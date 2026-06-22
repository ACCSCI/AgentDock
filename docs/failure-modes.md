# 已知失败模式速查表

> AI agent 失败时优先翻这张表。每个 phase 的新失败模式追加到对应 section。

## 通用

### "spawn 子进程卡住"
- **症状**: acceptance 测试 timeout, 进程不退出
- **根因**: 测试没调 `daemon.kill()` 或 `app.close()`
- **修复**: `afterAll(() => daemon.kill())` 必须存在

### "EADDRINUSE in acceptance"
- **症状**: spawnTestDaemon 失败, port 已占用
- **根因**: 上一个测试没释放端口, 或并行运行
- **修复**: vitest 用 `pool: "forks"`, `workers: 1`

### "Playwright Electron 启动失败"
- **症状**: `_electron.launch()` throws
- **根因**: electron 二进制缺失或没构建
- **修复**: 先跑 `bun run build` (electron-vite build) 再跑 e2e

## IPC handler 测试

### "IPC handler 返回 undefined"
- **症状**: integration 测试 `expect(result.sessionId).toBeDefined()` 失败
- **根因**: handler 没 return, 或 mock context 缺字段
- **修复**: 检查 handler 函数体最后一行是否有 return

### "webContents.send 没收到事件"
- **症状**: `onIpcEvent("session:abc:step", ...)` 没触发
- **根因**: mock sender 没绑 send spy, 或 channel 名拼错
- **修复**: 用 `test-utils/ipc-mock.ts` 的 `onIpcEvent` 而非直接 mock

## Hono / Daemon

### "zod 校验不生效"
- **症状**: 缺字段的请求应该返 400 但返 200
- **根因**: 路由没装 `zValidator`, 或者 schema 太宽松
- **修复**: `app.post('/foo', zValidator('json', FooSchema), handler)`

### "CSRF/Origin guard 没拦住"
- **症状**: 带 `Origin: http://evil.com` 的 POST 返 200
- **根因**: middleware 没装, 或装错位置 (route 后挂载)
- **修复**: middleware 用 `app.use('*', ...)` 全局挂, 在路由之前

### "app.request() 返 404"
- **症状**: 测试调 `app.request('/sessions/allocate')` 返 404
- **根因**: 路由没注册, 或 method 不对
- **修复**: 检查 `app.post(...)` 是否存在, body 是否对

## Vitest 配置

### "vitest workspace 报错: project not found"
- **症状**: `vitest run --project xxx` 失败
- **根因**: workspace config 里 `name` 拼错
- **修复**: 检查 `vitest.workspace.ts` 的 `name: "unit"` 等

### "import test-utils/X 时路径错误"
- **症状**: `Cannot find module 'test-utils/...'`
- **根因**: tsconfig paths 没配, 或相对路径深度不对
- **修复**: 用相对路径 `../../test-utils/x.js` (with `.js` for ESM)

## 新发现时怎么追加

每发现一个非显而易见的失败模式，按以下格式追加：

```markdown
### "<症状关键词>"
- **症状**: <具体的错误输出 / 现象>
- **根因**: <根本原因>
- **修复**: <具体修复方法 + 涉及的文件>
```

保持简短，不要写废话。AI agent 翻表是为了快速修复，不是为了读长文。
### "better-sqlite3 native binding failed to load" on Windows + Electron
- **症状**: IPC handler for `db:*` throws "better-sqlite3 native binding failed to load" (or similar MODULE_VERSION mismatch). Renderer shows "Not Found" / 项目列表为空.
- **根因**: `better-sqlite3` ships prebuilds for specific Node ABI versions. The prebuild in `node_modules/better-sqlite3/build/Release/` was built for bun/Node 24, but Electron 42 ships a different Node ABI. The loader searches 12 candidate paths and none match.
- **修复**: 
  1. Install Windows Build Tools: `npm install -g windows-build-tools` (or via Visual Studio Installer with "Desktop development with C++" workload)
  2. Run `bunx electron-builder install-app-deps` to rebuild better-sqlite3 against Electron's Node ABI
  3. Restart `bun run start` / `bun run dev`
- **临时 workaround**: If build env is unavailable, the app will still boot — the renderer will just show "Not Found" until a working build env is set up. The IPC layer (daemon, terminals, fs, shell) all work without better-sqlite3.

### "no entry point found for electron app" (preview command)
- **症状**: `bun run start` errors with `Error: No entry point found for electron app, please add a "main" field to package.json`.
- **根因**: `electron-vite preview` (Phase 0's `start` script) needs a `"main": "out/main/main.js"` field in package.json. That field was removed during the Phase 0 package.json cleanup.
- **修复**: Add `"main": "out/main/main.js"` to the top of package.json.
