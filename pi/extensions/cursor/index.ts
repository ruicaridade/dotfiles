import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	calculateCost,
	createAssistantMessageEventStream,
	type ImageContent,
	type Message,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	type TextContent,
	type Tool,
	type ToolCall,
	type ToolResultMessage,
} from "@mariozechner/pi-ai";
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import http2, { type ClientHttp2Session, type ClientHttp2Stream } from "node:http2";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	AgentClientMessageSchema,
	AgentRunRequestSchema,
	AgentServerMessageSchema,
	AssistantMessageSchema,
	BackgroundShellSpawnResultSchema,
	ClientHeartbeatSchema,
	ConversationActionSchema,
	ConversationStateStructureSchema,
	ConversationStepSchema,
	AgentConversationTurnStructureSchema,
	ConversationTurnStructureSchema,
	DeleteRejectedSchema,
	DeleteResultSchema,
	DiagnosticsResultSchema,
	ExecClientMessageSchema,
	FetchErrorSchema,
	FetchResultSchema,
	GetBlobResultSchema,
	GetUsableModelsRequestSchema,
	GetUsableModelsResponseSchema,
	GrepErrorSchema,
	GrepResultSchema,
	KvClientMessageSchema,
	LsRejectedSchema,
	LsResultSchema,
	McpErrorSchema,
	McpResultSchema,
	McpSuccessSchema,
	McpTextContentSchema,
	McpToolDefinitionSchema,
	McpToolResultContentItemSchema,
	ModelDetailsSchema,
	ReadRejectedSchema,
	ReadResultSchema,
	RequestContextResultSchema,
	RequestContextSchema,
	RequestContextSuccessSchema,
	SetBlobResultSchema,
	ShellRejectedSchema,
	ShellResultSchema,
	UserMessageActionSchema,
	UserMessageSchema,
	WriteRejectedSchema,
	WriteResultSchema,
	WriteShellStdinErrorSchema,
	WriteShellStdinResultSchema,
	type AgentServerMessage,
	type ConversationStateStructure,
	type ExecServerMessage,
	type KvServerMessage,
	type McpToolDefinition,
	type ModelDetails,
} from "./proto/agent_pb";

const CURSOR_PROVIDER = "cursor";
const CURSOR_API_URL = process.env.CURSOR_API_URL ?? "https://api2.cursor.sh";
const CURSOR_LOGIN_URL = "https://cursor.com/loginDeepControl";
const CURSOR_POLL_URL = "https://api2.cursor.sh/auth/poll";
const CURSOR_REFRESH_URL = process.env.CURSOR_REFRESH_URL ?? "https://api2.cursor.sh/auth/exchange_user_api_key";
const CURSOR_CLIENT_VERSION = process.env.CURSOR_CLIENT_VERSION ?? "cli-2026.01.09-231024f";
const CONNECT_END_STREAM_FLAG = 0b00000010;
const CONVERSATION_TTL_MS = 30 * 60 * 1000;
const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

type PiTool = Tool<any>;

interface CursorModel {
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number;
	maxTokens: number;
}

