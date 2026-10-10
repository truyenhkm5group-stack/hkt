import { sql, type SQL } from "drizzle-orm";
import { AI_DOWN_HANDOFF_REASON, HUMAN_COOLDOWN_MINUTES, HUMAN_COOLDOWN_MS, STAFF_COOLDOWN_REASON_LIST } from "@/lib/sales-chatbot/ai-hold-shared";
import { readConversationControl, TAKEOVER_REASON } from "@/lib/sales-chatbot/conversation-control-shared";
import { PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { HISTORY_CREATED_BY } from "@/lib/sales-chatbot/history-shared";
import { ORDER_NEEDS_REVIEW } from "@/lib/queries/orders";
import type { InboxHandling } from "@/lib/sales-chatbot/inbox-shared";

/**
 * ═══════════ BỐN KHÁI NIỆM CỦA HỘP THƯ — MỘT NƠI KHAI (chủ shop 10/10/2026, mục B · C · G) ═══════════
 *
 * Trước bản này một điều kiện làm việc cho nhiều khái niệm: «Chưa đọc» đòi tin cuối là của KHÁCH (AI trả lời xong là hội thoại
 * thành «đã đọc» dù chưa người nào mở), số chưa đọc đếm sau câu cuối của BOT, và «Cần người» = mọi `HANDOFF` (gộp tiếp quản tay,
 * thời gian AI nhường sau câu tay của nhân viên và ca cần người thật). Bốn khái niệm, bốn điều kiện, KHÔNG suy ra lẫn nhau:
 *
 *  · HUMAN_UNREAD   — khách gửi ≥ 1 tin SAU lần cuối NGƯỜI thấy hội thoại: mở hội thoại (`staff_seen_at`) hoặc trả lời khách từ
 *                     ERP (`last_staff_at` — đã trả lời thì đã thấy mọi tin trước đó). Tin BOT không bao giờ xoá «chưa đọc».
 *  · WAITING_REPLY  — lượt nói cuối là của KHÁCH và chưa ai (bot · nhân viên ERP · phía page ngoài ERP) trả lời sau nó, kể cả khi
 *                     khách nhắn nối sau câu bot. Tin khách nhập từ lịch sử (`history_until`) không phải việc chờ.
 *  · NEEDS_HUMAN    — có LÝ DO THẬT cần người quyết: AI xin người / công cụ chuyển người (khách đòi gặp người, khách nhắn sau khi
 *                     chốt đơn, hội thoại quá dài…) · AI hỏng (đang trong khoảng chờ thử lại) · đơn của hội thoại mang cờ cần người
 *                     kiểm (`orders.raw.review`: khách báo huỷ · địa chỉ chưa ghép xã). Nhân viên đang trả lời KHÔNG phải lý do.
 *  · HUMAN_HANDLING — người đang cầm: MANUAL_TAKEOVER (bấm «Tiếp quản») · STAFF_COOLDOWN (AI nhường sau câu tay của nhân viên —
 *                     còn hạn; chat web chờ người trả lại) · COPILOT (AI gợi ý, người gửi — của hội thoại hoặc cả tổ chức).
 *
 * «Ai đang trả lời» (`replying`) phủ kín, không giao nhau: HUMAN (có người cầm) · NOBODY (AI đã dừng vì cần người mà chưa ai cầm —
 * luôn nằm trong NEEDS_HUMAN) · AI (còn lại). Thẻ «AI đang trả lời» = AI; «Người đang xử lý» = HUMAN.
 *
 * MỖI khái niệm có HAI bản: điều kiện SQL (lọc + đếm ở máy chủ) và hàm THUẦN `classifyInboxState` (huy hiệu trên hàng). Hai bản
 * dựng từ ĐÚNG các hằng chung (`ai-hold-shared.ts` · `conversation-control-shared.ts`) và `tests/inbox-semantics-v3.test.ts` so
 * từng hội thoại của một ma trận: tập dòng của mỗi bộ lọc = tập dòng hàm thuần phân loại vào đó.
 *
 * Mọi điều kiện an toàn với NULL (`coalesce(…, false)`): `not NULL` là NULL, và một hội thoại rơi khỏi CẢ «AI» LẪN «Người» là
 * hội thoại biến mất khỏi mọi bộ lọc.
 */

const C = "sales_chat_conversations";
const col = (name: string) => sql.raw(`"${C}"."${name}"`);
const EPOCH = sql`'epoch'::timestamptz`;
const ts = (name: string) => sql`coalesce(${col(name)}, ${EPOCH})`;
const MODE = sql`coalesce(${col("state")}->'control'->>'mode', '')`;
const REASON = sql`coalesce(${col("handoff_reason")}, '')`;
const IS_HANDOFF = sql`(${col("status")} = 'HANDOFF')`;
const inList = (xs: readonly string[]) =>
  sql.join(
    xs.map((x) => sql`${x}`),
    sql`, `,
  );
/** Mốc nhường của dòng cũ chưa có `human_cooldown_until` (và đồng hồ thử lại khi AI hỏng) — ĐÚNG luật `aiHoldOf`. */
const FALLBACK_UNTIL = sql`(${col("updated_at")} + (${HUMAN_COOLDOWN_MINUTES}::int * interval '1 minute'))`;
const safe = (cond: SQL): SQL<boolean> => sql<boolean>`coalesce((${cond}), false)`;

/** Câu «nhân viên đang trả lời trên chat web» — chat web chờ người bấm trả lại (không tự hết hạn). */
export const WEB_STAFF_REASON = "Nhân viên đang trả lời trên chat web";

/** Lý do `HANDOFF` KHÔNG phải «AI xin người»: nhân viên đang trả lời (mọi kênh) · tiếp quản · AI hỏng (lý do riêng `AI_DOWN`). */
const NOT_AI_HANDOFF_REASONS: readonly string[] = [...STAFF_COOLDOWN_REASON_LIST, WEB_STAFF_REASON, TAKEOVER_REASON, AI_DOWN_HANDOFF_REASON];
const NOT_AI_HANDOFF_SET: ReadonlySet<string> = new Set(NOT_AI_HANDOFF_REASONS);
const STAFF_COOLDOWN_SET: ReadonlySet<string> = new Set(STAFF_COOLDOWN_REASON_LIST);

export const NEEDS_HUMAN_CODES = ["AI_HANDOFF", "AI_DOWN", "ORDER_REVIEW"] as const;
export type NeedsHumanCode = (typeof NEEDS_HUMAN_CODES)[number];
export const HUMAN_HANDLING_KINDS = ["MANUAL_TAKEOVER", "STAFF_COOLDOWN", "COPILOT"] as const;
export type HumanHandling = (typeof HUMAN_HANDLING_KINDS)[number];
export type InboxReplying = "AI" | "HUMAN" | "NOBODY";

// ─────────────────────────── Điều kiện SQL ───────────────────────────

/** Có tin phía page (ngoài ERP: nhân viên trên Pancake / Hộp thư Meta, tự động của page) SAU tin khách cuối. */
export const PAGE_REPLY_AFTER_CUSTOMER_SQL = sql<boolean>`exists (select 1 from "sales_chat_inbound" i where i.page_id = ${col("page_id")} and i.thread_id = ${col("thread_id")}
    and i.note = ${PAGE_REPLY} and i.created_at > ${col("last_customer_at")})`;

/** Đơn của hội thoại đang mang cờ CẦN NGƯỜI KIỂM — ĐÚNG biểu thức của bộ lọc «Cần người kiểm» ở trang Đơn (`ORDER_NEEDS_REVIEW`). */
export const ORDER_UNDER_REVIEW_SQL = sql<boolean>`exists (select 1 from "orders" where "orders"."sales_conversation_id" = ${col("id")}
    and "orders"."stage" not in ('DELETED', 'CANCELLED') and ${ORDER_NEEDS_REVIEW})`;

/** Mốc NGƯỜI thấy hội thoại lần cuối: mở hội thoại hoặc trả lời khách từ ERP (`greatest` bỏ qua NULL). KHÔNG BAO GIỜ tính tin bot. */
const HUMAN_SEEN = sql`coalesce(greatest(${col("staff_seen_at")}, ${col("last_staff_at")}), ${EPOCH})`;

/** HUMAN_UNREAD — khách gửi tin SAU lần cuối người thấy, bất kể AI đã trả lời hay chưa. */
export const HUMAN_UNREAD_SQL: SQL<boolean> = safe(sql`${col("last_customer_at")} is not null and ${col("last_customer_at")} > ${HUMAN_SEEN} and ${col("last_customer_at")} > ${ts("history_until")}`);

/** WAITING_REPLY — tin cuối là của khách, chưa câu trả lời nào sau nó (bot · nhân viên ERP · phía page), và là tin SỐNG. */
export const WAITING_REPLY_SQL: SQL<boolean> = safe(
  sql`${col("last_customer_at")} is not null and ${col("last_customer_at")} > ${ts("last_bot_at")} and ${col("last_customer_at")} > ${ts("last_staff_at")}
    and ${col("last_customer_at")} > ${ts("history_until")} and not ${PAGE_REPLY_AFTER_CUSTOMER_SQL}`,
);

/**
 * SỐ tin khách chưa đọc (trần 100 — hàng in «99+»): tin KHÁCH sống mới hơn lần cuối người thấy hội thoại. Tin bot KHÔNG đặt lại bộ
 * đếm — khách hỏi 3 câu, bot trả lời cả 3, chưa ai mở ⇒ «3».
 */
export const HUMAN_UNREAD_COUNT_SQL = sql<number>`(case when ${col("page_id")} is not null and ${col("thread_id")} is not null
  then (select count(*)::int from (select 1 from "sales_chat_inbound" i where i.page_id = ${col("page_id")} and i.thread_id = ${col("thread_id")}
    and i.kind = 'INBOX' and i.imported_at is null and coalesce(i.note, '') not in ('BOT_SENT', ${PAGE_REPLY})
    and i.created_at > ${HUMAN_SEEN} limit 100) x)
  else (select count(*)::int from (select 1 from "sales_chat_messages" m where m.conversation_id = ${col("id")} and m.role = 'user'
    and m.created_at > ${HUMAN_SEEN} limit 100) y) end)`;

const MANUAL_TAKEOVER_SQL = sql`(${MODE} = 'HUMAN' or (${IS_HANDOFF} and ${REASON} = ${TAKEOVER_REASON}))`;
function staffCooldownCore(now: Date): SQL {
  return sql`(${IS_HANDOFF} and (
    ${REASON} = ${WEB_STAFF_REASON}
    or (${REASON} in (${inList(STAFF_COOLDOWN_REASON_LIST)}) and coalesce(${col("human_cooldown_until")}, ${FALLBACK_UNTIL}) > ${now})
    or (${REASON} not in (${inList(STAFF_COOLDOWN_REASON_LIST)}) and coalesce(${col("human_cooldown_until")} > ${now}, false))))`;
}
function aiDownCore(now: Date): SQL {
  return sql`(${IS_HANDOFF} and ${REASON} = ${AI_DOWN_HANDOFF_REASON} and ${FALLBACK_UNTIL} > ${now})`;
}
const AI_HANDOFF_CORE = sql`(${IS_HANDOFF} and ${REASON} not in (${inList(NOT_AI_HANDOFF_REASONS)}) and ${MODE} <> 'HUMAN')`;

/** MỘT loại người đang cầm hội thoại (thứ tự: tiếp quản > nhường > AI gợi ý — đúng `classifyInboxState`). */
export function humanHandlingKindSql(kind: HumanHandling, now: Date, orgCopilot: boolean): SQL<boolean> {
  if (kind === "MANUAL_TAKEOVER") return safe(MANUAL_TAKEOVER_SQL);
  if (kind === "STAFF_COOLDOWN") return safe(sql`not ${MANUAL_TAKEOVER_SQL} and ${staffCooldownCore(now)}`);
  return safe(sql`not ${MANUAL_TAKEOVER_SQL} and not ${safe(staffCooldownCore(now))} and ${orgCopilot ? sql`true` : sql`${MODE} = 'COPILOT'`}`);
}

/** HUMAN_HANDLING — thẻ «Người đang xử lý»: tiếp quản · nhường sau câu tay · AI gợi ý. */
export function humanHandlingSql(now: Date, orgCopilot: boolean): SQL<boolean> {
  return safe(sql`${MANUAL_TAKEOVER_SQL} or ${safe(staffCooldownCore(now))} or ${orgCopilot ? sql`true` : sql`${MODE} = 'COPILOT'`}`);
}

/** NEEDS_HUMAN theo TỪNG lý do (để đếm / bài kiểm). */
export function needsHumanReasonSql(code: NeedsHumanCode, now: Date): SQL<boolean> {
  if (code === "AI_DOWN") return safe(aiDownCore(now));
  if (code === "AI_HANDOFF") return safe(AI_HANDOFF_CORE);
  return safe(ORDER_UNDER_REVIEW_SQL);
}

/** NEEDS_HUMAN — thẻ «Cần người»: có lý do thật cần người quyết (không gồm hội thoại chỉ đang có nhân viên trả lời). */
export function needsHumanSql(now: Date): SQL<boolean> {
  return safe(sql`${aiDownCore(now)} or ${AI_HANDOFF_CORE} or ${ORDER_UNDER_REVIEW_SQL}`);
}

/** «Không ai trả lời»: AI dừng vì cần người (xin người / AI hỏng) và chưa có người cầm. */
function nobodySql(now: Date, orgCopilot: boolean): SQL<boolean> {
  return safe(sql`(${aiDownCore(now)} or ${AI_HANDOFF_CORE}) and not ${humanHandlingSql(now, orgCopilot)}`);
}

/** Thẻ «AI đang trả lời»: không người cầm và AI không dừng vì cần người. */
export function aiReplyingSql(now: Date, orgCopilot: boolean): SQL<boolean> {
  return safe(sql`not ${humanHandlingSql(now, orgCopilot)} and not ${nobodySql(now, orgCopilot)}`);
}

/**
 * TIN CÓ NGHĨA mới nhất (khách · bot · nhân viên ERP · tin nhập từ lịch sử) — khoá xếp của hộp thư và mốc của bộ lọc thời gian.
 * KHÔNG `updated_at`, không cột siêu dữ liệu nào: đổi nhãn, đổi người phụ trách, mở hồ sơ khách, đổi chế độ AI không đẩy hội thoại
 * lên đầu. Hội thoại do LƯỢT NHẬP LỊCH SỬ tạo không lấy giờ nhập làm mốc.
 */
export const INBOX_ACTIVITY_SQL = sql<Date>`greatest(${ts("last_customer_at")}, ${ts("last_bot_at")}, ${ts("last_staff_at")}, ${ts("history_until")}, case when ${col("created_by")} = ${HISTORY_CREATED_BY} then ${EPOCH} else ${col("created_at")} end)`;

// ─────────────────────────── Hàm thuần ───────────────────────────

export type InboxStateInput = {
  status: string;
  handoffReason: string | null;
  state: unknown;
  updatedAt: Date;
  humanCooldownUntil: Date | null;
  lastCustomerAt: Date | null;
  lastBotAt: Date | null;
  lastStaffAt: Date | null;
  staffSeenAt: Date | null;
  historyUntil: Date | null;
  /** `PAGE_REPLY_AFTER_CUSTOMER_SQL` của hội thoại. */
  pageReplyAfterCustomer: boolean;
  /** `ORDER_UNDER_REVIEW_SQL` của hội thoại. */
  orderUnderReview: boolean;
};

export type InboxStates = {
  humanUnread: boolean;
  waitingReply: boolean;
  needsHuman: NeedsHumanCode | null;
  humanHandling: HumanHandling | null;
  replying: InboxReplying;
};

const ms = (d: Date | null | undefined) => (d ? d.getTime() : 0);

/** Phân loại MỘT hội thoại tại `now` — bản thuần của các điều kiện SQL phía trên. HÀM THUẦN. */
export function classifyInboxState(r: InboxStateInput, now: Date, orgCopilot: boolean): InboxStates {
  const t = now.getTime();
  const cust = r.lastCustomerAt ? r.lastCustomerAt.getTime() : null;
  const humanUnread = cust !== null && cust > Math.max(ms(r.staffSeenAt), ms(r.lastStaffAt)) && cust > ms(r.historyUntil);
  const waitingReply = cust !== null && cust > ms(r.lastBotAt) && cust > ms(r.lastStaffAt) && cust > ms(r.historyUntil) && !r.pageReplyAfterCustomer;

  const mode = readConversationControl(r.state)?.mode ?? "AUTO";
  const handoff = r.status === "HANDOFF";
  const reason = r.handoffReason ?? "";
  const fallbackUntil = r.updatedAt.getTime() + HUMAN_COOLDOWN_MS;
  const manual = mode === "HUMAN" || (handoff && reason === TAKEOVER_REASON);
  const cooldown =
    !manual &&
    handoff &&
    (reason === WEB_STAFF_REASON || (STAFF_COOLDOWN_SET.has(reason) ? (r.humanCooldownUntil ? r.humanCooldownUntil.getTime() : fallbackUntil) > t : r.humanCooldownUntil !== null && r.humanCooldownUntil.getTime() > t));
  const copilot = !manual && !cooldown && (orgCopilot || mode === "COPILOT");
  const humanHandling: HumanHandling | null = manual ? "MANUAL_TAKEOVER" : cooldown ? "STAFF_COOLDOWN" : copilot ? "COPILOT" : null;

  const aiDown = handoff && reason === AI_DOWN_HANDOFF_REASON && fallbackUntil > t;
  const aiHandoff = handoff && !NOT_AI_HANDOFF_SET.has(reason) && mode !== "HUMAN";
  const needsHuman: NeedsHumanCode | null = aiDown ? "AI_DOWN" : aiHandoff ? "AI_HANDOFF" : r.orderUnderReview ? "ORDER_REVIEW" : null;
  const replying: InboxReplying = humanHandling ? "HUMAN" : aiDown || aiHandoff ? "NOBODY" : "AI";
  return { humanUnread, waitingReply, needsHuman, humanHandling, replying };
}

/** Huy hiệu AI / người của một hàng từ phân loại: AI gợi ý · Người (tiếp quản / nhường) · Chờ người (AI dừng, chưa ai cầm) · AI. HÀM THUẦN. */
export function inboxHandlingFrom(s: Pick<InboxStates, "humanHandling" | "replying">): InboxHandling {
  if (s.humanHandling === "COPILOT") return "COPILOT";
  if (s.humanHandling) return "HUMAN";
  return s.replying === "NOBODY" ? "WAITING" : "AI";
}
