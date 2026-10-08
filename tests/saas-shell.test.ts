/**
 * ═══════════ VỎ APP CỦA KHÁCH CHỐT ĐƠN TỰ ĐỘNG (lib/constants/saas-nav.ts) ═══════════
 *
 * Chủ shop chốt 07/10/2026: workspace khách SaaS «Sales Agent» chỉ thấy TÁM mục, không thấy menu ERP, `/` về hộp thư, dùng tốt
 * trên điện thoại, và trang ERP nội bộ bị CHẶN Ở MÁY CHỦ (không chỉ giấu link). Bài này khoá:
 *
 *  1. THUẦN — ai là workspace Sales Agent (nhà / thương hiệu khác / thuê ERP / thiếu ai_sales ⇒ KHÔNG); đúng 8 mục, đúng thứ tự,
 *     không mục ERP; trang nhà không bao giờ là trang người đó bị đá ra (vòng lặp chuyển hướng); danh sách cho phép / cấm.
 *  2. QUÉT TRANG — mọi trang mở được trong vỏ thuộc một module của Chốt Đơn hoặc lõi dùng chung, KHÔNG BAO GIỜ một module độc
 *     quyền của ERP; mỗi mục dẫn tới một `page.tsx` có thật và đòi đúng khoá quyền mục khai.
 *  3. TRƯỚC / SAU — workspace ERP và nhà: thương hiệu không đổi menu ERP; menu ERP vẫn vẽ bằng `AppTopNav` như cũ.
 *  4. MÁY CHỦ (tổ chức thật trên PGlite, mã `sa-`): route nội bộ ⇒ `SHELL_RESTRICTED` + `requireUser` chuyển về hộp thư; `/` ⇒
 *     hộp thư; trang của vỏ + API ⇒ đi qua; bật một module ERP ⇒ hết vỏ ngay; nhà không đổi.
 *  5. MOBILE — hợp đồng mã nguồn của vỏ: thanh dưới chỉ ở màn hẹp, ô bấm ≥ 44px, `<main>` không tràn ngang.
 *
 * Tự dọn: tổ chức `sa-shell` lưu trữ + xoá thư mục CSDL trong `finally`.
 */
import { CHANNELS_ROUTE } from "@/lib/channels/overview-shared";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { visibleGroups } from "@/components/app-sidebar";
import { ALL_PERMISSIONS } from "@/lib/auth/permissions";
import { requireUser, resolveCurrentUser, setRequestPathSourceForTests, signSession } from "@/lib/auth/session";
import { moduleOfPath } from "@/lib/constants/platform-modules";
import {
  ERP_FRAME_HTML_MARKERS,
  isSalesAgentUser,
  SALES_AGENT_ALLOWED_PREFIXES,
  SALES_AGENT_CHANNELS_HREF,
  SALES_AGENT_FALLBACK_HREF,
  SALES_AGENT_INBOX_HREF,
  SALES_AGENT_MOBILE_PRIMARY,
  SALES_AGENT_NAV,
  SALES_AGENT_SHELL_HTML_MARKER,
  salesAgentActiveKey,
  salesAgentHomeFor,
  salesAgentNavFor,
  salesAgentPathAllowed,
  salesAgentRedirectFor,
  salesAgentShell,
  SHELL_BLOCKED_PARAM,
  shellAllows,
  shellFitHeight,
} from "@/lib/constants/saas-nav";
import { DENY_REASON_MESSAGE, DENY_REASON_PARAM, loginShouldStay } from "@/lib/constants/session-revocation";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { PRODUCTS, SHARED_COMMERCE_CORE } from "@/lib/saas/catalog";

