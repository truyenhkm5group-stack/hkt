/**
 * ═══════════ GỬI TIN RA NHÓM CHAT CỦA TỔ CHỨC — PHẦN THUẦN, CLIENT-SAFE (0180) ═══════════
 *
 * Tài liệu: docs/platform/self-service-journey.md mục «Thông báo nhóm». MỘT giao diện nhà cung cấp (`MessagingProvider`,
 * lib/messaging/providers.ts) cho ba loại kết nối theo tổ chức — Lark webhook, Telegram bot, và HỘP THỬ (sandbox, không
 * gọi mạng, tin nằm trong sổ `messaging_deliveries` để người cấu hình đọc lại). Luật tự động gửi tin qua hành động
 * `send_message` của bộ máy luật (Phase 3) — KHÔNG có đường gửi thứ hai (chatbot không tự gửi vào nhóm).
 *
 * Tệp này KHÔNG import gì chạy được: màn hình cấu hình, bộ kiểm luật và máy chủ dùng chung một bộ khoá, một cú pháp mẫu
 * tin và MỘT hàm điền mẫu (`renderTemplate`), để "xem trước trên màn hình" và "tin thật gửi đi" không bao giờ là hai luật.
 */

/** Kết nối nhắn tin theo tổ chức — khoá trong sổ connector (`lib/connectors/registry.ts`). */
export const MESSAGING_CONNECTOR_KEYS = ["lark-webhook", "telegram-bot", "sandbox-messaging"] as const;
export type MessagingConnectorKey = (typeof MESSAGING_CONNECTOR_KEYS)[number];

export function isMessagingConnector(key: unknown): key is MessagingConnectorKey {
  return typeof key === "string" && (MESSAGING_CONNECTOR_KEYS as readonly string[]).includes(key);
}

export const MESSAGING_CONNECTOR_LABEL: Record<MessagingConnectorKey, string> = {
  "lark-webhook": "Lark — nhóm chat (webhook)",
  "telegram-bot": "Telegram — bot của tổ chức",
  "sandbox-messaging": "Hộp thử (không gửi ra ngoài)",
};

/** Nơi nhận của từng loại — màn hình in câu này cạnh ô "Nơi nhận". */
export const MESSAGING_DESTINATION_HINT: Record<MessagingConnectorKey, string> = {
  "lark-webhook": "Một webhook Lark là MỘT nhóm — tin luôn vào nhóm đã tạo bot. Muốn nhóm khác thì khai kết nối khác.",
  "telegram-bot": "Chat ID của nhóm / kênh (số, thường âm, hoặc @tên_kênh). Bỏ trống = chat đã khai ở kết nối.",
  "sandbox-messaging": "Tên kênh thử để phân biệt khi đọc lại (vd «Nhóm vận hành»). Tin KHÔNG rời khỏi ERP.",
};

/**
 * Trạng thái hiển thị của một kết nối nhắn tin — ba trạng thái yêu cầu + hai trạng thái "chưa xong":
 *  · `CONNECTED` — kết nối thật (Lark / Telegram) đang bật và lần kiểm gần nhất ĐẠT;
 *  · `TEST_MODE` — hộp thử đang bật (tin không rời ERP);
 *  · `FAILED` — lần kiểm gần nhất HỎNG;
 *  · `DRAFT` — đã lưu nhưng chưa kiểm / chưa bật;
 *  · `NOT_CONFIGURED` — chưa khai.
 */
export type MessagingStatus = "CONNECTED" | "TEST_MODE" | "FAILED" | "DRAFT" | "NOT_CONFIGURED";

export const MESSAGING_STATUS_LABEL: Record<MessagingStatus, string> = {
  CONNECTED: "ĐÃ KẾT NỐI",
  TEST_MODE: "CHẾ ĐỘ THỬ",
  FAILED: "LỖI",
  DRAFT: "CHƯA BẬT",
  NOT_CONFIGURED: "CHƯA KHAI",
};

export function messagingStatusOf(connectorKey: MessagingConnectorKey, conn: { status: string; lastTestOk: boolean | null } | null): MessagingStatus {
  if (!conn) return "NOT_CONFIGURED";
  if (conn.lastTestOk === false) return "FAILED";
  if (conn.status === "ACTIVE" && conn.lastTestOk === true) return connectorKey === "sandbox-messaging" ? "TEST_MODE" : "CONNECTED";
  return "DRAFT";
}

// ═══ MẪU TIN ═══

/** Cú pháp ô điền: `{{khoá}}`. Khoá lạ giữ NGUYÊN chữ (người đọc thấy mình gõ sai), không thay bằng rỗng. */
export const TEMPLATE_TOKEN = /\{\{\s*([a-z_]+)\s*\}\}/g;
export const MESSAGE_TEMPLATE_MAX = 2000;

export function renderTemplate(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(TEMPLATE_TOKEN, (whole, key: string) => (Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : whole));
}

