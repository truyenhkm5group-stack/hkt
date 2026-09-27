/**
 * NỀN TẢNG · TRÌNH SOẠN TRANG TUỲ BIẾN (Phase 4) — `/settings/pages`, `/settings/pages/new`, `/settings/pages/[id]`.
 *
 * Server action đọc cookie của Next nên không gọi được ngoài request; bài này gọi LÕI của màn hình
 * (`lib/platform-ui/page-admin.ts`) với `SessionUser` dựng tay — cùng hàm action gọi, không nhánh riêng cho kiểm
 * thử. Phần thuần (`page-admin-shared.ts`) kiểm riêng: khoá khối không trùng, lỗi theo `path` về đúng khối / nhóm,
 * chuyển khối giữa nhóm không mất khối, gợi ý đường dẫn bỏ dấu.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema as dbSchema } from "@/db";
import { visible, type NavUserLike } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { MODULE_KEYS, moduleOfPath } from "@/lib/constants/platform-modules";
import type { PageSchema } from "@/lib/pages/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { sameConfig } from "@/lib/platform-ui/metadata-admin-shared";
import {
  adminArchivePage,
  adminCreatePage,
  adminCreatePageFromTemplate,
  adminPublishPage,
  adminSavePageDraft,
  adminUpdatePageMeta,
  loadPageEditor,
  loadPageList,
  pageAdminDenial,
  pageMetaOptions,
} from "@/lib/platform-ui/page-admin";
import {
  BLOCK_TYPE_LABEL,
  blankPageMeta,
  blankSchema,
  checkPageDraft,
  checkPageMeta,
  metaErrorsFor,
  moveBlockToSection,
  newBlock,
  normalizePageMeta,
  normalizePath,
  pageState,
  splitPageErrors,
  suggestBlockId,
  suggestSlug,
  type PageEditorCatalog,
} from "@/lib/platform-ui/page-admin-shared";
import { BLOCK_TYPES } from "@/lib/pages/types";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "pa-user", email: "pa@local", name: "PA", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

function testMenu() {
  const item = NAV_MODULES.find((m) => m.href === "/settings/pages");
  assert.ok(item, "sổ menu phải có /settings/pages");
  assert.equal(item.zone, "SYSTEM", "Trang tuỳ biến thuộc vùng Hệ thống");
  assert.equal("permission" in item ? item.permission : null, "metadata:manage");
  assert.ok(item.why.length > 20, "mục menu phải nói VÌ SAO nó thuộc quản trị");
  assert.equal(moduleOfPath("/settings/pages"), "core", "trình soạn trang thuộc lõi — không module nào tắt được nó");
  assert.equal(moduleOfPath("/p/bat-ky"), "core", "tiền tố /p thuộc lõi (G11); module THẬT của trang kiểm trong route");
  const manager: NavUserLike = { role: "MANAGER", permissions: ["dashboard:view", "workflow:manage"], modules: [...MODULE_KEYS] };
  assert.equal(visible(item, manager), false, "không có metadata:manage ⇒ không thấy mục menu");
  assert.equal(visible(item, { ...manager, permissions: ["metadata:manage"] }), true);
}

const EMPTY_CATALOG: PageEditorCatalog = { metrics: [], series: [], lists: [], timelines: [], actions: [], objects: [], periods: [] };

function testPure() {
  // Nhãn: mọi loại khối có nhãn tiếng Việt, không hai loại chung một nhãn.
  const labels = BLOCK_TYPES.map((t) => BLOCK_TYPE_LABEL[t]);
  assert.ok(labels.every((l) => l.length > 2));
  assert.equal(new Set(labels).size, labels.length);

  // Gợi ý đường dẫn: bỏ dấu, không trùng, luôn khớp mẫu slug.
  assert.equal(suggestSlug("Tổng quan bán hàng"), "tong-quan-ban-hang");
  assert.equal(suggestSlug("Tổng quan bán hàng", new Set(["tong-quan-ban-hang"])), "tong-quan-ban-hang-2");
  assert.equal(suggestSlug("2026 — đơn"), "trang-2026-don", "không bắt đầu bằng số");
  assert.equal(suggestSlug("!!"), "trang-moi");

  // Thông tin trang: đường dẫn KHOÁ sau lần xuất bản đầu ⇒ không kiểm lại (không đổi được), module phải đang bật.
  const meta = normalizePageMeta({ ...blankPageMeta(), name: "  Bán hàng  ", slug: "ban-hang", nav: { enabled: true, label: " ", zone: "", order: 3 } });
  assert.equal(meta.name, "Bán hàng");
  assert.equal(meta.nav.label, "Bán hàng", "nhãn menu trống ⇒ theo tên trang");
  assert.equal(meta.nav.zone, null, "nhóm rỗng ⇒ null = nhóm «Trang tuỳ biến»");
  const modules = new Set(["core", "orders"]);
  assert.deepEqual(checkPageMeta(meta, { takenSlugs: new Set(), slugLocked: false, modules }), []);
  assert.deepEqual(checkPageMeta({ ...meta, slug: "Bán Hàng" }, { takenSlugs: new Set(), slugLocked: false, modules }).map((e) => e.path), ["slug"]);
  assert.deepEqual(checkPageMeta(meta, { takenSlugs: new Set(["ban-hang"]), slugLocked: false, modules }).map((e) => e.path), ["slug"], "slug trùng trang khác");
  assert.deepEqual(checkPageMeta({ ...meta, slug: "Bán Hàng" }, { takenSlugs: new Set(), slugLocked: true, modules }), [], "đã khoá ⇒ không kiểm slug");
  assert.deepEqual(checkPageMeta({ ...meta, moduleKey: "finance" }, { takenSlugs: new Set(), slugLocked: false, modules }).map((e) => e.path), ["moduleKey"], "module tắt ⇒ không chọn được");
  assert.deepEqual(metaErrorsFor([{ path: "nav.label", message: "x" }, { path: "name", message: "y" }], "nav").map((e) => e.message), ["x"]);

  // Khối mới: khoá không trùng, cấu hình khởi đầu đúng loại; sổ trống ⇒ kiểm sớm báo "chưa chọn nguồn" tại đúng path.
  let schema = blankSchema();
  for (const type of BLOCK_TYPES) {
    const b = newBlock(type, schema, EMPTY_CATALOG);
    assert.equal(b.type, type);
    schema = { ...schema, sections: [{ ...schema.sections[0], blocks: [...schema.sections[0].blocks, b] }] };
  }
  const ids = schema.sections[0].blocks.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length, "khoá khối không trùng");
  assert.equal(suggestBlockId(schema, "kpi"), "kpi_2");
  const early = checkPageDraft(schema);
  for (const [i, field] of ["metric", "source", "series", "objectKey", "source", "objectKey", "action", "body"].entries()) {
    assert.ok(early.some((e) => e.path === `sections.0.blocks.${i}.config.${field}`), `khối ${BLOCK_TYPES[i]} thiếu nguồn ⇒ báo ở sections.0.blocks.${i}.config.${field}`);
  }
  const dup: PageSchema = { version: 1, sections: [{ key: "a", blocks: [{ id: "x1", type: "text", span: 12, config: { body: "a" } }, { id: "x1", type: "text", span: 12, config: { body: "b" } }] }] };
  assert.deepEqual(checkPageDraft(dup).map((e) => e.path), ["sections.0.blocks.1.id"], "khoá khối trùng ⇒ báo ở khối thứ hai");
  const tooMany: PageSchema = { version: 1, sections: [{ key: "a", blocks: Array.from({ length: 21 }, (_, i) => ({ id: `t_${i}`, type: "text" as const, span: 12 as const, config: { body: "x" } })) }] };
  assert.ok(checkPageDraft(tooMany).some((e) => e.path === "sections" && /20/.test(e.message)), "trần 20 khối");

  // Lỗi của máy chủ theo `path` về ĐÚNG MỘT chỗ; cú pháp ngoặc vuông cũng khớp; lỗi lạ không bị nuốt.
  const two: PageSchema = { version: 1, sections: [{ key: "a", blocks: [dup.sections[0].blocks[0]] }, { key: "b", blocks: [{ id: "k", type: "kpi", span: 3, config: { metric: "x" } }] }] };
  const split = splitPageErrors(
    [
      { path: "sections.1.blocks.0.config.metric", message: "Nguồn «x» không có trong sổ." },
      { path: "sections[0].title", message: "Tiêu đề quá dài." },
      { path: "sections.10.blocks.0", message: "lạc" },
      { path: "nav", message: "chung" },
    ],
    two,
  );
  assert.deepEqual(split.block[1][0].map((e) => e.message), ["Nguồn «x» không có trong sổ."]);
  assert.deepEqual(split.section[0].map((e) => e.message), ["Tiêu đề quá dài."]);
  assert.deepEqual(split.general.map((e) => e.message), ["lạc", "chung"], "lỗi không gắn được chỗ nào hiện ở đầu, không biến mất");
  assert.equal(split.block[0][0].length + split.section[1].length, 0);
  assert.equal(normalizePath("sections[2].blocks[0].config"), "sections.2.blocks.0.config");

  // Chuyển khối giữa nhóm: không mất, không nhân đôi; chỉ số lạ ⇒ không đổi.
  const moved = moveBlockToSection(two, 1, 0, 0);
  assert.deepEqual(moved.sections.map((s) => s.blocks.map((b) => b.id)), [["x1", "k"], []]);
  assert.deepEqual(moveBlockToSection(two, 0, 5, 1), two);

  assert.equal(pageState({ status: "ACTIVE", publishedVersion: 0 }), "DRAFT_ONLY");
  assert.equal(pageState({ status: "ACTIVE", publishedVersion: 2 }), "PUBLISHED");
  assert.equal(pageState({ status: "ARCHIVED", publishedVersion: 2 }), "ARCHIVED");
}

async function testCoreGates() {
  // Người thiếu `metadata:manage` bị từ chối Ở LÕI — kể cả khi gọi thẳng, bỏ qua trang — và dịch vụ không được gọi.
  const manager = sessionUser({ role: "MANAGER", permissions: ["customers:view", "workflow:manage"] });
  assert.match(pageAdminDenial(manager) ?? "", /quyền/);
  const meta = { ...blankPageMeta(), name: "Thử", slug: "thu" };
  for (const r of [
    await loadPageList(manager),
    await loadPageEditor(manager, null),
    await loadPageEditor(manager, "p1"),
    await adminCreatePage(manager, meta),
    await adminCreatePageFromTemplate(manager, "sales-overview"),
    await adminUpdatePageMeta(manager, "p1", meta),
    await adminSavePageDraft(manager, "p1", blankSchema()),
    await adminPublishPage(manager, "p1"),
    await adminArchivePage(manager, "p1"),
  ]) {
    assert.ok(!r.ok && /quyền/.test(r.errors[0]?.message ?? ""), "thiếu metadata:manage ⇒ từ chối ở lõi");
  }
  assert.match(pageAdminDenial(sessionUser({ organization: undefined })) ?? "", /tổ chức/, "phiên không mang tổ chức ⇒ từ chối, không rơi về tổ chức nhà");
  assert.equal(pageAdminDenial(sessionUser({ role: "VIEWER", permissions: ["metadata:manage"] })), null, "vai trò bất kỳ có khoá là được");

  // Đầu vào lạ bị chặn trước dịch vụ; module chủ phải ĐANG BẬT với tổ chức người bấm.
  const admin = sessionUser({ modules: ["core", "customers"] });
  const offModule = await adminCreatePage(admin, { ...meta, moduleKey: "finance" });
  assert.ok(!offModule.ok && offModule.errors[0].path === "moduleKey" && /đang tắt/.test(offModule.errors[0].message), "module chủ đang tắt ⇒ từ chối ở ô moduleKey");
  const bogus = await adminCreatePage(admin, { ...meta, moduleKey: "khong_co" });
  assert.ok(!bogus.ok && bogus.errors[0].path === "moduleKey");
  assert.ok(!(await adminCreatePage(admin, "không phải object")).ok);
  const badSchema = await adminSavePageDraft(admin, "p1", { sections: "x" });
  assert.ok(!badSchema.ok && badSchema.errors[0].path === "sections");
  assert.ok(!(await adminPublishPage(admin, "  ")).ok, "thiếu mã trang");
  const badTemplate = await adminCreatePageFromTemplate(admin, "khong_co_mau");
  assert.ok(!badTemplate.ok && badTemplate.errors[0].path === "template", "mẫu lạ ⇒ từ chối");

  // Ô chọn: chỉ module đang bật; quyền của module tắt không hiện.
  const options = pageMetaOptions(admin);
  assert.deepEqual(options.modules.map((m) => m.key).sort(), ["core", "customers"]);
  assert.ok(options.permissions.some((p) => p.key === "customers:view"));
  assert.ok(!options.permissions.some((p) => p.key === "orders:read"), "quyền thuộc module đang tắt không chọn được");
  assert.equal(options.zones[0].key, "", "nhóm đầu = «Trang tuỳ biến» (null)");

  // Trình soạn trang mới đọc sổ lọc theo module đang bật: đối tượng của module tắt không hiện.
  const blank = await loadPageEditor(admin, null);
  assert.ok(blank.ok, JSON.stringify(blank));
  assert.equal(blank.value.page, null);
  assert.ok(blank.value.catalog.objects.some((o) => o.key === "customer"));
  assert.ok(!blank.value.catalog.objects.some((o) => o.key === "order"), "đối tượng của module tắt không vào sổ trình soạn");
  assert.ok(blank.value.catalog.periods.every((p) => p.value !== "custom"), "khối không nhận kỳ tuỳ chọn (không có ô ngày)");
}

const ORG = "pa-p4";

async function cleanupOrg(code: string) {
  const pdb = await getPlatformDb();
  const org = await pdb.query.platformOrganizations.findFirst({ where: eq(dbSchema.platformOrganizations.code, code) });
  if (org) {
    await pdb.delete(dbSchema.platformOrganizationModules).where(eq(dbSchema.platformOrganizationModules.organizationId, org.id));
    await pdb.delete(dbSchema.platformOrganizations).where(eq(dbSchema.platformOrganizations.id, org.id));
  }
  invalidateOrganizations();
  invalidateCapabilities();
}

/**
 * Vòng đời THẬT qua lõi màn hình trên CSDL của một tổ chức riêng (`pa-p4`, tự cấp và tự dọn) — cùng hàm mà server
 * action gọi, dịch vụ `lib/pages/registry` thật, sổ nguồn thật: tạo ⇒ NHÁP → lưu nháp sai ⇒ lỗi đúng `path` và
 * không ghi → lưu nháp đúng → xuất bản ⇒ danh sách phản ánh phiên bản + người xuất bản → nháp lệch bản xuất bản →
 * xuất bản lại ⇒ phiên bản 2 → slug khoá → tạo từ mẫu ⇒ NHÁP (bấm hai lần ⇒ hai trang, slug không va) → lưu trữ.
 */
