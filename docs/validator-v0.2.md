# AgentDock Compatibility Validator v0.2

> 给定任意 Git 仓库，判断其与 AgentDock 的兼容等级。  
> 本文档定义检查清单、两种验证方案（LLM Prompt / Rule-based）、输出格式。  
> 基于 ADS v0.2，新增 Phase 7 Session Isolation 检查。

---

## 1. Verdict 定义

| Verdict | 含义 | 判定规则 |
|---------|------|---------|
| **Compatible** | 所有 MUST 检查通过 + 无隔离冲突 | MUST 全通过，SHOULD ≥ 4/6，无 L0/L1 隔离冲突 |
| **Partially Compatible** | 核心功能可用但并行受限 | MUST 全通过但存在 L2 隔离冲突，或 SHOULD < 4/6，或 MUST 有 1 项可修复 |
| **Not Compatible** | 无法被 AgentDock 管理 | MUST 有 ≥ 1 项不可修复失败，或存在 L0/L1 不可修复隔离冲突 |

**v0.2 变更：** Verdict 判定从"仅检查项目能否运行"扩展为"项目能否并行运行"。L0/L1 隔离冲突等同于 BLOCKER。

---

## 2. Check Registry

所有检查项按执行顺序排列。共 7 个 Phase，40 项检查。

### Phase 1 — Environment（环境检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 1 | `ENV-GIT` | Git 仓库检测 | BLOCKER | M1 | `git rev-parse --is-inside-work-tree` 返回 0 | `git init` |
| 2 | `ENV-GIT-CLEAN` | Git 工作区状态 | WARNING | M1 | 无未提交变更（或仅含 `.agentdock/`） | `git add` / `git stash` |
| 3 | `ENV-GIT-REMOTE` | 远程仓库可达 | INFO | — | `git remote -v` 列出至少一个远程 | 添加 remote |
| 4 | `ENV-PERMISSIONS` | 目录可读写 | BLOCKER | M4 | 对项目根目录有 r+w 权限 | 修改权限 |
| 5 | `ENV-DISK` | 磁盘空间 | WARNING | — | 剩余空间 > 500MB | 清理磁盘 |

### Phase 2 — Config（配置检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 6 | `CFG-EXISTS` | 配置文件存在 | INFO | M3 | `agentdock.config.yaml` 存在 | 创建空配置文件 |
| 7 | `CFG-YAML` | YAML 语法有效 | BLOCKER | 4.4 | 文件可被 YAML parser 解析 | 检查 YAML 语法 |
| 8 | `CFG-SCHEMA` | Schema 校验通过 | BLOCKER | 4.4 | 符合 `AgentDockConfigSchema` | 修正字段 |
| 9 | `CFG-VERSION` | 版本字段 | WARNING | — | `version` 字段存在且为 `"1"` | 添加 `version: "1"` |
| 10 | `CFG-RESOURCE-PATH` | 资源路径无逃逸 | BLOCKER | 4.3 | 所有 `source` 不含 `..` | 修正路径 |
| 11 | `CFG-RESOURCE-UNIQUE` | 资源声明无重复 | WARNING | 4.3 | 同一 `source` 未出现两次 | 合并或删除重复项 |
| 12 | `CFG-HOOK-EVENT` | Hook 事件名合法 | BLOCKER | 4.5 | 所有 key 属于已知事件列表 | 修正事件名 |
| 13 | `CFG-HOOK-RUN` | Hook run 非空 | BLOCKER | 4.5 | 每个 Hook 的 `run` 字段非空字符串 | 填写命令 |
| 14 | `CFG-HOOK-TIMEOUT` | Hook timeout 合理 | WARNING | 4.5 | `timeout` > 0 且 ≤ 600000（10 min） | 调整 timeout |

### Phase 3 — Project Structure（项目结构检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 15 | `PROJ-ENTRY` | 入口文件/命令可识别 | BLOCKER | M5 | 存在 `package.json`（含 scripts）、`Cargo.toml`、`go.mod`、`pyproject.toml`、`Makefile`、`Dockerfile` 或入口源文件 | 添加入口文件或声明启动命令 |
| 16 | `PROJ-DEPS-MANAGER` | 包管理器可识别 | WARNING | S4 | 存在依赖描述文件 | 添加依赖描述文件 |
| 17 | `PROJ-LOCK-FILE` | 锁文件存在 | WARNING | S2 | 存在 lock 文件 | 运行安装命令生成锁文件 |
| 18 | `PROJ-ENV-FILE` | `.env` 文件存在 | INFO | S1 | `.env` 或 `.env.example` 存在 | 创建 `.env` |
| 19 | `PROJ-ENV-TEMPLATE` | `.env.example` 存在 | INFO | — | `.env.example` / `.env.template` 存在 | 创建 `.env.example` |
| 20 | `PROJ-NODE_MODULES` | 依赖目录存在 | WARNING | — | `node_modules` / `venv` / `.venv` / `target` 存在 | 运行安装命令 |

### Phase 4 — Port & Network（端口与网络检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 21 | `NET-PORT-CONFIG` | 端口可通过环境变量配置 | WARNING | S3 | 源码中 `PORT` 不被硬编码 | 改用 `process.env.PORT` 或 `$PORT` |
| 22 | `NET-PORT-RANGE` | 默认端口在可用范围 | INFO | 4.6 | 默认端口在 20000-65535 范围内 | 无需修复 |
| 23 | `NET-WS` | WebSocket 使用检测 | INFO | Y4 | 检测 WebSocket 依赖 | 无需修复 |
| 24 | `NET-DEBUG` | 调试端口检测 | INFO | Y5 | 检测 `--inspect`/`--debug` 配置 | 无需修复 |

### Phase 5 — Worktree Compatibility（Worktree 兼容性检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 25 | `WT-DIRNAME` | `__dirname` 使用风险 | WARNING | S5 | 源码中无 `__dirname` 或已适配 | 改用相对路径或 `import.meta.url` |
| 26 | `WT-HARDCODED-PATH` | 硬编码绝对路径检测 | WARNING | S5 | 源码中无硬编码的项目绝对路径 | 改用 `process.cwd()` 或环境变量 |
| 27 | `WT-SYMLINK` | 符号链接依赖 | WARNING | — | 项目不依赖 symlink | 改为 npm link 后重建 |
| 28 | `WT-GITMODULES` | Git submodule 检测 | WARNING | — | 无 `.gitmodules`，或已初始化 | `git submodule update --init` |

### Phase 6 — Build & Runtime（构建与运行时检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 29 | `BUILD-SCRIPT` | 构建脚本可识别 | INFO | M2 | `package.json` 中有 `build`/`start`/`dev` script | 添加 script |
| 30 | `BUILD-TYPECHECK` | 类型检查通过 | INFO | SHOULD | `tsc --noEmit` 无错误（TypeScript 项目） | 修复类型错误 |

### Phase 7 — Session Isolation（Session 隔离检查）🆕

> **v0.2 新增。** 对应 ADS v0.2 §4.7。检查项目在多 Session 并行运行时是否会产生资源冲突。

