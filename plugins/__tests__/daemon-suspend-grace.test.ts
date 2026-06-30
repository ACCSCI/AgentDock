// @ts-nocheck
/**
 * §11.6 — 挂起/休眠一次性宽限 (防误回收).
 *
 * 笔记本合盖 / 系统休眠 / VM 挂起会让 client 进程被冻结, 唤醒后单调
 * 时钟跳变. cleanupStaleClients 内 detectSuspendAndMaybeSkip 比较两次
 * tick 之间的墙钟间隔, 异常大 (> 2 × SYNC_INTERVAL) 时返回 true,
 * 跳过本轮判定.
 */
import { describe, expect, it, vi } from "vitest";
import {
  detectSuspendAndMaybeSkip,
  resetSuspendDetector,
} from "../daemon/context.js";

describe("§11.6 挂起/休眠检测 (detectSuspendAndMaybeSkip)", () => {
  it("returns false on normal tick interval", () => {
    resetSuspendDetector();
    // 第一次调用: lastTickAt=now, gap=0 → false
    expect(detectSuspendAndMaybeSkip()).toBe(false);
  });

  it("returns true after a long wall-clock gap (simulating suspend)", async () => {
    resetSuspendDetector();
    // 第一次调用锁定 lastTickAt
    detectSuspendAndMaybeSkip();
    // 模拟 65s 过去 (> 2 × SYNC_INTERVAL = 60s)
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 65_000);
    expect(detectSuspendAndMaybeSkip()).toBe(true);
    vi.useRealTimers();
  });

  it("returns false for a normal inter-tick gap (e.g. 30s)", () => {
    resetSuspendDetector();
    detectSuspendAndMaybeSkip();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 30_000);
    // 30s 正好等于 SYNC_INTERVAL, 不超过 2× 阈值
    expect(detectSuspendAndMaybeSkip()).toBe(false);
    vi.useRealTimers();
  });

  it("after a suspend-skip, the next tick uses the new baseline", () => {
    resetSuspendDetector();
    detectSuspendAndMaybeSkip();
    vi.useFakeTimers();
    // 模拟挂起
    vi.setSystemTime(Date.now() + 65_000);
    expect(detectSuspendAndMaybeSkip()).toBe(true);
    // 紧接着一次正常 tick, 应当不报挂起(lastTickAt 已被刷新)
    vi.setSystemTime(Date.now() + 31_000);
    expect(detectSuspendAndMaybeSkip()).toBe(false);
    vi.useRealTimers();
  });
});
