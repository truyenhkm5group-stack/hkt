import type { PlanStatus } from "@/lib/constants/planning";

/**
 * ═══════════ ĐỨT SIZE — CÒN HÀNG MÀ KHÔNG BÁN ĐƯỢC ═══════════
 *
 * Bộ máy quyết định tồn kho (`decideInventory`) phán TỪNG mẫu mã: size M hết ⇒ "nguy cơ hết hàng",
 * size XL còn 30 cái ⇒ "giữ nguyên". Cả hai câu đều đúng mà vẫn bỏ sót điều đắt nhất: NHÌN Ở CẤP MÀU,
 * mẫu này vẫn "còn 40 cái", quảng cáo vẫn chạy, nhưng phần lớn khách muốn đúng những size đã hết.
 * Tiền quảng cáo đổ vào một mẫu không bán đủ size, và 40 cái còn lại toàn size lệch — mai kia thành
 * hàng chết. Không bảng nào đang nói ra câu đó.
 *
 * KHÔNG CÓ CÔNG THỨC ĐO MỚI. Tồn khả dụng, trạng thái, số bán 30 ngày lấy NGUYÊN từ dòng Kế hoạch SX
 * (`getReplenishmentPlan`); số nên đặt và hàng đã đặt xưởng lấy nguyên từ `decideInventory`. Tệp này
 * chỉ GOM theo (mã hàng, màu) và hỏi: phần lượng bán rơi vào size đã hết là bao nhiêu?
 *
 * ─── VÌ SAO ĐO TỶ TRỌNG BẰNG BÁN 30 NGÀY ───
 *
 * `sold30` là nhu cầu RÒNG (không huỷ, không hoàn, không tặng) — gồm cả đơn đã chốt đang CHỜ HÀNG, nên
 * size hết mà khách vẫn đặt thì nhu cầu ấy vẫn được đếm. Nhưng size hết LÂU thì lượng bán của nó tụt
 * xuống vì không có hàng để chốt: tỷ trọng ở đây là CẬN DƯỚI của nhu cầu thật. Sai theo hướng đó là sai
 * an toàn — bộ máy báo ít hơn thực tế, không bao giờ báo đứt size cho một mẫu chưa đứt.
 *
 * ─── BA RANH GIỚI ───
 *
 *  1. CHƯA BIẾT KHÔNG PHẢI HẾT HÀNG. Một size có người mua mà chưa có phiếu nhập (`stockKnown = false`)
 *     thì không ai biết nó còn hay hết ⇒ cả nhóm màu KHÔNG kết luận, được ĐẾM RIÊNG (`unknown`).
 *  2. ÍT ĐƠN THÌ TỶ TRỌNG LÀ NHIỄU. Nhóm màu bán dưới `minGroupSold30` cái/30 ngày không được phán
 *     (`insufficient`) — 3 đơn size M trên 5 đơn cả màu không phải "60% khách muốn size M".
 *  3. CHỈ ĐỀ XUẤT. Không tự đặt sản xuất, không tự tắt quảng cáo. Thiếu số hàng đặt xưởng (trang chi
 *     tiết sản phẩm không đọc lệnh SX) thì KHÔNG in câu hành động — chỉ in sự việc và trỏ về trang
 *     Quyết định vốn tồn kho, để hai trang không nói hai việc khác nhau cho cùng một mẫu.
 */

/**
 * Ngưỡng PHÂN TÍCH (không phải ngưỡng nghiệp vụ về tiền hay kết quả đơn): nó không đổi con số nào,
 * chỉ quyết định nhóm màu nào được gọi tên ra. MỘT CHỖ DUY NHẤT.
 */
export const SIZE_BREAK_RULE = {
  /** Nhóm màu bán dưới ngần này cái trong 30 ngày thì tỷ trọng size là nhiễu — không phán. */
  minGroupSold30: 10,
  /** Phần lượng bán (%) rơi vào size đã hết / sắp hết từ mức này trở lên ⇒ gọi tên nhóm màu. */
  brokenSharePct: 40,
} as const;

export type SizeBreakLevel = "BROKEN" | "AT_RISK";

export const SIZE_BREAK_LABEL: Record<SizeBreakLevel, string> = {
  BROKEN: "Đã đứt size",
  AT_RISK: "Sắp đứt size",
};

export const SIZE_BREAK_TONE: Record<SizeBreakLevel, string> = {
  BROKEN: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
  AT_RISK: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
};

export type SizeBreakVariant = {
  variantId: string;
  productId: string;
  productName: string;
  productCode: string;
  color: string;
  size: string;
  /** false = chưa có phiếu nhập ⇒ tồn CHƯA BIẾT. */
  stockKnown: boolean;
  /** Tồn khả dụng của Kế hoạch SX (tồn thực tế − đã chốt chưa xuất). */
  available: number;
  /** Trạng thái của Kế hoạch SX — `CRITICAL` = hết trước khi lô mới về. */
  status: PlanStatus;
  /** Bán 30 ngày RÒNG của Kế hoạch SX. */
  sold30: number;
  /** Giá nhập; `null` = CHƯA BIẾT (không phải 0đ). */
  unitCost: number | null;
  /** Số nên đặt SAU khi trừ hàng đã đặt xưởng (`decideInventory`); `null` = không có số. */
  suggestedQty: number | null;
  /** Đã đặt xưởng chưa nhận; `null` = nguồn gọi KHÔNG đọc lệnh sản xuất ⇒ không in câu hành động. */
  openPoQty: number | null;
};

