import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { computePlan, DEFAULT_PLANNING, PLANNING_KEY, type PlanningAssumptions, type PlanOutput, type PlanStatus } from "@/lib/constants/planning";
import { LAST_RECEIPT_COST, erpStockExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { getSettingJson } from "@/lib/settings";

const pv = schema.productVariants;
const p = schema.products;
const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

export async function loadPlanningAssumptions(): Promise<PlanningAssumptions> {
  const cfg = await getSettingJson<PlanningAssumptions>(PLANNING_KEY, DEFAULT_PLANNING);
  return { ...DEFAULT_PLANNING, ...cfg, leadTimeOverrides: cfg.leadTimeOverrides ?? {} };
}

export type PlanRow = PlanOutput & {
  variantId: string;
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
  sold7: number;
  sold30: number;
  soldInWindow: number;
  leadTimeDays: number;
  unitCost: number;
  retailPrice: number;
  orderCost: number;
};

export type PlanReport = {
  assumptions: PlanningAssumptions;
  rows: PlanRow[];
  products: { productId: string; productName: string; productCode: string; image: string | null; rows: PlanRow[]; suggested: number; orderCost: number; worst: PlanStatus }[];
  summary: { variants: number; out: number; critical: number; low: number; suggestedUnits: number; orderCost: number; byStatus: Record<PlanStatus, number> };
};

const STATUS_RANK: Record<PlanStatus, number> = { OUT: 0, CRITICAL: 1, LOW: 2, OK: 3, IDLE: 4 };

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

export async function getReplenishmentPlan(): Promise<PlanReport> {
  const db = await getDb();
  const a = await loadPlanningAssumptions();
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const d7 = demandSubquery(db, 7, "d7");
  const d30 = demandSubquery(db, 30, "d30");
  const dw = demandSubquery(db, Math.max(1, a.velocityWindowDays), "dw");
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
      pancakeStock: pv.remainQuantity,
      committed: sql<number>`coalesce(${sales.pending}, 0)`,
      inTransit: sql<number>`coalesce(${sales.inTransit}, 0)`,
      sold7: sql<number>`coalesce(${d7.qty}, 0)`,
      sold30: sql<number>`coalesce(${d30.qty}, 0)`,
      soldInWindow: sql<number>`coalesce(${dw.qty}, 0)`,
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
    .where(sql`${pv.isRemoved} = false and ${p.isRemoved} = false`)
    .orderBy(asc(p.name), asc(pv.sku));

  const planRows: PlanRow[] = rows.map((r) => {
    const leadTimeDays = a.leadTimeOverrides[r.productId] ?? a.leadTimeDays;
    const plan = computePlan({ stock: Number(r.stock ?? 0), committed: Number(r.committed ?? 0), soldInWindow: Number(r.soldInWindow ?? 0), windowDays: Math.max(1, a.velocityWindowDays), leadTimeDays, coverDays: a.coverDays, safetyDays: a.safetyDays, roundTo: Math.max(1, a.roundTo) });
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
      pancakeStock: Number(r.pancakeStock ?? 0),
      committed: Number(r.committed ?? 0),
      inTransit: Number(r.inTransit ?? 0),
      sold7: Number(r.sold7 ?? 0),
      sold30: Number(r.sold30 ?? 0),
      soldInWindow: Number(r.soldInWindow ?? 0),
      leadTimeDays,
      unitCost,
      retailPrice: Number(r.retailPrice ?? 0),
      orderCost: plan.suggested * unitCost,
    };
  });
  // bỏ mẫu mã không bán, không tồn, không đặt
  const active = planRows.filter((r) => r.sold30 > 0 || r.stock !== 0 || r.committed > 0 || r.suggested > 0);
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
  const byStatus: Record<PlanStatus, number> = { OUT: 0, CRITICAL: 0, LOW: 0, OK: 0, IDLE: 0 };
  for (const r of active) byStatus[r.status] += 1;
  return {
    assumptions: a,
    rows: active,
    products,
    summary: { variants: active.length, out: byStatus.OUT, critical: byStatus.CRITICAL, low: byStatus.LOW, suggestedUnits: active.reduce((t, r) => t + r.suggested, 0), orderCost: active.reduce((t, r) => t + r.orderCost, 0), byStatus },
  };
}
