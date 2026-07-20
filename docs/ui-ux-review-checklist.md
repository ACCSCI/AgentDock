# AgentDock UI/UX 审阅与优化清单

> 状态：待后续迭代执行。审阅基线为 `frontend-design` 与 Vercel Web Interface Guidelines；本清单不代表本轮已修改 UI 实现。

## P0：交互语义与键盘可达性

- [ ] 将 `FilePicker` 迁移到 Radix/shadcn Dialog：补齐 `role="dialog"`、标题/描述关联、焦点陷阱、Escape 关闭、关闭后焦点归还及背景滚动隔离。`src/components/FilePicker.tsx:98`
- [ ] 为文件条目提供原生按钮/列表框语义以及 Enter/Space 操作，避免仅依赖单击、双击。`src/components/FilePicker.tsx:148`
- [ ] 重构会话卡为“容器 + 主选择按钮 + 同级操作按钮”，消除 `role="button"` 容器内嵌按钮和输入框的冲突。`src/components/SessionCard.tsx:366`、`src/components/SessionCard.tsx:443`
- [ ] 将终端新增菜单迁移到 shadcn DropdownMenu，确保方向键、Enter、Escape、焦点恢复可用，并消除可点击 `div`。`src/components/TerminalManager.tsx:462`
- [ ] 为所有纯图标按钮提供可访问名称，优先 `aria-label`，不要只依赖 `title`：文件选择关闭、配置项删除、会话删除、终端字号增减/固定等。`src/components/FilePicker.tsx:102`、`src/components/ConfigEditor.tsx:344`、`src/components/SessionCard.tsx:485`
- [ ] 在根布局加入“跳到主要内容”链接，并给主要内容容器稳定的 `id`/`main` 语义。`src/routes/__root.tsx:20`

## P1：表单、状态与错误恢复

- [ ] 给配置编辑器的每个输入建立唯一 `id` 与 `htmlFor`；补充稳定的 `name`、合理的 `autocomplete`/`inputmode`，并将帮助文本用 `aria-describedby` 关联。`src/components/ConfigEditor.tsx:319`、`src/components/ConfigEditor.tsx:438`、`src/components/ConfigEditor.tsx:484`
- [ ] 给文件搜索输入增加可见或视觉隐藏标签、`name` 和搜索语义。`src/components/FilePicker.tsx:131`
- [ ] 让终端字体选择器与标签显式关联；字号值使用 `aria-live` 或具名输出，增减按钮使用 `aria-label`。`src/components/TerminalSettingsBar.tsx:32`
- [ ] 为配置加载、解析、保存建立互斥的 loading/empty/error/success 状态；解析失败不能永久显示“加载中”，需显示文件路径、错误原因、修复入口和重试。`src/components/ConfigEditor.tsx`
- [ ] 配置存在未保存修改时，在切换项目、路由或关闭窗口前提示；保存失败时在字段附近或页面级错误区保留错误，而非仅短暂 toast。
- [ ] 删除会话、清理孤儿 worktree 等不可逆动作统一使用 AlertDialog，明确对象名称与后果；危险按钮和默认主操作色分离。
- [ ] 将界面中的三个点统一为真正省略号 `…`，例如 `Connecting…`、`重试中…`、`扫描中…`。`src/components/SessionTerminal.tsx:176`、`src/components/HookErrorModal.tsx:136`、`src/components/OrphanCleanModal.tsx:152`

## P1：视觉系统与产品辨识度

- [ ] 收敛首页、工作区和配置编辑器为同一套 shadcn/Tailwind 语义 token；逐步删除兼容别名与旧式组件 CSS，避免“新控制台 + 旧工作台”两套视觉语言。`src/styles/globals.css:172`、`src/styles/components/workspace.css:9`、`src/styles/components/config-editor.css:478`
- [ ] 建立 AgentDock 标志性组件 **Worktree Rail**：以项目 → worktree → session → terminal/port/lifecycle 的关系表达状态、归属和切换，而不是通用侧栏卡片堆叠。
- [ ] 明确色彩角色：Canvas `#F6F7F9`、Surface `#FFFFFF`、Ink `#17181D`、Signal Rose `#D43853`、Process Blue `#356AE6`、Danger `#D9462F`；主操作与危险操作不得共用红色语义。`src/styles/globals.css:149`
- [ ] 字体层级采用“产品/状态标题 Maple Mono NF CN Bold、正文系统无衬线、端口/时长/路径 Maple Mono”；端口和时长启用 `tabular-nums`。`src/styles/globals.css:266`
- [ ] 统一中英文规则：产品术语可保留英文，说明与动作使用当前 locale；移除静态伪状态文案（如未经过真实检测的 `Git worktree ready`）。`src/routes/index.tsx:58`
- [ ] 修复窄窗口首页布局：`px-10` 改为响应式边距，三列能力卡片在窄宽度下降为一列或横向可读结构。`src/routes/index.tsx:38`、`src/routes/index.tsx:61`

## P2：动效与微交互

