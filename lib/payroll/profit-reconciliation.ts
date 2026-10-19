/**
 * ═══════════ ĐỐI SOÁT LỢI NHUẬN TÍNH LƯƠNG MỘT THÁNG — HÀM THUẦN ═══════════
 *
 * Đặc tả: `docs/payroll-code-ledger.md` §9. Chủ shop giao 19/10/2026 (Payroll V2 vận hành): đối chiếu
 * P&L tính lương với đơn hàng, quảng cáo, giá vốn, logistics, hoàn / huỷ và chi phí chung; phân loại
 * chi phí THEO MÃ · CHUNG · CHƯA XÁC ĐỊNH NGUỒN; số chưa đủ căn cứ ⇒ CHƯA ĐỐI SOÁT và khoá duyệt thưởng.
 *
 * KHÔNG tính lại lợi nhuận. Hai vế đã có sẵn và được đặt cạnh nhau:
 *  · vế CƠ SỞ LƯƠNG — `getMarketerReport().totals` / `products[]` (con số bảng lương dùng);
 *  · vế NGUỒN       — máy chi phí `getRecognizedCosts()` (con số Báo cáo lợi nhuận dùng) + số đo trực
 *    tiếp trên đơn (chứng từ tiền, đơn chưa kết thúc, dòng chưa biết giá vốn).
 * Mỗi dòng có một trong bốn trạng thái: KHỚP · CHÊNH ĐÃ GIẢI THÍCH · ƯỚC TÍNH · CHƯA ĐỐI SOÁT.
 *
 * Không đọc CSDL, không đọc đồng hồ, chạy hai lần ra cùng kết quả.
 */

export type ReconStatus = "MATCHED" | "EXPLAINED" | "ESTIMATED" | "UNRECONCILED";
export type CostClass = "BY_CODE" | "SHARED" | "UNKNOWN_SOURCE" | "NOT_IN_BASIS";

export const RECON_STATUS_LABEL: Record<ReconStatus, string> = {
  MATCHED: "Khớp nguồn",
  EXPLAINED: "Chênh đã giải thích",
  ESTIMATED: "Ước tính (không phải số đo)",
  UNRECONCILED: "Chưa đối soát",
};

export const COST_CLASS_LABEL: Record<CostClass, string> = {
  BY_CODE: "Chi phí theo mã",
  SHARED: "Chi phí chung (cấp công ty)",
  UNKNOWN_SOURCE: "Chưa xác định nguồn",
  NOT_IN_BASIS: "Có thật nhưng CHƯA vào cơ sở lương",
};

export type MonthReconInput = {
  monthKey: string;
  /** Vế cơ sở lương (`getMarketerReport(month, "profit1")`). */
  basis: {
    revenue: number;
    cogs: number;
    /** QC gắn mã, chia theo người: có MKTer · chưa gán MKTer. */
    adsCodeWithMarketer: number;
    adsCodeNoMarketer: number;
    /** QC không gắn mã ("test"): có MKTer · không ai. */
    adsTestWithMarketer: number;
    adsTestNoMarketer: number;
    /** Cước chiều đi theo vận đơn (gồm kiện đang đi), KHÔNG gồm điều chỉnh tay. */
    shippingPerShipment: number;
    logisticsAdjustment: number;
    logisticsAdjustmentUnallocated: number;
    operatingEntered: number;
    operatingAllocToCodes: number;
    fixedCostAssumption: number;
    perOrderOpsEstimate: number;
    sharedUnallocated: number;
    profit: number;
    /** Phần loại khỏi cơ sở vì là thù lao biến đổi — ước tính ranh giới thì `estimated`. */
    basisExclusionMeasured: number;
    basisExclusionEstimated: number;
  };
  /** Vế nguồn — máy chi phí cùng kỳ. */
  engine: {
    cogs: number;
    ads: number;
    /** Cước theo vận đơn của đơn ĐÃ KẾT THÚC — KHÔNG gồm điều chỉnh tay. */
    shipping: number;
    /** Phí trên vận đơn CHIỀU VỀ — KHÔNG gồm điều chỉnh phí hoàn (phần ấy đã nằm trong cơ sở). */
    returnCost: number;
    operatingTotal: number;
  };
  /** Số đo trực tiếp trên đơn của tháng (cùng biểu thức kết quả đơn với cơ sở lương). */
  orders: {
    deliveredRevenue: number;
    deliveredRevenueWithMoney: number;
    deliveredOrders: number;
    deliveredOrdersWithMoney: number;
    /** Đơn chưa kết thúc (đang đi · chưa rời kho · chưa biết) — doanh thu của tháng CHƯA CHỐT. */
    openOrders: number;
    openValue: number;
    /** Giá trị hàng của đơn ĐÃ KẾT THÚC (giao thành công + hoàn), không gồm đơn huỷ. */
    settledValue: number;
    returnedOrders: number;
    cancelledOrders: number;
    /** Dòng hàng đã giao mà giá vốn rơi về 0 (không phiếu nhập, không giá Pancake, không giá nhập mẫu mã). */
    unknownCostLines: number;
    unknownCostRevenue: number;
    /** Kiện đã gửi mà cước rơi về 0 (không phí vận đơn, không phí đối tác). */
    sentNoFeeOrders: number;
  };
  /** Cảnh báo `high` của máy chi phí (vd lương cứng chưa ghi nhận) — tiêu đề + số tiền. */
  costWarnings: readonly { rule: string; title: string; amount: number }[];
  codes: readonly { productId: string; code: string; hasCustomId: boolean; revenue: number; profit: number; unknownCostLines: number; adsNoMarketer: number; assigned: boolean }[];
};

