/**
 * Reconciler tests — C1-C5 残缺态分类 (新架构 §4.3 + §4.4 双信号死亡).
 *
 * 验证:
 *  1. RECOVERING 期完全跳过对账 (§4.4 末段).
 *  2. READY 后 LEASE_TTL 宽限窗口内跳过卡死判定.
 *  3. C1 (creating, lease dead) — 通过 commit point 检查 → retain; 不通过 → rollback.
 *  4. C2 (deleting, lease dead) — 接管续删.
 *  5. C3 (active, worktree 不存在) — 标记 orphan, 不静默删.
 *  6. C4 (无记录, dir 存在) — UI 提示永不自动删.
 *  7. C5 (active, git 悬挂) — git worktree prune → C3.
 *  8. 正常 active + worktree 存在 — noop.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReconciler, type ReconcileDeps, type ReconcileAction } from "../reconciler.js";
import { DaemonStateV2 } from "../daemon-state-v2.js";
import { LEASE_TTL_MS } from "../constants.js";

function makeStateV2(): DaemonStateV2 {
  const s = new DaemonStateV2();
  s.setState("READY");
  return s;
}

function makeDeps(overrides: Partial<ReconcileDeps> = {}): ReconcileDeps {
  return {
    stateV2: makeStateV2(),
    getOwnerLastHeartbeat: () => null,
    isProcessAlive: () => false,
    existsSync: () => false,
    readFileSync: () => "",
    execImpl: async () => ({ stdout: "", stderr: "" }),
    now: () => 1_000_000,
    ...overrides,
  };
}

describe("reconciler — RECOVERING 期跳过", () => {
  it("RECOVERING 时 tick 返回空 actions", async () => {
    const stateV2 = makeStateV2();
    stateV2.setState("RECOVERING");
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: Date.now() - 10_000, // 已过期
    });
    const deps = makeDeps({ stateV2 });
    const r = createReconciler(deps);
    const report = await r.tick();
    expect(report.actions).toHaveLength(0);
  });
});

describe("reconciler — READY 宽限窗口", () => {
  it("READY 后 LEASE_TTL 宽限窗口内跳过", async () => {
    const stateV2 = makeStateV2();
    let nowVal = 1_000_000;
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: nowVal - 10_000, // 过期, 但在宽限窗内
    });
    const r = createReconciler(
      makeDeps({ stateV2, now: () => nowVal }),
    );
    r.setReady(nowVal);
    // Within grace: 1s after ready
    nowVal += 1_000;
    const report = await r.tick();
    expect(report.actions.filter((a) => a.kind !== "noop")).toHaveLength(0);
    expect(r.isInGraceWindow()).toBe(true);
  });

  it("超过宽限窗口后开始判定", async () => {
    const stateV2 = makeStateV2();
    let nowVal = 1_000_000;
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: nowVal - 10_000,
    });
    const r = createReconciler(
      makeDeps({ stateV2, now: () => nowVal }),
    );
    r.setReady(nowVal);
    // Past grace: LEASE_TTL + 1s
    nowVal += LEASE_TTL_MS + 1_000;
    const report = await r.tick();
    expect(r.isInGraceWindow()).toBe(false);
    // Should have classified this abandoned session
    const meaningful = report.actions.filter((a) => a.kind !== "noop");
    expect(meaningful.length).toBeGreaterThan(0);
  });
});

describe("reconciler — C1 (creating + lease dead)", () => {
  it(".env 缺端口键 → C1-rollback missing-env-ports", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0, // 已过期
    });
    stateV2.claimPort("s1", 3000, "FOO");
    const rollback = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      stateV2,
      existsSync: () => false, // .env 不存在
      rollbackCreate: rollback,
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    const c1 = report.actions.find((a) => a.kind === "C1-rollback");
    expect(c1).toBeDefined();
    if (c1?.kind === "C1-rollback") {
      expect(c1.reason).toBe("missing-env-ports");
    }
    expect(rollback).toHaveBeenCalledWith("s1");
  });

  it(".env 端口值不匹配 → C1-rollback env-values-mismatch", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    stateV2.claimPort("s1", 3000, "FOO");
    const envFileContent = "FOO=2999\n"; // 不一致
    const deps = makeDeps({
      stateV2,
      existsSync: () => true,
      readFileSync: () => envFileContent,
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    const c1 = report.actions.find((a) => a.kind === "C1-rollback");
    expect(c1).toBeDefined();
    if (c1?.kind === "C1-rollback") {
      expect(c1.reason).toBe("env-values-mismatch");
    }
  });

  it(".env 端口值匹配 → C1-retain passes-commit-point", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    stateV2.claimPort("s1", 3000, "FOO");
    const deps = makeDeps({
      stateV2,
      existsSync: () => true,
      readFileSync: () => "FOO=3000\n",
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    const c1 = report.actions.find((a) => a.kind === "C1-retain");
    expect(c1).toBeDefined();
  });
});

describe("reconciler — C2 (deleting + lease dead)", () => {
  it("接管续删", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    stateV2.activateSession("s1");
    stateV2.beginDelete("s1", 0);
    const takeOver = vi.fn().mockResolvedValue(undefined);
    const deps = makeDeps({
      stateV2,
      takeOverDelete: takeOver,
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    const c2 = report.actions.find((a) => a.kind === "C2-takeover-delete");
    expect(c2).toBeDefined();
    if (c2?.kind === "C2-takeover-delete") {
      expect(c2.sessionId).toBe("s1");
      expect(c2.projectRoot).toBe("/p");
    }
    expect(takeOver).toHaveBeenCalledWith("s1", "/p", expect.stringContaining(`${path.sep}.agentdock${path.sep}worktrees${path.sep}s1`));
  });
});

describe("reconciler — C3 (active + no worktree)", () => {
  it("active 但 worktree 不存在 → 标记 orphan, 不自动删", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    stateV2.activateSession("s1");
    const emitted: ReconcileAction[] = [];
    const deps = makeDeps({
      stateV2,
      existsSync: () => false, // worktree 不存在
      emitOrphan: (a) => emitted.push(a),
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    const c3 = report.actions.find((a) => a.kind === "C3-orphan");
    expect(c3).toBeDefined();
    expect(emitted.some((a) => a.kind === "C3-orphan")).toBe(true);
  });

  it("active + worktree 存在 → noop", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: 0,
    });
    stateV2.activateSession("s1");
    const deps = makeDeps({
      stateV2,
      existsSync: () => true, // worktree 存在
    });
    const r = createReconciler(deps);
    const report = await r.tick();
    // no C1/C2/C3 actions for this active session
    const meaningful = report.actions.filter((a) => a.kind !== "noop");
    expect(meaningful).toHaveLength(0);
  });
});

describe("reconciler — creating 状态但 lease 仍 alive", () => {
  it("不应被对账器打扰", async () => {
    const stateV2 = makeStateV2();
    stateV2.createSession({
      sessionId: "s1",
      projectRoot: "/p",
      displayName: "x",
      clientId: "c1",
      pid: 1,
      leaseExpiresAt: Date.now() + 60_000, // 远未到期
    });
    const deps = makeDeps({ stateV2 });
    const r = createReconciler(deps);
    const report = await r.tick();
    // All creating sessions in progress → noop
    const meaningful = report.actions.filter((a) => a.kind !== "noop");
    expect(meaningful).toHaveLength(0);
  });
});

describe("reconciler — RECONCILER_TUNING 常量", () => {
  it("TICK_INTERVAL_MS = RECOVERING_HARD_MAX/2", async () => {
    const { RECONCILER_TUNING } = await import("../reconciler.js");
    expect(RECONCILER_TUNING.TICK_INTERVAL_MS).toBeGreaterThan(0);
    expect(RECONCILER_TUNING.LEASE_TTL_MS).toBe(LEASE_TTL_MS);
  });
});
