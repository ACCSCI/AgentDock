# AGENTS

> 本文件是给所有 contributor（包括 AI agent）阅读的项目级指引。架构、测试、用户测试的当前规则都在这里。

## 架构现状

### 单实例架构（0.1.x 当前状态）

- AgentDock 0.1.x 运行在 **单个 Electron 进程**里，所有 session/port/state 都由这个进程拥有（`SessionManager`、`PortPool`）。**没有独立的 daemon 进程**——`DaemonStatusBar` 已在 PR #108 中移除，因为单实例下这个栏位只是静态 "Running" 文字，没有信息价值。
- 状态分两份 SQLite 存储：
  - **全局项目 DB**：dev 模式在 `<userDataDir>/global/projects.db`，生产在 `~/.agentdock/projects.db`——存已打开的项目（`id, name, path, createdAt`）
  - **项目 DB**：在 `<userDataDir>/data/db.sqlite`——存当前激活项目的 `sessions` 和 `todos`
- `SessionManager` 是纯内存的，session 的生命周期状态（`creating | active | deleting`）和步骤进度持久化到项目 DB 的 `sessions.status` / `sessions.steps` 列，渲染端通过 `db:projects:list` 直接读，不需要 SSE/streaming。

### Dev 模式 userData 隔离

- `AGENTDOCK_DEV_INSTANCE=<N>` 环境变量（由 `scripts/dev-instance.ts` 设置）标记 dev 模式。
- 设了之后，`projects.db` 跟随 `<userData>/global/projects.db`，不再用生产路径 `~/.agentdock/projects.db`。这样多个 dev AgentDock 实例可以并行跑而不撞共享 SQLite 文件。
- **不设时行为等同于生产**（单实例、单全局 `~/.agentdock/projects.db`）。
- 默认保持生产行为；dev/测试需要并行时显式设 `AGENTDOCK_DEV_INSTANCE=1`。
- Worktree 目录（`<project>/.agentdock/worktrees/`）是项目级的，不跟随 userData——dev 和生产用的是同一份。
- `app.requestSingleInstanceLock()` 以 `userData` 为 key，所以 dev 实例只要 `--user-data-dir` 不同就能共存；生产单实例不变量保持不变。

## 测试隔离流水线

测试按"在哪跑"分成三层，**不要跨层迁移**：

| 层 | 跑在哪 | 跑什么 | 触发方式 |
|---|---|---|---|
| CI | GitHub Actions runner | typecheck + lint + unit + build | push/PR 自动 |
| 本地 dev | 开发者机器 | unit + integration + acceptance + e2e（59 个 spec） | `bun run test` / `bun run test:e2e` |
| 用户测试 | 开发者机器 | 探索性 UI 流程测试（见下文） | `npx flue run user-agent` |

### 为什么 CI 不跑 e2e

GitHub runner 是共享临时虚拟机，Electron 在上面启动不稳定（字体/端口/显示系统都不可控）。CI 守住"代码能 build + 单测过"这条线就够了。

### 并行实例隔离规则

每个并行运行的实例（e2e test、user-agent、多 dev 窗口）启动 Electron 时**必须**带：
- `--user-data-dir=<独立目录>` —— 隔离项目 DB（`data/db.sqlite`）
- `AGENTDOCK_DEV_INSTANCE=1` —— 隔离全局 DB（`<userData>/global/projects.db`）

这两个 flag 一起用能产生完全自洽的 AgentDock 实例，不与其它实例在 SQLite、端口、session 状态上冲突。

`<userData>/global/projects.db` 这个路径是 v9/v10 schema 迁移加的——之前共享的 `~/.agentdock/projects.db` 是并行测试的撞车点。

## 用户测试（User-agent Testing）

- **是什么**：一个 Flue agent（Astro 团队的 `@flue/runtime`），模拟真实用户点击 AgentDock UI 来发现 UX bug。不进 CI，按需在开发者机器上跑。
- **实现位置**：`.flue/` 目录（agents / tools / app）。详见 `.flue/agents/user-agent.ts`。
- **怎么跑**：`npx flue run user-agent --target node --input '{"message":"targetProject=<path>"}'`
- **实际做了什么**：
  1. Claude Sonnet 4.6 读 instructions + targetProject
  2. 通过 bash sandbox 调 `.flue/tools/launch-electron.ts`
  3. 读 JSON 报告 + 截图
  4. 失败时读相关源码
  5. 输出结构化报告：passed/failed 步骤、根因、影响文件、截图路径
- **价值**：发现所有手写 e2e spec 漏掉的 bug——例如 `src/routes/app.$projectId.tsx:22` 的 `project?.sessions.find` optional chain 错误导致打开项目时崩溃，所有 59 个 spec 没一个真正"打开项目"所以没碰到。
- **前置条件**：需要先 `npx electron-vite build`（agent 启动时会自己检查并提示）。

## 环境变量加载

- AgentDock 运行时代码加载 `.env` 时用 `plugins/env.ts` 里的 helper。
- 优先用 `readEnvFile()` 而不是临时写正则解析——这样引号包裹的值和行内注释能正确处理。

## Worktree 子进程隔离

- Worktree 范围内的子进程构造环境变量顺序：
  1. 清理过的继承环境
  2. 当前 worktree 的 `.env`
  3. 显式的 `AGENTDOCK_*` 运行时变量
- 不要依赖 Bun/Vite/框架的 dotenv 自动加载去覆盖继承的父进程值。
- 保留"先清理再覆盖 workspace env"的行为，除非有明确语义改动。

## Vite watcher

- `.agentdock/**` 和 `.claude/**` 排除在 Vite 文件监听之外——避免 session 管理或 Claude 使用时触发无关重载。
- `.agentdock-dev/**` 也排除——dev 模式的 per-instance userData 目录在那里（见 "Dev 模式 userData 隔离"）。