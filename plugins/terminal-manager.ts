import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TerminalStatus = "spawning" | "running" | "exited";

export interface TerminalInstance {
  terminalId: string;
  sessionId: string;
  name: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  pid: number | null;
  status: TerminalStatus;
  createdAt: Date;
  connections: Set<WebSocket>;
  buffer: string[];
}

const MAX_BUFFER_LINES = 50000;

export class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();
  private sessionIndex = new Map<string, Set<string>>(); // sessionId → Set<terminalId>
  private host: ChildProcess | null = null;
  private hostReady = false;
  private pendingRequests: Array<() => void> = [];

  private ensureHost(): void {
    if (this.host && this.hostReady) return;
    if (this.host && !this.hostReady) return;

    const hostPath = path.join(__dirname, "pty-host.cjs");
    this.host = spawn(process.execPath, [hostPath], {
      stdio: ["pipe", "pipe", "inherit"],
    });

    const rl = createInterface({ input: this.host.stdout! });

    rl.on("line", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === "ready") {
        this.hostReady = true;
        for (const resolve of this.pendingRequests) resolve();
        this.pendingRequests = [];
        return;
      }

      // All messages from PTY host now carry terminalId
      const terminalId = msg.terminalId as string | undefined;
      if (!terminalId) {
        if (msg.type === "error") {
          console.error("[PTY-Host]", msg.message);
        }
        return;
      }

      const terminal = this.terminals.get(terminalId);
      if (!terminal) return;

      switch (msg.type) {
        case "spawned":
          terminal.pid = msg.pid as number;
          terminal.status = "running";
          console.log(`[TerminalManager] Terminal ${terminalId} spawned (pid=${msg.pid})`);
          break;

        case "output":
          this.appendBuffer(terminal, msg.data as string);
          for (const ws of terminal.connections) {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "output", data: msg.data }));
            }
          }
          break;

        case "exit":
          {
            terminal.status = "exited";
            const exitMsg = JSON.stringify({ type: "exit", code: msg.code, signal: msg.signal });
            for (const ws of terminal.connections) {
              if (ws.readyState === ws.OPEN) ws.send(exitMsg);
            }
            console.log(`[TerminalManager] Terminal ${terminalId} exited (code=${msg.code})`);
            // Don't remove immediately — keep for status queries. Cleanup on kill().
          }
          break;

        case "error":
          for (const ws of terminal.connections) {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "error", message: msg.message }));
            }
          }
          break;
      }
    });

    this.host.on("exit", (code) => {
      console.log(`[TerminalManager] PTY host exited (code=${code})`);
      this.host = null;
      this.hostReady = false;
      for (const [, terminal] of this.terminals) {
        terminal.status = "exited";
        for (const ws of terminal.connections) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "exit", code: null, signal: "host_died" }));
          }
        }
      }
      this.terminals.clear();
      this.sessionIndex.clear();
    });
  }

  private async waitForHost(): Promise<void> {
    if (this.hostReady) return;
    this.ensureHost();
    if (this.hostReady) return;
    return new Promise((resolve) => {
      this.pendingRequests.push(resolve);
    });
  }

  private sendToHost(msg: Record<string, unknown>): void {
    if (!this.host || !this.host.stdin) {
      throw new Error("PTY host not available");
    }
    this.host.stdin.write(JSON.stringify(msg) + "\n");
  }

  private addToSessionIndex(sessionId: string, terminalId: string): void {
    let set = this.sessionIndex.get(sessionId);
    if (!set) {
      set = new Set();
      this.sessionIndex.set(sessionId, set);
    }
    set.add(terminalId);
  }

  private removeFromSessionIndex(sessionId: string, terminalId: string): void {
    const set = this.sessionIndex.get(sessionId);
    if (set) {
      set.delete(terminalId);
      if (set.size === 0) this.sessionIndex.delete(sessionId);
    }
  }

  /** Create a new terminal instance. */
  async create(opts: {
    sessionId: string;
    worktreePath: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }): Promise<TerminalInstance> {
    const { sessionId, worktreePath, shell = "default", cols = 80, rows = 24 } = opts;

    if (!existsSync(worktreePath)) {
      throw new Error(`Worktree path not found: ${sessionId} @ ${worktreePath}`);
    }

    await this.waitForHost();

    const terminalId = nanoid(8);
    const terminal: TerminalInstance = {
      terminalId,
      sessionId,
      name: shell,
      shell,
      cwd: worktreePath,
      cols,
      rows,
      pid: null,
      status: "spawning",
      createdAt: new Date(),
      connections: new Set(),
      buffer: [],
    };

    this.terminals.set(terminalId, terminal);
    this.addToSessionIndex(sessionId, terminalId);

    this.sendToHost({
      type: "spawn",
      terminalId,
      sessionId,
      shell,
      worktreePath,
      cols,
      rows,
    });

    console.log(`[TerminalManager] Created terminal ${terminalId} (session: ${sessionId}, shell: ${shell})`);
    return terminal;
  }

  /** Get a terminal by ID. */
  get(terminalId: string): TerminalInstance | undefined {
    return this.terminals.get(terminalId);
  }

  /** Rename a terminal. */
  rename(terminalId: string, name: string): TerminalInstance | undefined {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return undefined;
    terminal.name = name;
    return terminal;
  }

  /** Attach a WebSocket connection to a terminal. */
  attach(terminalId: string, ws: WebSocket): TerminalInstance {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${terminalId}`);
    terminal.connections.add(ws);
    return terminal;
  }

  /** Detach a WebSocket connection from a terminal (does not kill PTY). */
  detach(terminalId: string, ws: WebSocket): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;
    terminal.connections.delete(ws);
  }

  /** Write data to a terminal's PTY. */
  write(terminalId: string, data: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.status === "exited") return;
    this.sendToHost({ type: "write", terminalId, data });
  }

  /** Resize a terminal's PTY. */
  resize(terminalId: string, cols: number, rows: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal || terminal.status === "exited") return;
    terminal.cols = cols;
    terminal.rows = rows;
    this.sendToHost({ type: "resize", terminalId, cols, rows });
  }

  /** Kill a terminal and remove it. */
  kill(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    console.log(`[TerminalManager] Killing terminal ${terminalId}`);
    this.sendToHost({ type: "kill", terminalId });

    // Notify connected clients
    const exitMsg = JSON.stringify({ type: "exit", code: null, signal: "killed" });
    for (const ws of terminal.connections) {
      if (ws.readyState === ws.OPEN) ws.send(exitMsg);
      ws.close();
    }

    this.removeFromSessionIndex(terminal.sessionId, terminalId);
    this.terminals.delete(terminalId);
  }

  /** List all terminals for a session. */
  listBySession(sessionId: string): TerminalInstance[] {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return [];
    return Array.from(ids).map((id) => this.terminals.get(id)!).filter(Boolean);
  }

  /** Kill all terminals belonging to a session. */
  killBySession(sessionId: string): void {
    const ids = this.sessionIndex.get(sessionId);
    if (!ids) return;
    // Copy to array since kill() mutates the set
    for (const terminalId of Array.from(ids)) {
      this.kill(terminalId);
    }
  }

  /** Kill all terminals and shut down PTY host. */
  killAll(): void {
    if (!this.host) return;
    this.sendToHost({ type: "killAll" });

    // Notify all connected clients
    const exitMsg = JSON.stringify({ type: "exit", code: null, signal: "shutdown" });
    for (const [, terminal] of this.terminals) {
      for (const ws of terminal.connections) {
        if (ws.readyState === ws.OPEN) ws.send(exitMsg);
        ws.close();
      }
    }

    this.terminals.clear();
    this.sessionIndex.clear();
    this.host.kill();
    this.host = null;
    this.hostReady = false;
  }

  get activeCount(): number {
    return this.terminals.size;
  }

  private appendBuffer(terminal: TerminalInstance, text: string): void {
    terminal.buffer.push(text);
    if (terminal.buffer.length > MAX_BUFFER_LINES) {
      terminal.buffer.splice(0, terminal.buffer.length - MAX_BUFFER_LINES);
    }
  }
}

/** 全局单例 */
export const terminalManager = new TerminalManager();