const FALLBACK_MODELS: CursorModel[] = [
	{ id: "auto", name: "Auto", reasoning: true, contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
	{ id: "composer-1", name: "Composer 1", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "composer-1.5", name: "Composer 1.5", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "composer-2", name: "Composer 2", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-4.6-opus-high", name: "Claude 4.6 Opus", reasoning: true, contextWindow: 200_000, maxTokens: 128_000 },
	{ id: "claude-4.6-sonnet-medium", name: "Claude 4.6 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "claude-4.5-sonnet", name: "Claude 4.5 Sonnet", reasoning: true, contextWindow: 200_000, maxTokens: 64_000 },
	{ id: "gpt-5.5", name: "GPT-5.5", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
	{ id: "gpt-5.4-medium", name: "GPT-5.4", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 },
	{ id: "gpt-5.2", name: "GPT-5.2", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
	{ id: "gpt-5.2-codex", name: "GPT-5.2 Codex", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
	{ id: "gpt-5.3-codex", name: "GPT-5.3 Codex", reasoning: true, contextWindow: 400_000, maxTokens: 128_000 },
	{ id: "gpt-5.3-codex-spark-preview", name: "GPT-5.3 Codex Spark", reasoning: true, contextWindow: 128_000, maxTokens: 128_000 },
	{ id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", reasoning: true, contextWindow: 1_000_000, maxTokens: 64_000 },
	{ id: "grok-code-fast-1", name: "Grok Code Fast 1", reasoning: false, contextWindow: 128_000, maxTokens: 64_000 },
];

type CursorCredentialsWithModels = OAuthCredentials & { cursorModels?: CursorModel[]; cursorModelsFetchedAt?: number };

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

function readStoredCursorCredential(): CursorCredentialsWithModels | undefined {
	try {
		const path = getAuthPath();
		if (!existsSync(path)) return undefined;
		const data = JSON.parse(readFileSync(path, "utf8"));
		const cred = data?.[CURSOR_PROVIDER];
		if (cred?.type === "oauth" && typeof cred.access === "string") return cred as CursorCredentialsWithModels;
	} catch {}
	return undefined;
}

function writeStoredCursorCredential(credential: CursorCredentialsWithModels): void {
	try {
		const path = getAuthPath();
		const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
		data[CURSOR_PROVIDER] = { type: "oauth", ...credential };
		writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
	} catch {}
}

function inferContextWindow(modelId: string): number {
	const id = modelId.toLowerCase();
	if (/gemini/.test(id)) return 1_000_000;
	if (/gpt-5\.[235]|gpt-5\.5|codex/.test(id)) return 400_000;
	if (/gpt-5\.4/.test(id)) return 272_000;
	if (/grok/.test(id)) return 128_000;
	return DEFAULT_CONTEXT_WINDOW;
}

function inferMaxTokens(modelId: string): number {
	const id = modelId.toLowerCase();
	if (/opus|gpt|codex/.test(id)) return 128_000;
	return DEFAULT_MAX_TOKENS;
}

function normalizeCursorModel(details: ModelDetails): CursorModel | null {
	const id = details.modelId?.trim();
	if (!id) return null;
	const name = [details.displayName, details.displayNameShort, details.displayModelId, ...(details.aliases ?? []), id]
		.map((candidate) => typeof candidate === "string" ? candidate.trim() : "")
		.find(Boolean) ?? id;
	const reasoning = Boolean(details.thinkingDetails) || hasReasoningVariantId(id);
	return { id, name, reasoning, contextWindow: inferContextWindow(id), maxTokens: inferMaxTokens(id) };
}

function hasReasoningVariantId(id: string): boolean {
	return /(^|[-_.])(extra-high|xhigh|high|medium|low|thinking|reasoning)([-_.]|$)/i.test(id);
}

function postProcessCursorModels(models: CursorModel[]): CursorModel[] {
	const byId = new Map<string, CursorModel>();
	for (const model of models) {
		byId.set(model.id, {
			...model,
			reasoning: model.reasoning || hasReasoningVariantId(model.id),
			contextWindow: model.contextWindow || inferContextWindow(model.id),
			maxTokens: model.maxTokens || inferMaxTokens(model.id),
		});
	}
	// Cursor currently returns the auto router as "default" for the CLI API. Keep
	// that exact id, but also expose the UI/common name "auto" for discoverability.
	if (!byId.has("auto") && byId.has("default")) {
		const base = byId.get("default")!;
		byId.set("auto", { ...base, id: "auto", name: "Auto" });
	}
	return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeCursorModels(models: readonly ModelDetails[]): CursorModel[] {
	const normalized: CursorModel[] = [];
	for (const details of models) {
		const model = normalizeCursorModel(details);
		if (model) normalized.push(model);
	}
	return postProcessCursorModels(normalized);
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
	if (payload.length < 5) return null;
	let offset = 0;
	while (offset + 5 <= payload.length) {
		const flags = payload[offset]!;
		const view = new DataView(payload.buffer, payload.byteOffset + offset, payload.byteLength - offset);
		const messageLength = view.getUint32(1, false);
		const frameEnd = offset + 5 + messageLength;
		if (frameEnd > payload.length) return null;
		if ((flags & 0b0000_0001) !== 0) return null;
		if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
		offset = frameEnd;
	}
	return null;
}

function callCursorUnaryRpc(accessToken: string, rpcPath: string, requestBody: Uint8Array, timeoutMs = 10_000): Promise<Uint8Array> {
	return new Promise((resolve, reject) => {
		const client = http2.connect(CURSOR_API_URL);
		const chunks: Buffer[] = [];
		const timeout = setTimeout(() => {
			try { client.destroy(); } catch {}
			reject(new Error("Cursor unary RPC timed out"));
		}, timeoutMs);
		const req = client.request({
			":method": "POST",
			":path": rpcPath,
			"content-type": "application/proto",
			te: "trailers",
			authorization: `Bearer ${accessToken}`,
			"x-ghost-mode": "true",
			"x-cursor-client-version": CURSOR_CLIENT_VERSION,
			"x-cursor-client-type": "cli",
			"x-request-id": randomUUID(),
		});
		const cleanup = () => { clearTimeout(timeout); try { client.close(); } catch {} };
		client.on("error", (error) => { cleanup(); reject(error); });
		req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
		req.on("error", (error) => { cleanup(); reject(error); });
		req.on("end", () => { cleanup(); resolve(Buffer.concat(chunks)); });
		req.end(requestBody);
	});
}

async function fetchCursorModels(accessToken: string): Promise<CursorModel[]> {
	const requestPayload = create(GetUsableModelsRequestSchema, {});
	const response = await callCursorUnaryRpc(accessToken, GET_USABLE_MODELS_PATH, toBinary(GetUsableModelsRequestSchema, requestPayload));
	let body = response;
	try {
		const decoded = fromBinary(GetUsableModelsResponseSchema, body);
		const models = normalizeCursorModels(decoded.models);
		if (models.length > 0) return models;
	} catch {}
	const framed = decodeConnectUnaryBody(response);
	if (framed) body = framed;
	const decoded = fromBinary(GetUsableModelsResponseSchema, body);
	const models = normalizeCursorModels(decoded.models);
	if (models.length === 0) throw new Error("Cursor returned no usable models");
	return models;
}

async function getInitialModels(): Promise<CursorModel[]> {
	const stored = readStoredCursorCredential();
	if (stored?.cursorModels?.length) {
		const cursorModels = postProcessCursorModels(stored.cursorModels);
		writeStoredCursorCredential({ ...stored, cursorModels, cursorModelsFetchedAt: stored.cursorModelsFetchedAt ?? Date.now() });
		return cursorModels;
	}
	let token = process.env.CURSOR_ACCESS_TOKEN || stored?.access;
	if (stored && (!token || stored.expires < Date.now())) {
		try {
			const refreshed = await refreshCursorToken(stored);
			writeStoredCursorCredential(refreshed as CursorCredentialsWithModels);
			token = refreshed.access;
		} catch {}
	}
	if (token) {
		try {
			const cursorModels = await fetchCursorModels(token);
			if (stored) writeStoredCursorCredential({ ...stored, cursorModels, cursorModelsFetchedAt: Date.now() });
			return cursorModels;
		} catch (error) {
			console.warn(`[cursor] model discovery failed, using fallback list: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return FALLBACK_MODELS;
}

interface PendingExec {
	execId: string;
	execMsgId: number;
	toolCallId: string;
	toolName: string;
	decodedArgs: string;
}

interface H2Bridge {
	write(data: Uint8Array): void;
	end(): void;
	onData(cb: (chunk: Buffer) => void): void;
	onClose(cb: (code: number) => void): void;
	readonly alive: boolean;
}

interface ActiveBridge {
	bridge: H2Bridge;
	heartbeatTimer: NodeJS.Timeout;
	blobStore: Map<string, Uint8Array>;
	mcpTools: McpToolDefinition[];
	pendingExecs: PendingExec[];
}

interface StoredConversation {
	conversationId: string;
	checkpoint: Uint8Array | null;
	blobStore: Map<string, Uint8Array>;
	lastAccessMs: number;
}

const activeBridges = new Map<string, ActiveBridge>();
const conversationStates = new Map<string, StoredConversation>();

function emptyUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(new Error("Cancelled"));
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timeout);
			reject(new Error("Cancelled"));
		}, { once: true });
	});
}

async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	const verifierBytes = new Uint8Array(96);
	crypto.getRandomValues(verifierBytes);
	const verifier = Buffer.from(verifierBytes).toString("base64url");
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: Buffer.from(hash).toString("base64url") };
}

function getTokenExpiry(token: string): number {
	try {
		const parts = token.split(".");
		if (parts.length === 3 && parts[1]) {
			const decoded = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			if (typeof decoded?.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
		}
	} catch {}
	return Date.now() + 3600 * 1000;
}

async function pollCursorAuth(uuid: string, verifier: string, signal?: AbortSignal): Promise<{ accessToken: string; refreshToken: string }> {
	let delay = 1000;
	let consecutiveErrors = 0;
	for (let attempt = 0; attempt < 150; attempt++) {
		await abortableSleep(delay, signal);
		try {
			const response = await fetch(`${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`, { signal });
			if (response.status === 404) {
				consecutiveErrors = 0;
				delay = Math.min(delay * 1.2, 10_000);
				continue;
			}
			if (response.ok) return await response.json() as { accessToken: string; refreshToken: string };
			throw new Error(`Poll failed: ${response.status} ${await response.text()}`);
		} catch (error) {
			if (signal?.aborted) throw error;
			consecutiveErrors++;
			if (consecutiveErrors >= 3) throw new Error("Too many consecutive errors during Cursor auth polling");
		}
	}
	throw new Error("Cursor authentication polling timed out");
}

async function loginCursor(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const { verifier, challenge } = await generatePKCE();
	const uuid = randomUUID();
	const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
	callbacks.onAuth({ url: `${CURSOR_LOGIN_URL}?${params.toString()}` });
	const { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier, (callbacks as any).signal);
	const credentials: CursorCredentialsWithModels = { access: accessToken, refresh: refreshToken, expires: getTokenExpiry(accessToken) };
	try {
		credentials.cursorModels = await fetchCursorModels(accessToken);
		credentials.cursorModelsFetchedAt = Date.now();
	} catch {}
	return credentials;
}

async function refreshCursorToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(CURSOR_REFRESH_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${credentials.refresh}`, "Content-Type": "application/json" },
		body: "{}",
	});
	if (!response.ok) throw new Error(`Cursor token refresh failed: ${response.status} ${await response.text()}`);
	const data = await response.json() as { accessToken: string; refreshToken?: string };
	const refreshed: CursorCredentialsWithModels = {
		access: data.accessToken,
		refresh: data.refreshToken || credentials.refresh,
		expires: getTokenExpiry(data.accessToken),
	};
	try {
		refreshed.cursorModels = await fetchCursorModels(data.accessToken);
		refreshed.cursorModelsFetchedAt = Date.now();
	} catch {
		refreshed.cursorModels = (credentials as CursorCredentialsWithModels).cursorModels;
		refreshed.cursorModelsFetchedAt = (credentials as CursorCredentialsWithModels).cursorModelsFetchedAt;
	}
	return refreshed;
}

function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(5 + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, 5);
	return frame;
}

function spawnBridge(accessToken: string, rpcPath = "/agent.v1.AgentService/Run"): H2Bridge {
	const client: ClientHttp2Session = http2.connect(CURSOR_API_URL);
	const headers = {
		":method": "POST",
		":path": rpcPath,
		"content-type": "application/connect+proto",
		te: "trailers",
		authorization: `Bearer ${accessToken}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
		"x-request-id": randomUUID(),
		"connect-protocol-version": "1",
	};
	const req: ClientHttp2Stream = client.request(headers);
	let dataCb: ((chunk: Buffer) => void) | undefined;
	let closeCb: ((code: number) => void) | undefined;
	let exited = false;
	let exitCode = 1;
	let timeout = setTimeout(() => close(1), 30_000);

	const resetTimeout = () => {
		clearTimeout(timeout);
		timeout = setTimeout(() => close(1), 120_000);
	};
	const close = (code: number) => {
		if (exited) return;
		exited = true;
		exitCode = code;
		clearTimeout(timeout);
		try { req.close(); } catch {}
		try { client.close(); } catch {}
		closeCb?.(code);
	};

	client.on("error", () => close(1));
	req.on("data", (chunk: Buffer) => { resetTimeout(); dataCb?.(Buffer.from(chunk)); });
	req.on("end", () => close(0));
	req.on("close", () => close(exitCode));
	req.on("error", () => close(1));

	return {
		get alive() { return !exited; },
		write(data) { if (!exited && !req.destroyed && !req.closed) { resetTimeout(); req.write(data); } },
		end() { if (!exited && !req.destroyed && !req.closed) req.end(); close(0); },
		onData(cb) { dataCb = cb; },
		onClose(cb) { closeCb = cb; if (exited) queueMicrotask(() => cb(exitCode)); },
	};
}

function makeHeartbeatBytes(): Uint8Array {
	const heartbeat = create(AgentClientMessageSchema, { message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) } });
	return frameConnectMessage(toBinary(AgentClientMessageSchema, heartbeat));
}

function createConnectFrameParser(onMessage: (bytes: Uint8Array) => void, onEndStream: (bytes: Uint8Array) => void): (incoming: Buffer) => void {
	let pending = Buffer.alloc(0);
	return (incoming: Buffer) => {
		pending = Buffer.concat([pending, incoming]);
		while (pending.length >= 5) {
			const flags = pending[0]!;
			const msgLen = pending.readUInt32BE(1);
			if (pending.length < 5 + msgLen) break;
			const messageBytes = pending.subarray(5, 5 + msgLen);
			pending = pending.subarray(5 + msgLen);
			if (flags & CONNECT_END_STREAM_FLAG) onEndStream(messageBytes);
			else onMessage(messageBytes);
		}
	};
}

function evictStaleConversations() {
	const now = Date.now();
	for (const [key, stored] of conversationStates) if (now - stored.lastAccessMs > CONVERSATION_TTL_MS) conversationStates.delete(key);
}

function textFromContent(content: Message["content"] | undefined): string {
	if (content == null) return "";
	if (typeof content === "string") return content;
	return content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
}

function toolResultText(msg: ToolResultMessage): string {
	return msg.content.map((c) => c.type === "text" ? c.text : `[image: ${c.mimeType}]`).join("\n");
}

interface ParsedContext {
	systemPrompt: string;
	userText: string;
	turns: Array<{ userText: string; assistantText: string }>;
	toolResults: Array<{ toolCallId: string; content: string; isError: boolean }>;
}

function parseContext(context: Context): ParsedContext {
	const systemPrompt = context.systemPrompt ?? "";
	const pairs: Array<{ userText: string; assistantText: string }> = [];
	const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];
	let pendingUser = "";

	for (const msg of context.messages) {
		if (msg.role === "user") {
			if (pendingUser) pairs.push({ userText: pendingUser, assistantText: "" });
			pendingUser = textFromContent(msg.content);
		} else if (msg.role === "assistant") {
			const assistantText = msg.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (pendingUser) {
				pairs.push({ userText: pendingUser, assistantText });
				pendingUser = "";
			}
		} else if (msg.role === "toolResult") {
			toolResults.push({ toolCallId: msg.toolCallId, content: toolResultText(msg), isError: msg.isError });
		}
	}

	let userText = "";
	if (pendingUser) userText = pendingUser;
	else if (pairs.length > 0 && toolResults.length === 0) userText = pairs.pop()!.userText;
	return { systemPrompt, userText, turns: pairs, toolResults };
}

function buildMcpToolDefinitions(tools: PiTool[] = []): McpToolDefinition[] {
	return tools.map((tool) => {
		const schema = tool.parameters && typeof tool.parameters === "object" ? (tool.parameters as unknown as JsonValue) : { type: "object", properties: {}, required: [] };
		return create(McpToolDefinitionSchema, {
			name: tool.name,
			description: tool.description || "",
			providerIdentifier: "pi",
			toolName: tool.name,
			inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, schema)),
		});
	});
}

function decodeMcpArgValue(value: Uint8Array): unknown {
	try { return toJson(ValueSchema, fromBinary(ValueSchema, value)); } catch {}
	return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) decoded[key] = decodeMcpArgValue(value);
	return decoded;
}

interface CursorRequestPayload {
	requestBytes: Uint8Array;
	blobStore: Map<string, Uint8Array>;
	mcpTools: McpToolDefinition[];
}

function buildCursorRequest(
	modelId: string,
	systemPrompt: string,
	userText: string,
	turns: Array<{ userText: string; assistantText: string }>,
	conversationId: string,
	checkpoint: Uint8Array | null,
	existingBlobStore?: Map<string, Uint8Array>,
): CursorRequestPayload {
	const blobStore = new Map<string, Uint8Array>(existingBlobStore ?? []);
	const systemJson = JSON.stringify({ role: "system", content: systemPrompt });
	const systemBytes = new TextEncoder().encode(systemJson);
	const systemBlobId = new Uint8Array(createHash("sha256").update(systemBytes).digest());
	blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes);

	let conversationState: ConversationStateStructure;
	if (checkpoint) {
		conversationState = fromBinary(ConversationStateStructureSchema, checkpoint);
	} else {
		const turnBytes: Uint8Array[] = [];
		for (const turn of turns) {
			const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: randomUUID() });
			const stepBytes: Uint8Array[] = [];
			if (turn.assistantText) {
				const step = create(ConversationStepSchema, { message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: turn.assistantText }) } });
				stepBytes.push(toBinary(ConversationStepSchema, step));
			}
			const agentTurn = create(AgentConversationTurnStructureSchema, { userMessage: toBinary(UserMessageSchema, userMsg), steps: stepBytes });
			turnBytes.push(toBinary(ConversationTurnStructureSchema, create(ConversationTurnStructureSchema, { turn: { case: "agentConversationTurn", value: agentTurn } })));
		}
		conversationState = create(ConversationStateStructureSchema, {
			rootPromptMessagesJson: [systemBlobId],
			turns: turnBytes,
			todos: [],
			pendingToolCalls: [],
			previousWorkspaceUris: [],
			fileStates: {},
			fileStatesV2: {},
			summaryArchives: [],
			turnTimings: [],
			subagentStates: {},
			selfSummaryCount: 0,
			readPaths: [],
		});
	}

	const userMessage = create(UserMessageSchema, { text: userText, messageId: randomUUID() });
	const action = create(ConversationActionSchema, { action: { case: "userMessageAction", value: create(UserMessageActionSchema, { userMessage }) } });
	const modelDetails = create(ModelDetailsSchema, { modelId, displayModelId: modelId, displayName: modelId });
	const runRequest = create(AgentRunRequestSchema, { conversationState, action, modelDetails, conversationId });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "runRequest", value: runRequest } });
	return { requestBytes: toBinary(AgentClientMessageSchema, clientMessage), blobStore, mcpTools: [] };
}

function parseConnectEndStream(data: Uint8Array): Error | null {
	try {
		const payload = JSON.parse(new TextDecoder().decode(data));
		if (payload?.error) return new Error(`Connect error ${payload.error.code ?? "unknown"}: ${payload.error.message ?? "Unknown error"}`);
		return null;
	} catch { return new Error("Failed to parse Cursor Connect end stream"); }
}

interface StreamState {
	pendingExecs: PendingExec[];
	outputTokens: number;
	totalTokens: number;
}

const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];
const MAX_THINKING_TAG_LEN = 16;

function createThinkingTagFilter() {
	let buffer = "";
	let inThinking = false;
	return {
		process(text: string): { content: string; reasoning: string } {
			const input = buffer + text;
			buffer = "";
			let content = "";
			let reasoning = "";
			let lastIdx = 0;
			const re = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");
			let match: RegExpExecArray | null;
			while ((match = re.exec(input)) !== null) {
				const before = input.slice(lastIdx, match.index);
				if (inThinking) reasoning += before; else content += before;
				inThinking = match[1] !== "/";
				lastIdx = re.lastIndex;
			}
			const rest = input.slice(lastIdx);
			const ltPos = rest.lastIndexOf("<");
			if (ltPos >= 0 && rest.length - ltPos < MAX_THINKING_TAG_LEN && /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))) {
				buffer = rest.slice(ltPos);
				const before = rest.slice(0, ltPos);
				if (inThinking) reasoning += before; else content += before;
			} else {
				if (inThinking) reasoning += rest; else content += rest;
			}
			return { content, reasoning };
		},
		flush(): { content: string; reasoning: string } {
			const b = buffer;
			buffer = "";
			if (!b) return { content: "", reasoning: "" };
			return inThinking ? { content: "", reasoning: b } : { content: b, reasoning: "" };
		},
	};
}

function sendKvResponse(kvMsg: KvServerMessage, messageCase: string, value: unknown, sendFrame: (data: Uint8Array) => void): void {
	const response = create(KvClientMessageSchema, { id: kvMsg.id, message: { case: messageCase as any, value: value as any } });
	const clientMsg = create(AgentClientMessageSchema, { message: { case: "kvClientMessage", value: response } });
	sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

function handleKvMessage(kvMsg: KvServerMessage, blobStore: Map<string, Uint8Array>, sendFrame: (data: Uint8Array) => void): void {
	const kvCase = kvMsg.message.case;
	if (kvCase === "getBlobArgs") {
		const blobIdKey = Buffer.from(kvMsg.message.value.blobId).toString("hex");
		sendKvResponse(kvMsg, "getBlobResult", create(GetBlobResultSchema, blobStore.has(blobIdKey) ? { blobData: blobStore.get(blobIdKey) } : {}), sendFrame);
	} else if (kvCase === "setBlobArgs") {
		const { blobId, blobData } = kvMsg.message.value;
		blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
		sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
	}
}

function sendExecResult(execMsg: ExecServerMessage, messageCase: string, value: unknown, sendFrame: (data: Uint8Array) => void): void {
	const execClientMessage = create(ExecClientMessageSchema, { id: execMsg.id, execId: execMsg.execId, message: { case: messageCase as any, value: value as any } });
	const clientMessage = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } });
	sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

function handleExecMessage(execMsg: ExecServerMessage, mcpTools: McpToolDefinition[], sendFrame: (data: Uint8Array) => void, onMcpExec: (exec: PendingExec) => void): void {
	const execCase = execMsg.message.case;
	if (execCase === "requestContextArgs") {
		const requestContext = create(RequestContextSchema, { rules: [], repositoryInfo: [], tools: mcpTools, gitRepos: [], projectLayouts: [], mcpInstructions: [], fileContents: {}, customSubagents: [] });
		const result = create(RequestContextResultSchema, { result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext }) } });
		sendExecResult(execMsg, "requestContextResult", result, sendFrame);
		return;
	}
	if (execCase === "mcpArgs") {
		const mcpArgs = execMsg.message.value;
		const decoded = decodeMcpArgsMap((mcpArgs.args ?? {}) as Record<string, Uint8Array>);
		onMcpExec({ execId: execMsg.execId, execMsgId: execMsg.id, toolCallId: mcpArgs.toolCallId || randomUUID(), toolName: mcpArgs.toolName || mcpArgs.name, decodedArgs: JSON.stringify(decoded) });
		return;
	}

	const REJECT_REASON = "Tool not available in this environment. Use the MCP tools provided instead.";
	if (execCase === "readArgs") {
		const args = execMsg.message.value;
		sendExecResult(execMsg, "readResult", create(ReadResultSchema, { result: { case: "rejected", value: create(ReadRejectedSchema, { path: args.path, reason: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "lsArgs") {
		const args = execMsg.message.value;
		sendExecResult(execMsg, "lsResult", create(LsResultSchema, { result: { case: "rejected", value: create(LsRejectedSchema, { path: args.path, reason: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "grepArgs") {
		sendExecResult(execMsg, "grepResult", create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "writeArgs") {
		const args = execMsg.message.value;
		sendExecResult(execMsg, "writeResult", create(WriteResultSchema, { result: { case: "rejected", value: create(WriteRejectedSchema, { path: args.path, reason: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "deleteArgs") {
		const args = execMsg.message.value;
		sendExecResult(execMsg, "deleteResult", create(DeleteResultSchema, { result: { case: "rejected", value: create(DeleteRejectedSchema, { path: args.path, reason: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
		const args = execMsg.message.value as any;
		sendExecResult(execMsg, "shellResult", create(ShellResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: args.command ?? "", workingDirectory: args.workingDirectory ?? "", reason: REJECT_REASON, isReadonly: false }) } }), sendFrame);
	} else if (execCase === "backgroundShellSpawnArgs") {
		const args = execMsg.message.value as any;
		sendExecResult(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, { result: { case: "rejected", value: create(ShellRejectedSchema, { command: args.command ?? "", workingDirectory: args.workingDirectory ?? "", reason: REJECT_REASON, isReadonly: false }) } }), sendFrame);
	} else if (execCase === "writeShellStdinArgs") {
		sendExecResult(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, { result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "fetchArgs") {
		const args = execMsg.message.value as any;
		sendExecResult(execMsg, "fetchResult", create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url: args.url ?? "", error: REJECT_REASON }) } }), sendFrame);
	} else if (execCase === "diagnosticsArgs") {
		sendExecResult(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {}), sendFrame);
	} else {
		const miscCaseMap: Record<string, string> = { listMcpResourcesExecArgs: "listMcpResourcesExecResult", readMcpResourceExecArgs: "readMcpResourceExecResult", recordScreenArgs: "recordScreenResult", computerUseArgs: "computerUseResult" };
		const resultCase = miscCaseMap[execCase as string];
		if (resultCase) sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
	}
}

function processServerMessage(
	msg: AgentServerMessage,
	blobStore: Map<string, Uint8Array>,
	mcpTools: McpToolDefinition[],
	sendFrame: (data: Uint8Array) => void,
	state: StreamState,
	onText: (text: string, isThinking?: boolean) => void,
	onMcpExec: (exec: PendingExec) => void,
	onCheckpoint?: (checkpointBytes: Uint8Array) => void,
): void {
	const msgCase = msg.message.case;
	if (msgCase === "interactionUpdate") {
		const update: any = msg.message.value;
		const updateCase = update.message?.case;
		if (updateCase === "textDelta") onText(update.message.value.text || "", false);
		else if (updateCase === "thinkingDelta") onText(update.message.value.text || "", true);
		else if (updateCase === "tokenDelta") state.outputTokens += update.message.value.tokens ?? 0;
	} else if (msgCase === "kvServerMessage") {
		handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
	} else if (msgCase === "execServerMessage") {
		handleExecMessage(msg.message.value as ExecServerMessage, mcpTools, sendFrame, onMcpExec);
	} else if (msgCase === "conversationCheckpointUpdate") {
		const stateStructure = msg.message.value as ConversationStateStructure;
		if (stateStructure.tokenDetails) state.totalTokens = stateStructure.tokenDetails.usedTokens;
		onCheckpoint?.(toBinary(ConversationStateStructureSchema, stateStructure));
	}
}

function deriveBridgeKey(modelId: string, context: Context): string {
	const firstUser = context.messages.find((m) => m.role === "user");
	const firstUserText = firstUser?.role === "user" ? textFromContent(firstUser.content) : "";
	return createHash("sha256").update(`bridge:${modelId}:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

function deriveConversationKey(context: Context): string {
	const firstUser = context.messages.find((m) => m.role === "user");
	const firstUserText = firstUser?.role === "user" ? textFromContent(firstUser.content) : "";
	return createHash("sha256").update(`conv:${firstUserText.slice(0, 200)}`).digest("hex").slice(0, 16);
}

function deterministicConversationId(convKey: string): string {
	const hex = createHash("sha256").update(`cursor-conv-id:${convKey}`).digest("hex").slice(0, 32);
	return [hex.slice(0, 8), hex.slice(8, 12), `4${hex.slice(13, 16)}`, `${(0x8 | (parseInt(hex[16]!, 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`, hex.slice(20, 32)].join("-");
}

function computeUsage(model: Model<Api>, output: AssistantMessage, state: StreamState) {
	output.usage.output = state.outputTokens;
	output.usage.totalTokens = state.totalTokens || state.outputTokens;
	output.usage.input = Math.max(0, output.usage.totalTokens - output.usage.output);
	calculateCost(model, output.usage);
}

function startBridge(accessToken: string, requestBytes: Uint8Array): { bridge: H2Bridge; heartbeatTimer: NodeJS.Timeout } {
	const bridge = spawnBridge(accessToken);
	bridge.write(frameConnectMessage(requestBytes));
	const heartbeatTimer = setInterval(() => bridge.write(makeHeartbeatBytes()), 5_000);
	return { bridge, heartbeatTimer };
}

function ensureTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
	const lastIndex = output.content.length - 1;
	if (lastIndex >= 0 && output.content[lastIndex]?.type === "text") return lastIndex;
	const index = output.content.length;
	output.content.push({ type: "text", text: "" });
	stream.push({ type: "text_start", contentIndex: index, partial: output });
	return index;
}

function ensureThinkingBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
	const lastIndex = output.content.length - 1;
	if (lastIndex >= 0 && output.content[lastIndex]?.type === "thinking") return lastIndex;
	const index = output.content.length;
	output.content.push({ type: "thinking", thinking: "" });
	stream.push({ type: "thinking_start", contentIndex: index, partial: output });
	return index;
}

function appendText(output: AssistantMessage, stream: AssistantMessageEventStream, text: string) {
	if (!text) return;
	const index = ensureTextBlock(output, stream);
	const block = output.content[index]! as TextContent;
	block.text += text;
	stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
}

function appendThinking(output: AssistantMessage, stream: AssistantMessageEventStream, text: string) {
	if (!text) return;
	const index = ensureThinkingBlock(output, stream);
	const block = output.content[index]! as any;
	block.thinking += text;
	stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: output });
}

function closeOpenBlocks(output: AssistantMessage, stream: AssistantMessageEventStream) {
	for (let i = 0; i < output.content.length; i++) {
		const block = output.content[i]!;
		if (block.type === "text") stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
		else if (block.type === "thinking") stream.push({ type: "thinking_end", contentIndex: i, content: block.thinking, partial: output });
	}
}

function runBridgeToPiStream(
	bridge: H2Bridge,
	heartbeatTimer: NodeJS.Timeout,
	blobStore: Map<string, Uint8Array>,
	mcpTools: McpToolDefinition[],
	model: Model<Api>,
	bridgeKey: string,
	convKey: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	state: StreamState,
) {
	const tagFilter = createThinkingTagFilter();
	let emittedToolUse = false;
	let ended = false;
	const finish = (kind: "stop" | "toolUse" | "error", errorMessage?: string) => {
		if (ended) return;
		ended = true;
		if (kind !== "toolUse") clearInterval(heartbeatTimer);
		if (kind === "error") {
			output.stopReason = "error";
			output.errorMessage = errorMessage;
			stream.push({ type: "error", reason: "error", error: output });
		} else {
			output.stopReason = kind === "toolUse" ? "toolUse" : "stop";
			computeUsage(model, output, state);
			stream.push({ type: "done", reason: output.stopReason, message: output });
		}
		stream.end();
	};

	const processChunk = createConnectFrameParser(
		(messageBytes) => {
			try {
				const serverMessage = fromBinary(AgentServerMessageSchema, messageBytes);
				processServerMessage(
					serverMessage,
					blobStore,
					mcpTools,
					(data) => bridge.write(data),
					state,
					(text, isThinking) => {
						if (emittedToolUse) return;
						if (isThinking) appendThinking(output, stream, text);
						else {
							const { content, reasoning } = tagFilter.process(text);
							appendThinking(output, stream, reasoning);
							appendText(output, stream, content);
						}
					},
					(exec) => {
						if (emittedToolUse) return;
						emittedToolUse = true;
						state.pendingExecs.push(exec);
						const flushed = tagFilter.flush();
						appendThinking(output, stream, flushed.reasoning);
						appendText(output, stream, flushed.content);
						closeOpenBlocks(output, stream);

						const index = output.content.length;
						const toolCall: ToolCall = { type: "toolCall", id: exec.toolCallId, name: exec.toolName, arguments: {} };
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						try { toolCall.arguments = JSON.parse(exec.decodedArgs || "{}"); } catch { toolCall.arguments = {}; }
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: exec.decodedArgs, partial: output });
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });

						activeBridges.set(bridgeKey, { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs: state.pendingExecs });
						finish("toolUse");
					},
					(checkpointBytes) => {
						const stored = conversationStates.get(convKey);
						if (stored) { stored.checkpoint = checkpointBytes; stored.lastAccessMs = Date.now(); }
					},
				);
			} catch {
				// Cursor occasionally emits messages from newer schema revisions; ignore unparseable messages.
			}
		},
		(endStreamBytes) => {
			const endError = parseConnectEndStream(endStreamBytes);
			if (endError && !emittedToolUse) appendText(output, stream, `\n[Cursor error: ${endError.message}]`);
		},
	);

	bridge.onData(processChunk);
	bridge.onClose((code) => {
		const stored = conversationStates.get(convKey);
		if (stored) {
			for (const [k, v] of blobStore) stored.blobStore.set(k, v);
			stored.lastAccessMs = Date.now();
		}
		if (emittedToolUse) {
			activeBridges.delete(bridgeKey);
			clearInterval(heartbeatTimer);
			return;
		}
		const flushed = tagFilter.flush();
		appendThinking(output, stream, flushed.reasoning);
		appendText(output, stream, flushed.content);
		closeOpenBlocks(output, stream);
		finish(code === 0 ? "stop" : "error", code === 0 ? undefined : "Cursor HTTP/2 stream ended unexpectedly");
	});
}

function resumeWithToolResults(active: ActiveBridge, parsed: ParsedContext, model: Model<Api>, bridgeKey: string, convKey: string, stream: AssistantMessageEventStream, output: AssistantMessage) {
	const { bridge, heartbeatTimer, blobStore, mcpTools, pendingExecs } = active;
	for (const exec of pendingExecs) {
		const result = parsed.toolResults.find((r) => r.toolCallId === exec.toolCallId);
		const mcpResult = result
			? create(McpResultSchema, {
				result: {
					case: "success",
					value: create(McpSuccessSchema, {
						content: [create(McpToolResultContentItemSchema, { content: { case: "text", value: create(McpTextContentSchema, { text: result.content }) } })],
						isError: result.isError,
					}),
				},
			})
			: create(McpResultSchema, { result: { case: "error", value: create(McpErrorSchema, { error: "Tool result not provided" }) } });
		const execClientMessage = create(ExecClientMessageSchema, { id: exec.execMsgId, execId: exec.execId, message: { case: "mcpResult" as any, value: mcpResult as any } });
		const clientMessage = create(AgentClientMessageSchema, { message: { case: "execClientMessage", value: execClientMessage } });
		bridge.write(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
	}
	runBridgeToPiStream(bridge, heartbeatTimer, blobStore, mcpTools, model, bridgeKey, convKey, stream, output, { pendingExecs: [], outputTokens: 0, totalTokens: 0 });
}

function streamCursor(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createOutput(model);
	stream.push({ type: "start", partial: output });

	(async () => {
		try {
			const accessToken = options?.apiKey;
			if (!accessToken) throw new Error("No Cursor token. Run /login cursor first, then select a cursor/* model.");
			const parsed = parseContext(context);
			const bridgeKey = deriveBridgeKey(model.id, context);
			const convKey = deriveConversationKey(context);
			const active = activeBridges.get(bridgeKey);

			if (active && parsed.toolResults.length > 0) {
				activeBridges.delete(bridgeKey);
				if (active.bridge.alive) {
					resumeWithToolResults(active, parsed, model, bridgeKey, convKey, stream, output);
					return;
				}
				clearInterval(active.heartbeatTimer);
				active.bridge.end();
			}

			let stored = conversationStates.get(convKey);
			if (!stored) {
				stored = { conversationId: deterministicConversationId(convKey), checkpoint: null, blobStore: new Map(), lastAccessMs: Date.now() };
				conversationStates.set(convKey, stored);
			}
			stored.lastAccessMs = Date.now();
			evictStaleConversations();

			const effectiveUserText = parsed.userText || (parsed.toolResults.length > 0 ? parsed.toolResults.map((r) => r.content).join("\n") : "");
			if (!effectiveUserText.trim()) throw new Error("No user message found for Cursor request");
			const payload = buildCursorRequest(model.id, parsed.systemPrompt, effectiveUserText, parsed.turns, stored.conversationId, stored.checkpoint, stored.blobStore);
			payload.mcpTools = buildMcpToolDefinitions(context.tools);
			const { bridge, heartbeatTimer } = startBridge(accessToken, payload.requestBytes);
			options?.signal?.addEventListener("abort", () => {
				clearInterval(heartbeatTimer);
				bridge.end();
				if (!output.errorMessage) {
					output.stopReason = "aborted";
					output.errorMessage = "Request aborted";
					stream.push({ type: "error", reason: "aborted", error: output });
					stream.end();
				}
			}, { once: true });
			runBridgeToPiStream(bridge, heartbeatTimer, payload.blobStore, payload.mcpTools, model, bridgeKey, convKey, stream, output, { pendingExecs: [], outputTokens: 0, totalTokens: 0 });
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

interface ModelCost { input: number; output: number; cache: { read: number; write: number } }
const DEFAULT_COST: ModelCost = { input: 3, output: 15, cache: { read: 0.3, write: 0 } };
const COST_PATTERNS: Array<{ match: RegExp; cost: ModelCost }> = [
	{ match: /claude.*opus.*fast/i, cost: { input: 30, output: 150, cache: { read: 3, write: 37.5 } } },
	{ match: /claude.*opus/i, cost: { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } } },
	{ match: /claude.*haiku/i, cost: { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } } },
	{ match: /claude|sonnet/i, cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } } },
	{ match: /composer-?2/i, cost: { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } } },
	{ match: /composer-?1\.5/i, cost: { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } } },
	{ match: /composer/i, cost: { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } } },
	{ match: /gpt-5\.4/i, cost: { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } } },
	{ match: /gpt-5\.[23]/i, cost: { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } } },
	{ match: /gpt-5/i, cost: { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } } },
	{ match: /gemini/i, cost: { input: 2, output: 12, cache: { read: 0.2, write: 0 } } },
	{ match: /grok/i, cost: { input: 2, output: 6, cache: { read: 0.2, write: 0 } } },
	{ match: /kimi/i, cost: { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } } },
];
function estimateCost(id: string): ModelCost { return COST_PATTERNS.find((p) => p.match.test(id))?.cost ?? DEFAULT_COST; }