async function testLifecycleDb() {
  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: ORG, name: "Tổ chức thử trang tuỳ biến", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT Trang", password: "Page@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const row = await db.query.users.findFirst({ where: eq(dbSchema.users.email, `admin@${ORG}.local`) });
      assert.ok(row);
      const modules = [...(await getEnabledModules(ORG))];
      const admin = sessionUser({ id: row.id, email: row.email, organization: { code: ORG, name: "Trang", isHome: false }, modules });

      const empty = await loadPageList(admin);
      assert.ok(empty.ok && empty.value.pages.length === 0, "tổ chức mới không có trang nào — mẫu không tự kích hoạt (luật 23)");
      const tplKeys = empty.value.templates.map((t) => t.key);
      assert.ok(tplKeys.includes("sales-overview"), "mẫu của module đang bật được liệt kê");
      if (!modules.includes("inventory")) assert.ok(!tplKeys.includes("inventory-overview"), "mẫu của module đang tắt không hiện");

      // ── Tạo ⇒ NHÁP ──
      const created = await adminCreatePage(admin, normalizePageMeta({ ...blankPageMeta(), name: "Bán hàng hôm nay", slug: "ban-hang", moduleKey: "orders", nav: { enabled: true, label: "", zone: null, order: 5 } }));
      assert.ok(created.ok, JSON.stringify(created));
      const id = created.id;
      const dupSlug = await adminCreatePage(admin, { ...blankPageMeta(), name: "Trùng", slug: "ban-hang", moduleKey: "orders" });
      assert.ok(!dupSlug.ok && dupSlug.errors.some((e) => e.path === "slug"), "slug trùng ⇒ lỗi của dịch vụ về đúng ô slug");
      const fresh = await loadPageEditor(admin, id);
      assert.ok(fresh.ok && fresh.value.page, JSON.stringify(fresh));
      assert.equal(fresh.value.page.publishedVersion, 0, "trang mới ở NHÁP — chưa xuất bản");
      assert.equal(fresh.value.published, null);
      assert.equal(fresh.value.draft.sections.length, 1, "nháp rỗng mở với một nhóm trống để có chỗ thêm khối");
      const catalog = fresh.value.catalog;
      assert.ok(catalog.metrics.some((m) => m.key === "orders_today"), "sổ nguồn của trình soạn = listDataSources của người soạn");
      assert.ok(catalog.lists.some((l) => l.objectKey === "order"));

      // ── Lưu nháp SAI ⇒ lỗi validatePageSchema đúng `path`, không ghi gì ──
      const bad: PageSchema = { version: 1, sections: [{ key: "tong_quan", blocks: [{ id: "don_hom_nay", type: "kpi", span: 3, config: { metric: "khong_co_nguon" } }] }] };
      const badSave = await adminSavePageDraft(admin, id, bad);
      assert.ok(!badSave.ok, "nguồn lạ ⇒ không lưu được");
      assert.ok(badSave.errors.some((e) => normalizePath(e.path) === "sections.0.blocks.0.config.metric"), `lỗi về đúng path: ${JSON.stringify(badSave.errors)}`);
      assert.ok(splitPageErrors(badSave.errors, bad).block[0][0].length > 0, "màn hình đặt lỗi dưới đúng khối");
      const afterBad = await loadPageEditor(admin, id);
      assert.ok(afterBad.ok && afterBad.value.draft.sections[0].blocks.length === 0, "lượt lưu bị từ chối không ghi nháp");

      // ── Lưu nháp ĐÚNG → xuất bản ⇒ danh sách phản ánh phiên bản ──
      let draft = blankSchema();
      const kpi = { ...newBlock("kpi", draft, catalog), config: { metric: "orders_today" } };
      draft = { ...draft, sections: [{ ...draft.sections[0], blocks: [kpi] }] };
      const table = newBlock("table", draft, { ...catalog, lists: catalog.lists.filter((l) => l.objectKey === "order") });
      draft = { ...draft, sections: [{ ...draft.sections[0], blocks: [kpi, table] }] };
      assert.deepEqual(checkPageDraft(draft), [], "khối dựng từ sổ thật qua được kiểm sớm");
      const saved = await adminSavePageDraft(admin, id, draft);
      assert.ok(saved.ok, JSON.stringify(saved));
      const listDraft = await loadPageList(admin);
      assert.ok(listDraft.ok);
      assert.equal(listDraft.value.pages.find((p) => p.id === id)?.publishedVersion, 0, "lưu nháp KHÔNG xuất bản");

      const pub = await adminPublishPage(admin, id);
      assert.ok(pub.ok, JSON.stringify(pub));
      const list1 = await loadPageList(admin);
      assert.ok(list1.ok);
      const row1 = list1.value.pages.find((p) => p.id === id);
      assert.equal(row1?.publishedVersion, 1, "danh sách phản ánh phiên bản 1");
      assert.ok(row1?.publishedAt, "có mốc xuất bản");
      assert.equal(row1?.nav.enabled, true);
      assert.equal(row1?.nav.label, "Bán hàng hôm nay", "nhãn menu trống ⇒ theo tên trang");
      const v1 = await loadPageEditor(admin, id);
      assert.ok(v1.ok && v1.value.page && v1.value.published);
      assert.equal(v1.value.page.publishedBy, "QT Trang", "dòng «Đang xuất bản» đọc TÊN người bấm theo khoá tài khoản");
      assert.ok(sameConfig(v1.value.draft, v1.value.published), "vừa xuất bản ⇒ nháp trùng bản xuất bản (không bật cờ lệch)");

      // ── Nháp lệch → xuất bản lại ⇒ phiên bản 2 ──
      const base = v1.value.draft.sections[0];
      const withText: PageSchema = { ...v1.value.draft, sections: [{ ...base, blocks: [...base.blocks, { id: "ghi_chu", type: "text", span: 12, config: { heading: "Ghi chú ca" } }] }] };
      assert.ok((await adminSavePageDraft(admin, id, withText)).ok);
      const drifted = await loadPageEditor(admin, id);
      assert.ok(drifted.ok && drifted.value.published);
      assert.ok(!sameConfig(drifted.value.draft, drifted.value.published), "nháp khác bản đã xuất bản ⇒ cờ lệch bật");
      assert.equal(drifted.value.page?.publishedVersion, 1, "lưu nháp không đổi phiên bản đang chạy");
      assert.ok((await adminPublishPage(admin, id)).ok);
      const list2 = await loadPageList(admin);
      assert.ok(list2.ok && list2.value.pages.find((p) => p.id === id)?.publishedVersion === 2, "xuất bản lại ⇒ phiên bản 2");

      // ── Slug khoá sau lần xuất bản đầu ──
      const moveSlug = await adminUpdatePageMeta(admin, id, { ...blankPageMeta(), name: "Bán hàng hôm nay", slug: "ban-hang-moi", moduleKey: "orders" });
      assert.ok(!moveSlug.ok && moveSlug.errors.some((e) => e.path === "slug"), "đổi slug sau khi xuất bản ⇒ từ chối ở ô slug");
      const rename = await adminUpdatePageMeta(admin, id, { ...blankPageMeta(), name: "Bán hàng", slug: "ban-hang", moduleKey: "orders" });
      assert.ok(rename.ok, JSON.stringify(rename));

      // ── Tạo từ mẫu ⇒ NHÁP; bấm lần hai ⇒ trang thứ hai, slug không va ──
      const t1 = await adminCreatePageFromTemplate(admin, "sales-overview");
      assert.ok(t1.ok, JSON.stringify(t1));
      const t2 = await adminCreatePageFromTemplate(admin, "sales-overview");
      assert.ok(t2.ok, JSON.stringify(t2));
      const tv = await loadPageEditor(admin, t1.id);
      assert.ok(tv.ok && tv.value.page);
      assert.equal(tv.value.page.publishedVersion, 0, "trang từ mẫu sinh ở NHÁP");
      assert.ok(tv.value.draft.sections.some((s) => s.blocks.length > 0), "nháp từ mẫu có khối");
      const list3 = await loadPageList(admin);
      assert.ok(list3.ok);
      const slugs = list3.value.pages.map((p) => p.slug);
      assert.equal(new Set(slugs).size, slugs.length, "hai lần tạo từ mẫu không va slug");

      // ── Lưu trữ ──
      assert.ok((await adminArchivePage(admin, t2.id)).ok);
      const list4 = await loadPageList(admin);
      assert.ok(list4.ok);
      assert.equal(list4.value.pages.find((p) => p.id === t2.id)?.status, "ARCHIVED");
      assert.equal(list4.value.pages.at(-1)?.id, t2.id, "trang lưu trữ xuống cuối bảng");
      assert.ok(!(await adminSavePageDraft(admin, t2.id, draft)).ok, "trang đã lưu trữ không sửa được");

      // Người cùng tổ chức mà thiếu quyền: lõi từ chối trước dịch vụ.
      const viewer = sessionUser({ ...admin, role: "VIEWER", permissions: ["orders:read"] });
      assert.ok(!(await adminPublishPage(viewer, id)).ok);
      assert.ok(!(await loadPageList(viewer)).ok);
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testPageAdmin() {
  testMenu();
  testPure();
  await testCoreGates();
  await testLifecycleDb();
  console.log("✓ Nền tảng · trình soạn trang tuỳ biến (giao diện): menu gác bằng metadata:manage (vùng Hệ thống, thuộc lõi), lõi từ chối người thiếu quyền / phiên không tổ chức trước dịch vụ, module chủ phải đang bật; khoá khối không trùng, kiểm sớm báo đúng path từng loại khối, lỗi máy chủ theo path về đúng khối / nhóm và lỗi lạc không bị nuốt, chuyển khối giữa nhóm không mất khối; vòng đời thật (pa-p4): tạo ⇒ NHÁP, nguồn lạ ⇒ lỗi ở sections.0.blocks.0.config.metric và không ghi, lưu nháp ⇒ vẫn phiên bản 0, xuất bản ⇒ danh sách phiên bản 1 + tên người bấm, nháp lệch ⇒ cờ bật, xuất bản lại ⇒ 2, slug khoá, tạo từ mẫu hai lần ⇒ hai NHÁP không va slug, lưu trữ xuống cuối");
}
