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

/**
 * ══════════════ PHÂN BỔ CHI PHÍ SUY RA TỪ GIẢ ĐỊNH (không nằm ở bảng `expenses`) ══════════════
 *
 * Bốn phương pháp ở trên chỉ áp cho KHOẢN CHI CÓ CHỨNG TỪ. Báo cáo lợi nhuận còn có những chi phí
 * ƯỚC TÍNH suy ra từ bộ giả định: đóng hàng, nhân viên vận đơn, chi phí cố định, dự phòng rủi ro
 * tồn kho, thuế, phí thẻ. Mỗi khoản như vậy phải khai rõ CĂN CỨ PHÂN BỔ (cost driver) — chi phí đi
 * theo cái gì — rồi mới nhân. Không khai driver thì sớm muộn cũng có người nhân nhầm cơ sở.
 */
export const COST_DRIVERS = ["TIME", "PER_ORDER", "PER_UNIT_SOLD", "PCT_REVENUE", "PCT_ADS", "DIRECT"] as const;
export type CostDriver = (typeof COST_DRIVERS)[number];

export const COST_DRIVER_LABEL: Record<CostDriver, string> = {
  TIME: "Theo thời gian",
  PER_ORDER: "Theo đơn xử lý",
  PER_UNIT_SOLD: "Theo hàng bán ra",
  PCT_REVENUE: "Theo % doanh thu",
  PCT_ADS: "Theo % chi quảng cáo",
  DIRECT: "Gắn thẳng vào đối tượng",
};

/**
 * ─────────── DỰ PHÒNG RỦI RO TỒN KHO: DRIVER LÀ HÀNG BÁN RA, KHÔNG PHẢI HÀNG NHẬP ───────────
 *
 * Bug gốc (chủ shop nêu 09/09/2026): rủi ro tồn kho tính bằng `% × giá trị hàng NHẬP trong kỳ`.
 * Mã Q002 nhập 200 triệu, rủi ro 10% = 20 triệu. Xem báo cáo MỘT TUẦN chỉ bán 100/1.000 đơn của lô
 * đó thì tuần ấy vẫn gánh đủ 20 triệu ⇒ mã lãi thành mã lỗ. Tuần sau không nhập gì thì rủi ro = 0
 * ⇒ mã lỗ thành mã lãi. Cùng một mã, cùng một tốc độ bán, hai kết luận trái ngược — đúng hình dạng
 * của bug tiền thuê mặt bằng ở đầu file này, chỉ khác là nó nằm ở chiều HÀNG chứ không phải chiều
 * NGÀY: một sự kiện NHẬP KHO bị ném trọn vào kỳ báo cáo chứa nó.
 *
 * Nguyên tắc: dự phòng rủi ro là DỰ PHÒNG TRÊN HÀNG, được giải phóng vào lợi nhuận THEO HÀNG RA
 * KHỎI KHO, giống hệt giá vốn. Tỷ lệ giữ nguyên ý nghĩa chủ shop đã chốt — 10% giá trị lô hàng cuối
 * cùng sẽ mất vì lỗi / xả / thất thoát — chỉ đổi THỜI ĐIỂM ghi nhận:
 *
 *     rủi ro ghi vào kỳ = % × GIÁ VỐN HÀNG BÁN RA trong kỳ
 *
 * Bán hết lô thì Σ mọi kỳ = % × giá vốn cả lô = ĐÚNG BẰNG con số cũ. Tổng vòng đời không đổi, chỉ
 * hết nhảy bậc theo ngày nhập hàng. Đây là cùng một phép "hiệu hai số luỹ kế" ở trên, đổi trục từ
 * NGÀY sang SỐ HÀNG.
 */
export function inventoryRiskOnSold(cogsSold: number, riskPercent: number): number {
  return Math.round(Math.max(0, cogsSold) * clampPercent(riskPercent) / 100);
}

/**
 * PHẦN RỦI RO CÒN TREO TRÊN HÀNG TỒN — memo, KHÔNG trừ vào lợi nhuận kỳ.
 *
 * Chuyển rủi ro sang ghi theo hàng bán mà không hiện phần này thì rủi ro hàng ế biến mất khỏi màn
 * hình, và báo cáo lại sai theo hướng ngược lại: lạc quan giả. Hàng chưa bán vẫn đang gánh rủi ro,
 * chỉ là chưa tới lúc ghi vào lãi lỗ.
 *
 * Đây là ƯỚC TÍNH. Hàng hỏng / xả lỗ THỰC TẾ phải vào sổ bằng phiếu kho ADJUSTMENT + khoản chi
 * thật, không được để dự phòng đứng thay chứng từ.
 */
export function inventoryRiskExposure(stockValue: number, riskPercent: number): number {
  return Math.round(Math.max(0, stockValue) * clampPercent(riskPercent) / 100);
}

function clampPercent(pct: number): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/**
 * ─────────── CHIA MỘT TỔNG CHO NHIỀU ĐỐI TƯỢNG SAO CHO CỘNG LẠI ĐÚNG BẰNG TỔNG ───────────
 *
 * `Math.round(total * w / W)` cho từng dòng là cách ai cũng viết, và Σ các dòng gần như không bao
 * giờ bằng `total`: chia 5.000.000đ cho 7 mã thì lệch vài đồng, chia cho 300 mã thì lệch hàng trăm.
 * Bảng chi tiết cộng lại không khớp dòng tổng ⇒ chủ shop mất niềm tin vào cả báo cáo.
 *
 * Dùng LARGEST REMAINDER: lấy phần nguyên trước, phần dư còn thiếu phát cho các dòng có phần lẻ lớn
 * nhất. Kết quả CHẮC CHẮN Σ = total (khi total ≥ 0 và có ít nhất một trọng số > 0).
 */
export function distributeProportionally(total: number, weights: number[]): number[] {
  const out = new Array<number>(weights.length).fill(0);
  const sum = weights.reduce((t, w) => t + Math.max(0, w), 0);
  if (!Number.isFinite(total) || total === 0 || sum <= 0) return out;
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(total));
  const exact = weights.map((w) => (abs * Math.max(0, w)) / sum);
  let given = 0;
  for (let idx = 0; idx < exact.length; idx += 1) {
    out[idx] = Math.floor(exact[idx]);
    given += out[idx];
  }
  const order = exact
    .map((v, idx) => ({ idx, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.idx - b.idx);
  for (let k = 0; given < abs && k < order.length; k += 1, given += 1) out[order[k].idx] += 1;
  // Còn thiếu sau một vòng (nhiều dòng trọng số 0) thì dồn nốt vào dòng nặng nhất.
  if (given < abs) {
    const heaviest = weights.reduce((best, w, idx) => (w > weights[best] ? idx : best), 0);
    out[heaviest] += abs - given;
  }
  return sign < 0 ? out.map((v) => -v) : out;
}
