import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo, periodKey } from "@/lib/cache";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { IS_RETURNED, successRate } from "@/lib/queries/metrics";
import { ORDER_SOURCE, type OrderSourceKey } from "@/lib/queries/order-source";
import { ORDER_OUTCOME, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { availableStockExpr, variantReceiptsSubquery, variantSalesSubquery, stockKnownExpr } from "@/lib/queries/stock";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── HIỆU QUẢ THEO MẪU MÃ ─────────────
 *
 * "Bán chạy" theo SỐ LƯỢNG LÊN ĐƠN là con số đánh lừa: một mẫu mã bán 100 cái mà hoàn 60 thì kém
 * hơn hẳn mẫu mã bán 50 cái hoàn 5. Bảng này ghép ba chiều lại để nhìn được cái nào thật sự đáng
 * sản xuất tiếp:
 *
 *  · BÁN     — số lượng lên đơn, số lượng thật sự tới tay khách, doanh thu giao thành công;
 *  · CHẤT    — tỷ lệ giao thành công, tỷ lệ hoàn, phần doanh thu mất vì hoàn;
 *  · CÒN     — khả dụng bán và số ngày còn đủ hàng (days of cover).
 *
 * Kết quả đơn luôn đi qua `ORDER_OUTCOME` — không có công thức riêng ở đây.
 * `contribution` (lợi nhuận góp thô) chỉ tính khi TRA ĐƯỢC GIÁ VỐN; không tra được thì trả `null`
 * và ghi rõ, KHÔNG lấy 0 rồi hiển thị như đã biết.
 */

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;
const pv = schema.productVariants;

export type ProductIntelRow = {
  variantId: string | null;
  sku: string;
  productId: string | null;
  productName: string;
  color: string;
  size: string;
  image: string | null;
  /** Số lượng lên đơn (không tính đơn huỷ, không tính hàng tặng). */
  orderedQty: number;
  /** Số lượng THẬT SỰ tới tay khách. */
  deliveredQty: number;
  /** Số lượng của đơn hoàn. */
  returnedQty: number;
  deliveredRevenue: number;
  /** Doanh thu mất vì đơn hoàn — hàng đã đi rồi về. */
  lostRevenue: number;
  /** GTC (%) trên đơn đã kết thúc; null khi chưa có đơn nào kết thúc. */
  successRate: number | null;
  returnRate: number | null;
  /** Lợi nhuận góp thô = doanh thu giao TC − giá vốn phần đã giao. `null` = chưa tra được giá vốn. */
  contribution: number | null;
  /** Vì sao chưa tính được lợi nhuận góp. */
  contributionBlockedBy: string | null;
  /** Khả dụng bán; `null` khi mẫu mã chưa có phiếu nhập nào (CHƯA BIẾT, không phải 0). */
  available: number | null;
  /** Số ngày còn đủ hàng theo tốc độ bán trong kỳ; `null` khi không bán được cái nào hoặc chưa biết tồn. */
  daysOfCover: number | null;
};

export type ProductIntelQuery = {
  period: Period;
  q?: string;
  /** Lọc theo kênh bán (nguồn đơn). */
  channel?: OrderSourceKey;
  productId?: string;
  color?: string;
  size?: string;
  limit?: number;
};

/** Đơn vào bảng: đã chốt trên Pancake, bỏ hàng tặng (0đ nhưng vẫn rời kho — đếm ở sổ kho, không ở đây). */
function scope(query: ProductIntelQuery): SQL {
  const conds: SQL[] = [REPORTABLE_ORDER as SQL, eq(i.isBonus, false)];
  if (query.period.from) conds.push(gte(o.insertedAt, query.period.from));
  if (query.period.to) conds.push(lte(o.insertedAt, query.period.to));
  if (query.channel) conds.push(sql`${ORDER_SOURCE} = ${query.channel}`);
  if (query.productId) conds.push(sql`${i.productId} = ${query.productId}`);
  if (query.color) conds.push(sql`${pv.color} = ${query.color}`);
  if (query.size) conds.push(sql`${pv.size} = ${query.size}`);
  const term = query.q?.trim();
  if (term) {
    const like = `%${term}%`;
    conds.push(sql`(${i.sku} ilike ${like} or ${i.productName} ilike ${like} or ${i.variationDetail} ilike ${like})`);
  }
  return and(...conds) as SQL;
}

async function intelligenceUncached(query: ProductIntelQuery): Promise<ProductIntelRow[]> {
  const db = await getDb();
  const limit = query.limit ?? 50;
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const windowDays = query.period.from && query.period.to ? Math.max(1, Math.round((query.period.to.getTime() - query.period.from.getTime()) / 86_400_000)) : 30;

  const rows = await db
    .select({
      variantId: i.variantId,
      sku: sql<string>`max(${i.sku})`,
      productId: sql<string | null>`max(${i.productId})`,
      productName: sql<string>`max(${i.productName})`,
      color: sql<string>`coalesce(max(${pv.color}), '')`,
      size: sql<string>`coalesce(max(${pv.size}), '')`,
      image: sql<string | null>`max(${i.image})`,
      orderedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      deliveredQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      returnedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${IS_RETURNED}), 0)`,
      deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returnedOrders: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      lostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${IS_RETURNED}), 0)`,
      deliveredCost: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      /** Dòng đã giao mà không tra được giá vốn — nếu có thì lợi nhuận góp là CHƯA BIẾT. */
      missingCostLines: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and ${LINE_UNIT_COST} = 0)`,
      // Join theo mẫu mã là 1:1 nên `max()` chỉ để thoả GROUP BY, không đổi giá trị.
      available: sql<number | null>`max(case when ${stockKnownExpr(receipts)} then ${availableStockExpr(sales, receipts)} else null end)`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .leftJoin(sales, eq(sales.variantId, i.variantId))
    .leftJoin(receipts, eq(receipts.variantId, i.variantId))
    .where(scope(query))
    .groupBy(i.variantId)
    .orderBy(desc(sql`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`))
    .limit(limit);

  return rows.map((r) => {
    const delivered = Number(r.deliveredOrders ?? 0);
    const returned = Number(r.returnedOrders ?? 0);
    const rate = successRate(delivered, returned);
    const missing = Number(r.missingCostLines ?? 0);
    const deliveredQty = Number(r.deliveredQty ?? 0);
    const available = r.available === null || r.available === undefined ? null : Number(r.available);
    // Tốc độ bán tính theo SỐ THẬT SỰ GIAO ĐƯỢC, không theo số lên đơn — hàng hoàn không phải nhu cầu.
    const velocity = deliveredQty / windowDays;
    return {
      variantId: r.variantId,
      sku: r.sku ?? "",
      productId: r.productId ?? null,
      productName: r.productName ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      image: r.image ?? null,
      orderedQty: Number(r.orderedQty ?? 0),
      deliveredQty,
      returnedQty: Number(r.returnedQty ?? 0),
      deliveredRevenue: Number(r.deliveredRevenue ?? 0),
      lostRevenue: Number(r.lostRevenue ?? 0),
      successRate: rate,
      returnRate: rate === null ? null : Math.round((100 - rate) * 10) / 10,
      contribution: missing > 0 ? null : Number(r.deliveredRevenue ?? 0) - Number(r.deliveredCost ?? 0),
      contributionBlockedBy: missing > 0 ? `${missing} dòng đã giao không tra được giá nhập — nhập phiếu kho có đơn giá cho mẫu mã này` : null,
      available,
      daysOfCover: available === null || velocity <= 0 ? null : Math.round((available / velocity) * 10) / 10,
    };
  });
}

export async function getProductIntelligence(query: ProductIntelQuery): Promise<ProductIntelRow[]> {
  const key = `productIntel:${periodKey(query.period)}:${query.q ?? ""}:${query.channel ?? ""}:${query.productId ?? ""}:${query.color ?? ""}:${query.size ?? ""}:${query.limit ?? 50}`;
  return memo(key, 90_000, () => intelligenceUncached(query));
}

export type ProductMatrix = {
  colors: string[];
  sizes: string[];
  /** `cells[color][size]` — thiếu ô nghĩa là mẫu mã đó không bán được cái nào trong kỳ. */
  cells: Record<string, Record<string, ProductIntelRow>>;
};

/**
 * Ma trận Màu × Size của MỘT mã hàng. Chỉ dựng khi mã hàng thật sự có nhiều màu/size —
 * mã một biến thể thì bảng ma trận chỉ làm rối.
 */
export async function getProductMatrix(productId: string, period: Period): Promise<ProductMatrix | null> {
  const rows = await getProductIntelligence({ period, productId, limit: 500 });
  const colors = [...new Set(rows.map((r) => r.color).filter(Boolean))].sort();
  const sizes = [...new Set(rows.map((r) => r.size).filter(Boolean))].sort();
  if (colors.length < 2 && sizes.length < 2) return null;
  const cells: Record<string, Record<string, ProductIntelRow>> = {};
  for (const row of rows) {
    if (!row.color && !row.size) continue;
    const c = row.color || "—";
    cells[c] ??= {};
    cells[c][row.size || "—"] = row;
  }
  return { colors: colors.length ? colors : ["—"], sizes: sizes.length ? sizes : ["—"], cells };
}
