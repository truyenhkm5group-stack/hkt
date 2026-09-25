import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { adsCeiling } from "@/lib/constants/estimated-cost";
import { BREAK_EVEN_CPO_LABEL, maxAdCostPerOrder } from "@/lib/constants/break-even-cpo";
import type { DecisionBasis } from "@/lib/constants/ads-decision";
import { getAdsDecision, type AdsDecisionRow } from "@/lib/queries/ads-decision";
import { getNominalProfitReport, type NominalRow } from "@/lib/queries/profit-nominal";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ KINH TẾ THEO MẪU — ƯỚC TÍNH ĐỨNG CẠNH THỰC ĐẠT, KHÔNG TRỘN ═══════════
 *
 * Hợp đồng Company OS §6 (`getModelEconomics`, Agent F). Hàm này KHÔNG có công thức lợi nhuận nào
 * của riêng nó: mọi con số tiền đến từ hai bộ máy đã có, gọi đúng như màn hình của chúng gọi.
 *
 *  · ƯỚC TÍNH  — `getNominalProfitReport` (tab Lợi nhuận danh nghĩa), đúng DÒNG của mã. Doanh thu
 *    và giá vốn cân theo tỷ lệ giao thành công ước tính (thang bậc mục 68); cước theo GIẢ ĐỊNH;
 *    LN ròng đã trừ vận hành/cố định phân bổ, thuế, rủi ro tồn kho.
 *  · THỰC ĐẠT  — `getAdsDecision(…, "product")` (bảng quyết định `/ads`), đúng DÒNG của mã. Doanh
 *    thu giao thành công theo `ORDER_OUTCOME`, giá vốn của đơn đã giao, cước THẬT (cả phí hoàn).
 *    Chỉ tới mức LỢI NHUẬN GÓP — bộ máy ấy cố ý không phân bổ chi phí cố định.
 *  · TẠM TÍNH  — cũng từ bảng quyết định: số đo + phần đang treo cân theo GTC ước tính.
 *
 * ─── VÌ SAO KHÔNG LỌC BÁO CÁO DANH NGHĨA THEO MÃ ───
 *
 * Dòng danh nghĩa của một mã PHỤ THUỘC mọi mã khác: vận hành và cố định chia theo tỷ trọng doanh
 * số POS của cả kỳ. Lọc truy vấn xuống một mã thì hoặc phải tính lại tổng toàn shop (không rẻ hơn),
 * hoặc ra số sai. Nên hàm này gọi báo cáo ĐẦY ĐỦ qua `memo` (khoá cache đã chứa mọi tham số) rồi
 * nhặt dòng — bằng nhau theo cấu trúc, và dùng chung bộ đệm với các trang khác gọi cùng tham số.
 * `tests/company-os-economics.test.ts` so từng trường với báo cáo gốc.
 *
 * ─── GIÁ VỐN: SỐNG, KHÔNG ĐÓNG BĂNG — NÓI RA Ở TRƯỜNG `cogsBasis` ───
 *
 * Cả hai bộ máy tính giá vốn SỐNG theo phiếu nhập gần nhất (`LINE_UNIT_COST` / `lineUnitCost`,
 * `docs/cogs-recognition-contract.md` mục 1–2). Báo cáo P&L / tiền thật đọc giá vốn ĐÃ ĐÓNG BĂNG lúc
 * giao (`recognized_cogs`, mục 6 của hợp đồng ấy). Một phiếu nhập mới hôm nay đổi hai cột ở đây mà
 * không đổi P&L — nên số ở đây có thể lệch P&L của cùng mã, và lý do nằm trong dữ liệu trả về.
 *
 * Giá vốn DỰ TÍNH (`profit.estimatedCosts`) KHÔNG BAO GIỜ áp ở đây (luật 2 của `estimated-cost.ts`:
 * chỉ tab Lợi nhuận danh nghĩa và một ngoại lệ chủ shop đã chốt được bật; `tests/estimated-cost.test.ts`
 * quét mã nguồn). Mã chưa có giá vốn thật thì ô tiền mang ghi chú "CAO HƠN THẬT", không mượn giá đoán.
 * Mở rộng ngoại lệ là quyết định của chủ shop.
 */

