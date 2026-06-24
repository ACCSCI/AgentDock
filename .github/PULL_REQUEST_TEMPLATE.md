## 变更说明

<!-- 简要描述这个 PR 做了什么,为什么。 -->

## 关联 Issue

<!-- 关联的 issue,例如:`Fixes #123` / `Closes #456` / `Related #789` -->

Closes #

## 变更类型

<!-- 勾选所有适用的 -->

- [ ] 🐛 Bug 修复(`fix:`)
- [ ] ✨ 新功能(`feat:`)
- [ ] 💥 破坏性变更(BREAKING CHANGE)
- [ ] 📖 文档(`docs:`)
- [ ] 🎨 代码风格(`style:`)
- [ ] ♻️ 重构(`refactor:`)
- [ ] ⚡ 性能优化(`perf:`)
- [ ] ✅ 测试(`test:`)
- [ ] 🔧 构建/工具链(`chore:` / `ci:`)

## 改动清单

<!-- 详细列出改动 -->

- 改动 1:[文件名 + 简述]
- 改动 2:[文件名 + 简述]
- ...

## 架构影响

<!-- 涉及 daemon/session/端口的改动必须说明 -->

- [ ] 不涉及核心架构(daemon/session/端口)
- [ ] 涉及核心架构,**已阅读并遵循** [新架构.md](https://github.com/ACCSCI/AgentDock/blob/master/docs/%E6%96%B0%E6%9E%B6%E6%9E%84.md) §0 不变式

## 测试

- [ ] 已运行 `bun run check`,无错误
- [ ] 已运行 `bun run test`,所有测试通过
- [ ] 已运行 `bun run test:e2e`,E2E 测试通过
- [ ] 新增了单元测试(覆盖新逻辑)
- [ ] 新增了 E2E 测试(覆盖新流程)
- [ ] 不需要测试(纯文档 / 配置变更)

## 文档

- [ ] README 已更新
- [ ] CONTRIBUTING 已更新
- [ ] docs/ 已更新
- [ ] 提示词模板已更新(`src/constants/`)
- [ ] 不需要文档变更

## 截图 / 录屏(可选)

<!-- UI 改动请附上截图/录屏 -->

## 检查清单

- [ ] 我已阅读 [CONTRIBUTING.md](https://github.com/ACCSCI/AgentDock/blob/master/CONTRIBUTING.md)
- [ ] 我已阅读 [新架构.md](https://github.com/ACCSCI/AgentDock/blob/master/docs/%E6%96%B0%E6%9E%B6%E6%9E%84.md)(如涉及核心架构)
- [ ] Commit 信息遵循 [Conventional Commits](https://www.conventionalcommits.org/)
- [ ] PR 标题遵循 Conventional Commits 格式(如 `feat: add amazing feature`)
- [ ] 我已运行 `bun run check:fix` 格式化代码
- [ ] 我已 rebase 到最新的 `master`
- [ ] 我已自测过所有改动

## 部署说明(可选)

<!-- 是否需要特殊部署步骤?数据库迁移?配置变更? -->
