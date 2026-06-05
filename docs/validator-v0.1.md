# AgentDock Compatibility Validator v0.1

> 给定任意 Git 仓库，判断其与 AgentDock 的兼容等级。  
> 本文档定义检查清单、两种验证方案（LLM Prompt / Rule-based）、输出格式。

---

## 1. Verdict 定义

| Verdict | 含义 | 判定规则 |
|---------|------|---------|
| **Compatible** | 所有 MUST 检查通过 + 无 BLOCKER 风险 | MUST 全通过，SHOULD 通过 ≥ 4/6 |
| **Partially Compatible** | 核心功能可用但受限 | MUST 全通过但 SHOULD 通过 < 4/6，或 MUST 有 1 项可修复 |
| **Not Compatible** | 无法被 AgentDock 管理 | MUST 有 ≥ 1 项不可修复的失败 |

---

## 2. Check Registry

所有检查项按执行顺序排列。每项包含：

- **ID**：唯一标识
- **Phase**：所属阶段（详见 §3）
- **Risk**：BLOCKER / WARNING / INFO
- **Spec Ref**：对应 ADS v0.1 规范章节
- **Fix**：修复建议（不可修复时标注 `unfixable`）

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
| 6 | `CFG-EXISTS` | 配置文件存在 | INFO | M3 | `agentdock.config.yaml` 存在 | 创建空配置文件（见 §7） |
| 7 | `CFG-YAML` | YAML 语法有效 | BLOCKER | 4.4 | 文件可被 YAML parser 解析 | 检查 YAML 语法 |
| 8 | `CFG-SCHEMA` | Schema 校验通过 | BLOCKER | 4.4 | 符合 `AgentDockConfigSchema` | 修正字段（见 §7） |
| 9 | `CFG-VERSION` | 版本字段 | WARNING | — | `version` 字段存在且为 `"1"` | 添加 `version: "1"` |
| 10 | `CFG-RESOURCE-PATH` | 资源路径无逃逸 | BLOCKER | 4.3 | 所有 `source` 不含 `..` | 修正路径 |
| 11 | `CFG-RESOURCE-UNIQUE` | 资源声明无重复 | WARNING | 4.3 | 同一 `source` 未出现两次 | 合并或删除重复项 |
| 12 | `CFG-HOOK-EVENT` | Hook 事件名合法 | BLOCKER | 4.5 | 所有 key 属于已知事件列表 | 修正事件名 |
| 13 | `CFG-HOOK-RUN` | Hook run 非空 | BLOCKER | 4.5 | 每个 Hook 的 `run` 字段非空字符串 | 填写命令 |
| 14 | `CFG-HOOK-TIMEOUT` | Hook timeout 合理 | WARNING | 4.5 | `timeout` > 0 且 ≤ 600000（10 min） | 调整 timeout |

### Phase 3 — Project Structure（项目结构检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 15 | `PROJ-ENTRY` | 入口文件/命令可识别 | BLOCKER | M5 | 存在 `package.json`（含 scripts）、`Cargo.toml`、`go.mod`、`pyproject.toml`、`Makefile`、`Dockerfile` 或 `*.py`/`*.js`/`*.ts` 入口 | 添加入口文件或声明启动命令 |
| 16 | `PROJ-DEPS-MANAGER` | 包管理器可识别 | WARNING | S4 | 存在 `package.json`/`requirements.txt`/`Cargo.toml`/`go.mod`/`pyproject.toml` | 添加依赖描述文件 |
| 17 | `PROJ-LOCK-FILE` | 锁文件存在 | WARNING | S2 | 存在 `package-lock.json` / `yarn.lock` / `pnpm-lock.yaml` / `poetry.lock` / `Cargo.lock` / `go.sum` | 运行安装命令生成锁文件 |
| 18 | `PROJ-ENV-FILE` | `.env` 文件存在 | INFO | S1 | `.env` 或 `.env.example` 存在 | 创建 `.env` |
| 19 | `PROJ-ENV-TEMPLATE` | `.env.example` 存在 | INFO | — | `.env.example` / `.env.template` 存在 | 创建 `.env.example` |
| 20 | `PROJ-NODE_MODULES` | 依赖目录存在 | WARNING | — | `node_modules` / `venv` / `.venv` / `target` 存在 | 运行安装命令 |