| # | Check ID | 检查项 | Isolation Level | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|----------------|------|------|---------|-----|
| 31 | `IS-DB` | 共享数据库检测 | L1 | **BLOCKER** | IS-01 | 源码中数据库连接使用相对路径或环境变量 | 改为 `file:./dev.db` 或 `DATABASE_URL` 环境变量 |
| 32 | `IS-CACHE` | 共享缓存目录检测 | L3 | **WARNING** | IS-02 | 缓存目录为项目本地路径（非全局） | 配置 `CACHE_DIR=./.cache` |
| 33 | `IS-UPLOAD` | 共享上传目录检测 | L2 | **FAIL** | IS-03 | 上传路径通过环境变量配置 | 改为 `UPLOAD_DIR=./uploads` |
| 34 | `IS-CONFIG-DIR` | 全局配置目录检测 | L3 | **WARNING** | IS-04 | 无用户级配置目录读写 | 支持 `XDG_CONFIG_HOME` 重定向 |
| 35 | `IS-DOCKER-NAME` | 固定 Docker 容器名检测 | L0 | **BLOCKER** | IS-05 | 无 `container_name` 或使用变量模板 | 移除 `container_name` 或用 `${SESSION_ID}` 模板 |
| 36 | `IS-DOCKER-NET` | 固定 Docker 网络名检测 | L3 | **WARNING** | IS-06 | 无 `external: true` 固定网络名 | 使用 `COMPOSE_PROJECT_NAME` 自动前缀 |
| 37 | `IS-DOCKER-VOL` | 固定 Docker Volume 检测 | L1 | **BLOCKER** | IS-07 | 无固定 named volume 或使用 `COMPOSE_PROJECT_NAME` | 改为 bind mount 或设置 `COMPOSE_PROJECT_NAME` |
| 38 | `IS-PORT` | 固定端口检测 | L0 | **BLOCKER** | IS-08 | 所有端口通过环境变量配置 | 改用 `process.env.PORT` / `$PORT` |
| 39 | `IS-USER-DIR` | 用户目录写入检测 | L2 | **FAIL** | IS-09 | 无用户主目录固定路径写入 | 支持 `XDG_DATA_HOME` 重定向 |
| 40 | `IS-LOCK` | 进程级全局锁检测 | L0 | **BLOCKER** | IS-10 | 锁文件路径为本地或可配置 | 改为 `$AGENTDOCK_WORKTREE_PATH/.lock` |

**Phase 7 Risk 映射规则：**

```
隔离等级 → Risk 映射：
  L0 (Hard Block)      → BLOCKER   → 项目无法并行运行
  L1 (Data Corruption)  → BLOCKER   → 并行运行导致数据损坏
  L2 (Data Conflict)    → FAIL      → 并行运行导致数据不一致
  L3 (State Staleness)  → WARNING   → 状态过期但不影响正确性
  L4 (No Conflict)      → PASS      → 天然安全
```

---

## 3. Execution Phases

```
Phase 1: Environment         ──── BLOCKER? → 快速失败
    │
Phase 2: Config              ──── BLOCKER? → 快速失败
    │
Phase 3: Project Structure   ──── BLOCKER? → 快速失败
    │
Phase 4: Port & Network      ──── 收集 INFO，不阻塞
    │
Phase 5: Worktree Compat     ──── WARNING 聚合
    │
Phase 6: Build & Runtime     ──── 收集 INFO，不阻塞
    │
Phase 7: Session Isolation   ──── BLOCKER/FAIL 聚合，影响 Verdict  🆕
    │
    └─→ Verdict 汇总
```

**Early Termination 规则：**

- Phase 1 `ENV-GIT` 失败 → 终止，`Not Compatible`
- Phase 2 `CFG-SCHEMA` 失败 → 终止，`Not Compatible`
- Phase 7 `IS-DB` 或 `IS-DOCKER-NAME` 失败（L0/L1 不可修复） → 终止，`Not Compatible`
- 其他 BLOCKER → 继续执行但标记，收集所有 BLOCKER 后统一报告

**Phase 7 特殊规则：**

Phase 7 是唯一**不触发 Early Termination** 的 BLOCKER 阶段。原因：
- L0/L1 冲突可以通过 Hook 配置或代码修改修复
- 需要收集所有隔离冲突以便一次性报告
- 只有**不可修复**的 L0/L1 才最终判定为 `Not Compatible`

---

## 4. Risk Level 定义

| Level | 含义 | 对 Verdict 的影响 |
|-------|------|------------------|
| **BLOCKER** | 项目无法被 AgentDock 管理 | 任一 BLOCKER 失败 → `Not Compatible`（可修复时降为 `Partially Compatible`） |
| **FAIL** | 并行运行时数据不一致 | FAIL > 0 → `Partially Compatible` |
| **WARNING** | 功能受限或行为不符合预期 | 聚合：WARNING ≥ 3 且无 BLOCKER/FAIL → `Partially Compatible` |
| **INFO** | 信息性提示 | 不影响 Verdict |

**v0.2 新增 FAIL 级别：** 用于 Phase 7 中 L2 隔离冲突。与 BLOCKER 的区别是 L2 不会导致物理不可运行或数据损坏，而是数据不一致。

---

## 5. Output Format

### 5.1 Machine-readable (JSON)

```json
{
  "version": "0.2",
  "repo": "/path/to/project",
  "verdict": "Partially Compatible",
  "score": 65,
  "phases": [
    {
      "name": "Environment",
      "checks": [
        { "id": "ENV-GIT", "status": "PASS", "risk": "BLOCKER", "message": "Git repository detected", "fix": null }
      ]
    },
    {
      "name": "Session Isolation",
      "checks": [
        { "id": "IS-DB", "status": "FAIL", "risk": "BLOCKER", "isolation": "L1", "message": "SQLite database at hardcoded path ./data/app.db", "fix": "Use DATABASE_URL=file:./dev.db or env variable" },
        { "id": "IS-PORT", "status": "FAIL", "risk": "BLOCKER", "isolation": "L0", "message": "Port 3000 hardcoded in src/server.ts:8", "fix": "Use process.env.PORT || 3000" },
        { "id": "IS-UPLOAD", "status": "WARN", "risk": "FAIL", "isolation": "L2", "message": "Upload path hardcoded to ./uploads", "fix": "Use UPLOAD_DIR env variable" }
      ]
    }
  ],
  "isolation": {
    "level": "L1",
    "conflicts": [
      { "id": "IS-DB", "level": "L1", "fixable": true },
      { "id": "IS-PORT", "level": "L0", "fixable": true }
    ],
    "parallelSessions": "BLOCKED_BY_L0_L1"
  },
  "summary": {
    "total": 40,
    "pass": 32,
    "warn": 3,
    "fail": 2,
    "info": 3,
    "blockers": 2,
    "fixableBlockers": 2
  }
}
```

### 5.2 Human-readable (Markdown)

