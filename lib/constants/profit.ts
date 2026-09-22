/** Giả định dùng cho báo cáo lợi nhuận danh nghĩa theo mã hàng (lưu trong settings: profit.assumptions) */
export type ProfitAssumptions = {
  /** Cước gửi ĐVVC cho MỌI đơn gửi đi, kể cả đơn sau đó hoàn (đ) — 0 = tự tính bình quân 90 ngày từ dữ liệu */
  shipFeeDelivered: number;
  /** Tổng cước một đơn hoàn = cước gửi + phí hoàn về (đ) — 0 = cước gửi + phí hoàn bình quân (nếu có dữ liệu), không thì gấp đôi cước gửi */
  shipFeeReturned: number;
  /** Chi phí đóng hàng (túi, thùng, in bill…) cho mỗi đơn gửi đi (đ) */
  packingFeePerOrder: number;
  /** Chi phí nhân viên vận đơn cho mỗi đơn xử lý (đ) */
  opsStaffPerOrder: number;
  /** Thưởng nhân viên vận đơn cho mỗi đơn giao thất bại được cứu thành giao thành công (đ) */
  opsStaffPerRescued: number;
  /** Tỷ lệ đơn cứu được ước tính (% số đơn gửi) — thực tế của shop khoảng 10% */
  rescueRatePercent: number;
  /** Chi phí cố định mỗi tháng: văn phòng, điện nước, internet… (đ), phân bổ theo số ngày trong kỳ và tỷ trọng doanh số */
  fixedCostMonthly: number;
  /** Số ngày lịch sử dùng để ước tính tỷ lệ hoàn của từng mã */
  returnRateWindowDays: number;
  /**
   * ═══════════ TỶ LỆ KHAI CHUNG LÀ MỘT MỤC TIÊU, KHÔNG PHẢI MỘT DỰ BÁO ═══════════
   *
   * Tỷ lệ hoàn (%) áp cho mã CHƯA có đủ lịch sử của chính nó — bậc cuối của thang bậc
   * `resolveDeliveryRate()` (AGENTS.md mục 68).
   *
   * Chủ shop chốt 23/09/2026: **GTC 55% ⇒ hoàn 45%**, và khai rõ đây là **mức hàng mới PHẢI ĐẠT**,
   * dùng làm căn cứ chăm sóc quảng cáo khi chưa có số thật — chứ không phải một lời tiên đoán về
   * việc hàng mới SẼ giao được bao nhiêu.
   *
   * Sự phân biệt ấy không phải chuyện chữ nghĩa, nó đổi cách đọc màn hình: một con số DỰ BÁO sai
   * thì mô hình sai và phải sửa mô hình; một con số MỤC TIÊU không đạt thì khâu vận hành chưa đạt
   * và phải sửa vận hành. Nên mọi nhãn của bậc này phải nói "mục tiêu", không nói "ước tính".
   *
   * ─── VÌ SAO KHÔNG ĐẶT BẰNG SỐ ĐO ───
   *
   * Đo production 22/09/2026 trên 1.862 đơn đã có kết cục của 90 ngày: tỷ lệ hoàn thật **66,2%**
   * (⇒ GTC ~33,8%). Đặt bậc cuối bằng con số ấy sẽ cho ước tính sát hơn, nhưng nó biến bậc này
   * thành một dự báo — và khi đó hàng mới mặc định bị coi là sẽ hoàn hai phần ba trước khi có một
   * đơn nào được giao. Chủ shop chọn để nó là ĐÍCH. Mã nào có số thật thì thang bậc tự chuyển sang
   * số thật, nên đây chỉ là quy ước để vận hành trong lúc chưa có số, không phải một khẳng định.
   *
   * Hệ quả phải nhìn thấy: dòng nào đang chạy trên bậc này thì màn hình phải in ĐỘ PHỦ bên cạnh,
   * và lợi nhuận tạm tính của nó đọc là "theo kế hoạch", không phải "sẽ về ngần ấy".
   */
  defaultReturnRate: number;
  /**
   * ═══════════ MỐC CHUYỂN TỪ GIẢ ĐỊNH SANG SỐ THẬT CỦA CHÍNH MÃ HÀNG ═══════════
   *
   * Mã có đủ ngần này đơn ĐÃ CÓ KẾT CỤC (giao thành công + hoàn) trong cửa sổ `returnRateWindowDays`
   * thì thang bậc `resolveDeliveryRate()` thôi dùng tỷ lệ khai chung và **tuân theo số đo của chính
   * mã ấy**. Đây là bậc `history` trong thang bậc (AGENTS.md mục 68).
   *
   * Nó là NGƯỠNG NGHIỆP VỤ và sửa được không cần deploy — trang **Báo cáo → Giả định**, ô
   * *"Đơn kết thúc tối thiểu"*. Con số ở đây chỉ là giá trị khởi đầu cho một cài đặt mới.
   *
   * ─── ĐÁNH ĐỔI, ĐO ĐƯỢC, KHÔNG PHẢI CẢM TÍNH ───
   *
   * Nâng ngưỡng = đòi bằng chứng chắc hơn, nhưng cũng = ĐẨY THÊM MÃ về dùng tỷ lệ khai chung. Đo
   * production 22/09/2026 (7 mã, cửa sổ 90 ngày), số đơn đã có kết cục:
   *
   *     Đầm Q002 1.157 · Đầm Q003 474 · Đầm Q004 124 · Q001 71 · Quần định hình 33 · ĐẦM Q005 3 · Set Q006 0
   *
   * Nên 10 → 50 làm ĐÚNG MỘT mã đổi phe: **Quần định hình** (33 đơn, hoàn 60,6% đo được) rơi về tỷ
   * lệ khai chung. Bốn mã lớn vẫn đi bằng số đo của mình, hai mã mới vẫn chưa có gì để đo.
   */
  minFinishedOrders: number;
  /** Ghi đè tỷ lệ hoàn (%) theo productId */
  overrides: Record<string, number>;
  /** Dự phòng rủi ro tồn kho (% trên TỔNG giá trị hàng nhập trong kỳ theo phiếu nhập): hàng lỗi, tồn lâu phải xả, thất thoát */
  inventoryRiskPercent: number;
  /** Dự trù thuế (% doanh thu GTC ước tính) */
  taxPercent: number;
  /** Chi phí khác theo % chi phí quảng cáo (vd phí thanh toán ngoại tệ khi Meta thu thẻ 1,1%) */
  otherCostPercentOfAds: number;
  /** Xác suất đơn giao thất bại (chờ xử lý / chờ phát lại) cuối cùng thành hoàn (%); 0 = tự học từ lịch sử */
  failedToReturnPercent: number;
};

