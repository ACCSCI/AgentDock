# Master ↔ Electron Alignment Audit

**Audit baseline:** `origin/master` (commit `8ec663a` — one commit ahead of HEAD
`337fc82`; the leading commit is the dangling-branch fix from PR #37, covered
below in Trivial Fixes).

**Current worktree:** `D:\Projects\AgentDock\.agentdock\worktrees\QnbbSNcX`,
post Electron + Hono rearchitecture (Phase 0–5 in flight), with the IPC
gaps surfaced by this audit already patched (see § Resolved IPC Gaps).

**TL;DR.** Master's 26-route HTTP surface (`plugins/api.ts`) and 21-route
local daemon (`plugins/daemon.ts`) are now both covered by either an IPC
channel (`electron/main/ipc/*`) or a Hono route under
`plugins/daemon/routes/*`. The first pass of the audit found **2
critical, 6 major, 1 partial** gaps where the Electron migration had
silently dropped behavior; all are now fixed in this PR (§ Resolved IPC
Gaps). One commit (`8ec663a`) ahead of HEAD on origin/master was
verified against the worktree code and is covered. No GAP remains open.

---

## 1. API route → IPC channel mapping (master `plugins/api.ts`)

26 routes. ✅ = behavior-equivalent, 🛠 = was broken, fixed in this PR.

| # | Master endpoint | IPC channel | Handler file:line | Status |
|---|---|---|---|---|
| 1 | `GET /api/reallocated` | `bootstrap:reallocated` | `electron/main/bootstrap.ts:43` | ✅ |
| 2 | `POST /api/init` | `db:init` | `electron/main/ipc/db.ts:178` | ✅ |
| 3 | `GET /api/projects` | `db:projects:list` | `electron/main/ipc/db.ts:191` | 🛠 sync+reconcile added |
| 4 | `POST /api/sync` | `sync:project` (new) | `electron/main/ipc/db.ts:295` | 🛠 channel reintroduced |
| 5 | `POST /api/projects` | `db:projects:create` | `electron/main/ipc/db.ts:223` | ✅ |
| 6 | `GET /api/browse-dirs` | `fs:browseDirs` | `electron/main/ipc/fs-config.ts:20` | ✅ |
| 7 | `GET /api/projects/:id/config` | `config:get` | `electron/main/ipc/fs-config.ts:73` | ✅ |
| 8 | `POST /api/projects/:id/config` | `config:save` | `electron/main/ipc/fs-config.ts:95` | ✅ |
| 9 | `GET /api/projects/:id/files` | `fs:files` | `electron/main/ipc/fs-config.ts:49` | ✅ |
| 10 | `DELETE /api/projects/:id` | `db:projects:delete` | `electron/main/ipc/db.ts:234` | 🛠 worktree+port cleanup added |
| 11 | `POST /api/projects/:id/sessions` (SSE) | `sessions:create` + `session:<id>:step`/`session:<id>:complete` | `electron/main/ipc/sessions.ts:38` | ✅ already streams |
| 12 | `DELETE /api/sessions/:id` (SSE) | `sessions:delete` + same streams | `electron/main/ipc/sessions.ts:164` | 🛠 SSE-equivalent streaming added |
| 13 | `PATCH /api/sessions/:id` (rename) | `sessions:rename` | `electron/main/ipc/sessions.ts:258` | 🛠 git branch rename added |
| 14 | `PUT /api/sessions/reorder` | `db:sessions:reorder` | `electron/main/ipc/db.ts:276` | ✅ |
| 15 | `POST /api/sessions/:id/reassign-ports` | `sessions:reassignPorts` | `electron/main/ipc/sessions.ts:296` | ✅ |
| 16 | `POST /api/sessions/:id/retry-hooks` | `sessions:retryHooks` | `electron/main/ipc/sessions.ts:367` | 🛠 real hook engine wired |
| 17 | `GET /api/sessions/:id/background-hook-status` | `sessions:bgHookStatus` | `electron/main/ipc/sessions.ts:443` | ✅ |
| 18 | `GET /api/sessions/:id/hook-errors` | `sessions:hookErrors` | `electron/main/ipc/sessions.ts:459` | ✅ |
| 19 | `POST /api/open-explorer` | `shell:openExplorer` | `electron/main/ipc/worktree-shell.ts:153` | ✅ |
| 20 | `POST /api/open-terminal` | `shell:openTerminal` | `electron/main/ipc/worktree-shell.ts:172` | ✅ |
| 21 | `POST /api/sessions/:id/terminals` | `terminals:create` | `electron/main/ipc/terminals.ts:40` | 🛠 worktreePath lookup added |
| 22 | `GET /api/sessions/:id/terminals` | `terminals:list` | `electron/main/ipc/terminals.ts:64` | ✅ |
| 23 | `PATCH /api/terminals/:terminalId` | `terminals:rename` | `electron/main/ipc/terminals.ts:79` | ✅ |
| 24 | `DELETE /api/terminals/:terminalId` | `terminals:delete` | `electron/main/ipc/terminals.ts:87` | ✅ |
| 25 | `GET /api/projects/:id/orphans` | `worktree:orphans` | `electron/main/ipc/worktree-shell.ts:52` | 🛠 branch scan added |
| 26 | `POST /api/orphans/delete` | `worktree:deleteOrphans` | `electron/main/ipc/worktree-shell.ts:90` | 🛠 branches body accepted |