export type EconomicsBasis = "ESTIMATED" | "REALIZED" | "PROJECTED";

export const ECONOMICS_BASIS_LABEL: Record<EconomicsBasis, string> = {
  ESTIMATED: "Ước tính",
  REALIZED: "Thực đạt",
  PROJECTED: "Tạm tính",
};

export type EconomicsUnit = "VND" | "COUNT" | "PCT";

export type EconomicsValue = {
  /** `null` = CHƯA BIẾT / KHÔNG ÁP DỤNG — lý do ở `note`. Không bao giờ là 0 giả (mục 42). */
  value: number | null;
  basis: EconomicsBasis;
  /** "Ước tính" / "Thực đạt" / "Tạm tính" — nhãn in cạnh con số. */
  label: string;
  /** Bộ máy + trường sinh ra con số — truy nguyên được (mục 8.7). */
  source: string;
  note: string | null;
};

export type EconomicsLineKey =
  | "orders"
  | "deliveryRate"
  | "deliveredRevenue"
  | "adSpend"
  | "cpo"
  | "contributionMarginPct"
  | "contributionAfterAds"
  | "contributionPerOrder"
  | "breakEvenCpoContribution"
  | "maxAdCostPerOrderNet"
  | "netProfit"
  | "netProfitPerOrder";

export type EconomicsLine = {
  key: EconomicsLineKey;
  label: string;
  unit: EconomicsUnit;
  estimated: EconomicsValue;
  realized: EconomicsValue;
  /** `null` = dòng này không có khái niệm tạm tính (không phải "tạm tính bằng 0"). */
  projected: EconomicsValue | null;
};

export type ModelEconomics = {
  productId: string;
  period: { label: string; fromKey: string | null; toKey: string | null };
  /** Có dòng của mã trong báo cáo danh nghĩa không. `false` ⇒ mọi ô Ước tính là `null`. */
  estimatedFound: boolean;
  /** Có dòng của mã trong bảng quyết định cấp mã không. `false` ⇒ mọi ô Thực đạt / Tạm tính là `null`. */
  realizedFound: boolean;
  /** Căn cứ khuyến nghị của bảng quyết định cho mã (`null` khi không có dòng). */
  decisionBasis: DecisionBasis | null;
  /** Giá vốn dự tính có được áp cho phía Ước tính không, và phần tiền đến từ nó. */
  withEstimatedCost: boolean;
  estimatedCogsFromSetting: number | null;
  cogsBasis: {
    estimated: "LIVE_LATEST_RECEIPT";
    realized: "LIVE_LATEST_RECEIPT";
    /** Cả hai đều KHÔNG đọc giá vốn đóng băng lúc giao (`recognized_cogs`). Luôn `false` — khai để không ai phải đoán. */
    usesFrozenRecognizedCogs: false;
    note: string;
  };
  lines: EconomicsLine[];
  /** Những điều người đọc phải biết để không so nhầm — in ra, không giấu. */
  notes: string[];
};

const NOMINAL_SRC = "getNominalProfitReport";
const DECISION_SRC = "getAdsDecision(product)";

function economicsCell(basis: EconomicsBasis, value: number | null, source: string, note: string | null = null): EconomicsValue {
  const clean = value === null || !Number.isFinite(value) ? null : value;
  return { value: clean, basis, label: ECONOMICS_BASIS_LABEL[basis], source, note: clean === null && value !== null ? (note ?? "Không tính được") : note };
}

const perOrder = (money: number | null, orders: number | null): number | null =>
  money === null || orders === null || orders <= 0 ? null : Math.round(money / orders);

/**
 * Dựng bảng từ HAI DÒNG ĐÃ TÍNH SẴN. Hàm THUẦN — không đọc CSDL, không đọc đồng hồ — để kiểm thử
 * được mọi nhánh null mà không dựng dữ liệu.
 */
