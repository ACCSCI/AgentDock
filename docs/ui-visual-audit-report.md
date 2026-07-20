# AgentDock 视觉审计报告（布局 / 排版）

> 基线：`codex/ui-shadcn-refactor` @ `8262a19`（含未提交工作区改动）
> 方法：真实启动隔离 Electron 实例（独立 `--user-data-dir` + `AGENTDOCK_DEV_INSTANCE`），
> 按 `docs/ui-ux-review-checklist.md` 检查表逐界面截图并人工审阅。
> 证据：`e2e/audit-shots/*.png`（11 张），采集脚本 `e2e/ui-visual-audit.spec.ts`。
> 矩阵：浅色/深色 × 1280×800（标准）、浅色 × 900×640（窄窗口）。
> 覆盖界面：首页、目录选择弹层、配置编辑器、工作区+终端、终端新增菜单、删除确认、窄窗口全链路。

## 执行摘要

**根本原因**：项目处于 shadcn/Tailwind 重构的"半完成"状态，存在**两套并存的视觉语言**——
首页/7 个 shadcn 组件用新语义 token（`--background`/`--primary`），而工作区、会话侧栏、
配置编辑器、终端面板等仍用 18 个旧 CSS 模块 + 一套旧的 `--color-*` token（3771 行），
两套之间靠一层"兼容别名"勉强映射。这正是用户感知到的"布局、排版问题很多"的来源：
**不是零散 bug，而是系统性不一致**。

> 复审说明：本报告经作者（日常使用用户）复核，**终端区的"空间浪费"为误报**——
> 终端黑框是 xterm 正常填满 `flex:1` 区后的背景，内容少属正常。真正的 S1 只有两条（深色卡片、首页重叠）。

按用户影响排序，最关键的两件事：

1. **深色模式残缺（S1）** — Session 卡片在深色下渲染成刺眼的浅灰白色，与深色侧栏格格不入。
2. **首页 CTA 与能力卡片重叠 + 大面积空洞（S1/S2）** — 主按钮压在卡片上，首屏上部约 30% 空白。

（工作区顶部那叠信息条——worktree 路径 / 端口徽章 / 字体设置栏——经作者确认**日常有用**，
只需轻度美化、合并行以提升密度，列为 S3，见 S3-E。）

---

## 问题清单（按严重度分级）

> 分级：S0 阻断 / S1 遮挡或严重影响主任务 / S2 明显布局排版缺陷 / S3 轻微一致性/审美。
> 标注：✅ Confirmed（可观察客观缺陷）· ◻ Candidate（主观审美，需设计评审）。

### S1 — 严重影响主任务

**S1-A 深色模式下 Session 卡片背景错误** ✅
证据：`10-workspace-session-dark-standard.png`
Session 1 / Session 2 两张卡片在深色侧栏里渲染成浅灰白色，对比刺眼。
根因（源码）：`session-card.css:213` `.session-card-foreign { background:#f8fafc }` 等硬编码浅色，
不跟随 dark token；`.session-card` 基色 `var(--card)` 之外仍有若干 `#xxx` 硬编码
（`session-card.css:142,147,150`、`session-status.css:44` `#d1d5db`）。
修复方向：删除组件内所有硬编码色值，统一走语义 token；dark 用 `.dark`/media 下的同一变量覆盖。

**S1-B 首页主按钮与能力卡片重叠** ✅
证据：`01-home-light-standard.png`、`20-home-light-narrow.png`
"打开项目" CTA 按钮与其下方 `Isolated/Observable/Coordinated` 三列卡片在垂直方向重叠（按钮压住卡片顶边）。
根因（源码）：`index.tsx:44` 标题用 `leading-[0.98] tracking-[-0.055em]` + `clamp(2rem,4vw,4.25rem)`，
`index.tsx:53` CTA 区 `mt-8`、`index.tsx:64` 卡片区 `mt-14`，在部分宽度下卡片上沿侵入按钮盒。
修复方向：用稳定的栅格间距（固定 `gap`）替代大字号标题的负行高压榨，给 CTA 与卡片之间设最小间距。

> ~~原 S1-A「工作区终端空间浪费」已撤销~~ —— 复核确认终端黑框为 xterm 正常背景，非布局缺陷。

