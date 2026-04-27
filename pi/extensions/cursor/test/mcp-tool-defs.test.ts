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
