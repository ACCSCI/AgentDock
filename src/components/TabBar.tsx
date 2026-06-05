import { useNavigate } from "@tanstack/react-router";
import { useCreateProject, useDeleteProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";

export function TabBar() {
  const navigate = useNavigate();
  const { activeProjectId, setActiveProject } = useStore();
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const deleteProject = useDeleteProject();

  const handleOpenProject = async () => {
    if (typeof window.showDirectoryPicker !== "function") {
      alert("Your browser does not support the File System Access API.");
      return;
    }

    try {
      const dirHandle = await window.showDirectoryPicker();
      const name = dirHandle.name;
      const path = window.prompt("输入项目绝对路径", `D:\\Projects\\${name}`)?.trim();

      if (!path) return;

      const existing = projects?.find((p) => p.name === name);
      if (existing) {
        setActiveProject(existing.id);
        navigate({ to: "/app/$projectId", params: { projectId: existing.id } });
        return;
      }

      const project = await createProject.mutateAsync({ name, path });
      setActiveProject(project.id);
      navigate({ to: "/app/$projectId", params: { projectId: project.id } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      alert(`打开目录失败: ${message}`);
    }
  };

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
      <button type="button" className="tab-add" onClick={handleOpenProject}>
        +
      </button>
    </div>
  );
}