/** Khoá có trong mẫu mà không có trong bộ biến — màn hình báo trước khi lưu. */
export function unknownTemplateKeys(template: string, known: readonly string[]): string[] {
  const out = new Set<string>();
  for (const m of template.matchAll(TEMPLATE_TOKEN)) if (!known.includes(m[1])) out.add(m[1]);
  return [...out];
}

/** Ba sự kiện đơn hàng có mẫu tin dựng sẵn. */
export const ORDER_MESSAGE_EVENTS = ["order.confirmed", "order.updated", "order.cancelled"] as const;
export type OrderMessageEvent = (typeof ORDER_MESSAGE_EVENTS)[number];

/** Ô điền được của tin đơn hàng — lib/messaging/order-message.ts dựng ĐÚNG bộ khoá này. */
export const ORDER_MESSAGE_VARS: readonly { key: string; label: string }[] = [
  { key: "order_code", label: "Mã đơn" },
  { key: "status", label: "Trạng thái đơn" },
  { key: "customer_name", label: "Tên khách" },
  { key: "customer_phone", label: "SĐT khách" },
  { key: "recipient_name", label: "Người nhận" },
  { key: "recipient_phone", label: "SĐT người nhận" },
  { key: "address", label: "Địa chỉ giao" },
  { key: "items", label: "Dòng hàng (tên × SL × đơn giá = thành tiền)" },
  { key: "subtotal", label: "Tiền hàng" },
  { key: "discount", label: "Chiết khấu" },
  { key: "shipping_fee", label: "Phí ship" },
  { key: "cod", label: "Tiền thu khi giao (COD)" },
  { key: "source", label: "Nguồn / kênh bán" },
  { key: "note", label: "Ghi chú đơn" },
  { key: "changes", label: "Phần vừa đổi (tin cập nhật)" },
  { key: "cancel_reason", label: "Lý do huỷ" },
  { key: "erp_link", label: "Liên kết mở đơn trong ERP" },
];
export const ORDER_MESSAGE_VAR_KEYS: readonly string[] = ORDER_MESSAGE_VARS.map((v) => v.key);

/** Ô điền được khi luật KHÔNG nói về một đơn (sự kiện khác): tên luật, nhãn bản ghi, tên sự kiện. */
export const GENERIC_MESSAGE_VARS: readonly { key: string; label: string }[] = [
  { key: "rule_name", label: "Tên luật" },
  { key: "subject", label: "Bản ghi / sự kiện đã kích hoạt" },
  { key: "event", label: "Tên sự kiện" },
];
export const GENERIC_MESSAGE_VAR_KEYS: readonly string[] = GENERIC_MESSAGE_VARS.map((v) => v.key);

export const ORDER_MESSAGE_EVENT_LABEL: Record<OrderMessageEvent, string> = {
  "order.confirmed": "Khi đơn được chốt",
  "order.updated": "Khi đơn đã chốt bị sửa (hàng / địa chỉ / tiền thu)",
  "order.cancelled": "Khi đơn đã chốt bị huỷ",
};

export const DEFAULT_ORDER_TEMPLATES: Record<OrderMessageEvent, string> = {
  "order.confirmed": [
    "🟢 ĐƠN MỚI {{order_code}}",
    "Khách: {{customer_name}} · {{customer_phone}}",
    "Người nhận: {{recipient_name}} · {{recipient_phone}}",
    "Địa chỉ: {{address}}",
    "{{items}}",
    "Tiền hàng: {{subtotal}} · Chiết khấu: {{discount}} · Ship: {{shipping_fee}}",
    "THU COD: {{cod}}",
    "Nguồn: {{source}}",
    "Ghi chú: {{note}}",
    "{{erp_link}}",
  ].join("\n"),
  "order.updated": [
    "🟡 CẬP NHẬT ĐƠN {{order_code}} — đổi: {{changes}}",
    "Người nhận: {{recipient_name}} · {{recipient_phone}}",
    "Địa chỉ: {{address}}",
    "{{items}}",
    "Ship: {{shipping_fee}} · THU COD: {{cod}}",
    "{{erp_link}}",
  ].join("\n"),
  "order.cancelled": ["🔴 HUỶ ĐƠN {{order_code}}", "Khách: {{customer_name}} · {{customer_phone}}", "Lý do: {{cancel_reason}}", "Không đóng / không giao đơn này.", "{{erp_link}}"].join("\n"),
};

/** Khoá luật do bộ cấu hình «Báo nhóm vận hành» quản lý — một luật cho mỗi sự kiện. */
export const ORDER_NOTIFY_RULE_KEYS: Record<OrderMessageEvent, string> = {
  "order.confirmed": "bao_nhom_don_xac_nhan",
  "order.updated": "bao_nhom_don_cap_nhat",
  "order.cancelled": "bao_nhom_don_huy",
};
