/**
 * Terminal IPC handlers.
 *
 * terminals:create / list / rename / delete are REST-style for the
 * metadata; terminals:open bridges to the streaming terminal via
 * MessageChannelMain (so the renderer can use a port for bidir I/O).
 */
import { MessageChannelMain } from "electron";
import { ipcMain } from "electron";
import { eq } from "drizzle-orm";
import { IPC_CHANNELS } from "../../shared/api-types.js";
import { terminalManager } from "../../../plugins/terminal-manager.js";
import { getActiveDb } from "../../../plugins/db/index.js";
import * as schema from "../../../plugins/db/schema.js";
import { log } from "../../../plugins/logger.js";

/**
 * Look up a session's `worktreePath` from the active DB. node-pty needs a
 * real cwd to spawn into; without it, `terminalManager.create` throws
 * `Worktree path not found`. Centralized so the same lookup is reusable
 * by terminals:create today and any future "spawn terminal for session"
 * channels (e.g. shell:openTerminal).
 */
function resolveSessionWorktree(sessionId: string): string {
  const db = getActiveDb();
  if (!db) {
    throw new Error("db not initialized: call db:init first");
  }
  const row = db
    .select({ worktreePath: schema.sessions.worktreePath })
    .from(schema.sessions)
    .where(eq(schema.sessions.id, sessionId))
    .get();
  if (!row?.worktreePath) {
    throw new Error(`Session not found or has no worktree: ${sessionId}`);
  }
  return row.worktreePath;
}

export function registerTerminals(): void {
  ipcMain.handle(IPC_CHANNELS["terminals:create"], async (_e, params: { sessionId: string; shell?: string }) => {
    if (!params?.sessionId) {
      throw new Error("sessionId required");
    }
    const { sessionId, shell } = params;
    const worktreePath = resolveSessionWorktree(sessionId);
    // Use a default cols/rows; the renderer can resize via the message port.
    const terminal = await terminalManager.create({
      sessionId,
      worktreePath,
      shell: shell ?? "default",
      cols: 80,
      rows: 24,
    });
    return {
      terminalId: terminal.terminalId,
      sessionId: terminal.sessionId,
      shell: terminal.shell,
      status: terminal.status,
      pid: terminal.pid,
      createdAt: new Date().toISOString(),
    };
  });

  ipcMain.handle(IPC_CHANNELS["terminals:list"], (_e, sessionId: string) => {
    if (!sessionId) {
      throw new Error("sessionId required");
    }
    const terminals = terminalManager.listBySession(sessionId);
    return terminals.map((t) => ({
      terminalId: t.terminalId,
      sessionId: t.sessionId,
      shell: t.shell,
      status: t.status,
      pid: t.pid,
      createdAt: new Date().toISOString(),
    }));
  });

  ipcMain.handle(IPC_CHANNELS["terminals:rename"], (_e, params: { terminalId: string; name: string }) => {
    if (!params?.terminalId || !params?.name) {
      throw new Error("terminalId and name required");
    }
    terminalManager.rename(params.terminalId, params.name);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["terminals:delete"], async (_e, terminalId: string) => {
    if (!terminalId) {
      throw new Error("terminalId required");
    }
    await terminalManager.kill(terminalId);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS["terminals:open"], (event, terminalId: string) => {
    if (!terminalId) {
      throw new Error("terminalId required");
    }
    // Create a MessageChannel: one port goes to the renderer (via
    // postMessage on the WebContents), the other stays in main attached
    // to the terminal's PTY host via terminalManager.attachPort.
    const { port1, port2 } = new MessageChannelMain();
    try {
      terminalManager.attachPort(terminalId, port2);
    } catch (err) {
      log.error({ err, terminalId }, "failed to attach port");
      // Don't leak port1 if attach failed.
      try {
        port1.close();
      } catch {
        // best-effort
      }
      throw err;
    }
    // Transfer port1 to the renderer. The 'terminal:port' message channel
    // is a one-shot port-transfer; the renderer receives the port and
    // uses it for bidirectional I/O with the PTY.
    event.sender.postMessage("terminal:port", { terminalId }, [port1]);
    return { ready: true };
  });
}