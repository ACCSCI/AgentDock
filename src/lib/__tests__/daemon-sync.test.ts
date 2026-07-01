// @ts-nocheck
/**
 * Renderer-side daemon-sync tests (新架构 §7.3, §11.3 #8).
 *
 * Mirrors the main-side SyncApplier tests. Both implementations must
 * produce the same behavior on the same inputs — see also
 * electron/main/__tests__/sync-applier.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  applySnapshot,
  dispatchEvent,
  emptyState,
  type SseEvent,
  type V2SyncSnapshot,
} from "../daemon-sync";

function snap(o: Partial<V2SyncSnapshot> = {}): V2SyncSnapshot {
  return {
    state: "READY",
    snapshotSeq: 100,
    serverTime: 1_000_000,
    sessions: [],
    owners: [],
    ports: [],
    ...o,
  };
}
function ev(event: string, seq: number, data: unknown): SseEvent {
  return { event, seq, data };
}

/** Local mirror of main-side applyAll — applies snapshot then events in order. */
function applyAll(snapshot: V2SyncSnapshot, events: SseEvent[]) {
  let s = applySnapshot(emptyState(), snapshot);
  for (const e of events) s = dispatchEvent(s, e);
  return s;
}

describe("applySnapshot", () => {
  it("replaces state with snapshot", () => {
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
        ports: [{ port: 3000, sessionId: "s1", name: "FOO" }],
      }),
    );
    expect(s.sessions.size).toBe(1);
    expect(s.ports.size).toBe(1);
    expect(s.snapshotSeq).toBe(100);
  });
});

describe("dispatchEvent — 择新", () => {
  it("discards seq <= snapshotSeq", () => {
    let s = applySnapshot(emptyState(), snap({ snapshotSeq: 100 }));
    s = dispatchEvent(s, ev("session-created", 50, { sessionId: "x" }));
    expect(s.discardedCount).toBe(1);
  });
  it("applies seq > snapshotSeq", () => {
    let s = applySnapshot(emptyState(), snap({ snapshotSeq: 100 }));
    s = dispatchEvent(s, ev("session-created", 101, { sessionId: "x" }));
    expect(s.sessions.has("x")).toBe(true);
    expect(s.discardedCount).toBe(0);
  });
  it("applies pre-snapshot events when no snapshot yet", () => {
    let s = emptyState();
    s = dispatchEvent(s, ev("session-created", 1, { sessionId: "x" }));
    expect(s.sessions.has("x")).toBe(true);
  });
});

describe("§11.3 #8 — 快照不回退覆盖更新", () => {
  it("port-reassigned at seq=101 wins over snapshot's port=3000", () => {
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
      ev("port-reassigned", 101, { sessionId: "s1", oldPort: 3000, newPort: 3001 }),
    );
    s = dispatchEvent(
      s,
      ev("port-reassigned", 50, { sessionId: "s1", oldPort: 2999, newPort: 3000 }),
    );
    expect(s.ports.get(3001)?.sessionId).toBe("s1");
    expect(s.ports.get(3000)).toBeUndefined();
    expect(s.discardedCount).toBe(1);
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
