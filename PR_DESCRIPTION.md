# PR: Harden session ownership, port recovery, and UI session status

## Summary

This PR tightens session ownership semantics, adds self-healing for stale DB ports, fixes external-session discovery, persists heartbeat liveness, and introduces UI statuses (`foreign`/`reclaimed`/`allocated`) with a collapsed foreign-sessions accordion and a safer project-tab close button.

---

## Why

The existing system had several correctness gaps:

- **No ownership enforcement.** Any registered client could `release` or `reassign-ports` on another client's session, and `declare` would silently transfer ownership.
- **DB ports could go stale without recovery.** `GET /api/projects` only filled null ports but never corrected mismatched non-null ones.
- **External sessions (created by another AgentDock instance) discovered from disk got `ports: null`** and stayed that way until manual reassign — the discovery path never called `declareSessions` to get fresh ports.
- **`/sync/declare` trusted DB-provided ports without an OS bindability check.** After a daemon restart, old DB ports that happened to be externally occupied would be accepted.
- **Heartbeat timestamps were not persisted.** A daemon restart could immediately stale active clients because the WAL had stale `lastHeartbeat` values.
- **Affirmative consent not required.** Clicking the ✕ on a project tab called `DELETE /api/projects/:id`, destroying all sessions under the project with no confirmation.

---

## What changed

### 1. Session ownership hardening

**Files:** `plugins/daemon-state.ts`, `plugins/daemon.ts`

- Added `getSessionOwnership()` returning `"owned" | "reclaimable" | "foreign" | "missing"`.
- `/sessions/release` now rejects (403) if the caller is not the current owner. Returns 404 for unknown sessions.
- `/sessions/reassign` validates ownership. If the owner is stale, ownership is transferred to the caller first (returns `"reclaimed"`).
- `/sync/declare` no longer silently transfers ownership to a different live client. Returns `"foreign"` when the session belongs to another live client, `"reclaimed"` when the former owner is gone, and `"existing"` for same-owner declarations.

### 2. Port reconciliation and self-healing

**Files:** `plugins/api.ts`, `plugins/daemon.ts`

- `/sync/declare` now checks all five declared ports with `isPortAvailable()` before trusting DB values. If any port is externally occupied, the entire set is reallocated.
- Startup sync now writes DB and `.env` for _every_ result with `r.ports`, not only `"allocated"` status.
- `GET /api/projects` now:
  - Calls `syncProjectPortsToDb()` to correct non-null but outdated DB ports using daemon state.
  - When a new worktree is discovered on disk: if daemon knows it, uses its ports; if not, calls `declareSessions()` immediately to get fresh ports instead of inserting `ports: null`.
  - `declareDiscoveredSession` is wrapped in try-catch so a daemon error doesn't crash the entire sync.

### 3. Heartbeat liveness persistence

**Files:** `plugins/daemon.ts`

- Heartbeat now persists to WAL with throttling (every 30s per client) so a daemon restart does not immediately invalidate recently active clients.
- `registerClient` / `unregisterClient` / `cleanupStaleClients` all manage the throttled-persistence bookkeeping.

### 4. API session status plumbing

**Files:** `plugins/api.ts`

- `GET /api/projects` now returns per-session `status` (`"existing"` / `"foreign"` / `"allocated"` / `"reclaimed"`), `ownerClientId`, and permission flags (`canSelect`, `canDelete`, `canReassign`, `canRename`).
- Transient statuses (`"allocated"`, `"reclaimed"`) are tracked via an in-memory `_sessionStatuses` map derived from startup sync and creation/reassign paths.

### 5. Frontend session status UI

**Files:** `src/lib/queries.ts`, `src/components/SessionCard.tsx`, `src/components/SessionSidebar.tsx`, `src/routes/app.$projectId.tsx`, `src/styles/globals.css`

- **`SessionData`** extended with `status`, `ownerClientId`, and `can*` permission flags.
- **`SessionListItem`** union type resolves conflicts between `CreatingSession`/`DeletingSession` and the new runtime status field.
- **Foreign sessions** are rendered in a collapsed accordion ("Foreign Sessions (N)") at the bottom of the sidebar, greyed out, non-interactive, with an owner tooltip.
- **Active session auto-fallback**: if `activeSessionId` becomes foreign, the sidebar automatically selects the first available session.
- **Recovered / Allocated badges** show as one-time dismissible pills in the workspace header.
- **Session card** for foreign state is greyed, non-clickable, no context menu. For reclaimed/allocated states it shows a subtle badge.
- **Project-tab close button (✕)** now only clears the UI store — it no longer calls `DELETE /api/projects/:id`, which destroyed all sessions under the project.

---

## Testing

### Pre-existing test results (Vitest, Node)
All 87 tests pass across 5 test files:

```
plugins/__tests__/port-conflict-defense.test.ts   ✓
plugins/__tests__/api-integration.test.ts          ✓  (34 tests incl. P1/P2 port self-healing)
plugins/__tests__/sync-declare.test.ts             ✓
plugins/__tests__/daemon-session-api.test.ts        ✓
plugins/__tests__/daemon-client-resilience.test.ts  ✓
```

### Key test additions

| Test file | New / modified tests |
|-----------|---------------------|
| `daemon-session-api.test.ts` | Non-owner release → 403; non-owner reassign → 403; owner can reassign reclaimed session; declare returns foreign/reclaimed |
| `sync-declare.test.ts` | Foreign live-owner; reclaimed stale-owner; mixed batch (existing/foreign/allocated) |
| `port-conflict-defense.test.ts` | OS-occupied ports force full reallocation on declare |
| `api-integration.test.ts` | P1: first-discovered external session gets ports immediately; P2: daemon corrects stale non-null DB ports + `.env` |
| `daemon-client-resilience.test.ts` | Restart preserves ownership for recently heartbeating client |

### Manual verification checklist

1. **Normal single-instance flow:** create session → ports assigned → terminal works.
2. **External session discovery:** `git worktree add` outside AgentDock, restart, verify session appears with ports.
3. **Reassign ports:** right-click → reassign → workspace header shows "Ports refreshed" (dismissible).
4. **Foreign sessions** (dual-instance): instance B sees A's sessions as greyed out in foreign accordion.
5. **Active-session auto-fallback:** B's active session becomes foreign → B auto-switches.
6. **Tab close safety:** clicking ✕ closes tab, does not delete sessions.

---

## Known limitations

- **`npm run build` is not clean.** The project has pre-existing TypeScript errors (unused imports, type assertions, test-typing issues) unrelated to this PR. The focused test suite passes cleanly.
- **probe-then-bind race** is architecturally unavoidable: the allocator checks `isPortAvailable()` before recording the assignment, but an external process can bind the port between probe and actual service start. The fix reduces the window by rejecting already-unavailable DB ports on declare.
- **Legacy `/ports/*` allocator** is not unified with the session-allocator path; port allocations from legacy APIs are invisible to the session daemon state.

---

## Review guide

Suggested review order:

1. **`plugins/daemon-state.ts`** — new ownership helpers (`getSessionOwnership`, `claimSession`)
2. **`plugins/daemon.ts`** — ownership validation in release/reassign/declare routes; OS-bindability check; heartbeat throttled persist
3. **`plugins/api.ts`** — `syncProjectPortsToDb`, `declareDiscoveredSession`, `getSessionUiStatus`; startup sync and `/api/projects` changes
4. **Test files** — validate the semantic changes through the test suite
5. **Frontend** — `SessionSidebar` foreign accordion, `SessionCard` foreign/allocated/reclaimed states, `app.$projectId` transient-status pill, `TabBar` close-safety fix
