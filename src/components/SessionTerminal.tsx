import { useEffect, useRef, useState } from "react";
import { terminalCache, type TerminalCacheStatus } from "../lib/terminal-cache";
import { useStore } from "../lib/store";
import "@xterm/xterm/css/xterm.css";

interface SessionTerminalProps {
  terminalId: string;
  sessionId: string;
  worktreePath: string;
}

/**
 * SessionTerminal — thin shell that delegates terminal lifecycle to terminalCache.
 *
 * The cache owns the Terminal instance, WebSocket, and ResizeObserver.
 * This component only manages DOM attachment and status display.
 */
export function SessionTerminal({ terminalId, sessionId }: SessionTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalCacheStatus>("connecting");
  const { terminalPrefs } = useStore();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Get or create cached terminal (creates WS connection if new)
    const entry = terminalCache.getOrCreate(terminalId, sessionId, terminalPrefs);

    // Attach terminal DOM to this container
    terminalCache.attach(terminalId, container);

    // Sync status from cache to React state
    const unsub = terminalCache.onStatusChange(terminalId, setStatus);
    setStatus(entry.status);

    return () => {
      unsub();
      terminalCache.detach(terminalId);
    };
  }, [terminalId, sessionId]);

  return (
    <div className="session-terminal" data-testid="session-terminal" data-status={status}>
      {status !== "connected" && (
        <div className={`session-terminal-overlay ${status}`}>
          {status === "connecting" && "Connecting..."}
          {status === "disconnected" && "Disconnected — Click + to reconnect"}
          {status === "error" && "Connection error"}
          {status === "exited" && "Process exited"}
        </div>
      )}
      <div
        ref={containerRef}
        className="session-terminal-xterm"
        data-testid="terminal-xterm"
      />
    </div>
  );
}
