/**
 * Pipeline configuration types — single source of truth for the shape of
 * `e2e/pipeline.yaml`. Imported by:
 *   - `e2e/runner.ts`  → reads YAML, casts to `PipelineConfig`
 *   - debugging tools  → consult classifier/notification settings
 *
 * Why a typed schema rather than `any`:
 *   - Typos in YAML surface at parse time (TS error), not at test time.
 *   - When the pipeline gains a new field (e.g. per-spec reporter override),
 *     every consumer that needs to read it is flagged by the compiler.
 *
 * Validation strategy:
 *   - This file defines the *shape*, not the runtime guard. The runner
 *     does shallow validation of required fields and throws a helpful
 *     error pointing at the offending key. For exhaustive validation,
 *     swap in `zod` or `valibot` and reuse this file as the source.
 */
export interface PipelineConfig {
  /** Schema version — bump when a breaking change lands. */
  version: string;
  project: {
    type: "electron";
    /** Path to the main process entry — relative to repo root. */
    entry: string;
  };
  pipeline: {
    /** Defaults applied when a spec doesn't override. */
    global: {
      parallel: number;
      /** Per-test timeout in ms. */
      timeout: number;
      retries: number;
    };
    /**
     * Per-spec overrides. `pattern` is a glob matched against the file path
     * relative to `testDir`. `mode` controls whether the Electron app
     * is launched fresh per test (`isolate`) or reused across tests
     * within a worker (`reuse`).
     */
    specs: Array<{
      pattern: string;
      mode: "isolate" | "reuse";
      parallel: number;
      /** Free-form tags, e.g. `@smoke`, `@slow` — matchable with `--grep`. */
      tags?: string[];
    }>;
    default: {
      mode: "isolate" | "reuse";
      parallel: number;
    };
  };
  monitoring: {
    screenshots: "always" | "on-failure" | "never";
    traces: "always" | "retain-on-failure" | "never";
    logs: "always" | "on-failure" | "never";
    domSnapshot: "always" | "on-failure" | "never";
  };
  debugging: {
    classifier: {
      enabled: boolean;
      rules: Array<{
        type: "flaky" | "environment" | "real-bug";
        /** RegExp source — runner compiles to RegExp. */
        pattern?: string;
        action: "retry" | "skip" | "report";
      }>;
    };
    fixSuggester: {
      enabled: boolean;
      maxSuggestions: number;
    };
    notifications: {
      onTestComplete: boolean;
      onPipelineComplete: boolean;
      /** `file` writes JSON to e2e/notifications/, `webhook` POSTs, `claude-code` is reserved. */
      channel: "claude-code" | "webhook" | "file";
    };
  };
}
