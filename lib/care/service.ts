import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { clearMemo } from "@/lib/cache";
import { canRequestCarrierAction } from "@/lib/care/redelivery-eligibility";
import { careSlaHours } from "@/lib/care/sla";
import { carrierSubstate } from "@/lib/constants/carrier-substate";
import { ACTION_CALLS_CARRIER, BUSINESS_ACTIONS, BUSINESS_ACTION_LABEL } from "@/lib/constants/care-outcome";
import { NOT_CARE_CONDITION } from "@/lib/care/lifecycle";
import { slaOf } from "@/lib/care/view";
import {
  CARE_STATUSES,
  CARE_TERMINAL_STATUSES,
  CARE_WAITING_STATUSES,
  CARRIER_ACTION_KEYS,
  CARRIER_ACTION_LABEL,
  canTransition,
  CARE_FOLLOW_UP_DEFAULT_HOURS,
  defaultFollowUpAt,
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

/**
 * Trạng thái care của một kiện để trả về màn hình sau mỗi thao tác: đợt ĐANG MỞ, hoặc — khi không
 * còn đợt nào mở — đợt GẦN NHẤT (vừa đóng). Người vừa bấm "Đã xong" phải thấy dòng đổi thành "Đã
 * xong", không phải thấy một ca NEW trống.
 */
export async function loadCareState(shipmentId: string): Promise<CareState> {
  const db = await getDb();
  const [r] = await db
    .select({ care: schema.shipmentCare, ownerName: schema.users.name })
    .from(schema.shipmentCare)
    .leftJoin(schema.users, eq(schema.users.id, schema.shipmentCare.ownerId))
    .where(eq(schema.shipmentCare.shipmentId, shipmentId))
    .orderBy(desc(schema.shipmentCare.active), desc(schema.shipmentCare.episodeNo))
    .limit(1);
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
/**
 * ĐỢT CHĂM SÓC ĐANG MỞ của một kiện — mở mới nếu chưa có.
 *
 * ─── VÌ SAO HÀM NÀY PHẢI ĐỔI Ở BẢN NÀY ───
 *
 * Trước migration 0075 một kiện có ĐÚNG MỘT dòng care, nên `select … where shipment_id = …` rồi
 * lấy `[0]` luôn đúng. Nay một kiện có nhiều ĐỢT, và lấy dòng đầu tiên theo thứ tự Postgres trả về
 * là lấy một đợt bất kỳ — có thể là đợt đã đóng từ tháng trước. Mọi thao tác sau đó sẽ ghi vào
 * đúng đợt sai đó, im lặng.
 *
 * Nên ở đây lấy ĐÚNG đợt đang mở. Không có đợt nào đang mở thì:
 *   · đợt gần nhất do NGƯỜI hoặc MÁY đã đóng ⇒ trả về đợt đó — người ghi chú / hẹn lên một ca đã
 *     đóng thì ghi lên chính ca đó, còn đổi trạng thái thường thì bị bảng chuyển từ chối ("dùng mở
 *     lại"); KHÔNG lặng lẽ mở đợt mới thay họ;
 *   · chưa từng có đợt nào ⇒ mở đợt mới (MANUAL) và đánh số tiếp.
 */
async function ensureCareRow(shipmentId: string, actor: string): Promise<CareRow | null> {
  const db = await getDb();
  const [s] = await db
    .select({ id: schema.shipments.id, orderId: schema.shipments.orderId, vtpOrderNumber: schema.shipments.vtpOrderNumber, trackingCode: schema.shipments.trackingCode, stage: schema.shipments.stage, vtpStatus: schema.shipments.vtpStatus, vtpStatusName: schema.shipments.vtpStatusName })
    .from(schema.shipments)
    .where(eq(schema.shipments.id, shipmentId));
  if (!s) return null;

  const dangMo = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, shipmentId), eq(schema.shipmentCare.active, true)) });
  if (dangMo) return dangMo;
  const ganNhat = await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, shipmentId), orderBy: [desc(schema.shipmentCare.episodeNo)] });
  if (ganNhat && CARE_TERMINAL_STATUSES.includes(ganNhat.careStatus as CareStatus)) return ganNhat;

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, shipmentId)); // ĐẾM MỌI ĐỢT, kể cả đã đóng — số đợt tiếp theo phải nối tiếp lịch sử, không đếm lại từ 1.
  const { substate } = carrierSubstate({ code: s.vtpStatus, text: s.vtpStatusName, stage: s.stage });
  await db
    .insert(schema.shipmentCare)
    .values({
      shipmentId,
      orderId: s.orderId,
      trackingNumber: s.vtpOrderNumber ?? s.trackingCode,
      episodeNo: Number(n ?? 0) + 1,
      active: true,
      entryCarrierState: substate,
      // NGƯỜI mở, không phải sự kiện ĐVVC — ghi rõ để báo cáo phân biệt được hai nguồn.
      sourceTrigger: "MANUAL",
      openedAt: new Date(),
      careOutcome: "PENDING",
      updatedBy: actor,
    })
    // Chỉ mục duy nhất từng phần chặn đợt thứ hai. Thua cuộc đua thì đọc lại đợt của người thắng.
    .onConflictDoNothing();
  const row = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, shipmentId), eq(schema.shipmentCare.active, true)) });
  return row ?? null;
}

