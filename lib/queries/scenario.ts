import { SCENARIO_LIMIT } from "@/lib/constants/scenario";
import { getAdsAttributionAudit } from "@/lib/queries/ads-attribution";
import { getProfitReport } from "@/lib/queries/reports";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── MÔ PHỎNG KỊCH BẢN ─────────────
 *
 * Trả lời câu "nếu … thì lợi nhuận đổi thế nào" bằng chính con số của kỳ đang xem, chứ không bằng
 * một bảng tính riêng ngoài Excel — nơi mọi giả định đều biến mất sau một tuần.
 *
 * BA RANH GIỚI CỨNG:
 *
 * 1. **KHÔNG BAO GIỜ GHI.** Mô phỏng chỉ đọc điểm xuất phát rồi tính trong bộ nhớ. Không lưu kịch
 *    bản, không đổi giả định lợi nhuận, không tạo đơn sản xuất, không đụng ngân sách quảng cáo.
 *    Ranh giới này được khoá ở mức mã nguồn trong `tests/advisory-safety.test.ts`.
 *
 * 2. **Điểm xuất phát là số THẬT.** Lấy nguyên `getProfitReport` — cùng công thức lợi nhuận với
 *    trang Báo cáo, cùng `ORDER_OUTCOME`. Không có con số nào ở đây được gõ tay.
 *
 * 3. **Chi quảng cáo là ĐÒN BẨY CHI PHÍ, không phải đòn bẩy doanh thu.** Cho doanh thu tăng theo
 *    ngân sách nghĩa là nhân với ROAS quy kết — mà độ phủ quy kết hiện chỉ khoảng một nửa. Ở mức
 *    phủ đó, phép nhân ấy là bịa, và bịa trong một công cụ ra quyết định thì tệ hơn là không có
 *    công cụ. Trang này hiện độ phủ ngay cạnh đòn bẩy để người đọc biết vì sao nó bị chặn.
 *
 * Mô hình cố ý TUYẾN TÍNH và nói ra được từng bước — một mô hình phức tạp mà không ai kiểm được
 * thì không dùng để quyết định tiền thật.
 */

export type ScenarioLevers = {
  /** Đổi bao nhiêu ĐIỂM phần trăm (từ 70% lên 75% là +5). */
  successRatePoints: number;
  pricePercent: number;
  cogsPercent: number;
  shippingPercent: number;
  adSpendPercent: number;
  opexPercent: number;
};

export const NO_LEVERS: ScenarioLevers = {
  successRatePoints: 0,
  pricePercent: 0,
  cogsPercent: 0,
  shippingPercent: 0,
  adSpendPercent: 0,
  opexPercent: 0,
};

/** Điểm xuất phát: các dòng lãi lỗ của kỳ đang xem. Tiền là số nguyên VND. */
export type ScenarioBaseline = {
  /** Đơn đã KẾT THÚC = giao thành công + hoàn. Đơn đang giao không nằm ở đây vì chưa ngã ngũ. */
  finishedOrders: number;
  successOrders: number;
  revenue: number;
  cogs: number;
  shipping: number;
  returnFee: number;
  marketplaceFee: number;
  adSpend: number;
  operating: number;
};

export type ScenarioLines = ScenarioBaseline & {
  returnedOrders: number;
  successRate: number | null;
  grossProfit: number;
  netProfit: number;
  /** Biên lợi nhuận trên doanh thu. `null` khi không có doanh thu — CHƯA BIẾT, không phải 0%. */
  margin: number | null;
};

export type ScenarioResult = {
  levers: ScenarioLevers;
  base: ScenarioLines;
  next: ScenarioLines;
  /** Chênh lệch lợi nhuận ròng, đồng. Dương là kịch bản tốt hơn hiện tại. */
  profitDelta: number;
  /**
   * Tỷ lệ giao thành công tối thiểu để hoà vốn, GIỮ NGUYÊN các đòn bẩy khác của kịch bản.
   * `null` khi không giải được (không có đơn kết thúc, hoặc mỗi đơn giao thêm vẫn lỗ).
   */
  breakEvenSuccessRate: number | null;
  /** Vì sao con số này chỉ nên dùng để so sánh tương đối. */
  assumptions: string[];
};

