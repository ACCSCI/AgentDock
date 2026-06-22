/**
 * SyncApplier — snapshot + stream ordering (新架构 §7.3, §11.3 #8).
 *
 *   /sync 响应携带 snapshotSeq — 拍快照时的 SSE seq 水位。
 *   套用规则 = 快照打底 + 增量择新 (§11.3 #8)：
 *     1. 套用快照，覆盖本地 session/owner/port 表为 snapshot 内容。
 *     2. 之后到达的 SSE 增量事件, 只重放 seq > snapshotSeq 的(快照后发生的),
 *        丢弃 seq <= snapshotSeq 的(已被快照包含)。
 *     3. 幂等兜底: 所有增量 apply 必须幂等(port-reassigned 用 newPort 覆盖,
 *        port-released / session-purged 删存在即删, session-renamed 覆写
 *        displayName)。即便 snapshotSeq 缺失或误重放, 幂等也保证不出错。
 *
 * 此模块是**纯逻辑**, 不依赖 Electron、不依赖网络。Unit-test 友好。
 * Electron main 进程在 onResyncRequired 回调里拉一次 /sync 后, 把快照喂给
 * applySnapshot(); SSE 事件经过 dispatchEvent() 进入; 模块内部维护
 * snapshotSeq 阈值, 自动决定哪些事件被应用、哪些被丢弃。
 */
import { log } from "../../plugins/logger.js";

/**
 * 一条从 /sync 拿到的 snapshot. 字段与 daemon v2 /sync 响应保持一致。
 */
export interface V2SyncSnapshot {
  state: "RECOVERING" | "READY";
  snapshotSeq: number;
  serverTime: number;
  sessions: Array<{
    sessionId: string;
    projectRoot: string;
    displayName: string;
    status: "creating" | "active" | "deleting";
    createdAt: number;
    ports: Record<string, number>;
  }>;
  owners: Array<{
    sessionId: string;
    clientId: string;
    pid: number;
    fencingToken: number;
  }>;
  ports: Array<{ port: number; sessionId: string; name: string }>;
}

/**
 * 一条 SSE 事件. event 名按 §7.3 表, data 是 daemon 发的 JSON.
 */
export interface SseEvent {
  event: string;
  /** SSE 帧 id, 整数 seq. 0 / 缺失 = 不可排序事件(比如 resync-required). */
  seq: number;
  data: unknown;
}

/**
 * 增量 apply 后的本地状态。键化是便于 O(1) 查询 + 反映"当前可见集合"。
 */
export interface AppliedState {
  sessions: Map<string, V2SyncSnapshot["sessions"][number]>;
  owners: Map<string, V2SyncSnapshot["owners"][number]>;
  /** port 键化, 与 v2Sessions.ports 一起保证值一致。 */
  ports: Map<number, { sessionId: string; name: string }>;
  /** 当前已套用的最大 seq, 用于诊断 / 断线续连 Last-Event-ID. */
  appliedSeq: number;
  /** 最近一次 snapshot 的 snapshotSeq; null = 还没套过快照(增量直接放过, 等价于 snapshotSeq=0). */
  snapshotSeq: number | null;
  /** 累计丢弃的 event 数(因 seq <= snapshotSeq) — 仅诊断。 */
  discardedCount: number;
  /** 累计已应用的 event 数(因 seq > snapshotSeq)。*/
  appliedEventCount: number;
}

/**
 * 构造一个空的 AppliedState.
 */
export function emptyState(): AppliedState {
  return {
    sessions: new Map(),
    owners: new Map(),
    ports: new Map(),
    appliedSeq: 0,
    snapshotSeq: null,
    discardedCount: 0,
    appliedEventCount: 0,
  };
}

/**
 * 套用 snapshot. 覆盖式 — 任何现有状态被 snapshot 内容替换。
 * 记录 snapshotSeq 阈值, 之后到达的 seq <= snapshotSeq 的事件将被丢弃。
 */
