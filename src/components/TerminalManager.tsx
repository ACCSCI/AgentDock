import { useCallback, useEffect, useRef, useState } from "react";
import { useCreateTerminal, useDeleteTerminal, useRenameTerminal, useSessionTerminals } from "../lib/queries";
import { useStore } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { SessionTerminal } from "./SessionTerminal";

interface TerminalManagerProps {
  sessionId: string;
  worktreePath: string;
}

interface MenuState {
  x: number;
  y: number;
  terminalId: string;
}

export function TerminalManager({ sessionId, worktreePath }: TerminalManagerProps) {
  const { setActiveTerminal, getActiveTerminal } = useStore();
  const activeTerminalId = getActiveTerminal(sessionId);
  const { data: terminals = [] } = useSessionTerminals(sessionId);
  const [loading, setLoading] = useState(false);
  const createTerminal = useCreateTerminal();
  const deleteTerminal = useDeleteTerminal();
  const renameTerminal = useRenameTerminal();
  const justCreatedRef = useRef<string | null>(null);

  // Context menu state
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus rename input
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // Close context menu on outside click
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [menu]);

  // If active terminal no longer exists, clear it
  useEffect(() => {
    const justCreated = justCreatedRef.current;
    if (justCreated && activeTerminalId === justCreated) return;
    if (activeTerminalId && !terminals.find((t) => t.terminalId === activeTerminalId)) {
      setActiveTerminal(sessionId, null);
    }
  }, [activeTerminalId, terminals, setActiveTerminal, sessionId]);

  // Clear the just-created ref once the terminal appears in the query data
  useEffect(() => {
    if (justCreatedRef.current && terminals.find((t) => t.terminalId === justCreatedRef.current)) {
      justCreatedRef.current = null;
    }
  }, [terminals]);

  // Auto-select first terminal if none selected
  useEffect(() => {
    if (!activeTerminalId && terminals.length > 0) {
      const first = terminals.find((t) => t.status !== "exited") ?? terminals[0];
      setActiveTerminal(sessionId, first.terminalId);
    }
  }, [activeTerminalId, terminals, setActiveTerminal, sessionId]);

  const handleNewTerminal = async () => {
    setLoading(true);
    try {
      const terminal = await createTerminal.mutateAsync({ sessionId });
      justCreatedRef.current = terminal.terminalId;
      setActiveTerminal(sessionId, terminal.terminalId);
    } catch (err) {
      alert(`Failed to create terminal: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  const handleCloseTerminal = async (terminalId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await deleteTerminal.mutateAsync(terminalId);
      terminalCache.dispose(terminalId);
      if (activeTerminalId === terminalId) {
        const remaining = terminals.filter((t) => t.terminalId !== terminalId && t.status !== "exited");
        setActiveTerminal(sessionId, remaining.length > 0 ? remaining[0].terminalId : null);
      }
    } catch {
      // ignore
    }
  };

  const handleTabClick = (terminalId: string) => {
    if (editingId) return; // don't switch tab while renaming
    setActiveTerminal(sessionId, terminalId);
  };

  const handleContextMenu = (e: React.MouseEvent, terminalId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, terminalId });
  };

  const handleStartRename = useCallback((terminalId: string) => {
    const terminal = terminals.find((t) => t.terminalId === terminalId);
    if (!terminal) return;
    setMenu(null);
    setEditValue(terminal.name);
    setEditingId(terminalId);
  }, [terminals]);

  const handleConfirmRename = useCallback(() => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    const terminal = terminals.find((t) => t.terminalId === editingId);
    if (trimmed && terminal && trimmed !== terminal.name) {
      renameTerminal.mutateAsync({ terminalId: editingId, name: trimmed });
    }
    setEditingId(null);
  }, [editingId, editValue, terminals, renameTerminal]);

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleConfirmRename();
    } else if (e.key === "Escape") {
      setEditingId(null);
    }
  };

  const activeTerminal = terminals.find((t) => t.terminalId === activeTerminalId);

  return (
    <div className="terminal-panel">
      {/* Terminal tab bar */}
      <div className="terminal-tab-bar">
        {terminals.map((t) => (
          <div
            key={t.terminalId}
            className={`terminal-tab ${t.terminalId === activeTerminalId ? "terminal-tab-active" : ""} ${t.status === "exited" ? "terminal-tab-exited" : ""}`}
            onClick={() => handleTabClick(t.terminalId)}
            onContextMenu={(e) => handleContextMenu(e, t.terminalId)}
            onKeyDown={(e) => { if (e.key === "Enter") handleTabClick(t.terminalId); }}
            tabIndex={0}
            role="tab"
            aria-selected={t.terminalId === activeTerminalId}
          >
            <span className="terminal-tab-icon">
              {t.status === "exited" ? "○" : "●"}
            </span>
            {editingId === t.terminalId ? (
              <input
                ref={inputRef}
                className="terminal-rename-input"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleConfirmRename}
                onKeyDown={handleRenameKeyDown}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="terminal-tab-name">{t.name}</span>
            )}
            <button
              type="button"
              className="terminal-tab-close"
              onClick={(e) => handleCloseTerminal(t.terminalId, e)}
              title="Close terminal"
            >
              x
            </button>
          </div>
        ))}
        <button
          type="button"
          className="terminal-tab-add"
          onClick={handleNewTerminal}
          disabled={loading || createTerminal.isPending}
          title="New Terminal"
        >
          +
        </button>
      </div>

      {/* Context menu */}
      {menu && (
        <div
          className="terminal-context-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          <div
            className="terminal-context-menu-item"
            onClick={() => handleStartRename(menu.terminalId)}
          >
            Rename
          </div>
          <div
            className="terminal-context-menu-item terminal-context-menu-item-danger"
            onClick={() => { setMenu(null); handleCloseTerminal(menu.terminalId); }}
          >
            Close
          </div>
        </div>
      )}

      {/* Terminal content */}
      <div className="terminal-content">
        {activeTerminal ? (
          <SessionTerminal
            terminalId={activeTerminal.terminalId}
            sessionId={sessionId}
            worktreePath={worktreePath}
          />
        ) : (
          <div className="terminal-empty">
            <p>No terminal active.</p>
            <p>
              Click <strong>+</strong> to create a new terminal.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
