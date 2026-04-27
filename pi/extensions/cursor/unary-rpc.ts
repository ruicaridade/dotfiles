import { randomUUID } from "node:crypto";
import { connect as h2Connect } from "node:http2";
import { type CursorRuntimeConfig, resolveRuntimeConfig } from "./runtime-config.ts";

export interface CursorUnaryRpcOptions {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  runtimeConfig?: Partial<CursorRuntimeConfig>;
}

export interface CursorUnaryRpcResult {
  body: Uint8Array;
  exitCode: number;
  timedOut: boolean;
}

export async function callCursorUnaryRpc(
  options: CursorUnaryRpcOptions,
): Promise<CursorUnaryRpcResult> {
  const runtimeConfig = resolveRuntimeConfig(options.runtimeConfig);
  const url = options.url ?? runtimeConfig.apiUrl;
  const requestId = randomUUID();
  let resolve!: (value: CursorUnaryRpcResult) => void;
  const promise = new Promise<CursorUnaryRpcResult>((r) => { resolve = r; });

  let timedOut = false;
  let settled = false;

  const session = h2Connect(url);
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : 5_000;
  const timeout = setTimeout(() => {
    timedOut = true;
    try { session.destroy(); } catch { /* ignore */ }
  }, timeoutMs);

  const finish = (body: Uint8Array, code: number) => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    try { session.close(); } catch { /* ignore */ }
    resolve({ body, exitCode: timedOut ? 1 : code, timedOut });
  };

  session.on("error", () => finish(new Uint8Array(0), 1));

  const stream = session.request({
    ":method": "POST",
    ":path": options.rpcPath,
    "content-type": "application/proto",
    "user-agent": "connect-es/1.6.1",
    authorization: `Bearer ${options.accessToken}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": runtimeConfig.clientVersion,
    "x-cursor-client-type": "cli",
    "x-request-id": requestId,
  });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  stream.on("end", () => finish(Buffer.concat(chunks), 0));
  stream.on("error", () => finish(Buffer.concat(chunks), 1));

  if (options.requestBody.length > 0) {
    stream.end(Buffer.from(options.requestBody));
  } else {
    stream.end();
  }
  return promise;
}
