import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Api,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  calculateCost,
} from "@mariozechner/pi-ai";
import type { CursorSession, RetryHint, SessionEvent } from "./cursor-session.ts";
import { createThinkingTagFilter } from "./thinking-filter.ts";

export type PumpOutcome =
  | { kind: "batchReady" }
  | { kind: "stop" }
  | { kind: "error"; message: string; retryHint?: RetryHint };

/**
 * Pump session events into the pi stream. Pushes incremental events (text, thinking,
 * tool calls) but does NOT push the terminal `done`/`error` event — that's the caller's
 * responsibility, so retries can happen without a closed stream.
 */
export function pumpSession(
  session: Pick<CursorSession, "next">,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
): Promise<PumpOutcome> {
  return (async () => {
    const tagFilter = createThinkingTagFilter();
    let outputTokens = 0;
    let totalTokens = 0;

    for (;;) {
      const event = (await session.next()) as SessionEvent;

      if (event.type === "text") {
        if (event.isThinking) {
          appendThinking(output, stream, event.text);
        } else {
          const { content, reasoning } = tagFilter.process(event.text);
          if (reasoning) appendThinking(output, stream, reasoning);
          if (content) appendText(output, stream, content);
        }
        continue;
      }
      if (event.type === "toolCall") {
        const flushed = tagFilter.flush();
        if (flushed.reasoning) appendThinking(output, stream, flushed.reasoning);
        if (flushed.content) appendText(output, stream, flushed.content);
        closeOpenBlocks(output, stream);

        const index = output.content.length;
        const toolCall: ToolCall = {
          type: "toolCall",
          id: event.exec.toolCallId,
          name: event.exec.toolName,
          arguments: {},
        };
        output.content.push(toolCall);
        stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
        try {
          toolCall.arguments = JSON.parse(event.exec.decodedArgs || "{}");
        } catch {
          toolCall.arguments = {};
        }
        stream.push({
          type: "toolcall_delta",
          contentIndex: index,
          delta: event.exec.decodedArgs,
          partial: output,
        });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
        continue;
      }
      if (event.type === "usage") {
        outputTokens = event.outputTokens;
        totalTokens = event.totalTokens;
        continue;
      }
      if (event.type === "batchReady") {
        flushTagFilter(tagFilter, output, stream);
        closeOpenBlocks(output, stream);
        applyUsage(output, model, outputTokens, totalTokens);
        return { kind: "batchReady" };
      }
      if (event.type === "done") {
        flushTagFilter(tagFilter, output, stream);
        closeOpenBlocks(output, stream);
        applyUsage(output, model, outputTokens, totalTokens);
        if (event.error) {
          return { kind: "error", message: event.error, retryHint: event.retryHint };
        }
        return { kind: "stop" };
      }
    }
  })();
}

function flushTagFilter(
  tagFilter: ReturnType<typeof createThinkingTagFilter>,
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  const flushed = tagFilter.flush();
  if (flushed.reasoning) appendThinking(output, stream, flushed.reasoning);
  if (flushed.content) appendText(output, stream, flushed.content);
}

/** Push the terminal event for a `batchReady` outcome (toolUse stop). */
export function commitBatchReady(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
): void {
  output.stopReason = "toolUse";
  stream.push({ type: "done", reason: "toolUse", message: output });
  stream.end();
}

/** Push the terminal event for a `stop` outcome. */
export function commitStop(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
): void {
  output.stopReason = "stop";
  stream.push({ type: "done", reason: "stop", message: output });
  stream.end();
}

/** Push the terminal event for an `error` outcome. */
export function commitError(
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  message: string,
  reason: "error" | "aborted" = "error",
): void {
  output.stopReason = reason;
  output.errorMessage = message;
  stream.push({ type: "error", reason, error: output });
  stream.end();
}

function applyUsage(
  output: AssistantMessage,
  model: Model<Api>,
  outputTokens: number,
  totalTokens: number,
): void {
  output.usage.output = outputTokens;
  output.usage.totalTokens = totalTokens || outputTokens;
  output.usage.input = Math.max(0, output.usage.totalTokens - output.usage.output);
  calculateCost(model, output.usage);
}

function ensureTextBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
  const last = output.content.length - 1;
  if (last >= 0 && output.content[last]?.type === "text") return last;
  const index = output.content.length;
  output.content.push({ type: "text", text: "" });
  stream.push({ type: "text_start", contentIndex: index, partial: output });
  return index;
}

function ensureThinkingBlock(output: AssistantMessage, stream: AssistantMessageEventStream): number {
  const last = output.content.length - 1;
  if (last >= 0 && output.content[last]?.type === "thinking") return last;
  const index = output.content.length;
  output.content.push({ type: "thinking", thinking: "" });
  stream.push({ type: "thinking_start", contentIndex: index, partial: output });
  return index;
}

function appendText(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  text: string,
): void {
  if (!text) return;
  const index = ensureTextBlock(output, stream);
  const block = output.content[index]! as TextContent;
  block.text += text;
  stream.push({ type: "text_delta", contentIndex: index, delta: text, partial: output });
}

function appendThinking(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
  text: string,
): void {
  if (!text) return;
  const index = ensureThinkingBlock(output, stream);
  const block = output.content[index]! as ThinkingContent;
  block.thinking += text;
  stream.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: output });
}

function closeOpenBlocks(
  output: AssistantMessage,
  stream: AssistantMessageEventStream,
): void {
  for (let i = 0; i < output.content.length; i++) {
    const block = output.content[i]!;
    if (block.type === "text") {
      stream.push({ type: "text_end", contentIndex: i, content: block.text, partial: output });
    } else if (block.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: i,
        content: block.thinking,
        partial: output,
      });
    }
  }
}
