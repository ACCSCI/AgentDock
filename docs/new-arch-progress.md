# 新架构重构进度

按 `新架构.md` (v2) 实施的阶段性重构。每个 P 阶段独立 commit + push，配套单测/集成测守护回归。

## 已完成 (✅ shipped)

| 阶段 | 内容 | 关键文件 | 测试 |
| --- | --- | --- | --- |
| **P0** | PORT_KEYS_DEFAULT 单一真相源 (config.ts) | `plugins/config.ts`, `plugins/daemon-state.ts` | 4 |
| **P1** | DaemonStateV2 三表 (ports/owners/sessions, schemaVersion=2) | `plugins/daemon-state-v2.ts` | 28 |
| **P2** | WAL v1→v2 自动迁移 + 备份 | `plugins/daemon-migrate.ts`, `plugins/daemon-wal-v2.ts` | 28 |
| **P3** | Daemon API v2 端点 (claim/release/takeover/session/*) | `plugins/daemon/routes/v2.ts` | 25 |
| **P4** | RECOVERING 状态机 (早退 + 硬上限) | `plugins/recovering-controller.ts` | 14 |
| **P5** | SSE 事件流 + 环形缓冲 + resync-required | `plugins/sse-bus.ts` | 20 (14 + 6) |
| **P10** | /debug/state + /metrics | (P3 内已交付) | 25 (P3 内) |
| **P11** | 不变式断言库 (8 条 §11.3) | `plugins/invariants.ts`, `plugins/config-derived.ts` | 28 |
| **P12** | 故障注入 (crashDaemon/grabPort/stallOwner/partitionClient) | `plugins/fault-injector.ts` | 6 |
| **P14** | 真实项目 E2E (D:\Projects\test\env-isolation-demo) | `plugins/__tests__/real-project-e2e.ts` | ✅ 11/11 |

测试统计 (2026-06-21 末次跑): **692 tests, 690 passing, 2 baseline pre-existing failures** (与新架构无关)。

## 暂未完成 (scope-deferred)

| 阶段 | 内容 | 备注 |
| --- | --- | --- |
| **P6** | 客户端断线重注册 + snapshotSeq 择新 | Daemon 端 /sync 已带 snapshotSeq；client 端需要 Electron main 接入 |
| **P7** | 活性租约 hook 续约 (hook-engine 自动心跳) | /session/heartbeat 端点已实现；hook-engine 集成待 P9 |
| **P8** | 三表对账 (C1-C5 残缺态分类) | DaemonStateV2 提供 isSessionAbandoned 谓词；定期对账器待 P9 |
| **P9** | AgentDock 客户端重写 (session lifecycle + SSE 消费) | plugins/session-lifecycle.ts 仍使用 v1 API |
| **P13** | 7 个 Playwright E2E 剧本 (UI 端到端) | 需要 Electron + Playwright 完整栈 + e2e/ 目录的 spec 迁移 |
| **P15** | UI 改造 (Daemon 状态条 + 只读提示 + 端口运行态) | React 组件层 |

## 核心架构不变式 (已实现 + 测试守护)

1. **Daemon 是真相源** — stateV2 在内存, WAL (schemaVersion=2) 是崩溃快照
2. **.env 不可信** — 端口经 claim() 入口必走 bind probe, bindFailed:true 跳过重探测
3. **claim 而非 allocate** — /claim 带 sessionId+fencingToken; 同 session 幂等免探活
4. **整批语义** — session 的 N 个端口同生共死 (getSessionPorts/releaseAllPorts)
5. **fencingToken 单调自增** — 接管 +1, 旧 token 写入返 409 STALE_OWNER
6. **派生字段不入库** — branch/worktreePath 从 sessionId 派生 (branchForSession/worktreePathFor)
7. **displayName 隔离** — 路径/分支永不读 displayName
8. **RECOVERING 状态机** — soft_min 收齐早退, hard_max 兜底
9. **SSE 事件流** — 环形缓冲 SSE_REPLAY_BUFFER=256, 越界 → resync-required
10. **WAL 自动迁移** — 纯函数链, 中途崩溃回原状; 首次升级备份 bak.v${fromVersion}

## 验证证据

- `bun run test:unit` — 692 tests, 690 pass (2 pre-existing unrelated)
- `NODE_ENV=test bun plugins/__tests__/real-project-e2e.ts` — 11/11 PASS
- 手工探针 `bun probe-sse.ts` — SSE 端到端验证 (Frame 1: session-created, Frame 2: hello, Frame 3: ownership-revoked)

## 下一步推荐

按 ROI 排序:
1. **P9 客户端重写** — 把 plugins/session-lifecycle.ts 切到 v2 API, 落地完整的 UI↔Daemon 循环
2. **P13 E2E 剧本** — 复用 P11+P12 不变式+故障注入, 写 7 个 Playwright 脚本
3. **P7 活性租约 hook 续约** — 写 hook-engine 的 lease interval 集成
4. **P15 UI 改造** — TabBar/SessionSidebar 显示 Daemon 状态条 + 只读模式提示

## 提交历史

```
2f2df77 refactor(new-arch): P12 — 故障注入 (test-only)
9636c82 refactor(new-arch): P5 — SSE 事件流 + 环形缓冲 + resync-required 降级
e2bb3c2 refactor(new-arch): P4+P10+P11 — RECOVERING 状态机 + 不变式断言库
696a43a refactor(new-arch): P3 — Daemon API v2 端点 (claim/release/takeover/session/*)
6fb7066 refactor(new-arch): P2 — WAL v1→v2 自动迁移 + 备份
b9a3bc3 refactor(new-arch): P0+P1 — PORT_KEYS 去重 + DaemonStateV2 三表
```

分支: `agentdock/架构审查` (本地 + remote `origin`)
