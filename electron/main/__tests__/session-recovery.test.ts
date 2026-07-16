// @ts-nocheck
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../plugins/port-allocator.js", () => ({
  isPortAvailable: vi.fn(async () => true),
}));

import { createPortPool } from "../port-pool.js";
import { createSessionManager } from "../session-manager.js";
import { restorePersistedSessions } from "../session-recovery.js";

describe("restorePersistedSessions", () => {
  it("hydrates all valid worktree sessions before new allocations", async () => {
    const pool = createPortPool({ start: 33000, end: 33009 });
    const manager = createSessionManager(pool);
    const result = restorePersistedSessions(
      [
        {
          id: "persisted",
          projectId: "project",
          name: "Persisted",
          worktreePath: "C:/project/.agentdock/worktrees/persisted",
          ports: JSON.stringify({
            FRONTEND_PORT: 33000,
            BACKEND_PORT: 33001,
            WS_PORT: 33002,
            DEBUG_PORT: 33003,
            PREVIEW_PORT: 33004,
          }),
          status: "active",
          createdAt: new Date(0).toISOString(),
        },
      ],
      [{ id: "project", path: "C:/project" }],
      manager,
      () => true,
    );

    expect(result).toEqual({ restored: 1, skipped: 0, staleCreatingSessionIds: [] });
    expect(manager.getSession("persisted")).not.toBeNull();
    const fresh = await manager.createSession({
      sessionId: "fresh",
      projectPath: "C:/project",
      displayName: "Fresh",
      portKeys: ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"],
    });
    expect(Object.values(fresh)).toEqual([33005, 33006, 33007, 33008, 33009]);
  });

  it("skips corrupt ports and missing worktrees", () => {
    const pool = createPortPool({ start: 34000, end: 34009 });
    const manager = createSessionManager(pool);
    const rows = [
      {
        id: "corrupt",
        projectId: "project",
        name: "Corrupt",
        worktreePath: "missing",
        ports: "not-json",
        createdAt: new Date().toISOString(),
      },
    ];

    expect(
      restorePersistedSessions(rows, [{ id: "project", path: "C:/project" }], manager, () => false),
    ).toEqual({ restored: 0, skipped: 1, staleCreatingSessionIds: [] });
  });

  it("reports interrupted creating sessions without committed ports for cleanup", () => {
    const pool = createPortPool({ start: 35000, end: 35009 });
    const manager = createSessionManager(pool);
    const row = {
      id: "interrupted",
      projectId: "project",
      name: "Interrupted",
      worktreePath: "C:/project/.agentdock/worktrees/interrupted",
      ports: null,
      status: "creating",
      createdAt: new Date().toISOString(),
    };

    expect(
      restorePersistedSessions([row], [{ id: "project", path: "C:/project" }], manager, () => true),
    ).toEqual({ restored: 0, skipped: 1, staleCreatingSessionIds: ["interrupted"] });
    expect(manager.getSession("interrupted")).toBeNull();
  });
});
