/**
 * Port runtime probe — 新架构 §3.5 末段.
 *
 *   运行态 (在跑/已停) 是"用时现查", 不是被维护的状态。真相就是子进程本身:
 *   UI 渲染时对外部端口临时 `net.connect` 探一下, 拿到三态结果:
 *     - "running":  连上 (有进程在 listen)
 *     - "stopped":  ECONNREFUSED (端口在 OS 层空闲)
 *     - "unknown":  超时 / 其它错误 (Windows 防火墙/AV 可能静默丢 SYN, 必
 *                   须短超时兜底, 否则拖到 OS 默认 ~21s; §3.5 末段)
 *
 *   探测**纯展示用途**, 结果绝不反向影响端口归属或触发回收 (见 §11.3 不变式 2).
 *
 *   超时常量 RUNTIME_PROBE_TIMEOUT_MS (默认 300ms) — 来自新架构 §11.5 表.
 */
import { connect, type Socket } from "node:net";
import { RUNTIME_PROBE_TIMEOUT_MS } from "../../plugins/constants.js";

export type RuntimeProbeState = "running" | "stopped" | "unknown";

export interface RuntimeProbeResult {
  state: RuntimeProbeState;
  /** ms 实测耗时 — 仅诊断 */
  elapsedMs: number;
}

export interface RuntimeProbeOptions {
  /** host to connect to. Default: 127.0.0.1. */
  host?: string;
  /** override timeout. Default: RUNTIME_PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** override connect (tests). */
  connectImpl?: typeof connect;
}

/**
 * probeRuntime — 三态 net.connect 探测 (§3.5 末段).
 *
 *   - 连上 → "running"
 *   - ECONNREFUSED → "stopped"
 *   - 超时 / 其它错误 → "unknown"  (UI 显中性态, 不阻塞渲染)
 */
export function probeRuntime(
  port: number,
  opts: RuntimeProbeOptions = {},
): Promise<RuntimeProbeResult> {
  const host = opts.host ?? "127.0.0.1";
  const timeoutMs = opts.timeoutMs ?? RUNTIME_PROBE_TIMEOUT_MS;
  const connectFn = opts.connectImpl ?? connect;
  const start = Date.now();

  return new Promise((resolve) => {
    let settled = false;
    const done = (state: RuntimeProbeState) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* already destroyed */
      }
      resolve({ state, elapsedMs: Date.now() - start });
    };

    const sock: Socket = connectFn({ port, host });

    const timer = setTimeout(() => done("unknown"), timeoutMs);

    sock.once("connect", () => {
      clearTimeout(timer);
      done("running");
    });

    sock.once("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (err.code === "ECONNREFUSED") {
        done("stopped");
      } else {
        // ETIMEDOUT, ENOTFOUND, EHOSTUNREACH, EACCES, 防火墙丢包… 全部 "unknown"
        done("unknown");
      }
    });
  });
}

/**
 * probeMultiple — 一次探测多个端口, 独立超时. 给 sidebar 端口指示用.
 */
export async function probeMultiple(
  ports: number[],
  opts: RuntimeProbeOptions = {},
): Promise<Map<number, RuntimeProbeResult>> {
  const out = new Map<number, RuntimeProbeResult>();
  await Promise.all(
    ports.map(async (p) => {
      out.set(p, await probeRuntime(p, opts));
    }),
  );
  return out;
}
