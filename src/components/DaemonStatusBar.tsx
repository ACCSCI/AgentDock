/**
 * DaemonStatusBar — 新架构 §2 + §11.1 UI observability surface.
 *
 * Renders the daemon's pid/port/protocolVersion/schemaVersion/state in a
 * thin strip at the top of the app. Polls `daemon:health` every 5s (cheap,
 * tiny payload) so the user sees live state during RECOVERING → READY
 * transitions.
 *
 * The `daemon-...` data-testids let E2E specs assert the status without
 * needing to scrape pixels.
 */
import { useEffect, useState } from "react";
import { TID } from "../lib/testids";

interface DaemonHealth {
  status: string;
  protocolVersion: string;
  schemaVersion: number;
  state: string;
  capabilities: string[];
  pid: number;
  port: number;
  startedAt?: number;
}

declare global {
  interface Window {
    api: {
      daemon: {
        health: () => Promise<DaemonHealth>;
        debugState: () => Promise<unknown>;
        faultInject: (path: string, body?: unknown) => Promise<unknown>;
      };
    };
  }
}

const POLL_INTERVAL_MS = 5_000;

export function DaemonStatusBar() {
  const [health, setHealth] = useState<DaemonHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      try {
        const h = await window.api.daemon.health();
        if (!cancelled) {
          setHealth(h);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    };
    fetchOnce();
    const id = setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div
        className="daemon-status-bar daemon-status-bar--error"
        data-testid={TID.daemonStatusBar}
        data-status="error"
      >
        <span data-testid={TID.daemonState}>down</span>
        <span data-testid={TID.daemonError}>{error}</span>
      </div>
    );
  }

  if (!health) {
    return (
      <div
        className="daemon-status-bar"
        data-testid={TID.daemonStatusBar}
        data-status="connecting"
      >
        <span data-testid={TID.daemonState}>connecting…</span>
      </div>
    );
  }

  const isReady = health.state === "READY";
  return (
    <div
      className={`daemon-status-bar${isReady ? "" : " daemon-status-bar--warn"}`}
      data-testid={TID.daemonStatusBar}
      data-status={isReady ? "ready" : "recovering"}
    >
      <span data-testid={TID.daemonState}>{health.state.toLowerCase()}</span>
      <span data-testid={TID.daemonPid}>pid {health.pid}</span>
      <span data-testid={TID.daemonPort}>port {health.port}</span>
      <span data-testid={TID.daemonProtocol}>v{health.protocolVersion}</span>
      <span data-testid={TID.daemonCapabilities}>
        {health.capabilities.length} caps
      </span>
    </div>
  );
}