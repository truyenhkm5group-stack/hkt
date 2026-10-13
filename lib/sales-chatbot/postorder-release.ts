import { and, asc, desc, eq, gt, like, lte, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { paymentSignalInCustomerText } from "@/lib/sales-chatbot/claim-guard";
import { readConversationControl } from "@/lib/sales-chatbot/conversation-control-shared";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";
import { HANDOFF_QUEUE_CLEAR } from "@/lib/sales-chatbot/handoff-routing-shared";
import { CUSTOMER_MESSAGE_ROW_SQL, customerInboundRowSql, STATE_HANDOFF_AT_SQL, WAITING_REPLY_SQL } from "@/lib/sales-chatbot/inbox-states";
import { customerComplaintSignal, customerNotReceivedSignal } from "@/lib/sales-chatbot/lifecycle";
import { foldVi } from "@/lib/sales-chatbot/text";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ TRẢ CHO AI CÁC HỘI THOẠI KẸT VÌ LUẬT CŨ «KHÁCH NHẮN SAU KHI CHỐT ĐƠN» (HOTFIX P0 12/10/2026) ═══════════
 *
 * Bản vá engine bỏ luật chuyển người MẶC ĐỊNH sau khi chốt đơn (AI trả lời theo giai đoạn khách — lifecycle.ts::customerPhaseOf). Hội
 * thoại đã bị chuyển người bằng luật cũ vẫn nằm `HANDOFF` với lý do ấy: không đường nào tự trả về AI (lý do này không tự hết hạn), và
 * đo 11/10 có 248 hội thoại HSLC treo «KHÔNG CHỦ». Watchdog của lượt quét KHÔNG đụng chúng: trả hàng loạt về AI là lượt ghi hàng loạt
 * trên production — chủ shop duyệt (AGENTS §7). Tệp này là lõi CHẠY THỬ mặc định của ops `sales-postorder-handoff-release`.
 *
 * Chỉ trả về AI hội thoại KHÔNG AI ĐANG CẦM và KHÔNG CÒN YÊU CẦU NÀO CHƯA ĐƯỢC TRẢ LỜI (review #821 F3 — trả về AI xoá dấu hàng đợi, nên
 * một yêu cầu đang chờ sẽ biến khỏi hàng đợi người mà AI không bao giờ trả lời nó):
 *  · tiếp quản · người phụ trách còn hoạt động · câu nhân viên sau mốc chuyển người ⇒ để nguyên (người đang làm);
 *  · tin cuối là của KHÁCH chưa ai trả lời (`WAITING_REPLY`) ⇒ để nguyên (khách đang chờ — người trả lời rồi mới trả AI);
 *  · tin khách KỂ TỪ lúc chuyển người có yêu cầu SỬA ĐƠN · KHIẾU NẠI / chưa nhận hàng · HUỶ · báo đã chuyển khoản ⇒ để nguyên.
 * Lý do chuyển người KHÁC (khách báo chuyển khoản, khiếu nại, ghi đơn hỏng…) không bao giờ khớp tiền tố nên không bao giờ bị đụng.
 * KHÔNG gửi tin cho khách, KHÔNG đụng đơn. Ghi có điều kiện (trạng thái + lý do + không chờ trả lời y như lúc đọc) ⇒ chạy lại / chạy chồng
 * không ghi đôi.
 */

/** Tiền tố lý do của luật cũ (engine.ts trước 12/10/2026) — chuỗi ĐÃ LƯU trong CSDL, không đổi. */
export const LEGACY_POST_ORDER_REASON_PREFIX = "Khách nhắn sau khi đã chốt đơn";

export const CUSTOMER_REQUEST_KINDS = ["EDIT", "COMPLAINT", "CANCEL", "PAYMENT"] as const;
export type CustomerRequestKind = (typeof CUSTOMER_REQUEST_KINDS)[number];
export const CUSTOMER_REQUEST_LABEL: Record<CustomerRequestKind, string> = { EDIT: "sửa đơn", COMPLAINT: "khiếu nại / chưa nhận hàng", CANCEL: "huỷ", PAYMENT: "báo đã chuyển khoản" };

const EDIT_RE =
  /\b(?:doi|sua|thay|cap nhat)\s+(?:lai\s+)?(?:dia chi|sdt|so dien thoai|so dt|ngay|lich|gio|nguoi nhan|don|mon|size|mau|loai)\b|\b(?:them|bot|giam|tang)\s+(?:\d+\s+)?(?:\S+\s+){0,2}(?:nua|vao don)\b|\bgiao\s+(?:vao\s+|hom\s+)?(?:chu nhat|thu \d|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay|ngay mai)\b/;
const CANCEL_RE = /\bhuy\b|\bkhong\s+(?:lay|mua|nhan)\s+nua\b|\bthoi\s+(?:khong|ko|k)\s+(?:lay|mua)\b|\bbom\s+hang\b/;

/** Loại yêu cầu trong các tin khách (gộp). HÀM THUẦN. */
export function customerRequestKinds(texts: readonly string[]): CustomerRequestKind[] {
  const out = new Set<CustomerRequestKind>();
  for (const t of texts) {
    const f = foldVi(t.normalize("NFC"));
    if (customerComplaintSignal(t) || customerNotReceivedSignal(t)) out.add("COMPLAINT");
    if (CANCEL_RE.test(f)) out.add("CANCEL");
    if (EDIT_RE.test(f)) out.add("EDIT");
    if (paymentSignalInCustomerText(t)) out.add("PAYMENT");
  }
  return CUSTOMER_REQUEST_KINDS.filter((k) => out.has(k));
}

export const RELEASE_VERDICTS = ["RELEASE", "HELD_BY_PERSON", "STAFF_REPLIED", "TAKEOVER", "CUSTOMER_WAITING", "CUSTOMER_REQUEST"] as const;
export type ReleaseVerdict = (typeof RELEASE_VERDICTS)[number];
export const RELEASE_VERDICT_LABEL: Record<ReleaseVerdict, string> = {
  RELEASE: "trả cho AI được (không ai cầm, không yêu cầu nào chờ)",
  HELD_BY_PERSON: "có người phụ trách — để nguyên",
  STAFF_REPLIED: "nhân viên đã trả lời sau khi chuyển — để nguyên",
  TAKEOVER: "đang «Tiếp quản» — để nguyên",
  CUSTOMER_WAITING: "khách đang chờ câu trả lời — để nguyên",
  CUSTOMER_REQUEST: "khách có yêu cầu kể từ lúc chuyển — để nguyên",
};

/** Một hội thoại được trả về AI hay để nguyên. HÀM THUẦN. */
export function releaseVerdict(r: { state: unknown; assigneeUserId: string | null; assigneeActive: boolean; lastStaffAt: Date | null; since: Date | null; waiting?: boolean; requests?: readonly CustomerRequestKind[] }): ReleaseVerdict {
  if (readConversationControl(r.state)?.mode === "HUMAN") return "TAKEOVER";
  if (r.assigneeUserId && r.assigneeActive) return "HELD_BY_PERSON";
  if (r.lastStaffAt && (!r.since || r.lastStaffAt.getTime() >= r.since.getTime())) return "STAFF_REPLIED";
  if (r.waiting) return "CUSTOMER_WAITING";
  if (r.requests?.length) return "CUSTOMER_REQUEST";
  return "RELEASE";
}

export type ReleaseReport = {
  candidates: number;
  byVerdict: Record<ReleaseVerdict, number>;
  /** Khách đang chờ câu trả lời (tin cuối là của khách) — đếm trên MỌI ứng viên, kể cả đã bị loại vì lý do khác. */
  waiting: number;
  /** Loại yêu cầu trong tin khách kể từ lúc chuyển người — đếm trên mọi ứng viên. */
  requests: Record<CustomerRequestKind, number>;
  released: number;
  apply: boolean;
};

const C = schema.salesChatConversations;
const MACHINE_EMAIL = "job:sales-postorder-handoff-release";

/**
 * Tin KHÁCH của hội thoại kể từ tin khách CUỐI ở / trước mốc chuyển người (mốc LÙI — review #821 vòng 2: chính tin làm hội thoại bị chuyển
 * người, vd «cho chị đổi địa chỉ», tới TRƯỚC `handoff.at` vài giây; lọc «sau mốc» là loại đúng yêu cầu cần giữ). Sổ tin thô kênh nhắn tin;
 * chat web: lịch sử bot. Tối đa 50 tin, chỉ để nhận yêu cầu.
 */
async function customerTextsSince(conv: { id: string; pageId: string | null; threadId: string | null }, since: Date | null): Promise<string[]> {
  const db = await getDb();
  if (conv.pageId && conv.threadId) {
    const i = schema.salesChatInbound;
    const own = and(eq(i.pageId, conv.pageId), eq(i.threadId, conv.threadId), customerInboundRowSql('"sales_chat_inbound"'));
    const [anchor] = since ? await db.select({ at: i.createdAt }).from(i).where(and(own, lte(i.createdAt, since))).orderBy(desc(i.createdAt)).limit(1) : [];
    const from = anchor ? new Date(anchor.at.getTime() - 1) : (since ?? new Date(0));
    const rows = await db
      .select({ text: i.text })
      .from(i)
      .where(and(own, gt(i.createdAt, from)))
      .orderBy(asc(i.createdAt))
      .limit(50);
    return rows.map((r) => r.text);
  }
  const from = since ? new Date(since.getTime() - 10 * 60_000) : new Date(0);
  const rows = rowsOf<{ content: unknown }>(await db.execute(sql`select m.content from "sales_chat_messages" m where m.conversation_id = ${conv.id} and m.created_at > ${from} and ${CUSTOMER_MESSAGE_ROW_SQL} order by m.seq limit 50`));
  const out: string[] = [];
  for (const r of rows) for (const b of Array.isArray(r.content) ? (r.content as { type?: string; text?: string }[]) : []) if (b.type === "text" && b.text) out.push(b.text);
  return out;
}

export async function releaseLegacyPostOrderHandoffs(opts: { apply: boolean; now?: Date }): Promise<ReleaseReport> {
  const now = opts.now ?? new Date();
  const db = await getDb();
  const rows = await db
    .select({
      id: C.id,
      pageId: C.pageId,
      threadId: C.threadId,
      handoffReason: C.handoffReason,
      state: C.state,
      assigneeUserId: C.assigneeUserId,
      assigneeActive: schema.users.active,
      lastStaffAt: C.lastStaffAt,
      queuedAt: C.handoffQueuedAt,
      waiting: WAITING_REPLY_SQL,
      handoffAt: STATE_HANDOFF_AT_SQL,
    })
    .from(C)
    .leftJoin(schema.users, eq(schema.users.id, C.assigneeUserId))
    .where(and(eq(C.status, "HANDOFF"), sql`${C.channel} <> 'TEST'`, like(C.handoffReason, `${LEGACY_POST_ORDER_REASON_PREFIX}%`)))
    .limit(5000);
  const report: ReleaseReport = {
    candidates: rows.length,
    byVerdict: Object.fromEntries(RELEASE_VERDICTS.map((v) => [v, 0])) as Record<ReleaseVerdict, number>,
    waiting: 0,
    requests: Object.fromEntries(CUSTOMER_REQUEST_KINDS.map((k) => [k, 0])) as Record<CustomerRequestKind, number>,
    released: 0,
    apply: opts.apply,
  };
  for (const r of rows) {
    const since = r.handoffAt ? new Date(r.handoffAt) : r.queuedAt;
    const waiting = Boolean(r.waiting);
    const requests = customerRequestKinds(await customerTextsSince(r, since));
    if (waiting) report.waiting += 1;
    for (const k of requests) report.requests[k] += 1;
    const v = releaseVerdict({ state: r.state, assigneeUserId: r.assigneeUserId, assigneeActive: Boolean(r.assigneeActive), lastStaffAt: r.lastStaffAt, since, waiting, requests });
    report.byVerdict[v] += 1;
    if (v !== "RELEASE" || !opts.apply || !r.handoffReason) continue;
    const done = await db
      .update(C)
      .set({ status: "OPEN", handoffReason: null, state: sql`${C.state} - 'handoff'`, humanCooldownUntil: null, ...HANDOFF_QUEUE_CLEAR, updatedAt: now })
      .where(and(eq(C.id, r.id), eq(C.status, "HANDOFF"), eq(C.handoffReason, r.handoffReason), sql`coalesce(${C.state}->'control'->>'mode', '') <> 'HUMAN'`, sql`not ${WAITING_REPLY_SQL}`))
      .returning({ id: C.id });
    if (!done.length) continue;
    report.released += 1;
    await recordConversationEvent(r.id, { type: "ai.resumed", actorKind: "SYSTEM", actorUserId: null, occurredAt: now, reasonCode: "RETURNED", payload: { via: "POSTORDER_RELEASE", reason: r.handoffReason.slice(0, 200) }, key: `postorder-release:${r.id}` });
    await audit({ userId: null, userEmail: MACHINE_EMAIL, action: "SALES_CHAT_POSTORDER_RELEASE", entity: "SALES_CONVERSATION", entityId: r.id, before: { status: "HANDOFF", handoffReason: r.handoffReason }, after: { status: "OPEN" }, reason: "Luật cũ «khách nhắn sau khi chốt đơn ⇒ chuyển người» đã bỏ (12/10/2026); không ai đang cầm, không yêu cầu nào chờ" });
  }
  return report;
}

/** Dòng tóm tắt chỉ số đếm. HÀM THUẦN. */
export function releaseSummaryLines(code: string, r: ReleaseReport): string[] {
  return [
    `${code}: hội thoại kẹt luật cũ «sau khi chốt đơn» ${r.candidates} · ${RELEASE_VERDICTS.map((v) => `${RELEASE_VERDICT_LABEL[v]} ${r.byVerdict[v]}`).join(" · ")}`,
    `${code}: khách đang chờ câu trả lời ${r.waiting} · yêu cầu trong tin khách kể từ lúc chuyển: ${CUSTOMER_REQUEST_KINDS.map((k) => `${CUSTOMER_REQUEST_LABEL[k]} ${r.requests[k]}`).join(" · ")}`,
    `${code}: ${r.apply ? `ĐÃ trả cho AI ${r.released}` : "CHẠY THỬ — chưa ghi gì (thêm --apply sau khi chủ shop duyệt)"}`,
  ];
}
