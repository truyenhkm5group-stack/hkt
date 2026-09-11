import { and, desc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { clearMemo } from "@/lib/cache";
import { slaOf } from "@/lib/care/view";
import {
  CARE_STATUSES,
  CARE_TERMINAL_STATUSES,
  CARRIER_ACTION_KEYS,
  CARRIER_ACTION_LABEL,
  canTransition,
  carrierActionAllowed,
  type CareEventAction,
  type CareEventSource,
  type CareStatus,
  type CarrierActionKey,
  type CarrierRequestStatus,
} from "@/lib/constants/care";
import { CARE_ACTION_KINDS, type CareActionKind } from "@/lib/constants/delivery-tower";
import { IntegrationError } from "@/lib/integrations/http";
import { getViettelPostClient, VTP_ORDER_ACTIONS } from "@/lib/integrations/viettelpost/client";
import { syncViettelPostShipments } from "@/lib/integrations/viettelpost/sync";
import type { CareState, CarrierRequestView } from "@/lib/care/contracts";

/**
 * ═══════════ NGHIỆP VỤ CARE ENGINE (không phụ thuộc phiên đăng nhập) ═══════════
 *
 * Server Action (`lib/actions/care-workbench.ts`) và AI tools (`lib/ai/*`) chỉ kiểm quyền rồi gọi
 * vào đây với một `actor`. Ba luật không đổi:
 *  1. KHÔNG hàm nào chạm `shipments.stage` — chiều ĐVVC là chứng từ.
 *  2. MỌI thay đổi ghi một dòng `care_case_events` (chỉ thêm) + `audit_logs`. Không sửa lịch sử.
 *  3. Đổi trạng thái chỉ đi theo `CARE_TRANSITIONS`; RESOLVED / CANCELLED chỉ mở lại bằng `reopenCase`.
 */

export type CareActor = { id: string | null; email: string; name?: string | null; source?: CareEventSource };
export type Result<T> = { ok: true; data: T } | { error: string };

type CareRow = typeof schema.shipmentCare.$inferSelect;

const EMPTY: CareState = { status: "NEW", owner: null, followUpAt: null, lastNote: "", lastNoteAt: null, lastNoteBy: "", firstResponseAt: null, doneAt: null, reopenCount: 0, updatedAt: null, updatedBy: "" };

export async function loadCareState(shipmentId: string): Promise<CareState> {
  const db = await getDb();
  const [r] = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  if (!r) return EMPTY;
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

/** Bảo đảm có dòng care cho kiện; trả về dòng HIỆN TẠI (trước khi đổi). `null` = kiện không tồn tại. */
async function ensureCareRow(shipmentId: string, actor: string): Promise<CareRow | null> {
  const db = await getDb();
  const [s] = await db.select({ id: schema.shipments.id }).from(schema.shipments).where(eq(schema.shipments.id, shipmentId));
  if (!s) return null;
  await db.insert(schema.shipmentCare).values({ shipmentId, updatedBy: actor }).onConflictDoNothing();
  const [row] = await db.select().from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, shipmentId));
  return row ?? null;
}

/** Mốc kiện vào điều kiện cần care — dùng để chụp SLA vào sự kiện. Lần giao hụt gần nhất, rồi tin cuối, rồi lúc mở case. */
async function queueSinceOf(shipmentId: string, fallback: Date): Promise<Date> {
  const db = await getDb();
  const [f] = await db
    .select({ at: schema.shipmentEvents.occurredAt })
    .from(schema.shipmentEvents)
    .where(and(eq(schema.shipmentEvents.shipmentId, shipmentId), eq(schema.shipmentEvents.normalizedStage, "DELIVERY_FAILED")))
    .orderBy(desc(schema.shipmentEvents.occurredAt))
    .limit(1);
  if (f?.at) return f.at;
  const [l] = await db.select({ at: schema.shipmentEvents.occurredAt }).from(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, shipmentId)).orderBy(desc(schema.shipmentEvents.occurredAt)).limit(1);
  return l?.at ?? fallback;
}

