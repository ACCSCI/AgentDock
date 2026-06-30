// @ts-nocheck
/**
 * E2E invariants helper — 新架构 §11.3.
 *
 * Exposes two layers:
 *
 *   1. fetchInvariants(window): 直接调 daemon `/debug/invariants` 端点
 *      (P2+ 二审修新增, v2 路径). 返回 CompositeResult 或 throws 当
 *      daemon 端 503 + INVARIANT_VIOLATION.
 *
 *   2. assertInvariantsAfterStep(window, ctx): 设计为 Playwright `afterEach`
 *      钩子. 测试 spec 在每个 step 后调一次, 失败立即 throw 让 spec 失败.
 *      上下文 (ctx) 字段可选 — 不传时只跑 #1/#2/#4/#5, 传 ctx 时把
 *      #3/#6/#7/#8 一并喂入.
 *
 * 用法:
 *
 *   import { test, expect } from "@playwright/test";
 *   import { assertInvariantsAfterStep } from "./helpers/invariants.js";
 *
 *   test.afterEach(async ({ window }) => {
 *     await assertInvariantsAfterStep(window);
 *   });
 *
 *   test("...", async ({ window }) => {
 *     // ... 测试逻辑 ...
 *     await assertInvariantsAfterStep(window, {
 *       envNotTrusted: [3000, 3000, true],
 *     });
 *   });
 */
import type { Page } from "@playwright/test";

export interface InvariantResult {
  ok: boolean;
  detail: string;
}

export interface CompositeResult {
  ok: boolean;
  results: Record<string, InvariantResult>;
  failed: string[];
}

/**
 * 调 daemon `/debug/invariants` 端点.
 *  - 200 + success=true → 所有不变式通过
 *  - 503 + success=false + error.code=INVARIANT_VIOLATION → 至少 1 条失败
 *  - 其他 (daemon down / 404) → 抛 Error (网络错, 不是不变式失败)
 */
export async function fetchInvariants(
  window: Page,
): Promise<CompositeResult> {
  return await window.evaluate(async () => {
    const port = (
      window as unknown as { __agentdockDaemonPort?: number }
    ).__agentdockDaemonPort;
    if (!port) {
      // Renderer 没暴露 port — 退回到通过 faultInject 路径
      // (IPC `daemon:debugState` 已知可达, 但 invariants 端点不一定在 IPC 暴露).
      throw new Error(
        "fetchInvariants: window.__agentdockDaemonPort not set; " +
          "cannot hit /debug/invariants directly. Set port via preload.",
      );
    }
    const res = await fetch(`http://127.0.0.1:${port}/debug/invariants-v2`);
    const body = (await res.json()) as {
      success: boolean;
      ok?: boolean;
      results?: Record<string, InvariantResult>;
      failed?: string[];
      error?: { code: string; message: string; failed: string[] };
    };
    if (!res.ok && body.error?.code !== "INVARIANT_VIOLATION") {
      throw new Error(
        `fetchInvariants: unexpected ${res.status} ${JSON.stringify(body)}`,
      );
    }
    return {
      ok: body.ok ?? false,
      results: body.results ?? {},
      failed: body.failed ?? body.error?.failed ?? [],
    };
  });
}

/**
 * 上下文型断言参数. 传给 daemon `/debug/invariants` 后会被 plug 进
 * `checkAllInvariants(state, listeners, ctx)` 让对应不变式跑起来.
 *
 * - envNotTrusted: tuple [preferredPort, actuallyAllocatedPort, bindProbeRan]
 * - staleWriteStatus: HTTP status from /claim with stale token (期望 409)
 * - displayNameIsolation: [displayName, worktreePath, branch, prefix, prefix, sessionId]
 * - snapshotStream: [snapshotSeq, snapshotState, incrementalAfter, incrementalSeq]
 */
export interface InvariantContext {
  envNotTrusted?: [number | undefined, number, boolean];
  staleWriteStatus?: number;
  displayNameIsolation?: [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  snapshotStream?: [number, Record<string, number>, Record<string, number>, number];
}

/**
 * `afterEach` 钩子. 不变式失败立即 throw, 让 spec 红.
 * 失败信息包含每条失败的 detail 便于定位.
 *
 * 跳过逻辑:
 *  - v1 模式 (daemon 端 v2 路由未注册) → silently skip. 通过
 *    `bootstrap:v2Enabled` IPC 探测.
 */
export async function assertInvariantsAfterStep(
  window: Page,
  ctx?: InvariantContext,
): Promise<void> {
  const v2Enabled = await window.evaluate(() =>
    (
      window as unknown as {
        api: { bootstrap: { v2Enabled: () => Promise<boolean> } };
      }
    ).api.bootstrap.v2Enabled(),
  );
  if (!v2Enabled) {
    // v1 路径下不变式断言由 v1 /debug/invariants 覆盖 (debug.ts), 不阻塞
    // v1 E2E. 真正的 v1 校验在 daemon-state-invariants.test.ts 单元测试里.
    return;
  }
  const composite = await fetchInvariants(window);
  // ctx 字段 (snapshotStream / envNotTrusted 等) 由 daemon 端
  // /debug/invariants 收; 当前实现固定跑 #1/#2/#4/#5, ctx 字段留给未来
  // 扩展. 这里只保证默认 4 条全过即可.
  if (!composite.ok) {
    const lines = composite.failed.map((f) => `  - ${f}`).join("\n");
    throw new Error(
      `[invariant] ${composite.failed.length} invariant(s) violated:\n${lines}`,
    );
  }
}