import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useProjects, isBackgroundHookRunning } from "../lib/queries";
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
  const { data: projects } = useProjects();
  const [dismissedStatuses, setDismissedStatuses] = useState<Record<string, true>>({});
  const project = projects?.find((p) => p.id === projectId);
  const activeSession = project?.sessions.find((s) => s.id === activeSessionId);
  const [showHookErrors, setShowHookErrors] = useState(false);

  const transientStatus = activeSession?.status === "allocated" || activeSession?.status === "reclaimed"
    ? activeSession.status
    : null;
  const dismissKey = activeSession && transientStatus ? `${activeSession.id}:${transientStatus}` : null;
  const shouldShowStatus = !!activeSession && !!transientStatus && !isBackgroundHookRunning(activeSession) && !dismissedStatuses[dismissKey ?? ""];

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
            {shouldShowStatus && (
              <button
                type="button"
                className={`workspace-session-status workspace-session-status-${transientStatus}`}
                onClick={() => {
                  if (!dismissKey) return;
                  setDismissedStatuses((prev) => ({ ...prev, [dismissKey]: true }));
                }}
                title={transientStatus === "reclaimed" ? "This session was recovered from a stale owner. Click to dismiss." : "Ports were refreshed during recovery. Click to dismiss."}
              >
                {transientStatus === "reclaimed" ? "Recovered" : "Ports refreshed"} ×
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
