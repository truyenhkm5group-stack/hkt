import type { ModuleKey } from "@/lib/constants/platform-modules";

/**
 * ═══════════ SỔ CONNECTOR — KHAI ĐÚNG SỰ THẬT MỌI TÍCH HỢP ĐANG CÓ ═══════════
 *
 * Hợp đồng: docs/platform/phase-9-contracts.md §1 · builder-roadmap X6/X7.
 *
 * Sổ này KHÔNG viết lại tích hợp nào. Pancake, Viettel Post, Meta, SePay, Lark/Telegram, AI… vẫn chạy
 * đúng đường cũ của tổ chức nhà (VNX), bằng credential ở biến môi trường / bảng `settings` nhà. Sổ
 * chỉ NÓI RA từng cái: làm được gì, xác thực kiểu gì, cài đặt nằm ở đâu, webhook phân giải tổ chức
 * thế nào, có hàm kiểm tra sức khoẻ thật không, và — quan trọng nhất — tổ chức nào được dùng.
 *
 * ─── HAI MỨC THUÊ BAO ───
 *
 *  · `HOME_ONLY` — credential là của tổ chức nhà (biến môi trường). Mọi lối gọi mạng chặn bằng
 *    `assertHomeCredentials()`; màn hình Kết nối hiện ở chế độ CHỈ ĐỌC cho tổ chức nhà (đã cấu hình
 *    hay chưa — KHÔNG BAO GIỜ hiện giá trị) và "chưa mở" cho tổ chức khác. Không chuyển credential
 *    của VNX sang bảng mới (quyết định X7).
 *  · `PER_ORG` — mỗi tổ chức tự khai trong CSDL của chính nó (`org_connections`, bí mật mã hoá), hoặc
 *    không cần credential nào (`auth: "NONE"`, dữ liệu do người tải lên CSDL của tổ chức đang đăng nhập).
 *
 * ─── KHAI SAI LÀ ĐỎ ───
 *
 * `tests/connectors.test.ts` quét mã: mỗi thư mục/tệp dưới `lib/integrations/` phải thuộc ĐÚNG MỘT mục
 * (qua `code`), mỗi route `app/api/webhooks/**` phải có mục khai `webhook.path`, mỗi `webhook.binding`
 * phải khớp chế độ trong `WEBHOOK_BINDINGS`, mỗi `healthRef` phải trỏ tới một hàm có thật, mỗi biến
 * môi trường credential của nhà (`CUSTOMER_CREDENTIAL_ENV`) phải được một mục khai.
 *
 * Tệp THUẦN và client-safe: chỉ `import type`.
 */

export const CONNECTOR_KINDS = ["ORDER_SOURCE", "SHIPPING", "PAYMENT", "ADS", "MESSAGING", "ACCOUNTING", "AI", "STORAGE", "PLATFORM"] as const;
export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export const CONNECTOR_KIND_LABEL: Record<ConnectorKind, string> = {
  ORDER_SOURCE: "Nguồn đơn hàng",
  SHIPPING: "Vận chuyển",
  PAYMENT: "Thanh toán & ngân hàng",
  ADS: "Quảng cáo",
  MESSAGING: "Gửi tin & nhắn khách",
  ACCOUNTING: "Kế toán",
  AI: "Trí tuệ nhân tạo",
  STORAGE: "Lưu trữ & sao lưu",
  PLATFORM: "Vận hành nền tảng",
};

/**
 * Năng lực — tập ĐÓNG theo loại. Một năng lực không có trong danh sách của loại mình là khai sai
 * (bài kiểm chặn), vì màn hình và luật tự động sau này sẽ hỏi "connector nào làm được X".
 */
export const CAPABILITIES_BY_KIND = {
  ORDER_SOURCE: ["pull_orders", "pull_products", "pull_customers", "pull_inventory", "webhook_orders", "create_order", "read_public_sheet"],
  SHIPPING: ["track", "webhook_status", "create_label", "update_order", "import_file", "cod_statement"],
  PAYMENT: ["webhook_transactions", "pull_transactions", "import_statement"],
  ADS: ["read_spend", "read_billing", "write_budget", "publish_ads"],
  MESSAGING: ["send_group_message", "send_customer_message", "read_conversations", "bot_admin"],
  ACCOUNTING: ["export_ledger"],
  AI: ["chat", "vision", "image_generate", "video_generate", "speech"],
  STORAGE: ["offsite_backup"],
  PLATFORM: ["read_deployments", "read_pull_requests", "dispatch_workflow", "agent_ingest"],
} as const satisfies Record<ConnectorKind, readonly string[]>;
export type ConnectorCapability = (typeof CAPABILITIES_BY_KIND)[ConnectorKind][number];

