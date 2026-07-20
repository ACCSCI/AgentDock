import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n/react";
import {
  queryKeys,
  useCreateTerminal,
  useDeleteTerminal,
  useRenameTerminal,
  useSessionTerminals,
} from "../lib/queries";
import { useStore } from "../lib/store";
import type { TerminalDefaultAction } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { SessionTerminal } from "./SessionTerminal";
import { TerminalSettingsBar } from "./TerminalSettingsBar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

interface TerminalManagerProps {
  sessionId: string;
  worktreePath: string;
}

const ACTION_ITEMS: {
  key: TerminalDefaultAction;
  label: string;
  icon: string;
  command?: string;
}[] = [
  { key: "terminal", label: "Terminal", icon: ">" },
  { key: "claude", label: "Claude", icon: "◆", command: "claude" },
  { key: "copilot", label: "Copilot", icon: "⟡", command: "copilot" },
];

export function TerminalManager({ sessionId, worktreePath }: TerminalManagerProps) {
  const { t } = useTranslation("terminal");
  const { setActiveTerminal, getActiveTerminal, terminalDefaultAction, setTerminalDefaultAction } =
    useStore();
  const activeTerminalId = getActiveTerminal(sessionId);
  const { data: terminals = [] } = useSessionTerminals(sessionId);
  const [loading, setLoading] = useState(false);
  const createTerminal = useCreateTerminal();
  const deleteTerminal = useDeleteTerminal();
  const renameTerminal = useRenameTerminal();
  const justCreatedRef = useRef<string | null>(null);

  // Rename state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Drag-and-drop reorder state
  const queryClient = useQueryClient();
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);
  const [dragOverTerminalId, setDragOverTerminalId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<"left" | "right">("right");
  const draggedIdRef = useRef<string | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // Reset localOrder when sessionId changes to prevent cross-session state pollution
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (sessionId !== prevSessionId) {
    setPrevSessionId(sessionId);
    setLocalOrder(null);
  }

  // Derived ordered list of terminals for rendering (no useEffect needed)
  const displayTerminals = useMemo(() => {
    if (!localOrder) return terminals;
    const terminalMap = new Map(terminals.map((term) => [term.terminalId, term]));
    const ordered = localOrder
      .map((id) => terminalMap.get(id))
      .filter((term): term is NonNullable<typeof term> => term != null);
    // Append any new terminals from the server that aren't in localOrder yet
    const localSet = new Set(localOrder);
    const added = terminals.filter((term) => !localSet.has(term.terminalId));
    return [...ordered, ...added];
  }, [terminals, localOrder]);

  // Auto-focus rename input
  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  // ── Add button (DropdownMenu — no hover timers needed) ──────────────────
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement)?.closest('[data-testid="new-terminal"]')) {
        setAddMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [addMenuOpen]);

  useEffect(() => {
    if (
      justCreatedRef.current &&
      terminals.find((term) => term.terminalId === justCreatedRef.current)
    ) {
      justCreatedRef.current = null;
    }
    const justCreated = justCreatedRef.current;
    const isJustCreatedActive = justCreated && activeTerminalId === justCreated;
    if (
      !isJustCreatedActive &&
      activeTerminalId &&
      !terminals.find((term) => term.terminalId === activeTerminalId)
    ) {
      setActiveTerminal(sessionId, null);
      return;
    }
    if (!activeTerminalId && terminals.length > 0) {
      const first = terminals.find((term) => term.status !== "exited") ?? terminals[0];
      setActiveTerminal(sessionId, first.terminalId);
    }
  }, [activeTerminalId, terminals, setActiveTerminal, sessionId]);

  // Create a new terminal
  const handleAddTerminal = useCallback(
    (action?: TerminalDefaultAction) => {
      createTerminalWithAction(action ?? terminalDefaultAction);
    },
    [createTerminalWithAction, terminalDefaultAction],
  );

  const isDefault = (key: TerminalDefaultAction) => terminalDefaultAction === key;

  // --- Tab actions ---

  const createTerminalWithAction = useCallback(
    async (action: TerminalDefaultAction) => {
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
          terminalCache.sendText(terminal.terminalId, `${cmd}\r`);
        }
      } catch (err) {
        alert(`${t("createFailed")}: ${err instanceof Error ? err.message : t("unknownError")}`);
      } finally {
        setLoading(false);
      }
    },
    [createTerminal, sessionId, setActiveTerminal, renameTerminal],
  );

  // --- Tab actions ---

  const handleCloseTerminal = async (terminalId: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    try {
      await deleteTerminal.mutateAsync(terminalId);
      terminalCache.dispose(terminalId);
      if (activeTerminalId === terminalId) {
        const remaining = terminals.filter(
          (term) => term.terminalId !== terminalId && term.status !== "exited",
        );
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

  const handleStartRename = useCallback(
    (terminalId: string) => {
      const terminal = terminals.find((term) => term.terminalId === terminalId);
      if (!terminal) return;
      setEditValue(terminal.name);
      setEditingId(terminalId);
    },
    [terminals],
  );

  const handleConfirmRename = useCallback(() => {
    if (!editingId) return;
    const trimmed = editValue.trim();
    const terminal = terminals.find((term) => term.terminalId === editingId);
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

  // --- Drag-and-drop reorder handlers ---

  const handleDragStart = useCallback((terminalId: string) => {
    draggedIdRef.current = terminalId;
    setDragActive(true);
  }, []);

  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDragOverTerminalId(null);
    setDragActive(false);
  }, []);

  const handleTabDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>, terminalId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (terminalId === draggedIdRef.current) return;
      const target = e.currentTarget;
      const rect = target.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const nextPosition = e.clientX < midX ? "left" : "right";
      // Only re-render when target or position actually changes
      setDragOverTerminalId((prev) => (prev !== terminalId ? terminalId : prev));
      setDragPosition((prev) => (prev !== nextPosition ? nextPosition : prev));
    },
    [],
  );

  const handleTabDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // Only clear if actually leaving the tab (not entering a child)
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverTerminalId(null);
    }
  }, []);

  const handleTabDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>, targetId: string) => {
      e.preventDefault();
      e.stopPropagation();
      const draggedId = draggedIdRef.current;
      if (!draggedId || draggedId === targetId) {
        setDragOverTerminalId(null);
        return;
      }

      const currentOrder = displayTerminals.map((term) => term.terminalId);
      if (!currentOrder.includes(draggedId) || !currentOrder.includes(targetId)) {
        setDragOverTerminalId(null);
        return;
      }

      const next = currentOrder.filter((id) => id !== draggedId);
      let insertAt = next.indexOf(targetId);
      if (dragPosition === "right") insertAt += 1;
      next.splice(insertAt, 0, draggedId);

      setLocalOrder(next);

      // Update React Query cache (side effect outside state updater)
      const terminalMap = new Map(terminals.map((term) => [term.terminalId, term]));
      const reordered = next
        .map((id) => terminalMap.get(id))
        .filter((term): term is NonNullable<typeof term> => term != null);
      queryClient.setQueryData(queryKeys.terminals(sessionId), reordered);

      setDragOverTerminalId(null);
      setDragActive(false);
      draggedIdRef.current = null;
    },
    [displayTerminals, terminals, sessionId, dragPosition, queryClient],
  );

  const activeTerminal = terminals.find((term) => term.terminalId === activeTerminalId);

  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-testid="terminal-panel">
      {/* Terminal font settings bar */}
      <TerminalSettingsBar />

      {/* Terminal tab bar */}
      <div
        className={`flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-secondary px-1 ${dragActive ? "bg-muted" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={() => {
          setDragOverTerminalId(null);
          setDragActive(false);
          draggedIdRef.current = null;
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverTerminalId(null);
        }}
      >
        {displayTerminals.map((term) => (
          <ContextMenu key={term.terminalId}>
            <ContextMenuTrigger asChild>
              <div
                className={[
                  "flex h-7 min-w-[80px] max-w-[220px] items-center gap-1.5 rounded-sm border px-2.5 py-1 text-xs transition-colors select-none cursor-pointer",
                  term.terminalId === activeTerminalId
                    ? "border-primary bg-card"
                    : "border-border bg-secondary hover:bg-muted",
                  term.status === "exited" ? "opacity-50" : "",
                  draggedIdRef.current === term.terminalId ? "opacity-40" : "",
                  dragOverTerminalId === term.terminalId
                    ? dragPosition === "left"
                      ? "border-l-2 border-l-primary pl-2"
                      : "border-r-2 border-r-primary pr-2"
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                draggable={true}
                onDragStart={() => handleDragStart(term.terminalId)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleTabDragOver(e, term.terminalId)}
                onDragLeave={handleTabDragLeave}
                onDrop={(e) => handleTabDrop(e, term.terminalId)}
                data-testid="terminal-tab"
                data-terminal-id={term.terminalId}
              >
                {editingId === term.terminalId ? (
                  <input
                    ref={inputRef}
                    className="w-20 rounded-sm border border-primary bg-background px-1 py-0.5 text-xs text-primary outline-none"
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleConfirmRename}
                    onKeyDown={handleRenameKeyDown}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 self-stretch border-0 bg-transparent text-inherit"
                    aria-current={term.terminalId === activeTerminalId ? "page" : undefined}
                    onClick={() => handleTabClick(term.terminalId)}
                  >
                    <span
                      className={`shrink-0 text-[8px] ${term.status === "exited" ? "text-muted-foreground" : "text-success"}`}
                      aria-hidden="true"
                    >
                      {term.status === "exited" ? "○" : "●"}
                    </span>
                    <span className="truncate">{term.name}</span>
                  </button>
                )}
                <button
                  type="button"
                  className="terminal-tab-close shrink-0 cursor-pointer rounded border-0 bg-transparent px-0.5 text-[10px] leading-none text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
                  onClick={(e) => handleCloseTerminal(term.terminalId, e)}
                  title={t("closeTerminal")}
                  aria-label={`${t("closeTerminal")} ${term.name}`}
                >
                  ✕
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => handleStartRename(term.terminalId)}>
                {t("rename")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                variant="destructive"
                onSelect={() => handleCloseTerminal(term.terminalId)}
              >
                {t("closeTerminal")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}

        {/* "+" button — DropdownMenu for keyboard-accessible menu */}
        <DropdownMenu open={addMenuOpen} onOpenChange={setAddMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex size-6.5 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-dashed border-border bg-transparent text-sm text-primary transition-colors hover:border-primary hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-50"
              disabled={loading || createTerminal.isPending}
              title={`New ${ACTION_ITEMS.find((a) => a.key === terminalDefaultAction)?.label ?? "Terminal"}`}
              data-testid="new-terminal"
            >
              +
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4} className="min-w-[160px]">
            {ACTION_ITEMS.map((item) => (
              <DropdownMenuItem
                key={item.key}
                className="cursor-pointer"
                onClick={() => handleAddTerminal(item.key)}
              >
                <span className="w-4 shrink-0 text-center text-xs text-muted-foreground">
                  {item.key === "terminal" ? (
                    <ChevronRight aria-hidden="true" className="inline size-3" />
                  ) : (
                    item.icon
                  )}
                </span>
                <span className="flex-1">{item.label}</span>
                {isDefault(item.key) && (
                  <span className="ml-2 text-[10px] text-muted-foreground opacity-60">默认</span>
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Terminal content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {activeTerminal ? (
          <SessionTerminal
            terminalId={activeTerminal.terminalId}
            sessionId={sessionId}
            worktreePath={worktreePath}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
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
