/**
 * v2 State integration hooks — combines SSE push with polling fallback.
 *
 * F11b: useV2Projects combines v2State SSE push with old polling fallback
 * for backward compatibility with existing components.
 */
import { useMemo } from "react";
import type { ProjectData, SessionData, SessionRuntimeStatus } from "./types.js";
import { isCreatingSession, isDeletingSession } from "./types.js";
import { useV2State, isV2StateAvailable } from "../../hooks/useV2State.js";
import { useProjects } from "./projects.js";

/** Normalize path for consistent map keys across platforms. */
const normalizeKey = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * F11b: Hook that combines v2State SSE push with old polling fallback.
 *
 * Priority:
 * 1. v2State SSE push (real-time, from main process SyncApplier)
 * 2. 30s v2 sync loop (fallback if v2State not available)
 * 3. Old query (initial load fallback)
 *
 * Returns the same ProjectData[] format as useProjects() for backward
 * compatibility with existing components.
 */
export function useV2Projects() {
  const v2State = isV2StateAvailable() ? useV2State() : null;
  const oldQuery = useProjects();

  // Transform v2State data to ProjectData[] format
  const v2Projects = useMemo(() => {
    if (!v2State?.ready) return null;

    // Collect realSessionIds from active CreatingSession entries in the
    // React Query cache (oldQuery.data shares the same cache key so it
    // reflects optimistic inserts like CreatingSession). These sessions
    // are still in their optimistic creation lifecycle and must not be
    // replaced by v2State data — otherwise the session card flashes from
    // "loading" to "clickable" before the lifecycle completes.
    const creatingRealIds = new Set<string>();
    const cachedProjects = oldQuery.data;
    if (cachedProjects) {
      for (const p of cachedProjects) {
        for (const s of p.sessions) {
          if (isCreatingSession(s) && s.realSessionId) {
            creatingRealIds.add(s.realSessionId);
          }
        }
      }
    }

    // Build a path→nanoid lookup from the old DB query so v2State-derived
    // projects get the same `id` the local DB uses. This keeps
    // `activeProjectId` (nanoid) compatible with v2State's path-based IDs.
    const oldProjects = oldQuery.data ?? [];
    const pathToDbId = new Map<string, string>();
    for (const p of oldProjects) {
      if (p.path) pathToDbId.set(normalizeKey(p.path), p.id);
    }

    // Group sessions by projectRoot
    const projectMap = new Map<string, ProjectData>();
    const myClientId = v2State.clientId;

    for (const [sessionId, session] of v2State.sessions) {
      // Skip sessions still in CreatingSession optimistic state to prevent
      // v2State from prematurely overriding the loading spinner.
      if (creatingRealIds.has(sessionId)) continue;

      // Skip non-active sessions (creating/deleting) — these are already
      // represented as optimistic CreatingSession/DeletingSession entries
      // in the React Query cache. Without this guard, v2State can push a
      // session before the optimistic insert lands, making it clickable
      // while the create button is still spinning.
      if (session.status !== "active") continue;

      const projectRoot = session.projectRoot || "";
      const projectKey = normalizeKey(projectRoot);

      // §4.3: 判定有主/无主
      const ownerClientId = v2State.owners.get(sessionId)?.clientId;
      const hasOwner = ownerClientId != null && ownerClientId !== "";

      // 无主 session 不进 sidebar（由 OrphanCleanModal 处理）
      if (!hasOwner) continue;

      if (!projectMap.has(projectKey)) {
        // Prefer the nanoid id from the DB query when available, so
        // activeProjectId (which stores the nanoid) resolves correctly.
        const dbId = pathToDbId.get(projectKey);
        projectMap.set(projectKey, {
          id: dbId ?? projectRoot,
          name: projectRoot.split("/").pop() || projectRoot,
          path: projectRoot,
          createdAt: new Date(session.createdAt).toISOString(),
          sessions: [],
        });
      }

      // §4.3: 有主 → 判定"我的"还是"别人的"
      const isForeign = myClientId != null && ownerClientId !== myClientId;

      const project = projectMap.get(projectKey)!;
      project.sessions.push({
        id: session.sessionId,
        projectId: projectRoot,
        name: session.displayName,
        branch: "",
        worktreePath: projectRoot,
        ports: session.ports && Object.keys(session.ports).length > 0 ? {
          FRONTEND_PORT: session.ports.FRONTEND_PORT || 0,
          BACKEND_PORT: session.ports.BACKEND_PORT || 0,
          WS_PORT: session.ports.WS_PORT || 0,
          DEBUG_PORT: session.ports.DEBUG_PORT || 0,
          PREVIEW_PORT: session.ports.PREVIEW_PORT || 0,
        } : null,
        createdAt: new Date(session.createdAt).toISOString(),
        status: (isForeign ? "foreign" : session.status === "active" ? "existing" : session.status) as SessionRuntimeStatus,
        ownerClientId,
      });
    }

    // Merge optimistic sessions (CreatingSession / DeletingSession) from the
    // React Query cache into the v2State-derived projectMap. Without this,
    // filtering non-active v2State sessions would also remove the loading
    // spinner during creation and the "deleting" state during deletion.
    if (cachedProjects) {
      for (const cachedProj of cachedProjects) {
        const projectRoot = cachedProj.path;
        if (!projectRoot) continue;
        const projectKey = normalizeKey(projectRoot);
        const optimisticSessions = cachedProj.sessions.filter(
          (s) => isCreatingSession(s) || isDeletingSession(s),
        );
        if (optimisticSessions.length === 0) continue;

        if (!projectMap.has(projectKey)) {
          projectMap.set(projectKey, {
            id: cachedProj.id,
            name: cachedProj.name,
            path: projectRoot,
            createdAt: cachedProj.createdAt,
            sessions: [],
          });
        }
        const project = projectMap.get(projectKey)!;
        const existingIds = new Set(project.sessions.map((s) => s.id));
        for (const optSession of optimisticSessions) {
          if (!existingIds.has(optSession.id)) {
            project.sessions.push(optSession);
          }
        }
      }
    }

    // §4.3.2 — 兜底合并: v2 不认但 DB 有的 session (磁盘存在但 daemon 未
    // 注册, e.g. 人工 cp 建的 worktree). 这些 session 在 v2 path 下走不到
    // UI (被 status!=="active" / !hasOwner 过滤), 但磁盘上确实有 — 标
    // "takeover" 让 sidebar 显示, 提示用户需手动 claim.
    //
    // path 比较前规范化 (separators → /, lowercase, 去尾部 /), 否则
    // v2 projectMap key 跟 DB p.path 格式不同会导致查不到已有 project,
    // 出现重复条目.
    for (const p of oldProjects) {
      if (!p.path) continue;
      const pKey = normalizeKey(p.path);
      // 找 v2 projectMap 里同 path 的已有 project (规范化比较, O(1))
      let target = projectMap.get(pKey);
      if (!target) {
        target = {
          id: p.id,
          name: p.name,
          path: p.path,
          createdAt: p.createdAt,
          sessions: [],
        };
        projectMap.set(pKey, target);
      }
      const existingIds = new Set(target.sessions.map((s) => s.id));
      for (const s of p.sessions) {
        if (existingIds.has(s.id)) continue;
        target.sessions.push({
          id: s.id,
          projectId: target.id,
          name: s.name,
          branch: s.branch,
          worktreePath: s.worktreePath,
          ports: s.ports,
          backgroundHookStatus: s.backgroundHookStatus ?? null,
          createdAt: s.createdAt,
          userStatus: s.userStatus ?? null,
          lastActivatedAt: s.lastActivatedAt ?? null,
          // 标 takeover 让 SessionCard 知道这是 "磁盘有但 daemon 不认"
          status: "takeover" as const,
        });
      }
    }

    return Array.from(projectMap.values());
  }, [v2State, oldQuery.data]);

  // Return v2State data if available and non-empty, otherwise fall back
  // to old query. Empty v2State means the snapshot hasn't loaded sessions
  // yet (daemon still in RECOVERING, or no sessions exist); in that case
  // the old DB-based query is authoritative for project metadata.
  //
  // Also fall back when v2Projects has projects but zero total sessions —
  // this happens when v2State is ready but the daemon hasn't registered
  // owners yet (e.g. freshly claimed takeover sessions), so the
  // hasOwner filter strips all sessions. The DB-based oldProjects still
  // has the correct session data.
  if (v2Projects && v2Projects.length > 0 && v2Projects.some((p) => p.sessions.length > 0)) {
    return {
      ...oldQuery,
      data: v2Projects,
      // Mark that we're using v2State data
      isV2: true as const,
    };
  }

  return {
    ...oldQuery,
    isV2: false as const,
  };
}

