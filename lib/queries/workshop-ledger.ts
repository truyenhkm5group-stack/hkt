import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  batchActualCost,
  deliveryStatus,
  laborCost,
  paymentStatus,
  productActualCost,
  type ActualCost,
  type DeliveryState,
  type LaborCost,
  type PaymentStatus,
} from "@/lib/constants/workshop-ledger";

/**
 * ═══════════ SỔ ĐẶT XƯỞNG — ĐƯỜNG ĐỌC ═══════════
 *
 * Đọc bốn bảng của sổ rồi ráp lại qua ĐÚNG các hàm luật ở `lib/constants/workshop-ledger.ts` — trang
 * lô, trang vải, trang thanh toán và bảng giá SX thực tế cùng nhìn một kết quả, không trang nào tự
 * cộng lại.
 *
 * Phiếu kho chỉ được ĐỌC ở một chỗ: giá nhập trên phiếu gần nhất của mã, để đặt CẠNH giá SX thực tế.
 * Sổ này không ghi gì vào phiếu kho và không đi vào báo cáo lợi nhuận.
 *
 * Khối lượng: vài chục lô và đợt vải mỗi tháng ⇒ đọc hết rồi gom trong bộ nhớ, không cần phân trang.
 */

export type BatchRecord = typeof schema.productionBatches.$inferSelect;
export type DeliveryRecord = typeof schema.productionDeliveries.$inferSelect;
export type FabricRecord = typeof schema.fabricOrders.$inferSelect;
export type PaymentRecord = typeof schema.supplierPayments.$inferSelect;

export type BatchView = BatchRecord & {
  deliveries: DeliveryRecord[];
  payments: PaymentRecord[];
  fabrics: FabricRecord[];
  delivered: number;
  labor: LaborCost;
  pay: PaymentStatus;
  delivery: { state: DeliveryState; delivered: number; target: number; overdueDays: number | null };
  fabricAmount: number;
  cost: ActualCost;
};

export type FabricView = FabricRecord & {
  payments: PaymentRecord[];
  pay: PaymentStatus;
  batchLabel: string | null;
};

export type PaymentView = PaymentRecord & {
  /** "Q002 · lô 2" hoặc "Vải Q002 · vải chính" — để trang thanh toán đọc được mà không phải bấm vào. */
  targetLabel: string;
  targetKind: "BATCH" | "FABRIC";
  supplierName: string;
  batchIdForLink: string | null;
};

export type ProductCostView = {
  productCode: string;
  productName: string;
  productId: string | null;
  batches: number;
  fabricOrderCount: number;
  unassignedFabric: number;
  cost: ActualCost;
  /** Giá nhập bình quân trên PHIẾU KHO gần nhất của mã — thứ báo cáo lợi nhuận đang dùng làm giá vốn. */
  receiptUnitCost: number | null;
  receiptAt: Date | null;
};

function groupBy<T, K>(rows: readonly T[], key: (r: T) => K | null | undefined): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k == null) continue;
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return m;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

export function batchLabel(b: Pick<BatchRecord, "productCode" | "batchNo">) {
  return `${b.productCode} · lô ${b.batchNo}`;
}

function buildBatch(b: BatchRecord, deliveries: DeliveryRecord[], payments: PaymentRecord[], fabrics: FabricRecord[], now: Date): BatchView {
  const delivered = deliveries.reduce((s, d) => s + d.quantity, 0);
  const labor = laborCost({ agreedQty: b.agreedQty, laborUnitPrice: b.laborUnitPrice, adjustment: b.adjustment }, delivered);
  const fabricAmount = fabrics.reduce((s, f) => s + f.amount, 0);
  return {
    ...b,
    deliveries,
    payments,
    fabrics,
    delivered,
    labor,
    pay: paymentStatus(labor.amount, payments),
    delivery: deliveryStatus(b, delivered, now),
    fabricAmount,
    cost: batchActualCost({ fabricSource: b.fabricSource, fabricAmount, fabricOrderCount: fabrics.length, labor, delivered, status: b.status }),
  };
}

/** Giá nhập bình quân trên phiếu nhập (RECEIPT) gần nhất của từng mã — chỉ đọc. */
async function latestReceiptCost(productIds: string[]): Promise<Map<string, { unitCost: number; at: Date }>> {
  const out = new Map<string, { unitCost: number; at: Date }>();
  if (!productIds.length) return out;
  const db = await getDb();
  const res = await db.execute(sql`
    select distinct on (pv.product_id) pv.product_id as pid, sr.received_at as at,
      round(sum(ri.quantity::numeric * ri.unit_cost) / nullif(sum(ri.quantity), 0))::int as unit_cost
    from stock_receipt_items ri
    join stock_receipts sr on sr.id = ri.receipt_id
    join product_variants pv on pv.id = ri.variant_id
    where sr.kind = 'RECEIPT' and ri.quantity > 0 and ri.unit_cost > 0
      and pv.product_id in (${sql.join(productIds.map((id) => sql`${id}`), sql`, `)})
    group by pv.product_id, sr.id, sr.received_at
    order by pv.product_id, sr.received_at desc`);
  for (const r of rowsOf(res)) {
    const unitCost = Number(r.unit_cost);
    if (!Number.isFinite(unitCost) || unitCost <= 0) continue;
    out.set(String(r.pid), { unitCost, at: new Date(String(r.at)) });
  }
  return out;
}

