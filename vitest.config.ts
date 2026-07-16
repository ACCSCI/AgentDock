/**
 * Vitest configuration — three test layers defined inline.
 *
 * Vitest 4 prefers inline `test.projects` over a separate workspace file.
 * Each project gets its own include path, environment, and timeout.
 *
 * Unit: module-level behavior tests.
 * Integration: in-process HTTP and lifecycle boundaries.
 * Acceptance: current single-instance architecture invariants.
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
            "electron/**/__tests__/**/*.test.ts",
            "test-utils/**/*.test.ts",
          ],
          exclude: [
            "scripts/acceptance/**",
            "e2e/**",
            "plugins/__tests__/api-deletion-e2e.test.ts",
          ],
          environment: "node",
          // 5000ms (vitest default) is too tight for git-worktree tests.
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
          include: ["plugins/__tests__/api-deletion-e2e.test.ts"],
          exclude: ["scripts/acceptance/**", "e2e/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "acceptance",
          include: [
            "scripts/acceptance/phase0-foundation.test.ts",
            "scripts/acceptance/single-instance.test.ts",
          ],
          exclude: ["e2e/**"],
          environment: "node",
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
        // Isolate process-level IPC mocks between acceptance files.
        pool: "forks",
        poolOptions: {
          forks: { singleFork: false },
        },
      },
    ],
  },
});
