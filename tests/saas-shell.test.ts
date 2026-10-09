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
 *  6. NGOÀI (dashboard) — trang người vỏ mở được mà nằm ngoài nhóm `(dashboard)` (404 gốc, /pricing, văn bản pháp lý…) không
 *     điều hướng PHÍA CLIENT tới `/` (`<Link href="/">`, `router.push("/")`), và không tự chuyển hướng người đã đăng nhập thẳng
 *     tới `/` (`redirect(safeNextPath(…))`, `redirect("/")` — /login dùng `landingAfterSignIn`): lượt RSC ấy dựng layout
 *     `(dashboard)` từ gốc và layout ném redirect ⇒ vòng trang trắng #671. Tên sản phẩm của 404 gốc theo host như bố cục gốc.
 *
 * Tự dọn: tổ chức `sa-shell` lưu trữ + xoá thư mục CSDL trong `finally`.
 */
import { CHANNELS_MANAGE_PERMISSION, CHANNELS_ROUTE } from "@/lib/channels/overview-shared";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import { hostProductName } from "@/lib/branding/copy";
import { channelFactsOf } from "@/lib/onboarding/go-live";
import { anyChannelConnected } from "@/lib/onboarding/go-live-shared";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { PRODUCTS, SHARED_COMMERCE_CORE } from "@/lib/saas/catalog";
import { visibleTexts } from "./saas-hide-internal.test";

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
  // Mỗi tiền tố cho phép phải trỏ tới ít nhất một trang có thật (tiền tố mồ côi là chỗ hổng chờ trang ERP mới lọt vào). Trang có
  // thể đứng NGOÀI nhóm (dashboard): `/module-disabled` đứng ngoài để layout không chuyển hướng vào chính nó (shell-gate-redirects).
  const ngoaiNhom = (prefix: string) => existsSync(path.join(goc, "app", ...prefix.split("/").filter(Boolean), "page.tsx"));
  for (const prefix of SALES_AGENT_ALLOWED_PREFIXES) assert.ok(pages.some((p) => p.url === prefix || p.url.startsWith(`${prefix}/`)) || ngoaiNhom(prefix), `tiền tố cho phép ${prefix} không có trang nào`);
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
  // Trang vỏ mở được mà đứng NGOÀI nhóm (dashboard) (`/module-disabled` — đứng ngoài để layout không chuyển hướng vào chính nó)
  // vẫn là trang của vỏ: quét CÙNG luật, nếu không một nút «Mở Module của tổ chức» trần ở đó là lối cụt không ai thấy.
  const moNgoaiNhom = SALES_AGENT_ALLOWED_PREFIXES.filter(ngoaiNhom).map((prefix) => ({ url: prefix, file: rel(path.join(goc, "app", ...prefix.split("/").filter(Boolean), "page.tsx")) }));
  assert.ok(moNgoaiNhom.some((p) => p.url === "/module-disabled"), `quét cả trang vỏ ngoài nhóm (dashboard): ${moNgoaiNhom.map((p) => p.url).join(", ")}`);
  const loiCut: string[] = [];
  for (const pg of [...open, ...moNgoaiNhom]) {
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

  // HỘP THƯ RỖNG «chưa nối kênh»: hỏi MỌI kênh bằng ĐÚNG hàm của bước onboarding «đã nối kênh» (Pancake · Facebook nối thẳng ·
  // Zalo OA · chat web), không suy từ danh sách page của hộp thư (shop chỉ nối Zalo / chat web không có page nào); nút nối kênh
  // theo ĐÚNG quyền nối kênh của màn Kênh kết nối — người không nối được thấy câu «nhờ quản trị».
  assert.match(inbox, /memo\(`inbox:channel-facts:\$\{orgCode\}`, 60_000, \(\) => loadChannelFacts\(orgCode\)\)/, "hộp thư đọc kênh bằng hàm chung của onboarding, đệm 60 giây theo mã tổ chức (trang tự làm mới 5 giây)");
  assert.match(inbox, /noChannelYet = channelFacts !== null && !anyChannelConnected\(channelFacts\)/, "đọc kênh hỏng ⇒ không kết luận «chưa nối kênh»");
  assert.ok(!/noChannelYet = pages\.length === 0/.test(inbox), "không suy «chưa nối kênh» từ danh sách page của hộp thư");
  assert.match(inbox, /const canConnect = can\(user, CHANNELS_MANAGE_PERMISSION\)/, "nút nối kênh theo quyền nối kênh");
  assert.match(inbox, /\{canConnect \? \(\s*<Link href=\{SALES_AGENT_CHANNELS_HREF\}/, "nút «Kết nối Facebook» chỉ cho người nối được kênh");
  assert.match(inbox, /Nhờ quản trị cửa hàng nối kênh/, "người không nối được kênh thấy câu nhờ quản trị");
  assert.match(readFileSync(pageFileOf(CHANNELS_ROUTE), "utf8"), /const manage = can\(user, CHANNELS_MANAGE_PERMISSION\)/, "màn Kênh kết nối dùng CÙNG hằng quyền");
  assert.equal(CHANNELS_MANAGE_PERMISSION, "settings:manage");
  const khongKenh = { pancake: false, messenger: false, zalo: false, webChat: false };
  assert.equal(anyChannelConnected(khongKenh), false);
  for (const k of ["pancake", "messenger", "zalo", "webChat"] as const) assert.equal(anyChannelConnected({ ...khongKenh, [k]: true }), true, `chỉ ${k} ⇒ ĐÃ nối kênh`);
  assert.deepEqual(channelFactsOf({ fanpage: { status: "FAILED" }, messenger: { status: "ACTIVE", page: null }, zalo: { status: "ACTIVE" }, pub: { state: "PUBLISHED" } }), { pancake: false, messenger: false, zalo: true, webChat: true }, "Messenger bật mà chưa có page ⇒ chưa nối; Zalo bật · chat web xuất bản ⇒ nối");

  // Số dư AI khi cờ tắt: trang không đọc trạng thái gói ⇒ không khẳng định gì về gói.
  assert.ok(!/hoạt động bình thường/.test(readFileSync(pageFileOf("/settings/ai-balance"), "utf8")), "Số dư AI không khẳng định gói «vẫn hoạt động bình thường»");

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

/* ═════════════ 6 · NGOÀI (dashboard) — KHÔNG ĐIỀU HƯỚNG CLIENT TỚI `/` ═════════════ */
function kiemNgoaiDashboard() {
  const tracked = execFileSync("git", ["ls-files", "app", "components"], { cwd: goc, encoding: "utf8" })
    .split("\n")
    .filter((f) => f.endsWith(".tsx"));
  const outside = tracked.filter((f) => f.startsWith("app/") && !f.startsWith("app/(dashboard)/"));
  assert.ok(outside.includes("app/not-found.tsx") && outside.includes("app/pricing/page.tsx"), `đọc hụt trang ngoài (dashboard) (${outside.length} tệp)`);
  // Cả thành phần các trang ấy nạp trực tiếp (khung văn bản pháp lý, bảng giá công khai…): lối về `/` nằm trong đó cũng là lối của trang.
  const files = new Set(outside);
  for (const f of outside) {
    for (const m of readFileSync(path.join(goc, f), "utf8").matchAll(/from "@\/(components\/[^"]+)"/g)) {
      for (const c of [`${m[1]}.tsx`, `${m[1]}/index.tsx`]) if (tracked.includes(c)) files.add(c);
    }
  }
  assert.ok(files.has("components/legal/legal-page.tsx"), "quét cả thành phần trang ngoài nạp");
  // Bỏ chú thích trước khi quét: chú thích được phép NHẮC TỚI mẫu cấm (để giải thích vì sao), mã thì không.
  const maKhongChuThich = (f: string) =>
    readFileSync(path.join(goc, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const viPham = [...files].filter((f) => {
    const src = maKhongChuThich(f);
    return /<Link\b[^>]*?\bhref=(?:"\/"|'\/'|\{\s*["'`]\/["'`]\s*\})/.test(src) || /router\.(?:push|replace)\(\s*["'`]\/["'`]\s*\)/.test(src);
  });
  assert.deepEqual(viPham, [], `trang ngoài (dashboard) điều hướng client tới "/" — người vỏ gặp vòng trang trắng #671 (lib/saas/shell-landing.ts): ${viPham.join(" · ")}`);
  for (const f of ["app/not-found.tsx", "app/pricing/page.tsx", "components/legal/legal-page.tsx"]) assert.match(readFileSync(path.join(goc, f), "utf8"), /<a href="\/"/, `${f}: lối về trang chính tải cả trang`);
  // Trang ngoài (dashboard) TỰ chuyển hướng người đã đăng nhập (vd /login khi còn phiên) cũng là một lối tới `/`: tới đó bằng
  // `<Link>` (/start · /join · /reset → «Đăng nhập») là điều hướng client ⇒ cùng vòng #671. Đích phải tính bằng
  // `landingAfterSignIn` (người vỏ ⇒ trang nhà của vỏ), không `redirect(safeNextPath(…))` / `redirect("/")` trực tiếp.
  const chuyenThang = outside.filter((f) => /\bredirect\(\s*safeNextPath\(/.test(maKhongChuThich(f)) || /\bredirect\(\s*["'`]\/["'`]\s*\)/.test(maKhongChuThich(f)));
  assert.deepEqual(chuyenThang, [], `trang ngoài (dashboard) chuyển hướng thẳng tới "/" / safeNextPath — người vỏ đang đăng nhập gặp vòng #671: ${chuyenThang.join(" · ")}`);
  assert.match(maKhongChuThich("app/login/page.tsx"), /if \(session && !loginShouldStay\(params\.reason\)\) redirect\(await landingAfterSignIn\(params\.next\)\);/, "/login còn phiên ⇒ đích của landingAfterSignIn");
  // 404 gốc: tên sản phẩm theo host — tên miền con của khách không in «VNXcommerce», tên miền con lạ không in tên nào.
  assert.equal(hostProductName({ slug: "shop-a", org: { name: "Shop A" } }, "vnx"), "Shop A");
  assert.equal(hostProductName({ slug: "khong-co", org: null }, "vnx"), null);
  assert.equal(hostProductName({ slug: null, org: null }, "chotdon"), "Chốt Đơn Tự Động");
  assert.equal(hostProductName({ slug: null, org: null }, "vnx"), "VNXcommerce");
  const nf = readFileSync(path.join(goc, "app", "not-found.tsx"), "utf8");
  assert.ok(nf.includes("hostOrganization()") && nf.includes("hostProductName(host, brand)"), "404 gốc đọc tên theo host như bố cục gốc (app/layout.tsx)");
}

/* ═════════════ 7 · CHỮ KỸ THUẬT Ở VỎ (Launch Gate C3) ═════════════
 *
 * Finish Line R2 đo 21 đường của vỏ: còn «webhook · module · ERP · API · connector · TEST» ở AI Sales, Nhân viên, Kết nối,
 * Thiết lập, Kho, Tài khoản. Câu của ERP giữ NGUYÊN, nên câu chữ đi theo sản phẩm: `shell ? «câu chủ shop» : «câu ERP»` (cờ
 * `isSalesAgentUser`). Bộ quét: bỏ vế ERP của mọi `shell|plain|isSalesAgentUser(user) ? "…" : "…"`, rồi mọi chữ hiển thị còn mang
 * từ cấm phải nằm trong danh sách miễn trừ ĐÓNG có lý do (vế chỉ dựng cho ERP / nhà, hoặc TÊN MỤC của phần mềm bên thứ ba mà chủ
 * shop phải bấm). Miễn trừ mồ côi cũng đỏ.
 */
const SHELL_COPY_FILES = [
  "app/(dashboard)/settings/users/page.tsx",
  "app/(dashboard)/settings/users/invites-panel.tsx",
  "app/(dashboard)/settings/users/revoke-sessions-dialog.tsx",
  "app/(dashboard)/settings/users/users-table.tsx",
  "app/(dashboard)/ai/sales-chatbot/page.tsx",
  "app/(dashboard)/ai/sales-chatbot/order-sync-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/history-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/lessons-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/playbook-panel.tsx",
  "app/(dashboard)/ai/sales-chatbot/config-form.tsx",
  "app/(dashboard)/settings/connections/page.tsx",
  "components/connectors/connector-group-table.tsx",
  "components/connectors/legacy-connections.tsx",
  "app/(dashboard)/setup/page.tsx",
  "app/(dashboard)/settings/profile/page.tsx",
  "app/(dashboard)/inventory/receipts/page.tsx",
  "app/module-disabled/page.tsx",
  "app/module-disabled/error.tsx",
] as const;
const SHELL_FORBIDDEN = /\bERP\b|\bAPI\b|\bTEST\b|\bField\b|\b[Mm]odule\b|\b[Ww]ebhook\b|\b[Cc]onnector\b/;
const SHELL_COPY_EXEMPT: [string, string, string][] = [
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "mục «Webhook» (tên mục của Pancake)", "Tên MỤC trong Pancake mà chủ shop phải bấm — đổi chữ là hướng dẫn sai."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "Trang nhà phát triển của Zalo (developers.zalo.me)", "Tên mục / công cụ của Zalo trong «…» (Webhook · API Explorer) mà chủ shop phải bấm — câu quanh nó đã nói bằng tiếng Việt."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "mục «Webhook» (tên mục của Zalo)", "Tên mục của Zalo mà chủ shop phải bấm."],
  ["app/(dashboard)/ai/sales-chatbot/page.tsx", "c.channel !== \"TEST\"", "Mã so sánh kênh, không phải chữ hiển thị (bộ quét bắt nhầm đoạn mã giữa hai thẻ)."],
  ["components/connectors/connector-group-table.tsx", "{row.webhook ? (", "Đoạn mã trong khối `row.why ?` — `why` / `webhook` chỉ workspace nhà nhận."],
  ["components/connectors/connector-group-table.tsx", "Webhook", "Dòng «Webhook <đường dẫn>» trong khối `row.why ?` — chỉ workspace nhà."],
  ["app/(dashboard)/setup/page.tsx", "Module đang bật", "Nằm trong `{shell ? null : (…)}` — vỏ thấy tám mục ở khối «Menu», không thấy danh sách module."],
  ["app/(dashboard)/setup/page.tsx", "Bật / tắt module", "Nằm sau `shellAllows(user, \"/settings/modules\")` — vỏ chặn trang ấy nên không bao giờ dựng."],
  ["app/module-disabled/page.tsx", "Module chưa bật", "Tiêu đề tab của ERP; vỏ dùng SHELL_TITLE."],
  ["app/module-disabled/page.tsx", "[module-disabled]", "Nhãn nhật ký máy chủ (console.warn), không hiện ra màn hình."],
  ["app/module-disabled/page.tsx", "thuộc một module chưa được bật", "Nhánh ERP (sau `if (shell) return`)."],
  ["app/module-disabled/page.tsx", "chưa dùng mảng này của ERP", "Nhánh ERP (sau `if (shell) return`)."],
  ["app/module-disabled/page.tsx", "Module này dùng thông tin kết nối của tổ chức nhà", "Nhánh ERP (sau `if (shell) return`)."],
  ["app/module-disabled/page.tsx", "Bật / tắt module của tổ chức", "Nhánh ERP (sau `if (shell) return`)."],
  ["app/module-disabled/page.tsx", "Module của tổ chức", "Nhánh ERP, và sau `shellAllows(user, \"/settings/modules\")`."],
  // Chung nhất — đứng CUỐI để các mục cụ thể ở trên khớp trước (`findIndex` lấy mục đầu tiên).
  ["app/module-disabled/page.tsx", "Module", "Nhãn nhóm «Module» của nhánh ERP — người vỏ đã `return` sớm ở `if (shell)`."],
];

function kiemChuKyThuatVo() {
  const lit = String.raw`"(?:[^"\\\n]|\\.)*"|` + "`(?:[^`\\\\]|\\\\.)*`";
  const ternary = new RegExp(String.raw`\b(?:shell|plain|isSalesAgentUser\(user\))\s*\?\s*(${lit}|null|undefined)\s*:\s*(?:${lit})`, "g");
  const hits: string[] = [];
  const used = new Set<number>();
  for (const f of SHELL_COPY_FILES) {
    const src = readFileSync(path.join(goc, f), "utf8").replace(ternary, (_m, shellSide: string) => shellSide);
    for (const t of visibleTexts(src)) {
      if (!SHELL_FORBIDDEN.test(t) || /^[a-z0-9-]+$/.test(t.trim()) || t.trim().startsWith("/")) continue;
      const i = SHELL_COPY_EXEMPT.findIndex(([ef, snippet]) => ef === f && t.includes(snippet));
      if (i >= 0) used.add(i);
      else hits.push(`${f}: «${t.trim().slice(0, 140)}»`);
    }
  }
  assert.deepEqual(hits, [], "vỏ Chốt Đơn in chữ kỹ thuật (webhook · module · ERP · API · connector · TEST) — đưa vào `shell ? «câu chủ shop» : «câu ERP»` hoặc khai miễn trừ có lý do");
  const orphan = SHELL_COPY_EXEMPT.filter((_, i) => !used.has(i)).map(([f, x]) => `${f}: «${x}»`);
  assert.deepEqual(orphan, [], "miễn trừ không còn khớp chữ nào — xoá khỏi danh sách");
  // Tự kiểm bộ quét: vế ERP bị bỏ, vế vỏ còn được quét.
  const thu = `<p>{shell ? "Sổ của shop" : "Đọc từ ERP"}</p>\n<p>{shell ? "Tải module" : "x"}</p>`.replace(ternary, (_m, a: string) => a);
  assert.ok(!visibleTexts(thu).some((t) => /ERP/.test(t)) && visibleTexts(thu).some((t) => SHELL_FORBIDDEN.test(t)), "bộ quét bỏ đúng vế ERP, giữ vế vỏ");

  // TRANG NHÂN VIÊN (Finish Line R2: 786 ô < 32px, 4.296px ở 390px): vỏ ⇒ tiêu đề «Nhân viên», bảng gọn, ẩn ba khối ERP nâng cao.
  const users = readFileSync(pageFileOf("/settings/users"), "utf8");
  assert.match(users, /const shell = isSalesAgentUser\(user\)/, "trang Nhân viên quyết vỏ bằng ĐÚNG hàm chung");
  assert.match(users, /title=\{shell \? "Nhân viên" : "Người dùng"\}/, "tiêu đề = tên mục menu vỏ; ERP giữ «Người dùng»");
  assert.match(users, /compact=\{shell\}/, "bảng gọn (bỏ Phòng ban · Quyền & phạm vi) chỉ ở vỏ");
  const anKhoi = users.slice(users.indexOf("{shell ? null : ("));
  assert.ok(users.includes("{shell ? null : (") && ["<RolesPanel", "<PositionsPanel", "<RoleMatrix"].every((c) => anKhoi.includes(c)), "Vai trò tuỳ chỉnh · Chức danh · ma trận quyền chỉ dựng ngoài vỏ");
  assert.match(users, /requirePermission\("users:manage"\)/, "cổng trang không đổi");
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
  kiemNgoaiDashboard();
  kiemChuKyThuatVo();
  await kiemMayChu();
  console.log(
    `✓ Vỏ app Chốt Đơn: workspace Sales Agent = thương hiệu chotdon + chỉ sản phẩm Chốt Đơn theo module · đúng ${EIGHT.length} mục · ${BLOCKED.length} route nội bộ chặn ở máy chủ (SHELL_RESTRICTED ⇒ hộp thư) · \`/\` ⇒ hộp thư · bật module ERP / bỏ thương hiệu ⇒ menu ERP như cũ · nhà không đổi · thanh dưới điện thoại ≥ 44px · trang ngoài (dashboard) không điều hướng client tới \`/\` · hộp thư rỗng hỏi MỌI kênh, nút nối kênh theo quyền nối kênh`,
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
