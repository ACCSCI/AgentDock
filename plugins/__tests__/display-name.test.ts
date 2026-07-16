/**
 * displayName 最小消毒 (新架构 §4.1 末段).
 */
import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX_LENGTH, sanitizeDisplayName } from "../display-name.js";

describe("sanitizeDisplayName (新架构 §4.1)", () => {
  it("空字符串/空值 → ''", () => {
    expect(sanitizeDisplayName("")).toBe("");
    expect(sanitizeDisplayName(null)).toBe("");
    expect(sanitizeDisplayName(undefined)).toBe("");
  });

  it("保留普通字符 (中英文/数字/标点)", () => {
    expect(sanitizeDisplayName("My Session 1")).toBe("My Session 1");
    expect(sanitizeDisplayName("会话 一")).toBe("会话 一");
    expect(sanitizeDisplayName("Feature-X")).toBe("Feature-X");
  });

  it("保留 emoji 与 unicode 标点", () => {
    expect(sanitizeDisplayName("🚀 deploy")).toBe("🚀 deploy");
    expect(sanitizeDisplayName("feat: 写文档")).toBe("feat: 写文档");
  });

  it("去除 \\\\x00-\\\\x1F 控制字符 (防终端转义注入)", () => {
    // ANSI red
    expect(sanitizeDisplayName("\x1B[31mRED\x1B[0m")).toBe("[31mRED[0m");
    // \n \r \t
    expect(sanitizeDisplayName("a\nb\rc\td")).toBe("abcd");
    // \b backspace
    expect(sanitizeDisplayName("a\x08b")).toBe("ab");
  });

  it("去除 \\\\x7F DEL", () => {
    expect(sanitizeDisplayName("a\x7Fb")).toBe("ab");
  });

  it("trim 首尾空白", () => {
    expect(sanitizeDisplayName("  hello  ")).toBe("hello");
    expect(sanitizeDisplayName("\t\nfoo\n\t")).toBe("foo");
  });

  it("长度上限 128, 超出截断", () => {
    const long = "a".repeat(200);
    const out = sanitizeDisplayName(long);
    expect(out.length).toBe(DISPLAY_NAME_MAX_LENGTH);
    expect(out).toBe("a".repeat(DISPLAY_NAME_MAX_LENGTH));
  });

  it("控制字符 + 截断组合", () => {
    // 200 字符里塞了 5 个 \n — 净化后变 195, 截到 128
    const s = `${"a".repeat(100)}\n\n\n\n\n${"b".repeat(95)}`;
    expect(sanitizeDisplayName(s).length).toBe(128);
  });

  it("完全由控制字符组成 → ''", () => {
    expect(sanitizeDisplayName("\n\r\t\x00\x1B")).toBe("");
  });

  it("不套 SESSION_ID_RE 字符集 (允许中文/emoji/空格)", () => {
    // §11.3 #7 — displayName 可含任意字符, 不会被路径/分支派生误用
    const dirty = "中文 / 路径 危险 字符 \x1B[31mred\x1B[0m";
    const out = sanitizeDisplayName(dirty);
    // 控制字符被剥, 中间内容保留
    expect(out).toBe("中文 / 路径 危险 字符 [31mred[0m");
  });
});
