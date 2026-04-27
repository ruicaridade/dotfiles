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

test("text events emit text deltas and return stop outcome", async () => {
  const session = new FakeSession();
  const stream = createAssistantMessageEventStream();
  const output = makeOutput();
  const pump = pumpSession(session as any, stream, output, model);
  session.push({ type: "text", text: "hello", isThinking: false });
  session.push({ type: "text", text: " world", isThinking: false });
  session.push({ type: "done" });
  const outcome = await pump;
  assert.deepEqual(outcome, { kind: "stop" });
  // Text buffered into a single content block (reuse rule).
  assert.equal(output.content.length, 1);
  assert.equal((output.content[0] as { text: string }).text, "hello world");
});

test("toolCall + batchReady returns batchReady outcome", async () => {
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
  const outcome = await pump;
  assert.deepEqual(outcome, { kind: "batchReady" });
  assert.equal(output.content.length, 1);
  assert.equal((output.content[0] as { type: string }).type, "toolCall");
});

test("done with retryable error returns error outcome with retryHint", async () => {
  const session = new FakeSession();
  const stream = createAssistantMessageEventStream();
  const output = makeOutput();
  const pump = pumpSession(session as any, stream, output, model);
  session.push({ type: "done", error: "boom", retryHint: "resource_exhausted" });
  const outcome = await pump;
  assert.deepEqual(outcome, { kind: "error", message: "boom", retryHint: "resource_exhausted" });
});
