/**
 * Structured logger — pino wrapper for runtime use.
 *
 * Phase 0: scaffold. Replaces scattered console.log/warn/error calls
 * gradually in subsequent phases. Tests use test-utils/structured-log.ts
 * for capture, which is separate from this runtime logger.
 *
 * Why pino?
 *  - Fastest JSON logger for Node.js
 *  - Built-in child loggers, redaction, pretty-print in dev
 *  - Easy for AI agents to parse (one JSON object per line)
 *
 * Usage:
 *   import { log } from "./logger.js";
 *   log.info({ sessionId, step: "createWorktree" }, "lifecycle step started");
 *   log.warn({ orphanCount }, "orphan cleanup");
 *   log.error({ err, channel }, "ipc handler failed");
 */
import pino from "pino";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the per-process log file path.
 *
 * Electron main process: `app.getPath("userData")/logs/agentdock.log`
 *   — production logs live next to the user's data, easy to find.
 * Daemon (Bun) process: `~/.agentdock/logs/daemon.log`
 *   — daemon runs headless without `app`; fall back to a fixed home path.
 *
 * Override via AGENTDOCK_LOG_FILE for tests / packaging.
 */
function resolveLogFile(): string | null {
  if (process.env.AGENTDOCK_LOG_FILE) {
    return process.env.AGENTDOCK_LOG_FILE;
  }
  let baseDir: string;
  try {
    // Dynamic require so the daemon (no electron in its bundle) doesn't
    // crash on import. `app.getPath` is only valid after `app.ready`.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (app?.isReady?.() && app?.getPath) {
      baseDir = app.getPath("userData");
    } else {
      baseDir = join(homedir(), ".agentdock");
    }
  } catch {
    baseDir = join(homedir(), ".agentdock");
  }
  // process name hint: main → "main.log", daemon → "daemon.log"
  const fileName = process.env.AGENTDOCK_LOG_NAME ?? "agentdock.log";
  const logDir = join(baseDir, "logs");
  try {
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  } catch {
    // If we can't create the log dir, return null → log stays stdout-only.
    return null;
  }
  return join(logDir, fileName);
}

const logFile = resolveLogFile();

// Tee to stdout (kept for `bun plugins/daemon.ts` direct invocation, dev
// consoles, and `npm run dev` terminal output) AND to a file on disk so
// the log survives the process. Uses sonic-boom's default buffered mode
// (sync=false) so log writes don't block the main event loop.
const streams: pino.StreamEntry[] = [{ stream: process.stdout }];
if (logFile) {
  streams.push({ stream: pino.destination({ dest: logFile, sync: false, mkdir: true }) });
}

export const log = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    formatters: {
      level: (label) => ({ level: label }),
    },
    base: {
      service: "agentdock",
      pid: process.pid,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream(streams),
);

/** Exported for diagnostics — files the user can `tail` when reporting bugs. */
export const LOG_FILE_PATH = logFile;
