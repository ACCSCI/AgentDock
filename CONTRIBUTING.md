# 贡献指南

感谢你有兴趣为 AgentDock 做出贡献!🎉

AgentDock 是一个 **Electron 桌面应用**,通过 Git Worktree Session 隔离机制,为 Claude Code 等 AI Agent 提供大规模并行开发环境。本文档面向开发者,介绍如何提交 Issue、PR,以及项目的开发约定。

> 📖 **使用文档**:如果你只是想**使用** AgentDock,请阅读 [README.md](README.md)。本文档只关心**怎么贡献代码**。

---

## 目录

- [行为准则](#行为准则)
- [我能帮上什么忙?](#我能帮上什么忙)
- [报告 Bug](#报告-bug)
- [提议新功能](#提议新功能)
- [提交 Pull Request](#提交-pull-request)
- [开发环境搭建](#开发环境搭建)
- [项目结构](#项目结构)
- [代码规范](#代码规范)
- [Commit 规范](#commit-规范)
- [测试](#测试)
- [发布流程](#发布流程)

---

## 行为准则

参与本项目即表示你同意遵守 [Code of Conduct](CODE_OF_CONDUCT.md)。请在所有互动中保持友善和尊重。

---

## 我能帮上什么忙?

- 🐛 **修 Bug**:从 [issues](https://github.com/ACCSCI/AgentDock/issues?q=is%3Aopen+is%3Aissue+label%3Abug) 入手,`good first issue` 标签适合首次贡献
- 📖 **改进文档**:README、docs/ 下的架构文档、提示词模板等
- ⚡ **性能优化**:Worktree 创建/删除速度、端口分配、终端启动等
- 🧪 **写测试**:E2E 覆盖率、单测
- 🌐 **国际化**:目前以中文为主,欢迎英文翻译
- 💡 **新功能**:在 [Discussions](https://github.com/ACCSCI/AgentDock/discussions) 先讨论再实现

---

## 报告 Bug

提交 Bug 前请先**搜索已有 issues**,避免重复。

请使用 [Bug Report 模板](.github/ISSUE_TEMPLATE/bug_report.md)提交,包含:

- **清晰标题**:一句话描述问题
- **复现步骤**:从 `bun run dev` 启动开始,逐步列出
- **期望行为**:你认为应该发生什么
- **实际行为**:实际发生了什么(含报错截图/日志)
- **环境信息**:OS、Node 版本、Bun 版本、AgentDock 版本
- **附加信息**:相关 PR、相关 issue 等

---

## 提议新功能

新功能请先在 [Discussions → Ideas](https://github.com/ACCSCI/AgentDock/discussions/categories/ideas) 发帖讨论,**不要直接提 issue**。维护者会在讨论中给出反馈,达成共识后再决定是否进入开发。

请说明:

- **要解决的问题**:为什么需要这个功能?
- **解决方案**:你设想的实现方式
- **替代方案**:你考虑过的其他方案
- **影响范围**:会影响哪些模块/用户?

---

## 提交 Pull Request

### 流程

1. **Fork 仓库** 并克隆到本地
2. **创建特性分支**(从 `master`):
   ```bash
   git checkout master
   git pull origin master
   git checkout -b feature/your-feature-name
   ```
3. **开发 + 测试**:
   - 阅读 [项目结构](#项目结构),找到对应模块
   - 遵循 [代码规范](#代码规范) 和 [Commit 规范](#commit-规范)
   - 跑通 `bun run check` 和 `bun run test`
4. **提交 + 推送**:
   ```bash
   git add .
   git commit -m "feat: add amazing feature"
   git push origin feature/your-feature-name
   ```
5. **创建 PR**:使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md),关联相关 issue
6. **Code Review**:维护者会尽快 review,请耐心等待

### PR 审核要点

- ✅ 所有 CI 检查通过
- ✅ 代码符合项目风格(biome 通过)
- ✅ 包含必要的测试(单元测试 / E2E 测试)
- ✅ 文档同步更新(README、docs/、CHANGELOG)
- ✅ Commit 信息符合 Conventional Commits
- ✅ 与现有架构不冲突(参考 [新架构.md](docs/新架构.md))

---

## 开发环境搭建

### 前置要求

| 工具 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18 | 运行时 |
| Bun | >= 1.0 | **推荐**包管理器与运行时 |
| Git | >= 2.30 | Worktree 支持 |
| Claude Code | latest | 可选,用于 AI 辅助开发 |

### 初始化

```bash
git clone https://github.com/ACCSCI/AgentDock.git
cd AgentDock
bun install
bun run dev
```

### 常用命令

```bash
# 开发
bun run dev                 # 启动 Electron 开发模式
bun run dev:renderer        # 只启动 React 渲染进程
bun run dev:main            # 只启动主进程

# 构建
bun run build               # 构建生产版本(未打包)
bun run package             # 打包成可分发的 Electron 应用

# 测试
bun run test                # 单元测试(Vitest)
bun run test:e2e            # E2E 测试(Playwright)
bun run test:e2e:ui         # E2E 调试模式

# 代码质量
bun run check               # Biome lint + format
bun run check:fix           # 自动修复
bun run typecheck           # TypeScript 类型检查
```

### 调试技巧

- **主进程日志**:在 `electron/main.ts` 中 `console.log`,日志会输出到终端
- **渲染进程日志**:浏览器 DevTools(默认 `Ctrl+Shift+I` / `Cmd+Option+I`)
- **Daemon 日志**:`~/.agentdock/logs/`
- **Session Hook 失败**:在 AgentDock UI 中点击 "View logs" 查看

---

## 项目结构

```
agent-dock/
├── electron/              # Electron 主进程 + preload
│   ├── main.ts            # 主进程入口
│   ├── preload.ts         # Context Bridge
│   └── main/ipc/          # IPC 处理器
├── plugins/               # 核心业务逻辑(主进程 + Daemon 共享)
│   ├── daemon/            # Hono HTTP 服务器
│   ├── session-lifecycle.ts
│   ├── hook-engine.ts
│   ├── port-allocator.ts
│   └── ...
├── src/                   # React 渲染进程
│   ├── components/        # UI 组件
│   ├── constants/         # 提示词模板等常量
│   ├── lib/               # 工具函数、状态管理
│   └── routes/            # TanStack Router 文件路由
├── e2e/                   # Playwright E2E 测试
├── scripts/               # 构建/开发脚本
├── docs/                  # 架构与设计文档
│   └── 新架构.md          # ⭐ 必读
└── .github/               # GitHub 配置(workflows、模板)
```

### 关键模块

| 模块 | 职责 | 改动前必读 |
|------|------|-----------|
| `plugins/daemon/` | 机器级单例 HTTP 服务,管理端口分配和 Session 状态 | [新架构.md](docs/新架构.md) §0 不变式 |
| `plugins/session-lifecycle.ts` | 编排 Session 创建/删除的 5 步流程 | [新架构.md](docs/新架构.md) |
| `plugins/hook-engine.ts` | 执行生命周期钩子 | - |
| `electron/main/ipc/` | IPC 处理器(29+ channels) | 保持 contextBridge 安全 |
| `src/components/` | UI 组件 | 遵循现有命名与样式约定 |

### 架构不变式

⚠️ **涉及 daemon/session/端口的改动必须遵循 [新架构.md](docs/新架构.md) §0 列出的不变式。** 包括:

- 端口分配必须原子,带文件锁与过期检测
- Worktree 必须独立分支 + 独立 .env + 独立端口
- Session 创建失败必须回滚所有副作用
- Dev 模式 (`AGENTDOCK_DEV_INSTANCE`) 必须与生产模式数据隔离

---

## 代码规范

### 风格

- 使用 [Biome](https://biomejs.dev/) 统一格式化和 lint
- 提交前运行 `bun run check:fix`
- 缩进:2 空格(默认)
- 引号:双引号(项目已配置)
- 行宽:120 字符

### TypeScript

- 所有新代码使用 TypeScript(无 `any`,必要时用 `unknown` + 类型守卫)
- 公共 API 必须有类型定义(避免隐式 `any`)
- 使用 [Zod](https://zod.dev/) 校验外部输入(IPC、配置文件、HTTP 请求)

### React

- 函数组件 + Hooks(无 class 组件)
- Props 类型必须显式定义
- 避免不必要的 re-render(`useMemo` / `useCallback` 仅在确实需要时使用)
- 状态管理优先用 TanStack Query(服务端状态) + Zustand(客户端状态)

### 注释

- **业务逻辑**:解释"为什么",而不是"做了什么"
- **公共 API**:JSDoc 注释
- **复杂算法**:必要的内联注释

---

## Commit 规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Type

| Type | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档变更 |
| `style` | 代码格式(不影响逻辑) |
| `refactor` | 重构(既不是 feat 也不是 fix) |
| `perf` | 性能优化 |
| `test` | 测试相关 |
| `chore` | 构建/工具链/依赖 |
| `ci` | CI/CD 配置 |

### Scope(可选)

模块名,如 `daemon`、`session`、`ipc`、`ui`、`docs`、`ci`。

### 示例

```bash
feat(session): support custom worktree base path
fix(daemon): prevent port leak on graceful shutdown
docs: update architecture diagram for v0.2
chore(deps): bump electron to 42.4
```

### Breaking Changes

破坏性变更必须在 body 中以 `BREAKING CHANGE:` 开头说明:

```
feat(api): change SessionStatus enum to lowercase

BREAKING CHANGE: SessionStatus values are now lowercase
(e.g. "draft" instead of "Draft"). Update all consumers.
```

---

## 测试

### 单元测试(Vitest)

```bash
bun run test                # 运行所有单元测试
bun run test:watch          # 监听模式
```

- 测试文件:`*.test.ts` 与源码同目录
- 覆盖率目标:核心业务逻辑 ≥ 80%

### E2E 测试(Playwright)

```bash
bun run test:e2e            # 完整 E2E
bun run test:e2e:ui         # UI 模式(可视化调试)
```

- 测试文件:`e2e/*.spec.ts`
- E2E 测试运行前**关闭所有其他 AgentDock 实例**,避免实例冲突
- 详细文档:[docs/e2e-guide.md](docs/e2e-guide.md)

### 编写测试的原则

- 测试行为,不是实现
- 一个测试一个断言(尽量)
- 使用 descriptive 名称:`should return 404 when session not found`
- 避免依赖外部状态(网络、文件系统)

---

## 发布流程

1. 维护者从 `master` 创建 release 分支
2. 更新 `package.json` 版本号
3. 更新 CHANGELOG(若有)
4. 触发 CI release workflow(自动构建 + 发布)
5. 在 GitHub 创建 Release

普通贡献者**不需要**关心发布流程,只需提交 PR 即可。

---

## 许可证

提交代码即表示你同意以 [MIT License](LICENSE) 授权你的贡献。

---

## 寻求帮助

- 💬 [GitHub Discussions](https://github.com/ACCSCI/AgentDock/discussions) — 一般问题、功能讨论
- 🐛 [GitHub Issues](https://github.com/ACCSCI/AgentDock/issues) — Bug 报告
- 📖 [docs/](docs/) — 架构与设计文档

感谢你的贡献!🙏
