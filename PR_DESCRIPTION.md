# PR: Harden session ownership, port recovery, external-session discovery, and UI status

## Summary

This PR tightens session ownership semantics, adds self-healing for stale DB ports, fixes external-session discovery, persists heartbeat liveness, and introduces UI statuses (`foreign`/`reclaimed`/`allocated`) with a collapsed foreign-sessions accordion and a safer project-tab close button.

---

## Why

- **No ownership enforcement.** Any registered client could `release` or `reassign-ports` on another client's session.
- **DB ports could go stale without recovery.** `GET /api/projects` only filled null ports but never corrected mismatched non-null ones.
- **External sessions (created by another instance) discovered from disk got `ports: null`** until manual reassign.
- **`/sync/declare` trusted DB-provided ports without an OS bindability check.**
- **Heartbeat timestamps were not persisted.** A daemon restart could immediately stale active clients.
- **Clicking ✕ on a project tab called `DELETE /api/projects/:id`**, destroying all sessions with no confirmation.

---

## What changed

### 1. Session ownership hardening
- `plugins/daemon-state.ts`: Added `getSessionOwnership()` returning `"owned" | "reclaimable" | "foreign" | "missing"`, plus `claimSession()`.
- `plugins/daemon.ts`: `/sessions/release` and `/sessions/reassign` now reject (403) non-owner callers. `/sync/declare` returns `"foreign"`/`"reclaimed"`/`"existing"` — no silent takeover.
- `plugins/api.ts`: `_sessionStatuses` cleaned up on session/project delete to prevent memory leak.

### 2. Port reconciliation and self-healing
- `/sync/declare` checks all five declared ports with `isPortAvailable()` before trusting DB values. If any port is externally occupied, the entire set is reallocated.
- Startup sync writes DB and `.env` for every result with `r.ports`, not only `"allocated"`.
- `GET /api/projects` corrects non-null but outdated DB ports from daemon state and auto-declares discovered sessions instead of inserting `ports: null`.

### 3. Heartbeat liveness persistence
- Heartbeat persists to WAL with throttling (every 30s per client) to prevent stale-client cleanup on daemon restart.

### 4. API session status
- `GET /api/projects` returns `status` (`"existing"`/`"foreign"`/`"allocated"`/`"reclaimed"`), `ownerClientId`, and `can*` permission flags per session.

### 5. Frontend UI
- **Foreign sessions** in a collapsed "Foreign Sessions (N)" accordion, greyed out, non-interactive.
- **Active session auto-fallback** when current session becomes foreign.
- **Recovered / Ports refreshed** one-time dismissible badges.
- **Session card** for foreign state: greyed, no context menu. For reclaimed/allocated: subtle badge.
- **Project-tab ✕** closes the tab (filtered via `closedProjectIds`, persisted to localStorage). No longer calls DELETE API. Tab reappears when project is re-opened via +. Survives restart.
- **Tab click logic**: clicking active tab toggles session; clicking different project switches.
- **Sidebar collapse/expand** and **ConfigEditor** synced from origin/master.

### 6. Files + Config API
- `GET/POST /api/projects/:id/config` — read/write `agentdock.config.yaml`.
- `GET /api/projects/:id/files` — async file browser with git-tracked status (`untracked`/`modified`/`tracked`), node_modules/.git/.agentdock filtering.

### 7. Project config
- `ConfigEditor` + `FilePicker` components restored from origin/master.
- Workspace shows ConfigEditor when no session is active; TerminalManager when a session is active.
- Transient status pill (`Recovered`/`Ports refreshed`) shown in workspace header.

---

## Commits (13)

```
4b129f4 fix: persist closedProjectIds to localStorage to survive restart
ced530e fix: files endpoint — directory tracked detection via startsWith, same as origin/master
b284d0b fix: files endpoint git status — use git ls-files --cached for tracked detection
f763a14 docs: update PR description with closedProjectIds
281b96c fix: add closedProjectIds to store, filter open projects in TabBar
a7a1f1f fix: navigate to / on project deactivate/close to avoid stale requests
bb5cded fix: files endpoint — switch execSync to async execAsync + Promise.all
3b760c1 fix: sync files API format — add success, node_modules filter; update FileEntry/FilePicker
41492eb fix: add missing url variable in files endpoint
fcc3d84 fix: _sessionStatuses memory leak — cleanup on session/project delete
89dc504 fix: sync tab click logic with origin/master
b88f31e fix: add config and files API endpoints from origin/master
7e7eff6 fix: sync queries.ts from origin/master
aca88ed fix: restore ConfigEditor/FilePicker, add navigate home on deactivate
b9a1ecb fix: sync SessionSidebar and store from origin/master with foreign accordion
ba09d17 fix: sync IconSidebar and CSS from origin/master
e790497 fix: address review comments — write env before DB insert, context menu
0071e51 fix: harden session ownership, port recovery, external-session discovery, and UI status
```

---

## Testing

### Focused regression (Vitest, Node)
```
5 files, 87 tests — all pass
```

### Manual verification checklist
1. Normal single-instance flow: create session → ports → terminal works.
2. External session discovery: `git worktree add`, restart, session appears with ports.
3. Reassign ports: right-click → reassign → "Ports refreshed" dismissible badge.
4. Foreign sessions (dual-instance): instance B sees A's sessions greyed in accordion.
5. Active-session auto-fallback on foreign status.
6. Tab close: ✕ closes tab, does not delete sessions, navigates home.
7. ConfigEditor: click active tab → shows config; click ✕ → home.
8. FilePicker: opens from ConfigEditor, shows git status badges.

---

## Known limitations

- **`npm run build` has pre-existing TS errors** (unused imports, test typing issues) unrelated to this PR. Focused test suite passes.
- **probe-then-bind race** is architecturally unavoidable: external process can bind between probe and service start.
- **Legacy `/ports/*` allocator** is not unified with session-allocator path.
