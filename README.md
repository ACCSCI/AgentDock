# AgentDock

> 开箱即用的 Git Worktree Session 管理系统 —— 为 AI Agent 开发量身打造。

[![Electron](https://img.shields.io/badge/Electron-42.4-blue?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.1-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## 什么是 AgentDock？

AgentDock 是一款 **Electron 桌面应用**，专为 AI Agent 开发场景设计。它允许开发者基于同一个项目创建多个**完全隔离的 Git Worktree Session**，每个 Session 拥有独立的：

- **Git Worktree** — 独立的工作目录和分支
- **端口分配** — 自动分配可用端口，避免冲突
- **环境变量** — 独立的 `.env` 配置
- **内置终端** — 支持 Claude Code、Copilot 等 AI 工具快速启动

所有操作通过统一的 GUI 管理，无需手动切换目录或管理端口。

![AgentDock Screenshot](docs/screenshot.png)

---

## 核心特性

### 🔒 Session 隔离

每个 Session 是一个完整的 Git Worktree，而非简单的分支切换。多个 Session 可以**并行运行、互不干扰**：

```
project/
  .agentdock/
    worktrees/
      abc123/     ← Session A (独立 worktree + 独立 .env + 独立端口)
      def456/     ← Session B (独立 worktree + 独立 .env + 独立端口)
      ghi789/     ← Session C (独立 worktree + 独立 .env + 独立端口)
```

### 🖥️ Terminal 集成

内置 xterm.js 终端，支持：

- **快速启动预设**：Terminal、Claude Code、GitHub Copilot
- **一键切换**：在 Session 间快速切换终端
- **字体定制**：支持 Cascadia Code、Fira Code、JetBrains Mono 等
- **智能缓存**：切换 Session 时终端状态保持

### 🔄 自动化工作流

Session 创建时自动执行：

```
1. BeforeCreateSession hooks
2. 创建 Git Worktree
3. 同步资源文件（.env、数据库等）
4. 分配端口（写入 .env）
5. AfterCreateSession hooks（bun install、db:migrate 等）
```

### 🛡️ 安全加固

- **参数化 Git 命令** — 防止分支名注入
- **路径校验** — 仅允许绝对路径且必须存在
- **端口锁** — 原子性端口分配，防止重复占用
- **Daemon 隔离** — 仅绑定 `127.0.0.1`，防止跨站请求

---

## 为什么选择 AgentDock？

| 特性 | AgentDock | 手动管理 |
|------|-----------|----------|
| **Session 隔离** | ✅ 自动创建 Worktree | ❌ 手动 `git worktree add` |
| **端口管理** | ✅ 自动分配 + 冲突检测 | ❌ 手动查找可用端口 |
| **环境变量** | ✅ 自动同步 + 写入 `.env` | ❌ 手动复制粘贴 |
| **依赖安装** | ✅ 自动执行 `bun install` | ❌ 手动在每个目录执行 |
| **多 Session 并行** | ✅ 零配置支持 | ⚠️ 需要大量手动操作 |
| **终端集成** | ✅ 内置 xterm.js + AI 工具预设 | ❌ 需要单独打开终端 |
| **配置文件** | ✅ 可选，开箱即用 | ❌ 无 |

---

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Bun](https://bun.sh/) >= 1.0（推荐）
- [Git](https://git-scm.com/) >= 2.30

### 安装

```bash
# 克隆仓库
git clone https://github.com/ACCSCI/AgentDock.git
cd AgentDock

# 安装依赖
bun install

# 启动开发模式
bun run dev
```

### 使用步骤

1. **打开项目** — 点击首页的 "Open Project" 按钮，选择你的项目目录
2. **创建 Session** — 在左侧边栏点击 "+" 创建新的 Session
3. **开始开发** — 在内置终端中运行你的开发命令

AgentDock 会自动完成：
- 创建 Git Worktree
- 同步 `.env` 到 Worktree
- 分配可用端口
- 执行依赖安装（如果配置了 hook）

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron Main Process                    │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │   Daemon    │  │    IPC      │  │   Terminal Manager  │ │
│  │  (Hono)     │  │  Handlers   │  │   (node-pty)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Preload (contextBridge)                   │
│                    window.api (29+ channels)                 │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Renderer (React 19)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐ │
│  │    TabBar   │  │   Session   │  │   Terminal Panel    │ │
│  │             │  │   Sidebar   │  │   (xterm.js)        │ │
│  └─────────────┘  └─────────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 职责 |
|------|------|
| **Daemon** | 机器级单例 HTTP 服务器，管理端口分配和 Session 状态 |
| **Session Lifecycle** | 编排 Session 创建/删除的 5 步流程 |
| **Terminal Manager** | 管理终端生命周期，支持 PTY 和 MessagePort 传输 |
| **Port Allocator** | 原子性端口分配，支持文件锁和过期检测 |
| **Hook Engine** | 执行 Session 生命周期钩子（before/after create/delete） |
| **Resource Sync** | 同步资源文件到 Worktree（支持 overwrite/skip/merge 策略） |

---

## 配置文件（可选）

配置文件位于**目标项目根目录**（不是 AgentDock 本身），文件名：`agentdock.config.yaml`。

> 💡 **提示**：无配置文件时 AgentDock 即可正常运行，配置仅用于自定义资源同步和 Hook。

### 最小配置

```yaml
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "bun install"
      required: true
      timeout: 60000
```

### 完整配置示例

```yaml
version: "1"

resources:
  sync:
    # 覆盖 .env 文件
    - source: .env
      strategy: overwrite
      skipIfMissing: true

    # 覆盖数据库文件
    - source: dev.db
      strategy: overwrite
      skipIfMissing: true

    # 合并上传目录
    - source: uploads/
      strategy: merge
      skipIfMissing: true

    # 跳过本地配置
    - source: .env.local
      strategy: skip
      skipIfMissing: true

hooks:
  beforeCreateSession:
    - run: "echo 'Preparing session...'"
      required: false
      timeout: 5000
      cwd: worktree

  afterCreateSession:
    # 安装依赖
    - run: "bun install"
      required: true
      timeout: 60000
      cwd: worktree

    # 数据库迁移
    - run: "bun run db:migrate"
      required: true
      timeout: 30000
      cwd: worktree

  beforeDeleteSession:
    - run: "echo 'Cleaning up...'"
      required: false

  afterDeleteSession:
    - run: "echo 'Session deleted'"
      required: false
```

### 资源同步策略

| 策略 | 目标不存在时 | 目标已存在时 |
|------|------------|------------|
| `overwrite` | 复制 | 覆盖（幂等） |
| `skip` | 复制 | 跳过 |
| `merge` | 复制 | 合并（.env 逐 key，目录递归） |

### Hook 字段说明

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `run` | 必填 | shell 命令，支持平台自动选择（Windows cmd / Unix sh） |
| `required` | `false` | `true` 时失败会中断 pipeline |
| `timeout` | `30000` | 毫秒，超时后发送 SIGTERM（Windows: taskkill） |
| `cwd` | `worktree` | `worktree` = 在新 worktree 目录执行；`project` = 在项目根目录执行 |

### 环境变量

Hook 执行时自动注入：

| 变量 | 说明 |
|------|------|
| `AGENTDOCK_SESSION_ID` | 当前 Session ID |
| `AGENTDOCK_PROJECT_ID` | 当前项目 ID |
| `AGENTDOCK_EVENT` | 当前生命周期事件名 |

---

## Session 生命周期

### 创建流程

```
┌─────────────────────────────────────────────────────────────┐
│ 1. BeforeCreateSession hooks                               │
│    └─ 执行用户定义的预处理命令（可选）                        │
├─────────────────────────────────────────────────────────────┤
│ 2. CreateWorktree                                          │
│    └─ git worktree add <worktree-path> -b <branch>         │
├─────────────────────────────────────────────────────────────┤
│ 3. SyncResources                                           │
│    └─ 根据配置同步 .env、数据库等文件到 Worktree              │
├─────────────────────────────────────────────────────────────┤
│ 4. AllocatePorts                                           │
│    └─ 分配可用端口，写入 Worktree/.env                       │
├─────────────────────────────────────────────────────────────┤
│ 5. AfterCreateSession hooks                                │
│    └─ 执行用户定义的后处理命令（bun install 等）              │
└─────────────────────────────────────────────────────────────┘
```

### 删除流程

```
┌─────────────────────────────────────────────────────────────┐
│ 1. BeforeDeleteSession hooks                               │
│ 2. ReleasePorts                                            │
│ 3. RemoveWorktree                                          │
│ 4. AfterDeleteSession hooks                                │
└─────────────────────────────────────────────────────────────┘
```

### Rollback 触发条件

以下情况会自动 rollback（清理 worktree + 释放端口）：

- `beforeCreateSession` 中 `required: true` 的 hook 失败
- 资源同步失败（`skipIfMissing: false` 且源不存在）
- `afterCreateSession` 中 `required: true` 的 hook 失败

---

## 端口管理

### 分配流程

1. **端口范围**：30000-65535
2. **分配算法**：`pickFreePort()` 绑定 port=0 获取 OS 随机端口
3. **可用性验证**：TCP 连接探测（300ms 超时）
4. **原子性保证**：文件锁 + O_EXCL 创建，防止并发冲突

### 默认端口变量

| 变量名 | 用途 |
|--------|------|
| `FRONTEND_PORT` | Vite 开发服务器 |
| `BACKEND_PORT` | 后端服务 |
| `WS_PORT` | WebSocket 服务 |
| `DEBUG_PORT` | 调试端口 |
| `PREVIEW_PORT` | 预览服务 |

可通过 `agentdock.config.yaml` 自定义：

```yaml
version: "1"
env:
  ports:
    - MY_PORT
    - API_PORT
```

---

## 多实例支持

AgentDock 支持在同一台机器上运行多个 Electron 实例，共享状态：

- **机器级 Daemon**：单例 Hono HTTP 服务器，管理所有端口和 Session 状态
- **Session 所有权**：每个 Session 归属于特定的 Electron 实例
- **心跳检测**：30 秒间隔，90 秒超时
- **自动恢复**：Daemon 重启后自动恢复 Session 状态
- **冲突处理**：检测并处理孤儿 Session、过期锁等异常情况

---

## 技术栈

### 运行时依赖

| 技术 | 版本 | 用途 |
|------|------|------|
| [Electron](https://www.electronjs.org/) | 42.4 | 桌面应用框架 |
| [React](https://react.dev/) | 19.1 | UI 框架 |
| [TanStack Router](https://tanstack.com/router) | 1.120 | 文件路由（memory history） |
| [TanStack Query](https://tanstack.com/query) | 5.101 | 服务端状态管理 |
| [xterm.js](https://xtermjs.org/) | 5.5 | 终端模拟器 |
| [node-pty](https://github.com/nickel-org/node-pty) | 1.1 | 原生 PTY 支持 |
| [Hono](https://hono.dev/) | 4.12 | HTTP 服务器（Daemon） |
| [Drizzle ORM](https://orm.drizzle.team/) | 1.0-rc.3 | SQLite ORM |
| [Zod](https://zod.dev/) | 4.4 | Schema 验证 |

### 开发依赖

| 技术 | 用途 |
|------|------|
| [electron-vite](https://electron-vite.org/) | 构建工具链 |
| [Vitest](https://vitest.dev/) | 单元/集成测试 |
| [Playwright](https://playwright.dev/) | E2E 测试（真实 Electron） |
| [Biome](https://biomejs.dev/) | Linter + Formatter |

---

## 开发

### 常用命令

```bash
# 开发模式（Electron + Vite dev server）
bun run dev

# 构建生产版本
bun run build

# 运行构建后的 Electron 预览
bun run start

# 运行测试
bun run test

# 运行 E2E 测试
bun run test:e2e

# Lint + Format
bun run check
```

### 项目结构

```
agent-dock/
├── electron/              # Electron 主进程 + preload
│   ├── main.ts            # 主进程入口
│   ├── preload.ts         # Context Bridge
│   └── main/ipc/          # IPC 处理器（29+ channels）
├── plugins/               # 核心业务逻辑（主进程 + Daemon 共享）
│   ├── daemon/            # Hono HTTP 服务器
│   ├── terminal-manager.ts
│   ├── session-lifecycle.ts
│   ├── hook-engine.ts
│   └── ...
├── src/                   # React 渲染进程
│   ├── components/        # UI 组件
│   ├── lib/               # 工具函数、状态管理
│   └── routes/            # 文件路由
├── e2e/                   # Playwright E2E 测试
├── scripts/               # 构建脚本
└── docs/                  # 内部文档
```

### E2E 测试

```bash
# 运行所有 E2E 测试
bun run test:e2e

# 运行特定测试
bunx playwright test e2e/session-create.spec.ts

# 调试模式
bunx playwright test --headed
```

E2E 测试使用真实 Electron 应用，详见 `docs/e2e-guide.md`。

---

## 测试覆盖

```bash
bun run test
```

覆盖范围：
- ✅ 配置解析（Zod schema + YAML loader）
- ✅ 资源同步（文件/目录、三种策略、skipIfMissing）
- ✅ Hook 引擎（注册、执行、超时、required 中断）
- ✅ Session 生命周期（编排器、rollback、执行顺序）
- ✅ API 集成（HTTP 端到端）
- ✅ 安全加固（命令注入、git 注入、路径校验、Daemon Origin、端口锁存活检测、DB 版本化迁移）

---

## 安全

AgentDock 在执行外部命令、git 操作、文件访问与本地服务通信时遵循以下加固措施：

| 领域 | 加固措施 |
|------|---------|
| **文件浏览器** | 参数化调用，不经 shell 拼接，避免命令注入 |
| **Git Worktree** | 分支名经 `validateBranchName` 校验（拒绝 `--`、控制字符、`..` 等） |
| **项目路径** | `validateProjectPath` 要求绝对路径且为已存在目录 |
| **Daemon HTTP** | 仅绑定 `127.0.0.1`；非 GET 且携带 `Origin` 头的请求返回 403 |
| **端口锁** | 锁文件记录 `{pid, ts}`；仅当持有进程已退出、锁超过 30s 或内容损坏时才破锁 |
| **数据库** | 每项目 SQLite 通过 `PRAGMA user_version` 进行版本化迁移 |

---

## 常见配置模式

### Next.js 项目

```yaml
version: "1"

resources:
  sync:
    - source: .env.local
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "bun install"
      required: true
      timeout: 120000
    - run: "bun run db:push"
      required: false
      timeout: 30000
```

### 前后端分离项目

```yaml
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true
    - source: uploads/
      strategy: merge
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "cd frontend && bun install"
      cwd: worktree
      required: true
      timeout: 60000
    - run: "cd backend && bun install"
      cwd: worktree
      required: true
      timeout: 60000
    - run: "cp .env.backend backend/.env"
      cwd: worktree
      required: false
```

### 数据库迁移

```yaml
version: "1"

resources:
  sync:
    - source: dev.db
      strategy: overwrite
      skipIfMissing: true
    - source: prisma/
      strategy: skip
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "bun install"
      required: true
      timeout: 60000
    - run: "bunx prisma generate"
      required: true
      timeout: 30000
    - run: "bunx prisma db push"
      required: false
      timeout: 30000
```

---

## 相关文档

| 文档 | 说明 |
|------|------|
| [E2E 测试指南](docs/e2e-guide.md) | Playwright 测试框架使用说明 |
| [AgentDock 规范 v0.2](docs/ads-v0.2.md) | 项目兼容性规范 |
| [故障模式分析](docs/failure-modes.md) | 常见故障及处理方案 |
| [v1 API 弃用说明](docs/v1-deprecation.md) | v1 → v2 迁移指南 |

---

## 贡献

欢迎贡献！请遵循以下步骤：

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'feat: add amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 创建 Pull Request

### 开发规范

- 使用 [Biome](https://biomejs.dev/) 进行代码格式化
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- 新功能需要添加相应的测试
- E2E 测试使用 Playwright，详见 `docs/e2e-guide.md`

---

## 许可证

[MIT License](LICENSE)

---

## 致谢

- [Electron](https://www.electronjs.org/) - 桌面应用框架
- [React](https://react.dev/) - UI 框架
- [xterm.js](https://xtermjs.org/) - 终端模拟器
- [Hono](https://hono.dev/) - 轻量级 HTTP 框架
- [Drizzle ORM](https://orm.drizzle.team/) - 类型安全的 ORM
