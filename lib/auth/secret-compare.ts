import { timingSafeEqual } from "node:crypto";

/**
 * So sánh bí mật (secret webhook, cron secret) với THỜI GIAN KHÔNG PHỤ THUỘC NỘI DUNG.
 *
 * `===` trên chuỗi dừng ở ký tự sai đầu tiên; kẻ dò có thể đo chênh lệch thời gian để đoán dần
 * từng ký tự. Với bí mật nằm trên URL/webhook công khai, đó là đường tấn công rẻ nhất còn sót lại.
 * Độ dài khác nhau thì trả `false` ngay — độ dài của bí mật không phải thứ cần giấu.
 */
export function secretEquals(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Một trong nhiều ứng viên (header / query / body) khớp bí mật kỳ vọng. */
export function anySecretMatches(candidates: readonly (string | null | undefined)[], expected: string | null | undefined): boolean {
  if (!expected) return false;
  return candidates.some((c) => secretEquals(c, expected));
}
