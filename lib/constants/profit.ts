import type { StoredDeliveryRateOverride } from "@/lib/constants/delivery-rate";

/** Giả định dùng cho báo cáo lợi nhuận danh nghĩa theo mã hàng (lưu trong settings: profit.assumptions) */
export type ProfitAssumptions = {
  /**
   * Cước gửi ĐVVC cho MỌI đơn gửi đi, kể cả đơn sau đó hoàn (đ). `null` = để trống ⇒ tự tính bình
   * quân 90 ngày từ dữ liệu; một con số — KỂ CẢ 0 — là số đặt tay. Đọc qua `manualShipFee()`.
   */
  shipFeeDelivered: number | null;
  /**
   * Tổng cước một đơn hoàn = cước gửi + phí hoàn về (đ). `null` = để trống ⇒ cước gửi + phí hoàn
   * bình quân (nếu có dữ liệu), không thì gấp đôi cước gửi; một con số — KỂ CẢ 0 — là số đặt tay.
   */
  shipFeeReturned: number | null;
  /**
   * ═══ SỐ 0 CỦA Ô CƯỚC LÀ 0 THẬT ═══
   *
   * Bản lưu trước 06/10/2026 dùng 0 cho "để trống ⇒ tự tính", nên chủ shop gõ 0 (shop tự giao,
   * không trả cước) thì màn hình vẫn in 17.000 ₫ và lợi nhuận vẫn trừ cước. Từ bản này biểu mẫu
   * lưu `null` cho ô trống và bật cờ này; THIẾU cờ là dòng cũ, 0 của nó vẫn đọc theo nghĩa cũ —
   * không backfill, không đổi nghĩa một dòng đã lưu (AGENTS.md mục 8.8). KHÔNG đặt cờ này trong
   * `DEFAULT_PROFIT_ASSUMPTIONS`: `getSettingJson` trộn mặc định vào dòng đã lưu, và cờ ở mặc định
   * sẽ biến 0 "tự tính" của mọi dòng cũ thành 0 ₫.
   */
  shipFeeExplicitZero?: boolean;
  /**
   * ═══ CƯỚC ƯỚC TÍNH THEO KHOẢNG THỜI GIAN (chủ shop 21/10/2026) ═══
   *
   * "Chi phí vận chuyển ước tính có thể thay đổi theo khoảng thời gian khác nhau (sản lượng tăng thì deal
   * được giá cước thấp hơn, hoặc chính sách đổi) — không cố định xuyên suốt." Mỗi mốc có hiệu lực TỪ ngày
   * của nó tới TRƯỚC mốc kế tiếp; trước mốc đầu tiên dùng hai ô chung ở trên. Chỉ là ƯỚC TÍNH: cước THẬT của
   * một vận đơn luôn là số Viettel Post ghi nhận (`lib/queries/shipping-cost.ts`).
   */
  shipFeeSchedule?: ShipFeePeriod[];
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
  /**
   * ═══════════ MỐC "ĐỦ CHÍN": KHI NÀO MÁY ĐƯỢC TỰ ĐO MỘT MÃ ═══════════
   *
   * Mã có đủ ngần này đơn ĐÃ CÓ KẾT CỤC của chính nó thì bậc `projected` được chạy — tức mỗi đơn
   * đang giao được cân theo xác suất của trạng thái ĐVVC nó đang ở. Chưa đủ thì mã nằm ở bảng
   * **"Mã mới · chưa đủ căn cứ"** và tỷ lệ của nó là số đo của CHÍNH MÃ co ngót về `defaultReturnRate`.
   *
   * Con số này cũng là TRỌNG SỐ của mốc neo khi co ngót — cùng một câu hỏi thì cùng một con số.
   *
   * ─── VÌ SAO KHÔNG DÙNG CHUNG `minFinishedOrders` ───
   *
   * Hai ngưỡng gác hai thứ khác nhau. `minFinishedOrders` (chủ shop để 50) gác một TỶ LỆ THÔ:
   * "giao ÷ đã kết thúc" trong 90 ngày, không có gì đỡ, nên nó phải đòi nhiều bằng chứng.
   * `rateMatureMinFinished` (chủ shop chốt 10 ngày 23/09/2026) gác một MÔ HÌNH CÓ ĐIỀU KIỆN HOÁ,
   * thứ còn đọc được cả những đơn đang chạy. Ép cả hai về một con số là bắt chủ shop chọn một giá
   * trị cho hai quyết định trái chiều: để 10 thì tỷ lệ thô của một mã 12 đơn được tin; để 50 thì
   * một mã 20 đơn đã kết thúc vẫn bị coi là "chưa biết gì".
   *
   * Sửa được ở **Báo cáo → Giả định**, không cần deploy.
   */
  rateMatureMinFinished: number;
  /**
   * Ghi đè tỷ lệ hoàn theo `productId`.
   *
   * Hai dạng cùng tồn tại và `parseDeliveryRateOverride` đọc cả hai: **số trần** là mọi dòng đã lưu
   * trước 23/09/2026 (nghĩa: giữ vĩnh viễn), **bản khai** là dòng mới — có lý do, có người đặt, và
   * mặc định TỰ NHƯỜNG CHỖ cho số đo khi mã đủ chín. Dòng cũ không bị đổi nghĩa và không backfill.
   */
  overrides: Record<string, StoredDeliveryRateOverride>;
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

/** Một mốc của lịch cước ước tính. `shipFeeReturned = null` ⇒ tính như ô chung (cước gửi + phí hoàn về). */
export type ShipFeePeriod = { from: string; shipFeeDelivered: number; shipFeeReturned: number | null; note: string };

const NGAY = /^\d{4}-\d{2}-\d{2}$/;

/** Lịch cước đã lọc hợp lệ, xếp tăng theo ngày; mốc hỏng / trùng ngày bị bỏ (mốc đến sau thắng). HÀM THUẦN. */
export function shipFeeScheduleOf(saved: Pick<ProfitAssumptions, "shipFeeSchedule">): ShipFeePeriod[] {
  const raw = Array.isArray(saved.shipFeeSchedule) ? saved.shipFeeSchedule : [];
  const theoNgay = new Map<string, ShipFeePeriod>();
  for (const x of raw) {
    if (!x || typeof x.from !== "string" || !NGAY.test(x.from)) continue;
    const d = Number(x.shipFeeDelivered);
    if (!Number.isFinite(d) || d < 0) continue;
    const r = x.shipFeeReturned === null || x.shipFeeReturned === undefined ? null : Number(x.shipFeeReturned);
    theoNgay.set(x.from, { from: x.from, shipFeeDelivered: Math.round(d), shipFeeReturned: r !== null && Number.isFinite(r) && r >= 0 ? Math.round(r) : null, note: String(x.note ?? "") });
  }
  return [...theoNgay.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

export type ShipFeePair = { delivered: number; returned: number };

/**
 * Cước ước tính áp cho ngày `dateKey` (YYYY-MM-DD, giờ VN): mốc có `from ≤ dateKey` gần nhất; trước mọi
 * mốc ⇒ `base` (hai ô chung đã giải). Cước đơn hoàn để trống ⇒ cước gửi của mốc + phí hoàn về bình quân
 * (`returnFeeFromData`), không có dữ liệu thì gấp đôi — cùng luật với ô chung. HÀM THUẦN.
 */
export function shipFeesAt(base: ShipFeePair, schedule: readonly ShipFeePeriod[], dateKey: string, returnFeeFromData = 0): ShipFeePair & { from: string | null } {
  let pick: ShipFeePeriod | null = null;
  for (const x of schedule) if (x.from <= dateKey) pick = x;
  if (!pick) return { ...base, from: null };
  const returned = pick.shipFeeReturned ?? pick.shipFeeDelivered + (returnFeeFromData > 0 ? returnFeeFromData : pick.shipFeeDelivered);
  return { delivered: pick.shipFeeDelivered, returned, from: pick.from };
}

/**
 * Cước ước tính cho cả một kỳ `[fromKey, toKey]`: bình quân theo SỐ NGÀY chồng lấn với từng mốc (không theo
 * số đơn — số đơn của kỳ chưa đóng còn đổi). Kỳ mở hai đầu (toàn bộ) ⇒ mốc đang hiệu lực hôm `toKey` hoặc
 * `base`. HÀM THUẦN.
 */
export function shipFeesForPeriod(base: ShipFeePair, schedule: readonly ShipFeePeriod[], fromKey: string | null, toKey: string | null, returnFeeFromData = 0): ShipFeePair {
  if (!schedule.length) return base;
  if (!fromKey || !toKey || fromKey > toKey) {
    const p = shipFeesAt(base, schedule, toKey ?? "9999-12-31", returnFeeFromData);
    return { delivered: p.delivered, returned: p.returned };
  }
  const ngay = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10))) / 86_400_000;
  const a = ngay(fromKey);
  const b = ngay(toKey);
  const moc = [fromKey, ...schedule.map((x) => x.from).filter((k) => k > fromKey && k <= toKey)];
  let d = 0;
  let r = 0;
  for (let i = 0; i < moc.length; i++) {
    const dau = ngay(moc[i]);
    const cuoi = i + 1 < moc.length ? ngay(moc[i + 1]) - 1 : b;
    const soNgay = Math.max(0, cuoi - Math.max(dau, a) + 1);
    const p = shipFeesAt(base, schedule, moc[i], returnFeeFromData);
    d += p.delivered * soNgay;
    r += p.returned * soNgay;
  }
  const tong = b - a + 1;
  return { delivered: Math.round(d / tong), returned: Math.round(r / tong) };
}

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
  rateMatureMinFinished: 10,
  overrides: {},
  inventoryRiskPercent: 10,
  taxPercent: 1.5,
  otherCostPercentOfAds: 1.1,
  failedToReturnPercent: 0,
};

