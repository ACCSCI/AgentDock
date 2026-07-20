import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, GitPullRequest, Plus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  fetchSessionTerminals,
  queryKeys,
  useActivateSession,
  useCreateSessionSSE,
  useDeleteSessionSSE,
  useProjects,
  useReassignPorts,
  useRenameSession,
  useReorderSessions,
  useRetryHook,
  useSetSessionUserStatus,
  useSyncProject,
} from "../lib/queries";
import type { SessionUserStatus } from "../lib/queries";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useStore } from "../lib/store";
import { terminalCache } from "../lib/terminal-cache";
import { toast } from "../lib/toast";
import { ConfirmDeleteModal } from "./ConfirmDeleteModal";
import { SessionCard } from "./SessionCard";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function SessionSidebar() {
  const {
    activeProjectId,
    activeSessionId,
    setActiveSession,
    sidebarCollapsed,
    toggleSidebar,
    sidebarWidth,
    setSidebarWidth,
  } = useStore();

  // Single-instance: use only useProjects (no v2 state)
  const { data: projects } = useProjects();
  const queryClient = useQueryClient();
  const createSession = useCreateSessionSSE();
  const deleteSession = useDeleteSessionSSE();
  const renameSession = useRenameSession();
  const reassignPorts = useReassignPorts();
  const retryHook = useRetryHook();
  const reorderSessions = useReorderSessions();
  const setUserStatus = useSetSessionUserStatus();
  const activateSession = useActivateSession();

  const [dragOverSessionId, setDragOverSessionId] = useState<string | null>(null);
  const [dragPosition, setDragPosition] = useState<"before" | "after">("after");
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const draggedIdRef = useRef<string | null>(null);
  const lastCreateAtRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLDivElement>(null);
  const sidebarWidthRef = useRef(sidebarWidth);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  const onResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
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
        const newWidth = Math.min(
          SIDEBAR_MAX_WIDTH,
          Math.max(SIDEBAR_MIN_WIDTH, startWidth + delta),
        );
        setSidebarWidth(newWidth);
      };

      el.addEventListener("pointermove", onPointerMove);
      el.addEventListener("pointerup", cleanup);
      el.addEventListener("pointercancel", cleanup);
      document.body.style.userSelect = "none";
      document.body.style.cursor = "col-resize";
    },
    [setSidebarWidth],
  );

  const activeProject = projects?.find((p) => p.id === activeProjectId);
  const sessions = activeProject?.sessions ?? [];

  // Memoize the ordered list of visible session IDs for stable sorting
  const visibleSessionIds = useMemo(() => {
    return sessions.map((s) => s.id);
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
      .filter((s): s is NonNullable<typeof s> => s != null);
  }, [sessions, localOrder, visibleSessionIds]);

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
      if (!target) {
        setDragOverSessionId(null);
        return;
      }
      const targetId = target.dataset.sessionId;
      if (!targetId || targetId === draggedId) {
        setDragOverSessionId(null);
        return;
      }

      setLocalOrder((prevOrder) => {
        const order = prevOrder ?? visibleSessionIds;
        if (!order.includes(draggedId) || !order.includes(targetId)) return order;
        const next = order.filter((id) => id !== draggedId);
        let insertAt = next.indexOf(targetId);
        if (dragPosition === "after") insertAt += 1;
        next.splice(insertAt, 0, draggedId);
        reorderSessions
          .mutateAsync({ projectId: activeProject.id, sessionIds: next })
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

  const CREATE_COOLDOWN_MS = 1500;

  const handleNewSession = async () => {
    if (!activeProject) {
      console.error("SessionSidebar: activeProject is null");
      return;
    }
    console.log(
      `SessionSidebar: creating session for project ${activeProject.id} (${activeProject.name})`,
    );
    const now = Date.now();
    if (now - lastCreateAtRef.current < CREATE_COOLDOWN_MS) return;
    lastCreateAtRef.current = now;

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
    setDeletingSessionId(null);
    try {
      await deleteSession.mutateAsync({ sessionId, projectId: activeProject.id });
      terminalCache.disposeBySession(sessionId);
    } catch (err) {
      console.error("Failed to delete session:", err);
      toast.error(`删除失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleRequestDelete = (sessionId: string) => {
    setDeletingSessionId(sessionId);
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

  const handleSetUserStatus = async (sessionId: string, status: SessionUserStatus | null) => {
    try {
      await setUserStatus.mutateAsync({ sessionId, status });
    } catch (err) {
      alert(`设置状态失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  const handleActivate = (sessionId: string) => {
    // Fire-and-forget — UI shows optimistic update immediately
    activateSession.mutate(sessionId);
  };

  const [prLoading, setPrLoading] = useState(false);
  const handleOpenPullRequests = async () => {
    if (!activeProject) return;
    setPrLoading(true);
    try {
      await window.api.shell.openPullRequests(activeProject.id);
    } catch (err) {
      toast.error(`无法打开 Pull Requests: ${err instanceof Error ? err.message : "未知错误"}`);
    } finally {
      setPrLoading(false);
    }
  };

  // §4.3.2 — 手动扫盘按钮. 调 main 进程 syncProject(force=true),
  // 走完后 useSyncProject.onSuccess 自动 invalidate projects query,
  // sidebar 重新拉一次显示新发现的 worktree.
  const rescan = useSyncProject();
  const handleRescanDisk = async () => {
    try {
      const result = await rescan.mutateAsync();
      const { inserted, removed, cleanedOrphans, prunedRefs, total } = result ?? {};
      if (inserted || removed || cleanedOrphans || prunedRefs) {
        const parts: string[] = [];
        if (inserted) parts.push(`新增 ${inserted}`);
        if (cleanedOrphans) parts.push(`清理孤儿 ${cleanedOrphans}`);
        if (prunedRefs) parts.push(`修剪 ${prunedRefs}`);
        if (removed) parts.push(`移除失效 ${removed}`);
        toast.success(`同步完成: ${parts.join(", ")} (共 ${total} 个)`);
      } else {
        toast.info(`扫描完成, 共 ${total ?? 0} 个 session`);
      }
    } catch (err) {
      toast.error(`扫描失败: ${err instanceof Error ? err.message : "未知错误"}`);
    }
  };

  if (!activeProject) return null;

  if (sidebarCollapsed) {
    return (
      <aside
        className="flex w-10 shrink-0 flex-col items-center border-r border-border bg-card py-2"
        aria-label="Sessions"
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={toggleSidebar}
          aria-label="展开 Session 侧栏"
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      </aside>
    );
  }

  return (
    <>
      <aside
        className="relative flex shrink-0 flex-col border-r border-border bg-card"
        style={{ width: sidebarWidth }}
        aria-label="Sessions"
        data-testid="session-sidebar"
      >
        <div className="flex items-center border-b border-border px-3 py-2.5">
          <span className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
            Sessions
          </span>
          <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleRescanDisk}
                disabled={rescan.isPending}
                aria-label="扫描磁盘 worktree"
                data-testid="rescan-disk"
              >
                {rescan.isPending ? (
                  <span className="step-spinner" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>扫描磁盘 worktree</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleOpenPullRequests}
                disabled={prLoading}
                aria-label="查看 Pull Requests"
                data-testid="open-pull-requests"
              >
                <GitPullRequest aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>查看 Pull Requests</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon-sm"
                onClick={handleNewSession}
                disabled={createSession.isPending}
                aria-label="新建 Session"
                data-testid="new-session"
              >
                {createSession.isPending ? (
                  <span className="step-spinner" />
                ) : (
                  <Plus aria-hidden="true" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>新建 Session</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleSidebar}
            aria-label="收起 Session 侧栏"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          </div>
        </div>
        <div
          ref={listRef}
          className={`flex flex-1 flex-col gap-1 overflow-y-auto p-2 ${dragOverSessionId ? "drag-active" : ""}`}
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
              {dragOverSessionId === session.id && dragPosition === "before" && (
                <div className="session-drop-indicator" />
              )}
              <SessionCard
                session={session}
                isActive={session.id === activeSessionId}
                onSelect={setActiveSession}
                onRequestDelete={handleRequestDelete}
                onRename={handleRenameSession}
                onOpenInExplorer={handleOpenInExplorer}
                onOpenInTerminal={handleOpenInTerminal}
                onReassignPorts={handleReassignPorts}
                onRetryHooks={handleRetryHooks}
                onSetUserStatus={handleSetUserStatus}
                onActivate={handleActivate}
                onHover={prefetchTerminals}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
              />
              {dragOverSessionId === session.id && dragPosition === "after" && (
                <div className="session-drop-indicator" />
              )}
            </div>
          ))}
        </div>
        <div
          ref={handleRef}
          className="group absolute top-0 -right-1 z-10 flex h-full w-2.5 cursor-col-resize items-center justify-center"
          onPointerDown={onResizeStart}
          title="拖拽调整宽度"
          aria-label="拖拽调整侧栏宽度"
          role="separator"
          aria-orientation="vertical"
        >
          <span className="block h-8 w-0.5 rounded-full bg-border transition-colors group-hover:bg-primary" />
        </div>
      </aside>
      <ConfirmDeleteModal
        open={deletingSessionId !== null}
        sessionName={sessions.find((s) => s.id === deletingSessionId)?.name ?? ""}
        onConfirm={() => deletingSessionId && handleDeleteSession(deletingSessionId)}
        onCancel={() => setDeletingSessionId(null)}
      />
    </>
  );
}
