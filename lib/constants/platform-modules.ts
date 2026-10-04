import type { ModuleRow, Organization } from "@/lib/platform/types";

/**
 * ═══════════ SỔ MODULE CỦA NỀN TẢNG ═══════════
 *
 * Hợp đồng: `docs/platform/shared-contracts.md` mục 5–6; kiến trúc: `target-architecture.md` P6–P10.
 *
 * Sổ là MÃ NGUỒN (toàn cục, có phiên bản cùng mã); cấu hình bật/tắt là DỮ LIỆU theo tổ chức
 * (`platform_organization_modules`). Tệp này THUẦN và client-safe: không đọc CSDL, không import
 * `next` hay `node:*` — middleware, thanh menu và bài kiểm cùng dùng một bản.
 *
 * ─── HAI THỨ MỘT MODULE SỞ HỮU ───
 *
 *  · TIỀN TỐ ĐƯỜNG DẪN (P9) — cổng chính. Quyền không ánh xạ sạch sang module (`/ads` gác bằng
 *    `expenses:view`, `/production` bằng `planning:view`), nên tắt một module chặn theo ĐƯỜNG DẪN.
 *    Khớp tiền tố DÀI NHẤT theo ranh giới đoạn: `/inventory/planning` thuộc Sản xuất dù
 *    `/inventory` thuộc Kho. `tests/platform-modules.test.ts` quét MỌI `page.tsx`/`route.ts` và đòi
 *    mỗi cái thuộc đúng một module.
 *
 *  · KHOÁ QUYỀN — một khoá thuộc TỐI ĐA một module. `can()` trả `false` cho khoá của module đang
 *    tắt, kể cả ADMIN (P8). Luật gán: khoá thuộc module M khi mọi trang dùng nó làm CỔNG VÀO đều
 *    nằm trong M hoặc trong một module PHỤ THUỘC vào M (nên M chắc chắn bật khi trang ấy mở). Khoá
 *    là cổng vào của hai module không phụ thuộc nhau thì KHÔNG module nào sở hữu — gán cho một bên
 *    là khoá chết trang của bên kia — và phải khai ở `UNOWNED_PERMISSIONS` kèm lý do; cổng đường
 *    dẫn vẫn chặn nó ở từng trang. Khoá chỉ dùng để mở MỘT PHẦN của trang module khác (vd nút gán
 *    marketer trên `/ads` cần `payroll:manage`) vẫn thuộc module chủ: tắt module chủ thì phần ấy ẩn
 *    — hỏng về phía hẹp.
 *
 * **Khoá module là BẤT BIẾN** — nằm trong `platform_organization_modules.module_key`. Đổi tên là làm
 * mồ côi cấu hình của mọi tổ chức. Thêm module thì thêm khoá MỚI.
 */

export type ModuleCategory = "CORE" | "COMMERCE" | "OPERATIONS" | "FINANCE" | "PEOPLE" | "MARKETING" | "INDUSTRY" | "CONNECTOR" | "INTELLIGENCE";

