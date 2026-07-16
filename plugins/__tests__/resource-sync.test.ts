import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// @ts-nocheck
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceDefinition } from "../config.js";
import { SyncError, createResourceSyncService } from "../resource-sync.js";

let projectDir: string;
let worktreeDir: string;
const service = createResourceSyncService();

beforeEach(() => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  projectDir = path.join(os.tmpdir(), `ad-sync-project-${id}`);
  worktreeDir = path.join(os.tmpdir(), `ad-sync-worktree-${id}`);
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(worktreeDir, { recursive: true });
});

afterEach(() => {
  for (const dir of [projectDir, worktreeDir]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function makeResource(
  source: string,
  strategy: ResourceDefinition["strategy"] = "overwrite",
  skipIfMissing = true,
): ResourceDefinition {
  return { source, strategy, skipIfMissing };
}

// ============================================================
// B1–B8: 单文件同步 — syncOne
// ============================================================
describe("单文件同步 syncOne", () => {
  it("B1: 同步单个文件到空 worktree (overwrite)", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=1\n");
  });

  it("B2: overwrite 策略覆盖已有文件", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=new\n");
    writeFileSync(path.join(worktreeDir, ".env"), "A=old\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=new\n");
  });

  it("B3: skip 策略跳过已有文件", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=new\n");
    writeFileSync(path.join(worktreeDir, ".env"), "A=old\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env", "skip"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=old\n");
  });

  it("B4: skip 策略复制不存在的文件", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env", "skip"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=1\n");
  });

  it("B5: merge 策略合并 .env 文件 — source 覆盖同名 key, target 独有 key 保留", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\nB=2\n");
    writeFileSync(path.join(worktreeDir, ".env"), "B=old\nC=3\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env", "merge"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("merged");
    const merged = readFileSync(path.join(worktreeDir, ".env"), "utf-8");
    expect(merged).toContain("A=1");
    expect(merged).toContain("B=2");
    expect(merged).toContain("C=3");
    expect(merged).not.toContain("B=old");
  });

  it("B6: merge 策略对目标不存在的文件等同于复制", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    const result = await service.syncOne(projectDir, worktreeDir, makeResource(".env", "merge"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=1\n");
  });

  it("B7: skipIfMissing=true 时源文件不存在跳过", async () => {
    // projectDir has no dev.db
    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("dev.db", "overwrite", true),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("missing-skipped");
    expect(existsSync(path.join(worktreeDir, "dev.db"))).toBe(false);
  });

  it("B8: skipIfMissing=false 时源文件不存在返回失败", async () => {
    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("dev.db", "overwrite", false),
    );
    expect(result.success).toBe(false);
    expect(result.action).toBe("missing-skipped");
    expect(result.error).toContain("not found");
  });
});

// ============================================================
// B9–B14: 目录同步 — syncOne
// ============================================================
describe("目录同步 syncOne", () => {
  function createProjectDir() {
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "a.txt"), "file-a");
    writeFileSync(path.join(uploadsDir, "b.txt"), "file-b");
    return uploadsDir;
  }

  it("B9: 同步整个目录到空 worktree", async () => {
    createProjectDir();
    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("uploads/", "overwrite"),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, "uploads", "a.txt"), "utf-8")).toBe("file-a");
    expect(readFileSync(path.join(worktreeDir, "uploads", "b.txt"), "utf-8")).toBe("file-b");
  });

  it("B10: 目录 merge 策略不删除目标已有文件", async () => {
    // Project: uploads/a.txt (new content)
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "a.txt"), "new-a");

    // Worktree: uploads/a.txt (old) + uploads/c.txt
    const wtUploads = path.join(worktreeDir, "uploads");
    mkdirSync(wtUploads, { recursive: true });
    writeFileSync(path.join(wtUploads, "a.txt"), "old-a");
    writeFileSync(path.join(wtUploads, "c.txt"), "file-c");

    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("uploads/", "merge"),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("merged");
    expect(readFileSync(path.join(wtUploads, "a.txt"), "utf-8")).toBe("new-a");
    expect(readFileSync(path.join(wtUploads, "c.txt"), "utf-8")).toBe("file-c");
  });

  it("B11: 目录 overwrite 策略替换整个目录", async () => {
    // Project: uploads/a.txt
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "a.txt"), "file-a");

    // Worktree: uploads/old.txt
    const wtUploads = path.join(worktreeDir, "uploads");
    mkdirSync(wtUploads, { recursive: true });
    writeFileSync(path.join(wtUploads, "old.txt"), "old");

    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("uploads/", "overwrite"),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    const files = readdirSync(wtUploads);
    expect(files).toContain("a.txt");
    expect(files).not.toContain("old.txt");
  });

  it("B12: 目录 skip 策略跳过已存在目录", async () => {
    // Project: uploads/a.txt
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "a.txt"), "new");

    // Worktree: uploads/old.txt
    const wtUploads = path.join(worktreeDir, "uploads");
    mkdirSync(wtUploads, { recursive: true });
    writeFileSync(path.join(wtUploads, "old.txt"), "old");

    const result = await service.syncOne(projectDir, worktreeDir, makeResource("uploads/", "skip"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("skipped");
    // worktree unchanged
    expect(readFileSync(path.join(wtUploads, "old.txt"), "utf-8")).toBe("old");
    expect(existsSync(path.join(wtUploads, "a.txt"))).toBe(false);
  });

  it("B13: skipIfMissing=true 时源目录不存在跳过", async () => {
    // projectDir has no uploads/
    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("uploads/", "overwrite", true),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("missing-skipped");
  });

  it("B14: 空目录同步", async () => {
    mkdirSync(path.join(projectDir, "uploads"), { recursive: true });
    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("uploads/", "overwrite"),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(existsSync(path.join(worktreeDir, "uploads"))).toBe(true);
    expect(readdirSync(path.join(worktreeDir, "uploads"))).toEqual([]);
  });

  it("B14b: skip 策略同步目录到空 worktree — 目标不存在时复制目录", async () => {
    // Project has a directory, worktree has nothing
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "a.txt"), "file-a");
    writeFileSync(path.join(uploadsDir, "b.txt"), "file-b");

    const result = await service.syncOne(projectDir, worktreeDir, makeResource("uploads/", "skip"));
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    // Directory should have been copied
    expect(existsSync(path.join(worktreeDir, "uploads", "a.txt"))).toBe(true);
    expect(existsSync(path.join(worktreeDir, "uploads", "b.txt"))).toBe(true);
    expect(readFileSync(path.join(worktreeDir, "uploads", "a.txt"), "utf-8")).toBe("file-a");
  });
});

