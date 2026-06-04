import { useCreateSession, useDeleteSession, useProjects, useReassignPorts, useRenameSession } from "../lib/queries";
import { useStore } from "../lib/store";
import { SessionCard } from "./SessionCard";

export function SessionSidebar() {
  const { activeProjectId, activeSessionId, setActiveSession } = useStore();
  const { data: projects } = useProjects();
  const createSession = useCreateSession();
  const deleteSession = useDeleteSession();
  const renameSession = useRenameSession();
  const reassignPorts = useReassignPorts();

  const activeProject = projects?.find((p) => p.id === activeProjectId);

  if (!activeProject) return null;

  const handleNewSession = async () => {
    const count = activeProject.sessions.length + 1;
    try {
      await createSession.mutateAsync({
        projectId: activeProject.id,
        name: `Session ${count}`,
      });
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (!confirm("Delete this session and its worktree?")) return;
    try {
      await deleteSession.mutateAsync(sessionId);
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
