import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { TerminalManager } from "../components/TerminalManager";
import { ConfigEditor } from "../components/ConfigEditor";
import { HookErrorModal } from "../components/HookErrorModal";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";

export const Route = createFileRoute("/app/$projectId")({
  component: ProjectWorkspace,
});

function ProjectWorkspace() {
  const { projectId } = Route.useParams();
  const { activeSessionId } = useStore();
  const { data: projects, isLoading } = useProjects();
  const queryClient = useQueryClient();
  const [showHookErrors, setShowHookErrors] = useState(false);
  const hookErrorTriggerRef = useRef<HTMLButtonElement>(null);
  const [retryCount, setRetryCount] = useState(0);
  const project = projects?.find((p) => p.id === projectId);
  // Note: `project?.sessions.find` parses as `(project?.sessions).find`, so
  // the optional chain only guards `project`, not `project.sessions`. When
  // useOpenProject inserts a freshly-created project into the cache, the row
  // has no `sessions` field (it's not part of the `projects` schema row).
  // Use `?.` on both sides so we don't crash on partial cache state.
  const activeSession = project?.sessions?.find((s) => s.id === activeSessionId);
  const closeHookErrors = useCallback(() => {
    setShowHookErrors(false);
    requestAnimationFrame(() => hookErrorTriggerRef.current?.focus());
  }, []);

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
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <p>{isLoading || retryCount < 5 ? "Loading…" : "Project not found"}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 px-4 py-3">
      {/* Project header — name + path on one baseline, path truncates */}
      <div className="flex shrink-0 items-baseline gap-3">
        <h2 className="text-base font-semibold tracking-tight">{project.name}</h2>
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={project.path}>
          {project.path}
        </span>
      </div>

      {activeSession && (
        <div className="flex shrink-0 flex-col gap-2 rounded-md border border-border bg-card px-3 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-sm font-semibold text-primary">
              {activeSession.name}
            </span>
            <span
              className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
              title={activeSession.worktreePath}
            >
              {activeSession.worktreePath}
            </span>
            {activeSession.backgroundHookStatus === "failed" && (
              <Button
                ref={hookErrorTriggerRef}
                type="button"
                variant="warning"
                size="sm"
                onClick={() => setShowHookErrors(true)}
              >
                ⚠ 查看失败日志
              </Button>
            )}
          </div>
          {activeSession.ports && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(activeSession.ports).map(([key, value]) => (
                <Badge
                  key={key}
                  variant="outline"
                  className="font-mono tabular-nums"
                  title={key}
                >
                  {key.replace(/_PORT$/, "")}:{value}
                </Badge>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
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
          onClose={closeHookErrors}
        />
      )}
    </div>
  );
}