```markdown
## AgentDock Compatibility Report

**Repository:** `/path/to/project`  
**Verdict:** ⚠️ Partially Compatible (Score: 65/100)

### ❌ Blockers (2)

| Check | Isolation | Message | Fix |
|-------|-----------|---------|-----|
| IS-DB | L1 | SQLite at hardcoded `./data/app.db` | Use `DATABASE_URL=file:./dev.db` |
| IS-PORT | L0 | Port 3000 hardcoded in `src/server.ts:8` | Use `process.env.PORT` |

### ❌ Failures (1)

| Check | Isolation | Message | Fix |
|-------|-----------|---------|-----|
| IS-UPLOAD | L2 | Upload path hardcoded to `./uploads` | Use `UPLOAD_DIR` env var |

### ⚠️ Warnings (3)

| Check | Message | Fix |
|-------|---------|-----|
| ENV-GIT-CLEAN | 3 uncommitted changes | `git stash` |
| PROJ-LOCK-FILE | No lock file found | Run install |
| IS-CACHE | Global cache dir `~/.cache/app` | Use `CACHE_DIR=./.cache` |

### ℹ️ Info (3)

| Check | Message |
|-------|---------|
| ENV-GIT-REMOTE | No remote configured |
| PROJ-ENV-FILE | No `.env` file |
| NET-WS | WebSocket detected |

### Session Isolation Analysis

| Conflict | Level | Fixable | Parallel Sessions |
|----------|-------|---------|-------------------|
| IS-DB | L1 | ✅ | BLOCKED |
| IS-PORT | L0 | ✅ | BLOCKED |
| IS-UPLOAD | L2 | ✅ | Degraded |

**Max Isolation Level: L1 (Data Corruption)**  
**Parallel Session Status:** Blocked until L0/L1 conflicts resolved

### Score Breakdown

| Phase | Pass | Warn | Fail | Blocker |
|-------|------|------|------|---------|
| Environment | 3/5 | 2 | 0 | 0 |
| Config | 9/9 | 0 | 0 | 0 |
| Project Structure | 3/6 | 2 | 0 | 0 |
| Port & Network | 3/4 | 1 | 0 | 0 |
| Worktree Compat | 2/4 | 2 | 0 | 0 |
| Build & Runtime | 1/2 | 0 | 0 | 0 |
| **Session Isolation** | **3/10** | **1** | **2** | **2** |
```

### 5.3 Scoring Formula

```
基础分 = 100

Phase 1-6 扣分（同 v0.1）:
  BLOCKER × 10
  WARNING × 3
  INFO    × 1

Phase 7 隔离扣分（v0.2 新增）:
  L0 (BLOCKER, fixable)     → -15
  L0 (BLOCKER, unfixable)   → -30
  L1 (BLOCKER, fixable)     → -12
  L1 (BLOCKER, unfixable)   → -25
  L2 (FAIL)                 → -5
  L3 (WARNING)              → -2

Score = max(0, 100 - Σ(all penalties))
```

---

## 6. Solution A: LLM Prompt Validator

适用于没有本地执行环境的场景，由 LLM 基于仓库内容进行静态分析。

### 6.1 System Prompt

```text
You are an AgentDock Compatibility Validator (v0.2). Your task is to
evaluate whether a Git repository is compatible with AgentDock v0.2.

AGENTDOCK SPECIFICATION (ADS v0.2):
The spec defines requirements for projects to be managed by AgentDock,
a session management system that creates isolated Git Worktrees for
parallel development.

Key concepts:
- MANDATORY: Git repo, config file, entry point, read/write permissions
- SHOULD: .env, lock files, env-configurable ports, idempotent install
- SESSION ISOLATION: Projects must support parallel sessions without
  resource conflicts (database, Docker, ports, locks, etc.)

SESSION ISOLATION LEVELS:
- L0 (Hard Block): Physical impossibility to run in parallel
  → docker container_name, fixed ports, process locks
- L1 (Data Corruption): Parallel run causes irrecoverable damage
  → shared SQLite, fixed Docker volumes
- L2 (Data Conflict): Parallel run causes recoverable inconsistency
  → shared upload dirs, user directory writes
- L3 (State Staleness): State goes stale but correctness unaffected
  → global caches, config dirs, Docker networks
- L4 (No Conflict): Naturally safe

YOU WILL RECEIVE:
1. Repository file tree (directory listing)
2. Key file contents (package.json, config files, source snippets)
3. Docker Compose files (if any)
4. Git status output
5. Grep results for isolation patterns

YOUR TASK:
Evaluate the repository against the ADS v0.2 check registry, including
the new Session Isolation phase, and output a structured report.

CHECK REGISTRY (7 phases, 40 checks):
Phase 1 (Environment): ENV-GIT, ENV-GIT-CLEAN, ENV-GIT-REMOTE,
  ENV-PERMISSIONS, ENV-DISK
Phase 2 (Config): CFG-EXISTS, CFG-YAML, CFG-SCHEMA, CFG-VERSION,
  CFG-RESOURCE-PATH, CFG-RESOURCE-UNIQUE, CFG-HOOK-EVENT,
  CFG-HOOK-RUN, CFG-HOOK-TIMEOUT
Phase 3 (Project Structure): PROJ-ENTRY, PROJ-DEPS-MANAGER,
  PROJ-LOCK-FILE, PROJ-ENV-FILE, PROJ-ENV-TEMPLATE, PROJ-NODE_MODULES
Phase 4 (Port & Network): NET-PORT-CONFIG, NET-PORT-RANGE, NET-WS,
  NET-DEBUG
Phase 5 (Worktree Compat): WT-DIRNAME, WT-HARDCODED-PATH,
  WT-SYMLINK, WT-GITMODULES
Phase 6 (Build & Runtime): BUILD-SCRIPT, BUILD-TYPECHECK
Phase 7 (Session Isolation): IS-DB, IS-CACHE, IS-UPLOAD,
  IS-CONFIG-DIR, IS-DOCKER-NAME, IS-DOCKER-NET, IS-DOCKER-VOL,
  IS-PORT, IS-USER-DIR, IS-LOCK

OUTPUT FORMAT:
Return exactly one JSON object matching the schema:
{
  "version": "0.2",
  "verdict": "Compatible" | "Partially Compatible" | "Not Compatible",
  "score": <0-100>,
  "phases": [
    {
      "name": "<phase_name>",
      "checks": [
        {
          "id": "<CHECK_ID>",
          "status": "PASS" | "FAIL" | "WARN" | "SKIP",
          "risk": "BLOCKER" | "FAIL" | "WARNING" | "INFO",
          "isolation": "<L0|L1|L2|L3|null>",  // Phase 7 only
          "fixable": <bool>,                    // Phase 7 only
          "message": "<explanation>",
          "fix": "<actionable fix or null>"
        }
      ]
    }
  ],
  "isolation": {
    "level": "<max isolation level detected>",
    "conflicts": [{ "id": "IS-xxx", "level": "Lx", "fixable": bool }],
    "parallelSessions": "OK" | "DEGRADED" | "BLOCKED"
  },
  "summary": {
    "total": <int>, "pass": <int>, "warn": <int>,
    "fail": <int>, "blockers": <int>, "fixableBlockers": <int>
  }
}

RULES:
- Do NOT fabricate file contents. If you cannot verify a check, mark SKIP.
- For Phase 7 checks, analyze BOTH source code AND Docker Compose files.
- Pay special attention to:
  * Docker Compose: container_name, volumes with fixed names, external networks
  * Source code: hardcoded ports, database connection strings, file locks,
    user directory paths, global config directory usage
  * Config files: DATABASE_URL, PORT, LOCK_FILE paths
- For IS-PORT: distinguish between hardcoded ports (listen(3000)) and
  env-variable ports (listen(process.env.PORT)). Only flag hardcoding.
- Score = 100 - penalties (see scoring formula).
- Verdict rules:
  - Compatible: 0 blockers, 0 fails, warns < 3, max isolation ≤ L3
  - Partially Compatible: (fails > 0 OR warns ≥ 3 OR max isolation = L2)
  - Not Compatible: blockers > 0 (with unfixable L0/L1)
```

