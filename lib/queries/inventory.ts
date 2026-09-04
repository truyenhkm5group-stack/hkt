import { and, asc, count, desc, eq, exists, gte, ilike, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema } from "@/db";
import { inventoryTableLabel } from "@/lib/constants/inventory";
import type { ListParams } from "@/lib/search-params";

export const INVENTORY_SORTABLE = ["insertedAt", "quantity", "remainQuantity"];

const ih = schema.inventoryHistories;

export function inventorySearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  return or(
    ilike(ih.type, like),
    ilike(ih.refDisplayId, like),
    ilike(ih.editorName, like),
    exists(sql`(select 1 from ${schema.productVariants} pv join ${schema.products} p on p.id = pv.product_id where pv.id = ${ih.variantId} and (pv.sku ilike ${like} or pv.barcode ilike ${like} or p.name ilike ${like}))`),
  );
}

export function inventoryListWhere(params: ListParams) {
  const conds: (SQL | undefined)[] = [];
  const { period, filters, q } = params;
  if (period.from) conds.push(gte(ih.insertedAt, period.from));
  if (period.to) conds.push(lte(ih.insertedAt, period.to));
  if (filters.warehouse?.length) conds.push(inArray(ih.warehouseId, filters.warehouse));
  if (filters.table?.length) {
    const named = filters.table.filter((t) => t !== "none");
    const tableConds: SQL[] = [];
    if (named.length) tableConds.push(inArray(ih.tableName, named));
    if (filters.table.includes("none")) tableConds.push(or(isNull(ih.tableName), eq(ih.tableName, "")) as SQL);
    conds.push(or(...tableConds));
  }
  if (filters.direction?.includes("in")) conds.push(sql`${ih.quantity} > 0`);
  if (filters.direction?.includes("out")) conds.push(sql`${ih.quantity} < 0`);
  conds.push(inventorySearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

export async function listInventory(params: ListParams) {
  const db = await getDb();
  const where = inventoryListWhere(params);
  const sortMap: Record<string, AnyPgColumn> = { insertedAt: ih.insertedAt, quantity: ih.quantity, remainQuantity: ih.remainQuantity };
  const sortColumn = sortMap[params.sort] ?? ih.insertedAt;
  const orderBy = params.dir === "asc" ? asc(sortColumn) : desc(sortColumn);
  const [rows, [{ total }]] = await Promise.all([
    db.query.inventoryHistories.findMany({
      where,
      orderBy: [orderBy, desc(ih.id)],
      limit: params.pageSize,
      offset: (params.page - 1) * params.pageSize,
      columns: { id: true, quantity: true, remainQuantity: true, avgPrice: true, type: true, tableName: true, refDisplayId: true, editorName: true, insertedAt: true, warehouseId: true, variantId: true },
      with: {
        variant: { columns: { id: true, sku: true, color: true, size: true, images: true, productId: true }, with: { product: { columns: { id: true, name: true, image: true } } } },
        warehouse: { columns: { id: true, name: true } },
      },
    }),
    db.select({ total: count() }).from(ih).where(where),
  ]);
  return { rows, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

export type InventoryListRow = Awaited<ReturnType<typeof listInventory>>["rows"][number];

/** Số giao dịch theo kho / bảng tham chiếu trong kỳ (cho bộ lọc) */
export async function inventoryFacets(params: ListParams) {
  const db = await getDb();
  const base = inventoryListWhere({ ...params, filters: {} });
  const [warehouses, tables, [direction]] = await Promise.all([
    db
      .select({ value: schema.warehouses.id, label: schema.warehouses.name, count: count() })
      .from(ih)
      .innerJoin(schema.warehouses, eq(ih.warehouseId, schema.warehouses.id))
      .where(base)
      .groupBy(schema.warehouses.id, schema.warehouses.name)
      .orderBy(desc(count())),
    db
      .select({ value: sql<string>`coalesce(nullif(${ih.tableName}, ''), 'none')`, count: count() })
      .from(ih)
      .where(base)
      .groupBy(sql`1`)
      .orderBy(desc(count())),
    db
      .select({ imports: sql<number>`count(*) filter (where ${ih.quantity} > 0)`, exports: sql<number>`count(*) filter (where ${ih.quantity} < 0)` })
      .from(ih)
      .where(base),
  ]);
  return {
    warehouses: warehouses.map((w) => ({ value: w.value, label: w.label, count: Number(w.count) })),
    tables: tables.map((t) => ({ value: t.value, label: inventoryTableLabel(t.value === "none" ? null : t.value), count: Number(t.count) })),
    direction: [
      { value: "in", label: "Nhập kho (+)", count: Number(direction?.imports ?? 0) },
      { value: "out", label: "Xuất kho (−)", count: Number(direction?.exports ?? 0) },
    ],
  };
}

export async function inventorySummary(params: ListParams) {
  const db = await getDb();
  const where = inventoryListWhere(params);
  const [row] = await db
    .select({
      transactions: count(),
      imported: sql<number>`coalesce(sum(case when ${ih.quantity} > 0 then ${ih.quantity} else 0 end), 0)`,
      exported: sql<number>`coalesce(sum(case when ${ih.quantity} < 0 then -${ih.quantity} else 0 end), 0)`,
      importTx: sql<number>`count(*) filter (where ${ih.quantity} > 0)`,
      exportTx: sql<number>`count(*) filter (where ${ih.quantity} < 0)`,
      variants: sql<number>`count(distinct ${ih.variantId})`,
    })
    .from(ih)
    .where(where);
  return {
    transactions: Number(row?.transactions ?? 0),
    imported: Number(row?.imported ?? 0),
    exported: Number(row?.exported ?? 0),
    importTx: Number(row?.importTx ?? 0),
    exportTx: Number(row?.exportTx ?? 0),
    variants: Number(row?.variants ?? 0),
  };
}
