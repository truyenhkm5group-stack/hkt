/**
 * ═══════════ DANH MỤC CHO CHATBOT BÁN HÀNG — ĐỌC TỪ ERP, KHÔNG BAO GIỜ TỪ LỜI NHẮC (0180) — CHỈ MÁY CHỦ ═══════════
 *
 * Mọi con số bot nói ra (giá, tồn) đọc ở ĐÂY, lúc gọi công cụ, từ CSDL của tổ chức ngữ cảnh:
 *  · GIÁ = `product_variants.retail_price` hiện tại. Giá 0 / thiếu ⇒ `price: null` ("chưa có giá") — bot không được báo 0 ₫
 *    (luật 42) và không được lên đơn cho mã chưa có giá.
 *  · TỒN = đúng công thức sổ kho (`lib/queries/stock.ts`): tồn thực tế − đã chốt chưa xuất = KHẢ DỤNG. Mã chưa có phiếu nhập
 *    nào ⇒ `stockKnown = false` ⇒ `available: null` ("chưa xác nhận được tồn"), KHÔNG phải 0 và không phải "còn hàng".
 *  · Field tuỳ biến của sản phẩm: CHỈ những khoá người cấu hình cho phép bot đọc (`productFields` của cấu hình) — field
 *    nội bộ (giá nhập, ghi chú kho…) không bao giờ ra ngoài vì bot không biết tới chúng.
 * Sản phẩm / mẫu mã đã gỡ hoặc đang ẩn (`is_hidden` = thôi bán) không hiện với bot.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { loadCustomDefs } from "@/lib/metadata/common";
import { availableStockExpr, erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { foldVi } from "@/lib/sales-chatbot/text";

export type CatalogItem = {
  variantId: string;
  productId: string;
  name: string;
  sku: string;
  variant: string;
  price: number | null;
  fields: Record<string, string>;
};

export type StockInfo = { variantId: string; stockKnown: boolean; onHand: number | null; available: number | null };

const MAX_ITEMS = 2000;

export { foldVi };

function variantText(v: { detail: string; color: string; size: string }): string {
  return v.detail.trim() || [v.color, v.size].filter((x) => x.trim()).join(" · ");
}

async function productFieldValues(productIds: string[], allowed: readonly string[]): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (productIds.length === 0 || allowed.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .select({ recordId: schema.customValues.recordId, values: schema.customValues.values })
    .from(schema.customValues)
    .where(and(eq(schema.customValues.objectKey, "product"), inArray(schema.customValues.recordId, productIds)));
  for (const r of rows) {
    const picked: Record<string, string> = {};
    for (const k of allowed) {
      const v = (r.values ?? {})[k];
      if (typeof v === "string" && v.trim()) picked[k] = v.trim();
      else if (typeof v === "number" && Number.isFinite(v)) picked[k] = String(v);
    }
    out.set(r.recordId, picked);
  }
  return out;
}

/** Mọi mẫu mã ĐANG BÁN của tổ chức (trần 2.000) kèm field cho phép. */
export async function sellableCatalog(allowedFields: readonly string[]): Promise<CatalogItem[]> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = await db
    .select({ variantId: pv.id, productId: pv.productId, name: p.name, sku: pv.sku, detail: pv.detail, color: pv.color, size: pv.size, price: pv.retailPrice })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(and(eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false)))
    .orderBy(asc(p.name), asc(pv.sku))
    .limit(MAX_ITEMS);
  const fields = await productFieldValues([...new Set(rows.map((r) => r.productId))], allowedFields);
  return rows.map((r) => ({
    variantId: r.variantId,
    productId: r.productId,
    name: r.name,
    sku: r.sku,
    variant: variantText(r),
    price: r.price > 0 ? r.price : null,
    fields: fields.get(r.productId) ?? {},
  }));
}

/**
 * Tìm theo câu khách gõ: mọi từ của câu (đã bỏ dấu) phải có trong tên / SKU / quy cách. Không khớp đủ ⇒ xếp theo số từ
 * khớp, tối đa `limit`. Hàm THUẦN trên danh mục đã đọc.
 */
export function searchCatalog(items: readonly CatalogItem[], query: string, limit = 8): CatalogItem[] {
  const words = foldVi(query).split(" ").filter((w) => w.length > 0);
  if (words.length === 0) return items.slice(0, limit);
  const scored = items.map((it) => {
    const hay = foldVi([it.name, it.sku, it.variant, ...Object.values(it.fields)].join(" "));
    const hits = words.filter((w) => hay.includes(w)).length;
    return { it, hits, all: hits === words.length };
  });
  const full = scored.filter((s) => s.all);
  const pool = full.length ? full : scored.filter((s) => s.hits > 0).sort((a, b) => b.hits - a.hits);
  return pool.slice(0, limit).map((s) => s.it);
}

/** Tồn của các mẫu mã — CÙNG công thức với sổ kho. Mẫu mã không có trong kết quả = không tồn tại / đã gỡ. */
export async function stockFor(variantIds: readonly string[]): Promise<Map<string, StockInfo>> {
  const out = new Map<string, StockInfo>();
  const ids = [...new Set(variantIds)].filter(Boolean);
  if (ids.length === 0) return out;
  const db = await getDb();
  const pv = schema.productVariants;
  const sales = variantSalesSubquery(db, ids);
  const receipts = variantReceiptsSubquery(db, ids);
  const rows = await db
    .select({ id: pv.id, known: stockKnownExpr(receipts), onHand: erpStockExpr(sales, receipts), available: availableStockExpr(sales, receipts) })
    .from(pv)
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .where(inArray(pv.id, ids));
  for (const r of rows) {
    const known = Boolean(r.known);
    out.set(r.id, { variantId: r.id, stockKnown: known, onHand: known ? Number(r.onHand ?? 0) : null, available: known ? Number(r.available ?? 0) : null });
  }
  return out;
}

/** Field tuỳ biến của SẢN PHẨM mà tổ chức đang có (để màn hình cấu hình cho chọn field bot được đọc). */
export async function productCustomFieldOptions(): Promise<{ key: string; label: string; type: string }[]> {
  const defs = await loadCustomDefs("product", false);
  return defs.filter((d) => ["text", "textarea", "select", "number"].includes(d.type)).map((d) => ({ key: d.key, label: d.label, type: d.type }));
}