### Phase 4 — Port & Network（端口与网络检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 21 | `NET-PORT-CONFIG` | 端口可通过环境变量配置 | WARNING | S3 | 源码中 `PORT` 不被硬编码（grep 检测） | 改用 `process.env.PORT` 或 `$PORT` |
| 22 | `NET-PORT-RANGE` | 默认端口在可用范围 | INFO | 4.6 | 默认端口在 20000-65535 范围内 | 无需修复（AgentDock 自动分配） |
| 23 | `NET-WS` | WebSocket 使用检测 | INFO | Y4 | 检测 `ws`/`socket.io`/`WebSocket` 依赖 | 无需修复（自动分配 WS_PORT） |
| 24 | `NET-DEBUG` | 调试端口检测 | INFO | Y5 | 检测 `--inspect`/`--debug` 配置 | 无需修复（自动分配 DEBUG_PORT） |

### Phase 5 — Worktree Compatibility（Worktree 兼容性检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 25 | `WT-DIRNAME` | `__dirname` 使用风险 | WARNING | S5 | 源码中无 `__dirname` 或已通过 `fileURLToPath` 适配 | 改用相对路径或 `import.meta.url` |
| 26 | `WT-HARDCODED-PATH` | 硬编码绝对路径检测 | WARNING | S5 | 源码中无硬编码的项目绝对路径 | 改用 `process.cwd()` 或环境变量 |
| 27 | `WT-SYMLINK` | 符号链接依赖 | WARNING | — | 项目不依赖 `node_modules` 中的 symlink | 改为 npm link 后重建 |
| 28 | `WT-GITMODULES` | Git submodule 检测 | WARNING | — | 无 `.gitmodules`，或 submodule 已初始化 | `git submodule update --init` |

### Phase 6 — Build & Runtime（构建与运行时检查）

| # | Check ID | 检查项 | Risk | Spec | 通过条件 | Fix |
|---|----------|--------|------|------|---------|-----|
| 29 | `BUILD-SCRIPT` | 构建脚本可识别 | INFO | M2 | `package.json` 中有 `build`/`start`/`dev` script | 添加 script |
| 30 | `BUILD-TYPECHECK` | 类型检查通过 | INFO | SHOULD | `tsc --noEmit` 无错误（TypeScript 项目） | 修复类型错误 |

---

## 3. Execution Phases

检查按阶段顺序执行。前一阶段的 BLOCKER 失败会提前终止后续阶段。

```
Phase 1: Environment        ──── BLOCKER? → 快速失败
    │
Phase 2: Config             ──── BLOCKER? → 快速失败
    │
Phase 3: Project Structure  ──── BLOCKER? → 快速失败
    │
Phase 4: Port & Network     ──── 收集 INFO，不阻塞
    │
Phase 5: Worktree Compat    ──── WARNING 聚合
    │
Phase 6: Build & Runtime    ──── 收集 INFO，不阻塞
    │
    └─→ Verdict 汇总
```

**Early Termination 规则：**

- Phase 1 `ENV-GIT` 失败 → 终止，报告 `Not Compatible`
- Phase 2 `CFG-SCHEMA` 失败 → 终止，报告 `Not Compatible`（除非修复后可通过）
- 其他 BLOCKER → 继续执行但标记为 `Not Compatible`，收集所有 BLOCKER 后统一报告

---

## 4. Risk Level 定义

| Level | 含义 | 对 Verdict 的影响 |
|-------|------|------------------|
| **BLOCKER** | 项目无法被 AgentDock 管理 | 任一 BLOCKER 失败 → `Not Compatible`（可修复时降为 `Partially Compatible`） |
| **WARNING** | 功能受限或行为不符合预期 | 聚合计算：WARNING 数量 ≥ 3 且 MUST 无失败 → `Partially Compatible` |
| **INFO** | 信息性提示，不影响兼容性 | 不影响 Verdict，仅用于报告 |

---

## 5. Output Format

### 5.1 Machine-readable (JSON)

