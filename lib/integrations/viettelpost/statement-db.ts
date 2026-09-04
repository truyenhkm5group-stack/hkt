import { eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import { mapVtpStatusText, type StatementDetailRow, type StatementSummary, type VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";

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

// ───────── Danh sách vận đơn (Quản lý vận đơn → xuất Excel) ─────────

export type OrderListMatch = VtpOrderListRow & { shipmentId: string | null; orderLabel: string; currentStage: string | null; currentCod: string | null; mapped: ReturnType<typeof mapVtpStatusText> };

export async function matchVtpOrderList(rows: VtpOrderListRow[]): Promise<OrderListMatch[]> {
  const db = await getDb();
  const codes = [...new Set(rows.map((r) => r.trackingCode))];
  const found = codes.length
    ? await db
        .select({ id: schema.shipments.id, vtp: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, stage: schema.shipments.stage, codStatus: schema.shipments.codStatus, systemId: schema.orders.systemId, name: schema.orders.billFullName })
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
    return { ...r, shipmentId: f?.id ?? null, orderLabel: f ? `#${f.systemId ?? ""} ${f.name ?? ""}`.trim() : "", currentStage: f?.stage ?? null, currentCod: f?.codStatus ?? null, mapped: mapVtpStatusText(r.statusText) };
  });
}

const COD_RANK: Record<string, number> = { NOT_APPLICABLE: 0, PENDING: 1, COLLECTED: 2, RECONCILED: 3, PAID_TO_BANK: 4, DISPUTED: 2 };

/** Áp trạng thái Viettel Post (chữ) lên vận đơn ERP: giai đoạn, tên trạng thái, COD (không hạ COD đã về ngân hàng), cước thực tế */
export async function applyVtpOrderList(rows: VtpOrderListRow[]) {
  const db = await getDb();
  const matches = await matchVtpOrderList(rows);
  const now = new Date();
  let updated = 0;
  let paid = 0;
  for (const m of matches) {
    if (!m.shipmentId || m.mapped.stage === "UNKNOWN") continue;
    const statusDate = m.statusDate ? vnStartOfDay(m.statusDate) : null;
    const set: Record<string, unknown> = { stage: m.mapped.stage, vtpStatusName: m.statusText, isFinal: m.mapped.final, lastVtpSyncAt: now, updatedAt: now };
    if (statusDate) set.vtpStatusDate = statusDate;
    if (m.fee > 0) set.shippingFee = m.fee;
    if (m.mapped.stage === "DELIVERED" && statusDate) set.deliveredAt = statusDate;
    if (m.mapped.stage === "RETURNED" && statusDate) set.returnedAt = statusDate;
    if (m.mapped.cod && (COD_RANK[m.mapped.cod] ?? 0) > (COD_RANK[m.currentCod ?? "PENDING"] ?? 0)) {
      set.codStatus = m.mapped.cod;
      if (m.mapped.cod === "PAID_TO_BANK") {
        set.codPaidToBankAt = statusDate ?? now;
        set.codReconciledAt = statusDate ?? now;
        set.codCollected = m.cod > 0 ? m.cod : sql`case when ${schema.shipments.codCollected} = 0 then ${schema.shipments.codAmount} else ${schema.shipments.codCollected} end`;
        paid += 1;
      }
      if (m.mapped.cod === "COLLECTED") set.codCollected = m.cod > 0 ? m.cod : sql`case when ${schema.shipments.codCollected} = 0 then ${schema.shipments.codAmount} else ${schema.shipments.codCollected} end`;
    } else if (m.mapped.cod === "NOT_APPLICABLE" && m.currentCod !== "PAID_TO_BANK") set.codStatus = "NOT_APPLICABLE";
    await db.update(schema.shipments).set(set as Partial<typeof schema.shipments.$inferInsert>).where(eq(schema.shipments.id, m.shipmentId));
    updated += 1;
  }
  return { total: rows.length, matched: matches.filter((m) => m.shipmentId).length, updated, paid, unknown: matches.filter((m) => m.shipmentId && m.mapped.stage === "UNKNOWN").length };
}
