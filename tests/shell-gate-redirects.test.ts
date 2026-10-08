/**
 * ═══════════ ĐÍCH CHUYỂN HƯỚNG CỦA CỔNG KHÔNG BAO GIỜ LÀ MỘT TRANG MÀ CHÍNH LAYOUT CHẶN ═══════════
 *
 * Cơ chế (đo ở #671, chú thích đầu `lib/saas/shell-landing.ts`): khi layout `(dashboard)` được dựng TỪ GỐC trong một lượt RSC —
 * server action `redirect(X)` (máy chủ tự xin RSC của X, xoá cây định tuyến), `router.refresh()`, điều hướng client từ trang ngoài
 * nhóm — mà chính layout ấy ném `redirect(Y)` với Y nằm DƯỚI cùng layout, client giữ nút layout mang lỗi, chỉ xin phần dưới
 * layout cho Y, dựng lại lại ném ⇒ `router.replace` hàng nghìn lần, TRANG TRẮNG. #671 vá đường đăng nhập / đăng ký; còn hai nguồn,
 * cả hai vá ở ĐÍCH — không đổi luật quyền nào (AGENTS luật 28: một chỗ tính quyền):
 *
 *  1. Cổng QUYỀN — `requirePermission` · `requireUser(roles)` · `requireResource` (đi qua `requirePermission`) — đưa người thiếu
 *     quyền về `/?forbidden=1`. Người vỏ Chốt Đơn: `/` bị CHÍNH layout chặn (SHELL_RESTRICTED) ⇒ mọi server action từ chối người
 *     vỏ là một trang trắng. Nay `forbiddenRedirectFor`: người vỏ ⇒ trang nhà của vỏ `?forbidden=1` (vỏ in «Bạn không có quyền…»),
 *     ERP ⇒ `/?forbidden=1` y như cũ.
 *  2. Cổng MODULE của layout đưa về `/module-disabled` — trang từng nằm TRONG nhóm `(dashboard)` (mọi tổ chức, kể cả ERP: đăng nhập
 *     với `next` là trang của module tắt, làm mới trang khi module vừa tắt). Nay trang đứng NGOÀI nhóm.
 *
 * Bài này khoá:
 *  A. THUẦN — `forbiddenRedirectFor` trên MỌI tổ hợp vai trò × quyền của mục menu vỏ: ERP ⇒ đúng `/?forbidden=1`; vỏ ⇒ trang nhà
 *     của vỏ, trang ấy cổng vỏ mở được và người đó thấy mục của nó (đúng quyền trang đích tự đòi), cùng host, chuỗi chỉ ghép từ
 *     hằng (không open redirect); `shellNoticeOf` đọc đúng tham số, kể cả đọc lại chính đích vừa dựng.
 *  B. MÁY CHỦ (PGlite, tổ chức `sgr-cong` tự cấp, tự dọn) — người vỏ bị `requirePermission` / `requireUser(roles)` /
 *     `requireResource` từ chối ⇒ trang nhà `?forbidden=1`, và CHÍNH cổng cho đích ấy đi qua (layout không chuyển hướng lần hai);
 *     chủ shop bị từ chối vì module ERP tắt ⇒ hộp thư `?forbidden=1`; người ERP ⇒ `/?forbidden=1`; module tắt ⇒
 *     `/module-disabled?m=…` và cổng cho đích ấy đi qua.
 *  C. MÃ NGUỒN — không `?forbidden=1` trần nào trỏ vào trang vỏ chặn ở chỗ người vỏ chạm tới; đích cố định mà layout ném cho một
 *     lượt GET nằm ngoài `app/(dashboard)`; trang `/module-disabled` thoát ra bằng `<a>` (tải cả trang), không `<Link>`.
 *
 * Kiểm bằng trình duyệt (không vào npm test — kho không có hạ tầng trình duyệt): số đo trước / sau ghi ở commit.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { can, requirePermission, requireUser, resolveCurrentUser, setRequestPathSourceForTests, signSession } from "@/lib/auth/session";
import { requireResource } from "@/lib/auth/scope-guard";
import { moduleOfPermission } from "@/lib/constants/platform-modules";
import {
  FORBIDDEN_PARAM,
  forbiddenRedirectFor,
  isSalesAgentUser,
  SALES_AGENT_INBOX_HREF,
  SALES_AGENT_SETTINGS_HREF,
  salesAgentHomeFor,
  salesAgentNavFor,
  salesAgentPathAllowed,
  SHELL_BLOCKED_MESSAGE,
  SHELL_BLOCKED_PARAM,
  SHELL_FORBIDDEN_MESSAGE,
  shellNoticeOf,
  type ShellUser,
} from "@/lib/constants/saas-nav";
import { BILLING_LOCKED_PATH, MODULE_DISABLED_PATH } from "@/lib/constants/session-revocation";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { setSessionTokenSourceForTests, withOrganization } from "@/lib/platform/context";
import { getHomeOrganization, invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";

const goc = path.resolve(__dirname, "..");
const ORG = "sgr-cong";
const STAFF_ID = "sgr-cong-nv";
const HOME_VIEWER_ID = "sgr-cong-home-viewer";
const APP = "https://app.chotdontudong.com";
const ERP_DICH = "/?forbidden=1";
/** Đúng bộ module của mẫu «Chỉ cần AI bán hàng» (như tests/saas-shell.test.ts, tests/shell-login-landing.test.ts). */
const AI_SALES_MODULES = ["customers", "products", "orders", "inventory", "ai_sales"];
const SHELL_ORG = { isHome: false, brand: "chotdon" as const };
const ROLES = ["ADMIN", "MANAGER", "LEADER", "ACCOUNTANT", "WAREHOUSE", "CS", "MARKETING", "VIEWER"];
/** Khoá quyền mà các mục menu vỏ đòi — đủ để dựng MỌI trang nhà có thể có. Thêm hai khoá ERP để chắc chúng không đổi kết quả. */
const NAV_PERMS = ["ai_sales:view", "products:view", "users:manage", "settings:manage", "shipments:manage", "dashboard:view"];

