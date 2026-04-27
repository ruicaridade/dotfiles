/**
 * Handlers for Cursor server messages (AgentServerMessage).
 *
 * Adapted from opencode-cursor's cursor-messages.ts. Key change: native tools
 * (read/write/shell/etc) are REDIRECTED to pi tools via `nativeToPiRedirect`
 * instead of being rejected. Unsupported native tools (diagnostics, computer
 * use, etc) are still rejected with empty results.
 */
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import {
  fixPiArgNames,
  nativeToPiRedirect,
  type PendingExec,
} from "./native-tools.ts";
import {
  AgentClientMessageSchema,
  type AgentServerMessage,
  AskQuestionInteractionResponseSchema,
  AskQuestionRejectedSchema,
  AskQuestionResultSchema,
  BackgroundShellSpawnResultSchema,
  type ConversationStateStructure,
  ConversationStateStructureSchema,
  CreatePlanRequestResponseSchema,
  DiagnosticsResultSchema,
  ExaFetchRequestResponseSchema,
  ExaSearchRequestResponseSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientStreamCloseSchema,
  type ExecServerControlMessage,
  type ExecServerMessage,
  GetBlobResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  type KvServerMessage,
  McpInstructionsSchema,
  McpResultSchema,
  type McpToolDefinition,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  SwitchModeRequestResponseSchema,
  WebSearchRequestResponse_ApprovedSchema,
  WebSearchRequestResponseSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
} from "./proto/agent_pb.ts";
import { frameConnectMessage } from "./protocol.ts";

// ── Logger stubs ──

function logDebug(..._args: unknown[]): void {
  if (process.env.CURSOR_PROXY_DEBUG === "1") console.error("[cursor]", ..._args);
}
function logWarn(...args: unknown[]): void {
  if (process.env.CURSOR_PROXY_DEBUG === "1") console.warn("[cursor]", ...args);
}

// ── Types ──

export interface StreamState {
  toolCallIndex: number;
  /** Total exec round-trips (MCP + native rejects + requestContext). Tracks Cursor's 25-call limit. */
  totalExecCount: number;
  pendingExecs: PendingExec[];
  outputTokens: number;
  totalTokens: number;
  /** Set when the server sends an endStream frame (clean close or error). */
  endStreamSeen: boolean;
  /** Set by batch-complete signals (checkpoint, stepCompleted, turnEnded)
   *  to indicate pending execs should be flushed. */
  checkpointAfterExec: boolean;
  /** Tracks last delta type for debug logging transitions. */
  lastDeltaType: "text" | "thinking" | null;
}

// ── pi MCP tool prefix handling ──
// pi exposes its tools by raw name (read, write, grep, …). Cursor's model
// sometimes invents an `mcp_pi_` prefix. Strip it defensively.
const MCP_TOOL_PREFIX_RE = /^mcp_(?:pi|opencode)_/;
function stripMcpToolPrefix(name: string): string {
  return name.replace(MCP_TOOL_PREFIX_RE, "");
}

// ── Request-context builder (inlined from opencode-cursor) ──

const PI_MCP_SERVER_NAME = "pi";
const PI_MCP_INSTRUCTIONS =
  "This environment provides MCP tools (e.g. read, write, grep, ls, bash). " +
  "Always prefer these MCP tools over any built-in native tools.";

function buildRequestContext(mcpTools: McpToolDefinition[], cloudRule?: string) {
  return create(RequestContextSchema, {
    rules: [],
    repositoryInfo: [],
    tools: mcpTools,
    gitRepos: [],
    projectLayouts: [],
    mcpInstructions: [
      create(McpInstructionsSchema, {
        serverName: PI_MCP_SERVER_NAME,
        instructions: PI_MCP_INSTRUCTIONS,
      }),
    ],
    cloudRule: cloudRule || undefined,
    fileContents: {},
    customSubagents: [],
  });
}

// ── MCP arg decoding ──

function decodeMcpArgValue(value: Uint8Array): unknown {
  try {
    const parsed = fromBinary(ValueSchema, value);
    return toJson(ValueSchema, parsed);
  } catch {}
  return new TextDecoder().decode(value);
}

function decodeMcpArgsMap(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    decoded[key] = decodeMcpArgValue(value);
  }
  return decoded;
}