export type SizeBreakSizeLine = {
  variantId: string;
  size: string;
  sold30: number;
  /** Tỷ trọng (%) trong lượng bán 30 ngày của nhóm màu, làm tròn 1 chữ số. */
  sharePct: number;
  available: number;
  suggestedQty: number | null;
  openPoQty: number | null;
};

export type SizeBreakGroup = {
  key: string;
  productId: string;
  productName: string;
  productCode: string;
  color: string;
  level: SizeBreakLevel;
  totalSold30: number;
  /** Tỷ trọng (%) lượng bán rơi vào các size trong `brokenSizes`. */
  brokenSharePct: number;
  /** Size đã hết (BROKEN) hoặc đã hết + sắp hết trước khi lô mới về (AT_RISK). */
  brokenSizes: SizeBreakSizeLine[];
  /** Size còn hàng — đây là toàn bộ số "còn" mà nhóm màu đang khoe. */
  remainingSizes: SizeBreakSizeLine[];
  remainingUnits: number;
  /** Vốn (giá nhập) của phần còn lại; `null` = có size còn hàng mà chưa biết giá nhập. */
  remainingCapital: number | null;
  /** Lượng bán 30 ngày của các size đã hết/sắp hết — phần nhu cầu đang (sắp) không phục vụ được. */
  lostSold30: number;
  /** Sự việc, câu đọc được. */
  reason: string;
  /** Việc nên làm; `null` khi nguồn gọi không có số hàng đã đặt xưởng. */
  action: string | null;
};

export type SizeBreakReport = {
  groups: SizeBreakGroup[];
  /** Nhóm (mã hàng, màu) có từ 2 size trở lên và đủ lượng bán để phán. */
  evaluated: number;
  /** Nhóm có từ 2 size nhưng bán dưới `minGroupSold30` — chưa phán. */
  insufficient: number;
  /** Nhóm có size đang được mua mà CHƯA BIẾT tồn — không phán, đếm riêng. */
  unknown: number;
  rule: { minGroupSold30: number; brokenSharePct: number };
};

const norm = (v: string) => v.trim().toLowerCase();
const round1 = (v: number) => Math.round(v * 10) / 10;
const sizesText = (lines: SizeBreakSizeLine[]) => lines.map((l) => l.size || "(không size)").join(", ");

/** Hết hàng HÔM NAY theo sổ kho — cùng mốc `available <= 0` mà Kế hoạch SX dùng cho trạng thái OUT. */
function isOut(v: SizeBreakVariant) {
  return v.available <= 0;
}

function lineOf(v: SizeBreakVariant, total: number): SizeBreakSizeLine {
  return {
    variantId: v.variantId,
    size: v.size,
    sold30: v.sold30,
    sharePct: total > 0 ? round1((v.sold30 / total) * 100) : 0,
    available: v.available,
    suggestedQty: v.suggestedQty,
    openPoQty: v.openPoQty,
  };
}

/**
 * Câu hành động. Ba nhánh vì ba việc khác nhau: đã đặt xưởng đủ ⇒ CHỜ và đừng đẩy quảng cáo; còn
 * thiếu ⇒ đặt bù đúng size; Kế hoạch SX chưa có số ⇒ đi xem lại giả định, không bịa số.
 */
function actionOf(level: SizeBreakLevel, broken: SizeBreakSizeLine[]): string | null {
  if (broken.some((l) => l.openPoQty === null)) return null;
  const toOrder = broken.filter((l) => (l.suggestedQty ?? 0) > 0);
  const onOrder = broken.filter((l) => (l.openPoQty ?? 0) > 0);
  const adsNote = "Tới khi hàng về, đừng tăng ngân sách quảng cáo mẫu này — khách hỏi đúng size đó sẽ không có hàng.";
  if (toOrder.length) {
    const list = toOrder.map((l) => `${l.size || "(không size)"} ${l.suggestedQty}`).join(", ");
    const poNote = onOrder.length ? ` (đã trừ hàng đang đặt xưởng)` : "";
    return `${level === "AT_RISK" ? "Đặt bù ngay" : "Đặt bù"} theo Kế hoạch SX: ${list} cái${poNote}. ${adsNote}`;
  }
  if (onOrder.length) {
    const list = onOrder.map((l) => `${l.size || "(không size)"} ${l.openPoQty}`).join(", ");
    return `Đã đặt xưởng ${list} cái, đủ theo Kế hoạch SX — chờ hàng về. ${adsNote}`;
  }
  return `Kế hoạch SX chưa có số đặt cho size ${sizesText(broken)} (tốc độ gửi đi trong cửa sổ tính có thể bằng 0 vì đã hết hàng lâu) — xem lại ở trang Kế hoạch đặt hàng SX. ${adsNote}`;
}

