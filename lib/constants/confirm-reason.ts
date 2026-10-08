/**
 * ═══════════ «VÌ SAO NÚT CHƯA BẤM ĐƯỢC» CỦA HỘP XÁC NHẬN CÓ LÝ DO — THUẦN, CLIENT-SAFE ═══════════
 *
 * `ConfirmWithReason` (components/platform/pilot-ops.tsx) là nút GHI của mọi màn người vận hành: ô lý do → hộp xác nhận in nguyên
 * văn hệ quả → server action. Kiểm khởi chạy 08/10/2026 (FINISH_LINE #6): ở form có nhiều ô nhập, nút đứng ĐẦU khung và mờ tới khi
 * gõ đủ lý do, còn ô thật nằm bên dưới — người mới tưởng nút bị khoá mà không ai nói vì sao. Nay ô lý do + nút xuống DƯỚI các ô
 * nhập, và khi nút chưa bấm được thì cạnh nút có MỘT câu nói đúng thứ còn thiếu. Câu ấy dựng ở đây (thuần — bài kiểm gọi thẳng).
 */

export type ConfirmBlockInput = {
  /** Nhãn nút (vd «Tạo khách…») — dựng đầu câu khi người gọi không khai `lead`. */
  label: string;
  /** Đầu câu (vd «Chưa thể tạo khách»). */
  lead?: string;
  minReason: number;
  reason: string;
  /** Điều kiện còn thiếu do người gọi biết — cụm ngắn («chọn gói», «nhập email quản trị»). */
  missing?: readonly string[];
  /** Người gọi khoá cả khung (ô lý do cũng khoá) — chỉ nói được vì sao khi người gọi khai `disabledReason`. */
  disabled?: boolean;
  disabledReason?: string | null;
  pending?: boolean;
};

/** Cụm «còn thiếu lý do» — một chỗ cho mọi hộp xác nhận. */
export function reasonNeed(minReason: number): string {
  return `nhập lý do (ít nhất ${minReason} ký tự)`;
}

/** Nút có bấm được không — đúng điều kiện của nút: không đang chạy, không bị khoá, đủ lý do, không còn ô nào thiếu. */
export function confirmReady(input: Pick<ConfirmBlockInput, "minReason" | "reason" | "missing" | "disabled" | "pending">): boolean {
  return !input.pending && !input.disabled && input.reason.trim().length >= input.minReason && !(input.missing ?? []).some(Boolean);
}

/**
 * Câu cạnh nút khi nút chưa bấm được: «<đầu câu> — cần <thứ 1> · <thứ 2>.». `null` = không có gì để nói (nút bấm được, đang chạy,
 * hoặc khung bị khoá mà người gọi không khai lý do — im lặng còn hơn đoán).
 */
export function confirmBlockedReason(input: ConfirmBlockInput): string | null {
  if (input.pending) return null;
  const lead = input.lead ?? `Chưa bấm được «${input.label.replace(/[….\s]+$/u, "")}»`;
  if (input.disabled) return input.disabledReason ? `${lead} — ${input.disabledReason}.` : null;
  const need = [...(input.missing ?? []).filter(Boolean), ...(input.reason.trim().length < input.minReason ? [reasonNeed(input.minReason)] : [])];
  return need.length ? `${lead} — cần ${need.join(" · ")}.` : null;
}