**Plus** the Electron version adds 3 channels with no master equivalent
(intentional, not gaps): `bootstrap:health`, `bootstrap:clientId`,
`sessions:stream` (no-op marker).

**Plus** `WebSocket /api/terminal?terminalId=` on master is replaced by
`terminals:open` + `MessageChannelMain` port transfer + the new
`terminalManager.attachPort()` method in `plugins/terminal-manager.ts`.

---

## 2. Daemon HTTP route mapping (master `plugins/daemon.ts` → Hono)

21 endpoints, every one preserved by the Hono refactor under
`plugins/daemon/routes/*`. No GAPs — the Phase 1 acceptance suite
(`scripts/acceptance/phase1-daemon-hono.test.ts`) already enforces this
contract.

| Master | Hono route | File |
|---|---|---|
| `GET /health` | `GET /health` | `plugins/daemon/routes/health.ts:11` |
| `POST /ports/allocate` | identical | `plugins/daemon/routes/ports.ts:33` |
| `POST /ports/release` | identical | `plugins/daemon/routes/ports.ts:52` |
| `POST /register` | identical | `plugins/daemon/routes/registry.ts:27` |
| `POST /unregister` | identical | `plugins/daemon/routes/registry.ts:45` |
| `GET /status` | identical | `plugins/daemon/routes/registry.ts:56` |
| `POST /client/register` | identical | `plugins/daemon/routes/clients.ts:35` |
| `POST /client/unregister` | identical | `plugins/daemon/routes/clients.ts:52` |
| `POST /client/heartbeat` | identical | `plugins/daemon/routes/clients.ts:66` |
| `POST /sessions/allocate` | identical | `plugins/daemon/routes/sessions.ts:60` |
| `POST /sessions/release` | identical | `plugins/daemon/routes/sessions.ts:123` |
| `POST /sessions/reassign` | identical | `plugins/daemon/routes/sessions.ts:159` |
| `GET /sessions/list` | identical | `plugins/daemon/routes/sessions.ts:232` |
| `POST /sync/declare` | identical | `plugins/daemon/routes/sync.ts:61` |
| `GET /debug/state` | identical | `plugins/daemon/routes/debug.ts:25` |
| `GET /debug/invariants` | identical | `plugins/daemon/routes/debug.ts:30` |
| `GET /debug/wal` | identical | `plugins/daemon/routes/debug.ts:35` |
| `GET /debug/ports` | identical | `plugins/daemon/routes/debug.ts:66` |
| `GET /debug/clients` | identical | `plugins/daemon/routes/debug.ts:89` |
| `POST /debug/simulate-stale` | identical | `plugins/daemon/routes/debug.ts:110` |
| `POST /debug/trigger-cleanup` | identical | `plugins/daemon/routes/debug.ts:130` |

