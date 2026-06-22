import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchSessionTerminals, queryKeys, useCreateSessionSSE, useDeleteSessionSSE, useProjects, useReassignPorts, useRenameSession, useReorderSessions, useRetryHook, useV2Projects } from "../lib/queries";
import { useStore, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { toast } from "../lib/toast";
import { SessionCard } from "./SessionCard";

export function SessionSidebar() {
  const { activeProjectId, activeSessionId, setActiveSession, sidebarCollapsed, toggleSidebar, sidebarWidth, setSidebarWidth } = useStore();

  // F11b: Use v2State hook with fallback to old polling
  const { data: v2Projects, isV2: isV2Data } = useV2Projects();
  const { data: oldProjects } = useProjects();

  // Prefer v2State data if available, otherwise use old polling
  const projects = isV2Data ? v2Projects : oldProjects;
  const queryClient = useQueryClient();
  const createSession = useCreateSessionSSE();
  const deleteSession = useDeleteSessionSSE();
  const renameSession = useRenameSession();
  const reassignPorts = useReassignPorts();
  const retryHook = useRetryHook();
  const reorderSessions = useReorderSessions();

  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<"before" | "after">("after");
  const draggedIdRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [foreignOpen, setForeignOpen] = useState(false);
  const handleRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startWidth = sidebarWidthRef.current;

    const cleanup = () => {
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", cleanup);
      el.removeEventListener("pointercancel", cleanup);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", cleanup);
    el.addEventListener("pointercancel", cleanup);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, [setSidebarWidth]);

  const activeProject = projects?.find((p) => p.id === activeProjectId);
  const sessions = activeProject?.sessions ?? [];

  // Memoize the ordered list of visible (non-foreign) session IDs for stable sorting
  const visibleSessionIds = useMemo(() => {
    return sessions
      .filter((s) => s.status !== "foreign")
      .map((s) => s.id);
  }, [sessions]);

  // Sorted sessions: maintain a local order array that follows the returned order
  const [localOrder, setLocalOrder] = useState<string[] | null>(null);

  // Keep localOrder in sync with server data
  useEffect(() => {
    setLocalOrder((prev) => {
      if (!prev) return visibleSessionIds;
      const existingSet = new Set(prev);
      const currentSet = new Set(visibleSessionIds);
      const pruned = prev.filter((id) => currentSet.has(id));
      const added = visibleSessionIds.filter((id) => !existingSet.has(id));
      if (pruned.length !== prev.length || added.length > 0) {
        return [...pruned, ...added];
      }
      return prev;
    });
  }, [visibleSessionIds]);

  const sortedVisibleSessions = useMemo(() => {
    const order = localOrder ?? visibleSessionIds;
    const sessionMap = new Map(sessions.map((s) => [s.id, s]));
    return order
      .map((id) => sessionMap.get(id))
      .filter((s): s is NonNullable<typeof s> => s != null && s.status !== "foreign");
  }, [sessions, localOrder, visibleSessionIds]);

  const foreignSessions = useMemo(() => {
    return sessions.filter((s) => s.status === "foreign");
  }, [sessions]);

  const handleDragStart = useCallback((sessionId: string) => {
    draggedIdRef.current = sessionId;
  }, []);

  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDragOverSessionId(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const target = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
    if (!target) return;
    const sessionId = target.dataset.sessionId;
    if (!sessionId || sessionId === draggedIdRef.current) return;
    const rect = target.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    setDragOverSessionId(sessionId);
    setDragPosition(e.clientY < midY ? "before" : "after");
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOverSessionId(null);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const draggedId = draggedIdRef.current;
      if (!draggedId || !activeProject) {
        setDragOverSessionId(null);
        return;
      }
      const target = (e.target as HTMLElement).closest("[data-session-id]") as HTMLElement | null;
      if (!target) { setDragOverSessionId(null); return; }
      const targetId = target.dataset.sessionId;
      if (!targetId || targetId === draggedId) { setDragOverSessionId(null); return; }

      setLocalOrder((prevOrder) => {
        const order = prevOrder ?? visibleSessionIds;
        if (!order.includes(draggedId) || !order.includes(targetId)) return order;
        const next = order.filter((id) => id !== draggedId);
        let insertAt = next.indexOf(targetId);
        if (dragPosition === "after") insertAt += 1;
        next.splice(insertAt, 0, draggedId);
        reorderSessions.mutateAsync({ projectId: activeProject.id, sessionIds: next })
          .catch(() => setLocalOrder(null));
        return next;
      });
      setDragOverSessionId(null);
    },
    [activeProject, visibleSessionIds, reorderSessions, dragPosition],
  );

  const prefetchTerminals = (sessionId: string) => {
    queryClient.prefetchQuery({
      queryKey: queryKeys.terminals(sessionId),
      queryFn: () => fetchSessionTerminals(sessionId),
      staleTime: 5000,
    });
  };

  const handleNewSession = async () => {
    if (!activeProject) return;
    const existingNames = new Set(sessions.map((s) => s.name));
    let count = sessions.length + 1;
    while (existingNames.has(`Session ${count}`)) count++;
    try {
      await createSession.mutateAsync({
        projectId: activeProject.id,
        name: `Session ${count}`,
        tempId: `temp-${Date.now()}`,
      });
    } catch (err) {
      console.error("Failed to create session:", err);
      toast.error(`创建失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!activeProject) return;
    try {
      await deleteSession.mutateAsync({ sessionId, projectId: activeProject.id });
      terminalCache.disposeBySession(sessionId);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      await renameSession.mutateAsync({ sessionId, name: newName });
    } catch (err) {
      console.error("Failed to rename session:", err);
      toast.error(`重命名失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleOpenInExplorer = async (worktreePath: string) => {
    try {
      await window.api.shell.openExplorer(worktreePath);
    } catch {
      navigator.clipboard.writeText(worktreePath);
    }
  };

  const handleOpenInTerminal = async (worktreePath: string) => {
    try {
      await window.api.shell.openTerminal(worktreePath);
    } catch {
      navigator.clipboard.writeText(worktreePath);
    }
  };

  const handleReassignPorts = async (sessionId: string) => {
    try {
      await reassignPorts.mutateAsync(sessionId);
    } catch (err) {
      console.error("Failed to reassign ports:", err);
      toast.error(`重新分配端口失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleRetryHooks = async (sessionId: string) => {
    try {
      await retryHook.mutateAsync(sessionId);
    } catch (err) {
      console.error("Failed to retry hooks:", err);
      toast.error(`重试失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  if (!activeProject) return null;

  if (sidebarCollapsed) {
    return (
      <div className="session-sidebar session-sidebar-collapsed">
        <button type="button" className="session-sidebar-expand-btn" onClick={toggleSidebar} title="展开 Session 侧栏">▶</button>
      </div>
    );
  }

  return (
    <div className="session-sidebar" style={{ width: sidebarWidth }} data-testid="session-sidebar">
      <div className="session-sidebar-header">
        <span className="session-sidebar-title">Sessions</span>
        <button type="button" className="session-sidebar-collapse-btn" onClick={toggleSidebar} title="收起侧栏">◀</button>
      </div>
      <div
        ref={listRef}
        className={`session-list ${dragOverSessionId ? "drag-active" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {sortedVisibleSessions.map((session) => (
          <div
            key={session.id}
            data-session-id={session.id}
            data-testid="session-card"
            className={
              dragOverSessionId === session.id
                ? `session-card-wrapper ${dragPosition === "before" ? "drop-before" : "drop-after"}`
                : "session-card-wrapper"
            }
          >
            {dragOverSessionId === session.id && dragPosition === "before" && <div className="session-drop-indicator" />}
            <SessionCard
              session={session}
              isActive={session.id === activeSessionId}
              onSelect={setActiveSession}
              onDelete={handleDeleteSession}
              onRename={handleRenameSession}
              onOpenInExplorer={handleOpenInExplorer}
              onOpenInTerminal={handleOpenInTerminal}
              onReassignPorts={handleReassignPorts}
              onRetryHooks={handleRetryHooks}
              onHover={prefetchTerminals}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
            />
            {dragOverSessionId === session.id && dragPosition === "after" && <div className="session-drop-indicator" />}
          </div>
        ))}
        {foreignSessions.length > 0 && (
          <div className="session-foreign-group">
            <button type="button" className="session-foreign-toggle" onClick={() => setForeignOpen((v) => !v)}>
              {foreignOpen ? "▼" : "▶"} Foreign Sessions ({foreignSessions.length})
            </button>
            {foreignOpen && (
              <div className="session-foreign-list">
                {foreignSessions.map((session) => (
                  <SessionCard
                    key={session.id}
                    session={session}
                    isActive={false}
                    onSelect={setActiveSession}
                    onDelete={handleDeleteSession}
                    onRename={handleRenameSession}
                    onOpenInExplorer={handleOpenInExplorer}
                    onOpenInTerminal={handleOpenInTerminal}
                    onReassignPorts={handleReassignPorts}
                    onRetryHooks={handleRetryHooks}
                    onHover={prefetchTerminals}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <button
        type="button"
        className="session-add"
        onClick={handleNewSession}
        data-testid="new-session"
      >
        +
      </button>
      <div
        ref={handleRef}
        className="session-sidebar-resize-handle"
        onPointerDown={onResizeStart}
        title="拖拽调整宽度"
      >
        <span className="session-sidebar-resize-dots" />
      </div>
    </div>
  );
}
