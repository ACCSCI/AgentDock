# AgentDock

Git Worktree + 独立运行环境的 Session 管理系统。

## 快速开始

### 1. 在项目根目录创建配置文件

`agentdock.config.yaml`：

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

### 2. 启动 AgentDock

```bash
bun run dev
```

### 3. 创建 Session

通过 UI 创建 Session 时，AgentDock 会自动：

1. 创建 Git Worktree
2. 同步 `.env` 到 Worktree
3. 分配端口（写入 `.env`）
4. 执行 `bun install`

---

## 配置文件

配置文件位于**目标项目根目录**（不是 AgentDock 本身），文件名：`agentdock.config.yaml`。

### 完整示例

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
    - run: "echo 'Preparing session...'"
      required: false
      timeout: 5000
      cwd: worktree

  afterCreateSession:
    - run: "bun install"
      required: true
      timeout: 60000
      cwd: worktree

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

### 无配置文件时

如果没有 `agentdock.config.yaml`，AgentDock 使用默认配置（空资源同步、空 hooks），行为与重构前完全一致。

---

## Resource Sync（资源同步）

资源同步在 Worktree 创建后、端口分配前执行。

### 字段说明

```yaml
resources:
  sync:
    - source: .env          # 相对项目根目录的路径
      strategy: overwrite   # 同步策略
      skipIfMissing: true   # 源文件不存在时是否跳过
```

### 同步策略

| 策略 | 目标不存在时 | 目标已存在时 |
|------|------------|------------|
| `overwrite` | 复制 | 覆盖（幂等） |
| `skip` | 复制 | 跳过 |
| `merge` | 复制 | 合并（见下方说明） |

### merge 策略详情

- **`.env` 类文件**：逐 key 合并，source 的同名 key 覆盖 target，target 独有的 key 保留
  - 例：source `A=1, B=2` + target `B=old, C=3` → 结果 `A=1, B=2, C=3`
- **目录**：递归复制，source 中的文件覆盖同名文件，target 中已有的文件保留

### 路径规则

- 文件路径：`source: .env` → 同步 `<project>/.env` → `<worktree>/.env`
- 目录路径：`source: uploads/` → 同步整个目录（以 `/` 结尾识别为目录）
- 子目录：`source: config/local.json` → 保留目录结构

### skipIfMissing

- `true`（默认）：源文件/目录不存在时静默跳过，记录为 `missing-skipped`
- `false`：源文件不存在时抛出错误，触发 rollback（清理 worktree + 释放端口）

---

## Hook System（钩子系统）

Hook 在 Session 生命周期的特定阶段执行 shell 命令。

### 生命周期事件

| 事件 | 触发时机 | 失败影响 |
|------|---------|---------|
| `beforeCreateSession` | Worktree 创建前 | `required: true` → 中断创建 |
| `afterCreateSession` | 端口分配 + .env 写入后 | `required: true` → rollback（清理 worktree + 释放端口） |
| `beforeDeleteSession` | Worktree 删除前 | `required: true` → 中断删除 |
| `afterDeleteSession` | Worktree 删除后 | 失败不影响结果（仅记录） |

### Hook 字段

