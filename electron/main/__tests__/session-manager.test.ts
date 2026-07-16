// @ts-nocheck
import { beforeEach, describe, expect, it, vi } from "vitest";

let portsAvailable = true;

vi.mock("../../../plugins/port-allocator.js", () => ({
  isPortAvailable: vi.fn(async () => portsAvailable),
}));

import { PortPoolExhaustedError, createPortPool } from "../port-pool.js";
import { createSessionManager } from "../session-manager.js";

const portKeys = ["FRONTEND_PORT", "BACKEND_PORT", "WS_PORT", "DEBUG_PORT", "PREVIEW_PORT"];

describe("SessionManager persisted-state invariants", () => {
  beforeEach(() => {
    portsAvailable = true;
  });

  it("restores persisted ports before allocating a new session", async () => {
    const pool = createPortPool({ start: 30000, end: 30009 });
    const manager = createSessionManager(pool);

    manager.restoreSession({
      sessionId: "persisted",
      projectPath: "C:/project",
      displayName: "Persisted",
      ports: {
        FRONTEND_PORT: 30000,
        BACKEND_PORT: 30001,
        WS_PORT: 30002,
        DEBUG_PORT: 30003,
        PREVIEW_PORT: 30004,
      },
      status: "active",
      createdAt: 1,
    });

    const fresh = await manager.createSession({
      sessionId: "fresh",
      projectPath: "C:/project",
      displayName: "Fresh",
      portKeys,
    });

    expect(Object.values(fresh)).toEqual([30005, 30006, 30007, 30008, 30009]);
    expect(pool.getAllocatedPorts()).toEqual(
      new Set([30000, 30001, 30002, 30003, 30004, 30005, 30006, 30007, 30008, 30009]),
    );
  });

  it("keeps the old ownership when reassign cannot allocate replacements", async () => {
    const pool = createPortPool({ start: 31000, end: 31004 });
    const manager = createSessionManager(pool);
    const oldPorts = await manager.createSession({
      sessionId: "session",
      projectPath: "C:/project",
      displayName: "Session",
      portKeys,
    });

    portsAvailable = false;
    await expect(manager.reassignPorts("session")).rejects.toBeInstanceOf(PortPoolExhaustedError);

    expect(manager.getSession("session")?.ports).toEqual(oldPorts);
    expect(pool.getAllocatedPorts()).toEqual(new Set(Object.values(oldPorts)));
  });

  it("can atomically restore the previous mapping after persistence fails", async () => {
    const pool = createPortPool({ start: 32000, end: 32009 });
    const manager = createSessionManager(pool);
    const oldPorts = await manager.createSession({
      sessionId: "session",
      projectPath: "C:/project",
      displayName: "Session",
      portKeys,
    });

    const newPorts = await manager.reassignPorts("session");
    manager.restorePorts("session", oldPorts);

    expect(manager.getSession("session")?.ports).toEqual(oldPorts);
    expect(pool.getAllocatedPorts()).toEqual(new Set(Object.values(oldPorts)));
    expect(Object.values(newPorts).some((port) => pool.getAllocatedPorts().has(port))).toBe(false);
  });
});