export function buildModelEconomics(input: {
  productId: string;
  period: Period;
  nominal: NominalRow | null;
  /** `%CP khác theo QC` của đúng bản Giả định báo cáo danh nghĩa vừa dùng. */
  otherCostPercentOfAds: number;
  decision: AdsDecisionRow | null;
  withEstimatedCost: boolean;
}): ModelEconomics {
  const n = input.nominal;
  const d = input.decision;
  const notes: string[] = [];

  // ── Ô Ước tính: giá vốn còn trống ở mã thì lợi nhuận đang trừ 0 ₫ cho phần ấy — nói ra ở từng ô tiền.
  const estGap = n && n.cogsUncoveredQty > 0 ? `${n.cogsUncoveredQty} sp chưa biết giá vốn — đang tính 0 ₫, lợi nhuận CAO HƠN THẬT` : null;
  // ── Ô Thực đạt: bảng quyết định không bao giờ dùng giá dự tính, nên khoảng trống là số sp chưa có giá THẬT.
  const realGap = n && n.cogsUnknownQty > 0 ? `${n.cogsUnknownQty} sp (trong kỳ) chưa có giá vốn thật — bảng quyết định tính 0 ₫ cho phần ấy` : null;
  const noNominal = n ? null : "Mã không có dòng trong báo cáo danh nghĩa của kỳ (không đơn, không chi QC).";
  const noDecision = d ? null : "Mã không có dòng trong bảng quyết định cấp mã của kỳ.";

  const est = (value: number | null, field: string, note: string | null = null) => economicsCell("ESTIMATED", n ? value : null, `${NOMINAL_SRC} · ${field}`, n ? note : noNominal);
  const real = (value: number | null, field: string, note: string | null = null) => economicsCell("REALIZED", d ? value : null, `${DECISION_SRC} · ${field}`, d ? note : noDecision);
  const proj = (value: number | null, field: string, note: string | null = null) => economicsCell("PROJECTED", d ? value : null, `${DECISION_SRC} · ${field}`, d ? note : noDecision);
  const spendNote = d && !d.spendKnown ? "Không biết số chi QC của mã trong kỳ" : null;

  const estOrders = n ? n.orders : null;
  const estContributionBeforeAds = n ? n.expectedProfit + n.adSpend : null;
  const ceiling = n
    ? adsCeiling({
        netProfit: n.netProfit,
        adSpend: n.adSpend,
        otherCost: n.otherCost,
        expectedRevenue: n.expectedRevenue,
        posSales: n.salesAfterDiscount,
        orders: n.orders,
        otherCostPercentOfAds: input.otherCostPercentOfAds,
        targetMarginPct: null,
      })
    : null;

  const lines: EconomicsLine[] = [
    {
      key: "orders",
      label: "Đơn chốt",
      unit: "COUNT",
      estimated: est(n?.orders ?? null, "orders", "Đơn chưa huỷ theo NGÀY LÊN ĐƠN"),
      realized: real(d?.bookedOrders ?? null, "bookedOrders", "Đơn đã xác nhận (quần thể `confirmed`) — có thể lệch vài đơn so với cột Ước tính vì hai bộ máy lọc quần thể khác nhau"),
      projected: null,
    },
    {
      key: "deliveryRate",
      label: "Tỷ lệ giao thành công (%)",
      unit: "PCT",
      estimated: est(n?.deliveryRate ?? null, `deliveryRate (${n?.returnRateSource ?? "—"})`, n && n.deliveryRate === null ? "Chưa đo được" : null),
      realized: real(d?.successRate ?? null, "successRate", d && d.successRate === null ? "Chưa đơn nào kết thúc" : "Trên đơn ĐÃ kết thúc — đơn đang đi không ở mẫu số"),
      projected: d ? proj(d.appliedDeliveryRate, "appliedDeliveryRate", d.appliedDeliveryRate === null ? "Không có đơn đang treo — không có gì để ước tính" : "Tỷ lệ đã áp cho phần đang treo") : proj(null, "appliedDeliveryRate"),
    },
    {
      key: "deliveredRevenue",
      label: "Doanh thu giao thành công",
      unit: "VND",
      estimated: est(n?.expectedRevenue ?? null, "expectedRevenue", "Ước tính theo tỷ lệ GTC — gồm cả đơn chưa ngã ngũ"),
      realized: real(d?.deliveredRevenue ?? null, "deliveredRevenue", "Chỉ đơn đã giao theo ORDER_OUTCOME — đơn đang đi CHƯA có mặt"),
      projected: proj(d?.projectedDeliveredRevenue ?? null, "projectedDeliveredRevenue"),
    },
    {
      key: "adSpend",
      label: "Chi quảng cáo",
      unit: "VND",
      estimated: est(n?.adSpend ?? null, "adSpend"),
      realized: real(d && d.spendKnown ? d.spend : null, "spend", spendNote),
      projected: null,
    },
    {
      key: "cpo",
      label: "CPO thực (chi / đơn chốt)",
      unit: "VND",
      estimated: est(n && n.cpo !== null ? Math.round(n.cpo) : null, "cpo"),
      realized: real(d?.costPerOrder ?? null, "costPerOrder", spendNote),
      projected: null,
    },
    {
      key: "contributionMarginPct",
      label: "Biên LN góp trước QC (% DT giao)",
      unit: "PCT",
      estimated: est(
        n && n.expectedRevenue > 0 && estContributionBeforeAds !== null ? (estContributionBeforeAds / n.expectedRevenue) * 100 : null,
        "(expectedProfit + adSpend) ÷ expectedRevenue",
        estGap ?? (n && n.expectedRevenue <= 0 ? "Chưa có doanh thu giao ước tính" : null),
      ),
      realized: real(d && d.marginRate !== null ? d.marginRate * 100 : null, "marginRate", realGap ?? (d && d.marginRate === null ? "Chưa có doanh thu giao" : null)),
      projected: null,
    },
    {
      key: "contributionAfterAds",
      label: "Lợi nhuận góp sau QC",
      unit: "VND",
      estimated: est(n?.expectedProfit ?? null, "expectedProfit", estGap ?? "Cước theo GIẢ ĐỊNH (cước gửi / cước hoàn)"),
      realized: real(d && d.spendKnown ? d.profitAfterAds : null, "profitAfterAds", spendNote ?? realGap ?? "Cước thật cả phí hoàn; chỉ đơn đã giao mang doanh thu"),
      projected: proj(d && d.spendKnown ? d.projectedProfitAfterAds : null, "projectedProfitAfterAds", spendNote ?? realGap),
    },
    {
      key: "contributionPerOrder",
      label: "LN góp sau QC / đơn chốt",
      unit: "VND",
      estimated: est(perOrder(n?.expectedProfit ?? null, estOrders), "expectedProfit ÷ orders", estGap),
      realized: real(d && d.spendKnown ? perOrder(d.profitAfterAds, d.bookedOrders) : null, "profitAfterAds ÷ bookedOrders", spendNote ?? realGap),
      projected: proj(d && d.spendKnown ? perOrder(d.projectedProfitAfterAds, d.bookedOrders) : null, "projectedProfitAfterAds ÷ bookedOrders", spendNote ?? realGap),
    },
    {
      key: "breakEvenCpoContribution",
      label: "CPO hoà vốn · LN góp",
      unit: "VND",
      // CÙNG hàm với bảng quyết định: tử số là LN góp trước QC, %CP khác = 0 (phạm vi của bảng ấy).
      estimated: est(maxAdCostPerOrder({ profitBeforeAds: estContributionBeforeAds, orders: estOrders ?? 0 }), "maxAdCostPerOrder(expectedProfit + adSpend, orders)", estGap),
      realized: real(d?.breakEvenCpo ?? null, `breakEvenCpo · ${BREAK_EVEN_CPO_LABEL.CONTRIBUTION_ACTUAL}`, realGap),
      projected: proj(d?.projectedBreakEvenCpo ?? null, `projectedBreakEvenCpo · ${BREAK_EVEN_CPO_LABEL.CONTRIBUTION_PROJECTED}`, realGap),
    },
    {
      key: "maxAdCostPerOrderNet",
      label: BREAK_EVEN_CPO_LABEL.NOMINAL_NET,
      unit: "VND",
      estimated: est(ceiling?.breakEven.perOrder ?? null, "adsCeiling(…).breakEven.perOrder", estGap),
      realized: economicsCell("REALIZED", null, "—", "ERP chưa đo LN RÒNG thực đạt theo mã: vận hành/cố định chỉ được phân bổ trong bộ máy danh nghĩa"),
      projected: null,
    },
    {
      key: "netProfit",
      label: "Lợi nhuận ròng",
      unit: "VND",
      estimated: est(n?.netProfit ?? null, "netProfit", estGap ?? "Đã trừ vận hành/cố định phân bổ, thuế, rủi ro tồn kho, CP khác"),
      realized: economicsCell("REALIZED", null, "—", "ERP chưa đo LN RÒNG thực đạt theo mã (lợi nhuận tiền thật chỉ có ở cấp shop)"),
      projected: null,
    },
    {
      key: "netProfitPerOrder",
      label: "LN ròng / đơn chốt",
      unit: "VND",
      estimated: est(perOrder(n?.netProfit ?? null, estOrders), "netProfit ÷ orders", estGap),
      realized: economicsCell("REALIZED", null, "—", "ERP chưa đo LN RÒNG thực đạt theo mã"),
      projected: null,
    },
  ];

  notes.push(
    "Ước tính và Thực đạt đến từ HAI bộ máy có quần thể đơn hơi khác nhau (danh nghĩa: đơn chưa huỷ theo ngày lên đơn; quyết định: đơn đã xác nhận). Chênh vài đơn là khác định nghĩa, không phải lỗi.",
    "Thực đạt chỉ tới LỢI NHUẬN GÓP — bảng quyết định cố ý không phân bổ chi phí cố định. LN ròng chỉ có ở cột Ước tính.",
  );
  if (d && d.basis === "PROJECTED") notes.push("Phần lớn đơn của mã còn đang đi: cột Thực đạt đang thấp hơn kết cục thật; cột Tạm tính là con số bảng quyết định đang dùng để khuyến nghị.");
  if (input.withEstimatedCost && n && n.expectedCogsEstimated > 0) notes.push(`Cột Ước tính dùng ${n.expectedCogsEstimated.toLocaleString("vi-VN")} ₫ giá vốn DỰ TÍNH (đặt tay) — cột Thực đạt không bao giờ dùng giá dự tính.`);

  return {
    productId: input.productId,
    period: { label: input.period.label, fromKey: input.period.fromKey, toKey: input.period.toKey },
    estimatedFound: n !== null,
    realizedFound: d !== null,
    decisionBasis: d ? d.basis : null,
    withEstimatedCost: input.withEstimatedCost,
    estimatedCogsFromSetting: n ? n.expectedCogsEstimated : null,
    cogsBasis: {
      estimated: "LIVE_LATEST_RECEIPT",
      realized: "LIVE_LATEST_RECEIPT",
      usesFrozenRecognizedCogs: false,
      note: "Cả hai cột tính giá vốn SỐNG theo phiếu nhập gần nhất; P&L và lợi nhuận tiền thật dùng giá vốn ĐÓNG BĂNG lúc giao (recognized_cogs). Nhập phiếu mới có thể đổi số ở đây mà không đổi P&L của cùng mã.",
    },
    lines,
    notes,
  };
}