```json
{
  "version": "0.1",
  "repo": "/path/to/project",
  "verdict": "Partially Compatible",
  "score": 78,
  "phases": [
    {
      "name": "Environment",
      "checks": [
        {
          "id": "ENV-GIT",
          "status": "PASS",
          "risk": "BLOCKER",
          "message": "Git repository detected",
          "fix": null
        },
        {
          "id": "ENV-GIT-CLEAN",
          "status": "WARN",
          "risk": "WARNING",
          "message": "3 uncommitted changes in working tree",
          "fix": "git stash or git add"
        }
      ]
    }
  ],
  "summary": {
    "total": 30,
    "pass": 24,
    "warn": 5,
    "fail": 0,
    "info": 1,
    "blockers": 0,
    "fixable": 0
  }
}
```

### 5.2 Human-readable (Markdown)

```markdown
## AgentDock Compatibility Report

**Repository:** `/path/to/project`  
**Verdict:** ⚠️ Partially Compatible (Score: 78/100)

### ❌ Blockers
> 无

### ⚠️ Warnings (5)

| Check | Message | Fix |
|-------|---------|-----|
| ENV-GIT-CLEAN | 3 uncommitted changes | `git stash` |
| PROJ-LOCK-FILE | No lock file found | Run install to generate |
| NET-PORT-CONFIG | Port hardcoded in source | Use `process.env.PORT` |
| WT-DIRNAME | `__dirname` used in 3 files | Use `import.meta.url` |
| PROJ-NODE_MODULES | node_modules not found | `npm install` |

### ℹ️ Info (1)

| Check | Message |
|-------|---------|
| ENV-GIT-REMOTE | No remote configured |

### Score Breakdown

| Phase | Pass | Warn | Fail |
|-------|------|------|------|
| Environment | 3/5 | 2 | 0 |
| Config | 9/9 | 0 | 0 |
| Project Structure | 3/6 | 2 | 0 |
| Port & Network | 3/4 | 1 | 0 |
| Worktree Compat | 2/4 | 2 | 0 |
| Build & Runtime | 1/2 | 0 | 0 |
```

### 5.3 Scoring Formula

```
Score = (passed_checks / total_checks) × 100

weighted:
  BLOCKER  × 10  (失败时扣 10 分)
  WARNING  × 3   (失败时扣 3 分)
  INFO     × 1   (失败时扣 1 分)

Score = max(0, 100 - Σ(penalties))
```

---

## 6. Solution A: LLM Prompt Validator

适用于没有本地执行环境的场景，由 LLM 基于仓库内容进行静态分析。

### 6.1 System Prompt

```text
You are an AgentDock Compatibility Validator. Your task is to evaluate
whether a Git repository is compatible with AgentDock v0.1.

AGENTDOCK SPECIFICATION (ADS v0.1):
{spec: docs/ads-v0.1.md — 见下方完整规范摘要}

YOU WILL RECEIVE:
1. Repository file tree (directory listing)
2. Key file contents (package.json, config files, source snippets)
3. Git status output

YOUR TASK:
Evaluate the repository against the ADS v0.1 check registry and output
a structured validation report.

CHECK REGISTRY (ordered by execution phase):
{check_registry: 见本文 §2}

OUTPUT FORMAT:
Return exactly one JSON object matching the schema:
{
  "verdict": "Compatible" | "Partially Compatible" | "Not Compatible",
  "score": <0-100>,
  "phases": [
    {
      "name": "<phase_name>",
      "checks": [
        {
          "id": "<CHECK_ID>",
          "status": "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP",
          "risk": "BLOCKER" | "WARNING" | "INFO",
          "message": "<human readable explanation>",
          "fix": "<actionable fix or null>"
        }
      ]
    }
  ],
  "summary": {
    "total": <int>,
    "pass": <int>,
    "warn": <int>,
    "fail": <int>,
    "blockers": <int>
  }
}

RULES:
- Do NOT fabricate file contents. If you cannot verify a check, mark it SKIP.
- For code-level checks (NET-PORT-CONFIG, WT-DIRNAME, WT-HARDCODED-PATH),
  analyze the actual source code provided.
- For runtime checks (BUILD-TYPECHECK, PROJ-DEPS-MANAGER), infer from
  file existence and config, do not attempt execution.
- Score = 100 - (blockers×10) - (fails×3) - (warns×1).
- Verdict rules:
  - Compatible: 0 blockers AND 0 fails AND warns < 3
  - Partially Compatible: 0 blockers AND (fails > 0 OR warns ≥ 3)
  - Not Compatible: blockers > 0
```

