import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { TerminalManager } from "../components/TerminalManager";
import { ConfigEditor } from "../components/ConfigEditor";
import { HookErrorModal } from "../components/HookErrorModal";

export const Route = createFileRoute("/app/$projectId")({
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const { projectId } = Route.useParams();
  const { activeSessionId } = useStore();
  const { data: projects, isLoading } = useProjects();
  const queryClient = useQueryClient();
  const [showHookErrors, setShowHookErrors] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const project = projects?.find((p) => p.id === projectId);
  // Note: `project?.sessions.find` parses as `(project?.sessions).find`, so
  // the optional chain only guards `project`, not `project.sessions`. When
  // useOpenProject inserts a freshly-created project into the cache, the row
  // has no `sessions` field (it's not part of the `projects` schema row).
  // Use `?.` on both sides so we don't crash on partial cache state.
  const activeSession = project?.sessions?.find((s) => s.id === activeSessionId);

  // Cold-start race: project not in cache yet. Auto-refetch until found.
  useEffect(() => {
    if (!project && !isLoading && retryCount < 5) {
      const timer = setTimeout(async () => {
        await queryClient.invalidateQueries({ queryKey: queryKeys.projects });
        setRetryCount((c) => c + 1);
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [project, isLoading, retryCount, queryClient]);

  if (!project) {
    return (
      <div className="workspace-empty">
        <p>{isLoading || retryCount < 5 ? "Loading…" : "Project not found"}</p>
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
          <div className="workspace-session-row">
            <span className="workspace-session-label">{activeSession.name}</span>
            <span className="workspace-session-path">{activeSession.worktreePath}</span>
            {activeSession.backgroundHookStatus === "failed" && (
              <button
                type="button"
                className="workspace-hook-errors-btn"
                onClick={() => setShowHookErrors(true)}
              >
                ⚠ 查看失败日志
              </button>
            )}
          </div>
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
      {showHookErrors && activeSession && (
        <HookErrorModal
          sessionId={activeSession.id}
          onClose={() => setShowHookErrors(false)}
        />
      )}
    </div>
  );
}