function oCungHost(r: string, ten: string) {
  assert.ok(r.startsWith("/") && !r.startsWith("//") && !r.includes("\\"), `${ten}: đích ${JSON.stringify(r)} phải là đường nội bộ`);
  assert.equal(new URL(r, APP).host, new URL(APP).host, `${ten}: đích phải ở lại cùng host`);
}

/* ═════════════ A · THUẦN ═════════════ */
function kiemThuan() {
  assert.equal(FORBIDDEN_PARAM, "forbidden", "ERP và vỏ đọc CÙNG một tên tham số — trang ERP đã dùng `?forbidden=1` từ trước");

  // ERP / nhà / workspace không thuộc vỏ: đích cũ, từng chữ.
  const erp: [string, ShellUser][] = [
    ["người dựng tay không tổ chức", { role: "VIEWER", permissions: [] }],
    ["nhà (kể cả khi bật ai_sales)", { role: "ADMIN", permissions: [], organization: { isHome: true, brand: null }, modules: AI_SALES_MODULES }],
    ["tổ chức trước 0215 (thương hiệu NULL)", { role: "CS", permissions: [], organization: { isHome: false, brand: null }, modules: AI_SALES_MODULES }],
    ["thương hiệu VNX", { role: "CS", permissions: [], organization: { isHome: false, brand: "vnx" }, modules: AI_SALES_MODULES }],
    ["Chốt Đơn nhưng thuê ERP (bật giao vận)", { role: "ADMIN", permissions: [], organization: SHELL_ORG, modules: [...AI_SALES_MODULES, "logistics"] }],
    ["Chốt Đơn không mang tập module", { role: "ADMIN", permissions: [], organization: SHELL_ORG }],
  ];
  for (const [ten, u] of erp) {
    assert.equal(isSalesAgentUser(u), false, `${ten}: không thuộc vỏ`);
    assert.equal(forbiddenRedirectFor(u), ERP_DICH, `${ten}: giữ nguyên /?forbidden=1`);
  }

  // Vỏ: MỌI vai trò × MỌI tập con quyền của mục menu ⇒ trang nhà của vỏ, không bao giờ `/`.
  const gap = new Set<string>();
  for (const role of ROLES) {
    for (let mask = 0; mask < 1 << NAV_PERMS.length; mask++) {
      const u: ShellUser = { role, permissions: NAV_PERMS.filter((_, i) => mask & (1 << i)), organization: SHELL_ORG, modules: AI_SALES_MODULES };
      assert.equal(isSalesAgentUser(u), true);
      const dich = forbiddenRedirectFor(u);
      const ten = `${role} ${JSON.stringify(u.permissions)}`;
      const [duong, query, ...thua] = dich.split("?");
      assert.equal(thua.length, 0, `${ten}: đích có đúng một dấu «?»`);
      assert.equal(query, `${FORBIDDEN_PARAM}=1`, `${ten}: kèm tham số để vỏ nói vì sao`);
      assert.equal(duong, salesAgentHomeFor(u), `${ten}: về ĐÚNG trang nhà của vỏ (hàm cổng vỏ dùng), không luật thứ hai`);
      assert.notEqual(duong, "/", `${ten}: người vỏ không bao giờ về «/» — layout vỏ chặn «/» ⇒ vòng trang trắng`);
      assert.ok(salesAgentPathAllowed(dich), `${ten}: cổng vỏ phải cho ${dich} đi qua — nếu không layout chuyển hướng lần hai`);
      assert.ok(salesAgentNavFor(u).some((i) => i.href === duong), `${ten}: ${duong} phải là mục người này THẤY (đúng quyền trang đích tự đòi)`);
      oCungHost(dich, ten);
      gap.add(duong);
    }
  }
  assert.ok(gap.has(SALES_AGENT_INBOX_HREF) && gap.has("/products") && gap.has(SALES_AGENT_SETTINGS_HREF), `bộ tổ hợp phải chạm đủ ba loại trang nhà, thấy ${[...gap].join(", ")}`);
  assert.equal(forbiddenRedirectFor({ role: "ADMIN", permissions: [], organization: SHELL_ORG, modules: AI_SALES_MODULES }), `${SALES_AGENT_INBOX_HREF}?forbidden=1`, "chủ shop ⇒ hộp thư");
  assert.equal(forbiddenRedirectFor({ role: "VIEWER", permissions: ["products:view"], organization: SHELL_ORG, modules: AI_SALES_MODULES }), "/products?forbidden=1", "nhân viên chỉ xem sản phẩm ⇒ Sản phẩm");
  assert.equal(forbiddenRedirectFor({ role: "VIEWER", permissions: [], organization: SHELL_ORG, modules: AI_SALES_MODULES }), `${SALES_AGENT_SETTINGS_HREF}?forbidden=1`, "không quyền nào ⇒ Cài đặt (mục không đòi quyền)");

  // Câu vỏ in: đọc từ tham số, hai lý do hai câu, giá trị khác «1» không tính.
  const doc = (qs: string) => {
    const sp = new URLSearchParams(qs);
    return (k: string) => sp.get(k);
  };
  assert.match(SHELL_FORBIDDEN_MESSAGE, /không có quyền/i, "câu phải nói thẳng «không có quyền»");
  assert.notEqual(SHELL_FORBIDDEN_MESSAGE, SHELL_BLOCKED_MESSAGE, "«ngoài gói» và «không có quyền» là hai câu — gộp là đẩy người đọc đi sửa nhầm chỗ");
  assert.deepEqual(shellNoticeOf(doc(`${FORBIDDEN_PARAM}=1`)), { kind: FORBIDDEN_PARAM, text: SHELL_FORBIDDEN_MESSAGE });
  assert.deepEqual(shellNoticeOf(doc(`${SHELL_BLOCKED_PARAM}=1`)), { kind: SHELL_BLOCKED_PARAM, text: SHELL_BLOCKED_MESSAGE });
  for (const qs of ["", `${FORBIDDEN_PARAM}=0`, `${FORBIDDEN_PARAM}=true`, `${SHELL_BLOCKED_PARAM}=yes`, "x=1"]) assert.equal(shellNoticeOf(doc(qs)), null, `«${qs}» không in câu nào`);
  // Đọc lại CHÍNH đích vừa dựng: vỏ in đúng câu «không có quyền» ở trang nhà.
  const chu: ShellUser = { role: "ADMIN", permissions: [], organization: SHELL_ORG, modules: AI_SALES_MODULES };
  const url = new URL(forbiddenRedirectFor(chu), APP);
  assert.equal(shellNoticeOf((k) => url.searchParams.get(k))?.kind, FORBIDDEN_PARAM);
}

