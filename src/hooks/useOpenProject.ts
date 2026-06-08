import { useNavigate } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import { useCreateProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";

/**
 * Hook that encapsulates "open project" flow:
 *  1. Show DirBrowserModal
 *  2. User picks a directory → extract basename as project name
 *  3. If project already exists (matched by name), navigate to it
 *  4. Otherwise create a new project, then navigate
 */
export function useOpenProject() {
  const [modalOpen, setModalOpen] = useState(false);
  const { setActiveProject } = useStore();
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const navigate = useNavigate();

  const openProject = useCallback(() => {
    setModalOpen(true);
  }, []);

  const handleConfirm = useCallback(
    async (selectedPath: string) => {
      setModalOpen(false);

      // Extract basename as project name
      const normalized = selectedPath.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      const baseName = segments[segments.length - 1] || selectedPath;

      // First, match by exact path — same directory = same project
      const existingByPath = projects?.find((p) => p.path === selectedPath);
      if (existingByPath) {
        setActiveProject(existingByPath.id);
        navigate({ to: "/app/$projectId", params: { projectId: existingByPath.id } });
        return;
      }

      // Resolve name collision: if a project with the same name but different path exists, add suffix
      let name = baseName;
      const existingNames = new Set(projects?.map((p) => p.name) ?? []);
      if (existingNames.has(name)) {
        let suffix = 1;
        while (existingNames.has(`${baseName} (${suffix})`)) suffix++;
        name = `${baseName} (${suffix})`;
      }

      try {
        const project = await createProject.mutateAsync({ name, path: selectedPath });
        setActiveProject(project.id);
        navigate({ to: "/app/$projectId", params: { projectId: project.id } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(`打开项目失败: ${message}`);
      }
    },
    [projects, createProject, setActiveProject, navigate],
  );

  const handleCancel = useCallback(() => {
    setModalOpen(false);
  }, []);

  return {
    openProject,
    modalOpen,
    onModalConfirm: handleConfirm,
    onModalCancel: handleCancel,
  };
}
