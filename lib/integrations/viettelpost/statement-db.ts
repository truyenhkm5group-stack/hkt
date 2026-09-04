import { eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import type { StatementDetailRow, StatementSummary } from "@/lib/integrations/viettelpost/statement";

/** Tạo / cập nhật đợt nhận tiền theo mã bảng kê (tổng hợp, chưa cần chi tiết vận đơn) */
export async function upsertStatementBatches(rows: StatementSummary[], createdBy: string) {
  const db = await getDb();
  let created = 0;
  let updated = 0;
  for (const r of rows) {
    const values = {
      reference: r.reference,
      carrier: "Viettel Post",
      receivedAt: vnStartOfDay(r.receivedAt),
      totalAmount: r.netAmount,
      codGross: r.codGross,
      feeTotal: r.feeTotal,
      source: "VTP_STATEMENT",
      createdBy,
    };
    const existing = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, r.reference), columns: { id: true } });
    if (existing) {
      await db.update(schema.codBatches).set({ receivedAt: values.receivedAt, totalAmount: values.totalAmount, codGross: values.codGross, feeTotal: values.feeTotal, source: values.source }).where(eq(schema.codBatches.id, existing.id));
      updated += 1;
    } else {
      await db.insert(schema.codBatches).values({ ...values, note: "Bảng kê Viettel Post" });
      created += 1;
    }
  }
  return { created, updated };
}

export type DetailMatch = StatementDetailRow & { shipmentId: string | null; orderId: string | null; orderLabel: string; codStatus: string | null; codAmount: number };

/** Ghép từng dòng bảng kê với vận đơn trong ERP (mã VTP hoặc mã vận đơn) */
export async function matchStatementRows(rows: StatementDetailRow[]): Promise<DetailMatch[]> {
  const db = await getDb();
  const codes = [...new Set(rows.map((r) => r.trackingCode))];
  const found = codes.length
    ? await db
        .select({ id: schema.shipments.id, orderId: schema.shipments.orderId, vtp: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, codStatus: schema.shipments.codStatus, codAmount: schema.shipments.codAmount, systemId: schema.orders.systemId, name: schema.orders.billFullName })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(or(inArray(sql`upper(${schema.shipments.vtpOrderNumber})`, codes), inArray(sql`upper(${schema.shipments.trackingCode})`, codes)))
    : [];
  const byCode = new Map<string, (typeof found)[number]>();
  for (const f of found) {
    if (f.vtp) byCode.set(f.vtp.toUpperCase(), f);
    if (f.tracking) byCode.set(f.tracking.toUpperCase(), f);
  }
  return rows.map((r) => {
    const f = byCode.get(r.trackingCode);
    return { ...r, shipmentId: f?.id ?? null, orderId: f?.orderId ?? null, orderLabel: f ? `#${f.systemId ?? ""} ${f.name ?? ""}`.trim() : "", codStatus: f?.codStatus ?? null, codAmount: f?.codAmount ?? 0 };
  });
}

/** Áp chi tiết bảng kê: gắn vận đơn vào đợt, đánh dấu đã về ngân hàng, ghi cước thực tế */
export async function applyStatementDetail(summary: StatementSummary, rows: StatementDetailRow[], createdBy: string) {
  const db = await getDb();
  const matches = await matchStatementRows(rows);
  const matched = matches.filter((m) => m.shipmentId);
  const codGross = summary.codGross || rows.reduce((a, r) => a + r.cod, 0);
  const feeTotal = summary.feeTotal || rows.reduce((a, r) => a + r.fee, 0);
  const net = summary.netAmount || codGross - feeTotal;
  await upsertStatementBatches([{ ...summary, codGross, feeTotal, netAmount: net }], createdBy);
  const batch = await db.query.codBatches.findFirst({ where: eq(schema.codBatches.reference, summary.reference), columns: { id: true, receivedAt: true } });
  if (!batch) throw new Error("Không tạo được đợt nhận tiền");
  const now = new Date();
  let updatedShipments = 0;
  for (const m of matched) {
    await db
      .update(schema.shipments)
      .set({
        codStatus: "PAID_TO_BANK",
        codPaidToBankAt: batch.receivedAt,
        codBatchId: batch.id,
        codReconciledAt: sql`coalesce(${schema.shipments.codReconciledAt}, ${now})`,
        codCollected: m.cod > 0 ? m.cod : sql`case when ${schema.shipments.codCollected} = 0 then ${schema.shipments.codAmount} else ${schema.shipments.codCollected} end`,
        shippingFee: m.fee > 0 ? m.fee : schema.shipments.shippingFee,
        updatedAt: now,
      })
      .where(eq(schema.shipments.id, m.shipmentId as string));
    if (m.orderId && m.fee > 0) await db.update(schema.orders).set({ partnerFee: m.fee }).where(eq(schema.orders.id, m.orderId));
    updatedShipments += 1;
  }
  return { batchId: batch.id, matched: matched.length, unmatched: matches.length - matched.length, updatedShipments, codGross, feeTotal, net };
}
