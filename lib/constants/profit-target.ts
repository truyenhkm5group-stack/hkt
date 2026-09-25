/**
 * ═══════════ KẾ HOẠCH MỤC TIÊU LỢI NHUẬN — "MUỐN LÃI X/THÁNG THÌ PHẢI LÀM GÌ" ═══════════
 *
 * Câu hỏi của chủ shop (25/09/2026): *"đặt mục tiêu lợi nhuận tháng 100 tr (hoặc một con số bất kỳ),
 * dựa vào chỉ số của các mã win hiện tại, cho tôi bảng tính các kịch bản để biết cần làm gì"*.
 *
 * Trang Mô phỏng kịch bản trả lời chiều XUÔI (đổi một đòn bẩy → lợi nhuận đi đâu). Đây là chiều
 * NGƯỢC: cố định đích, giải ra số đơn / ngân sách quảng cáo mỗi ngày cần có.
 *
 * ─── ĐIỂM XUẤT PHÁT LÀ CON SỐ CỦA BÁO CÁO, KHÔNG PHẢI MỘT CÔNG THỨC THỨ HAI ───
 *
 * Mỗi mã mang nguyên các khoản của dòng mã trên Báo cáo lợi nhuận danh nghĩa. "Lãi góp mỗi đơn"
 * ở kịch bản giữ nguyên LẤY THẲNG từ dòng mã:
 *
 *     lãi góp/đơn = (LN ròng + vận hành đã nhập phân bổ + cố định phân bổ) ÷ số đơn
 *
 * nên kịch bản "giữ nguyên, nhân 1" ra ĐÚNG lợi nhuận báo cáo đang in (bài kiểm khoá). Đòn bẩy chỉ
 * cộng PHẦN CHÊNH mà nó tạo ra, tính bằng đúng các quy tắc của báo cáo:
 *
 *     doanh thu/đơn  = giá mỗi đơn giao được × (1 + % giá) × TL GTC
 *     giá vốn/đơn    = giá vốn mỗi đơn giao được × TL GTC      (hàng hoàn quay về, không mất)
 *     cước/đơn       = TL GTC × cước gửi + (1 − TL GTC) × cước đơn hoàn   (applyAssumptions)
 *     QC/đơn         = CPO × (1 + % CPO)
 *     rủi ro tồn     = % × giá vốn · thuế = % × doanh thu · CP khác = % × QC
 *
 * ─── BA GIẢ ĐỊNH, NÓI RA CHỨ KHÔNG GIẤU ───
 *
 *   1. TUYẾN TÍNH: nhân đôi đơn thì nhân đôi lãi góp. Thật ra đẩy ngân sách thường làm CPO TĂNG —
 *      nên bảng luôn có một dòng "CPO tăng khi đẩy ngân sách" để thấy cái giá của giả định này.
 *   2. CHI PHÍ CỐ ĐỊNH ĐỨNG YÊN: vận hành đã nhập (lương, mặt bằng, phần mềm) và chi phí cố định
 *      không tăng theo số đơn; đóng hàng và NV vận đơn thì tăng (nằm trong lãi góp/đơn).
 *   3. PHẦN CÒN LẠI GIỮ NGUYÊN: các mã không chọn, QC chưa ghép mã, cước điều chỉnh chưa chia —
 *      đóng góp đúng như hiện tại. Lợi nhuận shop = Σ lãi góp mã chọn + phần còn lại − cố định.
 *
 * Đây là PHÉP TÍNH KẾ HOẠCH, không phải dự báo: mọi con số đọc là "để đạt đích thì cần", và dựa
 * trên tỷ lệ GTC ước tính của báo cáo (phần đơn đang đi còn là xác suất).
 *
 * Hàm THUẦN: không đọc/ghi CSDL.
 */

/** Một mã, đúng các khoản của dòng mã trên Báo cáo lợi nhuận danh nghĩa (trong kỳ gốc). */
export type TargetSku = {
  productId: string;
  code: string;
  name: string;
  orders: number;
  items: number;
  expectedRevenue: number;
  expectedCogs: number;
  adSpend: number;
  operatingAlloc: number;
  fixedAlloc: number;
  netProfit: number;
  /** TL GTC ước tính (%) của báo cáo. `null` = chưa đo được ⇒ mã không vào phép tính. */
  deliveryRate: number | null;
  /** Còn sản phẩm chưa có giá vốn nào ⇒ lãi góp đang CAO hơn thật. */
  cogsIncomplete: boolean;
  /** Tồn thực tế theo Sổ kho; `null` = chưa có phiếu nhập (chưa biết, không phải 0). */
  stockQty: number | null;
};

