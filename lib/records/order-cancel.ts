/**
 * ═══════════ KHÁCH HUỶ ĐƠN — LÕI THỰC THI (chủ shop chốt 10/10/2026) — CHỈ MÁY CHỦ ═══════════
 *
 * Luật thuần (được huỷ chưa, bằng đường nào, lời khai lưu ở đâu): `lib/constants/order-cancel.ts`. Tệp này ĐỌC vòng đời vận đơn,
 * GỌI hãng khi cần, GHI qua đúng lõi huỷ đơn của người (`cancelOrderAsAgent` ⇒ `cancelOrder` của `order-create.ts`) và — khi máy
 * KHÔNG tự huỷ được — đẩy đơn vào HÀNG NGOẠI LỆ:
 *  · cờ CẦN NGƯỜI KIỂM `CANCEL_BLOCKED` (lý do ở `note`) ⇒ lọc «Cần người kiểm» ở trang Đơn, khung đơn hộp thư «CẦN XÁC THỰC»;
 *  · `orders.raw.cancellation.status = EXCEPTION` + mã lý do;
 *  · một thông báo chung (`notifications`, khoá chống trùng theo đơn + mã) + tin hộp thư cá nhân cho người có `orders:write`;
 *  · nhật ký `ORDER_CANCEL_EXCEPTION`.
 * Bot đọc KẾT QUẢ THẬT của các hàm này (`lib/sales-chatbot/tools.ts::cancel_order`): chỉ `CANCELLED` mới được nói «đã huỷ».
 *
 * KHÔNG HỎNG IM LẶNG: ghi hỏng ⇒ thử lại MỘT lần (lõi huỷ khoá dòng + đọc lại stage ⇒ thử lại không huỷ hai lần) ⇒ vẫn hỏng ⇒
 * ngoại lệ `WRITE_FAILED`; chính lượt ghi ngoại lệ hỏng ⇒ vẫn cố gửi thông báo, vẫn trả `EXCEPTION` cho lớp gọi (không bao giờ
 * trả «đã huỷ» khi chưa ghi được), và `console.error` cho log máy chủ (không in dữ liệu khách).
 */
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { activeUserIdsWhoCan } from "@/lib/auth/session";
import { cancelShipmentForOrderCancel, type CarrierCancelOutcome } from "@/lib/carriers/engine";
import { carrierAdapter } from "@/lib/carriers/registry";
import type { CarrierDeps } from "@/lib/carriers/types";
import { CARRIER_HANDOFF_KNOWN_SQL } from "@/lib/constants/carrier-handoff";
import { carrierCreateOf } from "@/lib/constants/carrier-vtp";
import { isManualOrderId, manualOrderRaw, manualOrderShortCode } from "@/lib/constants/manual-orders";
import {
  CANCEL_BLOCK_HINT,
  CANCEL_BLOCK_LABEL,
  CANCEL_OPEN_STAGES,
  customerCancelPlan,
  withCancelOutcome,
  withCancelRequest,
  withRescueResult,
  type CancelActor,
  type CancelAttemptInput,
  type CancelBlockCode,
  type CancelPlanInput,
  type RescueResult,
} from "@/lib/constants/order-cancel";
import { canFlagOrderForReview, withReviewEntry } from "@/lib/constants/order-review";
import { sendInboxMessages } from "@/lib/inbox/send";
import { publish } from "@/lib/realtime/bus";
import { cancelOrderAsAgent, manualOrderOrgGate, type OrderAgent } from "@/lib/records/order-create";

