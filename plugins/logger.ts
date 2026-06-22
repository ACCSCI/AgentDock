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

export const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  formatters: {
    level: (label) => ({ level: label }),
  },
  base: {
    service: "agentdock",
    pid: process.pid,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});