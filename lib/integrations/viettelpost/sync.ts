import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { getDb, schema, type Db } from "@/db";
import type { CodStatus, Shipment, ShipmentStage } from "@/db/schema";
import { VTP_FINAL_STATUSES, vtpStatusMeta } from "@/lib/constants/viettelpost";
import { getViettelPostClient, type VtpTrackingRecord } from "@/lib/integrations/viettelpost/client";
import { publish } from "@/lib/realtime/bus";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";

export type ApplyResult = { shipmentId: string; changed: boolean; created: boolean; stage: ShipmentStage };

/** Tìm vận đơn trong ERP theo mã VTP / mã vận đơn / mã tham chiếu */
export async function findShipmentForVtp(db: Db, record: VtpTrackingRecord): Promise<Shipment | null> {
  const orderNumber = record.orderNumber;
  if (orderNumber) {
    const byNumber = await db.query.shipments.findFirst({ where: or(eq(schema.shipments.vtpOrderNumber, orderNumber), eq(schema.shipments.trackingCode, orderNumber)) });
    if (byNumber) return byNumber;
  }
  const ref = record.orderReference;
  if (ref) {
    const systemId = Number(ref.replace(/\D/g, ""));
    const conditions = [eq(schema.orders.id, ref), eq(schema.orders.customId, ref)];
    if (Number.isFinite(systemId) && systemId > 0) conditions.push(eq(schema.orders.systemId, systemId));
    const order = await db.query.orders.findFirst({ where: or(...conditions), with: { shipment: true } });
    if (order?.shipment) return order.shipment;
    if (order) {
      const [created] = await db
        .insert(schema.shipments)
        .values({
          orderId: order.id,
          carrier: "Viettel Post",
          vtpOrderNumber: orderNumber || null,
          trackingCode: orderNumber || null,
          codAmount: order.moneyToCollect,
          receiverName: order.shipFullName,
          receiverPhone: order.shipPhone,
          receiverAddress: order.shipFullAddress,
        })
        .returning();
      return created;
    }
  }
  return null;
}

/**
 * Áp trạng thái Viettel Post vào vận đơn. Dùng chung cho webhook, polling và import.
 * Không tạo vận đơn mới nếu không tìm thấy, trừ khi allowCreate = true.
 */