### 6.2 User Prompt Template

```text
Please validate the following repository for AgentDock v0.2 compatibility.

## Repository Context

### File Tree
```tree
{file_tree}
```

### Key Files

#### {filename}
```{lang}
{file_content}
```
(repeat for each relevant file)

### Docker Compose Files
```yaml
{docker_compose_content}
```
(or "No Docker Compose files found")

### Grep Results — Isolation Patterns

#### Hardcoded Ports
```{results}
```

#### Database Connections
```{results}
```

#### Docker container_name / volumes
```{results}
```

#### Process Locks (flock, .pid, lockfile)
```{results}
```

#### User Directory Access (homedir, APPDATA, XDG)
```{results}
```

### Git Status
```bash
{git_status_output}
```

## Instructions

Evaluate this repository against the AgentDock Compatibility Specification v0.2.
Output your report as JSON following the schema defined in your system prompt.

Focus especially on:
1. Phase 1-6: Standard checks (entry point, config, ports, worktree compat)
2. **Phase 7 — Session Isolation (critical for v0.2):**
   a. Database: Is there a hardcoded SQLite/database path? Will two sessions
      corrupt each other's DB?
   b. Docker: Are container_name, volume names, or network names hardcoded?
   c. Ports: Are ports hardcoded or read from environment variables?
   d. Locks: Does the app use PID files or flock that prevents multi-instance?
   e. Uploads/User dirs: Does the app write to shared global paths?
3. For each IS-xx check, determine the isolation level (L0-L4)
   and whether the conflict is fixable via config/code changes.
```

### 6.3 Input Preparation Algorithm

```text
function prepareLLMInput(projectPath):
    context = {}

    // 1. File tree (depth 2, exclude hidden + node_modules)
    context.fileTree = listDir(projectPath, depth=2,
        exclude=[".git", "node_modules", ".venv", "dist", "build", ".agentdock"])

    // 2. Key files to read
    candidates = [
        "package.json", "tsconfig.json", "vite.config.*",
        "pyproject.toml", "requirements.txt", "setup.py",
        "Cargo.toml", "go.mod", "Makefile", "Dockerfile",
        "docker-compose.yml", "docker-compose.yaml",
        "compose.yml", "compose.yaml",
        "agentdock.config.yaml", ".env", ".env.example", ".env.template"
    ]
    context.files = {}
    for each candidate:
        if exists(projectPath / candidate):
            context.files[candidate] = readFile(projectPath / candidate)

    // 3. Source code for general checks
    context.sourceFiles = grepFiles(projectPath,
        patterns=["__dirname", "process.env.PORT", "hardcoded paths",
                   "WebSocket", "socket.io", "--inspect", "--debug"],
        extensions=[".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs"],
        maxResults=20)

    // 4. 🆕 Source code for isolation checks
    context.isolationGrep = {}

    // IS-PORT: hardcoded ports
    context.isolationGrep.hardcodedPorts = grepFiles(projectPath,
        patterns=[
            'listen\\(\\s*\\d{4,5}',      # listen(3000)
            ':\\s*\\d{4,5}\\s*[,)}]',      # :3000,
            'PORT\\s*=\\s*\\d{4,5}',       # PORT=3000
            '"port"\\s*:\\s*\\d{4,5}'      # "port": 3000
        ],
        excludePatterns=[
            'process\\.env\\.',            # exclude env var reads
            '\\$\\{.*PORT',                # exclude template vars
        ],
        extensions=[".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs", ".yaml", ".yml"],
        maxResults=30)

    // IS-DB: database connections
    context.isolationGrep.databaseConnections = grepFiles(projectPath,
        patterns=[
            'sqlite3?\\.connect',          # Python sqlite3
            'better-sqlite3',              # Node better-sqlite3
            'new Database\\(',             # better-sqlite3 constructor
            'DATABASE_URL',                # env reference
            'data_source',                 # SQLAlchemy
            'sqlx::Sqlite',                # Rust sqlx
        ],
        extensions=[".js", ".ts", ".py", ".rs", ".go", ".yaml", ".yml"],
        maxResults=20)

    // IS-DOCKER: container_name, volumes, networks
    context.isolationGrep.dockerConfig = grepFiles(projectPath,
        patterns=[
            'container_name\\s*:',         # docker-compose container_name
            'docker run.*--name',          # docker run --name
            'volumes:\\s*$',               # named volume section
            '- [a-zA-Z_-]+:',             # volume reference (name:)
            'external:\\s*true',           # external network
        ],
        extensions=[".yaml", ".yml"],
        maxResults=20)

    // IS-LOCK: process locks
    context.isolationGrep.processLocks = grepFiles(projectPath,
        patterns=[
            'flock',                       # flock syscall
            'lockfile',                    # lockfile module
            '\\.pid',                      # PID file
            'Lockfile',                    # Lockfile class
            'pidfile',                     # PID file path
            'createLock|acquireLock',      # lock creation
        ],
        extensions=[".js", ".ts", ".py", ".go", ".rs"],
        maxResults=20)

    // IS-USER-DIR: user directory access
    context.isolationGrep.userDirAccess = grepFiles(projectPath,
        patterns=[
            'os\\.homedir\\(\\)',          # Node.js homedir
            'process\\.env\\.HOME',        # HOME env
            'process\\.env\\.APPDATA',     # Windows APPDATA
            'XDG_CONFIG_HOME',            # XDG config
            'XDG_DATA_HOME',             # XDG data
            'expanduser',                 # Python pathlib
            'home_dir\\(\\)',             # Rust dirs crate
            'path\\.join.*homedir',       # path.join with homedir
        ],
        extensions=[".js", ".ts", ".py", ".go", ".rs"],
        maxResults=20)

    // 5. Git context
    context.gitStatus = exec("git status --porcelain")
    context.gitRemote = exec("git remote -v")
    context.gitBranch = exec("git branch --show-current")

    return context
```

---

## 7. Solution B: Rule-based Validator

适用于本地执行环境，通过文件系统操作和命令执行进行精确验证。

### 7.1 架构

```
agentdock validate <project-path> [--format json|md] [--output report.json]
    │
    ├─→ Phase 1: Environment         (shell commands)
    ├─→ Phase 2: Config              (YAML parse + Zod schema)
    ├─→ Phase 3: Project Structure   (filesystem checks)
    ├─→ Phase 4: Port/Network        (grep + static analysis)
    ├─→ Phase 5: Worktree Compat     (grep + static analysis)
    ├─→ Phase 6: Build/Runtime       (filesystem + optional exec)
    ├─→ Phase 7: Session Isolation   (grep + AST analysis)  🆕
    │
    └─→ Verdict + Report
```

### 7.2 Check Implementation (Phase 1-6)

与 v0.1 相同，此处不再重复。详见 [validator-v0.1.md §7.2](validator-v0.1.md)。

### 7.3 Check Implementation (Phase 7 — Session Isolation) 🆕

