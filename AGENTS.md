# AGENTS

## Architecture

- **[新架构.md](docs/新架构.md)** — AgentDock 核心架构设计文档，定义 Daemon 职责边界、端口仲裁模型、崩溃恢复与并发所有权语义。所有涉及 daemon/session/端口的改动必须遵循该文档的不变式（§0）。

## Environment loading

- Reuse `plugins/env.ts` helpers when loading `.env` files in AgentDock runtime code.
- Prefer `readEnvFile()` over ad-hoc line parsing so quoted values and inline comments are handled consistently.

## Worktree child process isolation

- Worktree-scoped child processes must build env in this order:
  1. sanitized inherited env
  2. current worktree `.env`
  3. explicit `AGENTDOCK_*` runtime vars
- Do not rely on Bun/Vite/framework dotenv loading to override inherited parent-process values.
- Preserve the current “sanitize first, then overlay workspace env” behavior unless there is a deliberate semantic change.

## Vite watcher

- Keep `.agentdock/**` and `.claude/**` excluded from Vite file watching to avoid unrelated reloads during session management or Claude usage.
