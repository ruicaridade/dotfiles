import { generatePKCE } from "./pkce.ts";
import { getTokenExpiry } from "./jwt.ts";
import { type CursorRuntimeConfig, resolveRuntimeConfig } from "./runtime-config.ts";

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY = 1_000;
const POLL_MAX_DELAY = 10_000;
const POLL_BACKOFF = 1.2;

export interface CursorAuthParams {
  verifier: string;
  challenge: string;
  uuid: string;
  loginUrl: string;
}

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export async function generateCursorAuthParams(
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<CursorAuthParams> {
  const config = resolveRuntimeConfig(runtimeConfig);
  const { verifier, challenge } = await generatePKCE();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    redirectTarget: "cli",
  });
  return { verifier, challenge, uuid, loginUrl: `${config.loginUrl}?${params.toString()}` };
}

export async function pollCursorAuth(
  uuid: string,
  verifier: string,
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<{ accessToken: string; refreshToken: string }> {
  const config = resolveRuntimeConfig(runtimeConfig);
  let delay = POLL_BASE_DELAY;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, delay));
    try {
      const response = await fetch(
        `${config.pollUrl}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
      );
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY);
        continue;
      }
      if (response.ok) {
        const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
        if (typeof data.accessToken !== "string" || !data.accessToken) {
          throw new Error("Cursor auth response missing accessToken");
        }
        if (typeof data.refreshToken !== "string" || !data.refreshToken) {
          throw new Error("Cursor auth response missing refreshToken");
        }
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }
      throw new Error(`Cursor auth poll failed: ${response.status}`);
    } catch (err) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw err instanceof Error ? err : new Error(String(err));
      }
    }
  }
  throw new Error("Cursor authentication polling timed out");
}

export async function refreshCursorToken(
  refreshToken: string,
  runtimeConfig?: Partial<CursorRuntimeConfig>,
): Promise<CursorCredentials> {
  const config = resolveRuntimeConfig(runtimeConfig);
  const response = await fetch(config.refreshUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${refreshToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Cursor token refresh failed: ${errText}`);
  }
  const data = (await response.json()) as { accessToken?: string; refreshToken?: string };
  if (typeof data.accessToken !== "string" || !data.accessToken) {
    throw new Error("Cursor token refresh missing accessToken");
  }
  return {
    access: data.accessToken,
    refresh: data.refreshToken || refreshToken,
    expires: getTokenExpiry(data.accessToken),
  };
}
