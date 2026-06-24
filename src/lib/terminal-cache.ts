/**
 * Terminal cache (renderer-side) — Phase 5 MessagePort transport.
 *
 * Migrated from WebSocket (`/api/terminal`) to MessageChannelMain.
 * The main process transfers a MessagePort via the IPC stream channel
 * `terminal:port`. We wrap it in a tiny shim that mimics the WebSocket
 * interface we used to drive, so the rest of this file stays unchanged.
 *
 * Wire format (preserved from the old WS protocol):
 *   renderer → main:  { type: "input",  data }
 *                    { type: "resize", cols, rows }
 *   main → renderer:  { type: "output", data }
 *                    { type: "opened", terminalId, sessionId, pid, status }
 *                    { type: "exit",   code, signal? }
 *                    { type: "error",  message }
 */
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IDisposable } from "@xterm/xterm";

// ---- Types ----

export type TerminalCacheStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error"
  | "exited";

interface CachedTerminal {
  terminalId: string;
  sessionId: string;
  terminal: Terminal;
  fitAddon: FitAddon;
  /** WebSocket-like shim wrapping a MessagePort (or null while connecting). */
  websocket: PortShim | null;
  status: TerminalCacheStatus;
  onDataDisposable: IDisposable;
  resizeObserver: ResizeObserver | null;
  containerRef: HTMLElement | null;
  reconnectAttempt: number;
  wasConnected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  debouncedSendResize: ReturnType<typeof debounce> | null;
  /** Cleanup for the port-transfer message listener. */
  offPortListener: (() => void) | null;
}

type StatusCallback = (status: TerminalCacheStatus) => void;

/**
 * Tiny shim: expose WebSocket-like semantics over a MessagePort.
 * The rest of this file (`send`, `onopen`, `onmessage`, `onclose`)
 * was written for WebSocket and is preserved unchanged.
 */
class PortShim {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: (() => void) | null = null;
  public readyState: 0 | 1 | 2 | 3 = 0; // CONNECTING

  constructor(private port: MessagePort) {
    port.onmessage = (e) => {
      if (this.onmessage) this.onmessage({ data: e.data as string });
    };
    port.start();
    // MessagePorts don't have a close event the same way WebSockets do.
    // We synthesize "open" immediately since postMessage is ready right away.
    this.readyState = 1;
    queueMicrotask(() => {
      if (this.onopen) this.onopen();
    });
  }

  send(data: string): void {
    this.port.postMessage(JSON.parse(data) as unknown);
  }

  close(): void {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }
}

// ---- Debounce utility ----

function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
  };
  return debounced as T & { cancel: () => void };
}

// ---- Terminal configuration (shared) ----

import { DEFAULT_TERMINAL_PREFS, type TerminalPreferences } from "./store";

