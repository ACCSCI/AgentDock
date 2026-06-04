import { useNavigate } from "@tanstack/react-router";
import { createFileRoute } from "@tanstack/react-router";
import { useCreateProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";

export const Route = createFileRoute("/")({
  component: HomeComponent,
});

function HomeComponent() {
  const { setActiveProject } = useStore();
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const navigate = useNavigate();

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

  return (
    <div className="home-container">
      <button type="button" className="home-open-btn" onClick={handleOpenProject}>
        打开项目
      </button>
    </div>
  );
}
