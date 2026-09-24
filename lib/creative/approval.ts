import { createHash } from "node:crypto";
import { actionToken, stableStringify, verifyActionToken } from "@/lib/ai/policy";
import type { CreativeRule } from "@/lib/constants/creative-loop";

/**
 * ═══════════ PHIẾU DUYỆT MỘT LÔ — KHOÁ ĐÚNG THỨ NGƯỜI ĐÃ XEM ═══════════
 *
 * Chủ shop chốt 24/09/2026: duyệt MỘT lần cho cả lô (nấc `COPILOT`). Một lần bấm cho phép máy tiêu
 * tới `số mẫu × ngân sách` — nên lần bấm ấy phải gắn chặt với ĐÚNG nội dung đã hiện trên màn hình.
 *
 * `approvalDigest` là sha256 của: ngày chạy · khung giờ · ngân sách mỗi mẫu · bộ luật tắt · và với
 * mỗi mẫu: id · băm ẢNH · câu chữ · tiêu đề. Đổi một ký tự câu chữ, tráo một tấm ảnh, nâng ngân sách,
 * dời khung giờ hay sửa một luật tắt SAU khi duyệt ⇒ digest khác ⇒ máy KHÔNG đăng
 * (`APPROVAL_MISMATCH`). Gạt một mẫu khỏi lô cũng làm digest đổi, nên phiếu cũ tự vô hiệu.
 *
 * Mẫu sắp theo `id` trước khi băm: thứ tự hiển thị không phải nội dung, và digest không được đổi chỉ
 * vì truy vấn trả hàng theo thứ tự khác.
 *
 * Phiếu (`batchTicket`) dùng lại nguyên cơ chế HMAC của `lib/ai/policy.ts` — gắn NGƯỜI · tool · (lô,
 * digest): không ai duyệt hộ người khác, và phiếu phát cho nội dung cũ không dùng được cho nội dung mới.
 * Hàm THUẦN (chỉ đọc `AUTH_SECRET` qua `actionToken`).
 */

/** Tên tool trong phiếu. Đổi chuỗi này là vô hiệu hoá mọi phiếu đang lưu hành — đó là ý muốn. */
export const CREATIVE_BATCH_APPROVE_TOOL = "CREATIVE_BATCH_APPROVE";

export type ApprovalVariant = { id: string; imageSha256: string; primaryText: string; headline: string };

export type ApprovalContent = {
  batchDay: string;
  startAt: Date;
  endAt: Date;
  budgetPerVariantVnd: number;
  killRules: CreativeRule[];
  variants: ApprovalVariant[];
};

export function approvalDigest(c: ApprovalContent): string {
  const payload = {
    batchDay: c.batchDay,
    startAt: c.startAt.toISOString(),
    endAt: c.endAt.toISOString(),
    budgetPerVariantVnd: c.budgetPerVariantVnd,
    killRules: c.killRules,
    variants: [...c.variants]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((v) => ({ id: v.id, imageSha256: v.imageSha256, primaryText: v.primaryText, headline: v.headline })),
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

export function batchTicket(userId: string, batchId: string, digest: string): string {
  return actionToken(userId, CREATIVE_BATCH_APPROVE_TOOL, { batchId, digest });
}

export function verifyBatchTicket(ticket: string, userId: string, batchId: string, digest: string): boolean {
  return verifyActionToken(ticket, userId, CREATIVE_BATCH_APPROVE_TOOL, { batchId, digest });
}
