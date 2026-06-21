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
});