export type TargetAssumptions = {
  shipFeeDelivered: number;
  shipFeeReturned: number;
  taxPercent: number;
  otherCostPercentOfAds: number;
  inventoryRiskPercent: number;
};

/** Ba đòn bẩy. 0 = giữ nguyên. */
export type TargetLevers = {
  /** Cộng thêm điểm % vào TL GTC (vd +5 ⇒ 40% → 45%). */
  gtcPoints: number;
  /** % đổi chi phí quảng cáo mỗi đơn (âm = rẻ hơn). */
  cpoPercent: number;
  /** % đổi giá bán / giá trị đơn (giả định tỷ lệ chốt không đổi). */
  pricePercent: number;
};

export const NO_LEVERS: TargetLevers = { gtcPoints: 0, cpoPercent: 0, pricePercent: 0 };

/** Số ngày của "một tháng" khi quy đổi — cùng quy ước 30 ngày của kỳ mặc định "30 ngày qua". */
export const DAYS_PER_MONTH = 30;

export type SkuUnit = {
  sku: TargetSku;
  /** TL GTC sau đòn bẩy (0–1). */
  gtc: number;
  /** Lãi góp mỗi đơn LÊN (trước chi phí cố định). */
  contributionPerOrder: number;
  cpo: number;
  /** Doanh thu GTC ƯT mỗi đơn lên. */
  revenuePerOrder: number;
  /** Đơn lên mỗi ngày trong kỳ gốc. */
  ordersPerDay: number;
};

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Lãi góp mỗi đơn của một mã dưới một bộ đòn bẩy. `null` khi mã không tính được: chưa có đơn,
 * chưa đo được TL GTC, hoặc TL GTC = 0 (không có giá mỗi đơn giao được để suy ra).
 */
export function skuUnit(sku: TargetSku, a: TargetAssumptions, lv: TargetLevers, periodDays: number): SkuUnit | null {
  if (sku.orders <= 0 || sku.deliveryRate === null || periodDays <= 0) return null;
  const g0 = clamp01(sku.deliveryRate / 100);
  if (g0 <= 0) return null;
  const g = clamp01(g0 + lv.gtcPoints / 100);
  const priceDelivered = sku.expectedRevenue / (sku.orders * g0);
  const cogsDelivered = sku.expectedCogs / (sku.orders * g0);
  const cpo0 = sku.adSpend / sku.orders;
  const tax = Math.max(0, a.taxPercent) / 100;
  const other = Math.max(0, a.otherCostPercentOfAds) / 100;
  const risk = Math.max(0, a.inventoryRiskPercent) / 100;

  /** Phần của lãi góp/đơn phụ thuộc đòn bẩy. Chi phí theo đơn không đổi (đóng hàng, NV) triệt tiêu trong phép trừ. */
  const bienDoi = (gg: number, gia: number, cpo: number) => {
    const rev = priceDelivered * (1 + gia) * gg;
    const cogs = cogsDelivered * gg;
    const ship = gg * a.shipFeeDelivered + (1 - gg) * a.shipFeeReturned;
    return rev - cogs - ship - cpo - risk * cogs - tax * rev - other * cpo;
  };
  const cpo = cpo0 * (1 + lv.cpoPercent / 100);
  const goc = (sku.netProfit + sku.operatingAlloc + sku.fixedAlloc) / sku.orders;
  const contributionPerOrder = goc + bienDoi(g, lv.pricePercent / 100, cpo) - bienDoi(g0, 0, cpo0);
  return {
    sku,
    gtc: g,
    contributionPerOrder,
    cpo,
    revenuePerOrder: priceDelivered * (1 + lv.pricePercent / 100) * g,
    ordersPerDay: sku.orders / periodDays,
  };
}

export type TargetBaseline = {
  /** LN ròng cả shop quy về một tháng (theo báo cáo). */
  shopMonthly: number;
  /** Vận hành đã nhập + chi phí cố định, quy về một tháng. */
  fixedMonthly: number;
  /** Σ lãi góp các mã chọn, quy về một tháng. */
  selectedContributionMonthly: number;
  /** Phần còn lại (mã không chọn + QC chưa ghép mã + cước chưa chia), giữ nguyên. */
  restMonthly: number;
};

