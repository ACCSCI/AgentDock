// @ts-nocheck
/**
 * SyncApplier — snapshot+stream ordering tests (新架构 §7.3, §11.3 #8).
 *
 * 验证:
 *  1. 套用 snapshot 后, 任何 seq <= snapshotSeq 的事件被丢弃。
 *  2. seq > snapshotSeq 的事件被正确 apply。
 *  3. 拍快照与到达 SSE 事件并发时, 不会发生回退覆盖 (§11.3 #8 不变式 8)。
 *  4. 各事件类型(创建/重命名/purge/重分配/释放/接管)幂等 — 重复 apply 不破坏 state。
 *  5. 未套过 snapshot 时, 事件直接 apply (等价于 snapshotSeq=0)。
 */
import { describe, expect, it } from "vitest";
import {
  applyAll,
  applySnapshot,
  dispatchEvent,
  emptyState,
  type SseEvent,
  type V2SyncSnapshot,
} from "../sync-applier.js";

function snap(overrides: Partial<V2SyncSnapshot> = {}): V2SyncSnapshot {
  return {
    state: "READY",
    snapshotSeq: 100,
    serverTime: 1_000_000,
    sessions: [],
    owners: [],
    ports: [],
    ...overrides,
  };
}

function ev(event: string, seq: number, data: unknown): SseEvent {
  return { event, seq, data };
}

describe("applySnapshot", () => {
  it("replaces state with snapshot contents", () => {
    const s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000 },
          },
        ],
        owners: [{ sessionId: "s1", clientId: "c1", pid: 1, fencingToken: 1 }],
        ports: [{ port: 3000, sessionId: "s1", name: "FOO" }],
      }),
    );
    expect(s.sessions.size).toBe(1);
    expect(s.owners.size).toBe(1);
    expect(s.ports.size).toBe(1);
    expect(s.snapshotSeq).toBe(100);
    expect(s.appliedSeq).toBe(100);
  });
});

describe("dispatchEvent — 择新规则", () => {
  it("discards events with seq <= snapshotSeq", () => {
    let s = applySnapshot(emptyState(), snap({ snapshotSeq: 100 }));
    s = dispatchEvent(s, ev("port-reassigned", 50, { sessionId: "x" }));
    expect(s.discardedCount).toBe(1);
    expect(s.appliedEventCount).toBe(0);
  });

  it("applies events with seq > snapshotSeq", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: {},
          },
        ],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("port-reassigned", 101, { sessionId: "s1", ports: { FOO: 3000 } }),
    );
    expect(s.appliedEventCount).toBe(1);
    expect(s.discardedCount).toBe(0);
    expect(s.ports.get(3000)?.sessionId).toBe("s1");
  });

  it("applies events without snapshot (snapshotSeq=null)", () => {
    let s = emptyState();
    s = dispatchEvent(
      s,
      ev("session-created", 1, { sessionId: "s1", displayName: "x" }),
    );
    expect(s.appliedEventCount).toBe(1);
    expect(s.sessions.get("s1")?.status).toBe("active");
  });
});

describe("invariant §11.3 #8 — 快照与增量并发不发生回退", () => {
  it("在 snapshotSeq=100 之后, seq=101 的 port-reassigned 不会被 snapshot 的旧值覆盖", () => {
    // 1) 初始 snapshot: s1 占用 FOO=3000
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000 },
          },
        ],
        ports: [{ port: 3000, sessionId: "s1", name: "FOO" }],
        snapshotSeq: 100,
      }),
    );
    // 2) seq=101: 端口重分配到 3001
    s = dispatchEvent(
      s,
      ev("port-reassigned", 101, { sessionId: "s1", oldPort: 3000, newPort: 3001 }),
    );
    // 3) seq=50 (乱序到达, 落后于 snapshot): 应被丢弃
    s = dispatchEvent(
      s,
      ev("port-reassigned", 50, { sessionId: "s1", oldPort: 2999, newPort: 3000 }),
    );
    // 期望: 端口 3001 仍归 s1, 端口 3000 已被 seq=101 释放
    expect(s.ports.get(3001)?.sessionId).toBe("s1");
    expect(s.ports.get(3000)).toBeUndefined();
    expect(s.discardedCount).toBe(1);
    expect(s.appliedEventCount).toBe(1);
  });
});