export const FALLBACK_SHIP_FEE_DELIVERED = 17_000;
export const FALLBACK_SHIP_FEE_RETURNED = 34_000;

/** Ô cước chủ shop đặt tay (số ≥ 0, kể cả 0), hoặc `null` = để trống ⇒ tự tính. Xem `shipFeeExplicitZero`. */
export function manualShipFee(
  saved: Pick<ProfitAssumptions, "shipFeeDelivered" | "shipFeeReturned" | "shipFeeExplicitZero">,
  key: "shipFeeDelivered" | "shipFeeReturned",
): number | null {
  const v = saved[key];
  if (v === null || v === undefined || (typeof v === "string" && v === "")) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.max(0, Math.round(n));
  if (rounded === 0 && saved.shipFeeExplicitZero !== true) return null;
  return rounded;
}

export type ShipFeeSource = "setting" | "data" | "fallback";

/**
 * Cước dùng cho phép tính: ô đặt tay thắng; ô trống lấy từ dữ liệu 90 ngày, không có dữ liệu thì
 * 17.000 ₫ / gấp đôi. Hàm THUẦN — phần đọc dữ liệu nằm ở `resolveAssumptions()`.
 */
export function resolveShipFees(
  manual: { delivered: number | null; returned: number | null },
  data: { delivered: number; returnFee: number },
): { delivered: number; returned: number; source: ShipFeeSource } {
  let source: ShipFeeSource = "setting";
  let delivered = manual.delivered;
  if (delivered === null) {
    delivered = data.delivered > 0 ? data.delivered : FALLBACK_SHIP_FEE_DELIVERED;
    source = data.delivered > 0 ? "data" : "fallback";
  }
  let returned = manual.returned;
  if (returned === null) {
    returned = delivered + (data.returnFee > 0 ? data.returnFee : delivered);
    if (source === "setting") source = data.returnFee > 0 ? "data" : "fallback";
  }
  return { delivered, returned, source };
}

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