export const PROFIT_ASSUMPTIONS_KEY = "profit.assumptions";

export const DEFAULT_PROFIT_ASSUMPTIONS: ProfitAssumptions = {
  shipFeeDelivered: 17_000,
  shipFeeReturned: 0,
  packingFeePerOrder: 5_000,
  opsStaffPerOrder: 2_000,
  opsStaffPerRescued: 10_000,
  rescueRatePercent: 10,
  fixedCostMonthly: 5_000_000,
  returnRateWindowDays: 90,
  // Chủ shop chốt 23/09/2026: GTC mục tiêu 55% cho hàng mới. Xem chú thích ở kiểu.
  defaultReturnRate: 45,
  // Chủ shop chốt 22/09/2026: "giao 50 đơn có trạng thái" là mốc tuân theo số thật. Xem chú thích ở kiểu.
  minFinishedOrders: 50,
  overrides: {},
  inventoryRiskPercent: 10,
  taxPercent: 1.5,
  otherCostPercentOfAds: 1.1,
  failedToReturnPercent: 0,
};

export const FALLBACK_SHIP_FEE_DELIVERED = 17_000;
export const FALLBACK_SHIP_FEE_RETURNED = 34_000;

/** Số ngày bình quân một tháng để quy đổi chi phí cố định theo kỳ */
export const DAYS_PER_MONTH = 365 / 12;

/** Số tháng của kỳ báo cáo (theo số ngày lịch), tối thiểu 1 ngày */
export function periodMonths(from: Date | null | undefined, to: Date | null | undefined): number {
  if (!from || !to) return 0;
  const days = Math.max(1, (to.getTime() - from.getTime()) / 86_400_000);
  return days / DAYS_PER_MONTH;
}