export async function getWorkshopLedger(now = new Date()) {
  const db = await getDb();
  const [batches, deliveries, fabrics, payments] = await Promise.all([
    db.select().from(schema.productionBatches).orderBy(desc(schema.productionBatches.orderedAt), asc(schema.productionBatches.productCode), asc(schema.productionBatches.batchNo)),
    db.select().from(schema.productionDeliveries).orderBy(asc(schema.productionDeliveries.deliveredAt), asc(schema.productionDeliveries.createdAt)),
    db.select().from(schema.fabricOrders).orderBy(desc(schema.fabricOrders.orderedAt), desc(schema.fabricOrders.createdAt)),
    db.select().from(schema.supplierPayments).orderBy(desc(schema.supplierPayments.paidAt), desc(schema.supplierPayments.createdAt)),
  ]);
  const delByBatch = groupBy(deliveries, (d) => d.batchId);
  const payByBatch = groupBy(payments, (p) => p.batchId);
  const payByFabric = groupBy(payments, (p) => p.fabricOrderId);
  const fabByBatch = groupBy(fabrics, (f) => f.batchId);

  const batchViews = batches.map((b) => buildBatch(b, delByBatch.get(b.id) ?? [], payByBatch.get(b.id) ?? [], fabByBatch.get(b.id) ?? [], now));
  const batchById = new Map(batchViews.map((b) => [b.id, b] as const));

  const fabricViews: FabricView[] = fabrics.map((f) => {
    const ps = payByFabric.get(f.id) ?? [];
    const b = f.batchId ? batchById.get(f.batchId) : undefined;
    return { ...f, payments: ps, pay: paymentStatus(f.amount, ps), batchLabel: b ? batchLabel(b) : null };
  });
  const fabricById = new Map(fabricViews.map((f) => [f.id, f] as const));

  const paymentViews: PaymentView[] = payments.map((p) => {
    if (p.batchId) {
      const b = batchById.get(p.batchId);
      return { ...p, targetKind: "BATCH", targetLabel: b ? `${batchLabel(b)} · tiền công` : "Lô đã xoá", supplierName: b?.supplier ?? "", batchIdForLink: p.batchId };
    }
    const f = p.fabricOrderId ? fabricById.get(p.fabricOrderId) : undefined;
    return {
      ...p,
      targetKind: "FABRIC",
      targetLabel: f ? `Vải ${f.productCode}${f.description ? ` · ${f.description}` : ""}${f.batchLabel ? ` (${f.batchLabel})` : ""}` : "Đợt vải đã xoá",
      supplierName: f?.supplier ?? "",
      batchIdForLink: f?.batchId ?? null,
    };
  });

  // ── Giá SX thực tế cấp MÃ ──
  const codes = [...new Set([...batchViews.map((b) => b.productCode), ...fabricViews.map((f) => f.productCode)].filter(Boolean))];
  const batchByCode = groupBy(batchViews, (b) => b.productCode);
  const fabricByCode = groupBy(fabricViews, (f) => f.productCode);
  const productIds = [...new Set([...batchViews.map((b) => b.productId), ...fabricViews.map((f) => f.productId)].filter((x): x is string => !!x))];
  const receipt = await latestReceiptCost(productIds);
  const productViews: ProductCostView[] = codes
    .map((code) => {
      const bs = batchByCode.get(code) ?? [];
      const fs = fabricByCode.get(code) ?? [];
      const productId = bs.find((b) => b.productId)?.productId ?? fs.find((f) => f.productId)?.productId ?? null;
      const r = productId ? receipt.get(productId) : undefined;
      return {
        productCode: code,
        productName: bs.find((b) => b.productName)?.productName ?? "",
        productId,
        batches: bs.filter((b) => b.status !== "CANCELLED").length,
        fabricOrderCount: fs.length,
        unassignedFabric: fs.filter((f) => !f.batchId).reduce((s, f) => s + f.amount, 0),
        cost: productActualCost({ batches: bs, fabricAmount: fs.reduce((s, f) => s + f.amount, 0), fabricOrderCount: fs.length }),
        receiptUnitCost: r?.unitCost ?? null,
        receiptAt: r?.at ?? null,
      };
    })
    .sort((a, b) => a.productCode.localeCompare(b.productCode, "vi"));

  // ── Tổng hợp đầu trang: chỉ cộng số ĐÃ BIẾT, và đếm riêng số khoản chưa biết ──
  const live = batchViews.filter((b) => b.status !== "CANCELLED");
  const owedBatches = live.reduce((s, b) => s + Math.max(0, b.pay.remaining ?? 0), 0);
  const owedFabric = fabricViews.reduce((s, f) => s + Math.max(0, f.pay.remaining ?? 0), 0);
  const summary = {
    openBatches: live.filter((b) => b.status === "OPEN").length,
    overdueBatches: live.filter((b) => b.delivery.overdueDays != null).length,
    orderedQty: live.reduce((s, b) => s + b.orderedQty, 0),
    deliveredQty: live.reduce((s, b) => s + b.delivered, 0),
    owedWorkshop: owedBatches,
    owedFabric,
    unpricedBatches: live.filter((b) => b.pay.state === "NO_PRICE").length,
    paidTotal: payments.reduce((s, p) => s + (p.kind === "REFUND" ? -p.amount : p.amount), 0),
    fabricTotal: fabrics.reduce((s, f) => s + f.amount, 0),
    fabricPending: fabrics.filter((f) => !f.receivedAt).length,
  };

  return { batches: batchViews, fabrics: fabricViews, payments: paymentViews, products: productViews, summary };
}

