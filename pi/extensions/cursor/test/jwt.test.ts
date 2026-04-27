import { test } from "node:test";
import { strict as assert } from "node:assert";
import { getTokenExpiry } from "../jwt.ts";

function makeJWT(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

test("returns exp - 5min in milliseconds when JWT carries an exp claim", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = makeJWT({ exp });
  const expiry = getTokenExpiry(token);
  assert.equal(expiry, exp * 1000 - 5 * 60 * 1000);
});

test("falls back to now+1h when JWT cannot be parsed", () => {
  const before = Date.now();
  const expiry = getTokenExpiry("not-a-jwt");
  const after = Date.now();
  assert.ok(expiry >= before + 3600 * 1000);
  assert.ok(expiry <= after + 3600 * 1000);
});

test("falls back when exp is missing", () => {
  const before = Date.now();
  const expiry = getTokenExpiry(makeJWT({ sub: "abc" }));
  const after = Date.now();
  assert.ok(expiry >= before + 3600 * 1000);
  assert.ok(expiry <= after + 3600 * 1000);
});
