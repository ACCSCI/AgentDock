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

function getStatusClass(state: string): string {
  switch (state) {
    case "READY":
      return "ready";
    case "RECOVERING":
      return "recovering";
    default:
      return "connecting";
  }
}

function getStateLabel(state: string): string {
  switch (state) {
    case "READY":
      return "Running";
    case "RECOVERING":
      return "Recovering";
    default:
      return "Connecting...";
  }
}

function buildTooltip(health: DaemonHealth): string {
  const capsList = health.capabilities || [];
  const caps = capsList.join(", ");
  return [
    "AgentDock 守护进程",
    `进程: PID ${health.pid} · 端口 ${health.port}`,
    `协议: v${health.protocolVersion} · Schema: v${health.schemaVersion}`,
    `功能: ${capsList.length}个 (${caps})`,
  ].join("\n");
}

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
        title={`守护进程离线\n错误: ${error}`}
      >
        <span className="daemon-status-dot" />
        <span className="daemon-status-label" data-testid={TID.daemonState}>
          Offline
        </span>
        <span className="daemon-status-sep" />
        <span className="daemon-status-info">
          <span data-testid={TID.daemonError}>{error}</span>
        </span>
      </div>
    );
  }

  if (!health) {
    return (
      <div
        className="daemon-status-bar daemon-status-bar--connecting"
        data-testid={TID.daemonStatusBar}
        data-status="connecting"
      >
        <span className="daemon-status-dot" />
        <span className="daemon-status-label" data-testid={TID.daemonState}>
          Connecting...
        </span>
      </div>
    );
  }

  const statusClass = getStatusClass(health.state);
  const stateLabel = getStateLabel(health.state);
  const isReady = health.state === "READY";
  const tooltip = buildTooltip(health);

  return (
    <div
      className={`daemon-status-bar daemon-status-bar--${statusClass}`}
      data-testid={TID.daemonStatusBar}
      data-status={isReady ? "ready" : "recovering"}
      title={tooltip}
    >
      <span className="daemon-status-dot" />
      <span className="daemon-status-label" data-testid={TID.daemonState}>
        {stateLabel}
      </span>

      {/* Hidden span for E2E compatibility */}
      <span className="sr-only" data-testid={TID.daemonPid}>
        pid {health.pid}
      </span>

      <span className="daemon-status-sep" />

      <span className="daemon-status-info" title={`守护进程通信端口: ${health.port}`}>
        <span className="daemon-status-icon">📋</span>
        <span>port</span>
        <span className="daemon-status-info-value" data-testid={TID.daemonPort}>
          {health.port}
        </span>
      </span>

      <span className="daemon-status-sep" />

      <span
        className="daemon-status-info"
        title={`协议版本: v${health.protocolVersion}\n功能: ${(health.capabilities || []).join(", ")}`}
      >
        <span className="daemon-status-icon">🔧</span>
        <span data-testid={TID.daemonProtocol}>v{health.protocolVersion}</span>
        <span>·</span>
        <span data-testid={TID.daemonCapabilities}>
          {(health.capabilities || []).length} caps
        </span>
      </span>
    </div>
  );
}
