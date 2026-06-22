/**
 * Prompt template for converting a project to be "AgentDock Compatible".
 *
 * Copied to clipboard via the IconSidebar 📋 button.
 * Based on AgentDock Compatible Specification v0.2 (docs/ads-v0.2.md).
 */

export const AGENTDOCK_COMPAT_PROMPT = `请将此项目改造为 "AgentDock Compatible" 项目。

## 背景

AgentDock 是一个会话管理系统，通过 Git Worktree 为每个 Session 提供隔离的开发环境，
自动分配端口、同步资源、执行生命周期 Hook。要让一个项目被 AgentDock 高效管理，
需要满足以下兼容性要求。

---

## 一、MUST 要求（必须全部满足）

| # | 要求 | 说明 |
|---|------|------|
| M1 | Git 仓库 | 项目根目录必须已执行 \`git init\` |
| M2 | 可构建运行 | 项目能在 Worktree 中通过安装依赖后启动 |
| M3 | 配置文件 | 项目根目录存在 \`agentdock.config.yaml\`（可为空配置 \`version: "1"\`） |
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

## 三、agentdock.config.yaml

请在项目根目录创建此文件（根据项目实际类型调整 hooks 和 sync 内容）：

\`\`\`yaml
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

env:
  ports:
    - FRONTEND_PORT
    - BACKEND_PORT
    - WS_PORT
    - DEBUG_PORT
    - PREVIEW_PORT
\`\`\`

**配置说明：**
- \`resources.sync\`：列出需要从主仓库同步到 Worktree 的文件/目录
- \`hooks\`：四个生命周期事件（\`beforeCreateSession\`、\`afterCreateSession\`、\`beforeDeleteSession\`、\`afterDeleteSession\`）
- \`env.ports\`：声明项目使用的端口槽位名称，AgentDock 自动分配 20000-65535 范围端口并写入 \`.env\`
- Hook 执行时可用环境变量：\`$AGENTDOCK_SESSION_ID\`、\`$AGENTDOCK_PROJECT_ID\`、\`$AGENTDOCK_WORKTREE_PATH\`、\`$AGENTDOCK_PROJECT_PATH\`

---

## 四、10 类 Session 隔离场景检查

多 Session 并行时，以下场景可能导致冲突，请逐一检查并修复：

| ID | 场景 | 隔离等级 | 修复方案 |
|----|------|---------|---------|
| IS-01 | 共享数据库（SQLite/嵌入式 DB） | L1 BLOCKER | DB 路径改为相对路径或环境变量：\`DATABASE_URL=file:./dev.db\` |
| IS-02 | 共享缓存目录 | L3 WARN | 改为项目本地缓存目录（如 \`.cache/\`） |
| IS-03 | 共享上传目录 | L2 FAIL | 上传目录设为环境变量 + Hook 同步 |
| IS-04 | 全局配置目录（\`~/.config/\`） | L3 WARN | 支持 \`XDG_CONFIG_HOME\` 环境变量重定向 |
| IS-05 | 固定 Docker 容器名 | L0 BLOCKER | 移除 \`container_name\`，让 Docker 自动生成唯一名称 |
| IS-06 | 固定 Docker 网络名 | L3 WARN | 使用动态网络名（Docker Compose 自动用项目名前缀） |
| IS-07 | 固定 Docker Volume | L1 BLOCKER | 使用 \`COMPOSE_PROJECT_NAME\` 自动前缀 volume 名 |
| IS-08 | 固定端口号 | L0 BLOCKER | 端口改为读取环境变量：\`process.env.PORT || 3000\` |
| IS-09 | 用户目录写入（\`~/myapp-data/\`） | L2 FAIL | 支持 \`XDG_DATA_HOME\` 重定向 |
| IS-10 | 进程级全局锁（PID 文件） | L0 BLOCKER | 锁文件路径改为 Worktree 内路径 |

**判定规则：** L0/L1 = Not Compatible，L2 = Partially Compatible，L3 = 降级但不阻塞。

---

## 五、执行步骤

1. 检查项目是否为 Git 仓库，如不是则执行 \`git init\`
2. 检查项目是否有明确的启动命令/入口文件（\`package.json\` scripts、\`main.py\` 等）
3. 在项目根目录创建 \`agentdock.config.yaml\`（参照第三节示例，根据项目类型调整）
4. 逐一排查第四节的 10 类隔离场景，修复所有 L0/L1 问题
5. 确保端口通过环境变量配置（而非硬编码数字），并声明在 \`env.ports\` 中
6. 确保 install/build 命令幂等（可重复执行）
7. 确保 \`afterCreateSession\` hook 包含依赖安装命令
8. 运行项目验证可以正常启动

---

## 参考

- AgentDock Compatible Specification v0.2：项目 \`docs/ads-v0.2.md\`
- 验证规则 v0.2：项目 \`docs/validator-v0.2.md\`
- 配置 Schema（Zod）：项目 \`plugins/config.ts\`
`;