function clamp(value: number, limit: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-limit, Math.min(limit, value));
}

/** Ép các đòn bẩy về khoảng cho phép. Giá trị lạ (chữ, NaN, vô cực) thành 0 chứ không làm sập trang. */
export function clampLevers(raw: Partial<ScenarioLevers>): ScenarioLevers {
  return {
    successRatePoints: clamp(Number(raw.successRatePoints ?? 0), SCENARIO_LIMIT.successRatePoints),
    pricePercent: clamp(Number(raw.pricePercent ?? 0), SCENARIO_LIMIT.percent),
    cogsPercent: clamp(Number(raw.cogsPercent ?? 0), SCENARIO_LIMIT.percent),
    shippingPercent: clamp(Number(raw.shippingPercent ?? 0), SCENARIO_LIMIT.percent),
    adSpendPercent: clamp(Number(raw.adSpendPercent ?? 0), SCENARIO_LIMIT.percent),
    opexPercent: clamp(Number(raw.opexPercent ?? 0), SCENARIO_LIMIT.percent),
  };
}

function linesOf(b: ScenarioBaseline): ScenarioLines {
  const grossProfit = b.revenue - b.cogs;
  const netProfit = grossProfit - b.shipping - b.returnFee - b.marketplaceFee - b.adSpend - b.operating;
  return {
    ...b,
    returnedOrders: Math.max(0, b.finishedOrders - b.successOrders),
    successRate: b.finishedOrders ? Math.round((b.successOrders / b.finishedOrders) * 1000) / 10 : null,
    grossProfit,
    netProfit,
    margin: b.revenue ? Math.round((netProfit / b.revenue) * 1000) / 10 : null,
  };
}

/**
 * Áp các đòn bẩy lên điểm xuất phát. Hàm THUẦN: cùng đầu vào cho cùng đầu ra, không đọc CSDL,
 * không ghi gì — nên kiểm thử được từng ca một mà không cần dựng dữ liệu.
 *
 * Công thức lợi nhuận giữ NGUYÊN như `lib/queries/reports.ts`:
 *   lợi nhuận ròng = doanh thu − giá vốn − cước − phí hoàn − phí sàn − quảng cáo − vận hành.
 * Mô phỏng chỉ đổi các số hạng, tuyệt đối không đổi công thức.
 */
