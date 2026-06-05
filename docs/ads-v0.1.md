# AgentDock Compatible Specification v0.1

> 本文档定义什么样的软件项目能够被 AgentDock 高效管理。  
> 规范基于 AgentDock 当前已实现能力设计，不绑定任何特定 CLI 工具、语言或框架。

---

## 1. Design Goals

| # | Goal | 说明 |
|---|------|------|
| G1 | **隔离性** | 每个 Session 运行在独立 Git Worktree 中，互不干扰 |
| G2 | **可复现** | 同一项目配置在任意机器上产生相同行为 |
| G3 | **零侵入** | 项目无需修改源码，仅通过声明式配置接入 |
| G4 | **并行安全** | 多个 Session 可同时运行，资源不冲突（端口、文件、进程） |
| G5 | **工具无关** | 不绑定 Claude Code / Gemini CLI / Codex CLI / 任何特定 AI 工具 |
| G6 | **语言无关** | 兼容 Web、CLI、AI、系统级项目 |

---

## 2. Non-Goals

| # | Non-Goal | 说明 |
|---|----------|------|
| NG1 | 不替代包管理器 | 不管理 npm / pip / cargo 依赖安装（通过 Hook 委托） |
| NG2 | 不替代 CI/CD | 不执行测试、构建、部署流水线（通过 Hook 委托） |
| NG3 | 不替代版本控制 | 不封装 git 操作（仅使用 worktree） |
| NG4 | 不定义开发工作流 | 不规定编码规范、分支策略、代码审查流程 |
| NG5 | 不提供运行时沙箱 | Session 进程共享宿主机资源，无容器隔离 |
| NG6 | 不管理数据库 schema | 不执行迁移，仅可同步数据库文件 |

---

## 3. Requirements

### 3.1 MUST Requirements

一个项目若要被 AgentDock 管理，**必须**满足以下条件：

| ID | Requirement | 说明 |
|----|-------------|------|
| M1 | **Git 仓库** | 项目根目录是一个 Git 仓库（`git init` 已执行） |
| M2 | **可克隆构建** | 项目能在 Worktree 中通过安装依赖后启动运行 |
| M3 | **配置文件** | 项目根目录存在 `agentdock.config.yaml`（可为空配置） |
| M4 | **文件可读** | AgentDock 运行用户对项目目录有读写权限 |
| M5 | **单一入口** | 项目有明确的启动命令或入口文件（如 `npm start`、`python main.py`） |

### 3.2 SHOULD Requirements

以下条件**强烈建议**满足，否则部分功能可能不可用：

| ID | Requirement | 说明 |
|----|-------------|------|
| S1 | **环境变量声明** | 项目使用 `.env` 文件管理配置，以便资源同步 |
| S2 | **依赖锁文件** | 存在 `package-lock.json`、`yarn.lock`、`poetry.lock` 等锁文件 |
| S3 | **端口可配置** | 服务端口通过环境变量（如 `PORT`）而非硬编码 |
| S4 | **幂等安装** | `install` 命令可重复执行且结果一致 |
| S5 | **Worktree 友好** | 项目不依赖 `__dirname` 定位资源（Worktree 路径与主仓库不同） |
| S6 | **非 GUI 项目** | 项目可无头运行（CLI / 服务端 / 后台任务） |

### 3.3 MAY Requirements

以下条件为可选增强：

| ID | Requirement | 说明 |
|----|-------------|------|
| Y1 | **多端口服务** | 项目同时暴露前端端口和后端端口（如 Vite dev server） |
| Y2 | **热重载** | 支持文件变更后自动重启 |
| Y3 | **数据库依赖** | 项目依赖本地数据库（SQLite / 文件数据库），需要同步 |
| Y4 | **WebSocket** | 项目使用 WebSocket 通信 |
| Y5 | **调试端口** | 支持远程调试协议（如 Node.js `--inspect`） |

---

## 4. Contracts

