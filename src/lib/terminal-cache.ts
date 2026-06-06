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
  websocket: WebSocket | null;
  status: TerminalCacheStatus;
  onDataDisposable: IDisposable;
  resizeObserver: ResizeObserver | null;
  containerRef: HTMLElement | null;
  reconnectAttempt: number;
  wasConnected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  exited: boolean;
  debouncedSendResize: ReturnType<typeof debounce> | null;
}

type StatusCallback = (status: TerminalCacheStatus) => void;

// ---- Debounce utility ----

function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number
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

const TERMINAL_CONFIG = {
  cursorBlink: true,
  cursorStyle: "block" as const,
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
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

  // -- WebSocket helpers --

  private safeCloseWs(ws: WebSocket | null): void {
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.onopen = () => ws.close();
    } else {
      ws.onopen = null;
      ws.close();
    }
  }

  private sendResize(entry: CachedTerminal): void {
    if (
      entry.websocket?.readyState === WebSocket.OPEN &&
      entry.terminal.rows > 0 &&
      entry.terminal.cols > 0
    ) {
      entry.websocket.send(
        JSON.stringify({
          type: "resize",
          cols: entry.terminal.cols,
          rows: entry.terminal.rows,
        })
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

  private connectWebSocket(entry: CachedTerminal): void {
    if (entry.websocket) {
      this.safeCloseWs(entry.websocket);
    }

    entry.status = "connecting";
    this.notifyStatus(entry.terminalId, "connecting");

    const protocol =
      window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal?terminalId=${encodeURIComponent(entry.terminalId)}`;

    const ws = new WebSocket(wsUrl);
    entry.websocket = ws;

    ws.onopen = () => {
      entry.reconnectAttempt = 0;
      entry.wasConnected = true;
      console.log(
        `[TerminalCache] WebSocket opened for ${entry.terminalId}`
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case "output":
            entry.terminal.write(msg.data);
            break;
          case "opened":
            entry.status = "connected";
            this.notifyStatus(entry.terminalId, "connected");
            this.safeFit(entry);
            this.sendResize(entry);
            console.log(
              `[TerminalCache] Terminal ${entry.terminalId} opened (pid=${msg.pid})`
            );
            break;
          case "exit":
            entry.terminal.writeln(
              `\r\n\x1b[33m[Process exited code=${msg.code}]\x1b[0m`
            );
            entry.exited = true;
            entry.status = "exited";
            this.notifyStatus(entry.terminalId, "exited");
            break;
          case "error":
            entry.terminal.writeln(
              `\r\n\x1b[31m[Error] ${msg.message}\x1b[0m`
            );
            entry.status = "error";
            this.notifyStatus(entry.terminalId, "error");
            break;
          case "heartbeat_ack":
            break;
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    ws.onclose = () => {
      console.log(
        `[TerminalCache] WebSocket closed for ${entry.terminalId}`
      );

      // Don't reconnect if process exited
      if (entry.exited) return;

      if (entry.status === "connected" || entry.status === "connecting") {
        entry.status = "disconnected";
        this.notifyStatus(entry.terminalId, "disconnected");
      }

      // Auto-reconnect with exponential backoff
      if (entry.wasConnected) {
        entry.wasConnected = false;
        const attempt = entry.reconnectAttempt;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        entry.reconnectAttempt = attempt + 1;
        console.log(
          `[TerminalCache] Reconnecting ${entry.terminalId} in ${delay}ms (attempt ${attempt + 1})`
        );
        entry.reconnectTimer = setTimeout(
          () => this.connectWebSocket(entry),
          delay
        );
      }
    };

    ws.onerror = () => {
      // onclose handles reconnection
    };
  }

  private startResizeObserver(entry: CachedTerminal): void {
    // Disconnect existing observer if any
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

  /**
   * Get or create a cached terminal instance.
   * If the terminal already exists in cache, returns it.
   * Otherwise creates a new Terminal, FitAddon, and WebSocket connection.
   */
  getOrCreate(terminalId: string, sessionId: string): CachedTerminal {
    const existing = this.cache.get(terminalId);
    if (existing) return existing;

    const terminal = new Terminal(TERMINAL_CONFIG);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    const onDataDisposable = terminal.onData((data) => {
      const entry = this.cache.get(terminalId);
      if (entry?.websocket?.readyState === WebSocket.OPEN) {
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
    };

    this.cache.set(terminalId, entry);
    this.connectWebSocket(entry);

    return entry;
  }

  /**
   * Attach a cached terminal to a DOM container.
   * First call: uses terminal.open() to initialize DOM.
   * Subsequent calls: uses appendChild to move existing DOM element.
   */
  attach(terminalId: string, container: HTMLElement): void {
    const entry = this.cache.get(terminalId);
    if (!entry) return;

    // Already attached to this container
    if (entry.containerRef === container) return;

    const isFirstAttach = !entry.terminal.element;
    const term = entry.terminal;

    // First attach: terminal.open() creates the DOM structure
    // Subsequent attach: appendChild moves the existing element
    if (!isFirstAttach) {
      container.appendChild(entry.terminal.element);
    } else {
      term.open(container);
    }
    entry.containerRef = container;

    // Start ResizeObserver on new container
    this.startResizeObserver(entry);

    // Fit and send resize after a frame to let browser lay out
    requestAnimationFrame(() => {
      this.safeFit(entry);
      this.sendResize(entry);

      // Sync scrollTop with xterm's internal ydisp.
      // After DOM move, xterm's _innerRefresh doesn't trigger scrollTop sync
      // because _currentRowHeight may be stale. We compute rowHeight from
      // scrollHeight and baseY+rows, then set scrollTop directly.
      if (!isFirstAttach) {
        const vp = term.element?.querySelector('.xterm-viewport') as HTMLElement | null;
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

  /**
   * Detach a cached terminal from its DOM container.
   * Moves the terminal element to the graveyard (hidden off-screen).
   * Terminal instance and WebSocket remain alive.
   */
  detach(terminalId: string): void {
    const entry = this.cache.get(terminalId);
    if (!entry || !entry.containerRef) return;

    // Stop ResizeObserver on current container
    this.stopResizeObserver(entry);

    // Move to graveyard
    const graveyard = this.getGraveyard();
    graveyard.appendChild(entry.terminal.element);
    entry.containerRef = null;
  }

  /**
   * Fully dispose a cached terminal: detach from DOM, close WebSocket,
   * dispose xterm instance, remove from cache.
   */
  dispose(terminalId: string): void {
    const entry = this.cache.get(terminalId);
    if (!entry) return;

    // Detach from DOM
    if (entry.containerRef) {
      this.stopResizeObserver(entry);
      // Remove from current parent (don't move to graveyard, we're disposing)
      entry.terminal.element.remove();
      entry.containerRef = null;
    }

    // Close WebSocket
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
    }
    this.safeCloseWs(entry.websocket);
    entry.websocket = null;

    // Dispose xterm
    entry.onDataDisposable.dispose();
    entry.terminal.dispose();

    // Remove from cache
    this.cache.delete(terminalId);
    this.statusListeners.delete(terminalId);
  }

  /**
   * Dispose all cached terminals belonging to a session.
   */
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

  /**
   * Get a cached terminal entry (no side effects).
   */
  get(terminalId: string): CachedTerminal | undefined {
    return this.cache.get(terminalId);
  }

  /**
   * Subscribe to status changes for a terminal.
   * Returns an unsubscribe function.
   */
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
}

// Export singleton
export const terminalCache = new TerminalCache();
