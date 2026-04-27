import { test } from "node:test";
import { strict as assert } from "node:assert";
import { parsePiContext } from "../pi-context.ts";
import type { Context } from "@mariozechner/pi-ai";

test("empty system prompt defaults", () => {
  const ctx: Context = { systemPrompt: "", messages: [] };
  const p = parsePiContext(ctx);
  assert.equal(p.systemPrompt, "You are a helpful assistant.");
  assert.equal(p.lastUserText, "");
  assert.equal(p.conversationKeyText, "");
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
  assert.equal(p.conversationKeyText, "hello");
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
  assert.equal(p.conversationKeyText, "u1");
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
  assert.equal(p.conversationKeyText, "u1");
  assert.deepEqual(p.toolResults, [
    { toolCallId: "tc1", content: "file contents", isError: false },
  ]);
});

test("old toolResult followed by assistant and user does not force resume mode", () => {
  const ctx: Context = {
    systemPrompt: "",
    messages: [
      { role: "user", content: "u1", timestamp: 1 },
      { role: "assistant", api: "openai-completions", provider: "x", model: "m",
        content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "f" } }],
        usage: zeroUsage(), stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "tc1", toolName: "read",
        content: [{ type: "text", text: "file contents" }], isError: false, timestamp: 3 },
      { role: "assistant", api: "openai-completions", provider: "x", model: "m",
        content: [{ type: "text", text: "a1" }], usage: zeroUsage(), stopReason: "stop", timestamp: 4 },
      { role: "user", content: "u2", timestamp: 5 },
    ],
  };
  const p = parsePiContext(ctx);
  assert.equal(p.lastUserText, "u2");
  assert.equal(p.conversationKeyText, "u1");
  assert.deepEqual(p.toolResults, []);
  assert.deepEqual(p.turns, [{ userText: "u1", assistantText: "a1" }]);
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
