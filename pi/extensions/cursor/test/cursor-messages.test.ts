import { test } from "node:test";
import { strict as assert } from "node:assert";
import { create } from "@bufbuild/protobuf";
import {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  ReadArgsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
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
        message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "hi" }) },
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
        message: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text: "rea" }) },
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