### S2 — 明显布局/排版缺陷

**S2-A 首页首屏上部大面积空洞** ✅
证据：`01-home-light-standard.png`
顶部约 30% 高度只有网格背景，内容被压到中下部，`justify-center` 在 1280×800 下把视觉重心压得过低。
修复方向：内容上移（`justify-center` → `pt-[18vh]` 之类），或让网格背景与内容更贴合。

**S2-B 中文标题字距过紧、可读性下降** ◻
证据：`01-home-light-standard.png`
`tracking-[-0.055em]` 使中文"工作现场"等字粘连。西文负字距有效，中文不适用。
修复方向：中文（CJK）场景字距 ≥ 0，仅对西文/数字保留紧凑字距（可用 `:lang` 或拆分 span）。

**S2-C 长会话名截断策略粗糙、溢出卡片** ✅
证据：`22-workspace-light-narrow.png`
`a-very-long-session-name-to-test-truncation-behavior` 被硬截断且右缘顶到卡片边框，无留白。
根因（源码）：`session-card.css:87` `.session-name` 有 `text-overflow:ellipsis`，
但卡片 `padding:9px 10px` 偏紧，且侧栏缺统一的 `min-w-0` 截断约束（review 清单 P2 已点出）。
修复方向：侧栏/卡片统一 `min-w-0` + 省略号，截断处提供 title/Tooltip 查看完整名。

**S2-D 残留 / 无效 project tab** ✅
证据：`03-config-editor-light-standard.png`（顶部 `agentdock-e2e-0-...` 残留 tab，指向不存在的临时路径）
这是 commit `17ff2b2` 试图修复的"全新安装后顶部残留大量 project tab"的再现。
修复方向：打开新项目前清理指向不存在路径的 tab；已在路线图上，建议提高优先级。

**S2-E 顶部信息条层级偏多、分隔线偏密** ✅（自 S1 降级，非致命）
证据：`04`、`10`
项目头 / session-info / 端口行 / 字体栏 / 终端 tab 共 5 层横条，每层都有边框或底色，视觉略碎。
**注意**：经作者确认这些信息日常有用，不是噪音；此处仅作密度优化，不必删除内容。
修复方向：同类信息归组、去掉重复分隔线即可（并入 S3-E 一起轻度美化，不必大改）。

### S3 — 一致性 / 审美

**S3-A 端口徽章、字体设置栏样式陈旧** ◻
证据：`04`、`22`
玫红描边圆角徽章 + 旧式 `- 14 +` stepper + 原生 `<select>`，与 shadcn `badge`/`button`/`select` 不一致。
修复方向：迁移到 shadcn `Badge`/`Select`，端口用 `tabular-nums` 等宽数字（review 清单 P1 字体层级）。

**S3-B 终端新增菜单图标风格不统一** ◻
证据：`05-terminal-addmenu-light-standard.png`
菜单项图标 `>` `◆` `◇` 是字符/几何符号，与全站 lucide 图标体系脱节。
修复方向：统一 lucide 图标；菜单迁移到 shadcn DropdownMenu（review 清单 P0 已列，兼获键盘可达性）。

**S3-C 目录选择弹层细节** ◻
证据：`02-dirbrowser-light-standard.png`
标题栏孤立 `/`、搜索框/按钮（Cancel/Select）样式偏旧；且 review 清单指出 `FilePicker` 缺 `role="dialog"` 等语义。
修复方向：迁移到 shadcn Dialog，统一按钮规格。

**S3-D 色彩语义：主色与危险色未分离** ◻
证据：`06-delete-confirm-light-standard.png`
`Delete` 用大红、全站主色用玫红（`#d43853`），两种红并存；删除会话确认里又出现绿色对勾（`session-card.css:143`）。
修复方向：按 review 清单色彩角色落地 Signal Rose（主）/ Danger（危险）分离。

**S3-E 工作区顶部信息条轻度美化** ◻（作者确认内容日常有用，仅做外观优化）
证据：`04`、`22`
那行超长 worktree 完整路径、5 个端口徽章、字体设置栏（`- 14 +` stepper + 原生 `<select>`）
样式偏旧、各占一行。**保留全部信息**，只做：路径改为可截断的单行省略 + hover 显示完整、
端口徽章换成 shadcn `Badge`（`tabular-nums`）、字体控件换成 shadcn `Select`/按钮，视觉上更紧凑统一。
修复方向：纯外观收敛，不动信息与交互。