/**
 * Mốc kiện vào điều kiện cần care — dùng để chụp SLA vào sự kiện.
 *
 * ĐỢT CÓ `opened_at` THÌ ĐÓ LÀ MỐC: nó là lúc ĐVVC báo sự cố mở đợt này (hoặc mốc trạng thái ĐVVC
 * khi đối chiếu mở), tức đúng câu hỏi "kiện chờ người từ bao giờ". Suy từ sự kiện giao hụt gần
 * nhất chỉ dành cho đợt cũ chưa có mốc — cùng thứ tự với bàn care (`care-workbench.ts`).
 */
async function queueSinceOf(shipmentId: string, fallback: Date, openedAt: Date | null = null): Promise<Date> {
  if (openedAt) return openedAt;
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
  input: { action: CareEventAction; note?: string; nextStatus?: CareStatus | null; nextOwner?: string | null; nextOwnerId?: string | null; followUpAt?: Date | null; payload?: unknown; reason?: string },
) {
  const db = await getDb();
  const now = new Date();
  const queueSince = await queueSinceOf(before.shipmentId, before.createdAt, before.openedAt);
  const sla = slaOf(queueSince, { status: before.careStatus as CareStatus, followUpAt: before.followUpAt, doneAt: before.doneAt, firstResponseAt: before.firstResponseAt }, now, await careSlaHours());
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
    /*
      CHỦ VIỆC BẰNG KHOÁ, ĐI CÙNG HAI CỘT EMAIL Ở TRÊN.

      Sổ sự kiện là thứ trả lời "ai đã cầm kiện này lúc nào". Email trả lời được cho NGƯỜI đọc,
      nhưng không quy kết được: đổi email là mất dấu, và `''` với `NULL` trông giống nhau. `NULL`
      ở đây có đúng một nghĩa: CHƯA AI NHẬN.
    */
    previousOwnerId: before.ownerId,
    nextOwnerId: input.nextOwnerId === undefined ? before.ownerId : input.nextOwnerId,
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

export const statusSchema = z
  .object({
    shipmentIds: z.array(z.string().min(1)).min(1).max(200),
    status: z.enum(CARE_STATUSES),
    note: z.string().trim().max(500).default(""),
    /** Bắt buộc khi đích là trạng thái CHỜ: một cái hẹn không có giờ không phải một cái hẹn. */
    followUpAt: z.coerce.date().optional(),
  })
  .refine((v) => !(CARE_WAITING_STATUSES as string[]).includes(v.status) || v.followUpAt instanceof Date, {
    message: `Chuyển sang trạng thái chờ phải kèm giờ xem lại — không có giờ thì ca biến mất khỏi Cần care (mặc định +${CARE_FOLLOW_UP_DEFAULT_HOURS} giờ nếu bấm nhanh)`,
    path: ["followUpAt"],
  });

/**
 * Đổi trạng thái theo bảng chuyển. Kiện không đổi được (đi sai đường) thì bị bỏ qua và nêu tên trong
 * `skipped` — hàng loạt không được vì một kiện mà hỏng cả mẻ. Vào RESOLVED / CANCELLED ở đây chỉ
 * được từ trạng thái mở; mở lại phải qua `reopenCase`.
 *
 * ĐÓNG = RỜI HÀNG ĐỢI, KHÔNG PHẢI KẾT QUẢ. Trạng thái kết thúc đi cùng `active = false` (một mệnh đề,
 * hai cột không được nói hai điều khác nhau — production 13/09/2026 có 13 đợt RESOLVED/CANCELLED mà
 * vẫn `active`). `care_outcome` vẫn PENDING: chỉ chứng từ ĐVVC mới chốt được cứu hay không, và vòng
 * đời sẽ chốt lên đúng đợt này dù nó đã đóng.
 */
export async function setCareStatus(user: CareActor, input: z.input<typeof statusSchema>): Promise<Result<{ states: Record<string, CareState>; skipped: { shipmentId: string; reason: string }[] }>> {
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, status, note, followUpAt } = parsed.data;
  const db = await getDb();
  const now = new Date();
  const states: Record<string, CareState> = {};
  const skipped: { shipmentId: string; reason: string }[] = [];
  const waiting = CARE_WAITING_STATUSES.includes(status);
  for (const shipmentId of [...new Set(shipmentIds)]) {
    const before = await ensureCareRow(shipmentId, user.email);
    if (!before) {
      skipped.push({ shipmentId, reason: "Không tìm thấy vận đơn" });
      continue;
    }
    const from = before.careStatus as CareStatus;
    if (from === status && !note && !followUpAt) {
      states[shipmentId] = await loadCareState(shipmentId);
      continue;
    }
    if (!canTransition(from, status)) {
      skipped.push({ shipmentId, reason: `Không chuyển được từ ${from} sang ${status}${CARE_TERMINAL_STATUSES.includes(from) ? " — case đã đóng, dùng mở lại" : ""}` });
      continue;
    }
    const terminal = CARE_TERMINAL_STATUSES.includes(status);
    const nextFollowUp = terminal ? null : waiting ? (followUpAt ?? before.followUpAt ?? defaultFollowUpAt(now)) : before.followUpAt;
    await db
      .update(schema.shipmentCare)
      .set({
        careStatus: status,
        active: !terminal,
        firstResponseAt: firstResponse(before, now),
        doneAt: terminal ? now : before.doneAt,
        escalatedAt: status === "ESCALATED" ? now : before.escalatedAt,
        followUpAt: nextFollowUp,
        ...(note ? { lastNote: note, lastNoteAt: now, lastNoteBy: user.email } : {}),
        updatedBy: user.email,
        updatedAt: now,
      })
      .where(eq(schema.shipmentCare.id, before.id));
    if (note) await db.insert(schema.careActions).values({ shipmentId, actorId: user.id, actorEmail: user.email, kind: "OTHER", note, stageAtAction: "" });
    await recordCareEvent(user, before, { action: status === "RESOLVED" ? "RESOLVE" : status === "CANCELLED" ? "CANCEL" : "STATUS", note, nextStatus: status, followUpAt: terminal || waiting ? nextFollowUp : undefined });
    states[shipmentId] = await loadCareState(shipmentId);
  }
  clearMemo();
  return { ok: true, data: { states, skipped } };
}