/** MỘT chỗ ghi lịch sử: sự kiện case (chỉ thêm) + nhật ký hệ thống. */
async function recordCareEvent(
  user: CareActor,
  before: CareRow,
  input: { action: CareEventAction; note?: string; nextStatus?: CareStatus | null; nextOwner?: string | null; followUpAt?: Date | null; payload?: unknown; reason?: string },
) {
  const db = await getDb();
  const now = new Date();
  const queueSince = await queueSinceOf(before.shipmentId, before.createdAt);
  const sla = slaOf(queueSince, { status: before.careStatus as CareStatus, followUpAt: before.followUpAt, doneAt: before.doneAt, firstResponseAt: before.firstResponseAt }, now);
  await db.insert(schema.careCaseEvents).values({
    shipmentId: before.shipmentId,
    actorId: user.id,
    actorEmail: user.email,
    source: user.source ?? "UI",
    action: input.action,
    note: input.note ?? "",
    previousStatus: before.careStatus,
    nextStatus: input.nextStatus === undefined ? before.careStatus : input.nextStatus,
    previousOwner: before.ownerEmail || null,
    nextOwner: input.nextOwner === undefined ? before.ownerEmail || null : input.nextOwner,
    followUpAt: input.followUpAt === undefined ? before.followUpAt : input.followUpAt,
    sla: { queueSince: queueSince.toISOString(), firstResponseDueAt: sla.firstResponseDueAt.toISOString(), resolveDueAt: sla.resolveDueAt.toISOString(), firstResponseBreached: sla.firstResponseBreached, resolveBreached: sla.resolveBreached },
    payload: input.payload ?? null,
  });
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: `care.${input.action.toLowerCase()}`,
    entity: "SHIPMENT",
    entityId: before.shipmentId,
    before: { careStatus: before.careStatus, owner: before.ownerEmail || null, followUpAt: before.followUpAt },
    after: { careStatus: input.nextStatus ?? before.careStatus, owner: input.nextOwner === undefined ? before.ownerEmail || null : input.nextOwner, followUpAt: input.followUpAt === undefined ? before.followUpAt : input.followUpAt, note: input.note ?? "" },
    reason: input.reason,
  });
}

function firstResponse(row: CareRow, now: Date) {
  return row.firstResponseAt ?? now;
}

// ───────────────────────────── ĐỔI TRẠNG THÁI ─────────────────────────────

export const statusSchema = z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(200), status: z.enum(CARE_STATUSES), note: z.string().trim().max(500).default("") });

/**
 * Đổi trạng thái theo bảng chuyển. Kiện không đổi được (đi sai đường) thì bị bỏ qua và nêu tên trong
 * `skipped` — hàng loạt không được vì một kiện mà hỏng cả mẻ. Vào RESOLVED / CANCELLED ở đây chỉ
 * được từ trạng thái mở; mở lại phải qua `reopenCase`.
 */
export async function setCareStatus(user: CareActor, input: z.input<typeof statusSchema>): Promise<Result<{ states: Record<string, CareState>; skipped: { shipmentId: string; reason: string }[] }>> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, status, note } = parsed.data;
  const db = await getDb();
  const now = new Date();
  const states: Record<string, CareState> = {};
  const skipped: { shipmentId: string; reason: string }[] = [];
  for (const shipmentId of [...new Set(shipmentIds)]) {
    const before = await ensureCareRow(shipmentId, user.email);
    if (!before) {
      skipped.push({ shipmentId, reason: "Không tìm thấy vận đơn" });
      continue;
    }
    const from = before.careStatus as CareStatus;
    if (from === status && !note) {
      states[shipmentId] = await loadCareState(shipmentId);
      continue;
    }
    if (!canTransition(from, status)) {
      skipped.push({ shipmentId, reason: `Không chuyển được từ ${from} sang ${status}${CARE_TERMINAL_STATUSES.includes(from) ? " — case đã đóng, dùng mở lại" : ""}` });
      continue;
    }
    const terminal = CARE_TERMINAL_STATUSES.includes(status);
    await db
      .update(schema.shipmentCare)
      .set({
        careStatus: status,
        firstResponseAt: firstResponse(before, now),
        doneAt: terminal ? now : before.doneAt,
        escalatedAt: status === "ESCALATED" ? now : before.escalatedAt,
        followUpAt: terminal ? null : before.followUpAt,
        ...(note ? { lastNote: note, lastNoteAt: now, lastNoteBy: user.email } : {}),
        updatedBy: user.email,
        updatedAt: now,
      })
      .where(eq(schema.shipmentCare.shipmentId, shipmentId));
    if (note) await db.insert(schema.careActions).values({ shipmentId, actorId: user.id, actorEmail: user.email, kind: "OTHER", note, stageAtAction: "" });
    await recordCareEvent(user, before, { action: status === "RESOLVED" ? "RESOLVE" : status === "CANCELLED" ? "CANCEL" : "STATUS", note, nextStatus: status, followUpAt: terminal ? null : undefined });
    states[shipmentId] = await loadCareState(shipmentId);
  }
  clearMemo();
  return { ok: true, data: { states, skipped } };
}