The Hono refactor adds `hostGuard`, `originGuard`, and `errorEnvelope`
middleware (`plugins/daemon/middleware/*`) plus zod-validator
schemas — strictly tighter than master's hand-rolled checks.

---

## 3. Renderer call-site migration

Every `fetch('/api/...')` site on master has a `window.api.*`
counterpart. The renderer's `src/lib/queries.ts` is the single
re-routing point (it wraps each call in a TanStack-Query hook). Spot
checks confirmed semantic equivalence for `useProjects`,
`useCreateSessionSSE`, `useDeleteSessionSSE`, `useRenameSession`,
`useReorderSessions`, `useReassignPorts`, `useSessionTerminals`,
`useBackgroundHookStatus`, `useHookErrors`, `useRetryHook`, `useOrphans`,
`useDeleteOrphans`, `useProjectConfig`, `useSaveConfig`, `useProjectFiles`.
The few direct `fetch(...)` sites outside `queries.ts`
(`DirBrowserModal.tsx`, `SessionSidebar.tsx`) are already on
`window.api.fs/shell.*`.

`src/lib/terminal-cache.ts` was migrated from WebSocket to
`MessagePort` (PortShim). The main-side counterpart
(`terminalManager.attachPort`) was the missing half — added in this PR.

---

## 4. Hook + lifecycle parity

| | master | current worktree | match |
|---|---|---|---|
| `HookLifecycleEvent` enum | `[beforeCreateSession, afterCreateSession, beforeDeleteSession, afterDeleteSession]` | identical (`plugins/config.ts:19`) | yes |
| Create pipeline step names | `beforeCreateSession`/`createWorktree`/`syncResources`/`allocatePorts`/`afterCreateSession` | identical (`plugins/session-lifecycle.ts:37`) | yes |
| Delete pipeline step names | `beforeDeleteSession`/`releasePorts`/`removeWorktree`/`afterDeleteSession` | identical | yes |
| `StepEvent` payload | `{step, status:"running"\|"done"\|"error", duration?, error?}` | identical | yes |
| `DeleteSessionInput.currentBranch` | added by 8ec663a | added in this PR (`plugins/session-lifecycle.ts:81`) | yes (this PR) |

---

## 5. `8ec663a` (dangling-branch fix) coverage

PR #37 widens `removeWorktree` / `renameWorktree` to thread the
session's actual current branch through to `git branch -D`, and adds
orphan-branch scanning. Per-file disposition:

| File | Master change | Worktree status |
|---|---|---|
| `plugins/worktree.ts` `removeWorktree` | options-object signature `{ currentBranch?, force? }` | Applied in this PR (kept boolean shape as legacy overload). |
| `plugins/worktree.ts` `renameWorktree` | accepts `currentBranch?` | Already on worktree (`plugins/worktree.ts:347`). |
| `plugins/worktree.ts` `scanOrphanBranches` / `removeOrphanBranch` | new helpers | Ported in this PR (`plugins/worktree.ts:494`/`533`). |
| `plugins/worktree.ts` `OrphanDir` type | `reason` widened, `branch?` added | Applied in this PR. |
| `plugins/session-lifecycle.ts` `DeleteSessionInput.currentBranch` | new field; forwarded to `removeWorktree` | Applied in this PR. Both create-rollback paths also pass `wt.branch`. |
| `plugins/api.ts` rename / orphans handlers | direct calls with the new args | n/a — `plugins/api.ts` is deleted; equivalents in the IPC layer pass `currentBranch` (rename), union branches (orphans), accept `branches` body (deleteOrphans). |
| `src/components/OrphanCleanModal.tsx` | `orphan-branch` reason label, split delete body | Applied (preserved on the worktree). |
| `src/components/IconSidebar.tsx` | `queryClient.invalidateQueries(["orphans"])` on click | Applied. |
| `src/lib/queries.ts` | `OrphanDir.reason` widened; `useDeleteOrphans` accepts `{paths?, branches?, projectId?}` | Applied. |
| `plugins/__tests__/worktree.test.ts` | 9 regression tests | Tests already on the worktree (untouched by this PR). |