### 6.2 User Prompt Template

```text
Please validate the following repository for AgentDock compatibility.

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

### Git Status
```bash
{git_status_output}
```

### Git Remote
```bash
{git_remote_output}
```

## Instructions

Evaluate this repository against the AgentDock Compatibility Specification v0.1.
Output your report as JSON following the schema defined in your system prompt.

Focus especially on:
1. Whether the project has an entry point / start command
2. Whether source code uses __dirname or hardcoded paths (Worktree compatibility)
3. Whether ports are configurable via environment variables
4. Whether a .env file and lock file exist
5. Whether agentdock.config.yaml exists and is valid
```

### 6.3 Input Preparation Algorithm

```text
function prepareLLMInput(projectPath):
    context = {}

    // 1. File tree (depth 2, exclude hidden + node_modules)
    context.fileTree = listDir(projectPath, depth=2,
        exclude=[".git", "node_modules", ".venv", "dist", "build", ".agentdock"])

    // 2. Key files to read (priority order)
    candidates = [
        "package.json", "tsconfig.json", "vite.config.*",
        "pyproject.toml", "requirements.txt", "setup.py",
        "Cargo.toml", "go.mod", "Makefile", "Dockerfile",
        "agentdock.config.yaml", ".env", ".env.example",
        ".gitmodules"
    ]
    context.files = {}
    for each candidate:
        if exists(projectPath / candidate):
            context.files[candidate] = readFile(projectPath / candidate)

    // 3. Source code samples for code-level checks
    context.sourceFiles = grepFiles(projectPath,
        patterns=["__dirname", "process.env.PORT", "hardcoded paths",
                   "WebSocket", "socket.io", "--inspect", "--debug"],
        extensions=[".js", ".ts", ".jsx", ".tsx", ".py", ".go", ".rs"],
        maxResults=20)

    // 4. Git context
    context.gitStatus = exec("git status --porcelain")
    context.gitRemote = exec("git remote -v")
    context.gitBranch = exec("git branch --show-current")

    return context
```

### 6.4 LLM 方案的局限

| 局限 | 影响 | 缓解 |
|------|------|------|
| 无法执行命令 | PROJ-NODE_MODULES、BUILD-TYPECHECK 等需运行时判断 | 标记为 SKIP |
| 无法检测端口占用 | NET-PORT-RANGE 无法验证 | 标记为 SKIP |
| 源码上下文有限 | 大型项目无法分析全部代码 | 采样 + grep 模式匹配 |
| 幻觉风险 | 可能虚构文件内容 | 强制要求标注 SKIP |

---

## 7. Solution B: Rule-based Validator

适用于本地执行环境，通过文件系统操作和命令执行进行精确验证。

### 7.1 架构

```
agentdock validate <project-path> [--format json|markdown] [--output report.json]
    │
    ├─→ Phase 1: Environment    (shell commands)
    ├─→ Phase 2: Config         (YAML parse + Zod schema)
    ├─→ Phase 3: Project        (filesystem checks)
    ├─→ Phase 4: Port/Network   (grep + static analysis)
    ├─→ Phase 5: Worktree       (grep + static analysis)
    ├─→ Phase 6: Build/Runtime  (filesystem + optional exec)
    │
    └─→ Verdict + Report
```

### 7.2 Check Implementation

