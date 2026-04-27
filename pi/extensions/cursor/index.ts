import { createHash } from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type SimpleStreamOptions,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  generateCursorAuthParams,
  pollCursorAuth,
  refreshCursorToken,
} from "./auth.ts";
import { getTokenExpiry } from "./jwt.ts";
import { type CursorModel, getCursorModels, clearModelCache } from "./models.ts";
import { estimateModelCost } from "./model-cost.ts";
import { resolveRuntimeConfig } from "./runtime-config.ts";
import { parsePiContext, type ParsedContext } from "./pi-context.ts";
import { buildCursorRequest, deterministicConversationId } from "./cursor-request.ts";
import { buildMcpToolDefinitions } from "./mcp-tool-defs.ts";
import { CursorSession, type RetryHint } from "./cursor-session.ts";
import { pumpSession } from "./pi-stream.ts";
import { computeRetryDelayMs, retryBudget } from "./retry.ts";

const PROVIDER = "cursor";

interface ConvState {
  conversationId: string;
  checkpoint: Uint8Array | null;
  blobStore: Map<string, Uint8Array>;
  lastAccessMs: number;
}

const bridges = new Map<string, CursorSession>();
const conversations = new Map<string, ConvState>();

function deriveBridgeKey(modelId: string, parsed: ParsedContext): string {
  return createHash("sha256")
    .update(`bridge:${modelId}:${parsed.lastUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

function deriveConvKey(parsed: ParsedContext): string {
  return createHash("sha256")
    .update(`conv:${parsed.lastUserText.slice(0, 200)}`)
    .digest("hex")
    .slice(0, 16);
}

function evictStaleConversations(ttlMs: number): void {
  const now = Date.now();
  for (const [key, conv] of conversations) {
    if (now - conv.lastAccessMs > ttlMs) conversations.delete(key);
  }
}

function buildOutput(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function emitErrorAndEnd(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  reason: "error" | "aborted",
  message: string,
): void {
  output.stopReason = reason;
  output.errorMessage = message;
  stream.push({ type: "error", reason, error: output });
  stream.end();
}

function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output = buildOutput(model);
  stream.push({ type: "start", partial: output });

  void (async () => {
    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        emitErrorAndEnd(stream, output, "error",
          "No Cursor token. Run /login cursor first, then select a cursor/* model.");
        return;
      }

      const runtimeConfig = resolveRuntimeConfig();
      const parsed = parsePiContext(context);
      const bridgeKey = deriveBridgeKey(model.id, parsed);
      const convKey = deriveConvKey(parsed);

      // Resume path: existing alive bridge + tool results.
      const existing = bridges.get(bridgeKey);
      if (existing && existing.alive && parsed.toolResults.length > 0) {
        existing.sendToolResults(
          parsed.toolResults.map((r) => ({ toolCallId: r.toolCallId, content: r.content })),
        );
        const result = await pumpSession(existing, stream, output, model);
        if (result === "done") bridges.delete(bridgeKey);
        return;
      }

      // New bridge path.
      let conv = conversations.get(convKey);
      if (!conv) {
        conv = {
          conversationId: deterministicConversationId(convKey),
          checkpoint: null,
          blobStore: new Map(),
          lastAccessMs: Date.now(),
        };
        conversations.set(convKey, conv);
      }
      conv.lastAccessMs = Date.now();
      evictStaleConversations(runtimeConfig.conversationTtlMs);

      // Effective user text: fall back to a tool-result-driven turn if pi only sent toolResults.
      const userText =
        parsed.lastUserText ||
        (parsed.toolResults.length > 0
          ? parsed.toolResults.map((r) => r.content).join("\n")
          : "");
      if (!userText.trim()) {
        emitErrorAndEnd(stream, output, "error", "No user message found for Cursor request");
        return;
      }

      const mcpTools = buildMcpToolDefinitions(context.tools);
      let attempt = 0;
      let attemptedFreshState = false;

      while (true) {
        const payload = buildCursorRequest({
          modelId: model.id,
          systemPrompt: parsed.systemPrompt,
          userText,
          turns: parsed.turns,
          conversationId: conv.conversationId,
          checkpoint: conv.checkpoint,
          existingBlobStore: conv.blobStore,
          mcpTools,
        });

        const session = new CursorSession({
          accessToken,
          requestBytes: payload.requestBytes,
          blobStore: payload.blobStore,
          mcpTools,
          maxMode: runtimeConfig.maxMode,
          convKey,
          runtimeConfig,
          onCheckpoint: (bytes, blobStore) => {
            conv!.checkpoint = bytes;
            for (const [k, v] of blobStore) conv!.blobStore.set(k, v);
            conv!.lastAccessMs = Date.now();
          },
        });
        bridges.set(bridgeKey, session);

        options?.signal?.addEventListener("abort", () => {
          session.close();
          if (!output.errorMessage) emitErrorAndEnd(stream, output, "aborted", "Request aborted");
        }, { once: true });

        const result = await pumpSession(session, stream, output, model);
        if (result === "batchReady") return; // Session stays alive in bridges map.
        bridges.delete(bridgeKey);

        // After done, check whether the session ended with a retryable error.
        if (output.stopReason !== "error" || !output.errorMessage) return;
        const hint: RetryHint | undefined =
          /timeout/i.test(output.errorMessage) ? "timeout" :
          /resource_exhausted/i.test(output.errorMessage) ? "resource_exhausted" :
          /blob not found/i.test(output.errorMessage) ? "blob_not_found" : undefined;
        if (!hint) return;

        const budget = retryBudget(hint);
        attempt++;
        if (attempt > budget.maxAttempts) return;
        if (budget.freshState && !attemptedFreshState) {
          conv.checkpoint = null;
          conv.blobStore.clear();
          attemptedFreshState = true;
        }
        // Wait the backoff and retry.
        await new Promise((r) => setTimeout(r, computeRetryDelayMs(attempt - 1)));
        delete output.errorMessage;
        output.stopReason = "stop";
      }
    } catch (err) {
      emitErrorAndEnd(
        stream,
        output,
        options?.signal?.aborted ? "aborted" : "error",
        err instanceof Error ? err.message : String(err),
      );
    }
  })();

  return stream;
}

function buildProviderModels(models: CursorModel[]): Array<{
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}> {
  return models.map((m) => {
    const cost = estimateModelCost(m.id);
    return {
      id: m.id,
      name: m.name,
      reasoning: m.reasoning,
      input: ["text"],
      cost: {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cache.read,
        cacheWrite: cost.cache.write,
      },
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
  });
}

async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const { verifier, uuid, loginUrl } = await generateCursorAuthParams();
  callbacks.onAuth({ url: loginUrl });
  const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier);
  return {
    access: accessToken,
    refresh: refreshToken,
    expires: getTokenExpiry(accessToken),
  };
}

async function refreshCursor(creds: OAuthCredentials): Promise<OAuthCredentials> {
  const refreshed = await refreshCursorToken(creds.refresh);
  return { ...refreshed };
}

async function discoverModels(): Promise<CursorModel[]> {
  const token = process.env.CURSOR_ACCESS_TOKEN;
  if (token) {
    const result = await getCursorModels(token);
    return result.models;
  }
  // No token at extension load: register with FALLBACK_MODELS via getCursorModels which
  // returns the fallback set when the upstream RPCs fail without auth.
  const result = await getCursorModels("");
  return result.models;
}

export default async function cursorExtension(pi: ExtensionAPI): Promise<void> {
  const initialModels = await discoverModels();

  pi.registerProvider(PROVIDER, {
    baseUrl: process.env.CURSOR_API_URL ?? "https://api2.cursor.sh",
    apiKey: "CURSOR_ACCESS_TOKEN",
    api: "openai-completions", // Pi treats Cursor as OpenAI-shaped externally; streamSimple owns the wire.
    models: buildProviderModels(initialModels),
    oauth: {
      name: "Cursor",
      login: loginCursor,
      refreshToken: refreshCursor,
      getApiKey: (creds) => creds.access,
    },
    streamSimple: streamCursor,
  });

  pi.registerCommand("cursor-refresh-models", {
    description: "Re-fetch the Cursor model list and re-register the provider",
    handler: async (_args, ctx) => {
      clearModelCache();
      const models = await discoverModels();
      pi.unregisterProvider(PROVIDER);
      pi.registerProvider(PROVIDER, {
        baseUrl: process.env.CURSOR_API_URL ?? "https://api2.cursor.sh",
        apiKey: "CURSOR_ACCESS_TOKEN",
        api: "openai-completions",
        models: buildProviderModels(models),
        oauth: {
          name: "Cursor",
          login: loginCursor,
          refreshToken: refreshCursor,
          getApiKey: (creds) => creds.access,
        },
        streamSimple: streamCursor,
      });
      ctx.ui.notify(`Refreshed ${models.length} Cursor models`, "info");
    },
  });

  pi.registerCommand("cursor-cleanup", {
    description: "Close all Cursor bridges and clear conversation cache",
    handler: async (_args, ctx) => {
      for (const session of bridges.values()) session.close();
      bridges.clear();
      conversations.clear();
      ctx.ui.notify("Cursor provider state cleared", "info");
    },
  });

  pi.on("session_shutdown", async () => {
    for (const session of bridges.values()) session.close();
    bridges.clear();
  });
}
