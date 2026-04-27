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
