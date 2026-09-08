/**
 * ───────────────── PHÂN BỔ CHI PHÍ THEO KHOẢNG THỜI GIAN BÁO CÁO ─────────────────
 *
 * Bug gốc: Báo cáo lợi nhuận lọc doanh thu theo khoảng ngày người dùng chọn, nhưng chi phí thì
 * cộng NGUYÊN khoản nếu `occurred_at` rơi vào khoảng đó. Hệ quả: tiền thuê mặt bằng 2.000.000đ/tháng
 * ghi ngày 01/09 sẽ vào ĐỦ 2.000.000đ khi xem tuần 01–07/09, và bằng 0 khi xem tuần 08–14/09. Cả
 * hai con số đều sai, và lợi nhuận tuần thành vô nghĩa.
 *
 * Nguyên tắc: mọi thành phần của báo cáo lợi nhuận phải dùng CÙNG một khoảng thời gian.
 *
 * CỐ Ý KHÔNG phân bổ đều mọi khoản: bản chất từng loại chi phí khác nhau, nên phải phân loại trước
 * rồi mới tính. Đoán bừa một phương pháp cho tất cả cũng sai như cộng nguyên khoản.
 */

export const COST_ALLOCATION_METHODS = [
  "EVENT_DATE",
  "PERIOD_PRORATA",
  "ORDER_ATTRIBUTED",
  "ACTUAL_DATED_SPEND",
] as const;

export type CostAllocationMethod = (typeof COST_ALLOCATION_METHODS)[number];

export const COST_ALLOCATION_LABEL: Record<CostAllocationMethod, string> = {
  EVENT_DATE: "Phát sinh một lần",
  PERIOD_PRORATA: "Chia theo số ngày trong kỳ",
  ORDER_ATTRIBUTED: "Gắn theo đơn / vận đơn",
  ACTUAL_DATED_SPEND: "Số thực chi theo ngày",
};

export const COST_ALLOCATION_HELP: Record<CostAllocationMethod, string> = {
  EVENT_DATE:
    "Ghi trọn vào đúng ngày phát sinh. Báo cáo không chứa ngày đó thì khoản này bằng 0. Dùng cho chi phí một lần: sửa chữa, phí phát sinh, khoản nhập tay lẻ.",
  PERIOD_PRORATA:
    "Khoản có hiệu lực trong một khoảng thời gian, chia theo số ngày chồng lấn với khoảng báo cáo. Dùng cho thuê mặt bằng, phần mềm thuê bao, máy chủ, lương cố định theo kỳ.",
  ORDER_ATTRIBUTED:
    "Chi phí gắn thẳng vào một đơn hoặc vận đơn (cước, phí hoàn, giá vốn). Ghi nhận theo mốc của chính đơn đó, KHÔNG chia theo tháng.",
  ACTUAL_DATED_SPEND:
    "Có số chi thực theo từng ngày (chi phí quảng cáo). Cộng đúng số ngày trong khoảng báo cáo, không chia đều từ một tổng tháng.",
};

/**
 * Nhóm chi phí mà bản chất là THEO KỲ. Thiếu kỳ hiệu lực thì con số của chúng trong báo cáo
 * khoảng ngắn chắc chắn sai — nêu ra ở Chất lượng dữ liệu để chủ shop điền, KHÔNG tự đoán kỳ.
 */
export const PERIOD_LIKE_CATEGORIES = ["RENT", "SALARY", "SOFTWARE"] as const;

/** Lệch giờ Việt Nam so với UTC. Mốc lưu là `timestamptz`; phần NGÀY phải lấy theo lịch VN. */
const VN_OFFSET_MS = 7 * 3_600_000;

/**
 * Số thứ tự ngày (theo lịch Việt Nam) của một mốc.
 *
 * Bắt buộc phải dịch sang giờ VN trước khi lấy phần ngày: `2026-09-01T00:00+07:00` chính là
 * `2026-08-31T17:00Z`, nên đọc theo lịch UTC sẽ ra ngày 31/08 và cả tháng 9 hoá thành 31 ngày.
 */
const vnDayIndex = (value: Date) => Math.floor((value.getTime() + VN_OFFSET_MS) / 86_400_000);

/** Số ngày (theo lịch Việt Nam) của một khoảng, tính CẢ hai đầu. */
export function inclusiveDays(from: Date, to: Date): number {
  return vnDayIndex(to) - vnDayIndex(from) + 1;
}

export type AllocatableExpense = {
  amount: number;
  occurredAt: Date;
  allocationMethod: CostAllocationMethod;
  periodStart?: Date | null;
  periodEnd?: Date | null;
};

/**
 * PHẦN CHI PHÍ THUỘC VỀ KHOẢNG BÁO CÁO. Một chỗ duy nhất tính, dùng chung cho mọi màn hình.
 *
 * Với khoản theo kỳ, tính bằng HIỆU CỦA HAI SỐ LUỸ KẾ chứ không nhân trực tiếp phân số:
 *
 *     phân bổ(từ, đến) = luỹ_kế(đến) − luỹ_kế(từ − 1 ngày)
 *
 * Nhờ vậy hai khoảng liền nhau cộng lại LUÔN bằng đúng tổng khoản, không thừa không thiếu vì làm
 * tròn — nhân phân số rồi làm tròn từng khoảng thì 7/30 + 23/30 có thể lệch một đồng.
 */
export function allocateExpenseToRange(expense: AllocatableExpense, reportStart: Date | null, reportEnd: Date | null): number {
  const { amount, allocationMethod, periodStart, periodEnd, occurredAt } = expense;

  if (allocationMethod !== "PERIOD_PRORATA" || !periodStart || !periodEnd) {
    // Không có kỳ hiệu lực ⇒ ghi trọn vào ngày phát sinh, và chỉ khi ngày đó nằm trong báo cáo.
    if (reportStart && occurredAt < reportStart) return 0;
    if (reportEnd && occurredAt > reportEnd) return 0;
    return amount;
  }

  if (periodEnd < periodStart) return 0;
  const total = inclusiveDays(periodStart, periodEnd);
  if (total <= 0) return 0;

  const from = reportStart && reportStart > periodStart ? reportStart : periodStart;
  const to = reportEnd && reportEnd < periodEnd ? reportEnd : periodEnd;
  if (to < from) return 0;

  /** Luỹ kế từ đầu kỳ tới hết ngày d. Ngày trước đầu kỳ = 0, hết kỳ = trọn khoản. */
  const cumulative = (d: Date) => {
    const days = inclusiveDays(periodStart, d);
    if (days <= 0) return 0;
    if (days >= total) return amount;
    return Math.round((amount * days) / total);
  };

  const before = new Date(from.getTime() - 86_400_000);
  return cumulative(to) - cumulative(before);
}