export type ConnectorAuth = "API_KEY" | "USERNAME_PASSWORD" | "OAUTH_TOKEN" | "WEBHOOK_SECRET" | "NONE";
export type ConnectorTenancy = "HOME_ONLY" | "PER_ORG";

export const CONNECTOR_AUTH_LABEL: Record<ConnectorAuth, string> = {
  API_KEY: "Khoá API",
  USERNAME_PASSWORD: "Tài khoản + mật khẩu",
  OAUTH_TOKEN: "Token uỷ quyền",
  WEBHOOK_SECRET: "Bí mật webhook",
  NONE: "Không cần khoá",
};

/** Một ô cài đặt. `secret` ⇒ không bao giờ trả về trình duyệt (chỉ `••••` + 4 ký tự cuối). */
export type SettingField = {
  key: string;
  label: string;
  type: "text" | "url";
  secret: boolean;
  required: boolean;
  hint?: string;
  /** Biểu thức chính quy (nguồn) mà giá trị phải khớp — kiểm ở máy chủ trước khi lưu. */
  pattern?: string;
  maxLength?: number;
  /** HOME_ONLY: biến môi trường đang giữ giá trị này cho tổ chức nhà (chỉ để khai, không đọc từ sổ). */
  envVar?: string;
};

/**
 * Cài đặt đang nằm ở đâu:
 *  · `ENV` — biến môi trường của máy chủ (của tổ chức nhà).
 *  · `ORG_CONNECTIONS` — bảng `org_connections` trong CSDL của tổ chức (màn hình `/settings/connections`).
 *  · `SETTINGS_TABLE` — bảng `settings` của CSDL tổ chức, sửa ở màn hình nghiệp vụ `where`.
 *  · `NONE` — không cần cài đặt (dữ liệu do người tải lên).
 */
export type ConnectorConfigStore = "ENV" | "ORG_CONNECTIONS" | "SETTINGS_TABLE" | "NONE";

/** Khớp khoá của `WEBHOOK_BINDINGS` (lib/platform/webhooks.ts) — bài kiểm so hai bên. */
export type WebhookBindingKey = "PANCAKE" | "VIETTELPOST" | "VTP_STATEMENT" | "SEPAY";

export type ConnectorWebhook = {
  /** Đường dẫn route theo cú pháp thư mục của Next (`[secret]`, `[[...event]]`). */
  path: string;
  /** Bên gửi xác thực bằng gì — một câu, không kèm giá trị. */
  verify: string;
  tenantResolution: "URL_SECRET" | "SIGNATURE" | "HOME_ONLY";
  /** Khoá chống trùng thật mà route dùng (đọc từ mã, không phải ý muốn). */
  idempotencyKey: string;
  /** Dòng khai trong `WEBHOOK_BINDINGS`; `null` = tuyến máy-gọi-máy không qua bảng đó (vd cửa ghi sổ agent). */
  binding: WebhookBindingKey | null;
};

export type ConnectorSpec = {
  key: string;
  label: string;
  vendor: string;
  kind: ConnectorKind;
  capabilities: readonly ConnectorCapability[];
  auth: ConnectorAuth;
  settings: readonly SettingField[];
  config: { store: ConnectorConfigStore; where: string };
  webhook: ConnectorWebhook | null;
  tenancy: ConnectorTenancy;
  /** `testConnection` ⇒ có hàm kiểm tra thật (`healthRef` = "tệp::hàm"). `null` ⇒ không có, nói thẳng. */
  health: "testConnection" | null;
  healthRef: string | null;
  module: ModuleKey;
  /** Tệp / thư mục (kết thúc `/`) hiện thực connector — bài kiểm đối chiếu với `lib/integrations/*`. */
  code: readonly string[];
  /**
   * Luồng chạy nào ĐỌC kết nối `PER_ORG` này lúc chạy. Rỗng = mới khai và kiểm được, CHƯA luồng nào
   * dùng — màn hình phải nói ra, không để người dùng tưởng bật lên là cảnh báo sẽ đi qua đây.
   */
  consumers: readonly string[];
  why: string;
};

const HOME_WHY = "Credential là biến môi trường của tổ chức nhà; mọi lối gọi mạng chặn tổ chức khác bằng assertHomeCredentials (P12).";

