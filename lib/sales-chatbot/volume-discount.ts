/**
 * ═══════════ BÁN THEO GÓI ĐƠN VỊ + GIẢM THEO KHỐI LƯỢNG (chủ shop HSLC 10/10/2026) ═══════════
 *
 * Trước đây danh mục có SẴN gói lớn (chả cá thu 2kg = 540.000 ₫) và bot tự chọn gói — hai lần trong một giờ bot lên «2kg × 2» khi
 * khách nói «lấy 2kg» (1.080.000 ₫ thay vì 540.000 ₫), và một lần lên «1kg × 2» = 560.000 ₫ trong khi đã báo khách 540.000 ₫. Chủ
 * shop chốt: KHÔNG dùng gói lớn nữa — khách lấy N kg ⇒ N × gói 1kg, rồi áp «giảm 20K khi mua từ 2kg». Luật này để MÁY CHỦ làm, không
 * để AI nhớ: AI chọn gói nào thì `priceLines` cũng quy về gói đơn vị và tự trừ tiền ⇒ cùng một khối lượng luôn ra cùng một số tiền.
 *
 * Phạm vi: TỪNG SẢN PHẨM (2kg chả cá + 1kg chả mực ⇒ chỉ chả cá đạt ngưỡng). Hai cách giảm, chủ shop chọn ở Cấu hình:
 *  · `ONCE` — đạt ngưỡng thì giảm ĐÚNG MỘT LẦN (4kg = 4 × 280.000 − 20.000 = 1.100.000 ₫);
 *  · `PER_STEP` — mỗi lần đủ ngưỡng giảm thêm một lần (4kg = 4 × 280.000 − 2 × 20.000 = 1.080.000 ₫ — khớp bảng gói 2kg cũ).
 * Mặc định TẮT — chính sách giá là quyết định của chủ shop. HÀM THUẦN, client import được.
 */

export type VolumeDiscountRule = {
  enabled: boolean;
  /** Khối lượng một gói ĐƠN VỊ (gram) — gói lớn hơn mà là bội số của nó được quy về N × gói này (cùng sản phẩm). */
  unitGrams: number;
  /** Ngưỡng khối lượng của MỘT sản phẩm trong đơn (gram) để được giảm. */
  minWeightGrams: number;
  /** Số tiền giảm (đồng). */
  amount: number;
  mode: "ONCE" | "PER_STEP";
};

export const DEFAULT_VOLUME_DISCOUNT: VolumeDiscountRule = { enabled: false, unitGrams: 1000, minWeightGrams: 2000, amount: 0, mode: "ONCE" };

const kgText = (g: number) => (g % 1000 === 0 ? `${g / 1000}kg` : `${(g / 1000).toLocaleString("vi-VN")}kg`);

/** Tiền giảm của MỘT sản phẩm có tổng khối lượng `grams` trong đơn. Không biết khối lượng ⇒ 0 (không đoán). HÀM THUẦN. */
export function volumeDiscountFor(grams: number | null, rule: VolumeDiscountRule): number {
  if (!rule.enabled || grams === null || rule.amount <= 0 || grams < rule.minWeightGrams) return 0;
  return rule.mode === "ONCE" ? rule.amount : Math.floor(grams / rule.minWeightGrams) * rule.amount;
}

export type UnitCatalogItem = { variantId: string; productId: string; price: number | null; weightGrams: number | null; addOnOnly?: boolean };

/**
 * Quy gói lớn về gói đơn vị: mẫu mã nặng W = k × `unitGrams` (k ≥ 2) của một sản phẩm CÓ mẫu mã đơn vị bán được (đúng `unitGrams`,
 * có giá, không phải chỉ-bán-kèm) ⇒ thay bằng gói đơn vị × (k × số lượng); dòng trùng mẫu mã gộp lại. Mẫu mã khác (0,5kg bán kèm,
 * sản phẩm không có gói đơn vị, không rõ khối lượng) giữ nguyên. HÀM THUẦN.
 */
export function toUnitPacks(lines: readonly { variantId: string; quantity: number }[], catalog: readonly UnitCatalogItem[], rule: VolumeDiscountRule): { variantId: string; quantity: number }[] {
  if (!rule.enabled) return lines.map((l) => ({ ...l }));
  const byId = new Map(catalog.map((c) => [c.variantId, c]));
  const unitOf = new Map<string, string>();
  for (const c of catalog) if (c.weightGrams === rule.unitGrams && c.price !== null && !c.addOnOnly && !unitOf.has(c.productId)) unitOf.set(c.productId, c.variantId);
  const out = new Map<string, number>();
  for (const l of lines) {
    const it = byId.get(l.variantId);
    const unit = it ? unitOf.get(it.productId) : undefined;
    const w = it?.weightGrams ?? null;
    const k = w !== null && w > rule.unitGrams && w % rule.unitGrams === 0 ? w / rule.unitGrams : null;
    const [id, q] = unit && k !== null ? [unit, l.quantity * k] : [l.variantId, l.quantity];
    out.set(id, (out.get(id) ?? 0) + q);
  }
  return [...out.entries()].map(([variantId, quantity]) => ({ variantId, quantity }));
}

/** Câu chính sách để AI nói lại («Mua từ 2kg (cùng món) giảm 20.000 ₫ …»). Tắt / chưa khai số tiền ⇒ "". HÀM THUẦN. */
export function volumeDiscountPolicyText(rule: VolumeDiscountRule, formatVnd: (n: number) => string): string {
  if (!rule.enabled || rule.amount <= 0) return "";
  return rule.mode === "ONCE"
    ? `Mua từ ${kgText(rule.minWeightGrams)} cùng một món giảm ${formatVnd(rule.amount)} cho món đó (giảm một lần)`
    : `Cứ mỗi ${kgText(rule.minWeightGrams)} cùng một món giảm ${formatVnd(rule.amount)}`;
}
