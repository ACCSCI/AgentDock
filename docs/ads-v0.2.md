# AgentDock Compatible Specification v0.2

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

| ID | Requirement | 说明 |
|----|-------------|------|
| M1 | **Git 仓库** | 项目根目录是一个 Git 仓库（`git init` 已执行） |
| M2 | **可克隆构建** | 项目能在 Worktree 中通过安装依赖后启动运行 |
| M3 | **配置文件** | 项目根目录存在 `agentdock.config.yaml`（可为空配置） |
| M4 | **文件可读** | AgentDock 运行用户对项目目录有读写权限 |
| M5 | **单一入口** | 项目有明确的启动命令或入口文件（如 `npm start`、`python main.py`） |

### 3.2 SHOULD Requirements

| ID | Requirement | 说明 |
|----|-------------|------|
| S1 | **环境变量声明** | 项目使用 `.env` 文件管理配置，以便资源同步 |
| S2 | **依赖锁文件** | 存在 `package-lock.json`、`yarn.lock`、`poetry.lock` 等锁文件 |
| S3 | **端口可配置** | 服务端口通过环境变量（如 `PORT`）而非硬编码 |
| S4 | **幂等安装** | `install` 命令可重复执行且结果一致 |
| S5 | **Worktree 友好** | 项目不依赖 `__dirname` 定位资源（Worktree 路径与主仓库不同） |
| S6 | **非 GUI 项目** | 项目可无头运行（CLI / 服务端 / 后台任务） |
| S7 | **Session 可并行** | 项目可在多实例并行运行时不产生资源冲突（见 §4.7） |

### 3.3 MAY Requirements

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
| **Session 隔离** | **并行资源冲突检测** | **报告冲突并降级** |

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

### 4.7 Session Isolation Contract

> **v0.2 新增。** 本节定义多 Session 并行运行时的隔离要求。

AgentDock 通过 Git Worktree 提供**源码级隔离**。但项目运行时还涉及数据库、缓存、容器、进程锁等资源，这些资源**不受 Worktree 保护**。本节分析 10 类并行冲突场景。

#### 隔离模型

```
┌──────────────────────────────────────────────────────────┐
│                    宿主机 (Host)                          │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │  Session A   │  │  Session B   │  │  Session C   │   │
│  │              │  │              │  │              │   │
│  │ ┌──────────┐ │  │ ┌──────────┐ │  │ ┌──────────┐ │   │
│  │ │ Worktree │ │  │ │ Worktree │ │  │ │ Worktree │ │   │
│  │ │ (隔离 ✓) │ │  │ │ (隔离 ✓) │ │  │ │ (隔离 ✓) │ │   │
│  │ └──────────┘ │  │ └──────────┘ │  │ └──────────┘ │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         │                 │                 │            │
│         └────────┬────────┘────────┬────────┘            │
│                  ▼                 ▼                      │
│         ┌──────────────┐  ┌──────────────┐               │
│         │  共享资源层   │  │  共享资源层   │  ← 冲突区域  │
│         │  DB / Cache  │  │  Docker /     │               │
│         │  Uploads     │  │  Lock / User  │               │
│         └──────────────┘  └──────────────┘               │
└──────────────────────────────────────────────────────────┘
```

#### 隔离等级定义

| Level | 含义 | 验证器 Risk 映射 |
|-------|------|-----------------|
| **L0 — Hard Block** | 两个 Session **物理上无法同时运行** | **BLOCKER** |
| **L1 — Data Corruption** | 并行运行导致**数据损坏且不可自动恢复** | **BLOCKER** |
| **L2 — Data Conflict** | 并行运行导致**数据不一致但可恢复** | **FAIL** |
| **L3 — State Staleness** | 并行运行导致**状态过期但不影响正确性** | **WARN** |
| **L4 — No Conflict** | 天然安全，无需干预 | **PASS** |

#### 10 类冲突场景分析

---

**IS-01: 共享数据库**

| 维度 | 分析 |
|------|------|
| **场景** | 多个 Session 连接同一数据库文件（SQLite、嵌入式 DB） |
| **冲突机制** | Session A 写入 → Session B 读到脏数据 / 写入冲突 → DB 损坏 |
| **隔离等级** | **L1 — Data Corruption**（SQLite 无多实例写入保护） |
| **Risk** | **BLOCKER** |
| **AgentDock 能力** | Resource Sync 可将 DB 文件从主仓库复制到 Worktree，但运行时仍可能通过绝对路径访问主仓库 DB |
| **检测方法** | grep 源码中的数据库连接字符串（`better-sqlite3`、`sqlalchemy`、`sqlite3.connect`、`DATABASE_URL` 硬编码路径） |
| **修复建议** | 将数据库路径改为相对路径或环境变量：`DATABASE_URL=file:./dev.db`；或在 Hook 中为每个 Session 创建独立 DB |
| **Hook 方案** | `afterCreateSession: cp main.db worktree/main.db && sqlite3 worktree/main.db "DELETE FROM..."` |

