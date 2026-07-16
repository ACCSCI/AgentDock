import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyCommitPoint } from "../v2-port-service.js";

describe("port commit point", () => {
  let worktreePath: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(path.join(os.tmpdir(), "agentdock-port-commit-"));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it("accepts an .env whose ports match the allocation", async () => {
    await writeFile(path.join(worktreePath, ".env"), "FRONTEND_PORT=30001\nBACKEND_PORT=30002\n");

    expect(() =>
      verifyCommitPoint(worktreePath, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).not.toThrow();
  });

  it("rejects a missing port key", async () => {
    await writeFile(path.join(worktreePath, ".env"), "FRONTEND_PORT=30001\n");

    expect(() =>
      verifyCommitPoint(worktreePath, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).toThrow(/missing port key BACKEND_PORT/);
  });

  it("rejects a stale port value", async () => {
    await writeFile(path.join(worktreePath, ".env"), "FRONTEND_PORT=30000\nBACKEND_PORT=30002\n");

    expect(() =>
      verifyCommitPoint(worktreePath, { FRONTEND_PORT: 30001, BACKEND_PORT: 30002 }),
    ).toThrow(/FRONTEND_PORT=30000/);
  });

  it("rejects a missing .env", () => {
    expect(() => verifyCommitPoint(worktreePath, { FRONTEND_PORT: 30001 })).toThrow(
      /cannot read .*\.env/,
    );
  });

  it("rejects an empty allocation", async () => {
    await writeFile(path.join(worktreePath, ".env"), "OTHER=value\n");
    expect(() => verifyCommitPoint(worktreePath, {})).toThrow(/no claimed ports/);
  });
});
