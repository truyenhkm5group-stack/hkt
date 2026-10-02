/**
 * ═══════════ BẢNG GIÁ · HẠN MỨC NỢ · TUỔI NỢ — HÀM THUẦN, client-safe (docs/verticals/price-lists-receivables.md) ═══════════
 *
 * Một luật chọn giá cho MỌI nơi đặt giá (form đơn tay, máy chủ, chatbot): bảng của khách → bảng mặc định → giá lẻ. Trong
 * một bảng, bậc có `min_quantity` lớn nhất mà vẫn ≤ số lượng thắng. Không bậc nào khớp ở cả hai bảng ⇒ giá lẻ. Giá lẻ
 * trống (0 / null) ⇒ `null` — CHƯA CÓ GIÁ, không phải 0đ (luật 42).
 *
 * Công nợ đi theo chứng từ thanh toán của đơn tay (ORDER_OUTCOME.md mục 11.1): số còn phải thu của MỘT đơn là
 * `manualPaymentStatus(...).outstanding`; ở đây chỉ có phép cộng / chia / chấm trên những con số đó.
 */

export type PriceTier = { variantId: string; minQuantity: number; unitPrice: number };
export type PriceListBook = { id: string; name: string; isDefault: boolean; tiers: readonly PriceTier[] };

export type PriceSource = "CUSTOMER_LIST" | "DEFAULT_LIST" | "RETAIL";
export const PRICE_SOURCE_LABEL: Record<PriceSource, string> = { CUSTOMER_LIST: "bảng giá của khách", DEFAULT_LIST: "bảng giá mặc định", RETAIL: "giá lẻ" };

export type PriceQuote = { unitPrice: number; source: PriceSource; listName: string | null; minQuantity: number | null } | null;

export const PRICE_LIST_LIMITS = { nameMax: 80, noteMax: 500, maxTiers: 5000, maxQuantity: 100_000, maxPrice: 10_000_000_000 } as const;

/** Bậc thắng của một mẫu mã trong một bảng: `min_quantity` lớn nhất mà ≤ số lượng. */
export function tierFor(tiers: readonly PriceTier[], variantId: string, quantity: number): PriceTier | null {
  let best: PriceTier | null = null;
  for (const t of tiers) {
    if (t.variantId !== variantId || t.minQuantity > quantity) continue;
    if (!best || t.minQuantity > best.minQuantity) best = t;
  }
  return best;
}

/** Đơn giá gợi ý cho một dòng. `customerList` = bảng gán cho khách (nếu có); `defaultList` = bảng mặc định đang bật. */
export function quoteUnitPrice(input: { variantId: string; quantity: number; retailPrice: number | null; customerList: PriceListBook | null; defaultList: PriceListBook | null }): PriceQuote {
  const qty = Number.isFinite(input.quantity) && input.quantity >= 1 ? Math.trunc(input.quantity) : 1;
  const tryList = (list: PriceListBook | null, source: PriceSource): PriceQuote => {
    if (!list) return null;
    const t = tierFor(list.tiers, input.variantId, qty);
    return t ? { unitPrice: t.unitPrice, source, listName: list.name, minQuantity: t.minQuantity } : null;
  };
  const customer = tryList(input.customerList, "CUSTOMER_LIST");
  if (customer) return customer;
  // Khách đã gán bảng RIÊNG mà bảng đó trùng bảng mặc định ⇒ không thử lại.
  const fallback = input.customerList && input.defaultList && input.customerList.id === input.defaultList.id ? null : tryList(input.defaultList, "DEFAULT_LIST");
  if (fallback) return fallback;
  const retail = input.retailPrice;
  return retail !== null && Number.isSafeInteger(retail) && retail > 0 ? { unitPrice: retail, source: "RETAIL", listName: null, minQuantity: null } : null;
}

/**
 * Kiểm một bảng giá trước khi lưu: mỗi (mẫu mã, bậc) một dòng, bậc ≥ 1, giá nguyên dương. KHÔNG bắt giá bậc cao phải
 * thấp hơn — một bảng có thể cố ý tăng giá theo số lượng (hàng hiếm), và đó là quyết định của chủ shop.
 */
export function validateTiers(tiers: readonly PriceTier[]): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  if (tiers.length > PRICE_LIST_LIMITS.maxTiers) errors.push({ field: "tiers", message: `Một bảng tối đa ${PRICE_LIST_LIMITS.maxTiers} dòng.` });
  const seen = new Set<string>();
  tiers.forEach((t, i) => {
    const p = `tiers.${i}`;
    if (!t.variantId) errors.push({ field: `${p}.variantId`, message: "Chọn mẫu mã." });
    if (!Number.isSafeInteger(t.minQuantity) || t.minQuantity < 1 || t.minQuantity > PRICE_LIST_LIMITS.maxQuantity) errors.push({ field: `${p}.minQuantity`, message: "Mua từ — số nguyên từ 1." });
    if (!Number.isSafeInteger(t.unitPrice) || t.unitPrice <= 0 || t.unitPrice > PRICE_LIST_LIMITS.maxPrice) errors.push({ field: `${p}.unitPrice`, message: "Đơn giá là số tiền nguyên dương (đồng)." });
    const key = `${t.variantId}|${t.minQuantity}`;
    if (t.variantId && seen.has(key)) errors.push({ field: `${p}.minQuantity`, message: "Trùng bậc «mua từ» của cùng mẫu mã." });
    seen.add(key);
  });
  return errors;
}

