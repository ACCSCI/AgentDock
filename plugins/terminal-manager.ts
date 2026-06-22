import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import type { WebSocket } from "ws";
import type { MessagePortMain } from "electron";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate pty-host.cjs across the dev / prod / electron-builder layouts.
 *
 *   - dev (electron-vite preview / npm test):
 *       __dirname = .../plugins  → pty-host.cjs is right here
 *   - prod (electron-vite build):
 *       __dirname = .../out/main → pty-host.cjs is copied here by
 *       electron.vite.config.ts's externalization rule
 *   - electron-builder packaged:
 *       __dirname = .../resources/app.asar.unpacked/out/main → same
 *
 * Walks a small candidate list and picks the first that exists, so a
 * missing copy step in any layout fails loudly with a useful path.
 */
function resolvePtyHostPath(): string {
  const candidates = [
    path.join(__dirname, "pty-host.cjs"),
    // build output sometimes flattens; check ../plugins as fallback.
    path.join(__dirname, "..", "plugins", "pty-host.cjs"),
    path.join(__dirname, "..", "..", "plugins", "pty-host.cjs"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  throw new Error(
    `pty-host.cjs not found. Searched: ${candidates.join(", ")}. ` +
      `Make sure electron.vite.config.ts copies plugins/pty-host.cjs into out/main/.`,
  );
}

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
  /** Active WebSocket subscribers (legacy daemon-WS path; unused under Electron). */
  connections: Set<WebSocket>;
  /** Active Electron MessagePort subscribers (current Electron renderer path). */
  ports: Set<MessagePortMain>;
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

    // pty-host.cjs lives next to this file in dev (plugins/) and in
    // out/main/ in prod (copied by electron.vite.config.ts). __dirname
    // resolves correctly in both cases.
    const hostPath = resolvePtyHostPath();
    // process.execPath is electron.exe in the Electron main process;
    // running pty-host.cjs with it directly would have Electron try to
    // launch `pty-host.cjs` as a new Electron app — exact symptom the
    // user hit: "Error launching app: Unable to find Electron app at
    // out/main/pty-host.cjs". ELECTRON_RUN_AS_NODE=1 makes the spawned
    // electron.exe behave like plain Node, so node-pty + IPC stay
    // inside one binary (no Node dependency on the user's machine).
    this.host = spawn(process.execPath, [hostPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
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
          // Replay the "opened" frame so any port that connects post-spawn
          // gets the pid immediately (the renderer ignores it after the
          // PortShim's synthetic onopen, but it costs nothing).
          this.broadcastToPorts(terminal, {
            type: "opened",
            terminalId,
            sessionId: terminal.sessionId,
            pid: terminal.pid,
            status: terminal.status,
          });
          break;

        case "output":
          this.appendBuffer(terminal, msg.data as string);
          for (const ws of terminal.connections) {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "output", data: msg.data }));
            }
          }
          this.broadcastToPorts(terminal, { type: "output", data: msg.data });
          break;

        case "exit":
          {
            terminal.status = "exited";
            const exitPayload = { type: "exit", code: msg.code, signal: msg.signal };
            const exitMsg = JSON.stringify(exitPayload);
            for (const ws of terminal.connections) {
              if (ws.readyState === ws.OPEN) ws.send(exitMsg);
            }
            this.broadcastToPorts(terminal, exitPayload);
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
          this.broadcastToPorts(terminal, { type: "error", message: msg.message });
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
        this.broadcastToPorts(terminal, { type: "exit", code: null, signal: "host_died" });
        this.closeAllPorts(terminal);
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
      name: shell === "default" ? "Terminal" : shell,
      shell,
      cwd: worktreePath,
      cols,
      rows,
      pid: null,
      status: "spawning",
      createdAt: new Date(),
      connections: new Set(),
      ports: new Set(),
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

  /**
   * Attach an Electron MessagePort to a terminal (current Electron path).
   *
   * Wire format (matches `src/lib/terminal-cache.ts` PortShim):
   *   port → main:  object `{type:"input",data}` | `{type:"resize",cols,rows}`
   *   main → port:  JSON string of `{type:"output"|"exit"|"error"|"opened", ...}`
   *
   * The asymmetric encoding is required because the renderer's PortShim
   * does `JSON.parse(JSON.stringify(data))` on send (so main sees an
   * object) but `JSON.parse(event.data)` on receive (so it expects a
   * string). Sending strings out is the path of least disruption.
   *
   * Replays the current buffer on attach so a late-joiner sees prior
   * output without scrolling history loss.
   */
  attachPort(terminalId: string, port: MessagePortMain): TerminalInstance {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) throw new Error(`Terminal not found: ${terminalId}`);

    terminal.ports.add(port);

    port.on("message", (e: { data: unknown }) => {
      const msg = e.data as { type?: string; data?: string; cols?: number; rows?: number };
      if (!msg || typeof msg.type !== "string") return;
      switch (msg.type) {
        case "input":
          if (typeof msg.data === "string") this.write(terminalId, msg.data);
          break;
        case "resize":
          if (typeof msg.cols === "number" && typeof msg.rows === "number") {
            this.resize(terminalId, msg.cols, msg.rows);
          }
          break;
      }
    });
    port.on("close", () => {
      terminal.ports.delete(port);
    });
    port.start();

    // Replay buffer so the renderer renders prior output. The xterm
    // serializer wrote each PTY chunk as-is; concat is safe.
    if (terminal.buffer.length > 0) {
      port.postMessage(
        JSON.stringify({ type: "output", data: terminal.buffer.join("") }),
      );
    }
    // Send "opened" so the renderer learns the pid (PortShim already
    // marked status=connected, but the master protocol emitted this).
    port.postMessage(
      JSON.stringify({
        type: "opened",
        terminalId,
        sessionId: terminal.sessionId,
        pid: terminal.pid,
        status: terminal.status,
      }),
    );
    // If the PTY already exited, tell the new port immediately so the
    // renderer shows its "process exited" overlay.
    if (terminal.status === "exited") {
      port.postMessage(JSON.stringify({ type: "exit", code: null, signal: "already-exited" }));
    }
    return terminal;
  }

  /** Broadcast a structured frame as a JSON string to every attached port. */
  private broadcastToPorts(terminal: TerminalInstance, frame: unknown): void {
    if (terminal.ports.size === 0) return;
    const json = JSON.stringify(frame);
    for (const port of terminal.ports) {
      try {
        port.postMessage(json);
      } catch {
        // Port may be closed mid-iteration; drop it.
        terminal.ports.delete(port);
      }
    }
  }

  /** Close every attached MessagePort (called on terminal kill / host death). */
  private closeAllPorts(terminal: TerminalInstance): void {
    for (const port of terminal.ports) {
      try {
        port.close();
      } catch {
        // Best-effort.
      }
    }
    terminal.ports.clear();
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
    const exitPayload = { type: "exit", code: null, signal: "killed" };
    const exitMsg = JSON.stringify(exitPayload);
    for (const ws of terminal.connections) {
      if (ws.readyState === ws.OPEN) ws.send(exitMsg);
      ws.close();
    }
    this.broadcastToPorts(terminal, exitPayload);
    this.closeAllPorts(terminal);

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
    const exitPayload = { type: "exit", code: null, signal: "shutdown" };
    const exitMsg = JSON.stringify(exitPayload);
    for (const [, terminal] of this.terminals) {
      for (const ws of terminal.connections) {
        if (ws.readyState === ws.OPEN) ws.send(exitMsg);
        ws.close();
      }
      this.broadcastToPorts(terminal, exitPayload);
      this.closeAllPorts(terminal);
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