### 4.1 Session Contract

Session 是 AgentDock 的核心抽象：一个隔离的开发/运行环境。

```
Session
├── id: string          (唯一标识)
├── name: string        (用户可读名称)
├── branch: string      (Git 分支, 格式: agentdock/{sessionId})
├── worktreePath: string (文件系统路径)
├── ports: SessionPorts (分配的端口集合)
├── status: "creating" | "running" | "deleted"
└── createdAt: Date
```

**Session 创建保证：**

1. Worktree 必须在 Hook 执行前创建完成
2. 资源同步在 Worktree 创建后、端口分配前执行
3. 端口分配在资源同步后执行（端口可写入 `.env`）
4. `afterCreateSession` Hook 在所有步骤完成后执行
5. 创建失败时自动回滚（删除已创建的 Worktree、释放已分配端口）

**Session 删除保证：**

1. `beforeDeleteSession` Hook 先执行
2. 端口释放后删除 Worktree
3. `afterDeleteSession` Hook 最后执行

**创建流程时序：**

```
[外部请求]
  │
  ├─→ beforeCreateSession hooks (可选, 可失败)
  │
  ├─→ createWorktree
  │     └─ onWorktreeReady 回调（插入 DB 记录）
  │
  ├─→ syncResources
  │
  ├─→ allocatePorts → 写入 .env
  │
  └─→ afterCreateSession hooks (可选, 可失败)
        │
        └─→ [Session 就绪]
```

### 4.2 Project Contract

Project 是被管理的源码仓库。

```
Project
├── path: string        (文件系统绝对路径)
├── id: string          (唯一标识)
├── name: string        (显示名称)
├── config: Config      (agentdock.config.yaml 解析结果)
├── isGitRepo: boolean  (是否为 Git 仓库)
└── currentBranch: string (当前 HEAD 分支)
```

**Project 要求：**

1. 项目路径必须是有效的 Git 仓库
2. `agentdock.config.yaml` 必须位于项目根目录
3. 同一项目可有多个并行 Session
4. Project 记录在磁盘发现 Worktree 时自动同步（防数据漂移）

### 4.3 Resource Contract

资源同步定义主仓库与 Worktree 之间的文件传播规则。

```yaml
resources:
  sync:
    - source: <相对路径>     # 必填, 相对于项目根目录
      strategy: <策略>       # 可选, 默认 overwrite
      skipIfMissing: <bool>  # 可选, 默认 true
```

**策略定义：**

| Strategy | 行为 |
|----------|------|
| `overwrite` | 目标文件不存在则复制，存在则覆盖 |
| `skip` | 目标文件已存在则跳过，不存在则复制 |
| `merge` | 目标为目录时合并内容（不删除目标中已有文件） |

**环境变量文件特殊处理：**

- 文件名匹配 `.env` 或 `.env.*` 时，自动解析为 key=value 格式
- 端口分配的变量（`FRONTEND_PORT`、`BACKEND_PORT`、`WS_PORT`、`DEBUG_PORT`、`PREVIEW_PORT`）会追加写入目标 `.env`
- 合并逻辑：主仓库变量 + 端口变量 → 写入 Worktree `.env`

**约束：**

1. `source` 路径不得包含 `..`（禁止逃逸到项目外）
2. 同一 `source` 不得重复声明
3. 不存在的源文件在 `skipIfMissing: true` 时静默跳过
4. `skipIfMissing: false` 时源文件不存在会报错

### 4.4 Validation Contract

AgentDock 在执行前对项目和配置进行校验。

**必须校验：**