/* ═════════════ B · MÁY CHỦ ═════════════ */
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

/** Đích của `redirect()` mà hàm ném ra — `""` = không chuyển hướng. */
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

/** Cổng cho đích này đi qua — tức layout `(dashboard)` dựng đích mà KHÔNG ném chuyển hướng lần hai. */
async function congChoQua(token: string, dich: string, ten: string) {
  const ket = await asRequest(token, dich.split("?")[0], () => resolveCurrentUser());
  assert.ok("user" in ket, `${ten}: cổng phải cho ${dich} đi qua (nếu không, layout chuyển hướng lần hai — đúng vòng trắng), nhận ${JSON.stringify(ket)}`);
  assert.equal(await asRequest(token, dich.split("?")[0], () => redirectTarget(() => requireUser())), "", `${ten}: requireUser ở ${dich} không chuyển hướng`);
}

async function kiemMayChu() {
  const dir = organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, "");
  rmSync(dir, { recursive: true, force: true });
  const pdb = await getPlatformDb();
  let failure: unknown = null;
  try {
    const prov = await provisionOrganization({ code: ORG, name: "Shop cổng chuyển hướng", modules: AI_SALES_MODULES, admin: { email: "chu@sgr-cong.local", name: "Chủ shop", password: "Sgr-cong@12345" }, source: "TEST", actor: null, brand: "chotdon" });
    assert.equal(prov.created, true);
    const admin = await withOrganization(ORG, async () => (await getDb()).query.users.findFirst({ where: eq(schema.users.email, "chu@sgr-cong.local") }));
    assert.ok(admin);
    await withOrganization(ORG, async () => (await getDb()).insert(schema.users).values({ id: STAFF_ID, email: "nv@sgr-cong.local", name: "Nhân viên", passwordHash: "x", role: "VIEWER", permissions: ["products:view"] }));
    const tokChu = await signSession({ id: admin.id, email: admin.email, name: admin.name, role: "ADMIN", orgCode: ORG });
    const tokNv = await signSession({ id: STAFF_ID, email: "nv@sgr-cong.local", name: "Nhân viên", role: "VIEWER", orgCode: ORG });

    // Nhân viên vỏ (chỉ xem sản phẩm) bấm một nút ở /settings/branding mà action đòi settings:manage — đúng lượt POST thật.
    const nv = await asRequest(tokNv, "/settings/branding", () => resolveCurrentUser());
    assert.ok("user" in nv && isSalesAgentUser(nv.user), `ca kiểm phải là người vỏ đi qua cổng, nhận ${JSON.stringify(nv)}`);
    const nhaNv = `${salesAgentHomeFor(nv.user)}?${FORBIDDEN_PARAM}=1`;
    assert.equal(nhaNv, "/products?forbidden=1");
    const lanGoi: [string, () => Promise<unknown>][] = [
      ["requirePermission(settings:manage)", () => requirePermission("settings:manage")],
      ["requireUser([ACCOUNTANT])", () => requireUser(["ACCOUNTANT"])],
      ["requireResource(WORK, work:department)", () => requireResource("WORK", "work:department")],
    ];
    for (const [ten, fn] of lanGoi) {
      const dich = await asRequest(tokNv, "/settings/branding", () => redirectTarget(fn));
      assert.equal(dich, nhaNv, `nhân viên vỏ — ${ten}: về trang nhà của vỏ kèm ?forbidden=1, KHÔNG về «/» (vỏ chặn ⇒ trang trắng)`);
      await congChoQua(tokNv, dich, `nhân viên vỏ — ${ten}`);
    }
    // Trang nhà đòi đúng quyền người ấy có — không bị đá tiếp.
    assert.equal(await asRequest(tokNv, "/products", () => redirectTarget(() => requirePermission("products:view"))), "", "trang nhà không từ chối chính người được đưa về");

    // Chủ shop: ADMIN vẫn bị cổng MODULE trong `can()` từ chối khoá của module ERP đang tắt ⇒ hộp thư, không «/».
    assert.ok("user" in (await asRequest(tokChu, "/orders/1", () => resolveCurrentUser())));
    const khoaErp = "shipments:manage";
    assert.ok(moduleOfPermission(khoaErp) && !AI_SALES_MODULES.includes(moduleOfPermission(khoaErp) as string), "khoá thử phải thuộc một module ERP vỏ không bật");
    const chuUser = await asRequest(tokChu, "/orders/1", () => resolveCurrentUser());
    assert.ok("user" in chuUser && !can(chuUser.user, khoaErp), "tiền đề: chủ shop không có khoá của module tắt");
    const dichChu = await asRequest(tokChu, "/orders/1", () => redirectTarget(() => requirePermission(khoaErp)));
    assert.equal(dichChu, `${SALES_AGENT_INBOX_HREF}?${FORBIDDEN_PARAM}=1`, "chủ shop ⇒ hộp thư ?forbidden=1");
    await congChoQua(tokChu, dichChu, "chủ shop");

    // Bỏ thương hiệu (tổ chức trước 0215 ⇒ không thuộc vỏ, ERP thu nhỏ): đích cũ, và cổng module đưa về /module-disabled.
    await pdb.update(schema.platformOrganizations).set({ brand: null }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    for (const [ten, fn] of lanGoi) assert.equal(await asRequest(tokNv, "/settings/branding", () => redirectTarget(fn)), ERP_DICH, `ERP — ${ten}: giữ nguyên /?forbidden=1`);
    const md = await asRequest(tokChu, "/shipments", () => redirectTarget(() => requireUser()));
    assert.equal(md, `${MODULE_DISABLED_PATH}?m=logistics`, "module tắt ⇒ trang giải thích");
    await congChoQua(tokChu, md, "module tắt");

    // Nhà: đích cũ, từng chữ.
    const home = await getHomeOrganization();
    await (await getDb()).insert(schema.users).values({ id: HOME_VIEWER_ID, email: "xem@sgr-cong-home.local", name: "Người xem nhà (sgr)", passwordHash: "x", role: "VIEWER" });
    const tokNha = await signSession({ id: HOME_VIEWER_ID, email: "xem@sgr-cong-home.local", name: "Người xem nhà (sgr)", role: "VIEWER", orgCode: home.code });
    for (const [ten, fn] of lanGoi) assert.equal(await asRequest(tokNha, "/settings/branding", () => redirectTarget(fn)), ERP_DICH, `nhà — ${ten}: giữ nguyên /?forbidden=1`);
  } catch (error) {
    failure = error;
  }
  try {
    setSessionTokenSourceForTests(null);
    setRequestPathSourceForTests(null);
    await (await getDb()).delete(schema.users).where(eq(schema.users.id, HOME_VIEWER_ID));
    await pdb.update(schema.platformOrganizations).set({ status: "ARCHIVED" }).where(eq(schema.platformOrganizations.code, ORG));
    invalidateOrganizations();
    invalidateCapabilities(ORG);
    rmSync(dir, { recursive: true, force: true });
  } catch (cleanupError) {
    if (!failure) throw cleanupError;
    console.error("[shell-gate-redirects] dọn dẹp cũng lỗi (lỗi chính ở dưới):", cleanupError);
  }
  if (failure) throw failure;
}

