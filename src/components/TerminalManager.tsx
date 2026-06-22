import { useCallback, useEffect, useRef, useState } from "react";
import { useCreateTerminal, useDeleteTerminal, useRenameTerminal, useSessionTerminals } from "../lib/queries";
import { useStore } from "../lib/store";
import type { TerminalDefaultAction } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { SessionTerminal } from "./SessionTerminal";
import { TerminalSettingsBar } from "./TerminalSettingsBar";

interface TerminalManagerProps {
  sessionId: string;
  worktreePath: string;
}

interface MenuState {
  x: number;
  y: number;
  terminalId: string;
}

const ACTION_ITEMS: { key: TerminalDefaultAction; label: string; icon: string; command?: string }[] = [
  { key: "terminal", label: "Terminal", icon: ">" },
  { key: "claude", label: "Claude", icon: "◆", command: "claude" },
  { key: "copilot", label: "Copilot", icon: "⟡", command: "copilot" },
];

export function TerminalManager({ sessionId, worktreePath }: TerminalManagerProps) {
  const { setActiveTerminal, getActiveTerminal, terminalDefaultAction, setTerminalDefaultAction } = useStore();
  const activeTerminalId = getActiveTerminal(sessionId);
  const { data: terminals = [] } = useSessionTerminals(sessionId);
  const [loading, setLoading] = useState(false);
  const createTerminal = useCreateTerminal();
  const deleteTerminal = useDeleteTerminal();
  const renameTerminal = useRenameTerminal();
  const justCreatedRef = useRef<string | null>(null);

  // Context menu state (right-click on tab)
  const [menu, setMenu] = useState<MenuState | null>(null);

  // Hover dropdown state for the "+" button
  const [showAddMenu, setShowAddMenu] = useState(false);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addHoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const addLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Close context menu on outside click / right-click elsewhere / Escape
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Close add menu on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const close = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [showAddMenu]);

  // Clean up hover timers on unmount
  useEffect(() => {
    return () => {
      if (addHoverTimer.current) clearTimeout(addHoverTimer.current);
      if (addLeaveTimer.current) clearTimeout(addLeaveTimer.current);
    };
  }, []);

  // Single effect for terminal selection
  useEffect(() => {
    if (justCreatedRef.current && terminals.find((t) => t.terminalId === justCreatedRef.current)) {
      justCreatedRef.current = null;
    }
    const justCreated = justCreatedRef.current;
    const isJustCreatedActive = justCreated && activeTerminalId === justCreated;
    if (!isJustCreatedActive && activeTerminalId && !terminals.find((t) => t.terminalId === activeTerminalId)) {
      setActiveTerminal(sessionId, null);
      return;
    }
    if (!activeTerminalId && terminals.length > 0) {
      const first = terminals.find((t) => t.status !== "exited") ?? terminals[0];
      setActiveTerminal(sessionId, first.terminalId);
    }
  }, [activeTerminalId, terminals, setActiveTerminal, sessionId]);

  // --- Add button hover handlers ---

  const handleAddEnter = useCallback(() => {
    if (addLeaveTimer.current) {
      clearTimeout(addLeaveTimer.current);
      addLeaveTimer.current = null;
    }
    addHoverTimer.current = setTimeout(() => setShowAddMenu(true), 250);
  }, []);

  const handleAddLeave = useCallback(() => {
    if (addHoverTimer.current) {
      clearTimeout(addHoverTimer.current);
      addHoverTimer.current = null;
    }
    addLeaveTimer.current = setTimeout(() => setShowAddMenu(false), 200);
  }, []);

  // --- Terminal creation ---

  const createTerminalWithAction = useCallback(async (action: TerminalDefaultAction) => {
    setLoading(true);
    try {
      const terminal = await createTerminal.mutateAsync({ sessionId });
      justCreatedRef.current = terminal.terminalId;
      setActiveTerminal(sessionId, terminal.terminalId);

      // Auto-rename tab based on action
      if (action !== "terminal") {
        const label = ACTION_ITEMS.find((a) => a.key === action)?.label ?? action;
        renameTerminal.mutateAsync({ terminalId: terminal.terminalId, name: label });
      }

      // Inject command for claude/copilot (\r = Enter key on Windows terminal)
      const cmd = ACTION_ITEMS.find((a) => a.key === action)?.command;
      if (cmd) {
        terminalCache.sendText(terminal.terminalId, cmd + "\r");
      }
    } catch (err) {
      alert(`Failed to create terminal: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  }, [createTerminal, sessionId, setActiveTerminal, renameTerminal]);

  const handleAddClick = useCallback(() => {
    // Clean up any pending hover timers
    if (addHoverTimer.current) { clearTimeout(addHoverTimer.current); addHoverTimer.current = null; }
    if (addLeaveTimer.current) { clearTimeout(addLeaveTimer.current); addLeaveTimer.current = null; }
    setShowAddMenu(false);
    createTerminalWithAction(terminalDefaultAction);
  }, [createTerminalWithAction, terminalDefaultAction]);

  const handleMenuItemClick = useCallback((action: TerminalDefaultAction) => {
    setShowAddMenu(false);
    createTerminalWithAction(action);
  }, [createTerminalWithAction]);

  const handlePin = useCallback((action: TerminalDefaultAction, e: React.MouseEvent) => {
    e.stopPropagation();
    setTerminalDefaultAction(action);
  }, [setTerminalDefaultAction]);

  // --- Tab actions ---

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
    if (editingId) return;
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
  const isDefault = (key: TerminalDefaultAction) => terminalDefaultAction === key;

  return (
    <div className="terminal-panel" data-testid="terminal-panel">
      {/* Terminal font settings bar */}
      <TerminalSettingsBar />

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
            data-testid="terminal-tab"
            data-terminal-id={t.terminalId}
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

        {/* "+" button with hover dropdown */}
        <div
          ref={addMenuRef}
          className="terminal-add-wrapper"
          onMouseEnter={handleAddEnter}
          onMouseLeave={handleAddLeave}
        >
          <button
            type="button"
            className="terminal-tab-add"
            onClick={handleAddClick}
            disabled={loading || createTerminal.isPending}
            title={`New ${ACTION_ITEMS.find((a) => a.key === terminalDefaultAction)?.label ?? "Terminal"}`}
            data-testid="new-terminal"
          >
            +
          </button>

          {showAddMenu && (
            <div className="terminal-add-dropdown">
              {ACTION_ITEMS.map((item) => (
                <div
                  key={item.key}
                  className={`terminal-add-dropdown-item ${isDefault(item.key) ? "terminal-add-dropdown-item-default" : ""}`}
                  onClick={() => handleMenuItemClick(item.key)}
                >
                  <span className="terminal-add-dropdown-icon">{item.icon}</span>
                  <span className="terminal-add-dropdown-label">{item.label}</span>
                  <button
                    type="button"
                    className={`terminal-add-dropdown-pin ${isDefault(item.key) ? "terminal-add-dropdown-pin-active" : ""}`}
                    onClick={(e) => handlePin(item.key, e)}
                    title={isDefault(item.key) ? "Default action" : "Set as default"}
                  >
                    <span className="pin-icon" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Context menu (right-click on tab) */}
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