---

**IS-02: 共享缓存**

| 维度 | 分析 |
|------|------|
| **场景** | 多个 Session 共享同一缓存目录（`.cache/`、`__pycache__/`、`/.next/cache/`） |
| **冲突机制** | 并发写入缓存文件 → 缓存损坏 → 构建/运行异常 |
| **隔离等级** | **L3 — State Staleness**（缓存可重建，损坏仅导致性能降级或单次构建失败） |
| **Risk** | **WARN** |
| **AgentDock 能力** | 无（缓存通常在 Worktree 内，天然隔离） |
| **检测方法** | 检测项目是否使用全局缓存目录（如 `~/.cache/`、`/tmp/app-cache/`）而非项目本地缓存 |
| **修复建议** | 将缓存目录配置为项目本地路径（如 `.cache/`）；或设置 `CACHE_DIR=./.cache` 环境变量 |

---

**IS-03: 共享上传目录**

| 维度 | 分析 |
|------|------|
| **场景** | 多个 Session 读写同一上传目录（`uploads/`、`public/uploads/`、`media/`） |
| **冲突机制** | Session A 上传文件 X → Session B 删除 X → Session A 读取 404；或文件名冲突覆盖 |
| **隔离等级** | **L2 — Data Conflict**（文件可恢复，但用户体验受损） |
| **Risk** | **FAIL** |
| **AgentDock 能力** | Resource Sync（`merge` 策略）可在创建时同步，但运行时无隔离 |
| **检测方法** | grep 源码中的硬编码上传路径、检测 `multer`/`busboy`/`flask-upload` 等上传中间件配置 |
| **修复建议** | 将上传目录设为环境变量：`UPLOAD_DIR=./uploads`；或在 `agentdock.config.yaml` 中声明同步策略 |
| **Hook 方案** | `afterCreateSession: mkdir -p worktree/uploads && cp -rn project/uploads/* worktree/uploads/ 2>/dev/null` |

---

**IS-04: 全局配置目录**

| 维度 | 分析 |
|------|------|
| **场景** | 应用运行时读写用户级配置目录（`~/.config/appname/`、`~/.appname/`、`%APPDATA%/appname/`） |
| **冲突机制** | Session A 修改配置 → Session B 读到 Session A 的配置 → 行为异常 |
| **隔离等级** | **L3 — State Staleness**（配置可恢复，最坏情况为行为不符预期） |
| **Risk** | **WARN** |
| **AgentDock 能力** | 无（Worktree 不覆盖用户目录） |
| **检测方法** | grep 源码中的 `os.homedir()`、`process.env.HOME`、`process.env.APPDATA`、`XDG_CONFIG_HOME` |
| **修复建议** | 支持 `XDG_CONFIG_HOME` 环境变量重定向：Hook 中设置 `XDG_CONFIG_HOME=$AGENTDOCK_WORKTREE_PATH/.config` |

---

**IS-05: 固定 Docker 容器名**

| 维度 | 分析 |
|------|------|
| **场景** | Docker Compose 或启动脚本中硬编码容器名称（`container_name: myapp`） |
| **冲突机制** | Session A 启动容器 `myapp` → Session B 尝试启动同名容器 → **失败：容器名已占用** |
| **隔离等级** | **L0 — Hard Block**（物理上无法同时运行） |
| **Risk** | **BLOCKER** |
| **AgentDock 能力** | 无（Docker 容器名是全局的） |
| **检测方法** | 检测 `docker-compose.yml`/`compose.yml` 中的 `container_name` 字段；检测 `docker run --name` 参数 |
| **修复建议** | 移除 `container_name`（Docker 自动生成唯一名称）；或使用模板：`container_name: ${PROJECT_NAME:-myapp}-${SESSION_ID:-default}` |
| **验证** | `grep -n 'container_name' docker-compose.yml compose.yml` |

---

**IS-06: 固定 Docker 网络名**

| 维度 | 分析 |
|------|------|
| **场景** | Docker Compose 中硬编码外部网络名（`external: true, name: myapp-network`） |
| **冲突机制** | 多个 Session 使用同一网络 → 容器可互相通信 → 端口/服务发现冲突 |
| **隔离等级** | **L3 — State Staleness**（网络共享不阻止启动，但破坏隔离） |
| **Risk** | **WARN** |
| **AgentDock 能力** | 无 |
| **检测方法** | grep `docker-compose.yml` 中 `networks:` 下的 `external: true` 和固定 `name:` |
| **修复建议** | 使用动态网络名：`name: ${COMPOSE_PROJECT_NAME:-default}_network`（Docker Compose 自动用项目名前缀） |

