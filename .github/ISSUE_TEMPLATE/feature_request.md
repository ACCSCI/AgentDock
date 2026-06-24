---
name: Feature Request
about: 提议一个新功能
title: '[Feature]: '
labels: enhancement
assignees: ''
---

> 💡 **新功能建议请先在 [Discussions → Ideas](https://github.com/ACCSCI/AgentDock/discussions/categories/ideas) 讨论,达成共识后再提 Issue。** 未经讨论的功能请求可能会被直接关闭。

## 功能描述

清晰描述你想要的功能。

## 要解决的问题

为什么需要这个功能?目前的痛点是什么?

例:`每次启动 Session 都要手动 cd 到 worktree 目录,很麻烦`

## 解决方案

你设想的实现方式是什么?

## 替代方案

你考虑过的其他方案?为什么不选它们?

## 影响范围

- 受影响的模块:`plugins/session-lifecycle.ts`、`electron/main/ipc/...` 等
- 受影响的用户:所有用户 / 高级用户 / 特定场景用户
- 是否有破坏性变更:是 / 否
- 是否需要数据库迁移:是 / 否
- 是否需要文档更新:是 / 否

## 优先级(自己评估)

- [ ] P0 - 必须有(阻塞核心功能)
- [ ] P1 - 应该有(重要功能)
- [ ] P2 - 可以有(锦上添花)

## 附加信息

- 截图 / Mockup:[拖拽到此处]
- 相关 issue / PR: #xxx
- 类似的实现参考(其他项目):...

## 你愿意贡献这个功能吗?

- [ ] 是,我会提交 PR
- [ ] 是,需要一些指导
- [ ] 否,只能提建议

## 检查清单

- [ ] 我已搜索过 [现有 issues](https://github.com/ACCSCI/AgentDock/issues?q=is%3Aissue+label%3Aenhancement),未发现重复
- [ ] 我已在 Discussions 中发起过讨论
- [ ] 我已阅读 [新架构.md](docs/新架构.md),确认该功能与现有架构兼容