export const reopenSchema = z.object({ shipmentId: z.string().min(1), note: z.string().trim().max(500).default("") });

/** Mở lại case đã đóng: về ASSIGNED nếu còn người, không thì NEW; đếm một lần mở lại. */
export async function reopenCase(user: CareActor, input: z.input<typeof reopenSchema>): Promise<Result<CareState>> {
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, note } = parsed.data;
  const db = await getDb();
  const before = await ensureCareRow(shipmentId, user.email);
  if (!before) return { error: "Không tìm thấy vận đơn" };
  if (!CARE_TERMINAL_STATUSES.includes(before.careStatus as CareStatus)) return { error: "Case chưa đóng — không có gì để mở lại" };
  const next: CareStatus = before.ownerId ? "ASSIGNED" : "NEW";
  const now = new Date();
  await db
    .update(schema.shipmentCare)
    .set({ careStatus: next, reopenCount: before.reopenCount + 1, doneAt: before.doneAt, ...(note ? { lastNote: note, lastNoteAt: now, lastNoteBy: user.email } : {}), updatedBy: user.email, updatedAt: now })
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  await recordCareEvent(user, before, { action: "REOPEN", note, nextStatus: next, reason: "Mở lại case đã đóng" });
  clearMemo();
  return { ok: true, data: await loadCareState(shipmentId) };
}

// ───────────────────────────── GIAO NGƯỜI ─────────────────────────────

export const ownerSchema = z.object({ shipmentIds: z.array(z.string().min(1)).min(1).max(200), ownerId: z.string().nullable() });

export async function setCareOwner(user: CareActor, input: z.input<typeof ownerSchema>): Promise<Result<{ states: Record<string, CareState>; skipped: { shipmentId: string; reason: string }[] }>> {
  const parsed = ownerSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, ownerId } = parsed.data;
  const db = await getDb();
  const owner = ownerId ? await db.query.users.findFirst({ where: eq(schema.users.id, ownerId), columns: { id: true, email: true, name: true } }) : null;
  if (ownerId && !owner) return { error: "Không tìm thấy người nhận việc" };
  const now = new Date();
  const states: Record<string, CareState> = {};
  const skipped: { shipmentId: string; reason: string }[] = [];
  for (const shipmentId of [...new Set(shipmentIds)]) {
    const before = await ensureCareRow(shipmentId, user.email);
    if (!before) {
      skipped.push({ shipmentId, reason: "Không tìm thấy vận đơn" });
      continue;
    }
    const from = before.careStatus as CareStatus;
    // Giao người cho case mới ⇒ ASSIGNED; bỏ người khỏi case ASSIGNED ⇒ NEW. Các trạng thái khác giữ nguyên.
    const next: CareStatus = from === "NEW" && owner ? "ASSIGNED" : from === "ASSIGNED" && !owner ? "NEW" : from;
    await db
      .update(schema.shipmentCare)
      .set({ ownerId: owner?.id ?? null, ownerEmail: owner?.email ?? "", careStatus: next, firstResponseAt: firstResponse(before, now), updatedBy: user.email, updatedAt: now })
      .where(eq(schema.shipmentCare.shipmentId, shipmentId));
    await recordCareEvent(user, before, { action: "ASSIGN", nextStatus: next, nextOwner: owner?.email ?? null, payload: { ownerId: owner?.id ?? null, ownerName: owner?.name ?? null } });
    states[shipmentId] = await loadCareState(shipmentId);
  }
  clearMemo();
  return { ok: true, data: { states, skipped } };
}

