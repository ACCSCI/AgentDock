import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useCreateSessionSSE, useDeleteSessionSSE, useProjects, useReassignPorts, useRenameSession } from "../lib/queries";
import { useStore } from "../lib/store";
import { SessionCard } from "./SessionCard";

export function SessionSidebar() {
  const { activeProjectId, activeSessionId, setActiveSession } = useStore();
  const { data: projects } = useProjects();
  const queryClient = useQueryClient();
  const createSession = useCreateSessionSSE();
  const deleteSession = useDeleteSessionSSE();
  const renameSession = useRenameSession();
  const reassignPorts = useReassignPorts();

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

  const prefetchTerminals = (sessionId: string) => {
    queryClient.prefetchQuery({
      queryKey: queryKeys.terminals(sessionId),
      queryFn: async () => {
        const res = await fetch(`/api/sessions/${sessionId}/terminals`);
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        return data.terminals;
      },
    });
  };

  return (
    <div className="session-sidebar">
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
    </div>
  );
}