const goc = path.resolve(__dirname, "..");
const ORG = "sa-shell";
const HOME_ADMIN_ID = "sa-home-admin";
/** Đúng bộ module của mẫu «Chỉ cần AI bán hàng» (lib/blueprints/templates/ai-sales.ts). */
const AI_SALES_MODULES = ["core", "work", "customers", "products", "orders", "inventory", "ai_sales"];
const EIGHT = ["Tổng quan", "Hội thoại", "AI Sales", "Sản phẩm", "Kênh kết nối", "Nhân viên", "Gói dịch vụ", "Cài đặt"];
/** Route nội bộ chủ shop nêu tên + bộ dựng của /settings + kho — phải bị chặn. */
const BLOCKED = [
  "/",
  "/cockpit",
  "/work",
  "/departments",
  "/data-quality",
  "/audit",
  "/approvals",
  "/alerts",
  "/settings",
  "/settings/data-model",
  "/settings/objects",
  "/settings/workflows",
  "/settings/pages",
  "/settings/pages/abc/builder",
  "/settings/ai-builder",
  "/settings/advanced",
  "/settings/modules",
  "/settings/templates",
  "/settings/forms",
  "/inventory",
  "/inventory/packing",
  "/inventory/returns",
  "/inventory/planning",
  "/inventory/decisions",
  "/orders/verify",
  "/orders/carrier-labels",
  "/customers/receivables",
  "/products/price-lists",
  "/my-payslip",
  "/p/trang-tuy-bien",
  "/o/doi-tuong",
  "/shipments",
  "/reports/returns",
  "/platform",
  "/aix", // ranh giới đoạn: `/ai` mở không có nghĩa `/aix` mở
];
const ALLOWED = [
  "/ai/overview",
  "/ai/sales-chatbot",
  "/ai/sales-chatbot/inbox",
  "/ai/sales-chatbot/conversations/abc",
  "/ai/sales-chatbot/messenger",
  "/products",
  "/products/123",
  "/inventory/receipts",
  "/inventory/receipts?receipt=abc",
  "/orders",
  "/orders/9007199254740993",
  "/orders/123/edit",
  "/customers/abc",
  "/settings/users",
  "/settings/plan",
  "/settings/shop",
  "/settings/profile",
  "/settings/branding",
  "/setup",
  "/help",
  "/module-disabled",
  "/api/events",
  "/api/notifications",
  "/ai/sales-chatbot/inbox?f=NEEDS_HUMAN",
];

const rel = (abs: string) => path.relative(goc, abs).split(path.sep).join("/");

/** Mọi `page.tsx` dưới `app/(dashboard)` ⇒ URL (bỏ nhóm `(…)`, giữ `[id]` dạng mẫu). */
function dashboardPages(): { url: string; file: string }[] {
  const root = path.join(goc, "app", "(dashboard)");
  const out: { url: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === "page.tsx") {
        const segs = path.relative(root, dir).split(path.sep).filter((s) => s && !/^\(.*\)$/.test(s));
        out.push({ url: `/${segs.join("/")}`, file: rel(full) });
      }
    }
  };
  walk(root);
  return out;
}

function pageFileOf(href: string): string {
  return path.join(goc, "app", "(dashboard)", ...href.split("/").filter(Boolean), "page.tsx");
}