export async function applyVtpTracking(record: VtpTrackingRecord, source: "VTP_WEBHOOK" | "VTP_POLL" | "VTP_IMPORT", options: { allowCreate?: boolean } = {}): Promise<ApplyResult | null> {
  const db = await getDb();
  let shipment = await findShipmentForVtp(db, record);
  let created = false;
  if (!shipment) {
    if (!options.allowCreate || !record.orderNumber) return null;
    const [row] = await db
      .insert(schema.shipments)
      .values({
        carrier: "Viettel Post",
        vtpOrderNumber: record.orderNumber,
        trackingCode: record.orderNumber,
        orderReference: record.orderReference || null,
        codAmount: record.moneyCollection,
        receiverName: record.receiverName,
        receiverPhone: record.receiverPhone,
        receiverAddress: record.receiverAddress,
      })
      .returning();
    shipment = row;
    created = true;
  }

  const meta = vtpStatusMeta(record.status, record.statusName);
  const statusDate = record.statusDate ?? new Date();
  const isNewer = !shipment.vtpStatusDate || statusDate.getTime() >= shipment.vtpStatusDate.getTime();

  // Ghi sự kiện hành trình (idempotent theo shipment + source + status + thời điểm)
  const eventRows: (typeof schema.shipmentEvents.$inferInsert)[] = [];
  if (record.status !== null || record.statusName) {
    eventRows.push({ shipmentId: shipment.id, source, status: String(record.status ?? record.statusName), statusName: meta.name, location: record.location, note: record.note, occurredAt: statusDate, raw: record.raw });
  }
  for (const step of record.journey) {
    if (!step.occurredAt) continue;
    eventRows.push({ shipmentId: shipment.id, source, status: String(step.status ?? step.statusName), statusName: step.statusName || vtpStatusMeta(step.status).name, location: step.location, note: step.note, occurredAt: step.occurredAt, raw: step.raw });
  }
  if (eventRows.length) await db.insert(schema.shipmentEvents).values(eventRows).onConflictDoNothing();

  if (!isNewer && !created) {
    await db.update(schema.shipments).set({ lastVtpSyncAt: new Date() }).where(eq(schema.shipments.id, shipment.id));
    return { shipmentId: shipment.id, changed: false, created, stage: shipment.stage };
  }

  const isFinal = record.status !== null && VTP_FINAL_STATUSES.has(record.status);
  const codAmount = record.moneyCollection > 0 ? record.moneyCollection : shipment.codAmount;
  let codStatus: CodStatus = shipment.codStatus;
  if (meta.stage === "DELIVERED" && codAmount > 0 && ["PENDING", "NOT_APPLICABLE"].includes(codStatus)) codStatus = "COLLECTED";
  if ((meta.stage === "RETURNED" || meta.stage === "CANCELLED") && ["PENDING", "COLLECTED"].includes(codStatus)) codStatus = "NOT_APPLICABLE";
  const stage = meta.stage === "UNKNOWN" ? shipment.stage : meta.stage;
  const existingRaw = shipment.raw && typeof shipment.raw === "object" ? (shipment.raw as Record<string, unknown>) : {};

  await db
    .update(schema.shipments)
    .set({
      carrier: shipment.carrier || "Viettel Post",
      vtpOrderNumber: shipment.vtpOrderNumber ?? (record.orderNumber || null),
      trackingCode: shipment.trackingCode ?? (record.orderNumber || null),
      orderReference: record.orderReference || shipment.orderReference,
      stage,
      vtpStatus: record.status,
      vtpStatusName: meta.name,
      vtpStatusDate: statusDate,
      vtpLocation: record.location || shipment.vtpLocation,
      vtpNote: record.note || shipment.vtpNote,
      vtpReasonCode: record.reasonCode ?? shipment.vtpReasonCode,
      service: record.service || shipment.service,
      weight: record.productWeight || shipment.weight,
      expectedDelivery: record.expectedDelivery || shipment.expectedDelivery,
      codAmount,
      codCollected: ["COLLECTED", "RECONCILED", "PAID_TO_BANK"].includes(codStatus) ? Math.max(shipment.codCollected, codAmount) : shipment.codCollected,
      codFee: record.moneyFeeCod || shipment.codFee,
      shippingFee: record.moneyTotal || record.moneyTotalFee || shipment.shippingFee,
      codStatus,
      receiverName: shipment.receiverName || record.receiverName,
      receiverPhone: shipment.receiverPhone || record.receiverPhone,
      receiverAddress: shipment.receiverAddress || record.receiverAddress,
      pickedUpAt: shipment.pickedUpAt ?? (["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED"].includes(stage) ? statusDate : null),
      firstDeliveryAt: shipment.firstDeliveryAt ?? (stage === "OUT_FOR_DELIVERY" || stage === "DELIVERED" ? statusDate : null),
      deliveredAt: stage === "DELIVERED" ? statusDate : shipment.deliveredAt,
      returnedAt: stage === "RETURNED" ? statusDate : shipment.returnedAt,
      cancelledAt: stage === "CANCELLED" ? statusDate : shipment.cancelledAt,
      isFinal,
      lastVtpSyncAt: new Date(),
      raw: { ...existingRaw, vtp: record.raw },
      updatedAt: new Date(),
    })
    .where(eq(schema.shipments.id, shipment.id));

  publish({ type: "shipment", shipmentId: shipment.id, status: stage });
  return { shipmentId: shipment.id, changed: true, created, stage };
}

