/**
 * useV2State — Renderer-side hook for daemon v2State IPC push.
 *
 * Implements §7.3: Subscribe to "daemon:v2State" IPC channel from main process,
 * reconstruct Maps from serialized tuple format, and maintain local AppliedState.
 *
 * Priority: v2State SSE push > 30s v2 sync loop > old query (fallback).
 */
import { useEffect, useRef, useState } from "react";
import type { AppliedState } from "../lib/daemon-sync";
import { emptyState, applySnapshot } from "../lib/daemon-sync";

// Serialized state from main process (Map entries as tuples)
interface SerializedV2State {
  sessions: Array<[string, { sessionId: string; projectRoot: string; displayName: string; status: string; createdAt: number; ports: Record<string, number> }]>;
  owners: Array<[string, { sessionId: string; clientId: string; pid: number; fencingToken: number }]>;
  ports: Array<[number, { sessionId: string; name: string }]>;
  snapshotSeq: number | null;
  appliedSeq: number;
}

// Public return type
export interface V2State {
  sessions: Map<string, SerializedV2State["sessions"][number][1]>;
  owners: Map<string, SerializedV2State["owners"][number][1]>;
  ports: Map<number, SerializedV2State["ports"][number][1]>;
  snapshotSeq: number | null;
  ready: boolean;
}

/**
 * Deserialize the tuple format back into Maps.
 */
function deserializeState(serialized: SerializedV2State): AppliedState {
  const state = emptyState();
  state.snapshotSeq = serialized.snapshotSeq;
  state.appliedSeq = serialized.appliedSeq;

  for (const [key, value] of serialized.sessions) {
    state.sessions.set(key, value);
  }
  for (const [key, value] of serialized.owners) {
    state.owners.set(key, value);
  }
  for (const [key, value] of serialized.ports) {
    state.ports.set(key, value);
  }

  return state;
}

/**
 * Convert AppliedState (Map-based) to V2State (also Map-based but ready for consumers).
 */
function toV2State(state: AppliedState): V2State {
  return {
    sessions: state.sessions,
    owners: state.owners,
    ports: state.ports,
    snapshotSeq: state.snapshotSeq,
    ready: state.snapshotSeq !== null,
  };
}

/**
 * Hook that subscribes to daemon v2State IPC push and maintains local state.
 *
 * Returns:
 * - sessions: Map<sessionId, SessionData>
 * - owners: Map<sessionId, OwnerData>
 * - ports: Map<port, PortData>
 * - snapshotSeq: number | null (null until first snapshot received)
 * - ready: boolean (true after first snapshot received)
 */
export function useV2State(): V2State {
  const [state, setState] = useState<AppliedState>(() => emptyState());
  const stateRef = useRef(state);

  useEffect(() => {
    // Check if window.api is available (running in Electron)
    if (!window.api?.daemon?.v2State?.subscribe) {
      return;
    }

    const unsubscribe = window.api.daemon.v2State.subscribe((serialized) => {
      // Deserialize the tuple format back into Maps
      const newState = deserializeState(serialized);

      // Update ref for synchronous access
      stateRef.current = newState;

      // Update React state
      setState(newState);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return toV2State(state);
}

/**
 * Check if v2State is available (running in Electron with daemon).
 */
export function isV2StateAvailable(): boolean {
  return typeof window !== "undefined" && !!window.api?.daemon?.v2State?.subscribe;
}
