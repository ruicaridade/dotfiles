# pi Cursor Provider Extension — Design

## Goal

Build a `pi` extension at `.pi/extensions/cursor/` that lets pi call Cursor models (Claude, GPT, Gemini, Composer, Grok via Cursor) without requiring the Cursor CLI to be installed. Authentication is via Cursor's OAuth (PKCE) flow integrated into pi's `/login`. Streaming is implemented natively against Cursor's gRPC backend (`api2.cursor.sh`) over HTTP/2 + Connect protocol.

## Background

The existing `pi/extensions/cursor/index.ts` (1193 lines, committed in `a6391ed`, removed from working tree) tried this once and failed. Its core mistake: rejected every native Cursor tool call (`readArgs`, `shellArgs`, `grepArgs`, etc.) with a "use MCP instead" message. Cursor's models keep retrying their native tools and stall. The debug log (`pi/cursor-debug.log`) shows recurring `exec.rejectNative` followed by 120s timeouts.

The reference implementation is [opencode-cursor](https://github.com/Hardcode84/opencode-cursor) — an OpenCode plugin that solves the same problem by **redirecting** native Cursor tools onto OpenCode's MCP equivalents and sending results back as the native protobuf result types Cursor expects. We adopt that strategy, adapted for pi's native streaming API.

opencode-cursor runs a local OpenAI-compatible proxy server because OpenCode can't do bidirectional streaming. Pi's `streamSimple` API doesn't have that constraint — we implement the protocol directly inside `streamSimple` and emit pi's native event types.

## Non-Goals

- Disk-backed conversation persistence (in-memory only).
- Title-generation via Cursor's NameAgent RPC (pi has its own session naming).
- Subagent / parent-session affinity (pi's subagent extension handles that separately).
- Image/PDF/audio inputs (Cursor's protocol doesn't expose them via this RPC).
- A local proxy server.

## Architecture

```
pi.streamSimple(model, context, options)
   │
   ├── Parse Context → { systemPrompt, turns, lastUserText, toolResults }
   ├── bridgeKey = sha256(model.id + first-user-text-prefix-200chars)
   ├── convKey   = sha256(first-user-text-prefix-200chars)
   │
   ├── If toolResults non-empty AND bridges[bridgeKey] alive:
   │      session.sendToolResults(toolResults)            ── RESUME PATH
   │      pump session events → pi.AssistantMessageEventStream
   │
   └── Else:
          stored = conversations[convKey] ?? new
          buildCursorRequest(modelId, parsed, stored.checkpoint, stored.blobStore)
          new CursorSession(...)                          ── NEW BRIDGE PATH
          bridges[bridgeKey] = session
          pump session events → pi.AssistantMessageEventStream

CursorSession (lives across multiple streamSimple calls):
   - HTTP/2 stream to api2.cursor.sh, Connect framing, protobuf bodies
   - One H2 message handler installed once, never replaced
   - Batch state machine: STREAMING ↔ COLLECTING ↔ FLUSHED
   - Event queue (buffers events arriving between pi calls)
   - Inactivity timer phases (thinking 30s / streaming 15s / collecting 30s / flushed 10min)
   - Heartbeat every 5s
```

Two protocol invariants from opencode-cursor we preserve:

1. **Persistent message handler.** The H2 `data` handler is installed once when the session is created. Pi-stream pumpers (the `for await` loop inside `streamSimple`) come and go; the session persists. This eliminates the race where messages arriving between pumpers are processed by a dead handler.
2. **Event queue bridges the gap.** Events that arrive while no pumper is reading (e.g., a late `mcpArgs` after `batchReady`) are buffered. The next pumper drains them in order.

## File Layout

```
.pi/extensions/cursor/
├── package.json              deps: @bufbuild/protobuf
├── proto/
│   ├── agent_pb.ts           generated, copied from opencode-cursor
│   └── aiserver_pb.ts        generated, for AvailableModels RPC
├── index.ts                  entry: registerProvider + OAuth + commands  (~150 lines)
├── auth.ts                   PKCE, login, poll, refresh, JWT expiry      (~140 lines)
├── runtime-config.ts         env-var-overridable URLs/timeouts            (~50 lines)
├── models.ts                 AvailableModels + GetEffectiveTokenLimit + fallback (~250 lines)
├── model-names.ts            pretty-name + reasoning-effort suffix mapping (~60 lines)
├── pi-context.ts             parse pi Context → systemPrompt/turns/toolResults (~80 lines)
├── cursor-request.ts         build AgentRunRequest protobuf from parsed context (~150 lines)
├── protocol.ts               Connect framing + parser + endStream decode  (~80 lines)
├── cursor-session.ts         H2 stream, batch state machine, event queue (~450 lines)
├── cursor-messages.ts        KV/exec/interactionUpdate dispatch          (~400 lines)
├── native-tools.ts           native→pi-tool redirect + protobuf result encoding (~600 lines)
├── thinking-filter.ts        streaming <think> tag filter                 (~50 lines)
├── pi-stream.ts              session events → pi AssistantMessageEventStream (~200 lines)
└── retry.ts                  backoff + classify(error) for resource_exhausted/timeout (~80 lines)
```

We can lift `protocol.ts`, `pkce` logic, large parts of `auth.ts`, `models.ts`, `native-tools.ts`, the protobuf files, and the cost table directly from opencode-cursor (Apache-2.0, attribution preserved).

## Pi Context → Cursor Request Mapping

Pi's `Context` is `{ systemPrompt?, messages: Message[], tools?: Tool[] }`. Messages are `UserMessage | AssistantMessage | ToolResultMessage`. We parse to:

```typescript
interface ParsedContext {
  systemPrompt: string;
  turns: Array<{ userText: string; assistantText: string }>;
  lastUserText: string;
  toolResults: Array<{ toolCallId: string; content: string; isError: boolean }>;
}
```

Rules:
- Empty system prompt → `"You are a helpful assistant."`
- Image content in user/assistant messages → flattened to `[image: <mimeType>]` placeholder text (Cursor RPC doesn't carry images on this path).
- A trailing `toolResultMessage[]` (no user message after) signals a *resume* — `lastUserText` is empty, `toolResults` is non-empty.
- A trailing user message signals a *new turn* — `lastUserText` is set.
- Otherwise, the last `(user, assistant)` pair becomes `lastUserText` (turns popped) so the conversation has something to extend from.

`buildCursorRequest(modelId, parsed, checkpoint?, blobStore?)` produces:
- `AgentRunRequest` with `conversationState`, `action: { userMessageAction: { userMessage } }`, `modelDetails: { modelId, displayModelId, displayName }`, `conversationId` (deterministic UUIDv4 from `convKey`).
- If `checkpoint` is present, `conversationState` is decoded from it; otherwise built from `turns`.
- System prompt blob registered in `blobStore` as a SHA-256-keyed entry; `rootPromptMessagesJson` references the blob ID.
- Returns `{ requestBytes, blobStore, mcpTools }` (mcpTools built separately from `context.tools`).

`mcpTools`: each pi `Tool` becomes an `McpToolDefinition` with `providerIdentifier: "pi"`, `toolName: tool.name`, and `inputSchema` = `tool.parameters` serialized through `protobuf.Value`.

## Native Tool Redirection

Cursor's model issues calls to its native tools and to MCP tools. We intercept all native calls in `cursor-messages.ts`'s exec handler and either redirect to a pi tool or reject:

| Native Cursor case | Pi tool call | Result encoding |
|---|---|---|
| `readArgs` | `read({ path, offset?, limit? })` | native `ReadResult` |
| `writeArgs` | `write({ path, content })` | native `WriteResult` |
| `deleteArgs` | `bash({ command: "rm -f -- '<safe-path>'" })` | native `DeleteResult` |
| `fetchArgs` | `fetch_content({ url })` (pi-web-access) | native `FetchResult` |
| `shellArgs` | `bash({ command, timeout? })` | native `ShellResult` |
| `shellStreamArgs` | `bash({ command, timeout? })` | native `ShellStream` events (start / stdout / exit + streamClose) |
| `lsArgs` | `ls({ path })` | MCP text fallback |
| `grepArgs` (with `pattern`) | `grep({ pattern, path?, glob?, ignoreCase?, context?, limit? })` | parsed → native `GrepResult` (files / content) |
| `grepArgs` (only `glob`) | `find({ pattern: glob, path? })` | native `GrepResult` files-with-matches shape |
| `mcpArgs` | `<toolName>(args)` pass-through | native `McpResult` text |
| `diagnosticsArgs` | — | empty `DiagnosticsResult` |
| `backgroundShellSpawnArgs` | — | rejected with explanation |
| `writeShellStdinArgs` | — | error result with explanation |
| `recordScreenArgs`, `computerUseArgs`, `listMcpResourcesExecArgs`, `readMcpResourceExecArgs` | — | empty/error result |

**Pi tool argument names** (verified against the installed pi-coding-agent version, **not** the opencode-cursor names):
- `read`: `{ path, offset?, limit? }` — uses `path`, not `filePath`
- `write`: `{ path, content }` — uses `path`
- `edit`: `{ path, edits }` (with `edits[]` carrying `oldText`/`newText`)
- `bash`: `{ command, timeout? }` — **no** `working_directory`, **no** `description`
- `grep`: `{ pattern, path?, glob?, ignoreCase?, literal?, context?, limit? }` — uses `ignoreCase` (not `-i`), `context` (not `-A`/`-B`/`-C`), and has no `output_mode` / `multiline` / `head_limit` / `type`
- `find`: `{ pattern, path?, limit? }` — `pattern` accepts glob/regex; no `glob_pattern`/`target_directory`
- `ls`: `{ path?, limit? }`
- `fetch_content` (pi-web-access): `{ url? | urls?, prompt?, ... }`

**Argument translation** (Cursor native args → pi tool args), applied in `nativeToMcpRedirect`:
- `readArgs.path` → `path` (and `offset`, `limit` if non-zero)
- `writeArgs`: read `fileBytes` (decode UTF-8) or `fileText` → `content`; `path` → `path`
- `deleteArgs.path` → POSIX-quoted path inside `bash` command (see safety note below)
- `fetchArgs.url` → `url` (single URL, since Cursor's fetch is one URL at a time)
- `shellArgs.command` → `command`; `shellArgs.timeout` (seconds) → `timeout`. Cursor's `workingDirectory` is **dropped** (logged warning) — pi's bash has no equivalent; if Cursor really wants a cwd, the model can `cd` in the command.
- `lsArgs.path` → `path`
- `grepArgs`:
  - `pattern` → `pattern` (default to `"."` if Cursor sent only `glob`)
  - `path` → `path`
  - `glob` → `glob`
  - `caseInsensitive` → `ignoreCase`
  - `context`/`contextBefore`/`contextAfter` (Cursor sends them separately) → max into `context`
  - `outputMode` is **not** sent to pi (no equivalent), but **remembered in `nativeArgs`** so the result formatter knows whether to emit a `count` / `files` / `content` GrepResult. `count` mode falls back to MCP text (pi grep has no count mode).
  - `multiline`, `headLimit`, `type` are dropped (no pi equivalents)

**Path safety in `deleteArgs`**: strip NUL bytes, single-quote-wrap, escape embedded single quotes (`'` → `'\''`). POSIX-safe.

**Grep result parsing**: pi's `grep` returns ripgrep-shaped text. Parse by the *Cursor-side* `outputMode` recorded in `nativeArgs`:
- `content`: `file:lineNum:text` for matches, `file-lineNum-text` for context lines (using `currentFile` prefix to disambiguate hyphens in filenames)
- `files_with_matches`: one path per line
- `count`: fall back to MCP text — pi grep doesn't emit count format
- Fallback to MCP text when output is non-empty but parses to zero items, or when `outputMode` is unrecognized.

**Pi-web-access fallback**: `fetchArgs` requires the `fetch_content` tool to exist in `context.tools`. If absent, return `FetchError` with a message asking the user to install `pi-web-access`. Detected at exec time.

The list of tools we declare to Cursor in `requestContextResult` is exactly `context.tools` (passed through `buildMcpToolDefinitions`). Native tools are *not* declared — the model knows them from training.

## Streaming Event Mapping

```
Cursor                                pi.AssistantMessageEventStream
─────────────────────────────────────────────────────────────────────
session start                         { type: "start", partial }

textDelta                             text block: text_start / text_delta / ...
  (run through thinking-tag filter:
   <think>...</think> in text →       
   thinking deltas instead)
thinkingDelta                         thinking block: thinking_start / thinking_delta / ...
tokenDelta                            output.usage.output += tokens (not emitted yet)
checkpointUpdate.tokenDetails         output.usage.totalTokens = usedTokens

mcpArgs / native exec args            close any open text/thinking blocks
  → redirect via native-tools         open toolCall block (own contentIndex):
  → push PendingExec                    toolcall_start
  → enqueue toolCall event              toolcall_delta { delta: argsJson }
                                        toolcall_end { toolCall }

[boundary: checkpoint+pendingExecs>0,
 stepCompleted+pendingExecs>0,
 turnEnded+pendingExecs>0,
 requestContextArgs+pendingExecs>0]
  (no event emitted — wait for batchReady)

batchReady (from session)             output.stopReason = "toolUse"
                                      computeUsage(model, output)
                                      { type: "done", reason: "toolUse", message: output }
                                      ← session stays alive in bridges map

done (from session)                   output.stopReason = "stop" | "error"
                                      { type: "done" | "error", ... }
                                      ← session removed from bridges map

[abort signal from pi options]        close session
                                      { type: "error", reason: "aborted", error: output }
```

**Block reuse rules** (avoids fragmenting deltas across micro-blocks):
- Reuse the current text block if it's the last content block in `output.content`.
- Reuse the current thinking block similarly.
- Before opening a toolCall block, close all open text/thinking blocks (`text_end` / `thinking_end`).
- Multiple tool calls in a batch get distinct content indices.

**Thinking-tag filter** (`thinking-filter.ts`): some Cursor models (e.g. composer-2) emit `<think>...</think>` *inside* text content rather than via `thinkingDelta`. The filter is a streaming state machine over text deltas, splitting them into `{ content, reasoning }` and emitting via `appendText` / `appendThinking`. Tag names recognized: `think`, `thinking`, `reasoning`, `thought`, `think_intent`. Trailing partial `<` is buffered up to 16 chars in case the next delta completes a tag.

**Usage accounting**: at `done` we set `output.usage.input = max(0, totalTokens - output.usage.output)` and call pi's `calculateCost(model, output.usage)`.

## OAuth Flow & Credentials

Use pi's `oauth` provider hook so `/login cursor` and `/logout cursor` Just Work:

```typescript
oauth: {
  name: "Cursor",

  async login(callbacks):
    // 1. PKCE
    verifier = base64url(96 random bytes)
    challenge = base64url(SHA-256(verifier))
    uuid = crypto.randomUUID()
    
    // 2. Open browser
    callbacks.onAuth({ url:
      "https://cursor.com/loginDeepControl"
      + "?challenge=" + challenge
      + "&uuid=" + uuid
      + "&mode=login&redirectTarget=cli"
    })
    
    // 3. Poll for completion
    //    1s base delay, ×1.2 backoff, 10s cap, 150 attempts max
    //    404 = not yet, 200 = done with { accessToken, refreshToken }
    //    3 consecutive non-404 errors aborts
    { accessToken, refreshToken } = await pollCursorAuth(uuid, verifier)
    
    return {
      access: accessToken,
      refresh: refreshToken,
      expires: jwtExp(accessToken) - 5*60*1000,  // 5-min safety margin
    }

  async refreshToken(creds):
    POST https://api2.cursor.sh/auth/exchange_user_api_key
      Authorization: Bearer ${creds.refresh}
      Content-Type: application/json
      body: "{}"
    → { accessToken, refreshToken? }
    return { access, refresh: refreshToken ?? creds.refresh, expires: jwtExp(access) - 5min }

  getApiKey(creds): creds.access
}
```

Pi handles "is it expired?" automatically before each `streamSimple` call and invokes `refreshToken` when needed. The access token arrives in `streamSimple` as `options.apiKey`.

**JWT expiry parsing**: split on `.`, base64url-decode the payload, read `exp` (seconds), return `exp*1000 - 5*60*1000`. If unparseable, fall back to `Date.now() + 3600*1000`.

**Credentials storage**: pi writes to `~/.pi/agent/auth.json` under the `"cursor"` key as `{ type: "oauth", access, refresh, expires }`. We never read/write this file directly. (The previous attempt cached a `cursorModels` field there — we explicitly do **not** repeat that. Stale cached models are confusing; discovery is fast at startup.)

**Env-var override**: `CURSOR_ACCESS_TOKEN` env var bypasses OAuth (matches pi convention from `apiKey: "CURSOR_ACCESS_TOKEN"`). Useful for CI.

## Model Discovery

Three-tier, run once during the async extension factory (so models exist before `pi --list-models` and the `/model` picker):

```
1. AvailableModels RPC      POST /aiserver.v1.AiService/AvailableModels
                              { includeLongContextModels: true,
                                includeHiddenModels: true }
                            → list of { name, clientDisplayName, supportsThinking }
                            Then in parallel (concurrency=12, 5s timeout each):
                              GetEffectiveTokenLimit RPC → context window
                            Merge and cache for the session.

2. GetUsableModels RPC      POST /agent.v1.AgentService/GetUsableModels
                              {} (legacy fallback)
                            → no per-model context windows, use MODEL_LIMITS table

3. FALLBACK_MODELS          Hardcoded last resort. Logged with warning.
```

Each `CursorModel` becomes a pi-registered model `cursor/<id>`:
- `id`: Cursor's model ID verbatim
- `name`: `clientDisplayName` if set, else pretty-formatted from id
- `reasoning`: `supportsThinking` || id contains thinking-effort suffix (`-high`, `-medium`, `-low`, `-extra-high`, `-thinking`, `-fast`)
- `input`: `["text"]` (no image/audio support on this RPC)
- `cost`: looked up via `MODEL_COST_TABLE` exact match → strip suffix → pattern match → default
- `contextWindow`: from RPC, else `MODEL_LIMITS` table, else 200000
- `maxTokens`: 64000 default, 128000 for opus / gpt-5.x / codex (pattern match)

**Reasoning-effort variants are distinct models**, not a "thinking level" axis. Cursor's protocol takes the model ID as-is — the suffix *is* the wire signal. Pi already supports per-model selection via `enabledModels`.

**`MODEL_COST_TABLE`** lifted from opencode-cursor. Patterns checked most-specific first (`/claude.*opus.*fast/` before `/claude.*opus/` before `/claude/`).

## Cursor-Specific Options

**Max mode**: Cursor's "max mode" toggle (longer context, higher cost). Default **on**. Override via:
- `CURSOR_MAX_MODE=false` env var (global)
- `options.metadata?.maxMode` per-call (so a prompt-customizer extension can flip it)

Encoded in the protobuf via `requestContext.cloudRule` and the request headers (mirroring opencode-cursor's `max-mode.ts`).

**Tool choice**: pi's `Context` doesn't currently surface OpenAI-style `tool_choice`. We always run with `auto` semantics — send all `context.tools` to Cursor, let the model decide. If pi adds tool_choice, we'll filter `mcpTools` in `cursor-request.ts`.

## Inactivity Timer Phases

| Phase | Timeout | Resets on |
|---|---|---|
| THINKING | 30s | session start, after sendToolResults — waiting for first model output |
| STREAMING | 15s | every text/thinking delta during normal generation |
| COLLECTING | 30s absolute | tool calls arriving, no boundary signal yet (does **not** reset on heartbeats) |
| FLUSHED | 10min absolute | bridge alive, waiting for pi to send tool results back |

THINKING fires once per cold start. STREAMING resets on every non-heartbeat message. COLLECTING is a non-sliding deadline (so heartbeats can't prevent flushing a tool batch). FLUSHED is a hard ceiling (pi can't sit on tool calls forever).

On COLLECTING timeout: force `batchReady` (safety net — flush pending execs even without a checkpoint signal). On FLUSHED timeout: emit `done` with error, close session.

## Errors, Retries, Abort

`retry.ts` classifies Connect end-stream errors:

| Error | Retry policy |
|---|---|
| `timeout` (no meaningful data within phase deadline) | up to 5 attempts, exponential backoff 500ms→4s, restart H2 stream from last checkpoint |
| `resource_exhausted` (Cursor server overload) | up to 10 attempts, same backoff |
| `blob_not_found` (checkpoint corruption) | drop conversation cache for `convKey`, retry once with fresh state (no checkpoint) |
| anything else | propagate as `stopReason: "error"` with the Connect error message |

Retries happen *inside* the session — the pump loop just sees a slightly delayed `done`. Exponential backoff: `delay = min(500ms × 2^attempt, 4s)`. Each retry decrements the relevant counter; when exhausted, propagate the error.

**Abort handling**: `options.signal.addEventListener("abort", () => session.close())`. The pump loop catches the resulting `done` event, sees `output.stopReason === "aborted"`, and emits `{ type: "error", reason: "aborted", error: output }`.

## Commands

| Command | Behavior |
|---|---|
| `/cursor-refresh-models` | Re-run model discovery, re-register the provider with the fresh list. Useful when Cursor adds new models. Lifted from previous attempt. |
| `/cursor-cleanup` | Close all in-memory bridges, clear conversation cache. Useful if anything wedges. Lifted from previous attempt. |

## Testing Strategy

The previous attempt had no tests. For the rewrite:

| Layer | Approach |
|---|---|
| Pure utilities (`pkce`, `protocol` framing, `thinking-filter`, grep parsing, JWT expiry) | Unit tests, no network. Run via `node --test` or `vitest` if pi extensions support it. |
| `pi-context.ts` | Snapshot tests over representative pi `Context` shapes (new turn, resume after tool calls, system-only, image content). |
| `native-tools.ts` redirect mapping | Table-driven tests: input native exec → expected `{ toolName, decodedArgs, nativeResultType, nativeArgs }`. |
| `cursor-session.ts` batch state machine | Hand-written `MockH2Stream` that emits framed protobuf messages; assert event queue contents and state transitions. |
| End-to-end | Manual smoke test against real Cursor backend with a small prompt that exercises tools (read/write/grep) and parallel calls. Captured in a debug log we can diff against. |

We will *not* port opencode-cursor's semantic fuzz suite — that's enormous and tests the proxy's resume semantics which we don't have. The state-machine tests cover the equivalent of their happy-path proxy tests.

## Build & Deploy

The extension is a directory at `.pi/extensions/cursor/` with `package.json` + TypeScript files. Pi auto-discovers it via the project-local extension path and loads through jiti (no compilation needed).

`package.json` declares `@bufbuild/protobuf` as a runtime dep. The `proto/*.ts` files are committed (generated from opencode-cursor's `proto/agent.proto` + `aiserver.proto` via `buf generate`); we don't run `buf` ourselves.

Existing `pi/settings.json` already has `"defaultProvider": "cursor"` and the enabled-models list — no settings changes needed once the extension loads cleanly.

## Open Questions

1. **`fetch_content` graceful degradation**: when pi-web-access is missing, do we (a) reject `fetchArgs` calls with a clear message, (b) fall back to native Node `fetch` with no rendering, or (c) hard-error at extension load? Default plan: (a).
2. **Reasoning-effort variant filtering**: Cursor exposes a *lot* of variants per base model (gpt-5.5-extra-high, -high, -medium, -low, -none, etc.). Should we register them all and let the user pick via `enabledModels`, or default-hide the rarely-used ones? Default plan: register all, no filter.
3. **Logging**: opencode-cursor has structured `logDebug/logWarn/logError` routed through OpenCode's plugin log API. Pi has `ctx.ui.notify`, but no equivalent at the streamSimple level. Default plan: write to `~/.pi/agent/cursor-debug.log` (matches the existing log path the user already has) when `CURSOR_PROXY_DEBUG=1`, no-op otherwise.

## Related Code

- Previous attempt: `git show a6391ed:pi/extensions/cursor/index.ts` (1193 lines, removed in current working tree)
- Reference: https://github.com/Hardcode84/opencode-cursor (Apache-2.0)
- Pi extension docs: `/home/ruicaridade/.local/share/mise/installs/node/25.0.0/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
- Pi custom-provider docs: `…/docs/custom-provider.md`
- Existing project-local extension example: `pi/extensions/codex-status.ts`
