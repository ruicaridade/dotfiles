import type { RetryHint } from "./cursor-session.ts";

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 4_000;

export function computeRetryDelayMs(attempt: number): number {
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
}

export interface RetryBudget {
  maxAttempts: number;
  /** When true, drop the cached checkpoint before retrying (start fresh). */
  freshState: boolean;
}

export function retryBudget(hint: RetryHint): RetryBudget {
  switch (hint) {
    case "timeout":
      return { maxAttempts: 5, freshState: false };
    case "resource_exhausted":
      return { maxAttempts: 10, freshState: false };
    case "blob_not_found":
      return { maxAttempts: 1, freshState: true };
  }
}
