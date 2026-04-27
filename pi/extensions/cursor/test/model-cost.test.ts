import { test } from "node:test";
import { strict as assert } from "node:assert";
import { estimateModelCost } from "../model-cost.ts";

test("exact id match returns table cost", () => {
  const cost = estimateModelCost("claude-4.6-sonnet");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});

test("variant id falls through to base via pattern", () => {
  // claude-4.6-sonnet-medium → /claude.*sonnet/ pattern
  const cost = estimateModelCost("claude-4.6-sonnet-medium");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});

test("opus-fast pattern beats opus pattern", () => {
  const cost = estimateModelCost("claude-4.6-opus-fast");
  assert.equal(cost.input, 30);
  assert.equal(cost.output, 150);
});

test("unknown family returns default", () => {
  const cost = estimateModelCost("xyz-unknown");
  assert.equal(cost.input, 3);
  assert.equal(cost.output, 15);
});
