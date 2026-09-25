import { asc, desc, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { marketerPriceAt, marketerPriceCutoff } from "@/lib/constants/marketer-price";
import { listMarketerPrices } from "@/lib/queries/marketer-price";
import type { Period } from "@/lib/search-params";
import { DEFAULT_PAYROLL_CONFIG, PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY, type Employee, type PayrollConfig } from "@/lib/constants/payroll";
import { sizeRank } from "@/lib/constants/production";
import { getSettingJson } from "@/lib/settings";
import {
  batchActualCost,
  openBatchQtyByVariant,
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

/** Một dòng của bảng chia màu/size: đặt · đã trả · còn lại. */
export type VariantLine = { variantId: string; color: string; size: string; ordered: number; delivered: number; remaining: number };

export type BatchView = BatchRecord & {
  /** Marketer phụ trách mã — ĐỌC từ cấu hình Lương ("Marketer phụ trách mã"), không khai lại ở đây. */
  marketerName: string | null;
  /** Bảng chia màu/size (rỗng khi lô chỉ ghi tổng). */
  variantLines: VariantLine[];
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
  marketerName: string | null;
  /** Giá báo MKT ĐANG HIỆU LỰC của mã (bảng giá báo theo mã). `null` = chưa báo. */
  marketerPrice: number | null;
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

type VariantInfo = { color: string; size: string };

/**
 * "Marketer phụ trách mã" theo cấu hình Lương. Đọc đúng hai khoá mà trang Lương ghi
 * (`payroll.config.productOwners` + `payroll.employees`) — chỉ để HIỂN THỊ tên, không quy kết gì.
 */
async function productMarketerNames(): Promise<Map<string, string>> {
  const [cfg, employees] = await Promise.all([
    getSettingJson<Partial<PayrollConfig>>(PAYROLL_CONFIG_KEY, DEFAULT_PAYROLL_CONFIG),
    // Sổ nhân sự lưu dạng `{ list: [...] }` (xem `listEmployees`) — KHÔNG phải mảng trần. Bản đầu đọc
    // nhầm hình nên mọi mã hiện "chưa gán" dù cấu hình Lương đã khai; bài kiểm CSDL khoá điều này.
    getSettingJson<{ list?: Employee[] }>(PAYROLL_EMPLOYEES_KEY, { list: [] }),
  ]);
  const nameOf = new Map((Array.isArray(employees?.list) ? employees.list : []).map((e) => [e.id, e.shortName || e.name] as const));
  const out = new Map<string, string>();
  for (const [productId, employeeId] of Object.entries(cfg.productOwners ?? {})) {
    const n = nameOf.get(employeeId);
    if (n) out.set(productId, n);
  }
  return out;
}

async function variantInfo(ids: string[]): Promise<Map<string, VariantInfo>> {
  if (!ids.length) return new Map();
  const db = await getDb();
  const rows = await db
    .select({ id: schema.productVariants.id, color: schema.productVariants.color, size: schema.productVariants.size })
    .from(schema.productVariants)
    .where(inArray(schema.productVariants.id, ids));
  return new Map(rows.map((r) => [r.id, { color: r.color ?? "", size: r.size ?? "" }] as const));
}

function variantLinesOf(b: BatchRecord, deliveries: DeliveryRecord[], info: Map<string, VariantInfo>): VariantLine[] {
  const got = new Map<string, number>();
  for (const d of deliveries) for (const [v, n] of Object.entries(d.cells ?? {})) got.set(v, (got.get(v) ?? 0) + n);
  return Object.entries(b.cells ?? {})
    .map(([variantId, ordered]) => {
      const delivered = got.get(variantId) ?? 0;
      const vi = info.get(variantId);
      return { variantId, color: vi?.color ?? "?", size: vi?.size ?? "", ordered, delivered, remaining: Math.max(0, ordered - delivered) };
    })
    .sort((x, y) => x.color.localeCompare(y.color, "vi") || sizeRank(x.size) - sizeRank(y.size));
}

function buildBatch(b: BatchRecord, deliveries: DeliveryRecord[], payments: PaymentRecord[], fabrics: FabricRecord[], now: Date, extra: { marketerName: string | null; info: Map<string, VariantInfo> }): BatchView {
  const delivered = deliveries.reduce((s, d) => s + d.quantity, 0);
  const labor = laborCost({ agreedQty: b.agreedQty, laborUnitPrice: b.laborUnitPrice, adjustment: b.adjustment, penalty: b.workshopPenalty }, delivered);
  const fabricAmount = fabrics.reduce((s, f) => s + f.amount, 0);
  return {
    ...b,
    marketerName: extra.marketerName,
    variantLines: variantLinesOf(b, deliveries, extra.info),
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

/** Giá nhập bình quân trên phiếu nhập (RECEIPT) gần nhất của từng mã — chỉ đọc. Báo cáo chênh lệch giá SX dùng lại cho mã chỉ có lệnh SX. */
export async function latestReceiptCost(productIds: string[]): Promise<Map<string, { unitCost: number; at: Date }>> {
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

  const [owners, info] = await Promise.all([productMarketerNames(), variantInfo([...new Set(batches.flatMap((b) => Object.keys(b.cells ?? {})))])]);
  const batchViews = batches.map((b) =>
    buildBatch(b, delByBatch.get(b.id) ?? [], payByBatch.get(b.id) ?? [], fabByBatch.get(b.id) ?? [], now, { marketerName: b.productId ? (owners.get(b.productId) ?? null) : null, info }),
  );
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
  const [receipt, prices] = await Promise.all([latestReceiptCost(productIds), listMarketerPrices()]);
  /*
    Giá báo HIỆN HÀNH để đọc cạnh giá SX. Tính TỪ HÔM NAY chứ không từ ngày bắt đầu áp dụng: trước
    tháng 9/2026 giá báo không áp cho đơn nào, nhưng người đặt giá vẫn cần thấy mình đã khai giá nào.
  */
  const currentMarketerPrice = (productId: string) => marketerPriceAt(prices.filter((x) => x.productId === productId), now);
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
        marketerName: productId ? (owners.get(productId) ?? null) : null,
        marketerPrice: productId ? currentMarketerPrice(productId) : null,
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
  const [owners, info] = await Promise.all([productMarketerNames(), variantInfo(Object.keys(b.cells ?? {}))]);
  const view = buildBatch(b, deliveries, directPayments, fabrics, now, { marketerName: b.productId ? (owners.get(b.productId) ?? null) : null, info });
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

/**
 * Hàng đặt xưởng chưa về theo mẫu, đọc từ Sổ đặt xưởng — CHỈ SỐ LƯỢNG, không một đồng nào (sổ này
 * không đi vào lợi nhuận). Dùng bởi `openPoQtyByVariant` để trang Thiếu hàng và Quyết định vốn tồn
 * kho trừ hàng đã đặt. Luật ở `openBatchQtyByVariant` (hàm thuần).
 */
export async function openBatchQtyByVariantFromLedger() {
  const db = await getDb();
  const [batches, deliveries, linked] = await Promise.all([
    db
      .select({
        id: schema.productionBatches.id,
        status: schema.productionBatches.status,
        cells: schema.productionBatches.cells,
        orderedQty: schema.productionBatches.orderedQty,
        agreedQty: schema.productionBatches.agreedQty,
        dueDate: schema.productionBatches.dueDate,
        productionOrderId: schema.productionBatches.productionOrderId,
      })
      .from(schema.productionBatches),
    db
      .select({ batchId: schema.productionDeliveries.batchId, quantity: schema.productionDeliveries.quantity, cells: schema.productionDeliveries.cells })
      .from(schema.productionDeliveries)
      .innerJoin(schema.productionBatches, eq(schema.productionBatches.id, schema.productionDeliveries.batchId))
      .where(eq(schema.productionBatches.status, "OPEN")),
    // Phiếu NHẬP HÀNG nối về lô (0132) — chứng từ TỒN, trừ khỏi "đang sản xuất" qua `openQtyAfterReceived`.
    linkedReceiptQty("batch"),
  ]);
  return openBatchQtyByVariant(
    batches.map((b) => ({ ...b, cells: b.cells ?? {}, dueDate: b.dueDate ? new Date(b.dueDate) : null })),
    deliveries.map((d) => ({ ...d, cells: d.cells ?? {} })),
    linked,
  );
}

/**
 * Số cái đã NHẬP KHO qua phiếu `RECEIPT` nối về một lệnh SX (`order`) hoặc một lô xưởng (`batch`),
 * theo mẫu mã: `mã lệnh/lô → (mẫu mã → số cái)`. Chỉ phiếu Nhập hàng — tái nhập hoàn / xuất tay /
 * điều chỉnh không phải hàng của xưởng. Phiếu không nối (mọi phiếu cũ) không góp gì.
 */
export async function linkedReceiptQty(by: "order" | "batch"): Promise<Map<string, Map<string, number>>> {
  const db = await getDb();
  const r = schema.stockReceipts;
  const ri = schema.stockReceiptItems;
  const key = by === "order" ? r.productionOrderId : r.productionBatchId;
  const rows = await db
    .select({ linkId: key, variantId: ri.variantId, qty: sql<number>`coalesce(sum(${ri.quantity}), 0)` })
    .from(ri)
    .innerJoin(r, eq(r.id, ri.receiptId))
    .where(sql`${r.kind} = 'RECEIPT' and ${key} is not null`)
    .groupBy(key, ri.variantId);
  const out = new Map<string, Map<string, number>>();
  for (const row of rows) {
    if (!row.linkId) continue;
    const m = out.get(row.linkId) ?? new Map<string, number>();
    m.set(row.variantId, (m.get(row.variantId) ?? 0) + Number(row.qty));
    out.set(row.linkId, m);
  }
  return out;
}

/**
 * Tiền phạt xưởng CỘNG cho MKT phụ trách mã trong kỳ (theo ngày ghi phạt). Chỉ SỐ TIỀN theo mã —
 * không đọc gì khác của sổ đặt xưởng. Phạt ghi trước ngày bắt đầu áp dụng không cộng.
 * Kèm số lô có phạt mà CHƯA khai ngày — không biết thuộc kỳ nào nên chưa cộng cho ai.
 */
export async function workshopPenaltyByProduct(period: Period): Promise<{ byProduct: Map<string, number>; undatedBatches: number; noProductBatches: number }> {
  const db = await getDb();
  const b = schema.productionBatches;
  const from = period.from && period.from > marketerPriceCutoff() ? period.from : marketerPriceCutoff();
  const rows = await db
    .select({
      productId: b.productId,
      amount: sql<number>`coalesce(sum(${b.workshopPenalty}) filter (where ${b.penaltyAt} >= ${from.toISOString()}::timestamptz${period.to ? sql` and ${b.penaltyAt} <= ${period.to.toISOString()}::timestamptz` : sql``}), 0)`,
      undated: sql<number>`count(*) filter (where ${b.penaltyAt} is null)`,
    })
    .from(b)
    .where(sql`${b.workshopPenalty} > 0 and ${b.status} <> 'CANCELLED'`)
    .groupBy(b.productId);
  const byProduct = new Map<string, number>();
  let undatedBatches = 0;
  let noProductBatches = 0;
  for (const r of rows) {
    undatedBatches += Number(r.undated);
    const amount = Number(r.amount);
    if (!amount) continue;
    if (!r.productId) {
      noProductBatches += 1;
      continue;
    }
    byProduct.set(r.productId, amount);
  }
  return { byProduct, undatedBatches, noProductBatches };
}

/*
  ═══ Company OS · Agent D — ĐỌC DANH TÍNH LÔ CHO SỔ KHO (không tiền) ═══

  Sổ đặt xưởng là công nợ / giá thành, nên CHỈ tệp này được chạm bốn bảng của nó
  (tests/workshop-ledger.test.ts). Ba hàm dưới đây cho sổ kho đúng thứ nó cần — mã lô, trạng thái,
  số cái — và KHÔNG trả một đồng tiền nào: phiếu nhập nối về lô, và trang 360 đếm hàng đang may.
*/

export type BatchLinkOption = { id: string; productCode: string; batchNo: number; supplier: string; orderedQty: number };

/** Lô xưởng ĐANG MỞ — ứng viên cho ô "Hàng của lô xưởng" trên phiếu nhập. */
export async function openBatchLinkOptions(limit = 300): Promise<BatchLinkOption[]> {
  const db = await getDb();
  const pb = schema.productionBatches;
  return db
    .select({ id: pb.id, productCode: pb.productCode, batchNo: pb.batchNo, supplier: pb.supplier, orderedQty: pb.orderedQty })
    .from(pb)
    .where(eq(pb.status, "OPEN"))
    .orderBy(desc(pb.orderedAt))
    .limit(limit);
}

/** Trạng thái + lệnh nối của MỘT lô — để kiểm phiếu nhập gắn vào lô có thật, chưa huỷ. `null` = không có lô đó. */
export async function batchLinkFacts(id: string): Promise<{ status: string; productionOrderId: string | null } | null> {
  const db = await getDb();
  const pb = schema.productionBatches;
  const [row] = await db.select({ status: pb.status, productionOrderId: pb.productionOrderId }).from(pb).where(eq(pb.id, id));
  return row ?? null;
}

/**
 * Số cái còn trong lô ĐANG MỞ của một mã hàng mà lô CHƯA chia được theo mẫu (không chia hộ — xem
 * `openBatchQtyByVariant`). Cùng một phép tính với phần theo mẫu, chỉ lọc theo mã hàng.
 */
export async function unsplitOpenBatchUnitsForProduct(productId: string): Promise<number> {
  const ledger = await openBatchQtyByVariantFromLedger();
  const ids = ledger.unsplit.map((u) => u.batchId);
  if (!ids.length) return 0;
  const db = await getDb();
  const pb = schema.productionBatches;
  const mine = new Set(
    (await db.select({ id: pb.id, productId: pb.productId }).from(pb).where(inArray(pb.id, ids))).filter((b) => b.productId === productId).map((b) => b.id),
  );
  return ledger.unsplit.filter((u) => mine.has(u.batchId)).reduce((t, u) => t + u.remaining, 0);
}