### 用户复核补充的三处（第二轮截图确认）

**S2-F 目录浏览器路径 UI 破碎、宽度随名称变化** ✅
证据：`30-dirbrowser-selected-light.png`
面包屑把 `/`（根）和 `C:` 渲染成一串独立的玫红小按钮，外加多余的 `/` 分隔符，看起来是
`/ / C:` 三个碎块而非整齐路径 `C:\`；段名长短不一（`$Recycle.Bin` vs `AMD`）导致整体参差，
`flex-wrap: wrap` 还会换行。底部"已选择"路径同为无前缀框的纯文本，宽度随路径变化。
根因（源码）：`DirBrowserModal.tsx:217-233` 每段独立 `<button>`；`directory-browser.css`
`.dir-breadcrumb-item` 无统一高度/容器；`.dir-modal-selected-path` 仅纯文本。
修复方向：面包屑改为**等高的连续路径条**（统一 segment 高度，或单个等宽字体的路径框），
去掉多余根 `/`；"已选择"路径加统一容器/前缀，固定高度、超长省略 + hover 看全。

**S2-G 设置页按钮/输入规格混用（"缝合怪"）** ✅
证据：`34-settings-light.png`
同一页 ≥5 种控件规格并存：语言切换走 shadcn Button（实心/描边）✅；`Check for Updates`
走旧 `.settings-version-check-btn`（灰底细边）❌；`Alt+d ×` 徽章走旧 `.settings-shortcut-badge`❌；
`+ Add` 走旧 `.settings-shortcut-add`（玫红虚线框）❌。高度、圆角、边框、字重互不统一。
根因（源码）：`settings.tsx` header/部分按钮用 shadcn，快捷键/版本/端口仍靠 `settings.css` 手写。
修复方向：全页控件统一到 shadcn `Button`/`Badge`/`Input`，删除 `settings.css` 里的手写按钮规格。

**S2-H 设置页端口范围输入布局错乱** ✅
证据：`34-settings-light.png`
两个端口输入框各自 `width:100%` 竖排，中间的 `-` 分隔符被挤到单独一行。
根因（源码）：`.settings-port-pool-row` 未形成有效 flex 行（输入框 `Input` 默认块级占满行宽）。
修复方向：两个输入框改为固定窄宽度并排在同一行，`-` 分隔符行内居中；或改用 shadcn 行内表单。

---

## 建议的修复顺序（与工作量匹配）

1. **先收敛设计 token（低成本、收益最大）** — 删除 `globals.css` 双 token 与"兼容别名"，
   让 18 个旧 CSS 模块收敛到单一语义 token；顺带消除 S1-A（深色卡片发白）与大部分 S3。
2. **修首页布局（S1-B/S2-A/S2-B）** — 首页是第一印象，成本低、见效快。
3. **迁移高频组件到 shadcn（S3-A/S3-B/S3-C/S3-E）** — 顺带解决 review 清单里的键盘可达性 P0 项；
   工作区顶部信息条只做轻度美化，内容保留。
4. **设置页 + 目录浏览器统一（S2-F/S2-G/S2-H）** — 全页控件收敛到 shadcn；
   面包屑改连续路径条；端口输入并排修复。
5. **窄窗口/截断统一（S2-C）** — 侧栏 `min-w-0` + 截断 + Tooltip。
6. **残留 project tab（S2-D）** — 清理指向不存在路径的 tab（延续 commit `17ff2b2`）。

## 未覆盖 / 限制

- 深色配置编辑器未单独截到（`11` 与工作区相同——截图前未切回 ConfigEditor 视图）；深色其余界面已覆盖。
- Windows 显示缩放（100%/125%）、150% 高分屏未在本轮抽查。
- 大量 session（>50）的列表虚拟化、拖拽重排的动效未覆盖。
- 采集脚本 `e2e/ui-visual-audit.spec.ts` 已入库，修复后可一键重跑做 before/after 对比。
