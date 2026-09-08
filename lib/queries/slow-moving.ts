import { and, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { computeVelocity } from "@/lib/constants/planning";
import { loadPlanningAssumptions } from "@/lib/queries/planning";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { LAST_RECEIPT_COST, availableStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { SLOW_MOVING_RULES, type StockRisk } from "@/lib/constants/slow-moving";

/**
 * ───────────── HÀNG BÁN CHẬM & VỐN NẰM CHẾT ─────────────
 *
 * Đối trọng của trang Kế hoạch sản xuất. Kế hoạch chỉ nhìn cái SẮP HẾT; nếu không có bảng này thì
 * shop chỉ thấy chỗ cần đổ thêm tiền vào, không bao giờ thấy chỗ tiền đang nằm chết.
 *
 * Đặc tả tồn kho: docs/inventory-forecast-contract.md. Tồn dùng đúng công thức của sổ kho, tốc độ
 * bán dùng đúng hàm chống nhiễu của kế hoạch — không có công thức riêng ở đây.
 *
 * GIÁ TRỊ VỐN tính theo GIÁ NHẬP, không theo giá bán: đây là số tiền đã bỏ ra và chưa thu lại,
 * không phải doanh thu có thể thu.
 */

const pv = schema.productVariants;
const p = schema.products;
const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

export type SlowMovingRow = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  color: string;
  size: string;
  available: number;
  /** Món/ngày, đã bỏ ngày đột biến. */
  velocity: number;
  /** `null` khi không bán được cái nào — CHƯA BIẾT, không phải vô cực. */
  daysOfCover: number | null;
  /** Lần cuối bán được (giao thành công); `null` = chưa bán được lần nào. */
  lastSoldAt: Date | null;
  daysSinceLastSale: number | null;
  unitCost: number;
  /** Tiền vốn đang nằm trong lô hàng này. */
  stockValue: number;
  /** Phần vốn VƯỢT mức cần thiết — tiền đáng lẽ không phải nằm đây. */
  excessValue: number;
  risk: StockRisk;
  reason: string;
};

export type SlowMovingReport = {
  rows: SlowMovingRow[];
  /** Tổng vốn đang nằm trong hàng tồn (theo giá nhập). */
  totalStockValue: number;
  /** Tổng phần vốn vượt mức cần thiết. */
  totalExcessValue: number;
  byRisk: Record<StockRisk, { count: number; value: number }>;
};

/**
 * Bán ròng trong cửa sổ, ngày bán mạnh nhất và lần cuối giao được hàng — mỗi thứ một truy vấn con
 * dùng ĐÚNG bí danh bảng mà `ORDER_OUTCOME` mong đợi.
 *
 * CỐ Ý không viết dưới dạng truy vấn con tương quan có bí danh riêng (o2/o3/o4): `ORDER_OUTCOME`
 * dựng trên bí danh `orders`/`shipments`, nên đặt bí danh khác sẽ khiến nó lặng lẽ trỏ sang bảng ở
 * câu ngoài và trả về kết quả sai mà không báo lỗi.
 */
function windowSalesSubquery(db: Awaited<ReturnType<typeof getDb>>, windowDays: number) {
  const daily = db
    .select({
      variantId: oi.variantId,
      day: sql<string>`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`.as("sale_day"),
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as("day_qty"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(sql`${o.insertedAt} >= now() - (${windowDays} || ' days')::interval and ${oi.isBonus} = false and ${ORDER_OUTCOME} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE')`)
    .groupBy(oi.variantId, sql`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`)
    .as("sm_daily");

  return db
    .select({
      variantId: daily.variantId,
      sold: sql<number>`coalesce(sum(${daily.qty}), 0)`.as("sm_sold"),
      peak: sql<number>`coalesce(max(${daily.qty}), 0)`.as("sm_peak"),
    })
    .from(daily)
    .groupBy(daily.variantId)
    .as("sm_window");
}

function lastSoldSubquery(db: Awaited<ReturnType<typeof getDb>>) {
  return db
    .select({ variantId: oi.variantId, lastSoldAt: sql<Date | null>`max(${o.insertedAt})`.as("sm_last_sold") })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    // Lần cuối THẬT SỰ giao được hàng — đơn hoàn nghĩa là chưa bán được.
    .where(sql`${ORDER_OUTCOME} = 'DELIVERED'`)
    .groupBy(oi.variantId)
    .as("sm_last");
}

async function slowMovingUncached(): Promise<SlowMovingReport> {
  const db = await getDb();
  const a = await loadPlanningAssumptions();
  const windowDays = Math.max(1, a.velocityWindowDays);
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const win = windowSalesSubquery(db, windowDays);
  const last = lastSoldSubquery(db);

  const rows = await db
    .select({
      variantId: pv.id,
      productId: pv.productId,
      productName: p.name,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      stockKnown: stockKnownExpr(receipts),
      available: availableStockExpr(sales, receipts),
      unitCost: sql<number>`coalesce(${LAST_RECEIPT_COST}, ${pv.lastImportedPrice}, 0)`,
      soldInWindow: sql<number>`coalesce(${win.sold}, 0)`,
      peakDayQty: sql<number>`coalesce(${win.peak}, 0)`,
      lastSoldAt: sql<Date | null>`${last.lastSoldAt}`,
    })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .leftJoin(win, eq(win.variantId, pv.id))
    .leftJoin(last, eq(last.variantId, pv.id))
    .where(and(eq(pv.isRemoved, false), eq(p.isRemoved, false)));

  const out: SlowMovingRow[] = [];
  const byRisk: Record<StockRisk, { count: number; value: number }> = {
    DEAD: { count: 0, value: 0 },
    EXCESS: { count: 0, value: 0 },
    SLOW: { count: 0, value: 0 },
    HEALTHY: { count: 0, value: 0 },
  };
  let totalStockValue = 0;
  let totalExcessValue = 0;

  for (const r of rows) {
    // Chưa có phiếu nhập ⇒ tồn là CHƯA BIẾT ⇒ không kết luận gì về vốn nằm chết.
    if (!r.stockKnown) continue;
    const available = Number(r.available ?? 0);
    if (available <= 0) continue;

    const v = computeVelocity(Number(r.soldInWindow ?? 0), windowDays, Number(r.peakDayQty ?? 0));
    const daysOfCover = v.velocity > 0 ? Math.round((available / v.velocity) * 10) / 10 : null;
    const unitCost = Number(r.unitCost ?? 0);
    const stockValue = available * unitCost;
    const lastSoldAt = r.lastSoldAt ? new Date(r.lastSoldAt) : null;
    const daysSinceLastSale = lastSoldAt ? Math.floor((Date.now() - lastSoldAt.getTime()) / 86_400_000) : null;

    let risk: StockRisk = "HEALTHY";
    let reason = "";
    if (v.velocity <= 0 && (daysSinceLastSale === null || daysSinceLastSale >= SLOW_MOVING_RULES.deadDays)) {
      risk = "DEAD";
      reason = daysSinceLastSale === null ? "Chưa bán được cái nào" : `Không bán được cái nào trong ${daysSinceLastSale} ngày`;
    } else if (daysOfCover !== null && daysOfCover > SLOW_MOVING_RULES.excessCoverDays) {
      risk = "EXCESS";
      reason = `Tồn đủ bán ${daysOfCover} ngày — vượt xa mức cần thiết`;
    } else if (daysOfCover !== null && daysOfCover > SLOW_MOVING_RULES.slowCoverDays) {
      risk = "SLOW";
      reason = `Tồn đủ bán ${daysOfCover} ngày — bán chậm hơn mức lành mạnh`;
    } else {
      reason = daysOfCover === null ? "Chưa đủ căn cứ" : `Tồn đủ bán ${daysOfCover} ngày`;
    }

    /**
     * PHẦN VỐN VƯỢT MỨC = tiền nằm trong số hàng nhiều hơn mức đủ bán trong kỳ lành mạnh.
     * Hàng chết thì TOÀN BỘ là vượt mức — không có nhịp bán nào để giữ lại phần nào cả.
     */
    const healthyQty = v.velocity > 0 ? Math.ceil(v.velocity * SLOW_MOVING_RULES.healthyCoverDays) : 0;
    const excessQty = Math.max(0, available - healthyQty);
    const excessValue = risk === "HEALTHY" ? 0 : excessQty * unitCost;

    totalStockValue += stockValue;
    totalExcessValue += excessValue;
    byRisk[risk].count += 1;
    byRisk[risk].value += stockValue;

    out.push({
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName ?? "",
      sku: r.sku ?? "",
      color: r.color ?? "",
      size: r.size ?? "",
      available,
      velocity: Math.round(v.velocity * 100) / 100,
      daysOfCover,
      lastSoldAt,
      daysSinceLastSale,
      unitCost,
      stockValue,
      excessValue,
      risk,
      reason,
    });
  }

  // Vốn nằm chết nhiều nhất lên trước — đó là thứ đáng xả trước.
  out.sort((x, y) => y.excessValue - x.excessValue || y.stockValue - x.stockValue);
  return { rows: out, totalStockValue, totalExcessValue, byRisk };
}

export async function getSlowMoving(): Promise<SlowMovingReport> {
  return memo("slowMoving", 120_000, slowMovingUncached);
}