/* ═════════════ C · MÃ NGUỒN ═════════════ */

/** Bỏ chú thích: đoạn GIẢI THÍCH vì sao bỏ `/?forbidden=1` không phải là lời gọi. */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function thanHam(src: string, dau: string): string {
  const i = src.indexOf(dau);
  assert.ok(i >= 0, `không thấy «${dau}»`);
  const sau = src.indexOf("\nexport ", i + 1);
  return boChuThich(src.slice(i, sau < 0 ? undefined : sau));
}

/** URL của một tệp trong `app/` — bỏ nhóm `(x)` và tên tệp; đoạn động `[id]` ⇒ `x` (đủ để hỏi cổng vỏ). */
function duongCuaTep(file: string): string {
  const doan = file
    .replace(/^app\//, "")
    .split("/")
    .slice(0, -1)
    .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@"))
    .map((s) => (s.startsWith("[") ? "x" : s));
  return `/${doan.join("/")}`;
}

function kiemMaNguon() {
  const session = readFileSync(path.join(goc, "lib", "auth", "session.ts"), "utf8");
  for (const dau of ["export async function requireUser(", "export async function requirePermission("]) {
    const than = thanHam(session, dau);
    assert.ok(!than.includes("forbidden=1"), `${dau}: không còn đích «?forbidden=1» viết tay — người vỏ về «/» là trang trắng`);
    assert.match(than, /redirect\(forbiddenRedirectFor\(user\)\)/, `${dau}: đích từ chối qua forbiddenRedirectFor (một hàm cho ERP và vỏ)`);
  }
  const scope = thanHam(readFileSync(path.join(goc, "lib", "auth", "scope-guard.ts"), "utf8"), "export async function requireResource(");
  assert.match(scope, /await requirePermission\(permission\)/, "requireResource đi qua requirePermission — cùng đích từ chối");
  assert.ok(!/redirect\(/.test(scope), "requireResource không tự chuyển hướng");

  const tracked = execFileSync("git", ["ls-files", "app", "lib", "components"], { cwd: goc, encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f));
  assert.ok(tracked.length > 500, `đọc hụt mã nguồn (${tracked.length} tệp)`);

  /*
    Mọi đích «…?forbidden=1» viết tay. Chỉ an toàn ở trang ERP mà cổng vỏ chặn TRƯỚC khi thân trang chạy (layout + `requireUser`
    của chính trang) — người vỏ không bao giờ tới dòng ấy. Ở `lib/`, `components/`, API và trang vỏ mở được, đích phải là trang
    vỏ mở được, nếu không thì phải đi qua `forbiddenRedirectFor`.
  */
  const thay: { file: string; target: string }[] = [];
  for (const file of tracked) {
    const src = boChuThich(readFileSync(path.join(goc, file), "utf8"));
    for (const m of src.matchAll(/["'`](\/[^"'`?\s]*)\?forbidden=1["'`&]/g)) thay.push({ file, target: m[1] });
  }
  assert.ok(thay.some((t) => t.file === "app/(dashboard)/platform/page.tsx"), "bộ quét phải thấy đích viết tay ở trang ERP (vd /platform) — không thấy là bộ quét hỏng");
  const viPham = thay.filter(({ file, target }) => {
    const nguoiVoToiDuoc = !file.startsWith("app/") || file.startsWith("app/api/") || salesAgentPathAllowed(duongCuaTep(file));
    return nguoiVoToiDuoc && !salesAgentPathAllowed(target);
  });
  assert.deepEqual(viPham, [], `đích «?forbidden=1» trỏ vào trang vỏ chặn ở chỗ người vỏ chạm tới — trang trắng: ${viPham.map((v) => `${v.file} → ${v.target}`).join(" · ")}`);

  /*
    Đích CỐ ĐỊNH mà `requireUser()` của layout ném ra trong một lượt GET phải là trang NGOÀI `app/(dashboard)`: đích ở trong
    nhóm thì client xin phần DƯỚI layout, giữ nút layout hỏng ⇒ vòng trắng. (Đích SHELL_RESTRICTED là trang nhà của vỏ — tính
    theo người, khoá ở phần A: cổng vỏ luôn cho nó đi qua.)
  */
  const pageFiles = tracked.filter((f) => f.startsWith("app/") && /\/page\.tsx$/.test(f));
  const tepCuaDuong = (url: string) => pageFiles.filter((f) => duongCuaTep(f) === url);
  for (const dich of ["/login", MODULE_DISABLED_PATH]) {
    const tep = tepCuaDuong(dich);
    assert.equal(tep.length, 1, `${dich}: đúng một trang phục vụ, thấy ${tep.join(", ")}`);
    assert.ok(!tep[0].startsWith("app/(dashboard)/"), `${dich}: đích layout ném phải nằm NGOÀI app/(dashboard) — ${tep[0]}`);
  }
  /*
    MIỄN TRỪ CÓ LÝ DO: `/billing-locked` vẫn ở trong nhóm. Cổng chỉ trả BILLING_LOCKED cho lượt GHI (POST), và mọi server action
    gọi `requireUser` / `requirePermission` TRƯỚC khi ghi ⇒ action tự chuyển hướng, máy chủ dựng `/billing-locked` bằng một lượt
    GET mà layout không chặn. Layout chỉ ném nó nếu một action KHÔNG qua cổng mà vẫn `revalidatePath` — chưa có đường nào như vậy.
  */
  assert.ok(tepCuaDuong(BILLING_LOCKED_PATH).every((f) => f.startsWith("app/(dashboard)/")), "đổi chỗ /billing-locked thì xoá miễn trừ này");
  assert.ok(!tracked.some((f) => f.startsWith("app/(dashboard)/module-disabled/")), "không còn bản /module-disabled nào trong nhóm (dashboard)");

  // Lối RA khỏi /module-disabled: tải cả trang. `<Link>` từ trang ngoài nhóm vào `(dashboard)` dựng layout trong một lượt RSC.
  const md = readFileSync(path.join(goc, tepCuaDuong(MODULE_DISABLED_PATH)[0]), "utf8");
  const mdMa = boChuThich(md);
  assert.ok(!/from "next\/link"/.test(mdMa) && !/<Link\b/.test(mdMa) && !/router\.(?:push|replace)\(/.test(mdMa), "/module-disabled: không điều hướng client vào (dashboard)");
  assert.match(mdMa, /<a href=\{home\}/, "/module-disabled: «về trang chính» là <a> tải cả trang");
  assert.match(mdMa, /salesAgentHomeFor\(user\)/, "/module-disabled: người vỏ về trang nhà của vỏ, không về «/»");
  assert.match(mdMa, /requireUser\(\)/, "/module-disabled: vẫn đòi đăng nhập");

  // Vỏ in câu «không có quyền» — cùng một chỗ in câu «ngoài gói», đọc qua shellNoticeOf.
  const shell = boChuThich(readFileSync(path.join(goc, "components", "saas-shell.tsx"), "utf8"));
  assert.match(shell, /shellNoticeOf\(/, "vỏ đọc câu thông báo qua shellNoticeOf");
}

export async function testShellGateRedirects() {
  kiemThuan();
  kiemMaNguon();
  await kiemMayChu();
  console.log(
    "✓ Cổng không chuyển hướng vào trang chính layout chặn: thiếu quyền (requirePermission · requireUser(roles) · requireResource) ⇒ người vỏ về trang nhà của vỏ ?forbidden=1, ERP / nhà giữ /?forbidden=1 · /module-disabled đứng ngoài (dashboard), lối ra tải cả trang · không đích viết tay nào trỏ người vỏ vào trang vỏ chặn",
  );
}

if (process.argv[1] && /shell-gate-redirects\.test\.ts$/.test(process.argv[1])) {
  testShellGateRedirects().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
