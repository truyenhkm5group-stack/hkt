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
    /** Σ `products[].adSpend` — QC đã trừ vào lợi nhuận mã. */
    adsCode: number;
    /** `totals.testSpend` — QC không gắn mã. */
    adsTest: number;
    /** Σ `marketers[].products[].adSpend` (mọi dòng, kể cả nhóm chưa gán) — phần QC của mã ĐI VÀO quy kết người. */
    adsCodeInPersonLines: number;
    /** Cước chiều đi theo vận đơn (gồm kiện đang đi), KHÔNG gồm điều chỉnh tay. */
    shippingPerShipment: number;
    logisticsAdjustment: number;
    logisticsAdjustmentUnallocated: number;
    operatingEntered: number;
    fixedCostAssumption: number;
    perOrderOpsEstimate: number;
    sharedUnallocated: number;
    profit: number;
    /** Phần loại khỏi cơ sở vì là thù lao biến đổi — ước tính ranh giới thì `estimated`. */
    basisExclusionMeasured: number;
    basisExclusionEstimated: number;
  };
  /** QC đo THẲNG trên `ad_spends` của kỳ (ngày chi), chia bốn ô — không đi qua phép quy kết nào. */
  adsRaw: { codeWithMarketer: number; codeNoMarketer: number; testWithMarketer: number; testNoMarketer: number };
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
    /** Doanh thu giao thành công của dòng hàng CÓ mã (cùng tập dòng với cơ sở). */
    deliveredRevenue: number;
    /** Doanh thu giao thành công của dòng hàng KHÔNG có mã — cơ sở lương bỏ qua chúng. */
    deliveredRevenueNoProduct: number;
    deliveredRevenueWithMoney: number;
    deliveredOrders: number;
    deliveredOrdersWithMoney: number;
    /** Đơn ĐÃ XÁC NHẬN chưa kết thúc (đang đi · chưa rời kho · chưa biết). */
    openOrders: number;
    openValue: number;
    /** Giá trị hàng của đơn ĐÃ KẾT THÚC (giao thành công + hoàn), không gồm đơn huỷ. */
    settledValue: number;
    returnedOrders: number;
    cancelledOrders: number;
    /** Dòng hàng đã giao mà giá vốn rơi về 0 (không phiếu nhập, không giá Pancake, không giá nhập mẫu mã). */
    unknownCostLines: number;
    unknownCostRevenue: number;
    /** Σ số lượng × (giá vốn cơ sở − giá vốn khi bỏ giá báo MKT) trên hàng đã giao — phần chênh do giá báo. */
    cogsMarketerPriceEffect: number;
    /** Cước theo vận đơn (nguyên đơn) của kiện ĐANG ĐI — cơ sở trừ, máy chi phí chưa trừ. */
    inTransitShipping: number;
    sentOrders: number;
    /** Kiện đã gửi mà cước rơi về 0 (không phí vận đơn, không phí đối tác). */
    sentNoFeeOrders: number;
  };
  /** Cảnh báo `high` của máy chi phí. */
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
  /** Dấu vân tay mọi con số của bảng — chụp vào ảnh kỳ, chữ ký cấp 1 ký đúng chuỗi này. */
  fingerprint: string;
};

const r = (n: number) => Math.round(n);
const pct = (a: number, b: number) => (b > 0 ? a / b : null);
const vnd = (n: number) => `${r(n).toLocaleString("vi-VN")} ₫`;

/** Cảnh báo thật sự là "chi phí có thật chưa vào cơ sở" — các cảnh báo trùng nguồn là khoản bị LOẠI vì trùng. */
const NOT_IN_BASIS_WARNINGS = new Set(["PAYROLL_OBLIGATION_NOT_RECOGNIZED"]);

