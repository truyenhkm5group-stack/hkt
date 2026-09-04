import { and, asc, count, desc, eq, exists, gte, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { getDb, schema, type Db } from "@/db";
import { toDate } from "@/lib/format";
import type { ListParams } from "@/lib/search-params";

export const PRODUCT_SORTABLE = ["remainQuantity", "retailPrice", "sold30", "sku", "updatedAtExternal", "stockValue"];

const pv = schema.productVariants;
const p = schema.products;

/** Mẫu mã đang bán: không ẩn / khoá / xoá ở cả cấp mẫu mã lẫn sản phẩm */
export function sellingCondition(): SQL {
  return and(eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(pv.isLocked, false), eq(p.isRemoved, false), eq(p.isHidden, false)) as SQL;
}

export function productSearchCondition(q: string): SQL | undefined {
  const term = q.trim();
  if (!term) return undefined;
  const like = `%${term}%`;
  return or(ilike(p.name, like), ilike(pv.sku, like), ilike(pv.barcode, like), ilike(pv.color, like), ilike(pv.size, like), ilike(p.customId, like), ilike(pv.customId, like));
}

/** Điều kiện lọc danh sách mẫu mã; `skip` để bỏ qua một số bộ lọc (dùng cho facet / KPI) */
export function productListWhere(params: ListParams, skip: string[] = []) {
  const conds: (SQL | undefined)[] = [];
  const { filters, q } = params;
  const stock = skip.includes("stock") ? undefined : filters.stock?.[0];
  if (stock === "low") conds.push(sql`${pv.remainQuantity} <= 5`);
  else if (stock === "out") conds.push(sql`${pv.remainQuantity} <= 0`);
  else if (stock === "in") conds.push(sql`${pv.remainQuantity} > 0`);
  const status = skip.includes("status") ? undefined : filters.status?.[0];
  if (status === "selling") conds.push(sellingCondition());
  else if (status === "hidden") conds.push(sql`not (${sellingCondition()})`);
  if (!skip.includes("category") && filters.category?.length) {
    conds.push(sql`${p.categories} && ${sql.raw(`ARRAY[${filters.category.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")}]::text[]`)}`);
  }
  if (!skip.includes("warehouse") && filters.warehouse?.length) {
    conds.push(exists(sql`(select 1 from ${schema.variantStocks} vs where vs.variant_id = ${pv.id} and vs.warehouse_id in ${filters.warehouse} and vs.remain_quantity > 0)`));
  }
  conds.push(productSearchCondition(q));
  const defined = conds.filter((c): c is SQL => Boolean(c));
  return defined.length ? and(...defined) : undefined;
}

/** Số lượng bán trong 30 ngày gần nhất theo mẫu mã (không tính đơn huỷ/xoá) */
function sold30Subquery(db: Db) {
  const since = new Date(Date.now() - 30 * 86_400_000);
  return db
    .select({ variantId: schema.orderItems.variantId, qty: sql<number>`sum(${schema.orderItems.quantity})`.as("qty") })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
    .where(and(gte(schema.orders.insertedAt, since), notInArray(schema.orders.stage, ["CANCELLED", "DELETED"])))
    .groupBy(schema.orderItems.variantId)
    .as("sold30");
}

export type VariantStockCell = { warehouseId: string; warehouseName: string; remainQuantity: number; actualRemainQuantity: number; pendingQuantity: number; returningQuantity: number };

export type ProductListRow = {
  id: string;
  productId: string;
  productName: string;
  productImage: string | null;
  categories: string[];
  sku: string;
  barcode: string | null;
  color: string;
  size: string;
  detail: string;
  images: string[];
  retailPrice: number;
  lastImportedPrice: number;
  avgImportedPrice: number;
  remainQuantity: number;
  actualRemainQuantity: number;
  selling: boolean;
  updatedAtExternal: Date | null;
  sold30: number;
  stockValue: number;
  stocks: VariantStockCell[];
};

export async function listWarehouses() {
  const db = await getDb();
  return db.select({ id: schema.warehouses.id, name: schema.warehouses.name }).from(schema.warehouses).orderBy(asc(schema.warehouses.name));
}

export async function listProducts(params: ListParams, limit?: number) {
  const db = await getDb();
  const where = productListWhere(params);
  const sold = sold30Subquery(db);
  const soldQty = sql<number>`coalesce(${sold.qty}, 0)`;
  const stockValue = sql<number>`greatest(${pv.remainQuantity}, 0) * ${pv.lastImportedPrice}`;
  const sortMap: Record<string, SQL | AnyPgColumn> = {
    remainQuantity: pv.remainQuantity,
    retailPrice: pv.retailPrice,
    sku: pv.sku,
    updatedAtExternal: pv.updatedAtExternal,
    sold30: soldQty,
    stockValue,
  };
  const sortExpr = sortMap[params.sort] ?? pv.remainQuantity;
  const orderBy = params.dir === "asc" ? asc(sortExpr) : desc(sortExpr);
  const pageSize = limit ?? params.pageSize;

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: pv.id,
        productId: pv.productId,
        productName: p.name,
        productImage: p.image,
        categories: p.categories,
        sku: pv.sku,
        barcode: pv.barcode,
        color: pv.color,
        size: pv.size,
        detail: pv.detail,
        images: pv.images,
        retailPrice: pv.retailPrice,
        lastImportedPrice: pv.lastImportedPrice,
        avgImportedPrice: pv.avgImportedPrice,
        remainQuantity: pv.remainQuantity,
        actualRemainQuantity: pv.actualRemainQuantity,
        selling: sql<boolean>`(${sellingCondition()})`,
        updatedAtExternal: pv.updatedAtExternal,
        sold30: soldQty,
        stockValue,
      })
      .from(pv)
      .innerJoin(p, eq(pv.productId, p.id))
      .leftJoin(sold, eq(sold.variantId, pv.id))
      .where(where)
      .orderBy(orderBy, asc(p.name), asc(pv.sku))
      .limit(pageSize)
      .offset(limit ? 0 : (params.page - 1) * params.pageSize),
    db.select({ total: count() }).from(pv).innerJoin(p, eq(pv.productId, p.id)).where(where),
  ]);

  const ids = rows.map((r) => r.id);
  const stocks = ids.length
    ? await db
        .select({
          variantId: schema.variantStocks.variantId,
          warehouseId: schema.variantStocks.warehouseId,
          warehouseName: schema.warehouses.name,
          remainQuantity: schema.variantStocks.remainQuantity,
          actualRemainQuantity: schema.variantStocks.actualRemainQuantity,
          pendingQuantity: schema.variantStocks.pendingQuantity,
          returningQuantity: schema.variantStocks.returningQuantity,
        })
        .from(schema.variantStocks)
        .innerJoin(schema.warehouses, eq(schema.variantStocks.warehouseId, schema.warehouses.id))
        .where(inArray(schema.variantStocks.variantId, ids))
    : [];
  const stockMap = new Map<string, VariantStockCell[]>();
  for (const s of stocks) {
    const list = stockMap.get(s.variantId) ?? [];
    list.push({ warehouseId: s.warehouseId, warehouseName: s.warehouseName, remainQuantity: s.remainQuantity, actualRemainQuantity: s.actualRemainQuantity, pendingQuantity: s.pendingQuantity, returningQuantity: s.returningQuantity });
    stockMap.set(s.variantId, list);
  }

  const mapped: ProductListRow[] = rows.map((r) => ({
    ...r,
    selling: Boolean(r.selling),
    avgImportedPrice: Number(r.avgImportedPrice ?? 0),
    sold30: Number(r.sold30 ?? 0),
    stockValue: Number(r.stockValue ?? 0),
    updatedAtExternal: toDate(r.updatedAtExternal),
    stocks: stockMap.get(r.id) ?? [],
  }));

  return { rows: mapped, total: Number(total), pageCount: Math.max(1, Math.ceil(Number(total) / params.pageSize)) };
}

