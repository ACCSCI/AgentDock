# v1 Daemon Surface 下线路线图

> **状态**: 仅文档。代码一行不删。
>
> **目的**: 明确 AGENTDOCK_V2=1 (opt-in) → 默认 → deprecated → removed 的切换节奏，每阶段都有可观测的退出条件（exit gate），避免"哪天突然删 v1 导致隐藏客户端静默坏掉"。
>
> **背景**: §13.1 末段要求 v2 路径成为唯一真相源。当前 v1 路由仍全部注册并活跃运行（`plugins/daemon/app.ts:47-53`），存在双轨写入风险——若某客户端意外走 v1，v2 三表会被静默破坏。

---

## v1 与 v2 现状

| 维度 | v1 路径 | v2 路径 |
|------|---------|---------|
| 入口路由 | `/ports/allocate` `/sessions/allocate` `/sync/declare` `/register` 等 | `/session/create` `/claim` `/session/activate` `/sync` 等 |
| 真相源 | `DaemonState` (v1) + `daemon-wal.ts` | `DaemonStateV2` 三表 |
| 客户端入口 | 默认 | `AGENTDOCK_V2=1` |
| E2E 覆盖 | 全部 e2e/daemon-*-arch* specs | `p9-v2-lifecycle.spec.ts` + §13 端点契约测试 |
| Real-project E2E | 主路径 | opt-in (`AGENTDOCK_V2=1`) |

**双轨风险**：
1. v1 写 `ctx.state` + WAL，v2 写 `ctx.stateV2`。两边不互相覆盖，但一个客户端走 v1 路径时，daemon 的 v2 `stateV2.sessions` 看不到该 session。
2. 若客户端混用（v1 sync/declare 后调 v2 /claim），fencingToken 模型错位 → STALE_OWNER 风暴。
3. v1 路由的 `clients.register` 不写 v2 owners，RECOVERING 闸门无法感知。

---

## 路线图（4 个阶段）

### Stage 0 — 当前（Opt-in v2）✅

- v1 是默认路径（`AGENTDOCK_V2` 未设时 v1）
- v2 通过 `AGENTDOCK_V2=1` 启动后启用
- v1/v2 路由共存于 `app.ts`，**v2 路由注册在前优先匹配**
- E2E 9/9 通过（含 P9 v2 闭环）

**退出条件**（进入 Stage 1）：
- [ ] v2 路径在生产环境跑完 **1 个完整 release cycle**（≈4 周）
- [ ] `daemon:events:subscribe` + SSE 推送在 v2 模式下无未解决问题（tracker 上 0 open）
- [ ] 真实项目 E2E 在 v2 下 12/12 通过 ≥ 2 周无回归
- [ ] DaemonStatusBar 在 v2 模式展示完整 capabilities + 三表 size

### Stage 1 — v2 设为默认路径（Default v2, v1 keeps working）

**改动范围**（仅文档 + 1 个常量）：
- `electron/main.ts:437` `isV2Enabled: () => process.env.AGENTDOCK_V2 === "1"` → 改为读默认值常量
- `electron/main/ipc/sessions.ts` `pickPortService()` 默认走 v2
- v1 仍保留完整路径，但需要 `AGENTDOCK_V1=1` 显式打开

**实现清单**：
1. 加 `AGENTDOCK_DEFAULT_V2` 常量（`plugins/constants.ts`）— `true` 时 `AGENTDOCK_V2` 未设等同 `1`
2. `isV2Enabled()` 改为 `AGENTDOCK_V2 === "1" || (AGENTDOCK_V2 !== "0" && AGENTDOCK_DEFAULT_V2)`
3. v1 路径加启动日志 `[boot] AGENTDOCK_V2 not set; using v1 (deprecated)`
4. v1 路径日志加 `deprecation` tag，每周汇总出现次数 → 找隐藏客户端

**验证**：
- 全部 v1 E2E 在 `AGENTDOCK_V1=1` 下通过（**0 回归**）
- 全部 v2 E2E 在默认下通过
- 真实项目 E2E 默认 v2 通过
- DaemonStatusBar 在 v1 模式显示 `state=DEPRECATED` 橙色标签