/**
 * Tìm các nhóm (mã hàng, màu) đứt size. Hàm THUẦN: cùng đầu vào luôn cùng đầu ra, không đọc CSDL,
 * không đọc đồng hồ.
 *
 *  · BROKEN  — size ĐÃ HẾT (khả dụng ≤ 0) chiếm ≥ `brokenSharePct`% lượng bán, mà nhóm vẫn còn hàng.
 *  · AT_RISK — chưa tới mức trên, nhưng cộng thêm size sẽ hết trước khi lô mới về (`CRITICAL`) thì tới.
 *
 * Nhóm hết sạch mọi size KHÔNG phải đứt size — đó là hết hàng, `decideInventory` đã nói.
 */
export function findSizeBreaks(variants: SizeBreakVariant[]): SizeBreakReport {
  const byGroup = new Map<string, SizeBreakVariant[]>();
  for (const v of variants) {
    const key = `${v.productId}::${norm(v.color)}`;
    const list = byGroup.get(key);
    if (list) list.push(v);
    else byGroup.set(key, [v]);
  }

  const R = SIZE_BREAK_RULE;
  const groups: SizeBreakGroup[] = [];
  let evaluated = 0;
  let insufficient = 0;
  let unknown = 0;

  for (const [key, list] of byGroup) {
    // Một size thì không có "dải size" để đứt.
    if (new Set(list.map((v) => norm(v.size))).size < 2) continue;
    const total = list.reduce((t, v) => t + Math.max(0, v.sold30), 0);
    if (list.some((v) => !v.stockKnown && v.sold30 > 0)) {
      unknown += 1;
      continue;
    }
    if (total < R.minGroupSold30) {
      insufficient += 1;
      continue;
    }
    evaluated += 1;

    const known = list.filter((v) => v.stockKnown);
    const out = known.filter((v) => isOut(v) && v.sold30 > 0);
    const critical = known.filter((v) => !isOut(v) && v.status === "CRITICAL" && v.sold30 > 0);
    const shareOf = (vs: SizeBreakVariant[]) => (total > 0 ? (vs.reduce((t, v) => t + v.sold30, 0) / total) * 100 : 0);

    let level: SizeBreakLevel | null = null;
    let broken: SizeBreakVariant[] = [];
    if (shareOf(out) >= R.brokenSharePct) {
      level = "BROKEN";
      broken = out;
    } else if (shareOf([...out, ...critical]) >= R.brokenSharePct) {
      level = "AT_RISK";
      broken = [...out, ...critical];
    }
    if (!level) continue;

    const brokenIds = new Set(broken.map((v) => v.variantId));
    const remaining = known.filter((v) => !brokenIds.has(v.variantId) && v.available > 0);
    const remainingUnits = remaining.reduce((t, v) => t + v.available, 0);
    // Hết sạch ở mọi size còn lại ⇒ đó là hết hàng, không phải đứt size.
    if (remainingUnits <= 0) continue;

    const brokenLines = broken.map((v) => lineOf(v, total)).sort((a, b) => b.sold30 - a.sold30 || a.size.localeCompare(b.size));
    const remainingLines = remaining.map((v) => lineOf(v, total)).sort((a, b) => b.available - a.available || a.size.localeCompare(b.size));
    const remainingCapital = remaining.some((v) => v.unitCost === null) ? null : Math.round(remaining.reduce((t, v) => t + v.available * (v.unitCost as number), 0));
    const brokenSharePct = round1(shareOf(broken));
    const lostSold30 = broken.reduce((t, v) => t + v.sold30, 0);
    const remainingShare = round1(shareOf(remaining));
    const first = list[0];
    const colorText = first.color.trim() ? ` màu ${first.color.trim()}` : "";
    const verb = level === "BROKEN" ? "đã hết" : "đã hết hoặc sẽ hết trước khi lô mới về";

    groups.push({
      key,
      productId: first.productId,
      productName: first.productName,
      productCode: first.productCode,
      color: first.color,
      level,
      totalSold30: total,
      brokenSharePct,
      brokenSizes: brokenLines,
      remainingSizes: remainingLines,
      remainingUnits,
      remainingCapital,
      lostSold30,
      reason: `${brokenSharePct}% lượng bán 30 ngày${colorText} rơi vào size ${sizesText(brokenLines)} — ${verb}. Còn ${remainingUnits} cái nằm ở size ${sizesText(remainingLines)}, nhóm size chỉ chiếm ${remainingShare}% lượng bán.`,
      action: actionOf(level, brokenLines),
    });
  }

  // Đã đứt trước sắp đứt; trong cùng mức, nhóm mất nhiều lượng bán nhất đứng trước.
  groups.sort((a, b) => (a.level === b.level ? b.lostSold30 - a.lostSold30 || a.key.localeCompare(b.key) : a.level === "BROKEN" ? -1 : 1));
  return { groups, evaluated, insufficient, unknown, rule: { minGroupSold30: R.minGroupSold30, brokenSharePct: R.brokenSharePct } };
}