// ───────────────────────────── HẸN THEO DÕI ─────────────────────────────

export const followUpSchema = z.object({
  shipmentId: z.string().min(1),
  at: z.coerce.date().nullable(),
  /** Đang chờ AI? Chờ ĐVVC? Mặc định chờ khách. */
  waitingFor: z.enum(["WAITING_CUSTOMER", "WAITING_CARRIER", "WAITING_REDELIVERY"]).default("WAITING_CUSTOMER"),
});

export async function setCareFollowUp(user: CareActor, input: z.input<typeof followUpSchema>): Promise<Result<CareState>> {
  const parsed = followUpSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, at, waitingFor } = parsed.data;
  const db = await getDb();
  const before = await ensureCareRow(shipmentId, user.email);
  if (!before) return { error: "Không tìm thấy vận đơn" };
  const from = before.careStatus as CareStatus;
  // Hẹn theo dõi = đã làm phần mình, đang chờ — trừ khi case đã escalate / đã đóng.
  const next: CareStatus = at && ["NEW", "ASSIGNED", "IN_PROGRESS"].includes(from) ? waitingFor : from;
  const now = new Date();
  await db
    .update(schema.shipmentCare)
    .set({ followUpAt: at, careStatus: next, firstResponseAt: firstResponse(before, now), updatedBy: user.email, updatedAt: now })
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  await recordCareEvent(user, before, { action: "FOLLOW_UP", nextStatus: next, followUpAt: at });
  clearMemo();
  return { ok: true, data: await loadCareState(shipmentId) };
}

// ───────────────────────────── NOTE NHANH ─────────────────────────────

export const noteSchema = z.object({ shipmentId: z.string().min(1), note: z.string().trim().min(1, "Nhập nội dung").max(500), kind: z.enum(CARE_ACTION_KINDS).default("OTHER") });

/** Note nhanh = một hành động care (có ảnh chụp bối cảnh) + note gần nhất trên dòng + một sự kiện case. */
export async function addCareNote(user: CareActor, input: z.input<typeof noteSchema>): Promise<Result<CareState>> {
  const parsed = noteSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, note, kind } = parsed.data;
  const db = await getDb();
  const before = await ensureCareRow(shipmentId, user.email);
  if (!before) return { error: "Không tìm thấy vận đơn" };
  const now = new Date();
  const [s] = await db.select({ stage: schema.shipments.stage, cod: schema.shipments.codAmount, orderId: schema.shipments.orderId }).from(schema.shipments).where(eq(schema.shipments.id, shipmentId));
  await db.insert(schema.careActions).values({ shipmentId, orderId: s?.orderId ?? null, actorId: user.id, actorEmail: user.email, kind: kind as CareActionKind, note, stageAtAction: s?.stage ?? "", codAtAction: s?.cod ?? null });
  const from = before.careStatus as CareStatus;
  const next: CareStatus = from === "NEW" || from === "ASSIGNED" ? "IN_PROGRESS" : from;
  await db
    .update(schema.shipmentCare)
    .set({ lastNote: note, lastNoteAt: now, lastNoteBy: user.email, careStatus: next, firstResponseAt: firstResponse(before, now), updatedBy: user.email, updatedAt: now })
    .where(eq(schema.shipmentCare.shipmentId, shipmentId));
  await recordCareEvent(user, before, { action: "NOTE", note, nextStatus: next, payload: { kind } });
  clearMemo();
  return { ok: true, data: await loadCareState(shipmentId) };
}

// ───────────────────────────── YÊU CẦU GỬI ĐVVC ─────────────────────────────

