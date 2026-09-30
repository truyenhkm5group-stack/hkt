/**
 * NỀN TẢNG · GIAO DIỆN MODULE THEO TỔ CHỨC — menu lọc theo module, chuông theo module «Cần xử lý»,
 * bảng cấu hình module, trang sức khoẻ nền tảng, lõi của ba server action.
 *
 * Server action (`lib/actions/platform-modules.ts`) đọc cookie của Next nên không gọi được ngoài
 * request; bài này gọi LÕI của chúng (`lib/platform-ui/module-toggle.ts`) với `SessionUser` dựng tay —
 * cùng hàm action gọi, không nhánh riêng cho kiểm thử. Phần còn lại của action chỉ là
 * `requirePermission` + `revalidatePath`.
 *
 * Tự dọn: tổ chức mang tiền tố `pu-`; thư mục CSDL xoá trước khi cấp, dòng mặt phẳng điều khiển xoá
 * khi xong (nhật ký nền tảng giữ lại — nó chỉ thêm, đúng như production).
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDbFor, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { allowedNavItems, bellShowsSharedQueue, foldsHubs, hubTools, menuActiveHref, visible, visibleGroups, type NavUserLike } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { FOOD_COMMERCE_BLUEPRINT } from "@/lib/blueprints/templates/food-commerce";
import { hubMembers, NAV_HUB_HREFS, NAV_MODULES, type ModuleSpec } from "@/lib/constants/department-modules";
import { MODULE_KEYS, moduleOfPath, PLATFORM_MODULES, resolveEnabledModules, validateModuleChange } from "@/lib/constants/platform-modules";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { platformOperatorDenial, toggleModuleForOrganization, toggleOwnFeature, toggleOwnModule } from "@/lib/platform-ui/module-toggle";
import { getPlatformHealth, readJournalCount } from "@/lib/queries/platform-health";
import { buildModuleView, getOrganizationModuleView } from "@/lib/queries/platform-modules";

const ORG = "pu-mono";

function navItem(href: string): ModuleSpec {
  const item = NAV_MODULES.find((m) => m.href === href);
  assert.ok(item, `sổ menu phải có ${href}`);
  return item;
}

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pu-user", email: "pu@local", name: "PU", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

function testMenuPure() {
  const production = navItem("/production");
  const planning = navItem("/inventory/planning");
  const inventory = navItem("/inventory");
  assert.equal(moduleOfPath(planning.href), "production", "tiền đề: /inventory/planning thuộc Sản xuất");

  const withoutProduction = MODULE_KEYS.filter((k) => k !== "production");
  const admin: NavUserLike = { role: "ADMIN", permissions: [], modules: withoutProduction };
  assert.equal(visible(production, admin), false, "module Sản xuất tắt ⇒ ẩn /production, KỂ CẢ ADMIN");
  assert.equal(visible(planning, admin), false, "khớp tiền tố dài nhất: /inventory/planning ẩn theo Sản xuất");
  assert.equal(visible(inventory, admin), true, "/inventory vẫn hiện — Kho đang bật");
  assert.equal(visible(production, { ...admin, modules: [...MODULE_KEYS] }), true, "module bật ⇒ ADMIN thấy");
  assert.equal(visible(production, { role: "ADMIN", permissions: [] }), true, "`modules` vắng mặt ⇒ không lọc gì (hành vi cũ)");
  const viewer: NavUserLike = { role: "VIEWER", permissions: ["planning:view"], modules: [...MODULE_KEYS] };
  assert.equal(visible(production, viewer), true, "module bật + có quyền ⇒ hiện");
  assert.equal(visible(production, { ...viewer, permissions: [] }), false, "module bật nhưng thiếu quyền ⇒ ẩn (luật cũ còn nguyên)");
  assert.equal(visible(production, { ...viewer, modules: withoutProduction }), false, "có quyền mà module tắt ⇒ ẩn");

  // Ô lệnh ⌘K và thanh menu đọc cùng hàm.
  assert.ok(!allowedNavItems(admin).some((i) => i.href === "/production" || i.href === "/models"), "⌘K không gợi ý trang của module tắt");
  assert.ok(allowedNavItems({ role: "ADMIN", permissions: [] }).some((i) => i.href === "/production"));
  const coreOnly: NavUserLike = { role: "ADMIN", permissions: [], modules: ["core", "work"] };
  const hrefs = visibleGroups(coreOnly).flatMap((g) => g.items.map((i) => i.href));
  assert.ok(hrefs.includes("/settings/modules") && hrefs.includes("/"), "tổ chức chỉ có lõi vẫn thấy màn hình quản trị module");
  // «Vận hành nền tảng» là khoá chỉ-nhà (`homeOrgPermissionDenied`, cùng luật với can()): phiên không mang tổ chức nhà ⇒
  // KHÔNG hiện, kể cả ADMIN (bài chấp nhận Phase 12, lỗi #2); ADMIN của tổ chức nhà vẫn thấy.
  assert.ok(!hrefs.includes("/platform"), "ADMIN không mang tổ chức nhà không thấy /platform");
  assert.ok(visibleGroups({ ...coreOnly, organization: { isHome: true } }).some((g) => g.items.some((i) => i.href === "/platform")), "ADMIN tổ chức nhà vẫn thấy /platform");
  assert.ok(!hrefs.includes("/orders") && !hrefs.includes("/alerts"), "tổ chức chỉ có lõi không thấy trang nghiệp vụ nào");
  for (const h of hrefs) assert.ok(["core", "work"].includes(moduleOfPath(h) ?? ""), `${h} hiện với tổ chức chỉ-lõi mà không thuộc lõi`);
  assert.equal(moduleOfPath("/settings/modules"), "core");
  assert.equal(moduleOfPath("/platform"), "core");
  assert.equal(moduleOfPath("/module-disabled"), "core");

  // Chuông: `/api/notifications` gác bằng `alerts:view` (module «Cần xử lý»).
  const withoutAlerts = MODULE_KEYS.filter((k) => k !== "alerts");
  assert.equal(bellShowsSharedQueue({ role: "ADMIN", permissions: [], modules: withoutAlerts }), false, "tắt «Cần xử lý» ⇒ chuông không hỏi hàng đợi chung (kể cả ADMIN)");
  assert.equal(bellShowsSharedQueue({ role: "ADMIN", permissions: [], modules: [...MODULE_KEYS] }), true);
  assert.equal(bellShowsSharedQueue({ role: "ADMIN", permissions: [] }), true, "`modules` vắng mặt ⇒ như cũ");
  assert.equal(bellShowsSharedQueue({ role: "CS", permissions: ["alerts:view"], modules: [...MODULE_KEYS] }), true);
  assert.equal(bellShowsSharedQueue({ role: "CS", permissions: [], modules: [...MODULE_KEYS] }), false, "không có alerts:view ⇒ không hỏi (từng nhận 403 mỗi 30 giây)");
}

/** Mười công cụ dựng cấu hình gom vào «Tuỳ biến nâng cao» ở tổ chức khách (chủ shop 30/09/2026). */
const BUILDER_HREFS = ["/settings/data-model", "/settings/forms", "/settings/lists", "/settings/statuses", "/settings/workflows", "/settings/pages", "/settings/templates", "/settings/export", "/settings/objects", "/settings/ai-builder"];
/** Năm trang chỉ có nghĩa với connector chỉ-nhà (Viettel Post / Pancake) — ẩn khỏi menu tổ chức khách. */
const HOME_DATA_HREFS = ["/shipments", "/cs", "/data-quality", "/products/performance", "/inventory/packing"];
/** Mục quản trị vẫn đứng riêng ở tổ chức khách. */
const SEPARATE_ADMIN_HREFS = ["/settings/users", "/audit", "/settings/modules", "/settings/connections", "/setup", "/settings/notifications"];

