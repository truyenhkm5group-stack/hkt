import { asc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { PriceListBook, PriceTier } from "@/lib/constants/price-lists";

/** Bảng giá cho trang danh sách — số bậc, số mẫu mã, số khách đang gán. */
export async function listPriceLists() {
  const db = await getDb();
  const pl = schema.priceLists;
  return db
    .select({
      id: pl.id,
      name: pl.name,
      note: pl.note,
      isDefault: pl.isDefault,
      active: pl.active,
      updatedAt: pl.updatedAt,
      tiers: sql<number>`(select count(*) from price_list_items i where i.price_list_id = "price_lists"."id")`.mapWith(Number),
      variants: sql<number>`(select count(distinct i.variant_id) from price_list_items i where i.price_list_id = "price_lists"."id")`.mapWith(Number),
      customers: sql<number>`(select count(*) from customer_trade_terms t where t.price_list_id = "price_lists"."id")`.mapWith(Number),
    })
    .from(pl)
    .orderBy(sql`${pl.active} desc`, asc(pl.name));
}

/** Một bảng giá kèm các bậc — cho trình sửa. `null` ⇒ không có. */
export async function getPriceList(id: string): Promise<{ id: string; name: string; note: string; isDefault: boolean; active: boolean; tiers: PriceTier[] } | null> {
  const db = await getDb();
  const [row] = await db.select().from(schema.priceLists).where(eq(schema.priceLists.id, id)).limit(1);
  if (!row) return null;
  const items = await db.select().from(schema.priceListItems).where(eq(schema.priceListItems.priceListId, id)).orderBy(asc(schema.priceListItems.variantId), asc(schema.priceListItems.minQuantity));
  return { id: row.id, name: row.name, note: row.note, isDefault: row.isDefault, active: row.active, tiers: items.map((i) => ({ variantId: i.variantId, minQuantity: i.minQuantity, unitPrice: i.unitPrice })) };
}

/**
 * Bảng giá áp cho MỘT khách: bảng gán cho khách (nếu còn bật) + bảng mặc định đang bật. Khách `null` (chưa nhận ra là
 * ai) ⇒ chỉ bảng mặc định. Đầu vào của `quoteUnitPrice` ở chatbot.
 */
export async function priceBooksFor(customerId: string | null): Promise<{ customerList: PriceListBook | null; defaultList: PriceListBook | null }> {
  const db = await getDb();
  const lists = await db.select().from(schema.priceLists).where(eq(schema.priceLists.active, true));
  if (lists.length === 0) return { customerList: null, defaultList: null };
  let assigned: string | null = null;
  if (customerId) {
    const [t] = await db.select({ priceListId: schema.customerTradeTerms.priceListId }).from(schema.customerTradeTerms).where(eq(schema.customerTradeTerms.customerId, customerId)).limit(1);
    assigned = t?.priceListId ?? null;
  }
  const want = lists.filter((l) => l.isDefault || l.id === assigned);
  const items = want.length ? await db.select().from(schema.priceListItems).where(inArray(schema.priceListItems.priceListId, want.map((l) => l.id))) : [];
  const book = (l: (typeof lists)[number]): PriceListBook => ({ id: l.id, name: l.name, isDefault: l.isDefault, tiers: items.filter((i) => i.priceListId === l.id).map((i) => ({ variantId: i.variantId, minQuantity: i.minQuantity, unitPrice: i.unitPrice })) });
  const own = lists.find((l) => l.id === assigned);
  const dflt = lists.find((l) => l.isDefault);
  return { customerList: own ? book(own) : null, defaultList: dflt ? book(dflt) : null };
}