| 检查项 | 校验规则 | 失败行为 |
|--------|---------|---------|
| Git 仓库 | `git rev-parse --is-inside-work-tree` | 拒绝创建 Session |
| Session ID | 不含 `..`、`/`、`\` | 拒绝创建 Session |
| 配置格式 | YAML 解析 + Schema 验证 | 拒绝启动 |
| 端口可用性 | TCP bind 检测 | 报告可用端口不足 |
| 资源路径 | 无路径逃逸 | 拒绝启动 |

**建议校验（SHOULD）：**

| 检查项 | 校验规则 |
|--------|---------|
| 依赖已安装 | `node_modules` / `venv` 等目录存在 |
| 项目可构建 | `tsc --noEmit` 等类型检查通过 |
| 端口未被占用 | 非 AgentDock 分配的端口未被外部进程占用 |

### 4.5 Hook Contract

Hook 是在 Session 生命周期特定阶段执行的命令。

```yaml
hooks:
  <event>:
    - run: "<shell 命令>"      # 必填
      required: <bool>         # 可选, 默认 false
      timeout: <毫秒>          # 可选, 默认 30000
      cwd: "worktree" | "project"  # 可选, 默认 worktree
```

**支持的生命周期事件：**

| Event | 触发时机 | 典型用途 |
|-------|---------|---------|
| `beforeCreateSession` | Worktree 创建前 | 预检查、打印信息 |
| `afterCreateSession` | Session 完全就绪后 | `install`、`migrate`、`seed` |
| `beforeDeleteSession` | Worktree 删除前 | 清理临时文件、停止服务 |
| `afterDeleteSession` | Session 删除完成后 | 日志记录、通知 |

**执行保证：**

1. 同一事件的 Hook 按声明顺序串行执行
2. `required: true` 的 Hook 失败时，整个 Session 创建/删除中止
3. `required: false` 的 Hook 失败时，记录错误但继续执行
4. 超时（默认 30s）后强制终止 Hook 进程
5. Hook 执行上下文包含 `sessionId`、`projectId`、`worktreePath`、`projectPath`
6. Hook 的 `cwd` 决定工作目录：`worktree`（默认）或 `project`

**执行上下文变量：**

| 变量 | 值 |
|------|---|
| `$AGENTDOCK_SESSION_ID` | 当前 Session ID |
| `$AGENTDOCK_PROJECT_ID` | 当前 Project ID |
| `$AGENTDOCK_WORKTREE_PATH` | Worktree 绝对路径 |
| `$AGENTDOCK_PROJECT_PATH` | 主仓库绝对路径 |

### 4.6 Port Contract

端口分配确保并行 Session 间无冲突。

**分配的端口槽位：**

| Slot | 环境变量名 | 用途 |
|------|-----------|------|
| 1 | `FRONTEND_PORT` | 前端开发服务器 |
| 2 | `BACKEND_PORT` | 后端 API 服务 |
| 3 | `WS_PORT` | WebSocket 服务 |
| 4 | `DEBUG_PORT` | 调试端口 |
| 5 | `PREVIEW_PORT` | 预览/静态文件服务 |

**分配规则：**

1. 范围：20000 - 65535
2. 候选端口必须同时通过注册表检查和 TCP bind 检查
3. 跨所有项目注册表去重（防止不同项目的 Session 端口冲突）
4. 分配后写入全局注册表（`.agentdock/port-registry.json`）
5. Session 删除时释放端口并从注册表移除

---

## 5. Configuration Schema

```yaml
# agentdock.config.yaml
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    - run: "npm install"
      required: true
      timeout: 60000
```

**最小有效配置（空配置）：**

```yaml
version: "1"
```

**完整配置：**

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
    - source: uploads/
      strategy: merge
      skipIfMissing: true
    - source: .env.local
      strategy: skip
      skipIfMissing: true

hooks:
  beforeCreateSession:
    - run: "echo 'Preparing...'"
      required: false
      timeout: 5000
      cwd: worktree

  afterCreateSession:
    - run: "npm install"
      required: true
      timeout: 60000
    - run: "npm run db:migrate"
      required: true
      timeout: 30000

  beforeDeleteSession:
    - run: "echo 'Cleaning up...'"
      required: false

  afterDeleteSession:
    - run: "echo 'Done'"
      required: false
```