export const CONNECTORS: readonly ConnectorSpec[] = [
  // ─────────────── NGUỒN ĐƠN ───────────────
  {
    key: "pancake-pos",
    label: "Pancake POS",
    vendor: "Pancake",
    kind: "ORDER_SOURCE",
    capabilities: ["pull_orders", "pull_products", "pull_customers", "pull_inventory", "webhook_orders", "create_order"],
    auth: "API_KEY",
    settings: [
      { key: "apiKey", label: "API key", type: "text", secret: true, required: true, envVar: "PANCAKE_API_KEY" },
      { key: "shopId", label: "Mã shop", type: "text", secret: false, required: true, envVar: "PANCAKE_SHOP_ID" },
      { key: "webhookSecret", label: "Bí mật trong URL webhook", type: "text", secret: true, required: false, envVar: "PANCAKE_WEBHOOK_SECRET" },
    ],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env) — trang /integrations của tổ chức nhà" },
    webhook: {
      path: "/api/webhooks/pancake/[secret]/[[...event]]",
      verify: "Bí mật nằm trong ĐƯỜNG DẪN, so hằng thời gian với PANCAKE_WEBHOOK_SECRET trước khi đọc body",
      tenantResolution: "HOME_ONLY",
      idempotencyKey: "webhookDedupeKey(PANCAKE, [loại, id, updated_at])",
      binding: "PANCAKE",
    },
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/pancake/client.ts::testConnection",
    module: "connector_pancake",
    code: ["lib/integrations/pancake/client.ts", "lib/integrations/pancake/sync.ts", "lib/integrations/pancake/mapper.ts", "lib/integrations/pancake/webhook.ts", "lib/landing/pos.ts"],
    consumers: [],
    why: `Đơn, khách, sản phẩm, tồn và đổi trả của VNX; landing gửi đơn nháp lên POS. ${HOME_WHY}`,
  },
  {
    key: "google-sheet-landing",
    label: "Google Sheet đơn landing",
    vendor: "Google",
    kind: "ORDER_SOURCE",
    capabilities: ["read_public_sheet"],
    auth: "NONE",
    settings: [{ key: "sheetUrl", label: "Link Google Sheet (CSV công khai)", type: "url", secret: false, required: true }],
    config: { store: "SETTINGS_TABLE", where: "settings[\"landing.config\"].sheetUrl — sửa ở /landing" },
    webhook: null,
    tenancy: "PER_ORG",
    health: null,
    healthRef: null,
    module: "sales_channels",
    code: ["lib/landing/sheet.ts"],
    consumers: ["lib/landing/sheet.ts"],
    why: "CSV export công khai, không khoá (AGENTS mục 5); URL đọc từ settings của CHÍNH tổ chức đang chạy — đã là theo tổ chức từ trước nền tảng.",
  },
  // ─────────────── VẬN CHUYỂN ───────────────
  {
    key: "viettelpost",
    label: "Viettel Post",
    vendor: "Viettel Post",
    kind: "SHIPPING",
    capabilities: ["track", "webhook_status", "update_order", "import_file"],
    auth: "USERNAME_PASSWORD",
    settings: [
      { key: "apiKey", label: "Token đối tác (thay cho tài khoản)", type: "text", secret: true, required: false, envVar: "VIETTELPOST_API_KEY" },
      { key: "username", label: "Tài khoản", type: "text", secret: false, required: false, envVar: "VIETTELPOST_USERNAME" },
      { key: "password", label: "Mật khẩu", type: "text", secret: true, required: false, envVar: "VIETTELPOST_PASSWORD" },
      { key: "webhookSecret", label: "Bí mật webhook", type: "text", secret: true, required: false, envVar: "VIETTELPOST_WEBHOOK_SECRET" },
    ],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env) — trang /integrations của tổ chức nhà" },
    webhook: {
      path: "/api/webhooks/viettelpost",
      verify: "Bí mật ở header / query / Bearer, hoặc TOKEN trong body, so với VIETTELPOST_WEBHOOK_SECRET; production thiếu bí mật ⇒ 503",
      tenantResolution: "HOME_ONLY",
      idempotencyKey: "webhookDedupeKey(VIETTELPOST, [ORDER_NUMBER, trạng thái, mốc ĐVVC]) — gửi lại chỉ tăng delivery_count, xử lý lại idempotent",
      binding: "VIETTELPOST",
    },
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/viettelpost/client.ts::testConnection",
    module: "connector_viettelpost",
    code: [
      "lib/integrations/viettelpost/client.ts",
      "lib/integrations/viettelpost/sync.ts",
      "lib/integrations/viettelpost/state.ts",
      "lib/integrations/viettelpost/status.ts",
      "lib/integrations/viettelpost/registry.ts",
      "lib/integrations/viettelpost/import-files.ts",
      "lib/integrations/viettelpost/import-preview.ts",
      "lib/integrations/viettelpost/import-run.ts",
    ],
    consumers: [],
    why: `Webhook là nguồn tin duy nhất của vận đơn (luật 51); API tra cứu/đổi đơn + nhập tệp Danh sách vận đơn. ${HOME_WHY}`,
  },
  {
    key: "viettelpost-statement",
    label: "Bảng kê COD Viettel Post (Gmail)",
    vendor: "Viettel Post",
    kind: "SHIPPING",
    capabilities: ["cod_statement", "import_file"],
    auth: "WEBHOOK_SECRET",
    settings: [{ key: "webhookSecret", label: "Bí mật webhook (dùng chung với Viettel Post)", type: "text", secret: true, required: true, envVar: "VIETTELPOST_WEBHOOK_SECRET" }],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env) + kịch bản Apps Script trong hộp thư của tổ chức nhà" },
    webhook: {
      path: "/api/webhooks/vtp-statement",
      verify: "x-webhook-secret / x-token / Bearer / ?secret= hoặc token trong body, so với VIETTELPOST_WEBHOOK_SECRET",
      tenantResolution: "HOME_ONLY",
      idempotencyKey: "checksum SHA-256 của NỘI DUNG tệp (vtp_import_batches, luật 49)",
      binding: "VTP_STATEMENT",
    },
    tenancy: "HOME_ONLY",
    health: null,
    healthRef: null,
    module: "connector_viettelpost",
    code: ["lib/integrations/viettelpost/statement.ts", "lib/integrations/viettelpost/statement-db.ts", "lib/integrations/viettelpost/statement-mail.ts"],
    consumers: [],
    why: `Ghi tiền thật (COD thực thu). Không có hàm kiểm tra — sức khoẻ đọc bằng nhịp tim của kịch bản Gmail. ${HOME_WHY}`,
  },
  // ─────────────── THANH TOÁN ───────────────
  {
    key: "sepay",
    label: "SePay (biến động số dư)",
    vendor: "SePay",
    kind: "PAYMENT",
    capabilities: ["webhook_transactions", "pull_transactions"],
    auth: "WEBHOOK_SECRET",
    settings: [
      { key: "webhookSecret", label: "Khoá ký HMAC webhook", type: "text", secret: true, required: false, envVar: "SEPAY_WEBHOOK_SECRET" },
      { key: "webhookApiKey", label: "API key webhook (lùi)", type: "text", secret: true, required: false, envVar: "SEPAY_WEBHOOK_API_KEY" },
      { key: "apiToken", label: "Token API v2 (đối chiếu)", type: "text", secret: true, required: false, envVar: "SEPAY_API_TOKEN" },
    ],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env)" },
    webhook: {
      path: "/api/webhooks/sepay",
      verify: "HMAC trên {timestamp}.{byte gốc} bằng SEPAY_WEBHOOK_SECRET, lùi về API key",
      tenantResolution: "HOME_ONLY",
      idempotencyKey: "webhookDedupeKey(SEPAY, [bank_transaction, id SePay]) + providerTxnId duy nhất",
      binding: "SEPAY",
    },
    tenancy: "HOME_ONLY",
    health: null,
    healthRef: null,
    module: "connector_bank",
    code: ["lib/integrations/bank/sepay.ts", "lib/integrations/bank/sepay-api.ts", "lib/integrations/bank/sepay-ingest.ts", "lib/integrations/bank/sepay-reconcile.ts"],
    consumers: [],
    why: `Ghi sổ ngân hàng đồng bộ (lỗi ⇒ 5xx để SePay gửi lại). Chưa có hàm kiểm tra riêng. ${HOME_WHY}`,
  },
  {
    key: "bank-statement-file",
    label: "Sao kê ngân hàng (tệp)",
    vendor: "Ngân hàng",
    kind: "PAYMENT",
    capabilities: ["import_statement"],
    auth: "NONE",
    settings: [],
    config: { store: "NONE", where: "Người dùng tải tệp sao kê lên /bank — ghi vào CSDL của tổ chức đang đăng nhập" },
    webhook: null,
    tenancy: "PER_ORG",
    health: null,
    healthRef: null,
    module: "finance",
    code: [
      "lib/integrations/bank/apply-rules.ts",
      "lib/integrations/bank/import.ts",
      "lib/integrations/bank/internal-transfer.ts",
      "lib/integrations/bank/ledger.ts",
      "lib/integrations/bank/match.ts",
      "lib/integrations/bank/rules.ts",
      "lib/integrations/bank/statement-file.ts",
      "lib/integrations/bank/statement-import.ts",
      "lib/integrations/bank/statement.ts",
    ],
    consumers: ["lib/integrations/bank/statement-import.ts"],
    why: "Không có credential nào: tệp do người tải lên, ghi vào getDb() của tổ chức đang đăng nhập — tự nhiên là theo tổ chức (luật 17).",
  },
  // ─────────────── QUẢNG CÁO ───────────────
  {
    key: "meta-ads",
    label: "Meta Ads (Facebook)",
    vendor: "Meta",
    kind: "ADS",
    capabilities: ["read_spend", "read_billing", "write_budget", "publish_ads"],
    auth: "OAUTH_TOKEN",
    settings: [
      { key: "accessToken", label: "Token System User", type: "text", secret: true, required: true, envVar: "FACEBOOK_ACCESS_TOKEN" },
      { key: "businessId", label: "Mã Business Manager", type: "text", secret: false, required: true, envVar: "FACEBOOK_BUSINESS_ID" },
    ],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env); cổng ghi ADS_WRITE_ENABLED + settings[\"ads.write.kill\"]" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/facebook/client.ts::testConnection",
    module: "connector_meta",
    code: ["lib/integrations/facebook/"],
    consumers: [],
    why: `Chỉ qua System User token (AGENTS mục 5). Nhánh GHI tiêu tiền thật. ${HOME_WHY}`,
  },
  // ─────────────── GỬI TIN ───────────────
  {
    key: "pancake-pages",
    label: "Pancake Pages (hội thoại fanpage)",
    vendor: "Pancake",
    kind: "MESSAGING",
    capabilities: ["read_conversations", "send_customer_message"],
    auth: "OAUTH_TOKEN",
    settings: [{ key: "accessToken", label: "Access token Pancake Pages", type: "text", secret: true, required: true, envVar: "PANCAKE_ACCESS_TOKEN" }],
    config: { store: "ENV", where: "Biến môi trường máy chủ (.env)" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/pancake/pages.ts::testConnection",
    module: "connector_pancake",
    code: ["lib/integrations/pancake/pages.ts"],
    consumers: [],
    why: `Nhắn tin TỚI KHÁCH HÀNG — chạy nhầm tổ chức là nhắn khách của người khác. ${HOME_WHY}`,
  },
  {
    key: "pancake-chatbot",
    label: "Bot chat bán hàng",
    vendor: "Nội bộ (container chatbot)",
    kind: "MESSAGING",
    capabilities: ["bot_admin"],
    auth: "API_KEY",
    settings: [{ key: "adminToken", label: "Khoá nội bộ bot", type: "text", secret: true, required: true, envVar: "CHATBOT_ADMIN_TOKEN" }],
    config: { store: "ENV", where: "Biến môi trường máy chủ (install-vps.sh sinh khoá); cài đặt bot trong volume chatbot_data" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/chatbot/client.ts::getChatbotStatus",
    module: "connector_pancake",
    code: ["lib/integrations/chatbot/"],
    consumers: [],
    why: `MỘT bot cho cả máy chủ = bot của VNX; proxy /api/chatbot chỉ cho tổ chức nhà. ${HOME_WHY}`,
  },
  {
    key: "lark-alerts",
    label: "Lark — kênh cảnh báo hiện hành",
    vendor: "Lark Suite",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "WEBHOOK_SECRET",
    settings: [
      { key: "webhookUrl", label: "Webhook nhóm chính", type: "url", secret: true, required: false, envVar: "LARK_WEBHOOK_URL" },
      { key: "secret", label: "Khoá ký nhóm chính", type: "text", secret: true, required: false, envVar: "LARK_WEBHOOK_SECRET" },
      { key: "billingWebhookUrl", label: "Webhook nhóm thanh toán QC", type: "url", secret: true, required: false, envVar: "LARK_BILLING_WEBHOOK_URL" },
      { key: "billingSecret", label: "Khoá ký nhóm thanh toán QC", type: "text", secret: true, required: false, envVar: "LARK_BILLING_WEBHOOK_SECRET" },
      { key: "inventoryWebhookUrl", label: "Webhook nhóm kho", type: "url", secret: true, required: false, envVar: "LARK_INVENTORY_WEBHOOK_URL" },
      { key: "inventorySecret", label: "Khoá ký nhóm kho", type: "text", secret: true, required: false, envVar: "LARK_INVENTORY_WEBHOOK_SECRET" },
      { key: "managerWebhookUrl", label: "Webhook nhóm quản lý", type: "url", secret: true, required: false, envVar: "LARK_MANAGER_WEBHOOK_URL" },
      { key: "managerSecret", label: "Khoá ký nhóm quản lý", type: "text", secret: true, required: false, envVar: "LARK_MANAGER_WEBHOOK_SECRET" },
    ],
    config: { store: "SETTINGS_TABLE", where: "settings[\"alerts.config\"] ở /alerts, lùi về biến môi trường LARK_* (chỉ tổ chức nhà)" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/actions/alerts.ts::sendTestLark",
    module: "connector_messaging",
    code: ["lib/alerts/lark.ts"],
    consumers: [],
    why: "Cảnh báo, bản tin sáng, lương tự động, leo thang đi qua đây. postToLark chặn tổ chức khác nhà KỂ CẢ khi địa chỉ lấy từ settings của họ — kênh của tổ chức khác là mục «lark-webhook».",
  },
  {
    key: "telegram-alerts",
    label: "Telegram — kênh cảnh báo hiện hành",
    vendor: "Telegram",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "API_KEY",
    settings: [
      { key: "botToken", label: "Bot token", type: "text", secret: true, required: false, envVar: "TELEGRAM_BOT_TOKEN" },
      { key: "chatId", label: "Chat ID", type: "text", secret: false, required: false, envVar: "TELEGRAM_CHAT_ID" },
    ],
    config: { store: "SETTINGS_TABLE", where: "settings[\"alerts.config\"] ở /alerts, lùi về biến môi trường TELEGRAM_* (chỉ tổ chức nhà)" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/actions/alerts.ts::sendTestTelegram",
    module: "connector_messaging",
    code: ["lib/alerts/telegram.ts"],
    consumers: [],
    why: "Như Lark: sendTelegram chặn tổ chức khác nhà. Kênh Telegram của tổ chức khác là mục «telegram-bot».",
  },
  {
    key: "lark-webhook",
    label: "Lark — webhook nhóm của tổ chức",
    vendor: "Lark Suite",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "WEBHOOK_SECRET",
    settings: [
      {
        key: "webhookUrl",
        label: "Webhook URL của Custom Bot",
        type: "url",
        secret: true,
        required: true,
        hint: "Nhóm Lark → Cài đặt → Bots → Thêm bot tuỳ chỉnh → Webhook URL. Chỉ nhận open.larksuite.com / open.feishu.cn.",
        pattern: "^https://open\\.(larksuite\\.com|feishu\\.cn)/open-apis/bot/v2/hook/[A-Za-z0-9-]{8,80}$",
        maxLength: 200,
      },
      { key: "signSecret", label: "Khoá ký (nếu bật Signature)", type: "text", secret: true, required: false, maxLength: 200 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testLarkWebhook",
    module: "alerts",
    code: ["lib/connectors/testers.ts"],
    consumers: [],
    why: "Kênh nhóm chat do CHÍNH tổ chức khai. Kiểm tra = gửi MỘT tin thử vào đúng nhóm đó (chỉ tới máy chủ Lark). Chưa luồng cảnh báo nào đọc bảng này — nối vào loadAlertConfig là bước sau, nói thẳng trên màn hình.",
  },
  {
    key: "telegram-bot",
    label: "Telegram — bot của tổ chức",
    vendor: "Telegram",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "API_KEY",
    settings: [
      { key: "botToken", label: "Bot token (từ @BotFather)", type: "text", secret: true, required: true, pattern: "^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$", maxLength: 90 },
      { key: "chatId", label: "Chat ID nhóm nhận tin", type: "text", secret: false, required: true, pattern: "^-?[0-9]{3,20}$|^@[A-Za-z0-9_]{5,64}$", maxLength: 70 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testTelegramBot",
    module: "alerts",
    code: ["lib/connectors/testers.ts"],
    consumers: [],
    why: "Bot do CHÍNH tổ chức tạo. Kiểm tra = getMe (chỉ đọc) rồi gửi MỘT tin thử vào chat đã khai, chỉ tới api.telegram.org. Chưa luồng cảnh báo nào đọc bảng này.",
  },
  // ─────────────── AI ───────────────
  {
    key: "ai-chat",
    label: "Trợ lý AI (Anthropic / OpenAI)",
    vendor: "Anthropic · OpenAI",
    kind: "AI",
    capabilities: ["chat"],
    auth: "API_KEY",
    settings: [
      { key: "anthropicApiKey", label: "Anthropic API key", type: "text", secret: true, required: false, envVar: "ANTHROPIC_API_KEY" },
      { key: "openaiApiKey", label: "OpenAI API key", type: "text", secret: true, required: false, envVar: "OPENAI_API_KEY" },
    ],
    config: { store: "ENV", where: "Biến môi trường máy chủ; chọn nhà cung cấp bằng AI_PROVIDER / AI_MODEL" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/ai/provider.ts::testAiConnection",
    module: "core",
    code: ["lib/ai/provider.ts", "lib/ai/providers/openai.ts"],
    consumers: [],
    why: `Trợ lý AI dùng chung không phải một module ở Phase 1 (khai ở lõi). Khoá của NỀN TẢNG hay của khách là quyết định còn treo (integration-inventory §2.3). ${HOME_WHY}`,
  },
  /*
    KHOÁ AI CỦA CHÍNH TỔ CHỨC (Phase 8 · §1 — "ai dùng người ấy trả"). Không có khoá AI dùng chung của nền tảng: AI
    Builder của một tổ chức đọc ĐÚNG MỘT kết nối đang bật của chính nó (`openActiveConnection`), còn khoá `.env` của
    tổ chức nhà (`ai-chat`) không bao giờ đi qua đây. Kiểm tra = liệt kê model (chỉ đọc, không tốn token).
  */
  {
    key: "anthropic-byok",
    label: "Anthropic — khoá AI của tổ chức",
    vendor: "Anthropic",
    kind: "AI",
    capabilities: ["chat"],
    auth: "API_KEY",
    settings: [
      { key: "apiKey", label: "Anthropic API key", type: "text", secret: true, required: true, hint: "console.anthropic.com → API keys. Khoá của tổ chức — tổ chức trả tiền token.", pattern: "^sk-ant-[A-Za-z0-9_-]{20,200}$", maxLength: 220 },
      { key: "model", label: "Model (để trống = mặc định)", type: "text", secret: false, required: false, hint: "Ví dụ claude-opus-5. Để trống thì dùng model mặc định của bậc trợ lý.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testAnthropicKey",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/ai-builder/providers.ts"],
    consumers: ["lib/ai-builder/provider.ts::getBuilderAi"],
    why: "Khoá AI do CHÍNH tổ chức mang đến cho AI Builder (Phase 8). Kiểm tra = GET /v1/models (chỉ đọc, không tốn token), chỉ tới api.anthropic.com, không theo chuyển hướng. Khoá .env của tổ chức nhà không bao giờ dùng thay.",
  },
  {
    key: "openai-byok",
    label: "OpenAI — khoá AI của tổ chức",
    vendor: "OpenAI",
    kind: "AI",
    capabilities: ["chat"],
    auth: "API_KEY",
    settings: [
      { key: "apiKey", label: "OpenAI API key", type: "text", secret: true, required: true, hint: "platform.openai.com → API keys. Khoá của tổ chức — tổ chức trả tiền token.", pattern: "^sk-[A-Za-z0-9_-]{20,200}$", maxLength: 220 },
      { key: "model", label: "Model (để trống = mặc định)", type: "text", secret: false, required: false, hint: "Để trống thì dùng model mặc định của bậc trợ lý.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testOpenAiKey",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/ai-builder/providers.ts"],
    consumers: ["lib/ai-builder/provider.ts::getBuilderAi"],
    why: "Khoá AI do CHÍNH tổ chức mang đến cho AI Builder (Phase 8). Kiểm tra = GET /v1/models (chỉ đọc, không tốn token), chỉ tới api.openai.com, không theo chuyển hướng. Khoá .env của tổ chức nhà không bao giờ dùng thay.",
  },
  {
    key: "openai-rest",
    label: "OpenAI REST (ảnh, đọc ảnh, giọng đọc)",
    vendor: "OpenAI",
    kind: "AI",
    capabilities: ["vision", "image_generate", "speech"],
    auth: "API_KEY",
    settings: [{ key: "apiKey", label: "OpenAI API key", type: "text", secret: true, required: true, envVar: "OPENAI_API_KEY" }],
    config: { store: "ENV", where: "Biến môi trường máy chủ" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: null,
    healthRef: null,
    module: "marketing",
    code: ["lib/integrations/openai/", "lib/creative/caption.ts", "lib/creative/vision.ts", "lib/creative/dna.ts", "lib/video-scale/openai-json.ts", "lib/video-scale/tts.ts"],
    consumers: [],
    why: `Sinh / đọc ảnh mẫu QC, kịch bản và giọng đọc Video Scale — tốn tiền thật. Không có hàm kiểm tra riêng. ${HOME_WHY}`,
  },
  {
    key: "gemini-video",
    label: "Gemini (Veo / Omni) — video",
    vendor: "Google",
    kind: "AI",
    capabilities: ["video_generate"],
    auth: "API_KEY",
    settings: [{ key: "apiKey", label: "Gemini API key", type: "text", secret: true, required: true, envVar: "GEMINI_API_KEY" }],
    config: { store: "ENV", where: "Biến môi trường máy chủ (GitHub Secret GEMINI_API_KEY → deploy)" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: null,
    healthRef: null,
    module: "marketing",
    code: ["lib/video-scale/providers/veo.ts", "lib/video-scale/providers/omni.ts"],
    consumers: [],
    why: `Video Scale — tốn tiền thật. Không có hàm kiểm tra riêng. ${HOME_WHY}`,
  },
  // ─────────────── LƯU TRỮ ───────────────
  {
    key: "google-drive-backup",
    label: "Google Drive — sao lưu ngoài máy chủ",
    vendor: "Google",
    kind: "STORAGE",
    capabilities: ["offsite_backup"],
    auth: "OAUTH_TOKEN",
    settings: [],
    config: { store: "ENV", where: "rclone trên máy chủ (/root/.config/erp-backup/offsite.env) — ứng dụng chỉ đọc trạng thái qua ERP_BACKUP_STATUS_DIR" },
    webhook: null,
    tenancy: "HOME_ONLY",
    health: null,
    healthRef: null,
    module: "core",
    code: ["scripts/erp-backup.sh", "lib/queries/backup-status.ts"],
    consumers: [],
    why: "Cron máy chủ sao lưu ĐÚNG MỘT CSDL (erp = nhà). CSDL tổ chức khác chưa được sao lưu — rủi ro còn mở (integration-inventory §1).",
  },
  // ─────────────── NỀN TẢNG ───────────────
  {
    key: "github",
    label: "GitHub (deploy, PR, agent)",
    vendor: "GitHub",
    kind: "PLATFORM",
    capabilities: ["read_deployments", "read_pull_requests", "dispatch_workflow", "agent_ingest"],
    auth: "OAUTH_TOKEN",
    settings: [],
    config: { store: "ENV", where: "ERP_GITHUB_TOKEN / ERP_GITHUB_DISPATCH_TOKEN / ERP_AGENT_GITHUB_APP_* — của NGƯỜI VẬN HÀNH nền tảng" },
    webhook: {
      path: "/api/tech/agent-run",
      verify: "AGENT_INGEST_SECRET (hoặc CRON_SECRET) so hằng thời gian; cửa hẹp, lược đồ .strict()",
      tenantResolution: "HOME_ONLY",
      idempotencyKey: "external_ref của lượt chạy — chỉ TẠO, gọi lại cùng khoá trả dòng cũ",
      binding: null,
    },
    tenancy: "HOME_ONLY",
    health: "testConnection",
    healthRef: "lib/integrations/github/client.ts::testConnection",
    module: "tech",
    code: ["lib/integrations/github/"],
    consumers: [],
    why: "Thuộc người vận hành NỀN TẢNG, không phải khách; bảng tech_* ở CSDL nhà. Module Tech chỉ tổ chức nhà bật được.",
  },
];

/** Tệp dưới `lib/integrations/` KHÔNG phải một connector — lý do bắt buộc (bài kiểm đọc). */
export const INTEGRATION_HELPERS: Readonly<Record<string, string>> = {
  "lib/integrations/http.ts": "Bộ gửi chung fetchJson (thử lại 429, hết giờ) — không giữ khoá nào, mỗi connector gọi nó đã tự chặn ở lối gửi của mình.",
};

export function findConnector(key: string): ConnectorSpec | null {
  return CONNECTORS.find((c) => c.key === key) ?? null;
}

/** Connector cấu hình được ở `/settings/connections` (bảng `org_connections`). */
export function isOrgConfigurable(spec: ConnectorSpec): boolean {
  return spec.tenancy === "PER_ORG" && spec.config.store === "ORG_CONNECTIONS" && spec.settings.length > 0;
}

export function secretFields(spec: ConnectorSpec): SettingField[] {
  return spec.settings.filter((f) => f.secret);
}

export function plainFields(spec: ConnectorSpec): SettingField[] {
  return spec.settings.filter((f) => !f.secret);
}

/** Trạng thái một kết nối trong `org_connections` — khớp ràng buộc `org_connections_status_check`. */
export const CONNECTION_STATUSES = ["DRAFT", "ACTIVE", "DISABLED"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export const CONNECTION_STATUS_LABEL: Record<ConnectionStatus, string> = {
  DRAFT: "Nháp — chưa bật",
  ACTIVE: "Đang bật",
  DISABLED: "Đã tắt",
};

/**
 * Che một bí mật để hiện: `••••` + 4 ký tự cuối. Bí mật ngắn (< 12 ký tự) chỉ `••••` — lộ 4/8 ký tự
 * là lộ nửa khoá. THUẦN: dùng được ở máy chủ lúc lưu (ghi sẵn gợi ý) và trong bài kiểm.
 */
export function maskSecret(value: string): string {
  const v = value.trim();
  if (!v) return "";
  return v.length >= 12 ? `••••${v.slice(-4)}` : "••••";
}