export type OpsCostInput = {
  /** Đơn đã xác nhận gửi đi trong kỳ */
  orders: number;
  /** Đơn giao thất bại rồi giao thành công */
  rescued: number;
};

/** Chi phí vận hành theo đơn từ giả định: đóng hàng × đơn, nhân viên vận đơn = đơn × đơn giá + đơn cứu × thưởng */
export function opsCosts(input: OpsCostInput, a: Pick<ProfitAssumptions, "packingFeePerOrder" | "opsStaffPerOrder" | "opsStaffPerRescued">) {
  const orders = Math.max(0, input.orders);
  const rescued = Math.min(Math.max(0, input.rescued), orders);
  const packingCost = Math.round(orders * Math.max(0, a.packingFeePerOrder || 0));
  const opsStaffCost = Math.round(orders * Math.max(0, a.opsStaffPerOrder || 0) + rescued * Math.max(0, a.opsStaffPerRescued || 0));
  return { packingCost, opsStaffCost };
}

/** Số đơn cứu được ước tính = đơn gửi × tỷ lệ cứu (%) */
export function rescuedFromRate(orders: number, ratePct: number): number {
  return Math.round(Math.max(0, orders) * (Math.min(100, Math.max(0, ratePct || 0)) / 100));
}

/** Chi phí cố định của kỳ = chi phí tháng × số tháng trong kỳ */
export function fixedCostForPeriod(monthly: number, months: number): number {
  return Math.round(Math.max(0, monthly || 0) * Math.max(0, months));
}

/**
 * ───────────── HAI TỶ LỆ QUẢNG CÁO ─────────────
 *
 * MỘT công thức duy nhất cho cả Báo cáo lợi nhuận và Bảng điều khiển. Trước đây chỉ có ở báo cáo;
 * chép sang bảng điều khiển là mở đường cho hai trang cho ra hai con số của cùng một chỉ số.
 *
 * MẪU SỐ 0 ⇒ `null`, KHÔNG phải 0%: chưa bán được đồng nào mà hiện "0%" sẽ bị đọc thành "quảng cáo
 * không tốn gì", ngược hoàn toàn sự thật.
 */
export function adsRatio(adSpend: number, denominator: number): number | null {
  if (!(denominator > 0)) return null;
  return (adSpend / denominator) * 100;
}

/**
 * ───────────── BA TỶ LỆ QUẢNG CÁO, MỘT HÀM ─────────────
 *
 * Trước bản này bảng lợi nhuận tính "CPQC / DT GTC" bằng HAI mẫu số khác nhau ở hai chỗ: thẻ tổng
 * chia cho doanh thu ĐÃ GIAO THẬT, còn từng dòng và dòng tổng của bảng chia cho DT GTC ƯỚC TÍNH.
 * Cùng một tên cột, hai con số. Nay mọi nơi gọi đúng hàm này và in đúng tên mẫu số:
 *
 *   · `overPosSales`          = CPQC ÷ doanh số POS đã chốt (chưa trừ hoàn)
 *   · `overDeliveredActual`   = CPQC ÷ doanh thu ĐÃ GIAO THẬT theo ORDER_OUTCOME (tới hôm nay)
 *   · `overProjectedRevenue`  = CPQC ÷ DT GTC ƯỚC TÍNH (đã giao + đang giao × P, cân theo từng đơn)
 *
 * Tử số là CPQC ĐÃ QUY KẾT về đúng mã / đúng tổng đang xét. Tiền quảng cáo chưa ghép được mã hàng
 * KHÔNG được rải đều vào các dòng — nó đứng riêng với nhãn "chưa quy kết". Mẫu số 0 hay chưa đo được
 * ⇒ `null`, không bao giờ 0%.
 */
export type AdsRatios = {
  overPosSales: number | null;
  overDeliveredActual: number | null;
  overProjectedRevenue: number | null;
};

export function adsRatios(input: { adSpend: number; posSales: number; deliveredRevenueActual: number; projectedDeliveredRevenue: number | null }): AdsRatios {
  return {
    overPosSales: adsRatio(input.adSpend, input.posSales),
    overDeliveredActual: adsRatio(input.adSpend, input.deliveredRevenueActual),
    overProjectedRevenue: input.projectedDeliveredRevenue === null ? null : adsRatio(input.adSpend, input.projectedDeliveredRevenue),
  };
}