export function applySnapshot(
  state: AppliedState,
  snapshot: V2SyncSnapshot,
): AppliedState {
  const next: AppliedState = emptyState();
  next.snapshotSeq = snapshot.snapshotSeq;
  next.appliedSeq = Math.max(state.appliedSeq, snapshot.snapshotSeq);

  for (const s of snapshot.sessions) {
    next.sessions.set(s.sessionId, s);
  }
  for (const o of snapshot.owners) {
    next.owners.set(o.sessionId, o);
  }
  for (const p of snapshot.ports) {
    next.ports.set(p.port, { sessionId: p.sessionId, name: p.name });
  }
  return next;
}

/**
 * 把一条 SSE 事件按 snapshot+stream 规则 apply 到 state 上。
 *
 * 关键规则:
 *   - snapshotSeq === null (还没套过快照): 直接 apply, 无需择新。
 *   - snapshotSeq !== null:
 *     - seq <= snapshotSeq: 丢弃(已被快照包含)。
 *     - seq > snapshotSeq: apply, 并尝试回填 session/owner/port。
 *
 * 幂等性: port-reassigned / port-released / session-purged / session-renamed
 * 全部幂等 — 重复 apply 不会破坏最终状态。
 */
export function dispatchEvent(
  state: AppliedState,
  event: SseEvent,
): AppliedState {
  // 还没套过快照: 直接 apply(等价于 snapshotSeq=0)。
  if (state.snapshotSeq === null) {
    return applyEventUnchecked(state, event);
  }
  // 已套过快照: 择新 — seq <= snapshotSeq 的丢弃。
  if (event.seq <= state.snapshotSeq) {
    return {
      ...state,
      discardedCount: state.discardedCount + 1,
    };
  }
  return applyEventUnchecked(state, event);
}

