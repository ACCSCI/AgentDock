/**
 * Structured Logging — pino instance for tests.
 *
 * Phase 0: Scaffold. Tests use this to emit JSON logs that can be parsed
 * by AI agents when debugging failures. In production code, plugins/logger.ts
 * wraps pino for runtime use.
 */

import pino, { type Logger } from "pino";

export function createTestLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    formatters: { level: (label) => ({ level: label }) },
    base: { service: "agentdock-test" },
  });
}

/**
 * Capture log output during a test. Returns a list of {level, msg, ...rest}
 * objects. Useful for asserting that expected log events fired.
 */
export interface CapturedLog {
  level: string;
  msg: string;
  [key: string]: unknown;
}

export function captureLogs(fn: () => void | Promise<void>): Promise<CapturedLog[]> {
  const captured: CapturedLog[] = [];
  const stream = {
    write(chunk: string) {
      try {
        const parsed = JSON.parse(chunk);
        captured.push(parsed);
      } catch {
        // ignore non-JSON output (e.g. pretty-print in dev)
      }
      return true;
    },
  };
  const logger = pino(
    {
      level: "trace",
      formatters: { level: (label) => ({ level: label }) },
      base: { service: "agentdock-test-capture" },
    },
    stream as any,
  );

  const previousLogger = (globalThis as { __testLogger?: Logger }).__testLogger;
  (globalThis as { __testLogger?: Logger }).__testLogger = logger;

  return Promise.resolve(fn()).finally(() => {
    (globalThis as { __testLogger?: Logger }).__testLogger = previousLogger;
  }).then(() => captured);
}