# SSE 竞态问题调试记录

## 现象

先点击删除 session，在删除过程中点击添加 session，新 session 不能第一时间显示创建阶段进度（steps 空白），要等删除完全结束后才有进度显示。

## 调试过程

### Step 1: 分析日志

服务器日志：

```
t=0      [SessionLifecycle] izGyG-G- → removeWorktree ✓
t=~16s   [SessionLifecycle] izGyG-G- → remove complete ✓ 16493ms
t=~16s   [SessionLifecycle] CX87P_So → create "Session 8"
```

关键线索：`removeWorktree ✓` 日志瞬间打出，但此后 16 秒才出现 create 日志。**日志语句和执行之间的时间去哪了？**

### Step 2: 找出阻塞点

查看 `plugins/worktree.ts` 中的 `removeWorktree`：

```typescript
export function removeWorktree(projectPath, sessionId, force) {
  // ...
  execSync(`git worktree remove ...`);  // 同步阻塞
  execSync(`git branch -D ...`);        // 同步阻塞
  rmSync(worktreePath);                  // 同步阻塞
  return { removed: worktreePath };
}
```

`execSync` 和 `rmSync` 是 Node.js **同步 API**，调用期间事件循环完全冻结，服务器无法处理任何请求。

### Step 3: 确认影响范围

`session-lifecycle.ts` 的 `remove()` 调用 `removeWorktree()` 后经历 16 秒的 `git worktree remove` 同步阻塞：

```typescript
// session-lifecycle.ts 的 remove() 函数
emit(onStep, { step: "removeWorktree", status: "running" });
removeWorktree(projectPath, sessionId, true);  // ❄️ 内部 execSync 阻塞 16 秒
log(sessionId, "removeWorktree ✓");            // ← 日志先打出
emit(onStep, { step: "removeWorktree", status: "done" }); // ← step 也是立即发出
```

这 16 秒内：
- CREATE 请求排队，SSE 流发不出
- 用户看到创建中的 session 但 steps=[]，进度空白

### Step 4: 检查前端缓存 — 发现第二个问题

查看 `src/lib/queries.ts`，两个 SSE mutation 的 `onSuccess` 都用了 `invalidateQueries()`：

```typescript
onSuccess: () => {
  queryClient.invalidateQueries({ queryKey: queryKeys.projects }); // ❌
}
```

`invalidateQueries` 触发服务端全量重拉。如果 delete 先完成而 create 还在 SSE 流中，服务端返回的数据不包含 temp session，缓存中的 CreatingSession 被覆盖，后续 step 事件也找不到 tempId。

## 修复方案

### 问题一：`execSync` 阻塞事件循环

**根因**：`execSync` / `rmSync` 是同步 API，大仓库上 `git worktree remove` 耗时可达 10-15 秒

**修复**：`plugins/worktree.ts`

| 改前 | 改后 |
|---|---|
| `execSync(...)` | `await execAsync(...)`（`util.promisify(exec)`） |
| `rmSync(path, ...)` | `await rm(path, ...)`（`fs/promises`） |
| `isRegisteredWorktree()` 同步 | `async` + `await execAsync(...)` |

连带改动：
- `plugins/session-lifecycle.ts` — 调用处加 `await`
- `plugins/api.ts` — 调用处加 `await`
- `plugins/__tests__/worktree.test.ts` — 13 个测试改为 `async`

### 问题二：`invalidateQueries` 冲掉乐观状态

**根因**：`onSuccess` 中的 `invalidateQueries` 触发全量重拉，正在创建中的 temp session 被服务端返回数据覆盖

**修复**：`src/lib/queries.ts`

```typescript
// useCreateSessionSSE.onSuccess — 替换 temp session
onSuccess: (session, { projectId, tempId }) => {
  queryClient.setQueryData(queryKeys.projects, (old) => {
    // ...用真实 session 替换 temp session
  });
},

// useDeleteSessionSSE.onSuccess — 直接移除
onSuccess: (_data, { sessionId, projectId }) => {
  queryClient.setQueryData(queryKeys.projects, (old) => {
    // ...filter 移除已删 session
  });
},
```

## 验证

### 单元测试

```bash
bun run test
# 206 passed, 12 test files, 0 failures
```

### e2e 浏览器验证

打开浏览器 → 点击删除 → 立即点添加 → 前端实时看到进度步骤 ✓ ✓ ✓ ✓

### 新增测试

| 文件 | 测试 | 说明 |
|---|---|---|
| `plugins/__tests__/api-integration.test.ts` | RACE1 | DELETE 中 execSync 阻塞时 CREATE 的延迟验证 |
| `plugins/__tests__/api-integration.test.ts` | RACE2 | 无阻塞时 CREATE 正常响应的对照测试 |
| `src/lib/__tests__/queries-sse.test.ts` | R1 | CreatingSession 在 delete onSuccess 后缓存存活验证 |
| `src/lib/__tests__/queries-sse.test.ts` | R2 | create onSuccess 只替换 temp session 不污染其他数据 |

## 教训

1. **Node.js 服务器中的同步 IO 操作要高度警惕** — `execSync`/`rmSync` 是事件循环杀手，在请求处理路径中必须用异步替代
2. **乐观更新 + SSE 流需要两层保护** — onMutate 插入临时状态 + onSuccess 直接操作缓存（避免 invalidate 冲掉并发操作）
3. **两个问题往往相互掩盖** — 用户看到"创建进度不显示"，实际可能是创建被阻塞（问题一）和进度被冲掉（问题二）的叠加效果。需要分别隔离验证
4. **日志时间线是调试第一武器** — 日志毫秒级时间戳直接暴露了 16 秒的"黑洞"，指向 `execSync`
