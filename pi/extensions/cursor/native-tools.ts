import type { ExecServerMessage } from "./proto/agent_pb.ts";

export type NativeResultType =
  | "readResult"
  | "writeResult"
  | "deleteResult"
  | "fetchResult"
  | "shellResult"
  | "shellStreamResult"
  | "lsResult"
  | "grepResult";

export interface PendingExec {
  execId: string;
  execMsgId: number;
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  nativeResultType?: NativeResultType;
  nativeArgs?: Record<string, string>;
}

export interface NativeRedirectInfo {
  toolCallId: string;
  toolName: string;
  decodedArgs: string;
  nativeResultType: NativeResultType;
  nativeArgs: Record<string, string>;
}

export function fixPiArgNames(toolName: string, args: Record<string, unknown>): void {
  if (toolName === "read") {
    if (args.path == null && args.filePath != null) {
      args.path = args.filePath;
      delete args.filePath;
    }
  } else if (toolName === "write" || toolName === "edit") {
    if (args.path == null && args.filePath != null) {
      args.path = args.filePath;
      delete args.filePath;
    }
    if (toolName === "write" && args.content == null && args.file_content != null) {
      args.content = args.file_content;
      delete args.file_content;
    }
  } else if (toolName === "find") {
    if (args.pattern == null && args.glob_pattern != null) {
      args.pattern = args.glob_pattern;
      delete args.glob_pattern;
    }
    if (args.path == null && args.target_directory != null) {
      args.path = args.target_directory;
      delete args.target_directory;
    }
  } else if (toolName === "grep") {
    if (args.pattern == null) args.pattern = ".";
  }
}

export function nativeToPiRedirect(
  execCase: string,
  execMsg: ExecServerMessage,
): NativeRedirectInfo | null {
  // biome-ignore lint/suspicious/noExplicitAny: protobuf union type
  const args = execMsg.message.value as any;
  const toolCallId = args?.toolCallId || crypto.randomUUID();

  if (execCase === "readArgs") {
    const piArgs: Record<string, unknown> = { path: args.path };
    if (args.offset != null && args.offset !== 0) piArgs.offset = args.offset;
    if (args.limit != null && args.limit !== 0) piArgs.limit = args.limit;
    return {
      toolCallId,
      toolName: "read",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: "readResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "writeArgs") {
    const fileContent =
      args.fileBytes && args.fileBytes.length > 0
        ? new TextDecoder().decode(args.fileBytes)
        : (args.fileText ?? "");
    return {
      toolCallId,
      toolName: "write",
      decodedArgs: JSON.stringify({ path: args.path, content: fileContent }),
      nativeResultType: "writeResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "deleteArgs") {
    const rawPath: string = args.path ?? "";
    if (!rawPath) {
      return {
        toolCallId,
        toolName: "bash",
        decodedArgs: JSON.stringify({ command: "true" }),
        nativeResultType: "deleteResult",
        nativeArgs: { path: "" },
      };
    }
    const safePath = rawPath.replace(/\0/g, "").replace(/'/g, `'\\''`);
    return {
      toolCallId,
      toolName: "bash",
      decodedArgs: JSON.stringify({ command: `rm -f -- '${safePath}'` }),
      nativeResultType: "deleteResult",
      nativeArgs: { path: rawPath },
    };
  }
  if (execCase === "fetchArgs") {
    return {
      toolCallId,
      toolName: "fetch_content",
      decodedArgs: JSON.stringify({ url: args.url }),
      nativeResultType: "fetchResult",
      nativeArgs: { url: args.url ?? "" },
    };
  }
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") {
    const cmd: string = args.command ?? "";
    if (args.workingDirectory) {
      console.warn(
        `[cursor] dropping unsupported workingDirectory='${args.workingDirectory}' for ${execCase}`,
      );
    }
    const piArgs: Record<string, unknown> = { command: cmd };
    if (args.timeout != null && args.timeout > 0) piArgs.timeout = args.timeout;
    return {
      toolCallId,
      toolName: "bash",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: execCase === "shellStreamArgs" ? "shellStreamResult" : "shellResult",
      nativeArgs: { command: cmd },
    };
  }
  if (execCase === "lsArgs") {
    return {
      toolCallId,
      toolName: "ls",
      decodedArgs: JSON.stringify({ path: args.path }),
      nativeResultType: "lsResult",
      nativeArgs: { path: args.path ?? "" },
    };
  }
  if (execCase === "grepArgs") {
    const pattern: string = args.pattern ?? "";
    if (!pattern && args.glob) {
      return {
        toolCallId,
        toolName: "find",
        decodedArgs: JSON.stringify({ pattern: args.glob, path: args.path || undefined }),
        nativeResultType: "grepResult",
        nativeArgs: {
          pattern: args.glob ?? "",
          path: args.path ?? "",
          outputMode: "files_with_matches",
        },
      };
    }
    const piArgs: Record<string, unknown> = { pattern: pattern || "." };
    if (args.path) piArgs.path = args.path;
    if (args.glob) piArgs.glob = args.glob;
    if (args.caseInsensitive != null) piArgs.ignoreCase = args.caseInsensitive;
    const ctxMax = Math.max(args.contextBefore ?? 0, args.contextAfter ?? 0, args.context ?? 0);
    if (ctxMax > 0) piArgs.context = ctxMax;
    if (args.headLimit != null) piArgs.limit = args.headLimit;
    return {
      toolCallId,
      toolName: "grep",
      decodedArgs: JSON.stringify(piArgs),
      nativeResultType: "grepResult",
      nativeArgs: {
        pattern: pattern || ".",
        path: args.path ?? "",
        outputMode: args.outputMode || "content",
      },
    };
  }
  return null;
}