export const reopenSchema = z.object({ shipmentId: z.string().min(1), note: z.string().trim().max(500).default("") });

/**
 * Mở lại case đã đóng: KÍCH HOẠT LẠI đợt gần nhất (về ASSIGNED nếu còn người, không thì NEW), đếm
 * một lần mở lại. Không mở đợt mới — "mở lại" là tiếp tục đúng đợt đó, giữ nguyên lịch sử của nó.
 *
 * Bản trước gọi `ensureCareRow`, hàm này thấy không còn đợt đang mở nên MỞ ĐỢT MỚI (MANUAL, NEW) rồi
 * mới kiểm "đã đóng chưa" — và trả lỗi "case chưa đóng" trên chính đợt vừa tự tạo. Kết quả: không
 * bao giờ mở lại được, và mỗi lần bấm để lại một đợt rác.
 */
export async function reopenCase(user: CareActor, input: z.input<typeof reopenSchema>): Promise<Result<CareState>> {
  const parsed = reopenSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, note } = parsed.data;
  const db = await getDb();
  const before = await db.query.shipmentCare.findFirst({ where: eq(schema.shipmentCare.shipmentId, shipmentId), orderBy: [desc(schema.shipmentCare.episodeNo)] });
  if (!before) return { error: "Kiện này chưa có đợt chăm sóc nào — không có gì để mở lại" };
  if (before.active || !CARE_TERMINAL_STATUSES.includes(before.careStatus as CareStatus)) return { error: "Case chưa đóng — không có gì để mở lại" };
  const next: CareStatus = before.ownerId ? "ASSIGNED" : "NEW";
  const now = new Date();
  const [row] = await db
    .update(schema.shipmentCare)
    .set({
      active: true,
      careStatus: next,
      reopenCount: before.reopenCount + 1,
      doneAt: before.doneAt,
      // Máy từng đóng vì "không phải điều kiện care" mà người mở lại ⇒ người biết hơn máy: đợt này
      // là ca thật, kết quả quay về chờ chứng từ. Quyết định khác (duyệt hoàn) giữ nguyên.
      resolution: before.resolution === NOT_CARE_CONDITION ? null : before.resolution,
      careOutcome: before.careOutcome ?? "PENDING",
      ...(note ? { lastNote: note, lastNoteAt: now, lastNoteBy: user.email } : {}),
      updatedBy: user.email,
      updatedAt: now,
    })
    // Chỉ mục duy nhất từng phần chặn nếu một đợt khác đã kịp mở — báo lỗi thay vì có hai đợt.
    .where(and(eq(schema.shipmentCare.id, before.id), eq(schema.shipmentCare.active, false)))
    .returning({ id: schema.shipmentCare.id })
    .catch(() => []);
  if (!row) return { error: "Kiện đã có đợt chăm sóc khác đang mở — làm tiếp trên đợt đó" };
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
      .set({
        ownerId: owner?.id ?? null,
        ownerEmail: owner?.email ?? "",
        careStatus: next,
        firstResponseAt: firstResponse(before, now),
        // Mốc giao và NGƯỜI ĐƯỢC GIAO ĐẦU TIÊN — ghi một lần, không viết lại khi chuyển tay (luật 34).
        assignedAt: owner ? (before.assignedAt ?? now) : before.assignedAt,
        initialOwnerId: owner ? (before.initialOwnerId ?? owner.id) : before.initialOwnerId,
        updatedBy: user.email,
        updatedAt: now,
      })
      .where(eq(schema.shipmentCare.id, before.id));
    await recordCareEvent(user, before, { action: "ASSIGN", nextStatus: next, nextOwner: owner?.email ?? null, nextOwnerId: owner?.id ?? null, payload: { ownerId: owner?.id ?? null, ownerName: owner?.name ?? null } });
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
    .where(eq(schema.shipmentCare.id, before.id));
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
    .where(eq(schema.shipmentCare.id, before.id));
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
  const s = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, vtpOrderNumber: true, trackingCode: true, stage: true, trackingCapability: true, vtpStatus: true, vtpStatusName: true } });
  if (!s) return { error: "Không tìm thấy vận đơn" };
  const number = s.vtpOrderNumber ?? s.trackingCode;
  if (!number) return { error: "Vận đơn chưa có mã Viettel Post" };

  /*
    ĐIỀU KIỆN XÉT TRÊN TRẠNG THÁI CON, KHÔNG PHẢI `stage`.

    `stage` gộp "chờ phát lại" (bưu tá sẽ quay lại) với "tồn - khách nghỉ" (chưa hẹn được) thành
    `DELIVERY_FAILED`, và gộp "chờ xử lý" của kiện đã đi nửa đường với kiện còn trong kho thành
    `PENDING`. Một luật đọc `stage` vì thế vừa cho phép nhầm, vừa chặn nhầm.

    Cùng một hàm với nút trên màn hình và với thao tác hàng loạt — xem `lib/care/redelivery-eligibility.ts`.
  */
  const duDieuKien = canRequestCarrierAction(actionKey, {
    stage: s.stage,
    vtpStatus: s.vtpStatus,
    vtpStatusName: s.vtpStatusName,
    orderNumber: number,
    trackingCapability: s.trackingCapability,
    configured: getViettelPostClient().configured,
  });
  if (!duDieuKien.ok) return { error: duDieuKien.reason };

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
  if (!duDieuKien.callsApi) {
    const error = duDieuKien.reason;
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
  /*
    LƯU ĐÚNG CÂU VIETTEL POST NÓI, không phải câu ERP dịch lại.

    `carrier.message` là lời từ chối nghiệp vụ đã tách khỏi mã HTTP (xem `loiNghiepVu` ở
    lib/integrations/http.ts). Trước đây nó bị gói vào một chuỗi "HTTP 400 …" rồi mới lưu — người
    đọc lịch sử không có cách nào tách ra được việc phải làm.
  */
  const loiDvvc = lastError instanceof IntegrationError ? lastError.carrier : undefined;
  const message = loiDvvc?.message || (lastError instanceof Error ? lastError.message : String(lastError));
  const unsupported = /quy[eề]n|permission|không tồn tại|not exist|not support|không hỗ trợ|kh[ôo]ng thu[ộo]c/i.test(message);
  const [failed] = await db
    .update(schema.carrierActionRequests)
    .set({ status: unsupported ? "UNSUPPORTED" : "FAILED", error: message, attempts, finishedAt: new Date() })
    .where(eq(schema.carrierActionRequests.id, pendingRow.id))
    .returning();
  if (careRow) await recordCareEvent(user, careRow, { action: "CARRIER_RESULT", payload: { requestId: failed.id, actionKey, status: failed.status, error: message, attempts } });
  clearMemo();
  return { error: unsupported ? `Viettel Post từ chối: ${message} — tài khoản API của ERP không thao tác được kiện này. Phải làm tay trên viettelpost.vn rồi bấm “Đã làm tay”.` : `Viettel Post từ chối: ${message} (đã gửi ${attempts} lần).` };
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

/* ═══════════════════ GỬI LỆNH ĐVVC CHO NHIỀU KIỆN MỘT LƯỢT ═══════════════════ */

export const bulkRequestSchema = z.object({
  shipmentIds: z.array(z.string().min(1)).min(1, "Chưa chọn kiện nào").max(200, "Tối đa 200 kiện một lượt"),
  actionKey: z.enum(CARRIER_ACTION_KEYS),
  note: z.string().trim().max(300).default(""),
});

export type BulkOutcome = "SUCCESS" | "MANUAL_REQUIRED" | "SKIPPED" | "FAILED";

export type BulkResultRow = {
  shipmentId: string;
  /** Mã vận đơn để người đọc đối chiếu với trang Viettel Post. */
  tracking: string;
  outcome: BulkOutcome;
  /** Lý do CỤ THỂ của chính kiện này — không phải một câu chung cho cả lượt. */
  message: string;
};

export type BulkResult = {
  rows: BulkResultRow[];
  counts: Record<BulkOutcome, number>;
};

/**
 * ═══════════ THÀNH CÔNG MỘT PHẦN LÀ KẾT QUẢ HỢP LỆ, KHÔNG PHẢI LỖI ═══════════
 *
 * Chọn 40 kiện rồi bấm "Phát tiếp": 12 kiện đủ điều kiện, 9 kiện đã giao xong từ hôm qua, 19 kiện
 * thuộc tài khoản Viettel Post khác. Một hàm "tất cả hoặc không" sẽ hoặc bỏ cả 12 kiện làm được,
 * hoặc gửi 40 lệnh trong đó 28 chắc chắn hỏng. Cả hai đều sai.
 *
 * Nên mỗi kiện đi riêng và mang KẾT QUẢ RIÊNG:
 *   · `SUCCESS`         — ĐVVC đã nhận lệnh (chưa phải "hàng đã đi tiếp" — chờ sự kiện xác nhận);
 *   · `MANUAL_REQUIRED` — không gửi API được, đã ghi vết, phải làm tay trên web;
 *   · `SKIPPED`         — không đủ điều kiện, KHÔNG gửi lệnh nào lên ĐVVC;
 *   · `FAILED`          — đã gửi và ĐVVC từ chối, kèm đúng câu ĐVVC nói.
 *
 * KIỆN KHÔNG ĐỦ ĐIỀU KIỆN KHÔNG SINH MỘT REQUEST NÀO. Điều kiện được xét TRƯỚC, bằng cùng hàm với
 * nút đơn lẻ và với màn hình — không có đường nào gửi một lệnh đã biết trước là hỏng.
 *
 * Tuần tự chứ không song song: `getViettelPostClient()` tự giới hạn nhịp gọi, và bắn 200 lệnh cùng
 * lúc lên ĐVVC là cách nhanh nhất để bị chặn.
 */
export async function bulkRequestCarrierAction(user: CareActor, input: z.input<typeof bulkRequestSchema>): Promise<Result<BulkResult>> {
  const parsed = bulkRequestSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentIds, actionKey, note } = parsed.data;
  const db = await getDb();
  const configured = getViettelPostClient().configured;

  const dsKien = await db
    .select({ id: schema.shipments.id, vtpOrderNumber: schema.shipments.vtpOrderNumber, trackingCode: schema.shipments.trackingCode, stage: schema.shipments.stage, trackingCapability: schema.shipments.trackingCapability, vtpStatus: schema.shipments.vtpStatus, vtpStatusName: schema.shipments.vtpStatusName })
    .from(schema.shipments)
    .where(inArray(schema.shipments.id, [...new Set(shipmentIds)]));
  const theoId = new Map(dsKien.map((k) => [k.id, k]));

  const rows: BulkResultRow[] = [];
  for (const id of [...new Set(shipmentIds)]) {
    const k = theoId.get(id);
    if (!k) {
      rows.push({ shipmentId: id, tracking: id, outcome: "SKIPPED", message: "Không tìm thấy vận đơn" });
      continue;
    }
    const tracking = k.vtpOrderNumber ?? k.trackingCode ?? id;
    const duDieuKien = canRequestCarrierAction(actionKey, {
      stage: k.stage,
      vtpStatus: k.vtpStatus,
      vtpStatusName: k.vtpStatusName,
      orderNumber: k.vtpOrderNumber ?? k.trackingCode,
      trackingCapability: k.trackingCapability,
      configured,
    });
    // BỎ QUA TỪ TRƯỚC — không một gói tin nào rời ERP cho kiện này.
    if (!duDieuKien.ok) {
      rows.push({ shipmentId: id, tracking, outcome: "SKIPPED", message: duDieuKien.reason });
      continue;
    }
    const r = await requestCarrierAction(user, { shipmentId: id, actionKey, note });
    if ("error" in r) {
      rows.push({ shipmentId: id, tracking, outcome: "FAILED", message: r.error });
      continue;
    }
    const manual = r.data.request.status === "MANUAL_REQUIRED";
    rows.push({ shipmentId: id, tracking, outcome: manual ? "MANUAL_REQUIRED" : "SUCCESS", message: r.data.message });
  }

  const counts: Record<BulkOutcome, number> = { SUCCESS: 0, MANUAL_REQUIRED: 0, SKIPPED: 0, FAILED: 0 };
  for (const r of rows) counts[r.outcome] += 1;
  await audit({
    userId: user.id,
    userEmail: user.email,
    action: "VTP_ORDER_ACTION_BULK",
    entity: "SHIPMENT",
    entityId: `bulk:${actionKey}:${rows.length}`,
    detail: { actionKey, note, counts, trackings: rows.map((r) => ({ tracking: r.tracking, outcome: r.outcome })) },
  });
  clearMemo();
  return { ok: true, data: { rows, counts } };
}