function toProviderModels(models: CursorModel[]) {
	return models.map((model) => {
		const cost = estimateCost(model.id);
		return {
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: ["text"] as const,
			cost: { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write },
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		};
	});
}

function toRuntimeModel(template: Model<Api>, model: CursorModel): Model<Api> {
	const cost = estimateCost(model.id);
	return {
		...template,
		id: model.id,
		name: model.name,
		reasoning: model.reasoning,
		input: ["text"],
		cost: { input: cost.input, output: cost.output, cacheRead: cost.cache.read, cacheWrite: cost.cache.write },
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
	};
}

function registerCursorProvider(pi: ExtensionAPI, models: CursorModel[]) {
	pi.registerProvider(CURSOR_PROVIDER, {
		baseUrl: CURSOR_API_URL,
		apiKey: "CURSOR_ACCESS_TOKEN",
		api: "cursor-agent-api",
		models: toProviderModels(models),
		oauth: {
			name: "Cursor",
			login: loginCursor,
			refreshToken: refreshCursorToken,
			getApiKey: (credentials) => credentials.access,
			modifyModels: (registeredModels, credentials) => {
				const cursorModels = (credentials as CursorCredentialsWithModels).cursorModels;
				if (!cursorModels?.length) return registeredModels;
				const processedCursorModels = postProcessCursorModels(cursorModels);
				const template = registeredModels.find((m) => m.provider === CURSOR_PROVIDER) ?? registeredModels[0];
				if (!template) return registeredModels;
				return [
					...registeredModels.filter((m) => m.provider !== CURSOR_PROVIDER),
					...processedCursorModels.map((model) => toRuntimeModel(template, model)),
				];
			},
		},
		streamSimple: streamCursor,
	});
}

