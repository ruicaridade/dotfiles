import { test } from "node:test";
import { strict as assert } from "node:assert";
import { generatePKCE } from "../pkce.ts";

test("generatePKCE returns base64url verifier and challenge", async () => {
  const { verifier, challenge } = await generatePKCE();
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  assert.ok(challenge.length >= 43 && challenge.length <= 128);
});

test("generatePKCE produces a different verifier each call", async () => {
  const a = await generatePKCE();
  const b = await generatePKCE();
  assert.notEqual(a.verifier, b.verifier);
});

test("challenge is sha256(verifier) base64url-encoded", async () => {
  const { createHash } = await import("node:crypto");
  const { verifier, challenge } = await generatePKCE();
  const expected = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(challenge, expected);
});