export const MODULE_KEYS = [
  "core",
  "work",
  "customers",
  "products",
  "orders",
  "inventory",
  "purchasing",
  "production",
  "logistics",
  "returns",
  "customer_care",
  "sales_channels",
  "marketing",
  "finance",
  "payroll",
  "alerts",
  "tech",
  "connector_pancake",
  "connector_viettelpost",
  "connector_meta",
  "connector_bank",
  "connector_messaging",
  "integrations",
  "apps",
  "ai_sales",
  "appointments",
  "warranty",
  "wholesale_leads",
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export type FeatureDef = { key: string; label: string; defaultEnabled: boolean; why: string };

export type ModuleDef = {
  key: ModuleKey;
  label: string;
  description: string;
  category: ModuleCategory;
  version: 1;
  core: boolean; // true ⇒ không tắt được, luôn bật
  dependsOn: ModuleKey[];
  features: FeatureDef[]; // khoá đầy đủ "<module>.<feature>"
  routes: string[]; // tiền tố đường dẫn trang + API sở hữu (khớp dài nhất thắng)
  permissions: string[]; // khoá quyền SỞ HỮU DUY NHẤT (một khoá thuộc tối đa một module)
  requiresHomeCredentials?: boolean; // connector dùng biến môi trường — Phase 1 chỉ tổ chức nhà bật được
  /**
   * Module mới mà tổ chức NHÀ không tự nhận (0180): sổ module của nhà mặc định BẬT mọi khoá thiếu dòng, nên module thêm
   * sau được migration ghi một dòng TẮT cho nhà — nhà bật tay ở /settings/modules nếu muốn. `/api/health` không đòi nhà bật
   * những module này.
   */
  homeOptIn?: boolean;
  why: string; // vì sao module này tồn tại / ranh giới của nó
};

/** Khoá quyền của nền tảng (hợp đồng mục 11; `metadata:manage` — phase-2-contracts M11). Khai ở đây để sổ module tự kiểm được chủ của chúng. */
export const PLATFORM_PERMISSION_KEYS = ["modules:manage", "platform:operate", "metadata:manage", "workflow:manage"] as const;

/**
 * Đường dẫn KHÔNG thuộc module nào — `moduleOfPath` trả `null`, không cổng module nào chặn.
 *  · `/api/webhooks`, `/api/sync`: tuyến máy-gọi-máy, chạy trong `withOrganization` và tự kiểm
 *    module của connector / job (hợp đồng mục 5, 8).
 *  · `/login`: chưa có phiên thì chưa có tổ chức để hỏi module.
 *  · `/start`: tạo tổ chức tự phục vụ (Phase 10) — tổ chức CHƯA tồn tại; cổng của nó là cờ `PLATFORM_SIGNUP_MODE`
 *    kiểm ở máy chủ (`lib/onboarding/service.ts`), không phải module.
 *  · `/join`: nhận lời mời người dùng — người được mời CHƯA có phiên nên chưa có tập module để hỏi; cổng của nó là mã
 *    mời, tra trong CSDL của tổ chức ghi trong đường dẫn (`lib/users/invites.ts`). Quản lý lời mời thì ở
 *    `/settings/users` (lõi, `users:manage`).
 *  · `/chat` (0180): trang chat CÔNG KHAI của chatbot bán hàng trên tên miền con — không phiên; tổ chức lấy từ host (chỉ
 *    tổ chức đã xuất bản) và trang tự hỏi module «AI bán hàng» TRONG ngữ cảnh tổ chức đó.
 *  · `/api/platform/domain-allowed` (0180): Caddy on-demand TLS hỏi — không phiên, chỉ trả 200/404.
 *  · `/gioi-thieu`: trang giới thiệu nền tảng ở tên miền gốc (lib/platform/site-host.ts) — người đọc chưa có tổ chức;
 *    trang chỉ đọc gói cước và chế độ đăng ký của nền tảng.
 *  · `/_next`: tài nguyên tĩnh của Next.
 */
export const MODULE_FREE_PATH_PREFIXES = ["/api/webhooks", "/api/sync", "/login", "/start", "/join", "/reset", "/chat", "/api/platform/domain-allowed", "/gioi-thieu", "/chinh-sach-bao-mat", "/dieu-khoan-su-dung", "/_next"] as const;

export const PLATFORM_MODULES: readonly ModuleDef[] = [
  {
    key: "core",
    label: "Nền tảng",
    description: "Tổng quan, buồng lái của chủ, người dùng & phân quyền, nhật ký, phòng ban, chất lượng dữ liệu, quản trị module.",
    category: "CORE",
    version: 1,
    core: true,
    dependsOn: [],
    features: [],
    routes: ["/", "/cockpit", "/approvals", "/settings", "/setup", "/audit", "/departments", "/data-quality", "/module-disabled", "/billing-locked", "/help", "/api/export/data", "/platform", "/p", "/api/events", "/api/notifications", "/api/health", "/api/perf", "/api/refresh", "/api/usage", "/api/metadata", "/api/branding"],
    permissions: ["dashboard:view", "audit:view", "users:manage", "settings:manage", "approvals:decide", ...PLATFORM_PERMISSION_KEYS],
    why: "Thứ mọi tổ chức cần để đăng nhập, phân quyền và quản trị chính mình. Không tắt được: tắt nó là khoá người quản trị khỏi chính màn hình bật lại nó. `/cockpit` ở đây: nó là tầng TỔNG HỢP của chủ (gác `dashboard:view`) đọc nhiều miền, không phải một màn hình Tài chính. `/integrations` KHÔNG ở đây — trang ấy in credential của tổ chức nhà (xem module «Kết nối dữ liệu»). `/approvals` ở đây: hàng đợi DUYỆT HAI BƯỚC (khoá `approvals:decide` của lõi) — luật tự động có cửa duyệt chạy ở mọi tổ chức, nên màn duyệt không được phụ thuộc «Cần xử lý» (module ấy cần «Đơn hàng»; tổ chức dịch vụ không có thì lượt chạy treo «chờ duyệt» mãi). `/api/metadata` (tải tệp của field tuỳ biến) ở đây vì một tệp thuộc ĐỐI TƯỢNG của bất kỳ module nào — route tự kiểm module của đối tượng sở hữu tệp và trả 403 MODULE_DISABLED khi nó tắt.",
  },
  {
    key: "work",
    label: "Công việc & mục tiêu",
    description: "Hàng đợi việc, OKR / BSC, thẻ điểm hiệu suất, kỳ review.",
    category: "CORE",
    version: 1,
    core: true,
    dependsOn: [],
    features: [
      { key: "work.okr", label: "OKR & thẻ điểm BSC", defaultEnabled: true, why: "Mục tiêu nối vào chỉ số có thật (luật 20); tổ chức chưa dùng OKR vẫn cần hàng đợi việc." },
      { key: "work.performance", label: "Thẻ điểm hiệu suất & kỳ review", defaultEnabled: true, why: "Chấm người bằng việc thuộc phòng của họ (luật 24) — tách khỏi hàng đợi vì không phải tổ chức nào cũng muốn chấm điểm." },
    ],
    routes: ["/work"],
    permissions: ["work:view", "work:manage", "work:assign", "work:department", "work:all", "work:admin", "okr:view", "okr:manage", "performance:view", "review:manage"],
    why: "Hàng đợi `/work` là PHÉP CHIẾU của mọi miền nghiệp vụ (luật 19) và cấu hình phòng ban (`work:admin`) được nhiều màn hình khác dùng — nên nó luôn bật như lõi.",
  },
  {
    key: "customers",
    label: "Khách hàng",
    description: "Hồ sơ khách, lịch sử mua, khách quay lại.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: [],
    features: [{ key: "customers.retention", label: "Khách quay lại", defaultEnabled: true, why: "Màn hình giữ chân khách (`/customers/retention`) — phân tích, không phải thao tác." }],
    routes: ["/customers"],
    permissions: ["customers:view", "customers:write"],
    why: "Danh bạ khách là nền của đơn hàng và CSKH; đứng riêng để tổ chức chỉ quản lý khách (chưa bán) vẫn dùng được.",
  },
  {
    key: "products",
    label: "Sản phẩm",
    description: "Sản phẩm, mẫu mã, hiệu quả theo mã hàng.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: [],
    features: [
      { key: "products.performance", label: "Hiệu quả theo mã hàng", defaultEnabled: true, why: "`/products/performance` — tỷ lệ giao thành công theo mã, đọc `ORDER_OUTCOME`." },
      { key: "products.notes", label: "Ghi chú sản phẩm", defaultEnabled: true, why: "Ô chữ tự do cho người đọc; không chạm con số nào (luật 46)." },
    ],
    routes: ["/products", "/api/export/products", "/api/phone-reputation"],
    permissions: ["products:view", "products:write"],
    why: "Danh mục hàng là nền của đơn, kho và sản xuất. `products:view` là cổng vào của cả trang Kho — Kho phụ thuộc Sản phẩm nên khoá thuộc về đây. `products:write` = tạo / sửa mã hàng TẠO TAY (chỉ khi tổ chức không bật `connector_pancake`).",
  },
  {
    key: "orders",
    label: "Đơn hàng",
    description: "Danh sách đơn, chi tiết đơn, xác minh đơn, xuất CSV.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: ["customers", "products"],
    features: [
      { key: "orders.verify", label: "Xác minh đơn", defaultEnabled: true, why: "`/orders/verify` — hàng đợi xác minh trước khi đẩy đi." },
      { key: "orders.export", label: "Xuất CSV đơn hàng", defaultEnabled: true, why: "Dữ liệu rời khỏi hệ thống — tổ chức có thể muốn tắt." },
    ],
    routes: ["/orders", "/api/export/orders"],
    permissions: ["orders:read", "orders:export", "orders:write"],
    why: "Một đơn là một khách mua một số sản phẩm — không có hai sổ kia thì đơn không có nghĩa. `orders:write` = tạo / sửa / huỷ đơn TẠO TAY (chỉ khi tổ chức không bật `connector_pancake`).",
  },
  {
    key: "inventory",
    label: "Kho",
    description: "Sổ kho, phiếu nhập, đóng gói, tái nhập hàng hoàn.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: ["products"],
    features: [
      { key: "inventory.stock_ledger", label: "Sổ kho (phiếu kho)", defaultEnabled: true, why: "Tồn thực tế = tổng phiếu kho − đã xuất qua ĐVVC (AGENTS mục 3.10)." },
      { key: "inventory.returns_restock", label: "Tái nhập hàng hoàn", defaultEnabled: true, why: "Hàng hoàn chỉ về tồn khi kho lập phiếu RETURN với số đếm thực (luật 4)." },
      { key: "inventory.packing", label: "Đợt đóng gói", defaultEnabled: true, why: "`/inventory/packing` — gom đơn theo đợt đóng hàng." },
    ],
    routes: ["/inventory", "/inventory/receipts", "/inventory/packing"],
    permissions: ["inventory:write", "inventory:restock-unidentified"],
    why: "Kho đếm hàng thật. Các trang con của `/inventory` thuộc Mua hàng / Sản xuất / Hàng hoàn khai ở module của chúng — khớp tiền tố dài nhất thắng.",
  },
  {
    key: "purchasing",
    label: "Mua hàng",
    description: "Nhà cung cấp & đặt hàng, thiếu hàng, quyết định nhập / xả.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: ["inventory"],
    features: [
      { key: "purchasing.suppliers", label: "Nhà cung cấp & đơn mua", defaultEnabled: true, why: "`/inventory/purchasing` — nhà cung cấp và công nợ mua hàng." },
      { key: "purchasing.shortage", label: "Thiếu hàng", defaultEnabled: true, why: "`/inventory/shortage` — đơn chờ hàng, mẫu thiếu tồn." },
      { key: "purchasing.reorder_decisions", label: "Quyết định nhập / xả", defaultEnabled: true, why: "`/inventory/decisions` — đề xuất đặt lại hàng và xả hàng chậm bán." },
    ],
    routes: ["/inventory/purchasing", "/inventory/shortage", "/inventory/decisions"],
    permissions: [],
    why: "Mua hàng về kho, không tự sản xuất. Khoá `planning:*` gác cả Mua hàng lẫn Sản xuất nên không module nào sở hữu nó (xem `UNOWNED_PERMISSIONS`).",
  },
  {
    key: "production",
    label: "Sản xuất",
    description: "Topic hỏi giá xưởng, giá thành, mẫu, vòng đời mẫu, kế hoạch đặt xưởng, sổ xưởng.",
    category: "INDUSTRY",
    version: 1,
    core: false,
    dependsOn: ["products", "inventory"],
    features: [
      { key: "production.topics", label: "Topic sản xuất & giá thành", defaultEnabled: true, why: "`/production` — mở topic, báo giá, bảng giá thành, mẫu chờ duyệt." },
      { key: "production.models", label: "Vòng đời mẫu", defaultEnabled: true, why: "`/models` — sổ mẫu và trạng thái vòng đời đã khai." },
      { key: "production.planning", label: "Kế hoạch đặt xưởng", defaultEnabled: true, why: "`/inventory/planning` — đề xuất và bảng đặt hàng chốt gửi xưởng." },
      { key: "production.workshop", label: "Sổ xưởng", defaultEnabled: true, why: "`/inventory/workshop` — công nợ và giao nhận với xưởng." },
    ],
    // `/marketing/topics` (chủ shop 27/09/2026): biểu mẫu mở topic nằm dưới menu Marketing nhưng LÀ tính năng
    // topic sản xuất — tiền tố dài hơn `/marketing` nên khớp về đây; tắt module Sản xuất là tắt luôn nó.
    routes: ["/production", "/marketing/topics", "/models", "/inventory/planning", "/inventory/workshop", "/print/production", "/api/production", "/api/export/planning"],
    permissions: ["models:view", "models:write", "production:write", "production:topic-open", "production:approve"],
    why: "Chỉ tổ chức TỰ đặt xưởng mới cần. Tách khỏi Mua hàng vì nhà buôn nhập hàng thành phẩm không có topic, mẫu hay giá thành.",
  },
  {
    key: "logistics",
    label: "Vận chuyển",
    description: "Vận đơn, chăm sóc kiện hàng, vận hành kho giao, nhập tệp ĐVVC.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: ["orders"],
    features: [
      { key: "logistics.care", label: "Chăm sóc kiện hàng", defaultEnabled: true, why: "Ca chăm sóc kiện giao chậm / chờ phát lại (luật 56–64)." },
      { key: "logistics.carrier_import", label: "Nhập tệp ĐVVC", defaultEnabled: true, why: "`/import-vtp` — chạy thử được và mọi lượt đều có vết (luật 49)." },
      { key: "logistics.operations", label: "Bàn vận hành", defaultEnabled: true, why: "`/operations` — tuổi chặng, trước khi giao, hoàn tất đơn." },
    ],
    routes: ["/shipments", "/operations", "/import-vtp", "/reports/stock-wait", "/api/shipments"],
    permissions: ["shipments:view", "shipments:manage"],
    why: "Đơn rời kho tới tay khách. `/reports/stock-wait` chỉ chuyển hướng sang `/shipments/stock-wait` nên thuộc về đây, không thuộc Tài chính.",
  },
  {
    key: "returns",
    label: "Hàng hoàn",
    description: "Đổi / trả, kiểm hàng hoàn tại kho, tỷ lệ hoàn theo mã.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: ["orders", "inventory"],
    features: [
      { key: "returns.inspection", label: "Kiểm hàng hoàn tại kho", defaultEnabled: true, why: "`/inventory/returns` — nhận, đếm, kiểm tình trạng trước khi tái nhập." },
      { key: "returns.rate_report", label: "Tỷ lệ hoàn theo mã", defaultEnabled: true, why: "`/reports/returns` — đọc `ORDER_OUTCOME`, không tự tính." },
    ],
    routes: ["/returns", "/reports/returns", "/inventory/returns", "/api/export/return-rate"],
    permissions: ["returns:view"],
    why: "Hàng quay về là một đơn cộng một lượt vào kho — thiếu một trong hai thì không có hàng hoàn.",
  },
  {
    key: "customer_care",
    label: "CSKH",
    description: "Case chăm sóc khách.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: ["customers"],
    features: [{ key: "customer_care.cases", label: "Case CSKH", defaultEnabled: true, why: "`/cs` — đổi size, đổi màu, sai địa chỉ / SĐT, trả hàng." }],
    routes: ["/cs"],
    permissions: ["cs:view", "cs:manage"],
    why: "Chăm sóc một KHÁCH (hỏi câu gì, cần gì) — khác chăm sóc một KIỆN HÀNG ở Vận chuyển (luật 53). `/chatbot` KHÔNG ở đây: nó là proxy tới bot duy nhất của VNX chạy trên Pancake, thuộc «Pancake POS».",
  },
  {
    key: "sales_channels",
    label: "Kênh bán (landing)",
    description: "Đơn từ landing page / Google Sheet.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: ["orders"],
    features: [{ key: "sales_channels.landing", label: "Đơn landing page", defaultEnabled: true, why: "`/landing` — đọc CSV công khai của Google Sheet, gửi đơn nháp lên POS." }],
    routes: ["/landing"],
    permissions: ["landing:view", "landing:manage", "landing:config"],
    why: "Kênh nhận đơn ngoài POS; mỗi đơn landing rồi cũng thành một đơn hàng.",
  },
  {
    key: "marketing",
    label: "Marketing",
    description: "Quảng cáo, ý tưởng & thư viện creative, fanpage, chăm sóc & bán chéo.",
    category: "MARKETING",
    version: 1,
    core: false,
    dependsOn: ["orders"],
    features: [
      { key: "marketing.meta_ads", label: "Hiệu quả quảng cáo", defaultEnabled: true, why: "`/ads` — chi tiêu theo chiến dịch / mã / marketer (luật 67)." },
      { key: "marketing.creative_library", label: "Ý tưởng & thư viện creative", defaultEnabled: true, why: "`/ideas`, `/marketing/creatives`, `/marketing/video-scale`." },
      { key: "marketing.profitability", label: "Lợi nhuận theo fanpage / marketer", defaultEnabled: true, why: "`/marketing/fanpages` — quy kết đơn theo ảnh chụp phân công fanpage." },
      { key: "marketing.outreach", label: "Chăm sóc & bán chéo", defaultEnabled: true, why: "`/outreach` — gửi tin hàng loạt, kịch bản chăm sóc." },
    ],
    routes: ["/ads", "/ideas", "/marketing", "/outreach", "/api/ideas", "/api/creative", "/api/video-scale", "/api/export/creatives-live"],
    permissions: ["ideas:view", "ideas:write", "ideas:review", "outreach:view", "outreach:send", "outreach:config"],
    why: "Tiền quảng cáo đổi ra đơn — không có đơn thì không đo được hiệu quả. `expenses:*` và `reports:nominal` gác cả trang Marketing lẫn Tài chính nên không thuộc riêng ai.",
  },
  {
    key: "finance",
    label: "Tài chính",
    description: "Đối soát COD, sổ ngân hàng, chi phí, báo cáo lợi nhuận, dòng tiền.",
    category: "FINANCE",
    version: 1,
    core: false,
    dependsOn: [],
    features: [
      { key: "finance.cod_reconciliation", label: "Đối soát COD", defaultEnabled: true, why: "`/cod` — tiền thực thu theo bảng kê, không theo COD khai báo." },
      { key: "finance.bank_ledger", label: "Sổ ngân hàng", defaultEnabled: true, why: "`/bank` — sao kê không tạo chi phí (luật 17)." },
      { key: "finance.expenses", label: "Chi phí vận hành", defaultEnabled: true, why: "`/expenses` — một nguồn cho một khoản chi (luật 15)." },
      { key: "finance.profit_reports", label: "Báo cáo lợi nhuận", defaultEnabled: true, why: "`/reports` — danh nghĩa, theo đơn giao, theo dòng tiền." },
      { key: "finance.cashflow", label: "Dòng tiền", defaultEnabled: true, why: "`/reports/cashflow`, `/finance-ops`." },
    ],
    routes: ["/finance", "/finance-ops", "/cod", "/bank", "/expenses", "/reports", "/api/export/cod", "/api/export/report"],
    permissions: ["cod:view", "bank:view", "bank:write", "bank:accounts", "reports:delivered", "reports:cash", "reports:assumptions"],
    why: "Tiền thật và lợi nhuận. Không phụ thuộc module nào: tổ chức chỉ ghi sổ chi phí / ngân hàng vẫn dùng được; báo cáo tự rỗng khi thiếu đơn.",
  },
  {
    key: "payroll",
    label: "Lương & hoa hồng",
    description: "Kỳ lương, chính sách, phân công, phiếu lương cá nhân.",
    category: "PEOPLE",
    version: 1,
    core: false,
    dependsOn: [],
    features: [
      { key: "payroll.autopilot", label: "Lương tự động", defaultEnabled: true, why: "`/payroll/autopilot` — dựng kỳ lương từ dữ liệu ERP." },
      { key: "payroll.self_service", label: "Phiếu lương cá nhân", defaultEnabled: true, why: "`/my-payslip` — mỗi người chỉ xem của chính mình." },
    ],
    routes: ["/payroll", "/my-payslip", "/api/export/payroll"],
    permissions: ["payroll:view-own", "payroll:view-all", "payroll:view", "payroll:manage", "payroll:approve"],
    why: "Lương cố định đi theo thời gian, hoa hồng đi theo đơn (luật 16). Không phụ thuộc Đơn hàng: tổ chức chỉ trả lương cố định vẫn dùng được.",
  },
  {
    key: "alerts",
    label: "Cần xử lý",
    description: "Cảnh báo vận hành, ngưỡng, kênh Lark / Telegram.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: ["orders"],
    features: [{ key: "alerts.marketing", label: "Cảnh báo marketing", defaultEnabled: true, why: "Ngưỡng chi tiêu / ROAS gửi nhóm quản lý marketing." }],
    routes: ["/alerts"],
    permissions: ["alerts:view", "alerts:manage"],
    why: "Cảnh báo đọc đơn / vận đơn để báo việc cần người xử lý. Chuông thông báo (`/api/notifications`) nằm ở lõi nhưng gác bằng `alerts:view` — tắt module này thì chuông rỗng.",
  },
  {
    key: "tech",
    label: "Phòng Tech AI",
    description: "Sức khoẻ hệ thống, việc Tech, agent, deploy, sự cố.",
    category: "INTELLIGENCE",
    version: 1,
    core: false,
    dependsOn: [],
    features: [
      { key: "tech.agents", label: "Agent tự động", defaultEnabled: true, why: "`/tech/agents` — sổ agent và lượt chạy." },
      { key: "tech.cto", label: "AI CTO", defaultEnabled: true, why: "`/tech/cto` — đề xuất việc Tech." },
    ],
    routes: ["/tech", "/api/tech"],
    permissions: ["tech:view", "tech:manage"],
    requiresHomeCredentials: true,
    why: "Phòng kỹ thuật của chính mã nguồn NỀN TẢNG — không phụ thuộc nghiệp vụ nào. Khoá là `tech`, không phải `ai`: trợ lý AI dùng chung (`lib/ai/*`) KHÔNG phải module ở Phase 1 — nó bị chặn ở tầng credential. Chỉ tổ chức nhà bật được: agent nhận việc từ đây sửa kho mã chung qua GitHub dispatch bằng token của tổ chức nhà, nên ADMIN của tổ chức khác có `tech:manage` sẽ giao việc sửa mã nền tảng bằng credential không phải của họ.",
  },
  {
    key: "connector_pancake",
    label: "Pancake POS",
    description: "Đồng bộ đơn, khách, sản phẩm từ Pancake POS; chatbot trên Pancake Pages.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: ["orders"],
    features: [{ key: "connector_pancake.chatbot", label: "Chatbot Pancake", defaultEnabled: true, why: "`/chatbot` — quy tắc & mẫu tin của bot chạy trên Pancake Pages." }],
    routes: ["/chatbot", "/api/chatbot"],
    permissions: [],
    requiresHomeCredentials: true,
    why: "Credential nằm ở biến môi trường của tổ chức nhà (P12) — Phase 1 chỉ tổ chức nhà bật được. Webhook tự kiểm module này. `/chatbot` + `/api/chatbot` là proxy tới bot DUY NHẤT của VNX (chạy trên Pancake Pages) nên đi theo connector này, không theo CSKH.",
  },
  {
    key: "connector_viettelpost",
    label: "Viettel Post",
    description: "Webhook, bảng kê, danh sách vận đơn Viettel Post.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: ["logistics"],
    features: [],
    routes: [],
    permissions: [],
    requiresHomeCredentials: true,
    why: "Nguồn tin duy nhất của vận đơn (luật 51); credential của tổ chức nhà.",
  },
  {
    key: "connector_meta",
    label: "Meta Ads",
    description: "Chi tiêu quảng cáo, đăng camp qua System User token.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: ["marketing"],
    features: [],
    routes: [],
    permissions: [],
    requiresHomeCredentials: true,
    why: "Chỉ qua System User token (AGENTS mục 5); credential của tổ chức nhà.",
  },
  {
    key: "connector_bank",
    label: "Ngân hàng / SePay",
    description: "Giao dịch ngân hàng qua webhook SePay.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: ["finance"],
    features: [],
    routes: [],
    permissions: [],
    requiresHomeCredentials: true,
    why: "Đổ giao dịch vào sổ ngân hàng; credential của tổ chức nhà.",
  },
  {
    key: "connector_messaging",
    label: "Lark / Telegram",
    description: "Gửi cảnh báo và bản tin ra nhóm chat.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: [],
    features: [],
    routes: [],
    permissions: [],
    requiresHomeCredentials: true,
    why: "Kênh gửi tin, không phụ thuộc nghiệp vụ nào; URL webhook là secret của tổ chức nhà.",
  },
  {
    key: "integrations",
    label: "Kết nối dữ liệu",
    description: "Trang cấu hình kết nối, kiểm tra kết nối, chạy đồng bộ tay.",
    category: "CONNECTOR",
    version: 1,
    core: false,
    dependsOn: [],
    features: [],
    routes: ["/integrations", "/api/integrations"],
    permissions: ["integrations:view", "integrations:manage", "sync:run"],
    requiresHomeCredentials: true,
    why: "`/integrations` in nguyên secret webhook Viettel Post và URL webhook Pancake kèm secret; `/api/integrations/test` trả tên shop / BM / tài khoản Viettel Post — tất cả là credential của tổ chức nhà từ biến môi trường. Nên nó KHÔNG thuộc lõi và chỉ tổ chức nhà bật được.",
  },
  {
    key: "apps",
    label: "Ứng dụng tuỳ biến",
    description: "Đối tượng nghiệp vụ tổ chức tự tạo (Hợp đồng bảo trì, Công trình, Xe…): danh sách, form, chi tiết tự sinh, quan hệ, luật tự động.",
    category: "OPERATIONS",
    version: 1,
    core: false,
    dependsOn: [],
    features: [],
    routes: ["/o"],
    permissions: ["records:view", "records:write"],
    why: "Phase 6 (docs/platform/phase-6-contracts.md): tổ chức thêm nghiệp vụ Core không có sẵn mà không cần viết mã — bản ghi ở `custom_records`, giá trị ở `custom_values` (X5), không bảng vật lý cho mỗi đối tượng. Tắt module ⇒ mọi đối tượng tuỳ biến ẩn khỏi menu VÀ bị từ chối ở máy chủ; định nghĩa và dữ liệu giữ nguyên. Không phụ thuộc module nào: tổ chức chỉ quản lý Công trình vẫn dùng được. Cấu hình đối tượng ở `/settings/objects` (lõi, `metadata:manage`).",
  },
  {
    key: "ai_sales",
    label: "AI bán hàng",
    description: "Chatbot bán hàng của CHÍNH tổ chức: trả lời giá / tồn từ ERP, lên đơn nháp, chốt đơn khi khách xác nhận, chuyển người khi cần. Khoá AI của tổ chức (BYOK).",
    category: "INTELLIGENCE",
    version: 1,
    core: false,
    dependsOn: ["customers", "products", "orders", "inventory"],
    features: [{ key: "ai_sales.web_chat", label: "Trang chat công khai", defaultEnabled: true, why: "`/chat` trên tên miền con đã xuất bản — khách của shop chat không cần tài khoản." }],
    routes: ["/ai", "/api/ai-sales"],
    permissions: ["ai_sales:view", "ai_sales:manage"],
    homeOptIn: true,
    why: "Bot trả lời KHÁCH của shop — khác AI Builder (soạn cấu hình ERP) và khác bot Pancake của tổ chức nhà (`connector_pancake`). Giá và tồn luôn đọc từ ERP qua công cụ, không nằm trong lời nhắc. Mọi lượt ghi (khách, đơn) đi qua ĐÚNG lõi tạo tay của khách / đơn — không đường ghi thứ hai. Tắt cho tổ chức nhà (0180).",
  },
  {
    key: "appointments",
    label: "Lịch hẹn & liệu trình",
    description: "Ngành dịch vụ có lịch (spa, salon, phòng khám, gym): đặt lịch theo kỹ thuật viên, chặn trùng giờ, khách tới / làm xong / không tới, liệu trình N buổi trả trước tự trừ buổi.",
    category: "INDUSTRY",
    version: 1,
    core: false,
    dependsOn: ["customers", "products"],
    features: [],
    routes: ["/appointments"],
    permissions: ["appointments:view", "appointments:write"],
    homeOptIn: true,
    why: "Lịch là trục của ngành dịch vụ — khác hẳn đơn hàng giao đi. Dịch vụ là mẫu mã của module Sản phẩm (giá, tên), khách là khách của module Khách hàng; số buổi liệu trình KHÔNG lưu thành cột mà đếm từ lịch đã làm. Tắt cho tổ chức nhà (0190).",
  },
  {
    key: "warranty",
    label: "Bảo hành & đổi trả theo serial",
    description: "Ngành bán hàng có bảo hành (gia dụng, điện máy nhỏ, đồ công nghệ): phiếu bảo hành theo serial, tra theo SĐT / serial, ca bảo hành sửa / đổi mới / hoàn tiền / trả nhà cung cấp, biết ngay còn hay hết bảo hành.",
    category: "INDUSTRY",
    version: 1,
    core: false,
    dependsOn: ["customers", "products"],
    features: [],
    routes: ["/warranty"],
    permissions: ["warranty:view", "warranty:write"],
    homeOptIn: true,
    why: "Bảo hành là nghĩa vụ SAU bán của ngành gia dụng — khác đổi trả hàng hoàn của thời trang COD. Sản phẩm là mẫu mã của module Sản phẩm, khách là khách của module Khách hàng; «còn bảo hành» KHÔNG lưu thành cột mà tính từ ngày mở ca so với hạn. Tắt cho tổ chức nhà (0196).",
  },
  {
    key: "wholesale_leads",
    label: "Săn khách sỉ",
    description: "Tìm nhà hàng / quán / khách sạn / cửa hàng thực phẩm từ dữ liệu doanh nghiệp công khai (Google Places), chấm điểm, phủ theo tỉnh × khu vực, hàng đợi liên hệ có danh sách không liên hệ, pipeline bán sỉ tới lúc thành khách hàng.",
    category: "COMMERCE",
    version: 1,
    core: false,
    dependsOn: ["customers"],
    features: [
      { key: "wholesale_leads.website_enrichment", label: "Đọc trang liên hệ công khai của website doanh nghiệp", defaultEnabled: true, why: "Tìm email / hotline / Facebook / Zalo trên chính website của doanh nghiệp, mỗi phát hiện lưu kèm URL nguồn; không vượt đăng nhập / captcha." },
      { key: "wholesale_leads.ai_opener", label: "AI soạn lời chào", defaultEnabled: true, why: "AI chỉ diễn đạt lại từ dữ kiện có trong lead và cấu hình của shop; tắt thì dùng mẫu lời chào cố định." },
    ],
    routes: ["/wholesale", "/api/wholesale"],
    permissions: ["wholesale:view", "wholesale:work", "wholesale:assign", "wholesale:scan", "wholesale:config"],
    homeOptIn: true,
    why: "Bán sỉ B2B cần KHÁCH MỚI mà chưa ai nhắn tin tới — khác AI bán hàng (trả lời khách đã tới) và khác Khách hàng (người đã mua). Lead chỉ thành dòng `customers` khi chốt được (WON) và đi qua đúng lõi tạo khách có sẵn, nên không có CRM thứ hai. Phụ thuộc Khách hàng vì chuyển đổi ghi vào đó. Khoá Google Places là của CHÍNH tổ chức (kết nối `google-places`). Tắt cho tổ chức nhà (0197).",
  },
];

/**
 * Khoá quyền KHÔNG module nào sở hữu — cổng vào của trang ở HAI module không phụ thuộc nhau. Gán
 * cho một bên thì tắt bên ấy làm chết trang của bên kia (kể cả khi bên kia đang bật). Cổng đường
 * dẫn (P9) vẫn chặn từng trang; `can()` với các khoá này đi theo luật quyền cũ.
 */
export const UNOWNED_PERMISSIONS: Readonly<Record<string, string>> = {
  "planning:view": "Cổng vào của Mua hàng (`/inventory/purchasing`, `/shortage`, `/decisions`) VÀ Sản xuất (`/production`, `/inventory/planning`, `/inventory/workshop`); Sản xuất không phụ thuộc Mua hàng.",
  "planning:write": "Ghi ở cả Mua hàng (nhà cung cấp, thiếu hàng) lẫn Sản xuất (bảng đặt xưởng, sổ xưởng) — cùng lý do với `planning:view`.",
  "expenses:view": "Cổng vào của `/ads` (Marketing) VÀ `/expenses` (Tài chính); nhãn quyền nói rõ gộp cả hai, và Marketing không phụ thuộc Tài chính.",
  "expenses:write": "Ghi chi tiêu quảng cáo / creative (Marketing) VÀ chi phí vận hành (Tài chính) — cùng lý do với `expenses:view`.",
  "reports:nominal": "Cổng vào của `/marketing/fanpages` (Marketing) VÀ `/reports`, `/reports/scenario`, `/reports/target` (Tài chính).",
  "reports:returns": "Cổng vào của `/reports/returns` (Hàng hoàn), `/reports/funnel` (Tài chính) VÀ `/products/performance` (Sản phẩm) — ba module không phụ thuộc nhau.",
  "cs:config": "Cổng vào của `/chatbot` («Pancake POS») VÀ khoá cấu hình quy tắc / mẫu tin của `/cs` (CSKH); connector Pancake không phụ thuộc CSKH.",
  "cod:write": "Cổng vào DUY NHẤT là `/import-vtp` (Vận chuyển) — nhập cả danh sách vận đơn lẫn bảng kê COD; gán cho Tài chính là khoá tệp ĐVVC của tổ chức không bật Tài chính.",
};

/**
 * Mẫu tổ chức: bộ module khởi đầu. Mẫu KHÔNG tự kích hoạt (luật 23) — nó chỉ là dữ liệu người bấm
 * chọn lúc cấp tổ chức. Mỗi mẫu phải ĐÓNG dưới phụ thuộc (bài kiểm).
 */
export const ORG_TEMPLATES: Record<string, { label: string; modules: ModuleKey[] }> = {
  "fashion-commerce": { label: "Thời trang bán online (hồ sơ VNX)", modules: [...MODULE_KEYS] },
  wholesale: { label: "Bán buôn", modules: ["core", "work", "customers", "products", "orders", "inventory", "purchasing", "finance"] },
};

// ═══════════ TRA CỨU ═══════════

const MODULE_BY_KEY: ReadonlyMap<string, ModuleDef> = new Map(PLATFORM_MODULES.map((m) => [m.key, m]));

export function moduleDef(key: string): ModuleDef | null {
  return MODULE_BY_KEY.get(key) ?? null;
}

export function isModuleKey(key: string): key is ModuleKey {
  return MODULE_BY_KEY.has(key);
}

function labelOf(key: ModuleKey): string {
  return MODULE_BY_KEY.get(key)?.label ?? key;
}

function labelsOf(keys: readonly ModuleKey[]): string {
  return keys.map((k) => `«${labelOf(k)}»`).join(", ");
}

/** Bảng tiền tố → module, xếp DÀI trước để phép khớp đầu tiên là phép khớp dài nhất. */
const ROUTE_TABLE: readonly { prefix: string; module: ModuleKey }[] = PLATFORM_MODULES.flatMap((m) => m.routes.map((prefix) => ({ prefix, module: m.key }))).sort((a, b) => b.prefix.length - a.prefix.length);

const PERMISSION_OWNER: ReadonlyMap<string, ModuleKey> = new Map(PLATFORM_MODULES.flatMap((m) => m.permissions.map((p) => [p, m.key] as const)));

/**
 * Chuẩn hoá đường dẫn trước khi khớp: bỏ query/hash, giải mã phần trăm, gộp `//`, bỏ `/` cuối,
 * chữ thường. Mọi tiền tố trong sổ là chữ thường, nên `/PAYROLL` rơi về Lương (hỏng về phía hẹp)
 * thay vì lọt qua cổng như một đường dẫn "không thuộc module nào".
 */
function normalizePath(pathname: string): string {
  let p = pathname.split(/[?#]/)[0] ?? "";
  try {
    p = decodeURIComponent(p);
  } catch {
    // Chuỗi mã hoá hỏng: giữ nguyên để vẫn khớp được phần còn đọc được.
  }
  p = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/").toLowerCase();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.replace(/\/+$/, "") || "/";
  return p;
}

function underPrefix(path: string, prefix: string): boolean {
  if (prefix === "/") return path === "/";
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Module sở hữu một đường dẫn — tiền tố DÀI NHẤT theo ranh giới đoạn thắng. `null` = không thuộc
 * module nào: tuyến máy-gọi-máy / công khai (`MODULE_FREE_PATH_PREFIXES`) hoặc đường dẫn không có
 * trong sổ (bài kiểm bảo đảm mọi trang thật đều có trong sổ).
 */
export function moduleOfPath(pathname: string): ModuleKey | null {
  const path = normalizePath(pathname);
  if (MODULE_FREE_PATH_PREFIXES.some((prefix) => underPrefix(path, prefix))) return null;
  for (const row of ROUTE_TABLE) if (underPrefix(path, row.prefix)) return row.module;
  return null;
}

/** Module sở hữu một khoá quyền; `null` = không ai sở hữu (khoá dùng chung hoặc khoá lạ). */
export function moduleOfPermission(permission: string): ModuleKey | null {
  return PERMISSION_OWNER.get(permission) ?? null;
}

// ═══════════ PHÂN GIẢI ═══════════

/** Tập module mà DỮ LIỆU nói bật (P7 + lõi), CHƯA đóng dưới phụ thuộc. */
function declaredEnabled(org: Pick<Organization, "moduleDefault">, rows: readonly ModuleRow[]): Set<ModuleKey> {
  // Khoá lạ bị bỏ qua. Hai dòng cùng khoá (khoá chính cấm, nhưng dữ liệu gõ tay thì không) ⇒ một
  // dòng tắt là đủ để tắt — hỏng về phía hẹp.
  const explicit = new Map<ModuleKey, boolean>();
  for (const row of rows) {
    if (!isModuleKey(row.moduleKey)) continue;
    const previous = explicit.get(row.moduleKey);
    explicit.set(row.moduleKey, previous === false ? false : row.enabled === true);
  }
  const result = new Set<ModuleKey>();
  for (const m of PLATFORM_MODULES) {
    const on = m.core || (explicit.get(m.key) ?? org.moduleDefault === "ENABLED");
    if (on) result.add(m.key);
  }
  return result;
}

/** Loại tới điểm bất động mọi module có phụ thuộc không nằm trong tập. Lõi không phụ thuộc ai. */
function closeUnderDependencies(set: Set<ModuleKey>): Set<ModuleKey> {
  const result = new Set(set);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of [...result]) {
      const def = MODULE_BY_KEY.get(key);
      if (!def || def.core) continue;
      if (def.dependsOn.some((d) => !result.has(d))) {
        result.delete(key);
        changed = true;
      }
    }
  }
  return result;
}

/**
 * Tập module ĐANG BẬT của một tổ chức. Dòng thiếu ⇒ theo `moduleDefault` (P7); lõi luôn bật; rồi
 * ĐÓNG dưới phụ thuộc — module bật mà phụ thuộc tắt (dữ liệu hỏng, gõ tay) bị coi là TẮT.
 */
export function resolveEnabledModules(org: Pick<Organization, "moduleDefault">, rows: readonly ModuleRow[]): Set<ModuleKey> {
  return closeUnderDependencies(declaredEnabled(org, rows));
}

export type ModuleDependencyError = { key: ModuleKey; label: string; missing: ModuleKey[]; message: string };

/** Module dữ liệu nói BẬT nhưng bị loại vì phụ thuộc — cho `/platform/health`. */
export function moduleDependencyErrors(org: Pick<Organization, "moduleDefault">, rows: readonly ModuleRow[]): ModuleDependencyError[] {
  const declared = declaredEnabled(org, rows);
  const resolved = closeUnderDependencies(declared);
  const errors: ModuleDependencyError[] = [];
  for (const key of declared) {
    if (resolved.has(key)) continue;
    const def = MODULE_BY_KEY.get(key);
    const missing = (def?.dependsOn ?? []).filter((d) => !resolved.has(d));
    errors.push({ key, label: labelOf(key), missing, message: `«${labelOf(key)}» được khai là bật nhưng đang bị coi là TẮT vì thiếu ${labelsOf(missing)}.` });
  }
  return errors;
}

export type ModuleChangeErrorCode = "CORE_MODULE" | "MISSING_DEPENDENCY" | "HAS_DEPENDENTS" | "REQUIRES_HOME_CREDENTIALS" | "UNKNOWN_MODULE";
export type ModuleChangeResult = { ok: true } | { ok: false; code: ModuleChangeErrorCode; message: string; related: ModuleKey[] };

/**
 * Kiểm một lượt bật/tắt TRƯỚC khi ghi. Chính sách P10: CHẶN + GIẢI THÍCH, không tự bật / tắt dây
 * chuyền. Bật cái đang bật / tắt cái đang tắt ⇒ ok (không làm gì).
 *
 * `opts` mặc định `orgIsHome: false`: gọi thiếu ngữ cảnh thì connector KHÔNG bật được — hỏng về
 * phía hẹp.
 */
export function validateModuleChange(current: ReadonlySet<ModuleKey>, key: string, enable: boolean, opts: { orgIsHome: boolean } = { orgIsHome: false }): ModuleChangeResult {
  const def = moduleDef(key);
  if (!def) return { ok: false, code: "UNKNOWN_MODULE", message: `Không có module mang khoá "${key}" trong sổ module.`, related: [] };

  if (!enable && def.core) return { ok: false, code: "CORE_MODULE", message: `«${def.label}» là module lõi — không tắt được.`, related: [def.key] };
  if (current.has(def.key) === enable) return { ok: true };

  if (enable) {
    if (def.requiresHomeCredentials && !opts.orgIsHome) {
      return { ok: false, code: "REQUIRES_HOME_CREDENTIALS", message: `«${def.label}» dùng thông tin kết nối của tổ chức nhà — ở giai đoạn này chỉ tổ chức nhà bật được.`, related: [def.key] };
    }
    const missing = def.dependsOn.filter((d) => !current.has(d));
    if (missing.length) {
      return { ok: false, code: "MISSING_DEPENDENCY", message: `Cần bật ${labelsOf(missing)} trước khi bật «${def.label}».`, related: missing };
    }
    return { ok: true };
  }

  const dependents = PLATFORM_MODULES.filter((m) => current.has(m.key) && m.dependsOn.includes(def.key)).map((m) => m.key);
  if (dependents.length) {
    return { ok: false, code: "HAS_DEPENDENTS", message: `Không tắt được «${def.label}» vì ${labelsOf(dependents)} đang bật và phụ thuộc vào nó — tắt các module đó trước.`, related: dependents };
  }
  return { ok: true };
}

const FEATURE_BY_KEY: ReadonlyMap<string, { module: ModuleKey; def: FeatureDef }> = new Map(PLATFORM_MODULES.flatMap((m) => m.features.map((f) => [f.key, { module: m.key, def: f }] as const)));

/**
 * Feature bật ⇔ module của nó bật ∧ (ghi đè trong `rows[].features` ?? `defaultEnabled`). Feature
 * lạ ⇒ `false`. Ghi đè không phải boolean (jsonb gõ tay) bị bỏ qua.
 */
export function resolveFeature(featureKey: string, enabledModules: ReadonlySet<ModuleKey>, rows: readonly ModuleRow[]): boolean {
  const entry = FEATURE_BY_KEY.get(featureKey);
  if (!entry || !enabledModules.has(entry.module)) return false;
  const override = rows.find((r) => r.moduleKey === entry.module)?.features?.[featureKey];
  return typeof override === "boolean" ? override : entry.def.defaultEnabled;
}

/** Khoá quyền thuộc module đang tắt — `can()` phải trả `false` cho chúng, kể cả ADMIN (P8). */
export function permissionsOwnedByDisabledModules(enabled: ReadonlySet<ModuleKey>): string[] {
  return PLATFORM_MODULES.filter((m) => !enabled.has(m.key)).flatMap((m) => m.permissions);
}

/** Module tổ chức NHÀ phải đang bật cho `/api/health` nói "khoẻ" — mọi module trừ module `homeOptIn` (0180). */
export const HOME_EXPECTED_MODULES: readonly ModuleKey[] = PLATFORM_MODULES.filter((m) => !m.homeOptIn).map((m) => m.key);
