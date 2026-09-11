import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { clearMemo } from "@/lib/cache";
import {
  CARE_STATUSES,
  CARRIER_ACTION_KEYS,
  CARRIER_ACTION_LABEL,
  carrierActionAllowed,
  type CareStatus,
  type CarrierActionKey,
  type CarrierRequestStatus,
} from "@/lib/constants/care";
import { CARE_ACTION_KINDS, type CareActionKind } from "@/lib/constants/delivery-tower";
import { getViettelPostClient, VTP_ORDER_ACTIONS } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import type { CareState, CarrierRequestView } from "@/lib/queries/care-workbench";

/**
 * ═══════════ NGHIỆP VỤ BÀN LÀM VIỆC GIAO VẬN (không phụ thuộc phiên đăng nhập) ═══════════
 *
 * Server Action ở `lib/actions/care-workbench.ts` chỉ kiểm quyền rồi gọi vào đây; kiểm thử gọi
 * thẳng vào đây với một `actor` giả. Mọi hàm trả về ĐÚNG mảnh trạng thái mới của kiện để client vá
 * tại dòng — không reload, không cuộn. Mọi hàm đều ghi nhật ký trước/sau. Không hàm nào chạm vào
 * `shipments.stage`: chiều ĐVVC là chứng từ, đội không được viết vào.
 */

export type CareActor = { id: string | null; email: string; name?: string | null };
export type Result<T> = { ok: true; data: T } | { error: string };

async function loadState(shipmentId: string): Promise<CareState> {
  const db = await getDb();
  const [r] = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  if (!r) return { status: "NEW", owner: null, followUpAt: null, lastNote: "", lastNoteAt: null, lastNoteBy: "", firstResponseAt: null, doneAt: null, reopenCount: 0, updatedAt: null, updatedBy: "" };
  return {
    status: r.care.careStatus as CareStatus,
    owner: r.care.ownerId ? { id: r.care.ownerId, name: r.ownerName || r.care.ownerEmail || r.care.ownerId } : null,
    followUpAt: r.care.followUpAt,
    lastNote: r.care.lastNote,
    lastNoteAt: r.care.lastNoteAt,
    lastNoteBy: r.care.lastNoteBy,
    firstResponseAt: r.care.firstResponseAt,
    doneAt: r.care.doneAt,
    reopenCount: r.care.reopenCount,
    updatedAt: r.care.updatedAt,
    updatedBy: r.care.updatedBy,
  };
}

/** Bảo đảm có dòng care cho kiện; trả về dòng hiện tại (trước khi đổi). */
async function ensureCareRow(shipmentId: string, actor: string) {
  const db = await getDb();
  const [s] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.id, shipmentId));
  if (!s) return null;
  await db.insert(schema.shipmentCare).values({ shipmentId, updatedBy: actor }).onConflictDoNothing();
  const [row] = await db.select().from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, shipmentId));
  return row ?? null;
}

/** Lần đầu có NGƯỜI động vào ⇒ chốt mốc phản hồi đầu tiên (không ghi đè). */
function firstResponse(row: typeof schema.shipmentCare.$inferSelect, now: Date) {
  return row.firstResponseAt ?? now;
}

export const statusSchema = z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(200), status: z.enum(CARE_STATUSES), note: z.string().trim().max(500).default("") });

