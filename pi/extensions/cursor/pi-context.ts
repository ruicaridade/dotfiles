import type {
  Context,
  Message,
  TextContent,
  ImageContent,
  ToolResultMessage,
} from "@mariozechner/pi-ai";

export interface ParsedContext {
  systemPrompt: string;
  turns: Array<{ userText: string; assistantText: string }>;
  lastUserText: string;
  toolResults: Array<{ toolCallId: string; content: string; isError: boolean }>;
}

function textFromContent(content: Message["content"] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .map((c) => {
      if ((c as TextContent).type === "text") return (c as TextContent).text;
      if ((c as ImageContent).type === "image") return `[image: ${(c as ImageContent).mimeType}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolResultText(msg: ToolResultMessage): string {
  return msg.content
    .map((c) => (c.type === "text" ? c.text : `[image: ${(c as ImageContent).mimeType}]`))
    .join("\n");
}

export function parsePiContext(context: Context): ParsedContext {
  const systemPrompt = (context.systemPrompt ?? "").trim() || "You are a helpful assistant.";
  const turns: Array<{ userText: string; assistantText: string }> = [];
  const toolResults: Array<{ toolCallId: string; content: string; isError: boolean }> = [];
  let pendingUser = "";
  let pendingAssistant = "";

  for (const msg of context.messages) {
    if (msg.role === "user") {
      if (pendingUser) {
        turns.push({ userText: pendingUser, assistantText: pendingAssistant });
        pendingAssistant = "";
      }
      pendingUser = textFromContent(msg.content);
    } else if (msg.role === "assistant") {
      pendingAssistant += msg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    } else if (msg.role === "toolResult") {
      toolResults.push({
        toolCallId: msg.toolCallId,
        content: toolResultText(msg),
        isError: msg.isError,
      });
    }
  }

  let lastUserText = "";
  if (toolResults.length > 0) {
    if (pendingUser) {
      turns.push({ userText: pendingUser, assistantText: pendingAssistant });
    }
  } else if (pendingUser) {
    lastUserText = pendingUser;
  } else if (turns.length > 0) {
    const last = turns.pop()!;
    lastUserText = last.userText;
  }

  return { systemPrompt, turns, lastUserText, toolResults };
}