The whole 8ec663a delta is now reflected end-to-end on the worktree.

---

## 6. Resolved IPC Gaps (this PR)

Detailed history of the 9 gaps the audit surfaced and the fix that
landed for each:

### Critical 1 — `terminals:open` runtime crash

- **Master behavior:** WebSocket `/api/terminal?terminalId=…` handles
  bidirectional PTY I/O.
- **Pre-fix:** `electron/main/ipc/terminals.ts` calls
  `terminalManager.attachPort(...)` but the method didn't exist; every
  user click on a terminal threw.
- **Fix:** added `attachPort(terminalId, port: MessagePortMain)` to
  `plugins/terminal-manager.ts:268`, with a parallel `ports:
  Set<MessagePortMain>` per terminal, buffer replay on attach, broadcast
  of `output`/`exit`/`error`/`opened` frames as JSON strings (matching
  what the renderer's PortShim's `JSON.parse(event.data)` expects), and
  cleanup on `kill()` / `killAll()` / host-death. Also fixed
  `terminals:create` to look up the session's `worktreePath` from the DB
  before invoking `terminalManager.create` (which requires
  `existsSync(worktreePath)`).

### Critical 2 — `sessions:retryHooks` stub

- **Master behavior:** builds `createHookEngine(createHookRegistry())`,
  loads hooks from config, executes `afterCreateSession`, and writes
  `backgroundHookStatus`+`backgroundHookErrors` back to the DB.
- **Pre-fix:** the handler set `backgroundHookStatus="running"` and
  returned; in-file comment admitted "Phase 6 will add full retry
  semantics".
- **Fix:** real implementation in
  `electron/main/ipc/sessions.ts:367` mirroring master line-for-line —
  gated on `backgroundHookStatus === "failed"`, builds a fresh registry
  from `loadConfig(projectPath)`, fires the engine fire-and-forget,
  persists the report (success → `completed`/`null`, failure →
  `failed`+truncated stdout/stderr JSON).

### Major 3 — `db:projects:list` missing sync + port reconcile

- **Master behavior:** `GET /api/projects` calls `scanDiskWorktrees`
  to auto-insert missing rows, hits the daemon `/sessions/list` to
  reconcile ports + `.env`, and resets stale `backgroundHookStatus:
  "running"` rows after a crash. Throttled to once per 5 s per project.
- **Pre-fix:** a plain `SELECT *`.
- **Fix:** new `syncProject(projectPath, daemonClient, force?)` helper
  in `electron/main/ipc/db.ts:103`, throttled via `lastScanAt: Map`,
  called from `db:projects:list` and the new `sync:project` channel.

### Major 4 — `POST /api/sync` had no IPC counterpart

- **Master behavior:** dedicated endpoint to manually trigger the
  disk+daemon sync.
- **Pre-fix:** the renderer had no path to force a refresh other than
  the 30 s `useProjects` poll.
- **Fix:** new `sync:project` channel + `window.api.sync.project()`
  preload entry. `IPC_CHANNEL_COUNT` is now 30 (was 29).

### Major 5 — `db:projects:delete` left orphans

- **Master behavior:** per session, `removeWorktree(p.path, s.id, {
  currentBranch: s.branch, force: true })` and
  `daemonClient.releaseSession(clientId, s.id)`, then the DB rows go.