---

**IS-07: 固定 Docker Volume**

| 维度 | 分析 |
|------|------|
| **场景** | Docker Compose 中使用固定名称的 named volume（`volumes: [db-data:/var/lib/postgresql/data]`） |
| **冲突机制** | Session A 和 Session B 共享同一 volume → 数据互相污染 → DB 损坏或状态不一致 |
| **隔离等级** | **L1 — Data Corruption**（数据库数据被跨 Session 覆盖） |
| **Risk** | **BLOCKER** |
| **AgentDock 能力** | 无（Docker volume 名是全局的） |
| **检测方法** | grep `docker-compose.yml` 中 `volumes:` 定义和 `services.*.volumes` 引用，检查是否使用固定 named volume |
| **修复建议** | 使用 `COMPOSE_PROJECT_NAME` 环境变量自动前缀 volume 名；或改用 bind mount 指向 Worktree 内路径 |
| **Hook 方案** | `beforeCreateSession: export COMPOSE_PROJECT_NAME=$AGENTDOCK_SESSION_ID` |

---

**IS-08: 固定端口**

| 维度 | 分析 |
|------|------|
| **场景** | 源码或配置中硬编码端口号（`listen(3000)`、`PORT=3000`） |
| **冲突机制** | Session A 占用 3000 → Session B 尝试绑定 3000 → **EADDRINUSE** |
| **隔离等级** | **L0 — Hard Block**（端口冲突导致启动失败） |
| **Risk** | **BLOCKER** |
| **AgentDock 能力** | Port Registry 自动分配端口（20000-65535），写入 `.env`；但源码必须读取环境变量才生效 |
| **检测方法** | grep 源码中的 `listen(\d{4,5})`、`:\d{4,5}`、`PORT=\d+`、`port: \d{4,5}`（排除环境变量读取模式） |
| **修复建议** | 将端口改为读取环境变量：`process.env.PORT \|\| 3000`；或 `--port $BACKEND_PORT` |
| **注意** | AgentDock 已通过 Port Contract 自动分配端口，但**项目必须配合读取环境变量**才能生效 |

---

**IS-09: 用户目录写入**

| 维度 | 分析 |
|------|------|
| **场景** | 应用运行时写入用户主目录下的固定路径（`~/myapp-data/`、`~/.local/share/myapp/`） |
| **冲突机制** | Session A 写入数据文件 → Session B 读到 Session A 的数据 → 业务逻辑错误 |
| **隔离等级** | **L2 — Data Conflict**（数据可恢复，但业务状态混乱） |
| **Risk** | **FAIL** |
| **AgentDock 能力** | 无（Worktree 不覆盖用户目录） |
| **检测方法** | grep 源码中的 `os.homedir()` + 硬编码子路径、`path.join(os.homedir(), '...')` |
| **修复建议** | 支持 `XDG_DATA_HOME` / `APPDATA` 环境变量重定向；或在 Hook 中设置 `HOME=$AGENTDOCK_WORKTREE_PATH/.home`（仅限 Hook 子进程） |

---

**IS-10: 进程级全局锁**

| 维度 | 分析 |
|------|------|
| **场景** | 应用使用 PID 文件或锁文件防止多实例运行（`/var/run/app.pid`、`app.lock`、`flock()`） |
| **冲突机制** | Session A 创建锁 → Session B 尝试获取锁 → **拒绝启动** |
| **隔离等级** | **L0 — Hard Block**（物理上无法同时运行） |
| **Risk** | **BLOCKER** |
| **AgentDock 能力** | 无（锁文件是进程级的） |
| **检测方法** | grep 源码中的 `flock`、`lockfile`、`.pid`、`createLock`、`pidfile`、`Lockfile` |
| **修复建议** | 将锁文件路径改为 Worktree 内路径：`LOCK_FILE=$AGENTDOCK_WORKTREE_PATH/app.lock`；或移除全局锁（开发环境不需要） |
| **注意** | 数据库的 WAL 锁（SQLite）属于 IS-01，不在此项 |

---

#### 隔离风险汇总