// ── Main dispatcher ──

/** Returns true if the message was a recognized type (real server activity, not keepalive). */
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
): boolean {
  const msgCase = msg.message.case;

  if (msgCase === "interactionUpdate") {
    handleInteractionUpdate(msg.message.value, state, onText);
    return true;
  } else if (msgCase === "kvServerMessage") {
    handleKvMessage(msg.message.value as KvServerMessage, blobStore, sendFrame);
    return true;
  } else if (msgCase === "execServerMessage") {
    handleExecMessage(
      msg.message.value as ExecServerMessage,
      mcpTools,
      cloudRule,
      sendFrame,
      onMcpExec,
      state,
    );
    return true;
  } else if (msgCase === "conversationCheckpointUpdate") {
    const stateStructure = msg.message.value as ConversationStateStructure;
    if (stateStructure.tokenDetails) {
      state.totalTokens = stateStructure.tokenDetails.usedTokens;
    }
    logDebug("checkpoint", { tokens: state.totalTokens, pending: state.pendingExecs.length });
    onCheckpoint(toBinary(ConversationStateStructureSchema, stateStructure));
    return true;
  } else if (msgCase === "execServerControlMessage") {
    const ctrl = msg.message.value as ExecServerControlMessage;
    if (ctrl.message.case === "abort") {
      logDebug("exec ABORT", { id: ctrl.message.value.id });
    }
    return true;
  } else if (msgCase === "interactionQuery") {
    handleInteractionQuery(msg.message.value as any, sendFrame, onQueryNote);
    return true;
  }
  logDebug("unrecognized server message case", { case: msgCase ?? "undefined" });
  return false;
}

// ── Interaction updates ──

function handleInteractionUpdate(
  update: any,
  state: StreamState,
  onText: (text: string, isThinking: boolean) => void,
): void {
  const updateCase = update.message?.case;

  if (updateCase === "textDelta") {
    const delta = update.message.value.text || "";
    if (delta) {
      if (state.lastDeltaType !== "text") state.lastDeltaType = "text";
      onText(delta, false);
    }
  } else if (updateCase === "thinkingDelta") {
    const delta = update.message.value.text || "";
    if (delta) {
      if (state.lastDeltaType !== "thinking") state.lastDeltaType = "thinking";
      onText(delta, true);
    }
  } else if (updateCase === "tokenDelta") {
    state.outputTokens += update.message.value.tokens ?? 0;
  } else if (updateCase === "toolCallStarted") {
    // informational
  } else if (updateCase === "toolCallCompleted") {
    // informational
  } else if (updateCase === "turnEnded" || updateCase === "stepCompleted") {
    if (state.pendingExecs.length > 0) {
      state.checkpointAfterExec = true;
    }
  } else if (updateCase === "heartbeat") {
    // keepalive
  } else if (updateCase && updateCase !== "toolCallDelta" && updateCase !== "partialToolCall") {
    logDebug("interactionUpdate unhandled", { type: updateCase });
  }
}

// ── Interaction queries ──