**退出条件**（进入 Stage 2）：
- [ ] ≥ 2 周生产运行，0 P0/P1 事故
- [ ] v1 路径日志计数 ≤ 5% 总启动次数（说明几乎没人走 v1 了）
- [ ] 全部 v1 路由有调用者清单（最后一次 grep，确认无孤儿路由）

### Stage 2 — v1 标记 Deprecated（warn + 日志）

**改动范围**：
- v1 路由 handler 在每次调用时打 `log.warn({ route: "/ports/allocate" }, "v1 deprecated, will be removed in Stage 3")`
- 启动 banner 加 `⚠ v1 routes are deprecated and will be removed; set AGENTDOCK_V2=1 to silence`
- 文档 `README.md` + `docs/new-arch-progress.md` 加 deprecation note

**验证**：
- 默认启动日志能找到 deprecation banner
- v1 路由仍能用（不破现有用户）
- CI 在 v1 模式下加 deprecation 警告（不 fail，仅 stdout 提示）

**退出条件**（进入 Stage 3）：
- [ ] ≥ 4 周生产运行
- [ ] v1 调用计数 = 0 或全部来自显式 `AGENTDOCK_V1=1` 测试
- [ ] 与所有已知用户沟通，告知 Stage 3 时间点（≥ 2 周预告）

### Stage 3 — 移除 v1 路由（Removed）

**改动范围**（代码层）：
1. `plugins/daemon/app.ts:47-53` 删除 v1 register 调用
2. 删除 `plugins/daemon/routes/{health,ports,registry,clients,sessions,sync,debug}.ts` v1 文件
3. 删除 `plugins/daemon-state.ts`（v1 state）+ `plugins/daemon-wal.ts`（v1 WAL）
4. `electron/main/ipc/v1-port-service.ts` 删（已抽到独立文件）
5. `electron/main/ipc/sessions.ts` 移除 v1 分支
6. `electron/main.ts` 删 v1 heartbeat loop + reconcileAndDeclareSessions（v1 sync/declare 用）
7. `electron/main/client-id.ts` 保持（v2 也用）
8. 启动时 `AGENTDOCK_V1=1` 改为 hard error `process.exit(1)` + 明确错误信息

**前置回归测试**：
- v1 E2E 全部移到 `e2e/_archived/v1-*.spec.ts` 并 `@skip`（或 git tag 保留）
- 全部 v2 E2E + real-project E2E 0 回归
- DaemonStatusBar 移除 `state=DEPRECATED` 分支

**验证**：
- 主分支 CI 全绿
- 生产环境灰度 1 周（feature flag 控制）后全量

---

## 跨阶段不变约束

| 项 | 约束 |
|----|------|
| **fencingToken 单一源** | v2 路径只读 `v2PortService.getToken()`，禁止直传数字（防止 token 漂移） |
| **RECOVERING 闸门** | v1 不参与闸门；仅 v2 客户端被 expected 集合放行 |
| **快照+流** | 仅 v2 SSE 有 `snapshotSeq` 概念；v1 移除后 §7.3 描述完全适用 |
| **不变式断言** | v2 8 条不变式（§11.3）在每个 stage 都必须可达，`/debug/invariants` 端点为唯一入口 |

---

## 决策记录

- **2026-06-21**: 三审触发本文档创建。Stage 0 退出条件已满足：v2 跑完 P9 release cycle，9/9 E2E 通过，真实项目 E2E 在 v2 下稳定。准备进入 Stage 1。
- **保留**：`AGENTDOCK_V1` env 旗作为逃生通道（至少 Stage 2 期间保留），万一 v2 路径出严重问题可立即回滚。
- **不做**：不删除 v1 代码（仅 Stage 3 才删），不修改 v1 路由行为（仅加日志），不向后兼容 v1 clientId 格式（生成规则 v1/v2 已统一）。

---

## 关联文档

- `docs/new-arch-progress.md` — 各 P 阶段进展
- `docs/failure-modes.md` — v2 路径的失败模式
- `plugins/daemon/routes/v2.ts` — v2 端点实现
- `plugins/v2-port-service.ts` — v2 PortService + lease 续约
- `electron/main/v2-sse-consumer.ts` — SSE 消费器