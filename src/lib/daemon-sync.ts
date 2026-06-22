/**
 * Renderer-side mirror of electron/main/sync-applier.ts.
 *
 * Implements the §7.3 / §11.3 #8 snapshot+stream ordering rule:
 *   1. Apply a /sync snapshot, recording its snapshotSeq.
 *   2. Apply SSE events with seq > snapshotSeq; discard the rest.
 *   3. All event applications are idempotent (see per-event-type handlers).
 *
 * The Electron main process holds the source-of-truth SyncApplier (in
 * electron/main/sync-applier.ts). This renderer module reuses the same
 * data shape so that the two stay in lockstep — both are unit-tested
 * against the same invariant suite.
 *
 * Why two implementations: the renderer's React tree can't import from
 * electron/main/ (that's main-process code with Node-only deps). Both
 * implementations are pure and share the same semantics.
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

export interface SseEvent {
  event: string;
  seq: number;
  data: unknown;
}

export interface AppliedState {
  sessions: Map<string, V2SyncSnapshot["sessions"][number]>;
  owners: Map<string, V2SyncSnapshot["owners"][number]>;
  ports: Map<number, { sessionId: string; name: string }>;
  appliedSeq: number;
  snapshotSeq: number | null;
  discardedCount: number;
  appliedEventCount: number;
}

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

export function applySnapshot(
  state: AppliedState,
  snapshot: V2SyncSnapshot,
): AppliedState {
  const next = emptyState();
  next.snapshotSeq = snapshot.snapshotSeq;
  next.appliedSeq = Math.max(state.appliedSeq, snapshot.snapshotSeq);
  for (const s of snapshot.sessions) next.sessions.set(s.sessionId, s);
  for (const o of snapshot.owners) next.owners.set(o.sessionId, o);
  for (const p of snapshot.ports) {
    next.ports.set(p.port, { sessionId: p.sessionId, name: p.name });
  }
  return next;
}

export function dispatchEvent(
  state: AppliedState,
  event: SseEvent,
): AppliedState {
  if (state.snapshotSeq === null) return applyEventUnchecked(state, event);
  if (event.seq <= state.snapshotSeq) {
    return { ...state, discardedCount: state.discardedCount + 1 };
  }
  return applyEventUnchecked(state, event);
}

function applyEventUnchecked(
  state: AppliedState,
  event: SseEvent,
): AppliedState {
  const next: AppliedState = {
    ...state,
    appliedEventCount: state.appliedEventCount + 1,
    appliedSeq: Math.max(state.appliedSeq, event.seq),
  };
  switch (event.event) {
    case "session-created": {
      const d = event.data as { sessionId?: string; displayName?: string };
      if (!d?.sessionId) return next;
      const cur = next.sessions.get(d.sessionId);
      if (cur) {
        next.sessions.set(d.sessionId, { ...cur, displayName: d.displayName ?? cur.displayName });
      } else {
        next.sessions.set(d.sessionId, {
          sessionId: d.sessionId,
          projectRoot: "",
          displayName: d.displayName ?? d.sessionId.slice(0, 8),
          status: "active",
          createdAt: Date.now(),
          ports: {},
        });
      }
      return next;
    }
    case "session-renamed": {
      const d = event.data as { sessionId?: string; newDisplayName?: string };
      if (!d?.sessionId || !next.sessions.has(d.sessionId)) return next;
      const cur = next.sessions.get(d.sessionId)!;
      next.sessions.set(d.sessionId, { ...cur, displayName: d.newDisplayName ?? cur.displayName });
      return next;
    }
    case "session-purged": {
      const d = event.data as { sessionId?: string };
      if (!d?.sessionId) return next;
      const session = next.sessions.get(d.sessionId);
      next.sessions.delete(d.sessionId);
      next.owners.delete(d.sessionId);
      if (session) {
        for (const port of Object.values(session.ports)) next.ports.delete(port);
      } else {
        for (const [port, rec] of next.ports) {
          if (rec.sessionId === d.sessionId) next.ports.delete(port);
        }
      }
      return next;
    }
    case "port-reassigned": {
      const d = event.data as {
        sessionId?: string;
        oldPort?: number;
        newPort?: number;
        ports?: Record<string, number>;
      };
      if (!d?.sessionId) return next;
      const session = next.sessions.get(d.sessionId);
      if (d.ports && session) {
        for (const port of Object.values(session.ports)) next.ports.delete(port);
        next.sessions.set(d.sessionId, { ...session, ports: { ...d.ports } });
        for (const [name, port] of Object.entries(d.ports)) {
          next.ports.set(port, { sessionId: d.sessionId, name });
        }
        return next;
      }
      if (typeof d.oldPort === "number" && typeof d.newPort === "number") {
        const oldRec = next.ports.get(d.oldPort);
        if (oldRec && oldRec.sessionId === d.sessionId) {
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
    case "heartbeat":
      return next;
    default:
      return next;
  }
}