/** Số mẫu mã theo tồn kho / danh mục / kho / trạng thái (cho bộ lọc) */
export async function productFacets(params: ListParams) {
  const db = await getDb();
  const base = productListWhere({ ...params, filters: {} });
  const selling = sellingCondition();
  const [categories, warehouseRows, warehouses, [stock], [status]] = await Promise.all([
    db
      .select({ value: sql<string>`cat.value`, count: count() })
      .from(pv)
      .innerJoin(p, eq(pv.productId, p.id))
      .crossJoinLateral(sql`unnest(${p.categories}) as cat(value)`)
      .where(base)
      .groupBy(sql`cat.value`)
      .orderBy(desc(count()), sql`cat.value`),
    db
      .select({ warehouseId: schema.variantStocks.warehouseId, count: count() })
      .from(schema.variantStocks)
      .innerJoin(pv, eq(schema.variantStocks.variantId, pv.id))
      .innerJoin(p, eq(pv.productId, p.id))
      .where(and(base, sql`${schema.variantStocks.remainQuantity} > 0`))
      .groupBy(schema.variantStocks.warehouseId),
    listWarehouses(),
    db
      .select({
        low: sql<number>`count(*) filter (where ${pv.remainQuantity} <= 5)`,
        out: sql<number>`count(*) filter (where ${pv.remainQuantity} <= 0)`,
        available: sql<number>`count(*) filter (where ${pv.remainQuantity} > 0)`,
      })
      .from(pv)
      .innerJoin(p, eq(pv.productId, p.id))
      .where(base),
    db
      .select({
        selling: sql<number>`count(*) filter (where ${selling})`,
        hidden: sql<number>`count(*) filter (where not (${selling}))`,
      })
      .from(pv)
      .innerJoin(p, eq(pv.productId, p.id))
      .where(base),
  ]);
  const whCount = Object.fromEntries(warehouseRows.map((w) => [w.warehouseId, Number(w.count)]));
  return {
    stock: [
      { value: "low", label: "Sắp hết (≤5)", count: Number(stock?.low ?? 0) },
      { value: "out", label: "Hết hàng (≤0)", count: Number(stock?.out ?? 0) },
      { value: "in", label: "Còn hàng", count: Number(stock?.available ?? 0) },
    ],
    categories: categories.filter((c) => c.value).map((c) => ({ value: c.value, label: c.value, count: Number(c.count) })),
    warehouses: warehouses.map((w) => ({ value: w.id, label: w.name, count: whCount[w.id] ?? 0 })),
    status: [
      { value: "selling", label: "Đang bán", count: Number(status?.selling ?? 0) },
      { value: "hidden", label: "Ẩn/khoá", count: Number(status?.hidden ?? 0) },
    ],
  };
}

