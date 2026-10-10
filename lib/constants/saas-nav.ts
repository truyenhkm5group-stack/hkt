import type { Permission } from "@/lib/auth/permissions";
import { productsFromModules } from "@/lib/saas/catalog";

/**
 * ═══════════ VỎ APP CỦA KHÁCH CHỐT ĐƠN TỰ ĐỘNG (workspace «Sales Agent») ═══════════
 *
 * Chủ shop chốt 07/10/2026: khách SaaS của Chốt Đơn Tự Động (app.chotdontudong.com) chỉ thấy TÁM mục — Tổng quan · Hội thoại ·
 * AI Sales · Sản phẩm · Kênh kết nối · Nhân viên · Gói dịch vụ · Cài đặt — và KHÔNG thấy menu ERP nội bộ. Ẩn menu chưa đủ: trang
 * ERP mà vỏ này không dùng bị CHẶN Ở MÁY CHỦ (`resolveCurrentUser` · lý do `SHELL_RESTRICTED`), cùng chỗ với cổng module.
 *
 * Tệp THUẦN, client-safe: thanh điều hướng (client), cổng máy chủ và bài kiểm đọc cùng một bản — không có danh sách thứ hai.
 *
 * ─── AI LÀ WORKSPACE «SALES AGENT» — MỘT HÀM, SUY TỪ DỮ LIỆU CÓ SẴN, KHÔNG SO TÊN GÓI ───
 *
 *  1. KHÔNG phải tổ chức nhà (nhà giữ nguyên mọi thứ).
 *  2. `platform_organizations.brand = 'chotdon'` — ghi MỘT lần lúc khách tự đăng ký trên host Chốt Đơn (0215), hoặc người vận
 *     hành đặt tay có lý do + nhật ký. Tổ chức có từ trước 0215 để `NULL` ⇒ KHÔNG đổi gì với họ (không đoán, mục 8.8).
 *  3. Sản phẩm đang dùng theo module (`productsFromModules` — CÙNG luật với backfill thuê bao 0224 và với
 *     `openSubscriptionsForProductsInUse`, nên thuê bao và vỏ không thể nói hai điều) ĐÚNG BẰNG `["chotdon"]`: module độc quyền
 *     của Chốt Đơn (`ai_sales`) bật, và KHÔNG một module độc quyền nào của ERP bật (giao vận, tài chính, quảng cáo, sỉ…). Lõi
 *     thương mại dùng chung (khách · sản phẩm · đơn · kho) không tự nó biến workspace thành khách ERP.
 *
 * Vì sao module mà không đọc thẳng `platform_product_subscriptions`: thuê bao CHỈ THÊM, không bao giờ tự huỷ khi module tắt; còn
 * thứ người dùng THẬT SỰ mở được là module (cổng đường dẫn). Cấp ERP cho một workspace (`provisioning`) bật module độc quyền của
 * ERP ⇒ vế 3 sai ⇒ menu ERP trở lại ngay, không cần cờ thứ hai. Và module đã nằm sẵn trong phiên (`SessionUser.modules`) nên
 * phép quyết định không tốn thêm một câu truy vấn nào ở mỗi lượt dựng.
 *
 * Workspace tự đăng ký trên host Chốt Đơn mà chọn ngành đầy đủ (thời trang, TMĐT…) thì mẫu ngành bật giao vận / tài chính ⇒ là
 * khách ERP ⇒ giữ menu ERP. Đúng ý: họ đã chọn một ERP, không phải chỉ một bot.
 */
export type ShellOrg = { isHome: boolean; brand?: "vnx" | "chotdon" | null } | null | undefined;

export function salesAgentShell(org: ShellOrg, modules: readonly string[] | null | undefined): boolean {
  if (!org || org.isHome) return false;
  if (org.brand !== "chotdon") return false;
  if (!modules) return false;
  const products = productsFromModules(new Set(modules));
  return products.length === 1 && products[0] === "chotdon";
}

/** Dạng người dùng tối thiểu cho mọi hàm dưới đây — cùng hình với `SessionUser` / `NavUserLike`. */
export type ShellUser = { role: string; permissions: readonly string[]; organization?: ShellOrg; modules?: readonly string[] };