export type ReconLine = {
  key: string;
  label: string;
  /** Số của cơ sở lương. `null` = cơ sở không có khoản này. */
  basis: number | null;
  /** Số của nguồn đối chiếu. `null` = không có nguồn độc lập. */
  source: number | null;
  /** basis − source khi cả hai có. */
  diff: number | null;
  status: ReconStatus;
  cls: CostClass | "REVENUE";
  note: string;
  href: string | null;
};

export type ReconIssue = { code: string; label: string; amount: number | null; count: number | null; href: string | null };

export type MonthReconciliation = {
  monthKey: string;
  lines: ReconLine[];
  classes: Record<CostClass, number>;
  /** Độ phủ: `null` = mẫu số 0 (không có gì để đo), khác 0%. */
  coverage: {
    /** Doanh thu đã giao có chứng từ tiền ÷ doanh thu đã giao (theo giá trị). */
    revenueWithMoneyPct: number | null;
    /** Giá trị đơn ĐÃ KẾT THÚC ÷ (đã kết thúc + chưa kết thúc) — tháng đã "chín" bao nhiêu. */
    revenueSettledPct: number | null;
    /** Chi phí ở dòng KHỚP / CHÊNH ĐÃ GIẢI THÍCH ÷ toàn bộ chi phí (gồm cả phần chưa vào cơ sở). */
    costReconciledPct: number | null;
  };
  codes: { total: number; withCustomId: number; profitComplete: number; assigned: number; withProfit: number };
  issues: ReconIssue[];
  status: "RECONCILED" | "UNRECONCILED";
  /** Dấu vân tay mọi con số người ký xác nhận đã thấy — số đổi ⇒ chữ ký cũ không còn áp. */
  fingerprint: string;
};

const r = (n: number) => Math.round(n);
const pct = (a: number, b: number) => (b > 0 ? a / b : null);

