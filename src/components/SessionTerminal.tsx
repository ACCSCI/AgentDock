import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface SessionTerminalProps {
  terminalId: string;
  worktreePath: string;
}

type TerminalStatus = "connecting" | "connected" | "disconnected" | "error";

function debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T & { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: unknown[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => { if (timer) clearTimeout(timer); };
  return debounced as T & { cancel: () => void };
}

/**
 * SessionTerminal — renders a single terminal instance.
 *
 * Uses terminalId (not sessionId) for PTY identification.
 * Supports auto-reconnect with exponential backoff.
 * Uses ResizeObserver with debounce for stable resize sync.
 */
export function SessionTerminal({ terminalId }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const wasConnectedRef = useRef(false);
  const unmountedRef = useRef(false);
  const [status, setStatus] = useState<TerminalStatus>("connecting");

  // ---- Debounced resize: single trigger source via ResizeObserver ----
  const debouncedResizeRef = useRef<ReturnType<typeof debounce> | null>(null);

  // ---- Close a WebSocket safely (avoid "closed before established" warning) ----
  const closeWs = useCallback((ws: WebSocket | null) => {
    if (!ws) return;
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    if (ws.readyState === WebSocket.CONNECTING) {
      // Closing a still-connecting socket triggers a browser warning.
      // Defer the close until the handshake completes.
      ws.onopen = () => ws.close();
    } else {
      ws.onopen = null;
      ws.close();
    }
  }, []);

  // ---- WebSocket connection with auto-reconnect ----
  const connect = useCallback(() => {
    if (unmountedRef.current) return;
    closeWs(wsRef.current);

    setStatus("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/terminal?terminalId=${encodeURIComponent(terminalId)}`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      reconnectAttemptRef.current = 0;
      wasConnectedRef.current = true;
      console.log(`[SessionTerminal] WebSocket opened for ${terminalId}`);
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const terminal = terminalRef.current;
        if (!terminal) return;

        switch (msg.type) {
          case "output":
            terminal.write(msg.data);
            break;
          case "opened":
            setStatus("connected");
            // Send initial resize after connection established
            safeFit();
            console.log(`[SessionTerminal] Terminal ${terminalId} opened (pid=${msg.pid}, status=${msg.status})`);
            break;
          case "exit":
            terminal.writeln(`\r\n\x1b[33m[Process exited code=${msg.code}]\x1b[0m`);
            setStatus("disconnected");
            break;
          case "error":
            terminal.writeln(`\r\n\x1b[31m[Error] ${msg.message}\x1b[0m`);
            setStatus("error");
            break;
          case "heartbeat_ack":
            break;
        }
      } catch {
        // Non-JSON message, ignore
      }
    };

    ws.onclose = () => {
      if (unmountedRef.current) return;
      console.log(`[SessionTerminal] WebSocket closed for ${terminalId}`);
      setStatus((s) => (s === "connected" || s === "connecting") ? "disconnected" : s);

      // Auto-reconnect with exponential backoff (only if we were previously connected)
      if (wasConnectedRef.current && !unmountedRef.current) {
        wasConnectedRef.current = false;
        const attempt = reconnectAttemptRef.current;
        const delay = Math.min(1000 * 2 ** attempt, 30000);
        reconnectAttemptRef.current = attempt + 1;
        console.log(`[SessionTerminal] Reconnecting in ${delay}ms (attempt ${attempt + 1})`);
        reconnectTimerRef.current = setTimeout(connect, delay);
      }
    };

    ws.onerror = () => {
      // onclose will handle reconnection
    };
  }, [terminalId, closeWs]);

  // ---- Safe fit helper ----
  const safeFit = useCallback(() => {
    const fit = fitAddonRef.current;
    const term = terminalRef.current;
    const container = containerRef.current;
    if (!fit || !term || !container) return;
    // Container with zero size means xterm's renderer is not ready yet;
    // calling fit() would read `undefined.dimensions` inside RenderService.
    if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
    try {
      fit.fit();
    } catch {
      // xterm renderer not ready
    }
  }, []);

  // ---- Initialize xterm + WS on mount ----
  useEffect(() => {
    unmountedRef.current = false;
    wasConnectedRef.current = false;
    reconnectAttemptRef.current = 0;
    const container = containerRef.current;
    if (!container) return;

    // Create xterm instance
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
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
    });
    terminalRef.current = terminal;

    // Install FitAddon
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    fitAddonRef.current = fitAddon;

    // Mount to DOM
    terminal.open(container);

    // Initial fit with requestAnimationFrame loop until renderer ready
    let rafId: number;
    function attemptFit() {
      try {
        fitAddon.fit();
      } catch {
        rafId = requestAnimationFrame(attemptFit);
        return;
      }
      // After first successful fit, send resize to backend
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
      }
    }
    rafId = requestAnimationFrame(attemptFit);

    terminal.writeln(`\x1b[90mConnecting to terminal ${terminalId}...\x1b[0m`);

    // Create debounced resize function (single trigger source)
    const sendResize = debounce((cols: number, rows: number) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    }, 100);
    debouncedResizeRef.current = sendResize;

    // ResizeObserver: single source of truth for resize sync
    const observer = new ResizeObserver(() => {
      const term = terminalRef.current;
      const fit = fitAddonRef.current;
      if (!term || !fit) return;
      try {
        fit.fit();
        sendResize(term.cols, term.rows);
      } catch { /* ignore */ }
    });
    observer.observe(container);
    resizeObserverRef.current = observer;

    // Connect WebSocket
    connect();

    // User input → WebSocket
    terminal.onData((data) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Note: terminal.onResize removed — ResizeObserver is the single resize trigger

    // Cleanup
    return () => {
      unmountedRef.current = true;
      cancelAnimationFrame(rafId);
      sendResize.cancel();
      observer.disconnect();
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      closeWs(wsRef.current);
      wsRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      resizeObserverRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, connect, closeWs]);

  return (
    <div className="session-terminal">
      {status !== "connected" && (
        <div className={`session-terminal-overlay ${status}`}>
          {status === "connecting" && "Connecting..."}
          {status === "disconnected" && "Disconnected — Click + to reconnect"}
          {status === "error" && "Connection error"}
        </div>
      )}
      <div ref={containerRef} className="session-terminal-xterm" />
    </div>
  );
}
