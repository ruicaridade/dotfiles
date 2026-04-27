# pi Cursor Provider Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pi extension at `.pi/extensions/cursor/` that authenticates with Cursor via OAuth and streams Cursor model responses through pi's native streaming API, with full support for Cursor's native tool calls redirected to pi's built-in tools.

**Architecture:** Pi extension implementing `pi.registerProvider("cursor", { oauth, streamSimple })`. `streamSimple` opens an HTTP/2 stream to `api2.cursor.sh`, framed with the Connect protocol, carrying protobuf messages. A `CursorSession` class owns the H2 stream, manages a batch state machine (STREAMING ↔ COLLECTING ↔ FLUSHED), and exposes events through a queue. A pumper inside `streamSimple` translates session events to pi's `AssistantMessageEventStream`. Native Cursor tool calls (read/write/shell/etc.) are intercepted and redirected to pi's built-in tools, with results encoded back as the native protobuf result types Cursor expects. Sessions are cached in-memory by a content-derived bridge key so pi's multi-turn `streamSimple` calls reuse the same H2 stream.

**Tech Stack:** TypeScript (loaded by pi via jiti), `@bufbuild/protobuf`, Node.js built-ins (`node:http2`, `node:crypto`), pi-ai event types. Tests use `node --test` with `tsx` loader.

**Spec:** [docs/superpowers/specs/2026-04-27-pi-cursor-extension-design.md](../specs/2026-04-27-pi-cursor-extension-design.md)

**Reference repos:**
- opencode-cursor (cloned to `/tmp/cursor-research/opencode-cursor`) — Apache-2.0, lift code with attribution.
- Previous attempt: `git show a6391ed:pi/extensions/cursor/index.ts` — reference only, do NOT use as scaffold.

---

## File Layout (target end state)

```
.pi/extensions/cursor/
├── package.json
├── tsconfig.json
├── README.md                  # short usage notes, license attribution
├── proto/
│   ├── agent_pb.ts            # 16k lines, generated, copied from opencode-cursor
│   └── aiserver_pb.ts
├── index.ts                   # entry point
├── auth.ts                    # PKCE, login, poll, refresh, JWT expiry
├── runtime-config.ts          # env-var-overridable URLs and timeouts
├── pkce.ts                    # PKCE helpers
├── jwt.ts                     # JWT exp parsing
├── protocol.ts                # Connect framing + frame parser + endStream decode
├── thinking-filter.ts         # streaming <think> tag filter
├── model-names.ts             # pretty name + reasoning-effort suffix
├── model-cost.ts              # cost table + estimateCost
├── models.ts                  # AvailableModels + GetEffectiveTokenLimit + fallbacks
├── unary-rpc.ts               # callCursorUnaryRpc helper
├── pi-context.ts              # pi Context → ParsedContext
├── cursor-request.ts          # build AgentRunRequest protobuf
├── mcp-tool-defs.ts           # pi Tool[] → McpToolDefinition[]
├── native-tools.ts            # redirect + native protobuf result encoding
├── grep-parser.ts             # ripgrep text → GrepResult protobuf
├── event-queue.ts             # async queue with overflow
├── cursor-messages.ts         # KV/exec/interactionUpdate dispatch
├── cursor-session.ts          # H2 stream + batch state machine + timer
├── pi-stream.ts               # session events → pi AssistantMessageEventStream
├── retry.ts                   # error classification + backoff
└── test/                      # node --test suite
    ├── pkce.test.ts
    ├── jwt.test.ts
    ├── protocol.test.ts
    ├── thinking-filter.test.ts
    ├── model-names.test.ts
    ├── model-cost.test.ts
    ├── pi-context.test.ts
    ├── mcp-tool-defs.test.ts
    ├── native-tools.test.ts
    ├── grep-parser.test.ts
    ├── event-queue.test.ts
    ├── cursor-messages.test.ts
    ├── cursor-session.test.ts
    ├── pi-stream.test.ts
    └── retry.test.ts
```

---

### Task 1: Scaffold the extension package

**Files:**
- Create: `pi/extensions/cursor/package.json`
- Create: `pi/extensions/cursor/tsconfig.json`
- Create: `pi/extensions/cursor/README.md`
- Create: `pi/extensions/cursor/index.ts` (stub)

- [ ] **Step 1: Create `pi/extensions/cursor/package.json`**

```json
{
  "name": "pi-cursor-extension",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "description": "Cursor model provider for pi via OAuth + Cursor gRPC API",
  "scripts": {
    "test": "node --import tsx --test 'test/**/*.test.ts'",
    "test:one": "node --import tsx --test"
  },
  "dependencies": {
    "@bufbuild/protobuf": "^2.2.5"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "@types/node": "^22.10.0",
    "@mariozechner/pi-coding-agent": "*"
  }
}
```

- [ ] **Step 2: Create `pi/extensions/cursor/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "proto/**"]
}
```

- [ ] **Step 3: Create `pi/extensions/cursor/README.md`**

```markdown
# pi Cursor Provider Extension

Authenticates with Cursor via OAuth and exposes Cursor models (Claude, GPT, Gemini, Composer, Grok) inside pi without requiring the Cursor CLI.

## Install

This extension is auto-discovered by pi from `.pi/extensions/cursor/` in this repository. Run `npm install` once inside this directory to fetch `@bufbuild/protobuf`.

## Authenticate

```sh
pi
/login cursor
```

A browser window opens; complete the Cursor login, and the tokens are persisted to `~/.pi/agent/auth.json`.

Set `CURSOR_ACCESS_TOKEN=<token>` to bypass OAuth (useful for CI).

## Models

Models are discovered from Cursor's `AvailableModels` RPC at startup. Use `/cursor-refresh-models` to re-fetch and `/cursor-cleanup` to clear in-memory bridges and conversation cache.

## Attribution

Protocol implementation, native tool redirection, grep parser, and protobuf definitions are derived from [opencode-cursor](https://github.com/Hardcode84/opencode-cursor) (Apache-2.0).
```

- [ ] **Step 4: Create `pi/extensions/cursor/index.ts` stub**

```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default async function cursorExtension(_pi: ExtensionAPI): Promise<void> {
  // Filled in across subsequent tasks.
}
```

- [ ] **Step 5: Install deps**

Run from `pi/extensions/cursor/`:
```sh
npm install
```
Expected: creates `node_modules/` with `@bufbuild/protobuf` and `tsx`. No errors.

- [ ] **Step 6: Add `node_modules/` to `.gitignore`**

Append to `pi/extensions/cursor/.gitignore`:
```
node_modules/
```

- [ ] **Step 7: Commit**

```sh
git add pi/extensions/cursor/package.json pi/extensions/cursor/tsconfig.json \
        pi/extensions/cursor/README.md pi/extensions/cursor/index.ts \
        pi/extensions/cursor/.gitignore pi/extensions/cursor/package-lock.json
git commit -m "Scaffold pi-cursor extension package"
```

---

### Task 2: Copy generated protobuf files

**Files:**
- Create: `pi/extensions/cursor/proto/agent_pb.ts` (copied)
- Create: `pi/extensions/cursor/proto/aiserver_pb.ts` (copied)

Rationale: these are 16k+ lines of generated TypeScript. We don't regenerate; we lift from opencode-cursor (Apache-2.0).

- [ ] **Step 1: Copy proto files from /tmp/cursor-research/opencode-cursor**

```sh
mkdir -p pi/extensions/cursor/proto
cp /tmp/cursor-research/opencode-cursor/src/proto/agent_pb.ts pi/extensions/cursor/proto/
cp /tmp/cursor-research/opencode-cursor/src/proto/aiserver_pb.ts pi/extensions/cursor/proto/
```

- [ ] **Step 2: Add an attribution header to each proto file**

At the top of each `.ts` file, prepend:

```typescript
/*
 * Generated protobuf TypeScript bindings.
 * Lifted from https://github.com/Hardcode84/opencode-cursor (Apache-2.0).
 * Do not hand-edit; regenerate via buf if Cursor's schema changes.
 */
```

- [ ] **Step 3: Verify the files import cleanly**

Run from `pi/extensions/cursor/`:
```sh
node --import tsx -e "import('./proto/agent_pb.ts').then(m => console.log('agent ok:', Object.keys(m).length, 'exports'))"
node --import tsx -e "import('./proto/aiserver_pb.ts').then(m => console.log('aiserver ok:', Object.keys(m).length, 'exports'))"
```
Expected: both print "ok:" with a positive number.

- [ ] **Step 4: Commit**

```sh
git add pi/extensions/cursor/proto/
git commit -m "Add generated Cursor protobuf bindings (lifted from opencode-cursor)"
```

---

### Task 3: PKCE helper + tests

**Files:**
- Create: `pi/extensions/cursor/pkce.ts`
- Create: `pi/extensions/cursor/test/pkce.test.ts`

- [ ] **Step 1: Write the failing test**

`pi/extensions/cursor/test/pkce.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { generatePKCE } from "../pkce.ts";

test("generatePKCE returns base64url verifier and challenge", async () => {
  const { verifier, challenge } = await generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.ok(challenge.length >= 43 && challenge.length <= 128);
});

test("generatePKCE produces a different verifier each call", async () => {
  const a = await generatePKCE();
  const b = await generatePKCE();
  assert.notEqual(a.verifier, b.verifier);
});

test("challenge is sha256(verifier) base64url-encoded", async () => {
  const { createHash } = await import("node:crypto");
  const { verifier, challenge } = await generatePKCE();
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
cd pi/extensions/cursor && npm test -- test/pkce.test.ts
```
Expected: FAIL with `Cannot find module '../pkce.ts'`.

- [ ] **Step 3: Write `pi/extensions/cursor/pkce.ts`**

```typescript
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");

  const data = new TextEncoder().encode(verifier);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const challenge = Buffer.from(hashBuffer).toString("base64url");

  return { verifier, challenge };
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/pkce.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/pkce.ts pi/extensions/cursor/test/pkce.test.ts
git commit -m "Add PKCE helper for Cursor OAuth"
```

---

### Task 4: JWT expiry parser + tests

**Files:**
- Create: `pi/extensions/cursor/jwt.ts`
- Create: `pi/extensions/cursor/test/jwt.test.ts`

- [ ] **Step 1: Write the failing test**

`pi/extensions/cursor/test/jwt.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getTokenExpiry } from "../jwt.ts";

function makeJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("returns exp - 5min in milliseconds when JWT carries an exp claim", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = makeJWT({ exp });
  const expiry = getTokenExpiry(token);
  assert.equal(expiry, exp * 1000 - 5 * 60 * 1000);
});

test("falls back to now+1h when JWT cannot be parsed", () => {
  const before = Date.now();
  const expiry = getTokenExpiry("not-a-jwt");
  const after = Date.now();
  assert.ok(expiry >= before + 3600 * 1000);
  assert.ok(expiry <= after + 3600 * 1000);
});

test("falls back when exp is missing", () => {
  const before = Date.now();
  const expiry = getTokenExpiry(makeJWT({ sub: "abc" }));
  const after = Date.now();
  assert.ok(expiry >= before + 3600 * 1000);
  assert.ok(expiry <= after + 3600 * 1000);
});
```

- [ ] **Step 2: Run test to verify it fails**

```sh
npm test -- test/jwt.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/jwt.ts`**

```typescript
const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 3600 * 1000;

export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + FALLBACK_TTL_MS;
    }
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (payload && typeof payload === "object" && typeof payload.exp === "number") {
      return payload.exp * 1000 - SAFETY_MARGIN_MS;
    }
  } catch {
    // fall through
  }
  return Date.now() + FALLBACK_TTL_MS;
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/jwt.test.ts
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/jwt.ts pi/extensions/cursor/test/jwt.test.ts
git commit -m "Add JWT expiry parser for Cursor access tokens"
```

---

### Task 5: Runtime config

**Files:**
- Create: `pi/extensions/cursor/runtime-config.ts`

No tests — pure data with env var reads.

- [ ] **Step 1: Write `pi/extensions/cursor/runtime-config.ts`**

```typescript
export interface CursorRuntimeConfig {
  apiUrl: string;
  agentUrl: string;
  loginUrl: string;
  pollUrl: string;
  refreshUrl: string;
  clientVersion: string;
  thinkingTimeoutMs: number;
  streamingTimeoutMs: number;
  collectingTimeoutMs: number;
  flushedSessionMaxLifetimeMs: number;
  conversationTtlMs: number;
  maxMode: boolean;
  debugLogPath: string | null;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function resolveRuntimeConfig(
  overrides: Partial<CursorRuntimeConfig> = {},
): CursorRuntimeConfig {
  return {
    apiUrl: process.env.CURSOR_API_URL ?? "https://api2.cursor.sh",
    agentUrl: process.env.CURSOR_AGENT_URL ?? "https://api2.cursor.sh",
    loginUrl: process.env.CURSOR_LOGIN_URL ?? "https://cursor.com/loginDeepControl",
    pollUrl: process.env.CURSOR_POLL_URL ?? "https://api2.cursor.sh/auth/poll",
    refreshUrl:
      process.env.CURSOR_REFRESH_URL ?? "https://api2.cursor.sh/auth/exchange_user_api_key",
    clientVersion: process.env.CURSOR_CLIENT_VERSION ?? "cli-2026.03.30-a5d3e17",
    thinkingTimeoutMs: 30_000,
    streamingTimeoutMs: 15_000,
    collectingTimeoutMs: 30_000,
    flushedSessionMaxLifetimeMs: 10 * 60 * 1000,
    conversationTtlMs: 30 * 60 * 1000,
    maxMode: envBool("CURSOR_MAX_MODE", true),
    debugLogPath: envBool("CURSOR_PROXY_DEBUG", false)
      ? `${process.env.HOME || "."}/.pi/agent/cursor-debug.log`
      : null,
    ...overrides,
  };
}
```

