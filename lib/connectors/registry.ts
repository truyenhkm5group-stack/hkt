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

export const CONNECTOR_KINDS = ["ORDER_SOURCE", "SHIPPING", "PAYMENT", "ADS", "MESSAGING", "ACCOUNTING", "AI", "STORAGE", "PLATFORM", "LEAD_SOURCE"] as const;
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
  LEAD_SOURCE: "Nguồn khách hàng tiềm năng",
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
  LEAD_SOURCE: ["search_places", "place_details"],
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
export type WebhookBindingKey = "PANCAKE" | "VIETTELPOST" | "VTP_STATEMENT" | "SEPAY" | "PANCAKE_FANPAGE" | "PANCAKE_POS_ORG" | "VIETTELPOST_ORG" | "MESSENGER";

export type ConnectorWebhook = {
  /** Đường dẫn route theo cú pháp thư mục của Next (`[secret]`, `[[...event]]`). */
  path: string;
  /** Bên gửi xác thực bằng gì — một câu, không kèm giá trị. */
  verify: string;
  tenantResolution: "URL_SECRET" | "SIGNATURE" | "HOME_ONLY" | "PAGE_INDEX";
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
  /*
    PANCAKE POS CỦA CHÍNH TỔ CHỨC KHÁCH (F1 · docs/verticals/fashion-cod.md — chủ nền tảng chốt 04/10/2026: đóng gói ERP gốc
    thành sản phẩm cho shop thời trang COD). API key + mã shop CỦA HỌ; đồng bộ chạy ĐÚNG bộ đồng bộ của nhà bên trong
    `withPancakeClient`. Thuộc module Đơn hàng (không phải `connector_pancake` — module đó là credential môi trường của nhà).
    Bật ⇒ Pancake là NGUỒN đơn / khách / sản phẩm (`orgHasSyncedSource`): ERP thôi tạo tay, chatbot ERP thôi lên đơn.
  */
  {
    key: "pancake-pos-org",
    label: "Pancake POS của tổ chức",
    vendor: "Pancake",
    kind: "ORDER_SOURCE",
    capabilities: ["pull_orders", "pull_products", "pull_customers", "pull_inventory", "webhook_orders"],
    auth: "API_KEY",
    settings: [
      {
        key: "apiKey",
        label: "API key Pancake POS",
        type: "text",
        secret: true,
        required: true,
        hint: "Pancake POS → Cấu hình → Ứng dụng → API: tạo / chép API key của shop. Khoá chỉ dùng để ĐỌC đơn, khách, sản phẩm, tồn.",
        pattern: "^[A-Za-z0-9_-]{16,200}$",
        maxLength: 200,
      },
      { key: "shopId", label: "Mã shop Pancake POS", type: "text", secret: false, required: true, hint: "Số ngay sau «/shop/» trên thanh địa chỉ khi mở Pancake POS", pattern: "^[0-9]{1,20}$", maxLength: 20 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: {
      path: "/api/webhooks/pancake-org/[token]/[[...event]]",
      verify: "Token «<mã tổ chức>.<chữ ký HMAC>» trong ĐƯỜNG DẪN (khoá con dẫn xuất từ PLATFORM_SECRETS_KEY), so hằng thời gian trước khi đọc body; tổ chức phải ACTIVE và kết nối phải đang bật",
      tenantResolution: "URL_SECRET",
      idempotencyKey: "webhookDedupeKey(PANCAKE, [loại, id, updated_at])",
      binding: "PANCAKE_POS_ORG",
    },
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testPancakePosOrg",
    module: "orders",
    code: ["lib/constants/pancake-pos-org.ts", "lib/integrations/pancake/org.ts", "app/api/webhooks/pancake-org/[token]/[[...event]]/route.ts", "components/connectors/org-pos-panel.tsx"],
    consumers: ["lib/integrations/pancake/org.ts::syncOrgPancake", "app/api/webhooks/pancake-org/[token]/[[...event]]/route.ts"],
    why: "Đơn, khách, sản phẩm, tồn kho và đổi trả từ Pancake POS của CHÍNH tổ chức khách (API key + mã shop của họ). Kiểm tra = GET danh sách shop của khoá, đòi mã shop đã khai nằm trong đó — chỉ đọc, chỉ tới pos.pages.fm. Webhook theo tổ chức đẩy đơn / khách / sản phẩm / tồn tức thời; nút «Đồng bộ ngay» (job «pancake-org») kéo đủ — lượt đầu 30 ngày đơn. Bật ⇒ Pancake là NGUỒN đơn / khách / sản phẩm: ERP thôi tạo tay. Khác «Pancake POS» của nhà (biến môi trường).",
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
  /*
    VIETTEL POST CỦA CHÍNH TỔ CHỨC KHÁCH (F2 · docs/verticals/fashion-cod.md). Viettel Post KHÔNG cấp API tra cứu cho shop
    (chủ shop chốt 24/09/2026) — nguồn tin là WEBHOOK + tệp «Danh sách vận đơn» / bảng kê COD. Không khoá nào để khai: máy
    chủ cấp URL webhook mang token HMAC riêng của tổ chức; shop dán URL đó vào tài khoản Viettel Post của họ. Tệp nhập ở
    /import-vtp (đã chạy theo tổ chức). Thuộc module Giao vận.
  */
  {
    key: "viettelpost-org",
    label: "Viettel Post của tổ chức (webhook)",
    vendor: "Viettel Post",
    kind: "SHIPPING",
    capabilities: ["webhook_status", "import_file"],
    auth: "NONE",
    settings: [],
    config: { store: "NONE", where: "Không cần khai: URL webhook do máy chủ cấp ở khung «Viettel Post của tổ chức» (/settings/connections); tệp nhập ở /import-vtp" },
    webhook: {
      path: "/api/webhooks/viettelpost-org/[token]",
      verify: "Token «<mã tổ chức>.<chữ ký HMAC>» trong ĐƯỜNG DẪN (khoá con dẫn xuất từ PLATFORM_SECRETS_KEY), so hằng thời gian trước khi đọc body; tổ chức phải ACTIVE và bật module Giao vận",
      tenantResolution: "URL_SECRET",
      idempotencyKey: "webhookDedupeKey(VIETTELPOST, [ORDER_NUMBER, trạng thái, mốc ĐVVC]) — cùng lõi với route của nhà",
      binding: "VIETTELPOST_ORG",
    },
    tenancy: "PER_ORG",
    health: null,
    healthRef: null,
    module: "logistics",
    code: ["lib/integrations/viettelpost/webhook-core.ts", "app/api/webhooks/viettelpost-org/[token]/route.ts", "components/connectors/org-carrier-panel.tsx"],
    consumers: ["app/api/webhooks/viettelpost-org/[token]/route.ts"],
    why: "Hành trình vận đơn Viettel Post của CHÍNH tổ chức khách, đẩy qua webhook vào URL mang token riêng của tổ chức (VTP không cấp API tra cứu). Cùng lõi với webhook của nhà: chống trùng theo (vận đơn, trạng thái, mốc ĐVVC), mốc ĐVVC mới hơn thì thắng. Không có hàm kiểm tra: không có API để hỏi — gói tin đầu tiên về là bằng chứng. Khác «Viettel Post» của nhà (biến môi trường).",
  },
  /*
    POS TỰ CHỦ (docs/verticals/pos-tu-chu.md): shop khách KHÔNG dùng Pancake POS vẫn đẩy đơn ERP sang Viettel Post. Tài khoản
    + mật khẩu Viettel Post CỦA HỌ; ERP tính cước, tạo vận đơn, lấy link in, huỷ khi hãng chưa lấy hàng. Hành trình vẫn về qua
    webhook «viettelpost-org» ở trên — hai kết nối bổ sung nhau, không thay nhau. Chủ shop duyệt nối mọi hãng (04/10/2026).
  */
  {
    key: "viettelpost-carrier",
    label: "Viettel Post của tổ chức (tạo vận đơn)",
    vendor: "Viettel Post",
    kind: "SHIPPING",
    capabilities: ["create_label", "update_order"],
    auth: "USERNAME_PASSWORD",
    settings: [
      { key: "username", label: "Tài khoản Viettel Post", type: "text", secret: false, required: true, hint: "Số điện thoại / email đăng nhập viettelpost.vn của shop", pattern: "^\\S{3,100}$", maxLength: 100 },
      { key: "password", label: "Mật khẩu Viettel Post", type: "text", secret: true, required: true, hint: "Chỉ dùng để đăng nhập API tạo / huỷ / in vận đơn — mã hoá trong CSDL của tổ chức.", maxLength: 200 },
      { key: "senderName", label: "Tên người gửi", type: "text", secret: false, required: true, hint: "In trên nhãn — thường là tên shop", maxLength: 100 },
      { key: "senderPhone", label: "SĐT người gửi", type: "text", secret: false, required: true, hint: "Bưu tá gọi số này khi tới lấy hàng", pattern: "^\\+?[0-9 .]{9,16}$", maxLength: 16 },
      { key: "senderAddress", label: "Địa chỉ lấy hàng", type: "text", secret: false, required: true, hint: "Số nhà, đường, xã / phường, tỉnh / thành — Viettel Post tự đọc địa chỉ dạng chữ", maxLength: 200 },
      { key: "defaultNote", label: "Ghi chú mặc định trên vận đơn", type: "text", secret: false, required: false, hint: "Ví dụ: Cho xem hàng, không cho thử", maxLength: 150 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — mật khẩu mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testViettelPostCarrier",
    module: "logistics",
    code: ["lib/constants/carrier-vtp.ts", "lib/integrations/viettelpost/carrier-org.ts", "lib/carriers/vtp-shipments.ts"],
    consumers: [
      "lib/carriers/vtp-shipments.ts::quoteVtpShipmentCore",
      "lib/carriers/vtp-shipments.ts::createVtpShipmentCore",
      "lib/carriers/vtp-shipments.ts::cancelVtpShipmentCore",
      "lib/carriers/vtp-shipments.ts::vtpPrintLinkCore",
      "lib/carriers/vtp-shipments.ts::bulkVtpPrintLinkCore",
    ],
    why: "Tạo vận đơn Viettel Post từ đơn tạo trong ERP bằng tài khoản của CHÍNH tổ chức — shop không cần Pancake POS. Kiểm tra = đăng nhập (Login → ownerconnect) rồi đọc danh sách kho lấy hàng — chỉ đọc, chỉ tới partner.viettelpost.vn. Tạo đơn giữ chỗ trước khi gọi hãng + mã ERP gửi kèm CHECK_UNIQUE + không tự gửi lại ⇒ một lần gửi không thành hai vận đơn. Hành trình về qua webhook «viettelpost-org».",
  },
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
  /*
    QUẢNG CÁO FACEBOOK CỦA CHÍNH TỔ CHỨC KHÁCH (chủ nền tảng chốt 03/10/2026 — Hải Sản Làng Chài): token System User của
    Business Manager CỦA HỌ + danh sách tài khoản quảng cáo họ khai. CHỈ ĐỌC chi tiêu (`ad_spends`); mọi đường GHI
    (đổi ngân sách, đăng quảng cáo — `ADS_WRITE_ENABLED`) vẫn chỉ của nhà. Thuộc module Marketing (không phải
    `connector_meta` — module đó là credential môi trường của nhà).
  */
  {
    key: "meta-ads-org",
    label: "Quảng cáo Facebook (Meta) của tổ chức",
    vendor: "Meta",
    kind: "ADS",
    capabilities: ["read_spend"],
    auth: "OAUTH_TOKEN",
    settings: [
      {
        key: "accessToken",
        label: "Token System User (Business Manager của tổ chức)",
        type: "text",
        secret: true,
        required: true,
        hint: "business.facebook.com → Cài đặt doanh nghiệp → Người dùng hệ thống → Tạo mã token, chọn quyền ads_read. Gán người dùng hệ thống vào từng tài khoản quảng cáo (quyền xem). Không dùng token tài khoản Facebook cá nhân.",
        pattern: "^EAA[A-Za-z0-9]{30,1000}$",
        maxLength: 1010,
      },
      {
        key: "adAccountIds",
        label: "Mã tài khoản quảng cáo (cách nhau bằng dấu phẩy)",
        type: "text",
        secret: false,
        required: true,
        hint: "Ví dụ act_1234567890, act_9876543210 — xem trong Trình quản lý quảng cáo. Tối đa 20 tài khoản.",
        pattern: "^\\s*(act_)?[0-9]{5,20}(\\s*[,;\\s]\\s*(act_)?[0-9]{5,20}){0,19}\\s*$",
        maxLength: 500,
      },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testMetaAdsOrg",
    module: "marketing",
    code: ["lib/connectors/testers.ts", "lib/marketing/meta-ads-org.ts"],
    consumers: ["lib/marketing/meta-ads-org.ts::syncOrgMetaAds", "lib/marketing/meta-ads-org.ts::openOrgMetaAdsClient", "lib/actions/creative-import.ts::importOwnAdsAction"],
    why: "Chi tiêu quảng cáo Facebook của CHÍNH tổ chức khách (token System User của BM họ + tài khoản họ khai). Kiểm tra = GET từng act_<id> (tên · tiền tệ · trạng thái) — chỉ đọc, chỉ tới graph.facebook.com, token đi trong tiêu đề, không theo chuyển hướng. Job «ads-spend-org» mỗi 60 phút kéo chi tiêu theo ngày vào ad_spends của tổ chức, rồi tra sổ mẩu fb_ads (trạng thái · bài viết · creative) bằng cùng client chỉ đọc; nút «Nhập mẫu thắng / mẫu tốt» ở Nguồn ảnh đọc ảnh + câu chữ của mẩu do chính tài khoản đã khai chạy. Khác «Meta Ads (Facebook)» của nhà (biến môi trường, có nhánh ghi).",
  },
  // ─────────────── NGUỒN KHÁCH TIỀM NĂNG ───────────────
  /*
    GOOGLE PLACES API (NEW) CỦA CHÍNH TỔ CHỨC (0197, Săn khách sỉ): khoá API Google Cloud của TỔ CHỨC (dự án Google
    Cloud của họ, hoá đơn Google của họ). Chỉ tìm doanh nghiệp công khai (Text / Nearby Search) và đọc chi tiết liên hệ
    (Place Details) — không có đường ghi nào. Khoá không bao giờ xuống trình duyệt.
  */
  {
    key: "google-places",
    label: "Google Places (tìm doanh nghiệp)",
    vendor: "Google",
    kind: "LEAD_SOURCE",
    capabilities: ["search_places", "place_details"],
    auth: "API_KEY",
    settings: [
      {
        key: "apiKey",
        label: "Khoá API Google Maps Platform (đã bật Places API (New))",
        type: "text",
        secret: true,
        required: true,
        hint: "console.cloud.google.com → chọn dự án có bật thanh toán → APIs & Services → Library → bật «Places API (New)» → Credentials → Create credentials → API key. Giới hạn khoá: API restrictions = chỉ Places API (New); Application restrictions = IP của máy chủ ERP. Đặt hạn mức (Quotas) theo ngày trong Google Cloud để chặn thêm một lớp.",
        pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{29,199}$",
        maxLength: 200,
      },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testGooglePlaces",
    module: "wholesale_leads",
    code: ["lib/connectors/testers.ts", "lib/integrations/google-places/", "lib/wholesale/engine.ts"],
    consumers: ["lib/wholesale/engine.ts::runLeadHunterTick"],
    why: "Săn khách sỉ (0197): tìm nhà hàng / quán / khách sạn / cửa hàng thực phẩm bằng Places API (New) với khoá của CHÍNH tổ chức. Kiểm tra = một lượt Text Search chỉ xin Place ID (SKU miễn phí), khoá đi trong tiêu đề X-Goog-Api-Key, chỉ tới places.googleapis.com, không theo chuyển hướng. Job «wholesale-leads» mỗi 3 phút chạy chiến dịch đang bật, có trần ngân sách ngày / tháng tự dừng.",
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
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/messaging/providers.ts"],
    consumers: ["lib/messaging/providers.ts::messagingProvider"],
    why: "Kênh nhóm chat do CHÍNH tổ chức khai. Kiểm tra = gửi MỘT tin thử vào đúng nhóm đó (chỉ tới máy chủ Lark). Luồng đọc: hành động «Gửi tin nhóm chat» của luật tự động (0180 — vd luật «Báo nhóm vận hành» khi đơn chốt / sửa / huỷ). Cảnh báo vận hành của VNX (loadAlertConfig) KHÔNG đọc bảng này.",
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
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/messaging/providers.ts"],
    consumers: ["lib/messaging/providers.ts::messagingProvider"],
    why: "Bot do CHÍNH tổ chức tạo. Kiểm tra = getMe (chỉ đọc) rồi gửi MỘT tin thử vào chat đã khai, chỉ tới api.telegram.org. Luồng đọc: hành động «Gửi tin nhóm chat» của luật tự động (0180). Cảnh báo vận hành của VNX không đọc bảng này.",
  },
  {
    key: "zalo-bot",
    label: "Zalo — bot của tổ chức",
    vendor: "Zalo",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "API_KEY",
    settings: [
      { key: "botToken", label: "Bot token (từ Zalo Bot Creator)", type: "text", secret: true, required: true, pattern: "^[0-9]{5,25}:[A-Za-z0-9_.-]{10,200}$", maxLength: 230 },
      { key: "chatId", label: "Chat ID nhận tin (bấm «Tìm chat»)", type: "text", secret: false, required: true, pattern: "^[A-Za-z0-9_-]{6,64}$", maxLength: 64 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testZaloBot",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/messaging/providers.ts"],
    consumers: ["lib/messaging/providers.ts::messagingProvider"],
    why: "Bot Zalo do CHÍNH tổ chức tạo ở bot.zaloplatforms.com. Kiểm tra = getMe rồi gửi MỘT tin thử vào chat đã khai, chỉ tới bot-api.zaloplatforms.com; «Tìm chat» đọc getUpdates để lấy mã chat (Zalo không hiện mã cho người dùng). Máy chủ tại Việt Nam gọi được Zalo kể cả khi Telegram bị chặn ở tầng mạng (đo 30/09/2026). Luồng đọc: hành động «Gửi tin nhóm chat» của luật tự động.",
  },
  {
    key: "pancake-fanpage",
    label: "Fanpage qua Pancake — bot trả lời tin nhắn",
    vendor: "Pancake",
    kind: "MESSAGING",
    capabilities: ["read_conversations", "send_customer_message"],
    auth: "API_KEY",
    settings: [
      { key: "pageId", label: "Page ID (trong Pancake)", type: "text", secret: false, required: true, pattern: "^[A-Za-z0-9_]{5,40}$", maxLength: 40 },
      { key: "pageAccessToken", label: "Page access token (Pancake → Cài đặt → Công cụ)", type: "text", secret: true, required: true, pattern: "^[A-Za-z0-9._-]{20,600}$", maxLength: 600 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: {
      path: "/api/webhooks/pancake/fanpage/[token]",
      verify: "token «<mã tổ chức>.<chữ ký HMAC>» trong đường dẫn — chữ ký dẫn xuất từ PLATFORM_SECRETS_KEY, riêng từng tổ chức",
      tenantResolution: "URL_SECRET",
      idempotencyKey: "sales_chat_inbound.message_id (UNIQUE)",
      binding: "PANCAKE_FANPAGE",
    },
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testPancakeFanpage",
    module: "ai_sales",
    code: ["lib/connectors/testers.ts", "lib/sales-chatbot/fanpage.ts", "app/api/webhooks/pancake/fanpage/[token]/route.ts"],
    consumers: ["lib/sales-chatbot/fanpage.ts::processFanpageThread"],
    why: "Fanpage của CHÍNH tổ chức (page access token của Pancake). Tin khách vào fanpage ⇒ webhook Pancake ⇒ đúng tổ chức theo token trong đường dẫn ⇒ chatbot bán hàng của tổ chức trả lời (giá / tồn đọc từ ERP, khoá AI của shop, đơn ghi vào ERP) ⇒ gửi lại qua pages.fm reply_inbox. Khác «Pancake Pages» của nhà (biến môi trường, container bot riêng).",
  },
  {
    key: "facebook-messenger",
    label: "Messenger trực tiếp — bot trả lời tin nhắn (không cần Pancake)",
    vendor: "Meta",
    kind: "MESSAGING",
    capabilities: ["read_conversations", "send_customer_message"],
    auth: "OAUTH_TOKEN",
    settings: [
      { key: "pageId", label: "Page ID", type: "text", secret: false, required: true, pattern: "^[0-9]{5,30}$", maxLength: 30 },
      { key: "pageName", label: "Tên page", type: "text", secret: false, required: false, maxLength: 120 },
      { key: "pageAccessToken", label: "Page access token (cấp qua nút «Kết nối Facebook Page»)", type: "text", secret: true, required: true, pattern: "^[A-Za-z0-9._-]{20,1000}$", maxLength: 1000 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/ai/sales-chatbot/messenger — chủ page bấm «Kết nối Facebook Page»; token mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: {
      path: "/api/webhooks/messenger",
      verify: "X-Hub-Signature-256 = HMAC-SHA256 của thân gói gốc bằng app secret của nền tảng (FACEBOOK_LOGIN_APP_SECRET); GET xác minh bằng mã dẫn xuất từ AUTH_SECRET",
      tenantResolution: "PAGE_INDEX",
      idempotencyKey: "sales_chat_inbound.message_id (UNIQUE) = mid của Meta",
      binding: "MESSENGER",
    },
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testFacebookMessenger",
    module: "ai_sales",
    code: ["lib/integrations/messenger/", "lib/sales-chatbot/messenger.ts", "app/api/webhooks/messenger/route.ts", "app/api/connect/messenger/start/route.ts", "app/api/connect/messenger/callback/route.ts"],
    consumers: ["lib/sales-chatbot/messenger.ts::processMessengerThread"],
    why: "Fanpage của CHÍNH tổ chức nối THẲNG với Meta qua app của nền tảng — shop không dùng Pancake vẫn có bot. Chủ page cấp quyền nhắn tin bằng Facebook Login; ERP lưu page token (mã hoá), đăng ký webhook cho page; tin khách ⇒ webhook chung ⇒ đúng tổ chức theo mã page ⇒ chatbot bán hàng của tổ chức ⇒ Send API. Cần app ở chế độ Live + quyền pages_messaging (Meta App Review) cho page của người ngoài app.",
  },
  /*
    HỘP THỬ (0180): kết nối nhắn tin KHÔNG gọi mạng — cùng giao diện `MessagingProvider` với Lark / Telegram, nhưng tin
    chỉ nằm trong sổ `messaging_deliveries` của chính tổ chức (màn hình «Thông báo nhóm» in lại). Để shop dựng và thử luật
    «báo nhóm vận hành» trước khi có (hoặc khi máy chủ chưa lưu được) bí mật Lark / Telegram — không bí mật nào ở đây, nên
    nó không cần `PLATFORM_SECRETS_KEY`. Trạng thái hiển thị là «CHẾ ĐỘ THỬ», không bao giờ «ĐÃ KẾT NỐI».
  */
  {
    key: "sandbox-messaging",
    label: "Hộp thử nhắn tin (không gửi ra ngoài)",
    vendor: "ERP",
    kind: "MESSAGING",
    capabilities: ["send_group_message"],
    auth: "NONE",
    settings: [{ key: "channelName", label: "Tên kênh thử", type: "text", secret: false, required: true, hint: "Tên để phân biệt khi đọc lại, vd «Nhóm vận hành». Tin KHÔNG rời khỏi ERP.", maxLength: 60 }],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — không có bí mật; tin nằm ở sổ messaging_deliveries của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testSandboxMessaging",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/messaging/providers.ts"],
    consumers: ["lib/messaging/providers.ts::messagingProvider"],
    why: "Chế độ thử của thông báo nhóm: cùng đường luật → hành động «Gửi tin nhóm chat» → MessagingProvider, chỉ khác là nhà cung cấp ghi sổ thay vì gọi Lark / Telegram. Không có đường gửi riêng.",
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
    capabilities: ["chat", "vision", "image_generate"],
    auth: "API_KEY",
    settings: [
      { key: "apiKey", label: "OpenAI API key", type: "text", secret: true, required: true, hint: "platform.openai.com → API keys. Khoá của tổ chức — tổ chức trả tiền token.", pattern: "^sk-[A-Za-z0-9_-]{20,200}$", maxLength: 220 },
      { key: "model", label: "Model (để trống = mặc định)", type: "text", secret: false, required: false, hint: "Để trống thì dùng model mặc định của bậc trợ lý.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
      { key: "imageModel", label: "Model vẽ ảnh (để trống = mặc định của Thư viện Media)", type: "text", secret: false, required: false, hint: "Model gpt-image dùng để vẽ ảnh quảng cáo ở Marketing → Thư viện Media (vd gpt-image-2). Để trống thì dùng model vẽ mặc định.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testOpenAiKey",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/ai-builder/providers.ts", "lib/creative/byok-image.ts"],
    consumers: ["lib/ai-builder/provider.ts::getBuilderAi", "lib/creative/org-ai.ts::creativeImageClient", "lib/creative/org-ai.ts::creativeCaptioner"],
    why: "Khoá AI do CHÍNH tổ chức mang đến cho AI Builder (Phase 8) và cho Thư viện Media (04/10/2026: vẽ ảnh quảng cáo bằng gpt-image `/v1/images/edits` + viết câu chữ theo ảnh — chỉ đường gen TAY, người bấm). Kiểm tra = GET /v1/models (chỉ đọc, không tốn token), chỉ tới api.openai.com, không theo chuyển hướng. Khoá .env của tổ chức nhà không bao giờ dùng thay.",
  },
  {
    key: "gemini-byok",
    label: "Google Gemini — khoá AI của tổ chức",
    vendor: "Google",
    kind: "AI",
    capabilities: ["chat", "vision", "image_generate"],
    auth: "API_KEY",
    settings: [
      { key: "apiKey", label: "Gemini API key", type: "text", secret: true, required: true, hint: "aistudio.google.com → Get API key → dán NGUYÊN khoá (không kèm «GEMINI_API_KEY=», dấu ngoặc hay khoảng trắng). Khoá của tổ chức — tổ chức trả tiền token.", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{29,199}$", maxLength: 200 },
      { key: "model", label: "Model (để trống = gemini-3.5-flash-lite)", type: "text", secret: false, required: false, hint: "Mặc định gemini-3.5-flash-lite · rẻ hơn: gemini-3.1-flash-lite · khôn hơn: gemini-3.5-flash. Khoá mới KHÔNG dùng được dòng 2.5.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
      { key: "imageModel", label: "Model vẽ ảnh (bắt buộc nếu vẽ ảnh bằng Gemini)", type: "text", secret: false, required: false, hint: "Model Gemini VẼ được ảnh mà khoá của bạn gọi được — xem danh sách trong AI Studio (tên có chữ «image»). ERP không đoán model: để trống thì Thư viện Media không vẽ bằng Gemini.", pattern: "^[a-z][a-z0-9.-]{2,60}$", maxLength: 60 },
    ],
    config: { store: "ORG_CONNECTIONS", where: "/settings/connections — bí mật mã hoá AES-256-GCM trong CSDL của tổ chức" },
    webhook: null,
    tenancy: "PER_ORG",
    health: "testConnection",
    healthRef: "lib/connectors/testers.ts::testGeminiKey",
    module: "core",
    code: ["lib/connectors/testers.ts", "lib/ai-builder/providers.ts", "lib/creative/byok-image.ts"],
    consumers: ["lib/sales-chatbot/engine.ts::salesChatProvider", "lib/creative/org-ai.ts::creativeImageClient", "lib/creative/org-ai.ts::creativeCaptioner"],
    why: "Khoá Gemini do CHÍNH tổ chức mang đến cho chatbot bán hàng (01/10/2026: bot fanpage của nhà chạy gemini-2.5-flash-lite đủ tốt và rẻ) và cho Thư viện Media (04/10/2026: viết câu chữ theo ảnh; vẽ ảnh CHỈ khi tổ chức khai «Model vẽ ảnh» — ERP không đoán model). Kiểm tra = GET /v1beta/models (chỉ đọc, không tốn token), chỉ tới generativelanguage.googleapis.com, khoá đi qua header x-goog-api-key, không theo chuyển hướng. Khoá Gemini .env của tổ chức nhà (video) không bao giờ dùng thay.",
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