// ============================================================
// B15–B19: syncAll 批量同步
// ============================================================
describe("syncAll 批量同步", () => {
  it("B15: 多资源顺序同步全部成功", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    writeFileSync(path.join(projectDir, "dev.db"), "db-content");
    const uploadsDir = path.join(projectDir, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(path.join(uploadsDir, "img.png"), "png");

    const report = await service.syncAll(projectDir, worktreeDir, [
      makeResource(".env", "overwrite"),
      makeResource("dev.db", "overwrite"),
      makeResource("uploads/", "merge"),
    ]);

    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(3);
    expect(report.results.every((r) => r.success)).toBe(true);
    expect(report.duration).toBeGreaterThanOrEqual(0);
  });

  it("B16: 部分资源缺失但 skipIfMissing 仍返回 success", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    // dev.db does not exist

    const report = await service.syncAll(projectDir, worktreeDir, [
      makeResource(".env", "overwrite", true),
      makeResource("dev.db", "overwrite", true),
    ]);

    expect(report.success).toBe(true);
    expect(report.results).toHaveLength(2);
    expect(report.results[0].action).toBe("copied");
    expect(report.results[1].action).toBe("missing-skipped");
  });

  it("B17: skipIfMissing=false 的资源缺失导致抛出 SyncError", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    // dev.db does not exist, skipIfMissing=false

    await expect(
      service.syncAll(projectDir, worktreeDir, [
        makeResource(".env", "overwrite", true),
        makeResource("dev.db", "overwrite", false),
      ]),
    ).rejects.toThrow(SyncError);

    // .env should still have been synced before the error
    expect(readFileSync(path.join(worktreeDir, ".env"), "utf-8")).toBe("A=1\n");
  });

  it("B18: 空资源列表返回空报告", async () => {
    const report = await service.syncAll(projectDir, worktreeDir, []);
    expect(report.success).toBe(true);
    expect(report.results).toEqual([]);
  });

  it("B19: 同步记录耗时", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    const report = await service.syncAll(projectDir, worktreeDir, [makeResource(".env")]);
    expect(report.duration).toBeGreaterThanOrEqual(0);
    expect(typeof report.duration).toBe("number");
  });
});

// ============================================================
// B20–B23: 边界情况
// ============================================================
describe("边界情况", () => {
  it("B20: worktree 路径不存在时抛错", async () => {
    writeFileSync(path.join(projectDir, ".env"), "A=1\n");
    const badWorktree = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    // Don't create the directory
    await expect(service.syncOne(projectDir, badWorktree, makeResource(".env"))).rejects.toThrow();
  });

  it("B21: project 路径不存在时 — 源文件 missing, skipIfMissing=true", async () => {
    const badProject = path.join(os.tmpdir(), `nonexistent-${Date.now()}`);
    const result = await service.syncOne(
      badProject,
      worktreeDir,
      makeResource(".env", "overwrite", true),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("missing-skipped");
  });

  it("B22: source 路径含特殊字符", async () => {
    const subDir = path.join(projectDir, "my files");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(path.join(subDir, "config.json"), '{"ok":true}');

    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("my files/config.json", "overwrite"),
    );
    expect(result.success).toBe(true);
    expect(result.action).toBe("copied");
    expect(readFileSync(path.join(worktreeDir, "my files", "config.json"), "utf-8")).toBe(
      '{"ok":true}',
    );
  });

  it("B23: 嵌套目录同步", async () => {
    const nested = path.join(projectDir, "src", "components", "ui");
    mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, "Button.tsx"), "<Button/>");
    writeFileSync(path.join(nested, "Input.tsx"), "<Input/>");

    const result = await service.syncOne(
      projectDir,
      worktreeDir,
      makeResource("src/", "overwrite"),
    );
    expect(result.success).toBe(true);
    expect(
      readFileSync(path.join(worktreeDir, "src", "components", "ui", "Button.tsx"), "utf-8"),
    ).toBe("<Button/>");
  });
});