/** Dựng đối soát một tháng. `period` dạng link: `period=custom&from=…&to=…`. */
export function buildMonthReconciliation(x: MonthReconInput, periodQuery: string): MonthReconciliation {
  const b = x.basis;
  const e = x.engine;
  const o = x.orders;
  const lines: ReconLine[] = [];
  const add = (l: Omit<ReconLine, "diff">) => lines.push({ ...l, diff: l.basis !== null && l.source !== null ? r(l.basis - l.source) : null });

  // ── DOANH THU ──
  add({
    key: "revenue",
    label: "Doanh thu giao thành công (theo ORDER_OUTCOME)",
    basis: r(b.revenue),
    source: r(o.deliveredRevenue),
    status: r(b.revenue) === r(o.deliveredRevenue) ? (o.deliveredRevenueWithMoney >= o.deliveredRevenue ? "MATCHED" : "UNRECONCILED") : "UNRECONCILED",
    cls: "REVENUE",
    note:
      o.deliveredRevenue > o.deliveredRevenueWithMoney
        ? `${(o.deliveredOrders - o.deliveredOrdersWithMoney).toLocaleString("vi-VN")} đơn đã giao CHƯA có chứng từ tiền (${r(o.deliveredRevenue - o.deliveredRevenueWithMoney).toLocaleString("vi-VN")} ₫) — doanh thu chưa xác minh, không phải đã thu.`
        : "Mọi đơn đã giao đều có chứng từ tiền (COD thực thu hoặc chuyển khoản).",
    href: "/cod?recon=unproven",
  });
  add({
    key: "open-orders",
    label: "Đơn của tháng CHƯA kết thúc (đang đi · chưa rời kho · chưa biết)",
    basis: null,
    source: r(o.openValue),
    status: o.openOrders > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "REVENUE",
    note: o.openOrders > 0 ? `${o.openOrders.toLocaleString("vi-VN")} đơn chưa có kết quả — doanh thu và giá vốn của chúng CHƯA vào cơ sở, cước và chi phí theo đơn ĐÃ vào. Lợi nhuận tháng còn đổi.` : "Mọi đơn của tháng đã có kết quả.",
    href: `/shipments?${periodQuery}`,
  });

  // ── GIÁ VỐN ──
  add({
    key: "cogs",
    label: "Giá vốn hàng giao thành công",
    basis: r(b.cogs),
    source: r(e.cogs),
    status: o.unknownCostLines > 0 ? "UNRECONCILED" : r(b.cogs) === r(e.cogs) ? "MATCHED" : "EXPLAINED",
    cls: "BY_CODE",
    note:
      o.unknownCostLines > 0
        ? `${o.unknownCostLines.toLocaleString("vi-VN")} dòng hàng đã giao (doanh thu ${r(o.unknownCostRevenue).toLocaleString("vi-VN")} ₫) KHÔNG có giá vốn nào — cơ sở đang tính 0 ₫ cho chúng, lợi nhuận cao hơn thật.`
        : r(b.cogs) === r(e.cogs)
          ? "Khớp máy chi phí."
          : "Cơ sở lương dùng giá báo MKT đang hiệu lực khi có (LINE_UNIT_COST), máy chi phí dùng giá vốn đơn — chênh là phần giá báo.",
    href: "/data-quality?issue=missing-cogs",
  });

  // ── QUẢNG CÁO ──
  const adsBasis = b.adsCodeWithMarketer + b.adsCodeNoMarketer + b.adsTestWithMarketer + b.adsTestNoMarketer;
  add({ key: "ads", label: "Chi phí quảng cáo (tổng)", basis: r(adsBasis), source: r(e.ads), status: r(adsBasis) === r(e.ads) ? "MATCHED" : "UNRECONCILED", cls: "BY_CODE", note: r(adsBasis) === r(e.ads) ? "Khớp máy chi phí." : "Tổng QC trong cơ sở lương lệch tổng QC của kỳ — kiểm dòng loại trừ / ngày chi.", href: `/ads?${periodQuery}` });
  add({ key: "ads-code-mk", label: "· QC gắn mã, có MKTer", basis: r(b.adsCodeWithMarketer), source: null, status: "MATCHED", cls: "BY_CODE", note: "Vào lợi nhuận mã và căn cứ trọng số SUPPORT.", href: `/ads?${periodQuery}` });
  add({
    key: "ads-code-nomk",
    label: "· QC gắn mã, CHƯA gán MKTer",
    basis: r(b.adsCodeNoMarketer),
    source: null,
    status: b.adsCodeNoMarketer > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "BY_CODE",
    note: "Lợi nhuận mã vẫn đúng (tiền đã trừ vào mã), nhưng không biết của ai — trọng số SUPPORT theo chi phí QC thiếu phần này.",
    href: `/ads?${periodQuery}&marketer=__none__`,
  });
  add({ key: "ads-test-mk", label: "· QC không gắn mã (test), có MKTer", basis: r(b.adsTestWithMarketer), source: null, status: "MATCHED", cls: "SHARED", note: "Chi phí chung có người chịu — trừ vào lợi nhuận cá nhân người chạy, không vào mã nào.", href: `/ads?${periodQuery}&product=__test__` });
  add({
    key: "ads-test-nomk",
    label: "· QC không gắn mã, không gán MKTer",
    basis: r(b.adsTestNoMarketer),
    source: null,
    status: b.adsTestNoMarketer > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "UNKNOWN_SOURCE",
    note: "Tiền thật đã trừ khỏi lợi nhuận công ty nhưng không thuộc mã nào, không thuộc ai.",
    href: `/ads?${periodQuery}&product=__test__&marketer=__none__`,
  });

  // ── LOGISTICS ──
  add({
    key: "shipping",
    label: "Cước chiều đi theo vận đơn",
    basis: r(b.shippingPerShipment),
    source: r(e.shipping),
    status: o.sentNoFeeOrders > 0 ? "UNRECONCILED" : "EXPLAINED",
    cls: "BY_CODE",
    note:
      (o.sentNoFeeOrders > 0 ? `${o.sentNoFeeOrders.toLocaleString("vi-VN")} kiện đã gửi KHÔNG có cước (tính 0 ₫). ` : "") +
      "Cơ sở lương trừ cước của MỌI kiện đã gửi (kể cả đang đi); máy chi phí chỉ trừ cước của đơn đã kết thúc — chênh là cước của kiện chưa có kết quả.",
    href: `/shipments?${periodQuery}`,
  });
  add({ key: "logistics-adj", label: "Điều chỉnh cước / phí hoàn có lý do (gõ tay)", basis: r(b.logisticsAdjustment), source: r(b.logisticsAdjustment), status: "MATCHED", cls: b.logisticsAdjustmentUnallocated > 0 ? "SHARED" : "BY_CODE", note: "Cùng một con số của máy chi phí.", href: "/expenses" });
  add({
    key: "return-cost",
    label: "Phí chiều hoàn (vận đơn chiều về)",
    basis: null,
    source: r(e.returnCost),
    status: e.returnCost > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "NOT_IN_BASIS",
    note: e.returnCost > 0 ? "Máy chi phí ghi nhận khoản này nhưng cơ sở lương CHƯA trừ — lợi nhuận tính lương cao hơn Báo cáo lợi nhuận đúng bằng số này. Đưa vào cơ sở là đổi cách tính thưởng ⇒ chủ shop quyết." : "Không có phí chiều hoàn trong kỳ.",
    href: `/shipments?${periodQuery}`,
  });

  // ── CHI PHÍ CHUNG / VẬN HÀNH ──
  add({
    key: "operating",
    label: "Chi phí vận hành đã nhập (sau khi loại thù lao biến đổi)",
    basis: r(b.operatingEntered),
    source: r(e.operatingTotal - b.basisExclusionMeasured - b.basisExclusionEstimated),
    status: r(b.operatingEntered) === r(e.operatingTotal - b.basisExclusionMeasured - b.basisExclusionEstimated) ? (b.basisExclusionEstimated > 0 ? "ESTIMATED" : "MATCHED") : "UNRECONCILED",
    cls: "SHARED",
    note: b.basisExclusionEstimated > 0 ? `Ranh giới lương cứng / hoa hồng trong nhóm Lương là ƯỚC TÍNH (${r(b.basisExclusionEstimated).toLocaleString("vi-VN")} ₫ loại khỏi cơ sở).` : "Khớp máy chi phí sau khi loại thù lao biến đổi.",
    href: "/expenses",
  });
  add({ key: "fixed-assumption", label: "Chi phí cố định GIẢ ĐỊNH (Lương → Cấu hình, theo tháng)", basis: r(b.fixedCostAssumption), source: null, status: b.fixedCostAssumption > 0 ? "ESTIMATED" : "MATCHED", cls: "SHARED", note: "Khai báo, không phải chứng từ — cộng THÊM vào chi phí đã nhập.", href: "/payroll/settings" });
  add({ key: "per-order-ops", label: "Đóng gói + nhân viên vận đơn theo đơn (định mức)", basis: r(b.perOrderOpsEstimate), source: null, status: b.perOrderOpsEstimate > 0 ? "ESTIMATED" : "MATCHED", cls: "BY_CODE", note: "Định mức × số kiện gửi (kèm tỷ lệ cứu đơn) — ước tính.", href: "/payroll/settings" });
  add({ key: "shared-unalloc", label: "Chi phí chung KHÔNG chia được xuống mã", basis: r(b.sharedUnallocated + b.logisticsAdjustmentUnallocated), source: null, status: "MATCHED", cls: "SHARED", note: "Vẫn trừ khỏi lợi nhuận công ty, không ném lên mã nào (kỳ không có doanh thu để chia).", href: null });
  for (const w of x.costWarnings) {
    add({ key: `warn:${w.rule}`, label: w.title, basis: null, source: r(w.amount), status: "UNRECONCILED", cls: "NOT_IN_BASIS", note: "Cảnh báo mức cao của máy chi phí — khoản chi có thật đang thiếu chứng từ.", href: "/payroll/settings" });
  }

  // ── NHÓM CHI PHÍ ──
  const classes: Record<CostClass, number> = { BY_CODE: 0, SHARED: 0, UNKNOWN_SOURCE: 0, NOT_IN_BASIS: 0 };
  classes.BY_CODE = r(b.cogs + b.adsCodeWithMarketer + b.adsCodeNoMarketer + b.shippingPerShipment + (b.logisticsAdjustment - b.logisticsAdjustmentUnallocated) + b.operatingAllocToCodes);
  classes.SHARED = r(b.adsTestWithMarketer + b.sharedUnallocated + b.logisticsAdjustmentUnallocated);
  classes.UNKNOWN_SOURCE = r(b.adsTestNoMarketer);
  classes.NOT_IN_BASIS = r(e.returnCost + x.costWarnings.reduce((t, w) => t + w.amount, 0));

  // ── ĐỘ PHỦ ──
  const chiPhi = lines.filter((l) => l.cls !== "REVENUE" && !l.key.startsWith("ads-") && l.key !== "shared-unalloc");
  const tongChiPhi = chiPhi.reduce((t, l) => t + Math.abs(l.basis ?? l.source ?? 0), 0);
  const daKhop = chiPhi.filter((l) => l.status === "MATCHED" || l.status === "EXPLAINED").reduce((t, l) => t + Math.abs(l.basis ?? l.source ?? 0), 0);
  const coverage = {
    revenueWithMoneyPct: pct(o.deliveredRevenueWithMoney, o.deliveredRevenue),
    revenueSettledPct: pct(o.settledValue, o.settledValue + o.openValue),
    costReconciledPct: pct(daKhop, tongChiPhi),
  };

  // ── MÃ ──
  const codes = {
    total: x.codes.length,
    withCustomId: x.codes.filter((c) => c.hasCustomId).length,
    // Mã "đủ dữ liệu lợi nhuận": có mã hàng, không dòng nào thiếu giá vốn, QC của mã đều có người.
    profitComplete: x.codes.filter((c) => c.hasCustomId && c.unknownCostLines === 0 && c.adsNoMarketer === 0).length,
    assigned: x.codes.filter((c) => c.assigned).length,
    withProfit: x.codes.filter((c) => c.revenue > 0 || c.profit !== 0).length,
  };

  const issues: ReconIssue[] = lines
    .filter((l) => l.status === "UNRECONCILED")
    .map((l) => ({ code: l.key, label: l.label, amount: l.source ?? l.basis, count: l.key === "open-orders" ? o.openOrders : l.key === "cogs" ? o.unknownCostLines : l.key === "shipping" ? o.sentNoFeeOrders : null, href: l.href }));
  const noMaHang = x.codes.filter((c) => !c.hasCustomId && (c.revenue > 0 || c.profit !== 0));
  if (noMaHang.length) issues.push({ code: "code-no-custom-id", label: "Mã có doanh thu / lợi nhuận nhưng CHƯA có mã hàng", amount: r(noMaHang.reduce((t, c) => t + c.profit, 0)), count: noMaHang.length, href: "/products" });

  const fingerprint = JSON.stringify([x.monthKey, lines.map((l) => [l.key, l.basis, l.source, l.status]), issues.map((i) => [i.code, i.amount, i.count])]);
  return { monthKey: x.monthKey, lines, classes, coverage, codes, issues, status: issues.length ? "UNRECONCILED" : "RECONCILED", fingerprint };
}