const TERMINAL_BASE_CONFIG = {
  cursorBlink: true,
  cursorStyle: "block" as const,
  scrollback: 50000,
  allowProposedApi: true,
  theme: {
    background: "#1e1e1e",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    selectionBackground: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11b8bd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
};

export function buildTerminalConfig(prefs: TerminalPreferences) {
  return {
    ...TERMINAL_BASE_CONFIG,
    fontSize: prefs.fontSize,
    fontFamily: prefs.fontFamily,
  };
}

declare global {
  interface Window {
    api: import("../electron/preload").ApiSurface;
  }
}

// ---- TerminalCache singleton ----

class TerminalCache {
  private cache = new Map<string, CachedTerminal>();
  private statusListeners = new Map<string, Set<StatusCallback>>();
  private graveyard: HTMLElement | null = null;

  // -- Graveyard container (lazy init) --

  private getGraveyard(): HTMLElement {
    if (!this.graveyard) {
      this.graveyard = document.createElement("div");
      this.graveyard.id = "terminal-graveyard";
      this.graveyard.style.cssText =
        "position:absolute;left:-9999px;top:-9999px;visibility:hidden;overflow:hidden;width:0;height:0;";
      document.body.appendChild(this.graveyard);
    }
    return this.graveyard;
  }

  // -- Status notification --

  private notifyStatus(terminalId: string, status: TerminalCacheStatus): void {
    const set = this.statusListeners.get(terminalId);
    if (set) {
      for (const cb of set) cb(status);
    }
  }

  // -- Port-based transport (replaces WebSocket) --

  private async connectPort(entry: CachedTerminal): Promise<void> {
    entry.status = "connecting";
    this.notifyStatus(entry.terminalId, "connecting");

    // Listen on window.message directly — bypass `window.api.terminals.
    // onPort` because contextBridge wraps the MessagePort and strips
    // its `.start()` / `.onmessage` methods. Preload's onPort
    // implementation re-dispatches the port via `window.postMessage`
    // for exactly this reason; we just pick it up on the receiving end
    // here. (Calling onPort would also work, but contextBridge would
    // hand us a stripped port via the callback path.)
    const winHandler = (event: MessageEvent) => {
      const data = event.data as { type?: string; terminalId?: string } | null;
      if (!data || data.type !== "terminal:port") return;
      if (data.terminalId !== entry.terminalId) return;
      const port = event.ports[0];
      if (!port) return;
      window.removeEventListener("message", winHandler);
      if (entry.offPortListener) {
        entry.offPortListener();
        entry.offPortListener = null;
      }
      this.attachPort(entry, port);
    };
    window.addEventListener("message", winHandler);
    // Keep the contextBridge `onPort` subscription active too so the
    // preload's ipcRenderer.on stays installed (its handler is what
    // triggers the window.postMessage re-dispatch). The callback we
    // pass is a no-op — `winHandler` above is the real receiver.
    const offPort = window.api.terminals.onPort(() => {
      /* no-op — see winHandler above */
    });
    entry.offPortListener = () => {
      window.removeEventListener("message", winHandler);
      offPort();
    };

    // Ask main to transfer a port for this terminalId.
    try {
      await window.api.terminals.open(entry.terminalId);
    } catch (err) {
      this.handleConnectionError(entry, err);
    }
  }

  private attachPort(entry: CachedTerminal, port: MessagePort): void {
    const shim = new PortShim(port);
    entry.websocket = shim;

    shim.onopen = () => {
      entry.reconnectAttempt = 0;
      entry.wasConnected = true;
      // Note: we don't get an "opened" event over the port — the
      // PortShim synthesizes the onopen immediately. The old WS protocol's
      // "opened" event from main is no longer needed because the port is
      // already ready for I/O the moment we receive it.
      entry.status = "connected";
      this.notifyStatus(entry.terminalId, "connected");
      this.safeFit(entry);
      this.sendResize(entry);
    };

    shim.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as { type: string; [k: string]: unknown };
        switch (msg.type) {
          case "output":
            entry.terminal.write(String(msg.data ?? ""));
            break;
          case "opened":
            // Defensive: main might still send an "opened" frame; ignore
            // (we already marked status = "connected" on onopen).
            break;
          case "exit":
            entry.terminal.writeln(
              `\r\n\x1b[33m[Process exited code=${msg.code}]\x1b[0m`,
            );
            entry.exited = true;
            entry.status = "exited";
            this.notifyStatus(entry.terminalId, "exited");
            break;
          case "error":
            entry.terminal.writeln(
              `\r\n\x1b[31m[Error] ${String(msg.message ?? "")}\x1b[0m`,
            );
            entry.status = "error";
            this.notifyStatus(entry.terminalId, "error");
            break;
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    shim.onclose = () => {
      if (entry.exited) return;
      if (entry.status === "connected" || entry.status === "connecting") {
        entry.status = "disconnected";
        this.notifyStatus(entry.terminalId, "disconnected");
      }
      if (entry.wasConnected) {
        entry.wasConnected = false;
        const attempt = entry.reconnectAttempt;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        entry.reconnectAttempt = attempt + 1;
        entry.reconnectTimer = setTimeout(() => {
          void this.connectPort(entry);
        }, delay);
      }
    };
  }

  private handleConnectionError(entry: CachedTerminal, err: unknown): void {
    if (entry.offPortListener) {
      entry.offPortListener();
      entry.offPortListener = null;
    }
    entry.status = "error";
    this.notifyStatus(entry.terminalId, "error");
    // Trigger a reconnect (the WS version did the same).
    if (entry.wasConnected) {
      entry.wasConnected = false;
      entry.reconnectTimer = setTimeout(() => {
        void this.connectPort(entry);
      }, 2000);
    }
    console.warn(`[TerminalCache] open(${entry.terminalId}) failed:`, err);
  }

  private sendResize(entry: CachedTerminal): void {
    if (
      entry.websocket?.readyState === 1 && // OPEN
      entry.terminal.rows > 0 &&
      entry.terminal.cols > 0
    ) {
      entry.websocket.send(
        JSON.stringify({
          type: "resize",
          cols: entry.terminal.cols,
          rows: entry.terminal.rows,
        }),
      );
    }
  }

  private safeFit(entry: CachedTerminal): void {
    if (!entry.containerRef) return;
    if (
      entry.containerRef.offsetWidth === 0 ||
      entry.containerRef.offsetHeight === 0
    )
      return;
    try {
      entry.fitAddon.fit();
    } catch {
      // xterm renderer not ready
    }
  }

  private startResizeObserver(entry: CachedTerminal): void {
    if (entry.resizeObserver) {
      entry.resizeObserver.disconnect();
    }
    if (!entry.containerRef) return;

    const sendResize = debounce(() => {
      this.safeFit(entry);
      this.sendResize(entry);
    }, 100);
    entry.debouncedSendResize = sendResize;

    const observer = new ResizeObserver(() => {
      sendResize();
    });
    observer.observe(entry.containerRef);
    entry.resizeObserver = observer;
  }

  private stopResizeObserver(entry: CachedTerminal): void {
    if (entry.resizeObserver) {
      entry.resizeObserver.disconnect();
      entry.resizeObserver = null;
    }
    if (entry.debouncedSendResize) {
      entry.debouncedSendResize.cancel();
      entry.debouncedSendResize = null;
    }
  }

  // -- Public API --

  getOrCreate(terminalId: string, sessionId: string, prefs?: TerminalPreferences): CachedTerminal {
    const existing = this.cache.get(terminalId);
    if (existing) return existing;

    const terminal = new Terminal(buildTerminalConfig(prefs ?? DEFAULT_TERMINAL_PREFS));
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const onDataDisposable = terminal.onData((data) => {
      const entry = this.cache.get(terminalId);
      if (entry?.websocket?.readyState === 1) {
        entry.websocket.send(JSON.stringify({ type: "input", data }));
      }
    });

    const entry: CachedTerminal = {
      terminalId,
      sessionId,
      terminal,
      fitAddon,
      websocket: null,
      status: "connecting",
      onDataDisposable,
      resizeObserver: null,
      containerRef: null,
      reconnectAttempt: 0,
      wasConnected: false,
      reconnectTimer: null,
      exited: false,
      debouncedSendResize: null,
      offPortListener: null,
    };

    this.cache.set(terminalId, entry);
    void this.connectPort(entry);
    return entry;
  }

  attach(terminalId: string, container: HTMLElement): void {
    const entry = this.cache.get(terminalId);
    if (!entry) return;
    if (entry.containerRef === container) return;

    const isFirstAttach = !entry.terminal.element;
    const term = entry.terminal;
    if (!isFirstAttach) {
      container.appendChild(entry.terminal.element);
    } else {
      term.open(container);
    }
    entry.containerRef = container;

    this.startResizeObserver(entry);

    requestAnimationFrame(() => {
      this.safeFit(entry);
      this.sendResize(entry);
      if (!isFirstAttach) {
        const vp = term.element?.querySelector(".xterm-viewport") as HTMLElement | null;
        if (vp && vp.scrollHeight > vp.clientHeight) {
          const rowHeight = vp.scrollHeight / (term.buffer.active.baseY + term.rows);
          const targetScrollTop = term.buffer.active.viewportY * rowHeight;
          if (Math.abs(vp.scrollTop - targetScrollTop) > 1) {
            vp.scrollTop = targetScrollTop;
          }
        }
      }
    });
  }

  detach(terminalId: string): void {
    const entry = this.cache.get(terminalId);
    if (!entry || !entry.containerRef) return;
    this.stopResizeObserver(entry);
    const graveyard = this.getGraveyard();
    graveyard.appendChild(entry.terminal.element);
    entry.containerRef = null;
  }

  dispose(terminalId: string): void {
    const entry = this.cache.get(terminalId);
    if (!entry) return;

    if (entry.containerRef) {
      this.stopResizeObserver(entry);
      entry.terminal.element.remove();
      entry.containerRef = null;
    }

    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }
    if (entry.offPortListener) {
      entry.offPortListener();
      entry.offPortListener = null;
    }
    if (entry.websocket) {
      entry.websocket.close();
      entry.websocket = null;
    }
    entry.onDataDisposable.dispose();
    entry.terminal.dispose();

    this.cache.delete(terminalId);
    this.statusListeners.delete(terminalId);
  }

  disposeBySession(sessionId: string): void {
    const toDispose: string[] = [];
    for (const [terminalId, entry] of this.cache) {
      if (entry.sessionId === sessionId) {
        toDispose.push(terminalId);
      }
    }
    for (const terminalId of toDispose) {
      this.dispose(terminalId);
    }
  }

  get(terminalId: string): CachedTerminal | undefined {
    return this.cache.get(terminalId);
  }

  onStatusChange(terminalId: string, cb: StatusCallback): () => void {
    let set = this.statusListeners.get(terminalId);
    if (!set) {
      set = new Set();
      this.statusListeners.set(terminalId, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0) this.statusListeners.delete(terminalId);
    };
  }

  /** Send text input to a terminal via IPC — waits for connection dynamically. */
  sendText(terminalId: string, text: string): void {
    const trySend = () => {
      const entry = this.cache.get(terminalId);
      if (!entry) {
        setTimeout(trySend, 50);
        return;
      }
      if (entry.status === "connected") {
        window.api.terminals.write(terminalId, text).catch((err) => {
          console.warn(`[TerminalCache] sendText(${terminalId}) failed:`, err);
        });
        return;
      }
      const unsubscribe = this.onStatusChange(terminalId, (status) => {
        if (status === "connected") {
          unsubscribe();
          window.api.terminals.write(terminalId, text).catch((err) => {
            console.warn(`[TerminalCache] sendText(${terminalId}) failed:`, err);
          });
        } else if (status === "exited" || status === "error") {
          unsubscribe();
        }
      });
    };
    trySend();
  }

  /** Update font size/family on all existing terminal instances. */
  applyPrefs(prefs: TerminalPreferences): void {
    for (const entry of this.cache.values()) {
      entry.terminal.options.fontSize = prefs.fontSize;
      entry.terminal.options.fontFamily = prefs.fontFamily;
      // Re-fit after font change since character dimensions change
      if (entry.containerRef) {
        requestAnimationFrame(() => this.safeFit(entry));
      }
    }
  }
}

export const terminalCache = new TerminalCache();