/** Đơn còn MỞ của một hội thoại — đơn khách có thể đang muốn huỷ (cùng phép nối với khung đơn hộp thư / form tạo đơn). */
export async function conversationCancelTargets(conversationId: string, stateIds: readonly (string | null | undefined)[]): Promise<{ id: string; stage: string }[]> {
  const db = await getDb();
  const c = schema.salesChatConversations;
  const o = schema.orders;
  const [conv] = await db.select({ orderId: c.orderId, draftOrderId: c.draftOrderId }).from(c).where(eq(c.id, conversationId)).limit(1);
  const ids = [...new Set([conv?.orderId, conv?.draftOrderId, ...stateIds].filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= 200))];
  const rows = await db
    .select({ id: o.id, stage: o.stage })
    .from(o)
    .where(and(ids.length ? or(eq(o.salesConversationId, conversationId), inArray(o.id, ids)) : eq(o.salesConversationId, conversationId), inArray(o.stage, [...CANCEL_OPEN_STAGES])))
    .orderBy(asc(o.insertedAt))
    .limit(20);
  return rows;
}

type Tx = Parameters<Parameters<Awaited<ReturnType<typeof getDb>>["transaction"]>[0]>[0];

/** Khoá dòng đơn, áp một phép biến `raw` THUẦN, ghi khi đổi. Đơn không phải đơn tay ⇒ không ghi gì (đơn đồng bộ: nguồn ghi đè). */
async function patchRaw(orderId: string, fn: (raw: Record<string, unknown>, stage: string) => { raw: Record<string, unknown>; changed: boolean }, now: Date): Promise<{ found: boolean; manual: boolean; stage: string | null; changed: boolean }> {
  const db = await getDb();
  return db.transaction(async (tx: Tx) => {
    const [row] = await tx.select({ id: schema.orders.id, stage: schema.orders.stage, raw: schema.orders.raw }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1).for("update");
    if (!row) return { found: false, manual: false, stage: null, changed: false };
    if (!isManualOrderId(row.id) || !manualOrderRaw(row.raw)) return { found: true, manual: false, stage: row.stage, changed: false };
    const next = fn((row.raw ?? {}) as Record<string, unknown>, row.stage);
    if (next.changed) await tx.update(schema.orders).set({ raw: next.raw, updatedAt: now }).where(eq(schema.orders.id, row.id));
    return { found: true, manual: true, stage: row.stage, changed: next.changed };
  });
}

const machineEmail = (agent: OrderAgent) => `agent:${agent.source}`;

/**
 * BƯỚC 1 — khách xin huỷ: ghi YÊU CẦU (mốc, nguyên văn, lý do, hội thoại) + mở lượt GIỮ ĐƠN trên `raw.cancellation`. Yêu cầu đang mở
 * gửi lại (tin trùng) ⇒ không ghi gì. Nhật ký `ORDER_CANCEL_REQUEST` (tác nhân MÁY). Cờ «khách huỷ» do lớp gọi gắn qua
 * `flagOrderForReviewAsAgent` (một đường gắn cờ).
 */
export async function recordCustomerCancelRequest(agent: OrderAgent, orderId: string, req: { quote: string | null; reason: string; conversationId: string | null }, now: Date = new Date()): Promise<{ changed: boolean; stage: string | null }> {
  const r = await patchRaw(orderId, (raw, stage) => (canFlagOrderForReview(stage) ? withCancelRequest(raw, { at: now.toISOString(), quote: req.quote, reason: req.reason, conversationId: req.conversationId, rescue: true }) : { raw, changed: false }), now);
  if (r.changed) {
    await audit({ userId: null, userEmail: machineEmail(agent), actorKind: "AGENT", action: "ORDER_CANCEL_REQUEST", entity: "ORDER", entityId: orderId, before: null, after: { requestedBy: "CUSTOMER", rescue: "PENDING", quote: req.quote, by: agent.name }, reason: req.reason });
    publish({ type: "order", orderId, action: "updated", source: "ERP" });
  }
  return { changed: r.changed, stage: r.stage };
}