export function isSalesAgentUser(user: ShellUser | null | undefined): boolean {
  return Boolean(user && salesAgentShell(user.organization, user.modules));
}

/** Trang «Kênh kết nối». Luồng L4 đang dựng trang kênh hợp nhất — đổi ĐÚNG hằng này khi nó xong. */
// Trang «Kênh kết nối» hợp nhất của luồng L4 (`CHANNELS_ROUTE`, lib/channels/overview-shared.ts) — giá trị đặt thẳng để tệp hằng của
// menu không kéo câu lỗi Messenger vào gói client; tests/saas-shell.test.ts khoá hai hằng bằng nhau.
export const SALES_AGENT_CHANNELS_HREF = "/ai/channels";
/** Hộp thư khách — trang mặc định sau đăng nhập (`/` chuyển về đây). */
export const SALES_AGENT_INBOX_HREF = "/ai/sales-chatbot/inbox";
export const SALES_AGENT_OVERVIEW_HREF = "/ai/overview";
export const SALES_AGENT_SETTINGS_HREF = "/settings/shop";
/** Trang mọi tài khoản đăng nhập đều mở được (chỉ `requireUser`) — đích cuối khi người xem không có mục nào khác. */
export const SALES_AGENT_FALLBACK_HREF = "/settings/profile";

export type SalesAgentNavKey = "overview" | "inbox" | "ai" | "products" | "channels" | "staff" | "plan" | "settings";

export type SalesAgentNavItem = {
  key: SalesAgentNavKey;
  href: string;
  label: string;
  /** Nhãn ngắn cho thanh dưới trên điện thoại. */
  short: string;
  /** Quyền để thấy mục — đúng quyền mà trang đích tự đòi (`requirePermission`), để không có mục dẫn vào trang bị đá ra. */
  permission?: Permission;
  /** Tiền tố đường dẫn KHÁC mà mục này «sở hữu» khi tô sáng (trang phụ không có mục riêng). */
  owns?: readonly string[];
};

/** TÁM MỤC, ĐÚNG THỨ TỰ CHỦ SHOP CHỐT. Thêm / bớt một mục là quyết định của chủ shop, bài kiểm khoá con số 8. */
export const SALES_AGENT_NAV: readonly SalesAgentNavItem[] = [
  { key: "overview", href: SALES_AGENT_OVERVIEW_HREF, label: "Tổng quan", short: "Tổng quan", permission: "ai_sales:view" },
  { key: "inbox", href: SALES_AGENT_INBOX_HREF, label: "Hội thoại", short: "Hội thoại", permission: "ai_sales:view", owns: ["/ai/sales-chatbot/conversations", "/orders", "/customers"] },
  { key: "ai", href: "/ai/sales-chatbot", label: "AI Sales", short: "AI Sales", permission: "ai_sales:view" },
  { key: "products", href: "/products", label: "Sản phẩm", short: "Sản phẩm", permission: "products:view", owns: ["/inventory/receipts"] },
  { key: "channels", href: SALES_AGENT_CHANNELS_HREF, label: "Kênh kết nối", short: "Kênh", permission: "ai_sales:view", owns: ["/settings/connections"] },
  { key: "staff", href: "/settings/users", label: "Nhân viên", short: "Nhân viên", permission: "users:manage" },
  { key: "plan", href: "/settings/plan", label: "Gói dịch vụ", short: "Gói", permission: "settings:manage", owns: ["/billing-locked", "/settings/ai-balance"] },
  { key: "settings", href: SALES_AGENT_SETTINGS_HREF, label: "Cài đặt", short: "Cài đặt", owns: ["/settings/branding", "/settings/notifications", "/settings/profile", "/settings/data-export", "/setup", "/help"] },
];

/** Bốn mục đứng trên thanh dưới của điện thoại; bốn mục còn lại nằm trong ngăn «Thêm». Hộp thư đứng đầu (mặc định). */
export const SALES_AGENT_MOBILE_PRIMARY: readonly SalesAgentNavKey[] = ["inbox", "overview", "ai", "products"];

function hasPerm(user: ShellUser, permission: Permission | undefined): boolean {
  if (!permission) return true;
  return user.role === "ADMIN" || user.permissions.includes(permission);
}