export async function setCareStatus(user: CareActor, input: z.input<typeof statusSchema>): Promise<Result<Record<string, CareState>>> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, status, note } = parsed.data;
  const db = await getDb();
  const now = new Date();
  const actor = user.email;
  const out: Record<string, CareState> = {};
  for (const shipmentId of [...new Set(shipmentIds)]) {
    const before = await ensureCareRow(shipmentId, actor);
    if (!before) continue;
    // Kiện đã đóng mà đội lại mở ⇒ đếm một lần mở lại.
    const reopen = before.careStatus === "DONE" && status !== "DONE";
    await db
      .update(schema.shipmentCare)
      .set({
        careStatus: status,
        firstResponseAt: firstResponse(before, now),
        doneAt: status === "DONE" ? now : before.doneAt,
        escalatedAt: status === "ESCALATED" ? now : before.escalatedAt,
        // Đóng hoặc escalate thì lịch hẹn theo dõi không còn nghĩa.
        followUpAt: status === "DONE" ? null : before.followUpAt,
        reopenCount: before.reopenCount + (reopen ? 1 : 0),
        ...(note ? { lastNote: note, lastNoteAt: now, lastNoteBy: actor } : {}),
        updatedBy: actor,
        updatedAt: now,
      })
      .where(eq(schema.shipmentCare.shipmentId, shipmentId));
    if (note) await db.insert(schema.careActions).values({ shipmentId, actorId: user.id, actorEmail: actor, kind: "OTHER", note, stageAtAction: "" });
    await audit({ userId: user.id, userEmail: actor, action: "care.status", entity: "SHIPMENT", entityId: shipmentId, before: { careStatus: before.careStatus }, after: { careStatus: status, note }, reason: reopen ? "Mở lại kiện đã đóng" : undefined });
    out[shipmentId] = await loadState(shipmentId);
  }
  clearMemo();
  return { ok: true, data: out };
}

export const ownerSchema = z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(200), ownerId: z.string().nullable() });

export async function setCareOwner(user: CareActor, input: z.input<typeof ownerSchema>): Promise<Result<Record<string, CareState>>> {
  const parsed = ownerSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, ownerId } = parsed.data;
  const db = await getDb();
  const owner = ownerId ? await db.query.users.findFirst({ where: eq(schema.users.id, ownerId), columns: { id: true, email: true, name: true } }) : null;
  if (ownerId && !owner) return { error: "Không tìm thấy người nhận việc" };
  const now = new Date();
  const actor = user.email;
  const out: Record<string, CareState> = {};
  for (const shipmentId of [...new Set(shipmentIds)]) {
    const before = await ensureCareRow(shipmentId, actor);
    if (!before) continue;
    await db
      .update(schema.shipmentCare)
      .set({
        ownerId: owner?.id ?? null,
        ownerEmail: owner?.email ?? "",
        // Giao việc cho người là đã có người động vào; trạng thái mới còn "chưa xử lý" thì thành "đang xử lý".
        careStatus: before.careStatus === "NEW" && owner ? "IN_PROGRESS" : before.careStatus,
        firstResponseAt: firstResponse(before, now),
        updatedBy: actor,
        updatedAt: now,
      })
      .where(eq(schema.shipmentCare.shipmentId, shipmentId));
    await audit({ userId: user.id, userEmail: actor, action: "care.owner", entity: "SHIPMENT", entityId: shipmentId, before: { ownerId: before.ownerId }, after: { ownerId: owner?.id ?? null, ownerName: owner?.name ?? null } });
    out[shipmentId] = await loadState(shipmentId);
  }
  clearMemo();
  return { ok: true, data: out };
}

export const followUpSchema = z.object({ shipmentId: z.string().min(1), at: z.coerce.date().nullable() });

export async function setCareFollowUp(user: CareActor, input: z.input<typeof followUpSchema>): Promise<Result<CareState>> {
  const parsed = followUpSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, at } = parsed.data;
  const db = await getDb();
  const now = new Date();
  const actor = user.email;
  const before = await ensureCareRow(shipmentId, actor);
  if (!before) return { error: "Không tìm thấy vận đơn" };
  await db
    .update(schema.shipmentCare)
    .set({
      followUpAt: at,
      // Hẹn theo dõi nghĩa là đã làm phần mình và đang chờ — trừ khi đã escalate / đã xong.
      careStatus: at && (before.careStatus === "NEW" || before.careStatus === "IN_PROGRESS") ? "WAITING" : before.careStatus,
      firstResponseAt: firstResponse(before, now),
      updatedBy: actor,
      updatedAt: now,
    })
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  await audit({ userId: user.id, userEmail: actor, action: "care.followUp", entity: "SHIPMENT", entityId: shipmentId, before: { followUpAt: before.followUpAt }, after: { followUpAt: at } });
  clearMemo();
  return { ok: true, data: await loadState(shipmentId) };
}