// ─────────────────────────── Hạn mức nợ ───────────────────────────

export type CreditCheck = { ok: true; limit: number | null; exposureAfter: number } | { ok: false; limit: number; exposureAfter: number; overBy: number };

/**
 * Chấm hạn mức khi một đơn được CHỐT: dư nợ sau đơn = còn phải thu của mọi đơn tay khác đang chốt / đã giao + số phải
 * trả của đơn này. Hạn mức NULL ⇒ chưa khai ⇒ không chặn. Hạn mức 0 là khai THẬT — "không cho nợ đồng nào".
 */
export function checkCredit(limit: number | null, otherExposure: number, thisOrderDue: number): CreditCheck {
  const exposureAfter = Math.max(0, Math.trunc(otherExposure)) + Math.max(0, Math.trunc(thisOrderDue));
  if (limit === null) return { ok: true, limit: null, exposureAfter };
  if (exposureAfter <= limit) return { ok: true, limit, exposureAfter };
  return { ok: false, limit, exposureAfter, overBy: exposureAfter - limit };
}

// ─────────────────────────── Tuổi nợ ───────────────────────────

export type AgingBucket = "CURRENT" | "D1_30" | "D31_60" | "D61_90" | "D90_PLUS";
export const AGING_BUCKETS: readonly AgingBucket[] = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"];
export const AGING_LABEL: Record<AgingBucket, string> = { CURRENT: "Trong hạn", D1_30: "Quá 1–30 ngày", D31_60: "Quá 31–60", D61_90: "Quá 61–90", D90_PLUS: "Quá > 90" };

/**
 * Một khoản còn phải thu thuộc nhóm tuổi nào. Hạn trả = ngày lên đơn + số ngày được nợ. Số ngày được nợ CHƯA KHAI ⇒
 * không tính quá hạn được ⇒ `CURRENT` kèm cờ `termsUnknown` ở tầng gọi — không đoán một con số mặc định.
 */
export function agingBucket(daysOverdue: number): AgingBucket {
  if (daysOverdue <= 0) return "CURRENT";
  if (daysOverdue <= 30) return "D1_30";
  if (daysOverdue <= 60) return "D31_60";
  if (daysOverdue <= 90) return "D61_90";
  return "D90_PLUS";
}

// ─────────────────────────── Thu nợ gộp ───────────────────────────

/** `orderedAt` là KHOÁ THỨ TỰ (chuỗi so sánh được) — nhỏ hơn được trả trước; xem `toOpenDebts`. */
export type OpenDebt = { orderId: string; outstanding: number; orderedAt: string };
export type Allocation = { orderId: string; amount: number };

/**
 * Chia MỘT khoản thu của khách vào các đơn còn nợ theo khoá thứ tự (nhỏ trước, rồi mã đơn cho ổn định). Không
 * chia vượt số còn nợ của từng đơn; số tiền lớn hơn tổng nợ ⇒ lỗi (phần dư không có đơn nào để ghi — ghi thu thừa ở một đơn
 * cụ thể là việc của người, không phải của phép chia).
 */
export function allocatePayment(amount: number, debts: readonly OpenDebt[]): { ok: true; allocations: Allocation[] } | { ok: false; error: string; totalOutstanding: number } {
  const total = debts.reduce((s, d) => s + Math.max(0, d.outstanding), 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) return { ok: false, error: "Số tiền là số nguyên dương (đồng).", totalOutstanding: total };
  if (amount > total) return { ok: false, error: `Số tiền lớn hơn tổng nợ (${total.toLocaleString("vi-VN")} ₫) — phần dư ghi ở một đơn cụ thể nếu là thu thừa.`, totalOutstanding: total };
  const sorted = [...debts].filter((d) => d.outstanding > 0).sort((a, b) => (a.orderedAt === b.orderedAt ? a.orderId.localeCompare(b.orderId) : a.orderedAt < b.orderedAt ? -1 : 1));
  let left = amount;
  const allocations: Allocation[] = [];
  for (const d of sorted) {
    if (left <= 0) break;
    const take = Math.min(left, d.outstanding);
    allocations.push({ orderId: d.orderId, amount: take });
    left -= take;
  }
  return { ok: true, allocations };
}
