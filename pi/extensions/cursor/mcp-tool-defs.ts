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