/** Khoá ổn định ngắn của dấu vân tay (để so và để in). */
export function reconFingerprintKey(fingerprint: string): string {
  let h = 2166136261;
  for (let i = 0; i < fingerprint.length; i++) {
    h ^= fingerprint.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `rc-${(h >>> 0).toString(16).padStart(8, "0")}-${fingerprint.length}`;
}

/**
 * ═══ TRẠNG THÁI CỦA MỘT KHOẢN THƯỞNG % LỢI NHUẬN ═══
 * Năm nấc theo đúng thứ tự đời sống của khoản tiền: tạm tính → (chưa) đủ điều kiện → đã duyệt → đã trả.
 */
export type ProfitBonusStage = "PROVISIONAL" | "NOT_ELIGIBLE" | "ELIGIBLE" | "APPROVED" | "PAID";
export const PROFIT_BONUS_STAGE_LABEL: Record<ProfitBonusStage, string> = {
  PROVISIONAL: "Tạm tính (chưa xét được điều kiện)",
  NOT_ELIGIBLE: "Chưa đủ điều kiện",
  ELIGIBLE: "Đủ điều kiện, chờ duyệt",
  APPROVED: "Đã duyệt",
  PAID: "Đã thanh toán",
};

export function profitBonusStage(x: { eligible: number | null; established: boolean; runStatus: string | null; paid: boolean }): ProfitBonusStage {
  if (x.paid || x.runStatus === "PAID") return x.eligible && x.eligible > 0 ? "PAID" : "NOT_ELIGIBLE";
  if (!x.established || x.eligible === null) return "PROVISIONAL";
  if (x.eligible <= 0) return "NOT_ELIGIBLE";
  return x.runStatus === "APPROVED" || x.runStatus === "LOCKED" ? "APPROVED" : "ELIGIBLE";
}