```yaml
hooks:
  afterCreateSession:
    - run: "bun install"        # shell 命令
      required: true             # 失败是否中断 pipeline
      timeout: 60000             # 超时毫秒数（默认 30000）
      cwd: worktree              # 执行目录：worktree（默认）| project
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `run` | 必填 | shell 命令，支持平台自动选择（Windows cmd / Unix sh） |
| `required` | `false` | `true` 时失败会中断 pipeline |
| `timeout` | `30000` | 毫秒，超时后发送 SIGTERM（Windows: taskkill） |
| `cwd` | `worktree` | `worktree` = 在新 worktree 目录执行；`project` = 在项目根目录执行 |

### 环境变量

Hook 执行时自动注入以下环境变量：

| 变量 | 说明 |
|------|------|
| `AGENTDOCK_SESSION_ID` | 当前 Session ID |
| `AGENTDOCK_PROJECT_ID` | 当前项目 ID |
| `AGENTDOCK_EVENT` | 当前生命周期事件名 |

### Worktree 环境变量隔离

AgentDock 会在启动 Worktree 子进程（例如 terminal shell、lifecycle hooks）前，先读取当前 Worktree 的 `.env`，并按以下优先级构造最终环境变量：

1. 继承父进程环境（先做冲突 key 消毒）
2. 当前 Worktree `.env`
3. `AGENTDOCK_*` 运行时变量

这可以避免父项目或 AgentDock 自身进程中的环境变量污染子项目。例如：

- 子项目自定义变量（如 `API_URL`）优先使用当前 Worktree `.env`
- 端口变量（如 `FRONTEND_PORT`）优先使用当前 Session 写入 Worktree `.env` 的值
- Hook 中注入的 `AGENTDOCK_SESSION_ID` / `AGENTDOCK_PROJECT_ID` / `AGENTDOCK_EVENT` 始终覆盖同名 `.env` 值

---

## Session 生命周期

### 创建流程

```
1. BeforeCreateSession hooks
2. CreateWorktree              ← Core
3. SyncResources               ← Core（读取 agentdock.config.yaml）
4. AllocatePorts               ← Core（写入 .env）
5. AfterCreateSession hooks
6. Insert DB + Return
```

### 删除流程

```
1. BeforeDeleteSession hooks
2. ReleasePorts                ← Core
3. RemoveWorktree              ← Core
4. AfterDeleteSession hooks
```

### Rollback 触发条件

以下情况会自动 rollback（清理 worktree + 释放端口）：

- `beforeCreateSession` 中 `required: true` 的 hook 失败
- 资源同步失败（`skipIfMissing: false` 且源不存在）
- `afterCreateSession` 中 `required: true` 的 hook 失败

---

## API 变更

### POST /api/projects/:id/sessions

响应新增 `syncReport` 和 `hookReports` 字段：

```json
{
  "success": true,
  "session": {
    "id": "abc123",
    "projectId": "proj1",
    "name": "My Session",
    "branch": "agentdock/abc123",
    "worktreePath": "/path/to/.agentdock/worktrees/abc123",
    "ports": {
      "FRONTEND_PORT": 20000,
      "BACKEND_PORT": 20001,
      "WS_PORT": 20002,
      "DEBUG_PORT": 20003,
      "PREVIEW_PORT": 20004
    }
  },
  "syncReport": {
    "results": [
      {
        "source": ".env",
        "target": ".env",
        "action": "copied",
        "success": true
      }
    ],
    "success": true,
    "duration": 5
  },
  "hookReports": [
    {
      "event": "afterCreateSession",
      "results": [
        {
          "success": true,
          "exitCode": 0,
          "stdout": "...",
          "stderr": "",
          "duration": 3200,
          "timedOut": false
        }
      ],
      "success": true,
      "duration": 3200
    }
  ]
}
```

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

## 开发说明

- `scripts/start.ts` 和 `vite.config.ts` 会复用 `plugins/env.ts` 中的 `readEnvFile()` 读取当前项目 `.env`
- 这样可以正确处理带引号或行尾注释的 `.env` 值，避免启动时出现端口解析错误
- Vite watcher 默认忽略 `.agentdock/**` 和 `.claude/**`，避免 session 或 Claude 生成文件触发无关热重载

---

## 安全

AgentDock 在执行外部命令、git 操作、文件访问与本地服务通信时遵循以下加固措施：

| 领域 | 加固 |
|------|------|
| 文件浏览器 | 打开目录使用参数化调用，不经 shell 拼接，避免命令注入 |
| Git Worktree | 分支名经 `validateBranchName` 校验（拒绝 `--`、控制字符、`..` 等），防止 git 参数注入 |
| 项目路径 | `validateProjectPath` 要求绝对路径且为已存在目录，拒绝非法/不存在路径 |
| Daemon HTTP | 仅绑定 `127.0.0.1`；移除通配 CORS，非 GET 且携带 `Origin` 头的请求返回 403，防止跨站请求伪造（CSRF/DNS rebinding） |
| 端口锁 | 锁文件记录 `{pid, ts}`；仅当持有进程已退出、锁超过 30s 或内容损坏时才破锁，避免误删存活进程的锁导致端口重复分配 |
| 数据库 | 每项目 SQLite 通过 `PRAGMA user_version` 进行版本化迁移，迁移幂等且包裹在事务中，兼容旧库且不丢数据 |

---

## 测试

```bash
bun run test
```

覆盖：
- 配置解析（Zod schema + YAML loader）
- 资源同步（文件/目录、三种策略、skipIfMissing）
- Hook 引擎（注册、执行、超时、required 中断）
- Session 生命周期（编排器、rollback、执行顺序）
- API 集成（HTTP 端到端）
- 安全加固（命令注入、git 注入、路径校验、Daemon Origin、端口锁存活检测、DB 版本化迁移）