function handleInteractionQuery(
  query: any,
  sendFrame: (data: Uint8Array) => void,
  onQueryNote: (text: string) => void,
): void {
  const queryId: number = query.id ?? 0;
  const queryCase: string = query.query?.case ?? "unknown";
  const searchTerm =
    queryCase === "webSearchRequestQuery"
      ? ((query.query?.value?.args?.searchTerm ?? "") as string)
      : "";

  let responseResult: any;

  if (queryCase === "webSearchRequestQuery") {
    if (searchTerm) onQueryNote(`[web search: ${searchTerm}]`);
    responseResult = {
      case: "webSearchRequestResponse",
      value: create(WebSearchRequestResponseSchema, {
        result: { case: "approved", value: create(WebSearchRequestResponse_ApprovedSchema, {}) },
      }),
    };
  } else if (queryCase === "exaSearchRequestQuery") {
    responseResult = {
      case: "exaSearchRequestResponse",
      value: create(ExaSearchRequestResponseSchema, {
        result: { case: "approved", value: {} as any },
      }),
    };
  } else if (queryCase === "exaFetchRequestQuery") {
    responseResult = {
      case: "exaFetchRequestResponse",
      value: create(ExaFetchRequestResponseSchema, {
        result: { case: "approved", value: {} as any },
      }),
    };
  } else if (queryCase === "askQuestionInteractionQuery") {
    responseResult = {
      case: "askQuestionInteractionResponse",
      value: create(AskQuestionInteractionResponseSchema, {
        result: create(AskQuestionResultSchema, {
          result: {
            case: "rejected",
            value: create(AskQuestionRejectedSchema, { reason: "Non-interactive session" }),
          },
        }),
      }),
    };
  } else if (queryCase === "switchModeRequestQuery") {
    responseResult = {
      case: "switchModeRequestResponse",
      value: create(SwitchModeRequestResponseSchema, {}),
    };
  } else if (queryCase === "createPlanRequestQuery") {
    responseResult = {
      case: "createPlanRequestResponse",
      value: create(CreatePlanRequestResponseSchema, {}),
    };
  } else {
    logDebug("interactionQuery unknown", { type: queryCase, id: queryId });
    const response = create(InteractionResponseSchema, { id: queryId });
    const clientMsg = create(AgentClientMessageSchema, {
      message: { case: "interactionResponse", value: response },
    });
    sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
    return;
  }

  const response = create(InteractionResponseSchema, { id: queryId, result: responseResult });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "interactionResponse", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

// ── KV (blob store) ──

function sendKvResponse(
  kvMsg: KvServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const response = create(KvClientMessageSchema, {
    id: kvMsg.id,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMsg = create(AgentClientMessageSchema, {
    message: { case: "kvClientMessage", value: response },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMsg)));
}

function handleKvMessage(
  kvMsg: KvServerMessage,
  blobStore: Map<string, Uint8Array>,
  sendFrame: (data: Uint8Array) => void,
): void {
  const kvCase = kvMsg.message.case;

  if (kvCase === "getBlobArgs") {
    const blobId = kvMsg.message.value.blobId;
    const blobIdKey = Buffer.from(blobId).toString("hex");
    const blobData = blobStore.get(blobIdKey);
    if (!blobData) {
      logDebug("KV getBlob MISS", { id: blobIdKey.slice(0, 16), size: blobStore.size });
    }
    sendKvResponse(
      kvMsg,
      "getBlobResult",
      create(GetBlobResultSchema, blobData ? { blobData } : {}),
      sendFrame,
    );
  } else if (kvCase === "setBlobArgs") {
    const { blobId, blobData } = kvMsg.message.value;
    blobStore.set(Buffer.from(blobId).toString("hex"), blobData);
    sendKvResponse(kvMsg, "setBlobResult", create(SetBlobResultSchema, {}), sendFrame);
  }
}

// ── Exec messages (tool calls) ──

export function handleExecMessage(
  execMsg: ExecServerMessage,
  mcpTools: McpToolDefinition[],
  cloudRule: string | undefined,
  sendFrame: (data: Uint8Array) => void,
  onMcpExec: (exec: PendingExec) => void,
  state?: StreamState,
): void {
  const execCase = execMsg.message.case;

  if (execCase === "requestContextArgs") {
    const requestContext = buildRequestContext(mcpTools, cloudRule);
    const result = create(RequestContextResultSchema, {
      result: {
        case: "success",
        value: create(RequestContextSuccessSchema, { requestContext }),
      },
    });
    sendExecResult(execMsg, "requestContextResult", result, sendFrame);
    return;
  }

  if (execCase === "mcpArgs") {
    if (state) state.totalExecCount++;
    const mcpArgs = execMsg.message.value;
    const decoded = decodeMcpArgsMap(mcpArgs.args ?? {});
    const resolvedToolName = stripMcpToolPrefix(mcpArgs.toolName || mcpArgs.name);
    fixPiArgNames(resolvedToolName, decoded);
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: mcpArgs.toolCallId || crypto.randomUUID(),
      toolName: resolvedToolName,
      decodedArgs: JSON.stringify(decoded),
    });
    return;
  }

  // --- Redirect supported native tools through pi MCP ---
  if (state) state.totalExecCount++;
  const nativeRedirect = nativeToPiRedirect(execCase as string, execMsg);
  if (nativeRedirect) {
    onMcpExec({
      execId: execMsg.execId,
      execMsgId: execMsg.id,
      toolCallId: nativeRedirect.toolCallId,
      toolName: nativeRedirect.toolName,
      decodedArgs: nativeRedirect.decodedArgs,
      nativeResultType: nativeRedirect.nativeResultType,
      nativeArgs: nativeRedirect.nativeArgs,
    });
    return;
  }

  // --- Reject unsupported native tools ---
  const REJECT_REASON =
    "Tool not available in this environment. Use the MCP tools provided instead.";

  if (execCase === "backgroundShellSpawnArgs") {
    const args = execMsg.message.value;
    const result = create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "rejected",
        value: create(ShellRejectedSchema, {
          command: args.command ?? "",
          workingDirectory: args.workingDirectory ?? "",
          reason: REJECT_REASON,
          isReadonly: false,
        }),
      },
    });
    sendExecResult(execMsg, "backgroundShellSpawnResult", result, sendFrame);
    return;
  }
  if (execCase === "writeShellStdinArgs") {
    const result = create(WriteShellStdinResultSchema, {
      result: {
        case: "error",
        value: create(WriteShellStdinErrorSchema, { error: REJECT_REASON }),
      },
    });
    sendExecResult(execMsg, "writeShellStdinResult", result, sendFrame);
    return;
  }
  if (execCase === "diagnosticsArgs") {
    const result = create(DiagnosticsResultSchema, {});
    sendExecResult(execMsg, "diagnosticsResult", result, sendFrame);
    return;
  }

  const miscCaseMap: Record<string, string> = {
    listMcpResourcesExecArgs: "listMcpResourcesExecResult",
    readMcpResourceExecArgs: "readMcpResourceExecResult",
    mcpStateExecArgs: "mcpStateExecResult",
    recordScreenArgs: "recordScreenResult",
    computerUseArgs: "computerUseResult",
  };
  const resultCase = miscCaseMap[execCase as string];
  if (resultCase) {
    sendExecResult(execMsg, resultCase, create(McpResultSchema, {}), sendFrame);
    return;
  }

  sendUnknownExecResult(execMsg, sendFrame);
}

