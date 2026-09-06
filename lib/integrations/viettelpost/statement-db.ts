import { and, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { vnStartOfDay } from "@/lib/format";
import { legBaseCode, mapVtpStatusText, mergeVtpOrderLists, type StatementDetailRow, type StatementSummary, type VtpOrderListRow } from "@/lib/integrations/viettelpost/statement";

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

export type OrderListMatch = VtpOrderListRow & {
  shipmentId: string | null;
  orderLabel: string;
  currentStage: string | null;
  currentCod: string | null;
  mapped: ReturnType<typeof mapVtpStatusText>;
  /** direct = đúng vận đơn trong ERP; leg = vận đơn chiều về của vận đơn gốc (ghi thành vận đơn riêng, không đè trạng thái đơn gốc) */
  matchKind: "direct" | "leg" | null;
  /** Mã vận đơn gốc khi đây là vận đơn chiều về */
  legOf: string | null;
  matchIssue?: string;
};

export async function matchVtpOrderList(rows: VtpOrderListRow[]): Promise<OrderListMatch[]> {
  const db = await getDb();
  // File VTP để mã vận đơn chiều về ("…1P1") ở cột Mã Vận Đơn, mã gốc ở cột Mã đơn hàng → tra cả ba dạng
  const codes = [...new Set(rows.flatMap((r) => [r.trackingCode, r.orderCode, legBaseCode(r.trackingCode)]).filter(Boolean))];
  const found = codes.length
    ? await db
        .select({ id: schema.shipments.id, vtp: schema.shipments.vtpOrderNumber, tracking: schema.shipments.trackingCode, stage: schema.shipments.stage, codStatus: schema.shipments.codStatus, systemId: schema.orders.systemId, name: schema.orders.billFullName })
        .from(schema.shipments)
        .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
        .where(or(inArray(sql`upper(${schema.shipments.vtpOrderNumber})`, codes), inArray(sql`upper(${schema.shipments.trackingCode})`, codes)))
    : [];
  const byCode = new Map<string, (typeof found)[number]>();
  const ambiguous = new Set<string>();
  for (const f of found) {
    for (const code of [f.vtp, f.tracking].filter((c): c is string => Boolean(c))) {
      const key = code.toUpperCase();
      if (byCode.has(key) && byCode.get(key)!.id !== f.id) ambiguous.add(key);
      byCode.set(key, f);
    }
  }
  return rows.map((r) => {
    // Mã có đuôi P (…1P1) là vận đơn CHIỀU VỀ: cột "Mã đơn hàng" của file chính là mã gốc, tin hơn suy từ chuỗi.
    // Phải xét chiều về TRƯỚC, nếu không mã gốc ở cột "Mã đơn hàng" sẽ bị coi là khớp trực tiếp và đè trạng thái đơn gốc.
    const isLeg = Boolean(legBaseCode(r.trackingCode));
    const base = isLeg ? r.orderCode || legBaseCode(r.trackingCode) : "";
    const direct = isLeg ? undefined : byCode.get(r.trackingCode);
    const leg = isLeg && base ? byCode.get(base) : undefined;
    const usedCode = isLeg ? base : r.trackingCode;
    const conflictingReferences = !isLeg && byCode.has(r.trackingCode) && byCode.has(r.orderCode) && byCode.get(r.trackingCode)!.id !== byCode.get(r.orderCode)!.id;
    const matchIssue = ambiguous.has(usedCode) || conflictingReferences ? "Mã tham chiếu ghép được nhiều vận đơn; cần đối chiếu" : undefined;
    const f = matchIssue ? undefined : direct ?? leg;
    return {
      ...r,
      shipmentId: f?.id ?? null,
      orderLabel: f ? `#${f.systemId ?? ""} ${f.name ?? ""}`.trim() : "",
      currentStage: f?.stage ?? null,
      currentCod: f?.codStatus ?? null,
      mapped: mapVtpStatusText(r.statusText),
      matchKind: f ? (direct ? "direct" : "leg") : null,
      legOf: leg ? (leg.vtp ?? base) : null,
      matchIssue,
    };
  });
}

/** Danh sách vận đơn cập nhật logistics/COD khai báo; không chứng minh tiền thực thu hay ngân hàng. */
export async function applyVtpOrderList(rows: VtpOrderListRow[], actor = "VTP_IMPORT") {
  const db = await getDb();
  const matches = await matchVtpOrderList(mergeVtpOrderLists(rows));
  const now = new Date();
  let updated = 0;
  let legs = 0;
  let stale = 0;
  let duplicate = 0;
  let missingDate = 0;
  let conflicts = matches.filter((m) => m.matchIssue).length;
  for (const m of [...matches].sort((a, b) => a.trackingCode.localeCompare(b.trackingCode))) {
    if (!m.shipmentId || m.mapped.stage === "UNKNOWN") continue;
    const occurredAt = m.statusAt ? new Date(m.statusAt) : m.statusDate ? vnStartOfDay(m.statusDate) : null;
    if (!occurredAt || !Number.isFinite(occurredAt.getTime())) { missingDate++; continue; }
    const result = await db.transaction(async (tx) => {
      const isLeg = m.matchKind === "leg";
      if (isLeg) {
        // Không sinh số 0 thay cho ô chưa biết trong schema shipments legacy NOT NULL.
        if (m.cod === null || m.fee === null) return "conflict";
        await tx.insert(schema.shipments).values({ carrier: "Viettel Post", vtpOrderNumber: m.trackingCode,
          trackingCode: m.trackingCode, orderReference: m.legOf, codAmount: m.cod, shippingFee: m.fee,
          codStatus: "NOT_APPLICABLE" }).onConflictDoNothing({ target: schema.shipments.vtpOrderNumber });
      }
      const [current] = await tx.select().from(schema.shipments)
        .where(isLeg ? eq(schema.shipments.vtpOrderNumber, m.trackingCode) : eq(schema.shipments.id, m.shipmentId!)).for("update");
      if (!current || (isLeg && (current.orderId !== null || current.orderReference !== m.legOf))) return "conflict";
      const snapshot = { trackingCode: m.trackingCode, orderCode: m.orderCode, statusText: m.statusText,
        cod: m.cod, fee: m.fee, codReconciliationText: m.codReconciliationText ?? "", paymentText: m.paymentText ?? "",
        returnFlag: m.returnFlag ?? false, forwardFlag: m.forwardFlag ?? false };
      const [existing] = await tx.select().from(schema.shipmentEvents).where(and(eq(schema.shipmentEvents.shipmentId, current.id),
        eq(schema.shipmentEvents.source, "VTP_IMPORT"), eq(schema.shipmentEvents.status, m.statusText), eq(schema.shipmentEvents.occurredAt, occurredAt)));
      if (existing) {
        const previous = existing.raw as { snapshot?: typeof snapshot } | null;
        return previous?.snapshot && Object.keys(snapshot).every((key) => previous.snapshot![key as keyof typeof snapshot] === snapshot[key as keyof typeof snapshot]) ? "duplicate" : "conflict";
      }
      const older = current.vtpStatusDate !== null && current.vtpStatusDate > occurredAt;
      const sameTimeConflict = current.vtpStatusDate?.getTime() === occurredAt.getTime() && current.stage !== m.mapped.stage;
      const before = { stage: current.stage, codAmount: current.codAmount, shippingFee: current.shippingFee, vtpStatusDate: current.vtpStatusDate };
      if (!older && !sameTimeConflict) {
        await tx.update(schema.shipments).set({ stage: m.mapped.stage, vtpStatusName: m.statusText,
          isFinal: m.mapped.final, vtpStatusDate: occurredAt, lastVtpSyncAt: now, updatedAt: now,
          ...(m.cod !== null ? { codAmount: m.cod } : {}), ...(m.fee !== null ? { shippingFee: m.fee } : {}),
          ...(m.mapped.stage === "DELIVERED" ? { deliveredAt: occurredAt } : {}),
          ...(m.mapped.stage === "RETURNED" ? { returnedAt: occurredAt } : {}),
        }).where(eq(schema.shipments.id, current.id));
      }
      const disposition = older ? "stale" : sameTimeConflict ? "conflict" : "applied";
      await tx.insert(schema.shipmentEvents).values({ shipmentId: current.id, source: "VTP_IMPORT", status: m.statusText,
        statusName: m.statusText, occurredAt, normalizedStage: m.mapped.stage, legType: isLeg ? "RETURN" : "OUTBOUND",
        verificationStatus: "PENDING", sourceReference: m.sourceHash ? `${m.sourceHash}:row:${m.sourceRow}` : null,
        raw: { snapshot, disposition, sourceHash: m.sourceHash ?? null, sourceRow: m.sourceRow ?? null, importedBy: actor } });
      await tx.insert(schema.auditLogs).values({ userEmail: actor, action: "VTP_ORDER_LIST_ROW", entity: "SHIPMENT", entityId: current.id,
        detail: { before, snapshot, disposition, sourceHash: m.sourceHash ?? null, sourceRow: m.sourceRow ?? null } });
      return disposition === "applied" ? isLeg ? "leg" : "updated" : disposition;
    });
    if (result === "updated") updated++;
    else if (result === "leg") legs++;
    else if (result === "stale") stale++;
    else if (result === "duplicate") duplicate++;
    else conflicts++;
  }
  return { total: rows.length, matched: matches.filter((m) => m.shipmentId).length, updated, paid: 0, legs, stale, duplicate, conflicts, missingDate,
    unmatched: matches.filter((m) => !m.shipmentId).length, unknown: matches.filter((m) => m.shipmentId && m.mapped.stage === "UNKNOWN").length };
}