/**
 * Mục người này thấy. Luật quyền KHÔNG viết lại ở đây (AGENTS mục 28): đây chỉ là lọc «mục có dẫn vào trang người này mở được
 * không» bằng đúng khoá trang đích tự đòi; cổng thật vẫn là `requirePermission` của trang + cổng vỏ ở máy chủ.
 */
export function salesAgentNavFor(user: ShellUser): SalesAgentNavItem[] {
  return SALES_AGENT_NAV.filter((item) => hasPerm(user, item.permission));
}

/**
 * Trang về nhà của người này trong vỏ: hộp thư nếu mở được, rồi mục đầu tiên còn thấy, cuối cùng là trang tài khoản (chỉ cần
 * đăng nhập). Không bao giờ trả một trang mà người này sẽ bị `requirePermission` đá về `/` — đá về `/` thì `/` lại chuyển về
 * đây, và đó là vòng lặp chuyển hướng.
 *
 * `setupOpen` — CỬA HÀNG CHƯA THIẾT LẬP XONG (chủ shop 10/10/2026: «khách low-tech sau đăng nhập phải thấy đúng một danh sách
 * thiết lập»): trang nhà là «Tổng quan», nơi đứng danh sách chín bước (lib/onboarding/go-live-shared.ts). Xong đủ chín bước ⇒ hộp
 * thư như #638. Hàm vẫn THUẦN: câu hỏi «đã xong chưa» do máy chủ trả lời (`shellLandingFor`, lib/saas/shell-setup.ts) và chỉ hỏi ở
 * hai cửa vào — sau đăng nhập và khi mở `/`; mọi lời gọi khác (đích từ chối quyền, thương hiệu trên thanh vỏ) giữ hộp thư.
 * Người không thấy «Tổng quan» (thiếu quyền) ⇒ y như cũ.
 */
export function salesAgentHomeFor(user: ShellUser, opts: { setupOpen?: boolean } = {}): string {
  const items = salesAgentNavFor(user);
  if (opts.setupOpen) {
    const overview = items.find((i) => i.key === "overview");
    if (overview) return overview.href;
  }
  return items.find((i) => i.key === "inbox")?.href ?? items[0]?.href ?? SALES_AGENT_FALLBACK_HREF;
}

/**
 * ═══ TRANG VỎ ĐƯỢC MỞ — DANH SÁCH CHO PHÉP, KHÔNG PHẢI DANH SÁCH CẤM ═══
 *
 * Cấm từng trang ERP là một danh sách luôn thiếu: mỗi trang ERP mới mặc định LỌT vào app của khách. Nên đảo lại: chỉ những tiền
 * tố dưới đây mở được, mọi trang khác chuyển về trang nhà của vỏ. Khớp theo RANH GIỚI ĐOẠN, tiền tố dài nhất thắng; `DENY` thắng
 * `ALLOW` khi dài hơn (vd `/orders` mở, `/orders/verify` không).
 *
 * QUYẾT ĐỊNH ĐƠN / KHÁCH / KHO:
 *  · `/orders` (danh sách, chi tiết, sửa, tạo) và `/customers` (danh sách, hồ sơ) MỞ nhưng KHÔNG có mục menu — chúng là trang phụ
 *    của «Hội thoại»: hộp thư dẫn thẳng tới đơn AI vừa chốt (`/orders/<id>`), tới chỗ sửa đơn nháp bot lên sai
 *    (`/orders/<id>/edit`) và tới hồ sơ khách. Chặn chúng là cắt đúng đường chủ shop dùng để kiểm đơn AI tạo ra. Công cụ ERP
 *    quanh đơn (xác minh, nhãn vận chuyển, tự giao, tuyến giao) và quanh khách (công nợ, nhắc mua lại, giữ chân) vẫn CHẶN.
 *  · Tồn kho: khách TỰ khai sản phẩm, giá, size, màu VÀ tồn (chủ shop chốt 07/10/2026) — nên mở ĐÚNG MỘT trang của sổ kho,
 *    `/inventory/receipts` (Nhập hàng · Kiểm kê · Tái nhập hàng hoàn, trang con của «Sản phẩm»). Đường ít mã nhất và không có
 *    luật thứ hai: trang ấy gọi đúng server action phiếu kho (`createStockReceipt`), tồn vẫn = tổng phiếu kho − đã xuất
 *    (AGENTS §3.10), «Kiểm kê» ghi phiếu ADJUSTMENT theo SỐ ĐẾM chứ không ghi thẳng con số tồn. Phần còn lại của `/inventory`
 *    (sổ kho tổng, đóng gói, mua hàng, sản xuất, quyết định nhập/xả, hàng hoàn chờ nhận) CHẶN — nghiệp vụ ERP.
 *  · Trong `/products`: hiệu quả theo mã (tỷ lệ giao thành công ERP), bảng giá sỉ và hàng giữ chỗ là công cụ ERP — CHẶN.
 *  · Trong `/settings`: chỉ người dùng, gói, tài khoản, thương hiệu, thông báo nhóm, kết nối, xuất dữ liệu và trang Cài đặt gọn.
 *    Bộ dựng (data-model, objects, forms, lists, statuses, workflows, pages, ai-builder, advanced, templates, modules) CHẶN.
 *
 * Chỉ áp cho TRANG. `/api/*` không đi qua cổng này: mỗi API đã tự gác bằng quyền + module, và các trang được mở gọi API của chúng
 * (sự kiện thời gian thực, chuông, tải ảnh) — chặn API ở đây là làm hỏng chính tám trang của vỏ.
 */
