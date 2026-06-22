import { useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { useCreateProject, useProjects } from "../lib/queries";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";

/**
 * Hook that encapsulates "open project" flow:
 *  1. Show DirBrowserModal
 *  2. User picks a directory → extract basename as project name
 *  3. If project already exists (matched by path), navigate to it
 *  4. Otherwise: check if directory is a git repo
 *     - Yes → create project → navigate
 *     - No  → show GitInitConfirmModal; on confirm, run `git init`,
 *              then create project; on cancel, abort (no side-effects)
 */
export function useOpenProject() {
  const [modalOpen, setModalOpen] = useState(false);
  const { setActiveProject } = useStore();
  const { data: projects } = useProjects();
  const createProject = useCreateProject();
  const navigate = useNavigate();

  // Git-init confirmation state
  const [gitInitModalOpen, setGitInitModalOpen] = useState(false);
  const [gitInitLoading, setGitInitLoading] = useState(false);
  const [pendingPath, setPendingPath] = useState("");
  const pendingPathRef = useRef<string | null>(null);

  const openProject = useCallback(() => {
    setModalOpen(true);
  }, []);

  /** Create a project and navigate to it. */
  const createAndNavigate = useCallback(
    async (selectedPath: string, name: string) => {
      try {
        const project = await createProject.mutateAsync({ name, path: selectedPath });
        setActiveProject(project.id);
        navigate({ to: "/app/$projectId", params: { projectId: project.id } });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        alert(`打开项目失败: ${message}`);
      }
    },
    [createProject, setActiveProject, navigate],
  );

  /**
   * Derive a project name from the selected path, resolving collisions
   * against existing project names. Returns empty string if the project
   * already exists by exact path (caller should navigate instead).
   */
  const resolveName = useCallback(
    (selectedPath: string): string => {
      const existingByPath = projects?.find((p) => p.path === selectedPath);
      if (existingByPath) return "";

      const normalized = selectedPath.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      const baseName = segments[segments.length - 1] || selectedPath;

      let name = baseName;
      const existingNames = new Set(projects?.map((p) => p.name) ?? []);
      if (existingNames.has(name)) {
        let suffix = 1;
        while (existingNames.has(`${baseName} (${suffix})`)) suffix++;
        name = `${baseName} (${suffix})`;
      }
      return name;
    },
    [projects],
  );

  // ── DirBrowserModal callbacks ───────────────────────────────────────

  const handleConfirm = useCallback(
    async (selectedPath: string) => {
      setModalOpen(false);

      // Fast-path: project with same path already exists → navigate.
      const existingByPath = projects?.find((p) => p.path === selectedPath);
      if (existingByPath) {
        setActiveProject(existingByPath.id);
        navigate({ to: "/app/$projectId", params: { projectId: existingByPath.id } });
        return;
      }

      // Check if directory is a git repo.
      const isRepo = await window.api.git.isRepo(selectedPath);
      if (isRepo) {
        const name = resolveName(selectedPath);
        if (name) await createAndNavigate(selectedPath, name);
        return;
      }

      // Not a git repo → pause and ask the user.
      pendingPathRef.current = selectedPath;
      setPendingPath(selectedPath);
      setGitInitModalOpen(true);
    },
    [projects, setActiveProject, navigate, resolveName, createAndNavigate],
  );

  const handleCancel = useCallback(() => {
    setModalOpen(false);
  }, []);

  // ── GitInitConfirmModal callbacks ───────────────────────────────────

  const handleGitInitConfirm = useCallback(async () => {
    const dirPath = pendingPathRef.current;
    if (!dirPath) return;

    setGitInitLoading(true);
    try {
      const result = await window.api.git.init(dirPath);
      if (!result.success) {
        toast.error(`Git 初始化失败: ${result.error ?? "未知错误"}`);
        pendingPathRef.current = null;
        setPendingPath("");
        setGitInitModalOpen(false);
        return;
      }

      toast.success("Git 仓库初始化完成");
      setGitInitModalOpen(false);
      setPendingPath("");
      const name = resolveName(dirPath);
      if (name) await createAndNavigate(dirPath, name);
    } finally {
      pendingPathRef.current = null;
      setGitInitLoading(false);
    }
  }, [resolveName, createAndNavigate]);

  const handleGitInitCancel = useCallback(() => {
    pendingPathRef.current = null;
    setPendingPath("");
    setGitInitModalOpen(false);
  }, []);

  return {
    openProject,
    modalOpen,
    onModalConfirm: handleConfirm,
    onModalCancel: handleCancel,
    // Git-init confirmation
    gitInitModalOpen,
    gitInitLoading,
    selectedDirPath: pendingPath,
    onGitInitConfirm: handleGitInitConfirm,
    onGitInitCancel: handleGitInitCancel,
  };
}
