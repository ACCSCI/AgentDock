import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchSessionTerminals, queryKeys, useCreateSessionSSE, useDeleteSessionSSE, useProjects, useReassignPorts, useRenameSession, useRetryHook } from "../lib/queries";
import { useStore } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { SessionCard } from "./SessionCard";

const SIDEBAR_MIN_WIDTH = 140;
const SIDEBAR_MAX_WIDTH = 600;

export function SessionSidebar() {
  const { activeProjectId, activeSessionId, setActiveSession, sidebarCollapsed, toggleSidebar, sidebarWidth, setSidebarWidth } = useStore();
  const { data: projects } = useProjects();
  const queryClient = useQueryClient();
  const createSession = useCreateSessionSSE();
  const deleteSession = useDeleteSessionSSE();
  const renameSession = useRenameSession();
  const reassignPorts = useReassignPorts();
  const retryHook = useRetryHook();

  const activeProject = projects?.find((p) => p.id === activeProjectId);

  if (!activeProject) return null;

  const handleNewSession = async () => {
    const existingNames = new Set(activeProject.sessions.map((s) => s.name));
    let count = activeProject.sessions.length + 1;
    while (existingNames.has(`Session ${count}`)) count++;
    try {
      await createSession.mutateAsync({
        projectId: activeProject.id,
        name: `Session ${count}`,
        tempId: `temp-${Date.now()}`,
      });
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!activeProject) return;
    try {
      await deleteSession.mutateAsync({ sessionId, projectId: activeProject.id });
      terminalCache.disposeBySession(sessionId);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleRenameSession = async (sessionId: string, newName: string) => {
    try {
      await renameSession.mutateAsync({ sessionId, name: newName });
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleOpenInExplorer = async (worktreePath: string) => {
    try {
      await fetch("/api/open-explorer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: worktreePath }),
      });
    } catch {
      navigator.clipboard.writeText(worktreePath);
    }
  };

  const handleReassignPorts = async (sessionId: string) => {
    try {
      await reassignPorts.mutateAsync(sessionId);
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleRetryHooks = async (sessionId: string) => {
    try {
      await retryHook.mutateAsync(sessionId);
    } catch (err) {
      alert(`重试失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleRef = useRef<HTMLDivElement>(null);

  const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta));
      setSidebarWidth(newWidth);
    };

    const onPointerUp = () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
  }, [sidebarWidth, setSidebarWidth]);

  const prefetchTerminals = (sessionId: string) => {
    queryClient.prefetchQuery({
      queryKey: queryKeys.terminals(sessionId),
      queryFn: () => fetchSessionTerminals(sessionId),
      staleTime: 5000,
    });
  };

  if (sidebarCollapsed) {
    return (
      <div className="session-sidebar session-sidebar-collapsed">
        <button
          type="button"
          className="session-sidebar-expand-btn"
          onClick={toggleSidebar}
          title="展开 Session 侧栏"
        >
          ▶
        </button>
      </div>
    );
  }

  return (
    <div className="session-sidebar" style={{ width: sidebarWidth }}>
      <div className="session-sidebar-header">
        <span className="session-sidebar-title">Sessions</span>
        <button
          type="button"
          className="session-sidebar-collapse-btn"
          onClick={toggleSidebar}
          title="收起侧栏"
        >
          ◀
        </button>
      </div>
      <div className="session-list">
        {activeProject.sessions.map((session) => (
          <SessionCard
            key={session.id}
            session={session}
            isActive={session.id === activeSessionId}
            onSelect={setActiveSession}
            onDelete={handleDeleteSession}
            onRename={handleRenameSession}
            onOpenInExplorer={handleOpenInExplorer}
            onReassignPorts={handleReassignPorts}
            onRetryHooks={handleRetryHooks}
            onHover={prefetchTerminals}
          />
        ))}
      </div>
      <button
        type="button"
        className="session-add"
        onClick={handleNewSession}
        disabled={createSession.isPending}
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