function applyEventUnchecked(state: AppliedState, event: SseEvent): AppliedState {
  const next: AppliedState = {
    ...state,
    appliedEventCount: state.appliedEventCount + 1,
    appliedSeq: Math.max(state.appliedSeq, event.seq),
  };

  switch (event.event) {
    case "session-created": {
      // { sessionId, displayName, branch }
      const d = event.data as { sessionId?: string; displayName?: string };
      if (!d?.sessionId) return next;
      if (next.sessions.has(d.sessionId)) {
        // 幂等: 已存在 → 合并 displayName (不覆盖其他字段)
        const cur = next.sessions.get(d.sessionId)!;
        next.sessions.set(d.sessionId, {
          ...cur,
          displayName: d.displayName ?? cur.displayName,
        });
      } else {
        next.sessions.set(d.sessionId, {
          sessionId: d.sessionId,
          projectRoot: "",
          displayName: d.displayName ?? d.sessionId.slice(0, 8),
          status: "active", // /session/activate 完成后才发此事件
          createdAt: Date.now(),
          ports: {},
        });
      }
      return next;
    }

    case "session-renamed": {
      // { sessionId, newDisplayName }
      const d = event.data as { sessionId?: string; newDisplayName?: string };
      if (!d?.sessionId || !next.sessions.has(d.sessionId)) return next;
      const cur = next.sessions.get(d.sessionId)!;
      next.sessions.set(d.sessionId, { ...cur, displayName: d.newDisplayName ?? cur.displayName });
      return next;
    }

    case "session-purged": {
      // { sessionId } — 整条 session + 其 owner + 它的所有 port 全部从三表移除。
      const d = event.data as { sessionId?: string };
      if (!d?.sessionId) return next;
      const session = next.sessions.get(d.sessionId);
      next.sessions.delete(d.sessionId);
      next.owners.delete(d.sessionId);
      if (session) {
        for (const port of Object.values(session.ports)) {
          next.ports.delete(port);
        }
      } else {
        // 即便没有 session 记录, 也清掉任何挂在该 sessionId 名下的 port
        for (const [port, rec] of next.ports) {
          if (rec.sessionId === d.sessionId) next.ports.delete(port);
        }
      }
      return next;
    }

    case "port-reassigned": {
      // { sessionId, oldPort, newPort } — port 整批重分配(用户主动 / 冲突)。
      // data 形态: { sessionId, ports?: Record<name, port> } 或 { sessionId, oldPort, newPort }
      const d = event.data as {
        sessionId?: string;
        oldPort?: number;
        newPort?: number;
        ports?: Record<string, number>;
      };
      if (!d?.sessionId) return next;
      const session = next.sessions.get(d.sessionId);
      if (d.ports) {
        // 整批模式(用户主动 reassign / create 后批量重分配)
        if (session) {
          // 先把旧 ports 从表里移除
          for (const port of Object.values(session.ports)) {
            next.ports.delete(port);
          }
          next.sessions.set(d.sessionId, { ...session, ports: { ...d.ports } });
        }
        for (const [name, port] of Object.entries(d.ports)) {
          next.ports.set(port, { sessionId: d.sessionId, name });
        }
        return next;
      }
      if (typeof d.oldPort === "number" && typeof d.newPort === "number") {
        // 单端口重分配
        const oldRec = next.ports.get(d.oldPort);
        if (oldRec) {
          next.ports.delete(d.oldPort);
          next.ports.set(d.newPort, { sessionId: oldRec.sessionId, name: oldRec.name });
          if (session) {
            const newPorts = { ...session.ports };
            for (const [k, v] of Object.entries(newPorts)) {
              if (v === d.oldPort) newPorts[k] = d.newPort;
            }
            next.sessions.set(d.sessionId, { ...session, ports: newPorts });
          }
        }
        return next;
      }
      return next;
    }

    case "port-released": {
      // { sessionId, port } — 单端口归还
      const d = event.data as { sessionId?: string; port?: number };
      if (!d?.sessionId || typeof d.port !== "number") return next;
      const rec = next.ports.get(d.port);
      if (rec && rec.sessionId === d.sessionId) {
        next.ports.delete(d.port);
        const session = next.sessions.get(d.sessionId);
        if (session) {
          const newPorts = { ...session.ports };
          for (const [k, v] of Object.entries(newPorts)) {
            if (v === d.port) delete newPorts[k];
          }
          next.sessions.set(d.sessionId, { ...session, ports: newPorts });
        }
      }
      return next;
    }

    case "ownership-revoked": {
      // { sessionId, newOwner, fencingToken } — 当前实例已被接管
      // 我们只把 owner 替换; session 状态保留。
      const d = event.data as { sessionId?: string; newOwner?: string; fencingToken?: number };
      if (!d?.sessionId) return next;
      const cur = next.owners.get(d.sessionId);
      if (cur) {
        next.owners.set(d.sessionId, {
          ...cur,
          clientId: d.newOwner ?? cur.clientId,
          fencingToken: d.fencingToken ?? cur.fencingToken,
        });
      }
      return next;
    }

    case "state-changed":
    case "resync-required":
      // 控制信号 — 不直接改动 state, 由 caller 决定(resync-required 触发新一次 applySnapshot)。
      log.debug({ event: event.event, seq: event.seq }, "control event");
      return next;

    default:
      log.warn({ event: event.event }, "unknown SSE event, ignored");
      return next;
  }
}

/**
 * 把 SSE 事件流 + 初始 snapshot 一起 apply 成最终 state。
 * 便捷函数 — 等价于:
 *   let s = emptyState();
 *   s = applySnapshot(s, snapshot);
 *   for (const ev of events) s = dispatchEvent(s, ev);
 *
 * 用于: 一次性 apply 一批历史事件(测试 / 断线重连回放)。
 */
export function applyAll(
  snapshot: V2SyncSnapshot | null,
  events: SseEvent[],
): AppliedState {
  let s = emptyState();
  if (snapshot) s = applySnapshot(s, snapshot);
  for (const ev of events) s = dispatchEvent(s, ev);
  return s;
}