/**
 * MENU TỔ CHỨC KHÁCH: một mục «Tuỳ biến nâng cao» thay mười công cụ, và năm trang của connector chỉ-nhà không hiện —
 * trong khi menu của tổ chức NHÀ giữ y nguyên. Cả hai luật đi bằng TRƯỜNG của sổ khai (`foldInto` / `hub`, `requires`), không
 * bằng tên tổ chức; quyền vẫn chỉ do `visible()` tính.
 */
function testCustomerOrgMenu() {
  // ── Sổ khai: trang gom đủ hình dạng ──
  const specs = NAV_MODULES as readonly ModuleSpec[];
  for (const hub of NAV_HUB_HREFS) {
    const rows = specs.filter((m) => m.href === hub);
    assert.equal(rows.length, 1, `${hub}: đúng một dòng trong sổ`);
    assert.equal(rows[0].hub, true, `${hub}: khai hub: true`);
    assert.ok(!rows[0].permission && !rows[0].anyOf, `${hub}: trang gom không khai quyền riêng — hiện theo quyền của công cụ bên trong`);
    const members = hubMembers(hub);
    assert.ok(members.length > 0, `${hub}: phải có mục gom vào`);
    for (const m of members) assert.equal(m.zone, rows[0].zone, `${m.href} gom vào ${hub} phải cùng vùng menu`);
  }
  for (const m of specs) if (m.foldInto) assert.ok((NAV_HUB_HREFS as readonly string[]).includes(m.foldInto), `${m.href} gom vào trang gom không có trong sổ`);
  assert.deepEqual(hubMembers("/settings/advanced").map((m) => m.href), BUILDER_HREFS, "đúng mười công cụ, theo thứ tự khai");
  // Năm trang của connector chỉ-nhà: nguồn số liệu khai bằng module connector — và mọi connector ấy chỉ nhà bật được.
  for (const h of HOME_DATA_HREFS) {
    const connectors = (specs.find((m) => m.href === h)?.requires ?? []).filter((k) => k.startsWith("connector_"));
    assert.ok(connectors.length > 0, `${h}: phải khai connector nguồn ở requires`);
    for (const k of connectors) assert.equal(PLATFORM_MODULES.find((d) => d.key === k)?.requiresHomeCredentials, true, `${h}: ${k} phải là connector chỉ-nhà`);
  }

  // ── Tổ chức thực phẩm (mẫu thật) ──
  const food = [...resolveEnabledModules({ moduleDefault: "DISABLED" }, FOOD_COMMERCE_BLUEPRINT.modules.map((k) => ({ moduleKey: k, enabled: true, features: {} }) as never))];
  const khach: NavUserLike = { role: "ADMIN", permissions: [], modules: food, organization: { isHome: false } };
  const khachMenu = allowedNavItems(khach).map((i) => i.href);
  assert.ok(khachMenu.includes("/settings/advanced"), "tổ chức khách thấy «Tuỳ biến nâng cao»");
  for (const h of BUILDER_HREFS) assert.ok(!khachMenu.includes(h), `tổ chức khách: ${h} không đứng riêng trên menu / ⌘K`);
  for (const h of HOME_DATA_HREFS) assert.ok(!khachMenu.includes(h), `tổ chức khách: ${h} không hiện`);
  for (const h of SEPARATE_ADMIN_HREFS) assert.ok(khachMenu.includes(h), `tổ chức khách: ${h} vẫn đứng riêng`);
  const he = visibleGroups(khach).find((g) => g.zone === "SYSTEM")?.items.map((i) => i.href) ?? [];
  assert.equal(he.indexOf("/settings/advanced"), he.indexOf("/settings/modules") + 1, "trang gom đứng ngay sau «Module của tổ chức»");
  assert.deepEqual(hubTools("/settings/advanced", khach).map((t) => t.href), BUILDER_HREFS, "quản trị thấy đủ mười công cụ trong trang gom");

  // Tổ chức khách bật MỌI module nó bật được (Vận chuyển, CSKH, Hàng hoàn… đều bật): năm trang VẪN ẩn, vì thứ thiếu là
  // connector, không phải module.
  const coTheBat = [...resolveEnabledModules({ moduleDefault: "DISABLED" }, PLATFORM_MODULES.filter((d) => !d.requiresHomeCredentials).map((d) => ({ moduleKey: d.key, enabled: true, features: {} }) as never))];
  assert.ok(coTheBat.includes("logistics") && coTheBat.includes("customer_care"), "tiền đề: tổ chức khách bật được Vận chuyển và CSKH");
  const khachDu = allowedNavItems({ ...khach, modules: coTheBat }).map((i) => i.href);
  for (const h of HOME_DATA_HREFS) assert.ok(!khachDu.includes(h), `tổ chức khách bật đủ module: ${h} vẫn không hiện (thiếu connector)`);

  // Trang gom chỉ liệt kê công cụ người xem được dùng — cùng `visible()` với menu.
  const chiLuat: NavUserLike = { role: "MANAGER", permissions: ["workflow:manage"], modules: food, organization: { isHome: false } };
  assert.deepEqual(hubTools("/settings/advanced", chiLuat).map((t) => t.href), ["/settings/workflows"], "chỉ có workflow:manage ⇒ chỉ «Luật tự động»");
  const chiMeta: NavUserLike = { ...chiLuat, permissions: ["metadata:manage"] };
  assert.deepEqual(hubTools("/settings/advanced", chiMeta).map((t) => t.href), BUILDER_HREFS.filter((h) => h !== "/settings/workflows"), "chỉ có metadata:manage ⇒ chín công cụ, không «Luật tự động»");
  for (const t of hubTools("/settings/advanced", chiMeta)) assert.equal(visible(t, chiMeta), true);
  assert.ok(allowedNavItems(chiLuat).some((i) => i.href === "/settings/advanced"), "có một công cụ ⇒ có mục trang gom");
  const khongQuyen: NavUserLike = { role: "MANAGER", permissions: ["dashboard:view"], modules: food, organization: { isHome: false } };
  assert.deepEqual(hubTools("/settings/advanced", khongQuyen), [], "không quyền nào ⇒ trang gom rỗng");
  assert.ok(!allowedNavItems(khongQuyen).some((i) => i.href === "/settings/advanced"), "không công cụ nào ⇒ không có mục trang gom");
  // Đang mở một công cụ đã gom ⇒ tô sáng trang gom (mục riêng không có trên menu của họ).
  assert.equal(menuActiveHref("/settings/forms/order", khach), "/settings/advanced");
  assert.equal(menuActiveHref("/settings/users", khach), "/settings/users");
  assert.equal(foldsHubs({}), true, "phiên không mang tổ chức ⇒ coi là tổ chức khách (cùng hướng với homeOrgPermissionDenied)");

  // ── Tổ chức nhà: y như trước ──
  const nha: NavUserLike = { role: "ADMIN", permissions: [], modules: [...MODULE_KEYS], organization: { isHome: true } };
  const nhaMenu = allowedNavItems(nha).map((i) => i.href);
  for (const h of [...BUILDER_HREFS, ...HOME_DATA_HREFS, ...SEPARATE_ADMIN_HREFS]) assert.ok(nhaMenu.includes(h), `nhà: ${h} vẫn trên menu`);
  assert.ok(!nhaMenu.includes("/settings/advanced"), "nhà: không có trang gom trên menu");
  assert.equal(menuActiveHref("/settings/forms/order", nha), "/settings/forms", "nhà: tô đúng mục riêng");
  assert.equal(hubTools("/settings/advanced", nha).length, 10, "nhà mở thẳng /settings/advanced vẫn thấy mục lục đủ");

  // Trang gom không tự tính quyền: danh sách chỉ đi qua `hubTools` (AGENTS.md mục 28).
  const page = readFileSync("app/(dashboard)/settings/advanced/page.tsx", "utf8");
  assert.ok(page.includes("hubTools(HUB, user)"), "trang gom lấy danh sách từ hubTools");
  assert.ok(!/\bcan\(|hasPermission\(|requirePermission\(/.test(page), "trang gom không hỏi quyền lần thứ hai");
  console.log("✓ Menu tổ chức khách: «Tuỳ biến nâng cao» gom mười công cụ, năm trang connector chỉ-nhà ẩn, menu nhà y nguyên");
}

function testModuleViewPure() {
  const home = buildModuleView({ moduleDefault: "ENABLED", isHome: true }, []);
  assert.equal(home.enabledCount, home.total, "tổ chức nhà không dòng nào ⇒ mọi module bật");
  const fresh = buildModuleView({ moduleDefault: "DISABLED", isHome: false }, [
    { moduleKey: "returns", enabled: true, features: {} },
    { moduleKey: "khoa-la", enabled: true, features: {} },
  ]);
  const rows = new Map(fresh.groups.flatMap((g) => g.rows).map((r) => [r.key, r]));
  assert.equal(rows.get("core")?.state, "CORE");
  assert.equal(rows.get("orders")?.state, "OFF");
  assert.equal(rows.get("connector_pancake")?.state, "HOME_ONLY", "connector ở tổ chức khác nhà ⇒ Chỉ tổ chức nhà");
  assert.equal(rows.get("returns")?.enabled, false, "khai bật mà thiếu phụ thuộc ⇒ coi là tắt");
  assert.match(rows.get("returns")?.dependencyError ?? "", /thiếu/, "và nói ra vì sao");
  assert.deepEqual(fresh.unknownKeys, ["khoa-la"]);
  assert.deepEqual(
    rows.get("orders")?.dependents.map((d) => d.key).sort(),
    ["ai_sales", "alerts", "connector_pancake", "logistics", "marketing", "returns", "sales_channels"].sort(),
    "cột «Module dựa vào nó» dựng từ sổ",
  );
}

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(schema.platformOrganizationModules).where(eq(schema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(schema.platformOrganizations).where(eq(schema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

export async function testPlatformUi() {
  testMenuPure();
  testCustomerOrgMenu();
  testModuleViewPure();

  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  const { organization } = await provisionOrganization({ code: ORG, name: "Tổ chức thử giao diện", templateKey: "wholesale", modules: ["customers", "products", "orders"], admin: { email: "admin@pu-mono.local", name: "Quản trị PU", password: "Pu@123456" }, source: "TEST", actor: null });

  try {
    // ── Sức khoẻ: tổ chức mới cấp kết nối được, đủ migration, bốn bảng platform_* rỗng ──
    const journal = readJournalCount();
    assert.ok(journal.count && journal.count > 100, "đọc được sổ migration của mã nguồn");
    let health = await getPlatformHealth();
    const mine = health.organizations.find((o) => o.code === ORG);
    const home = health.organizations.find((o) => o.isHome);
    assert.ok(mine && home);
    assert.equal(mine.connected, true, "CSDL tổ chức mới mở được");
    assert.equal(mine.migrationsApplied, journal.count, "CSDL tổ chức đã áp đủ migration");
    assert.equal(home.migrationsApplied, journal.count, "CSDL nhà đã áp đủ migration");
    assert.deepEqual(mine.platformTables?.map((t) => t.rows), [0, 0, 0, 0], "bốn bảng platform_* trong CSDL tổ chức rỗng");
    assert.deepEqual(mine.problems, [], "tổ chức mới cấp không có vấn đề");
    assert.equal(mine.enabledModules, 5, "lõi (2) + ba module bật khi cấp");
    assert.equal(home.platformTables, null, "tổ chức nhà: bảng platform_* là thật, không kiểm rỗng");

    // Máy quét PHẢI thấy một dòng lọt vào bản sao mặt phẳng điều khiển của CSDL tổ chức.
    const odb = await getDbFor(organization);
    await odb.insert(schema.platformAuditLog).values({ targetOrgCode: ORG, action: "FLAG_SET", subject: "pu-probe", source: "TEST" });
    try {
      health = await getPlatformHealth();
      const dirty = health.organizations.find((o) => o.code === ORG);
      assert.equal(dirty?.platformTables?.find((t) => t.table === "platform_audit_log")?.rows, 1);
      assert.ok(dirty?.problems.some((p) => p.includes("platform_audit_log")), "health phải báo bảng platform_* trong CSDL tổ chức có dòng");
    } finally {
      await odb.execute(sql`delete from platform_audit_log where subject = 'pu-probe'`);
    }

    // ── Lõi của server action: quản trị tổ chức bật/tắt module của CHÍNH mình ──
    // Người bấm là tài khoản THẬT trong CSDL tổ chức — nhật ký của tổ chức (`audit_logs.user_id`) trỏ vào nó.
    const adminRow = await odb.query.users.findFirst({ where: eq(schema.users.email, "admin@pu-mono.local") });
    assert.ok(adminRow, "tài khoản quản trị đầu tiên nằm trong CSDL tổ chức");
    const orgAdmin = sessionUser({ id: adminRow.id, email: adminRow.email, organization: { code: ORG, name: organization.name, isHome: false }, modules: ["core", "work", "customers", "products", "orders"] });
    const blocked = await toggleOwnModule(orgAdmin, { moduleKey: "returns", enabled: true });
    const expected = validateModuleChange(await getEnabledModules(ORG), "returns", true);
    assert.ok(!expected.ok && "error" in blocked);
    assert.equal(blocked.error, expected.message, "lỗi trả về NGUYÊN VĂN câu giải thích của sổ module");
    assert.equal((await getEnabledModules(ORG)).has("inventory"), false, "bị chặn thì KHÔNG tự bật dây chuyền phụ thuộc");

    assert.deepEqual(await toggleOwnModule(orgAdmin, { moduleKey: "inventory", enabled: true }), { ok: true, changed: true });
    assert.deepEqual(await toggleOwnModule(orgAdmin, { moduleKey: "returns", enabled: true, reason: "thử" }), { ok: true, changed: true });
    assert.ok((await getEnabledModules(ORG)).has("returns"), "bật có hiệu lực ngay (đệm năng lực đã xoá)");
    const hasDependents = await toggleOwnModule(orgAdmin, { moduleKey: "orders", enabled: false });
    assert.ok("error" in hasDependents && /Hàng hoàn/.test(hasDependents.error), "tắt Đơn hàng khi Hàng hoàn đang bật ⇒ chặn và nêu tên");
    const core = await toggleOwnModule(orgAdmin, { moduleKey: "core", enabled: false });
    assert.ok("error" in core && /lõi/.test(core.error));
    const connector = await toggleOwnModule(orgAdmin, { moduleKey: "connector_pancake", enabled: true });
    assert.ok("error" in connector && /tổ chức nhà/.test(connector.error), "connector: tổ chức khác nhà không bật được");
    const junk = await toggleOwnModule(orgAdmin, { moduleKey: "", enabled: "có" });
    assert.ok("error" in junk, "đầu vào sai kiểu ⇒ { error }, không ném");

    assert.deepEqual(await toggleOwnFeature(orgAdmin, { featureKey: "orders.export", enabled: false }), { ok: true, changed: true });
    const view = (await getOrganizationModuleView(ORG)).view;
    const exportFeature = view.groups.flatMap((g) => g.rows).find((r) => r.key === "orders")?.features.find((f) => f.key === "orders.export");
    assert.deepEqual([exportFeature?.enabled, exportFeature?.overridden], [false, true], "tính năng tắt riêng, ghi đè hiện ra");

    const viewer = sessionUser({ role: "VIEWER", permissions: [], organization: orgAdmin.organization, modules: orgAdmin.modules });
    const denied = await toggleOwnModule(viewer, { moduleKey: "inventory", enabled: false });
    assert.ok("error" in denied && /quyền/.test(denied.error), "không có modules:manage ⇒ từ chối");
    assert.ok("error" in (await toggleOwnModule(sessionUser({}), { moduleKey: "inventory", enabled: false })), "phiên không mang tổ chức ⇒ từ chối, không rơi về tổ chức nhà");

    // ── Vận hành nền tảng: chỉ người của tổ chức nhà ──
    assert.match(platformOperatorDenial(orgAdmin) ?? "", /tổ chức nhà/, "ADMIN của tổ chức khác KHÔNG vận hành được nền tảng");
    const cross = await toggleModuleForOrganization(orgAdmin, { orgCode: ORG, moduleKey: "customer_care", enabled: true, reason: "tự cấp cho mình" });
    assert.ok("error" in cross);
    const homeAdmin = sessionUser({ organization: { code: home.code, name: home.name, isHome: true } });
    assert.equal(platformOperatorDenial(homeAdmin), null);
    const noReason = await toggleModuleForOrganization(homeAdmin, { orgCode: ORG, moduleKey: "customer_care", enabled: true, reason: "" });
    assert.ok("error" in noReason && /lý do/i.test(noReason.error), "đổi module tổ chức khác bắt buộc lý do");
    assert.deepEqual(await toggleModuleForOrganization(homeAdmin, { orgCode: ORG, moduleKey: "customer_care", enabled: true, reason: "Hỗ trợ khách bật CSKH" }), { ok: true, changed: true });
    const pdb = await getPlatformDb();
    const trail = await pdb.select().from(schema.platformAuditLog).where(eq(schema.platformAuditLog.targetOrgCode, ORG));
    const crossTrail = trail.find((a) => a.subject === "customer_care");
    assert.equal(crossTrail?.actorOrgCode, home.code, "nhật ký nền tảng ghi người vận hành thuộc tổ chức nhà");
    assert.equal(crossTrail?.reason, "Hỗ trợ khách bật CSKH");
    assert.equal(crossTrail?.source, "UI");
    // Nhật ký CỦA CHÍNH tổ chức bị đổi: quản trị của họ thấy cả lượt tự đổi lẫn lượt người vận hành đổi hộ.
    const tenantTrail = await odb.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "PLATFORM_MODULE"));
    assert.ok(tenantTrail.some((a) => a.entityId === "returns" && a.userId === adminRow.id), "lượt tự đổi mang khoá tài khoản của người bấm");
    const crossTenant = tenantTrail.find((a) => a.entityId === "customer_care");
    assert.equal(crossTenant?.userId ?? null, null, "người vận hành không có tài khoản trong CSDL này ⇒ không ghi khoá trỏ vào hư không");
    assert.match(crossTenant?.userEmail ?? "", /vận hành nền tảng/);
  } finally {
    await cleanupOrg(ORG);
  }
  console.log("✓ Nền tảng · giao diện module: menu + ⌘K + chuông lọc theo module (kể cả ADMIN), sức khoẻ đo kết nối/migration/bảng platform_* rỗng và bắt được dòng lọt, bật/tắt chặn + giải thích nguyên văn");
}