```
┌─────────────────────────────────────────────────────────────────────┐
│ PHASE 7: SESSION ISOLATION CHECK IMPLEMENTATION                     │
├──────────┬──────────────────────────────────────────────────────────┤
│ Check ID │ Implementation                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-DB    │                                                          │
│          │ Step 1: Detect DB technology                             │
│          │   grep src/ for: sqlite3, better-sqlite3, sqlalchemy,   │
│          │   prisma, drizzle, sqlx::Sqlite, go-sqlite3             │
│          │                                                          │
│          │ Step 2: Check connection string                          │
│          │   - Find DB file path in source code                    │
│          │   - Check if path is relative (OK) or absolute (FAIL)   │
│          │   - Check if reads from env var (OK) or hardcoded (FAIL)│
│          │                                                          │
│          │ Step 3: Check docker-compose for DB services             │
│          │   - postgres, mysql, mongo with fixed volume names      │
│          │   → Flag as IS-DB + IS-DOCKER-VOL                       │
│          │                                                          │
│          │ PASS: DB path is relative/env-var AND no fixed volume   │
│          │ FAIL: DB path is absolute OR env not configurable       │
│          │                                                          │
│          │ Isolation: L1 (Data Corruption)                         │
│          │ Risk: BLOCKER                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-CACHE │                                                          │
│          │ grep src/ for:                                           │
│          │   - os.homedir() + cache path                           │
│          │   - /tmp/ or $TMPDIR + app name                         │
│          │   - ~/.cache/ references                                │
│          │                                                          │
│          │ PASS: Cache dir is project-local (./.cache)             │
│          │ WARN: Cache dir uses global path                        │
│          │                                                          │
│          │ Isolation: L3 (State Staleness)                         │
│          │ Risk: WARNING                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-UPLOAD│                                                          │
│          │ Step 1: Detect upload middleware                         │
│          │   grep for: multer, busboy, express-fileupload,         │
│          │   flask-upload, Django MEDIA_ROOT                       │
│          │                                                          │
│          │ Step 2: Check upload path                                │
│          │   - Find configured upload destination                  │
│          │   - Is it relative (OK) or absolute (WARN)?             │
│          │   - Is it configurable via env (OK)?                    │
│          │                                                          │
│          │ Step 3: Check if uploads/ is in .gitignore              │
│          │   - In gitignore = runtime-only data (OK)               │
│          │   - Not in gitignore = committed data (WARN)            │
│          │                                                          │
│          │ PASS: Upload path is relative/env-var + in .gitignore   │
│          │ FAIL: Upload path is hardcoded absolute path            │
│          │                                                          │
│          │ Isolation: L2 (Data Conflict)                           │
│          │ Risk: FAIL                                              │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-      │                                                          │
│ CONFIG-  │ grep src/ for:                                           │
│ DIR      │   - os.homedir() + .config/                             │
│          │   - XDG_CONFIG_HOME references                          │
│          │   - process.env.APPDATA                                 │
│          │                                                          │
│          │ PASS: No user-level config dir access                   │
│          │ WARN: Reads/writes ~/.config/{appname}                  │
│          │                                                          │
│          │ Isolation: L3 (State Staleness)                         │
│          │ Risk: WARNING                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-      │                                                          │
│ DOCKER-  │ Check 1: docker-compose.yml / compose.yml               │
│ NAME     │   grep for: container_name:                              │
│          │   - Found with fixed string → FAIL                      │
│          │   - Found with ${} template → PASS                      │
│          │   - Not found → PASS                                    │
│          │                                                          │
│          │ Check 2: Dockerfile / startup scripts                    │
│          │   grep for: docker run --name {fixed}                   │
│          │   - Found → FAIL                                        │
│          │   - Not found → PASS                                    │
│          │                                                          │
│          │ Isolation: L0 (Hard Block)                              │
│          │ Risk: BLOCKER                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-      │                                                          │
│ DOCKER-  │ Check 1: docker-compose.yml                              │
│ NET      │   grep for: networks: section with external: true       │
│          │   + fixed name: (not using ${COMPOSE_PROJECT_NAME})     │
│          │                                                          │
│          │ Check 2: Source code                                     │
│          │   grep for: Docker network name references              │
│          │                                                          │
│          │ PASS: No fixed external network OR uses dynamic name    │
│          │ WARN: Fixed external network name                       │
│          │                                                          │
│          │ Isolation: L3 (State Staleness)                         │
│          │ Risk: WARNING                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-      │                                                          │
│ DOCKER-  │ Step 1: Parse docker-compose.yml volumes section         │
│ VOL      │   Find named volumes (not bind mounts)                  │
│          │                                                          │
│          │ Step 2: Check naming pattern                             │
│          │   - Fixed name (db-data) → FAIL                         │
│          │   - Uses ${COMPOSE_PROJECT_NAME} prefix → PASS          │
│          │   - Bind mount (./path) → PASS                          │
│          │                                                          │
│          │ Step 3: Check service volume mounts                      │
│          │   - Named volume references → flag as shared            │
│          │   - Bind mount to project dir → OK (Worktree isolated)  │
│          │                                                          │
│          │ PASS: All volumes are bind mounts or dynamic-named      │
│          │ FAIL: Named volumes with fixed names                    │
│          │                                                          │
│          │ Isolation: L1 (Data Corruption)                         │
│          │ Risk: BLOCKER                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-PORT  │ Step 1: grep src/ for hardcoded port patterns           │
│          │   (same as NET-PORT-CONFIG but with BLOCKER risk)       │
│          │                                                          │
│          │ Step 2: Check docker-compose port mapping                │
│          │   - "3000:3000" → FAIL (host port hardcoded)            │
│          │   - "${PORT}:3000" → PASS (container port can stay)    │
│          │                                                          │
│          │ Step 3: Check for multiple services with same port      │
│          │   - If docker-compose has 2+ services with same host    │
│          │     port → FAIL                                         │
│          │                                                          │
│          │ PASS: All ports via env vars                            │
│          │ FAIL: Any hardcoded port in source or compose           │
│          │                                                          │
│          │ Isolation: L0 (Hard Block)                              │
│          │ Risk: BLOCKER                                           │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-USER- │                                                          │
│ DIR      │ grep src/ for:                                           │
│          │   - path.join(os.homedir(), ...)  ← absolute subdir    │
│          │   - process.env.HOME + hardcoded subdir                 │
│          │   - process.env.APPDATA + app name                      │
│          │                                                          │
│          │ Exclude:                                                 │
│          │   - XDG_*_HOME env var reads (configurable)             │
│          │   - os.tmpdir() (session-local is OK)                   │
│          │                                                          │
│          │ PASS: No user dir writes OR uses XDG vars              │
│          │ FAIL: Hardcoded user dir writes                         │
│          │                                                          │
│          │ Isolation: L2 (Data Conflict)                           │
│          │ Risk: FAIL                                              │
├──────────┼──────────────────────────────────────────────────────────┤
│ IS-LOCK  │                                                          │
│          │ grep src/ for:                                           │
│          │   - flock(                                              │
│          │   - lockfile / Lockfile                                  │
│          │   - .pid / pidfile                                       │
│          │   - createLock / acquireLock                            │
│          │   - createServer().listen() with exclusive flag         │
│          │                                                          │
│          │ For each match:                                          │
│          │   - Extract lock file path                               │
│          │   - Is path relative (OK) or absolute (FAIL)?           │
│          │   - Is path configurable via env (OK)?                  │
│          │   - Is it in project dir (OK) or /tmp/ / /var/run/ (FAIL)? │
│          │                                                          │
│          │ PASS: Lock path is relative/local + configurable        │
│          │ FAIL: Lock path is absolute global (/var/run, /tmp)     │
│          │                                                          │
│          │ Isolation: L0 (Hard Block)                              │
│          │ Risk: BLOCKER                                           │
└──────────┴──────────────────────────────────────────────────────────┘
```

