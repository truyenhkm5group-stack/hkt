/**
 * NỀN TẢNG · GIAO DIỆN QUẢN TRỊ METADATA (Phase 2) — bốn màn hình `/settings/{data-model,forms,lists,statuses}`.
 *
 * Server action (`lib/actions/metadata-admin.ts`) đọc cookie của Next nên không gọi được ngoài request; bài
 * này gọi LÕI của chúng (`lib/platform-ui/metadata-admin.ts`) với `SessionUser` dựng tay — cùng hàm action
 * gọi, không nhánh riêng cho kiểm thử.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { visible, type NavUserLike } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { MODULE_KEYS, moduleOfPath } from "@/lib/constants/platform-modules";
import { getPublishedForm } from "@/lib/metadata/forms";
import { getPublishedListView } from "@/lib/metadata/lists";
import { resolveStatusLabel } from "@/lib/metadata/statuses";
import { FIELD_KEY_PATTERN, type FormSchema } from "@/lib/metadata/types";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import {
  adminArchiveField,
  adminCreateField,
  adminMoveField,
  adminPublishForm,
  adminPublishList,
  adminSaveFormDraft,
  adminSaveListDraft,
  adminSaveStatusOverrides,
  adminUpdateField,
  FIELD_INPUT_MATCHES_SERVICE,
  loadDataModel,
  loadFormEditor,
  loadListEditor,
  loadStatusEditor,
  metadataAdminDenial,
  resolveAdminObject,
} from "@/lib/platform-ui/metadata-admin";
import {
  adminObjects,
  buildCatalog,
  checkFieldInput,
  blankFieldInput,
  mergeListColumns,
  moveItem,
  normalizeFieldInput,
  sameConfig,
  sameFormLayout,
  sameListLayout,
  suggestFieldKey,
  unplacedFields,
} from "@/lib/platform-ui/metadata-admin-shared";
import { objectDef } from "@/lib/constants/object-registry";

const ADMIN_PAGES = ["/settings/data-model", "/settings/forms", "/settings/lists", "/settings/statuses"] as const;

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "ma-user", email: "ma@local", name: "MA", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

function testMenu() {
  for (const href of ADMIN_PAGES) {
    const item = NAV_MODULES.find((m) => m.href === href);
    assert.ok(item, `sổ menu phải có ${href}`);
    assert.equal(item.zone, "SYSTEM", `${href} thuộc vùng Hệ thống`);
    assert.equal("permission" in item ? item.permission : null, "metadata:manage", `${href} gác bằng metadata:manage`);
    assert.equal(moduleOfPath(href), "core", `${href} thuộc lõi — không module nào tắt được màn hình cấu hình`);
    const manager: NavUserLike = { role: "MANAGER", permissions: ["dashboard:view", "customers:view"], modules: [...MODULE_KEYS] };
    assert.equal(visible(item, manager), false, `${href}: không có metadata:manage ⇒ không thấy mục menu`);
    assert.equal(visible(item, { ...manager, permissions: ["metadata:manage"] }), true);
  }
}

function testPure() {
  // Gợi ý khoá: bỏ dấu (cả đ), chữ thường, không trùng, luôn khớp mẫu khoá của hợp đồng (M4).
  assert.equal(suggestFieldKey("Ngày sinh"), "ngay_sinh");
  assert.equal(suggestFieldKey("Đường dây nóng"), "duong_day_nong");
  assert.equal(suggestFieldKey("địa chỉ giao"), "dia_chi_giao", "đ thường cũng bỏ dấu");
  assert.equal(suggestFieldKey("Hạng thành viên", new Set(["hang_thanh_vien"])), "hang_thanh_vien_2");
  assert.equal(suggestFieldKey("2024 mã"), "f_2024_ma", "không bắt đầu bằng số");
  for (const s of ["", "?", "a", "Ư".repeat(80), "Số điện thoại (phụ)", "1"]) assert.match(suggestFieldKey(s), FIELD_KEY_PATTERN, `«${s}» ⇒ khoá hợp lệ`);

  // Kiểm sớm: trùng khoá hệ thống, trùng khoá đã lưu trữ, tuỳ chọn trùng, regex hỏng.
  const base = { ...blankFieldInput(), key: "name", label: "Tên" };
  const opts = { creating: true, takenKeys: new Set(["hang"]), systemKeys: new Set(["name"]) };
  assert.ok(checkFieldInput(base, opts).some((e) => e.field === "key" && /hệ thống/.test(e.message)));
  assert.ok(checkFieldInput({ ...base, key: "hang" }, opts).some((e) => e.field === "key" && /lưu trữ/.test(e.message)), "khoá của field đã lưu trữ cũng không dùng lại được");
  const dupe = normalizeFieldInput({ ...base, key: "hang_the", type: "select", options: [{ value: "a", label: "A", active: true, position: 0 }, { value: "a", label: "B", active: true, position: 1 }] });
  assert.ok(checkFieldInput(dupe, opts).some((e) => e.field === "options.1.value"));
  assert.ok(checkFieldInput({ ...base, key: "ma", validation: { pattern: "(" } }, opts).some((e) => e.field === "validation.pattern"));
  assert.deepEqual(checkFieldInput({ ...base, key: "ma_the" }, opts), []);
  assert.deepEqual(checkFieldInput({ ...base, key: "khong_hop_le!" }, { ...opts, creating: false }), [], "sửa field không kiểm khoá (bất biến)");

  // Chuẩn hoá: bỏ phần không thuộc kiểu; chuyển trạng thái chỉ giữ giá trị còn tồn tại.
  const status = normalizeFieldInput({
    ...base,
    key: "giai_doan",
    type: "status",
    validation: { min: 1, pattern: "x" },
    options: [{ value: " moi ", label: "Mới", active: true, position: 9 }, { value: "xong", label: "Xong", active: true, position: 3 }],
    transitions: { moi: ["xong", "moi", "khong_co"], bo: ["moi"] },
  });
  assert.deepEqual(status.options.map((o) => [o.value, o.position]), [["moi", 0], ["xong", 1]]);
  assert.deepEqual(status.transitions, { moi: ["xong"] }, "bỏ tự-chuyển, bỏ giá trị lạ");
  assert.deepEqual(status.validation, {}, "field trạng thái không mang min/max/pattern");
  assert.equal(normalizeFieldInput({ ...base, type: "user", defaultValue: "u1" }).defaultValue, null, "kiểu người dùng không có mặc định");

  // Danh mục + trình soạn.
  const customer = objectDef("customer");
  assert.ok(customer);
  const catalog = buildCatalog(customer.fields, [
    { id: "1", objectKey: "customer", key: "hang", label: "Hạng", type: "select", required: false, defaultValue: null, options: [{ value: "vip", label: "VIP", active: true, position: 0 }, { value: "cu", label: "Cũ", active: false, position: 1 }], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: true, position: 0, status: "ACTIVE" },
    { id: "2", objectKey: "customer", key: "bo", label: "Bỏ", type: "text", required: false, defaultValue: null, options: [], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: false, position: 1, status: "ARCHIVED" },
  ]);
  assert.ok(!catalog.some((c) => c.ref === "custom:bo"), "field đã lưu trữ không vào trình soạn");
  assert.deepEqual(catalog.find((c) => c.ref === "custom:hang")?.options.map((o) => o.value), ["vip"], "tuỳ chọn đã tắt không chọn được làm mặc định");
  const name = catalog.find((c) => c.ref === "system:name");
  assert.deepEqual([name?.lockedRequired, name?.lockedReadOnly], [true, false], "Tên khách: bắt buộc bị khoá, sửa được");
  assert.equal(catalog.find((c) => c.ref === "system:order_count")?.lockedReadOnly, true, "số liệu tính ra luôn chỉ đọc");
  const form = { version: 1 as const, sections: [{ key: "a", label: "A", fields: [{ ref: "system:name" as const, visible: true, readOnly: false, required: true }] }] };
  assert.equal(unplacedFields(form, catalog).length, catalog.length - 1);
  const cols = mergeListColumns({ version: 1, columns: [{ ref: "custom:hang", visible: true }, { ref: "custom:bo", visible: true }], defaultSort: null, defaultFilters: [] }, catalog);
  assert.deepEqual(cols[0], { ref: "custom:hang", visible: true }, "giữ thứ tự của nháp");
  assert.ok(!cols.some((c) => c.ref === "custom:bo"), "cột trỏ field đã lưu trữ bị bỏ");
  assert.ok(cols.slice(1).every((c) => !c.visible), "field chưa có trong nháp nối cuối ở trạng thái ẨN");
  assert.deepEqual(moveItem([1, 2, 3], 0, -1), [1, 2, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 1, 1), [1, 3, 2]);
  assert.ok(sameConfig({ a: 1, b: [1, { c: 2, d: undefined }] }, { b: [1, { c: 2 }], a: 1 }), "so theo nội dung, không theo thứ tự khoá");
  assert.ok(!sameConfig({ a: [1, 2] }, { a: [2, 1] }), "thứ tự mảng là nội dung");
}

async function testCoreGates() {
  const admin = sessionUser({});
  // Người thiếu `metadata:manage` bị từ chối Ở LÕI — kể cả khi gọi thẳng, bỏ qua trang.
  const manager = sessionUser({ role: "MANAGER", permissions: ["customers:view", "orders:read"] });
  assert.match(metadataAdminDenial(manager) ?? "", /quyền/);
  for (const r of [
    await adminCreateField(manager, "customer", { key: "hang", label: "Hạng", type: "text" }),
    await adminArchiveField(manager, "customer", "hang"),
    await adminSaveFormDraft(manager, "customer", "profile", { version: 1, sections: [] }),
    await adminPublishForm(manager, "customer", "profile"),
    await adminSaveStatusOverrides(manager, "order", "stage", []),
    await loadDataModel(manager, "customer"),
  ]) {
    assert.ok(!r.ok && /quyền/.test(r.errors[0]?.message ?? ""), "thiếu metadata:manage ⇒ từ chối ở lõi");
  }
  assert.ok(!resolveAdminObject(sessionUser({ organization: undefined }), "customer", "customFields").ok, "phiên không mang tổ chức ⇒ từ chối, không rơi về tổ chức nhà");
  assert.equal(metadataAdminDenial(sessionUser({ role: "VIEWER", permissions: ["metadata:manage"] })), null, "vai trò bất kỳ có khoá là được");

  // Tổ chức tắt module của đối tượng ⇒ đối tượng không có trong danh sách chọn, VÀ lõi từ chối nó.
  const noCustomers = sessionUser({ modules: MODULE_KEYS.filter((k) => k !== "customers") });
  for (const cap of ["customFields", "forms", "lists"] as const) {
    assert.ok(!adminObjects(noCustomers, cap).some((o) => o.key === "customer"), `${cap}: module Khách hàng tắt ⇒ không có Khách hàng`);
    assert.ok(adminObjects(admin, cap).some((o) => o.key === "customer"), `${cap}: module bật ⇒ có Khách hàng`);
  }
  const off = resolveAdminObject(noCustomers, "customer", "customFields");
  assert.ok(!off.ok && /tắt/.test(off.errors[0].message), "gọi thẳng đối tượng của module tắt ⇒ từ chối, nói rõ vì sao");
  assert.ok(!(await adminCreateField(noCustomers, "customer", { key: "hang", label: "Hạng", type: "text" })).ok);
  const noOrders = sessionUser({ modules: MODULE_KEYS.filter((k) => k !== "orders") });
  assert.deepEqual(adminObjects(noOrders, "statuses"), [], "tắt Đơn hàng ⇒ màn hình Trạng thái không còn đối tượng nào");

  // Chỉ đối tượng customizable + có năng lực; khoá lạ bị từ chối.
  assert.ok(!adminObjects(admin, "customFields").some((o) => o.key === "order_item"), "dòng đơn không tuỳ biến được");
  assert.deepEqual(adminObjects(admin, "forms").map((o) => o.key), ["customer"]);
  assert.deepEqual(adminObjects(admin, "statuses").map((o) => o.key), ["order"]);
  assert.ok(!resolveAdminObject(admin, "order_item", "customFields").ok);
  assert.ok(!resolveAdminObject(admin, "khong-co", "customFields").ok);
  assert.ok(!resolveAdminObject(admin, "order", "forms").ok, "đơn hàng không có form ghi (luật ORDER_OUTCOME)");
  assert.ok(!(await loadFormEditor(admin, "customer", "khong-co")).ok, "khoá form lạ ⇒ từ chối");
  assert.ok(!(await loadStatusEditor(admin, "order", "total")).ok, "chỉ field khai trong statusFields mới đổi nhãn được");

  // Trạng thái hệ thống: bảng dựng từ giá trị GỐC của sổ, không thêm không bớt.
  const stage = await loadStatusEditor(admin, "order", "stage");
  assert.ok(stage.ok);
  assert.deepEqual(
    stage.value.rows.map((r) => r.value),
    (objectDef("order")?.fields.find((f) => f.key === "stage")?.options ?? []).map((o) => o.value),
  );
}

const ORG = "ma-meta";

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

/**
 * Vòng đời THẬT qua lõi action trên CSDL của một tổ chức riêng (`ma-meta`, tự cấp và tự dọn): tạo field →
 * lưu nháp form → CHƯA xuất bản thì người dùng vẫn thấy bản cũ → xuất bản ⇒ đổi. Cộng danh sách, nhãn trạng
 * thái, đổi vị trí, lưu trữ — và lỗi của dịch vụ về tới màn hình NGUYÊN VĂN, đúng khoá ô.
 */
