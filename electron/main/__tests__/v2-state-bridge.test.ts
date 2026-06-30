// @ts-nocheck
/**
 * v2-state-bridge — serializeForPush tests.
 *
 * Verifies that serializeForPush converts AppliedState into a plain-object
 * format suitable for IPC push to the renderer process.
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
import { serializeForPush } from "../v2-state-bridge.js";

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

describe("serializeForPush", () => {
  it("returns sessions, owners, ports as arrays from Map entries", () => {
    const state = applySnapshot(
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

    const serialized = serializeForPush(state);

    expect(serialized.sessions).toEqual([
      [
        "s1",
        {
          sessionId: "s1",
          projectRoot: "/p",
          displayName: "x",
          status: "active",
          createdAt: 1,
          ports: { FOO: 3000 },
        },
      ],
    ]);
    expect(serialized.owners).toEqual([
      ["s1", { sessionId: "s1", clientId: "c1", pid: 1, fencingToken: 1 }],
    ]);
    expect(serialized.ports).toEqual([
      [3000, { sessionId: "s1", name: "FOO" }],
    ]);
    expect(serialized.snapshotSeq).toBe(100);
    expect(serialized.appliedSeq).toBe(100);
  });

  it("includes snapshotSeq and appliedSeq from state", () => {
    let state = applySnapshot(emptyState(), snap({ snapshotSeq: 50 }));
    state = dispatchEvent(
      state,
      ev("session-created", 51, { sessionId: "s1", displayName: "x" }),
    );

    const serialized = serializeForPush(state);

    expect(serialized.snapshotSeq).toBe(50);
    expect(serialized.appliedSeq).toBe(51);
  });

  it("handles empty state", () => {
    const state = emptyState();
    const serialized = serializeForPush(state);

    expect(serialized.sessions).toEqual([]);
    expect(serialized.owners).toEqual([]);
    expect(serialized.ports).toEqual([]);
    expect(serialized.snapshotSeq).toBeNull();
    expect(serialized.appliedSeq).toBe(0);
  });

  it("reflects events applied after snapshot", () => {
    let state = applySnapshot(
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
    state = dispatchEvent(
      state,
      ev("session-renamed", 101, { sessionId: "s1", newDisplayName: "new" }),
    );

    const serialized = serializeForPush(state);

    // Find s1 in the serialized sessions array
    const s1Entry = serialized.sessions.find(([id]) => id === "s1");
    expect(s1Entry).toBeDefined();
    expect(s1Entry![1].displayName).toBe("new");
  });
});