export function baseline(skus: TargetSku[], shopNetProfit: number, fixedInPeriod: number, periodDays: number): TargetBaseline {
  const m = DAYS_PER_MONTH / periodDays;
  const shopMonthly = shopNetProfit * m;
  const fixedMonthly = fixedInPeriod * m;
  const selectedContributionMonthly = skus.reduce((t, s) => t + (s.netProfit + s.operatingAlloc + s.fixedAlloc), 0) * m;
  // LN shop = lãi góp mã chọn + phần còn lại − cố định ⇒ phần còn lại là số dư đúng, không đoán.
  const restMonthly = shopMonthly - selectedContributionMonthly + fixedMonthly;
  return { shopMonthly, fixedMonthly, selectedContributionMonthly, restMonthly };
}

export type ScenarioSku = {
  productId: string;
  label: string;
  ordersPerDayNow: number;
  ordersPerDayNeeded: number | null;
  adPerDayNeeded: number | null;
  contributionPerOrder: number;
  /** Sản phẩm gửi đi mỗi tháng cần có (đơn × sp/đơn) — so với tồn. */
  itemsMonthlyNeeded: number | null;
  stockQty: number | null;
};

export type ScenarioResult = {
  levers: TargetLevers;
  /** Lãi góp bình quân mỗi đơn của các mã chọn (theo tỷ trọng đơn hiện tại). */
  contributionPerOrder: number | null;
  /** LN tháng nếu GIỮ số đơn như hiện tại mà chỉ đổi đòn bẩy. */
  profitAtCurrentVolume: number;
  /**
   * Hệ số nhân số đơn so với hiện tại để đạt đích (giữ nguyên tỷ trọng giữa các mã).
   * `null` = KHÔNG đạt được bằng cách tăng đơn: mỗi đơn đang lỗ (lãi góp ≤ 0).
   */
  multiplier: number | null;
  ordersPerDay: number | null;
  adPerDay: number | null;
  revenueMonthly: number | null;
  perSku: ScenarioSku[];
};

/**
 * Giải: cần nhân số đơn của các mã chọn lên bao nhiêu lần để LN ròng tháng = đích.
 *
 *     đích = k × Σ lãi góp mã chọn(đòn bẩy) + phần còn lại − cố định
 */
export function solveScenario(units: SkuUnit[], base: TargetBaseline, targetMonthly: number, lv: TargetLevers): ScenarioResult {
  const m = DAYS_PER_MONTH;
  const monthOrders = (u: SkuUnit) => u.ordersPerDay * m;
  const contrib = units.reduce((t, u) => t + u.contributionPerOrder * monthOrders(u), 0);
  const totalOrdersMonth = units.reduce((t, u) => t + monthOrders(u), 0);
  const need = targetMonthly + base.fixedMonthly - base.restMonthly;
  const multiplier = contrib > 0 ? Math.max(0, need / contrib) : null;
  const perSku: ScenarioSku[] = units.map((u) => {
    const perDay = multiplier === null ? null : u.ordersPerDay * multiplier;
    const itemsPerOrder = u.sku.orders > 0 ? u.sku.items / u.sku.orders : 0;
    return {
      productId: u.sku.productId,
      label: u.sku.code || u.sku.name,
      ordersPerDayNow: u.ordersPerDay,
      ordersPerDayNeeded: perDay,
      adPerDayNeeded: perDay === null ? null : perDay * u.cpo,
      contributionPerOrder: u.contributionPerOrder,
      itemsMonthlyNeeded: perDay === null ? null : perDay * m * itemsPerOrder,
      stockQty: u.sku.stockQty,
    };
  });
  return {
    levers: lv,
    contributionPerOrder: totalOrdersMonth > 0 ? contrib / totalOrdersMonth : null,
    profitAtCurrentVolume: contrib + base.restMonthly - base.fixedMonthly,
    multiplier,
    ordersPerDay: multiplier === null ? null : perSku.reduce((t, s) => t + (s.ordersPerDayNeeded ?? 0), 0),
    adPerDay: multiplier === null ? null : perSku.reduce((t, s) => t + (s.adPerDayNeeded ?? 0), 0),
    revenueMonthly: multiplier === null ? null : units.reduce((t, u) => t + u.revenuePerOrder * monthOrders(u) * multiplier, 0),
    perSku,
  };
}

