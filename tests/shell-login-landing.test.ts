/**
 * ═══════════ ĐÍCH SAU ĐĂNG NHẬP / ĐĂNG KÝ CỦA VỎ CHỐT ĐƠN — F-01 (lib/saas/shell-landing.ts) ═══════════
 *
 * Server action `redirect("/")` cho người thuộc vỏ từng làm TRANG TRẮNG: chính layout `(dashboard)` chuyển hướng `/` về hộp thư,
 * client lưu nút layout mang lỗi chuyển hướng, rồi điều hướng tới hộp thư (cùng layout) dùng lại nút hỏng ⇒ `replaceState` hàng
 * nghìn lần. Bài này khoá:
 *
 *  1. THUẦN — `landingPath`: ngoài vỏ ĐÚNG `safeNextPath(next)`; trong vỏ `next` vỏ mở được thì giữ, còn lại (`/`, trang ERP,
 *     ngoài miền, `//evil`, `/ai/../cockpit`) về trang nhà của vỏ; mọi đích ở lại cùng host; `salesAgentHomeOfRedirect` ngược
 *     đúng `salesAgentRedirectFor`; vỏ còn là vỏ thì mọi trang vỏ mở được thuộc module đang bật (không cổng module nào chuyển hướng).
 *  2. MÁY CHỦ (tổ chức thật trên PGlite, mã `dich-dang-nhap`) — đúng đường của lượt POST `/login` · `/start`: chủ shop ⇒ hộp thư
 *     (không kèm «ngoài gói»); nhân viên không đọc được hộp thư ⇒ mục đầu tiên còn thấy; nhà và workspace không thuộc vỏ ⇒ y như
 *     `safeNextPath`; không phiên ⇒ đường cũ.
 *  3. MÃ NGUỒN — `loginAction` / `quickSignupAction` không còn `redirect("/")` trần, và tính đích SAU khi đã mở phiên.
 *
 * Tự dọn: tổ chức lưu trữ + xoá thư mục CSDL + xoá người dùng nhà trong `finally`.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { safeNextPath } from "@/lib/auth/safe-redirect";
import { resolveCurrentUser, setRequestPathSourceForTests, signSession } from "@/lib/auth/session";
import { moduleOfPath, PLATFORM_MODULES } from "@/lib/constants/platform-modules";
import {
  isSalesAgentUser,
  SALES_AGENT_ALLOWED_PREFIXES,
  SALES_AGENT_INBOX_HREF,
  salesAgentHomeFor,
  salesAgentHomeOfRedirect,
  salesAgentPathAllowed,
  salesAgentRedirectFor,
  SHELL_BLOCKED_PARAM,
} from "@/lib/constants/saas-nav";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { landingAfterSignIn, landingPath, shellHomeOfSession } from "@/lib/saas/shell-landing";

const goc = path.resolve(__dirname, "..");
const ORG = "dich-dang-nhap";
const HOME_USER_ID = "dich-dang-nhap-home";
const STAFF_ID = "dich-dang-nhap-kho";
/** Đúng bộ module của mẫu «Chỉ cần AI bán hàng» (như tests/saas-shell.test.ts). */
const AI_SALES_MODULES = ["customers", "products", "orders", "inventory", "ai_sales"];
const APP = "https://app.chotdontudong.com";

/** `next` độc / lạ — cùng bộ với tests/login-throttle.test.ts, thêm các đường vỏ chặn. */
const TAN_CONG = ["//evil.com", "/\\evil.com", "\\\\evil.com", "/\\/evil.com", "https://evil.com", "http:/evil.com", "javascript:alert(1)", "/\t/evil.com", "/\n/evil.com", "/..//evil.com", "/%2e%2e//evil.com", " /x", "evil.com", ""];
const VO_CHAN = ["/", "/?forbidden=1", "/cockpit", "/work", "/settings/modules", "/inventory", "/orders/verify", "/shipments", "/ai/../cockpit", "/ai/%2e%2e/cockpit", "/products/../reports"];
const VO_MO = ["/ai/sales-chatbot/inbox?f=NEEDS_HUMAN", "/orders/123", "/orders/9007199254740993/edit", "/customers/abc", "/products?q=ao#dong-2", "/inventory/receipts", "/settings/profile", "/ai/overview"];

