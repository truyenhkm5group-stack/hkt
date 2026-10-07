/**
 * ═══════════ DẤU PHIÊN BẢN LỜI NHẮC TRÊN ĐƠN BOT CHỐT (Master Mission «Order Truth») — CHỈ MÁY CHỦ ═══════════
 *
 * Câu hỏi khi một đơn bị tranh cãi: «đơn này do lời nhắc nào, cấu hình nào, model nào, bản mã nào sinh ra?». Sổ sự kiện đã nối
 * đơn → hội thoại → sổ AI theo `ref` và mốc; còn thiếu chính cái đã ra lệnh chốt. Dấu này đi cùng `state.confirmed` (đặt ĐÚNG
 * lúc công cụ chốt chạy) rồi vào `payload.stamp` của sự kiện `order.confirmed`.
 *
 *  · Chỉ lưu DẤU BĂM — không chép nguyên văn lời nhắc vào sổ sự kiện (lời nhắc có hồ sơ shop, bài học, tên khách).
 *    Kiểm lại một đơn = dựng lại lời nhắc từ bản mã `codeVersion` + cấu hình rồi so `promptHash`.
 *  · `promptHash` băm lời nhắc hệ thống ĐÚNG như lượt đó gửi đi + tập công cụ; `configHash` băm cấu hình bot.
 *  · `codeVersion` = SHA deploy ghi (`lib/version.ts`); `null` = CHƯA BIẾT (chạy dev / thiếu `.env`), không bịa chuỗi.
 */
import { createHash } from "node:crypto";

export type PromptStamp = { promptHash: string; configHash: string; model: string | null; codeVersion: string | null };

const digest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** HÀM THUẦN — cùng đầu vào luôn ra cùng dấu; thứ tự khai công cụ không đổi dấu. */
export function promptStampOf(input: { system: string; tools: readonly string[]; config: unknown; model: string | null; codeVersion: string | null }): PromptStamp {
  return {
    promptHash: digest(`${input.system}\n␞tools␞${[...input.tools].sort().join(",")}`),
    configHash: digest(JSON.stringify(input.config ?? null)),
    model: input.model,
    codeVersion: input.codeVersion,
  };
}
