/**
 * RECOVERING state machine — 新架构 §5.2 unit tests.
 */
import { describe, expect, it } from "vitest";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import {
  createRecoveringController,
  gateClaimInRecovering,
} from "../recovering-controller.js";

describe("createRecoveringController — early-exit + hard cap", () => {
  it("starts in RECOVERING", () => {
    const s = new DaemonStateV2();
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1", "u2"]),
      now: () => 0,
    });
    expect(c.isRecovering()).toBe(true);
    expect(s.state).toBe("RECOVERING");
  });

  it("early-exits when all expected reports received after soft_min", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1"]),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
    });
    c.recordReport("u1");

    // Before soft_min: still RECOVERING even if all reported
    clock = 50;
    expect(c.tick()).toBe("RECOVERING");

    // After soft_min + all reported → READY
    clock = 150;
    expect(c.tick()).toBe("READY");
    expect(s.state).toBe("READY");
  });

  it("does NOT early-exit before soft_min even with all reports in", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1"]),
      softMinMs: 1000,
      hardMaxMs: 5000,
      now: () => clock,
    });
    c.recordReport("u1");

    clock = 500;
    expect(c.tick()).toBe("RECOVERING");

    clock = 1100;
    expect(c.tick()).toBe("READY");
  });

  it("hard-caps at RECOVERING_HARD_MAX regardless of reports", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1", "u2", "u3"]),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
    });
    // Only 1 of 3 reported, but past hard_max
    c.recordReport("u1");

    clock = 999;
    expect(c.tick()).toBe("RECOVERING");

    clock = 1001;
    expect(c.tick()).toBe("READY");
  });

  it("early-exits immediately after soft_min when no expected (fresh install)", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
    });
    clock = 50;
    expect(c.tick()).toBe("RECOVERING");

    clock = 101;
    expect(c.tick()).toBe("READY");
  });

  it("records only expected reports (stray sessionIds ignored)", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1"]),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
    });
    c.recordReport("u1"); // expected
    c.recordReport("u99"); // not expected — should not count
    c.recordReport("u1"); // duplicate — still 1

    clock = 150;
    expect(c.tick()).toBe("READY");
  });

  it("forceReady bypasses the timer", () => {
    const s = new DaemonStateV2();
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1"]),
      now: () => 0,
    });
    c.forceReady("admin override");
    expect(s.state).toBe("READY");
  });

  it("snapshot reports current state + counters", () => {
    const s = new DaemonStateV2();
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(["u1", "u2"]),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
    });
    c.recordReport("u1");
    clock = 50;
    c.tick();

    const snap = c.snapshot();
    expect(snap.state).toBe("RECOVERING");
    expect(snap.elapsedMs).toBe(50);
    expect(snap.expected).toBe(2);
    expect(snap.reported).toBe(1);
    expect(snap.softMinMs).toBe(100);
    expect(snap.hardMaxMs).toBe(1000);
  });

  it("onTransition callback fires on state change", () => {
    const s = new DaemonStateV2();
    const transitions: Array<{ to: string; reason: string }> = [];
    let clock = 0;
    const c = createRecoveringController(s, {
      expectedSessionIds: new Set(),
      softMinMs: 100,
      hardMaxMs: 1000,
      now: () => clock,
      onTransition: (next, reason) => {
        transitions.push({ to: next, reason });
      },
    });
    clock = 150;
    c.tick();
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toEqual({
      to: "READY",
      reason: expect.stringMatching(/early-exit/),
    });
  });
});

describe("gateClaimInRecovering — recovery claim whitelisting", () => {
  it("allows all claims when READY", () => {
    const s = new DaemonStateV2();
    s.setState("READY");
    const r = gateClaimInRecovering(s, "u1", new Set(), new Set());
    expect(r.allow).toBe(true);
  });

  it("RECOVERING rejects claims for unknown sessionIds", () => {
    const s = new DaemonStateV2();
    s.setState("RECOVERING");
    const r = gateClaimInRecovering(s, "u1", new Set(["u2"]), new Set());
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.code).toBe("RECOVERING");
  });

  it("RECOVERING allows claims for expected sessionIds (recovery re-registration)", () => {
    const s = new DaemonStateV2();
    s.setState("RECOVERING");
    const r = gateClaimInRecovering(s, "u1", new Set(["u1"]), new Set());
    expect(r.allow).toBe(true);
  });

  it("RECOVERING allows claims for sessionIds already reported this window", () => {
    const s = new DaemonStateV2();
    s.setState("RECOVERING");
    const r = gateClaimInRecovering(s, "u1", new Set(), new Set(["u1"]));
    expect(r.allow).toBe(true);
  });

  it("RECOVERING rejects claims for sessionIds NOT in expected set AND not yet reported", () => {
    const s = new DaemonStateV2();
    s.setState("RECOVERING");
    const r = gateClaimInRecovering(s, "u99", new Set(["u1"]), new Set());
    expect(r.allow).toBe(false);
  });
});
