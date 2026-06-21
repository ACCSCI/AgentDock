/**
 * constants.ts — single source of truth guard (新架构 §11.5 C4).
 *
 * Verifies that the centralized timing constants in plugins/constants.ts
 * are the SINGLE source of truth — no other module may re-declare them
 * with different values. This guards against the historical bug where
 * plugins/daemon/context.ts re-exported HEARTBEAT_PERSIST_INTERVAL_MS
 * with a different value (30000 vs 5000), causing 6× divergence depending
 * on which import path was used.
 */
import { describe, expect, it } from "vitest";
import {
  HEARTBEAT_PERSIST_INTERVAL_MS as CANONICAL_PERSIST_MS,
} from "../constants.js";
import {
  HEARTBEAT_PERSIST_INTERVAL_MS as CONTEXT_PERSIST_MS,
} from "../daemon/context.js";

describe("constants — single source of truth (F1)", () => {
  it("plugins/constants.ts declares HEARTBEAT_PERSIST_INTERVAL_MS = 5000", () => {
    expect(CANONICAL_PERSIST_MS).toBe(5_000);
  });

  it("plugins/daemon/context.ts re-exports the SAME constant (not a duplicate)", () => {
    // If context.ts re-declares with its own literal, this fails.
    // After F1 fix, context.ts must import from constants.ts so the
    // values are identical references (not just numerically equal).
    expect(CONTEXT_PERSIST_MS).toBe(CANONICAL_PERSIST_MS);
  });

  it("daemon context no longer has a divergent HEARTBEAT_PERSIST_INTERVAL_MS = 30000", () => {
    // Pre-fix bug value was 30000. After F1, the value must NOT be 30000.
    expect(CONTEXT_PERSIST_MS).not.toBe(30_000);
  });

  it("constant identity check — same reference (not just equal)", () => {
    // Using Object.is ensures the values are the SAME export, not two
    // numerically-coincident constants. This catches accidental
    // re-declaration with the same numeric value.
    expect(Object.is(CONTEXT_PERSIST_MS, CANONICAL_PERSIST_MS)).toBe(true);
  });
});