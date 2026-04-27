import { test, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import {
  generateCursorAuthParams,
  pollCursorAuth,
  refreshCursorToken,
} from "../auth.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("generateCursorAuthParams produces a valid Cursor login URL", async () => {
  const { verifier, challenge, uuid, loginUrl } = await generateCursorAuthParams();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.match(uuid, /^[0-9a-f-]{36}$/);
  const u = new URL(loginUrl);
  assert.equal(u.host, "cursor.com");
  assert.equal(u.pathname, "/loginDeepControl");
  assert.equal(u.searchParams.get("challenge"), challenge);
  assert.equal(u.searchParams.get("uuid"), uuid);
  assert.equal(u.searchParams.get("mode"), "login");
  assert.equal(u.searchParams.get("redirectTarget"), "cli");
});

test("pollCursorAuth keeps polling on 404 and resolves on 200", { timeout: 30_000 }, async () => {
  let calls = 0;
  globalThis.fetch = (async (input: string | URL) => {
    calls++;
    const url = typeof input === "string" ? input : input.toString();
    assert.match(url, /\/auth\/poll\?uuid=u&verifier=v/);
    if (calls < 3) return new Response("", { status: 404 });
    return Response.json({ accessToken: "ACC", refreshToken: "REF" });
  }) as typeof fetch;

  const result = await pollCursorAuth("u", "v", { /* faster polling for the test */ } as any);
  assert.equal(result.accessToken, "ACC");
  assert.equal(result.refreshToken, "REF");
  assert.equal(calls, 3);
});

test("refreshCursorToken POSTs with bearer refresh and parses tokens", async () => {
  let captured: { url: string; init?: RequestInit } | null = null;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    captured = { url: typeof input === "string" ? input : input.toString(), init };
    return Response.json({ accessToken: "NEW_ACC", refreshToken: "NEW_REF" });
  }) as typeof fetch;

  const result = await refreshCursorToken("OLD_REF");
  assert.equal(result.access, "NEW_ACC");
  assert.equal(result.refresh, "NEW_REF");
  assert.ok(typeof result.expires === "number");
  assert.match(captured!.url, /\/auth\/exchange_user_api_key$/);
  assert.equal((captured!.init!.headers as Record<string, string>).Authorization, "Bearer OLD_REF");
});

test("refreshCursorToken keeps the old refresh token if response omits one", async () => {
  globalThis.fetch = (async () => Response.json({ accessToken: "NEW_ACC" })) as typeof fetch;
  const result = await refreshCursorToken("KEEP_THIS_REF");
  assert.equal(result.refresh, "KEEP_THIS_REF");
});

test("refreshCursorToken throws on HTTP error", async () => {
  globalThis.fetch = (async () => new Response("bad", { status: 401 })) as typeof fetch;
  await assert.rejects(() => refreshCursorToken("X"), /Cursor token refresh failed/);
});
