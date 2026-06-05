import { useCallback, useEffect, useState } from "react";
import { useCreateTerminal, useDeleteTerminal, type TerminalData } from "../lib/queries";
import { useStore } from "../lib/store";
import { SessionTerminal } from "./SessionTerminal";

interface TerminalManagerProps {
  sessionId: string;
  worktreePath: string;
}

export function TerminalManager({ sessionId, worktreePath }: TerminalManagerProps) {
  const { setActiveTerminal, getActiveTerminal } = useStore();
  const activeTerminalId = getActiveTerminal(sessionId);
  const [terminals, setTerminals] = useState<TerminalData[]>([]);
  const [loading, setLoading] = useState(false);
  const createTerminal = useCreateTerminal();
  const deleteTerminal = useDeleteTerminal();

  // Fetch terminal list for this session
  const fetchTerminals = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/terminals`);
      const data = await res.json();
      if (data.success) {
        setTerminals(data.terminals);
        // If active terminal no longer exists, clear it
        if (activeTerminalId && !data.terminals.find((t: TerminalData) => t.terminalId === activeTerminalId)) {
          setActiveTerminal(sessionId, null);
        }
      }
    } catch {
      // ignore
    }
  }, [sessionId, activeTerminalId, setActiveTerminal]);

  useEffect(() => {
    fetchTerminals();
  }, [fetchTerminals]);

  // Poll terminal status every 3s (for exited detection)
  useEffect(() => {
    const timer = setInterval(fetchTerminals, 3000);
    return () => clearInterval(timer);
  }, [fetchTerminals]);

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
      setTerminals((prev) => [...prev, terminal]);
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
      setTerminals((prev) => prev.filter((t) => t.terminalId !== terminalId));
      if (activeTerminalId === terminalId) {
        const remaining = terminals.filter((t) => t.terminalId !== terminalId && t.status !== "exited");
        setActiveTerminal(sessionId, remaining.length > 0 ? remaining[0].terminalId : null);
      }
    } catch {
      // ignore
    }
  };

  const handleTabClick = (terminalId: string) => {
    setActiveTerminal(sessionId, terminalId);
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
            onKeyDown={(e) => { if (e.key === "Enter") handleTabClick(t.terminalId); }}
            tabIndex={0}
            role="tab"
            aria-selected={t.terminalId === activeTerminalId}
          >
            <span className="terminal-tab-icon">
              {t.status === "exited" ? "○" : "●"}
            </span>
            <span className="terminal-tab-name">{t.shell}</span>
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

      {/* Terminal content */}
      <div className="terminal-content">
        {activeTerminal ? (
          <SessionTerminal
            key={activeTerminal.terminalId}
            terminalId={activeTerminal.terminalId}
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
