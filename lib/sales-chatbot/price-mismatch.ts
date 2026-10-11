/**
 * ═══════════ ĐƠN CỦA BOT CÓ LỆCH BÁO GIÁ MÁY CHỦ KHÔNG — PHÂN LOẠI THUẦN (ops `price-mismatch-scan`) ═══════════
 *
 * Vì sao (P0 11/10/2026, ca «Phạm Minh Ái»): tổ chức bật «báo giá sỉ» thì đường giá cũ bỏ qua giảm theo khối lượng cho MỌI khách
 * (khối giảm nằm trong `if (!books)`) ⇒ 2kg chả cá thu 560.000 thay vì 540.000. Đơn đã ghi theo giá sai cần một danh sách để sửa.
 *
 * Hàm này tính lại tiền hàng của MỘT đơn bằng CHÍNH `computePriced` (quote.ts) — không công thức thứ hai — trên một hay nhiều ngữ
 * cảnh giá (giá cho khách chưa xác minh, và bảng riêng của khách nếu có): khớp MỘT ngữ cảnh là khớp. Giá danh mục HÔM NAY có thể khác
 * lúc lên đơn ⇒ mọi kết luận là ESTIMATED; `missingVolumeDiscount` chỉ bật khi đơn giá từng dòng KHỚP giá hôm nay mà tiền giảm thiếu —
 * đó là đúng lỗi kể trên, không lẫn với chuyện đổi giá.
 */
import { computePriced, type PricingContext } from "@/lib/sales-chatbot/quote";

export type MismatchOrderLine = { variantId: string | null; quantity: number; unitPrice: number | null; discount: number | null };

export type MismatchVerdict = {
  kind: "OK" | "PRICE_MISMATCH" | "UNPRICEABLE";
  /** Tiền hàng đơn đang ghi (Σ đơn giá × SL − giảm dòng). */
  actual: number;
  /** Tiền hàng máy chủ tính lại (ngữ cảnh đầu tiên); `null` = không tính lại được. */
  expected: number | null;
  /** Đơn giá khớp giá hôm nay nhưng tiền giảm theo khối lượng thiếu (lỗi «sỉ bật thì mất giảm»). */
  missingVolumeDiscount: boolean;
  /** Có dòng gói đơn vị × N ≥ 2 (dáng «2 × 1kg»). */
  multiUnit: boolean;
  /** Vì sao không tính lại được (mẫu mã đã xoá / ẩn / thiếu giá). */
  reason: string | null;
};

export function classifyOrderPrice(lines: readonly MismatchOrderLine[], contexts: readonly PricingContext[]): MismatchVerdict {
  const actual = lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity - (l.discount ?? 0), 0);
  const first = contexts[0];
  const unitGrams = first?.cfg.volumeDiscount.unitGrams ?? 1000;
  const multiUnit = Boolean(first) && lines.some((l) => l.variantId !== null && l.quantity >= 2 && first.weight.get(l.variantId) === unitGrams);
  const base = { actual, multiUnit };
  if (!first || !lines.length) return { ...base, kind: "UNPRICEABLE", expected: null, missingVolumeDiscount: false, reason: "đơn không có dòng hàng" };
  if (lines.some((l) => l.variantId === null || !first.byId.has(l.variantId))) return { ...base, kind: "UNPRICEABLE", expected: null, missingVolumeDiscount: false, reason: "mẫu mã đã xoá / ẩn khỏi danh mục" };
  const cart = lines.map((l) => ({ variantId: l.variantId!, quantity: l.quantity }));
  const runs = contexts.map((ctx) => computePriced(cart, ctx)).filter((p) => !p.unpriced.length && !p.missing.length);
  if (!runs.length) return { ...base, kind: "UNPRICEABLE", expected: null, missingVolumeDiscount: false, reason: "mẫu mã thiếu giá bán" };
  const expected = runs[0].subtotal;
  if (runs.some((p) => p.subtotal === actual)) return { ...base, kind: "OK", expected, missingVolumeDiscount: false, reason: null };
  const p = runs[0];
  const grossOrder = lines.reduce((s, l) => s + (l.unitPrice ?? 0) * l.quantity, 0);
  const grossServer = p.lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const discOrder = lines.reduce((s, l) => s + (l.discount ?? 0), 0);
  const discServer = p.lines.reduce((s, l) => s + l.discount, 0);
  return { ...base, kind: "PRICE_MISMATCH", expected, missingVolumeDiscount: grossOrder === grossServer && discServer > discOrder, reason: null };
}
