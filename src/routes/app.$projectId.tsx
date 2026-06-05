import { createFileRoute } from "@tanstack/react-router";
import { useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { TerminalManager } from "../components/TerminalManager";

export const Route = createFileRoute("/app/$projectId")({
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const { projectId } = Route.useParams();
  const { activeSessionId } = useStore();
  const { data: projects } = useProjects();
  const project = projects?.find((p) => p.id === projectId);
  const activeSession = project?.sessions.find((s) => s.id === activeSessionId);

  if (!project) {
    return (
      <div className="workspace-empty">
        <p>Project not found</p>
      </div>
    );
  }

  return (
    <div className="workspace-container">
      <div className="workspace-header">
        <h2>{project.name}</h2>
        <span className="workspace-path">{project.path}</span>
      </div>
      <div className="workspace-content">
        {project.sessions.length === 0 ? (
          <p className="workspace-hint">Click "+" in the sidebar to create a new session</p>
        ) : !activeSession ? (
          <p className="workspace-hint">Select a session from the sidebar to start working</p>
        ) : (
          <TerminalManager
            sessionId={activeSession.id}
            worktreePath={activeSession.worktreePath}
          />
        )}
      </div>
    </div>
  );
}
