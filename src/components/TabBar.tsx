import { useNavigate } from "@tanstack/react-router";
import { useDeleteProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { useOpenProject } from "../hooks/useOpenProject";
import { DirBrowserModal } from "./DirBrowserModal";

export function TabBar() {
  const navigate = useNavigate();
  const { activeProjectId, activeSessionId, setActiveProject, setActiveSession } = useStore();
  const { data: projects } = useProjects();
  const deleteProject = useDeleteProject();
  const { openProject, modalOpen, onModalConfirm, onModalCancel } = useOpenProject();

  const handleRemoveProject = async (projectId: string) => {
    try {
      await deleteProject.mutateAsync(projectId);
      if (activeProjectId === projectId) {
        setActiveProject(null);
      }
    } catch (err) {
      alert(`Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  };

  const handleTabClick = (projectId: string) => {
    if (projectId === activeProjectId) {
      // Clicking active project tab
      if (activeSessionId) {
        // Session is active → clear session, show project config
        setActiveSession(null);
      } else {
        // No session → deactivate project entirely
        setActiveProject(null);
        navigate({ to: "/app" });
      }
    } else {
      // Clicking a different project → activate it
      setActiveProject(projectId);
      navigate({ to: "/app/$projectId", params: { projectId } });
    }
  };

  return (
    <div className="tab-bar">
      {(projects || []).map((project) => (
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
        >
          <span className="tab-name">{project.name}</span>
          <button
            type="button"
            className="tab-close"
            onClick={(e) => {
              e.stopPropagation();
              handleRemoveProject(project.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="tab-add" onClick={openProject}>
        +
      </button>
      <DirBrowserModal open={modalOpen} onConfirm={onModalConfirm} onCancel={onModalCancel} />
    </div>
  );
}