export const noteSchema = z.object({ shipmentId: z.string().min(1), note: z.string().trim().min(1, "Nhập nội dung").max(500), kind: z.enum(CARE_ACTION_KINDS).default("OTHER") });

/** Note nhanh = một hành động care (có ảnh chụp bối cảnh) + note gần nhất trên dòng. */
export async function addCareNote(user: CareActor, input: z.input<typeof noteSchema>): Promise<Result<CareState>> {
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, note, kind } = parsed.data;
  const db = await getDb();
  const now = new Date();
  const actor = user.email;
  const before = await ensureCareRow(shipmentId, actor);
  if (!before) return { error: "Không tìm thấy vận đơn" };
  const [s] = await db.select({ stage: schema.shipments.stage, cod: schema.shipments.codAmount, orderId: schema.shipments.orderId }).from(schema.shipments).where(eq(schema.shipments.id, shipmentId));
  await db.insert(schema.careActions).values({ shipmentId, orderId: s?.orderId ?? null, actorId: user.id, actorEmail: actor, kind: kind as CareActionKind, note, stageAtAction: s?.stage ?? "", codAtAction: s?.cod ?? null });
  await db
    .update(schema.shipmentCare)
    .set({
      lastNote: note,
      lastNoteAt: now,
      lastNoteBy: actor,
      careStatus: before.careStatus === "NEW" ? "IN_PROGRESS" : before.careStatus,
      firstResponseAt: firstResponse(before, now),
      updatedBy: actor,
      updatedAt: now,
    })
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  await audit({ userId: user.id, userEmail: actor, action: "care.note", entity: "SHIPMENT", entityId: shipmentId, after: { kind, note } });
  clearMemo();
  return { ok: true, data: await loadState(shipmentId) };
}

/**
 * ───────────── GỬI YÊU CẦU TỚI VIETTEL POST ─────────────
 *
 * Vòng đời: PENDING → SENT → ACK (API nhận) → SUCCESS khi sự kiện hành trình xác nhận
 * (`settleCarrierRequests`) | FAILED | UNSUPPORTED. Tài khoản API không có quyền trên kiện
 * (`tracking_capability` ≠ API_TRACKABLE) ⇒ MANUAL_REQUIRED: ghi lại yêu cầu, nói thẳng phải làm
 * tay, KHÔNG giả vờ gửi. Không hành động nào ở đây tự đổi trạng thái care.
 */
export const requestSchema = z.object({
  shipmentId: z.string().min(1),
  actionKey: z.enum(CARRIER_ACTION_KEYS),
  note: z.string().trim().max(300).default(""),
  edit: z
    .object({
      receiverName: z.string().trim().min(1).max(120),
      receiverPhone: z.string().trim().regex(/^0\d{9,10}$/, "SĐT không hợp lệ"),
      receiverAddress: z.string().trim().min(5).max(500),
      moneyCollection: z.number().int().min(0).max(100_000_000),
      note: z.string().trim().max(300).default(""),
    })
    .optional(),
});

function toView(r: typeof schema.carrierActionRequests.$inferSelect): CarrierRequestView {
  return { id: r.id, actionKey: r.actionKey as CarrierActionKey, status: r.status as CarrierRequestStatus, at: r.createdAt, error: r.error, note: r.note, actor: r.actorEmail };
}

