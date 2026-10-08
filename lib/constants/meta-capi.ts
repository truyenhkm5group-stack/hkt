/**
 * ═══════════ SỰ KIỆN CHUYỂN ĐỔI GỬI META (Conversions API cho tin nhắn doanh nghiệp) — HÀM THUẦN, client-safe ═══════════
 *
 * Chủ shop HSLC 08/10/2026: «gửi sự kiện khi chốt đơn». Đơn chốt trong hội thoại Messenger ⇒ MỘT sự kiện `Purchase`
 * (`action_source = business_messaging`, `messaging_channel = messenger`) mang page + PSID của khách và giá trị đơn, để
 * Trình quản lý quảng cáo đếm được lượt mua mà ERP chốt và Meta tối ưu phân phối theo nó.
 *
 *  · Mốc gửi = lúc CHỐT (sự kiện `order.confirmed`), không phải lúc giao — quyết định của chủ shop; đơn hoàn về sau KHÔNG
 *    được rút lại (Meta không có lệnh huỷ sự kiện), nên con số «lượt mua» của Meta sẽ cao hơn số giao thành công. Đơn bị
 *    huỷ TRƯỚC lượt gửi thì không gửi.
 *  · `event_id` cố định theo đơn ⇒ một lượt gửi lại (mạng chập, không biết lượt trước đã tới chưa) Meta tự khử trùng.
 *  · Meta chỉ nhận sự kiện trong 7 ngày kể từ `event_time` ⇒ quá hạn là `SKIPPED · TOO_OLD`, không cố gửi.
 */

export const META_CAPI_CONNECTOR = "meta-capi-org" as const;
export const META_CAPI_EVENT_NAME = "Purchase" as const;
/** Cửa sổ Meta nhận sự kiện (ngày) — trừ 1 giờ đệm để lượt gửi sát hạn không bị từ chối vì lệch đồng hồ. */
export const META_CAPI_WINDOW_DAYS = 7;
export const META_CAPI_WINDOW_MS = META_CAPI_WINDOW_DAYS * 86_400_000 - 3_600_000;
/** Mỗi lượt job gửi tối đa chừng này sự kiện (một request / sự kiện — lỗi của đơn này không kéo đơn khác). */
export const META_CAPI_SEND_PER_RUN = 60;
/** Mỗi lượt xếp hàng tối đa chừng này đơn chốt mới. */
export const META_CAPI_ENQUEUE_PER_RUN = 300;

export const META_DATASET_ID_PATTERN = /^[0-9]{8,20}$/;
const PAGE_ID_PATTERN = /^[0-9]{5,20}$/;
const PSID_PATTERN = /^[0-9]{5,25}$/;

export const META_CAPI_STATUSES = ["PENDING", "SENT", "SKIPPED", "FAILED"] as const;
export type MetaCapiStatus = (typeof META_CAPI_STATUSES)[number];

export const META_CAPI_SKIP_REASONS = ["NOT_FROM_CHAT", "NOT_MESSENGER", "NO_PSID", "NO_VALUE", "CANCELLED_BEFORE_SEND", "TOO_OLD", "ORDER_MISSING"] as const;
export type MetaCapiSkipReason = (typeof META_CAPI_SKIP_REASONS)[number];
export const META_CAPI_SKIP_LABEL: Record<MetaCapiSkipReason, string> = {
  NOT_FROM_CHAT: "Đơn không chốt trong hội thoại (lên tay / POS)",
  NOT_MESSENGER: "Hội thoại không phải Messenger (Zalo, chat web, bình luận)",
  NO_PSID: "Không có mã khách Messenger (PSID) của hội thoại",
  NO_VALUE: "Đơn chưa có giá trị",
  CANCELLED_BEFORE_SEND: "Đơn huỷ trước lượt gửi",
  TOO_OLD: "Quá 7 ngày — Meta không nhận",
  ORDER_MISSING: "Không còn đơn trong ERP",
};

/** Mã sự kiện cố định theo đơn — Meta khử trùng theo (dataset, event_name, event_id). HÀM THUẦN. */
export function metaCapiEventId(orderId: string): string {
  return `erp-order-${orderId}`;
}

/**
 * PSID của khách trong một hội thoại fanpage. Nguồn chuẩn là `sales_chat_inbound.sender_id` (PSID Pancake / Meta ghi lúc
 * nhận tin — 0233); hội thoại cũ hơn thì mã hội thoại Pancake dạng `<page>_<psid>` (chỉ khi hội thoại có tin nhắn hộp thư,
 * không phải bình luận) hoặc mã hội thoại Messenger trực tiếp (chính là PSID). Không chắc ⇒ `null`, không đoán. HÀM THUẦN.
 */
export function psidOf(input: { pageId: string | null; threadId: string | null; senderId: string | null; hasInboxMessage: boolean }): string | null {
  const sender = (input.senderId ?? "").trim();
  if (PSID_PATTERN.test(sender) && sender !== input.pageId) return sender;
  if (!input.hasInboxMessage || !input.pageId || !input.threadId) return null;
  const thread = input.threadId.trim();
  const prefix = `${input.pageId}_`;
  if (thread.startsWith(prefix)) {
    const rest = thread.slice(prefix.length);
    return PSID_PATTERN.test(rest) ? rest : null;
  }
  return PSID_PATTERN.test(thread) && thread !== input.pageId ? thread : null;
}