describe("per-event-type semantics", () => {
  it("session-created 幂等: 重复事件不破坏已有 session", () => {
    let s = emptyState();
    s = dispatchEvent(
      s,
      ev("session-created", 1, { sessionId: "s1", displayName: "first" }),
    );
    s = dispatchEvent(
      s,
      ev("session-created", 2, { sessionId: "s1", displayName: "second" }),
    );
    // 第二次应该是幂等覆盖 displayName, 不丢 session
    expect(s.sessions.get("s1")?.displayName).toBe("second");
  });

  it("session-renamed 覆写 displayName", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "old",
            status: "active",
            createdAt: 1,
            ports: {},
          },
        ],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("session-renamed", 101, { sessionId: "s1", newDisplayName: "new" }),
    );
    expect(s.sessions.get("s1")?.displayName).toBe("new");
  });

  it("session-purged 移除三表", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000, BAR: 3001 },
          },
        ],
        owners: [{ sessionId: "s1", clientId: "c1", pid: 1, fencingToken: 1 }],
        ports: [
          { port: 3000, sessionId: "s1", name: "FOO" },
          { port: 3001, sessionId: "s1", name: "BAR" },
        ],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(s, ev("session-purged", 101, { sessionId: "s1" }));
    expect(s.sessions.has("s1")).toBe(false);
    expect(s.owners.has("s1")).toBe(false);
    expect(s.ports.size).toBe(0);
  });

  it("port-reassigned (整批模式) 清旧 port + 加新 port", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000, BAR: 3001 },
          },
        ],
        ports: [
          { port: 3000, sessionId: "s1", name: "FOO" },
          { port: 3001, sessionId: "s1", name: "BAR" },
        ],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("port-reassigned", 101, {
        sessionId: "s1",
        ports: { FOO: 4000, BAR: 4001 },
      }),
    );
    expect(s.ports.get(3000)).toBeUndefined();
    expect(s.ports.get(3001)).toBeUndefined();
    expect(s.ports.get(4000)?.sessionId).toBe("s1");
    expect(s.ports.get(4001)?.sessionId).toBe("s1");
  });

  it("port-reassigned (单端口模式) 替换", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000 },
          },
        ],
        ports: [{ port: 3000, sessionId: "s1", name: "FOO" }],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("port-reassigned", 101, {
        sessionId: "s1",
        oldPort: 3000,
        newPort: 3002,
      }),
    );
    expect(s.ports.get(3000)).toBeUndefined();
    expect(s.ports.get(3002)?.sessionId).toBe("s1");
    expect(s.sessions.get("s1")?.ports.FOO).toBe(3002);
  });

  it("port-released 单端口归还", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        sessions: [
          {
            sessionId: "s1",
            projectRoot: "/p",
            displayName: "x",
            status: "active",
            createdAt: 1,
            ports: { FOO: 3000 },
          },
        ],
        ports: [{ port: 3000, sessionId: "s1", name: "FOO" }],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("port-released", 101, { sessionId: "s1", port: 3000 }),
    );
    expect(s.ports.get(3000)).toBeUndefined();
    expect(s.sessions.get("s1")?.ports.FOO).toBeUndefined();
  });

  it("ownership-revoked 替换 owner", () => {
    let s = applySnapshot(
      emptyState(),
      snap({
        owners: [
          { sessionId: "s1", clientId: "c1", pid: 1, fencingToken: 5 },
        ],
        snapshotSeq: 100,
      }),
    );
    s = dispatchEvent(
      s,
      ev("ownership-revoked", 101, {
        sessionId: "s1",
        newOwner: "c2",
        fencingToken: 6,
      }),
    );
    expect(s.owners.get("s1")?.clientId).toBe("c2");
    expect(s.owners.get("s1")?.fencingToken).toBe(6);
  });

  it("unknown event 警告但不破坏 state", () => {
    let s = applySnapshot(emptyState(), snap({ snapshotSeq: 100 }));
    s = dispatchEvent(s, ev("totally-fake-event", 101, { x: 1 }));
    expect(s.appliedEventCount).toBe(1); // 计数器+1(计入 applied)
    // 不应抛错
  });
});

describe("applyAll convenience", () => {
  it("applies snapshot first, then events in order", () => {
    const result = applyAll(snap({ snapshotSeq: 50 }), [
      ev("session-created", 51, { sessionId: "s1", displayName: "x" }),
      ev("port-reassigned", 52, { sessionId: "s1", ports: { FOO: 3000 } }),
    ]);
    expect(result.sessions.has("s1")).toBe(true);
    expect(result.ports.get(3000)?.sessionId).toBe("s1");
    expect(result.discardedCount).toBe(0);
    expect(result.appliedEventCount).toBe(2);
  });

  it("discards pre-snapshot events", () => {
    const result = applyAll(snap({ snapshotSeq: 100 }), [
      ev("session-created", 50, { sessionId: "old" }), // 丢弃
      ev("session-created", 101, { sessionId: "new" }), // 应用
    ]);
    expect(result.sessions.has("old")).toBe(false);
    expect(result.sessions.has("new")).toBe(true);
    expect(result.discardedCount).toBe(1);
  });
});