```text
┌─────────────────────────────────────────────────────────────────┐
│ CHECK IMPLEMENTATION MAP                                        │
├──────────┬──────────────────────────────────────────────────────┤
│ Check ID │ Implementation                                       │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 1  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ ENV-GIT  │ exec("git rev-parse --is-inside-work-tree")         │
│          │ exit 0 = PASS, else = FAIL                           │
├──────────┼──────────────────────────────────────────────────────┤
│ ENV-GIT- │ exec("git status --porcelain")                      │
│ CLEAN    │ output empty = PASS, else = WARN                     │
├──────────┼──────────────────────────────────────────────────────┤
│ GIT-     │ exec("git remote -v")                                │
│ REMOTE   │ output non-empty = PASS, else = INFO                 │
├──────────┼──────────────────────────────────────────────────────┤
│ ENV-     │ fs.access(projectPath, R_OK | W_OK)                  │
│ PERM     │ success = PASS, else = FAIL                          │
├──────────┼──────────────────────────────────────────────────────┤
│ ENV-DISK │ os.statfs(projectPath)                               │
│          │ free > 500MB = PASS, else = WARN                     │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 2  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ fs.existsSync("agentdock.config.yaml")              │
│ EXISTS   │ exists = PASS, else = INFO                           │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-YAML │ yaml.parse(content) — 无异常 = PASS                 │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ AgentDockConfigSchema.safeParse(parsed)              │
│ SCHEMA   │ success = PASS, else = FAIL (含错误详情)            │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ config.version === "1"                               │
│ VERSION  │ match = PASS, else = WARN                            │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ every resource.source: !source.includes("..")        │
│ RES-PATH │ all clean = PASS, else = FAIL                        │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ unique(sources).length === sources.length            │
│ RES-UNIQ │ unique = PASS, else = WARN                           │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ every key ∈ knownEvents                              │
│ HOOK-EVT │ all valid = PASS, else = FAIL                        │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ every hook.run is non-empty string                   │
│ HOOK-RUN │ all valid = PASS, else = FAIL                        │
├──────────┼──────────────────────────────────────────────────────┤
│ CFG-     │ every hook.timeout ∈ (0, 600000]                     │
│ HOOK-TMO │ all valid = PASS, else = WARN                        │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 3  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync(["package.json","Cargo.toml",             │
│ ENTRY    │   "go.mod","pyproject.toml","Makefile",              │
│          │   "Dockerfile"]) || hasEntrypoint(src)               │
│          │ found = PASS, else = FAIL                             │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync(["package.json","requirements.txt",      │
│ DEPS-MGR │   "Cargo.toml","go.mod","pyproject.toml"])           │
│          │ found = PASS, else = WARN                             │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync(["package-lock.json","yarn.lock",        │
│ LOCK     │   "pnpm-lock.yaml","poetry.lock",                    │
│          │   "Cargo.lock","go.sum"])                             │
│          │ found = PASS, else = WARN                             │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync([".env",".env.local",".env.development"]) │
│ ENV-FILE │ found = PASS, else = INFO                             │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync([".env.example",".env.template"])         │
│ ENV-TMPL │ found = PASS, else = INFO                             │
├──────────┼──────────────────────────────────────────────────────┤
│ PROJ-    │ existsSync(["node_modules","venv",".venv","target"]) │
│ NODE_MOD │ found = PASS, else = WARN                             │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 4  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ NET-     │ grep src/ for hardcoded PORT patterns                │
│ PORT-CFG │ (排除 env 读取模式)                                   │
│          │ no hardcode = PASS, else = WARN                       │
├──────────┼──────────────────────────────────────────────────────┤
│ NET-     │ parse package.json / config for default port          │
│ PORT-RNG │ port ∈ [20000,65535] = PASS, else = INFO             │
├──────────┼──────────────────────────────────────────────────────┤
│ NET-WS   │ grep src/ for ws|socket.io|WebSocket                 │
│          │ found = INFO (informational only)                     │
├──────────┼──────────────────────────────────────────────────────┤
│ NET-     │ grep src/ for --inspect|--debug                       │
│ DEBUG    │ found = INFO                                          │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 5  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ WT-      │ grep src/ for __dirname (排除 fileURLToPath 适配)     │
│ DIRNAME  │ no raw usage = PASS, else = WARN                      │
├──────────┼──────────────────────────────────────────────────────┤
│ WT-      │ grep src/ for hardcoded absolute paths               │
│ HARDCODE │ no hardcode = PASS, else = WARN                       │
├──────────┼──────────────────────────────────────────────────────┤
│ WT-      │ find symlinks in node_modules                         │
│ SYMLINK  │ no symlinks = PASS, else = WARN                       │
├──────────┼──────────────────────────────────────────────────────┤
│ WT-      │ existsSync(".gitmodules")                             │
│ GITMODS  │ no file = PASS, else WARN (check init status)        │
├──────────┼──────────────────────────────────────────────────────┤
│ Phase 6  │                                                      │
├──────────┼──────────────────────────────────────────────────────┤
│ BUILD-   │ package.json scripts has build/start/dev              │
│ SCRIPT   │ found = PASS, else = INFO                             │
├──────────┼──────────────────────────────────────────────────────┤
│ BUILD-   │ exec("npx tsc --noEmit") (if TS project)             │
│ TYPECHK  │ exit 0 = PASS, else = WARN (optional, slow)          │
└──────────┴──────────────────────────────────────────────────────┘
```