async function testLifecycleDb() {
  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: ORG, name: "Tổ chức thử quản trị metadata", modules: ["customers", "products", "orders"], admin: { email: `admin@${ORG}.local`, name: "QT MA", password: "Meta@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const row = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(row, "quản trị đầu tiên nằm trong CSDL tổ chức");
      const modules = [...(await getEnabledModules(ORG))];
      const admin = sessionUser({ id: row.id, email: row.email, organization: { code: ORG, name: "MA", isHome: false }, modules });
      const viewer = sessionUser({ ...admin, role: "VIEWER", permissions: ["customers:view"] });

      // ── Field: tạo qua lõi, lỗi dịch vụ về NGUYÊN VĂN theo khoá ô ──
      const tier = normalizeFieldInput({
        ...blankFieldInput(),
        key: "hang_the",
        label: "Hạng thẻ",
        type: "select",
        filterable: true,
        options: [
          { value: "vip", label: "VIP", active: true, position: 0, color: "amber" },
          { value: "thuong", label: "Thường", active: true, position: 1 },
        ],
      });
      assert.deepEqual(await adminCreateField(admin, "customer", tier), { ok: true });
      const again = await adminCreateField(admin, "customer", tier);
      assert.ok(!again.ok && again.errors.some((e) => e.field === "key" && /đã có/.test(e.message)), "trùng khoá ⇒ lỗi của DỊCH VỤ, gắn ô «key»");
      const badPattern = await adminCreateField(admin, "customer", normalizeFieldInput({ ...blankFieldInput(), key: "ma_so", label: "Mã số", validation: { pattern: "(a+)+$" } }));
      assert.ok(!badPattern.ok && badPattern.errors.some((e) => e.field === "validation.pattern"), "mẫu kiểm nguy hiểm ⇒ lỗi gắn ô «validation.pattern»");
      const unknownKey = await adminCreateField(admin, "customer", { ...tier, key: "khac", laMa: 1 });
      assert.ok(!unknownKey.ok && unknownKey.errors.length > 0, "thuộc tính lạ ⇒ dịch vụ từ chối (lược đồ strict)");
      assert.equal(FIELD_INPUT_MATCHES_SERVICE, true);
      const denied = await adminCreateField(viewer, "customer", { ...tier, key: "lot_qua" });
      assert.ok(!denied.ok && /quyền/.test(denied.errors[0].message), "thiếu metadata:manage ⇒ lõi chặn trước dịch vụ");

      assert.deepEqual(await adminCreateField(admin, "customer", normalizeFieldInput({ ...blankFieldInput(), key: "ghi_chu_rieng", label: "Ghi chú riêng", type: "textarea" })), { ok: true });
      let model = await loadDataModel(admin, "customer");
      assert.ok(model.ok);
      assert.deepEqual(model.value.custom.map((f) => f.key), ["hang_the", "ghi_chu_rieng"]);
      assert.equal(model.value.custom[0].options[0].color, "amber", "màu tuỳ chọn đi tới CSDL");

      // Lên / xuống: đánh lại vị trí theo thứ tự mới.
      assert.deepEqual(await adminMoveField(admin, "customer", "ghi_chu_rieng", -1), { ok: true });
      model = await loadDataModel(admin, "customer");
      assert.ok(model.ok);
      assert.deepEqual(model.value.custom.map((f) => f.key), ["ghi_chu_rieng", "hang_the"], "nút lên đổi chỗ với láng giềng");
      assert.ok(!(await adminMoveField(admin, "customer", "ghi_chu_rieng", 5)).ok, "bước khác ±1 ⇒ từ chối");

      // Sửa: xoá một tuỳ chọn đã lưu bị DỊCH VỤ chặn (chỉ được tắt).
      const removed = await adminUpdateField(admin, "customer", "hang_the", { options: [{ value: "vip", label: "VIP", active: true, position: 0 }] });
      assert.ok(!removed.ok && removed.errors.some((e) => e.field === "options" && /tắt/.test(e.message)));
      assert.deepEqual(
        await adminUpdateField(admin, "customer", "hang_the", {
          label: "Hạng khách",
          options: [
            { value: "vip", label: "VIP", active: true, position: 0 },
            { value: "thuong", label: "Thường", active: false, position: 1 },
          ],
        }),
        { ok: true },
      );

      // ── Form: lưu nháp KHÔNG đổi bản người dùng thấy; xuất bản mới đổi ──
      const before = await getPublishedForm("customer", "profile");
      assert.equal(before.isDefault, true, "tổ chức mới: form mặc định");
      const editor = await loadFormEditor(admin, "customer", "profile");
      assert.ok(editor.ok);
      assert.ok(editor.value.catalog.some((c) => c.ref === "custom:hang_the"), "field mới có trong trình soạn");
      assert.equal(editor.value.published.isDefault, true);
      const draft: FormSchema = { version: 1, sections: [...editor.value.draft.sections, { key: "the_thanh_vien", label: "Thẻ thành viên", fields: [] }] };
      // Chuyển «Hạng khách» sang nhóm mới, bật bắt buộc, đặt mặc định.
      const from = draft.sections.findIndex((s) => s.fields.some((f) => f.ref === "custom:hang_the"));
      assert.ok(from >= 0);
      draft.sections[from] = { ...draft.sections[from], fields: draft.sections[from].fields.filter((f) => f.ref !== "custom:hang_the") };
      draft.sections[draft.sections.length - 1].fields.push({ ref: "custom:hang_the", visible: true, readOnly: false, required: true, defaultValue: "vip" });
      assert.deepEqual(await adminSaveFormDraft(admin, "customer", "profile", draft), { ok: true });

      const stillOld = await getPublishedForm("customer", "profile");
      assert.ok(sameConfig(stillOld.schema, before.schema) && stillOld.version === 0 && stillOld.isDefault, "lưu nháp ⇒ getPublishedForm KHÔNG đổi");
      const afterSave = await loadFormEditor(admin, "customer", "profile");
      assert.ok(afterSave.ok);
      assert.ok(afterSave.value.draft.sections.some((s) => s.key === "the_thanh_vien"), "trình soạn đọc lại đúng nháp đã lưu");
      assert.equal(sameFormLayout(afterSave.value.draft, afterSave.value.published.schema), false, "màn hình báo «Nháp khác bản đã xuất bản»");

      const badDraft = await adminSaveFormDraft(admin, "customer", "profile", { version: 1, sections: [{ key: "x", label: "", fields: [] }] });
      assert.ok(!badDraft.ok && badDraft.errors.some((e) => e.field.startsWith("sections.0")), "nhóm không tên ⇒ lỗi gắn đúng nhóm");
      assert.ok(!(await adminPublishForm(viewer, "customer", "profile")).ok, "người thiếu quyền không xuất bản được");
      assert.equal((await getPublishedForm("customer", "profile")).version, 0);

      assert.deepEqual(await adminPublishForm(admin, "customer", "profile"), { ok: true });
      const published = await getPublishedForm("customer", "profile");
      assert.equal(published.version, 1);
      assert.equal(published.isDefault, false);
      assert.ok(!sameConfig(published.schema, before.schema), "xuất bản ⇒ getPublishedForm ĐỔI");
      const placed = published.schema.sections.find((s) => s.key === "the_thanh_vien")?.fields.find((f) => f.ref === "custom:hang_the");
      assert.deepEqual([placed?.required, placed?.defaultValue], [true, "vip"]);
      const afterPublish = await loadFormEditor(admin, "customer", "profile");
      assert.ok(afterPublish.ok);
      assert.equal(afterPublish.value.published.publishedBy, `admin@${ORG}.local`, "dòng «bởi ai» là người bấm xuất bản");
      assert.ok(afterPublish.value.published.publishedAt, "dòng «lúc» có mốc");
      assert.equal(sameFormLayout(afterPublish.value.draft, afterPublish.value.published.schema), true, "xuất bản xong ⇒ hết cờ nháp lệch");
      // Field mới SAU khi xuất bản: trình soạn nối nó vào cuối ở trạng thái ẨN, bản đã xuất bản thì không có —
      // khác về dữ liệu nhưng người dùng không thấy gì khác, nên KHÔNG được báo «nháp lệch».
      assert.deepEqual(await adminCreateField(admin, "customer", normalizeFieldInput({ ...blankFieldInput(), key: "so_the", label: "Số thẻ" })), { ok: true });
      const withNew = await loadFormEditor(admin, "customer", "profile");
      assert.ok(withNew.ok);
      assert.ok(!sameConfig(withNew.value.draft, withNew.value.published.schema), "tiền đề: nháp có thêm ô ẩn của field mới");
      assert.equal(sameFormLayout(withNew.value.draft, withNew.value.published.schema), true, "ô ẩn chỉ có ở nháp không làm hai bản «khác»");

      // ── Danh sách ──
      const listEditor = await loadListEditor(admin, "customer", "default");
      assert.ok(listEditor.ok);
      const listDraft = {
        ...listEditor.value.draft,
        columns: listEditor.value.draft.columns.map((c) => (c.ref === "custom:hang_the" ? { ...c, visible: true } : c)),
        defaultSort: { ref: "system:name" as const, dir: "asc" as const },
        defaultFilters: [{ ref: "custom:hang_the" as const, op: "in" as const, value: ["vip"] }],
      };
      const listBefore = await getPublishedListView("customer", "default");
      const single = await adminSaveListDraft(admin, "customer", "default", { ...listDraft, defaultFilters: [{ ref: "custom:hang_the", op: "in", value: "vip" }] });
      assert.ok(!single.ok, "«thuộc một trong» với chuỗi đơn ⇒ dịch vụ từ chối (giao diện gửi mảng)");
      assert.deepEqual(await adminSaveListDraft(admin, "customer", "default", listDraft), { ok: true });
      assert.ok(sameConfig((await getPublishedListView("customer", "default")).schema, listBefore.schema), "lưu nháp danh sách ⇒ bản chạy thật không đổi");
      assert.deepEqual(await adminPublishList(admin, "customer", "default"), { ok: true });
      const listAfter = await getPublishedListView("customer", "default");
      assert.equal(listAfter.version, 1);
      assert.deepEqual(listAfter.schema.defaultFilters, listDraft.defaultFilters);
      assert.ok(listAfter.schema.columns.some((c) => c.ref === "custom:hang_the" && c.visible));
      const listReload = await loadListEditor(admin, "customer", "default");
      assert.ok(listReload.ok && sameListLayout(listReload.value.draft, listReload.value.published.schema));
      assert.deepEqual(await adminCreateField(admin, "customer", normalizeFieldInput({ ...blankFieldInput(), key: "ma_gioi_thieu", label: "Mã giới thiệu" })), { ok: true });
      const listWithNew = await loadListEditor(admin, "customer", "default");
      assert.ok(listWithNew.ok);
      assert.ok(!sameConfig(listWithNew.value.draft, listWithNew.value.published.schema), "tiền đề: nháp danh sách có thêm cột ẩn của field mới");
      assert.equal(sameListLayout(listWithNew.value.draft, listWithNew.value.published.schema), true, "cột ẩn chỉ có ở nháp không làm hai bản «khác»");

      // ── Trạng thái hệ thống: chỉ nhãn / thứ tự / bộ lọc ──
      const stage = await loadStatusEditor(admin, "order", "stage");
      assert.ok(stage.ok);
      const rows = stage.value.rows.map((r, i) => ({ value: r.value, label: r.value === "NEW" ? "Đơn mới vào" : null, position: r.value === "NEW" ? stage.value.rows.length : i, active: r.value !== "DELETED" }));
      assert.deepEqual(await adminSaveStatusOverrides(admin, "order", "stage", rows), { ok: true });
      const stage2 = await loadStatusEditor(admin, "order", "stage");
      assert.ok(stage2.ok);
      assert.equal(stage2.value.rows.at(-1)?.value, "NEW", "thứ tự mới được giữ");
      assert.equal(stage2.value.rows.at(-1)?.label, "Đơn mới vào");
      assert.equal(stage2.value.rows.find((r) => r.value === "DELETED")?.active, false);
      assert.equal(stage2.value.rows.length, stage.value.rows.length, "không thêm, không bớt giá trị");
      assert.equal(await resolveStatusLabel("order", "stage", "NEW"), "Đơn mới vào", "nhãn tới được nơi hiển thị");
      const extra = await adminSaveStatusOverrides(admin, "order", "stage", [...rows, { value: "BIA_RA", label: "x", position: 0, active: true }]);
      assert.ok(!extra.ok && extra.errors.some((e) => e.field === "BIA_RA"), "giá trị lạ ⇒ lỗi gắn đúng dòng, không thêm trạng thái");

      // ── Lưu trữ: giữ dòng, thôi sửa được ──
      assert.deepEqual(await adminArchiveField(admin, "customer", "ghi_chu_rieng"), { ok: true });
      model = await loadDataModel(admin, "customer");
      assert.ok(model.ok);
      assert.equal(model.value.custom.find((f) => f.key === "ghi_chu_rieng")?.status, "ARCHIVED", "lưu trữ ≠ xoá: dòng vẫn còn");
      assert.ok(!(await adminUpdateField(admin, "customer", "ghi_chu_rieng", { label: "x" })).ok, "field đã lưu trữ không sửa được");
      assert.ok(!(await adminMoveField(admin, "customer", "ghi_chu_rieng", 1)).ok, "field đã lưu trữ không đổi vị trí");
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testMetadataAdmin() {
  testMenu();
  testPure();
  await testCoreGates();
  await testLifecycleDb();
  console.log("✓ Nền tảng · quản trị metadata: 4 màn hình gác bằng metadata:manage (menu + lõi), đối tượng của module tắt không chọn được và bị lõi từ chối, gợi ý khoá bỏ dấu luôn hợp lệ, trình soạn khoá luật form; vòng đời thật: tạo field → lưu nháp (bản chạy không đổi) → xuất bản (đổi, ghi người + lúc), danh sách, nhãn trạng thái, lưu trữ");
}