export const SALES_AGENT_ALLOWED_PREFIXES: readonly string[] = [
  "/ai",
  "/products",
  "/inventory/receipts",
  "/orders",
  "/customers",
  "/settings/users",
  "/settings/plan",
  // Số dư AI (0235): trang con của «Gói dịch vụ» — tiền trả trước cho khách AI vượt phần gói gồm (cờ canary ai_balance.enabled).
  "/settings/ai-balance",
  "/settings/profile",
  "/settings/branding",
  "/settings/notifications",
  "/settings/connections",
  "/settings/data-export",
  "/settings/shop",
  "/setup",
  "/help",
  "/module-disabled",
  "/billing-locked",
];

export const SALES_AGENT_DENIED_PREFIXES: readonly string[] = [
  "/orders/verify",
  "/orders/carrier-labels",
  "/orders/self-delivery",
  "/orders/shipping-routes",
  "/customers/receivables",
  "/customers/reorder",
  "/customers/retention",
  "/products/performance",
  "/products/price-lists",
  "/products/reserved",
];

function underPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

/** Đường dẫn TRANG này có mở được trong vỏ Sales Agent không. Đường không phải trang (`/api/*`) ⇒ `true` (xem trên). */
export function salesAgentPathAllowed(rawPath: string): boolean {
  const path = (rawPath.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  if (path === "/api" || path.startsWith("/api/")) return true;
  const allow = SALES_AGENT_ALLOWED_PREFIXES.filter((p) => underPrefix(path, p)).sort((a, b) => b.length - a.length)[0];
  if (!allow) return false;
  const deny = SALES_AGENT_DENIED_PREFIXES.filter((p) => underPrefix(path, p)).sort((a, b) => b.length - a.length)[0];
  return !deny || deny.length < allow.length;
}

/**
 * Một liên kết có nên VẼ cho người này không — ĐÚNG phép quyết định của cổng máy chủ (`salesAgentPathAllowed`), không danh sách
 * thứ hai. Ngoài vỏ ⇒ luôn `true` (menu ERP y như cũ). Trang dùng chung với ERP gọi hàm này quanh mọi link trỏ vào route mà vỏ
 * chặn: một nút dẫn tới trang sẽ bị chuyển về hộp thư là lối cụt.
 */
export function shellAllows(user: ShellUser | null | undefined, href: string): boolean {
  return !isSalesAgentUser(user) || salesAgentPathAllowed(href);
}

/**
 * DẤU HIỆU TRÊN HTML THẬT — cho phép đo đọc trang qua HTTP (ops `saas-acceptance` bước C, lib/saas/acceptance.ts):
 *  · vỏ app Chốt Đơn đã dựng ⇔ `components/saas-shell.tsx` vẽ thuộc tính này ở khung ngoài cùng;
 *  · khung ERP NỘI BỘ lọt vào ⇔ một trong các dấu của thanh trên ERP (`components/app-topnav.tsx` — nhãn thương hiệu VNXcommerce,
 *    nút AI Copilot của `components/ai-copilot.tsx`). Trang của vỏ KHÔNG BAO GIỜ được mang dấu nào trong số đó.
 * tests/saas-shell.test.ts khoá các tệp ấy còn mang ĐÚNG những dấu này — đổi một bên mà quên bên kia là đỏ, phép đo không mù im lặng.
 */
export const SALES_AGENT_SHELL_HTML_MARKER = 'data-shell="sales-agent"';
export const ERP_FRAME_HTML_MARKERS: readonly string[] = ['aria-label="VNXcommerce', 'aria-label="Mở AI Copilot"'];

/** Tham số trên trang nhà khi máy chủ vừa chuyển người dùng khỏi một trang ngoài vỏ — vỏ in một câu ngắn thay vì im lặng. */
export const SHELL_BLOCKED_PARAM = "ngoai-goi";
export const SHELL_BLOCKED_MESSAGE = "Trang này không có trong gói Chốt Đơn — đã đưa bạn về đây.";

/**
 * Đích chuyển hướng khi cổng vỏ chặn `path`: trang nhà của người này, kèm `?ngoai-goi=1` để vỏ nói ra vì sao. `/` là cửa vào
 * mặc định (sau đăng nhập, bấm thương hiệu) nên KHÔNG kèm câu — không có gì bị từ chối ở đó.
 */
export function salesAgentRedirectFor(user: ShellUser, rawPath: string): string {
  const home = salesAgentHomeFor(user);
  const path = (rawPath.split(/[?#]/)[0] || "/").replace(/\/+$/, "") || "/";
  return path === "/" ? home : `${home}?${SHELL_BLOCKED_PARAM}=1`;
}

/**
 * Ngược ĐÚNG của `salesAgentRedirectFor`: bỏ dấu «ngoài gói» để còn lại trang nhà (`salesAgentHomeFor`). Dùng khi lượt gọi bị
 * cổng vỏ gặp KHÔNG phải một trang bị từ chối — lượt POST đăng nhập / đăng ký tới `/login` · `/start` (lib/saas/shell-landing.ts):
 * in «Trang này không có trong gói» ngay sau khi vừa đăng nhập là nói sai. `salesAgentHomeFor` không bao giờ trả chuỗi có query.
 */
export function salesAgentHomeOfRedirect(target: string): string {
  const marker = `?${SHELL_BLOCKED_PARAM}=1`;
  return target.endsWith(marker) ? target.slice(0, -marker.length) : target;
}

/**
 * Tham số «không có quyền» trên trang nhà — CÙNG tên với `/?forbidden=1` mà cổng quyền của ERP dùng từ trước. Vỏ in câu RIÊNG
 * cho nó: «ngoài gói» (trang không có trong Chốt Đơn) và «không có quyền» (có trong gói nhưng người này chưa được cấp) đưa người
 * đọc tới hai việc khác nhau — gộp làm một là bảo họ đi tìm nhầm chỗ.
 */
export const FORBIDDEN_PARAM = "forbidden";
export const SHELL_FORBIDDEN_MESSAGE = "Bạn không có quyền mở trang hoặc làm thao tác vừa rồi — đã đưa bạn về đây. Cần quyền này thì nhờ chủ cửa hàng cấp.";
/**
 * Câu RIÊNG cho chủ shop (ADMIN). ADMIN có mọi khoá, nên khi cổng quyền vẫn từ chối thì lý do là khoá ấy thuộc một chức năng
 * NGOÀI GÓI / chưa bật cho cửa hàng (cổng module trong `can()`) — bảo chủ shop «nhờ chủ cửa hàng cấp» là bảo họ đi tìm chính mình.
 */
export const SHELL_FORBIDDEN_OWNER_MESSAGE = "Trang hoặc thao tác vừa rồi chưa có trong gói hiện tại của cửa hàng — đã đưa bạn về đây. Xem và nâng gói ở mục «Gói dịch vụ».";

/**
 * ═══ ĐÍCH KHI CỔNG QUYỀN TỪ CHỐI — `requirePermission` · `requireUser(roles)` (và `requireResource`, đi qua `requirePermission`) ═══
 *
 * Chỉ đổi ĐÍCH, không đổi luật: có quyền hay không vẫn do `can()` quyết (AGENTS luật 28). ERP / nhà: `/?forbidden=1` y như
 * trước. Người thuộc vỏ: `/` là trang mà CHÍNH layout `(dashboard)` chặn (SHELL_RESTRICTED). Một server action bị từ chối ⇒ máy
 * chủ dựng `/` TỪ GỐC, layout ném `redirect(trang nhà)`, client giữ nút layout mang lỗi rồi `router.replace` hàng nghìn lần —
 * trang trắng (cơ chế ở lib/saas/shell-landing.ts; đo 08/10/2026: 6.092–6.362 lần điều hướng trong 15 giây). Nên người vỏ về THẲNG
 * trang nhà của vỏ: `salesAgentHomeFor` không bao giờ trả trang người đó bị đá ra, và cổng vỏ luôn cho nó đi qua — layout không
 * chuyển hướng lần hai. Chuỗi chỉ ghép từ hằng (href của menu vỏ), không đầu vào nào của người dùng ⇒ không open redirect.
 */
export function forbiddenRedirectFor(user: ShellUser): string {
  return `${isSalesAgentUser(user) ? salesAgentHomeFor(user) : "/"}?${FORBIDDEN_PARAM}=1`;
}

/** Câu vỏ in khi máy chủ vừa đưa người dùng về trang nhà. `kind` = tham số đã kích hoạt nó. */
export type ShellNotice = { kind: typeof SHELL_BLOCKED_PARAM | typeof FORBIDDEN_PARAM; text: string };

/**
 * THUẦN: đọc tham số qua `param` (thanh vỏ đưa `useSearchParams().get`, bài kiểm đưa `URLSearchParams.get`) — một bản cho cả hai.
 * `viewer` chỉ chọn CÂU (chủ shop ⇒ câu «ngoài gói»), không đổi luật nào.
 */
export function shellNoticeOf(param: (name: string) => string | null | undefined, viewer?: { role: string } | null): ShellNotice | null {
  if (param(SHELL_BLOCKED_PARAM) === "1") return { kind: SHELL_BLOCKED_PARAM, text: SHELL_BLOCKED_MESSAGE };
  if (param(FORBIDDEN_PARAM) === "1") return { kind: FORBIDDEN_PARAM, text: viewer?.role === "ADMIN" ? SHELL_FORBIDDEN_OWNER_MESSAGE : SHELL_FORBIDDEN_MESSAGE };
  return null;
}

/**
 * Chiều cao một khung «lấp đầy màn hình» (hộp thư) trong vỏ: phần nhìn thấy của viewport trừ mép trên của khung, trừ thanh dưới
 * (đã gồm vùng an toàn iPhone vì nó mang `padding-bottom: env(safe-area-inset-bottom)`), trừ khe thở. Thuần để kiểm được; khung
 * client đo ba số này rồi gọi hàm. Không bao giờ thấp hơn `min` — màn quá thấp thì cuộn trang, không bóp ô soạn tin về 0.
 */
export function shellFitHeight(input: { viewport: number; top: number; bottomNav: number; gap?: number; min?: number }): number {
  const gap = input.gap ?? 8;
  const min = input.min ?? 280;
  return Math.max(min, Math.floor(input.viewport - input.top - input.bottomNav - gap));
}

/** Mục tô sáng cho trang hiện tại: href / `owns` khớp dài nhất, trong đúng các mục người này thấy. */
export function salesAgentActiveKey(pathname: string, items: readonly SalesAgentNavItem[]): SalesAgentNavKey | undefined {
  let best: { key: SalesAgentNavKey; len: number } | undefined;
  for (const item of items) {
    for (const prefix of [item.href, ...(item.owns ?? [])]) {
      if (underPrefix(pathname, prefix) && (!best || prefix.length > best.len)) best = { key: item.key, len: prefix.length };
    }
  }
  return best?.key;
}