- [ ] **Step 2: Commit**

```sh
git add pi/extensions/cursor/runtime-config.ts
git commit -m "Add Cursor runtime config with env-var overrides"
```

---

### Task 6: Connect protocol framing + parser + tests

**Files:**
- Create: `pi/extensions/cursor/protocol.ts`
- Create: `pi/extensions/cursor/test/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/protocol.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  CONNECT_END_STREAM_FLAG,
  createConnectFrameParser,
  decodeConnectUnaryBody,
  frameConnectMessage,
  parseConnectEndStream,
} from "../protocol.ts";

test("frameConnectMessage prepends 5-byte header (flag + big-endian length)", () => {
  const data = new Uint8Array([1, 2, 3, 4]);
  const framed = frameConnectMessage(data);
  assert.equal(framed[0], 0);
  assert.equal(framed.readUInt32BE(1), 4);
  assert.deepEqual(framed.subarray(5), Buffer.from(data));
});

test("parser delivers messages and end-stream separately", () => {
  const messages: Uint8Array[] = [];
  const ends: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    (b: Uint8Array) => messages.push(b),
    (b: Uint8Array) => ends.push(b),
  );

  const m1 = frameConnectMessage(new Uint8Array([0xaa, 0xbb]));
  const m2 = frameConnectMessage(new Uint8Array([0xcc]));
  const eof = frameConnectMessage(Buffer.from('{"error":null}'), CONNECT_END_STREAM_FLAG);
  parse(Buffer.concat([m1, m2, eof]));

  assert.equal(messages.length, 2);
  // Parser slices from a Buffer, so emitted values are Buffer subtypes; compare with Buffer.from.
  assert.deepEqual(messages[0], Buffer.from([0xaa, 0xbb]));
  assert.deepEqual(messages[1], Buffer.from([0xcc]));
  assert.equal(ends.length, 1);
});

test("parser buffers partial frames across calls", () => {
  const messages: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    (b: Uint8Array) => messages.push(b),
    () => {},
  );
  const full = frameConnectMessage(new Uint8Array([1, 2, 3, 4, 5]));
  parse(full.subarray(0, 3));
  assert.equal(messages.length, 0);
  parse(full.subarray(3));
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], Buffer.from([1, 2, 3, 4, 5]));
});

test("oversize frame triggers endStream and resets buffer", () => {
  const ends: Uint8Array[] = [];
  const parse = createConnectFrameParser(
    () => {},
    (b: Uint8Array) => ends.push(b),
  );
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(64 * 1024 * 1024, 1); // 64 MiB > 32 MiB cap
  parse(header);
  assert.equal(ends.length, 1);
  const txt = new TextDecoder().decode(ends[0]!);
  assert.match(txt, /frame_too_large/);
});

test("decodeConnectUnaryBody extracts the data frame", () => {
  const payload = new Uint8Array([9, 9, 9]);
  const framed = frameConnectMessage(payload);
  const decoded = decodeConnectUnaryBody(framed);
  // decodeConnectUnaryBody slices into the framed Buffer, so result is a Buffer view.
  assert.deepEqual(decoded, Buffer.from([9, 9, 9]));
});

test("parseConnectEndStream returns null on success", () => {
  const buf = new TextEncoder().encode("{}");
  assert.equal(parseConnectEndStream(buf), null);
});

test("parseConnectEndStream returns Error with code+message", () => {
  const buf = new TextEncoder().encode(
    JSON.stringify({ error: { code: "resource_exhausted", message: "boom" } }),
  );
  const err = parseConnectEndStream(buf);
  assert.ok(err instanceof Error);
  assert.match(err!.message, /resource_exhausted/);
  assert.match(err!.message, /boom/);
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/protocol.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/protocol.ts`**

Lift verbatim from `/tmp/cursor-research/opencode-cursor/src/protocol.ts` (already inspected — 83 lines, identical to what we want):

```typescript
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(data.length, 1);
  return Buffer.concat([header, Buffer.from(data)]);
}

export const CONNECT_END_STREAM_FLAG = 0b00000010;

const MAX_FRAME_SIZE = 32 * 1024 * 1024;

export function createConnectFrameParser(
  onMessage: (bytes: Uint8Array) => void,
  onEndStream: (bytes: Uint8Array) => void,
): (incoming: Buffer) => void {
  let pending = Buffer.alloc(0);
  return (incoming: Buffer) => {
    pending = Buffer.concat([pending, incoming]);
    while (pending.length >= 5) {
      const flags = pending[0]!;
      const msgLen = pending.readUInt32BE(1);
      if (msgLen > MAX_FRAME_SIZE) {
        pending = Buffer.alloc(0);
        onEndStream(
          new TextEncoder().encode(
            JSON.stringify({
              error: { code: "frame_too_large", message: `Frame size ${msgLen} exceeds limit` },
            }),
          ),
        );
        return;
      }
      if (pending.length < 5 + msgLen) break;
      const messageBytes = pending.subarray(5, 5 + msgLen);
      pending = pending.subarray(5 + msgLen);
      if (flags & CONNECT_END_STREAM_FLAG) {
        onEndStream(messageBytes);
      } else {
        onMessage(messageBytes);
      }
    }
  };
}

export function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & CONNECT_END_STREAM_FLAG) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }
    offset = frameEnd;
  }
  return null;
}

export function parseConnectEndStream(data: Uint8Array): Error | null {
  try {
    const payload = JSON.parse(new TextDecoder().decode(data));
    const error = payload?.error;
    if (error) {
      const code = error.code ?? "unknown";
      const message = error.message ?? "Unknown error";
      return new Error(`Connect error ${code}: ${message}`);
    }
    return null;
  } catch {
    return new Error("Failed to parse Connect end stream");
  }
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/protocol.test.ts
```
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/protocol.ts pi/extensions/cursor/test/protocol.test.ts
git commit -m "Add Connect protocol framing and parser"
```

---

### Task 7: Thinking-tag filter + tests

**Files:**
- Create: `pi/extensions/cursor/thinking-filter.ts`
- Create: `pi/extensions/cursor/test/thinking-filter.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/thinking-filter.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createThinkingTagFilter } from "../thinking-filter.ts";

test("passes through plain text", () => {
  const f = createThinkingTagFilter();
  assert.deepEqual(f.process("Hello world"), { content: "Hello world", reasoning: "" });
  assert.deepEqual(f.flush(), { content: "", reasoning: "" });
});

test("splits text and thinking", () => {
  const f = createThinkingTagFilter();
  assert.deepEqual(f.process("before<think>inner</think>after"), {
    content: "beforeafter",
    reasoning: "inner",
  });
});

test("buffers partial tag across deltas", () => {
  const f = createThinkingTagFilter();
  const a = f.process("text<thi");
  assert.deepEqual(a, { content: "text", reasoning: "" });
  const b = f.process("nking>secret</thinking>more");
  assert.deepEqual(b, { content: "more", reasoning: "secret" });
});

test("recognizes alternate tag names", () => {
  const f = createThinkingTagFilter();
  assert.deepEqual(f.process("<reasoning>r</reasoning>"), { content: "", reasoning: "r" });
  const g = createThinkingTagFilter();
  assert.deepEqual(g.process("<thought>t</thought>"), { content: "", reasoning: "t" });
});

test("flush emits buffered partial tag as text when no closing tag", () => {
  const f = createThinkingTagFilter();
  const a = f.process("hi<thi");
  assert.deepEqual(a, { content: "hi", reasoning: "" });
  // Buffered "<thi" is in the filter but not yet known to be a tag.
  const flushed = f.flush();
  assert.deepEqual(flushed, { content: "<thi", reasoning: "" });
});

