const SAFETY_MARGIN_MS = 5 * 60 * 1000;
const FALLBACK_TTL_MS = 3600 * 1000;

export function getTokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) {
      return Date.now() + FALLBACK_TTL_MS;
    }
    const payload = JSON.parse(
      Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    if (payload && typeof payload === "object" && typeof payload.exp === "number") {
      return payload.exp * 1000 - SAFETY_MARGIN_MS;
    }
  } catch {
    // fall through
  }
  return Date.now() + FALLBACK_TTL_MS;
}