function oCungHost(r: string, ten: string) {
  assert.ok(r.startsWith("/") && !r.startsWith("//") && !r.includes("\\"), `${ten}: đích ${JSON.stringify(r)} phải là đường nội bộ`);
  assert.equal(new URL(r, APP).host, new URL(APP).host, `${ten}: đích phải ở lại cùng host`);
}

/* ═════════════ 1 · THUẦN ═════════════ */
function kiemThuan() {
  // Ngoài vỏ: đúng bằng safeNextPath — ERP / nhà không đổi một ký tự.
  for (const n of [undefined, null, 42, ...TAN_CONG, ...VO_CHAN, ...VO_MO]) assert.equal(landingPath(n, null), safeNextPath(n), `ngoài vỏ: next=${JSON.stringify(n)} phải đúng như safeNextPath`);

  // Trong vỏ: trang chặn / ngoài miền / độc ⇒ trang nhà; trang vỏ mở được ⇒ giữ nguyên (cả query + hash).
  for (const home of [SALES_AGENT_INBOX_HREF, "/products", "/settings/shop"]) {
    for (const n of [undefined, null, ...TAN_CONG, ...VO_CHAN]) {
      const r = landingPath(n, home);
      assert.equal(r, home, `vỏ: next=${JSON.stringify(n)} phải về trang nhà ${home}, nhận ${r}`);
      oCungHost(r, `vỏ next=${JSON.stringify(n)}`);
    }
    for (const n of VO_MO) assert.equal(landingPath(n, home), safeNextPath(n), `vỏ: ${n} mở được trong vỏ ⇒ giữ`);
  }
  // Mọi đích của người vỏ là trang vỏ mở được và KHÔNG là `/` — chỗ layout tự chuyển hướng, gốc của vòng lặp.
  for (const n of [...TAN_CONG, ...VO_CHAN, ...VO_MO]) {
    const r = landingPath(n, SALES_AGENT_INBOX_HREF);
    assert.ok(salesAgentPathAllowed(r) && r.split(/[?#]/)[0] !== "/", `vỏ: next=${JSON.stringify(n)} ra ${r} — phải là trang vỏ dựng được`);
  }

  // Dấu «ngoài gói»: bỏ đúng dấu do salesAgentRedirectFor thêm, không đụng chuỗi khác.
  const khach = { isHome: false, brand: "chotdon" as const };
  const allMods = ["core", "work", ...AI_SALES_MODULES];
  const nguoi = [
    { role: "ADMIN", permissions: [] as string[], organization: khach, modules: allMods },
    { role: "VIEWER", permissions: ["products:view"], organization: khach, modules: allMods },
    { role: "VIEWER", permissions: [] as string[], organization: khach, modules: allMods },
  ];
  for (const u of nguoi) {
    for (const p of ["/", "/login", "/start", "/cockpit", "/inventory/planning"]) assert.equal(salesAgentHomeOfRedirect(salesAgentRedirectFor(u, p)), salesAgentHomeFor(u), `ngược của salesAgentRedirectFor(${u.role}, ${p})`);
  }
  assert.equal(salesAgentHomeOfRedirect(`${SALES_AGENT_INBOX_HREF}?${SHELL_BLOCKED_PARAM}=1`), SALES_AGENT_INBOX_HREF);
  assert.equal(salesAgentHomeOfRedirect("/products"), "/products");

  // Cổng MODULE của layout không bao giờ chuyển hướng người vỏ khỏi một trang vỏ mở được: ai_sales phụ thuộc mọi module mà các
  // trang ấy thuộc về — tắt một cái là tắt ai_sales, workspace thôi là vỏ (lib/constants/saas-nav.ts::salesAgentShell).
  const aiSales = PLATFORM_MODULES.find((m) => m.key === "ai_sales");
  assert.ok(aiSales);
  for (const prefix of SALES_AGENT_ALLOWED_PREFIXES) {
    const m = moduleOfPath(prefix);
    const def = m ? PLATFORM_MODULES.find((x) => x.key === m) : null;
    assert.ok(m === null || m === "ai_sales" || def?.core || aiSales.dependsOn.includes(m), `${prefix} thuộc module ${m} mà ai_sales không phụ thuộc — người vỏ có thể bị layout chuyển về /module-disabled (đúng vòng lặp F-01)`);
  }
}

/* ═════════════ 2 · MÁY CHỦ ═════════════ */
async function asRequest<T>(token: string | undefined, reqPath: string, fn: () => Promise<T>): Promise<T> {
  setSessionTokenSourceForTests(async () => token);
  setRequestPathSourceForTests(() => reqPath);
  try {
    return await fn();
  } finally {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
  }
}

async function kiemMayChu() {
  const dir = organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, "");
  rmSync(dir, { recursive: true, force: true });
  const pdb = await getPlatformDb();
  let failure: unknown = null;
  try {
    const prov = await provisionOrganization({ code: ORG, name: "Shop đích đăng nhập", modules: AI_SALES_MODULES, admin: { email: "chu@dich-dang-nhap.local", name: "Chủ shop", password: "Dich-dang-nhap@12345" }, source: "TEST", actor: null, brand: "chotdon" });
    assert.equal(prov.created, true);
    const admin = await withOrganization(ORG, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@dich-dang-nhap.local") }));
    assert.ok(admin);
    await withOrganization(ORG, async () => (await getDb()).insert(schema.users).values({ id: STAFF_ID, email: "kho@dich-dang-nhap.local", name: "Nhân viên kho", passwordHash: "x", role: "VIEWER", permissions: ["products:view"] }));
    const tokChu = await signSession({ id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", orgCode: ORG });
    const tokKho = await signSession({ id: STAFF_ID, email: "kho@dich-dang-nhap.local", name: "Nhân viên kho", role: "VIEWER", orgCode: ORG });

    // Lượt POST đăng nhập / đăng ký: cổng vỏ trả SHELL_RESTRICTED (đường không phải trang vỏ) — hàm đọc đúng trang nhà, bỏ dấu.
    for (const reqPath of ["/login", "/start"]) {
      const ket = await asRequest(tokChu, reqPath, () => resolveCurrentUser());
      assert.ok("denied" in ket && ket.denied === "SHELL_RESTRICTED", `${reqPath}: lượt POST của người vỏ phải gặp cổng vỏ (nhánh cần kiểm), nhận ${JSON.stringify(ket)}`);
      assert.equal(await asRequest(tokChu, reqPath, () => shellHomeOfSession()), SALES_AGENT_INBOX_HREF, `${reqPath}: chủ shop ⇒ hộp thư, KHÔNG kèm «ngoài gói»`);
      assert.equal(await asRequest(tokChu, reqPath, () => landingAfterSignIn("/")), SALES_AGENT_INBOX_HREF, `${reqPath}: next=/ ⇒ hộp thư một bước`);
      assert.equal(await asRequest(tokChu, reqPath, () => landingAfterSignIn(undefined)), SALES_AGENT_INBOX_HREF);
      for (const n of [...TAN_CONG, ...VO_CHAN]) assert.equal(await asRequest(tokChu, reqPath, () => landingAfterSignIn(n)), SALES_AGENT_INBOX_HREF, `${reqPath}: next=${JSON.stringify(n)} ⇒ hộp thư`);
      for (const n of VO_MO) assert.equal(await asRequest(tokChu, reqPath, () => landingAfterSignIn(n)), safeNextPath(n), `${reqPath}: ${n} ⇒ giữ`);
    }
    // Nhánh người dùng đi qua cổng (đường của vỏ): cùng câu trả lời.
    assert.equal(await asRequest(tokChu, "/ai/overview", () => shellHomeOfSession()), SALES_AGENT_INBOX_HREF, "nhánh { user } cho cùng trang nhà");

    // Nhân viên không đọc được hộp thư: trang nhà là mục đầu tiên họ còn thấy — đúng hàm cổng vỏ dùng, không bao giờ hộp thư.
    const quaCong = await asRequest(tokKho, "/products", () => resolveCurrentUser());
    assert.ok("user" in quaCong && isSalesAgentUser(quaCong.user), `nhân viên kho mở được /products, nhận ${JSON.stringify(quaCong)}`);
    const nhaKho = salesAgentHomeFor(quaCong.user);
    assert.notEqual(nhaKho, SALES_AGENT_INBOX_HREF, "ca kiểm phải là người KHÔNG có hộp thư");
    assert.equal(await asRequest(tokKho, "/login", () => landingAfterSignIn("/")), nhaKho, "nhân viên không có hộp thư ⇒ trang nhà của CHÍNH họ");
    assert.equal(await asRequest(tokKho, "/login", () => landingAfterSignIn("/cockpit")), nhaKho);

    // Không phiên (cookie chưa ghi được) ⇒ đường cũ, không làm hỏng lượt đăng nhập.
    for (const n of ["/", "/cockpit", "//evil.com"]) assert.equal(await asRequest(undefined, "/login", () => landingAfterSignIn(n)), safeNextPath(n));

    // Nhà: đúng safeNextPath, không bao giờ bị coi là vỏ.
    const home = await getHomeOrganization();
    await (await getDb()).insert(schema.users).values({ id: HOME_USER_ID, email: "admin@dich-dang-nhap-home.local", name: "Quản trị nhà (đích)", passwordHash: "x", role: "ADMIN" });
    const tokNha = await signSession({ id: HOME_USER_ID, email: "admin@dich-dang-nhap-home.local", name: "Quản trị nhà (đích)", role: "ADMIN", orgCode: home.code });
    for (const n of [undefined, ...TAN_CONG, ...VO_CHAN, ...VO_MO, "/marketing/creatives"]) assert.equal(await asRequest(tokNha, "/login", () => landingAfterSignIn(n)), safeNextPath(n), `nhà: next=${JSON.stringify(n)} y như cũ`);

    // Workspace không còn là vỏ (bỏ thương hiệu ⇒ menu ERP): y như cũ, kể cả next=/.
    await pdb.update(schema.platformOrganizations).set({ brand: null }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    for (const n of ["/", "/cockpit", "/orders/123", "//evil.com"]) assert.equal(await asRequest(tokChu, "/login", () => landingAfterSignIn(n)), safeNextPath(n), `không thuộc vỏ: next=${n} y như cũ`);
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    await (await getDb()).delete(schema.users).where(eq(schema.users.id, HOME_USER_ID));
    await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    invalidateCapabilities(ORG);
    rmSync(dir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[shell-login-landing] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
}

/* ═════════════ 3 · MÃ NGUỒN ═════════════ */
function thanHam(src: string, ten: string): string {
  const dau = src.indexOf(`export async function ${ten}(`);
  assert.ok(dau >= 0, `không thấy ${ten}`);
  const sau = src.indexOf("\nexport ", dau + 1);
  // Bỏ chú thích: đoạn GIẢI THÍCH vì sao bỏ `redirect("/")` không phải là lời gọi.
  return src
    .slice(dau, sau < 0 ? undefined : sau)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function kiemMaNguon() {
  const auth = thanHam(readFileSync(path.join(goc, "lib", "actions", "auth.ts"), "utf8"), "loginAction");
  const qs = thanHam(readFileSync(path.join(goc, "lib", "actions", "onboarding.ts"), "utf8"), "quickSignupAction");
  for (const [ten, than, moPhien] of [
    ["loginAction", auth, "verifyLogin("],
    ["quickSignupAction", qs, "quickSignup("],
  ] as const) {
    assert.ok(!/redirect\(\s*"\/"\s*\)/.test(than) && !/\?\s*"\/"\s*:/.test(than), `${ten}: không còn redirect("/") trần — với người vỏ đó là trang trắng (F-01)`);
    assert.ok(!than.includes("redirect(safeNextPath("), `${ten}: đích phải qua landingAfterSignIn (safeNextPath nằm trong đó)`);
    const i = than.indexOf("landingAfterSignIn(");
    assert.ok(i > 0, `${ten}: phải tính đích bằng landingAfterSignIn`);
    assert.ok(than.indexOf(moPhien) >= 0 && than.indexOf(moPhien) < i, `${ten}: đích tính SAU khi đã mở phiên (${moPhien}) — trước đó cổng vỏ chưa biết người này là ai`);
  }
  // Không ai gọi móc kiểm thử trong mã sản phẩm của đường này.
  const landing = readFileSync(path.join(goc, "lib", "saas", "shell-landing.ts"), "utf8");
  assert.ok(!/ForTests\(/.test(landing), "shell-landing không được dùng móc kiểm thử");
}

export async function testShellLoginLanding() {
  kiemThuan();
  kiemMaNguon();
  await kiemMayChu();
  console.log("✓ Đích sau đăng nhập / đăng ký của vỏ Chốt Đơn (F-01): người vỏ ⇒ trang nhà của vỏ một bước (không qua `/` mà layout chuyển hướng) · next vỏ mở được thì giữ · next chặn / ngoài miền / //evil ⇒ trang nhà · nhà và workspace không thuộc vỏ ⇒ đúng safeNextPath · không phiên ⇒ đường cũ");
}

if (process.argv[1] && /shell-login-landing\.test\.ts$/.test(process.argv[1])) {
  testShellLoginLanding().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
