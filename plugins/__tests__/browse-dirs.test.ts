import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import os from "node:os";

function json(res: ServerResponse, status: number, data: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

let server: ReturnType<typeof createServer>;
let baseUrl: string;
let tmpDir: string;

function startTestServer(port: number): Promise<void> {
  return new Promise((resolve) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);
      const pathname = url.pathname;
      const method = req.method || "GET";

      // GET /api/browse-dirs — inlined handler for test isolation
      if (pathname === "/api/browse-dirs" && method === "GET") {
        const targetPath = url.searchParams.get("path");
        try {
          const fs = await import("node:fs/promises");
          const nodePath = await import("node:path");
          if (!targetPath) {
            const roots: Array<{ name: string; path: string }> = [];
            if (process.platform === "win32") {
              for (const letter of "CDEFGHIJKLMNOPQRSTUVWXYZ") {
                const drive = `${letter}:\\`;
                try { await fs.access(drive); roots.push({ name: drive, path: drive }); } catch {}
              }
            } else {
              roots.push({ name: "/", path: "/" });
            }
            const home = process.env.HOME || process.env.USERPROFILE || "";
            if (home) {
              try { await fs.access(home); roots.push({ name: "~ (Home)", path: home }); } catch {}
            }
            json(res, 200, { entries: roots });
            return;
          }
          const resolved = nodePath.resolve(targetPath);
          try {
            const stat = await fs.stat(resolved);
            if (!stat.isDirectory()) { json(res, 400, { error: "Path is not an existing directory" }); return; }
          } catch {
            json(res, 400, { error: "Path is not an existing directory" }); return;
          }
          const entries: Array<{ name: string; path: string }> = [];
          const parent = nodePath.dirname(resolved);
          if (parent !== resolved) {
            entries.push({ name: ".. (上级目录)", path: parent });
          }
          const items = await fs.readdir(resolved, { withFileTypes: true });
          for (const item of items) {
            if (item.isDirectory() && !item.name.startsWith(".")) {
              entries.push({ name: item.name, path: nodePath.join(resolved, item.name) });
            }
          }
          json(res, 200, { entries, currentPath: resolved });
        } catch (err) {
          json(res, 500, { error: err instanceof Error ? err.message : "Unknown error" });
        }
        return;
      }
    });
    server.listen(port, resolve);
  });
}

beforeEach(async () => {
  tmpDir = path.join(os.tmpdir(), `ad-browse-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  // Create test directory structure
  mkdirSync(path.join(tmpDir, "projects", "web"), { recursive: true });
  mkdirSync(path.join(tmpDir, "archive", "web"), { recursive: true });
  writeFileSync(path.join(tmpDir, "projects", "web", "index.html"), "");
  writeFileSync(path.join(tmpDir, "archive", "web", "index.html"), "");
  const port = 19000 + Math.floor(Math.random() * 1000);
  await startTestServer(port);
  baseUrl = `http://localhost:${port}`;
});

afterEach(() => {
  server?.close();
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

describe("GET /api/browse-dirs", () => {
  it("returns root entries when no path given", async () => {
    const res = await fetch(`${baseUrl}/api/browse-dirs`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
    // Should not include A: or B: drives on Windows
    if (process.platform === "win32") {
      const names = data.entries.map((e: { name: string }) => e.name);
      expect(names).not.toContain("A:\\");
      expect(names).not.toContain("B:\\");
    }
  });

  it("lists subdirectories of a given path", async () => {
    const target = path.join(tmpDir, "projects");
    const res = await fetch(`${baseUrl}/api/browse-dirs?path=${encodeURIComponent(target)}`);
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(data.currentPath).toBe(target);
    const names = data.entries.map((e: { name: string }) => e.name);
    expect(names).toContain("web");
    expect(names).toContain(".. (上级目录)");
  });

  it("returns error for non-existent path", async () => {
    const res = await fetch(`${baseUrl}/api/browse-dirs?path=${encodeURIComponent("/nonexistent")}`);
    const data = await res.json();
    expect(res.status).toBe(400);
    expect(data.error).toContain("not an existing directory");
  });

  it("returns error for file (not directory)", async () => {
    const filePath = path.join(tmpDir, "projects", "web", "index.html");
    const res = await fetch(`${baseUrl}/api/browse-dirs?path=${encodeURIComponent(filePath)}`);
    expect(res.status).toBe(400);
  });
});
