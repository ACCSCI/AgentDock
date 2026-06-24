# AgentDock

> 开箱即用的 Git Worktree Session 管理系统 —— 为 AI Agent 并行开发量身打造。

[![Electron](https://img.shields.io/badge/Electron-42.4-blue?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19.1-61dafb?logo=react)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

---

## 什么是 AgentDock？

AgentDock 是一款 **Electron 桌面应用**，让你基于同一个项目创建多个**完全隔离的 Git Worktree Session**，每个 Session 拥有独立的 Git 分支、端口、环境变量和内置终端。所有 Session 可以**并行运行、互不干扰**，配合 Claude Code 等 AI 工具，实现大规模并行开发。

```
project/
  .agentdock/
    worktrees/
      abc123/     ← Session A（独立 worktree + 独立 .env + 独立端口）
      def456/     ← Session B（独立 worktree + 独立 .env + 独立端口）
      ghi789/     ← Session C（独立 worktree + 独立 .env + 独立端口）
```

---

## 完整使用流程

下面是从零开始到大规模并行开发的完整步骤。每一步都对应 AgentDock 中的实际操作。

### 第 1 步：打开项目

**前置要求：**

- [Node.js](https://nodejs.org/) >= 18
- [Bun](https://bun.sh/) >= 1.0（推荐）
- [Git](https://git-scm.com/) >= 2.30
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（可选，用于 AI 辅助开发）

**安装并启动 AgentDock：**

```bash
git clone https://github.com/ACCSCI/AgentDock.git
cd AgentDock
bun install
bun run dev
```

**打开你的项目：**

1. AgentDock 启动后进入首页
2. 点击 **"Open Project"** 按钮
3. 在文件浏览器中选择你的项目目录

> 💡 **提示**：项目必须是一个 Git 仓库（已执行 `git init`）。如果不是，AgentDock 会提示你是否自动初始化。

打开项目后，你会看到 AgentDock 的主界面：

```
┌──────────────────────────────────────────────────────────┐
│ [项目标签页]                                              │
├────┬──────────┬──────────────────────────────────────────┤
│    │          │                                          │
│ 🧹 │ Sessions │  工作区                                    │
│ 📋 │          │  （配置编辑器 / 终端面板）                    │
│ ⚙️ │  + 新建   │                                          │
│    │          │                                          │
│    │ Session  │                                          │
│    │   列表    │                                          │
│    │          │                                          │
├────┴──────────┴──────────────────────────────────────────┤
│ 状态栏                                                    │
└──────────────────────────────────────────────────────────┘
```

- **左侧图标栏**：工具按钮（清理孤儿 Worktree、复制兼容性提示词、设置）
- **Session 侧边栏**：Session 列表 + 新建按钮
- **工作区**：配置编辑器（未选中 Session 时）或终端面板（选中 Session 时）

---

### 第 2 步：配置项目

AgentDock **无需配置即可运行**，但为了获得最佳体验（特别是多 Session 并行），建议在项目根目录创建配置文件。

**方式 A：在 AgentDock 中直接配置**

1. 打开项目后（不选中任何 Session），工作区会显示 **YAML 配置编辑器**
2. 直接在编辑器中编写 `agentdock.config.yaml`
3. 配置会自动保存到项目根目录

**方式 B：手动创建配置文件**

在你的项目根目录创建 `agentdock.config.yaml`：

```yaml
version: "1"

# 资源同步：创建 Session 时自动复制文件到 Worktree
resources:
  sync:
    - source: .env
      strategy: overwrite       # 覆盖（每次创建都更新）
      skipIfMissing: true       # 源文件不存在时跳过

# 生命周期 Hooks
hooks:
  afterCreateSession:
    # 安装依赖（每个 Worktree 独立安装）
    - run: "bun install"
      required: true            # 失败则中断创建
      timeout: 120000
      cwd: worktree             # 在 Worktree 目录中执行
```

**关键配置说明：**

| 配置项 | 说明 |
|--------|------|
| `resources.sync` | 创建 Session 时自动同步的文件列表 |
| `strategy: overwrite` | 每次都覆盖目标文件 |
| `strategy: skip` | 目标已存在则跳过 |
| `strategy: merge` | 合并（.env 逐 key，目录递归） |
| `hooks.afterCreateSession` | 创建后执行的命令（如安装依赖、数据库迁移） |
| `hooks.beforeCreateSession` | 创建前执行的命令 |
| `required: true` | 命令失败则整个创建流程回滚 |

**完整配置示例（含数据库迁移的全栈项目）：**

```yaml
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true
    - source: dev.db
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "bun install"
      required: true
      timeout: 120000
      cwd: worktree
    - run: "bunx prisma generate"
      required: true
      timeout: 30000
      cwd: worktree
    - run: "bunx prisma db push"
      required: false
      timeout: 30000
      cwd: worktree

env:
  ports:
    - FRONTEND_PORT
    - BACKEND_PORT
```

> 💡 **端口分配**：AgentDock 会在 `20000-65535` 范围内自动分配可用端口，写入 Worktree 的 `.env` 文件。你的项目需要通过环境变量读取端口（如 `process.env.FRONTEND_PORT`），不要硬编码。

---

### 第 3 步：新建 Session

1. 在左侧 **Session 侧边栏**点击 **"+"** 按钮
2. AgentDock 自动执行 5 步创建流程：

```
  ✓ BeforeCreateSession hooks（预处理命令）
  ✓ 创建 Git Worktree（独立目录 + 独立分支）
  ✓ 同步资源文件（.env、数据库等 → Worktree）
  ✓ 分配端口（自动探测可用端口 → 写入 .env）
  ✓ AfterCreateSession hooks（依赖安装、数据库迁移等）
```

3. 创建完成后，Session 卡片出现在侧边栏中，显示状态图标和端口号

**Session 创建成功后，你拥有：**

- 一个独立的 Git Worktree（目录：`项目/.agentdock/worktrees/<sessionId>/`）
- 一个独立的 Git 分支（名称：`agentdock/<sessionId>`）
- 独立的 `.env` 文件（已写入分配的端口）
- 独立安装的依赖（通过 Hook 执行）
- 一个内置终端（自动打开）

> 💡 **拖拽排序**：可以拖拽 Session 卡片调整顺序，排序会持久化保存。
>
> 💡 **重命名**：双击 Session 名称即可重命名，分支名会同步更新。

---

### 第 4 步：启动 Claude Code

1. 确保已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI：
   ```bash
   npm install -g @anthropic-ai/claude-code
   ```

2. 在 AgentDock 中，点击工作区的终端创建按钮（或 `+` 按钮），选择 **Claude Code** 预设

3. 终端会在当前 Session 的 Worktree 目录中自动启动 `claude` 命令

4. Claude Code 启动后，就可以在这个隔离环境中开始 AI 辅助开发

> 💡 **终端预设**：AgentDock 支持三种终端预设 —— **Terminal**（普通 Shell）、**Claude Code**、**GitHub Copilot**。选择会记住你的偏好。
>
> 💡 **终端缓存**：切换 Session 时终端状态会保持，不会丢失。

---

### 第 5 步：从侧栏复制提示词改造项目

这一步是让项目 **兼容 AgentDock 并行开发** 的关键。

1. 点击左侧图标栏的 **📋（剪贴板）按钮**
2. AgentDock 会将完整的 **"AgentDock Compatible Specification"** 提示词复制到剪贴板
3. 在 Claude Code（或其他 AI 工具）的终端中**粘贴这段提示词**并发送

这段提示词会指导 AI 工具帮你检查并改造项目，确保以下 **10 类隔离场景** 不会冲突：

| 隔离场景 | 风险等级 | 说明 |
|---------|---------|------|
| IS-01 共享数据库 | ⚠️ L1 BLOCKER | 多 Session 共享同一 DB 文件会损坏数据 |
| IS-02 共享缓存 | 🟡 L3 WARN | 缓存可重建，仅影响性能 |
| IS-03 共享上传目录 | ⚠️ L2 FAIL | 文件互相覆盖 |
| IS-04 全局配置目录 | 🟡 L3 WARN | 配置互相干扰 |
| IS-05 固定 Docker 容器名 | 🔴 L0 BLOCKER | 容器名冲突，无法启动 |
| IS-06 固定 Docker 网络名 | 🟡 L3 WARN | 容器互通导致服务发现冲突 |
| IS-07 固定 Docker Volume | 🔴 L1 BLOCKER | 数据互相污染 |
| IS-08 固定端口 | 🔴 L0 BLOCKER | 端口冲突，EADDRINUSE |
| IS-09 用户目录写入 | ⚠️ L2 FAIL | 数据互相干扰 |
| IS-10 进程级全局锁 | 🔴 L0 BLOCKER | 锁冲突，拒绝启动 |

**最常见的改造：端口环境变量化**

```typescript
// ❌ 硬编码端口（会导致并行 Session 冲突）
app.listen(3000);

// ✅ 读取环境变量（AgentDock 自动分配端口）
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT);
```

```typescript
// ❌ Vite 硬编码端口
export default defineConfig({
  server: { port: 5173 }
});

// ✅ 读取 AgentDock 分配的端口
export default defineConfig({
  server: { port: Number(process.env.FRONTEND_PORT) || 5173 }
});
```

改造完成后，项目即可在多个 Session 中**安全并行运行**。

---

### 第 6 步：创建 PR

AgentDock 中的每个 Session 都有独立的 Git 分支（`agentdock/<sessionId>`），可以正常推送和创建 PR：

1. **在 Session 终端中**完成开发和提交：
   ```bash
   git add .
   git commit -m "feat: implement user authentication"
   git push origin agentdock/<sessionId>
   ```

2. **使用 GitHub CLI 创建 PR**：
   ```bash
   gh pr create --title "feat: implement user authentication" --body "..."
   ```

3. **或在 AgentDock 侧边栏**点击 **🔗 按钮**（Pull Requests 图标），直接在浏览器中打开 GitHub 的 PR 页面

> 💡 **提示**：每个 Session 的分支是独立的，所以多个 Session 可以同时推送各自的 PR，互不影响。

---

### 第 7 步：合并 PR

1. 在 GitHub 上完成 Code Review
2. 合并 PR（Merge / Squash / Rebase 均可）
3. 回到 AgentDock，Session 侧边栏的 PR 按钮可以查看所有 PR 状态

> 💡 **SpeedPR 技能**：如果你在 Claude Code 中使用了 `speedpr` 技能，它可以自动完成从提交到 PR 创建、Review、CI 检查、冲突解决的全流程，一键达到 "Ready To Merge" 状态。

---

### 第 8 步：删除 Session

开发完成并合并 PR 后，清理 Session：

1. 在 Session 侧边栏中，点击 Session 卡片上的 **✕** 按钮
2. 在弹出的确认对话框中确认删除
3. AgentDock 自动执行 4 步清理流程：

```
  ✓ BeforeDeleteSession hooks（清理命令）
  ✓ 释放端口（归还到可用端口池）
  ✓ 删除 Git Worktree（git worktree remove --force）
  ✓ AfterDeleteSession hooks（后处理）
```

**Session 删除后：**

- Worktree 目录被移除
- 分支保留在 Git 中（可恢复）
- 端口被释放，可供其他 Session 使用

> 💡 **右键菜单**：右键点击 Session 卡片可以看到更多选项 —— 重命名、设置状态、在资源管理器中打开、在终端中打开、重新分配端口等。

---

### 开始大规模并行开发

完成以上步骤后，你的项目已经准备好进行大规模并行开发了。核心工作流：

```
创建 Session A ──→ 启动 Claude Code ──→ 开发功能 A ──→ 提交 PR ──→ 合并 ──→ 删除
创建 Session B ──→ 启动 Claude Code ──→ 开发功能 B ──→ 提交 PR ──→ 合并 ──→ 删除
创建 Session C ──→ 启动 Claude Code ──→ 开发功能 C ──→ 提交 PR ──→ 合并 ──→ 删除
      ↑              ↑              ↑              ↑          ↑         ↑
      └──────────────── 全部并行运行，互不干扰 ──────────────────────────┘
```

**并行开发的关键原则：**

1. **每个 Session 是独立的** —— 独立的代码、端口、数据库、依赖
2. **项目只需改造一次** —— 通过提示词完成兼容性改造后，所有 Session 都能安全并行
3. **配置只需设置一次** —— `agentdock.config.yaml` 会同步到每个 Session
4. **终端实时切换** —— 点击不同 Session 卡片即可切换终端，状态保持

---

## Session 管理功能一览

### Session 状态

每个 Session 有 6 种用户状态，方便跟踪开发进度：

| 状态 | 图标 | 说明 |
|------|------|------|
| Draft | 📝 | 草稿 |
| Plan | 📋 | 计划中 |
| Working | 🔨 | 开发中 |
| PR | 🔗 | PR 已创建 |
| Verifying | ✅ | 验证中 |
| Done | ✔️ | 完成 |

右键 Session 卡片 → "Set Status" 即可切换状态。

### 其他功能

| 功能 | 操作 |
|------|------|
| **拖拽排序** | 拖拽 Session 卡片调整顺序 |
| **重命名** | 双击 Session 名称 |
| **打开资源管理器** | 右键 → Open in Explorer |
| **打开外部终端** | 右键 → Open in Terminal |
| **重新分配端口** | 右键 → Reassign Ports |
| **查看 Hook 错误** | 点击 "View logs" 查看失败日志 |
| **重试失败的 Hook** | 点击 "Retry" 重新执行 |

---

## 常见项目配置示例

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
```

### Python/Django 项目

```yaml
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true
    - source: db.sqlite3
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "python -m venv .venv"
      cwd: worktree
      required: true
      timeout: 30000
    - run: ".venv/bin/pip install -r requirements.txt"
      cwd: worktree
      required: true
      timeout: 120000
    - run: ".venv/bin/python manage.py migrate"
      cwd: worktree
      required: false
      timeout: 30000
```

---

## 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                 Electron Main Process                    │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────────┐ │
│  │  Daemon   │  │    IPC    │  │  Terminal Manager   │ │
│  │  (Hono)   │  │ Handlers  │  │    (node-pty)       │ │
│  └───────────┘  └───────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│              Preload (contextBridge)                      │
│              window.api (29+ channels)                   │
└─────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────┐
│                 Renderer (React 19)                      │
│  ┌───────────┐  ┌───────────┐  ┌─────────────────────┐ │
│  │  TabBar   │  │  Session  │  │  Terminal Panel     │ │
│  │           │  │  Sidebar  │  │    (xterm.js)       │ │
│  └───────────┘  └───────────┘  └─────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 职责 |
|------|------|
| **Daemon** | 机器级单例 HTTP 服务器，管理端口分配和 Session 状态 |
| **Session Lifecycle** | 编排 Session 创建/删除的 5 步流程 |
| **Terminal Manager** | 管理终端生命周期，支持 PTY 和 MessagePort 传输 |
| **Port Allocator** | 原子性端口分配，支持文件锁和过期检测 |
| **Hook Engine** | 执行 Session 生命周期钩子（before/after create/delete） |
| **Resource Sync** | 同步资源文件到 Worktree（overwrite/skip/merge 策略） |

### 技术栈

| 技术 | 用途 |
|------|------|
| [Electron](https://www.electronjs.org/) 42.4 | 桌面应用框架 |
| [React](https://react.dev/) 19.1 | UI 框架 |
| [TanStack Router](https://tanstack.com/router) | 文件路由 |
| [TanStack Query](https://tanstack.com/query) | 服务端状态管理 |
| [xterm.js](https://xtermjs.org/) | 终端模拟器 |
| [Hono](https://hono.dev/) | HTTP 服务器（Daemon） |
| [Drizzle ORM](https://orm.drizzle.team/) | SQLite ORM |
| [Zod](https://zod.dev/) 4.4 | Schema 验证 |
| [electron-vite](https://electron-vite.org/) | 构建工具链 |

---

## 开发

```bash
# 开发模式
bun run dev

# 构建生产版本
bun run build

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
│   └── main/ipc/          # IPC 处理器
├── plugins/               # 核心业务逻辑（主进程 + Daemon 共享）
│   ├── daemon/            # Hono HTTP 服务器
│   ├── session-lifecycle.ts
│   ├── hook-engine.ts
│   └── ...
├── src/                   # React 渲染进程
│   ├── components/        # UI 组件
│   ├── constants/         # 提示词模板等常量
│   ├── lib/               # 工具函数、状态管理
│   └── routes/            # 文件路由
├── e2e/                   # Playwright E2E 测试
├── scripts/               # 构建脚本
└── docs/                  # 内部文档
```

---

## 贡献

1. Fork 本仓库
2. 创建特性分支（`git checkout -b feature/amazing-feature`）
3. 提交更改（`git commit -m 'feat: add amazing feature'`）
4. 推送到分支（`git push origin feature/amazing-feature`）
5. 创建 Pull Request

- 使用 [Biome](https://biomejs.dev/) 格式化代码
- 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- 新功能需添加测试

## 许可证

[MIT License](LICENSE)