/* ═════════════ 1 · THUẦN ═════════════ */
function kiemThuan() {
  const khach = { isHome: false, brand: "chotdon" as const };
  assert.equal(salesAgentShell(khach, AI_SALES_MODULES), true, "khách Chốt Đơn chỉ AI bán hàng ⇒ vỏ Sales Agent");
  assert.equal(salesAgentShell(khach, ["ai_sales", "customers", "products", "orders", "inventory"]), true, "không cần liệt kê lõi — luật đọc sản phẩm theo module");
  assert.equal(salesAgentShell({ isHome: true, brand: "chotdon" }, AI_SALES_MODULES), false, "nhà KHÔNG BAO GIỜ mang vỏ");
  assert.equal(salesAgentShell({ isHome: false, brand: null }, AI_SALES_MODULES), false, "thương hiệu chưa theo dõi (tổ chức trước 0215) ⇒ giữ menu cũ");
  assert.equal(salesAgentShell({ isHome: false }, AI_SALES_MODULES), false, "không có trường thương hiệu ⇒ giữ menu cũ");
  assert.equal(salesAgentShell({ isHome: false, brand: "vnx" }, AI_SALES_MODULES), false, "khách đăng ký ở VNXcommerce ⇒ giữ menu cũ");
  assert.equal(salesAgentShell(khach, [...AI_SALES_MODULES, "logistics"]), false, "bật một module độc quyền ERP (giao vận) ⇒ là khách ERP ⇒ menu ERP");
  // HSLC-giống: săn khách sỉ + quảng cáo Meta — dù ai đó đặt thương hiệu chotdon, họ vẫn đang dùng ERP.
  assert.equal(salesAgentShell(khach, [...AI_SALES_MODULES, "wholesale_leads", "marketing"]), false, "workspace dùng nghiệp vụ ERP giữ menu ERP");
  assert.equal(salesAgentShell(khach, SHARED_COMMERCE_CORE), false, "chỉ lõi thương mại, chưa bật AI bán hàng ⇒ không phải khách Chốt Đơn");
  assert.equal(salesAgentShell(khach, undefined), false, "không có tập module (người dựng tay) ⇒ hỏng về phía cũ");
  assert.equal(salesAgentShell(null, AI_SALES_MODULES), false);
  // Mọi module độc quyền ERP, từng cái một, đều đưa workspace về menu ERP.
  const erpOnly = PRODUCTS.find((p) => p.key === "erp")!.exclusiveModules;
  assert.ok(erpOnly.length > 10, "đọc hụt danh mục ERP");
  for (const m of erpOnly) assert.equal(salesAgentShell(khach, [...AI_SALES_MODULES, m]), false, `module ERP ${m} bật ⇒ menu ERP`);

  // ── 8 mục, đúng thứ tự, đúng nhãn ──
  const admin = { role: "ADMIN", permissions: [] as string[], organization: khach, modules: AI_SALES_MODULES };
  const items = salesAgentNavFor(admin);
  assert.deepEqual(
    items.map((i) => i.label),
    EIGHT,
    "chủ shop (ADMIN) thấy ĐÚNG tám mục, đúng thứ tự",
  );
  assert.equal(new Set(SALES_AGENT_NAV.map((i) => i.href)).size, 8, "tám mục, tám trang khác nhau");
  assert.equal(SALES_AGENT_NAV.find((i) => i.key === "channels")?.href, SALES_AGENT_CHANNELS_HREF, "Kênh kết nối đi qua MỘT hằng (L4 đổi đúng chỗ đó)");
  assert.equal(SALES_AGENT_CHANNELS_HREF, CHANNELS_ROUTE, "mục «Kênh kết nối» của vỏ khách trỏ đúng trang kênh hợp nhất của L4");
  assert.equal(SALES_AGENT_NAV.find((i) => i.key === "inbox")?.href, SALES_AGENT_INBOX_HREF);
  for (const it of SALES_AGENT_NAV) {
    assert.ok(salesAgentPathAllowed(it.href), `mục ${it.label} (${it.href}) phải mở được trong vỏ — mục dẫn vào trang bị chặn là lối cụt`);
    for (const o of it.owns ?? []) assert.ok(salesAgentPathAllowed(o), `${it.label} sở hữu ${o} nhưng ${o} bị chặn`);
    if (it.permission) assert.ok((ALL_PERMISSIONS as string[]).includes(it.permission), `${it.permission} là khoá có thật`);
  }
  assert.deepEqual(SALES_AGENT_MOBILE_PRIMARY.length, 4, "thanh dưới: bốn mục + «Thêm»");
  assert.equal(SALES_AGENT_MOBILE_PRIMARY[0], "inbox", "hộp thư đứng đầu thanh dưới (trang mặc định)");

  // ── Trang nhà: hộp thư; không quyền thì lùi, KHÔNG BAO GIỜ vào trang sẽ đá về `/` ──
  assert.equal(salesAgentHomeFor(admin), SALES_AGENT_INBOX_HREF, "sau đăng nhập ưu tiên hộp thư");
  const sale = { role: "VIEWER", permissions: ["ai_sales:view", "products:view", "orders:read"], organization: khach, modules: AI_SALES_MODULES };
  assert.deepEqual(
    salesAgentNavFor(sale).map((i) => i.key),
    ["overview", "inbox", "ai", "products", "channels", "settings"],
    "nhân viên bán hàng không thấy Nhân viên / Gói (không có khoá trang đích đòi)",
  );
  assert.equal(salesAgentHomeFor(sale), SALES_AGENT_INBOX_HREF);
  const kho = { role: "VIEWER", permissions: ["products:view"], organization: khach, modules: AI_SALES_MODULES };
  assert.equal(salesAgentHomeFor(kho), "/products", "không đọc được hộp thư ⇒ mục đầu tiên còn thấy");
  const trang = { role: "VIEWER", permissions: [] as string[], organization: khach, modules: AI_SALES_MODULES };
  assert.equal(salesAgentHomeFor(trang), "/settings/shop", "không quyền gì ⇒ Cài đặt (trang chỉ đòi đăng nhập)");
  assert.ok(salesAgentPathAllowed(SALES_AGENT_FALLBACK_HREF), "trang lùi cuối cùng phải mở được, nếu không là vòng lặp");
  assert.ok(!salesAgentPathAllowed("/"), "`/` không thuộc vỏ ⇒ máy chủ chuyển về trang nhà");

  // ── Cho phép / cấm ──
  for (const p of BLOCKED) assert.equal(salesAgentPathAllowed(p), false, `${p} phải bị CHẶN trong vỏ Sales Agent`);
  for (const p of ALLOWED) assert.equal(salesAgentPathAllowed(p), true, `${p} phải mở được trong vỏ Sales Agent`);
  assert.equal(salesAgentPathAllowed("/orders/"), true, "dấu / cuối không đổi kết luận");

  // ── Tô sáng ──
  const all = salesAgentNavFor(admin);
  assert.equal(salesAgentActiveKey("/orders/123", all), "inbox", "đơn là trang phụ của Hội thoại");
  assert.equal(salesAgentActiveKey("/customers/abc", all), "inbox");
  assert.equal(salesAgentActiveKey("/ai/sales-chatbot/inbox", all), "inbox");
  assert.equal(salesAgentActiveKey("/ai/sales-chatbot/performance", all), "ai", "khớp dài nhất: trang con của AI Sales");
  assert.equal(salesAgentActiveKey(SALES_AGENT_CHANNELS_HREF, all), "channels");
  assert.equal(salesAgentActiveKey("/settings/branding", all), "settings");
  assert.equal(salesAgentActiveKey("/ai/overview", all), "overview");
  assert.equal(salesAgentActiveKey("/products/123", all), "products");
  assert.equal(salesAgentActiveKey("/inventory/receipts", all), "products", "phiếu kho là trang con của Sản phẩm");

  // ── shellAllows: CÙNG phép quyết định với cổng máy chủ; ngoài vỏ luôn vẽ ──
  const erpAdmin = { ...admin, organization: { isHome: false, brand: null } };
  for (const p of [...BLOCKED, ...ALLOWED]) {
    assert.equal(shellAllows(admin, p), salesAgentPathAllowed(p), `shellAllows(${p}) phải nói đúng điều cổng máy chủ nói`);
    assert.equal(shellAllows(erpAdmin, p), true, `ngoài vỏ: link ${p} vẽ như cũ`);
  }
  assert.equal(shellAllows(null, "/inventory/planning"), true);

  // ── Chuyển hướng: `/` im lặng về hộp thư; trang bị chặn kèm câu «không có trong gói» ──
  assert.equal(salesAgentRedirectFor(admin, "/"), SALES_AGENT_INBOX_HREF, "`/` là cửa vào mặc định — không kèm câu từ chối");
  assert.equal(salesAgentRedirectFor(admin, "/cockpit"), `${SALES_AGENT_INBOX_HREF}?${SHELL_BLOCKED_PARAM}=1`);
  assert.equal(salesAgentRedirectFor(trang, "/work"), `/settings/shop?${SHELL_BLOCKED_PARAM}=1`, "người không đọc được hộp thư: về Cài đặt, vẫn có câu");

  // ── Chiều cao khung hộp thư trong vỏ: ô soạn tin không bao giờ nằm dưới thanh dưới ──
  // iPhone 14 (390×844): mép trên khung ~190px, thanh dưới 64 + vùng an toàn 34 = 98px.
  const h390 = shellFitHeight({ viewport: 844, top: 190, bottomNav: 98 });
  assert.ok(190 + h390 + 98 <= 844, `390×844: khung (${h390}px) + thanh dưới phải vừa màn hình`);
  const h375 = shellFitHeight({ viewport: 667, top: 170, bottomNav: 64 });
  assert.ok(170 + h375 + 64 <= 667, `375×667: khung (${h375}px) + thanh dưới phải vừa màn hình`);
  assert.equal(shellFitHeight({ viewport: 400, top: 200, bottomNav: 98 }), 280, "màn quá thấp ⇒ giữ tối thiểu, cuộn trang thay vì bóp khung về 0");
  assert.equal(shellFitHeight({ viewport: 900, top: 100, bottomNav: 0, gap: 0 }), 800, "màn rộng không có thanh dưới");
}

