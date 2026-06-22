import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { useOpenProject } from "../hooks/useOpenProject";
import { DirBrowserModal } from "./DirBrowserModal";
import { DaemonStatusBar } from "./DaemonStatusBar";

export function TabBar() {
  const navigate = useNavigate();
  const { activeProjectId, activeSessionId, setActiveProject, setActiveSession, closedProjectIds, closeProject } = useStore();
  const { data: projects } = useProjects();
  const { openProject, modalOpen, onModalConfirm, onModalCancel } = useOpenProject();
  const openProjects = projects?.filter((p) => !closedProjectIds.includes(p.id)) ?? [];

  const handleRemoveProject = (projectId: string) => {
    closeProject(projectId);
    try { navigate({ to: "/" }); } catch {}
  };

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
      setActiveProject(projectId);
      navigate({ to: "/app/$projectId", params: { projectId } });
    }
  };

  return (
    <>
      <DaemonStatusBar />
      <div className="tab-bar" data-testid="tab-bar">
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
      </div>
    </>
  );
}
