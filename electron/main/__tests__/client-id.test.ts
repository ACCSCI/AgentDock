/**
 * §6 clientId 进程级唯一性 (新架构 §6 末段).
 *
 * 架构要求: hostname + pid + 启动时间戳 + 随机后缀 (或直接 uuid).
 * 防跨进程撞 id → fencingToken 误判接管.
 */
import { describe, expect, it } from "vitest";
import { generateClientIdForTest } from "../client-id.js";

describe("generateClientId (新架构 §6 clientId 唯一性)", () => {
  it("contains hostname, pid, bootTime, and random suffix", () => {
    const id = generateClientIdForTest({
      hostname: "myhost",
      pid: 1234,
      bootTimeMs: 1_700_000_000_000,
      randomBytes: () => Buffer.from("abcd1234", "hex"),
    });
    // 形如: client_myhost_1234_1700000000000_abcd1234
    expect(id).toMatch(/^client_myhost_1234_1700000000000_abcd1234$/);
  });

  it("不同 randomBytes 产出不同 id (防同进程多次生成)", () => {
    const id1 = generateClientIdForTest({
      hostname: "h", pid: 1, bootTimeMs: 1, randomBytes: () => Buffer.from("aaaa", "hex"),
    });
    const id2 = generateClientIdForTest({
      hostname: "h", pid: 1, bootTimeMs: 1, randomBytes: () => Buffer.from("bbbb", "hex"),
    });
    expect(id1).not.toBe(id2);
  });

  it("不同 pid 产出不同 id (防跨进程撞)", () => {
    const mk = (pid: number) => generateClientIdForTest({
      hostname: "h", pid, bootTimeMs: 1, randomBytes: () => Buffer.from("aa", "hex"),
    });
    expect(mk(1)).not.toBe(mk(2));
  });

  it("hostname 包含非法字符时被替换为 _", () => {
    const id = generateClientIdForTest({
      hostname: "my host.local",
      pid: 1,
      bootTimeMs: 1,
      randomBytes: () => Buffer.from("aa", "hex"),
    });
    // space 和 . 被 _ 替换
    expect(id).toMatch(/^client_my_host_local_/);
  });

  it("空 hostname 降级为 'host' (防空字符串)", () => {
    const id = generateClientIdForTest({
      hostname: "...",
      pid: 1,
      bootTimeMs: 1,
      randomBytes: () => Buffer.from("aa", "hex"),
    });
    expect(id).toMatch(/^client_host_/);
  });
});
