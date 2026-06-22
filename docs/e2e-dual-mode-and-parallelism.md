# E2E UI 测试双模式支持 + 多 Worker 并行化

> 设计文档 | 2026-06-22 | 作者：FleetView Agent

---

## 一、问题背景

当前的 E2E 测试在每个 test 都会重新调用 `electron.launch()` 创建一个全新的 Electron 实例。单个 test 的 Electron 启动成本（launch → firstWindow → waitForFunction）约 **5–10s**，加上 teardown 和进程退出等待，10 个 test 总共要付出约 **75s 纯启动/关闭开销**，占整体运行时长的主要部分。

### 现有架构回顾

| 维度 | 现状 |
|---|---|
| 测试框架 | Playwright Test (`@playwright/test`) |
| 并行度 | `workers: 1`，`fullyParallel: false` |
| 每 test 启动 | ✅ 每个 test 各自 `electron.launch()` + `app.close()` |
| Build 缓存 | ✅ `electron-vite build` 已做 `buildOnce` module 级缓存 |
| 数据隔离 | 每个 test 独立 `tmpdir()` + `--user-data-dir` |
| 共享 fixture | `e2e/fixtures/electron-fixture.ts`（仍是 per-test 启动） |
| 自启动 spec | 5 个 spec 手动 launch，未使用共享 fixture |

### 单个 test 的生命周期

```
electron-vite build  (仅首次，~2-5s)
  ↓
electron.launch()    ← ~2-5s 启动开销
  ↓
app.firstWindow()    ← ~1-3s 等待
  ↓
waitForFunction()    ← ~0.5-1s 等待 window.api
  ↓
───── 执行测试逻辑 ─────
  ↓
app.close()
  ↓
750ms 等待子进程退出
```

---

## 二、Playwright Electron API 调研结论

### 关键发现：`_electron` 没有 `connect()` 方法

Playwright 的 `Electron` 类**只有一个方法 `launch()`**。与浏览器类型不同，没有 `connect()`、没有 `connectOverCDP()`、没有 `wsEndpoint` 参数。

| 能力 | `electron.launch()` | `chromium.connectOverCDP()` |
|---|---|---|
| 官方支持 | ✅ 完整支持 | ❌ 仅用于浏览器，不用于 Electron |
| Main process 控制 | ✅ `electronApp.evaluate()` | ❌ 不可用 |
| BrowserWindow 映射 | ✅ `electronApp.browserWindow(page)` | ❌ 不可用 |
| 连接已有实例 | ❌ 只能启动新进程 | ⚠️ 可以但功能严重受限 |
| `close()` 行为 | 杀进程 | 仅断开连接，不杀进程 |
| 进程生命周期管理 | ✅ | ❌ |

### CDP workaround（不推荐）

社区有人尝试启动 Electron 时加 `--remote-debugging-port=9222`，然后用 `chromium.connectOverCDP()` 连接。**严重限制**：丢失所有 Electron 专用 API（`evaluate`、`browserWindow`、进程管理），测试保真度大幅下降，不是官方推荐的模式。

**结论**：不能用 CDP workaround 实现"连接到已有 Electron 实例"。方案必须在 `electron.launch()` 框架内设计。

---

## 三、14 个 spec 的隔离需求分析

| # | Spec 文件 | 隔离判定 | 关键原因 |
|---|---|---|---|
| 1 | `session-lifecycle.spec.ts` | **MUST_ISOLATE** | DB + fs 双轮幂等性断言 |
| 2 | `session-hook.spec.ts` | **MUST_ISOLATE** | 三子测、disk marker、async 状态机 |
| 3 | `session-orphan-branches.spec.ts` | **MUST_ISOLATE** | 直接操作 git branch，断言精确列表 |
| 4 | `session-orphan-ui.spec.ts` | **MUST_ISOLATE** | UI 模态 + 磁盘分支操作 |
| 5 | `session-port-reallocated.spec.ts` | **MUST_ISOLATE** | 手动 launch 两个实例，测试端口碰撞 |
| 6 | `session-ui.spec.ts` | **MUST_ISOLATE** | DB row + worktree 计数断言 |
| 7 | `session-ui-interaction.spec.ts` | **MUST_ISOLATE** | 多 session、多终端、慢 hook |
| 8 | `session-ui-slow-hook.spec.ts` | **MUST_ISOLATE** | 异步时序敏感，单 session |
| 9 | `daemon-multi-instance.spec.ts` | **MUST_ISOLATE** | 全局 `~/.agentdock/` daemon 状态 |
| 10 | `daemon-client-lifecycle.spec.ts` | **MUST_ISOLATE** | 全局 daemon 注册 + 35s 心跳等待 |
| 11 | `full-flow.spec.ts` | **MUST_ISOLATE** | 自管 `beforeAll`/`afterAll`，独立 build |
| 12 | `test-preload.spec.ts` | **MUST_ISOLATE** | 独立 launch，调试用 |
| 13 | `sse-resync-required.spec.ts` | **MUST_ISOLATE** | 全局 SSE ring buffer 溢出测试 |
| 14 | `electron-boots.spec.ts` | **SAFE_FOR_REUSE** | `expect(true).toBe(true)` 占位 |

