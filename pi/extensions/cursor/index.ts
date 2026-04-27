import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import {
  FALLBACK_MODELS,
  clearModelCache,
  getCursorModels,
  type CursorModel,
} from "./models.ts";
import { estimateModelCost } from "./model-cost.ts";
import { resolveRuntimeConfig } from "./runtime-config.ts";
import { parsePiContext, type ParsedContext } from "./pi-context.ts";
import { buildCursorRequest, deterministicConversationId } from "./cursor-request.ts";
import { buildMcpToolDefinitions } from "./mcp-tool-defs.ts";
import { CursorSession, type RetryHint } from "./cursor-session.ts";
import { commitBatchReady, commitError, commitStop, pumpSession } from "./pi-stream.ts";
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
        const outcome = await pumpSession(existing, stream, output, model);
        if (outcome.kind === "batchReady") {
          commitBatchReady(stream, output);
          return;
        }
        bridges.delete(bridgeKey);
        if (outcome.kind === "stop") commitStop(stream, output);
        else commitError(stream, output, outcome.message);
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
      let abortSubscribed = false;

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
          onCheckpoint: (bytes, _blobStore) => {
            conv!.checkpoint = bytes;
            // payload.blobStore is conv.blobStore by reference, so KV writes already
            // landed there as they happened. Just bump the access time.
            conv!.lastAccessMs = Date.now();
          },
        });
        bridges.set(bridgeKey, session);

        if (!abortSubscribed) {
          abortSubscribed = true;
          options?.signal?.addEventListener("abort", () => {
            session.close();
            if (!output.errorMessage) commitError(stream, output, "Request aborted", "aborted");
          }, { once: true });
        }

        const outcome = await pumpSession(session, stream, output, model);
        if (outcome.kind === "batchReady") {
          commitBatchReady(stream, output);
          return;
        }
        bridges.delete(bridgeKey);

        if (outcome.kind === "stop") {
          commitStop(stream, output);
          return;
        }

        // outcome.kind === "error" — decide retry vs commit.
        const hint: RetryHint | undefined =
          outcome.retryHint ??
          (/timeout/i.test(outcome.message) ? "timeout" :
           /resource_exhausted/i.test(outcome.message) ? "resource_exhausted" :
           /blob not found/i.test(outcome.message) ? "blob_not_found" : undefined);
        if (!hint) {
          commitError(stream, output, outcome.message);
          return;
        }

        const budget = retryBudget(hint);
        attempt++;
        if (attempt > budget.maxAttempts) {
          commitError(stream, output, `${outcome.message} (gave up after ${attempt - 1} retries)`);
          return;
        }
        if (budget.freshState && !attemptedFreshState) {
          conv.checkpoint = null;
          conv.blobStore.clear();
          attemptedFreshState = true;
        }
        const delay = computeRetryDelayMs(attempt - 1);
        console.warn(
          `[cursor] retry ${attempt}/${budget.maxAttempts} after ${hint} in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
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

function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

interface StoredCursorAuth {
  access: string;
  refresh: string;
  expires: number;
}

function readStoredCursorAuth(): StoredCursorAuth | null {
  try {
    const path = join(getAgentDir(), "auth.json");
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const cred = data?.cursor;
    if (cred?.type !== "oauth") return null;
    if (typeof cred.access !== "string" || !cred.access) return null;
    return {
      access: cred.access,
      refresh: typeof cred.refresh === "string" ? cred.refresh : "",
      expires: typeof cred.expires === "number" ? cred.expires : 0,
    };
  } catch {
    return null;
  }
}

const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CachedModels {
  fetchedAt: number;
  models: CursorModel[];
}

function readCachedModels(): CursorModel[] | null {
  try {
    const path = join(getAgentDir(), "cursor-models.cache.json");
    if (!existsSync(path)) return null;
    const cache = JSON.parse(readFileSync(path, "utf8")) as CachedModels;
    if (!cache?.models?.length) return null;
    if (Date.now() - cache.fetchedAt > MODEL_CACHE_TTL_MS) return null;
    return cache.models;
  } catch {
    return null;
  }
}

function writeCachedModels(models: CursorModel[]): void {
  try {
    const path = join(getAgentDir(), "cursor-models.cache.json");
    writeFileSync(path, JSON.stringify({ fetchedAt: Date.now(), models }, null, 2), "utf8");
  } catch {
    // Best effort.
  }
}

async function getValidAccessToken(): Promise<string | null> {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  const stored = readStoredCursorAuth();
  if (!stored) return null;
  if (stored.expires > Date.now()) return stored.access;
  if (!stored.refresh) return null;
  try {
    const refreshed = await refreshCursorToken(stored.refresh);
    return refreshed.access;
  } catch {
    return null;
  }
}

async function fetchModelsFromCursor(): Promise<CursorModel[] | null> {
  const token = await getValidAccessToken();
  if (!token) return null;
  try {
    const result = await getCursorModels(token);
    if (result.source === "fallback") return null;
    return result.models;
  } catch {
    return null;
  }
}

function registerCursorProvider(pi: ExtensionAPI, models: CursorModel[]): void {
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
}

function sameModelIds(a: CursorModel[], b: CursorModel[]): boolean {
  if (a.length !== b.length) return false;
  const aIds = new Set(a.map((m) => m.id));
  for (const m of b) if (!aIds.has(m.id)) return false;
  return true;
}

export default function cursorExtension(pi: ExtensionAPI): void {
  // Synchronous initial registration: cached models if recent, otherwise the upstream fallback list.
  const cached = readCachedModels();
  const initialModels = cached ?? FALLBACK_MODELS;
  registerCursorProvider(pi, initialModels);

  // Background refresh: re-register with live models when the fetch completes.
  void (async () => {
    const fresh = await fetchModelsFromCursor();
    if (!fresh || fresh.length === 0) return;
    if (cached && sameModelIds(cached, fresh)) return;
    pi.unregisterProvider(PROVIDER);
    registerCursorProvider(pi, fresh);
    writeCachedModels(fresh);
  })();

  pi.registerCommand("cursor-refresh-models", {
    description: "Re-fetch the Cursor model list and re-register the provider",
    handler: async (_args, ctx) => {
      clearModelCache();
      const fresh = await fetchModelsFromCursor();
      if (!fresh) {
        ctx.ui.notify("Cursor model refresh failed (no token or upstream error)", "error");
        return;
      }
      pi.unregisterProvider(PROVIDER);
      registerCursorProvider(pi, fresh);
      writeCachedModels(fresh);
      ctx.ui.notify(`Refreshed ${fresh.length} Cursor models`, "info");
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