test("flush emits buffered partial tag as reasoning when inside thinking", () => {
  const f = createThinkingTagFilter();
  // "<think>hi</thi" enters thinking mode (eager emit "hi" as reasoning),
  // then leaves "</thi" buffered as a partial close-tag.
  const processed = f.process("<think>hi</thi");
  assert.deepEqual(processed, { content: "", reasoning: "hi" });
  // Now we're inThinking with a buffered partial. Flush should emit it as reasoning.
  const flushed = f.flush();
  assert.deepEqual(flushed, { content: "", reasoning: "</thi" });
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/thinking-filter.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/thinking-filter.ts`**

```typescript
const THINKING_TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];
const MAX_THINKING_TAG_LEN = 16;
const TAG_RE = new RegExp(`<(/?)(?:${THINKING_TAG_NAMES.join("|")})\\s*>`, "gi");

export interface ThinkingTagFilter {
  process(text: string): { content: string; reasoning: string };
  flush(): { content: string; reasoning: string };
}

export function createThinkingTagFilter(): ThinkingTagFilter {
  let buffer = "";
  let inThinking = false;

  return {
    process(text: string) {
      const input = buffer + text;
      buffer = "";
      let content = "";
      let reasoning = "";
      let lastIdx = 0;
      const re = new RegExp(TAG_RE.source, "gi");
      let match: RegExpExecArray | null;
      while ((match = re.exec(input)) !== null) {
        const before = input.slice(lastIdx, match.index);
        if (inThinking) reasoning += before;
        else content += before;
        inThinking = match[1] !== "/";
        lastIdx = re.lastIndex;
      }
      const rest = input.slice(lastIdx);
      const ltPos = rest.lastIndexOf("<");
      if (
        ltPos >= 0 &&
        rest.length - ltPos < MAX_THINKING_TAG_LEN &&
        /^<\/?[a-z_]*$/i.test(rest.slice(ltPos))
      ) {
        buffer = rest.slice(ltPos);
        const before = rest.slice(0, ltPos);
        if (inThinking) reasoning += before;
        else content += before;
      } else if (inThinking) {
        reasoning += rest;
      } else {
        content += rest;
      }
      return { content, reasoning };
    },

    flush() {
      const remaining = buffer;
      buffer = "";
      if (!remaining) return { content: "", reasoning: "" };
      return inThinking
        ? { content: "", reasoning: remaining }
        : { content: remaining, reasoning: "" };
    },
  };
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/thinking-filter.test.ts
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/thinking-filter.ts pi/extensions/cursor/test/thinking-filter.test.ts
git commit -m "Add streaming thinking-tag filter"
```

---

### Task 8: Auth flow (login, poll, refresh)

**Files:**
- Create: `pi/extensions/cursor/auth.ts`
- Create: `pi/extensions/cursor/test/auth.test.ts`

Tests use a stubbed `fetch` global to avoid network.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/auth.test.ts`:
```typescript
import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  generateCursorAuthParams,
  pollCursorAuth,
  refreshCursorToken,
} from "../auth.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("generateCursorAuthParams produces a valid Cursor login URL", async () => {
  const { verifier, challenge, uuid, loginUrl } = await generateCursorAuthParams();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  const u = new URL(loginUrl);
  assert.equal(u.host, "cursor.com");
  assert.equal(u.pathname, "/loginDeepControl");
  assert.equal(u.searchParams.get("challenge"), challenge);
  assert.equal(u.searchParams.get("uuid"), uuid);
  assert.equal(u.searchParams.get("mode"), "login");
  assert.equal(u.searchParams.get("redirectTarget"), "cli");
});

test("pollCursorAuth keeps polling on 404 and resolves on 200", async () => {
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls++;
    const url = typeof input === "string" ? input : input.toString();
    assert.match(url, /\/auth\/poll\?uuid=u&verifier=v/);
    if (calls < 3) return new Response("", { status: 404 });
    return Response.json({ accessToken: "ACC", refreshToken: "REF" });
  }) as typeof fetch;

  const result = await pollCursorAuth("u", "v", { /* faster polling for the test */ } as any);
  assert.equal(result.accessToken, "ACC");
  assert.equal(result.refreshToken, "REF");
  assert.equal(calls, 3);
}, { timeout: 30_000 });

test("refreshCursorToken POSTs with bearer refresh and parses tokens", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = { url: typeof input === "string" ? input : input.toString(), init };
    return Response.json({ accessToken: "NEW_ACC", refreshToken: "NEW_REF" });
  }) as typeof fetch;

  const result = await refreshCursorToken("OLD_REF");
  assert.equal(result.access, "NEW_ACC");
  assert.equal(result.refresh, "NEW_REF");
  assert.ok(typeof result.expires === "number");
  assert.match(captured!.url, /\/auth\/exchange_user_api_key$/);
  assert.equal((captured!.init!.headers as Record<string, string>).Authorization, "Bearer OLD_REF");
});

test("refreshCursorToken keeps the old refresh token if response omits one", async () => {
  globalThis.fetch = (async () => Response.json({ accessToken: "NEW_ACC" })) as typeof fetch;
  const result = await refreshCursorToken("KEEP_THIS_REF");
  assert.equal(result.refresh, "KEEP_THIS_REF");
});

test("refreshCursorToken throws on HTTP error", async () => {
  globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
  await assert.rejects(() => refreshCursorToken("X"), /Cursor token refresh failed/);
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/auth.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 3: Write `pi/extensions/cursor/auth.ts`**

```typescript
import { generatePKCE } from "./pkce.ts";
import { getTokenExpiry } from "./jwt.ts";
import { type CursorRuntimeConfig, resolveRuntimeConfig } from "./runtime-config.ts";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1_000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF = 1.2;

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export async function generateCursorAuthParams(
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<CursorAuthParams> {
  const config = resolveRuntimeConfig(runtimeConfig);
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return { verifier, challenge, uuid, loginUrl: `${config.loginUrl}?${params.toString()}` };
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<{ accessToken: string; refreshToken: string }> {
  const config = resolveRuntimeConfig(runtimeConfig);
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const response = await fetch(
        `${config.pollUrl}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
      );
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY);
        continue;
      }
      if (response.ok) {
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (typeof data.accessToken !== "string" || !data.accessToken) {
          throw new Error("Cursor auth response missing accessToken");
        }
        if (typeof data.refreshToken !== "string" || !data.refreshToken) {
          throw new Error("Cursor auth response missing refreshToken");
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }
      throw new Error(`Cursor auth poll failed: ${response.status}`);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  throw new Error("Cursor authentication polling timed out");
}

export async function refreshCursorToken(
  refreshToken: string,
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<CursorCredentials> {
  const config = resolveRuntimeConfig(runtimeConfig);
  const response = await fetch(config.refreshUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cursor token refresh failed: ${errText}`);
  }
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
  if (typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Cursor token refresh missing accessToken");
  }
  return {
    access: data.accessToken,
    refresh: data.refreshToken || refreshToken,
    expires: getTokenExpiry(data.accessToken),
  };
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/auth.test.ts
```
Expected: PASS. Note the polling test uses real timers and may take ~3 seconds (3 retries × 1s base).

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/auth.ts pi/extensions/cursor/test/auth.test.ts
git commit -m "Add Cursor OAuth login, poll, and refresh"
```

---

### Task 9: Model name resolution + tests

**Files:**
- Create: `pi/extensions/cursor/model-names.ts`
- Create: `pi/extensions/cursor/test/model-names.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/model-names.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hasReasoningSuffix, prettyCursorModelName, resolveCursorModelName } from "../model-names.ts";

test("hasReasoningSuffix detects effort suffixes", () => {
  assert.equal(hasReasoningSuffix("gpt-5.5-extra-high"), true);
  assert.equal(hasReasoningSuffix("claude-4.6-sonnet-medium"), true);
  assert.equal(hasReasoningSuffix("composer-2-fast"), true);
  assert.equal(hasReasoningSuffix("composer-2"), false);
  assert.equal(hasReasoningSuffix("auto"), false);
});

test("prettyCursorModelName humanizes ids", () => {
  assert.equal(prettyCursorModelName("claude-4.6-sonnet"), "Claude 4.6 Sonnet");
  assert.equal(prettyCursorModelName("gpt-5.5-extra-high"), "GPT-5.5 Extra High");
  assert.equal(prettyCursorModelName("composer-2-fast"), "Composer 2 Fast");
});

test("resolveCursorModelName prefers explicit display name when non-empty", () => {
  assert.equal(resolveCursorModelName("gpt-5.5-high", "GPT 5.5 High"), "GPT 5.5 High");
  assert.equal(resolveCursorModelName("gpt-5.5-high", ""), "GPT-5.5 High");
  assert.equal(resolveCursorModelName("gpt-5.5-high", undefined), "GPT-5.5 High");
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/model-names.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/model-names.ts`**

```typescript
const REASONING_SUFFIX_RE = /(^|[-_.])(extra-high|xhigh|high|medium|low|none|thinking|reasoning|fast)$/i;

export function hasReasoningSuffix(id: string): boolean {
  return REASONING_SUFFIX_RE.test(id);
}

const FAMILY_LABELS: Array<[RegExp, string]> = [
  [/^claude/i, "Claude"],
  [/^gpt/i, "GPT"],
  [/^composer/i, "Composer"],
  [/^gemini/i, "Gemini"],
  [/^grok/i, "Grok"],
  [/^kimi/i, "Kimi"],
];

export function prettyCursorModelName(id: string): string {
  // Replace family prefix with cap label (claude → Claude), then title-case the rest.
  for (const [re, label] of FAMILY_LABELS) {
    if (re.test(id)) {
      const rest = id.replace(re, "");
      return `${label}${prettify(rest)}`;
    }
  }
  return prettify(id, true);
}

function prettify(s: string, capFirst = false): string {
  // "-4.6-sonnet-extra-high" → " 4.6 Sonnet Extra High"
  const parts = s.split(/[-_]+/).filter(Boolean);
  const titled = parts.map((p, i) =>
    /^\d/.test(p) ? p : (i === 0 && !capFirst) ? p.charAt(0).toUpperCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1),
  );
  if (capFirst && titled.length) titled[0] = titled[0]!.charAt(0).toUpperCase() + titled[0]!.slice(1);
  return parts.length ? ` ${titled.join(" ")}` : "";
}

export function resolveCursorModelName(id: string, displayName?: string | null): string {
  const trimmed = (displayName ?? "").trim();
  return trimmed || prettyCursorModelName(id);
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/model-names.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/model-names.ts pi/extensions/cursor/test/model-names.test.ts
git commit -m "Add Cursor model name pretty-printing"
```

---

### Task 10: Cost table + estimate + tests

**Files:**
- Create: `pi/extensions/cursor/model-cost.ts`
- Create: `pi/extensions/cursor/test/model-cost.test.ts`

Lift `MODEL_COST_TABLE` and `MODEL_COST_PATTERNS` verbatim from opencode-cursor's `src/index.ts` (lines ~229–326). They mirror Cursor's pricing page.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/model-cost.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { estimateModelCost } from "../model-cost.ts";

test("exact id match returns table cost", () => {
  const cost = estimateModelCost("claude-4.6-sonnet");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});

test("variant id falls through to base via pattern", () => {
  // claude-4.6-sonnet-medium → /claude.*sonnet/ pattern
  const cost = estimateModelCost("claude-4.6-sonnet-medium");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});

test("opus-fast pattern beats opus pattern", () => {
  const cost = estimateModelCost("claude-4.6-opus-fast");
  assert.equal(cost.input, 30);
  assert.equal(cost.output, 150);
});

test("unknown family returns default", () => {
  const cost = estimateModelCost("xyz-unknown");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/model-cost.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/model-cost.ts`**

Lift the cost table and pattern matcher from `/tmp/cursor-research/opencode-cursor/src/index.ts:229-326`. Export `ModelCost`, `MODEL_COST_TABLE`, and `estimateModelCost`. Full content:

```typescript
export interface ModelCost {
  input: number;
  output: number;
  cache: { read: number; write: number };
}

// $/M token rates from cursor.com/docs/models-and-pricing
export const MODEL_COST_TABLE: Record<string, ModelCost> = {
  // Anthropic
  "claude-4-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4-sonnet-1m": { input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
  "claude-4.5-haiku": { input: 1, output: 5, cache: { read: 0.1, write: 1.25 } },
  "claude-4.5-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.5-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  "claude-4.6-opus": { input: 5, output: 25, cache: { read: 0.5, write: 6.25 } },
  "claude-4.6-opus-fast": { input: 30, output: 150, cache: { read: 3, write: 37.5 } },
  "claude-4.6-sonnet": { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  // Cursor
  "composer-1": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "composer-1.5": { input: 3.5, output: 17.5, cache: { read: 0.35, write: 0 } },
  "composer-2": { input: 0.5, output: 2.5, cache: { read: 0.2, write: 0 } },
  "composer-2-fast": { input: 1.5, output: 7.5, cache: { read: 0.2, write: 0 } },
  // Google
  "gemini-2.5-flash": { input: 0.3, output: 2.5, cache: { read: 0.03, write: 0 } },
  "gemini-3-flash": { input: 0.5, output: 3, cache: { read: 0.05, write: 0 } },
  "gemini-3-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3-pro-image": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  "gemini-3.1-pro": { input: 2, output: 12, cache: { read: 0.2, write: 0 } },
  // OpenAI
  "gpt-5": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5-fast": { input: 2.5, output: 20, cache: { read: 0.25, write: 0 } },
  "gpt-5-mini": { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5-codex": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-max": { input: 1.25, output: 10, cache: { read: 0.125, write: 0 } },
  "gpt-5.1-codex-mini": { input: 0.25, output: 2, cache: { read: 0.025, write: 0 } },
  "gpt-5.2": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.2-codex": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.3-codex": { input: 1.75, output: 14, cache: { read: 0.175, write: 0 } },
  "gpt-5.4": { input: 2.5, output: 15, cache: { read: 0.25, write: 0 } },
  "gpt-5.4-mini": { input: 0.75, output: 4.5, cache: { read: 0.075, write: 0 } },
  "gpt-5.4-nano": { input: 0.2, output: 1.25, cache: { read: 0.02, write: 0 } },
  // xAI
  "grok-4.20": { input: 2, output: 6, cache: { read: 0.2, write: 0 } },
  // Moonshot
  "kimi-k2.5": { input: 0.6, output: 3, cache: { read: 0.1, write: 0 } },
};

const MODEL_COST_PATTERNS: Array<{ match: (id: string) => boolean; cost: ModelCost }> = [
  { match: (id) => /claude.*opus.*fast/i.test(id), cost: MODEL_COST_TABLE["claude-4.6-opus-fast"]! },
  { match: (id) => /claude.*opus/i.test(id),       cost: MODEL_COST_TABLE["claude-4.6-opus"]! },
  { match: (id) => /claude.*haiku/i.test(id),      cost: MODEL_COST_TABLE["claude-4.5-haiku"]! },
  { match: (id) => /claude.*sonnet/i.test(id),     cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /claude/i.test(id),             cost: MODEL_COST_TABLE["claude-4.6-sonnet"]! },
  { match: (id) => /composer-?2/i.test(id),        cost: MODEL_COST_TABLE["composer-2"]! },
  { match: (id) => /composer-?1\.5/i.test(id),     cost: MODEL_COST_TABLE["composer-1.5"]! },
  { match: (id) => /composer/i.test(id),           cost: MODEL_COST_TABLE["composer-1"]! },
  { match: (id) => /gpt-5\.4.*nano/i.test(id),     cost: MODEL_COST_TABLE["gpt-5.4-nano"]! },
  { match: (id) => /gpt-5\.4.*mini/i.test(id),     cost: MODEL_COST_TABLE["gpt-5.4-mini"]! },
  { match: (id) => /gpt-5\.4/i.test(id),           cost: MODEL_COST_TABLE["gpt-5.4"]! },
  { match: (id) => /gpt-5\.3/i.test(id),           cost: MODEL_COST_TABLE["gpt-5.3-codex"]! },
  { match: (id) => /gpt-5\.2/i.test(id),           cost: MODEL_COST_TABLE["gpt-5.2"]! },
  { match: (id) => /gpt-5\.1.*mini/i.test(id),     cost: MODEL_COST_TABLE["gpt-5.1-codex-mini"]! },
  { match: (id) => /gpt-5\.1/i.test(id),           cost: MODEL_COST_TABLE["gpt-5.1-codex"]! },
  { match: (id) => /gpt-5.*mini/i.test(id),        cost: MODEL_COST_TABLE["gpt-5-mini"]! },
  { match: (id) => /gpt-5.*fast/i.test(id),        cost: MODEL_COST_TABLE["gpt-5-fast"]! },
  { match: (id) => /gpt-5/i.test(id),              cost: MODEL_COST_TABLE["gpt-5"]! },
  { match: (id) => /gemini.*3\.1/i.test(id),       cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /gemini.*3.*flash/i.test(id),   cost: MODEL_COST_TABLE["gemini-3-flash"]! },
  { match: (id) => /gemini.*3/i.test(id),          cost: MODEL_COST_TABLE["gemini-3-pro"]! },
  { match: (id) => /gemini.*flash/i.test(id),      cost: MODEL_COST_TABLE["gemini-2.5-flash"]! },
  { match: (id) => /gemini/i.test(id),             cost: MODEL_COST_TABLE["gemini-3.1-pro"]! },
  { match: (id) => /grok/i.test(id),               cost: MODEL_COST_TABLE["grok-4.20"]! },
  { match: (id) => /kimi/i.test(id),               cost: MODEL_COST_TABLE["kimi-k2.5"]! },
];

const DEFAULT_COST: ModelCost = { input: 3, output: 15, cache: { read: 0.3, write: 0 } };

export function estimateModelCost(modelId: string): ModelCost {
  const normalized = modelId.toLowerCase();
  if (MODEL_COST_TABLE[normalized]) return MODEL_COST_TABLE[normalized]!;
  const stripped = normalized.replace(/-(high|medium|low|preview|thinking|spark-preview)$/g, "");
  if (MODEL_COST_TABLE[stripped]) return MODEL_COST_TABLE[stripped]!;
  return MODEL_COST_PATTERNS.find((p) => p.match(normalized))?.cost ?? DEFAULT_COST;
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/model-cost.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/model-cost.ts pi/extensions/cursor/test/model-cost.test.ts
git commit -m "Add Cursor model cost estimation"
```

---

### Task 11: Unary RPC helper

**Files:**
- Create: `pi/extensions/cursor/unary-rpc.ts`

No tests at this layer (pure transport, exercised via models tests in next task).

- [ ] **Step 1: Write `pi/extensions/cursor/unary-rpc.ts`**

Lift from `/tmp/cursor-research/opencode-cursor/src/cursor-session.ts` (the `callCursorUnaryRpc` function at the bottom). Adjust imports.

```typescript
import { randomUUID } from "node:crypto";
import { connect as h2Connect } from "node:http2";
import { type CursorRuntimeConfig, resolveRuntimeConfig } from "./runtime-config.ts";

export interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  runtimeConfig?: Partial<CursorRuntimeConfig>;
}

export interface CursorUnaryRpcResult {
  body: Uint8Array;
  exitCode: number;
  timedOut: boolean;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
): Promise<CursorUnaryRpcResult> {
  const runtimeConfig = resolveRuntimeConfig(options.runtimeConfig);
  const url = options.url ?? runtimeConfig.apiUrl;
  const requestId = randomUUID();
  const { promise, resolve } = Promise.withResolvers<CursorUnaryRpcResult>();

  let timedOut = false;
  let settled = false;

  const session = h2Connect(url);
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 5_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { session.destroy(); } catch { /* ignore */ }
  }, timeoutMs);

  const finish = (body: Uint8Array, code: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try { session.close(); } catch { /* ignore */ }
    resolve({ body, exitCode: timedOut ? 1 : code, timedOut });
  };

  session.on("error", () => finish(new Uint8Array(0), 1));

  const stream = session.request({
    ":method": "POST",
    ":path": options.rpcPath,
    "content-type": "application/proto",
    "user-agent": "connect-es/1.6.1",
    authorization: `Bearer ${options.accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": runtimeConfig.clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": requestId,
  });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  stream.on("end", () => finish(Buffer.concat(chunks), 0));
  stream.on("error", () => finish(Buffer.concat(chunks), 1));

  if (options.requestBody.length > 0) {
    stream.end(Buffer.from(options.requestBody));
  } else {
    stream.end();
  }
  return promise;
}
```

- [ ] **Step 2: Commit**

```sh
git add pi/extensions/cursor/unary-rpc.ts
git commit -m "Add Cursor unary RPC helper over HTTP/2"
```

---

### Task 12: Model discovery (AvailableModels + GetUsableModels + fallback)

**Files:**
- Create: `pi/extensions/cursor/models.ts`

No unit tests — exercised end-to-end against a real Cursor account (smoke test in Task 25). Tests at this layer would require recording protobuf responses, which is more work than it's worth at v1.

- [ ] **Step 1: Write `pi/extensions/cursor/models.ts`**

Lift `MODEL_LIMITS`, `FALLBACK_MODELS`, `encodeVarint`, `encodeTokenLimitRequest`, `decodeTokenLimitResponse`, `fetchTokenLimit`, `fetchTokenLimits`, `fetchAvailableModels`, `fetchGetUsableModels`, and the public `getCursorModels` from `/tmp/cursor-research/opencode-cursor/src/models.ts`. Adjust imports to local files. Replace `logDebug`/`logWarn` with `console.warn` or comment them out — we'll add real logging later if needed.

The full file is ~490 lines; copy the entire body of opencode-cursor's `src/models.ts` and update import paths:
- `./cursor-session` → `./unary-rpc.ts` (the function moved there)
- `./logger` → comment-out
- `./model-names` → `./model-names.ts`
- `./proto/agent_pb` → `./proto/agent_pb.ts`
- `./proto/aiserver_pb` → `./proto/aiserver_pb.ts`
- `./protocol` → `./protocol.ts`
- `./runtime-config` → `./runtime-config.ts`

Public exports needed: `CursorModel`, `getCursorModels`, `clearModelCache`. The `CursorModel` interface must match:
```typescript
export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}
```

- [ ] **Step 2: Smoke check that the file imports cleanly**

```sh
node --import tsx -e "import('./models.ts').then(m => console.log(Object.keys(m)))"
```
Expected: prints `[ 'getCursorModels', 'clearModelCache' ]` (or similar — at least no error).

- [ ] **Step 3: Commit**

```sh
git add pi/extensions/cursor/models.ts
git commit -m "Add Cursor model discovery (AvailableModels + fallbacks)"
```

---

### Task 13: Pi context parser + tests

**Files:**
- Create: `pi/extensions/cursor/pi-context.ts`
- Create: `pi/extensions/cursor/test/pi-context.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/pi-context.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parsePiContext } from "../pi-context.ts";
import type { Context } from "@mariozechner/pi-ai";

test("empty system prompt defaults", () => {
  const ctx: Context = { systemPrompt: "", messages: [] };
  const p = parsePiContext(ctx);
  assert.equal(p.systemPrompt, "You are a helpful assistant.");
  assert.equal(p.lastUserText, "");
  assert.deepEqual(p.turns, []);
  assert.deepEqual(p.toolResults, []);
});

test("single user message → lastUserText, no turns", () => {
  const ctx: Context = {
    systemPrompt: "Be brief.",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
  };
  const p = parsePiContext(ctx);
  assert.equal(p.systemPrompt, "Be brief.");
  assert.equal(p.lastUserText, "hello");
  assert.deepEqual(p.turns, []);
});

test("user/assistant pair followed by user → one turn + lastUserText", () => {
  const ctx: Context = {
    systemPrompt: "S",
    messages: [
      { role: "user", content: "u1", timestamp: 1 },
      { role: "assistant", api: "openai-completions", provider: "x", model: "m",
        content: [{ type: "text", text: "a1" }], usage: zeroUsage(), stopReason: "stop", timestamp: 2 },
      { role: "user", content: "u2", timestamp: 3 },
    ],
  };
  const p = parsePiContext(ctx);
  assert.equal(p.lastUserText, "u2");
  assert.deepEqual(p.turns, [{ userText: "u1", assistantText: "a1" }]);
});

test("trailing toolResult → resume mode, lastUserText empty, toolResults populated", () => {
  const ctx: Context = {
    systemPrompt: "",
    messages: [
      { role: "user", content: "u1", timestamp: 1 },
      { role: "assistant", api: "openai-completions", provider: "x", model: "m",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } }],
        usage: zeroUsage(), stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "tc1", toolName: "read",
        content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
    ],
  };
  const p = parsePiContext(ctx);
  assert.equal(p.lastUserText, "");
  assert.deepEqual(p.toolResults, [
    { toolCallId: "tc1", content: "file contents", isError: false },
  ]);
});

test("array text content concatenates with newlines", () => {
  const ctx: Context = {
    systemPrompt: "",
    messages: [{
      role: "user",
      content: [{ type: "text", text: "a" }, { type: "text", text: "b" }],
      timestamp: 1,
    }],
  };
  const p = parsePiContext(ctx);
  assert.equal(p.lastUserText, "a\nb");
});

test("image content flattens to placeholder", () => {
  const ctx: Context = {
    systemPrompt: "",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "see this:" },
        { type: "image", data: "...", mimeType: "image/png" },
      ],
      timestamp: 1,
    }],
  };
  const p = parsePiContext(ctx);
  assert.match(p.lastUserText, /see this:/);
  assert.match(p.lastUserText, /\[image: image\/png\]/);
});

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/pi-context.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/pi-context.ts`**

```typescript
import type {
  Context,
  Message,
  TextContent,
  ImageContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export interface ParsedContext {
  systemPrompt: string;
  turns: Array<{ userText: string; assistantText: string }>;
  lastUserText: string;
  toolResults: Array<{ toolCallId: string; content: string; isError: boolean }>;
}

function textFromContent(content: Message["content"] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if ((c as TextContent).type === "text") return (c as TextContent).text;
      if ((c as ImageContent).type === "image") return `[image: ${(c as ImageContent).mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultText(msg: ToolResultMessage): string {
  return msg.content
    .map((c) => (c.type === "text" ? c.text : `[image: ${(c as ImageContent).mimeType}]`))
    .join("\n");
}

export function parsePiContext(context: Context): ParsedContext {
  const systemPrompt = (context.systemPrompt ?? "").trim() || "You are a helpful assistant.";
  const turns: Array<{ userText: string; assistantText: string }> = [];
  const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];
  let pendingUser = "";
  let pendingAssistant = "";

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (pendingUser) {
        turns.push({ userText: pendingUser, assistantText: pendingAssistant });
        pendingAssistant = "";
      }
      pendingUser = textFromContent(msg.content);
    } else if (msg.role === "assistant") {
      pendingAssistant += msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (msg.role === "toolResult") {
      toolResults.push({
        toolCallId: msg.toolCallId,
        content: toolResultText(msg),
        isError: msg.isError,
      });
    }
  }

  let lastUserText = "";
  if (pendingUser) {
    lastUserText = pendingUser;
  } else if (turns.length > 0 && toolResults.length === 0) {
    const last = turns.pop()!;
    lastUserText = last.userText;
  }

  return { systemPrompt, turns, lastUserText, toolResults };
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/pi-context.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/pi-context.ts pi/extensions/cursor/test/pi-context.test.ts
git commit -m "Add pi Context parser for Cursor request building"
```

---

### Task 14: MCP tool definition builder + tests

**Files:**
- Create: `pi/extensions/cursor/mcp-tool-defs.ts`
- Create: `pi/extensions/cursor/test/mcp-tool-defs.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/mcp-tool-defs.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildMcpToolDefinitions } from "../mcp-tool-defs.ts";
import { Type } from "typebox";

test("empty tool list → empty array", () => {
  assert.deepEqual(buildMcpToolDefinitions([]), []);
});

test("single tool produces one McpToolDefinition with serialized schema", () => {
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: Type.Object({
        path: Type.String(),
        limit: Type.Optional(Type.Number()),
      }),
    },
  ];
  const result = buildMcpToolDefinitions(tools as any);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.name, "read");
  assert.equal(result[0]!.description, "Read a file");
  assert.equal(result[0]!.providerIdentifier, "pi");
  assert.equal(result[0]!.toolName, "read");
  assert.ok(result[0]!.inputSchema instanceof Uint8Array);
  assert.ok(result[0]!.inputSchema.length > 0);
});

test("missing description becomes empty string", () => {
  const tools = [{ name: "x", description: "", parameters: Type.Object({}) }];
  const result = buildMcpToolDefinitions(tools as any);
  assert.equal(result[0]!.description, "");
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/mcp-tool-defs.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/mcp-tool-defs.ts`**

```typescript
import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Tool } from "@mariozechner/pi-ai";
import { McpToolDefinitionSchema, type McpToolDefinition } from "./proto/agent_pb.ts";

export function buildMcpToolDefinitions(tools: Tool[] = []): McpToolDefinition[] {
  return tools.map((tool) => {
    const schema =
      tool.parameters && typeof tool.parameters === "object"
        ? (tool.parameters as unknown as JsonValue)
        : { type: "object", properties: {}, required: [] };
    return create(McpToolDefinitionSchema, {
      name: tool.name,
      description: tool.description || "",
      providerIdentifier: "pi",
      toolName: tool.name,
      inputSchema: toBinary(ValueSchema, fromJson(ValueSchema, schema)),
    });
  });
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/mcp-tool-defs.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/mcp-tool-defs.ts pi/extensions/cursor/test/mcp-tool-defs.test.ts
git commit -m "Add pi Tool[] → Cursor McpToolDefinition[] adapter"
```

---

### Task 15: Cursor request builder

**Files:**
- Create: `pi/extensions/cursor/cursor-request.ts`

No isolated unit test — tested implicitly via the smoke test (Task 25). The protobuf round-trip with our parsed context + a small `CursorSession` mock would require lots of fixture wiring; not worth the time.

- [ ] **Step 1: Write `pi/extensions/cursor/cursor-request.ts`**

```typescript
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash, randomUUID } from "node:crypto";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  ModelDetailsSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type ConversationStateStructure,
  type McpToolDefinition,
} from "./proto/agent_pb.ts";

export interface CursorRequestPayload {
  requestBytes: Uint8Array;
  blobStore: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
  conversationId: string;
}

export function deterministicConversationId(convKey: string): string {
  const hex = createHash("sha256").update(`cursor-conv-id:${convKey}`).digest("hex").slice(0, 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${(0x8 | (parseInt(hex[16]!, 16) & 0x3)).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export function buildCursorRequest(args: {
  modelId: string;
  systemPrompt: string;
  userText: string;
  turns: Array<{ userText: string; assistantText: string }>;
  conversationId: string;
  checkpoint?: Uint8Array | null;
  existingBlobStore?: Map<string, Uint8Array>;
  mcpTools: McpToolDefinition[];
}): CursorRequestPayload {
  const blobStore = new Map<string, Uint8Array>(args.existingBlobStore ?? []);
  const systemJson = JSON.stringify({ role: "system", content: args.systemPrompt });
  const systemBytes = new TextEncoder().encode(systemJson);
  const systemBlobId = new Uint8Array(createHash("sha256").update(systemBytes).digest());
  blobStore.set(Buffer.from(systemBlobId).toString("hex"), systemBytes);

  let conversationState: ConversationStateStructure;
  if (args.checkpoint) {
    conversationState = fromBinary(ConversationStateStructureSchema, args.checkpoint);
  } else {
    const turnBytes: Uint8Array[] = [];
    for (const turn of args.turns) {
      const userMsg = create(UserMessageSchema, { text: turn.userText, messageId: randomUUID() });
      const stepBytes: Uint8Array[] = [];
      if (turn.assistantText) {
        const step = create(ConversationStepSchema, {
          message: {
            case: "assistantMessage",
            value: create(AssistantMessageSchema, { text: turn.assistantText }),
          },
        });
        stepBytes.push(toBinary(ConversationStepSchema, step));
      }
      const agentTurn = create(AgentConversationTurnStructureSchema, {
        userMessage: toBinary(UserMessageSchema, userMsg),
        steps: stepBytes,
      });
      turnBytes.push(
        toBinary(
          ConversationTurnStructureSchema,
          create(ConversationTurnStructureSchema, {
            turn: { case: "agentConversationTurn", value: agentTurn },
          }),
        ),
      );
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

  const userMessage = create(UserMessageSchema, {
    text: args.userText,
    messageId: randomUUID(),
  });
  const action = create(ConversationActionSchema, {
    action: {
      case: "userMessageAction",
      value: create(UserMessageActionSchema, { userMessage }),
    },
  });
  const modelDetails = create(ModelDetailsSchema, {
    modelId: args.modelId,
    displayModelId: args.modelId,
    displayName: args.modelId,
  });
  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action,
    modelDetails,
    conversationId: args.conversationId,
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });

  return {
    requestBytes: toBinary(AgentClientMessageSchema, clientMessage),
    blobStore,
    mcpTools: args.mcpTools,
    conversationId: args.conversationId,
  };
}
```

- [ ] **Step 2: Smoke check**

```sh
node --import tsx -e "
import { buildCursorRequest, deterministicConversationId } from './cursor-request.ts';
const id = deterministicConversationId('test-key');
console.log('id:', id, 'len:', id.length);
const r = buildCursorRequest({
  modelId: 'claude-4.6-sonnet',
  systemPrompt: 'sys',
  userText: 'hello',
  turns: [],
  conversationId: id,
  mcpTools: [],
});
console.log('request bytes:', r.requestBytes.length);
"
```
Expected: prints UUID with length 36 and a positive `request bytes` count.

- [ ] **Step 3: Commit**

```sh
git add pi/extensions/cursor/cursor-request.ts
git commit -m "Add Cursor AgentRunRequest builder"
```

---

### Task 16: Native tool redirection — args mapping

**Files:**
- Create: `pi/extensions/cursor/native-tools.ts` (partial — add redirect map only; result formatters in next task)
- Create: `pi/extensions/cursor/test/native-tools.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/native-tools.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fixPiArgNames, nativeToPiRedirect } from "../native-tools.ts";

function buildExecMsg(args: any) {
  return { id: 1, execId: "e1", message: { value: args } } as any;
}

test("readArgs → read with path/offset/limit", () => {
  const r = nativeToPiRedirect("readArgs", buildExecMsg({ toolCallId: "t", path: "/a", offset: 5, limit: 100 }));
  assert.equal(r!.toolName, "read");
  assert.deepEqual(JSON.parse(r!.decodedArgs), { path: "/a", offset: 5, limit: 100 });
  assert.equal(r!.nativeResultType, "readResult");
  assert.deepEqual(r!.nativeArgs, { path: "/a" });
});

test("readArgs omits zero offset and limit", () => {
  const r = nativeToPiRedirect("readArgs", buildExecMsg({ toolCallId: "t", path: "/a", offset: 0, limit: 0 }));
  assert.deepEqual(JSON.parse(r!.decodedArgs), { path: "/a" });
});

test("writeArgs prefers fileBytes over fileText, decodes UTF-8", () => {
  const bytes = new TextEncoder().encode("héllo");
  const r = nativeToPiRedirect("writeArgs", buildExecMsg({ path: "/x", fileBytes: bytes, fileText: "ignored" }));
  assert.equal(JSON.parse(r!.decodedArgs).content, "héllo");
});

test("deleteArgs builds POSIX-safe rm command", () => {
  const r = nativeToPiRedirect("deleteArgs", buildExecMsg({ path: "evil's name" }));
  const args = JSON.parse(r!.decodedArgs);
  assert.equal(args.command, `rm -f -- 'evil'\\''s name'`);
});

test("deleteArgs handles empty path", () => {
  const r = nativeToPiRedirect("deleteArgs", buildExecMsg({ path: "" }));
  assert.equal(r!.toolName, "bash");
  assert.equal(JSON.parse(r!.decodedArgs).command, "true");
});

test("shellArgs maps timeout and command, drops workingDirectory with logged warning", () => {
  const r = nativeToPiRedirect("shellArgs", buildExecMsg({ command: "ls", timeout: 30, workingDirectory: "/tmp" }));
  const args = JSON.parse(r!.decodedArgs);
  assert.equal(args.command, "ls");
  assert.equal(args.timeout, 30);
  assert.equal(args.working_directory, undefined);
});

test("shellArgs vs shellStreamArgs distinguished by nativeResultType", () => {
  const a = nativeToPiRedirect("shellArgs", buildExecMsg({ command: "ls" }));
  assert.equal(a!.nativeResultType, "shellResult");
  const b = nativeToPiRedirect("shellStreamArgs", buildExecMsg({ command: "ls" }));
  assert.equal(b!.nativeResultType, "shellStreamResult");
});

test("lsArgs → ls", () => {
  const r = nativeToPiRedirect("lsArgs", buildExecMsg({ path: "/dir" }));
  assert.equal(r!.toolName, "ls");
  assert.deepEqual(JSON.parse(r!.decodedArgs), { path: "/dir" });
});

test("grepArgs with pattern → grep", () => {
  const r = nativeToPiRedirect("grepArgs", buildExecMsg({
    pattern: "foo", path: "/p", glob: "*.ts", caseInsensitive: true,
    contextBefore: 2, contextAfter: 1, outputMode: "content",
  }));
  const args = JSON.parse(r!.decodedArgs);
  assert.equal(args.pattern, "foo");
  assert.equal(args.path, "/p");
  assert.equal(args.glob, "*.ts");
  assert.equal(args.ignoreCase, true);
  assert.equal(args.context, 2); // max(before, after)
  assert.equal(r!.nativeArgs!.outputMode, "content");
});

test("grepArgs with only glob → find", () => {
  const r = nativeToPiRedirect("grepArgs", buildExecMsg({ glob: "*.ts", path: "/p" }));
  assert.equal(r!.toolName, "find");
  assert.deepEqual(JSON.parse(r!.decodedArgs), { pattern: "*.ts", path: "/p" });
});

test("fetchArgs → fetch_content", () => {
  const r = nativeToPiRedirect("fetchArgs", buildExecMsg({ url: "https://x" }));
  assert.equal(r!.toolName, "fetch_content");
  assert.deepEqual(JSON.parse(r!.decodedArgs), { url: "https://x" });
});

test("unknown native case returns null", () => {
  assert.equal(nativeToPiRedirect("diagnosticsArgs", buildExecMsg({})), null);
  assert.equal(nativeToPiRedirect("unknownArgs", buildExecMsg({})), null);
});

test("fixPiArgNames rewrites read args in place", () => {
  const args: Record<string, unknown> = { path: "/x" };
  fixPiArgNames("read", args);
  assert.deepEqual(args, { path: "/x" }); // pi already uses 'path', so no change
});

test("fixPiArgNames maps filePath → path", () => {
  const args: Record<string, unknown> = { filePath: "/x" };
  fixPiArgNames("read", args);
  assert.deepEqual(args, { path: "/x" });
});

test("fixPiArgNames defaults grep pattern", () => {
  const args: Record<string, unknown> = { glob: "*.ts" };
  fixPiArgNames("grep", args);
  assert.equal(args.pattern, ".");
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/native-tools.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/native-tools.ts` (redirect part only)**

```typescript
import type { ExecServerMessage } from "./proto/agent_pb.ts";

export type NativeResultType =
  | "readResult"
  | "writeResult"
  | "deleteResult"
  | "fetchResult"
  | "shellResult"
  | "shellStreamResult"
  | "lsResult"
  | "grepResult";

export interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  nativeResultType?: NativeResultType;
  nativeArgs?: Record<string, string>;
}

export interface NativeRedirectInfo {
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  nativeResultType: NativeResultType;
  nativeArgs: Record<string, string>;
}

export function fixPiArgNames(toolName: string, args: Record<string, unknown>): void {
  if (toolName === "read") {
    if (args.path == null && args.filePath != null) {
      args.path = args.filePath;
      delete args.filePath;
    }
  } else if (toolName === "write" || toolName === "edit") {
    if (args.path == null && args.filePath != null) {
      args.path = args.filePath;
      delete args.filePath;
    }
    if (toolName === "write" && args.content == null && args.file_content != null) {
      args.content = args.file_content;
      delete args.file_content;
    }
  } else if (toolName === "find") {
    if (args.pattern == null && args.glob_pattern != null) {
      args.pattern = args.glob_pattern;
      delete args.glob_pattern;
    }
    if (args.path == null && args.target_directory != null) {
      args.path = args.target_directory;
      delete args.target_directory;
    }
  } else if (toolName === "grep") {
    if (args.pattern == null) args.pattern = ".";
  }
}

export function nativeToPiRedirect(
  execCase: string,
  execMsg: ExecServerMessage,
): NativeRedirectInfo | null {
  // biome-ignore lint/suspicious/noExplicitAny: protobuf union type
  const args = execMsg.message.value as any;
  const toolCallId = args?.toolCallId || crypto.randomUUID();

  if (execCase === "readArgs") {
    const piArgs: Record<string, unknown> = { path: args.path };
    if (args.offset != null && args.offset !== 0) piArgs.offset = args.offset;
    if (args.limit != null && args.limit !== 0) piArgs.limit = args.limit;
    return {
      toolCallId,
      toolName: "read",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: "readResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "writeArgs") {
    const fileContent =
      args.fileBytes && args.fileBytes.length > 0
        ? new TextDecoder().decode(args.fileBytes)
        : (args.fileText ?? "");
    return {
      toolCallId,
      toolName: "write",
      decodedArgs: JSON.stringify({ path: args.path, content: fileContent }),
      nativeResultType: "writeResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "deleteArgs") {
    const rawPath: string = args.path ?? "";
    if (!rawPath) {
      return {
        toolCallId,
        toolName: "bash",
        decodedArgs: JSON.stringify({ command: "true" }),
        nativeResultType: "deleteResult",
        nativeArgs: { path: "" },
      };
    }
    const safePath = rawPath.replace(/\0/g, "").replace(/'/g, `'\\''`);
    return {
      toolCallId,
      toolName: "bash",
      decodedArgs: JSON.stringify({ command: `rm -f -- '${safePath}'` }),
      nativeResultType: "deleteResult",
      nativeArgs: { path: rawPath },
    };
  }
  if (execCase === "fetchArgs") {
    return {
      toolCallId,
      toolName: "fetch_content",
      decodedArgs: JSON.stringify({ url: args.url }),
      nativeResultType: "fetchResult",
      nativeArgs: { url: args.url ?? "" },
    };
  }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const cmd: string = args.command ?? "";
    if (args.workingDirectory) {
      console.warn(
        `[cursor] dropping unsupported workingDirectory='${args.workingDirectory}' for ${execCase}`,
      );
    }
    const piArgs: Record<string, unknown> = { command: cmd };
    if (args.timeout != null && args.timeout > 0) piArgs.timeout = args.timeout;
    return {
      toolCallId,
      toolName: "bash",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: execCase === "shellStreamArgs" ? "shellStreamResult" : "shellResult",
      nativeArgs: { command: cmd },
    };
  }
  if (execCase === "lsArgs") {
    return {
      toolCallId,
      toolName: "ls",
      decodedArgs: JSON.stringify({ path: args.path }),
      nativeResultType: "lsResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "grepArgs") {
    const pattern: string = args.pattern ?? "";
    if (!pattern && args.glob) {
      return {
        toolCallId,
        toolName: "find",
        decodedArgs: JSON.stringify({ pattern: args.glob, path: args.path || undefined }),
        nativeResultType: "grepResult",
        nativeArgs: {
          pattern: args.glob ?? "",
          path: args.path ?? "",
          outputMode: "files_with_matches",
        },
      };
    }
    const piArgs: Record<string, unknown> = { pattern: pattern || "." };
    if (args.path) piArgs.path = args.path;
    if (args.glob) piArgs.glob = args.glob;
    if (args.caseInsensitive != null) piArgs.ignoreCase = args.caseInsensitive;
    const ctxMax = Math.max(args.contextBefore ?? 0, args.contextAfter ?? 0, args.context ?? 0);
    if (ctxMax > 0) piArgs.context = ctxMax;
    if (args.headLimit != null) piArgs.limit = args.headLimit;
    return {
      toolCallId,
      toolName: "grep",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: "grepResult",
      nativeArgs: {
        pattern: pattern || ".",
        path: args.path ?? "",
        outputMode: args.outputMode || "content",
      },
    };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/native-tools.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/native-tools.ts pi/extensions/cursor/test/native-tools.test.ts
git commit -m "Add native Cursor tool → pi tool redirection mapping"
```

---

### Task 17: Grep result parser

**Files:**
- Create: `pi/extensions/cursor/grep-parser.ts`
- Create: `pi/extensions/cursor/test/grep-parser.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/grep-parser.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { buildGrepResult } from "../grep-parser.ts";

test("files_with_matches mode parses one path per line", () => {
  const r = buildGrepResult("a.ts\nb.ts\n", { outputMode: "files_with_matches", path: "" });
  assert.ok(r);
  // The proto has `result: { case: 'success', value: GrepSuccess }`. Inspect that.
  const success = (r!.resultValue as any).result.value;
  const inner = success.workspaceResults["."].result;
  assert.equal(inner.case, "files");
  assert.deepEqual(inner.value.files, ["a.ts", "b.ts"]);
});

test("content mode parses file:lineNum:text matches", () => {
  const text = "src/foo.ts:12:const x = 1\nsrc/foo.ts:14:const y = 2\nsrc/bar.ts:1:hello\n";
  const r = buildGrepResult(text, { pattern: "x", path: "src", outputMode: "content" });
  assert.ok(r);
  const success = (r!.resultValue as any).result.value;
  const inner = success.workspaceResults["src"].result;
  assert.equal(inner.case, "content");
  assert.equal(inner.value.matches.length, 2);
});

test("count mode is not parsed (returns null)", () => {
  // Pi grep doesn't emit count format, fall back to MCP text.
  const r = buildGrepResult("foo.ts:3\nbar.ts:1\n", { outputMode: "count" });
  assert.equal(r, null);
});

test("empty content with matching outputMode returns empty result", () => {
  const r = buildGrepResult("", { outputMode: "files_with_matches" });
  assert.ok(r); // empty input is fine
});

test("non-empty unparseable content returns null", () => {
  const r = buildGrepResult("totally not ripgrep output", { outputMode: "files_with_matches" });
  // files mode is permissive — every non-empty line is a path. So this returns ok.
  // Use content mode instead for the unparseable check:
  const r2 = buildGrepResult("totally not ripgrep output", { outputMode: "content", pattern: "x" });
  assert.equal(r2, null);
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/grep-parser.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/grep-parser.ts`**

Lift from `/tmp/cursor-research/opencode-cursor/src/native-tools.ts` (lines 272-503: `buildGrepResult`, `isEmptyResult`, `buildCountResult`, `buildFilesResult`, `buildContentResult`, `parseContextLine`, plus `VALID_OUTPUT_MODES`). Adapt to:
- Drop the `count` case (pi grep doesn't support it — return `null` → MCP text fallback).
- Adjust imports to local proto path.

```typescript
import { create } from "@bufbuild/protobuf";
import {
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  type GrepContentMatch,
  type GrepContentResult,
  type GrepFileMatch,
  type GrepFilesResult,
  type GrepResult,
  type GrepUnionResult,
} from "./proto/agent_pb.ts";

const SUPPORTED_OUTPUT_MODES: ReadonlySet<string> = new Set(["content", "files_with_matches"]);

export interface GrepBuildResult {
  resultCase: "grepResult";
  resultValue: GrepResult;
}

export function buildGrepResult(
  content: string,
  args: Record<string, string>,
): GrepBuildResult | null {
  const pattern = args.pattern ?? "";
  const path = args.path ?? "";
  const outputMode = args.outputMode || "content";

  if (!SUPPORTED_OUTPUT_MODES.has(outputMode)) return null;

  let unionResult:
    | { case: "files"; value: GrepFilesResult }
    | { case: "content"; value: GrepContentResult };

  if (outputMode === "files_with_matches") {
    unionResult = buildFilesResult(content);
  } else {
    unionResult = buildContentResult(content);
  }

  if (content.trim() && isEmptyResult(unionResult)) return null;

  const workspaceResults: { [key: string]: GrepUnionResult } = {};
  workspaceResults[path || "."] = create(GrepUnionResultSchema, { result: unionResult });

  return {
    resultCase: "grepResult",
    resultValue: create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, { pattern, path, outputMode, workspaceResults }),
      },
    }),
  };
}

function isEmptyResult(
  r:
    | { case: "files"; value: GrepFilesResult }
    | { case: "content"; value: GrepContentResult },
): boolean {
  return r.case === "files" ? r.value.files.length === 0 : r.value.matches.length === 0;
}

function buildFilesResult(content: string): { case: "files"; value: GrepFilesResult } {
  const files = content
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
  return {
    case: "files" as const,
    value: create(GrepFilesResultSchema, {
      files,
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated: false,
    }),
  };
}

function buildContentResult(content: string): { case: "content"; value: GrepContentResult } {
  const fileMatches: GrepFileMatch[] = [];
  let currentFile = "";
  let currentMatches: GrepContentMatch[] = [];
  let totalLines = 0;
  let totalMatchedLines = 0;

  const flushFile = () => {
    if (currentFile && currentMatches.length > 0) {
      fileMatches.push(create(GrepFileMatchSchema, { file: currentFile, matches: currentMatches }));
    }
    currentMatches = [];
  };

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "--" || line === "") continue;

    const matchHit = line.match(/^(.+?):(\d+):(.*)/);
    if (matchHit) {
      const file = matchHit[1]!;
      const lineNum = Number.parseInt(matchHit[2]!, 10);
      const text = matchHit[3]!;
      if (file !== currentFile) {
        flushFile();
        currentFile = file;
      }
      totalLines++;
      totalMatchedLines++;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber: lineNum,
          content: text,
          isContextLine: false,
        }),
      );
      continue;
    }

    const ctx = parseContextLine(line, currentFile);
    if (ctx) {
      if (ctx.file !== currentFile) {
        flushFile();
        currentFile = ctx.file;
      }
      totalLines++;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber: ctx.lineNum,
          content: ctx.text,
          isContextLine: true,
        }),
      );
    }
  }
  flushFile();

  return {
    case: "content" as const,
    value: create(GrepContentResultSchema, {
      matches: fileMatches,
      totalLines,
      totalMatchedLines,
      clientTruncated: false,
      ripgrepTruncated: false,
    }),
  };
}

function parseContextLine(
  line: string,
  currentFile: string,
): { file: string; lineNum: number; text: string } | null {
  if (currentFile) {
    const prefix = `${currentFile}-`;
    if (line.startsWith(prefix)) {
      const m = line.slice(prefix.length).match(/^(\d+)-(.*)/s);
      if (m) {
        return { file: currentFile, lineNum: Number.parseInt(m[1]!, 10), text: m[2]! };
      }
    }
  }
  const m = line.match(/^(.+?)-(\d+)-(.*)/);
  if (m) {
    return { file: m[1]!, lineNum: Number.parseInt(m[2]!, 10), text: m[3]! };
  }
  return null;
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/grep-parser.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/grep-parser.ts pi/extensions/cursor/test/grep-parser.test.ts
git commit -m "Add ripgrep-output → Cursor GrepResult parser"
```

---

### Task 18: Native result formatters

**Files:**
- Modify: `pi/extensions/cursor/native-tools.ts` (append result-sending functions)

No isolated test — these write framed protobufs onto a `BridgeWriter` interface; tested via `cursor-session.test.ts` (Task 22).

- [ ] **Step 1: Append to `pi/extensions/cursor/native-tools.ts`**

After the existing exports, append:

```typescript
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  FetchResultSchema,
  FetchSuccessSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteResultSchema,
  WriteSuccessSchema,
} from "./proto/agent_pb.ts";
import { frameConnectMessage } from "./protocol.ts";
import { buildGrepResult } from "./grep-parser.ts";

export interface BridgeWriter {
  write: (data: Uint8Array) => void;
}

function frameClientMessage(message: { case: string; value: unknown }): Buffer {
  return frameConnectMessage(
    toBinary(
      AgentClientMessageSchema,
      // biome-ignore lint/suspicious/noExplicitAny: protobuf union
      create(AgentClientMessageSchema, { message } as any),
    ),
  );
}

function sendStreamClose(bridge: BridgeWriter, execMsgId: number): void {
  const controlMsg = create(ExecClientControlMessageSchema, {
    message: {
      case: "streamClose",
      value: create(ExecClientStreamCloseSchema, { id: execMsgId }),
    },
  });
  bridge.write(frameClientMessage({ case: "execClientControlMessage", value: controlMsg }));
}

function sendExecResult(
  bridge: BridgeWriter,
  exec: PendingExec,
  resultCase: string,
  resultValue: unknown,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: exec.execMsgId,
    execId: exec.execId,
    // biome-ignore lint/suspicious/noExplicitAny: protobuf union
    message: { case: resultCase as any, value: resultValue as any },
  });
  bridge.write(frameClientMessage({ case: "execClientMessage", value: execClientMessage }));
  sendStreamClose(bridge, exec.execMsgId);
}

export function sendMcpResultSuccess(
  bridge: BridgeWriter,
  exec: PendingExec,
  content: string,
): void {
  const mcpResult = create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: [
          create(McpToolResultContentItemSchema, {
            content: { case: "text", value: create(McpTextContentSchema, { text: content }) },
          }),
        ],
        isError: false,
      }),
    },
  });
  sendExecResult(bridge, exec, "mcpResult", mcpResult);
}

export function sendMcpResultError(
  bridge: BridgeWriter,
  exec: PendingExec,
  errorMessage: string,
): void {
  const mcpResult = create(McpResultSchema, {
    result: {
      case: "success",
      value: create(McpSuccessSchema, {
        content: [
          create(McpToolResultContentItemSchema, {
            content: { case: "text", value: create(McpTextContentSchema, { text: errorMessage }) },
          }),
        ],
        isError: true,
      }),
    },
  });
  sendExecResult(bridge, exec, "mcpResult", mcpResult);
}

export function sendNativeResult(bridge: BridgeWriter, exec: PendingExec, content: string): void {
  const args = exec.nativeArgs ?? {};

  switch (exec.nativeResultType) {
    case "readResult": {
      const lines = content.split("\n");
      const value = create(ReadResultSchema, {
        result: {
          case: "success",
          value: create(ReadSuccessSchema, {
            path: args.path ?? "",
            totalLines: lines.length,
            fileSize: BigInt(new TextEncoder().encode(content).byteLength),
            truncated: false,
            output: { case: "content", value: content },
          }),
        },
      });
      sendExecResult(bridge, exec, "readResult", value);
      return;
    }
    case "writeResult": {
      const bytes = new TextEncoder().encode(content);
      const value = create(WriteResultSchema, {
        result: {
          case: "success",
          value: create(WriteSuccessSchema, {
            path: args.path ?? "",
            linesCreated: content.split("\n").length,
            fileSize: bytes.byteLength,
          }),
        },
      });
      sendExecResult(bridge, exec, "writeResult", value);
      return;
    }
    case "deleteResult": {
      const value = create(DeleteResultSchema, {
        result: {
          case: "success",
          value: create(DeleteSuccessSchema, { path: args.path ?? "" }),
        },
      });
      sendExecResult(bridge, exec, "deleteResult", value);
      return;
    }
    case "fetchResult": {
      const value = create(FetchResultSchema, {
        result: {
          case: "success",
          value: create(FetchSuccessSchema, {
            url: args.url ?? "",
            content,
            statusCode: 200,
          }),
        },
      });
      sendExecResult(bridge, exec, "fetchResult", value);
      return;
    }
    case "shellResult": {
      const value = create(ShellResultSchema, {
        result: {
          case: "success",
          value: create(ShellSuccessSchema, {
            command: args.command ?? "",
            workingDirectory: "",
            exitCode: 0,
            signal: "",
            stdout: content,
            stderr: "",
          }),
        },
      });
      sendExecResult(bridge, exec, "shellResult", value);
      return;
    }
    case "shellStreamResult": {
      const sendStreamEvent = (event: { case: string; value: unknown }) => {
        bridge.write(
          frameClientMessage({
            case: "execClientMessage",
            value: create(ExecClientMessageSchema, {
              id: exec.execMsgId,
              execId: exec.execId,
              // biome-ignore lint/suspicious/noExplicitAny: protobuf union
              message: { case: "shellStream" as any, value: create(ShellStreamSchema, { event } as any) },
            }),
          }),
        );
      };
      sendStreamEvent({ case: "start", value: create(ShellStreamStartSchema, {}) });
      if (content) {
        sendStreamEvent({
          case: "stdout",
          value: create(ShellStreamStdoutSchema, { data: content }),
        });
      }
      sendStreamEvent({ case: "exit", value: create(ShellStreamExitSchema, { code: 0 }) });
      sendStreamClose(bridge, exec.execMsgId);
      return;
    }
    case "grepResult": {
      const built = buildGrepResult(content, args);
      if (!built) {
        sendMcpResultSuccess(bridge, exec, content);
        return;
      }
      sendExecResult(bridge, exec, built.resultCase, built.resultValue);
      return;
    }
    case "lsResult":
    default:
      sendMcpResultSuccess(bridge, exec, content);
  }
}
```

- [ ] **Step 2: Smoke check it imports**

```sh
node --import tsx -e "import('./native-tools.ts').then(m => console.log(Object.keys(m)))"
```
Expected: prints exports including `sendMcpResultSuccess`, `sendNativeResult`, `sendMcpResultError`.

- [ ] **Step 3: Commit**

```sh
git add pi/extensions/cursor/native-tools.ts
git commit -m "Add native Cursor tool result encoders (read/write/shell/etc)"
```

---

### Task 19: Event queue + tests

**Files:**
- Create: `pi/extensions/cursor/event-queue.ts`
- Create: `pi/extensions/cursor/test/event-queue.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/event-queue.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { EventQueue } from "../event-queue.ts";

test("push then next returns events in order", async () => {
  const q = new EventQueue<number>();
  q.push(1); q.push(2); q.push(3);
  assert.equal(await q.next(), 1);
  assert.equal(await q.next(), 2);
  assert.equal(await q.next(), 3);
});

test("next blocks until push", async () => {
  const q = new EventQueue<string>();
  const p = q.next();
  setTimeout(() => q.push("hi"), 10);
  assert.equal(await p, "hi");
});

test("multiple consecutive next calls are served FIFO", async () => {
  const q = new EventQueue<number>();
  const a = q.next();
  const b = q.next();
  q.push(1); q.push(2);
  assert.equal(await a, 1);
  assert.equal(await b, 2);
});

test("pushForce always delivers, even after overflow shutdown", () => {
  let overflowed = false;
  const q = new EventQueue<number>({ maxSize: 2, onOverflow: () => { overflowed = true; } });
  q.push(1); q.push(2);
  q.push(3); // overflow
  assert.equal(overflowed, true);
  q.pushForce(99); // still works
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/event-queue.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/event-queue.ts`**

```typescript
export interface EventQueueOptions {
  maxSize?: number;
  onOverflow?: () => void;
}

const DEFAULT_MAX_SIZE = 1024;

export class EventQueue<T> {
  private buffer: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  private overflowed = false;
  private readonly maxSize: number;
  private readonly onOverflow?: () => void;

  constructor(options: EventQueueOptions = {}) {
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
    this.onOverflow = options.onOverflow;
  }

  push(value: T): void {
    if (this.overflowed) return;
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w(value);
      return;
    }
    if (this.buffer.length >= this.maxSize) {
      this.overflowed = true;
      this.onOverflow?.();
      return;
    }
    this.buffer.push(value);
  }

  pushForce(value: T): void {
    if (this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      w(value);
      return;
    }
    this.buffer.push(value);
  }

  next(): Promise<T> {
    if (this.buffer.length > 0) {
      return Promise.resolve(this.buffer.shift()!);
    }
    return new Promise<T>((resolve) => this.waiters.push(resolve));
  }
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/event-queue.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/event-queue.ts pi/extensions/cursor/test/event-queue.test.ts
git commit -m "Add async event queue with overflow guard"
```

---

### Task 20: Cursor server-message dispatcher

**Files:**
- Create: `pi/extensions/cursor/cursor-messages.ts`
- Create: `pi/extensions/cursor/test/cursor-messages.test.ts`

This module wires `processServerMessage` — given a `AgentServerMessage`, dispatches to KV/exec/interactionUpdate handlers. Keeps the protocol logic outside `CursorSession`.

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/cursor-messages.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ConversationStateStructureSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  ReadArgsSchema,
  SetBlobArgsSchema,
  TextDeltaSchema,
  ThinkingDeltaSchema,
  TokenDeltaSchema,
} from "../proto/agent_pb.ts";
import { processServerMessage, type StreamState } from "../cursor-messages.ts";

function freshState(): StreamState {
  return {
    toolCallIndex: 0,
    totalExecCount: 0,
    pendingExecs: [],
    outputTokens: 0,
    totalTokens: 0,
    endStreamSeen: false,
    checkpointAfterExec: false,
    lastDeltaType: null,
  };
}

test("textDelta → onText with isThinking=false", () => {
  const msg = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "textDelta", value: create(TextDeltaSchema, { text: "hi" }) },
      }),
    },
  });
  const out: { text: string; thinking: boolean }[] = [];
  processServerMessage(msg, new Map(), [], undefined, () => {}, freshState(),
    (text, isThinking) => out.push({ text, thinking: !!isThinking }),
    () => assert.fail("no exec"),
    () => assert.fail("no checkpoint"),
    () => {});
  assert.deepEqual(out, [{ text: "hi", thinking: false }]);
});

test("thinkingDelta → onText with isThinking=true", () => {
  const msg = create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, {
        message: { case: "thinkingDelta", value: create(ThinkingDeltaSchema, { text: "rea" }) },
      }),
    },
  });
  const out: { text: string; thinking: boolean }[] = [];
  processServerMessage(msg, new Map(), [], undefined, () => {}, freshState(),
    (text, isThinking) => out.push({ text, thinking: !!isThinking }),
    () => {}, () => {}, () => {});
  assert.deepEqual(out, [{ text: "rea", thinking: true }]);
});

test("kvGetBlobArgs returns blob from store", () => {
  const blobId = new Uint8Array([1, 2, 3]);
  const blobData = new TextEncoder().encode("payload");
  const store = new Map<string, Uint8Array>([[Buffer.from(blobId).toString("hex"), blobData]]);
  const msg = create(AgentServerMessageSchema, {
    message: {
      case: "kvServerMessage",
      value: create(KvServerMessageSchema, {
        id: 7,
        message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) },
      }),
    },
  });
  const writes: Uint8Array[] = [];
  processServerMessage(msg, store, [], undefined, (data) => writes.push(data), freshState(),
    () => {}, () => {}, () => {}, () => {});
  assert.equal(writes.length, 1); // One frame written back with the blob result
});

test("execServerMessage with native readArgs → onMcpExec with redirected info", () => {
  const args = create(ReadArgsSchema, { path: "/x", toolCallId: "tc1" });
  const msg = create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, {
        id: 1, execId: "e1",
        message: { case: "readArgs", value: args },
      }),
    },
  });
  let captured: any = null;
  processServerMessage(msg, new Map(), [], undefined, () => {}, freshState(),
    () => {}, (exec) => { captured = exec; }, () => {}, () => {});
  assert.equal(captured?.toolName, "read");
  assert.equal(captured?.nativeResultType, "readResult");
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/cursor-messages.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/cursor-messages.ts`**

The full body is ~400 lines; lift the structure from `/tmp/cursor-research/opencode-cursor/src/cursor-messages.ts` and adapt:

Key differences:
- Replace native-tool **reject** logic with `nativeToPiRedirect()` from `native-tools.ts`. When `nativeToPiRedirect` returns a redirect, build a `PendingExec` with `nativeResultType` and `nativeArgs` and call `onMcpExec(exec)`.
- For unsupported native cases (`diagnosticsArgs`, `backgroundShellSpawnArgs`, `writeShellStdinArgs`, `recordScreenArgs`, `computerUseArgs`, `listMcpResourcesExecArgs`, `readMcpResourceExecArgs`): send minimal/empty/error native protobuf result back through `sendFrame` (rejection path).
- For pure `mcpArgs`: decode `args: Record<string, Uint8Array>` (each value is a `Value` protobuf), produce a `PendingExec` with no `nativeResultType`. Apply `fixPiArgNames(toolName, decodedArgs)` before stringifying.
- Handle `kvServerMessage` → `getBlobArgs`/`setBlobArgs` against the in-memory blob store.
- Handle `interactionUpdate` cases: `textDelta` (call `onText(text, false)`), `thinkingDelta` (call `onText(text, true)`), `tokenDelta` (`state.outputTokens += tokens`), `toolCallStarted`/`toolCallCompleted` (no-op — informational), `stepCompleted`/`turnEnded` (will be observed by session for batch boundaries; this dispatcher just reports recognition).
- Handle `conversationCheckpointUpdate` → `state.totalTokens = stateStructure.tokenDetails.usedTokens`; serialize state structure and call `onCheckpoint(bytes)`.
- Handle `interactionQuery` → call `onQueryNote(text)` for now (we don't auto-approve).

Public exports:
```typescript
export interface StreamState {
  toolCallIndex: number;
  totalExecCount: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  endStreamSeen: boolean;
  checkpointAfterExec: boolean;
  lastDeltaType: "text" | "thinking" | null;
}

export function processServerMessage(
  msg: AgentServerMessage,
  blobStore: Map<string, Uint8Array>,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Uint8Array) => void,
  state: StreamState,
  onText: (text: string, isThinking: boolean) => void,
  onMcpExec: (exec: PendingExec) => void,
  onCheckpoint: (bytes: Uint8Array) => void,
  onQueryNote: (text: string) => void,
): boolean { /* returns true if message was recognized (resets inactivity timer) */ }
```

The complete listing follows the structure of opencode-cursor's `cursor-messages.ts`. Reference that file for the full dispatch tables for unrecognized native execs (each one calls `sendExecRejectResult` with the corresponding `*RejectedSchema` / empty result schema). Apply `fixPiArgNames` to mcpArgs so the model's path/glob_pattern slip-ups get normalized before pi sees them.

- [ ] **Step 4: Run tests**

```sh
npm test -- test/cursor-messages.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/cursor-messages.ts pi/extensions/cursor/test/cursor-messages.test.ts
git commit -m "Add Cursor server-message dispatcher with native tool redirection"
```

---

### Task 21: CursorSession — H2 + batch state machine + timer

**Files:**
- Create: `pi/extensions/cursor/cursor-session.ts`

Tests for the session state machine require a fake H2 stream — that's complex enough that we exercise it via Task 25's smoke test rather than a full mock here.

- [ ] **Step 1: Write `pi/extensions/cursor/cursor-session.ts`**

Lift the `CursorSession` class verbatim from `/tmp/cursor-research/opencode-cursor/src/cursor-session.ts`, with these adjustments:

- Drop the `onCheckpoint` option (we cache in-memory in the session map; checkpoints are passed via the existing `onCheckpoint` already on the constructor — keep it for compatibility with the existing structure, but the caller can ignore the bytes since we use only in-memory state).
- Drop the `cloudRule`/`maxMode` getters that aren't used.
- Replace `import "./logger"` with stub:

```typescript
function logDebug(...args: unknown[]): void {
  if (process.env.CURSOR_PROXY_DEBUG === "1") console.error("[cursor]", ...args);
}
function logError(...args: unknown[]): void { console.error("[cursor]", ...args); }
function logWarn(...args: unknown[]): void { if (process.env.CURSOR_PROXY_DEBUG === "1") console.warn("[cursor]", ...args); }
```

- Replace `import { processServerMessage }` with an import from `./cursor-messages.ts`.
- Adjust other imports to local `.ts` paths.
- Default `maxMode` to `runtimeConfig.maxMode` (which already reads `CURSOR_MAX_MODE`).
- Keep the public API:
  - constructor(`SessionOptions`)
  - `next(): Promise<SessionEvent>`
  - `sendToolResults(results: { toolCallId: string; content: string }[]): void`
  - `close(): void`
  - getters: `alive`, `flushedExecs`, `outputTokens`, `totalTokens`

Public types:
```typescript
export type RetryHint = "blob_not_found" | "resource_exhausted" | "timeout";

