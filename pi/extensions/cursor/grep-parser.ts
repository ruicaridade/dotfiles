import { create } from "@bufbuild/protobuf";
import {
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  type GrepContentMatch,
  type GrepContentResult,
  type GrepFileMatch,
  type GrepFilesResult,
  type GrepResult,
  type GrepUnionResult,
} from "./proto/agent_pb.ts";

const SUPPORTED_OUTPUT_MODES: ReadonlySet<string> = new Set(["content", "files_with_matches"]);

export interface GrepBuildResult {
  resultCase: "grepResult";
  resultValue: GrepResult;
}

export function buildGrepResult(
  content: string,
  args: Record<string, string>,
): GrepBuildResult | null {
  const pattern = args.pattern ?? "";
  const path = args.path ?? "";
  const outputMode = args.outputMode || "content";

  if (!SUPPORTED_OUTPUT_MODES.has(outputMode)) return null;

  let unionResult:
    | { case: "files"; value: GrepFilesResult }
    | { case: "content"; value: GrepContentResult };

  if (outputMode === "files_with_matches") {
    unionResult = buildFilesResult(content);
  } else {
    unionResult = buildContentResult(content);
  }

  if (content.trim() && isEmptyResult(unionResult)) return null;

  const workspaceResults: { [key: string]: GrepUnionResult } = {};
  workspaceResults[path || "."] = create(GrepUnionResultSchema, { result: unionResult });

  return {
    resultCase: "grepResult",
    resultValue: create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, { pattern, path, outputMode, workspaceResults }),
      },
    }),
  };
}

function isEmptyResult(
  r:
    | { case: "files"; value: GrepFilesResult }
    | { case: "content"; value: GrepContentResult },
): boolean {
  return r.case === "files" ? r.value.files.length === 0 : r.value.matches.length === 0;
}

function buildFilesResult(content: string): { case: "files"; value: GrepFilesResult } {
  const files = content
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean);
  return {
    case: "files" as const,
    value: create(GrepFilesResultSchema, {
      files,
      totalFiles: files.length,
      clientTruncated: false,
      ripgrepTruncated: false,
    }),
  };
}

function buildContentResult(content: string): { case: "content"; value: GrepContentResult } {
  const fileMatches: GrepFileMatch[] = [];
  let currentFile = "";
  let currentMatches: GrepContentMatch[] = [];
  let totalLines = 0;
  let totalMatchedLines = 0;

  const flushFile = () => {
    if (currentFile && currentMatches.length > 0) {
      fileMatches.push(create(GrepFileMatchSchema, { file: currentFile, matches: currentMatches }));
    }
    currentMatches = [];
  };

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line === "--" || line === "") continue;

    const matchHit = line.match(/^(.+?):(\d+):(.*)/);
    if (matchHit) {
      const file = matchHit[1]!;
      const lineNum = Number.parseInt(matchHit[2]!, 10);
      const text = matchHit[3]!;
      if (file !== currentFile) {
        flushFile();
        currentFile = file;
      }
      totalLines++;
      totalMatchedLines++;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber: lineNum,
          content: text,
          isContextLine: false,
        }),
      );
      continue;
    }

    const ctx = parseContextLine(line, currentFile);
    if (ctx) {
      if (ctx.file !== currentFile) {
        flushFile();
        currentFile = ctx.file;
      }
      totalLines++;
      currentMatches.push(
        create(GrepContentMatchSchema, {
          lineNumber: ctx.lineNum,
          content: ctx.text,
          isContextLine: true,
        }),
      );
    }
  }
  flushFile();

  return {
    case: "content" as const,
    value: create(GrepContentResultSchema, {
      matches: fileMatches,
      totalLines,
      totalMatchedLines,
      clientTruncated: false,
      ripgrepTruncated: false,
    }),
  };
}

function parseContextLine(
  line: string,
  currentFile: string,
): { file: string; lineNum: number; text: string } | null {
  if (currentFile) {
    const prefix = `${currentFile}-`;
    if (line.startsWith(prefix)) {
      const m = line.slice(prefix.length).match(/^(\d+)-(.*)/s);
      if (m) {
        return { file: currentFile, lineNum: Number.parseInt(m[1]!, 10), text: m[2]! };
      }
    }
  }
  const m = line.match(/^(.+?)-(\d+)-(.*)/);
  if (m) {
    return { file: m[1]!, lineNum: Number.parseInt(m[2]!, 10), text: m[3]! };
  }
  return null;
}
