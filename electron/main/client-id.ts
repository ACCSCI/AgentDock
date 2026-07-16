import { randomBytes } from "node:crypto";
/**
 * 客户端 ID 生成 (新架构 §6 末段).
 *
 *   进程级唯一: hostname + pid + 启动时间戳 + 随机后缀
 *
 * 不复用 sessionId (sessionId 是 session 身份, instance-id 是实例身份, 二者正交).
 * 也不复用 cwd (同 cwd 启动两个 Electron 实例 = 同一 clientId 会撞).
 */
import os from "node:os";
import process from "node:process";

/**
 * 主入口: 在 main 启动时调一次, 锁定 bootTimeMs 当时值.
 * 同一进程内多次调用会因 bootTimeMs + randomBytes 不同而产出不同 id (防
 * disconnect 重连等场景).
 */
let BOOT_TIME_MS = Date.now();

export function generateClientId(): string {
  return generateClientIdForTest({
    hostname: os.hostname(),
    pid: process.pid,
    bootTimeMs: BOOT_TIME_MS,
    randomBytes: (n) => randomBytes(n),
  });
}

/** 单测可见的纯函数版. */
export interface ClientIdDeps {
  hostname: string;
  pid: number;
  bootTimeMs: number;
  randomBytes: (n: number) => Buffer;
}

export function generateClientIdForTest(deps: ClientIdDeps): string {
  // 把非法字符替换为 _ (保留 _ 本身). 替换后若全是非字母数字字符
  // (即只剩下 _), 视作空 hostname 降级为 "host".
  const replaced = deps.hostname.replace(/[^a-zA-Z0-9-]/g, "_").slice(0, 32);
  const safeHost = replaced.replace(/_/g, "") ? replaced : "host";
  return ["client", safeHost, deps.pid, deps.bootTimeMs, deps.randomBytes(4).toString("hex")].join(
    "_",
  );
}

/** 测试钩子: 锁定 bootTimeMs (e.g. main 启动时一次). */
export function setBootTimeForTest(ms: number): void {
  BOOT_TIME_MS = ms;
}
