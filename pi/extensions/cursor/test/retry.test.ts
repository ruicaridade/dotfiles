import { test } from "node:test";
import { strict as assert } from "node:assert";
import { computeRetryDelayMs, retryBudget } from "../retry.ts";

test("budget for timeout = 5", () => {
  const b = retryBudget("timeout");
  assert.equal(b.maxAttempts, 5);
});

test("budget for resource_exhausted = 10", () => {
  const b = retryBudget("resource_exhausted");
  assert.equal(b.maxAttempts, 10);
});

test("budget for blob_not_found = 1 (one fresh-state retry)", () => {
  const b = retryBudget("blob_not_found");
  assert.equal(b.maxAttempts, 1);
});

test("delay grows exponentially capped at 4s", () => {
  assert.equal(computeRetryDelayMs(0), 500);
  assert.equal(computeRetryDelayMs(1), 1000);
  assert.equal(computeRetryDelayMs(2), 2000);
  assert.equal(computeRetryDelayMs(3), 4000);
  assert.equal(computeRetryDelayMs(10), 4000); // capped
});
