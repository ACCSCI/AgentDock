# 新架构 Post-fix 迭代 Backlog

> 上下文: 新架构 §11.5 验收清单 + 10 项缺口修复 (commit `29fb2d6`) 完成后,
> 仍有 3 项**不在 §11.5 硬门槛内**但应当在下个迭代清理的事项. 本文档
> 用于审阅与排期.

**完成基线**: 27/27 任务, 765/768 单测通过, 3 个 pre-existing 失败
(config A8b / port-conflict-defense T7 / sse-integration) 与本批无关.

---

## 迭代项 #1 — `syncResources` 全链路回滚 (v2 流程侧)

### 范围
新架构 §4.2 末段规定:

> 资源同步(syncResources)属 creating 段内步骤: 紧随 `git worktree add`
> 之后、`claim` 之前执行, 按 `config.resources.sync` 把父项目共享资源
> (依赖、配置、`.env` 基线等) 拷贝/合并进新 worktree. 它**纳入 create
> 的回滚链**——同步失败须释放本事务已占端口、清理半建 worktree.

### 当前实现缺口

`electron/main/ipc/sessions.ts` 的 `sessions:create` handler:

1. 走 `v2PortService.allocateSession()` — 内含 create→claim×N→activate 全链,
   任一失败自动调 `/session/delete` + `/session/purge` (commit `29fb2d6`
   之后) 释放 daemon 端端口.
2. **但 worktree 物理创建 + 资源同步由 session-lifecycle.ts 流程层编排**,
   在 v2 path 下, syncResources 失败时未走"删 worktree + 释放端口"的
   完整回滚链.

### 修复路径

| 步骤 | 文件 | 内容 |
|---|---|---|
| 1 | `electron/main/ipc/sessions.ts` | 在 `sessions:create` 成功跑完 v2 allocateSession 后, 调 `sessionLifecycle.create()` 跑资源同步; 失败时主动调 `v2PortService.completeDeletion()` + worktree 清理 |
| 2 | `plugins/session-lifecycle.ts` | `create()` 内的 syncResources 失败 catch 块确保: 释放所有已 claim 端口 + 删 worktree + 调 v2 service `completeDeletion` |
| 3 | 新增单测 | `plugins/__tests__/v2-rollback.test.ts`: syncResources 失败时验证 worktree 被删 + 端口被 release + sessions 表无残留 |

### 验收
- 资源同步失败时, daemon `/debug/state` 看不到该 session
- worktree 目录被删除
- 所有 claim 过的端口回 FREE
- 现有 e2e `daemon-v2-architecture.spec.ts` / `p9-v2-lifecycle.spec.ts` 仍 pass

### 估时
中等 — 主要在 client-side 流程编排, 涉及 session-lifecycle.ts + IPC handler
两处协同, 约 4-6 小时含测试.

---

## 迭代项 #2 — v1 surface 全面下线

### 范围
架构 §12.3 明确"留接口不建设" — v1 路径不写分布式逻辑, 但没说 v1 本身
必须留. 当前 v1 与 v2 并存导致:

- `daemon-state.ts` 仍有 `allocatePorts(count)` 方法(标 @deprecated)
- `/ports/allocate`, `/ports/release`, `/sync/declare`, `/sessions/allocate`,
  `/sessions/release`, `/sessions/reassign` 6 个 v1 端点仍挂载在 Hono app 上
- `app.ts` 同时调 `registerV2` 和 `registerSessions` + `registerSync` + 
  `registerPorts` + `registerClients` + `registerRegistry`
- v1 state + v1 WAL + v1 sync/declare 测试 (compat-verify / db-migration /
  api-heartbeat / api-integration) 共占 3 个测试文件的全部 fixture
- `daemon-state.ts` 1019 行里约一半是 v1 富对象逻辑 (worktreeIndex / 
  projectPath / allocatedPorts 数组)

### 修复路径

| 阶段 | 内容 |
|---|---|
| 2a | **v1 routes 移除** (1d) — 删 `registerSessions` / `registerSync` / `registerPorts` 调用, 删 v1 端点, 保留 client routes (v1 仍要给 v1 client 用, 但 electron main 不用) |
| 2b | **v1 state 收缩** (1d) — `daemon-state.ts` 收缩为只保留 `clients` map (供 v1 /client/register heartbeat); sessions / ports / worktreeIndex 全部移除 |
| 2c | **daemon-state.ts.allocatePorts 删除** (0.5d) — 移除 @deprecated, 全代码库 grep 替换为 `port-allocator.ts:allocateNFreePorts` |
| 2d | **v1 测试迁 v2** (1d) — `compat-verify.test.ts` + `db-migration.test.ts` 改用 v2 routes; `api-heartbeat.test.ts` + `api-integration.test.ts` 删除 (v1 路径) |
| 2e | **daemon.ts 收缩** (0.5d) — `plugins/daemon.ts` 当前 1019 行, 其中大部分是 v1 back-compat 代码; 收缩为只导出 `AgentDockDaemon` Hono-based |

