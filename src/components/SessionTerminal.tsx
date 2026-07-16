import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store";
import { type TerminalCacheStatus, terminalCache } from "../lib/terminal-cache";
import "@xterm/xterm/css/xterm.css";

interface ContextMenuState {
  x: number;
  y: number;
  hasSelection: boolean;
}

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
  const ctxMenuRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<TerminalCacheStatus>("connecting");
  const { terminalPrefs } = useStore();
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  // Cache selection text captured on right-click mousedown, before xterm.js
  // clears it.  The contextmenu handler and copy handler both read from here
  // so that "Copy" works reliably even when getSelection() returns empty by
  // the time the user clicks the menu item.
  const selectionCacheRef = useRef<string>("");

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
  }, [terminalId, sessionId, terminalPrefs]);

  // Cache selection text on right-click mousedown — xterm.js clears the
  // internal selection during mousedown processing, so by the time the
  // contextmenu event fires, getSelection() already returns empty.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 2) {
        const entry = terminalCache.get(terminalId);
        selectionCacheRef.current = entry?.terminal.getSelection() ?? "";
      } else {
        selectionCacheRef.current = "";
      }
    };
    container.addEventListener("mousedown", onMouseDown, true);
    return () => container.removeEventListener("mousedown", onMouseDown, true);
  }, [terminalId]);

  // Close context menu on outside mousedown / right-click elsewhere / scroll / Escape
  useEffect(() => {
    if (!ctxMenu) {
      selectionCacheRef.current = "";
      return;
    }
    const close = () => setCtxMenu(null);
    const handleMouseDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", handleMouseDown, true);
    window.addEventListener("contextmenu", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handleMouseDown, true);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // Use the selection cached on mousedown (button=2) — by the time the
    // contextmenu event fires xterm.js may have already cleared it.
    const hasSelection = !!selectionCacheRef.current;
    // Clamp to viewport so the menu never overflows off-screen
    const menuWidth = 180;
    const menuHeight = 160;
    const x =
      e.clientX + menuWidth > window.innerWidth
        ? Math.max(0, window.innerWidth - menuWidth - 10)
        : e.clientX;
    const y =
      e.clientY + menuHeight > window.innerHeight
        ? Math.max(0, window.innerHeight - menuHeight - 10)
        : e.clientY;
    setCtxMenu({ x, y, hasSelection });
  }, []);

  const handleCopy = useCallback(async () => {
    const entry = terminalCache.get(terminalId);
    if (!entry) {
      setCtxMenu(null);
      return;
    }
    // Prefer the selection cached on right-click mousedown — xterm.js may
    // have cleared it by now.  Fall back to the live selection in case the
    // user opened the menu via keyboard.
    const text = selectionCacheRef.current || entry.terminal.getSelection();
    if (text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Fallback: leave selection — user can still Ctrl+C
      }
    }
    setCtxMenu(null);
  }, [terminalId]);

  const handlePaste = useCallback(async () => {
    const entry = terminalCache.get(terminalId);
    if (!entry || entry.websocket?.readyState !== 1) {
      setCtxMenu(null);
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        // Delegate to xterm.js: it wraps the payload with bracketed-paste
        // sequences (\x1b[200~...\x1b[201~) and re-fires `onData`, so the
        // shell treats multi-line input as one paste instead of executing
        // each line immediately. Mirrors what Ctrl+Shift+V already does.
        entry.terminal.paste(text);
      }
    } catch {
      // Clipboard access denied — silently ignore
    }
    setCtxMenu(null);
  }, [terminalId]);

  const handleSelectAll = useCallback(() => {
    const entry = terminalCache.get(terminalId);
    entry?.terminal.selectAll();
    setCtxMenu(null);
  }, [terminalId]);

  const handleClearSelection = useCallback(() => {
    const entry = terminalCache.get(terminalId);
    entry?.terminal.clearSelection();
    setCtxMenu(null);
  }, [terminalId]);

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
        onContextMenu={handleContextMenu}
      />
      {ctxMenu && (
        <div ref={ctxMenuRef} className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button
            type="button"
            className="context-menu-item"
            onClick={handleCopy}
            disabled={!ctxMenu.hasSelection}
          >
            Copy
          </button>
          <button type="button" className="context-menu-item" onClick={handlePaste}>
            Paste
          </button>
          <div className="context-menu-separator" />
          <button type="button" className="context-menu-item" onClick={handleSelectAll}>
            Select All
          </button>
          <button type="button" className="context-menu-item" onClick={handleClearSelection}>
            Clear Selection
          </button>
        </div>
      )}
    </div>
  );
}
