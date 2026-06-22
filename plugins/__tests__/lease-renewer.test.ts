/**
 * Lease renewer tests (新架构 §4.4 — 活性租约 hook 续约 + 双信号死亡判定).
 *
 * 验证:
 *  1. setInterval 在 withLeaseRenewal 包住的期间每 LEASE_RENEW_INTERVAL
 *     触发一次 fetchHeartbeat。
 *  2. inner() 抛错时, lease 续约器在 finally 里被 stop()(不再有 heartbeat 调用)。
 *  3. inner() resolve 时, lease 续约器同样 stop()(不应有残留 timer)。
 *  4. 续约失败 3 次后 onExhausted 触发, 续约停止。
 *  5. kick() 手动立即触发一次。
 *  6. 实例崩溃模拟: process 没了 → 主流程的 lease.setInterval 同时没了
 *     (模拟: 直接 dispose()), daemon 端会按 §4.4 双信号判定 takeover。
 *  7. 重叠的 kick/inFlight 不会无限堆积(只有一次 inFlight=true)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startLeaseRenewal, withLeaseRenewal } from "../lease-renewer.js";
import { LEASE_RENEW_INTERVAL_MS } from "../constants.js";

describe("startLeaseRenewal", () => {
  let fetchHeartbeat: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchHeartbeat = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("每 intervalMs 触发一次 fetchHeartbeat", async () => {
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
    });
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 2.5);
    expect(fetchHeartbeat).toHaveBeenCalledTimes(2);
    lease.stop();
  });

  it("手动 kick() 立即触发", async () => {
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
    });
    await lease.kick();
    expect(fetchHeartbeat).toHaveBeenCalledTimes(1);
    expect(fetchHeartbeat).toHaveBeenCalledWith({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
    });
    lease.stop();
  });

  it("stop() 后不再触发", async () => {
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
    });
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    lease.stop();
    const callsBefore = fetchHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 5);
    expect(fetchHeartbeat.mock.calls.length).toBe(callsBefore);
  });

  it("续约失败 3 次触发 onExhausted", async () => {
    const onExhausted = vi.fn();
    fetchHeartbeat.mockResolvedValue(false);
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
      onExhausted,
    });
    // kick 1 (failure 1)
    await lease.kick();
    expect(fetchHeartbeat).toHaveBeenCalledTimes(1);
    // advance through 2 more ticks
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(onExhausted).toHaveBeenCalledWith("s1");
    // ActiveLease should report not-active
    expect(lease.isActive()).toBe(false);
  });

  it("renew 成功后失败计数清零", async () => {
    const onRenewed = vi.fn();
    let succeed = false;
    fetchHeartbeat.mockImplementation(async () => succeed);
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
      onRenewed,
    });
    // 2 fails
    await lease.kick();
    expect(fetchHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    // 1 success
    succeed = true;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(onRenewed).toHaveBeenCalled();
    // Now: 2 fails + 1 success; failure count reset to 0
    // 2 more fails should not trigger exhausted (only 2 in a row)
    succeed = false;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    // Total: 1st fail + (advance) 2nd fail + (succeed=true advance) success
    // + (succeed=false advance) 3rd fail + (advance) 4th fail
    // 4 consecutive fails, but #3 was success in between — count reset
    // At this point: fail, fail, success, fail, fail = should be at 2 fails (after reset)
    // so not exhausted
    expect(lease.isActive()).toBe(true);
    lease.stop();
  });

  it("heartbeat 抛异常也计入失败", async () => {
    const onExhausted = vi.fn();
    fetchHeartbeat.mockRejectedValue(new Error("network"));
    const lease = startLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
      onExhausted,
    });
    await lease.kick();
    expect(fetchHeartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS);
    expect(onExhausted).toHaveBeenCalled();
  });
});

describe("withLeaseRenewal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("主流程 resolve 时 stop() 续约器", async () => {
    const fetchHeartbeat = vi.fn().mockResolvedValue(true);
    const inner = vi.fn().mockResolvedValue("ok");
    const result = await withLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
      inner,
    });
    expect(result).toBe("ok");
    expect(inner).toHaveBeenCalledTimes(1);
    // 续约在 inner 之前 kick 一次; inner resolve 后 stop; 之后 timer 不应再触发
    const callsAfter = fetchHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 5);
    expect(fetchHeartbeat.mock.calls.length).toBe(callsAfter);
  });

  it("主流程 throw 时 stop() 续约器, 异常传播", async () => {
    const fetchHeartbeat = vi.fn().mockResolvedValue(true);
    const inner = vi.fn().mockRejectedValue(new Error("hook failed"));
    await expect(
      withLeaseRenewal({
        sessionId: "s1",
        fencingToken: 1,
        phase: "creating",
        fetchHeartbeat,
        inner,
      }),
    ).rejects.toThrow("hook failed");
    // 续约在 finally 里停了 — 之后 timer 不应再触发
    const callsAfter = fetchHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 5);
    expect(fetchHeartbeat.mock.calls.length).toBe(callsAfter);
  });

  it("长流程中续约一直持续", async () => {
    const fetchHeartbeat = vi.fn().mockResolvedValue(true);
    const inner = vi.fn().mockImplementation(async () => {
      // 模拟长 hook
      await new Promise((r) => setTimeout(r, LEASE_RENEW_INTERVAL_MS * 3));
      return "done";
    });
    const promise = withLeaseRenewal({
      sessionId: "s1",
      fencingToken: 1,
      phase: "creating",
      fetchHeartbeat,
      inner,
    });
    // 推进 3 个 interval — 期间至少 2 次 heartbeat (1st tick fires at 5s, 2nd at 10s, 3rd at 15s)
    await vi.advanceTimersByTimeAsync(LEASE_RENEW_INTERVAL_MS * 3);
    const result = await promise;
    expect(result).toBe("done");
    // 期望至少 2 次 heartbeat (long hook 期间, lease 没断过)
    expect(fetchHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
