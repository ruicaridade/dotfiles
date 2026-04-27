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
