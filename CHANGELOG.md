# Changelog

所有 AgentDock 的显著变更都会记录在此文件。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),
本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added
- 社区标准化文件:`CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`LICENSE`、`SECURITY.md`
- Issue 模板:Bug Report、Feature Request、Documentation、Question
- Pull Request 模板

## [0.1.0] - 2026-05-29

### Fixed
- 打包后 Daemon 启动问题(#91)
- 修复磁盘 worktree 同步 + 跨项目数据污染 + 扫描按钮(#89)
- 全局项目数据库迁移(#86)
- 修复 dev/prod userData 隔离,多实例开发不竞争 SQLite(#90)

[Unreleased]: https://github.com/ACCSCI/AgentDock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ACCSCI/AgentDock/releases/tag/v0.1.0