### 7.3 Grep Patterns

```yaml
patterns:
  NET-PORT-CONFIG:
    - regex: 'listen\(\s*\d{4,5}'          # listen(3000) — 硬编码
      exclude: 'listen\(\s*\w+\.'           # listen(process.env.PORT) — OK
    - regex: ':\s*\d{4,5}\s*[,)]'          # :3000, — 硬编码
      exclude: ':\s*\w+\.'

  WT-DIRNAME:
    - regex: '(?<!fileURLToPath.*)__dirname'  # 非适配模式的 __dirname
    - regex: 'require\(["\']path["\']\).*__dirname'

  WT-HARDCODED-PATH:
    - regex: '"/Users/|"/home/|"/C:\\\\|D:\\\\Projects'  # 常见硬编码路径
    - regex: "'\/[a-zA-Z]+\/[a-zA-Z]+\/[a-zA-Z]+"       # 绝对路径字面量

  NET-WS:
    - regex: 'WebSocket|socket\.io|require\(["\']ws["\']\)'

  NET-DEBUG:
    - regex: '--inspect|--debug-brk|--inspect-brk'
```

### 7.4 Script Skeleton

```bash
#!/usr/bin/env bash
# agentdock-validate.sh — Rule-based compatibility validator
# Usage: ./agentdock-validate.sh <project-path> [--format json|md]

set -euo pipefail

PROJECT_PATH="${1:-.}"
FORMAT="${2:---format json}"
RESULTS=()
SCORE=100

# --- Helpers ---
check() {
  local id="$1" status="$2" risk="$3" msg="$4" fix="${5:-null}"
  RESULTS+=("{\"id\":\"$id\",\"status\":\"$status\",\"risk\":\"$risk\",\"message\":\"$msg\",\"fix\":$fix}")
  case "$risk" in
    BLOCKER) [[ "$status" == "FAIL" ]] && SCORE=$((SCORE - 10)) ;;
    WARNING) [[ "$status" == "WARN" ]] && SCORE=$((SCORE - 3))  ;;
    INFO)    [[ "$status" == "FAIL" ]] && SCORE=$((SCORE - 1))  ;;
  esac
}

# --- Phase 1: Environment ---
if git -C "$PROJECT_PATH" rev-parse --is-inside-work-tree &>/dev/null; then
  check ENV-GIT PASS BLOCKER "Git repository detected"
else
  check ENV-GIT FAIL BLOCKER "Not a Git repository" "\"cd $PROJECT_PATH && git init\""
fi

# ... (剩余 Phase 实现类似)
```

---

## 8. Prompt Engineering Notes

### 8.1 LLM 验证时的 Context Window 管理

| 项目规模 | 策略 | 预估 tokens |
|---------|------|-------------|
| < 50 文件 | 全量 file tree + 关键文件内容 | ~15k |
| 50-200 文件 | 深度 2 file tree + grep 结果 | ~20k |
| 200-1000 文件 | 深度 2 file tree + 采样 10 源文件 | ~25k |
| > 1000 文件 | 深度 1 file tree + 仅关键文件 | ~15k |

### 8.2 两种方案对比

