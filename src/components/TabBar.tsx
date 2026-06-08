import { useNavigate } from "@tanstack/react-router";
import { useDeleteProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { useOpenProject } from "../hooks/useOpenProject";
import { DirBrowserModal } from "./DirBrowserModal";

export function TabBar() {
  const navigate = useNavigate();
  const { activeProjectId, setActiveProject } = useStore();
  const { data: projects } = useProjects();
  const deleteProject = useDeleteProject();
  const { openProject, modalOpen, onModalConfirm, onModalCancel } = useOpenProject();

  const handleRemoveProject = (projectId: string) => {
    if (activeProjectId === projectId) {
      setActiveProject(null);
      navigate({ to: "/" });
    }
  };

  return (
    <div className="tab-bar">
      {(projects || []).map((project) => (
        <div
          key={project.id}
          className={`tab-item ${project.id === activeProjectId ? "active" : ""}`}
          onClick={() => {
            setActiveProject(project.id);
            navigate({ to: "/app/$projectId", params: { projectId: project.id } });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setActiveProject(project.id);
              navigate({ to: "/app/$projectId", params: { projectId: project.id } });
            }
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