/**
 * NẾU CHỈ MỘT MÃ GÁNH PHẦN CÒN THIẾU (các mã khác giữ nguyên): mã ấy cần bao nhiêu đơn/ngày.
 * `null` khi lãi góp/đơn của mã ≤ 0 — bán thêm mã lỗ chỉ làm xa đích hơn.
 */
export function soloOrdersPerDay(unit: SkuUnit, allUnits: SkuUnit[], base: TargetBaseline, targetMonthly: number): number | null {
  if (unit.contributionPerOrder <= 0) return null;
  const contrib = allUnits.reduce((t, u) => t + u.contributionPerOrder * u.ordersPerDay * DAYS_PER_MONTH, 0);
  const gap = targetMonthly - (contrib + base.restMonthly - base.fixedMonthly);
  return Math.max(0, unit.ordersPerDay + gap / unit.contributionPerOrder / DAYS_PER_MONTH);
}

/** Đòn bẩy nhập tay bị kẹp về khoảng có nghĩa — một ô gõ nhầm "500" không được ra kịch bản vô lý. */
export function clampTargetLevers(lv: Partial<TargetLevers>): TargetLevers {
  const f = (v: unknown, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : 0;
  };
  return { gtcPoints: f(lv.gtcPoints, -50, 50), cpoPercent: f(lv.cpoPercent, -90, 200), pricePercent: f(lv.pricePercent, -50, 100) };
}

export type TargetSteps = { gtcPoints: number; cpoPercent: number; pricePercent: number };

/** Bước mặc định của các kịch bản mẫu — chỉ là CỠ BƯỚC để so sánh, người xem sửa được ngay trên trang. */
export const DEFAULT_TARGET_STEPS: TargetSteps = { gtcPoints: 5, cpoPercent: 10, pricePercent: 5 };

export type TargetScenarioDef = { key: string; label: string; levers: TargetLevers };

/**
 * Các kịch bản mẫu: giữ nguyên · từng đòn bẩy riêng · cả ba · và MỘT kịch bản XẤU (CPO tăng khi
 * đẩy ngân sách) để giả định tuyến tính không trông như một lời hứa. Kịch bản riêng của người xem
 * (nếu có) đứng cuối.
 */
export function buildScenarios(steps: TargetSteps, custom: TargetLevers | null): TargetScenarioDef[] {
  const s = clampTargetLevers(steps);
  const out: TargetScenarioDef[] = [{ key: "giu", label: "Giữ nguyên chỉ số, chỉ tăng đơn", levers: NO_LEVERS }];
  if (s.gtcPoints) out.push({ key: "gtc", label: `TL GTC +${s.gtcPoints} điểm`, levers: { ...NO_LEVERS, gtcPoints: s.gtcPoints } });
  if (s.cpoPercent) out.push({ key: "cpo", label: `CPO −${s.cpoPercent}%`, levers: { ...NO_LEVERS, cpoPercent: -s.cpoPercent } });
  if (s.pricePercent) out.push({ key: "gia", label: `Giá bán +${s.pricePercent}%`, levers: { ...NO_LEVERS, pricePercent: s.pricePercent } });
  if ([s.gtcPoints, s.cpoPercent, s.pricePercent].filter(Boolean).length > 1)
    out.push({ key: "ca3", label: "Cả ba cùng lúc", levers: { gtcPoints: s.gtcPoints, cpoPercent: -s.cpoPercent, pricePercent: s.pricePercent } });
  if (s.cpoPercent) out.push({ key: "xau", label: `Rủi ro: CPO +${s.cpoPercent}% khi đẩy ngân sách`, levers: { ...NO_LEVERS, cpoPercent: s.cpoPercent } });
  if (custom && (custom.gtcPoints || custom.cpoPercent || custom.pricePercent)) {
    const c = clampTargetLevers(custom);
    const phan = [c.gtcPoints ? `GTC ${c.gtcPoints > 0 ? "+" : ""}${c.gtcPoints} điểm` : null, c.cpoPercent ? `CPO ${c.cpoPercent > 0 ? "+" : ""}${c.cpoPercent}%` : null, c.pricePercent ? `giá ${c.pricePercent > 0 ? "+" : ""}${c.pricePercent}%` : null].filter(Boolean);
    out.push({ key: "rieng", label: `Kịch bản của bạn: ${phan.join(" · ")}`, levers: c });
  }
  return out;
}