export type PurchaseInput = { orderId: string; eventTime: Date; pageId: string; psid: string; valueVnd: number; orderCode?: string | null };

/** Một sự kiện `Purchase` theo hợp đồng Conversions API cho tin nhắn doanh nghiệp (Messenger). HÀM THUẦN. */
export function buildPurchaseEvent(i: PurchaseInput): Record<string, unknown> {
  if (!PAGE_ID_PATTERN.test(i.pageId)) throw new Error("page_id không hợp lệ");
  if (!PSID_PATTERN.test(i.psid)) throw new Error("PSID không hợp lệ");
  if (!Number.isSafeInteger(i.valueVnd) || i.valueVnd <= 0) throw new Error("giá trị đơn phải là số tiền nguyên dương");
  return {
    event_name: META_CAPI_EVENT_NAME,
    event_time: Math.floor(i.eventTime.getTime() / 1000),
    event_id: metaCapiEventId(i.orderId),
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: { page_id: i.pageId, page_scoped_user_id: i.psid },
    custom_data: { currency: "VND", value: i.valueVnd, ...(i.orderCode ? { order_id: i.orderCode } : {}) },
  };
}

/** Phép phân loại một đơn trước khi xếp hàng — HÀM THUẦN (đầu vào đã đọc từ CSDL). */
export function classifyOrderForCapi(i: {
  exists: boolean;
  stage: string | null;
  valueVnd: number | null;
  channel: string | null;
  pageId: string | null;
  psid: string | null;
  eventTime: Date;
  now: Date;
}): { status: "PENDING" } | { status: "SKIPPED"; reason: MetaCapiSkipReason } {
  if (!i.exists) return { status: "SKIPPED", reason: "ORDER_MISSING" };
  if (i.now.getTime() - i.eventTime.getTime() > META_CAPI_WINDOW_MS) return { status: "SKIPPED", reason: "TOO_OLD" };
  if (i.stage === "CANCELLED" || i.stage === "DELETED") return { status: "SKIPPED", reason: "CANCELLED_BEFORE_SEND" };
  if (!i.channel) return { status: "SKIPPED", reason: "NOT_FROM_CHAT" };
  if (i.channel !== "FANPAGE" || !i.pageId || !PAGE_ID_PATTERN.test(i.pageId)) return { status: "SKIPPED", reason: "NOT_MESSENGER" };
  if (!i.psid) return { status: "SKIPPED", reason: "NO_PSID" };
  if (i.valueVnd === null || !Number.isSafeInteger(i.valueVnd) || i.valueVnd <= 0) return { status: "SKIPPED", reason: "NO_VALUE" };
  return { status: "PENDING" };
}

export type CapiVerdict = { ok: true; received: number; fbtraceId: string | null } | { ok: false; auth: boolean; retryable: boolean; message: string; fbtraceId: string | null };

/** Đọc phản hồi của `POST /{dataset}/events`. Không tin HTTP status một mình — đọc `error` trong thân. HÀM THUẦN. */
export function capiVerdict(status: number, body: unknown): CapiVerdict {
  const rec = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  const err = rec && rec.error && typeof rec.error === "object" ? (rec.error as Record<string, unknown>) : null;
  const trace = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 80) : null);
  if (err || status < 200 || status >= 300) {
    const code = err && typeof err.code === "number" ? err.code : null;
    const msg = err && typeof err.message === "string" ? err.message.slice(0, 200) : `HTTP ${status}`;
    const auth = code === 190 || code === 200 || code === 10 || status === 401 || status === 403;
    // 4 / 17 / 32 / 613 = giới hạn tần suất; 1 / 2 = lỗi tạm của Meta; 5xx = phía Meta.
    const retryable = !auth && (status >= 500 || code === 1 || code === 2 || code === 4 || code === 17 || code === 32 || code === 613 || status === 429);
    return { ok: false, auth, retryable, message: auth ? `token không hợp lệ / không có quyền gửi sự kiện vào dataset (${msg})` : msg, fbtraceId: trace(err?.fbtrace_id ?? rec?.fbtrace_id) };
  }
  const received = rec && typeof rec.events_received === "number" ? rec.events_received : 0;
  if (received < 1) return { ok: false, auth: false, retryable: true, message: "Meta trả 200 nhưng không nhận sự kiện nào (events_received = 0)", fbtraceId: trace(rec?.fbtrace_id) };
  return { ok: true, received, fbtraceId: trace(rec?.fbtrace_id) };
}

/** Mốc thử lại sau lượt hỏng thứ `attempts` (1, 2, …): 10 phút × 2^(n−1), trần 6 giờ. HÀM THUẦN. */
export function capiNextAttempt(attempts: number, now: Date): Date {
  const n = Math.max(1, Math.trunc(attempts));
  const minutes = Math.min(10 * 2 ** (n - 1), 360);
  return new Date(now.getTime() + minutes * 60_000);
}

/** Máy chủ Graph API — hằng số, không theo cấu hình (không cho trỏ sự kiện của khách sang máy khác). */
export const META_GRAPH_HOST = "https://graph.facebook.com";
