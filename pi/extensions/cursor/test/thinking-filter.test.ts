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