/**
 * Hook to get sessions for a specific project, using v2State when available.
 */
export function useV2ProjectSessions(projectId: string | null) {
  const v2State = isV2StateAvailable() ? useV2State() : null;
  const oldQuery = useProjects();

  const sessions = useMemo(() => {
    if (!projectId) return [];

    // Resolve projectId (may be nanoid) to actual project path
    const projectPath = oldQuery.data?.find(
      (p) => p.id === projectId || p.path === projectId,
    )?.path || projectId;

    // Try v2State first
    if (v2State?.ready) {
      const myClientId = v2State.clientId;
      const activeSessions = Array.from(v2State.sessions.values())
        .filter((s) => {
          // Only include active sessions owned by someone
          if (normalizeKey(s.projectRoot) !== normalizeKey(projectPath)) return false;
          if (s.status !== "active") return false;
          const ownerClientId = v2State.owners.get(s.sessionId)?.clientId;
          return ownerClientId != null && ownerClientId !== "";
        })
        .map((s) => {
          const ownerClientId = v2State.owners.get(s.sessionId)?.clientId ?? null;
          const isForeign = myClientId != null && ownerClientId !== null && ownerClientId !== myClientId;
          return {
            id: s.sessionId,
            projectId: s.projectRoot,
            name: s.displayName,
            branch: "",
            worktreePath: s.projectRoot,
            ports: s.ports && Object.keys(s.ports).length > 0 ? {
              FRONTEND_PORT: s.ports.FRONTEND_PORT || 0,
              BACKEND_PORT: s.ports.BACKEND_PORT || 0,
              WS_PORT: s.ports.WS_PORT || 0,
              DEBUG_PORT: s.ports.DEBUG_PORT || 0,
              PREVIEW_PORT: s.ports.PREVIEW_PORT || 0,
            } : null,
            createdAt: new Date(s.createdAt).toISOString(),
            status: (isForeign ? "foreign" : "existing") as SessionRuntimeStatus,
            ownerClientId,
          };
        }) as SessionData[];

      // Merge optimistic sessions (CreatingSession / DeletingSession) from
      // the React Query cache so the sidebar still shows loading spinners
      // during creation and deletion.
      const cachedProject = oldQuery.data?.find(
        (p) => p.id === projectId || p.path === projectId,
      );
      const optimisticSessions = cachedProject?.sessions.filter(
        (s) => isCreatingSession(s) || isDeletingSession(s),
      ) ?? [];

      return [...activeSessions, ...optimisticSessions];
    }

    // Fall back to old query
    const project = oldQuery.data?.find((p) => p.id === projectId);
    return project?.sessions ?? [];
  }, [v2State, oldQuery.data, projectId]);

  return {
    sessions,
    isV2: v2State?.ready ?? false,
  };
}
