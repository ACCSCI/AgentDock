/**
 * Prompt template for converting a project to be "AgentDock Compatible".
 *
 * Copied to clipboard via the IconSidebar 📋 button.
 * Contains the full AgentDock Compatible Specification so any AI tool can
 * help convert a project — without needing access to docs/.
 * Does NOT include YAML config — users configure that in AgentDock directly.
 */

export const AGENTDOCK_COMPAT_PROMPT = `请将此项目改造为 "AgentDock Compatible" 项目。以下是完整的规范和改造指南。

---

## 背景

AgentDock 是一个会话管理系统，通过 Git Worktree 为每个 Session 提供隔离的开发环境，自动分配端口、同步资源、执行生命周期 Hook。要让一个项目被 AgentDock 高效管理，需要满足以下兼容性要求。

**核心设计目标：** 隔离性、可复现、零侵入、并行安全、工具无关、语言无关。

---

## 一、MUST 要求（必须全部满足）

| # | 要求 | 说明 |
|---|------|------|
| M1 | Git 仓库 | 项目根目录必须已执行 \`git init\` |
| M2 | 可构建运行 | 项目能在 Worktree 中通过安装依赖后启动 |
| M3 | 配置文件 | 项目根目录存在 \`agentdock.config.yaml\`（由用户在 AgentDock 中配置） |
| M4 | 文件可读写 | AgentDock 用户对项目目录有读写权限 |
| M5 | 明确入口 | 项目有启动命令或入口文件（如 \`npm start\`、\`python main.py\`） |

---

## 二、SHOULD 要求（强烈建议满足）

| # | 要求 | 说明 |
|---|------|------|
| S1 | 环境变量 | 使用 \`.env\` 文件管理配置，以便资源同步 |
| S2 | 锁文件 | 存在 \`package-lock.json\`、\`yarn.lock\`、\`poetry.lock\` 等 |
| S3 | 端口可配置 | 服务端口通过环境变量（如 \`PORT\`、\`BACKEND_PORT\`）而非硬编码 |
| S4 | 幂等安装 | install 命令可重复执行且结果一致 |
| S5 | Worktree 友好 | 不依赖 \`__dirname\` 定位资源（Worktree 路径与主仓库不同） |
| S6 | 非 GUI | 可无头运行（CLI / 服务端 / 后台任务） |
| S7 | 并行安全 | 多实例并行运行时不产生资源冲突 |

---

## 三、10 类 Session 隔离场景检查

AgentDock 通过 Git Worktree 提供源码级隔离，但数据库、缓存、容器、进程锁等资源不受 Worktree 保护。多 Session 并行时，以下场景可能导致冲突，请逐一检查并修复。

### 隔离等级说明

| Level | 含义 | 风险判定 |
|-------|------|---------|
| **L0 — Hard Block** | 两个 Session 物理上无法同时运行 | **BLOCKER — Not Compatible** |
| **L1 — Data Corruption** | 并行运行导致数据损坏且不可自动恢复 | **BLOCKER — Not Compatible** |
| **L2 — Data Conflict** | 并行运行导致数据不一致但可恢复 | **FAIL — Partially Compatible** |
| **L3 — State Staleness** | 并行运行导致状态过期但不影响正确性 | **WARN — 降级但不阻塞** |
| **L4 — No Conflict** | 天然安全，无需干预 | **PASS** |

**判定规则：** 项目隔离等级 = max(所有检测到的冲突场景的隔离等级)。L0/L1 = Not Compatible，L2 = Partially Compatible，L3 = 降级但不阻塞。

---

### IS-01: 共享数据库 ⚠️ L1 BLOCKER

**场景：** 多个 Session 连接同一数据库文件（SQLite、嵌入式 DB）。

**冲突机制：** Session A 写入 → Session B 读到脏数据 / 写入冲突 → DB 损坏。SQLite 无多实例写入保护。

**检测方法：**
\`\`\`bash
grep -rn "better-sqlite3\\|sqlalchemy\\|sqlite3.connect\\|DATABASE_URL" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**

JavaScript/TypeScript：
\`\`\`typescript
// ❌ 硬编码路径
const db = new Database('/var/data/app.db');

// ✅ 相对路径或环境变量
const dbPath = process.env.DATABASE_URL || 'file:./dev.db';
const db = new Database(dbPath);
\`\`\`

Python：
\`\`\`python
# ❌ 硬编码路径
engine = create_engine("sqlite:////var/data/app.db")

# ✅ 环境变量
import os
db_path = os.environ.get("DATABASE_URL", "sqlite:///./dev.db")
engine = create_engine(db_path)
\`\`\`

**Hook 方案：** 在 \`afterCreateSession\` 中为每个 Session 复制独立 DB：
\`\`\`
cp main.db $AGENTDOCK_WORKTREE_PATH/dev.db
\`\`\`

---

### IS-02: 共享缓存 🟡 L3 WARN

**场景：** 多个 Session 共享同一缓存目录（\`.cache/\`、\`__pycache__/\`、\`/.next/cache/\`）。

**冲突机制：** 并发写入缓存文件 → 缓存损坏 → 构建/运行异常（缓存可重建，仅影响性能或单次构建）。

**检测方法：**
\`\`\`bash
grep -rn "\\.cache\\|__pycache__\\|/tmp/.*cache" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**
\`\`\`typescript
// ✅ 使用项目本地缓存目录
const CACHE_DIR = process.env.CACHE_DIR || './.cache';
\`\`\`

\`\`\`python
# ✅ 设置环境变量限制缓存范围
CACHE_DIR = os.environ.get("CACHE_DIR", "./.cache")
\`\`\`

---

### IS-03: 共享上传目录 ⚠️ L2 FAIL

**场景：** 多个 Session 读写同一上传目录（\`uploads/\`、\`public/uploads/\`、\`media/\`）。

**冲突机制：** Session A 上传文件 X → Session B 删除 X → Session A 读取 404；或文件名冲突覆盖。

**检测方法：**
\`\`\`bash
grep -rn "uploads\\|multer\\|busboy\\|flask.upload" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**
\`\`\`typescript
// ❌ 硬编码上传路径
const UPLOAD_DIR = path.join(__dirname, 'uploads');

// ✅ 环境变量
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
\`\`\`

**Hook 方案：** 在 \`afterCreateSession\` 中同步初始数据：
\`\`\`
mkdir -p $AGENTDOCK_WORKTREE_PATH/uploads && cp -rn $AGENTDOCK_PROJECT_PATH/uploads/* $AGENTDOCK_WORKTREE_PATH/uploads/ 2>/dev/null
\`\`\`

---

### IS-04: 全局配置目录 🟡 L3 WARN

**场景：** 应用运行时读写用户级配置目录（\`~/.config/appname/\`、\`~/.appname/\`、\`%APPDATA%/appname/\`）。

**冲突机制：** Session A 修改配置 → Session B 读到 Session A 的配置 → 行为异常。

**检测方法：**
\`\`\`bash
grep -rn "os\\.homedir\\|process\\.env\\.HOME\\|process\\.env\\.APPDATA\\|XDG_CONFIG_HOME" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**
\`\`\`typescript
// ❌ 固定用户目录
const configDir = path.join(os.homedir(), '.myapp');

// ✅ 支持 XDG 重定向
const configDir = process.env.XDG_CONFIG_HOME
  || path.join(os.homedir(), '.config', 'myapp');
\`\`\`

**Hook 方案：** 在 Hook 中设置环境变量重定向：
\`\`\`
XDG_CONFIG_HOME=$AGENTDOCK_WORKTREE_PATH/.config
\`\`\`

---

### IS-05: 固定 Docker 容器名 🔴 L0 BLOCKER

**场景：** Docker Compose 或启动脚本中硬编码容器名称（\`container_name: myapp\`）。

**冲突机制：** Session A 启动容器 \`myapp\` → Session B 尝试启动同名容器 → **失败：容器名已占用**。

**检测方法：**
\`\`\`bash
grep -n "container_name" docker-compose.yml compose.yml 2>/dev/null
grep -rn "\\-\\-name " --include="*.sh" --include="*.yml" --include="*.yaml"
\`\`\`

**修复示例：**

docker-compose.yml：
\`\`\`yaml
# ❌ 固定容器名
services:
  app:
    container_name: myapp

# ✅ 移除 container_name（Docker 自动生成唯一名称）
services:
  app:
    # container_name 由 Docker Compose 自动用项目名前缀生成
\`\`\`

\`\`\`bash
# ✅ 或使用模板
container_name: \${PROJECT_NAME:-myapp}-\${SESSION_ID:-default}
\`\`\`

---

### IS-06: 固定 Docker 网络名 🟡 L3 WARN

**场景：** Docker Compose 中硬编码外部网络名（\`external: true, name: myapp-network\`）。

**冲突机制：** 多个 Session 使用同一网络 → 容器可互相通信 → 端口/服务发现冲突。

**检测方法：**
\`\`\`bash
grep -A2 "external:" docker-compose.yml compose.yml 2>/dev/null
\`\`\`

**修复示例：**
\`\`\`yaml
# ❌ 固定网络名
networks:
  app-network:
    external: true
    name: myapp-network

# ✅ 使用动态网络名（Docker Compose 自动用项目名前缀）
networks:
  app-network:
    # name 由 Docker Compose 自动设置为 {project}_app-network
\`\`\`

---

### IS-07: 固定 Docker Volume 🔴 L1 BLOCKER

**场景：** Docker Compose 中使用固定名称的 named volume（\`volumes: [db-data:/var/lib/postgresql/data]\`）。

**冲突机制：** Session A 和 Session B 共享同一 volume → 数据互相污染 → DB 损坏或状态不一致。

**检测方法：**
\`\`\`bash
grep -A5 "^volumes:" docker-compose.yml compose.yml 2>/dev/null
grep -rn "volumes:" --include="docker-compose.yml" --include="compose.yml"
\`\`\`

**修复示例：**
\`\`\`yaml
# ❌ 固定 named volume
services:
  db:
    volumes:
      - db-data:/var/lib/postgresql/data

# ✅ 使用 COMPOSE_PROJECT_NAME 自动前缀 volume 名
# 在 Hook 中设置：export COMPOSE_PROJECT_NAME=$AGENTDOCK_SESSION_ID
\`\`\`

**Hook 方案：** 在 \`beforeCreateSession\` 中设置项目名前缀：
\`\`\`
export COMPOSE_PROJECT_NAME=$AGENTDOCK_SESSION_ID
\`\`\`

---

### IS-08: 固定端口 🔴 L0 BLOCKER

**场景：** 源码或配置中硬编码端口号（\`listen(3000)\`、\`PORT=3000\`）。

**冲突机制：** Session A 占用 3000 → Session B 尝试绑定 3000 → **EADDRINUSE**。AgentDock 会自动分配端口（20000-65535 范围），但**项目必须读取环境变量才生效**。

**检测方法：**
\`\`\`bash
# 检测硬编码端口（排除环境变量读取模式）
grep -rn "listen([0-9]\\{4,5\\})" --include="*.ts" --include="*.js"
grep -rn "PORT=[0-9]" --include="*.env" --include="*.sh" --include="*.yml"
grep -rn "port: [0-9]\\{4,5\\}" --include="*.ts" --include="*.js" --include="*.yaml"
\`\`\`

**修复示例：**

Node.js/Express：
\`\`\`typescript
// ❌ 硬编码端口
app.listen(3000);

// ✅ 读取环境变量
const PORT = process.env.PORT || 3000;
app.listen(PORT);
\`\`\`

Vite：
\`\`\`typescript
// ❌ 硬编码端口
export default defineConfig({
  server: { port: 5173 }
});

// ✅ 读取环境变量
export default defineConfig({
  server: { port: Number(process.env.FRONTEND_PORT) || 5173 }
});
\`\`\`

Python/Flask：
\`\`\`python
# ❌ 硬编码端口
app.run(port=5000)

# ✅ 读取环境变量
import os
app.run(port=int(os.environ.get("PORT", 5000)))
\`\`\`

Docker Compose：
\`\`\`yaml
# ❌ 固定端口映射
ports:
  - "3000:3000"

# ✅ 读取环境变量
ports:
  - "\${BACKEND_PORT:-3000}:3000"
\`\`\`

---

### IS-09: 用户目录写入 ⚠️ L2 FAIL

**场景：** 应用运行时写入用户主目录下的固定路径（\`~/myapp-data/\`、\`~/.local/share/myapp/\`）。

**冲突机制：** Session A 写入数据文件 → Session B 读到 Session A 的数据 → 业务逻辑错误。

**检测方法：**
\`\`\`bash
grep -rn "os\\.homedir\\|path\\.join.*homedir" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**
\`\`\`typescript
// ❌ 固定用户目录
const dataDir = path.join(os.homedir(), 'myapp-data');

// ✅ 支持 XDG 重定向
const dataDir = process.env.XDG_DATA_HOME
  || path.join(os.homedir(), '.local', 'share', 'myapp');
\`\`\`

---

### IS-10: 进程级全局锁 🔴 L0 BLOCKER

**场景：** 应用使用 PID 文件或锁文件防止多实例运行（\`/var/run/app.pid\`、\`app.lock\`、\`flock()\`）。

**冲突机制：** Session A 创建锁 → Session B 尝试获取锁 → **拒绝启动**。

**检测方法：**
\`\`\`bash
grep -rn "flock\\|lockfile\\|\\.pid\\|createLock\\|pidfile\\|Lockfile" --include="*.ts" --include="*.js" --include="*.py"
\`\`\`

**修复示例：**
\`\`\`typescript
// ❌ 全局锁路径
const LOCK_FILE = '/var/run/myapp.pid';

// ✅ Worktree 内锁文件
const LOCK_FILE = process.env.AGENTDOCK_WORKTREE_PATH
  ? path.join(process.env.AGENTDOCK_WORKTREE_PATH, 'app.pid')
  : '/var/run/myapp.pid';
\`\`\`

---

## 四、关键改造模式

### 4.1 端口环境变量化

所有服务端口必须通过环境变量配置。AgentDock 自动分配 20000-65535 范围端口并写入 \`.env\`，但项目必须配合读取：

\`\`\`typescript
// 通用端口读取模式
const PORT = Number(process.env.PORT) || 3000;
const WS_PORT = Number(process.env.WS_PORT) || 8080;
const DEBUG_PORT = Number(process.env.DEBUG_PORT) || 9229;
\`\`\`

### 4.2 .env 文件管理

项目配置应使用 \`.env\` 文件管理，AgentDock 会在创建 Session 时自动同步：

\`\`\`bash
# .env 示例
DATABASE_URL=file:./dev.db
UPLOAD_DIR=./uploads
CACHE_DIR=./.cache
PORT=3000
\`\`\`

### 4.3 幂等安装

\`install\` 命令必须可重复执行且结果一致。确保：
- 不依赖外部状态（如特定数据库内容）
- 不产生副作用（如创建全局文件）
- 支持增量安装（已有依赖时不重复安装）

### 4.4 Worktree 友好路径

不要依赖 \`__dirname\` 定位相对于项目根的资源，因为 Worktree 路径与主仓库不同：

\`\`\`typescript
// ❌ 依赖 __dirname
const configPath = path.join(__dirname, '..', 'config.json');

// ✅ 使用环境变量或相对路径
const configPath = process.env.AGENTDOCK_PROJECT_PATH
  ? path.join(process.env.AGENTDOCK_PROJECT_PATH, 'config.json')
  : path.join(process.cwd(), 'config.json');
\`\`\`

### 4.5 Docker Compose 隔离

如果项目使用 Docker Compose，确保：
- 不使用固定 \`container_name\`
- 不使用固定 named volume
- 不使用固定外部网络名
- 使用 \`COMPOSE_PROJECT_NAME\` 环境变量自动前缀

---

## 五、执行步骤

1. **检查 Git 仓库** — 如不是则执行 \`git init\`
2. **检查启动命令** — 确认项目有明确的入口文件或启动脚本（\`package.json\` scripts、\`main.py\` 等）
3. **排查端口硬编码** — 按 IS-08 检查并修复所有硬编码端口
4. **排查共享资源** — 逐一检查 IS-01 到 IS-10 的 10 类隔离场景，修复所有 L0/L1 问题
5. **配置 .env 管理** — 确保配置通过环境变量管理，不在代码中硬编码
6. **确保幂等安装** — install/build 命令可重复执行
7. **验证 Worktree 友好** — 路径不依赖 \`__dirname\` 或固定绝对路径
8. **配置 AgentDock** — 在 AgentDock 中创建 \`agentdock.config.yaml\`（配置 resources.sync 和 hooks）
9. **运行验证** — 确认项目在 Worktree 中可正常启动

---

## 参考

以上规范基于 AgentDock Compatible Specification v0.2。如需了解 AgentDock 的内部架构（Daemon 生命周期、端口仲裁模型、崩溃恢复等），请参阅项目 \`docs/\` 目录下的文档。
`;