### 7.4 Grep Patterns for Phase 7

```yaml
isolation_patterns:
  IS-DB:
    detect:
      - 'sqlite3?\.connect'           # Python
      - 'better-sqlite3'              # Node
      - 'new Database\('              # better-sqlite3
      - 'DATABASE_URL'                # env reference
      - 'data_source'                 # SQLAlchemy
      - 'sqlx::Sqlite'               # Rust
      - 'go-sqlite3'                 # Go
      - 'prisma.*datasource'         # Prisma
    pathCheck:
      - pattern: '(?:file:|")((?:\/|[A-Z]:\\).+\.db)'  # absolute DB path
        status: FAIL
      - pattern: '(?:file:|")(\.\/.+\.db)'              # relative DB path
        status: PASS
      - pattern: 'process\.env\.(?:DATABASE_URL|DB_PATH)'  # env var
        status: PASS

  IS-CACHE:
    detect:
      - 'os\.homedir\(\).*cache'
      - '~\/\.cache\/'
      - '/tmp\/.*cache'
      - 'CACHE_DIR.*=.*\/'
    exclude: 'CACHE_DIR.*=.*\.\.'  # relative is OK

  IS-UPLOAD:
    detect:
      - 'multer|busboy|express-fileupload'  # Node
      - 'flask.upload|UploadSet'           # Python
      - 'MEDIA_ROOT|FILE_UPLOAD_DIR'       # Django
    pathCheck:
      - pattern: 'uploads.*=.*["\']\/'     # absolute path
        status: FAIL
      - pattern: 'uploads.*=.*["\']\.\.?\/'  # relative
        status: PASS

  IS-CONFIG-DIR:
    detect:
      - 'os\.homedir\(\).*\.config'
      - 'XDG_CONFIG_HOME'
      - 'process\.env\.APPDATA'
      - 'path\.join.*homedir.*config'

  IS-DOCKER-NAME:
    detect:
      - 'container_name\s*:'
      - 'docker\s+run.*--name\s+[a-zA-Z]'
    pathCheck:
      - pattern: 'container_name\s*:\s*\$\{'
        status: PASS   # dynamic name
      - pattern: 'container_name\s*:\s*[a-zA-Z]'
        status: FAIL   # fixed name

  IS-DOCKER-NET:
    detect:
      - 'external:\s*true'
      - 'name:\s*[a-zA-Z_-]+\s*#.*network'
    pathCheck:
      - pattern: 'name:\s*\$\{COMPOSE_PROJECT_NAME'
        status: PASS
      - pattern: 'name:\s*[a-zA-Z]+\s*$'
        status: WARN

  IS-DOCKER-VOL:
    detect:
      - '^\s+volumes:\s*$'            # top-level volumes section
      - '^\s+- [a-zA-Z_-]+:'          # named volume reference
    pathCheck:
      - pattern: '- \./'              # bind mount
        status: PASS
      - pattern: '- [a-zA-Z_-]+:/'   # named volume
        status: FAIL
      - pattern: '\$\{COMPOSE_PROJECT_NAME'
        status: PASS

  IS-PORT:
    detect:
      - 'listen\(\s*\d{4,5}'          # listen(3000)
      - ':\s*\d{4,5}\s*[,)}]'         # :3000,
      - 'PORT\s*=\s*\d{4,5}'          # PORT=3000
      - '"port"\s*:\s*\d{4,5}'        # "port": 3000
      - '"\d{4,5}:\d{4,5}"'          # docker-compose "3000:3000"
    exclude:
      - 'process\.env\.'              # env var reads OK
      - '\$\{.*PORT'                  # template vars OK
      - '\d{4,5}:\$\{'               # docker-compose dynamic host port

  IS-USER-DIR:
    detect:
      - 'path\.join\(.*homedir'
      - 'os\.homedir\(\).*\/[a-z]'   # homedir + subdir
      - 'process\.env\.HOME.*\/'
      - 'process\.env\.APPDATA'
    exclude:
      - 'XDG_'                        # XDG vars are configurable
      - 'os\.tmpdir\(\)'             # tmp is session-local OK

  IS-LOCK:
    detect:
      - 'flock\('
      - 'lockfile|Lockfile'
      - '\.pid\b'
      - 'pidfile|PIDFile'
      - 'createLock|acquireLock|acquire_lock'
    pathCheck:
      - pattern: '(?:\/var\/run|\/tmp\/|\/run\/).*\.pid'
        status: FAIL   # global path
      - pattern: '\.\/.*\.lock'
        status: PASS   # local path
      - pattern: 'process\.env\..*LOCK'
        status: PASS   # configurable
```

### 7.5 Script Skeleton (Phase 7)