export async function requestCarrierAction(user: CareActor, input: z.input<typeof requestSchema>): Promise<Result<{ request: CarrierRequestView; message: string }>> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, actionKey, note, edit } = parsed.data;
  if (actionKey === "edit" && !edit) return { error: "Thiếu thông tin người nhận" };
  const db = await getDb();
  const s = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, vtpOrderNumber: true, trackingCode: true, stage: true, trackingCapability: true } });
  if (!s) return { error: "Không tìm thấy vận đơn" };
  const number = s.vtpOrderNumber ?? s.trackingCode;
  if (!number) return { error: "Vận đơn chưa có mã Viettel Post" };
  if (!carrierActionAllowed(actionKey, s.stage)) return { error: `“${CARRIER_ACTION_LABEL[actionKey]}” không áp dụng cho kiện đang ở chặng ${s.stage}` };

  const actor = user.email;
  const payload = actionKey === "edit" ? { ...edit } : { type: VTP_ORDER_ACTIONS.find((a) => a.key === actionKey)?.type ?? null, note };
  // Idempotent theo kiện + hành động + nội dung + ngày: bấm hai lần không gửi hai yêu cầu.
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `${shipmentId}:${actionKey}:${day}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
  const existing = await db.query.carrierActionRequests.findFirst({ where: eq(schema.carrierActionRequests.idempotencyKey, idempotencyKey) });
  if (existing && !["FAILED", "UNSUPPORTED"].includes(existing.status)) {
    return { ok: true, data: { request: toView(existing), message: "Yêu cầu này đã được gửi trước đó — không gửi lại." } };
  }

  const client = getViettelPostClient();
  const configured = client.configured;
  const capable = configured && s.trackingCapability === "API_TRACKABLE";
  if (!capable) {
    const [row] = await db
      .insert(schema.carrierActionRequests)
      .values({
        shipmentId,
        orderNumber: number,
        actionKey,
        status: "MANUAL_REQUIRED",
        idempotencyKey: existing ? `${idempotencyKey}:${Date.now()}` : idempotencyKey,
        payload,
        error: configured ? "Tài khoản API Viettel Post của ERP không sở hữu vận đơn này (vận đơn Pancake tạo)." : "ERP chưa cấu hình tài khoản API Viettel Post.",
        actorId: user.id,
        actorEmail: actor,
        note,
        finishedAt: new Date(),
      })
      .returning();
    await audit({ userId: user.id, userEmail: actor, action: "carrier.request", entity: "SHIPMENT", entityId: shipmentId, after: { actionKey, status: "MANUAL_REQUIRED", number, payload }, reason: row.error ?? undefined });
    clearMemo();
    return { ok: true, data: { request: toView(row), message: `PHẢI LÀM TAY: ${row.error} Làm trên viettelpost.vn rồi bấm “Đã làm tay” để ghi lại.` } };
  }

  const [pendingRow] = await db
    .insert(schema.carrierActionRequests)
    .values({ shipmentId, orderNumber: number, actionKey, status: "PENDING", idempotencyKey: existing ? `${idempotencyKey}:${Date.now()}` : idempotencyKey, payload, actorId: user.id, actorEmail: actor, note })
    .returning();
  await audit({ userId: user.id, userEmail: actor, action: "carrier.request", entity: "SHIPMENT", entityId: shipmentId, after: { actionKey, status: "PENDING", number, payload } });

  const sentAt = new Date();
  await db.update(schema.carrierActionRequests).set({ status: "SENT", sentAt }).where(eq(schema.carrierActionRequests.id, pendingRow.id));
  try {
    const res =
      actionKey === "edit"
        ? await client.editOrder(number, edit!)
        : await client.updateOrder(number, VTP_ORDER_ACTIONS.find((a) => a.key === actionKey)!.type, note || `${CARRIER_ACTION_LABEL[actionKey]} từ ERP bởi ${user.name || actor}`);
    const [ack] = await db
      .update(schema.carrierActionRequests)
      .set({ status: "ACK", ackAt: new Date(), response: { message: res.message ?? null, status: res.status ?? null, data: res.data ?? null } })
      .where(eq(schema.carrierActionRequests.id, pendingRow.id))
      .returning();
    await db.insert(schema.shipmentEvents).values({ shipmentId, source: "MANUAL", status: `ERP · ${CARRIER_ACTION_LABEL[actionKey]}`, statusName: `ERP · ${CARRIER_ACTION_LABEL[actionKey]}`, note: `${user.name || actor}${note ? `: ${note}` : ""} · VTP: ${res.message || "OK"}`, occurredAt: new Date() }).onConflictDoNothing();
    await audit({ userId: user.id, userEmail: actor, action: "carrier.request.result", entity: "SHIPMENT", entityId: shipmentId, after: { requestId: ack.id, status: "ACK", response: res.message ?? null } });
    // Tra lại ngay để sự kiện xác nhận (nếu có) chuyển ACK → SUCCESS.
    await syncViettelPostShipments({ trigger: "MANUAL", actor, shipmentIds: [shipmentId], includeFinal: true }).catch(() => undefined);
    clearMemo();
    const after = (await db.query.carrierActionRequests.findFirst({ where: eq(schema.carrierActionRequests.id, ack.id) })) ?? ack;
    return { ok: true, data: { request: toView(after), message: `Viettel Post đã nhận yêu cầu “${CARRIER_ACTION_LABEL[actionKey]}” cho ${number}${res.message ? ` · ${res.message}` : ""}. Chờ sự kiện hành trình xác nhận.` } };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const unsupported = /quy[eề]n|permission|không tồn tại|not exist|not support|không hỗ trợ/i.test(message);
    const [failed] = await db
      .update(schema.carrierActionRequests)
      .set({ status: unsupported ? "UNSUPPORTED" : "FAILED", error: message, finishedAt: new Date() })
      .where(eq(schema.carrierActionRequests.id, pendingRow.id))
      .returning();
    await audit({ userId: user.id, userEmail: actor, action: "carrier.request.result", entity: "SHIPMENT", entityId: shipmentId, after: { requestId: failed.id, status: failed.status, error: message } });
    clearMemo();
    return { error: unsupported ? `Viettel Post không cho tài khoản này thao tác kiện (${message}). Phải làm tay trên viettelpost.vn.` : `Viettel Post từ chối: ${message}` };
  }
}

export const manualSchema = z.object({ requestId: z.string().min(1), note: z.string().trim().max(300).default("") });

/** Người xác nhận đã làm tay trên viettelpost.vn — ghi lại để lịch sử không trống, KHÔNG suy ra thành công. */
export async function markCarrierManualDone(user: CareActor, input: z.input<typeof manualSchema>): Promise<Result<CarrierRequestView>> {
  const parsed = manualSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const [row] = await db
    .update(schema.carrierActionRequests)
    .set({ status: "MANUAL_DONE", finishedAt: new Date(), note: parsed.data.note || undefined })
    .where(and(eq(schema.carrierActionRequests.id, parsed.data.requestId), inArray(schema.carrierActionRequests.status, ["MANUAL_REQUIRED"])))
    .returning();
  if (!row) return { error: "Yêu cầu không ở trạng thái phải làm tay" };
  await db.insert(schema.shipmentEvents).values({ shipmentId: row.shipmentId, source: "MANUAL", status: `ERP · ${CARRIER_ACTION_LABEL[row.actionKey as CarrierActionKey]} (làm tay)`, statusName: `ERP · ${CARRIER_ACTION_LABEL[row.actionKey as CarrierActionKey]} (làm tay)`, note: `${user.name || user.email}${parsed.data.note ? `: ${parsed.data.note}` : ""}`, occurredAt: new Date() }).onConflictDoNothing();
  await audit({ userId: user.id, userEmail: user.email, action: "carrier.manual", entity: "SHIPMENT", entityId: row.shipmentId, after: { requestId: row.id, actionKey: row.actionKey, note: parsed.data.note } });
  clearMemo();
  return { ok: true, data: toView(row) };
}