export async function getProductionBatchDetail(id: string, now = new Date()) {
  const db = await getDb();
  const b = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.id, id) });
  if (!b) return null;
  const [deliveries, fabrics, directPayments] = await Promise.all([
    db.select().from(schema.productionDeliveries).where(eq(schema.productionDeliveries.batchId, id)).orderBy(asc(schema.productionDeliveries.deliveredAt), asc(schema.productionDeliveries.createdAt)),
    db.select().from(schema.fabricOrders).where(eq(schema.fabricOrders.batchId, id)).orderBy(asc(schema.fabricOrders.orderedAt)),
    db.select().from(schema.supplierPayments).where(eq(schema.supplierPayments.batchId, id)).orderBy(asc(schema.supplierPayments.paidAt), asc(schema.supplierPayments.createdAt)),
  ]);
  const fabricPayments = fabrics.length
    ? await db.select().from(schema.supplierPayments).where(inArray(schema.supplierPayments.fabricOrderId, fabrics.map((f) => f.id))).orderBy(asc(schema.supplierPayments.paidAt))
    : [];
  const payByFabric = groupBy(fabricPayments, (p) => p.fabricOrderId);
  const view = buildBatch(b, deliveries, directPayments, fabrics, now);
  const fabricViews: FabricView[] = fabrics.map((f) => {
    const ps = payByFabric.get(f.id) ?? [];
    return { ...f, payments: ps, pay: paymentStatus(f.amount, ps), batchLabel: batchLabel(b) };
  });
  const productionOrder = b.productionOrderId
    ? await db.query.productionOrders.findFirst({ where: eq(schema.productionOrders.id, b.productionOrderId), columns: { id: true, code: true, totalQty: true, status: true } })
    : null;
  return { batch: view, fabrics: fabricViews, productionOrder: productionOrder ?? null };
}

/** Gợi ý cho ô nhập: mã hàng đang bán, lô đang mở, bảng đặt màu × size chưa gắn lô nào. */
export async function workshopFormOptions() {
  const db = await getDb();
  const [products, batches, orders] = await Promise.all([
    db
      .select({ code: schema.products.customId, name: schema.products.name })
      .from(schema.products)
      .where(sql`coalesce(${schema.products.customId}, '') <> '' and ${schema.products.isRemoved} = false`)
      .orderBy(asc(schema.products.customId))
      .limit(2000),
    db
      .select({ id: schema.productionBatches.id, productCode: schema.productionBatches.productCode, batchNo: schema.productionBatches.batchNo, status: schema.productionBatches.status })
      .from(schema.productionBatches)
      .orderBy(asc(schema.productionBatches.productCode), desc(schema.productionBatches.batchNo)),
    db
      .select({ id: schema.productionOrders.id, code: schema.productionOrders.code, productCode: schema.productionOrders.productCode, totalQty: schema.productionOrders.totalQty })
      .from(schema.productionOrders)
      .where(sql`${schema.productionOrders.status} <> 'CANCELLED'`)
      .orderBy(desc(schema.productionOrders.createdAt))
      .limit(200),
  ]);
  return {
    products: products.map((p) => ({ code: (p.code ?? "").trim(), name: p.name })),
    batches: batches.map((b) => ({ id: b.id, label: batchLabel(b), productCode: b.productCode, batchNo: b.batchNo, status: b.status })),
    productionOrders: orders.map((o) => ({ id: o.id, label: `${o.code} · ${o.productCode || "?"} · ${o.totalQty} chiếc`, productCode: o.productCode })),
  };
}
export type WorkshopFormOptions = Awaited<ReturnType<typeof workshopFormOptions>>;