export function simulate(baseline: ScenarioBaseline, rawLevers: Partial<ScenarioLevers>): ScenarioResult {
  const levers = clampLevers(rawLevers);
  const base = linesOf(baseline);

  const priceFactor = 1 + levers.pricePercent / 100;
  const cogsFactor = 1 + levers.cogsPercent / 100;
  const shipFactor = 1 + levers.shippingPercent / 100;

  // Tỷ lệ giao thành công mới. Không có đơn kết thúc thì đòn bẩy này không có gì để tác động.
  const baseRate = baseline.finishedOrders ? baseline.successOrders / baseline.finishedOrders : null;
  const nextRate = baseRate === null ? null : Math.max(0, Math.min(1, baseRate + levers.successRatePoints / 100));
  const nextSuccess = nextRate === null ? baseline.successOrders : Math.round(baseline.finishedOrders * nextRate);
  const baseReturned = Math.max(0, baseline.finishedOrders - baseline.successOrders);
  const nextReturned = Math.max(0, baseline.finishedOrders - nextSuccess);

  // Hệ số quy mô. Không có đơn giao thành công nào thì không suy ra được doanh thu mỗi đơn — giữ 1
  // thay vì chia cho 0 rồi in ra Infinity.
  const successFactor = baseline.successOrders ? nextSuccess / baseline.successOrders : 1;
  const returnFactor = baseReturned ? nextReturned / baseReturned : 1;

  const next = linesOf({
    finishedOrders: baseline.finishedOrders,
    successOrders: nextSuccess,
    revenue: Math.round(baseline.revenue * successFactor * priceFactor),
    cogs: Math.round(baseline.cogs * successFactor * cogsFactor),
    // Cước chiều đi bám theo SỐ ĐƠN GỬI ĐI, mà số đơn gửi đi không đổi khi tỷ lệ giao thay đổi.
    shipping: Math.round(baseline.shipping * shipFactor),
    returnFee: Math.round(baseline.returnFee * returnFactor * shipFactor),
    marketplaceFee: baseline.marketplaceFee,
    adSpend: Math.round(baseline.adSpend * (1 + levers.adSpendPercent / 100)),
    operating: Math.round(baseline.operating * (1 + levers.opexPercent / 100)),
  });

  // ───────── Hoà vốn: giải phương trình bậc nhất theo tỷ lệ giao thành công ─────────
  // lợi nhuận(r) = A·r + C, với A = số đơn kết thúc × (lãi gộp mỗi đơn giao được + phí hoàn tránh được).
  let breakEvenSuccessRate: number | null = null;
  if (baseline.finishedOrders > 0 && baseline.successOrders > 0) {
    const revenuePer = (baseline.revenue / baseline.successOrders) * priceFactor;
    const cogsPer = (baseline.cogs / baseline.successOrders) * cogsFactor;
    const returnFeePer = baseReturned ? (baseline.returnFee / baseReturned) * shipFactor : 0;
    const A = baseline.finishedOrders * (revenuePer - cogsPer + returnFeePer);
    const C = -next.shipping - baseline.finishedOrders * returnFeePer - next.marketplaceFee - next.adSpend - next.operating;
    if (A > 0) {
      const r = (-C / A) * 100;
      breakEvenSuccessRate = r >= 0 && r <= 100 ? Math.round(r * 10) / 10 : null;
    }
  }

  return {
    levers,
    base,
    next,
    profitDelta: next.netProfit - base.netProfit,
    breakEvenSuccessRate,
    assumptions: [
      "Mô hình TUYẾN TÍNH quanh điểm hiện tại: mỗi đòn bẩy chỉ nhân số hạng của nó, không mô hình hoá phản ứng dây chuyền.",
      "Đổi giá bán KHÔNG kéo theo đổi số đơn — trong thực tế tăng giá thường làm giảm đơn, nên kịch bản tăng giá luôn lạc quan hơn đời thật.",
      "Tỷ lệ giao thành công đổi thì doanh thu và giá vốn đổi theo, phí hoàn giảm theo, còn cước chiều đi giữ nguyên vì số đơn gửi đi không đổi.",
      "Chi quảng cáo chỉ tính phần CHI. Doanh thu KHÔNG tăng theo ngân sách — xem độ phủ quy kết bên dưới.",
      "Đơn đang giao không nằm trong mẫu số: chỉ đơn đã kết thúc (giao thành công + hoàn) mới có kết quả để mô phỏng.",
      "Kịch bản KHÔNG được lưu và không đổi bất kỳ dữ liệu nào — đây là công cụ đọc.",
    ],
  };
}

export type ScenarioReport = ScenarioResult & {
  period: Period;
  /** Độ phủ quy kết quảng cáo — trần độ tin của mọi câu chuyện dính tới ngân sách quảng cáo. */
  adsAttributionCoverage: number | null;
};

/** Dựng điểm xuất phát từ báo cáo lợi nhuận của kỳ, rồi áp đòn bẩy. Chỉ đọc. */
export async function getScenario(period: Period, levers: Partial<ScenarioLevers>): Promise<ScenarioReport> {
  const report = await getProfitReport(period, "created");
  const c = report.current;
  const baseline: ScenarioBaseline = {
    finishedOrders: c.successOrders + c.returned,
    successOrders: c.successOrders,
    revenue: c.revenue,
    cogs: c.cogs,
    shipping: c.shipping,
    returnFee: c.returnFee,
    marketplaceFee: c.marketplaceFee,
    adSpend: c.adSpend,
    operating: c.operating,
  };
  // Độ phủ quy kết ĐƠN — trần độ tin của mọi câu chuyện dính tới ngân sách quảng cáo.
  const audit = await getAdsAttributionAudit(period).catch(() => null);
  const orderRow = audit?.rows.find((r) => r.unit === "order");
  return {
    ...simulate(baseline, levers),
    period,
    adsAttributionCoverage: orderRow ? Math.round(orderRow.coverage * 10) / 10 : null,
  };
}
