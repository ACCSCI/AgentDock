/**
 * v1 PortService builder — extracted from electron/main/ipc/sessions.ts so
 * v1 and v2 builders can sit side-by-side. P9 chooses between them based
 * on `process.env.AGENTDOCK_V2`.
 *
 * v1 protocol: POST /sessions/allocate (one-shot, returns full port map)
 * then POST /sessions/release. No fencingToken; no lease; no per-port
 * claim.
 */
import type {
  PortService,
  SessionPorts,
} from "../../../plugins/session-lifecycle.js";
import { log } from "../../../plugins/logger.js";
import type { DaemonHonoClient } from "../hono-client.js";

/**
 * Daemon-backed PortService. The session-lifecycle orchestrator needs
 * one for `allocatePorts` / port-release rollback — previously this
 * dep was omitted, so any successful `sessions:create` instantly hit
 * "portService is required" on the allocatePorts step.
 *
 * Both methods are thin wrappers around `POST /sessions/allocate` and
 * `POST /sessions/release` on the daemon. The clientId is the same
 * stable id from the IPC layer (so the daemon's ownership tracking
 * stays consistent).
 */
export function buildV1PortService(
  getDaemonClient: () => DaemonHonoClient | null,
  getClientId: () => string,
  projectPath: string,
): PortService {
  return {
    async allocateSession(params): Promise<SessionPorts> {
      const dc = getDaemonClient();
      if (!dc) throw new Error("daemon client not available");
      const res = await dc.sessions.allocate.$post({
        json: {
          clientId: getClientId(),
          sessionId: params.sessionId,
          projectPath,
          worktreePath: params.worktreePath,
          portKeys: params.portKeys,
        },
      });
      if (!res.ok) {
        throw new Error(`daemon /sessions/allocate failed: ${res.status}`);
      }
      const body = (await res.json()) as { ports: SessionPorts };
      return body.ports;
    },
    async releaseSession(sessionId: string): Promise<void> {
      const dc = getDaemonClient();
      if (!dc) return; // best-effort during rollback
      try {
        await dc.sessions.release.$post({
          json: { clientId: getClientId(), sessionId },
        });
      } catch (err) {
        log.warn({ err, sessionId }, "PortService.releaseSession failed");
      }
    },
  };
}