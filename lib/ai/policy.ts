import { createHmac } from "node:crypto";
import { env } from "@/lib/env";

/**
 * ═══════════ CHÍNH SÁCH XÁC NHẬN HÀNH ĐỘNG GHI ═══════════
 *
 * AI đề nghị một hành động ghi ⇒ máy chủ phát một TOKEN = HMAC(người · tool · input chuẩn hoá).
 * Người bấm xác nhận ⇒ gửi lại token ⇒ máy chủ tính lại và so. Nhờ vậy:
 *  · không ai xác nhận hộ người khác (token gắn với userId);
 *  · UI không sửa được input sau khi AI đề nghị (đổi một ký tự là token khác);
 *  · token không mang dữ liệu, không cần lưu bí mật gì ngoài `AUTH_SECRET` đã có.
 */

/** JSON ổn định: khoá sắp xếp, không phụ thuộc thứ tự model gõ. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

export function actionToken(userId: string, toolName: string, input: unknown): string {
  return createHmac("sha256", env.authSecret).update(`${userId}\n${toolName}\n${stableStringify(input)}`).digest("hex").slice(0, 32);
}

export function verifyActionToken(token: string, userId: string, toolName: string, input: unknown): boolean {
  const expected = actionToken(userId, toolName, input);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

/** Giới hạn để một cuộc trò chuyện không thành đường vòng làm hàng loạt. */
export const COPILOT_LIMITS = {
  /** Số lượt gọi model trong MỘT câu hỏi (mỗi lượt có thể gọi nhiều tool). */
  maxRounds: () => Math.max(1, Math.min(10, env.ai.maxToolRounds)),
  /** Số hành động ghi AI được đề nghị trong một câu trả lời. */
  maxPendingActions: 5,
  /** Ký tự tối đa của một kết quả tool đưa lại cho model. */
  maxToolResultChars: 12_000,
  maxPromptChars: 4_000,
  maxAnswerChars: 8_000,
  maxHistoryTurns: 12,
} as const;