**结论**：14 个 spec 中 13 个强依赖 per-test 隔离。**REUSE 模式 v1 默认 OFF**；仅对显式 opt-in 的 spec 生效。

---

## 四、Daemon 端关键约束

> 基于 `plugins/daemon-manager.ts`、`plugins/daemon-discovery.ts`、`plugins/daemon/server.ts` 调研

### Daemon 是机器级单例，固定在 `~/.agentdock/`

- `daemon-discovery.ts:63`：`return path.join(os.homedir(), AGENTDOCK_DIR)` —— **硬编码**，不读环境变量
- `daemon-manager.ts:73`：`this.baseDir = baseDir ?? path.join(os.homedir(), ".agentdock")` —— 构造函数接受可选参数，但生产代码从未传入
- `AGENTDOCK_DAEMON_BASE_DIR` 仅在 `session-port-reallocated.spec.ts` 中使用，**生产代码未 honor**

### 多 worker 并行的争抢点

| 文件 | 作用 | 并发问题 |
|---|---|---|
| `~/.agentdock/daemon-lock` | Leader 选举（O_EXCL） | 多 worker 竞争，只有 1 个 leader |
| `~/.agentdock/daemon.json` | Port 发现（pid, port） | 多 worker 读到相同 daemon |
| `~/.agentdock/daemon-state.json` | WAL（clients map, daemonPort） | 多 client 注册，端口分配冲突 |
| `~/.agentdock/ports.json` | 端口分配记录 | 并发分配同端口 |

**结论**：Plan D（多 Worker 并行）**必须先恢复 `AGENTDOCK_DAEMON_BASE_DIR` 支持**，让每个 worker 有独立的 `~/.agentdock-<id>/` 目录。

---

## 五、方案对比

### 方案 A：`test.describe.serial` + `beforeAll` 共享实例

```typescript
test.describe.serial('session tests (shared)', () => {
  let app: ElectronApplication;
  let window: Page;
  test.beforeAll(async () => {
    app = await electron.launch({ args: [mainEntry], ... });
    window = await app.firstWindow();
  });
  test.afterAll(async () => { await app?.close(); });
  test('test 1', async () => { /* 复用 window */ });
  test('test 2', async () => { /* 复用 window */ });
});
```

| 优点 | 缺点 |
|---|---|
| 节省 90%+ 启动时间 | 测试间有状态泄漏风险 |
| 官方完全支持 | 需手动管理 test 间状态清理 |
| 实现简单 | 不适合需要独立隔离的测试 |
| `full-flow.spec.ts` 已有此模式 | 失败的 test 可能影响后续 test |

### 方案 B：双模式 Fixture（本计划的推荐方案） ⭐

在现有 `electron-fixture.ts` 基础上，增加 `AGENTDOCK_E2E_REUSE` 环境变量控制模式：

```bash
# 模式 1 (默认): 每个 test 启动新 Electron（当前行为，完全隔离）
AGENTDOCK_E2E_REUSE=0   npx playwright test

# 模式 2: 整个 worker 共享一个 Electron 实例（快速，适合渲染层测试）
AGENTDOCK_E2E_REUSE=1   npx playwright test
```

