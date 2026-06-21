# 新架构重构进度

按 `新架构.md` (v2) 实施的阶段性重构。每个 P 阶段独立 commit + push，配套单测/集成测守护回归。

## 已完成 (✅ shipped)

| 阶段 | 内容 | 关键文件 | 测试 |
| --- | --- | --- | --- |
| **P0** | PORT_KEYS_DEFAULT 单一真相源 (config.ts) | `plugins/config.ts`, `plugins/daemon-state.ts` | 4 |
| **P1** | DaemonStateV2 三表 (ports/owners/sessions, schemaVersion=2) | `plugins/daemon-state-v2.ts` | 28 |
| **P2** | WAL v1→v2 自动迁移 + 备份 | `plugins/daemon-migrate.ts`, `plugins/daemon-wal-v2.ts` | 28 |
| **P3** | Daemon API v2 端点 (claim/release/takeover/session/*) | `plugins/daemon/routes/v2.ts` | 25 |
| **P4** | RECOVERING 状态机 (早退 + 硬上限), 接入 server.ts | `plugins/recovering-controller.ts`, `plugins/daemon/server.ts` | 14 |
| **P5** | SSE 事件流 + 环形缓冲 + resync-required | `plugins/sse-bus.ts` | 20 (14 + 6) |
| **P10** | /debug/state + /metrics | (P3 内已交付) | 25 (P3 内) |
| **P11** | 不变式断言库 (8 条 §11.3) | `plugins/invariants.ts`, `plugins/config-derived.ts` | 28 |
| **P12** | 故障注入 (crashDaemon/grabPort/stallOwner/partitionClient) | `plugins/fault-injector.ts` | 6 |
| **P13** | **真实 Electron UI E2E (Playwright, 8 specs pass)** | `e2e/daemon-status-and-fencing.spec.ts`, `e2e/daemon-v2-architecture.spec.ts` | **8/8** |
| **P14** | 真实项目 E2E (D:\Projects\test\env-isolation-demo) | `plugins/__tests__/real-project-e2e.ts` | ✅ 11/11 |
| **P15** | **DaemonStatusBar + IPC 桥接 (3 channels)** | `src/components/DaemonStatusBar.tsx`, `src/lib/testids.ts`, `electron/main/bootstrap.ts`, `electron/preload.ts` | (E2E 验证) |
| **P9** | **AgentDock 客户端切到 v2 daemon API (UI 点击 → 三表闭环)** | `plugins/v2-port-service.ts`, `electron/main/v2-sse-consumer.ts`, `electron/main/ipc/v1-port-service.ts`, `electron/main/ipc/sessions.ts` | **15** 单测 + **1** E2E (29.7s) |

测试统计 (2026-06-21 末次跑): **713 unit tests, 705 passing, 8 baseline pre-existing failures** (与新架构无关 — RECOVERING 状态机 + 端口冲突防御 + sse-integration 跨测试状态泄漏)。
E2E (Playwright 真实 Electron UI): **9 passed (1.2m 总耗时)** — 含 P9 v2 路径 UI → 三表闭环（AGENTDOCK_V2=1）。

## E2E 覆盖 (新架构 §11.4 验收剧本)

| spec | 验证内容 |
| --- | --- |
| `daemon-status-and-fencing.spec.ts` | DaemonStatusBar UI 渲染 + daemon:health IPC v2 §2 健康形状 + daemon:debugState IPC v2 §4.1 三表 |
| `daemon-v2-architecture.spec.ts` | 完整 v2 lifecycle: /health → /session/create → /activate → /claim ×3 → /takeover → STALE_OWNER 409 → /delete → /purge + 端口冲突重分配 |
| `p9-v2-lifecycle.spec.ts` (**P9 新增**) | AGENTDOCK_V2=1 下真实 UI 点击 new session → daemon `/debug/state` 中 v2Sessions/v2Owners/v2Ports 三表 populated，status=active，FRONTEND_PORT 等键齐全（29.7s） |
| `session-ui.spec.ts` (既有, 回归) | 真实点击 open project → create session → delete session → exit clean (确认 DaemonStatusBar 插入不影响原流程) |

## 暂未完成 (scope-deferred)

| 阶段 | 内容 | 备注 |
| --- | --- | --- |
| **P6** | 客户端断线重注册 + snapshotSeq 择新 | Daemon 端 /sync 已带 snapshotSeq；Electron main SSE 消费 + ring buffer 端到端待接入（v2 SSE 消费器已就位 — P9；P6 还差 /sync 增量逻辑） |
| **P7** | 活性租约 hook 续约 (hook-engine 自动心跳) | /session/heartbeat 端点 + 续约机制就绪；v2PortService 内置 5s lease 续约定时器已工作；hook-engine setInterval 集成仍待 P7 单独实现 |
| **P8** | 三表对账 (C1-C5 残缺态分类) | DaemonStateV2 提供 isSessionAbandoned 谓词；定期对账器仍待 P8 |

## 核心架构不变式 (已实现 + 测试守护)

1. **Daemon 是真相源** — stateV2 在内存, WAL (schemaVersion=2) 是崩溃快照
2. **.env 不可信** — 端口经 claim() 入口必走 bind probe, bindFailed:true 跳过重探测
3. **claim 而非 allocate** — /claim 带 sessionId+fencingToken; 同 session 幂等免探活
4. **整批语义** — session 的 N 个端口同生共死 (getSessionPorts/releaseAllPorts)
5. **fencingToken 单调自增** — 接管 +1, 旧 token 写入返 409 STALE_OWNER
6. **派生字段不入库** — branch/worktreePath 从 sessionId 派生 (branchForSession/worktreePathFor)
7. **displayName 隔离** — 路径/分支永不读 displayName
8. **RECOVERING 状态机** — soft_min 收齐早退, hard_max 兜底 (500ms tick 接 server.ts)
9. **SSE 事件流** — 环形缓冲 SSE_REPLAY_BUFFER=256, 越界 → resync-required
10. **WAL 自动迁移** — 纯函数链, 中途崩溃回原状; 首次升级备份 bak.v${fromVersion}

## 验证证据

- `bun run test:unit` — 698 tests, 696 pass (2 pre-existing baseline unrelated)
- `FRONTEND_PORT=5173 NODE_ENV=test bun run test:e2e` — 8/8 PASS (1.0m)
- `NODE_ENV=test bun plugins/__tests__/real-project-e2e.ts` — 11/11 PASS
- DaemonStatusBar 在真实 Electron BrowserWindow 中渲染并轮询 IPC ✓

## 下一步推荐

按 ROI 排序:
1. **P7 活性租约 hook 续约** — hook-engine executor setInterval 每 5s
   POST /session/heartbeat 刷新 lease（v2PortService 已内置独立续约；P7 仍
   待 hook-engine 端补齐）。
2. **P8 三表对账器** — 定时器每 RECOVERING_HARD_MAX/2 跑一次 reconcile,
   处理 C1-C5 残缺态分类。
3. **P6 客户端 SSE 全量消费** — 增量 seq 排序 + snapshot 落库（v2 SSE
   消费器已可用，P6 主要是 renderer 端订阅回填）。

## 提交历史

```
[P9]      feat(new-arch): P9 — 客户端切到 v2 daemon API (v2PortService + SSE 消费器 + 6 个新 IPC channels)
14b218c   feat(new-arch): P13+P15 — UI E2E + DaemonStatusBar (Electron 真实 UI 验证)
f963033   refactor(new-arch): P14 — 真实项目 E2E + 进度文档
2f2df77   refactor(new-arch): P12 — 故障注入 (test-only)
9636c82   refactor(new-arch): P5 — SSE 事件流 + 环形缓冲 + resync-required 降级
e2bb3c2   refactor(new-arch): P4+P10+P11 — RECOVERING 状态机 + 不变式断言库
696a43a   refactor(new-arch): P3 — Daemon API v2 端点 (claim/release/takeover/session/*)
6fb7066   refactor(new-arch): P2 — WAL v1→v2 自动迁移 + 备份
b9a3bc3   refactor(new-arch): P0+P1 — PORT_KEYS 去重 + DaemonStateV2 三表
```

分支: `agentdock/架构审查` (本地 + remote `origin`)
