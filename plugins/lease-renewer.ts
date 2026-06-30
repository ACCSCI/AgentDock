// @ts-nocheck
/**
 * Lease renewer — keeps the daemon's per-session progress lease warm
 * (新架构 §4.4).
 *
 *   一个 creating/deleting 条目被判为"卡死可接管", 当且仅当:
 *     1. 该 session 的 owner 实例心跳已超时(HEARTBEAT_TIMEOUT 90s); AND
 *     2. 该 session 的 progress lease 已过期(leaseExpiresAt < now).
 *
 *   任一活性信号仍在 → 视为进行中, 对账跳过(§4.3 C1/C2 的"否则"分支)。
 *   两者都死 → 接管。
 *
 * 租约绑定"生命周期执行器", 不绑定单个 hook 子进程。执行器是 owner
 * 实例里跑完整 create/delete 事务的那个 async 函数(依次跑各阶段多个
 * hook、再跑物理清理与句柄轮询)。它启动 setInterval 每
 * LEASE_RENEW_INTERVAL 调 POST /session/heartbeat, Daemon 刷新
 * leaseExpiresAt = now + LEASE_TTL; 执行器函数 settle 时清除 interval。
 *
 * 双信号死亡(§4.4):
 *   - 实例整个崩溃/进程被 kill → 执行器没了 → 续约停 + 心跳断 → 双死
 *   - 续约期任意阶段异常(hook 抛错、超时): 续约照常进行, 主流程 catch
 *     后清除 interval。
 *
 * 续约失败处理: 连续 N 次失败后停止续约(避免 daemon 死锁时无限重试),
 * 但不传播错误(主流程继续, 让 owner 后续 releaseSession 走 fresh daemon)。
 */
import { log } from "./logger.js";
import {
  HEARTBEAT_TIMEOUT_MS,
  LEASE_RENEW_INTERVAL_MS,
  LEASE_TTL_MS,
} from "./constants.js";

/**
 * POST /session/heartbeat 入参 (新架构 §13.1).
 */
export interface HeartbeatRequest {
  sessionId: string;
  fencingToken: number;
  phase?: "creating" | "deleting";
}

/**
 * 续约器依赖。fetchHeartbeat 是 POST /session/heartbeat 的薄包装。
 */
export interface LeaseRenewerDeps {
  /** POST /session/heartbeat 调用; 返回 success boolean(忽略 body). */
  fetchHeartbeat: (req: HeartbeatRequest) => Promise<boolean>;
  /** 可选: 续约成功回调(用于打点 / 诊断)。*/
  onRenewed?: (sessionId: string) => void;
  /** 可选: 续约连续失败达到上限时触发(用于清理。返回 true 表示 caller 已处理, 不再抛)。*/
  onExhausted?: (sessionId: string) => void;
  /** 可选: 注入的 setInterval (tests). */
  setIntervalImpl?: typeof setInterval;
  /** 可选: 注入的 clearInterval (tests). */
  clearIntervalImpl?: typeof clearInterval;
  /** 续约间隔, 默认 LEASE_RENEW_INTERVAL_MS (5s). */
  intervalMs?: number;
  /** 失败次数上限, 默认 3. */
  failureBudget?: number;
}

export interface ActiveLease {
  /** 刷新一次(manual kick, 立即调一次 heartbeat).  */
  kick(): Promise<void>;
  /** 停止续约(主流程 settle 时调用)。 */
  stop(): void;
  /** 检查是否仍在续约。 */
  isActive(): boolean;
}

const DEFAULT_FAILURE_BUDGET = 3;

/**
 * 启动一个 5s 周期的 lease 续约器。返回的 ActiveLease.stop() 必须被调用
 * (用 try/finally 包在主流程外层, 避免主流程异常时 timer 残留)。
 *
 * 使用例:
 *
 *   const lease = startLeaseRenewal({
 *     sessionId, fencingToken, phase: "creating",
 *     fetchHeartbeat: (req) => fetch(...).then(r => r.ok),
 *   });
 *   try {
 *     // ... 主流程 ...
 *   } finally {
 *     lease.stop();
 *   }
 */
export function startLeaseRenewal(
  args: { sessionId: string; fencingToken: number; phase: "creating" | "deleting" } & LeaseRenewerDeps,
): ActiveLease {
  const {
    sessionId,
    fencingToken,
    phase,
    fetchHeartbeat,
    onRenewed,
    onExhausted,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
    intervalMs = LEASE_RENEW_INTERVAL_MS,
    failureBudget = DEFAULT_FAILURE_BUDGET,
  } = args;

  let timer: ReturnType<typeof setInterval> | null = null;
  let failureCount = 0;
  let stopped = false;
  let inFlight = false;

  const doKick = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) return; // skip overlapping calls
    inFlight = true;
    try {
      const ok = await fetchHeartbeat({ sessionId, fencingToken, phase });
      if (stopped) return;
      if (ok) {
        failureCount = 0;
        onRenewed?.(sessionId);
        return;
      }
      // Non-OK: count as failure but don't stop immediately — 偶尔 transient。
      failureCount++;
    } catch (err) {
      // Network error / etc — count as failure.
      failureCount++;
      log.warn({ err, sessionId, failureCount }, "lease heartbeat threw");
    } finally {
      inFlight = false;
    }
    if (failureCount >= failureBudget) {
      log.warn(
        { sessionId, failureCount, budget: failureBudget },
        "lease heartbeat failure budget exhausted — stopping",
      );
      onExhausted?.(sessionId);
      stop();
    }
  };

  timer = setIntervalImpl(() => {
    void doKick();
  }, intervalMs);
  // Don't keep the event loop alive just for heartbeats during shutdown.
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref?: () => void }).unref?.();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
  }

  return {
    kick: doKick,
    stop,
    isActive: () => !stopped,
  };
}

/**
 * 把一个异步执行器包在 lease 续约器里。流程:
 *   1. 启动 setInterval 每 intervalMs 调 fetchHeartbeat。
 *   2. await inner() — 主流程(可能跑几分钟)。
 *   3. 无论 inner() resolve/reject, finally 里 stop() 续约器。
 *
 *   inner throw 时 lease 续约会停, 后续对账(§4.4)按"主流程异常"分类:
 *   - 若是 creating 半成品 → 走 C1 rollback(由 reconciler 判定)。
 *   - 若是 deleting 半成品 → 走 C2 接管(由 reconciler 续删)。
 *
 * 续约期间任何阶段 throw 不会影响主流程错误传播 — 续约只关心 lease 本身。
 */
export async function withLeaseRenewal<T>(
  args: { sessionId: string; fencingToken: number; phase: "creating" | "deleting"; inner: () => Promise<T> } & LeaseRenewerDeps,
): Promise<T> {
  const { inner, ...rest } = args;
  const lease = startLeaseRenewal(rest);
  try {
    return await inner();
  } finally {
    lease.stop();
  }
}

/** 仅诊断 — 把常量透出, 方便 caller / 单测引用。 */
export const LEASE_CONSTANTS = {
  LEASE_TTL_MS,
  LEASE_RENEW_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} as const;