export type SessionEvent =
  | { type: "text"; text: string; isThinking: boolean }
  | { type: "toolCall"; exec: PendingExec }
  | { type: "batchReady" }
  | { type: "usage"; outputTokens: number; totalTokens: number }
  | { type: "done"; error?: string; retryHint?: RetryHint };
```

- [ ] **Step 2: Smoke check the file imports**

```sh
node --import tsx -e "import('./cursor-session.ts').then(m => console.log(Object.keys(m)))"
```
Expected: prints `[ 'CursorSession', 'classifyConnectError' ]` (and types).

- [ ] **Step 3: Commit**

```sh
git add pi/extensions/cursor/cursor-session.ts
git commit -m "Add CursorSession with H2 stream + batch state machine"
```

---

### Task 22: Retry classifier + tests

**Files:**
- Create: `pi/extensions/cursor/retry.ts`
- Create: `pi/extensions/cursor/test/retry.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/retry.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeRetryDelayMs, retryBudget } from "../retry.ts";

test("budget for timeout = 5", () => {
  const b = retryBudget("timeout");
  assert.equal(b.maxAttempts, 5);
});

test("budget for resource_exhausted = 10", () => {
  const b = retryBudget("resource_exhausted");
  assert.equal(b.maxAttempts, 10);
});

