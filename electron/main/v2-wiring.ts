// @ts-nocheck
/**
 * v2 wiring — standalone async helpers for v2 reconnect/resync scenarios.
 *
 * Extracted from main.ts. `fullResyncAfterDisconnect` is called by the
 * SSE consumer when the TCP connection drops or the daemon explicitly
 * requests a resync (ring-buffer overflow / process restart).
 *
 * Extracted from main.ts (Approach A: state stays in main.ts, passed as params).
 */
import process from "node:process";
import { log } from "../../plugins/logger.js";
import type { V2PortServiceHandle } from "../../plugins/v2-port-service.js";
import { type AppliedState, type V2SyncSnapshot, applySnapshot } from "./sync-applier.js";

/**
 * §5.3 — 断线立即全量重注册.
 *
 * 触发: SseConsumer.onDisconnect (TCP 断开但 reconnect 未完成).
 * 步骤:
 *   1. POST /sync — 拿到 daemon 当前三表权威快照 (含 ports 数组).
 *   2. 对**所有**本地 active/creating session 调 /claim 重新注册
 *      (走 RECOVERING 闸门, expected 集合放行), 携带**当前端口作
 *      preferredPort** (从 /sync 响应的 ports 字段按 (sessionId, name)
 *      查找). 这样 daemon 端已知端口的 session 不会被换掉, RECOVERING
 *      窗口收不齐的场景 (daemon WAL 滞后) 也能让 client 主动重建.
 *   3. /claim 失败 (RECOVERING 期陌生 sessionId) 仅打 warn, 不抛 —
 *      SSE 重连后由后续增量 + onResyncRequired 继续收敛.
 *
 * 错误处理: 任何步骤失败仅打 warn, 不抛.
 *
 * @param daemonPort - The port the daemon is listening on.
 * @param v2 - The V2PortServiceHandle (null in v1 mode).
 * @param clientId - Stable client identifier.
 * @param getLastSeq - SSE consumer's current sequence watermark.
 * @param v2StateRef - Mutable reference to the AppliedState. The caller
 *   (main.ts) owns the actual variable; this function mutates it through
 *   a getter/setter pair so the caller always sees the latest value.
 * @param getV2State - Returns the current AppliedState.
 * @param setV2State - Replaces the current AppliedState.
 */
export async function fullResyncAfterDisconnect(
  daemonPort: number,
  v2: V2PortServiceHandle | null,
  clientId: string,
  getLastSeq: () => number,
  getV2State: () => AppliedState,
  setV2State: (s: AppliedState) => void,
): Promise<void> {
  if (!v2) return; // v1 模式或未启用 — 留给 v1 sync/declare 自己处理
  try {
    // P0+ — lastSeq 用 sseConsumer 真实水位, 避免 daemon replaySince(0)
    // 在长会话后回放数百条历史事件. SSE 重连时 resetSeq() 自动归零,
    // 下次断线重连会自然 fall back 到完整重同步.
    const syncRes = await fetch(`http://127.0.0.1:${daemonPort}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientId,
        pid: process.pid,
        lastSeq: getLastSeq(),
      }),
    });
    if (!syncRes.ok) {
      log.warn({ status: syncRes.status }, "§5.3 resync /sync non-OK");
      return;
    }
    const body = (await syncRes.json()) as {
      sessions: Array<{ sessionId: string; status: string }>;
      ports?: Array<{ port: number; sessionId: string; name: string }>;
      snapshotSeq?: number;
      owners?: Array<{ sessionId: string; clientId: string; pid: number; fencingToken: number }>;
    };
    // §7.3, §11.3 #8: Apply snapshot to SyncApplier state
    if (typeof body.snapshotSeq === "number") {
      setV2State(applySnapshot(getV2State(), body as V2SyncSnapshot));
      log.debug({ snapshotSeq: body.snapshotSeq }, "§7.3 applied snapshot to v2State");
    }
    // 索引: sessionId → (name → port). 给 /claim 携带 preferredPort 用.
    const portsBySid = new Map<string, Map<string, number>>();
    for (const p of body.ports ?? []) {
      let inner = portsBySid.get(p.sessionId);
      if (!inner) {
        inner = new Map();
        portsBySid.set(p.sessionId, inner);
      }
      inner.set(p.name, p.port);
    }
    // §5.3 — 对**所有**本地 active/creating session 走 /claim 重注册.
    const known = v2.listKnownSessions();
    for (const ks of known) {
      const portMap = portsBySid.get(ks.sessionId);
      log.info(
        {
          sessionId: ks.sessionId,
          portKeys: ks.portKeys,
          preferredPorts: portMap ? Object.fromEntries(portMap) : null,
        },
        "§5.3 re-claim session after disconnect",
      );
      for (const name of ks.portKeys) {
        const requestedPort = portMap?.get(name); // undefined = daemon 无记录
        try {
          const res = await fetch(`http://127.0.0.1:${daemonPort}/claim`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: ks.sessionId,
              fencingToken: ks.fencingToken,
              name,
              ...(requestedPort !== undefined ? { requestedPort } : {}),
            }),
          });
          if (!res.ok) {
            log.warn(
              { status: res.status, name, sessionId: ks.sessionId },
              "§5.3 re-claim failed (may be RECOVERING)",
            );
          }
        } catch (err) {
          log.warn({ err, name }, "§5.3 re-claim network failed");
        }
      }
    }
  } catch (err) {
    log.warn({ err }, "§5.3 full resync failed");
  }
}