- **Pre-fix:** only `db.delete(sessions)`+`db.delete(projects)`. Disk
  worktrees stayed; daemon kept the port allocations forever.
- **Fix:** new handler in `electron/main/ipc/db.ts:234` iterates sessions
  best-effort (failures recorded in a `failed[]` array instead of
  blocking the delete — otherwise a stuck session would make a project
  un-deletable).

### Major 6 (was "Partial 6") — `sessions:delete` no SSE

- **Master behavior:** when the renderer requests
  `Accept: text/event-stream`, the handler streams `step` events
  through the delete pipeline.
- **Pre-fix:** the handler `await`ed the whole pipeline and returned
  once; the renderer could only see the final result.
- **Fix:** `electron/main/ipc/sessions.ts:164` now passes an `onStep`
  callback to `sessionLifecycle.remove` that sends
  `session:<id>:step` IPC events, plus a final `session:<id>:complete`
  on success/failure — same shape as `sessions:create`. The renderer's
  existing `sessions.stream(id).onStep`/`onComplete` API works
  unchanged.

### Major 7 — `sessions:rename` didn't rename git branch

- **Master behavior:** `renameWorktree(projectPath, sessionId, newName,
  session.branch)` is called; both `name` and `branch` are written.
- **Pre-fix:** only `db.update(sessions).set({ name })`. The on-disk
  branch stayed at `agentdock/<original-id>`, so a later delete would
  leave a dangling branch — exactly the bug 8ec663a fixed.
- **Fix:** `electron/main/ipc/sessions.ts:258` calls `renameWorktree`,
  threads back `result.newBranch`, and updates `branch` alongside `name`.

### Major 8 — `worktree:orphans` only scanned directories

- **Master behavior** (after 8ec663a): union of `scanOrphanWorktrees` +
  `scanOrphanBranches`. The latter builds `knownBranches` from DB
  sessions ∪ `listWorktrees` output, then flags any
  `refs/heads/agentdock/*` branch outside that set.
- **Pre-fix:** only directory scan.
- **Fix:** `electron/main/ipc/worktree-shell.ts:52` builds the
  knownBranches set + unions both scans. `scanOrphanBranches` /
  `removeOrphanBranch` ported from master into `plugins/worktree.ts`.

### Major 9 — `worktree:deleteOrphans` accepted only `paths`

- **Master behavior:** body `{ paths?, branches?, projectId? }`; paths
  routed through `removeOrphanDir`, branches through `removeOrphanBranch`,
  per-project path-prefix validation.
- **Pre-fix:** only `paths: string[]`. `OrphanCleanModal` (renderer)
  already sends the new body shape (`paths` + `branches`), so any user
  clicking "delete orphan branch" got a 4xx.
- **Fix:** `electron/main/ipc/worktree-shell.ts:90` accepts the union
  shape (incl. the legacy `paths`-only array for back-compat),
  validates prefixes with `realpath`+normalized comparison (Windows
  case-insensitive), routes each entry through the right helper.

### Prerequisite — DB singleton wiring

While fixing the above, found that `electron/main/ipc/index.ts:62`
hardcoded `getDb: () => null`, so every `sessions:*` handler that
checks `if (!db) throw` would throw. Existing e2e never exercised
`sessions:create` so it stayed hidden.

- **Fix:** moved the active-DB singleton into `plugins/db/index.ts`
  (`getActiveDb`/`ensureActiveDb`/`resetActiveDb`). Both
  `electron/main/ipc/db.ts` and `electron/main/ipc/sessions.ts` now
  share the same Drizzle handle via that module.

---

## 7. Trivial Fixes (applied this PR)