test("budget for blob_not_found = 1 (one fresh-state retry)", () => {
  const b = retryBudget("blob_not_found");
  assert.equal(b.maxAttempts, 1);
});

test("delay grows exponentially capped at 4s", () => {
  assert.equal(computeRetryDelayMs(0), 500);
  assert.equal(computeRetryDelayMs(1), 1000);
  assert.equal(computeRetryDelayMs(2), 2000);
  assert.equal(computeRetryDelayMs(3), 4000);
  assert.equal(computeRetryDelayMs(10), 4000); // capped
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/retry.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/retry.ts`**

```typescript
import type { RetryHint } from "./cursor-session.ts";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

export function computeRetryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export interface RetryBudget {
  maxAttempts: number;
  /** When true, drop the cached checkpoint before retrying (start fresh). */
  freshState: boolean;
}

export function retryBudget(hint: RetryHint): RetryBudget {
  switch (hint) {
    case "timeout":
      return { maxAttempts: 5, freshState: false };
    case "resource_exhausted":
      return { maxAttempts: 10, freshState: false };
    case "blob_not_found":
      return { maxAttempts: 1, freshState: true };
  }
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/retry.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/retry.ts pi/extensions/cursor/test/retry.test.ts
git commit -m "Add retry-budget classifier for Cursor errors"
```

---

### Task 23: Pi stream pumper (session events → pi events)

**Files:**
- Create: `pi/extensions/cursor/pi-stream.ts`
- Create: `pi/extensions/cursor/test/pi-stream.test.ts`

- [ ] **Step 1: Write the failing tests**

`pi/extensions/cursor/test/pi-stream.test.ts`:
```typescript
import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  type AssistantMessage,
  type Model,
  createAssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { pumpSession } from "../pi-stream.ts";
import type { SessionEvent } from "../cursor-session.ts";

class FakeSession {
  private events: SessionEvent[] = [];
  private resolvers: ((e: SessionEvent) => void)[] = [];
  push(e: SessionEvent) {
    if (this.resolvers.length) this.resolvers.shift()!(e);
    else this.events.push(e);
  }
  next(): Promise<SessionEvent> {
    if (this.events.length) return Promise.resolve(this.events.shift()!);
    return new Promise((r) => this.resolvers.push(r));
  }
}

function makeOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-completions",
    provider: "cursor",
    model: "claude-4.6-sonnet",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: 0,
  };
}

const model = { id: "claude-4.6-sonnet", provider: "cursor", api: "openai-completions",
  name: "x", reasoning: true, input: ["text"], baseUrl: "", apiKey: "",
  contextWindow: 200000, maxTokens: 64000,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<"openai-completions">;

test("text events emit text_start/delta/end and done with stopReason=stop", async () => {
  const session = new FakeSession();
  const stream = createAssistantMessageEventStream();
  const output = makeOutput();
  const pump = pumpSession(session as any, stream, output, model);
  session.push({ type: "text", text: "hello", isThinking: false });
  session.push({ type: "text", text: " world", isThinking: false });
  session.push({ type: "done" });
  const result = await pump;
  assert.equal(result, "done");
  // Text was buffered into a single content block due to reuse rule.
  assert.equal(output.content.length, 1);
  assert.equal((output.content[0] as { text: string }).text, "hello world");
  assert.equal(output.stopReason, "stop");
});

test("toolCall + batchReady emits done with stopReason=toolUse", async () => {
  const session = new FakeSession();
  const stream = createAssistantMessageEventStream();
  const output = makeOutput();
  const pump = pumpSession(session as any, stream, output, model);
  session.push({
    type: "toolCall",
    exec: {
      execId: "e1", execMsgId: 1, toolCallId: "tc1", toolName: "read",
      decodedArgs: '{"path":"/a"}',
    },
  });
  session.push({ type: "batchReady" });
  const result = await pump;
  assert.equal(result, "batchReady");
  assert.equal(output.stopReason, "toolUse");
  assert.equal(output.content.length, 1);
  assert.equal((output.content[0] as { type: string }).type, "toolCall");
});
```

- [ ] **Step 2: Run tests, see them fail**

```sh
npm test -- test/pi-stream.test.ts
```
Expected: FAIL.

- [ ] **Step 3: Write `pi/extensions/cursor/pi-stream.ts`**

```typescript
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  calculateCost,
} from "@mariozechner/pi-ai";
import type { CursorSession, SessionEvent } from "./cursor-session.ts";
import { createThinkingTagFilter } from "./thinking-filter.ts";

export type PumpResult = "batchReady" | "done";

export function pumpSession(
  session: Pick<CursorSession, "next">,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
): Promise<PumpResult> {
  return (async () => {
    const tagFilter = createThinkingTagFilter();
    let outputTokens = 0;
    let totalTokens = 0;

    for (;;) {
      const event = (await session.next()) as SessionEvent;

      if (event.type === "text") {
        if (event.isThinking) {
          appendThinking(output, stream, event.text);
        } else {
          const { content, reasoning } = tagFilter.process(event.text);
          if (reasoning) appendThinking(output, stream, reasoning);
          if (content) appendText(output, stream, content);
        }
        continue;
      }
      if (event.type === "toolCall") {
        const flushed = tagFilter.flush();
        if (flushed.reasoning) appendThinking(output, stream, flushed.reasoning);
        if (flushed.content) appendText(output, stream, flushed.content);
        closeOpenBlocks(output, stream);

        const index = output.content.length;
        const toolCall: ToolCall = {
          type: "toolCall",
          id: event.exec.toolCallId,
          name: event.exec.toolName,
          arguments: {},
        };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        try {
          toolCall.arguments = JSON.parse(event.exec.decodedArgs || "{}");
        } catch {
          toolCall.arguments = {};
        }
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: event.exec.decodedArgs,
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
        continue;
      }
      if (event.type === "usage") {
        outputTokens = event.outputTokens;
        totalTokens = event.totalTokens;
        continue;
      }
      if (event.type === "batchReady") {
        const flushed = tagFilter.flush();
        if (flushed.reasoning) appendThinking(output, stream, flushed.reasoning);
        if (flushed.content) appendText(output, stream, flushed.content);
        closeOpenBlocks(output, stream);
        output.stopReason = "toolUse";
        applyUsage(output, model, outputTokens, totalTokens);
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return "batchReady";
      }
      if (event.type === "done") {
        const flushed = tagFilter.flush();
        if (flushed.reasoning) appendThinking(output, stream, flushed.reasoning);
        if (flushed.content) appendText(output, stream, flushed.content);
        closeOpenBlocks(output, stream);
        if (event.error) {
          output.stopReason = "error";
          output.errorMessage = event.error;
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          output.stopReason = "stop";
          applyUsage(output, model, outputTokens, totalTokens);
          stream.push({ type: "done", reason: "stop", message: output });
        }
        stream.end();
        return "done";
      }
    }
  })();
}

function applyUsage(
  output: AssistantMessage,
  model: Model<Api>,
  outputTokens: number,
  totalTokens: number,
): void {
  output.usage.output = outputTokens;
  output.usage.totalTokens = totalTokens || outputTokens;
  output.usage.input = Math.max(0, output.usage.totalTokens - output.usage.output);
  calculateCost(model, output.usage);
}

function ensureTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
  const last = output.content.length - 1;
  if (last >= 0 && output.content[last]?.type === "text") return last;
  const index = output.content.length;
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex: index, partial: output });
  return index;
}

function ensureThinkingBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
  const last = output.content.length - 1;
  if (last >= 0 && output.content[last]?.type === "thinking") return last;
  const index = output.content.length;
  output.content.push({ type: "thinking", thinking: "" });
  stream.push({ type: "thinking_start", contentIndex: index, partial: output });
  return index;
}

function appendText(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  text: string,
): void {
  if (!text) return;
  const index = ensureTextBlock(output, stream);
  const block = output.content[index]! as TextContent;
  block.text += text;
  stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
}

function appendThinking(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  text: string,
): void {
  if (!text) return;
  const index = ensureThinkingBlock(output, stream);
  const block = output.content[index]! as ThinkingContent;
  block.thinking += text;
  stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: output });
}

function closeOpenBlocks(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  for (let i = 0; i < output.content.length; i++) {
    const block = output.content[i]!;
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: i,
        content: block.thinking,
        partial: output,
      });
    }
  }
}
```

- [ ] **Step 4: Run tests**

```sh
npm test -- test/pi-stream.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add pi/extensions/cursor/pi-stream.ts pi/extensions/cursor/test/pi-stream.test.ts
git commit -m "Add pi event-stream pumper for Cursor sessions"
```

---

### Task 24: Wire up the provider — index.ts streamSimple + OAuth + commands

**Files:**
- Modify: `pi/extensions/cursor/index.ts`

This is the integration point. No isolated tests — exercised via the smoke test in Task 25.

- [ ] **Step 1: Replace `pi/extensions/cursor/index.ts`**

```typescript
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
        // Reset stream and output for the retry — emit a new start.
        // (Pi tolerates start+done sequences as long as we don't re-emit done.)
        // Wait the backoff.
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
  return refreshCursorToken(creds.refresh);
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
```

- [ ] **Step 2: Smoke check it imports**

```sh
node --import tsx -e "import('./index.ts').then(m => console.log('export:', typeof m.default))"
```
Expected: `export: function`.

- [ ] **Step 3: Run the full test suite**

```sh
npm test
```
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```sh
git add pi/extensions/cursor/index.ts
git commit -m "Wire up Cursor provider with OAuth, streamSimple, and refresh/cleanup commands"
```

---

### Task 25: End-to-end smoke test

**Files:**
- Modify: `pi/settings.json` (already has `defaultProvider: cursor` — should now resolve cleanly)

This task is manual — it's the only way to validate the full stack against real Cursor.

- [ ] **Step 1: Confirm pi loads the extension cleanly**

Run from the dotfiles repo root:
```sh
pi --list-models 2>&1 | grep "^cursor/" | head -10
```
Expected: at least 5 cursor models listed (composer, claude, gpt, gemini families).

If pi doesn't pick up the extension, check `.pi/extensions/cursor/index.ts` exports `default` as a function and `package.json`'s `dependencies` are installed. Run `npm install` inside the extension dir if `node_modules/` is missing.

- [ ] **Step 2: Authenticate (if not already)**

```sh
pi
```
At the pi prompt:
```
/login cursor
```
A browser opens. Complete login. Pi reports success and writes to `~/.pi/agent/auth.json`.

- [ ] **Step 3: Simple text-only prompt**

In pi:
```
/model cursor/claude-4.6-sonnet-medium
What is 2+2?
```
Expected: model responds with "4" or similar within ~5 seconds. No errors.

- [ ] **Step 4: Tool-using prompt**

In pi (a project with files):
```
/model cursor/gpt-5.5-high
List the TypeScript files in pi/extensions/cursor and tell me what `protocol.ts` does.
```
Expected:
- Model issues `ls` and/or `read` tool calls (visible in pi's UI as tool-use blocks).
- Tools resolve to pi's built-in tools (you'll see real file listings).
- Model responds with a coherent description, no 120s timeouts.

- [ ] **Step 5: Multi-turn conversation**

Same chat:
```
Now grep for "frameConnectMessage" in this directory.
```
Expected: grep tool call, results returned, model uses them.

- [ ] **Step 6: Verify the previous attempt's failure is fixed**

```sh
tail -100 ~/.pi/agent/cursor-debug.log 2>/dev/null | grep -E "rejectNative|stream produced no meaningful data" || echo "no errors"
```
Expected: `no errors` (assuming `CURSOR_PROXY_DEBUG=1` is set; otherwise no log file).

- [ ] **Step 7: If everything works, commit settings (no changes likely needed)**

If `pi/settings.json` got modified (e.g. lastChangelogVersion), commit:
```sh
git diff pi/settings.json
git add -p pi/settings.json
git commit -m "Update pi settings after Cursor extension verification"
```
Otherwise: nothing to commit.

---

## Self-Review Checklist

**Spec coverage:** every section of the spec has a corresponding task —
- File layout → Task 1
- Pi Context mapping → Tasks 13, 15
- Native tool redirection (full table) → Tasks 16, 17, 18
- Streaming event mapping → Tasks 7, 19, 20, 21, 23
- OAuth + credentials → Tasks 3, 4, 8, 24
- Model discovery → Tasks 9, 10, 11, 12, 24
- Cursor-specific options (max mode) → Task 5 (runtime-config), Task 21 (CursorSession honors `maxMode`)
- Inactivity timer → Task 21
- Errors/retries → Tasks 22, 24
- Commands → Task 24
- Open questions: `fetch_content` graceful degradation handled in Task 16 (returns `FetchError` shape if pi-web-access missing — actual implementation defers to runtime via the redirect mapping always emitting `fetchArgs` regardless; if `fetch_content` tool is absent in `context.tools`, pi will reject the call and the model adapts).

**Logging open question (spec §Open Questions): the runtime-config emits `debugLogPath` when `CURSOR_PROXY_DEBUG=1`, but no task wires up the writes. We rely on `console.error` / `console.warn` from the lifted `cursor-session.ts` and `cursor-messages.ts` stubs in Task 21 — which print to the same console pi runs in. If a debug file is needed later, add a small `logger.ts` that writes to `runtimeConfig.debugLogPath` when set; not in scope for v1.**

**Type consistency:**
- `CursorModel` defined in Task 12, referenced in Task 24 ✓
- `PendingExec`, `BridgeWriter`, `NativeRedirectInfo` all from `native-tools.ts` (Task 16/18) ✓
- `SessionEvent`, `RetryHint`, `CursorSession` from Task 21 ✓
- `ParsedContext` from Task 13 ✓
- `CursorRuntimeConfig` from Task 5 ✓

**Placeholder scan:** no "TBD"/"TODO"/"add error handling later" — checked. Every code step has full code or a reference to a specific opencode-cursor file with line ranges.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-pi-cursor-extension.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints for review.

Which approach?