---

## 6. Examples

### 6.1 Node.js + Express API

```yaml
version: "1"
resources:
  sync:
    - source: .env
      strategy: overwrite
hooks:
  afterCreateSession:
    - run: "npm ci"
      required: true
      timeout: 120000
    - run: "npx prisma migrate dev"
      required: true
      timeout: 30000
```

**适用条件：** M1-M5 满足，端口通过 `process.env.PORT` 读取。

### 6.2 Python + FastAPI

```yaml
version: "1"
resources:
  sync:
    - source: .env
      strategy: overwrite
    - source: dev.db
      strategy: overwrite
      skipIfMissing: true
hooks:
  afterCreateSession:
    - run: "python -m venv .venv"
      required: true
      timeout: 30000
    - run: ".venv\\Scripts\\pip install -r requirements.txt"
      required: true
      timeout: 120000
```

**适用条件：** M1-M5 满足，使用 `uvicorn --port $BACKEND_PORT` 启动。

### 6.3 Monorepo (pnpm workspace)

```yaml
version: "1"
resources:
  sync:
    - source: .env
      strategy: overwrite
    - source: .env.local
      strategy: skip
hooks:
  afterCreateSession:
    - run: "pnpm install"
      required: true
      timeout: 120000
    - run: "pnpm --filter @app/web build"
      required: true
      timeout: 180000
```

**适用条件：** M1-M5 满足，S2（锁文件 pnpm-lock.yaml 存在）。

### 6.4 CLI 工具项目

```yaml
version: "1"
resources:
  sync: []
hooks:
  afterCreateSession:
    - run: "cargo build"
      required: true
      timeout: 300000
```

**适用条件：** M1-M5 满足，无需端口分配（不声明端口槽位使用）。

### 6.5 无配置项目

无 `agentdock.config.yaml` 时，AgentDock 使用默认行为：
- 无资源同步
- 无 Hook 执行
- 仍分配端口并创建 Worktree

适用于一次性探索、代码阅读等轻量场景。

---

## 7. Compatibility Matrix

| 项目类型 | M1 | M2 | M3 | M4 | M5 | S1 | S3 | 兼容等级 |
|---------|----|----|----|----|----|----|----|---------|
| Node.js + Vite 前端 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full |
| Node.js + Express API | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full |
| Python + Flask/FastAPI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | High |
| Rust + Cargo | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | Medium |
| Go + CLI | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | Medium |
| 静态 HTML | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ | High |
| 需要 GUI 的项目 | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | — | — | Low |

> **兼容等级说明：**
> - **Full**：所有功能可用
> - **High**：核心功能可用，部分高级特性受限
> - **Medium**：基本可用，需要额外 Hook 配置
> - **Low**：可管理但受限严重

---

## 8. Versioning

本规范采用 [SemVer](https://semver.org/)：

- **MAJOR**：不兼容的变更（如删除必填字段、改变创建流程）
- **MINOR**：向后兼容的功能新增（如新增 Hook 事件、新增同步策略）
- **PATCH**：文档修正、定义澄清

当前版本：**v0.1.0**（Initial Draft）

---

## 9. Glossary

| Term | Definition |
|------|-----------|
| **AgentDock** | 会话管理系统，提供 Worktree 隔离、资源同步、端口分配、Hook 执行 |
| **Session** | 一个隔离的开发/运行环境实例 |
| **Worktree** | Git Worktree，从主仓库派生的独立工作副本 |
| **Project** | 被 AgentDock 管理的源码仓库 |
| **Hook** | 在 Session 生命周期特定阶段执行的 Shell 命令 |
| **Resource Sync** | 将主仓库中的指定文件同步到 Worktree 的机制 |
| **Port Registry** | 全局端口分配记录，防止跨 Session 端口冲突 |
| **Config** | `agentdock.config.yaml` 中的声明式配置 |