核心思路：用 Playwright 的 **`scope: 'worker'` fixture**（[官方文档](https://playwright.dev/docs/test-fixtures#fixture-scopes)）缓存 `ElectronApplication`：

```typescript
// Worker-scoped 共享实例（仅 REUSE=1 模式下生效）
let sharedApp: ElectronApplication | null = null;

app: async ({ dataDir }, use, testInfo) => {
  const reuse = process.env.AGENTDOCK_E2E_REUSE === '1';
  const mainEntry = await getMainEntry();

  let app: ElectronApplication;
  if (reuse) {
    if (!sharedApp) {
      sharedApp = await electron.launch({ args: [mainEntry], ... });
    }
    app = sharedApp;
  } else {
    app = await electron.launch({ args: [mainEntry], ... });
  }

  await use(app);

  if (!reuse) {
    await app.close();  // 仅非复用模式关闭
  }
}
```

| 优点 | 缺点 |
|---|---|
| 向后兼容，默认行为不变 | 需要 refactor fixture |
| 环境变量一键切换 | 复用模式下 test 间隔离降低 |
| CI 用 REUSE=0 保隔离，本地用 REUSE=1 提速 | 部分 test 需要重写 |
| 可按 spec 选择模式 | 复用模式下需 reset 钩子 |

### 方案 C：CDP 连接预启动 Electron（放弃）

| 优点 | 缺点 |
|---|---|
| 理论上最快 | ❌ 丢失 `electronApp.evaluate()` —— 无法测 IPC |
| | ❌ 丢失 `browserWindow()` —— 无法操作窗口句柄 |
| | ❌ 非官方支持，不稳定 |
| | ❌ 大部分现有测试会 break |

**结论：不可行，放弃。**

### 方案 D：多 Worker 并行（后置方案）

增加 `workers` 到 2-4，利用数据隔离实现并行。需先解决 Daemon 争抢问题（见第四节）。

| 优点 | 缺点 |
|---|---|
| 不改测试代码 | 需先恢复 `AGENTDOCK_DAEMON_BASE_DIR` |
| 自然加速 N 倍 | 端口分配冲突风险 |
| Playwright 原生支持 | Windows Electron 进程管理更脆弱 |

---

## 六、推荐组合：B + D

### 执行顺序

```
Phase 1: Plan B（本次执行）
  → 改造 electron-fixture.ts 支持 REUSE 模式
  → 本地开发用 AGENTDOCK_E2E_REUSE=1
  → CI 保持 REUSE=0（默认）
  → pilot: electron-boots.spec.ts

Phase 2: Plan D（待 daemon 隔离 PR 后）
  → 恢复 AGENTDOCK_DAEMON_BASE_DIR 支持
  → 验证多 worker 下隔离
  → 增加 workers 到 2-4
```

### 预期收益估算

| 场景 | 当前耗时 (10 tests) | REUSE 模式 | 多 Worker (2) | REUSE + 多 Worker |
|---|---|---|---|---|
| 启动开销 | ~75s | ~8s | ~75s (并行) | ~8s (并行) |
| 总 wall-clock | ~120s | ~53s | ~60s | ~27s |
| 加速比 | 基准 | **~2.3x** | **~2x** | **~4.4x** |

---

## 七、Plan B 详细设计

### 设计原则

1. **向后兼容**：`AGENTDOCK_E2E_REUSE=0`（默认）行为完全不变
2. **显式 opt-in**：复用模式需要 spec 作者主动选择，避免状态泄漏
3. **分层隔离**：renderer 状态通过 `localStorage.clear() + page.reload()` 重置；main process 通过 `electronApp.evaluate()` 注入的 reset 钩子重置；daemon 状态 v1 不重置（标记为 v2 工作）
4. **可观测**：复用模式下，capture buffers 仍按 test 隔离（重置时清空）

### 文件改动清单

#### 1. `e2e/fixtures/electron-fixture.ts` —— 主战场

**新增导出 `reuseTest`**：

```typescript
export const reuseTest = base.extend<ElectronFixtures>({
  // workerApp: worker-scoped，整个 worker 只 launch 一次
  workerApp: [async ({}, use) => {
    const mainEntry = await getMainEntry();
    const userDataDir = join(tmpdir(), `agentdock-e2e-worker-${process.pid}`);
    mkdirSync(userDataDir, { recursive: true });

    const app = await electron.launch({
      args: [mainEntry, `--user-data-dir=${userDataDir}`],
      cwd: tmpdir(),
      env: { /* 同 base fixture */ },
      timeout: 30_000,
    });
    await use(app);
    await app.close();
  }, { scope: 'worker' }],

  // app: per-test，返回同一个 app 实例 + 新建 capture buffers
  app: async ({ workerApp }, use, testInfo) => {
    const mainLog: string[] = [];
    const rendererLog: RendererConsoleEntry[] = [];
    const pageErrors: CapturedError[] = [];
    const dialogs: DialogRecord[] = [];
    (workerApp as any).__captures = { mainLog, rendererLog, pageErrors, dialogs };

    // Per-test reset（beforeEach 语义）
    const window = await workerApp.firstWindow();
    await window.evaluate(() => localStorage.clear());
    await workerApp.evaluate(() => {
      // v1 reset: 调用 main process 的重置钩子
      (globalThis as any).__e2eResetMainState?.();
    });
    await window.reload();
    await window.waitForFunction(
      () => typeof (window as any).api === 'object',
      null,
      { timeout: 10_000 },
    );

    await use(workerApp);

    // Capture buffers 附件（仅失败时）
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('main.log', { body: mainLog.join(''), contentType: 'text/plain' });
    }
  },
  // ... window/mainLog/rendererLog/pageErrors/dialogs 从 workerApp.__captures 读取
});
```

**`buildOnce` 缓存已存在**，无需改动。

#### 2. `electron/main.ts` —— 新增 reset IPC（v1 最小版）

在现有 `NODE_ENV === 'test'` 守卫内（与 fault inject 路由同位置），新增：

```typescript
if (process.env.NODE_ENV === 'test') {
  // 已有 fault inject 路由...

  // v1 e2e reset: 清空 renderer 相关的 main process 缓存
  ipcMain.handle('__e2e:resetMainState', () => {
    // 重置 project cache（如有）
    // 重置 worktree cache（如有）
    // 注意：v1 不重置 daemon 子进程、端口分配、SSE bus
  });
}
```

> **v1 边界**：reset **不触碰 daemon**。因此 REUSE 模式 v1 仅适用于纯渲染层测试，不适用于 daemon 相关 spec。

#### 3. `e2e/electron-boots.spec.ts` —— pilot 改造

```typescript
import { reuseTest as test, expect } from './fixtures/electron-fixture';

test.describe('electron boots @reuse', () => {
  test('主窗口可启动', async ({ window }) => {
    const title = await window.title();
    expect(title).toBeTruthy();
  });

  test('window.api 桥接已就绪', async ({ window }) => {
    const hasApi = await window.evaluate(() => typeof (window as any).api === 'object');
    expect(hasApi).toBe(true);
  });
});
```

两个 test 共享同一个 Electron 实例，验证 reset 后 `window.api` 仍可用。

#### 4. `package.json` —— 新增脚本

```json
{
  "test:e2e": "playwright test",
  "test:e2e:reuse": "cross-env AGENTDOCK_E2E_REUSE=1 playwright test --grep @reuse",
  "test:e2e:dev": "cross-env AGENTDOCK_E2E_REUSE=1 playwright test"
}
```

#### 5. `docs/e2e-dual-mode-and-parallelism.md` —— 本文件

### v1 边界（明确不做的事）

| 不做 | 原因 |
|---|---|
| Daemon 状态 reset | 端口分配、SSE bus、客户端注册都是全局状态；需要 daemon 端先实现 `__e2e:resetDaemonState`，是 v2 工作 |
| 跨 spec 共享 | spec 间隔离语义更弱，风险高 |
| 默认开启 REUSE | 13/14 spec 是 MUST_ISOLATE |
| 改造 MUST_ISOLATE 的 spec | 需要 daemon reset + 仔细审计状态假设，单独迭代 |

### v2 / 未来工作

- 实现 `__e2e:resetDaemonState`（释放所有 port、清空 SSE buffer、注销所有 client）
- 实现 `__e2e:resetRendererPrefs`（重置 zustand persisted state 在 localStorage 中的 key）
- 评估 `session-ui.spec.ts` 等相对独立的 spec 是否能升级到 REUSE
- 配套验证：在 REUSE 模式下对比 per-test 的 SPEC_TIME，记录加速比

---

## 八、Plan D 多 Worker 并行设计（后置）

### 前置条件（必须先执行）

1. **恢复 `AGENTDOCK_DAEMON_BASE_DIR` 支持**：
   - `plugins/daemon-discovery.ts:63`：读 `process.env.AGENTDOCK_DAEMON_BASE_DIR ?? path.join(os.homedir(), ".agentdock")`
   - `plugins/daemon-manager.ts:73`：同理
2. **验证多 worker 隔离**：每个 worker 用 `~/.agentdock-worker-${TEST_PARALLEL_INDEX}/` 目录，包含独立的 lock、port、daemon.json
3. **验证并发端口分配**：`ports.lock` 在并发场景下的正确性回归

### 设计草案

**Playwright 配置**：
```typescript
// playwright.config.ts
export default defineConfig({
  workers: process.env.CI ? 2 : (process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 4),
  fullyParallel: true,  // daemon 隔离就绪后启用
});
```

**每 worker 的环境变量**（通过 Playwright worker index 注入）：
```
AGENTDOCK_DAEMON_BASE_DIR=~/.agentdock-worker-${TEST_PARALLEL_INDEX}
AGENTDOCK_DATA_DIR=${DATA_DIR_WORKER_${TEST_PARALLEL_INDEX}}
```

**风险评估**：
- Windows 上 PowerShell 启停 Electron 比 Unix 慢，并行收益可能低于理论值
- 同时打开 4 个 BrowserWindow 对开发机内存压力较大（每实例 ~300-500MB）
- 需要验证 `daemon-multi-instance.spec.ts`（本身测试 daemon 共享）在多 worker 下的行为

### 不在本次执行范围内

Plan D 仅作为后续工作的设计方案记录。**不在当前 Plan B 实施时同时推进** —— 需要等 Plan B 验证稳定、daemon 隔离 PR 落地后再讨论。

---

## 九、验证方法

### Plan B 验证

**功能性回归**：
```bash
# 1. 默认模式回归（行为不变）
AGENTDOCK_E2E_REUSE=0 npx playwright test

# 2. REUSE 模式 pilot
AGENTDOCK_E2E_REUSE=1 npx playwright test --grep @reuse

# 3. 混合模式验证
AGENTDOCK_E2E_REUSE=1 npx playwright test e2e/electron-boots.spec.ts e2e/full-flow.spec.ts
```

**性能对比**：
- 记录 REUSE=0 和 REUSE=1 下 `electron-boots.spec.ts` 的总耗时
- 目标：2 个 test 总耗时从 ~15-20s → ~6-8s

**鲁棒性**：
- REUSE=1 下，test 间注入 `localStorage.setItem('foo', 'bar')`，确认下个 test 看不到（reset 生效）
- REUSE=1 下，test 间注入 `console.error`，确认下个 test 的 `expectNoRendererErrors` 不报历史（capture buffer 隔离）

### Plan D 验证（后置）

- 2 workers 跑完整套件，确认无端口冲突
- 端到端运行时间对比：1 worker vs 2 workers
- Windows CI 上稳定性观察

---

## 十、关键文件清单

### 本次修改（Plan B）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `e2e/fixtures/electron-fixture.ts` | 修改 | 新增 `reuseTest` 导出、`workerApp` worker-scoped fixture、per-test reset |
| `electron/main.ts` | 修改 | 新增 `__e2e:resetMainState` IPC（仅 test 模式） |
| `e2e/electron-boots.spec.ts` | 修改 | 启用真实启动测试，使用 `reuseTest`，tag `@reuse` |
| `package.json` | 修改 | 新增 `test:e2e:reuse` / `test:e2e:dev` 脚本 |
| `playwright.config.ts` | 不改 | 默认 REUSE=0，行为不变 |
| `docs/e2e-dual-mode-and-parallelism.md` | 新建 | 本文档 |

### 复用现有代码

| 来源 | 复用内容 |
|---|---|
| `e2e/fixtures/electron-fixture.ts:getMainEntry()` | Build 缓存（module 级 `buildOnce`） |
| `e2e/fixtures/electron-fixture.ts` capture buffers | mainLog/rendererLog/pageErrors/dialogs 实现 |
| `e2e/fixtures/electron-fixture.ts:listChildPids()` | 子进程泄漏检测 |
| `electron/main.ts` `NODE_ENV === 'test'` 守卫 | fault inject 路由的现成模式 |

### 后续修改（Plan D，待定）

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `plugins/daemon-discovery.ts` | 修改 | 恢复 `AGENTDOCK_DAEMON_BASE_DIR` 支持 |
| `plugins/daemon-manager.ts` | 修改 | 恢复 `AGENTDOCK_DAEMON_BASE_DIR` 支持 |
| `playwright.config.ts` | 修改 | 增加 workers 数量 |
| `e2e/fixtures/electron-fixture.ts` | 修改 | 注入 per-worker daemon base dir |

---

## 十一、API 参考

- **Playwright fixture scopes**：[`scope: 'worker'`](https://playwright.dev/docs/test-fixtures#fixture-scopes) —— fixture 在整个 worker 内只创建一次，test 结束后 cleanup
- **Playwright test tags**：[`@reuse`](https://playwright.dev/docs/test-annotations#tag-tests) —— 标记 spec 适用的模式
- **Playwright test.extend()**：[Extension](https://playwright.dev/docs/test-fixtures#custom-fixtures) —— 在 base test 上扩展自定义 fixture
