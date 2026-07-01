// @ts-nocheck
/**
 * F9: isSessionAbandoned §6.1 race window guard
 *
 * 新架构 §4.4 / §6.1 — when `ownerLastHeartbeat === null`, conservatively
 * return false. During lease renewal there is a transient race window where
 * the owner's heartbeat may be cleared (e.g. just before re-registration);
 * returning true here could allow a rival owner to take over an actively
 * being-deleted session.
 */
import { describe, expect, it } from "vitest";
import { DaemonStateV2 } from "../daemon-state-v2.js";

const HEARTBEAT_TIMEOUT = 90_000;

describe("DaemonStateV2 — isSessionAbandoned F9 race window guard", () => {
  function makeSession(leaseExpiresAt: number): DaemonStateV2 {
    const s = new DaemonStateV2();
    s.createSession({
      sessionId: "u1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "A",
      pid: 1,
      leaseExpiresAt,
    });
    return s;
  }

  it("RED: heartbeat=null + lease expired → false (new F9 behavior, no takeover)", () => {
    const now = 1_000_000;
    const s = makeSession(now - 1_000); // lease already expired
    expect(s.isSessionAbandoned("u1", now, HEARTBEAT_TIMEOUT, null)).toBe(false);
  });

  it("heartbeat=null + lease valid → false (no regression)", () => {
    const now = 1_000_000;
    const s = makeSession(now + 15_000); // lease still valid
    expect(s.isSessionAbandoned("u1", now, HEARTBEAT_TIMEOUT, null)).toBe(false);
  });

  it("heartbeat timed out + lease expired → true (normal abandoned path)", () => {
    const now = 1_000_000;
    const s = makeSession(now - 1_000); // lease already expired
    // last heartbeat long ago → owner gone AND lease dead → abandoned
    expect(
      s.isSessionAbandoned("u1", now, HEARTBEAT_TIMEOUT, now - 200_000),
    ).toBe(true);
  });

  it("heartbeat timed out + lease valid → false (lease still keeping it alive)", () => {
    const now = 1_000_000;
    const s = makeSession(now + 15_000); // lease still valid
    expect(
      s.isSessionAbandoned("u1", now, HEARTBEAT_TIMEOUT, now - 200_000),
    ).toBe(false);
  });
});