| Item | Action |
|---|---|
| `package.json` `"debug"` pointed at deleted `scripts/debug-headless.ts` | Re-pointed to `scripts/debug-start.ts` (the new pipe-everything launcher). |
| `package.json` `acceptance:phase5/6` referenced unimplemented test files | Removed; future phases re-add when the tests land. |
| `README.md` "开发说明" still listed `scripts/start.ts` + `vite.config.ts` | Rewritten to point at Electron + `electron.vite.config.ts`, `bun run dev`/`start`, and the new `--experimental-sqlite` requirement. |
| New e2e scripts | Added `test:e2e:trace`, `test:e2e:ui`, `test:e2e:devtools` to `package.json`. |
| Renderer `data-testid` audit | Page Object + minimum testid set added (see `e2e/pages/` and `docs/e2e-guide.md`). |

---

## 8. Audit Gaps Still Open

None as of this PR. Every routes-table row is either ✅ or 🛠. The
`bootstrap:health` assertion in `e2e/full-flow.spec.ts` was bumped from
`>=29` to `>=30` to track the new `sync:project` channel.

---

## 10. Architecture corrections (this PR)

Three architectural gaps where the Electron implementation diverged from
master's intent, surfaced during real-user testing and architectural
discussion:

### 10.1 `.env` port allocation to project root

**Master**: `writePortsToEnv` writes to `<worktree>/.env` (the worktree
copy). `config:get` reads from `projectPath/.env` (the project root).
The project root `.env` is the user-visible source of truth for their
dev-server port configuration.

**Pre-fix Electron**: AgentDock allocated ports only to the worktree
`.env`. The project root `.env` stayed stale (showing the user's original
`VITE_PORT=5173` or nothing). `config:get` read `projectPath/.env` but
it never had the allocated ports — so the config page always showed
stale / missing values.

**Fix**: `writePortsToEnv(worktreePath, ports, projectRoot?)` now writes
to BOTH paths — worktree (backward compat) and project root (user
visibility). Every call site in `sessions.ts` / `db.ts` /
`session-lifecycle.ts` passes `projectPath` as the third argument.

### 10.2 Daemon.json fixed at `~/.agentdock/`

**Master**: `daemon.json` always lives at `~/.agentdock/daemon.json`.
No environment variable override.

**Pre-fix Electron**: Added `AGENTDOCK_DAEMON_BASE_DIR` and
`AGENTDOCK_DATA_DIR` overrides to `DaemonManager` and
`daemon-discovery.ts`. This caused the discovery file to be written
to different locations depending on context, so two Electrons could
write their `daemon.json` to different directories and never see
each other — completely breaking multi-instance reuse.

**Fix**: Reverted to master's behavior — both `DaemonManager.baseDir`
and `daemon-discovery.ts:getDataDir()` hardcode
`path.join(os.homedir(), ".agentdock")`. All Electron instances on the
same machine share exactly one daemon, by design.

### 10.3 Auto-discovery of disk worktrees on `db:projects:list`

**Master**: `GET /api/projects` performs a full server-side disk-to-DB
reconciliation on every call (throttled to 30 s):
  1. `scanDiskWorktrees` → discover worktree dirs in `.agentdock/worktrees/`
  2. Auto-insert missing DB rows (+ `declareDiscoveredSession` to daemon)
  3. Sync daemon port state into DB
  4. Clean up stale DB rows (worktree gone from disk → release ports + DELETE)
  5. Reset stale `backgroundHookStatus: "running"` → `null`
The renderer just polls `useProjects()`; all reconciliation happens
server-side as a side-effect.

**Pre-fix Electron**: `db:projects:list` only did a basic `scanDiskWorktrees`
→ insert placeholder rows (no daemon declare, no stale cleanup). The
renderer could not see sessions created by other tools, by other
Electrons, or by manual `git worktree add` — even though the worktrees
existed on disk.

**Fix**: `syncProject()` in `electron/main/ipc/db.ts` now mirrors the
full 7-step master flow (throttled to 5 s per project). The renderer's
`useProjects()` poll triggers it automatically. The `sync:project` IPC
channel forces a full rescan (for explicit refresh buttons). New
`syncProjectPortsToDb` helper handles the daemon↔DB port
reconciliation.

