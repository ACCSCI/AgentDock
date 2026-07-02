import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { useInitDb, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { useOpenProject } from "../hooks/useOpenProject";
import { DirBrowserModal } from "./DirBrowserModal";
import { GitInitConfirmModal } from "./GitInitConfirmModal";

export function TabBar() {
  const navigate = useNavigate();
  const { activeProjectId, activeSessionId, setActiveProject, setActiveSession, closedProjectIds, closeProject } = useStore();
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

  const handleRemoveProject = useCallback((projectId: string) => {
    closeProject(projectId);
    // After closing a tab, switch to the next available tab if any remain.
    // Only navigate to home ("/") when the closed tab was the last one.
    const remaining = openProjects.filter((p) => p.id !== projectId);
    if (remaining.length > 0) {
      const next = remaining[0]!;
      setActiveProject(next.id);
      try { navigate({ to: "/app/$projectId", params: { projectId: next.id } }); } catch {}
    } else {
      try { navigate({ to: "/" }); } catch {}
    }
  }, [openProjects, closeProject, setActiveProject, navigate]);

  // Ctrl+W / Cmd+W — close the active project tab.
  //
  // Two paths:
  //   1. IPC "app:close-tab" from main process (handles macOS default menu
  //      which consumes Cmd+W before the renderer's keydown fires).
  //   2. Renderer keydown listener (handles Windows/Linux where no menu
  //      accelerator exists, and the IPC might not fire).
  //
  // Both call handleRemoveProject(activeProjectId).
  useEffect(() => {
    const closeActiveTab = () => {
      if (!activeProjectId) return;
      handleRemoveProject(activeProjectId);
    };

    // Path 1: IPC from main process (via before-input-event → send).
    const cleanupIpc = window.api?.app?.onCloseTab?.(closeActiveTab) ?? (() => {});

    // Path 2: Renderer keydown (fallback for Windows/Linux).
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key !== "w" && e.key !== "W") return;
      if (e.altKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        target?.isContentEditable
      ) {
        return;
      }
      if (!activeProjectId) return;
      e.preventDefault();
      handleRemoveProject(activeProjectId);
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
        try { navigate({ to: "/" }); } catch {}
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
      <div className="tab-bar" data-testid="tab-bar" ref={tabBarRef}>
      {openProjects.map((project) => (
        <div
          key={project.id}
          className={`tab-item ${project.id === activeProjectId ? "active" : ""}`}
          onClick={() => handleTabClick(project.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleTabClick(project.id);
          }}
          tabIndex={0}
          role="tab"
          aria-selected={project.id === activeProjectId}
          data-testid="project-tab"
          data-project-id={project.id}
        >
          <span className="tab-name">{project.name}</span>
          <button
            type="button"
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              handleRemoveProject(project.id);
            }}
            data-testid="project-tab-close"
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="tab-add" onClick={openProject} data-testid="new-project">
        +
      </button>
      <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
      <GitInitConfirmModal
        open={gitInitModalOpen}
        dirPath={selectedDirPath}
        onConfirm={onGitInitConfirm}
        onCancel={onGitInitCancel}
        loading={gitInitLoading}
      />
      </div>
    </>
  );
}