export default async function cursorProviderExtension(pi: ExtensionAPI) {
	let currentModels = await getInitialModels();
	registerCursorProvider(pi, currentModels);

	pi.registerCommand("cursor-refresh-models", {
		description: "Fetch the current Cursor model list from Cursor's API and re-register cursor models",
		handler: async (_args, ctx) => {
			const stored = readStoredCursorCredential();
			let token = process.env.CURSOR_ACCESS_TOKEN || stored?.access;
			if (stored && (!token || stored.expires < Date.now())) {
				const refreshed = await refreshCursorToken(stored);
				writeStoredCursorCredential(refreshed as CursorCredentialsWithModels);
				token = refreshed.access;
			}
			if (!token) {
				ctx.ui.notify("No Cursor token found. Run /login cursor first.", "error");
				return;
			}
			currentModels = await fetchCursorModels(token);
			if (stored) writeStoredCursorCredential({ ...stored, access: token, cursorModels: currentModels, cursorModelsFetchedAt: Date.now() });
			registerCursorProvider(pi, currentModels);
			ctx.ui.notify(`Fetched ${currentModels.length} Cursor models. Open /model and search cursor/.`, "info");
		},
	});

	pi.registerCommand("cursor-cleanup", {
		description: "Close active Cursor HTTP/2 streams and clear cached Cursor conversation state",
		handler: async (_args, ctx) => {
			for (const active of activeBridges.values()) {
				clearInterval(active.heartbeatTimer);
				active.bridge.end();
			}
			activeBridges.clear();
			conversationStates.clear();
			ctx.ui.notify("Cursor provider state cleared", "info");
		},
	});

	pi.on("session_shutdown", async () => {
		for (const active of activeBridges.values()) {
			clearInterval(active.heartbeatTimer);
			active.bridge.end();
		}
		activeBridges.clear();
	});
}