/* ═════════════ 2 · QUÉT TRANG ═════════════ */
function kiemTrang() {
  const pages = dashboardPages();
  assert.ok(pages.length > 100, `đọc hụt app/(dashboard) (${pages.length} trang)`);
  const chotdonModules = new Set<string>([...SHARED_COMMERCE_CORE, ...PRODUCTS.find((p) => p.key === "chotdon")!.exclusiveModules]);
  const open = pages.filter((p) => salesAgentPathAllowed(p.url));
  assert.ok(open.length >= 20, `vỏ mở quá ít trang (${open.length}) — danh sách cho phép bị cắt?`);
  for (const p of open) {
    const m = moduleOfPath(p.url);
    assert.ok(m === null || chotdonModules.has(m), `${p.file} mở trong vỏ nhưng thuộc module ERP «${m}» — khách Chốt Đơn không thuê ERP`);
  }
  // Mỗi tiền tố cho phép phải trỏ tới ít nhất một trang có thật (tiền tố mồ côi là chỗ hổng chờ trang ERP mới lọt vào).
  for (const prefix of SALES_AGENT_ALLOWED_PREFIXES) assert.ok(pages.some((p) => p.url === prefix || p.url.startsWith(`${prefix}/`)), `tiền tố cho phép ${prefix} không có trang nào`);
  // Mỗi mục: trang có thật + đòi đúng khoá mục khai (mục không khoá ⇒ trang chỉ `requireUser`).
  for (const it of SALES_AGENT_NAV) {
    const f = pageFileOf(it.href);
    assert.ok(existsSync(f), `mục ${it.label} trỏ tới trang không tồn tại: ${rel(f)}`);
    const src = readFileSync(f, "utf8");
    if (it.permission) assert.ok(src.includes(`"${it.permission}"`) || /PUBLISH_PERMISSION|CONNECTIONS_PERMISSION/.test(src), `${rel(f)} phải đòi đúng "${it.permission}" như mục ${it.label} khai`);
    else assert.match(src, /requireUser\(\)/, `${rel(f)}: mục không khai khoá ⇒ trang chỉ được đòi đăng nhập`);
  }
  // LỐI CỤT: trang mở được trong vỏ không được vẽ link vào route vỏ chặn, trừ khi bọc trong `shellAllows(…)` (CÙNG hàm với
  // cổng máy chủ — không danh sách thứ hai). `/` không phải lối cụt: máy chủ đưa về trang nhà.
  const loiCut: string[] = [];
  for (const pg of open) {
    const dir = path.dirname(path.join(goc, pg.file));
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
      const src = readFileSync(path.join(dir, f), "utf8");
      const boc = [...src.matchAll(/shellAllows\([^,()]+,\s*"([^"]+)"\)/g)].map((m) => m[1]);
      for (const m of src.matchAll(/href(?:=\{?|:\s*)["`](\/[^"`?#$]*)/g)) {
        const p = m[1].replace(/\/$/, "") || "/";
        if (p === "/" || salesAgentPathAllowed(p) || salesAgentPathAllowed(`${p}/x`)) continue;
        if (!boc.some((l) => p === l || p.startsWith(`${l}/`))) loiCut.push(`${pg.url} (${f}): ${m[1]}`);
      }
    }
  }
  assert.deepEqual(loiCut, [], `link trỏ vào route vỏ chặn mà không bọc shellAllows — với khách Chốt Đơn đó là lối cụt: ${loiCut.join(" · ")}`);

  // TỒN KHO: khách tự nhập / điều chỉnh tồn qua ĐÚNG trang phiếu kho có sẵn, gọi ĐÚNG server action phiếu kho — không luật thứ hai.
  assert.ok(salesAgentPathAllowed("/inventory/receipts") && !salesAgentPathAllowed("/inventory"), "mở đúng trang phiếu kho, sổ kho tổng vẫn chặn");
  const dialog = readFileSync(path.join(goc, "app", "(dashboard)", "inventory", "receipts", "receipt-dialog.tsx"), "utf8");
  assert.match(dialog, /import \{ createStockReceipt \} from "@\/lib\/actions\/stock"/, "phiếu kho đi qua createStockReceipt (tồn = tổng phiếu kho − đã xuất, AGENTS §3.10)");
  assert.equal(moduleOfPath("/inventory/receipts"), "inventory", "trang phiếu kho thuộc lõi thương mại dùng chung, không phải module ERP độc quyền");

  // HỘP THƯ trong vỏ: khung tự đo theo thanh dưới (đã gồm safe-area) thay vì `100dvh - 13.5rem` canh cho thanh ERP.
  const inbox = readFileSync(pageFileOf(SALES_AGENT_INBOX_HREF), "utf8");
  assert.match(inbox, /shell = isSalesAgentUser\(user\)/);
  assert.match(inbox, /<ShellViewportFit/, "trong vỏ, khung hộp thư đo chiều cao thật");
  assert.match(inbox, /h-\[calc\(100dvh-13\.5rem\)\] min-h-\[560px\]/, "ngoài vỏ: đúng chiều cao cũ");
  const fit = readFileSync(path.join(goc, "components", "shell-viewport-fit.tsx"), "utf8");
  assert.match(fit, /sales-agent-bottom-nav/, "khung đo thanh dưới thật của vỏ");
  assert.match(fit, /visualViewport/, "theo dõi bàn phím ảo / đổi cỡ màn");
  assert.match(fit, /shellFitHeight\(/, "dùng hàm thuần đã kiểm");
  const shellSrc = readFileSync(path.join(goc, "components", "saas-shell.tsx"), "utf8");
  assert.match(shellSrc, /SHELL_BLOCKED_PARAM/, "vỏ in câu «không có trong gói» khi bị chuyển hướng");

  // Tổng quan: số của shop, KHÔNG chi phí / token / model của nhà cung cấp.
  const ov = readFileSync(pageFileOf("/ai/overview"), "utf8");
  assert.match(ov, /withMoney: false/, "Tổng quan đọc hiệu quả AI KHÔNG kèm tiền AI");
  assert.ok(!/\br\.cost\b|r\.economics|costUsd|inputTokens|outputTokens|\.model\b/.test(ov), "Tổng quan không in chi phí / token / model");
  assert.match(ov, /deliveredRevenueVnd/, "doanh thu AI = đơn giao thành công (ORDER_OUTCOME qua loadAiSalesPerformance), không phải giá trị chốt");
}

/* ═════════════ 3 · TRƯỚC / SAU — ERP VÀ NHÀ KHÔNG ĐỔI ═════════════ */
function kiemTruocSau() {
  const erpModules = [...AI_SALES_MODULES, "logistics", "finance", "marketing", "returns"];
  for (const org of [{ isHome: true }, { isHome: false }, { isHome: false, brand: "vnx" as const }, { isHome: false, brand: null }]) {
    const truoc = { role: "ADMIN" as const, permissions: [] as string[], modules: erpModules, organization: { isHome: org.isHome } };
    const sau = { ...truoc, organization: org };
    assert.deepEqual(visibleGroups(sau), visibleGroups(truoc), `menu ERP y như trước khi phiên mang thương hiệu (${JSON.stringify(org)})`);
    assert.equal(isSalesAgentUser(sau), false);
  }
  // Workspace ERP mang thương hiệu chotdon (tự đăng ký ngành đầy đủ trên host Chốt Đơn): menu ERP nguyên vẹn, không vỏ.
  const erpChotdon = { role: "ADMIN" as const, permissions: [] as string[], modules: erpModules, organization: { isHome: false, brand: "chotdon" as const } };
  assert.equal(isSalesAgentUser(erpChotdon), false);
  assert.deepEqual(visibleGroups(erpChotdon), visibleGroups({ ...erpChotdon, organization: { isHome: false } }), "thương hiệu chotdon KHÔNG đổi menu của khách ERP");
  assert.ok(visibleGroups(erpChotdon).flatMap((g) => g.items).some((i) => i.href === "/orders"), "menu ERP vẫn có Đơn hàng");

  const layout = readFileSync(path.join(goc, "app", "(dashboard)", "layout.tsx"), "utf8");
  assert.match(layout, /const shell = isSalesAgentUser\(user\)/, "layout quyết định vỏ bằng ĐÚNG hàm chung");
  assert.match(layout, /shell \? \(\s*<SalesAgentShell[\s\S]*?\) : \(\s*<AppTopNav user=\{\{ \.\.\.user, dynamicPages \}\}/, "không phải vỏ ⇒ AppTopNav như cũ");
  const shellSrc = readFileSync(path.join(goc, "components", "saas-shell.tsx"), "utf8");
  for (const erpNav of ["visibleGroups", "MODULE_GROUPS", "GlobalSearch", "AiCopilot", "allowedNavItems"]) assert.ok(!shellSrc.includes(erpNav), `vỏ không được vẽ / tìm kiếm menu ERP (${erpNav})`);
  assert.match(shellSrc, /salesAgentNavFor\(user\)/, "vỏ đọc mục từ sổ khai, không giữ danh sách thứ hai");
  // Dấu HTML mà phép đo trang thật (ops saas-acceptance bước C) soi: tệp vẽ ra chúng phải còn mang ĐÚNG dấu ấy — đổi một bên mà quên
  // hằng số là phép đo mù im lặng (vỏ hỏng vẫn «không lộ ERP», hoặc vỏ đúng bị báo «không dựng vỏ»).
  assert.ok(shellSrc.includes(SALES_AGENT_SHELL_HTML_MARKER), "components/saas-shell.tsx phải vẽ dấu vỏ SALES_AGENT_SHELL_HTML_MARKER");
  const erpFrame = ["app-topnav.tsx", "ai-copilot.tsx"].map((f) => readFileSync(path.join(goc, "components", f), "utf8")).join("\n");
  for (const m of ERP_FRAME_HTML_MARKERS) {
    assert.ok(erpFrame.includes(m), `khung ERP phải còn vẽ dấu ${m} (ERP_FRAME_HTML_MARKERS)`);
    assert.ok(!shellSrc.includes(m), `vỏ không được vẽ dấu của khung ERP ${m}`);
  }
}

/* ═════════════ 5 · MOBILE (hợp đồng mã nguồn) ═════════════ */
function kiemMobile() {
  const shellSrc = readFileSync(path.join(goc, "components", "saas-shell.tsx"), "utf8");
  assert.match(shellSrc, /data-testid="sales-agent-bottom-nav"/, "có thanh dưới cho điện thoại");
  assert.match(shellSrc, /fixed inset-x-0 bottom-0[^"]*lg:hidden/, "thanh dưới cố định đáy và CHỈ ở màn hẹp");
  assert.match(shellSrc, /hidden h-screen w-60[^"]*lg:flex/, "thanh bên chỉ ở màn rộng");
  assert.match(shellSrc, /SheetContent side="bottom"/, "mục còn lại trong ngăn kéo «Thêm»");
  assert.match(shellSrc, /flex h-16 flex-col/, "ô thanh dưới cao 64px (≥ 44px)");
  assert.match(shellSrc, /flex min-h-11 items-center/, "ô thanh bên / ngăn kéo ≥ 44px");
  assert.match(shellSrc, /safe-area-inset-bottom/, "chừa vùng an toàn của điện thoại có thanh vuốt");
  const layout = readFileSync(path.join(goc, "app", "(dashboard)", "layout.tsx"), "utf8");
  assert.match(layout, /shell \? "overflow-x-clip pb-24/, "<main> của vỏ: không tràn ngang (clip, không phải hidden) và chừa đáy cho thanh dưới");
  for (const href of ["/ai/overview", "/settings/shop"]) {
    const src = readFileSync(pageFileOf(href), "utf8");
    assert.ok(!/min-w-\[(?:[6-9]\d\d|\d{4,})px\]|w-\[(?:[6-9]\d\d|\d{4,})px\]/.test(src), `${href}: không đặt bề rộng cố định lớn hơn màn điện thoại`);
    assert.match(src, /grid-cols-2|sm:grid-cols|divide-y/, `${href}: bố cục đổ cột theo màn hình`);
  }
}

/* ═════════════ 4 · MÁY CHỦ ═════════════ */
async function asRequest<T>(token: string, reqPath: string, fn: () => Promise<T>): Promise<T> {
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  try {
    return await fn();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

async function redirectTarget(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    const digest = String((error as { digest?: unknown }).digest ?? "");
    if (digest.startsWith("NEXT_REDIRECT")) return digest.split(";")[2] ?? "";
    throw error;
  }
  return "";
}

async function kiemMayChu() {
  const dir = organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, "");
  rmSync(dir, { recursive: true, force: true });
  const pdb = await getPlatformDb();
  let failure: unknown = null;
  try {
    const prov = await provisionOrganization({ code: ORG, name: "Shop vỏ Chốt Đơn", modules: AI_SALES_MODULES.filter((m) => m !== "core" && m !== "work"), admin: { email: "chu@sa-shell.local", name: "Chủ shop", password: "Sa-shell@12345" }, source: "TEST", actor: null, brand: "chotdon" });
    assert.equal(prov.created, true);
    const admin = await withOrganization(ORG, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@sa-shell.local") }));
    assert.ok(admin);
    const token = await signSession({ id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", orgCode: ORG });

    const ok = await asRequest(token, SALES_AGENT_INBOX_HREF, () => resolveCurrentUser());
    assert.ok("user" in ok, `hộp thư phải mở được, nhận ${JSON.stringify(ok)}`);
    assert.equal(ok.user.organization?.brand, "chotdon", "phiên mang thương hiệu của tổ chức (đọc từ sổ tổ chức, không từ client)");
    assert.equal(isSalesAgentUser(ok.user), true, "workspace tạo qua /start Chốt Đơn (mẫu AI bán hàng) mang vỏ");

    for (const p of ["/cockpit", "/work", "/departments", "/data-quality", "/audit", "/settings/data-model", "/settings/workflows", "/inventory", "/orders/verify", "/production"]) {
      const ket = await asRequest(token, p, () => resolveCurrentUser());
      assert.ok("denied" in ket && ket.denied === "SHELL_RESTRICTED", `${p} phải bị chặn ở MÁY CHỦ, nhận ${JSON.stringify(ket)}`);
      const dich = `${SALES_AGENT_INBOX_HREF}?${SHELL_BLOCKED_PARAM}=1`;
      assert.equal(ket.home, dich, "về hộp thư KÈM tham số để vỏ nói «không có trong gói», không im lặng");
      assert.equal(await asRequest(token, p, () => redirectTarget(() => requireUser())), dich, `${p}: requireUser chuyển về hộp thư, không về /login`);
    }
    assert.equal(await asRequest(token, "/", () => redirectTarget(() => requireUser())), SALES_AGENT_INBOX_HREF, "`/` ⇒ hộp thư");
    for (const p of ["/ai/overview", "/ai/sales-chatbot", "/products", "/inventory/receipts", "/orders/123", "/customers/abc", "/settings/users", "/settings/plan", "/settings/shop", "/api/events", "/api/notifications"]) {
      const ket = await asRequest(token, p, () => resolveCurrentUser());
      assert.ok("user" in ket, `${p} phải đi qua cổng vỏ, nhận ${JSON.stringify(ket)}`);
    }

    // Cấp ERP (bật một module độc quyền ERP) ⇒ hết vỏ NGAY, menu ERP trở lại — không cần cờ thứ hai.
    const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, ORG) });
    assert.ok(org);
    await pdb.insert(schema.platformOrganizationModules).values({ organizationId: org.id, moduleKey: "logistics", enabled: true, enabledAt: new Date(), updatedBy: "system:test" }).onConflictDoNothing();
    invalidateCapabilities(ORG);
    const erp = await asRequest(token, "/cockpit", () => resolveCurrentUser());
    assert.ok("user" in erp && !isSalesAgentUser(erp.user), `workspace có module ERP: /cockpit mở như cũ, nhận ${JSON.stringify(erp)}`);
    await pdb.delete(schema.platformOrganizationModules).where(and(eq(schema.platformOrganizationModules.organizationId, org.id), eq(schema.platformOrganizationModules.moduleKey, "logistics")));
    invalidateCapabilities(ORG);

    // Thương hiệu rút về NULL (tổ chức trước 0215) ⇒ menu cũ.
    await pdb.update(schema.platformOrganizations).set({ brand: null }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    const cu = await asRequest(token, "/cockpit", () => resolveCurrentUser());
    assert.ok("user" in cu && !isSalesAgentUser(cu.user), "thương hiệu chưa theo dõi ⇒ không vỏ, /cockpit mở như trước");

    // Nhà: không đổi gì.
    const home = await getHomeOrganization();
    await (await getDb()).insert(schema.users).values({ id: HOME_ADMIN_ID, email: "admin@sa-home.local", name: "Quản trị nhà (sa)", passwordHash: "x", role: "ADMIN" });
    const t = await signSession({ id: HOME_ADMIN_ID, email: "admin@sa-home.local", name: "Quản trị nhà (sa)", role: "ADMIN", orgCode: home.code });
    for (const p of ["/", "/cockpit", "/settings/data-model"]) {
      const ket = await asRequest(t, p, () => resolveCurrentUser());
      assert.ok("user" in ket && !isSalesAgentUser(ket.user), `nhà: ${p} đi qua như cũ, không bao giờ bị cổng vỏ chặn — nhận ${JSON.stringify(ket)}`);
    }

    // Lý do từ chối có tham số + câu riêng và giữ người dùng ở /login nếu lọt tới đó (không vòng lặp).
    assert.equal(DENY_REASON_PARAM.SHELL_RESTRICTED, "shell-restricted");
    assert.ok(DENY_REASON_MESSAGE["shell-restricted"] && loginShouldStay("shell-restricted"));
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    await (await getDb()).delete(schema.users).where(eq(schema.users.id, HOME_ADMIN_ID));
    await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    invalidateCapabilities(ORG);
    rmSync(dir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[saas-shell] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
}

export async function testSaasShell() {
  kiemThuan();
  kiemTrang();
  kiemTruocSau();
  kiemMobile();
  await kiemMayChu();
  console.log(
    `✓ Vỏ app Chốt Đơn: workspace Sales Agent = thương hiệu chotdon + chỉ sản phẩm Chốt Đơn theo module · đúng ${EIGHT.length} mục · ${BLOCKED.length} route nội bộ chặn ở máy chủ (SHELL_RESTRICTED ⇒ hộp thư) · \`/\` ⇒ hộp thư · bật module ERP / bỏ thương hiệu ⇒ menu ERP như cũ · nhà không đổi · thanh dưới điện thoại ≥ 44px`,
  );
}

if (process.argv[1] && /saas-shell\.test\.ts$/.test(process.argv[1])) {
  testSaasShell().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