/** Khách ĐỒNG Ý GIỮ ĐƠN sau lượt giữ (rescue thành công) ⇒ ghi kết quả, đơn không đổi stage. Nhật ký `ORDER_CANCEL_RESCUE`. */
export async function recordCustomerKeptOrder(agent: OrderAgent, orderId: string, quote: string | null, now: Date = new Date()): Promise<boolean> {
  const r = await patchRaw(orderId, (raw) => withRescueResult(raw, { result: "SUCCEEDED", at: now.toISOString(), quote }), now);
  if (r.changed) {
    await audit({ userId: null, userEmail: machineEmail(agent), actorKind: "AGENT", action: "ORDER_CANCEL_RESCUE", entity: "ORDER", entityId: orderId, before: { rescue: "PENDING" }, after: { rescue: "SUCCEEDED", quote, by: agent.name }, reason: "Khách đồng ý giữ đơn sau lượt giữ đơn" });
    publish({ type: "order", orderId, action: "updated", source: "ERP" });
  }
  return r.changed;
}

export type CustomerCancelInput = {
  orderId: string;
  agent: OrderAgent;
  /** AI (bot bán hàng) hay job đối soát. Người huỷ tay đi `cancelManualOrderCore`. */
  actorKind: "AI" | "SYSTEM";
  conversationId: string | null;
  quote: string | null;
  reason: string;
  /** Kết quả lượt giữ đơn tới lúc thực thi: bot ⇒ `FAILED` (khách vẫn huỷ); đối soát lịch sử ⇒ đúng điều đã biết. */
  rescue: RescueResult;
  now?: Date;
  deps?: CarrierDeps;
};

export type CustomerCancelResult =
  | { status: "CANCELLED" | "ALREADY_CANCELLED"; orderId: string; shortCode: string; carrier: { trackingCode: string; carrier: string } | null }
  | { status: "EXCEPTION"; orderId: string; shortCode: string; code: CancelBlockCode; detail: string; alerted: boolean };

