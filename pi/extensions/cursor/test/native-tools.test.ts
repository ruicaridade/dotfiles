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