/** Poll trạng thái các vận đơn Viettel Post chưa kết thúc */
export async function syncViettelPostShipments(options: { trigger?: SyncTrigger; actor?: string; limit?: number; includeFinal?: boolean; shipmentIds?: string[] } = {}) {
  return runSyncJob({ source: "VIETTELPOST", job: options.shipmentIds?.length ? "tracking_selected" : "tracking_poll", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const db = await getDb();
    const client = getViettelPostClient();
    const where = options.shipmentIds?.length
      ? inArray(schema.shipments.id, options.shipmentIds)
      : and(
          or(sql`${schema.shipments.carrier} ilike '%viettel%'`, isNotNull(schema.shipments.vtpOrderNumber)),
          or(isNotNull(schema.shipments.vtpOrderNumber), isNotNull(schema.shipments.trackingCode)),
          options.includeFinal ? undefined : eq(schema.shipments.isFinal, false),
        );
    const shipments = await db
      .select({ id: schema.shipments.id, vtpOrderNumber: schema.shipments.vtpOrderNumber, trackingCode: schema.shipments.trackingCode })
      .from(schema.shipments)
      .where(where)
      .orderBy(sql`${schema.shipments.lastVtpSyncAt} asc nulls first`, asc(schema.shipments.createdAt))
      .limit(options.limit ?? 300);
    ctx.summary.detail = `Kiểm tra ${shipments.length} vận đơn`;
    for (const shipment of shipments) {
      const orderNumber = shipment.vtpOrderNumber ?? shipment.trackingCode;
      if (!orderNumber) {
        ctx.summary.skipped += 1;
        continue;
      }
      try {
        const record = await client.getOrderDetail(orderNumber);
        if (!record) {
          ctx.summary.skipped += 1;
          await db.update(schema.shipments).set({ lastVtpSyncAt: new Date() }).where(eq(schema.shipments.id, shipment.id));
          continue;
        }
        const result = await applyVtpTracking({ ...record, orderNumber }, "VTP_POLL");
        if (result?.changed) ctx.summary.updated += 1;
        else ctx.summary.skipped += 1;
      } catch (error) {
        ctx.summary.failed += 1;
        ctx.log(`${orderNumber}: ${error instanceof Error ? error.message : String(error)}`);
        await db.update(schema.shipments).set({ lastVtpSyncAt: new Date() }).where(eq(schema.shipments.id, shipment.id)).catch(() => undefined);
      }
      await ctx.progress();
    }
    ctx.summary.detail = `Đã kiểm tra ${shipments.length} vận đơn · cập nhật ${ctx.summary.updated} · lỗi ${ctx.summary.failed}`;
    return shipments.length;
  });
}

/** Nhập danh sách vận đơn từ tài khoản Viettel Post (kể cả đơn không tạo qua Pancake) */
export async function importViettelPostOrders(options: { trigger?: SyncTrigger; actor?: string; days?: number } = {}) {
  return runSyncJob({ source: "VIETTELPOST", job: "orders_import", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const client = getViettelPostClient();
    const days = options.days ?? 30;
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    let page = 1;
    let fetched = 0;
    let total = 0;
    for (;;) {
      const result = await client.listOrders({ from, to, page });
      total = result.total;
      if (!result.orders.length) break;
      for (const record of result.orders) {
        if (!record.orderNumber) {
          ctx.summary.skipped += 1;
          continue;
        }
        try {
          const applied = await applyVtpTracking(record, "VTP_IMPORT", { allowCreate: true });
          if (applied?.created) ctx.summary.imported += 1;
          else if (applied?.changed) ctx.summary.updated += 1;
          else ctx.summary.skipped += 1;
        } catch (error) {
          ctx.summary.failed += 1;
          ctx.log(`${record.orderNumber}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      fetched += result.orders.length;
      ctx.summary.detail = `Trang ${page} · ${fetched}/${total || "?"} vận đơn`;
      await ctx.progress();
      if (fetched >= total || page >= 200) break;
      page += 1;
    }
    ctx.summary.detail = `Nhập ${fetched} vận đơn ${days} ngày gần nhất (mới ${ctx.summary.imported}, cập nhật ${ctx.summary.updated})`;
    return fetched;
  });
}

/** Các vận đơn Viettel Post chưa gắn với đơn Pancake */
export async function orphanVtpShipments(db: Db) {
  return db.query.shipments.findMany({ where: isNull(schema.shipments.orderId), orderBy: (s, { desc }) => [desc(s.createdAt)], limit: 200 });
}
