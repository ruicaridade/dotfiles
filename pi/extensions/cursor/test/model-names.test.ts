import { test } from "node:test";
import { strict as assert } from "node:assert";
import { hasReasoningSuffix, prettyCursorModelName, resolveCursorModelName } from "../model-names.ts";

test("hasReasoningSuffix detects effort suffixes", () => {
  assert.equal(hasReasoningSuffix("gpt-5.5-extra-high"), true);
  assert.equal(hasReasoningSuffix("claude-4.6-sonnet-medium"), true);
  assert.equal(hasReasoningSuffix("composer-2-fast"), true);
  assert.equal(hasReasoningSuffix("composer-2"), false);
  assert.equal(hasReasoningSuffix("auto"), false);
});

test("prettyCursorModelName humanizes ids", () => {
  assert.equal(prettyCursorModelName("claude-4.6-sonnet"), "Claude 4.6 Sonnet");
  assert.equal(prettyCursorModelName("gpt-5.5-extra-high"), "GPT-5.5 Extra High");
  assert.equal(prettyCursorModelName("composer-2-fast"), "Composer 2 Fast");
});

test("resolveCursorModelName prefers explicit display name when non-empty", () => {
  assert.equal(resolveCursorModelName("gpt-5.5-high", "GPT 5.5 High"), "GPT 5.5 High");
  assert.equal(resolveCursorModelName("gpt-5.5-high", ""), "GPT-5.5 High");
  assert.equal(resolveCursorModelName("gpt-5.5-high", undefined), "GPT-5.5 High");
});