/* ═══════════════════ BỐN QUYẾT ĐỊNH NGHIỆP VỤ ═══════════════════ */

export const businessActionSchema = z.object({
  shipmentId: z.string().min(1),
  action: z.enum(BUSINESS_ACTIONS),
  /** Lý do theo DANH MỤC — đếm được. Bắt buộc với "Duyệt hoàn": không ai được đóng đơn mà không nói vì sao. */
  reasonCode: z.string().trim().max(60).optional(),
  note: z.string().trim().max(300).default(""),
  /** Hẹn xem lại. Bắt buộc với "Theo dõi tiếp" — hẹn mà không có giờ thì không phải một cái hẹn. */
  followUpAt: z.coerce.date().optional(),
  /** Vận đơn của đơn ĐỔI, nếu đội đã tạo. Nối ca gốc với nó để đo riêng "cứu bằng đơn đổi". */
  replacementShipmentId: z.string().min(1).optional(),
});

export type BusinessActionResult = { request: CarrierRequestView | null; care: CareState; message: string };

/**
 * ═══════════ QUYẾT ĐỊNH CỦA SHOP ≠ TRẠNG THÁI CỦA GÓI HÀNG ═══════════
 *
 * Đây là chỗ dễ sai nhất của cả module, nên nói thẳng ra bốn điều KHÔNG xảy ra ở đây:
 *
 *   · "Duyệt hoàn" KHÔNG đặt vận đơn thành `RETURNED`. Đó là quyết định của shop; hàng chỉ thành
 *     hoàn khi ĐVVC báo, và chỉ vào lại tồn khi kho lập phiếu đếm thực tế.
 *   · "Phát tiếp" KHÔNG chốt ca là đã cứu được. Lệnh được ĐVVC NHẬN không phải hàng đã tới tay
 *     khách — ca vẫn mở cho tới khi hành trình nói kết cục.
 *   · "Đổi" KHÔNG tự coi đơn thay thế là thành công. Nó chỉ NỐI ca gốc với đơn đó.
 *   · "Theo dõi tiếp" KHÔNG gửi gì đi đâu cả.
 *
 * Cái duy nhất bốn hành động này làm với chiều ĐVVC là GỬI YÊU CẦU (hai hành động đầu) và ghi lại
 * ĐVVC trả lời gì. Kết quả vẫn do `lib/care/lifecycle.ts` chốt, từ sự kiện hành trình.
 */
