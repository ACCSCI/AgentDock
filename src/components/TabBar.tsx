import { Plus, X } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useOpenProject } from "../hooks/useOpenProject";
import { useInitDb, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { cn } from "../lib/utils";
import { DirBrowserModal } from "./DirBrowserModal";
import { GitInitConfirmModal } from "./GitInitConfirmModal";

export function TabBar() {
  const navigate = useNavigate();
  const {
    activeProjectId,
    activeSessionId,
    setActiveProject,
    setActiveSession,
    closedProjectIds,
    closeProject,
  } = useStore();
  const { data: projects } = useProjects();
  const initDb = useInitDb();
  const {
    openProject,
    modalOpen,
    onModalConfirm,
    onModalCancel,
    gitInitModalOpen,
    gitInitLoading,
    selectedDirPath,
    onGitInitConfirm,
    onGitInitCancel,
  } = useOpenProject();
  const openProjects = projects?.filter((p) => !closedProjectIds.includes(p.id)) ?? [];

  const handleRemoveProject = useCallback(
    (projectId: string) => {
      closeProject(projectId);
      // After closing a tab, switch to the next available tab if any remain.
      // Only navigate to home ("/") when the closed tab was the last one.
      const remaining = openProjects.filter((p) => p.id !== projectId);
      const next = remaining[0];
      if (next) {
        setActiveProject(next.id);
        try {
          navigate({ to: "/app/$projectId", params: { projectId: next.id } });
        } catch {}
      } else {
        try {
          navigate({ to: "/" });
        } catch {}
      }
    },
    [openProjects, closeProject, setActiveProject, navigate],
  );

  // Ctrl+W (Cmd+W on macOS) closes the active project tab. Two paths:
  //   1. IPC "app:close-tab" from main process (handles macOS default menu
  //      that consumes Cmd+W before the renderer's keydown fires).
  //   2. Renderer keydown fallback for Windows/Linux.
  useEffect(() => {
    const closeActiveTab = () => {
      if (!activeProjectId) return;
      handleRemoveProject(activeProjectId);
    };

    const cleanupIpc = window.api?.onCloseTab?.(closeActiveTab) ?? (() => {});

    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "w" && e.key !== "W") return;
      if (e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) {
        return;
      }
      e.preventDefault();
      closeActiveTab();
    };
    window.addEventListener("keydown", handler);

    return () => {
      cleanupIpc();
      window.removeEventListener("keydown", handler);
    };
  }, [activeProjectId, handleRemoveProject]);

  // Wheel handler — React's onWheel={...} is registered as a passive
  // listener, so e.preventDefault() inside it is silently ignored (the
  // browser logs a warning, and the default vertical scroll still runs).
  // We need a non-passive wheel listener attached via ref so we can both
  // suppress the default vertical scroll AND map deltaY → scrollLeft.
  const tabBarRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = tabBarRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      if (e.deltaY !== 0 && el.scrollWidth > el.clientWidth) {
        el.scrollLeft += e.deltaY;
        e.preventDefault();
      }
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  const handleTabClick = (projectId: string) => {
    if (closedProjectIds.includes(projectId)) {
      closeProject(projectId);
    }
    if (projectId === activeProjectId) {
      if (activeSessionId) {
        setActiveSession(null);
      } else {
        setActiveProject(null);
        try {
          navigate({ to: "/" });
        } catch {}
      }
    } else {
      // Tell the main process which project is active so syncProject()
      // and other DB handlers can find the project record in the global DB.
      const project = projects?.find((p) => p.id === projectId);
      if (project) {
        initDb.mutate(project.path, {
          onSuccess: () => {
            setActiveProject(projectId);
            navigate({ to: "/app/$projectId", params: { projectId } });
          },
        });
      } else {
        setActiveProject(projectId);
        navigate({ to: "/app/$projectId", params: { projectId } });
      }
    }
  };

  return (
    <>
      <nav
        className="flex h-10 shrink-0 items-center gap-0.5 overflow-x-auto overflow-y-hidden border-b border-border bg-secondary px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        aria-label="打开的项目"
        data-testid="tab-bar"
        ref={tabBarRef}
      >
        {openProjects.map((project) => (
          <div
            key={project.id}
            className={cn(
              "flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm border px-3 py-1.5 text-[13px] transition-colors select-none",
              project.id === activeProjectId
                ? "border-primary bg-card"
                : "border-border bg-secondary hover:bg-muted",
            )}
            data-testid="project-tab"
            data-project-id={project.id}
          >
            <button
              type="button"
              className="tab-select flex min-w-0 flex-1 cursor-pointer items-center self-stretch border-0 bg-transparent text-start text-inherit"
              aria-current={project.id === activeProjectId ? "page" : undefined}
              onClick={() => handleTabClick(project.id)}
            >
              <span className="max-w-[120px] truncate">{project.name}</span>
            </button>
            <button
              type="button"
              className="cursor-pointer rounded border-0 bg-transparent px-0.5 leading-none text-muted-foreground transition-colors hover:bg-secondary hover:text-primary"
              onClick={(e) => {
                e.stopPropagation();
                handleRemoveProject(project.id);
              }}
              data-testid="project-tab-close"
              aria-label={`关闭项目 ${project.name}`}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-sm border border-dashed border-border bg-transparent text-primary transition-colors hover:border-primary hover:bg-secondary"
          onClick={openProject}
          aria-label="打开新项目"
          data-testid="new-project"
        >
          <Plus aria-hidden="true" className="size-4" />
        </button>
        <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
        <GitInitConfirmModal
          open={gitInitModalOpen}
          dirPath={selectedDirPath}
          onConfirm={onGitInitConfirm}
          onCancel={onGitInitCancel}
          loading={gitInitLoading}
        />
      </nav>
    </>
  );
}
