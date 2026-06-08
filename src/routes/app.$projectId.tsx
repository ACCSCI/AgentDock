import { createFileRoute } from "@tanstack/react-router";
import { useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { TerminalManager } from "../components/TerminalManager";
import { ConfigEditor } from "../components/ConfigEditor";

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
      {activeSession && (
        <div className="workspace-session-info">
          <span className="workspace-session-label">{activeSession.name}</span>
          <span className="workspace-session-path">{activeSession.worktreePath}</span>
          {activeSession.ports && (
            <span className="workspace-session-ports">
              {Object.entries(activeSession.ports).map(([key, value]) => (
                <span key={key} className="workspace-port-badge" title={key}>
                  {key.replace(/_PORT$/, "")}:{value}
                </span>
              ))}
            </span>
          )}
        </div>
      )}
      <div className="workspace-content">
        {activeSession ? (
          <TerminalManager
            sessionId={activeSession.id}
            worktreePath={activeSession.worktreePath}
          />
        ) : (
          <ConfigEditor projectId={project.id} projectPath={project.path} />
        )}
      </div>
    </div>
  );
}
