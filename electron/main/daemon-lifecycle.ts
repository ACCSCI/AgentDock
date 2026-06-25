/**
 * Daemon lifecycle helpers — heartbeat, v2 sync loop, client register/unregister.
 *
 * Extracted from main.ts (Approach A: state stays in main.ts, passed as params).
 */
import process from "node:process";
import { log } from "../../plugins/logger.js";
import type { DaemonHonoClient } from "./hono-client.js";

// Heartbeat: every 30 s. Daemon's HEARTBEAT_TIMEOUT_MS is 90 s, so
// missing two heartbeats marks us stale and the daemon releases our
// sessions on the next cleanup tick. 30 s aligns with daemon's
// HEARTBEAT_PERSIST_INTERVAL_MS so every successful beat persists.
export const HEARTBEAT_INTERVAL_MS = 30_000;

export async function registerClientWithDaemon(
  daemonClient: DaemonHonoClient | null,
  clientId: string,
): Promise<void> {
  if (!daemonClient) return;
  try {
    const res = await daemonClient.client.register.$post({
      json: { clientId, pid: process.pid, projectPaths: [process.cwd()] },
    });
    if (!res.ok) {
      log.warn({ status: res.status }, "client/register non-2xx");
    }
  } catch (err) {
    log.warn({ err }, "client/register failed");
  }
}

export function startHeartbeatLoop(
  daemonClient: DaemonHonoClient | null,
  clientId: string,
  existingTimer: ReturnType<typeof setInterval> | null,
): ReturnType<typeof setInterval> {
  if (existingTimer) clearInterval(existingTimer);
  const timer = setInterval(() => {
    if (!daemonClient) return;
    void daemonClient.client.heartbeat
      .$post({ json: { clientId } })
      .catch((err) => log.warn({ err }, "heartbeat failed"));
  }, HEARTBEAT_INTERVAL_MS);
  // Don't keep the event loop alive just for heartbeats during shutdown.
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * §7 — v2 path 30s sync loop (兼 heartbeat). SSE 推送增量, /sync
 * 提供全量兜底 + 维持 daemon 端 client 活性 (HEARTBEAT_TIMEOUT 90s).
 * v2 路径不走 v1 /client/heartbeat, 因此**必须**有自己的周期调用.
 *
 * P0+ (二审修): lastSeq 改为从 sseConsumer.getLastSeq() 读取真实水位,
 * 避免 daemon 端 replaySince(0) 在重启后回放大量历史事件。
 * 用 accessor 函数而非快照值, 让 SSE 重连 resetSeq() 后下一 tick 自动生效.
 */
export function startV2SyncLoop(
  daemonPort: number,
  getLastSeq: () => number,
  clientId: string,
  existingTimer: ReturnType<typeof setInterval> | null,
): ReturnType<typeof setInterval> {
  if (existingTimer) clearInterval(existingTimer);
  const tick = async (): Promise<void> => {
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          pid: process.pid,
          lastSeq: getLastSeq(),
        }),
      });
      if (!res.ok) {
        log.debug({ status: res.status }, "v2 /sync non-2xx");
      }
    } catch (err) {
      // 网络错: 静默 — SSE 还在跑, 30s 后重试
      log.debug({ err }, "v2 /sync failed");
    }
  };
  const timer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
  if (typeof timer.unref === "function") timer.unref();
  // 立即跑一次, 不等 30s
  void tick();
  return timer;
}

export async function unregisterClientWithDaemon(
  daemonClient: DaemonHonoClient | null,
  clientId: string,
): Promise<void> {
  if (!daemonClient) return;
  try {
    await daemonClient.client.unregister.$post({ json: { clientId } });
  } catch (err) {
    log.warn({ err }, "client/unregister failed (non-fatal at shutdown)");
  }
}
