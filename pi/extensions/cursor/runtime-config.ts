export interface CursorRuntimeConfig {
  apiUrl: string;
  agentUrl: string;
  loginUrl: string;
  pollUrl: string;
  refreshUrl: string;
  clientVersion: string;
  thinkingTimeoutMs: number;
  streamingTimeoutMs: number;
  collectingTimeoutMs: number;
  flushedSessionMaxLifetimeMs: number;
  conversationTtlMs: number;
  maxMode: boolean;
  debugLogPath: string | null;
}

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

export function resolveRuntimeConfig(
  overrides: Partial<CursorRuntimeConfig> = {},
): CursorRuntimeConfig {
  return {
    apiUrl: process.env.CURSOR_API_URL ?? "https://api2.cursor.sh",
    agentUrl: process.env.CURSOR_AGENT_URL ?? "https://api2.cursor.sh",
    loginUrl: process.env.CURSOR_LOGIN_URL ?? "https://cursor.com/loginDeepControl",
    pollUrl: process.env.CURSOR_POLL_URL ?? "https://api2.cursor.sh/auth/poll",
    refreshUrl:
      process.env.CURSOR_REFRESH_URL ?? "https://api2.cursor.sh/auth/exchange_user_api_key",
    clientVersion: process.env.CURSOR_CLIENT_VERSION ?? "cli-2026.03.30-a5d3e17",
    thinkingTimeoutMs: 30_000,
    streamingTimeoutMs: 15_000,
    collectingTimeoutMs: 30_000,
    flushedSessionMaxLifetimeMs: 10 * 60 * 1000,
    conversationTtlMs: 30 * 60 * 1000,
    maxMode: envBool("CURSOR_MAX_MODE", true),
    debugLogPath: envBool("CURSOR_PROXY_DEBUG", false)
      ? `${process.env.HOME || "."}/.pi/agent/cursor-debug.log`
      : null,
    ...overrides,
  };
}
