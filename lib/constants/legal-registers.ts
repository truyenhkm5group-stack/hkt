/**
 * ═══════════ SỔ BÊN XỬ LÝ PHỤ + SỔ CHUYỂN DỮ LIỆU XUYÊN BIÊN GIỚI (docs/legal/SUBPROCESSOR_REGISTER.md · VIETNAM_LEGAL_COMPLIANCE.md §7) ═══════════
 *
 * Bản CÓ KIỂU của hai bảng tài liệu — để máy kiểm được điều người đọc chỉ có thể tin:
 *   · mỗi bên ngoài mà mã nguồn gọi tới (hostname / SDK) phải có một dòng ở đây — `tests/legal-registers.test.ts` quét
 *     mã nguồn đã vào kho, gặp hostname lạ ⇒ ĐỎ (trừ danh sách miễn trừ có lý do);
 *   · mục khai `NOT_IN_USE` (email, SMS, theo dõi lỗi, analytics, cổng thanh toán) mang danh sách hostname / SDK canh gác —
 *     mã nguồn bắt đầu gọi một trong số đó ⇒ ĐỎ, buộc người viết khai bên mới (AGENTS §7: dịch vụ ngoài mới phải hỏi);
 *   · bộ id (S1…S30, X1…X11) phải TRÙNG với tài liệu; tài liệu ghi UNKNOWN thì hằng không được ghi một giá trị.
 *
 * ─── UNKNOWN LÀ MỘT GIÁ TRỊ, KHÔNG PHẢI CHỖ TRỐNG (AGENTS §3.42) ───
 * Vùng xử lý, thời gian lưu tại bên kia, bằng chứng hợp đồng / DPA: chưa đọc điều khoản của bên đó, chưa có văn bản ⇒
 * `UNKNOWN`, và `legalRegisterUnknowns()` liệt kê từng ô — không ô nào bị đoán cho «đủ bảng». Điền một vùng phải kèm
 * bằng chứng, và tài liệu phải nói cùng điều đó trước.
 *
 * Tệp chỉ khai báo — không đọc CSDL, không gọi mạng, không đổi hành vi hệ thống. Phân loại vai trò PHÁP LÝ (bên xử lý phụ
 * hay bên kiểm soát độc lập) là việc của luật sư (G-3); cột `role` ở đây là vai trò CHỨC NĂNG.
 */

export const UNKNOWN = "UNKNOWN" as const;
export type Unknown = typeof UNKNOWN;

/** Tập dữ liệu theo `DATA_PROCESSING_REGISTER.md` §2. */
export const DATASET_IDS = ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D14", "D15", "D16", "D17"] as const;
export type DatasetId = (typeof DATASET_IDS)[number];

/** Đường chuyển xuyên biên giới theo `VIETNAM_LEGAL_COMPLIANCE.md` §7. */
export const CROSS_BORDER_IDS = ["X1", "X2", "X3", "X4", "X5", "X6", "X7", "X8", "X9", "X10", "X11"] as const;
export type CrossBorderId = (typeof CROSS_BORDER_IDS)[number];

export const PROCESSOR_ROLES = [
  "HOSTING",
  "BACKUP",
  "CODE_CI",
  "RELAY",
  "MONITORING",
  "CHANNEL",
  "ALERTING",
  "AI_MODEL",
  "CARRIER",
  "PAYMENT_RECONCILIATION",
  "DATA_SOURCE",
  "SIGN_IN",
  "OTP",
  "EMAIL",
  "SMS",
  "ANALYTICS",
  "PAYMENT_GATEWAY",
  "LOCAL_LIBRARY",
] as const;
export type ProcessorRole = (typeof PROCESSOR_ROLES)[number];

/**
 * `IN_USE` — chạy ở mức nền tảng, không cần ai bật. `CONDITIONAL` — chỉ chạy khi một cấu hình / kết nối được bật (khách
 * thuê nối kênh, biến môi trường đặt…); có đang bật trên production hay không ghi ở `usageNote` (UNKNOWN khi chưa đo —
 * M-OBSERVE). `NOT_IN_USE` — mã nguồn không gọi; danh sách `watch` canh để điều đó còn đúng.
 */
export const PROCESSOR_USAGES = ["IN_USE", "CONDITIONAL", "NOT_IN_USE"] as const;
export type ProcessorUsage = (typeof PROCESSOR_USAGES)[number];

/** Bằng chứng: chuỗi trỏ tới văn bản thật (hợp đồng, DPA ký, trang điều khoản đã đọc có ngày). */
export type Evidence = { value: string; evidence: string };

export type SubprocessorEntry = {
  /** `S<n>` theo SUBPROCESSOR_REGISTER.md; mục KHÔNG dùng (§5) mang `N-<loại>`. */
  id: string;
  vendor: string;
  legalEntity: string | Unknown;
  role: ProcessorRole;
  purpose: string;
  datasets: readonly DatasetId[];
  dataCategories: string;
  /** Tệp mã gọi bên này (đường dẫn trong kho — bài kiểm mở từng tệp). Rỗng chỉ khi `NOT_IN_USE`. */
  calledFrom: readonly string[];
  /** Hostname mã nguồn gọi tới (khớp hậu tố). */
  hosts: readonly string[];
  /** Gói npm của bên này trong `package.json`. */
  sdks: readonly string[];
  usage: ProcessorUsage;
  usageNote: string;
  /** Điều khoản chuẩn áp dụng theo tài liệu; chưa xác định tài khoản / bản nào ⇒ UNKNOWN. */
  terms: string | Unknown;
  /** DPA / hợp đồng xử lý dữ liệu đã ký — chưa có văn bản ⇒ UNKNOWN. */
  dpa: Unknown | { evidence: string };
  /** Chỉ cho `NOT_IN_USE`: hostname / SDK mà nếu mã nguồn gọi tới thì mục này đã sai. */
  watch?: { hosts: readonly string[]; sdks: readonly string[] };
};

