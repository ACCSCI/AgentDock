/**
 * Vitest configuration — three test layers defined inline.
 *
 * Vitest 4 prefers inline `test.projects` over a separate workspace file.
 * Each project gets its own include path, environment, and timeout.
 *
 * Unit: existing module tests. Fast (<1s). No I/O.
 * Integration: in-process testing of Hono app + IPC handlers (Phase 1+).
 * Acceptance: phase-gate scripts that spawn real daemon / Electron (Phase 0+).
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "plugins/__tests__/**/*.test.ts",
            "src/lib/__tests__/**/*.test.ts",
            "src/hooks/__tests__/**/*.test.ts",
            "plugins/daemon/__tests__/**/*.test.ts",
            "plugins/daemon/**/__tests__/**/*.test.ts",
            "electron/**/__tests__/**/*.test.ts",
            "test-utils/**/*.test.ts",
          ],
          exclude: [
            "plugins/daemon/__tests__/integration.test.ts",
            "scripts/acceptance/**",
            "e2e/**",
          ],
          environment: "node",
          // 5000ms (vitest default) is too tight for spawn-heavy tests
          // (real daemon HTTP server + git worktree) under full-suite load.
          // 30s matches what these tests need; faster tests still complete
          // in <1s anyway. Resolves the 1-4 flaky unit timeouts seen across
          // rounds 1-11 when the full vitest suite runs in sequence.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "plugins/daemon/__tests__/integration.test.ts",
            "electron/ipc/__tests__/**/*.test.ts",
            "src/lib/__tests__/queries-sse.test.ts",
            "src/lib/__tests__/terminal-cache.test.ts",
          ],
          exclude: ["scripts/acceptance/**", "e2e/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "acceptance",
          include: ["scripts/acceptance/**/*.test.ts"],
          exclude: ["e2e/**"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
        // Each acceptance test may spawn a daemon; isolate via separate workers.
        // (Vitest 4: pool options moved to top level, not nested in test.)
        pool: "forks",
        poolOptions: {
          forks: { singleFork: false },
        },
      },
    ],
  },
});