// @ts-nocheck
/**
 * Phase 1 (Hono refactor): thin re-export. Real impl in plugins/daemon/.
 * Existing tests import { AgentDockDaemon } from this file unchanged.
 */
export { AgentDockDaemon, runDaemon } from "./daemon/server.js";
export type { DaemonOptions } from "./daemon/context.js";