```bash
#!/usr/bin/env bash
# agentdock-validate.sh — Phase 7: Session Isolation
# Called after Phase 1-6

check_isolation() {
  local PROJECT_PATH="$1"
  local SRC_DIRS=("src" "lib" "app" "internal" "pkg" "cmd" ".")

  # ── IS-DB ──
  local db_hits=$(grep -rn --include="*.{js,ts,py,go,rs}" \
    -E 'sqlite3?\.connect|better-sqlite3|new Database\(|sqlx::Sqlite|go-sqlite3' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null | head -20)

  if [[ -n "$db_hits" ]]; then
    # Check if DB path is absolute
    local abs_path=$(echo "$db_hits" | grep -E '(file:|")((?:\/|[A-Z]:\\).+\.db)')
    local env_path=$(echo "$db_hits" | grep -E 'process\.env\.(DATABASE_URL|DB_PATH)')
    if [[ -n "$abs_path" && -z "$env_path" ]]; then
      check IS-DB FAIL BLOCKER "L1" "Database path is absolute: $abs_path" \
        "Use relative path or DATABASE_URL env var"
    else
      check IS-DB PASS BLOCKER "L1" "Database uses relative/env path"
    fi
  else
    check IS-DB PASS BLOCKER "L1" "No embedded database detected"
  fi

  # ── IS-DOCKER-NAME ──
  local compose_files=$(find "$PROJECT_PATH" -maxdepth 2 \
    \( -name "docker-compose.yml" -o -name "docker-compose.yaml" \
       -o -name "compose.yml" -o -name "compose.yaml" \) 2>/dev/null)

  if [[ -n "$compose_files" ]]; then
    local container_names=$(grep -n 'container_name:' $compose_files 2>/dev/null)
    if [[ -n "$container_names" ]]; then
      local fixed=$(echo "$container_names" | grep -v '\${')
      if [[ -n "$fixed" ]]; then
        check IS-DOCKER-NAME FAIL BLOCKER "L0" \
          "Fixed container_name: $(echo "$fixed" | head -1)" \
          "Remove container_name or use \${SESSION_ID} template"
      else
        check IS-DOCKER-NAME PASS BLOCKER "L0" "container_name uses dynamic template"
      fi
    else
      check IS-DOCKER-NAME PASS BLOCKER "L0" "No container_name configured"
    fi
  else
    check IS-DOCKER-NAME PASS BLOCKER "L0" "No Docker Compose files"
  fi

  # ── IS-DOCKER-VOL ──
  if [[ -n "$compose_files" ]]; then
    local named_vols=$(grep -E '^\s+- [a-zA-Z_-]+:' $compose_files 2>/dev/null)
    local bind_mounts=$(grep -E '^\s+- \./' $compose_files 2>/dev/null)
    local dynamic_vols=$(grep -E '\$\{COMPOSE_PROJECT_NAME' $compose_files 2>/dev/null)

    if [[ -n "$named_vols" && -z "$dynamic_vols" ]]; then
      check IS-DOCKER-VOL FAIL BLOCKER "L1" \
        "Fixed named volume: $(echo "$named_vols" | head -1)" \
        "Use bind mount or \${COMPOSE_PROJECT_NAME} prefix"
    else
      check IS-DOCKER-VOL PASS BLOCKER "L1" "No fixed named volumes"
    fi
  else
    check IS-DOCKER-VOL PASS BLOCKER "L1" "No Docker Compose files"
  fi

  # ── IS-PORT ──
  local port_hits=$(grep -rn --include="*.{js,ts,py,go,rs,yaml,yml}" \
    -E 'listen\(\s*[0-9]{4,5}|PORT\s*=\s*[0-9]{4,5}|"port"\s*:\s*[0-9]{4,5}' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null \
    | grep -v 'process\.env\.' \
    | grep -v '\$\{' \
    | head -10)

  if [[ -n "$port_hits" ]]; then
    check IS-PORT FAIL BLOCKER "L0" \
      "Hardcoded port: $(echo "$port_hits" | head -1)" \
      "Use process.env.PORT or \$PORT"
  else
    check IS-PORT PASS BLOCKER "L0" "Ports use environment variables"
  fi

  # ── IS-LOCK ──
  local lock_hits=$(grep -rn --include="*.{js,ts,py,go,rs}" \
    -E 'flock\(|lockfile|\.pid\b|pidfile|createLock|acquireLock' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null | head -10)

  if [[ -n "$lock_hits" ]]; then
    local global_lock=$(echo "$lock_hits" | grep -E '\/var\/run|\/tmp\/|\/run\/')
    if [[ -n "$global_lock" ]]; then
      check IS-LOCK FAIL BLOCKER "L0" \
        "Global lock path: $(echo "$global_lock" | head -1)" \
        "Use \$AGENTDOCK_WORKTREE_PATH/.lock instead"
    else
      check IS-LOCK PASS BLOCKER "L0" "Lock path is project-local"
    fi
  else
    check IS-LOCK PASS BLOCKER "L0" "No process lock detected"
  fi

  # ── IS-UPLOAD ──
  local upload_hits=$(grep -rn --include="*.{js,ts,py,yaml,yml}" \
    -E 'multer|busboy|express-fileupload|flask.upload|MEDIA_ROOT|FILE_UPLOAD' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null | head -10)

  if [[ -n "$upload_hits" ]]; then
    local upload_config=$(grep -rn --include="*.{js,ts,py}" \
      -E 'uploads.*=.*["\']\/|upload.*dir.*["\']\/' \
      "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null | head -5)
    if [[ -n "$upload_config" ]]; then
      check IS-UPLOAD FAIL FAIL "L2" \
        "Hardcoded upload path: $upload_config" \
        "Use UPLOAD_DIR env variable"
    else
      check IS-UPLOAD PASS FAIL "L2" "Upload path is configurable"
    fi
  else
    check IS-UPLOAD PASS FAIL "L2" "No upload middleware detected"
  fi

  # ── IS-CACHE ──
  local cache_hits=$(grep -rn --include="*.{js,ts,py,go,rs}" \
    -E 'homedir\(\).*cache|~\/\.cache|\/tmp\/.*cache|CACHE_DIR' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null \
    | grep -v 'CACHE_DIR.*=.*\.\.' \
    | head -5)

  if [[ -n "$cache_hits" ]]; then
    check IS-CACHE WARN WARNING "L3" \
      "Global cache dir: $(echo "$cache_hits" | head -1)" \
      "Use CACHE_DIR=./.cache"
  else
    check IS-CACHE PASS WARNING "L3" "Cache is project-local"
  fi

  # ── IS-CONFIG-DIR ──
  local config_dir_hits=$(grep -rn --include="*.{js,ts,py,go,rs}" \
    -E 'homedir\(\).*\.config|XDG_CONFIG_HOME|APPDATA' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null | head -5)

  if [[ -n "$config_dir_hits" ]]; then
    check IS-CONFIG-DIR WARN WARNING "L3" \
      "Global config dir: $(echo "$config_dir_hits" | head -1)" \
      "Support XDG_CONFIG_HOME env var"
  else
    check IS-CONFIG-DIR PASS WARNING "L3" "No global config dir access"
  fi

  # ── IS-USER-DIR ──
  local user_dir_hits=$(grep -rn --include="*.{js,ts,py,go,rs}" \
    -E 'homedir\(\).*\/[a-z]|process\.env\.HOME.*\/|process\.env\.APPDATA' \
    "$PROJECT_PATH"/${SRC_DIRS[@]} 2>/dev/null \
    | grep -v 'XDG_' \
    | head -5)

  if [[ -n "$user_dir_hits" ]]; then
    check IS-USER-DIR FAIL FAIL "L2" \
      "User dir write: $(echo "$user_dir_hits" | head -1)" \
      "Support XDG_DATA_HOME or make path configurable"
  else
    check IS-USER-DIR PASS FAIL "L2" "No user dir writes"
  fi

  # ── IS-DOCKER-NET ──
  if [[ -n "$compose_files" ]]; then
    local ext_net=$(grep -B2 -A2 'external:\s*true' $compose_files 2>/dev/null)
    if [[ -n "$ext_net" ]]; then
      local fixed_net=$(echo "$ext_net" | grep 'name:' | grep -v '\${COMPOSE_PROJECT_NAME')
      if [[ -n "$fixed_net" ]]; then
        check IS-DOCKER-NET WARN WARNING "L3" \
          "Fixed external network: $fixed_net" \
          "Use \${COMPOSE_PROJECT_NAME}_network"
      else
        check IS-DOCKER-NET PASS WARNING "L3" "Network uses dynamic name"
      fi
    else
      check IS-DOCKER-NET PASS WARNING "L3" "No external networks"
    fi
  else
    check IS-DOCKER-NET PASS WARNING "L3" "No Docker Compose files"
  fi
}
```

---

## 8. Prompt Engineering Notes

### 8.1 LLM 验证时的 Context Window 管理

| 项目规模 | 策略 | 预估 tokens |
|---------|------|-------------|
| < 50 文件 | 全量 file tree + 关键文件 + isolation grep 结果 | ~20k |
| 50-200 文件 | 深度 2 file tree + grep 结果 | ~25k |
| 200-1000 文件 | 深度 2 file tree + 采样 10 源文件 + isolation grep | ~30k |
| > 1000 文件 | 深度 1 file tree + 仅关键文件 + isolation grep | ~20k |

### 8.2 v0.2 新增的 LLM 输入要求

Phase 7 的 LLM 验证需要额外输入：

1. **Docker Compose 文件完整内容**（不仅是 grep 结果）
2. **Isolation-specific grep 结果**（6 个维度的 pattern match）
3. **数据库连接配置**（.env 中的 DATABASE_URL 等）
4. **源码中的路径操作**（path.join、os.homedir 等调用）

