/**
 * ═══════════ THANG BẬC TỶ LỆ GIAO THÀNH CÔNG CỦA MỘT MÃ HÀNG ═══════════
 *
 * MỘT hàm THUẦN trả lời đúng một câu hỏi: *"mã này, trong kỳ này, bao nhiêu phần trăm đơn tới được
 * tay khách?"* — và nó nói luôn CĂN CỨ nào đã trả lời (`source`), vì một con số đo được và một con
 * số giả định trông y hệt nhau khi in cùng cỡ chữ.
 *
 * ─── VÌ SAO NÓ PHẢI RỜI KHỎI `profit-nominal.ts` ───
 *
 * Thang bậc này do chủ shop chốt ngày 21/09/2026 và tới 22/09/2026 nó chỉ sống trong thân vòng lặp
 * dựng dòng của Báo cáo lợi nhuận danh nghĩa. Báo cáo Hiệu quả marketing theo ngày cần ĐÚNG thang
 * bậc ấy — chép sang là dựng bậc thứ hai, và hai bậc thì có ngày chúng trả lời khác nhau về cùng
 * một mã trong khi cả hai màn hình đều nói "tỷ lệ giao thành công".
 *
 * ─── BỐN BẬC, XẾP THEO ĐỘ MẠNH CỦA CĂN CỨ ───
 *
 *   1. `override`  — chủ shop gõ tay ở Giả định. Đây là một QUYẾT ĐỊNH, không phải ước lượng, nên
 *                    nó thắng mọi số đo.
 *   2. `projected` — hợp đồng `PROJECTED_GTC_V3`: mỗi đơn đang chạy cân theo xác suất của CHÍNH
 *                    trạng thái ĐVVC nó đang ở. CHỈ dùng khi mã đã có ít nhất MỘT đơn đi tới kết
 *                    cục — chưa có thì tử số toàn bộ là xác suất MƯỢN từ mã khác (đo được ngày
 *                    21/09/2026: Đầm Q005 `giao 0 · hoàn 0 · đang giao 62` mà ô tỷ lệ in 37,5%).
 *   3. `history`   — tỷ lệ hoàn thật của mã trong `returnRateWindowDays` ngày gần nhất, chỉ khi số
 *                    đơn đã kết thúc đạt `minFinishedOrders`.
 *   4. `default`   — tỷ lệ khai ở Giả định (`defaultReturnRate`). YẾU NHẤT, và là bậc duy nhất
 *                    không có một quan sát nào của chính mã đứng sau.
 *
 * Không có bậc thứ năm và KHÔNG có nhánh nào trả về "—" cho một mã đang bán: chủ shop chốt
 * 21/09/2026 rằng một ô trống không giúp ra quyết định nào. Nhưng `source` phải đi kèm con số tới
 * tận màn hình, vì bậc 4 là GIẢ ĐỊNH — nó không được tô màu và không được xếp hạng.
 */

export type DeliveryRateSource = "override" | "projected" | "history" | "default";

/** Bậc nào là SỐ ĐO của chính mã, bậc nào là quyết định / giả định. Dùng để quyết định có tô màu. */
export const DELIVERY_RATE_MEASURED: Record<DeliveryRateSource, boolean> = {
  override: false,
  projected: true,
  history: true,
  default: false,
};

export const DELIVERY_RATE_SOURCE_LABEL: Record<DeliveryRateSource, string> = {
  override: "Ghi đè tay",
  projected: "Số đo theo từng đơn",
  history: "Lịch sử của mã",
  default: "Tỷ lệ khai ở Giả định",
};

export type DeliveryRateInput = {
  /** Tỷ lệ HOÀN (%) chủ shop gõ tay cho mã này. `undefined`/`null` = không có ghi đè. */
  overrideReturnRate?: number | null;
  /** Tỷ lệ GIAO THÀNH CÔNG (%) của hợp đồng `PROJECTED_GTC_V3`. `null` = hợp đồng chưa kết luận được. */
  projectedDeliveryRate: number | null;
  /** Số đơn CỦA CHÍNH MÃ đã đi tới kết cục trong cohort mô hình. 0 ⇒ hợp đồng đang mượn số của mã khác. */
  projectedFinished: number;
  /** Tỷ lệ HOÀN (%) lịch sử của mã. `null` = chưa đơn nào kết thúc trong cửa sổ. */
  historyReturnRate: number | null;
  historyFinished: number;
  minFinishedOrders: number;
  /** Tỷ lệ HOÀN (%) khai ở Giả định — bậc cuối. */
  defaultReturnRate: number;
};

export type ResolvedDeliveryRate = {
  /** % giao thành công, luôn là một con số (0–100). */
  deliveryRate: number;
  /** % hoàn = 100 − `deliveryRate`. */
  returnRate: number;
  source: DeliveryRateSource;
  /** Số đơn đã kết thúc đứng sau con số này. 0 với bậc `default`. */
  finished: number;
  /**
   * Tỷ lệ HOÀN NỀN — bậc `history` nếu đủ mẫu, không thì `default`. Đây là con số sẽ được dùng nếu
   * ghi đè tay và số đo đều vắng mặt; màn hình Giả định in nó để chủ shop thấy bậc lùi là bao nhiêu.
   * KHÔNG làm tròn: nó là đầu vào hiển thị, không phải kết luận.
   */
  baseReturnRate: number;
};

const clampPct = (v: number) => Math.min(100, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Thang bậc, chạy đúng thứ tự trên. Trả về TỶ LỆ HOÀN lẫn TỶ LỆ GIAO để nơi gọi không phải tự lấy
 * phần bù — hai phép trừ ở hai tệp là hai cơ hội để một chỗ làm tròn khác chỗ kia.
 */
export function resolveDeliveryRate(i: DeliveryRateInput): ResolvedDeliveryRate {
  let baseReturnRate = i.defaultReturnRate;
  let returnRate = clampPct(i.defaultReturnRate);
  let source: DeliveryRateSource = "default";
  let finished = 0;

  if (i.historyReturnRate !== null && i.historyFinished >= i.minFinishedOrders) {
    baseReturnRate = i.historyReturnRate;
    returnRate = clampPct(i.historyReturnRate);
    source = "history";
    finished = i.historyFinished;
  }

  const ov = i.overrideReturnRate;
  if (ov !== undefined && ov !== null && Number.isFinite(ov)) {
    returnRate = clampPct(ov);
    source = "override";
    finished = 0;
  } else if (i.projectedDeliveryRate !== null && i.projectedFinished > 0) {
    returnRate = clampPct(100 - i.projectedDeliveryRate);
    source = "projected";
    finished = i.projectedFinished;
  }

  const rr = round1(returnRate);
  return { deliveryRate: round1(100 - rr), returnRate: rr, source, finished, baseReturnRate };
}