/**
 * Vòng đời: PENDING → SENT → ACKNOWLEDGED (API nhận) → SUCCESS khi sự kiện hành trình xác nhận
 * (`settleCarrierRequests`) | FAILED | UNSUPPORTED. Tài khoản API không có quyền trên kiện
 * (`tracking_capability` ≠ API_TRACKABLE) ⇒ MANUAL_REQUIRED: ghi lại yêu cầu, nói thẳng phải làm
 * tay, KHÔNG giả vờ gửi. Retry hữu hạn (`CARRIER_MAX_ATTEMPTS`) chỉ cho lỗi tạm thời (mạng / 5xx).
 * Không hành động nào ở đây tự đổi trạng thái care.
 */
const CARRIER_MAX_ATTEMPTS = 3;

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
  return { id: r.id, actionKey: r.actionKey as CarrierActionKey, status: r.status as CarrierRequestStatus, at: r.createdAt, error: r.error, note: r.note, actor: r.actorEmail, attempts: r.attempts };
}

async function sleep(ms: number) {
  await new Promise((r) => setTimeout(r, ms));
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

  const careRow = await ensureCareRow(shipmentId, user.email);
  const vtpType = VTP_ORDER_ACTIONS.find((a) => a.key === actionKey)?.type ?? null;
  const payload = actionKey === "edit" ? { ...edit } : { type: vtpType, note };
  // Idempotent theo kiện + hành động + nội dung + ngày: bấm hai lần không gửi hai yêu cầu.
  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `${shipmentId}:${actionKey}:${day}:${createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16)}`;
  const existing = await db.query.carrierActionRequests.findFirst({ where: eq(schema.carrierActionRequests.idempotencyKey, idempotencyKey) });
  if (existing && !["FAILED", "UNSUPPORTED"].includes(existing.status)) {
    return { ok: true, data: { request: toView(existing), message: "Yêu cầu này đã được gửi trước đó — không gửi lại." } };
  }
  const key = existing ? `${idempotencyKey}:${Date.now()}` : idempotencyKey;

  const client = getViettelPostClient();
  const configured = client.configured;
  const capable = configured && s.trackingCapability === "API_TRACKABLE";
  if (!capable) {
    const error = configured ? "Tài khoản API Viettel Post của ERP không sở hữu vận đơn này (vận đơn Pancake tạo)." : "ERP chưa cấu hình tài khoản API Viettel Post.";
    const [row] = await db
      .insert(schema.carrierActionRequests)
      .values({ shipmentId, orderNumber: number, actionKey, status: "MANUAL_REQUIRED", idempotencyKey: key, payload, error, actorId: user.id, actorEmail: user.email, note, finishedAt: new Date() })
      .returning();
    if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_REQUEST", note, payload: { requestId: row.id, actionKey, status: "MANUAL_REQUIRED" }, reason: error });
    clearMemo();
    return { ok: true, data: { request: toView(row), message: `PHẢI LÀM TAY: ${error} Làm trên viettelpost.vn rồi bấm “Đã làm tay” để ghi lại.` } };
  }

  const rawRequest =
    actionKey === "edit"
      ? { endpoint: "order/edit", body: { ORDER_NUMBER: number, RECEIVER_FULLNAME: edit!.receiverName, RECEIVER_PHONE: edit!.receiverPhone, RECEIVER_ADDRESS: edit!.receiverAddress, MONEY_COLLECTION: edit!.moneyCollection, ORDER_NOTE: edit!.note } }
      : { endpoint: "order/UpdateOrder", body: { TYPE: vtpType, ORDER_NUMBER: number, NOTE: note || `${CARRIER_ACTION_LABEL[actionKey]} từ ERP bởi ${user.name || user.email}` } };
  const [pendingRow] = await db
    .insert(schema.carrierActionRequests)
    .values({ shipmentId, orderNumber: number, actionKey, status: "PENDING", idempotencyKey: key, payload, rawRequest, actorId: user.id, actorEmail: user.email, note })
    .returning();
  if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_REQUEST", note, payload: { requestId: pendingRow.id, actionKey, status: "PENDING" } });

  let attempts = 0;
  let lastError: unknown = null;
  while (attempts < CARRIER_MAX_ATTEMPTS) {
    attempts += 1;
    const sentAt = new Date();
    await db.update(schema.carrierActionRequests).set({ status: "SENT", sentAt, attempts }).where(eq(schema.carrierActionRequests.id, pendingRow.id));
    try {
      const res = actionKey === "edit" ? await client.editOrder(number, edit!) : await client.updateOrder(number, vtpType as NonNullable<typeof vtpType>, String(rawRequest.body.NOTE ?? ""));
      const [ack] = await db
        .update(schema.carrierActionRequests)
        .set({ status: "ACKNOWLEDGED", ackAt: new Date(), response: { message: res.message ?? null, status: res.status ?? null, data: res.data ?? null } })
        .where(eq(schema.carrierActionRequests.id, pendingRow.id))
        .returning();
      await db
        .insert(schema.shipmentEvents)
        .values({ shipmentId, source: "MANUAL", status: `ERP · ${CARRIER_ACTION_LABEL[actionKey]}`, statusName: `ERP · ${CARRIER_ACTION_LABEL[actionKey]}`, note: `${user.name || user.email}${note ? `: ${note}` : ""} · VTP: ${res.message || "OK"}`, occurredAt: new Date() })
        .onConflictDoNothing();
      if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_RESULT", payload: { requestId: ack.id, actionKey, status: "ACKNOWLEDGED", response: res.message ?? null, attempts } });
      // Tra lại ngay để sự kiện xác nhận (nếu có) chuyển ACKNOWLEDGED → SUCCESS.
      await syncViettelPostShipments({ trigger: "MANUAL", actor: user.email, shipmentIds: [shipmentId], includeFinal: true }).catch(() => undefined);
      clearMemo();
      const after = (await db.query.carrierActionRequests.findFirst({ where: eq(schema.carrierActionRequests.id, ack.id) })) ?? ack;
      return { ok: true, data: { request: toView(after), message: `Viettel Post đã nhận yêu cầu “${CARRIER_ACTION_LABEL[actionKey]}” cho ${number}${res.message ? ` · ${res.message}` : ""}. Chờ sự kiện hành trình xác nhận.` } };
    } catch (e) {
      lastError = e;
      const transient = e instanceof IntegrationError ? e.retryable || e.status >= 500 : !(e instanceof Error) || /ECONN|ETIMEDOUT|fetch failed|network/i.test(e.message);
      if (!transient || attempts >= CARRIER_MAX_ATTEMPTS) break;
      await sleep(300 * attempts);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  const unsupported = /quy[eề]n|permission|không tồn tại|not exist|not support|không hỗ trợ/i.test(message);
  const [failed] = await db
    .update(schema.carrierActionRequests)
    .set({ status: unsupported ? "UNSUPPORTED" : "FAILED", error: message, attempts, finishedAt: new Date() })
    .where(eq(schema.carrierActionRequests.id, pendingRow.id))
    .returning();
  if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_RESULT", payload: { requestId: failed.id, actionKey, status: failed.status, error: message, attempts } });
  clearMemo();
  return { error: unsupported ? `Viettel Post không cho tài khoản này thao tác kiện (${message}). Phải làm tay trên viettelpost.vn.` : `Viettel Post từ chối sau ${attempts} lần gửi: ${message}` };
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
  const label = CARRIER_ACTION_LABEL[row.actionKey as CarrierActionKey];
  await db.insert(schema.shipmentEvents).values({ shipmentId: row.shipmentId, source: "MANUAL", status: `ERP · ${label} (làm tay)`, statusName: `ERP · ${label} (làm tay)`, note: `${user.name || user.email}${parsed.data.note ? `: ${parsed.data.note}` : ""}`, occurredAt: new Date() }).onConflictDoNothing();
  const careRow = await ensureCareRow(row.shipmentId, user.email);
  if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_MANUAL", note: parsed.data.note, payload: { requestId: row.id, actionKey: row.actionKey } });
  clearMemo();
  return { ok: true, data: toView(row) };
}
