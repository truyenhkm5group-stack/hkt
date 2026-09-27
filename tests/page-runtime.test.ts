/**
 * PHASE 4 · DYNAMIC PAGE RUNTIME — sổ loại khối, kiểm schema, sổ trang (nháp / xuất bản / phiên bản / ảnh chụp /
 * nhật ký), mẫu trang, dựng trang cô lập lỗi, menu động (docs/platform/phase-4-contracts.md).
 *
 * Hai phần:
 *  · THUẦN: `validatePageSchema` với SỔ GIẢ tiêm vào (bài kiểm không phụ thuộc nội dung sổ thật) — khối lạ, id
 *    trùng, nguồn lạ, module tắt ⇒ chặn, quá trần, kỳ / dạng biểu đồ nguồn không hỗ trợ; menu động; dựng trang
 *    với trình phân giải giả (một khối ném lỗi không kéo khối khác).
 *  · HAI TỔ CHỨC THẬT (`pr4-a`, `pr4-b` — hai CSDL PGlite riêng): vòng đời một trang, cô lập slug / id, slug bất
 *    biến sau xuất bản, lưu trữ, mẫu sinh ở NHÁP.
 *
 * Tự dọn: thư mục CSDL `pr4-*` xoá TRƯỚC khi cấp; dòng mặt phẳng điều khiển xoá khi xong.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { visibleGroups, allowedNavItems, activeHrefOf, NAV_TITLES } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { usageKeyOf, usageKeysFrom } from "@/lib/constants/page-usage";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { createCustomField } from "@/lib/metadata/fields";
import { MetadataError } from "@/lib/metadata/errors";
import type { MetadataActor } from "@/lib/metadata/types";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { executePageAction } from "@/lib/pages/actions";
import { COMPONENT_REGISTRY, defaultPageCatalog, normalizePageSchema, validatePageSchema, type PageCatalog } from "@/lib/pages/components";
import { resolvePage } from "@/lib/pages/data-sources";
import { dynamicNavFor, pageOpenableBy } from "@/lib/pages/nav";
import { archivePage, createPage, createPageFromTemplate, getPageBySlug, getPageDraft, listNavPages, listPages, publishPage, savePageDraft, updatePageMeta } from "@/lib/pages/registry";
import { startPageRender, type PageResolver } from "@/lib/pages/render";
import { buildTemplateSchema, PAGE_TEMPLATES, templates } from "@/lib/pages/templates";
import { BLOCK_TYPES, PAGE_MAX_BLOCKS, PAGE_MAX_SECTIONS, type PageBlock, type PageDefinition, type PageSchema } from "@/lib/pages/types";

const A = "pr4-a";
const B = "pr4-b";

// ─────────────────────────── Sổ giả ───────────────────────────

const CAT: PageCatalog = {
  metrics: [
    { key: "t_orders", label: "Đơn (giả)", module: "orders", permission: "orders:view", format: "number", periods: ["today", "7d", "30d"], why: "sổ giả của bài kiểm" },
    { key: "t_cash", label: "Tiền (giả)", module: "finance", permission: "finance:view", format: "vnd", periods: ["30d"], why: "nguồn của module Tài chính — tổ chức kiểm thử không bật" },
  ],
  series: [{ key: "t_series", label: "Chuỗi (giả)", module: "orders", permission: "orders:view", kinds: ["bar", "line"], format: "number", periods: ["7d", "30d"], why: "sổ giả" }],
  lists: [
    { objectKey: "customer", label: "Khách", module: "customers", permission: "customers:view", why: "sổ giả" },
    { objectKey: "order", label: "Đơn", module: "orders", permission: "orders:view", why: "sổ giả" },
  ],
  timelines: [{ key: "t_tl", label: "Dòng thời gian đơn (giả)", module: "orders", permission: "orders:view", recordObject: "order", why: "sổ giả" }],
  actions: [{ key: "t_open", label: "Mở trang", module: null, permission: null, sideEffect: "NONE", requiresApproval: false, why: "sổ giả" }],
};

const ON: ReadonlySet<ModuleKey> = new Set<ModuleKey>(["core", "work", "customers", "products", "orders"]);

const kpi = (id: string, metric = "t_orders", extra: Record<string, unknown> = {}): PageBlock => ({ id, type: "kpi", span: 3, config: { metric, ...extra } } as PageBlock);
const table = (id: string, source = "customer", extra: Record<string, unknown> = {}): PageBlock => ({ id, type: "table", span: 12, config: { source, ...extra } } as PageBlock);
const chart = (id: string, kind = "bar"): PageBlock => ({ id, type: "chart", span: 6, config: { series: "t_series", kind } } as PageBlock);
const page = (...blocks: PageBlock[]): PageSchema => ({ version: 1, sections: [{ key: "main", blocks }] });

function errorsOf(s: unknown, modules: ReadonlySet<ModuleKey> = ON): string[] {
  return validatePageSchema(s, { modules, catalog: CAT }).errors.map((e) => `${e.path} :: ${e.message}`);
}
function expectError(s: unknown, re: RegExp, label: string, modules?: ReadonlySet<ModuleKey>) {
  const errs = errorsOf(s, modules);
  assert.ok(errs.some((e) => re.test(e)), `${label}: mong lỗi ${re}, nhận ${JSON.stringify(errs)}`);
}

function testValidatePure() {
  // Sổ loại khối phủ đúng tám loại của hợp đồng.
  assert.deepEqual(Object.keys(COMPONENT_REGISTRY).sort(), [...BLOCK_TYPES].sort(), "COMPONENT_REGISTRY phủ đúng BLOCK_TYPES");
  for (const t of BLOCK_TYPES) assert.equal(COMPONENT_REGISTRY[t].type, t);

  const good = page(kpi("orders_kpi", "t_orders", { period: "7d" }), table("customers_tbl", "customer", { columns: ["system:name", "custom:hang"], pageSize: 20 }), chart("trend"));
  assert.deepEqual(errorsOf(good), [], "schema hợp lệ không có lỗi");
  assert.equal(validatePageSchema(good, { modules: ON, catalog: CAT }).ok, true);

  expectError(page({ id: "x_1", type: "carousel", span: 3, config: {} } as unknown as PageBlock), /Loại khối «carousel» không có trong sổ/, "khối lạ");
  expectError(page(kpi("dup_id"), kpi("dup_id")), /bị trùng trong trang/, "id trùng");
  expectError(page(kpi("A_bad")), /Khoá khối phải khớp/, "id sai dạng");
  expectError(page(kpi("x")), /Khoá khối phải khớp/, "id một ký tự");
  expectError(page(kpi("k_1", "khong_co")), /«khong_co» không có trong sổ chỉ số/, "nguồn lạ");
  expectError(page(table("t_1", "employee")), /không có trong sổ nguồn danh sách/, "đối tượng không phải nguồn danh sách");
  expectError(page({ id: "b_1", type: "button", span: 3, config: { action: "xoa_het", label: "Xoá" } } as PageBlock), /không có trong sổ action/, "action lạ");
  // G7: module tắt ⇒ LỖI CHẶN khi xuất bản; lưu nháp hạ xuống cảnh báo.
  const finance = page(kpi("cash", "t_cash"));
  expectError(finance, /module «finance» đang TẮT/, "module tắt chặn");
  const draftCheck = validatePageSchema(finance, { modules: ON, catalog: CAT, moduleIssues: "warning" });
  assert.equal(draftCheck.ok, true, "lưu nháp: module tắt chỉ là cảnh báo");
  assert.ok(draftCheck.warnings.some((w) => /finance/.test(w.message)));
  assert.deepEqual(errorsOf(finance, new Set<ModuleKey>([...ON, "finance"])), [], "bật module ⇒ hết lỗi");
  // Trần
  const many = Array.from({ length: PAGE_MAX_BLOCKS + 1 }, (_, i) => kpi(`k_${i}`));
  expectError(page(...many), new RegExp(`Tối đa ${PAGE_MAX_BLOCKS} khối`), "quá trần khối");
  assert.deepEqual(errorsOf(page(...many.slice(0, PAGE_MAX_BLOCKS))), [], "đúng trần thì được");
  const sections = { version: 1, sections: Array.from({ length: PAGE_MAX_SECTIONS + 1 }, (_, i) => ({ key: `s${i}`, blocks: [kpi(`k_${i}`)] })) };
  expectError(sections, new RegExp(`Tối đa ${PAGE_MAX_SECTIONS} phần`), "quá trần phần");
  expectError({ version: 1, sections: [{ key: "a", blocks: [] }, { key: "a", blocks: [] }] }, /Khoá phần «a» bị trùng/, "khoá phần trùng");
  // Hình dạng / cấu hình
  expectError({ ...page(kpi("k_1")), extra: 1 }, /Khoá lạ «extra»/, "khoá lạ ở gốc");
  expectError({ version: 2, sections: [] }, /Phiên bản schema phải là 1/, "phiên bản");
  expectError(page({ ...kpi("k_1"), span: 5 } as unknown as PageBlock), /Độ rộng phải là một trong/, "span lạ");
  expectError(page({ id: "k_1", type: "kpi", span: 3, config: { metric: "t_orders", sql: "drop table x" } } as unknown as PageBlock), /config/, "khoá lạ trong cấu hình (không SQL tự do)");
  expectError(page(kpi("k_1", "t_orders", { period: "90d" })), /không hỗ trợ kỳ «90d»/, "kỳ nguồn không hỗ trợ");
  expectError(page(kpi("k_1", "t_orders", { period: "custom" })), /config\.period/, "kỳ custom không khai được trong cấu hình");
  expectError(page(chart("c_1", "pie")), /không vẽ được dạng «pie»/, "dạng biểu đồ nguồn không hỗ trợ");
  expectError(page(table("t_1", "customer", { pageSize: 500 })), /config\.pageSize/, "bảng > 100 dòng");
  expectError(page(table("t_1", "customer", { columns: ["system:khong_co"] })), /không có field hệ thống/, "field hệ thống lạ");
  expectError(page(table("t_1", "customer", { filters: [{ ref: "system:address", op: "eq", value: "x" }] })), /không lọc được/, "lọc field không filterable");
  expectError(page({ id: "kb_1", type: "kanban", span: 12, config: { objectKey: "order", statusField: "system:stage", cardFields: [], allowMove: true } } as PageBlock), /field CUSTOM kiểu trạng thái/, "kanban trên trạng thái hệ thống bị chặn (G6)");
  expectError(page({ id: "kb_2", type: "kanban", span: 12, config: { objectKey: "customer", statusField: "", cardFields: [], allowMove: false } } as unknown as PageBlock), /blocks\.0\.config\.statusField/, "kanban chưa chọn field ⇒ lỗi tại đúng ô statusField (đường dẫn chấm)");
  expectError(page({ id: "tl_1", type: "timeline", span: 6, config: { source: "t_tl" } } as PageBlock), /cần tham số URL/, "timeline theo bản ghi cần recordParam");
  expectError(page({ id: "f_1", type: "form", span: 6, config: { objectKey: "customer", formKey: "khong_co", mode: "create" } } as PageBlock), /không có form «khong_co»/, "form lạ");
  expectError(page({ id: "t_1", type: "text", span: 12, config: {} } as PageBlock), /cần tiêu đề hoặc nội dung/, "khối chữ rỗng");
  assert.equal(validatePageSchema("không phải object", { modules: ON, catalog: CAT }).ok, false);
  // Sổ RỖNG (sổ thật lúc chưa điền): mọi khoá nguồn đều lạ, validate vẫn chạy không ném.
  const empty: PageCatalog = { metrics: [], series: [], lists: [], timelines: [], actions: [] };
  assert.ok(!validatePageSchema(good, { modules: ON, catalog: empty }).ok, "sổ rỗng ⇒ mọi nguồn là lạ");
  // Chuẩn hoá bỏ khoảng trắng, không thêm khoá lạ.
  const norm = normalizePageSchema(page({ id: "txt", type: "text", span: 12, title: "", config: { heading: "  Chào  " } } as PageBlock), { modules: ON, catalog: CAT });
  assert.deepEqual(norm?.sections[0].blocks[0], { id: "txt", type: "text", span: 12, config: { heading: "Chào" } });

  console.log("✓ Trang động · kiểm schema thuần: 8 loại khối, khối lạ / id trùng / nguồn lạ / module tắt / quá trần / kỳ & dạng biểu đồ / kanban hệ thống đều bị chặn");
}

// ─────────────────────────── Dựng trang & menu (thuần) ───────────────────────────

function viewer(over: Partial<SessionUser> = {}): SessionUser {
  return { id: "u1", email: "u@x", name: "U", role: "VIEWER", permissions: ["orders:view"], scope: "ALL", departmentCodes: [], positionId: null, modules: [...ON], ...over };
}

async function testRenderIsolation() {
  const s: PageSchema = {
    version: 1,
    sections: [
      { key: "a", blocks: [kpi("good_one"), kpi("boom"), { ...kpi("hidden"), visibility: { permission: "finance:view" } } as PageBlock] },
      { key: "b", blocks: [{ ...kpi("only_hidden"), visibility: { module: "finance" } } as PageBlock] },
    ],
  };
  const seen: string[] = [];
  const ctx = { searchParams: {}, period: "30d" as const };
  // Trình phân giải giả CÙNG hình `resolvePage`: trả phần của từng khối, "quên" khối `lost`.
  const resolver: PageResolver = async (schemaIn) => {
    const blocks = schemaIn.sections.flatMap((x) => x.blocks);
    seen.push(...blocks.map((b) => b.id));
    return { sections: [{ key: "a", blocks: blocks.filter((b) => b.id !== "boom").map((block) => ({ ok: true as const, block, data: { label: block.id, value: null, format: "number" as const } })) }] };
  };
  const errors = console.error;
  console.error = () => {};
  try {
    const sections = startPageRender(s, viewer(), ctx, "t", resolver);
    const results = await Promise.all(sections.flatMap((x) => x.blocks).map((b) => b.result));
    assert.deepEqual(seen.sort(), ["boom", "good_one"], "khối ẩn (UX) bị bỏ TRƯỚC khi phân giải — không tốn truy vấn");
    assert.equal(sections.length, 1, "section chỉ có khối ẩn thì bỏ");
    const good = results.find((r) => r.block.id === "good_one");
    const boom = results.find((r) => r.block.id === "boom");
    assert.ok(good?.ok, "khối lành vẫn có dữ liệu");
    assert.ok(boom && !boom.ok && boom.issue.code === "DATA_ERROR" && boom.issue.blockId === "boom", "khối không có kết quả ⇒ DATA_ERROR của đúng khối đó");
    // Chính trình phân giải ném (mất kết nối trước khi vào khối nào): mọi khối thành chỗ giữ, câu lỗi thô không lộ.
    const crashed = startPageRender(s, viewer(), ctx, "t", async () => {
      throw new Error("SELECT * FROM mat_khau — lỗi thô không được lộ");
    });
    const all = await Promise.all(crashed.flatMap((x) => x.blocks).map((b) => b.result));
    assert.ok(all.length === 2 && all.every((r) => !r.ok && r.issue.code === "DATA_ERROR"), "trình phân giải ném ⇒ mọi khối DATA_ERROR, trang vẫn đứng");
    assert.ok(all.every((r) => !r.ok && !/mat_khau/.test(r.issue.message)), "câu lỗi thô KHÔNG đi tới trình duyệt");
  } finally {
    console.error = errors;
  }

  // Menu động
  const def = (slug: string, over: Partial<PageDefinition> = {}): PageDefinition => ({
    id: slug,
    slug,
    name: slug,
    moduleKey: "orders",
    requiredPermission: null,
    nav: { enabled: true, label: `Trang ${slug}`, zone: null, order: 0 },
    status: "ACTIVE",
    publishedVersion: 1,
    publishedAt: null,
    publishedBy: null,
    ...over,
  });
  const pages = [
    def("ban-hang", { nav: { enabled: true, label: "Bán hàng", zone: "SALES", order: 2 } }),
    def("tu-do"),
    def("nhap", { publishedVersion: 0 }),
    def("tat-menu", { nav: { enabled: false, label: "", zone: null, order: 0 } }),
    def("luu-tru", { status: "ARCHIVED" }),
    def("tai-chinh", { moduleKey: "finance" }),
    def("can-quyen", { requiredPermission: "payroll:manage" }),
  ];
  const v = viewer();
  const items = dynamicNavFor(pages, v);
  assert.deepEqual(items.map((i) => i.href).sort(), ["/p/ban-hang", "/p/tu-do"], "chỉ trang ĐÃ XUẤT BẢN, bật menu, còn hoạt động, module bật, có quyền");
  assert.equal(pageOpenableBy(def("x", { requiredPermission: "payroll:manage" }), { role: "ADMIN", permissions: [], modules: [...ON] }), false, "ADMIN không vượt module sở hữu quyền (payroll tắt)");
  const groups = visibleGroups({ role: "VIEWER", permissions: ["orders:view"], modules: [...ON], dynamicPages: items });
  const custom = groups.find((g) => g.zone === "CUSTOM_PAGES");
  assert.deepEqual(custom?.items.map((i) => i.href), ["/p/tu-do"], "không khai vùng ⇒ nhóm Trang tuỳ biến");
  assert.ok(groups.find((g) => g.zone === "SALES")?.items.some((i) => i.href === "/p/ban-hang"), "khai vùng ⇒ nối vào cuối nhóm phòng đó");
  const noDyn = visibleGroups({ role: "VIEWER", permissions: ["orders:view"], modules: [...ON] });
  assert.ok(!noDyn.some((g) => g.zone === "CUSTOM_PAGES"), "không có trang động ⇒ menu cũ nguyên vẹn");
  assert.ok(allowedNavItems({ role: "VIEWER", permissions: [], modules: [...ON], dynamicPages: items }).some((i) => i.href === "/p/tu-do"), "⌘K thấy trang động");
  assert.equal(activeHrefOf("/p/tu-do", ["/p/tu-do"]), "/p/tu-do", "mục động được tô sáng");
  // Bộ đếm lượt mở: mọi /p/<slug> gom vào MỘT khoá.
  const keys = usageKeysFrom(Object.keys(NAV_TITLES));
  assert.equal(usageKeyOf("/p/bat-ky-slug", keys), "/p", "trang động đếm vào một khoá, không phình theo slug");

  console.log("✓ Trang động · dựng trang: khung từ schema, khối thiếu kết quả / trình phân giải ném ⇒ chỗ giữ (không lộ lỗi thô), khối ẩn không phân giải · menu động lọc theo module + quyền, nhóm Trang tuỳ biến");
}

// ─────────────────────────── Hai tổ chức thật ───────────────────────────

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

async function adminOf(org: string): Promise<MetadataActor> {
  return withOrganization(org, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email };
  });
}

async function auditOf(entityId: string, action: string) {
  const db = await getDb();
  const t = schema.auditLogs;
  return db
    .select()
    .from(t)
    .where(and(eq(t.entity, "META_PAGE"), eq(t.entityId, entityId), eq(t.action, action)));
}

async function testLifecycle() {
  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers", "products", "orders"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Page@12345" }, source: "TEST", actor: null });
  }
  try {
    const actorA = await adminOf(A);
    const actorB = await adminOf(B);
    const opts = { catalog: CAT };
    const v1 = page(kpi("orders_kpi", "t_orders", { period: "7d" }), table("customers_tbl"));

    // ── 1. Tạo → nháp → người dùng CHƯA thấy gì ──
    const idA = await withOrganization(A, async () => {
      assert.deepEqual(await listPages(), [], "tổ chức mới không có trang nào — mẫu không tự kích hoạt");
      const created = await createPage({ slug: "bang-a", name: "Bảng A", moduleKey: "orders", nav: { enabled: true } }, actorA, opts);
      assert.ok(created.ok, JSON.stringify(created));
      assert.equal(created.page.publishedVersion, 0);
      assert.equal(created.page.nav.label, "Bảng A", "nhãn menu trống ⇒ lấy tên trang");
      assert.equal(await getPageBySlug("bang-a"), null, "chưa xuất bản ⇒ không mở được");

      const dup = await createPage({ slug: "bang-a", name: "Trùng", moduleKey: "orders" }, actorA, opts);
      assert.ok(!dup.ok && dup.code === "SLUG_TAKEN", "slug trùng bị chặn");
      const badSlug = await createPage({ slug: "Bang A", name: "x", moduleKey: "orders" }, actorA, opts);
      assert.ok(!badSlug.ok && badSlug.code === "INVALID");
      const off = await createPage({ slug: "tai-chinh", name: "x", moduleKey: "finance" }, actorA, opts);
      assert.ok(!off.ok && off.code === "MODULE_DISABLED", "module chủ tắt ⇒ không tạo được");

      const bad = await savePageDraft(created.page.id, page(kpi("k_1", "khong_co")), actorA, opts);
      assert.ok(!bad.ok && bad.code === "INVALID", "nháp sai sổ bị từ chối");
      const saved = await savePageDraft(created.page.id, v1, actorA, opts);
      assert.ok(saved.ok, JSON.stringify(saved));
      assert.equal(await getPageBySlug("bang-a"), null, "lưu nháp KHÔNG đổi thứ người dùng thấy");
      assert.equal((await auditOf(created.page.id, "META_PAGE_DRAFT_SAVE")).length, 1);
      return created.page.id;
    });

    // ── 2. Xuất bản ⇒ đổi; phiên bản + ảnh chụp + nhật ký ──
    await withOrganization(A, async () => {
      const pub = await publishPage(idA, actorA, opts);
      assert.ok(pub.ok, JSON.stringify(pub));
      assert.equal(pub.version, 1);
      const live = await getPageBySlug("bang-a");
      assert.ok(live, "xuất bản ⇒ mở được");
      assert.deepEqual(live.schema, v1);
      assert.equal(live.page.publishedVersion, 1);

      // Nháp mới (thêm biểu đồ) KHÔNG đổi bản đang chạy cho tới khi xuất bản lại.
      const v2 = page(kpi("orders_kpi", "t_orders", { period: "7d" }), table("customers_tbl"), chart("trend"));
      assert.ok((await savePageDraft(idA, v2, actorA, opts)).ok);
      assert.deepEqual((await getPageBySlug("bang-a"))?.schema, v1, "bản đang chạy vẫn là v1");
      assert.deepEqual((await getPageDraft(idA)).draft, v2, "trình soạn thấy nháp v2");
      const pub2 = await publishPage(idA, actorA, opts);
      assert.ok(pub2.ok && pub2.version === 2);
      assert.ok((await getPageBySlug("bang-a"))?.schema.sections[0].blocks.some((b) => b.type === "chart"), "tải lại thấy biểu đồ");

      const db = await getDb();
      const vt = schema.metaConfigVersions;
      const versions = await db.select().from(vt).where(and(eq(vt.kind, "PAGE"), eq(vt.configKey, idA)));
      assert.deepEqual(versions.map((r) => r.version).sort(), [1, 2], "mỗi lần xuất bản MỘT ảnh chụp");
      const snap1 = versions.find((r) => r.version === 1)?.snapshot as { page: { slug: string }; schema: PageSchema };
      assert.equal(snap1.page.slug, "bang-a");
      assert.deepEqual(snap1.schema, v1, "ảnh chụp bất biến giữ đúng bản v1");
      const logs = await auditOf(idA, "META_PAGE_PUBLISH");
      assert.equal(logs.length, 2, "mỗi lần xuất bản một dòng nhật ký");

      // Slug bất biến sau lần xuất bản đầu; tên / menu vẫn sửa được.
      const lock = await updatePageMeta(idA, { slug: "doi-ten" }, actorA);
      assert.ok(!lock.ok && lock.code === "SLUG_LOCKED", "slug khoá sau xuất bản");
      const renamed = await updatePageMeta(idA, { name: "Bảng A mới", nav: { zone: "SALES" } }, actorA);
      assert.ok(renamed.ok && renamed.page.slug === "bang-a" && renamed.page.nav.zone === "SALES");
      assert.ok((await listNavPages()).some((p) => p.id === idA), "trang bật menu có trong menu động");

      // G7 ở lượt xuất bản: nháp trỏ nguồn của module tắt được LƯU (cảnh báo) nhưng KHÔNG xuất bản được.
      const fin = await savePageDraft(idA, page(kpi("cash", "t_cash")), actorA, opts);
      assert.ok(fin.ok && fin.warnings.some((w) => /finance/.test(w.message)), "nháp: cảnh báo module tắt");
      const blocked = await publishPage(idA, actorA, opts);
      assert.ok(!blocked.ok && blocked.errors.some((e) => /finance/.test(e.message)), "xuất bản bị chặn khi module tắt");
      assert.equal((await getPageBySlug("bang-a"))?.page.publishedVersion, 2, "bản đang chạy không đổi");

      // Kanban trên field custom không tồn tại / không phải trạng thái ⇒ từ chối.
      const kb = (ref: string) => page({ id: "board", type: "kanban", span: 12, config: { objectKey: "customer", statusField: ref, cardFields: [], allowMove: true } } as PageBlock);
      const missing = await savePageDraft(idA, kb("custom:khong_co"), actorA, opts);
      assert.ok(!missing.ok && missing.errors.some((e) => /không có field custom/.test(e.message)));
      assert.ok((await createCustomField("customer", { key: "hang", label: "Hạng", type: "text" }, actorA)).ok);
      const notStatus = await savePageDraft(idA, kb("custom:hang"), actorA, opts);
      assert.ok(!notStatus.ok && notStatus.errors.some((e) => /không phải kiểu trạng thái/.test(e.message)));
    });

    // ── 3. Cô lập hai tổ chức: B không thấy trang / cấu hình của A theo slug hay id ──
    await withOrganization(B, async () => {
      assert.equal(await getPageBySlug("bang-a"), null, "slug của A không tồn tại ở B");
      await assert.rejects(getPageDraft(idA), (e: unknown) => e instanceof MetadataError && e.code === "NOT_FOUND", "id của A ⇒ không tìm thấy");
      const pub = await publishPage(idA, actorB, opts);
      assert.ok(!pub.ok && pub.code === "NOT_FOUND", "B không xuất bản được trang của A");
      const save = await savePageDraft(idA, v1, actorB, opts);
      assert.ok(!save.ok && save.code === "NOT_FOUND");
      const arch = await archivePage(idA, actorB);
      assert.ok(!arch.ok && arch.code === "NOT_FOUND", "B không lưu trữ được trang của A");
      assert.deepEqual(await listPages({ includeArchived: true }), []);
      const own = await createPage({ slug: "bang-a", name: "Bảng của B", moduleKey: "orders" }, actorB, opts);
      assert.ok(own.ok, "cùng slug ở tổ chức khác — hai CSDL, hai sổ");
    });
    await withOrganization(A, async () => assert.equal((await getPageBySlug("bang-a"))?.page.name, "Bảng A mới", "trang của B không đè trang của A"));

    // ── 3b. Sổ THẬT + trình phân giải THẬT (P4-DATA): trang KPI + bảng + dòng thời gian xuất bản rồi dựng ──
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values([{ id: "pr4-a-cus1", name: "Khách thật A1" }]);
      const real: PageSchema = {
        version: 1,
        sections: [
          {
            key: "main",
            blocks: [
              { id: "don_hom_nay", type: "kpi", span: 3, config: { metric: "orders_today", period: "today" } } as PageBlock,
              { id: "khach", type: "table", span: 12, config: { source: "customer", columns: ["system:name"], pageSize: 10 } } as PageBlock,
              // Khoá dòng thời gian của field custom là `custom_record_<đối tượng>`; URL không mang `id` ⇒ khối này HỎNG lúc dựng.
              { id: "lich_su", type: "timeline", span: 6, config: { source: "custom_record_customer", recordParam: "id", limit: 10 } } as PageBlock,
              { id: "sang_trang", type: "button", span: 3, config: { action: "open_page", label: "Mở bảng A", input: { slug: "bang-a" } } } as PageBlock,
            ],
          },
        ],
      };
      const created = await createPage({ slug: "so-lieu-that", name: "Số liệu thật", moduleKey: "orders" }, actorA);
      assert.ok(created.ok, JSON.stringify(created));
      const saved = await savePageDraft(created.page.id, real, actorA);
      assert.ok(saved.ok, `sổ thật nhận schema: ${JSON.stringify(saved)}`);
      assert.ok((await publishPage(created.page.id, actorA)).ok);
      const live = await getPageBySlug("so-lieu-that");
      assert.ok(live);
      const adminView = viewer({ id: actorA.id!, email: actorA.email, role: "ADMIN", permissions: [] });
      const rendered = startPageRender(live.schema, adminView, { searchParams: {}, period: "30d" }, live.page.slug, resolvePage);
      const byId = new Map((await Promise.all(rendered.flatMap((x) => x.blocks).map((b) => b.result))).map((r) => [r.block.id, r]));
      const k = byId.get("don_hom_nay");
      assert.ok(k?.ok, `KPI có dữ liệu: ${JSON.stringify(k)}`);
      const t = byId.get("khach");
      assert.ok(t?.ok && (t.data as { rows: { id: string }[] }).rows.some((r) => r.id === "pr4-a-cus1"), `bảng đọc đúng CSDL của tổ chức: ${JSON.stringify(t)}`);
      const broken = byId.get("lich_su");
      assert.ok(broken && !broken.ok, "khối hỏng thành chỗ giữ");
      assert.ok(byId.get("sang_trang")?.ok, "khối hỏng không làm hỏng khối khác");
      // Người thiếu quyền khách hàng: bảng bị MÁY CHỦ từ chối, KPI đơn vẫn đọc được (G8).
      const narrow = viewer({ id: actorA.id!, email: actorA.email, role: "VIEWER", permissions: ["orders:read"] });
      const r2 = new Map((await Promise.all(startPageRender(live.schema, narrow, { searchParams: {}, period: "30d" }, live.page.slug, resolvePage).flatMap((x) => x.blocks).map((b) => b.result))).map((r) => [r.block.id, r]));
      const denied = r2.get("khach");
      assert.ok(denied && !denied.ok && denied.issue.code === "FORBIDDEN", `thiếu customers:view ⇒ FORBIDDEN: ${JSON.stringify(denied)}`);
      assert.ok(r2.get("don_hom_nay")?.ok, "KPI đơn vẫn đọc được với orders:read");
      // Nút đọc lại cấu hình ĐÃ XUẤT BẢN qua `getPageBySlug` (đúng nối dây của `runPageAction`).
      const go = await executePageAction("so-lieu-that", "sang_trang", {}, adminView, { loadPublished: getPageBySlug });
      assert.ok(go.ok && go.redirectTo === "/p/bang-a", JSON.stringify(go));
      const draftOnly = { ...real, sections: [{ key: "main", blocks: [...real.sections[0].blocks, { id: "chi_trong_nhap", type: "button", span: 3, config: { action: "open_page", label: "x", input: { slug: "bang-a" } } } as PageBlock] }] };
      assert.ok((await savePageDraft(created.page.id, draftOnly, actorA)).ok);
      const ghost = await executePageAction("so-lieu-that", "chi_trong_nhap", {}, adminView, { loadPublished: getPageBySlug });
      assert.ok(!ghost.ok && ghost.code === "NOT_FOUND", "khối chỉ có trong NHÁP không bấm được");
    });
    await withOrganization(B, async () => {
      const bView = viewer({ id: actorB.id!, email: actorB.email, role: "ADMIN", permissions: [] });
      const cross = await executePageAction("so-lieu-that", "sang_trang", {}, bView, { loadPublished: getPageBySlug });
      assert.ok(!cross.ok && cross.code === "NOT_FOUND", "B không bấm được nút trên trang của A");
    });
    // Mẫu dựng từ SỔ THẬT phải qua kiểm schema (không khoá bịa).
    const realOn = new Set<ModuleKey>([...ON, "inventory", "returns"]);
    for (const t of PAGE_TEMPLATES) {
      const built = buildTemplateSchema(t.key, { catalog: defaultPageCatalog(), modules: realOn, customFields: [{ objectKey: "customer", key: "giai_doan", label: "Giai đoạn", type: "status", listable: true }] });
      const v = validatePageSchema(built.schema, { modules: realOn });
      assert.equal(v.ok, true, `mẫu ${t.key} trên sổ thật: ${JSON.stringify(v.errors)}`);
      if (t.key !== "customer-workspace") assert.deepEqual(built.skipped, [], `mẫu ${t.key}: mọi khoá ứng viên có trong sổ thật`);
    }

    // ── 4. Mẫu: chỉ khi bấm, sinh ở NHÁP, chỉ dùng khoá sổ có thật ──
    await withOrganization(A, async () => {
      const ws = await createPageFromTemplate("customer-workspace", actorA, {}, opts);
      assert.ok(ws.ok, JSON.stringify(ws));
      assert.equal(ws.page.publishedVersion, 0, "mẫu sinh ở NHÁP");
      assert.equal(await getPageBySlug(ws.page.slug), null, "người dùng chưa thấy trang mẫu");
      const d = (await getPageDraft(ws.page.id)).draft;
      const tbl = d.sections.flatMap((s) => s.blocks).find((b) => b.id === "customers_table");
      assert.ok(tbl && (tbl.config as { columns: string[] }).columns.includes("custom:hang"), "cột custom của tổ chức vào bảng");
      assert.ok(ws.skipped.some((x) => x.blockId === "customers_kanban"), "chưa có field trạng thái ⇒ bỏ kanban VÀ nói ra");
      assert.ok((await createCustomField("customer", { key: "giai_doan", label: "Giai đoạn", type: "status", options: [{ value: "moi", label: "Mới" }, { value: "xong", label: "Xong" }] }, actorA)).ok);
      const ws2 = await createPageFromTemplate("customer-workspace", actorA, { slug: "ban-lam-viec-2" }, opts);
      assert.ok(ws2.ok && !ws2.skipped.some((x) => x.blockId === "customers_kanban"), "có field trạng thái ⇒ có kanban");
      const sales = await createPageFromTemplate("sales-overview", actorA, {}, opts);
      assert.ok(sales.ok, JSON.stringify(sales));
      assert.ok(sales.skipped.some((x) => x.blockId === "orders_today"), "sổ giả không có khoá orders_today ⇒ khối bị bỏ, không đoán khoá gần giống");
      const unknown = await createPageFromTemplate("khong-co", actorA, {}, opts);
      assert.ok(!unknown.ok && unknown.code === "NOT_FOUND");
    });
    assert.deepEqual(templates().map((t) => t.key), ["sales-overview", "inventory-overview", "customer-workspace"], "trình soạn đọc ba mẫu");
    // Mẫu chỉ dùng khoá có thật: dựng thuần với sổ giả rồi kiểm lại.
    for (const t of PAGE_TEMPLATES) {
      const built = buildTemplateSchema(t.key, { catalog: CAT, modules: ON, customFields: [] });
      assert.equal(validatePageSchema(built.schema, { modules: ON, catalog: CAT }).ok, true, `mẫu ${t.key} dựng ra schema hợp lệ`);
    }

    // ── 5. Lưu trữ ⇒ không mở, rời menu, không sửa được ──
    await withOrganization(A, async () => {
      const arch = await archivePage(idA, actorA);
      assert.ok(arch.ok && arch.page.status === "ARCHIVED");
      assert.equal(await getPageBySlug("bang-a"), null, "lưu trữ ⇒ không mở được");
      assert.ok(!(await listNavPages()).some((p) => p.id === idA), "lưu trữ ⇒ rời menu");
      assert.ok(!(await listPages()).some((p) => p.id === idA));
      assert.ok((await listPages({ includeArchived: true })).some((p) => p.id === idA), "không xoá dữ liệu");
      const edit = await updatePageMeta(idA, { name: "x" }, actorA);
      assert.ok(!edit.ok && edit.code === "ARCHIVED");
      const repub = await publishPage(idA, actorA, opts);
      assert.ok(!repub.ok && repub.code === "ARCHIVED");
      assert.equal((await auditOf(idA, "META_PAGE_ARCHIVE")).length, 1);
    });

    console.log("✓ Trang động · hai tổ chức: tạo → nháp (chưa thấy) → xuất bản (phiên bản + ảnh chụp + nhật ký) · slug bất biến · module tắt chặn xuất bản · id/slug chéo tổ chức ⇒ không tồn tại · sổ + trình phân giải THẬT: KPI/bảng có số, khối hỏng không kéo khối khác, thiếu quyền ⇒ máy chủ từ chối, nút đọc bản đã xuất bản · mẫu sinh ở NHÁP · lưu trữ ⇒ không mở, rời menu");
  } finally {
    for (const code of [A, B]) await cleanupOrg(code);
  }
}

export async function testPageRuntime() {
  testValidatePure();
  await testRenderIsolation();
  await testLifecycle();
}

