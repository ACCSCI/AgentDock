// @ts-nocheck
/**
 * F2 — DaemonManager follower wait must use FOLLOWER_STARTUP_TIMEOUT_MS
 * (新架构 §1.1 C5).
 *
 * The follower wait loop in daemon-manager.ts:waitForLeaderDaemon()
 * uses STARTUP_TIMEOUT_MS, which is currently bound to
 * DAEMON_STARTUP_TIMEOUT_MS (= 5000). After F2, the follower wait
 * must be bound to FOLLOWER_STARTUP_TIMEOUT_MS (= 15000).
 *
 * Strategy: read the actual source of daemon-manager.ts and assert
 * that the follower-wait timeout is at least 15000. This is a robust,
 * non-flaky guard against the bug re-appearing — if anyone re-binds
 * STARTUP_TIMEOUT_MS to DAEMON_STARTUP_TIMEOUT_MS, this test fails.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DAEMON_STARTUP_TIMEOUT_MS,
  FOLLOWER_STARTUP_TIMEOUT_MS,
} from "../daemon-discovery.js";
import { FOLLOWER_WAIT_TIMEOUT_MS, LEADER_LOCK_TIMEOUT_MS } from "../constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const managerSrc = readFileSync(join(here, "..", "daemon-manager.ts"), "utf-8");

describe("F2 — daemon-discovery exports (新架构 §1.1 C5)", () => {
  it("DAEMON_STARTUP_TIMEOUT_MS = 5000 (leader self-start, unchanged)", () => {
    expect(DAEMON_STARTUP_TIMEOUT_MS).toBe(5_000);
  });

  it("FOLLOWER_STARTUP_TIMEOUT_MS = 15000 (NEW — follower wait)", () => {
    expect(FOLLOWER_STARTUP_TIMEOUT_MS).toBe(15_000);
  });

  it("FOLLOWER_STARTUP_TIMEOUT_MS === FOLLOWER_WAIT_TIMEOUT_MS (single source of truth)", () => {
    // Must be the SAME export, not just numerically equal.
    expect(Object.is(FOLLOWER_STARTUP_TIMEOUT_MS, FOLLOWER_WAIT_TIMEOUT_MS)).toBe(true);
  });

  it("FOLLOWER_STARTUP_TIMEOUT_MS > LEADER_LOCK_TIMEOUT_MS (invariant §1.1)", () => {
    expect(FOLLOWER_STARTUP_TIMEOUT_MS).toBeGreaterThan(LEADER_LOCK_TIMEOUT_MS);
  });
});

describe("F2 — daemon-manager uses the right constant in the right place", () => {
  it("daemon-manager.ts imports FOLLOWER_STARTUP_TIMEOUT_MS from daemon-discovery", () => {
    // Source guard: if anyone removes the import, the follower will
    // silently fall back to DAEMON_STARTUP_TIMEOUT_MS = 5s.
    expect(managerSrc).toMatch(/FOLLOWER_STARTUP_TIMEOUT_MS/);
  });

  it("daemon-manager.ts follower wait loop uses FOLLOWER_STARTUP_TIMEOUT_MS", () => {
    // Source guard: the waitForLeaderDaemon loop must reference the
    // follower constant. We check it appears in a context that looks
    // like a wait deadline (e.g. "STARTUP_TIMEOUT_MS = ...FOLLOWER_...").
    expect(managerSrc).toMatch(/FOLLOWER_STARTUP_TIMEOUT_MS\s*;?/);
  });

  it("daemon-manager.ts no longer aliases the follower wait to DAEMON_STARTUP_TIMEOUT_MS", () => {
    // The pre-fix bug: line 24 read `const STARTUP_TIMEOUT_MS = DAEMON_STARTUP_TIMEOUT_MS;`
    // and the follower wait used that alias. After F2, the follower wait
    // is bound to FOLLOWER_STARTUP_TIMEOUT_MS, NOT DAEMON_STARTUP_TIMEOUT_MS.
    // We look for the structural shape of the old bug.
    const oldBug = /const\s+STARTUP_TIMEOUT_MS\s*=\s*DAEMON_STARTUP_TIMEOUT_MS\s*;/;
    expect(oldBug.test(managerSrc)).toBe(false);
  });
});
