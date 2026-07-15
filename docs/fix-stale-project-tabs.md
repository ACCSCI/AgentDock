# 修复经验: 全新安装后顶部残留大量 project tab

## 问题现象

用户全新安装 AgentDock（无论 perUser 还是 perMachine，无论安装/卸载多少次），
启动后顶部出现大量 project tab —— 包括：

- `AgentDock` — 安装目录本身
- `Copilot-Switch`、`AgentDock (1)` — 历史打开过的项目
- `a2b1c2fe-591`、`bed4c452-74d` — git worktree 目录
- `win-unpacked` — build 产物目录
- `agentdock-e2e-*`（多个）— e2e 测试自动生成的 temp 目录

关键：**用户全新安装后没有执行任何操作**，tab 就已经存在。

## 根因（两个独立问题）

### 根因 1: 打包后 `process.cwd()` 被 auto-register 成项目

`electron/main.ts` 启动时执行：

```ts
activeProjectPath = process.cwd();
```

- **开发模式**: `process.cwd()` = 仓库根目录，是真实项目，符合预期
- **打包模式**: `process.cwd()` = 安装目录
  （`C:\Users\<u>\AppData\Local\Programs\AgentDock`），**不是**用户项目

renderer 启动调 `db:projects:list` → `syncProject(activeProjectPath)` →
项目在 global DB 找不到 → **auto-register** 用目录名 "AgentDock" 注册。
这就是 `AgentDock` 那一行的来源。

**修复**: 打包模式不 auto-init 项目，显示"打开项目"欢迎页。

```ts
if (!app.isPackaged) {
  activeProjectPath = process.cwd();  // dev only
} else {
  // packaged: no auto project, show welcome screen
}
```

### 根因 2: legacy `~/.agentdock/projects.db` 未被清理

v0.1-v0.2 时期 global projects DB 存在 `$HOME/.agentdock/projects.db`
（后来迁移到 userData，但 fallback 逻辑一直保留 homedir 路径）。

这个文件里积累了 41 行历史记录（e2e 测试目录、worktree 目录、build
产物目录都被当成 project 注册过）。**卸载不清、重装照读**，所以 tab
一直存在。

尝试用 NSIS `customUnInstall` / `customUnInstallSection` 宏在卸载时删
`~/.agentdock`，但踩了两个坑（见下）。最终改为**启动时清理**（JS 层，
100% 可靠）：

```ts
// electron/main.ts, before openGlobalDb()
const legacyDbPath = join(app.getPath("home"), ".agentdock", "projects.db");
if (existsSync(legacyDbPath)) unlinkSync(legacyDbPath);
```

## NSIS 踩坑记录（重要）

### 坑 1: `$USERPROFILE` 不是 NSIS 内置变量

在 NSIS uninstaller 里写 `RMDir /r "$USERPROFILE\.agentdock"` **静默失败**。
NSIS 编译时报 warning（但不影响构建）：

```
6000: unknown variable/constant "USERPROFILE" detected, ignoring
```

`$USERPROFILE` 是 Windows 环境变量，NSIS 不继承。合法的 NSIS 内置变量
只有 `$APPDATA`（Roaming）、`$LOCALAPPDATA`（Local）、`$DESKTOP`、
`$PROGRAMFILES` 等。`$PROGRAMDATA` 同样不是内置变量。

**正确做法**: 用 `$DESKTOP` 倒推 home 目录：

```nsi
StrCpy $0 "$DESKTOP"       ; C:\Users\<u>\Desktop
StrCpy $0 $0 -8            ; 去掉末尾 "Desktop" (8 字符) → C:\Users\<u>\
StrCpy $0 "$0.agentdock"   ; → C:\Users\<u>\.agentdock
```

### 坑 2: `customUnInstall` / `customUnInstallSection` 宏不展开

electron-builder 的 NSIS 模板用 `!ifmacrodef customUnInstall` 检测自定义
宏。但 NSIS 3.0.4 在某些情况下不识别 `.nsh` include 文件里的宏定义，
`!insertmacro` 展开为空。详见 `docs/tech-debt/nsis-macro-expansion.md`。

**结论**: 不要依赖 NSIS 宏做关键清理逻辑。userData 清理放在 **app 启动时
的 JS 层**（可靠），NSIS 宏只做锦上添花（`deleteAppDataOnUninstall: true`
删 Roaming，宏尝试删其它路径，能删就删，删不了靠 JS 兜底）。

## $APPDATA vs $LOCALAPPDATA vs 安装目录

三者是不同路径，容易混淆：

| NSIS 变量 | 实际路径 | 用途 |
|---|---|---|
| `$APPDATA` | `C:\Users\<u>\AppData\Roaming` | electron 默认 userData |
| `$LOCALAPPDATA` | `C:\Users\<u>\AppData\Local` | perUser 安装目录父级 |
| 安装目录 | `$LOCALAPPDATA\Programs\AgentDock` | exe + dll |
| legacy DB | `C:\Users\<u>\.agentdock` | v0.1-v0.2 global DB |

## 验证方法（无 GUI 自动化测试）

用 PowerShell/Python 做 silent install/uninstall（无需管理员，perUser）：

```python
import subprocess, os, sqlite3
# 清旧 DB
db = os.path.expanduser('~/.agentdock/projects.db')
if os.path.exists(db): os.remove(db)
# silent 安装
subprocess.run([installer, '/S', '/currentuser', r'/D=C:\AgentDock-Test'])
# 启动 + 等窗口
p = subprocess.Popen([r'C:\AgentDock-Test\AgentDock.exe'])
time.sleep(15)
# 检查 global DB —— 应该是 0 行（打包后不 auto-register）
conn = sqlite3.connect(db)
print(conn.execute('SELECT COUNT(*) FROM projects').fetchone())
```

关键断言: **全新安装启动后 `projects.db` 应为 0 行**（或文件不存在）。
如果 > 0，说明 auto-register 又把某个非项目目录注册了。

## 修改清单

| 文件 | 改动 |
|---|---|
| `electron/main.ts` | 打包模式不 auto-init 项目；启动时清 legacy `~/.agentdock/projects.db` |
| `build/installer/installer.nsh` | `$DESKTOP` 倒推 home 删 `.agentdock`；customUnInstall + customUnInstallSection 双保险 |
| `electron-builder.yml` | `deleteAppDataOnUninstall: true`；include `build/installer/installer.nsh` |
| `docs/troubleshooting.md` | 用户手动清理指南 |
| `docs/tech-debt/nsis-macro-expansion.md` | NSIS 宏不展开的技术债记录 |