### 8.3 两种方案对比（v0.2 更新）

| 维度 | LLM Prompt | Rule-based |
|------|-----------|------------|
| **精度** | 中等（可推断语义） | 高（确定性 grep） |
| **速度** | 慢（API 调用） | 快（本地执行） |
| **Phase 7 精度** | 高（可理解 Docker Compose 上下文） | 中（pattern 匹配可能误报） |
| **误报率** | 低（LLM 理解意图） | 中（grep 无法区分注释和代码） |
| **覆盖率** | 高（可发现未预料的冲突模式） | 中（仅预定义 pattern） |
| **成本** | 每次消耗 tokens | 无额外成本 |
| **可离线** | 否 | 是 |
| **推荐场景** | 评估第三方仓库、CI 集成 | 本地开发、自动化流水线 |

### 8.4 推荐用法

```
┌──────────────────────────────────────────────────────────────┐
│  开发阶段                                                    │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │ Rule-based   │───→│ 快速本地验证                      │    │
│  │ Phase 1-6    │    │ 每次 save / commit                │    │
│  └─────────────┘    └──────────────────────────────────┘    │
│                                                               │
│  Session 隔离评估                                             │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │ Rule-based   │───→│ Phase 7: 自动检测隔离冲突         │    │
│  │ Phase 7      │    │ 首次接入 AgentDock 时运行         │    │
│  └─────────────┘    └──────────────────────────────────┘    │
│                                                               │
│  深度评估（第三方仓库）                                       │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │ LLM Prompt   │───→│ 全量分析 + 语义理解               │    │
│  │ All Phases   │    │ 评估可并行性                      │    │
│  └─────────────┘    └──────────────────────────────────┘    │
│                                                               │
│  CI 阶段                                                     │
│  ┌─────────────┐    ┌──────────────────────────────────┐    │
│  │ Rule-based   │───→│ 自动化门禁                        │    │
│  │ + LLM (可选) │    │ PR check / merge gate             │    │
│  └─────────────┘    └──────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 9. Auto-fix Suggestions

### v0.1 已有

| Check | Auto-fix Action |
|-------|----------------|
| `CFG-EXISTS` | 创建 `agentdock.config.yaml`（空配置） |
| `CFG-VERSION` | 添加 `version: "1"` |
| `CFG-RESOURCE-PATH` | 移除 `..` 路径并警告 |
| `CFG-RESOURCE-UNIQUE` | 去重，保留最后出现的声明 |
| `PROJ-ENV-FILE` | 从 `.env.example` 复制为 `.env` |
| `PROJ-NODE_MODULES` | 执行检测到的包管理器 install 命令 |

### v0.2 新增

| Check | Auto-fix Action |
|-------|----------------|
| `IS-DB` | 在 `.env` 中添加 `DATABASE_URL=file:./dev.db` |
| `IS-PORT` | 在源码入口处添加 `const PORT = process.env.PORT \|\| <原端口>` 提示 |
| `IS-DOCKER-NAME` | 在 `docker-compose.yml` 中注释掉 `container_name` 行 |
| `IS-DOCKER-VOL` | 将 named volume 改为 `./data:/var/lib/...` bind mount |
| `IS-DOCKER-NET` | 将固定网络名改为 `${COMPOSE_PROJECT_NAME}_network` |
| `IS-USER-DIR` | 在 `.env` 中添加 `XDG_DATA_HOME=$AGENTDOCK_WORKTREE_PATH/.data` |

**不可自动修复的 BLOCKER：**

| Check | 原因 |
|-------|------|
| `ENV-GIT` | 需要决定初始化策略 |
| `ENV-PERMISSIONS` | 需要系统级权限变更 |
| `CFG-YAML` | 需要理解业务意图 |
| `CFG-SCHEMA` | 需要理解配置语义 |
| `CFG-HOOK-EVENT` | 需要理解项目生命周期 |
| `CFG-HOOK-RUN` | 需要知道正确的启动命令 |
| `PROJ-ENTRY` | 需要理解项目结构 |
| `IS-LOCK`（全局锁） | 需要理解锁的业务必要性 |

---

## 10. Verdict Decision Tree

```
START
  │
  ├─ Phase 1 BLOCKER 失败?
  │   ├─ YES → Not Compatible
  │   └─ NO  ↓
  │
  ├─ Phase 2 BLOCKER 失败?
  │   ├─ YES → Not Compatible (列出可修复项)
  │   └─ NO  ↓
  │
  ├─ Phase 3 BLOCKER 失败?
  │   ├─ YES → Not Compatible
  │   └─ NO  ↓
  │
  ├─ Phase 7: Isolation Level?
  │   ├─ L0/L1 (不可修复) → Not Compatible
  │   ├─ L0/L1 (可修复)   → Partially Compatible
  │   ├─ L2               → Partially Compatible
  │   ├─ L3               → WARNING 聚合
  │   └─ L4 / 无冲突      ↓
  │
  ├─ 总 BLOCKER 数 > 0 (Phase 1-6)?
  │   ├─ YES → Not Compatible
  │   └─ NO  ↓
  │
  ├─ 总 FAIL 数 > 0?
  │   ├─ YES → Partially Compatible
  │   └─ NO  ↓
  │
  ├─ 总 WARN 数 ≥ 3?
  │   ├─ YES → Partially Compatible
  │   └─ NO  ↓
  │
  └─ Compatible
```

---

## Appendix A: Grep Pattern Quick Reference

```yaml
# Phase 7 快速参考 — 每个 IS 检查的核心 grep pattern

IS-DB:
  - 'sqlite3?\.connect|better-sqlite3|new Database\(|DATABASE_URL|sqlx::Sqlite'

IS-CACHE:
  - 'homedir\(\).*cache|~\/\.cache|\/tmp\/.*cache'

IS-UPLOAD:
  - 'multer|busboy|express-fileupload|flask.upload|MEDIA_ROOT'

IS-CONFIG-DIR:
  - 'homedir\(\).*\.config|XDG_CONFIG_HOME|APPDATA'

IS-DOCKER-NAME:
  - 'container_name\s*:|docker.*run.*--name'

IS-DOCKER-NET:
  - 'external:\s*true'

IS-DOCKER-VOL:
  - '^\s+- [a-zA-Z_-]+:/'  # named volume reference

IS-PORT:
  - 'listen\(\s*[0-9]{4,5}|PORT\s*=\s*[0-9]{4,5}|"port"\s*:\s*[0-9]{4,5}'

IS-USER-DIR:
  - 'homedir\(\).*\/[a-z]|process\.env\.HOME.*\/|APPDATA'

IS-LOCK:
  - 'flock\(|lockfile|\.pid\b|pidfile|createLock|acquireLock'
```

## Appendix B: v0.1 → v0.2 Migration

| v0.1 | v0.2 变化 |
|------|----------|
| 30 checks / 6 phases | **40 checks / 7 phases** (+10 isolation checks) |
| Verdict: MUST-only | Verdict: MUST + **Isolation Level** |
| Risk: BLOCKER/WARN/INFO | Risk: BLOCKER/**FAIL**/WARN/INFO |
| Scoring: flat penalties | Scoring: **isolation-weighted penalties** |
| LLM prompt: v0.1 spec | LLM prompt: **v0.2 spec + isolation patterns** |
| Output: no isolation data | Output: **`isolation` field** with L0-L4 |