### 10.4 Related: stale Electron process leak guard

The daemon multi-instance spec (`daemon-multi-instance.spec.ts`) exposed
that a leaked Electron process from a previous broken run could leave a
stale `clientRegistry` entry in the daemon, which would cause
`getSessionOwnership` to return "foreign" and block the current
Electron from claiming sessions. The spec now includes a post-test
cleanup step to remove the old client entry.

---

## 9. Additional Production Bugs Surfaced During E2E

The three e2e debugging paths (`session-lifecycle.spec.ts` IPC-only,
`session-ui.spec.ts` real-clicks, `session-hook.spec.ts` real-hook)
each surfaced bugs the other two could not:

### From `session-ui.spec.ts` (real clicks)

- **`useDeleteSessionSSE` never fired the IPC.** The renderer hook subscribed to
  `session:<id>:step`/`complete` and waited on a Promise that resolved
  on `complete`, but never called `window.api.sessions.delete()` to
  trigger the IPC. Every user click on "✕ Confirm" left the card stuck
  in `deleting` state forever. Fix: dispatch the IPC and let `complete`
  resolve the Promise — `src/lib/queries.ts:354-380`.
- **Prod renderer always showed "Not Found".** TanStack Router used the
  default `browserHistory`, but Electron loads the renderer from a
  `file://.../index.html` URL whose pathname is the absolute file
  path. `/` never matched, every route was "Not Found", the home page
  was invisible in prod builds. Dev mode (Vite dev server at `/`)
  hides the bug. Fix: switch to `createMemoryHistory({initialEntries: ["/"]})`
  in `src/main.tsx`.
- **All `sessions:*` handlers used the wrong `projectPath`.** They
  read `deps.getProjectPath()` (the process-wide active path = cwd)
  instead of looking up `projects.path` by `session.projectId`. With
  more than one project open, `removeWorktree` / `renameWorktree` /
  `loadConfig` / `retryHooks` all pointed at the wrong directory.
  Fix: resolve the owner project from DB inside each handler.

### From `session-hook.spec.ts` (real hook execution)

- **Hook exit codes were lost.** `plugins/hook-engine.ts` read
  `(error as { status?: number }).status` from Node's `exec` callback,
  but `ExecException.code` is where the exit code lives. Every
  non-zero exit was reported as `1` regardless of the actual code.
  Fix: read `.code` first, fall back to `.status`. Now `process.exit(7)`
  surfaces as `exitCode: 7` in `backgroundHookErrors`.
