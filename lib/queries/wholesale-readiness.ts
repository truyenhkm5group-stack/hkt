import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { availableStockExpr, erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import {
  DESCRIPTION_FIELD_KEYS,
  evaluateExportReadiness,
  evaluateVariantReadiness,
  STORAGE_FIELD_KEYS,
  summarizeReadiness,
  type ExportReadiness,
  type ReadinessSources,
  type ReadinessSummary,
  type TierLite,
  type VariantReadiness,
} from "@/lib/wholesale/catalog-readiness";

/**
 * ═══════════ SẴN SÀNG BÁN SỈ / XUẤT KHẨU — ĐỌC (docs/tech/hslc-b2b-sales-agent.md · P1c) ═══════════
 *
 * CHỈ ĐỌC. Mọi con số đi qua hàm có sẵn của miền sở hữu nó, không viết lại:
 *  · TỒN = sổ kho (`stockKnownExpr` · `erpStockExpr` · `availableStockExpr`, lib/queries/stock.ts — luật 10), tắt JIT như mọi
 *    chỗ khác đọc phép gộp `vsales`.
 *  · BẬC GIÁ = `price_lists` / `price_list_items` của bảng ĐANG BẬT — cùng tập bảng mà `priceBooksFor` (đường báo giá) đọc.
 *  · MÔ TẢ / BẢO QUẢN = field sản phẩm ĐÃ KHAI (`meta_custom_fields` ACTIVE) ∩ khoá của mẫu ngành — không đọc khoá lạ.
 *  · HẠN DÙNG = `stock_lots` (module «Lô & hạn dùng»).
 * Kết luận là hàm thuần `lib/wholesale/catalog-readiness.ts`.
 */

const MAX_VARIANTS = 3000;

export type WholesaleReadinessBoard = {
  rows: VariantReadiness[];
  summary: ReadinessSummary;
  exportReadiness: ExportReadiness;
  sources: ReadinessSources;
  /** Đọc tới trần — danh mục có thể dài hơn số dòng đang xét. */
  truncated: boolean;
};

export async function wholesaleReadinessBoard(): Promise<WholesaleReadinessBoard> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;

  // Mẫu mã ĐANG BÁN — cùng điều kiện với danh mục của chatbot (`sellableCatalog`): chưa gỡ, không ẩn, sản phẩm chưa gỡ.
  const variants = await db
    .select({
      variantId: pv.id,
      productId: pv.productId,
      productName: p.name,
      sku: pv.sku,
      detail: pv.detail,
      color: pv.color,
      size: pv.size,
      weight: pv.weight,
      images: pv.images,
      productImage: p.image,
      addOnOnly: pv.addOnOnly,
    })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(and(eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false)))
    .orderBy(asc(p.name), asc(pv.sku), asc(pv.id))
    .limit(MAX_VARIANTS + 1);
  const truncated = variants.length > MAX_VARIANTS;
  const list = variants.slice(0, MAX_VARIANTS);
  const variantIds = list.map((v) => v.variantId);
  const productIds = [...new Set(list.map((v) => v.productId))];

  const [lists, fieldDefs] = await Promise.all([
    db.select({ id: schema.priceLists.id, name: schema.priceLists.name, isDefault: schema.priceLists.isDefault }).from(schema.priceLists).where(eq(schema.priceLists.active, true)),
    db
      .select({ key: schema.metaCustomFields.fieldKey, label: schema.metaCustomFields.label })
      .from(schema.metaCustomFields)
      .where(and(eq(schema.metaCustomFields.objectKey, "product"), eq(schema.metaCustomFields.status, "ACTIVE"))),
  ]);
  const defaultList = lists.find((l) => l.isDefault) ?? null;
  const descKeys = fieldDefs.filter((f) => (DESCRIPTION_FIELD_KEYS as readonly string[]).includes(f.key));
  const storageKeys = fieldDefs.filter((f) => (STORAGE_FIELD_KEYS as readonly string[]).includes(f.key)).map((f) => f.key);
  const sources: ReadinessSources = { defaultListName: defaultList?.name ?? null, descriptionFieldKeys: descKeys.map((f) => f.key), storageFieldKeys: storageKeys };

  const empty = variantIds.length === 0;
  const [items, values, lots, stock] = await Promise.all([
    empty || lists.length === 0
      ? Promise.resolve([])
      : db
          .select({ priceListId: schema.priceListItems.priceListId, variantId: schema.priceListItems.variantId, minQuantity: schema.priceListItems.minQuantity, unitPrice: schema.priceListItems.unitPrice })
          .from(schema.priceListItems)
          .where(and(inArray(schema.priceListItems.priceListId, lists.map((l) => l.id)), inArray(schema.priceListItems.variantId, variantIds))),
    empty || descKeys.length + storageKeys.length === 0
      ? Promise.resolve([])
      : db
          .select({ recordId: schema.customValues.recordId, values: schema.customValues.values })
          .from(schema.customValues)
          .where(and(eq(schema.customValues.objectKey, "product"), inArray(schema.customValues.recordId, productIds))),
    empty
      ? Promise.resolve([])
      : db
          .select({
            variantId: schema.stockLots.variantId,
            lotCount: sql<number>`count(*)`.mapWith(Number),
            earliest: sql<string>`min(${schema.stockLots.expiresOn})::text`,
            latest: sql<string>`max(${schema.stockLots.expiresOn})::text`,
          })
          .from(schema.stockLots)
          .where(inArray(schema.stockLots.variantId, variantIds))
          .groupBy(schema.stockLots.variantId),
    empty
      ? Promise.resolve([])
      : chayKhongJit(db, async (tx) => {
          const sales = variantSalesSubquery(tx, variantIds);
          const receipts = variantReceiptsSubquery(tx, variantIds);
          return await tx
            .select({ variantId: pv.id, stockKnown: stockKnownExpr(receipts), onHand: erpStockExpr(sales, receipts), available: availableStockExpr(sales, receipts) })
            .from(pv)
            .leftJoin(sales, eq(sales.variantId, pv.id))
            .leftJoin(receipts, eq(receipts.variantId, pv.id))
            .where(inArray(pv.id, variantIds));
        }),
  ]);

  const listName = new Map(lists.map((l) => [l.id, l.name]));
  const defaultTiers = new Map<string, TierLite[]>();
  const otherLists = new Map<string, Set<string>>();
  for (const it of items) {
    if (defaultList && it.priceListId === defaultList.id) {
      const arr = defaultTiers.get(it.variantId) ?? [];
      arr.push({ minQuantity: it.minQuantity, unitPrice: it.unitPrice });
      defaultTiers.set(it.variantId, arr);
    } else {
      const set = otherLists.get(it.variantId) ?? new Set<string>();
      set.add(listName.get(it.priceListId) ?? it.priceListId);
      otherLists.set(it.variantId, set);
    }
  }
  const textOf = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
  const valuesByProduct = new Map(values.map((r) => [r.recordId, r.values ?? {}]));
  const lotsByVariant = new Map(lots.map((l) => [l.variantId, l]));
  const stockByVariant = new Map(stock.map((s) => [s.variantId, s]));

  const rows = list.map((v) => {
    const vals = valuesByProduct.get(v.productId) ?? {};
    const st = stockByVariant.get(v.variantId);
    const lot = lotsByVariant.get(v.variantId);
    const stockKnown = Boolean(st?.stockKnown);
    return evaluateVariantReadiness(
      {
        variantId: v.variantId,
        productId: v.productId,
        productName: v.productName,
        sku: v.sku,
        variantLabel: v.detail.trim() || [v.color, v.size].filter((x) => x.trim()).join(" · "),
        addOnOnly: v.addOnOnly,
        weightGrams: v.weight,
        imageUrl: v.images?.find((x) => x.trim()) || v.productImage || null,
        defaultTiers: defaultTiers.get(v.variantId) ?? [],
        otherListNames: [...(otherLists.get(v.variantId) ?? [])],
        stockKnown,
        // Chưa có phiếu nhập ⇒ KHÔNG đưa số ra (luật 42): biểu thức vẫn trả «0 − đã xuất», con số đó là bịa.
        onHand: stockKnown && st ? Number(st.onHand) : null,
        available: stockKnown && st ? Number(st.available) : null,
        descriptionFields: descKeys.filter((f) => textOf(vals[f.key])).map((f) => f.label),
        storageFilled: storageKeys.length ? storageKeys.some((k) => textOf(vals[k])) : null,
        lotCount: lot?.lotCount ?? 0,
        lotEarliestExpiry: lot?.earliest ?? null,
        lotLatestExpiry: lot?.latest ?? null,
      },
      sources,
    );
  });

  return { rows, summary: summarizeReadiness(rows), exportReadiness: evaluateExportReadiness(rows, sources), sources, truncated };
}
