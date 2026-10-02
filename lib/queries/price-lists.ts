import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { PriceTier } from "@/lib/constants/price-lists";

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