| # | 场景 | 隔离等级 | Risk | 可修复性 | 典型触发条件 |
|---|------|---------|------|---------|-------------|
| IS-01 | 共享数据库 | L1 | **BLOCKER** | 中 — 需改 DB 路径为相对/环境变量 | SQLite、嵌入式 DB |
| IS-02 | 共享缓存 | L3 | **WARN** | 高 — 改为本地缓存目录 | 全局缓存目录 |
| IS-03 | 共享上传目录 | L2 | **FAIL** | 高 — 改为环境变量 + Hook 同步 | 文件上传功能 |
| IS-04 | 全局配置目录 | L3 | **WARN** | 中 — 支持 XDG 环境变量重定向 | 读写用户配置 |
| IS-05 | 固定 Docker 容器名 | L0 | **BLOCKER** | 高 — 移除 container_name | Docker Compose |
| IS-06 | 固定 Docker 网络名 | L3 | **WARN** | 高 — 使用动态网络名 | Docker Compose |
| IS-07 | 固定 Docker Volume | L1 | **BLOCKER** | 中 — 使用 COMPOSE_PROJECT_NAME | Docker Compose |
| IS-08 | 固定端口 | L0 | **BLOCKER** | 高 — 读取环境变量 | 服务端应用 |
| IS-09 | 用户目录写入 | L2 | **FAIL** | 中 — XDG 重定向 | 桌面/CLI 应用 |
| IS-10 | 进程级全局锁 | L0 | **BLOCKER** | 中 — 锁文件路径本地化 | 单例进程设计 |

#### 隔离等级判定规则

```
项目隔离等级 = max(所有检测到的冲突场景的隔离等级)

L0 (Hard Block)     → Risk: BLOCKER  → Verdict: Not Compatible
L1 (Data Corruption) → Risk: BLOCKER  → Verdict: Not Compatible
L2 (Data Conflict)   → Risk: FAIL     → Verdict: Partially Compatible
L3 (State Staleness) → Risk: WARN     → 降级评分，不阻塞 Verdict
L4 (No Conflict)     → Risk: PASS     → 不影响 Verdict
```

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

### 6.1 Node.js + Express API（需 Session 隔离配置）

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
    - run: "cp dev.db worktree/dev.db"
      required: false
      timeout: 5000
```

**Session 隔离要求：** IS-01（DB）、IS-08（端口）  
**修复：** DB 路径使用 `file:./dev.db`，端口使用 `process.env.PORT`。

### 6.2 Docker Compose 项目（需移除固定名称）

```yaml
# docker-compose.yml — 修复前（不兼容）
services:
  app:
    container_name: myapp        # IS-05: BLOCKER
    ports:
      - "3000:3000"              # IS-08: BLOCKER
    volumes:
      - db-data:/var/lib/data   # IS-07: BLOCKER

volumes:
  db-data:                       # 固定 volume 名
```

```yaml
# docker-compose.yml — 修复后（兼容）
services:
  app:
    # container_name 移除（自动生成唯一名称）
    ports:
      - "${BACKEND_PORT:-3000}:3000"
    volumes:
      - ./data:/var/lib/data    # 改为 bind mount
    environment:
      - PORT=3000
```

### 6.3 CLI 工具项目

```yaml
version: "1"
resources: []
hooks:
  afterCreateSession:
    - run: "cargo build"
      required: true
      timeout: 300000
```

**Session 隔离要求：** IS-10（进程锁）  
**修复：** 将锁文件路径改为 `$AGENTDOCK_WORKTREE_PATH/.lock`。

### 6.4 无配置项目

无 `agentdock.config.yaml` 时，AgentDock 使用默认行为：
- 无资源同步
- 无 Hook 执行
- 仍分配端口并创建 Worktree

适用于一次性探索、代码阅读等轻量场景。

---

## 7. Compatibility Matrix

| 项目类型 | M1 | M2 | M3 | M4 | M5 | IS | 兼容等级 |
|---------|----|----|----|----|----|----|---------|
| Node.js + Vite 前端 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full |
| Node.js + Express API | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ DB | High |
| Python + Flask/FastAPI | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ DB | High |
| Docker Compose 项目 | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ 多项 | Low → High（修复后） |
| Rust + Cargo | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full |
| Go + CLI | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ Lock | High |
| 静态 HTML | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Full |
| 需要 GUI 的项目 | ✅ | ⚠️ | ✅ | ✅ | ⚠️ | — | Low |

> **IS 列：** Session Isolation 检查通过情况。⚠️ = 需要 Hook 配置修复，❌ = 需要代码/配置修改。

---

## 8. Versioning

本规范采用 [SemVer](https://semver.org/)：

- **MAJOR**：不兼容的变更（如删除必填字段、改变创建流程）
- **MINOR**：向后兼容的功能新增（如新增 Hook 事件、新增同步策略、新增隔离检查项）
- **PATCH**：文档修正、定义澄清

| Version | Date | Changes |
|---------|------|---------|
| v0.1.0 | 2026-06-05 | Initial draft |
| v0.2.0 | 2026-06-05 | 新增 §4.7 Session Isolation Contract；新增 S7 需求；10 类并行冲突场景分析 |

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
| **Session Isolation** | 多 Session 并行运行时，除源码外的资源隔离能力 |
| **隔离等级** | L0-L4，描述并行冲突的严重程度 |