export const SUBPROCESSORS: readonly SubprocessorEntry[] = [
  // ─── §1 Hạ tầng và vận hành ───
  {
    id: "S1",
    vendor: "Nhà cung cấp VPS (Vietnix theo docs/TRIEN-KHAI-VPS.md · VNPT theo Chính sách 1.1 — chưa xác nhận)",
    legalEntity: UNKNOWN,
    role: "HOSTING",
    purpose: "Máy chủ ảo chạy ứng dụng, mọi CSDL, sao lưu nội bộ",
    datasets: ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10", "D11", "D12", "D13", "D15", "D16", "D17"],
    dataCategories: "Toàn bộ CSDL nhà + erp_org_*, .env, volume bot, sao lưu nội bộ",
    calledFrom: ["docker-compose.prod.yml", ".github/workflows/deploy-vps.yml"],
    hosts: [],
    sdks: [],
    usage: "IN_USE",
    usageNote: "Pháp nhân ký hợp đồng VPS chưa xác nhận (F-9); mã hoá at-rest UNKNOWN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S2",
    vendor: "Google Drive (sao lưu ngoài máy)",
    legalEntity: "Google LLC",
    role: "BACKUP",
    purpose: "Bản sao lưu ngoài máy chủ, mã hoá rclone crypt trước khi tải (tên tệp cũng mã hoá)",
    datasets: ["D16"],
    dataCategories: "pg_dump mọi CSDL, tar bot, WAL PITR — đã mã hoá",
    calledFrom: ["scripts/erp-backup.sh", "scripts/erp-pitr.sh"],
    hosts: [],
    sdks: [],
    usage: "IN_USE",
    usageNote: "Tài khoản Workspace hay cá nhân: UNKNOWN; khoá crypt ở VPS",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S3",
    vendor: "GitHub (kho PUBLIC, Actions, Secrets)",
    legalEntity: "GitHub, Inc. (Microsoft)",
    role: "CODE_CI",
    purpose: "Mã nguồn, CI/CD, chạy ops; kết quả truy vấn production đi kênh mã hoá",
    datasets: ["D13"],
    dataCategories: "Mã nguồn, Secrets (tên), artefact mã hoá; log Actions cũ có thể chứa dữ liệu khách (sự cố 24/09)",
    calledFrom: [".github/workflows/ops-vps.yml", ".github/workflows/deploy-vps.yml", "lib/integrations/github/client.ts"],
    hosts: ["github.com", "api.github.com", "raw.githubusercontent.com"],
    sdks: [],
    usage: "IN_USE",
    usageNote: "Log Actions giữ 90 ngày; sự cố 24/09 chờ luật sư đánh giá (G-11)",
    terms: "ToS GitHub",
    dpa: UNKNOWN,
  },
  {
    id: "S4",
    vendor: "GitHub Container Registry (GHCR)",
    legalEntity: "GitHub, Inc. (Microsoft)",
    role: "CODE_CI",
    purpose: "Lưu image ứng dụng để deploy",
    datasets: [],
    dataCategories: "Image ứng dụng (.dockerignore loại .env, data)",
    calledFrom: [".github/workflows/deploy-vps.yml"],
    hosts: ["ghcr.io"],
    sdks: [],
    usage: "IN_USE",
    usageNote: "Visibility image: UNKNOWN (M-OBSERVE)",
    terms: "ToS GitHub",
    dpa: UNKNOWN,
  },
  {
    id: "S5",
    vendor: "Cloudflare Workers (relay Telegram)",
    legalEntity: "Cloudflare, Inc.",
    role: "RELAY",
    purpose: "Chuyển tiếp lời gọi Bot API Telegram khi VPS bị chặn",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "Toàn bộ nội dung tin Telegram (tin đơn: tên · SĐT · địa chỉ · món) + bot token trong đường dẫn",
    calledFrom: ["deploy/telegram-relay-worker.js", "lib/connectors/telegram-api.ts"],
    hosts: ["workers.dev", "tg.vnxcommerce.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Chỉ khi TELEGRAM_API_BASE đặt; đang bật trên production hay không: UNKNOWN (M-OBSERVE)",
    terms: "ToS Cloudflare",
    dpa: UNKNOWN,
  },
  {
    id: "S6",
    vendor: "Google Cloud Run (relay Google Places của khách thuê)",
    legalEntity: "Google LLC",
    role: "RELAY",
    purpose: "Chuyển tiếp lời gọi Places API qua dự án GCP của khách thuê",
    datasets: ["D17"],
    dataCategories: "Khoá Places của khách thuê + từ khoá tìm",
    calledFrom: ["deploy/places-relay/server.js", "deploy/places-relay/relay.js"],
    hosts: [],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khách thuê tự dựng relay trong dự án GCP của mình",
    terms: "ToS GCP của khách thuê",
    dpa: UNKNOWN,
  },
  {
    id: "S7",
    vendor: "healthchecks.io (bot nhà, tuỳ chọn)",
    legalEntity: "Healthchecks.io",
    role: "MONITORING",
    purpose: "Ping báo bot nhà còn sống",
    datasets: [],
    dataCategories: "Chỉ lời gọi GET, không dữ liệu người",
    calledFrom: ["chatbot/src/server.js"],
    hosts: ["hc-ping.com", "healthchecks.io"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Chỉ khi cấu hình URL ping; có dùng không: UNKNOWN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  // ─── §2 Kênh và nền tảng xã hội ───
  {
    id: "S8",
    vendor: "Meta — Đăng nhập Facebook",
    legalEntity: "Meta Platforms, Inc. / Meta Platforms Ireland Ltd. (theo điều khoản)",
    role: "SIGN_IN",
    purpose: "Đăng nhập bằng Facebook (email, public_profile)",
    datasets: ["D1"],
    dataCategories: "id, họ tên, email",
    calledFrom: ["lib/auth/oauth.ts"],
    hosts: ["www.facebook.com", "graph.facebook.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi người dùng chọn đăng nhập bằng Facebook",
    terms: "Meta Platform Terms",
    dpa: UNKNOWN,
  },
  {
    id: "S9",
    vendor: "Meta — Messenger Platform / Instagram DM",
    legalEntity: "Meta Platforms, Inc. / Meta Platforms Ireland Ltd. (theo điều khoản)",
    role: "CHANNEL",
    purpose: "Nhận / gửi tin fanpage, bình luận, tra hồ sơ, lịch sử hội thoại",
    datasets: ["D3", "D4", "D9"],
    dataCategories: "PSID, tin hai chiều, ảnh, bình luận, referral quảng cáo; page token (mã hoá tại VNX)",
    calledFrom: ["lib/integrations/messenger/graph.ts", "lib/sales-chatbot/messenger.ts", "app/api/webhooks/messenger/route.ts"],
    hosts: ["graph.facebook.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi khách thuê nối page; App Review chưa duyệt (docs/meta-app-review/)",
    terms: "Meta Platform Terms + Developer Policies",
    dpa: UNKNOWN,
  },
  {
    id: "S10",
    vendor: "Meta — Marketing API",
    legalEntity: "Meta Platforms, Inc. / Meta Platforms Ireland Ltd. (theo điều khoản)",
    role: "CHANNEL",
    purpose: "Đọc chi tiêu, đăng quảng cáo, tải video (ERP nhà + khách BYO)",
    datasets: [],
    dataCategories: "Tài khoản quảng cáo, insight, creative",
    calledFrom: ["lib/integrations/facebook/client.ts", "lib/integrations/facebook/ads-write.ts", "lib/connectors/registry.ts"],
    hosts: ["graph.facebook.com", "rupload.facebook.com", "adsmanager.facebook.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Ngoài phạm vi Chốt Đơn; chạy cho ERP nhà và tổ chức tự nối",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S11",
    vendor: "Pancake Pages / POS",
    legalEntity: UNKNOWN,
    role: "CHANNEL",
    purpose: "Hội thoại fanpage, đơn, khách, kho, gửi hàng loạt",
    datasets: ["D3", "D4", "D5", "D6", "D7"],
    dataCategories: "Hội thoại, tên, SĐT, địa chỉ, đơn",
    calledFrom: ["lib/env.ts", "lib/integrations/pancake", "app/api/webhooks/pancake", "app/api/webhooks/pancake-org"],
    hosts: ["pages.fm", "pancake.vn"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khách thuê tự kết nối",
    terms: "ToS Pancake",
    dpa: UNKNOWN,
  },
  {
    id: "S12",
    vendor: "Zalo OA (ứng dụng của shop)",
    legalEntity: "VNG Corporation",
    role: "CHANNEL",
    purpose: "Tin khách hai chiều (48 giờ), tải ảnh",
    datasets: ["D3", "D4"],
    dataCategories: "Tin, ảnh, Zalo user id",
    calledFrom: ["lib/integrations/zalo/oa.ts", "app/api/webhooks/zalo-oa"],
    hosts: ["openapi.zalo.me", "oauth.zaloapp.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi khách thuê nối OA",
    terms: "ToS Zalo",
    dpa: UNKNOWN,
  },
  {
    id: "S13",
    vendor: "Zalo ZNS (OTP đăng ký, qua OA nhà)",
    legalEntity: "VNG Corporation",
    role: "OTP",
    purpose: "Gửi mã OTP 6 số khi đăng ký",
    datasets: ["D1"],
    dataCategories: "SĐT người đăng ký + mã",
    calledFrom: ["lib/onboarding/phone-otp.ts"],
    hosts: ["business.openapi.zalo.me"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "OTP đăng ký mặc định TẮT",
    terms: "ToS ZNS",
    dpa: UNKNOWN,
  },
  {
    id: "S14",
    vendor: "Zalo Bot (báo nhóm)",
    legalEntity: "VNG Corporation",
    role: "ALERTING",
    purpose: "Tin báo nhóm (có thể chứa đơn)",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "Tin đơn: tên · SĐT · địa chỉ",
    calledFrom: ["lib/connectors/registry.ts"],
    hosts: ["bot-api.zaloplatforms.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức nối Zalo Bot",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S15",
    vendor: "Telegram Bot API",
    legalEntity: "Telegram FZ-LLC / Telegram Messenger Inc.",
    role: "ALERTING",
    purpose: "Tin báo nhóm, cảnh báo, tin đơn mới",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "Tin đơn mới: tên · SĐT · địa chỉ · món; cảnh báo vận hành",
    calledFrom: ["lib/alerts/telegram.ts", "lib/sales-chatbot/new-order-alert.ts", "lib/connectors/telegram-api.ts"],
    hosts: ["api.telegram.org"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức nối nhóm Telegram (HSLC bật 04/10)",
    terms: "ToS Telegram",
    dpa: UNKNOWN,
  },
  {
    id: "S16",
    vendor: "Lark Custom Bot",
    legalEntity: "Lark Technologies Pte. Ltd. (Singapore) / ByteDance",
    role: "ALERTING",
    purpose: "Cảnh báo, bản tin, lương, leo thang, đơn (ERP nhà)",
    datasets: ["D5", "D7"],
    dataCategories: "Mã đơn, tên khách, SĐT ở một số mẫu; lương nhân viên (ERP nhà)",
    calledFrom: ["lib/alerts/lark.ts", "lib/connectors/testers.ts"],
    hosts: ["open.larksuite.com", "open.feishu.cn"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức khai webhook Lark",
    terms: "ToS Lark",
    dpa: UNKNOWN,
  },
  // ─── §3 AI ───
  {
    id: "S17",
    vendor: "Google Gemini API — khoá nền tảng",
    legalEntity: "Google LLC",
    role: "AI_MODEL",
    purpose: "Sinh câu trả lời bot bán hàng, trích đơn, đọc ảnh (nguồn PLATFORM)",
    datasets: ["D4", "D8", "D10"],
    dataCategories: "System prompt (sổ tay, danh mục, giá, tồn), 40 tin hội thoại, khối khách cũ (tên · SĐT · địa chỉ · đơn), ảnh khách",
    calledFrom: ["lib/ai-usage/platform-ai.ts", "lib/ai-builder/providers.ts", "lib/sales-chatbot/engine.ts", "lib/sales-chatbot/vision.ts", "scripts/org-ai-cutover.ts"],
    // Bốn hostname sau `generativelanguage` chỉ do script ops scripts/org-ai-cutover.ts gọi bằng khoá nền tảng để dò dự án
    // Google của khoá (thân rỗng, không dữ liệu người — #694).
    hosts: [
      "generativelanguage.googleapis.com",
      "apikeys.googleapis.com",
      "cloudresourcemanager.googleapis.com",
      "www.googleapis.com",
      "translation.googleapis.com",
      "language.googleapis.com",
      "vision.googleapis.com",
    ],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Chỉ khi PLATFORM_AI_ENABLED=1 + gói có credit; provider / model đang chạy trên production: UNKNOWN (M-OBSERVE). Gói trả phí hay miễn phí: UNKNOWN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S18",
    vendor: "Gemini BYOK (khoá của khách thuê)",
    legalEntity: "Google LLC",
    role: "AI_MODEL",
    purpose: "Như S17 + ảnh sản phẩm (creative), bằng khoá của khách thuê",
    datasets: ["D4", "D8", "D10"],
    dataCategories: "Như S17",
    calledFrom: ["lib/connectors/registry.ts", "lib/creative/byok-image.ts"],
    hosts: ["generativelanguage.googleapis.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi khách thuê nối khoá Gemini của mình",
    terms: "Tài khoản Google của khách thuê",
    dpa: UNKNOWN,
  },
  {
    id: "S19",
    vendor: "Gemini — bot nhà (chatbot/)",
    legalEntity: "Google LLC",
    role: "AI_MODEL",
    purpose: "Chat + đọc ảnh + chép ghi âm giọng khách (bot của tổ chức nhà)",
    datasets: ["D4", "D8"],
    dataCategories: "Tin, ảnh, giọng nói (≤ 3 clip)",
    calledFrom: ["chatbot/src/gemini.js", "chatbot/src/voice.js"],
    hosts: ["generativelanguage.googleapis.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi container bot nhà chạy; gói miễn phí hay trả phí: UNKNOWN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S20",
    vendor: "Gemini Veo / Omni (Video Scale, nhà)",
    legalEntity: "Google LLC",
    role: "AI_MODEL",
    purpose: "Sinh video quảng cáo",
    datasets: [],
    dataCategories: "Kịch bản, ảnh sản phẩm (store: true ⇒ Google lưu)",
    calledFrom: ["lib/video-scale/providers/omni.ts", "lib/video-scale/providers/veo.ts"],
    hosts: ["generativelanguage.googleapis.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Chỉ ERP nhà khi bật Video Scale",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S21",
    vendor: "Anthropic",
    legalEntity: "Anthropic PBC",
    role: "AI_MODEL",
    purpose: "Copilot, phân loại CSKH, agent (nhà); BYOK / nền tảng khi chọn provider anthropic",
    datasets: ["D4", "D8"],
    dataCategories: "Dữ liệu ERP qua công cụ (đơn, khách), hội thoại CSKH để phân loại, mã nguồn (CI)",
    calledFrom: ["lib/ai/provider.ts", "lib/ai/router.ts", "lib/ai-builder/providers.ts"],
    hosts: ["api.anthropic.com"],
    sdks: ["@anthropic-ai/sdk"],
    usage: "CONDITIONAL",
    usageNote: "Khoá nhà / BYOK / nền tảng — tuỳ cấu hình",
    terms: "Commercial Terms — xác nhận",
    dpa: UNKNOWN,
  },
  {
    id: "S22",
    vendor: "OpenAI",
    legalEntity: "OpenAI, L.L.C.",
    role: "AI_MODEL",
    purpose: "Chat (store:false), ảnh, Files + Batch, TTS (nhà và BYOK)",
    datasets: ["D4", "D8"],
    dataCategories: "Ảnh / câu chữ quảng cáo, kịch bản; chat khách nếu AI_PROVIDER=openai ở bot nhà",
    calledFrom: ["lib/ai/providers/openai.ts", "lib/integrations/openai/images.ts", "lib/integrations/openai/batch.ts", "lib/video-scale/tts.ts"],
    hosts: ["api.openai.com"],
    sdks: ["openai"],
    usage: "CONDITIONAL",
    usageNote: "Khoá nhà / BYOK — tuỳ cấu hình",
    terms: "API Terms",
    dpa: UNKNOWN,
  },
  // ─── §4 Bán hàng, vận chuyển, thanh toán ───
  {
    id: "S23",
    vendor: "Viettel Post",
    legalEntity: "Tổng công ty CP Bưu chính Viettel",
    role: "CARRIER",
    purpose: "Tạo vận đơn, tra hành trình, webhook, bảng kê COD",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "Tên · SĐT · địa chỉ người nhận, tiền thu hộ",
    calledFrom: ["lib/constants/carrier-vtp.ts", "lib/integrations/viettelpost", "app/api/webhooks/viettelpost"],
    hosts: ["viettelpost.vn"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức kết nối Viettel Post",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S24",
    vendor: "GHN",
    legalEntity: "Giao Hàng Nhanh",
    role: "CARRIER",
    purpose: "Vận đơn, webhook",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "to_name / to_phone / to_address, COD",
    calledFrom: ["lib/constants/carrier-ghn.ts", "lib/integrations/ghn", "app/api/webhooks/ghn-org"],
    hosts: ["ghn.vn"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức kết nối GHN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S25",
    vendor: "GHTK",
    legalEntity: "Giao Hàng Tiết Kiệm",
    role: "CARRIER",
    purpose: "Vận đơn, webhook",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "tel, địa chỉ, pick_money",
    calledFrom: ["lib/constants/carrier-ghtk.ts", "lib/integrations/ghtk", "app/api/webhooks/ghtk-org"],
    hosts: ["giaohangtietkiem.vn"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức kết nối GHTK",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S26",
    vendor: "SePay",
    legalEntity: UNKNOWN,
    role: "PAYMENT_RECONCILIATION",
    purpose: "Đối soát biến động số dư ngân hàng — không giữ tiền (xác nhận hợp đồng)",
    datasets: ["D11"],
    dataCategories: "Ngân hàng, số tài khoản, số tiền, nội dung chuyển khoản, mã tham chiếu",
    calledFrom: ["lib/integrations/bank/sepay.ts", "lib/integrations/bank/sepay-api.ts", "app/api/webhooks/sepay/route.ts"],
    hosts: ["userapi.sepay.vn"],
    sdks: [],
    usage: "IN_USE",
    usageNote: "Đối soát thu phí nền tảng",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S27",
    vendor: "VietQR (chuẩn EMVCo — dựng cục bộ)",
    legalEntity: UNKNOWN,
    role: "LOCAL_LIBRARY",
    purpose: "Dựng mã QR chuyển khoản bằng thư viện qrcode — không gọi dịch vụ ngoài",
    datasets: [],
    dataCategories: "Không dữ liệu nào rời máy chủ",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "lib/payroll/vietqr.ts dựng QR cục bộ, không gọi img.vietqr.io",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["vietqr.io", "vietqr.net"], sdks: [] },
  },
  {
    id: "S28",
    vendor: "Google Sheets CSV công khai / Apps Script của shop",
    legalEntity: "Google LLC",
    role: "DATA_SOURCE",
    purpose: "Đơn landing, sổ xưởng, bảng kê VTP từ Gmail (chiều VÀO)",
    datasets: ["D5", "D6", "D7"],
    dataCategories: "Đơn landing (tên, SĐT, địa chỉ) — dữ liệu nằm ở Google trước",
    calledFrom: ["lib/constants/landing.ts", "lib/actions/workshop-ledger.ts"],
    hosts: ["docs.google.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức khai link CSV",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S29",
    vendor: "Google Places API (New)",
    legalEntity: "Google LLC",
    role: "DATA_SOURCE",
    purpose: "Tìm cơ sở kinh doanh (săn khách sỉ)",
    datasets: ["D17"],
    dataCategories: "Từ khoá đi ra; dữ liệu doanh nghiệp công khai (có thể là cá nhân) về",
    calledFrom: ["lib/integrations/google-places/client.ts", "deploy/places-relay/relay.js"],
    hosts: ["places.googleapis.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi tổ chức nối khoá Places",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  {
    id: "S30",
    vendor: "Google OAuth (đăng nhập)",
    legalEntity: "Google LLC",
    role: "SIGN_IN",
    purpose: "Đăng nhập bằng Google (openid email profile)",
    datasets: ["D1"],
    dataCategories: "sub, email đã xác minh, họ tên",
    calledFrom: ["lib/auth/oauth.ts"],
    hosts: ["accounts.google.com", "oauth2.googleapis.com"],
    sdks: [],
    usage: "CONDITIONAL",
    usageNote: "Khi người dùng chọn đăng nhập bằng Google",
    terms: UNKNOWN,
    dpa: UNKNOWN,
  },
  // ─── §5 Đã quét và KHÔNG có — canh gác để điều đó còn đúng ───
  {
    id: "N-EMAIL",
    vendor: "Dịch vụ gửi email (SMTP / Resend / SendGrid / Gmail API…)",
    legalEntity: UNKNOWN,
    role: "EMAIL",
    purpose: "Không có — hệ thống chưa có kênh thư (docs/saas/PROVISIONING.md)",
    datasets: [],
    dataCategories: "—",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "Cam kết «báo trước qua email» ở Điều khoản chưa có kênh thực hiện (F-11)",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["api.sendgrid.com", "api.resend.com", "api.postmarkapp.com", "api.mailgun.net", "gmail.googleapis.com", "api.brevo.com"], sdks: ["nodemailer", "@sendgrid/mail", "resend", "postmark", "mailgun.js", "@getbrevo/brevo"] },
  },
  {
    id: "N-SMS",
    vendor: "Dịch vụ SMS (eSMS / Twilio / SpeedSMS / Stringee / Firebase)",
    legalEntity: UNKNOWN,
    role: "SMS",
    purpose: "Không có — OTP chỉ qua Zalo ZNS (S13)",
    datasets: [],
    dataCategories: "—",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "Có SMS thì NĐ 91 (đồng ý trước + từ chối) áp ngay",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["api.twilio.com", "rest.esms.vn", "api.speedsms.vn", "api.stringee.com", "identitytoolkit.googleapis.com"], sdks: ["twilio", "firebase", "firebase-admin"] },
  },
  {
    id: "N-MONITORING",
    vendor: "Theo dõi lỗi / log tập trung (Sentry, Datadog, New Relic, Grafana Cloud…)",
    legalEntity: UNKNOWN,
    role: "MONITORING",
    purpose: "Không có — log ở Docker trên VPS, audit trong CSDL (ngoài healthchecks.io tuỳ chọn, S7)",
    datasets: [],
    dataCategories: "—",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "Thêm một bên log tập trung = log (có thể chứa dữ liệu người) rời VN",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["sentry.io", "datadoghq.com", "newrelic.com", "grafana.net", "logtail.com", "betterstack.com"], sdks: ["@sentry/nextjs", "@sentry/node", "dd-trace", "newrelic", "@logtail/node"] },
  },
  {
    id: "N-ANALYTICS",
    vendor: "Analytics bên thứ ba (GA / GTM / Meta Pixel / PostHog / Plausible / Hotjar / Clarity)",
    legalEntity: UNKNOWN,
    role: "ANALYTICS",
    purpose: "Không có — chỉ bộ đếm first-party app/api/usage/visit",
    datasets: [],
    dataCategories: "—",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "Không cookie bên thứ ba ⇒ không cần cookie banner hôm nay",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["googletagmanager.com", "google-analytics.com", "connect.facebook.net", "posthog.com", "plausible.io", "hotjar.com", "clarity.ms"], sdks: ["posthog-js", "@vercel/analytics", "mixpanel-browser", "react-ga4", "@next/third-parties"] },
  },
  {
    id: "N-PAYMENT-GATEWAY",
    vendor: "Cổng thanh toán thẻ / ví (VNPay, MoMo, ZaloPay, PayOS, OnePay, Casso, Stripe, PayPal)",
    legalEntity: UNKNOWN,
    role: "PAYMENT_GATEWAY",
    purpose: "Không có — thu tiền bằng chuyển khoản + đối soát SePay (S26)",
    datasets: [],
    dataCategories: "—",
    calledFrom: [],
    hosts: [],
    sdks: [],
    usage: "NOT_IN_USE",
    usageNote: "lib/billing/provider.ts: cổng thanh toán là dịch vụ ngoài mới, phải hỏi chủ nền tảng",
    terms: UNKNOWN,
    dpa: UNKNOWN,
    watch: { hosts: ["vnpayment.vn", "momo.vn", "zalopay.vn", "payos.vn", "onepay.vn", "casso.vn", "stripe.com", "paypal.com"], sdks: ["stripe", "@stripe/stripe-js", "@paypal/checkout-server-sdk", "@payos/node"] },
  },
];

// ─────────────────────────── Sổ chuyển xuyên biên giới ───────────────────────────

/** Hồ sơ đánh giá tác động chuyển dữ liệu ra nước ngoài (NĐ 356 Điều 18, Mẫu 09). Hôm nay: CHƯA hồ sơ nào được lập. */
export const TRANSFER_ASSESSMENT_STATES = ["NOT_FILED", "DRAFTED", "FILED", "NOT_REQUIRED_CONFIRMED"] as const;
export type TransferAssessmentState = (typeof TRANSFER_ASSESSMENT_STATES)[number];

export type CrossBorderTransfer = {
  id: CrossBorderId;
  vendor: string;
  /** Dòng của sổ bên xử lý phụ đi qua đường chuyển này. */
  processors: readonly string[];
  dataCategories: string;
  purpose: string;
  /** Dữ liệu có rời máy chủ VN tới pháp nhân / hạ tầng ngoài VN không. Pháp nhân VN mà nơi xử lý chưa xác minh ⇒ UNKNOWN. */
  crossBorder: "YES" | "NO" | Unknown;
  /** Nơi bên kia xử lý / lưu — chưa có văn bản của bên đó ⇒ UNKNOWN (KHÔNG đoán). */
  region: Unknown | Evidence;
  /** Bên kia giữ dữ liệu bao lâu. */
  retentionAtVendor: Unknown | Evidence;
  /** Hợp đồng / DPA / điều khoản đã đọc có ngày. */
  contractEvidence: Unknown | { evidence: string };
  transferAssessment: TransferAssessmentState;
  note: string;
};

export const CROSS_BORDER_TRANSFERS: readonly CrossBorderTransfer[] = [
  {
    id: "X1",
    vendor: "Google Gemini API",
    processors: ["S17", "S18", "S19", "S20"],
    dataCategories: "Nội dung hội thoại, tên hiển thị, SĐT / địa chỉ nếu khách gõ, ảnh, ghi âm (bot nhà)",
    purpose: "Sinh câu trả lời / trích đơn / đọc ảnh",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "API generativelanguage không cam kết vùng; Vertex AI có vùng nhưng chưa dùng — BLOCKER (U)",
  },
  {
    id: "X2",
    vendor: "Google Drive (sao lưu)",
    processors: ["S2"],
    dataCategories: "Toàn bộ CSDL — mã hoá rclone crypt, khoá ở VPS",
    purpose: "Sao lưu ngoài máy",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Dữ liệu đã mã hoá có còn là chuyển DLCN không — G-3; giữ hay chuyển về trong nước — F-3",
  },
  {
    id: "X3",
    vendor: "Telegram Bot API",
    processors: ["S15"],
    dataCategories: "Tên, SĐT, địa chỉ, món hàng của khách hàng cuối; cảnh báo vận hành",
    purpose: "Tin báo nhóm / tin đơn mới",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Giữ tin đầy đủ (phương án A) hay chuyển tin đơn sang Zalo Bot (B) — F-2",
  },
  {
    id: "X4",
    vendor: "Lark Custom Bot",
    processors: ["S16"],
    dataCategories: "Cảnh báo, bản tin, leo thang: mã đơn, tên khách, SĐT ở một số mẫu",
    purpose: "Cảnh báo vận hành ERP nhà",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Pháp nhân đăng ký ở Singapore — nơi xử lý vẫn chưa xác minh",
  },
  {
    id: "X5",
    vendor: "Meta Graph / Messenger",
    processors: ["S8", "S9", "S10"],
    dataCategories: "Tin hai chiều, PSID, tên; câu trả lời bot",
    purpose: "Kênh bán hàng",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Dữ liệu sinh ra ở Meta, VNX nhận về và gửi lại — có cần hồ sơ không: G-3",
  },
  {
    id: "X6",
    vendor: "Anthropic / OpenAI",
    processors: ["S21", "S22"],
    dataCategories: "Hội thoại CSKH của shop VNX (phân loại), ảnh sản phẩm, prompt copilot",
    purpose: "AI nội bộ ERP nhà; BYOK",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "ERP nhà VNX (không phải sản phẩm Chốt Đơn) — vẫn vào hồ sơ của VNX",
  },
  {
    id: "X7",
    vendor: "GitHub",
    processors: ["S3", "S4"],
    dataCategories: "Mã nguồn; kết quả truy vấn production đã mã hoá; log Actions cũ (sự cố 24/09)",
    purpose: "Mã nguồn, CI/CD, ops",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Thấp — vẫn liệt kê; sự cố 24/09 chờ G-11",
  },
  {
    id: "X8",
    vendor: "Google Places (+ relay Cloud Run của khách thuê)",
    processors: ["S29", "S6"],
    dataCategories: "Tên, SĐT, địa chỉ cơ sở kinh doanh (chiều VÀO); từ khoá tìm (chiều RA)",
    purpose: "Săn khách sỉ",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Chặng relay đặt asia-southeast1 theo cấu hình (deploy/places-relay/server.js) — đó là trạm chuyển, KHÔNG phải nơi Places API xử lý; vùng của API vẫn UNKNOWN",
  },
  {
    id: "X9",
    vendor: "Cloudflare Worker (relay Telegram)",
    processors: ["S5"],
    dataCategories: "Toàn bộ nội dung tin Telegram (tin đơn: tên, SĐT, địa chỉ) + bot token",
    purpose: "Vượt chặn mạng tới Telegram",
    crossBorder: "YES",
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Đang bật trên production hay không: UNKNOWN (TELEGRAM_API_BASE — M-OBSERVE); chưa công bố ở Chính sách 1.1",
  },
  {
    id: "X10",
    vendor: "Zalo Bot API",
    processors: ["S14"],
    dataCategories: "Tin báo nhóm (có thể chứa đơn)",
    purpose: "Tin báo nhóm",
    crossBorder: UNKNOWN,
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Pháp nhân VN (VNG); nơi xử lý chưa xác minh bằng văn bản",
  },
  {
    id: "X11",
    vendor: "GHN · GHTK",
    processors: ["S24", "S25"],
    dataCategories: "Tên, SĐT, địa chỉ người nhận, COD",
    purpose: "Giao hàng",
    crossBorder: UNKNOWN,
    region: UNKNOWN,
    retentionAtVendor: UNKNOWN,
    contractEvidence: UNKNOWN,
    transferAssessment: "NOT_FILED",
    note: "Pháp nhân VN; nơi xử lý chưa xác minh bằng văn bản; thiếu trong Chính sách §4",
  },
];

// ─────────────────────────── Quét mã nguồn: miễn trừ có lý do ───────────────────────────

/**
 * Hostname xuất hiện trong mã nguồn mà KHÔNG phải một bên nhận dữ liệu. Mỗi dòng PHẢI có lý do — bài kiểm từ chối lý do
 * rỗng. Thêm một hostname vào đây thay vì khai một bên xử lý là một khẳng định («máy chủ không gửi dữ liệu người tới đó»)
 * và người duyệt phải đọc được nó.
 */
export const VENDOR_SCAN_EXEMPT_HOSTS: Readonly<Record<string, string>> = {
  "www.w3.org": "Không gian tên XML / SVG — chuỗi định danh, không gọi mạng",
  "schema.org": "Ngữ cảnh JSON-LD — chuỗi định danh, không gọi mạng",
  "www.sitemaps.org": "Không gian tên sitemap — chuỗi định danh",
  "scripts.sil.org": "Liên kết giấy phép phông chữ — không gọi mạng",
  "vnxcommerce.com": "Tên miền của chính nền tảng",
  "chotdontudong.com": "Tên miền của chính nền tảng",
  "nhahang.vn": "Ví dụ minh hoạ trong câu hướng dẫn",
  "www.nhahangabc.vn": "Ví dụ minh hoạ trong câu hướng dẫn",
  "zalo.me": "Liên kết cho NGƯỜI bấm (mở Zalo) — máy chủ không gửi dữ liệu",
  "wa.me": "Liên kết cho người bấm — máy chủ không gửi dữ liệu",
  "fb.me": "Liên kết chia sẻ cho người bấm — máy chủ không gửi dữ liệu",
  "fb.com": "Liên kết cho người bấm — máy chủ không gửi dữ liệu",
  "www.google.com": "Liên kết bản đồ / tìm kiếm cho người bấm — máy chủ không gửi dữ liệu",
  "developers.google.com": "Liên kết tài liệu",
  "docs.sepay.vn": "Liên kết tài liệu",
  "developer.sepay.vn": "Liên kết tài liệu",
  "developer.pancake.biz": "Liên kết tài liệu",
  "pixabay.com": "Liên kết giấy phép nhạc nền (Video Scale) — không gọi API",
  "mixkit.co": "Liên kết giấy phép nhạc nền (Video Scale) — không gọi API",
  "get.docker.com": "Script cài VPS một lần tải trình cài Docker — không mang dữ liệu người",
  "ifconfig.me": "Script cài VPS một lần hỏi IP công khai của máy — không mang dữ liệu người",
  "api.ipify.org": "Script cài VPS một lần hỏi IP công khai của máy — không mang dữ liệu người",
};

/** Hostname `host` thuộc mục `entryHost` khi trùng hẳn hoặc là tên miền con. */
export function hostMatches(host: string, entryHost: string): boolean {
  const h = host.toLowerCase();
  const e = entryHost.toLowerCase();
  return h === e || h.endsWith(`.${e}`);
}

/** Dòng sổ (đang / có điều kiện dùng) khai hostname này — `null` khi chưa ai khai. */
export function subprocessorForHost(host: string): SubprocessorEntry | null {
  return SUBPROCESSORS.find((s) => s.usage !== "NOT_IN_USE" && s.hosts.some((h) => hostMatches(host, h))) ?? null;
}

/**
 * Đuôi tên miền DÀNH RIÊNG (RFC 2606 / 6761) — không bao giờ phân giải ra một máy chủ của bên thứ ba, nên một URL mang nó
 * (gốc giả để `new URL()` đọc đường dẫn tương đối, giá trị mặc định cho kiểm thử) không phải một bên nhận dữ liệu.
 */
export const RESERVED_TLDS: readonly string[] = ["local", "invalid", "test", "example", "localhost"];

/** Hostname được miễn trừ (kèm lý do) — `null` khi không. */
export function exemptReasonForHost(host: string): string | null {
  const tld = host.toLowerCase().split(".").pop() ?? "";
  if (RESERVED_TLDS.includes(tld)) return `Đuôi .${tld} dành riêng (RFC 2606 / 6761) — không phân giải ra máy chủ bên ngoài`;
  for (const [h, why] of Object.entries(VENDOR_SCAN_EXEMPT_HOSTS)) if (hostMatches(host, h)) return why;
  return null;
}

/**
 * Mọi ô UNKNOWN của hai sổ, mỗi ô một dòng `<id>.<trường>` — để màn hình / báo cáo in RA chỗ chưa biết thay vì giấu.
 * Không ô nào ở đây được «điền cho đủ»: muốn bớt một dòng thì phải có văn bản của bên kia (luật 45: TRUE_UNKNOWN giữ nguyên).
 */
export function legalRegisterUnknowns(): string[] {
  const out: string[] = [];
  for (const s of SUBPROCESSORS) {
    if (s.legalEntity === UNKNOWN) out.push(`${s.id}.legalEntity`);
    if (s.terms === UNKNOWN) out.push(`${s.id}.terms`);
    if (s.dpa === UNKNOWN) out.push(`${s.id}.dpa`);
  }
  for (const x of CROSS_BORDER_TRANSFERS) {
    if (x.crossBorder === UNKNOWN) out.push(`${x.id}.crossBorder`);
    if (x.region === UNKNOWN) out.push(`${x.id}.region`);
    if (x.retentionAtVendor === UNKNOWN) out.push(`${x.id}.retentionAtVendor`);
    if (x.contractEvidence === UNKNOWN) out.push(`${x.id}.contractEvidence`);
  }
  return out;
}
