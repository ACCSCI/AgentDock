import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { queryKeys, useCreateProject, useInitDb, useProjects } from "../lib/queries";
import type { ProjectData } from "../lib/queries/types";
import { useStore } from "../lib/store";
import { toast } from "../lib/toast";

/**
 * Normalize a file path for comparison:
 * - Convert backslashes to forward slashes
 * - Remove trailing slashes
 * - Lowercase drive letter on Windows
 */
function normalizePath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([A-Z]):/i, (_, d: string) => d.toLowerCase() + ":");
}

/**
 * Safely extract a human-readable message from an unknown thrown value.
 *
 * Why: Errors that cross the Electron IPC boundary are structured-cloned
 * and lose their Error prototype on the renderer side, so
 * `error instanceof Error` is false and `String(error)` degenerates to
 * `"[object Object]"`. Naive callers then try to JSON.parse the result
 * and explode with `Unexpected token "o"`. This helper:
 *   1. Prefers Error.message when present
 *   2. Falls back to the string itself if it's a string
 *   3. Tries JSON.stringify for plain objects
 *   4. Last-resort: String(error)
 */
function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

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
  const queryClient = useQueryClient();
  const [modalOpen, setModalOpen] = useState(false);
  const { setActiveProject } = useStore();
  const { data: projects, isLoading: isProjectsLoading, isFetched: isProjectsFetched } = useProjects();
  const createProject = useCreateProject();
  const initDb = useInitDb();
  const navigate = useNavigate();

  // Git-init confirmation state
  const [gitInitModalOpen, setGitInitModalOpen] = useState(false);
  const [gitInitLoading, setGitInitLoading] = useState(false);
  const [pendingPath, setPendingPath] = useState("");
  const pendingPathRef = useRef<string | null>(null);

  const openProject = useCallback(() => {
    setModalOpen(true);
  }, []);

  /**
   * Insert a project into the cached projects list, replacing any
   * existing entry with the same id. Returns the updated list.
   *
   * Why: useCreateProject's onSuccess invalidates the projects query
   * which kicks off an async refetch. If we await a refetch + then
   * navigate, the in-flight refetch can race with TanStack Router's
   * memory-mode navigation and HomeComponent can swallow the navigate.
   * Doing the insert synchronously via setQueryData gives us a known
   * cache state at the moment we issue navigate.
   */
  const insertOrReplaceProject = useCallback(
    (project: ProjectData): ProjectData[] => {
      const old = queryClient.getQueryData<ProjectData[]>(queryKeys.projects);
      const list = old ?? [];
      const idx = list.findIndex((p) => p.id === project.id);
      // Normalize the project row so it matches the ProjectData shape returned
      // by useProjects. The raw row from db:projects:create only has
      // {id, name, path, createdAt}; consumers (e.g. ProjectWorkspace)
      // assume the full shape with sessions[]. Fill missing arrays so we
      // don't crash on partial cache state right after creating/opening.
      const normalized: ProjectData = {
        ...project,
        sessions: project.sessions ?? [],
      };
      let next: ProjectData[];
      if (idx >= 0) {
        next = list.slice();
        next[idx] = normalized;
      } else {
        next = [...list, normalized];
      }
      queryClient.setQueryData<ProjectData[]>(queryKeys.projects, next);
      return next;
    },
    [queryClient],
  );

  /** Create a project and navigate to it. */
  const createAndNavigate = useCallback(
    async (selectedPath: string, name: string) => {
      try {
        const project = await createProject.mutateAsync({ name, path: selectedPath });
        await initDb.mutateAsync(selectedPath);
        setActiveProject(project.id);
        // Synchronously inject the new project into the cache so TabBar
        // can render it on first mount. Don't await an async refetch —
        // it would race with the navigate below and HomeComponent would
        // swallow the route change.
        insertOrReplaceProject(project);
        // Defer the navigate past the current commit so the navigate
        // isn't dropped by HomeComponent's re-render cycle triggered
        // by the cache update above.
        requestAnimationFrame(() => {
          navigate({ to: "/app/$projectId", params: { projectId: project.id } });
        });
      } catch (error) {
        const message = safeErrorMessage(error);
        alert(`打开项目失败: ${message}`);
      }
    },
    [createProject, initDb, setActiveProject, navigate, insertOrReplaceProject],
  );

  /**
   * Derive a project name from the selected path, resolving collisions
   * against existing project names. Returns empty string if the project
   * already exists by exact path (caller should navigate instead).
   */
  const resolveName = useCallback(
    (selectedPath: string, projectsList: typeof projects): string => {
      const normalizedSelected = normalizePath(selectedPath);
      const existingByPath = projectsList?.find(
        (p) => normalizePath(p.path) === normalizedSelected,
      );
      if (existingByPath) return "";

      const normalized = selectedPath.replace(/\\/g, "/");
      const segments = normalized.split("/").filter(Boolean);
      const baseName = segments[segments.length - 1] || selectedPath;

      let name = baseName;
      const existingNames = new Set(projectsList?.map((p) => p.name) ?? []);
      if (existingNames.has(name)) {
        let suffix = 1;
        while (existingNames.has(`${baseName} (${suffix})`)) suffix++;
        name = `${baseName} (${suffix})`;
      }
      return name;
    },
    [],
  );

  // ── DirBrowserModal callbacks ───────────────────────────────────────

  const handleConfirm = useCallback(
    async (selectedPath: string) => {
      setModalOpen(false);

      // Ensure the projects list is settled before we make any decision.
      // On cold-start, useProjects() may still be in-flight (initial fetch
      // hasn't returned), in which case `projects` is undefined and the
      // fast-path below would fall through to the create branch, causing
      // a duplicate create for an already-existing project.
      let projectsList = projects;
      if (!isProjectsFetched || isProjectsLoading) {
        try {
          projectsList = await queryClient.fetchQuery({
            queryKey: queryKeys.projects,
            staleTime: 0,
          });
        } catch (error) {
          // If we can't fetch the projects list, surface a friendly error
          // and bail out — do not blindly attempt to create.
          const message = safeErrorMessage(error);
          alert(`无法加载项目列表: ${message}`);
          return;
        }
      }

      // Fast-path: project with same path already exists → navigate.
      // Use normalized path comparison to handle trailing slashes, case differences, etc.
      const normalizedSelected = normalizePath(selectedPath);
      const existingByPath = projectsList?.find(
        (p) => normalizePath(p.path) === normalizedSelected,
      );
      if (existingByPath) {
        await initDb.mutateAsync(selectedPath);
        setActiveProject(existingByPath.id);
        // Ensure the cache reflects the active project state synchronously
        // before navigating. Don't await an async refetch — it would race
        // with the navigate and HomeComponent would swallow the route change.
        insertOrReplaceProject(existingByPath);
        requestAnimationFrame(() => {
          navigate({ to: "/app/$projectId", params: { projectId: existingByPath.id } });
        });
        return;
      }

      // Check if directory is a git repo.
      const isRepo = await window.api.git.isRepo(selectedPath);
      if (isRepo) {
        const name = resolveName(selectedPath, projectsList);
        if (name) await createAndNavigate(selectedPath, name);
        return;
      }

      // Not a git repo → pause and ask the user.
      pendingPathRef.current = selectedPath;
      setPendingPath(selectedPath);
      setGitInitModalOpen(true);
    },
    [
      projects,
      isProjectsFetched,
      isProjectsLoading,
      queryClient,
      setActiveProject,
      navigate,
      resolveName,
      createAndNavigate,
      initDb,
      insertOrReplaceProject,
    ],
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
        setGitInitModalOpen(false);
        setPendingPath("");
        return;
      }

      toast.success("Git 仓库初始化完成");
      setGitInitModalOpen(false);
      setPendingPath("");

      // Make sure we have the latest projects list before resolving a name
      // so we don't accidentally collide with an existing project name.
      let projectsList = projects;
      if (!isProjectsFetched || isProjectsLoading) {
        try {
          projectsList = await queryClient.fetchQuery({
            queryKey: queryKeys.projects,
            staleTime: 0,
          });
        } catch {
          // fall back to the cached list; the create path will still
          // de-dup by normalized path on the main process side
        }
      }

      const name = resolveName(dirPath, projectsList);
      if (name) await createAndNavigate(dirPath, name);
    } catch (error) {
      const message = safeErrorMessage(error);
      toast.error(`Git 初始化失败: ${message}`);
      setGitInitModalOpen(false);
      setPendingPath("");
    } finally {
      pendingPathRef.current = null;
      setGitInitLoading(false);
    }
  }, [projects, isProjectsFetched, isProjectsLoading, queryClient, resolveName, createAndNavigate]);

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