/** KPI tồn kho theo bộ lọc hiện tại (bỏ qua lọc tồn kho / trạng thái) */
export async function productSummary(params: ListParams) {
  const db = await getDb();
  const where = productListWhere(params, ["stock", "status"]);
  const selling = sellingCondition();
  const sold = sold30Subquery(db);
  const [row] = await db
    .select({
      selling: sql<number>`count(*) filter (where ${selling})`,
      low: sql<number>`count(*) filter (where ${selling} and ${pv.remainQuantity} between 1 and 5)`,
      out: sql<number>`count(*) filter (where ${selling} and ${pv.remainQuantity} <= 0)`,
      stockValue: sql<number>`coalesce(sum(case when ${pv.isRemoved} = false and ${pv.remainQuantity} > 0 then ${pv.remainQuantity}::bigint * ${pv.lastImportedPrice} else 0 end), 0)`,
      stockUnits: sql<number>`coalesce(sum(case when ${pv.isRemoved} = false and ${pv.remainQuantity} > 0 then ${pv.remainQuantity} else 0 end), 0)`,
      sold30: sql<number>`coalesce(sum(${sold.qty}), 0)`,
      products: sql<number>`count(distinct ${pv.productId})`,
    })
    .from(pv)
    .innerJoin(p, eq(pv.productId, p.id))
    .leftJoin(sold, eq(sold.variantId, pv.id))
    .where(where);
  return {
    selling: Number(row?.selling ?? 0),
    low: Number(row?.low ?? 0),
    out: Number(row?.out ?? 0),
    stockValue: Number(row?.stockValue ?? 0),
    stockUnits: Number(row?.stockUnits ?? 0),
    sold30: Number(row?.sold30 ?? 0),
    products: Number(row?.products ?? 0),
  };
}

// ───────────────────────── Chi tiết sản phẩm ─────────────────────────

