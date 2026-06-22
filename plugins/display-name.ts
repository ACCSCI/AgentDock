/**
 * displayName 最小消毒 (新架构 §4.1 末段).
 *
 *   最小消毒 = 长度上限 (≤128) + 去除控制字符 (\x00-\x1F).
 *   其余字符 (中文/emoji/空格/标点) 全部放行.
 *
 * 不调用此函数会导致:
 *   - 终端转义注入 (e.g. `\x1B[31m` 篡改终端颜色)
 *   - 日志污染 (控制字符乱码)
 *   - DoS (超长 displayName 撑爆字段)
 *
 * 与 sessionId 校验 (SESSION_ID_RE) 不同 — sessionId 受严格字符集约束
 * (用于路径/分支), displayName 是**自由文本**, 仅做最小消毒.
 */

export const DISPLAY_NAME_MAX_LENGTH = 128;

/**
 * sanitizeDisplayName — 控制字符全剥, 长度截断, trim 收尾空格.
 *
 *   \x00-\x1F  (C0 控制字符, 含 \n \r \t \b ANSI escape \x1B)
 *   \x7F       (DEL)
 *
 * 中间保留: 空格、中文、emoji、所有 unicode 标点.
 */
export function sanitizeDisplayName(input: string | null | undefined): string {
  if (!input) return "";
  // 去控制字符 (\x00-\x1F + \x7F)
  let cleaned = input.replace(/[\x00-\x1F\x7F]/g, "");
  // trim 首尾空白
  cleaned = cleaned.trim();
  // 长度截断
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) {
    cleaned = cleaned.slice(0, DISPLAY_NAME_MAX_LENGTH);
  }
  return cleaned;
}