- **`backgroundHookStatus` never reached `"failed"`.** The IPC
  `sessions:create` handler only translated `afterCreateSession` step
  events (`running` → `completed`). The lifecycle's `report.success`
  only fails when a *required* hook fails — non-required async hooks
  that exit non-zero pass through as `report.success=true` and emit
  the `done` step. Result: an actual hook failure showed as
  `"completed"` and the renderer's failed-hook UI never lit up. Fix:
  wire `onBackgroundHookComplete` on the IPC side, inspect individual
  `report.results` (master's `POST /retry-hooks` did the same), persist
  `status="failed"` + a `backgroundHookErrors` JSON blob when ANY
  hook (required or not) failed.

### From `session-lifecycle.spec.ts` (IPC-only)

(Documented in §6 above — same root: `getDb=null` hard-coded,
`for await` on a non-iterable, missing `portService`, the `setImmediate`
subscribe race.)

### config:get 路径修复 + foreign 机制

- **config:get 读了错误 .env**：`config:get` 用 `getProjectPath()` 拿 `activeProjectPath`，但项目路径可能是 worktree（用户打开的是 `.agentdock/worktrees/<id>/`），导致读到 AgentDock 分配后的端口（5 个 key），而不是用户项目根 `.env` 里的变量名（比如只有 `FRONTEND_PORT`）。修复：`config:get` 接收 `projectId`，从 DB 查出 `projects.path`（真实项目根路径）读 `.env`。Preload bridge + renderer `useProjectConfig(projectId)` 都已传 projectId。

- **writePortsToEnv 覆盖项目根 .env**：之前的改动把分配端口同时写到 worktree `.env` 和项目根 `.env`，导致 `db:projects:list` 同步时把用户原有的 `.env` 覆盖为 5 个分配端口。修复：`writePortsToEnv` 只写 worktree 的 `.env`，项目根 `.env` 永远不动。

- **foreign 机制上线**：`main.ts` 加了 `sessionStatuses` map（owned/foreign/reclaimed/orphan），`syncProject` 里 `declareDiscoveredSession` 把 daemon 的 ownership status 存入 map；`db:projects:list` 返回 `runtimeStatus` 字段给渲染器；`SessionCard.tsx` 的 `isForeign` 判断生效，foreign session 显示 badge 并禁用删除/重命名。

### From the user's manual run (round 2 — terminal + delete-during-hook)

- **`pty-host.cjs` not copied to `out/main/` in prod.** `electron-vite
  build` only bundled `main.ts`, leaving `plugins/pty-host.cjs`
  behind. `terminalManager.ensureHost()` resolved the path via
  `__dirname` which in prod points at `out/main/` → ENOENT → Electron
  showed "Error launching app: Unable to find Electron app at
  out/main/pty-host.cjs". Fix: a `copyPtyHostPlugin` Vite plugin in
  `electron.vite.config.ts` copies the file at the end of every
  build. `terminal-manager.ts` also got a `resolvePtyHostPath()` that
  tries multiple candidate directories and throws a helpful error
  with the searched paths.
- **`spawn(process.execPath, [hostPath])` from main launches a new
  Electron app**, not Node. In Electron `process.execPath` IS
  `electron.exe`. Without `ELECTRON_RUN_AS_NODE=1` in the spawn env,
  electron treats `pty-host.cjs` as an app entry. Fix: set
  `ELECTRON_RUN_AS_NODE: "1"` so the spawned process runs as plain
  Node and node-pty works.
- **`webContents.postMessage(channel, msg, [transfer])` ports were
  routed through the wrong renderer transport.** The preload listened
  on `window.message` — but Electron delivers transferred ports on
  `event.ports` of an `ipcRenderer.on(channel)` event, never on
  window.message. Symptom: every terminal stuck at `data-status=
  "connecting"`. Fix: preload subscribes via `ipcRenderer.on
  ("terminal:port", ...)`.
- **ContextBridge stripped `MessagePort.start()` / `.onmessage`.**
  Even after fixing the transport, handing the port through a
  contextBridge-exposed callback wrapped it and removed its methods
  → renderer crashed with `Uncaught Error: port.start is not a
  function`. Fix: preload re-dispatches via `window.postMessage(msg,
  "*", [port])` — the renderer's `terminal-cache.ts` then subscribes
  to `window.message` directly (NOT via the contextBridge `onPort`
  callback) so it receives the native DOM MessagePort with methods
  intact.

### Related to React's "Maximum update depth exceeded"

The user reported a React infinite-loop error after deleting a
session that had a running async hook. Root cause was downstream of
the `useDeleteSessionSSE` bug above: the mutation's Promise never
resolved (because no IPC was dispatched), so the optimistic
"deleting" state stayed forever; the `useBackgroundHookStatus` 2 s
poll kept invalidating the projects cache, every re-render brought
the deleting card back, and TanStack's mutation pending state +
React effect cascade eventually tripped the 50-update guard. Fixing
`useDeleteSessionSSE` (have the mutation actually dispatch the
delete IPC) made the symptom disappear.

The repro spec `session-ui-slow-hook.spec.ts` plus
`session-ui-interaction.spec.ts` both now run the full
hook → delete → renderer-quiet sequence and assert that no
`console.error` (which is how React surfaces the loop) was logged.
