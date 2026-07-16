/**
 * Pipeline Runner — orchestrates Playwright runs against `e2e/pipeline.yaml`.
 *
 * Why a custom runner when Playwright already has its own CLI:
 *   - Playwright runs all specs in one mode. AgentDock has two:
 *     `isolate` (one Electron per test) and `reuse` (one Electron shared
 *     across tests in a worker). The runner groups specs by mode and
 *     invokes Playwright separately for each group, so `reuse` tests
 *     boot a single Electron while `isolate` tests each get their own.
 *   - The runner writes machine-readable artifacts to `e2e/notifications/`
 *     and `e2e/reports/`, suitable for AI agents to ingest without parsing
 *     Playwright's stdout. `e2e/run-state.json` is overwritten on every
 *     spec completion for live status.
 *
 * Usage:
 *   bun run e2e:run                     # Run full pipeline
 *   bun run e2e:run -- --tags @smoke    # Filter by tag
 *   bun run e2e:run -- --group isolate  # Run one mode group only
 *
 * Exit codes:
 *   0  → all groups passed
 *   1  → one or more specs failed
 *   2  → pipeline config invalid (load failure)
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { PipelineConfig } from "./pipeline-config.schema.js";

const ROOT = process.cwd();
const CONFIG_PATH = join(ROOT, "e2e/pipeline.yaml");
const NOTIFICATIONS_DIR = join(ROOT, "e2e/notifications");
const REPORTS_DIR = join(ROOT, "e2e/reports");
const RUN_STATE_PATH = join(ROOT, "e2e/run-state.json");

interface RunState {
  startedAt: string;
  finishedAt?: string;
  groups: Array<{
    mode: "isolate" | "reuse";
    specs: string[];
    status: "pending" | "running" | "passed" | "failed";
    startedAt?: string;
    finishedAt?: string;
    exitCode?: number;
  }>;
}

function loadConfig(): PipelineConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Pipeline config not found: ${CONFIG_PATH}`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  const parsed = parseYaml(raw) as PipelineConfig;
  if (!parsed || parsed.version !== "1") {
    throw new Error(
      `Unsupported pipeline config version: ${parsed?.version ?? "(missing)"}. Expected "1".`,
    );
  }
  return parsed;
}

interface CliArgs {
  tags: string[];
  group: "isolate" | "reuse" | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { tags: [], group: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tags" && argv[i + 1]) {
      args.tags = argv[i + 1].split(",").map((t) => t.trim());
      i++;
    } else if (arg === "--group" && argv[i + 1]) {
      const g = argv[i + 1] as "isolate" | "reuse";
      if (g !== "isolate" && g !== "reuse") {
        throw new Error(`Invalid --group value: ${g}`);
      }
      args.group = g;
      i++;
    }
  }
  return args;
}

function ensureDirs(): void {
  for (const dir of [NOTIFICATIONS_DIR, REPORTS_DIR]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
}

function writeRunState(state: RunState): void {
  writeFileSync(RUN_STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

function writeNotification(payload: object, label: string): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(NOTIFICATIONS_DIR, `${timestamp}-${label}.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2), "utf-8");
}

interface GroupResult {
  mode: "isolate" | "reuse";
  specs: string[];
  status: "passed" | "failed";
  exitCode: number;
  startedAt: string;
  finishedAt: string;
}

function runGroup(
  mode: "isolate" | "reuse",
  specs: string[],
  config: PipelineConfig,
  tags: string[],
): Promise<GroupResult> {
  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const env: Record<string, string> = {
      ...process.env,
      AGENTDOCK_E2E_REUSE: mode === "reuse" ? "1" : "0",
    };

    const args = ["playwright", "test"];
    if (specs.length > 0) args.push(...specs);
    if (tags.length > 0) {
      args.push("--grep", tags.map((t) => (t.startsWith("@") ? t : `@${t}`)).join("|"));
    }
    args.push(`--workers=${config.pipeline.global.parallel}`);

    const child = spawn("npx", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      shell: process.platform === "win32",
    });

    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
    });

    child.on("close", (code) => {
      const finishedAt = new Date().toISOString();
      const exitCode = code ?? 1;
      resolve({
        mode,
        specs,
        status: exitCode === 0 ? "passed" : "failed",
        exitCode,
        startedAt,
        finishedAt,
      });
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  const cliArgs = parseArgs(process.argv.slice(2));
  ensureDirs();

  const allGroups: Array<{ mode: "isolate" | "reuse"; specs: string[] }> = [];
  if (!cliArgs.group || cliArgs.group === "isolate") {
    allGroups.push({
      mode: "isolate",
      specs: config.pipeline.specs.filter((s) => s.mode === "isolate").map((s) => s.pattern),
    });
  }
  if (!cliArgs.group || cliArgs.group === "reuse") {
    allGroups.push({
      mode: "reuse",
      specs: config.pipeline.specs.filter((s) => s.mode === "reuse").map((s) => s.pattern),
    });
  }

  const runState: RunState = {
    startedAt: new Date().toISOString(),
    groups: allGroups.map((g) => ({
      mode: g.mode,
      specs: g.specs,
      status: "pending",
    })),
  };
  writeRunState(runState);

  console.log(`\n📦 Pipeline starting: ${allGroups.length} group(s)\n`);
  const results: GroupResult[] = [];
  for (const group of allGroups) {
    const idx = runState.groups.findIndex((g) => g.mode === group.mode);
    runState.groups[idx].status = "running";
    runState.groups[idx].startedAt = new Date().toISOString();
    writeRunState(runState);

    console.log(`\n▶ Running ${group.mode} group (${group.specs.length} specs)`);
    const result = await runGroup(group.mode, group.specs, config, cliArgs.tags);
    results.push(result);

    const stateIdx = runState.groups.findIndex((g) => g.mode === group.mode);
    runState.groups[stateIdx].status = result.status;
    runState.groups[stateIdx].finishedAt = result.finishedAt;
    runState.groups[stateIdx].exitCode = result.exitCode;
    writeRunState(runState);

    if (config.debugging.notifications.onPipelineComplete) {
      writeNotification(result, `group-${group.mode}`);
    }
  }

  runState.finishedAt = new Date().toISOString();
  writeRunState(runState);

  const finalReport = {
    startedAt: runState.startedAt,
    finishedAt: runState.finishedAt,
    groups: results,
    success: results.every((r) => r.status === "passed"),
  };
  const reportPath = join(REPORTS_DIR, `${runState.finishedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(reportPath, JSON.stringify(finalReport, null, 2), "utf-8");

  console.log(
    `\n${finalReport.success ? "✅" : "❌"} Pipeline ${finalReport.success ? "passed" : "failed"}`,
  );
  console.log(`📄 Report: ${reportPath}`);
  process.exit(finalReport.success ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n❌ Pipeline runner error: ${err.message ?? err}`);
  process.exit(2);
});