### 验收
- `app.ts` 只挂 v2 routes + health + debug + metrics + fault + events
- `daemon-state.ts` < 200 行
- `daemon.ts` < 200 行
- `bun run test:unit` 仍 ≥ 750 passing
- 现有 E2E (8 个) 0 回归

### 估时
4 天, 主工作量在测试迁移与回退守护.

### 风险
- 旧用户 (AGENTDOCK_V2 未设) 的 Electron 旧版会断 — 必须 `protocolVersion`
  升级到 `"2"` (主版本不匹配 → 拒绝连接, 架构 §13.4)
- 旧 daemon-state.json v1 schema 不再被读, 必须保留 daemon-migrate.ts v1→v2
  迁移 (已完成, 不动)

---

## 迭代项 #3 — Pre-existing 3 个测试失败修复

### 范围

不是新架构契约的缺口, 但是是测试通过率的硬指标 (3/768 = 0.4%).

| 测试 | 失败原因初判 | 文件 |
|---|---|---|
| `config.test.ts > A8b: YAML 中 async: true 被正确解析` | YAML `async: true` 解析时把 `required` 字段吞掉或类型不匹配 | `plugins/__tests__/config.test.ts` + `plugins/config.ts` |
| `port-conflict-defense.test.ts > T7: DB port conflicts with already-allocated → reallocates` | v1 sync/declare 在端口冲突时未触发重分配; v2 path 不再走 v1 sync/declare 后该测试 fixture 失效 | `plugins/__tests__/port-conflict-defense.test.ts` + `plugins/daemon-state.ts:allocatePorts` |
| `sse-integration.test.ts > port-reassigned event fires when claim conflicts` | SSE 事件在测试中发不出去, 可能是 ring buffer 初始化时机或 reconnect 流程问题 | `plugins/__tests__/sse-integration.test.ts` + `plugins/daemon/routes/v2.ts` |

### 修复路径

**3a. config A8b (0.5d)**
- 复现: 写一个最小 YAML `async: true required: true` 看 schema 校验是否抛错
- 修法: `config.ts:loadConfig` 的 backward-compat 补丁里, 给 `async: true`
  显式 `required: false` (已存在但可能不够细致)
- 测试: 加单测覆盖纯 `async: true` 无 `required` 字段的情况

**3b. port-conflict-defense T7 (1d)**
- 这是 v1 路径, 修法二选一:
  - (a) 修 v1 sync/declare 让端口冲突 → reallocate (老逻辑)
  - (b) 把这个测试迁到 v2 路径 (用 v2 /sync 替代 v1 /sync/declare)
- 推荐 (b), 因为 v2 path 是未来, v1 path 计划下个迭代删 (见 #2)

**3c. sse-integration T (1d)**
- 跑测试加 log, 看 ring buffer 在事件 publish 后是否真的写入
- 大概率是测试时序问题: `port-reassigned` 事件需要 §5.2 RECOVERING 闸门
  放行 + claim 触发; 修复后这个 test 可能仍 fail, 需把 fixture 改成显式
  `recoveringSoftMinMs: 0`

### 验收
- `bun run test:unit` 全部 768 通过
- 0 pre-existing 失败

### 估时
2-3 天, 含 debug 时间.

---

## 优先级建议

按 ROI 排序:

1. **#3 (pre-existing 3 失败)** — 2-3 天, 收益是 100% 测试通过率
2. **#1 (syncResources 全链路回滚)** — 4-6 小时, 补完架构 §4.2 流程侧承诺
3. **#2 (v1 surface 下线)** — 4 天, 涉及 protocolVersion 升级, 需协调旧用户

**推荐先做 #1** — 它是真正与新架构相关的硬缺口, 修复成本低; #3 与新架构
无关但提升测试通过率; #2 适合作为独立 PR 配套 release note 推进.

---

## 相关文件

- `docs/new-arch-progress.md` — 主进度文档 (commit `29fb2d6` 已记录)
- `新架构.md` §11.5 验收清单 (硬门槛)
- `新架构.md` §14.2 端口分配函数归位 (已修复)
- `新架构.md` §4.2 资源同步回滚链 (待 #1)
- `新架构.md` §12.3 v1 路径边界 (待 #2 决策)
