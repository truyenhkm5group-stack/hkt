/**
 * ═══════════ GIÁ BÁN CHO ĐƯỜNG AGENT — MỘT CÔNG THỨC (docs/productization/TECH_DEBT.md TD-01 · MIGRATION_PLAN.md M3) ═══════════
 *
 * Trước tệp này giá đúng chỉ được tính ở lớp công cụ của chatbot (`priceLines`), còn lõi đơn nhận `unitPrice` do NGƯỜI GỌI
 * truyền: một công cụ / kênh / agent mới gọi thẳng `createOrderAsAgent` là truyền được giá tuỳ ý. Nay lõi tự tính lại đơn giá
 * bằng ĐÚNG hàm mà bot dùng để báo giá — `agentUnitPrice` — nên không đường agent nào bán lệch giá được.
 *
 * Hai chế độ (khai bởi lớp gọi, không đoán):
 *  · `RETAIL` — giá lẻ của mẫu mã (`product_variants.retail_price`; 0 / thiếu ⇒ CHƯA CÓ GIÁ, không phải 0 ₫).
 *  · `PRICE_BOOK` — bảng giá riêng của khách → bảng mặc định → giá lẻ (`quoteUnitPrice`, cùng hàm với form đơn tay).
 */
import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { quoteUnitPrice, type PriceListBook } from "@/lib/constants/price-lists";
import { priceBooksFor } from "@/lib/queries/price-lists";

export type AgentPricingMode = "RETAIL" | "PRICE_BOOK";
export type PriceBooks = { customerList: PriceListBook | null; defaultList: PriceListBook | null } | null;

/** Đơn giá của MỘT dòng — HÀM THUẦN. `retailPrice` ≤ 0 / null ⇒ chưa có giá lẻ. `books = null` ⇒ chế độ giá lẻ. */
export function agentUnitPrice(input: { variantId: string; quantity: number; retailPrice: number | null; books: PriceBooks }): number | null {
  const retail = input.retailPrice !== null && input.retailPrice > 0 ? input.retailPrice : null;
  if (!input.books) return retail;
  return quoteUnitPrice({ variantId: input.variantId, quantity: input.quantity, retailPrice: retail, customerList: input.books.customerList, defaultList: input.books.defaultList })?.unitPrice ?? null;
}

/** Bảng giá cần cho một chế độ — `null` ở chế độ giá lẻ (không đọc CSDL). */
export async function priceBooksForMode(mode: AgentPricingMode, customerId: string | null): Promise<PriceBooks> {
  return mode === "PRICE_BOOK" ? priceBooksFor(customerId) : null;
}

/** Đơn giá MÁY CHỦ tính cho từng dòng (mẫu mã không có ⇒ không có trong Map). */
export async function agentUnitPrices(lines: readonly { variantId: string; quantity: number }[], customerId: string | null, mode: AgentPricingMode): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const ids = [...new Set(lines.map((l) => l.variantId))].filter(Boolean);
  if (!ids.length) return out;
  const db = await getDb();
  const pv = schema.productVariants;
  const rows = await db.select({ id: pv.id, retail: pv.retailPrice }).from(pv).where(inArray(pv.id, ids));
  const retail = new Map(rows.map((r) => [r.id, r.retail]));
  const books = await priceBooksForMode(mode, customerId);
  lines.forEach((l, i) => {
    if (!retail.has(l.variantId)) return;
    out.set(`${i}`, agentUnitPrice({ variantId: l.variantId, quantity: l.quantity, retailPrice: retail.get(l.variantId) ?? null, books }));
  });
  return out;
}

/**
 * So giá agent gửi với giá máy chủ tính — HÀM THUẦN. Trả danh sách lỗi theo dòng (rỗng = khớp). Đường agent KHÔNG được mang
 * chiết khấu (dòng / đơn): giảm giá ngoài bảng là quyết định của người, không của máy.
 */
export function agentPriceProblems(
  lines: readonly { variantId: string; quantity: number; unitPrice: number; discount: number }[],
  expected: ReadonlyMap<string, number | null>,
  orderDiscount: number,
): { field: string; message: string }[] {
  const out: { field: string; message: string }[] = [];
  lines.forEach((l, i) => {
    const want = expected.get(`${i}`);
    if (want === undefined) return; // mẫu mã không tồn tại — `prepare()` đã báo lỗi riêng.
    if (want === null) out.push({ field: `lines.${i}.unitPrice`, message: "Mẫu mã chưa có giá bán — máy không được tự đặt giá." });
    else if (l.unitPrice !== want) out.push({ field: `lines.${i}.unitPrice`, message: `Giá vừa đổi: đơn giá đúng là ${want.toLocaleString("vi-VN")} ₫ (gửi lên ${l.unitPrice.toLocaleString("vi-VN")} ₫).` });
    if (l.discount !== 0) out.push({ field: `lines.${i}.discount`, message: "Máy không được tự chiết khấu dòng hàng." });
  });
  if (orderDiscount !== 0) out.push({ field: "orderDiscount", message: "Máy không được tự chiết khấu đơn." });
  return out;
}
