/**
 * v2-state-bridge — Serialize AppliedState for IPC push to renderer.
 *
 * Converts the Map-based AppliedState into a plain-object format that can be
 * sent over Electron IPC via webContents.send("daemon:v2State", ...).
 *
 * This is a pure function with no Electron or network dependencies.
 */
import type { AppliedState } from "./sync-applier.js";

export interface SerializedV2State {
  sessions: Array<[string, AppliedState["sessions"] extends Map<string, infer V> ? V : never]>;
  owners: Array<[string, AppliedState["owners"] extends Map<string, infer V> ? V : never]>;
  ports: Array<[number, AppliedState["ports"] extends Map<number, infer V> ? V : never]>;
  snapshotSeq: number | null;
  appliedSeq: number;
}

/**
 * Convert an AppliedState (Map-based) into a plain-object format suitable for
 * IPC push to the renderer process.
 *
 * Maps are serialized as arrays of [key, value] tuples, which JSON.stringify
 * handles correctly and the renderer can reconstruct into Maps.
 */
export function serializeForPush(state: AppliedState): SerializedV2State {
  return {
    sessions: Array.from(state.sessions.entries()),
    owners: Array.from(state.owners.entries()),
    ports: Array.from(state.ports.entries()),
    snapshotSeq: state.snapshotSeq,
    appliedSeq: state.appliedSeq,
  };
}