export async function recordBusinessAction(user: CareActor, input: z.input<typeof businessActionSchema>): Promise<Result<BusinessActionResult>> {
  const parsed = businessActionSchema.safeParse(input);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { shipmentId, action, reasonCode, note, followUpAt, replacementShipmentId } = parsed.data;

  if (action === "APPROVE_RETURN" && !reasonCode) return { error: "Chọn lý do hoàn trước khi duyệt — báo cáo lý do hoàn rỗng vĩnh viễn nếu bước này bỏ qua" };
  if (action === "CONTINUE_MONITORING" && !followUpAt) return { error: "Chọn thời điểm xem lại — hẹn mà không có giờ thì ca chìm xuống đáy hàng đợi" };
  if (action === "EXCHANGE" && !replacementShipmentId) return { error: "Chọn vận đơn của đơn đổi — không có nó thì “cứu bằng đơn đổi” không đo được, chỉ đoán được" };

  const db = await getDb();

  /*
    ĐIỀU KIỆN XÉT TRƯỚC, VÀ XÉT BẰNG CÙNG MỘT HÀM VỚI NÚT TRÊN MÀN HÌNH.

    Bản trước gọi thẳng `requestCarrierAction`; hàm đó từ chối vì SAI TRẠNG THÁI (kiện đã giao,
    chưa có mã…) nhưng chỗ này vẫn ghi quyết định, đẩy ca sang "chờ ĐVVC" và báo "Đã gửi yêu cầu".
    Một lời từ chối của CHÍNH ERP không phải một lời từ chối của ĐVVC: không có gì để ghi vào sổ.
  */
  const kien = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, shipmentId), columns: { id: true, vtpOrderNumber: true, trackingCode: true, stage: true, trackingCapability: true, vtpStatus: true, vtpStatusName: true } });
  if (!kien) return { error: "Không tìm thấy vận đơn" };
  if (ACTION_CALLS_CARRIER[action]) {
    const actionKey: CarrierActionKey = action === "APPROVE_RETURN" ? "approve-return" : "redeliver";
    const duDieuKien = canRequestCarrierAction(actionKey, {
      stage: kien.stage,
      vtpStatus: kien.vtpStatus,
      vtpStatusName: kien.vtpStatusName,
      orderNumber: kien.vtpOrderNumber ?? kien.trackingCode,
      trackingCapability: kien.trackingCapability,
      configured: getViettelPostClient().configured,
    });
    if (!duDieuKien.ok) return { error: duDieuKien.reason };
  }

  /* Đơn đổi: nhận cả id lẫn mã vận đơn — người xử lý biết mã, không biết id. */
  let replacementId: string | null = null;
  if (replacementShipmentId) {
    const thayThe = await db.query.shipments.findFirst({
      where: or(eq(schema.shipments.id, replacementShipmentId), eq(schema.shipments.vtpOrderNumber, replacementShipmentId), eq(schema.shipments.trackingCode, replacementShipmentId)),
      columns: { id: true },
    });
    if (!thayThe) return { error: `Không tìm thấy vận đơn đơn đổi “${replacementShipmentId}” — tạo vận đơn thay thế trước rồi nối` };
    if (thayThe.id === shipmentId) return { error: "Đơn đổi phải là một vận đơn KHÁC kiện đang gặp sự cố" };
    replacementId = thayThe.id;
  }

  const careRow = await ensureCareRow(shipmentId, user.email);
  if (!careRow) return { error: "Không tìm thấy vận đơn" };
  const truoc = careRow.careStatus as CareStatus;

  /* ───── Hai hành động GỬI LỆNH sang ĐVVC ───── */
  let request: CarrierRequestView | null = null;
  let carrierResult: string | null = null;
  if (ACTION_CALLS_CARRIER[action]) {
    const actionKey: CarrierActionKey = action === "APPROVE_RETURN" ? "approve-return" : "redeliver";
    const r = await requestCarrierAction(user, { shipmentId, actionKey, note });
    if ("error" in r) {
      // ĐVVC (không phải ERP) từ chối KHÔNG làm mất quyết định của shop: vẫn ghi vào sổ, kèm đúng
      // câu ĐVVC nói — điều kiện của ERP đã được xét ở trên nên tới đây chỉ còn lời của ĐVVC.
      carrierResult = r.error;
    } else {
      request = r.data.request;
      carrierResult = r.data.request.status;
    }
  }

  /*
    HẸN XEM LẠI MẶC ĐỊNH cho ba hành động đưa ca vào trạng thái chờ mà không có giờ: một cái hẹn không
    có giờ không phải một cái hẹn, và ca "chờ ĐVVC" không có hạn là ca biến mất khỏi Cần care.
  */
  const now = new Date();
  const henXemLai = followUpAt ?? careRow.followUpAt ?? defaultFollowUpAt(now);

  /* ───── Trạng thái xử lý đi tới đâu ───── */
  const sau: CareStatus =
    action === "APPROVE_RETURN" ? "WAITING_CARRIER" : action === "REQUEST_REDELIVERY" ? "WAITING_CARRIER" : action === "EXCHANGE" ? "WAITING_CARRIER" : "WAITING_REDELIVERY";

  await db
    .update(schema.shipmentCare)
    .set({
      careStatus: canTransition(truoc, sau) ? sau : truoc,
      // `resolution` là QUYẾT ĐỊNH, KHÔNG phải kết cục logistics. Nó không đụng tới `care_outcome`.
      resolution: action === "APPROVE_RETURN" ? "RETURN_APPROVED" : careRow.resolution,
      followUpAt: henXemLai,
      replacementShipmentId: replacementId ?? careRow.replacementShipmentId,
      firstActionAt: careRow.firstActionAt ?? now,
      lastActionAt: now,
      firstResponseAt: careRow.firstResponseAt ?? now,
      lastNote: note || careRow.lastNote,
      lastNoteAt: note ? now : careRow.lastNoteAt,
      lastNoteBy: note ? user.email : careRow.lastNoteBy,
      updatedBy: user.email,
      updatedAt: now,
    })
    .where(eq(schema.shipmentCare.id, careRow.id));

  // LỊCH SỬ CHỈ THÊM — không lệnh `update` nào chạm vào dòng đã ghi.
  await db.insert(schema.careBusinessActions).values({
    careCaseId: careRow.id,
    shipmentId,
    actorUserId: user.id,
    actorEmail: user.email,
    ownerIdAtAction: careRow.ownerId,
    actionType: action,
    reasonCode: reasonCode ?? null,
    reasonNote: note,
    requestedAt: now,
    carrierCommandId: request?.id ?? null,
    carrierResult,
    previousCareStatus: truoc,
    nextCareStatus: sau,
    metadata: { followUpAt: henXemLai.toISOString(), followUpDefaulted: !followUpAt && !careRow.followUpAt, replacementShipmentId: replacementId ?? null },
  });

  await recordCareEvent(user, careRow, { action: "CARRIER_REQUEST", note, followUpAt: henXemLai, payload: { businessAction: action, reasonCode: reasonCode ?? null, carrierResult } });
  await audit({ userId: user.id, userEmail: user.email, action: "CARE_BUSINESS_ACTION", entity: "SHIPMENT", entityId: shipmentId, detail: { action, reasonCode, carrierResult, previous: truoc, next: sau } });
  clearMemo();

  const care = await loadCareState(shipmentId);
  const nhan = BUSINESS_ACTION_LABEL[action];
  const duoi =
    action === "APPROVE_RETURN"
      ? "Đã ghi quyết định. Vận đơn CHƯA thành “đã hoàn” — chỉ chứng từ ĐVVC mới đổi được điều đó."
      : action === "REQUEST_REDELIVERY"
        ? "Đã gửi yêu cầu. Ca vẫn MỞ cho tới khi hành trình ĐVVC nói kết cục — lệnh được nhận không phải hàng đã tới tay khách."
        : action === "EXCHANGE"
          ? "Đã nối ca với đơn đổi. Kết quả “cứu bằng đơn đổi” chỉ được ghi khi đơn đó thật sự giao thành công."
          : `Đã hẹn xem lại. Ca quay về hàng đợi đúng giờ hẹn.`;
  return { ok: true, data: { request, care, message: `${nhan}: ${duoi}${carrierResult && request === null ? ` · ĐVVC: ${carrierResult}` : ""}` } };
}