| 维度 | LLM Prompt | Rule-based |
|------|-----------|------------|
| **精度** | 中等（依赖模型能力） | 高（确定性检查） |
| **速度** | 慢（API 调用） | 快（本地执行） |
| **覆盖率** | 高（可推断隐含问题） | 中（仅预定义规则） |
| **成本** | 每次消耗 tokens | 无额外成本 |
| **可离线** | 否 | 是 |
| **可扩展** | 修改 prompt 即可 | 需修改代码 |
| **适用场景** | 评估第三方仓库、CI 集成 | 本地开发、自动化流水线 |

### 8.3 推荐用法

```
┌─────────────────────────────────────────────────┐
│  开发阶段                                       │
│  ┌─────────────┐    ┌──────────────────────┐    │
│  │ Rule-based   │───→│ 快速本地验证         │    │
│  │ Validator    │    │ 每次 save / commit   │    │
│  └─────────────┘    └──────────────────────┘    │
│                                                  │
│  评估阶段                                       │
│  ┌─────────────┐    ┌──────────────────────┐    │
│  │ LLM Prompt   │───→│ 深度分析 + 推断      │    │
│  │ Validator    │    │ 评估第三方仓库       │    │
│  └─────────────┘    └──────────────────────┘    │
│                                                  │
│  CI 阶段                                        │
│  ┌─────────────┐    ┌──────────────────────┐    │
│  │ Rule-based   │───→│ 自动化门禁           │    │
│  │ + LLM (可选) │    │ PR check / merge gate│    │
│  └─────────────┘    └──────────────────────┘    │
└─────────────────────────────────────────────────┘
```

---

## 9. Auto-fix Suggestions

以下场景可提供自动修复（`agentdock validate --fix`）：

| Check | Auto-fix Action |
|-------|----------------|
| `CFG-EXISTS` | 创建 `agentdock.config.yaml`（空配置） |
| `CFG-VERSION` | 添加 `version: "1"` |
| `CFG-RESOURCE-PATH` | 移除 `..` 路径并警告 |
| `CFG-RESOURCE-UNIQUE` | 去重，保留最后出现的声明 |
| `PROJ-ENV-FILE` | 从 `.env.example` 复制为 `.env` |
| `PROJ-NODE_MODULES` | 执行检测到的包管理器 install 命令 |

**不可自动修复的 BLOCKER（必须人工介入）：**

| Check | 原因 |
|-------|------|
| `ENV-GIT` | 需要决定初始化策略 |
| `ENV-PERMISSIONS` | 需要系统级权限变更 |
| `CFG-YAML` | 需要理解业务意图才能修复语法 |
| `CFG-SCHEMA` | 需要理解配置语义 |
| `CFG-HOOK-EVENT` | 需要理解项目生命周期 |
| `CFG-HOOK-RUN` | 需要知道正确的启动命令 |
| `PROJ-ENTRY` | 需要理解项目结构 |

---

## 10. Integration Examples

### 10.1 Git Pre-commit Hook

```bash
#!/bin/bash
# .git/hooks/pre-commit
agentdock validate . --format json | jq -e '.summary.blockers == 0' || {
  echo "❌ AgentDock compatibility check failed"
  exit 1
}
```

### 10.2 GitHub Actions

```yaml
- name: AgentDock Compatibility Check
  run: |
    npx agentdock-validate . --format json > report.json
    SCORE=$(jq '.score' report.json)
    if [ "$SCORE" -lt 70 ]; then
      echo "::error::AgentDock compatibility score $SCORE < 70"
      exit 1
    fi
```

### 10.3 VS Code Task

```json
{
  "label": "AgentDock Validate",
  "type": "shell",
  "command": "agentdock",
  "args": ["validate", "${workspaceFolder}", "--format", "markdown"],
  "problemMatcher": []
}
```

---

## Appendix A: Auto-generated Config Template

当 `CFG-EXISTS` 检测到配置文件缺失时，生成以下模板：

```yaml
# agentdock.config.yaml
# Generated by AgentDock Compatibility Validator v0.1
version: "1"

resources:
  sync:
    - source: .env
      strategy: overwrite
      skipIfMissing: true

hooks:
  afterCreateSession:
    # TODO: 添加项目安装命令
    # - run: "npm install"
    #   required: true
    #   timeout: 60000
```

## Appendix B: Verdict Decision Tree

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
  ├─ 总 BLOCKER 数 > 0?
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