- [ ] 暂不引入动画库；优先用 Tailwind/CSS 完成 120–200ms 的 hover、press、focus、展开和状态切换，仅动画 `transform`/`opacity`，禁止 `transition: all`。
- [ ] 为创建 session、hook 执行、terminal 连接设计轻量状态连续性：按钮即时反馈 → 行内进度 → 成功/失败结果，避免装饰性整页入场动画。
- [ ] 拖拽会话时增加抬升、目标插入线和释放反馈；不得只靠颜色表达，键盘重排需有等价路径与公告。
- [ ] 所有动效遵守 `prefers-reduced-motion`；若后续出现跨区域编排、FLIP 重排或复杂时间线，再评估引入 Motion/GSAP，并以包体、清理和降级路径为准入条件。

## P2：布局、内容与平台细节

- [ ] 为侧栏名称、路径、命令和状态标签补齐 `min-w-0`、截断/换行策略；截断内容提供可访问的完整值查看方式。
- [ ] 对超过 50 项的 session、终端或文件列表使用虚拟化或 `content-visibility`，并验证滚动位置与键盘焦点不丢失。
- [ ] Dialog/Dropdown 的滚动容器增加 `overscroll-behavior: contain`；主要按钮增加 `touch-action: manipulation`，同时保留清晰的 focus-visible。
- [ ] 导航动作使用 Link，保留 Ctrl/Cmd 点击与中键行为；历史返回等真实命令继续使用 Button。`src/components/IconSidebar.tsx:98`
- [ ] 让可分享/可恢复的视图状态进入 URL 或持久化状态：配置 section、hook tab、当前 session/terminal；浏览器/窗口返回行为需可预测。
- [ ] 检查 `color-scheme`、系统主题同步与窗口主题色，保证原生控件、滚动条和 Electron 标题栏一致。

## UI E2E 验收门槛

- [ ] 执行 `docs/ui-e2e-acceptance-plan.md` 中的桌面双模式、窄窗口、键盘流、主题和视觉回归场景。
- [ ] 每个并行 Electron 实例同时设置独立 `--user-data-dir` 与 `AGENTDOCK_DEV_INSTANCE=1`。
- [ ] Playwright 加入 axe 阻断：无 serious/critical 可访问性违规；关键流程全程仅键盘可完成。
- [ ] 为 FilePicker、SessionCard、Terminal add menu、ConfigEditor 错误恢复分别补充回归 spec。
- [ ] 验收截图至少覆盖首页、空工作区、多 session、配置错误、hook 失败、删除确认、窄窗口和 reduced-motion。
- [ ] 本地通过 `bun run typecheck`、`bun run lint`、`bun run test`、`bun run test:e2e`；探索性用户测试按项目规则执行 `npx flue run user-agent`。

## 强制视觉 UI E2E 与用户视角探索

> 功能 E2E 通过不等于 UI/UX 验收通过。以下流程必须启动真实 Electron 应用、像用户一样完成任务，并以实际窗口截图为主要证据；不得只读代码、DOM、样式值或测试断言后宣布视觉验收完成。

### Round 1：真实用户探索

- [ ] 使用隔离实例启动构建产物：独立 `--user-data-dir` + `AGENTDOCK_DEV_INSTANCE=1`，记录 Git HEAD、dirty diff hash、应用版本、Windows 缩放、窗口尺寸、locale 和主题。
- [ ] 至少使用三类 Persona 串行探索：首次使用者（耐心低）、日常开发者（高频多任务）、细节敏感/键盘用户；不得让多个 Persona 共享运行状态。
- [ ] 先跑任务模式，再跑自由探索模式：任务模式验证固定关键旅程，自由探索用于发现测试作者没有预设的视觉和 UX 问题。
- [ ] 首次使用旅程：打开应用 → 理解首页 → 添加/打开项目 → 创建 session → 观察初始化 → 打开 terminal → 返回/切换项目。
- [ ] 日常工作旅程：多 session 切换与拖拽 → 多 terminal 新建/关闭/固定默认动作 → 查看端口 → 调整终端字号和字体 → 长时间停留后恢复操作。
- [ ] 配置旅程：打开 ConfigEditor → 添加/删除 resource、hook、port → 文件选择 → YAML 预览 → 保存成功 → 制造解析/保存错误 → 恢复并重试。
- [ ] 异常旅程：hook 失败与重试、terminal 连接中/断开、孤儿 worktree、删除确认、空列表、超长名称/路径/命令、大量 session、慢加载。
- [ ] 每 2–3 个动作以及每进入一个新页面、弹层、菜单或错误状态后重新截图和观察，不得只截流程起点与终点。
- [ ] 每个可滚动页面从顶部按约一个 viewport 的步长滚到底部逐屏截图，再返回原交互焦点；滚动触发懒加载或布局变化后重新检查。
- [ ] 记录用户行为证据：犹豫、误点、回退、重复寻找、看不到反馈、错误恢复失败、焦点丢失；UX 结论必须同时引用动作日志与对应截图。

### 截图矩阵