/**
 * Kinh tế của MỘT mã trong kỳ — ước tính cạnh thực đạt. Không `memo` riêng: hai bộ máy bên dưới đã
 * `memo` với khoá chứa đủ tham số (kỳ, mốc, bộ lọc, công tắc QC, giá dự tính, tồn kho).
 *
 * `withStock = false` khi gọi báo cáo danh nghĩa: tồn kho chỉ nuôi ô GHI CHÚ, không một đồng nào vào
 * lợi nhuận (mục 14), và đó là câu đắt nhất của báo cáo — cùng lựa chọn với bảng lương.
 */
export async function getModelEconomics(productId: string, range: Period): Promise<ModelEconomics> {
  const [nominal, decision] = await Promise.all([
    // Tham số thứ năm `false` TƯỜNG MINH: không bao giờ giá vốn dự tính (xem chú thích đầu tệp).
    getNominalProfitReport(range, "ORDERED", NO_ORDER_VALUE_FILTER, true, false, false),
    getAdsDecision(range, "product"),
  ]);
  return buildModelEconomics({
    productId,
    period: range,
    nominal: nominal.rows.find((r) => r.productId === productId) ?? null,
    otherCostPercentOfAds: nominal.assumptions.otherCostPercentOfAds ?? 0,
    decision: decision.rows.find((r) => r.key === productId) ?? null,
    withEstimatedCost: false,
  });
}