/** Dựng đối soát một tháng. `period` dạng link: `period=custom&from=…&to=…`. */
export function buildMonthReconciliation(x: MonthReconInput, periodQuery: string): MonthReconciliation {
  const b = x.basis;
  const e = x.engine;
  const o = x.orders;
  const q = x.adsRaw;
  const lines: ReconLine[] = [];
  const add = (l: Omit<ReconLine, "diff">) => lines.push({ ...l, diff: l.basis !== null && l.source !== null ? r(l.basis - l.source) : null });

  // ── DOANH THU ──
  const thieuTien = o.deliveredRevenue - o.deliveredRevenueWithMoney;
  add({
    key: "revenue",
    label: "Doanh thu giao thành công (theo ORDER_OUTCOME)",
    basis: r(b.revenue),
    source: r(o.deliveredRevenue),
    status: r(b.revenue) === r(o.deliveredRevenue) && thieuTien <= 0 ? "MATCHED" : "UNRECONCILED",
    cls: "REVENUE",
    note:
      (r(b.revenue) !== r(o.deliveredRevenue) ? `Cơ sở lệch số đo lại ${vnd(b.revenue - o.deliveredRevenue)} — kiểm biểu thức kết quả đơn. ` : "") +
      (thieuTien > 0
        ? `${(o.deliveredOrders - o.deliveredOrdersWithMoney).toLocaleString("vi-VN")} đơn đã giao CHƯA có chứng từ tiền (${vnd(thieuTien)}) — doanh thu chưa xác minh, không phải đã thu.`
        : "Mọi đơn đã giao đều có chứng từ tiền (COD thực thu hoặc chuyển khoản)."),
    href: "/cod?recon=unproven",
  });
  add({
    key: "revenue-no-product",
    label: "Doanh thu giao thành công của dòng hàng KHÔNG có mã",
    basis: null,
    source: r(o.deliveredRevenueNoProduct),
    status: o.deliveredRevenueNoProduct > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "REVENUE",
    note: o.deliveredRevenueNoProduct > 0 ? "Dòng hàng không ghép được mẫu mã / sản phẩm — cơ sở lương BỎ QUA chúng (không doanh thu, không giá vốn). Ghép mẫu mã rồi đo lại." : "Mọi dòng hàng đã giao đều có mã.",
    href: "/products",
  });
  add({
    key: "open-orders",
    label: "Đơn đã xác nhận của tháng CHƯA kết thúc (đang đi · chưa rời kho · chưa biết)",
    basis: null,
    source: r(o.openValue),
    status: o.openOrders > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "REVENUE",
    note: o.openOrders > 0 ? `${o.openOrders.toLocaleString("vi-VN")} đơn chưa có kết quả — doanh thu và giá vốn của chúng CHƯA vào cơ sở, cước và chi phí theo đơn ĐÃ vào. Lợi nhuận tháng còn đổi.` : "Mọi đơn đã xác nhận của tháng đã có kết quả.",
    href: `/shipments?${periodQuery}`,
  });

  // ── GIÁ VỐN ── chênh chỉ "đã giải thích" khi phần dư sau khi trừ ảnh hưởng giá báo MKT về 0 (sai số làm tròn ≤ 1 ₫ / đơn).
  const tolCogs = Math.max(1, o.deliveredOrders);
  const duCogs = b.cogs - e.cogs - o.cogsMarketerPriceEffect;
  add({
    key: "cogs",
    label: "Giá vốn hàng giao thành công",
    basis: r(b.cogs),
    source: r(e.cogs),
    status: o.unknownCostLines > 0 ? "UNRECONCILED" : r(b.cogs) === r(e.cogs) ? "MATCHED" : Math.abs(duCogs) <= tolCogs ? "EXPLAINED" : "UNRECONCILED",
    cls: "BY_CODE",
    note:
      (o.unknownCostLines > 0 ? `${o.unknownCostLines.toLocaleString("vi-VN")} dòng hàng đã giao (doanh thu ${vnd(o.unknownCostRevenue)}) KHÔNG có giá vốn nào — cơ sở đang tính 0 ₫ cho chúng, lợi nhuận cao hơn thật. ` : "") +
      (r(b.cogs) === r(e.cogs)
        ? "Khớp máy chi phí."
        : `Chênh ${vnd(b.cogs - e.cogs)} = giá báo MKT ${vnd(o.cogsMarketerPriceEffect)} + phần dư ${vnd(duCogs)}${Math.abs(duCogs) <= tolCogs ? " (làm tròn)" : " — cơ sở dùng giá vốn HÔM NAY (phiếu nhập mới nhất), máy chi phí dùng giá vốn đã chốt lúc giao: phần dư này chưa được đối chiếu"}.`),
    href: "/data-quality?issue=missing-cogs",
  });

  // ── QUẢNG CÁO ── tổng đối chiếu máy chi phí; bốn ô đo THẲNG trên ad_spends.
  const adsBasis = b.adsCode + b.adsTest;
  const adsRawTong = q.codeWithMarketer + q.codeNoMarketer + q.testWithMarketer + q.testNoMarketer;
  add({ key: "ads", label: "Chi phí quảng cáo (tổng)", basis: r(adsBasis), source: r(e.ads), status: r(adsBasis) === r(e.ads) ? "MATCHED" : "UNRECONCILED", cls: "BY_CODE", note: r(adsBasis) === r(e.ads) ? "Khớp máy chi phí." : `Tổng QC trong cơ sở lương lệch máy chi phí ${vnd(adsBasis - e.ads)}.`, href: `/ads?${periodQuery}` });
  add({
    key: "ads-parts",
    label: "· Bốn ô QC đo thẳng trên bảng chi (cộng lại)",
    basis: r(adsBasis),
    source: r(adsRawTong),
    status: r(adsBasis) === r(adsRawTong) ? "MATCHED" : "UNRECONCILED",
    cls: "BY_CODE",
    note: r(adsBasis) === r(adsRawTong) ? "Bốn ô cộng lại đúng bằng QC của cơ sở." : `Bốn ô lệch cơ sở ${vnd(adsBasis - adsRawTong)}.`,
    href: `/ads?${periodQuery}`,
  });
  add({ key: "ads-code-mk", label: "· QC gắn mã, có MKTer", basis: null, source: r(q.codeWithMarketer), status: "MATCHED", cls: "BY_CODE", note: "Vào lợi nhuận mã và căn cứ trọng số SUPPORT.", href: `/ads?${periodQuery}` });
  add({
    key: "ads-code-nomk",
    label: "· QC gắn mã, CHƯA gán MKTer",
    basis: null,
    source: r(q.codeNoMarketer),
    status: q.codeNoMarketer > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "BY_CODE",
    note: "Lợi nhuận mã vẫn đúng (tiền đã trừ vào mã), nhưng không biết của ai — trọng số SUPPORT theo chi phí QC thiếu phần này.",
    href: `/ads?${periodQuery}&marketer=__none__`,
  });
  add({ key: "ads-test-mk", label: "· QC không gắn mã (test), có MKTer", basis: null, source: r(q.testWithMarketer), status: "MATCHED", cls: "SHARED", note: "Chi phí chung có người chịu — trừ vào lợi nhuận cá nhân người chạy, không vào mã nào.", href: `/ads?${periodQuery}&product=__test__` });
  add({
    key: "ads-test-nomk",
    label: "· QC không gắn mã, không gán MKTer",
    basis: null,
    source: r(q.testNoMarketer),
    status: q.testNoMarketer > 0 ? "UNRECONCILED" : "MATCHED",
    cls: "UNKNOWN_SOURCE",
    note: "Tiền thật đã trừ khỏi lợi nhuận công ty nhưng không thuộc mã nào, không thuộc ai.",
    href: `/ads?${periodQuery}&product=__test__&marketer=__none__`,
  });
  const ngoaiQuyKet = b.adsCode - b.adsCodeInPersonLines;
  add({
    key: "ads-outside-attribution",
    label: "· QC của mã KHÔNG đi vào quy kết của MKTer nào",
    basis: r(b.adsCode),
    source: r(b.adsCodeInPersonLines),
    status: r(ngoaiQuyKet) === 0 ? "MATCHED" : "UNRECONCILED",
    cls: "BY_CODE",
    note:
      r(ngoaiQuyKet) === 0
        ? "Mọi đồng QC của mã đều nằm trong dòng của một MKTer (hoặc nhóm chưa gán)."
        : `${vnd(ngoaiQuyKet)} QC đã trừ vào lợi nhuận mã nhưng không nằm trong dòng của MKTer nào (vd mã quy kết theo fanpage, người chi QC không có trong tỷ lệ) — "chi tiền không ai nhận".`,
    href: `/ads?${periodQuery}`,
  });

  // ── LOGISTICS ── chênh cước chỉ "đã giải thích" khi phần dư sau khi trừ cước kiện đang đi về 0 (≤ 1 ₫ / kiện).
  const duShip = b.shippingPerShipment - e.shipping - o.inTransitShipping;
  const tolShip = Math.max(1, o.sentOrders);
  add({
    key: "shipping",
    label: "Cước chiều đi theo vận đơn",
    basis: r(b.shippingPerShipment),
    source: r(e.shipping),
    status: o.sentNoFeeOrders > 0 ? "UNRECONCILED" : r(b.shippingPerShipment) === r(e.shipping) ? "MATCHED" : Math.abs(duShip) <= tolShip ? "EXPLAINED" : "UNRECONCILED",
    cls: "BY_CODE",
    note:
      (o.sentNoFeeOrders > 0 ? `${o.sentNoFeeOrders.toLocaleString("vi-VN")} kiện đã gửi KHÔNG có cước (tính 0 ₫). ` : "") +
      `Chênh ${vnd(b.shippingPerShipment - e.shipping)} = cước kiện đang đi ${vnd(o.inTransitShipping)} + phần dư ${vnd(duShip)}${Math.abs(duShip) <= tolShip ? " (làm tròn khi chia cước theo dòng hàng)" : " — chưa giải thích (cước chia theo dòng hàng lệch tổng đơn, hoặc đơn tổng tiền 0)"}.`,
    href: `/shipments?${periodQuery}`,
  });
  add({ key: "logistics-adj", label: "Điều chỉnh cước / phí hoàn có lý do (gõ tay)", basis: r(b.logisticsAdjustment), source: r(b.logisticsAdjustment), status: "MATCHED", cls: "BY_CODE", note: "Cùng một con số của máy chi phí (không phải đối chiếu độc lập).", href: "/expenses" });
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
  const opNguon = e.operatingTotal - b.basisExclusionMeasured - b.basisExclusionEstimated;
  add({
    key: "operating",
    label: "Chi phí vận hành đã nhập (sau khi loại thù lao biến đổi)",
    basis: r(b.operatingEntered),
    source: r(opNguon),
    status: r(b.operatingEntered) === r(opNguon) ? (b.basisExclusionEstimated > 0 ? "ESTIMATED" : "MATCHED") : "UNRECONCILED",
    cls: "SHARED",
    note:
      "CÙNG nguồn với máy chi phí (bảng Chi phí theo kỳ phân bổ) — kiểm sự nhất quán, không phải đối chiếu độc lập với sao kê." +
      (b.basisExclusionEstimated > 0 ? ` Ranh giới lương cứng / hoa hồng trong nhóm Lương là ƯỚC TÍNH (${vnd(b.basisExclusionEstimated)} loại khỏi cơ sở).` : ""),
    href: "/expenses",
  });
  add({ key: "fixed-assumption", label: "Chi phí cố định GIẢ ĐỊNH (Lương → Cấu hình, theo tháng)", basis: r(b.fixedCostAssumption), source: null, status: b.fixedCostAssumption > 0 ? "ESTIMATED" : "MATCHED", cls: "SHARED", note: "Khai báo, không phải chứng từ — cộng THÊM vào chi phí đã nhập, chia xuống mã theo doanh thu.", href: "/payroll/settings" });
  add({ key: "per-order-ops", label: "Đóng gói + nhân viên vận đơn theo đơn (định mức)", basis: r(b.perOrderOpsEstimate), source: null, status: b.perOrderOpsEstimate > 0 ? "ESTIMATED" : "MATCHED", cls: "BY_CODE", note: "Định mức × số kiện gửi (kèm tỷ lệ cứu đơn) — ước tính.", href: "/payroll/settings" });
  add({ key: "shared-unalloc", label: "· trong đó KHÔNG chia được xuống mã", basis: r(b.sharedUnallocated + b.logisticsAdjustmentUnallocated), source: null, status: "MATCHED", cls: "SHARED", note: "Vẫn trừ khỏi lợi nhuận công ty, không ném lên mã nào (kỳ không có doanh thu để chia).", href: null });
  for (const w of x.costWarnings) {
    const chuaVao = NOT_IN_BASIS_WARNINGS.has(w.rule);
    add({
      key: `warn:${w.rule}`,
      label: w.title,
      basis: null,
      source: r(w.amount),
      status: "UNRECONCILED",
      cls: chuaVao ? "NOT_IN_BASIS" : "SHARED",
      note: chuaVao ? "Khoản chi có thật chưa có chứng từ trong kỳ — chưa vào cơ sở lương." : "Khoản bị LOẠI vì trùng nguồn — không cộng thêm vào đâu; người đối soát kiểm tay phần chênh.",
      href: "/payroll/settings",
    });
  }

  // ── NHÓM CHI PHÍ ── (chi phí chung CHIA xuống mã theo doanh thu vẫn là chi phí chung)
  const classes: Record<CostClass, number> = {
    BY_CODE: r(b.cogs + b.adsCode + b.shippingPerShipment + (b.logisticsAdjustment - b.logisticsAdjustmentUnallocated) + b.perOrderOpsEstimate),
    SHARED: r(b.operatingEntered + b.fixedCostAssumption + q.testWithMarketer + b.logisticsAdjustmentUnallocated),
    UNKNOWN_SOURCE: r(q.testNoMarketer),
    NOT_IN_BASIS: r(e.returnCost + x.costWarnings.filter((w) => NOT_IN_BASIS_WARNINGS.has(w.rule)).reduce((t, w) => t + w.amount, 0)),
  };

  // ── ĐỘ PHỦ ──
  const COST_KEYS = new Set(["cogs", "ads", "shipping", "logistics-adj", "return-cost", "operating", "fixed-assumption", "per-order-ops"]);
  const chiPhi = lines.filter((l) => COST_KEYS.has(l.key) || l.key.startsWith("warn:"));
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

  const COUNT: Record<string, number> = { "open-orders": o.openOrders, cogs: o.unknownCostLines, shipping: o.sentNoFeeOrders };
  const issues: ReconIssue[] = lines
    .filter((l) => l.status === "UNRECONCILED")
    .map((l) => ({ code: l.key, label: l.label, amount: l.diff ?? l.source ?? l.basis, count: COUNT[l.key] ?? null, href: l.href }));
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

/**
 * ═══ CẤP 2: ĐIỀU KIỆN DUYỆT / KHOÁ KỲ CÓ THƯỞNG % LỢI NHUẬN ĐỦ ĐIỀU KIỆN ═══
 *
 * Chữ ký cấp 1 ký trên ẢNH CHỤP kỳ (không phải số sống — số sống đổi theo từng webhook, ký số sống là
 * không bao giờ khớp). `null` = được phép. Hàm thuần: server đọc chữ ký TRONG giao dịch rồi gọi vào đây.
 */
export function profitApprovalProblem(x: {
  allocatedTotal: number | null | undefined;
  monthKey: string;
  snapshotFingerprint: string | null | undefined;
  signoffs: readonly { id: string; monthKey: string; fingerprint: string; signedById: string | null; signedByEmail: string; revokedAt?: string | null }[];
  actorId: string | null;
  /** `true` ở bước DUYỆT (người duyệt phải khác người ký); `false` ở bước KHOÁ (chỉ cần chữ ký còn hiệu lực). */
  requireDifferentPerson: boolean;
}): string | null {
  if (!((x.allocatedTotal ?? 0) > 0)) return null;
  if (!x.snapshotFingerprint) return "Kỳ có thưởng % lợi nhuận đủ điều kiện nhưng ảnh chụp không mang bảng đối soát — bấm “Tính lại” để chụp lại.";
  const ky = x.signoffs.find((s) => !s.revokedAt && s.monthKey === x.monthKey && s.fingerprint === x.snapshotFingerprint) ?? null;
  if (!ky) return `Kỳ tháng ${x.monthKey} có thưởng % lợi nhuận đủ điều kiện nhưng CHƯA có chữ ký đối soát cấp 1 còn hiệu lực trên ĐÚNG ảnh chụp này. Mở Lương → Đối soát để ký (hoặc ký lại nếu chữ ký cũ đã huỷ / ảnh đã tính lại).`;
  if (x.requireDifferentPerson && ky.signedById !== null && ky.signedById === x.actorId) return `Bạn đã ký đối soát cấp 1 cho tháng này (${ky.signedByEmail}). Duyệt cấp 2 phải do MỘT NGƯỜI KHÁC.`;
  return null;
}
