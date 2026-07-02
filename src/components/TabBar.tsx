import { useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
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

  const handleRemoveProject = (projectId: string) => {
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
  };

  // Ctrl+W (Cmd+W on macOS) closes the active project tab. Matches the
  // common IDE shortcut for "close current tab". Skipped when an input
  // is focused so users typing in a terminal/editor aren't surprised.
  useEffect(() => {
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
    return () => window.removeEventListener("keydown", handler);
    // handleRemoveProject closes over activeProjectId + openProjects; re-bind
    // each time either changes so the closure stays current.
  }, [activeProjectId, openProjects]);

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
      <div
        className="tab-bar"
        data-testid="tab-bar"
        onWheel={(e) => {
          // Map vertical wheel (mouse) / touchpad horizontal gestures onto
          // the tab-bar's horizontal scroll. Without this, an overflowing
          // tab bar would be unreachable on devices without horizontal
          // scroll wheels (most mouse wheels only emit deltaY).
          const target = e.currentTarget;
          if (e.deltaY !== 0 && target.scrollWidth > target.clientWidth) {
            target.scrollLeft += e.deltaY;
            e.preventDefault();
          }
        }}
      >
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