/** Dữ kiện để quyết — đơn + mọi lần gửi (kèm chứng cứ bàn giao) + phiếu xuất kho tay trỏ về đơn. */
export async function loadCancelFacts(orderId: string): Promise<{ input: CancelPlanInput; shipmentIds: string[] } | null> {
  const db = await getDb();
  const [order] = await db.select({ id: schema.orders.id, stage: schema.orders.stage, raw: schema.orders.raw }).from(schema.orders).where(eq(schema.orders.id, orderId)).limit(1);
  if (!order) return null;
  const s = schema.shipments;
  const [rows, issues] = await Promise.all([
    db
      .select({ id: s.id, stage: s.stage, raw: s.raw, vtpStatus: s.vtpStatus, code: sql<string | null>`coalesce(${s.vtpOrderNumber}, ${s.trackingCode})`, handoff: sql<boolean>`${sql.raw(CARRIER_HANDOFF_KNOWN_SQL)}` })
      .from(s)
      .where(eq(s.orderId, orderId))
      .orderBy(asc(s.createdAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceipts).where(and(eq(schema.stockReceipts.kind, "ISSUE"), eq(schema.stockReceipts.reference, orderId))),
  ]);
  const attempts: CancelAttemptInput[] = rows.map((r) => {
    const create = carrierCreateOf(r.raw);
    const adapter = create ? carrierAdapter(create.carrier ?? "VTP") : null;
    return {
      stage: r.stage,
      raw: r.raw,
      handoffKnown: r.handoff === true,
      createdByErp: Boolean(create),
      createState: create?.state ?? null,
      hasTrackingCode: Boolean(r.code),
      carrierCancellable: adapter ? adapter.cancellable({ stage: r.stage, vtpStatus: r.vtpStatus }) : null,
    };
  });
  return { input: { manual: isManualOrderId(order.id) && manualOrderRaw(order.raw) !== null, stage: order.stage, attempts, manualIssues: Number(issues[0]?.n ?? 0) }, shipmentIds: rows.map((r) => r.id) };
}

const CARRIER_FAILURE: Record<Exclude<CarrierCancelOutcome["kind"], "ACCEPTED">, CancelBlockCode> = {
  REJECTED: "CARRIER_REJECTED",
  UNKNOWN: "CARRIER_UNKNOWN",
  UNAVAILABLE: "CARRIER_UNAVAILABLE",
  NOT_CANCELLABLE: "CARRIER_NOT_CANCELLABLE",
};

/** Số lần ghi huỷ (lần đầu + MỘT lần thử lại) — lõi huỷ idempotent nên thử lại không bao giờ huỷ hai lần. */
const WRITE_TRIES = 2;

/**
 * BƯỚC CUỐI — khách đã chốt huỷ (lượt giữ đơn thất bại): huỷ THEO VÒNG ĐỜI VẬN ĐƠN. Trả kết quả THẬT; chỉ `CANCELLED` /
 * `ALREADY_CANCELLED` nghĩa là đơn ĐÃ «Đã huỷ» trong CSDL. Mọi nhánh khác là `EXCEPTION` đã vào hàng ngoại lệ + cảnh báo người.
 */
export async function executeCustomerCancel(input: CustomerCancelInput): Promise<CustomerCancelResult> {
  const now = input.now ?? new Date();
  const shortCode = manualOrderShortCode(input.orderId);
  const actor: CancelActor = { kind: input.actorKind, userId: null, name: input.agent.name };
  const reason = (input.reason.trim() || "Khách huỷ đơn").slice(0, 300);
  const exception = async (code: CancelBlockCode, detail: string): Promise<CustomerCancelResult> => {
    const alerted = await raiseCancelException(input.orderId, code, detail, { agent: input.agent, actor, conversationId: input.conversationId, quote: input.quote, reason, rescue: input.rescue, now });
    return { status: "EXCEPTION", orderId: input.orderId, shortCode, code, detail, alerted };
  };
  const gate = await manualOrderOrgGate();
  if (!gate.allowed) return exception("NOT_ERP_ORDER", gate.reason);
  // Lượt giữ đơn đã có kết quả (khách vẫn huỷ) ⇒ ghi trước, để cả nhánh ngoại lệ cũng nói đúng «đã giữ, không được».
  if (input.rescue === "FAILED") await patchRaw(input.orderId, (raw) => withRescueResult(raw, { result: "FAILED", at: now.toISOString(), quote: input.quote }), now).catch(() => undefined);
  const facts = await loadCancelFacts(input.orderId);
  if (!facts) return exception("NOT_ERP_ORDER", "Không có đơn này trong tổ chức.");
  const plan = customerCancelPlan(facts.input);
  if (plan.kind === "ALREADY_CANCELLED") return { status: "ALREADY_CANCELLED", orderId: input.orderId, shortCode, carrier: null };
  if (plan.kind === "NEEDS_HUMAN") return exception(plan.code, "");
  let carrier: { trackingCode: string; carrier: string } | null = null;
  if (plan.kind === "CARRIER_CANCEL") {
    const res = await cancelShipmentForOrderCancel(facts.shipmentIds[plan.attemptIndex], reason, input.agent, input.deps);
    if (res.kind !== "ACCEPTED") return exception(CARRIER_FAILURE[res.kind], res.message);
    carrier = { trackingCode: res.trackingCode, carrier: res.carrier };
  }
  let lastError = "";
  for (let i = 0; i < WRITE_TRIES; i++) {
    try {
      const r = await cancelOrderAsAgent(input.agent, input.orderId, { reason }, { actorKind: input.actorKind, requestedBy: "CUSTOMER", conversationId: input.conversationId, quote: input.quote, rescue: input.rescue });
      if (r.ok) return { status: r.reused ? "ALREADY_CANCELLED" : "CANCELLED", orderId: input.orderId, shortCode, carrier };
      // Lõi từ chối có lý do (vận đơn vừa xuất hiện, đơn vừa khép…) — không phải lỗi tạm, không thử lại.
      return exception(r.code === "CONFLICT" ? "ATTEMPT_UNRESOLVED" : "WRITE_FAILED", r.errors.map((e) => e.message).join(" · ").slice(0, 300));
    } catch (error) {
      lastError = error instanceof Error ? error.message.slice(0, 200) : "lỗi không rõ";
      console.error(`[order-cancel] ghi huỷ đơn hỏng (lần ${i + 1}/${WRITE_TRIES}):`, lastError);
    }
  }
  return exception("WRITE_FAILED", lastError);
}

/**
 * HÀNG NGOẠI LỆ + CẢNH BÁO NGƯỜI. Trả `true` khi ít nhất thông báo chung đã ghi được. Cùng đơn + cùng mã + cùng chi tiết gọi lại ⇒
 * không thêm dòng nào (cờ, lời khai, nhật ký, thông báo đều có khoá chống trùng).
 */
export async function raiseCancelException(
  orderId: string,
  code: CancelBlockCode,
  detail: string,
  ctx: { agent: OrderAgent; actor: CancelActor; conversationId: string | null; quote: string | null; reason: string; rescue: RescueResult; now: Date },
): Promise<boolean> {
  const label = CANCEL_BLOCK_LABEL[code];
  const note = `${label}${detail ? ` — ${detail}` : ""}`.slice(0, 300);
  let changed = false;
  try {
    const r = await patchRaw(
      orderId,
      (raw, stage) => {
        const out = withCancelOutcome(raw, { status: "EXCEPTION", at: ctx.now.toISOString(), actor: ctx.actor, exception: { code, detail }, fallback: { requestedBy: "CUSTOMER", reason: ctx.reason, quote: ctx.quote, conversationId: ctx.conversationId, rescue: ctx.rescue } });
        if (!canFlagOrderForReview(stage)) return out;
        const flagged = withReviewEntry(out.raw, { code: "CANCEL_BLOCKED", note, quote: ctx.quote, at: ctx.now.toISOString(), by: ctx.agent.name });
        return { raw: flagged.raw, changed: out.changed || flagged.changed };
      },
      ctx.now,
    );
    changed = r.changed;
  } catch (error) {
    console.error("[order-cancel] ghi hàng ngoại lệ hỏng — vẫn gửi cảnh báo:", error instanceof Error ? error.message.slice(0, 200) : error);
  }
  if (changed) {
    await audit({ userId: null, userEmail: machineEmail(ctx.agent), actorKind: "AGENT", action: "ORDER_CANCEL_EXCEPTION", entity: "ORDER", entityId: orderId, before: null, after: { code, detail: detail || null, rescue: ctx.rescue, by: ctx.agent.name }, reason: `Khách huỷ — máy không tự huỷ: ${label}` });
    publish({ type: "order", orderId, action: "updated", source: "ERP" });
  }
  try {
    const db = await getDb();
    const title = "Khách huỷ đơn — cần người xử lý";
    const body = `Đơn #${manualOrderShortCode(orderId)}: ${note}. ${CANCEL_BLOCK_HINT[code]}`.slice(0, 600);
    const href = `/orders/${encodeURIComponent(orderId)}`;
    const key = `order-cancel:exception:${orderId}:${code}`;
    const severity = code === "WRITE_FAILED" || code === "CARRIER_UNKNOWN" || code === "HANDED_TO_CARRIER" ? "critical" : "warning";
    await db.insert(schema.notifications).values({ kind: "SYSTEM", severity, title, body, href, entityType: "ORDER", entityId: orderId, dedupeKey: key, occurredAt: ctx.now }).onConflictDoNothing({ target: schema.notifications.dedupeKey });
    const users = await activeUserIdsWhoCan("orders:write");
    await sendInboxMessages(users.map((userId) => ({ userId, kind: "ORDER_CANCEL_EXCEPTION", title, body, href, dedupeKey: `${key}:${userId}` })), db);
    return true;
  } catch (error) {
    console.error("[order-cancel] gửi cảnh báo ngoại lệ hỏng:", error instanceof Error ? error.message.slice(0, 200) : error);
    return false;
  }
}