export async function getProductDetail(id: string) {
  const db = await getDb();
  const product = await db.query.products.findFirst({
    where: or(eq(p.id, id), eq(p.customId, id)),
    with: {
      variants: {
        orderBy: [asc(pv.sku), asc(pv.color), asc(pv.size)],
        with: { stocks: { with: { warehouse: { columns: { id: true, name: true } } } } },
      },
    },
  });
  if (!product) return null;

  const variantIds = product.variants.map((v) => v.id);
  const itemMatch = variantIds.length ? or(inArray(schema.orderItems.variantId, variantIds), eq(schema.orderItems.productId, product.id)) : eq(schema.orderItems.productId, product.id);
  const notCancelled = notInArray(schema.orders.stage, ["CANCELLED", "DELETED"]);
  const since30 = new Date(Date.now() - 30 * 86_400_000);
  const since90 = new Date(Date.now() - 90 * 86_400_000);

  const [[sales], soldByVariant, dailyRows, histories, recentOrders, warehouses] = await Promise.all([
    db
      .select({
        sold30: sql<number>`coalesce(sum(case when ${schema.orders.insertedAt} >= ${since30} then ${schema.orderItems.quantity} else 0 end), 0)`,
        sold90: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)`,
        revenue90: sql<number>`coalesce(sum(${schema.orderItems.lineTotal}), 0)`,
        orders90: sql<number>`count(distinct ${schema.orders.id})`,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
      .where(and(itemMatch, notCancelled, gte(schema.orders.insertedAt, since90))),
    variantIds.length
      ? db
          .select({ variantId: schema.orderItems.variantId, qty: sql<number>`sum(${schema.orderItems.quantity})` })
          .from(schema.orderItems)
          .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
          .where(and(inArray(schema.orderItems.variantId, variantIds), notCancelled, gte(schema.orders.insertedAt, since30)))
          .groupBy(schema.orderItems.variantId)
      : Promise.resolve([]),
    db
      .select({
        day: sql<string>`to_char(${schema.orders.insertedAt} at time zone 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD')`,
        quantity: sql<number>`sum(${schema.orderItems.quantity})`,
        orders: sql<number>`count(distinct ${schema.orders.id})`,
      })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orderItems.orderId, schema.orders.id))
      .where(and(itemMatch, notCancelled, gte(schema.orders.insertedAt, since30)))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
    variantIds.length
      ? db.query.inventoryHistories.findMany({
          where: inArray(schema.inventoryHistories.variantId, variantIds),
          orderBy: [desc(schema.inventoryHistories.insertedAt)],
          limit: 30,
          with: { variant: { columns: { id: true, sku: true, color: true, size: true } }, warehouse: { columns: { name: true } } },
        })
      : Promise.resolve([]),
    db.query.orders.findMany({
      where: exists(sql`(select 1 from ${schema.orderItems} oi where oi.order_id = ${schema.orders.id} and (${variantIds.length ? sql`oi.variant_id in ${variantIds} or ` : sql``}oi.product_id = ${product.id}))`),
      orderBy: [desc(schema.orders.insertedAt)],
      limit: 10,
      columns: { id: true, systemId: true, billFullName: true, billPhone: true, source: true, stage: true, statusName: true, totalPriceAfterDiscount: true, insertedAt: true },
      with: {
        shipment: { columns: { stage: true, vtpStatusName: true } },
        items: {
          columns: { productName: true, variationDetail: true, quantity: true, variantId: true, productId: true, sku: true },
          where: (oi, ops) => (variantIds.length ? ops.or(ops.inArray(oi.variantId, variantIds), ops.eq(oi.productId, product.id)) : ops.eq(oi.productId, product.id)),
        },
      },
    }),
    listWarehouses(),
  ]);

  const soldMap = Object.fromEntries(soldByVariant.map((s) => [s.variantId ?? "", Number(s.qty ?? 0)]));
  const dailyMap = Object.fromEntries(dailyRows.map((d) => [d.day, { quantity: Number(d.quantity ?? 0), orders: Number(d.orders ?? 0) }]));
  const daily: { day: string; quantity: number; orders: number }[] = [];
  for (let i = 29; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 86_400_000);
    const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    daily.push({ day: key, quantity: dailyMap[key]?.quantity ?? 0, orders: dailyMap[key]?.orders ?? 0 });
  }

  const variants = product.variants.map((v) => ({ ...v, sold30: soldMap[v.id] ?? 0, stockValue: Math.max(v.remainQuantity, 0) * v.lastImportedPrice }));
  const totals = {
    remain: variants.reduce((s, v) => s + v.remainQuantity, 0),
    actual: variants.reduce((s, v) => s + v.actualRemainQuantity, 0),
    stockValue: variants.reduce((s, v) => s + v.stockValue, 0),
    sold30: Number(sales?.sold30 ?? 0),
    sold90: Number(sales?.sold90 ?? 0),
    revenue90: Number(sales?.revenue90 ?? 0),
    orders90: Number(sales?.orders90 ?? 0),
    selling: variants.filter((v) => !v.isHidden && !v.isLocked && !v.isRemoved).length,
  };

  return { ...product, variants, totals, daily, histories, recentOrders, warehouses };
}

export type ProductDetail = NonNullable<Awaited<ReturnType<typeof getProductDetail>>>;

/** Tra cứu sản phẩm theo id mẫu mã (để chuyển hướng /products/<variantId> → /products/<productId>) */
export async function findProductIdByVariant(variantId: string) {
  const db = await getDb();
  const row = await db.query.productVariants.findFirst({ where: eq(pv.id, variantId), columns: { productId: true } });
  return row?.productId ?? null;
}