- [ ] 窗口尺寸至少覆盖 `1024×640`、`1280×800`、`1440×900`、`1920×1080`；额外验证接近应用允许的最小窗口。
- [ ] Windows 显示缩放至少抽查 100% 与 125%；若发布目标包含高分屏，再抽查 150%。
- [ ] 浅色和深色主题分别覆盖关键页面；切换主题后检查原生控件、滚动条、标题栏、terminal 与弹层是否一致。
- [ ] 中文和英文各覆盖一次主要旅程；使用超长项目名、session 名、路径、命令、错误信息检查截断、换行和布局扩张。
- [ ] 状态截图必须覆盖 loading、empty、success、warning、error、disabled、hover、pressed、selected、focus-visible、dragging、modal/menu open。
- [ ] 动效页面同时保留正常模式与 `prefers-reduced-motion` 截图/录像；不得用动画中间帧作为唯一视觉基线。

### 每张截图的人工/视觉模型检查表

- [ ] **边距与栅格**：窗口安全区、页边距、面板内边距、行列间距是否有一致节奏；相邻元素是否过挤或形成异常大空洞。
- [ ] **对齐**：标题、正文、图标、输入框、按钮、状态点、端口数字是否落在共同基线/网格；不同页面同类控件是否跳位。
- [ ] **排版**：字体角色、字号、字重、行高、每行长度、数字等宽、中文/英文混排是否清晰；是否存在截断、孤行、拥挤或层级倒置。
- [ ] **配色**：背景/表面/边框/文本/状态色是否协调；primary、selected、warning、danger 是否能区分；对比度是否足够且不只靠颜色传意。
- [ ] **视觉层级**：用户第一眼是否知道当前项目、session、terminal、主要任务和下一步；辅助信息是否抢夺主操作注意力。
- [ ] **组件一致性**：按钮高度、圆角、边框、阴影、图标尺寸、hover/focus/disabled 状态是否遵循统一 token；是否残留旧 CSS 视觉语言。
- [ ] **空间与密度**：首页不能松散空洞，工作区不能拥挤；高频信息密度提高时仍需保持可扫描性和明确分组。
- [ ] **响应式与溢出**：缩窄窗口时不得遮挡、重叠、横向意外滚动或隐藏关键按钮；弹层不得超出可视区，长内容必须可滚动。
- [ ] **可点击性与反馈**：可交互元素是否一眼可辨；点击、键盘操作、拖拽、保存、创建、删除后是否立即出现与动作匹配的反馈。
- [ ] **任务连续性**：弹层关闭后焦点是否返回，切换 session 是否保留上下文，错误是否告诉用户发生什么、影响什么、下一步怎么做。
- [ ] **真实内容压力**：不得只用短占位符验收；必须使用真实长度的路径、命令、项目名、端口、错误栈和多条数据。
- [ ] **审美整体性**：检查 Worktree Rail、色彩、字体、图标和微交互是否形成 AgentDock 自有语言，而非页面分别像不同模板。

### 证据、分级与报告

- [ ] 每个发现必须记录 Persona、任务步骤、窗口尺寸/缩放/主题、复现动作、截图路径、可见证据、用户影响、严重度与置信度。
- [ ] S0/S1/S2/S3 按用户影响分级；遮挡关键操作的视觉问题可以是 S1，轻微对齐/配色问题通常为 S3。
- [ ] 将“明确遮挡、裁切、溢出、低对比、无反馈”等可观察缺陷列为 Confirmed；主观配色、风格和审美判断默认列为 Candidate，需设计评审确认。
- [ ] 报告必须包含逐页面截图索引、问题标注图或坐标说明、复现步骤、建议修复方向，以及未覆盖场景和基础设施限制。
- [ ] 基础设施失败（应用未启动、端口冲突、Playwright/浏览器缺失）标记 `INCONCLUSIVE`，不得计为产品 bug，也不得视为通过。
- [ ] 截图、事件日志、窗口/焦点摘要和报告保存在版本化运行目录；敏感路径、用户名和终端内容在共享报告前脱敏。

### Round 2：修复后同条件对比

- [ ] 冻结 Round 1 的 Persona、Story、seed、locale、主题、窗口尺寸、缩放与初始数据；Round 2 必须复用相同条件。
- [ ] 对每个目标问题先跑最短复现路径，再完整执行关键旅程；生成 before/after 并排图或可叠加对比图。
- [ ] “本轮没有看到”不等于修复；必须到达相同步骤、状态和 viewport，且功能断言与视觉检查同时通过。
- [ ] 验收结果只能为 `VERIFIED_FIXED`、`PARTIALLY_FIXED`、`NOT_FIXED`、`REGRESSION` 或 `INCONCLUSIVE`，并说明依据。
- [ ] 不得出现新的 S0/S1、关键路径回归、明显布局漂移或主题/语言回归；否则整轮视觉 UI E2E 不通过。

## 完成定义

- [ ] 上述 P0 全部完成，且无鼠标条件下核心任务可完成。
- [ ] 视觉 token、组件状态和中英文规则有单一来源，不再依赖页面级覆盖维持一致性。
- [ ] 新增交互具备 loading、empty、error、disabled、focus、reduced-motion 状态。
- [ ] UI E2E、axe、视觉快照与探索性用户测试均留存可复核报告和截图。
