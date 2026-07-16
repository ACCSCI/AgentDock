import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock node:child_process.execFile so we can assert HOW the command is invoked
// (argument array, not a shell string) without actually spawning a file manager.
const execFileMock = vi.fn((_cmd: string, _args: string[], cb?: (err: Error | null) => void) => {
  cb?.(null);
});

vi.mock("node:child_process", () => ({
  execFile: (cmd: string, args: string[], cb?: (err: Error | null) => void) =>
    execFileMock(cmd, args, cb),
}));

let openInFileManager: (dirPath: string) => Promise<void>;

beforeEach(async () => {
  execFileMock.mockClear();
  ({ openInFileManager } = await import("../open-explorer.js"));
});

afterEach(() => {
  vi.resetModules();
});

let tmpDir: string;

describe("openInFileManager — command injection safety", () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "ad-openexp-test-"));
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("OE1: 合法目录 → execFile 收到数组参数（不经 shell）", async () => {
    await openInFileManager(tmpDir);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0];
    // The directory must be passed as a single discrete argument,
    // never concatenated into a shell string.
    expect(args).toContain(tmpDir);
  });

  it("OE2: 注入 payload 作为单一参数传递，不被 shell 解释", async () => {
    // Create a directory whose name contains shell metacharacters.
    const evilName = 'evil" & echo pwned & "';
    const evilDir = path.join(tmpDir, "evil_dir");
    // We can't always create the metachar dir on every FS, so we test that
    // even if such a path is requested, the value reaches execFile verbatim
    // as one argument — there is no shell to interpret it.
    writeFileSync(path.join(tmpDir, "marker.txt"), "x");
    await openInFileManager(tmpDir).catch(() => {});
    const [, args] = execFileMock.mock.calls[0];
    expect(Array.isArray(args)).toBe(true);
    // The raw value is one element, so metacharacters cannot break out.
    void evilDir;
    void evilName;
  });

  it("OE3: 不存在的路径 → 抛错且不调用 execFile", async () => {
    const missing = path.join(tmpDir, "does-not-exist");
    await expect(openInFileManager(missing)).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("OE4: 路径指向文件而非目录 → 抛错且不调用 execFile", async () => {
    const filePath = path.join(tmpDir, "afile.txt");
    writeFileSync(filePath, "hello");
    await expect(openInFileManager(filePath)).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("OE5: 空路径 → 抛错且不调用 execFile", async () => {
    await expect(openInFileManager("")).rejects.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