// ── Exec result helpers ──

function sendExecResult(
  execMsg: ExecServerMessage,
  messageCase: string,
  value: unknown,
  sendFrame: (data: Uint8Array) => void,
): void {
  const execClientMessage = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
    message: { case: messageCase as any, value: value as any },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMessage },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
  sendExecStreamClose(execMsg.id, sendFrame);
}

function sendExecStreamClose(execId: number, sendFrame: (data: Uint8Array) => void): void {
  const controlMsg = create(ExecClientControlMessageSchema, {
    message: {
      case: "streamClose",
      value: create(ExecClientStreamCloseSchema, { id: execId }),
    },
  });
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientControlMessage", value: controlMsg },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
}

/**
 * Send a best-effort empty result for an exec type not in our proto schema.
 * Extracts the unknown oneof field number from $unknown and mirrors it back
 * as an empty message, preventing the server from waiting indefinitely.
 */
function sendUnknownExecResult(
  execMsg: ExecServerMessage,
  sendFrame: (data: Uint8Array) => void,
): void {
  const unknowns: Array<{ no: number; wireType: number; data: Uint8Array }> | undefined = (
    execMsg as any
  ).$unknown;
  const argsField = unknowns?.find(
    (f) => f.wireType === 2 && f.no !== 1 && f.no !== 15 && f.no !== 19,
  );
  if (!argsField) {
    logWarn("unhandled exec: no recoverable field number", {
      case: execMsg.message.case,
      id: execMsg.id,
    });
    return;
  }
  const resultFieldNo = argsField.no;
  logWarn("unhandled exec: sending empty result", { field: resultFieldNo, id: execMsg.id });
  const execClientMsg = create(ExecClientMessageSchema, {
    id: execMsg.id,
    execId: execMsg.execId,
  });
  (execClientMsg as any).$unknown = [{ no: resultFieldNo, wireType: 2, data: new Uint8Array(0) }];
  const clientMessage = create(AgentClientMessageSchema, {
    message: { case: "execClientMessage", value: execClientMsg },
  });
  sendFrame(frameConnectMessage(toBinary(AgentClientMessageSchema, clientMessage)));
  sendExecStreamClose(execMsg.id, sendFrame);
}
