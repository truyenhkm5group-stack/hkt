import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { computePlan, DEFAULT_PLANNING, PLANNING_KEY, type PlanningAssumptions, type PlanOutput, type PlanStatus } from "@/lib/constants/planning";
import { LAST_RECEIPT_COST, erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { getSettingJson } from "@/lib/settings";

const pv = schema.productVariants;
const p = schema.products;
const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

export async function loadPlanningAssumptions(): Promise<PlanningAssumptions> {
  const cfg = await getSettingJson<PlanningAssumptions>(PLANNING_KEY, DEFAULT_PLANNING);
  return { ...DEFAULT_PLANNING, ...cfg, leadTimeOverrides: cfg.leadTimeOverrides ?? {}, minOrderQtyOverrides: cfg.minOrderQtyOverrides ?? {} };
}

export type PlanRow = PlanOutput & {
  variantId: string;
  /** false = chưa có phiếu nhập nào ⇒ tồn không tính được, không đề xuất đặt hàng */
  stockKnown: boolean;
  productId: string;
  productName: string;
  productCode: string;
  image: string | null;
  sku: string;
  color: string;
  size: string;
  stock: number;
  pancakeStock: number;
  committed: number;
  inTransit: number;
  awaitingReturn: number;
  sold7: number;
  sold30: number;
  soldInWindow: number;
  /** Số lượng bán của ngày mạnh nhất trong cửa sổ — căn cứ nhận ra đột biến. */
  peakDayQty: number;
  leadTimeDays: number;
  unitCost: number;
  retailPrice: number;
  orderCost: number;
};

export type PlanOptions = {
  /** Số ngày muốn đủ hàng bán sau khi lô mới về — người dùng chọn ngay trên trang. */
  coverDays?: number;
  /** Có trừ hàng đang ở ngoài / chờ hoàn về khỏi lượng cần đặt không. */
  countIncoming?: boolean;
};

export type PlanReport = {
  assumptions: PlanningAssumptions;
  /** Tham số thực sự đã dùng để tính bảng này. */
  used: { coverDays: number; countIncoming: boolean; returnRecoveryRate: number; shopReturnRate: number };
  rows: PlanRow[];
  products: { productId: string; productName: string; productCode: string; image: string | null; rows: PlanRow[]; suggested: number; orderCost: number; worst: PlanStatus }[];
  summary: { variants: number; out: number; critical: number; low: number; unknown: number; suggestedUnits: number; orderCost: number; incomingUnits: number; byStatus: Record<PlanStatus, number> };
};

/** Dưới ngần này đơn đã kết thúc thì tỷ lệ hoàn của riêng mẫu mã không đáng tin, dùng số toàn shop. */
const MIN_RETURN_RATE_SAMPLE = 20;

const STATUS_RANK: Record<PlanStatus, number> = { OUT: 0, UNKNOWN: 1, CRITICAL: 2, LOW: 3, OK: 4, IDLE: 5 };

/** Nhu cầu ròng (không huỷ, không hoàn) theo mẫu mã trong N ngày theo ngày lên đơn */
function demandSubquery(db: Awaited<ReturnType<typeof getDb>>, days: number, alias: string) {
  return db
    .select({
      variantId: oi.variantId,
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as(`qty_${alias}`),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(sql`${o.insertedAt} >= now() - (${days} || ' days')::interval and ${ORDER_OUTCOME} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE') and ${oi.isBonus} = false`)
    .groupBy(oi.variantId)
    .as(`demand_${alias}`);
}

/**
 * NGÀY BÁN MẠNH NHẤT của từng mẫu mã trong cửa sổ tính tốc độ.
 *
 * Dùng để nhận ra đột biến: một buổi livestream bán 60 cái trong 14 ngày đẩy tốc độ lên 4,3
 * cái/ngày, và kế hoạch sẽ đặt sản xuất theo nhịp đó cho cả tháng sau. Xem `computeVelocity`.
 *
 * Ngày tính theo GIỜ VIỆT NAM: một buổi live tối muộn không được tách làm hai ngày.
 */
function peakDaySubquery(db: Awaited<ReturnType<typeof getDb>>, days: number) {
  const daily = db
    .select({
      variantId: oi.variantId,
      day: sql<string>`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`.as("sale_day"),
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as("day_qty"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .where(sql`${o.insertedAt} >= now() - (${days} || ' days')::interval and ${ORDER_OUTCOME} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE') and ${oi.isBonus} = false`)
    .groupBy(oi.variantId, sql`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`)
    .as("daily_sales");

  return db
    .select({ variantId: daily.variantId, peak: sql<number>`coalesce(max(${daily.qty}), 0)`.as("peak_day_qty") })
    .from(daily)
    .groupBy(daily.variantId)
    .as("peak_day");
}

async function getReplenishmentPlanUncached(opt: PlanOptions): Promise<PlanReport> {
  const db = await getDb();
  const saved = await loadPlanningAssumptions();
  const coverDays = Number.isFinite(opt.coverDays) ? Math.min(365, Math.max(0, Math.round(opt.coverDays as number))) : saved.coverDays;
  const countIncoming = opt.countIncoming !== false;
  const a: PlanningAssumptions = { ...saved, coverDays };
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const d7 = demandSubquery(db, 7, "d7");
  const d30 = demandSubquery(db, 30, "d30");
  const dw = demandSubquery(db, Math.max(1, a.velocityWindowDays), "dw");
  const peak = peakDaySubquery(db, Math.max(1, a.velocityWindowDays));
  const rows = await db
    .select({
      variantId: pv.id,
      productId: pv.productId,
      productName: p.name,
      productCode: sql<string>`coalesce(${p.customId}, '')`,
      image: sql<string | null>`coalesce(${pv.images}[1], ${p.image})`,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      stock: erpStockExpr(sales, receipts),
      stockKnown: stockKnownExpr(receipts),
      pancakeStock: pv.remainQuantity,
      committed: sql<number>`coalesce(${sales.reserved}, 0)`,
      inTransit: sql<number>`coalesce(${sales.inTransit}, 0)`,
      awaitingReturn: sql<number>`coalesce(${sales.awaitingReturn}, 0)`,
      returnHandled: sql<number>`coalesce(${sales.returnHandled}, 0)`,
      returnRestocked: sql<number>`coalesce(${receipts.returnIn}, 0)`,
      delivered: sql<number>`coalesce(${sales.delivered}, 0)`,
      returned: sql<number>`coalesce(${sales.returned}, 0)`,
      sold7: sql<number>`coalesce(${d7.qty}, 0)`,
      sold30: sql<number>`coalesce(${d30.qty}, 0)`,
      soldInWindow: sql<number>`coalesce(${dw.qty}, 0)`,
      peakDayQty: sql<number>`coalesce(${peak.peak}, 0)`,
      unitCost: sql<number>`coalesce(${LAST_RECEIPT_COST}, ${pv.lastImportedPrice}, 0)`,
      retailPrice: pv.retailPrice,
    })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .leftJoin(d7, eq(d7.variantId, pv.id))
    .leftJoin(d30, eq(d30.variantId, pv.id))
    .leftJoin(dw, eq(dw.variantId, pv.id))
    .leftJoin(peak, eq(peak.variantId, pv.id))
    .where(sql`${pv.isRemoved} = false and ${p.isRemoved} = false`)
    .orderBy(asc(p.name), asc(pv.sku));

  // Tỷ lệ nhập lại được kho: hàng hoàn đã lập phiếu tái nhập ÷ hàng hoàn đã xử lý, tính trên toàn
  // shop (mẫu từng mẫu mã quá nhỏ). Chưa có dữ liệu thì coi như về đủ — đó là mặc định vật lý.
  const tongHoanDaXuLy = rows.reduce((t, r) => t + Number(r.returnHandled ?? 0), 0);
  const tongHoanDaNhapLai = rows.reduce((t, r) => t + Number(r.returnRestocked ?? 0), 0);
  const returnRecoveryRate = tongHoanDaXuLy > 0 ? Math.min(1, tongHoanDaNhapLai / tongHoanDaXuLy) : 1;
  // Tỷ lệ hoàn để ước phần hàng đang ở ngoài sẽ quay về: dùng số của chính mẫu mã khi đủ mẫu,
  // không đủ thì dùng số toàn shop.
  const tongGiao = rows.reduce((t, r) => t + Number(r.delivered ?? 0), 0);
  const tongHoan = rows.reduce((t, r) => t + Number(r.returned ?? 0), 0);
  const shopReturnRate = tongGiao + tongHoan > 0 ? tongHoan / (tongGiao + tongHoan) : 0;

  const planRows: PlanRow[] = rows.map((r) => {
    const leadTimeDays = a.leadTimeOverrides[r.productId] ?? a.leadTimeDays;
    const ketThuc = Number(r.delivered ?? 0) + Number(r.returned ?? 0);
    const returnRate = ketThuc >= MIN_RETURN_RATE_SAMPLE ? Number(r.returned ?? 0) / ketThuc : shopReturnRate;
    const plan = computePlan({ stock: Number(r.stock ?? 0), stockKnown: Boolean(r.stockKnown), committed: Number(r.committed ?? 0), soldInWindow: Number(r.soldInWindow ?? 0), windowDays: Math.max(1, a.velocityWindowDays), leadTimeDays, coverDays: a.coverDays, safetyDays: a.safetyDays, roundTo: Math.max(1, a.roundTo), peakDayQty: Number(r.peakDayQty ?? 0), minOrderQty: a.minOrderQtyOverrides?.[r.productId] ?? a.minOrderQty, inTransit: Number(r.inTransit ?? 0), awaitingReturn: Number(r.awaitingReturn ?? 0), returnRate, returnRecoveryRate, countIncoming });
    const unitCost = Number(r.unitCost ?? 0);
    return {
      ...plan,
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName,
      productCode: r.productCode ?? "",
      image: r.image,
      sku: r.sku,
      color: r.color,
      size: r.size,
      stock: Number(r.stock ?? 0),
      stockKnown: Boolean(r.stockKnown),
      pancakeStock: Number(r.pancakeStock ?? 0),
      committed: Number(r.committed ?? 0),
      inTransit: Number(r.inTransit ?? 0),
      awaitingReturn: Number(r.awaitingReturn ?? 0),
      sold7: Number(r.sold7 ?? 0),
      sold30: Number(r.sold30 ?? 0),
      soldInWindow: Number(r.soldInWindow ?? 0),
      peakDayQty: Number(r.peakDayQty ?? 0),
      leadTimeDays,
      unitCost,
      retailPrice: Number(r.retailPrice ?? 0),
      orderCost: plan.suggested * unitCost,
    };
  });
  // bỏ mẫu mã không bán, không tồn, không đặt
  const active = planRows.filter((r) => r.sold30 > 0 || r.stock !== 0 || r.committed > 0 || r.suggested > 0 || r.status === "UNKNOWN");
  const byProduct = new Map<string, PlanReport["products"][number]>();
  for (const r of active) {
    const g = byProduct.get(r.productId) ?? { productId: r.productId, productName: r.productName, productCode: r.productCode, image: r.image, rows: [], suggested: 0, orderCost: 0, worst: "IDLE" as PlanStatus };
    g.rows.push(r);
    g.suggested += r.suggested;
    g.orderCost += r.orderCost;
    if (STATUS_RANK[r.status] < STATUS_RANK[g.worst]) g.worst = r.status;
    byProduct.set(r.productId, g);
  }
  const products = [...byProduct.values()].sort((x, y) => STATUS_RANK[x.worst] - STATUS_RANK[y.worst] || y.suggested - x.suggested);
  for (const g of products) g.rows.sort((x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status] || y.suggested - x.suggested);
  const byStatus: Record<PlanStatus, number> = { OUT: 0, UNKNOWN: 0, CRITICAL: 0, LOW: 0, OK: 0, IDLE: 0 };
  for (const r of active) byStatus[r.status] += 1;
  return {
    assumptions: a,
    used: { coverDays: a.coverDays, countIncoming, returnRecoveryRate, shopReturnRate },
    rows: active,
    products,
    summary: { variants: active.length, out: byStatus.OUT, critical: byStatus.CRITICAL, low: byStatus.LOW, unknown: byStatus.UNKNOWN, suggestedUnits: active.reduce((t, r) => t + r.suggested, 0), orderCost: active.reduce((t, r) => t + r.orderCost, 0), incomingUnits: active.reduce((t, r) => t + r.incoming, 0), byStatus },
  };
}

export async function getReplenishmentPlan(opt: PlanOptions = {}) {
  const khoa = `${opt.coverDays ?? "mac-dinh"}:${opt.countIncoming === false ? "khong-tinh-hoan" : "tinh-hoan"}`;
  return memo(`getReplenishmentPlan:${khoa}`, 120000, () => getReplenishmentPlanUncached(opt));
}
