/**
 * PHASE 2 · FORM RUNTIME + DANH SÁCH THEO METADATA (M8, M9) — phần THUẦN.
 *
 *  · `applyListView`: không schema ⇒ NGUYÊN cột mã nguồn (tổ chức nhà không đổi gì); ẩn / đổi thứ tự;
 *    cột gánh nhiều field; cột không ai nhắc giữ chỗ; cột custom chèn đúng vị trí; field ARCHIVED rơi.
 *  · `buildFormLayout`: ẩn không vẽ, `required` chỉ CHẶT thêm, `editable: false` luôn chỉ đọc, lý do
 *    chỉ đọc của đối tượng đồng bộ, thiếu quyền sửa ⇒ chỉ đọc.
 *  · Bảng field hệ thống ⇒ cột mã nguồn khớp với `columns.tsx` thật (quét mã nguồn).
 *  · Nhãn trạng thái HỆ THỐNG: chỉ giá trị đã khai override; bộ lọc ẩn giá trị tắt trừ khi đang chọn.
 *  · Hàng rào tạo khách (CSDL thật): nhà bật `connector_pancake` ⇒ từ chối; tổ chức `mr-create` (không
 *    Pancake) ⇒ thiếu `customers:write` từ chối, ô ẩn/chỉ đọc không nhận ghi, lượt ghi custom hỏng gỡ
 *    dòng khách vừa chèn. Tự dọn tổ chức `mr-create`.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { createCustomField, updateCustomField } from "@/lib/metadata/fields";
import { publishListView, saveListViewDraft } from "@/lib/metadata/lists";
import { getListMetadata, listCustomValuesFor } from "@/lib/queries/metadata-lists";
import { getCustomValues, saveCustomValues } from "@/lib/metadata/values";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createCustomerCore, customerCreateGate } from "@/lib/records/customer-create";
import {
  applyListView,
  applyStatusFacet,
  describeListFilter,
  statusLabelOverrides,
  buildFormLayout,
  customDefaultFilters,
  formatCustomValue,
  initialFormValues,
  isoToVnLocalInput,
  parseCurrencyInput,
  listViewDefaultSort,
  statusTargets,
  validateFormClient,
  visibleCustomKeys,
  vnLocalInputToIso,
} from "@/components/metadata/runtime-core";
import { CUSTOMER_LIST_REF_COLUMNS, ORDER_LIST_REF_COLUMNS } from "@/lib/constants/metadata-list-columns";
import { objectDef } from "@/lib/constants/object-registry";
import type { CustomFieldDef, FormSchema, ListViewSchema } from "@/lib/metadata/types";

type Col = { id: string };
const BASE: Col[] = ["name", "address", "orderCount", "success", "purchasedAmount", "lastOrderAt", "source"].map((id) => ({ id }));
const ids = (cols: readonly Col[]) => cols.map((c) => c.id);

function cf(key: string, over: Partial<CustomFieldDef> = {}): CustomFieldDef {
  return {
    id: `id-${key}`,
    objectKey: "customer",
    key,
    label: key.toUpperCase(),
    type: "text",
    required: false,
    defaultValue: null,
    options: [],
    validation: {},
    transitions: {},
    relationObject: null,
    helpText: null,
    viewPermission: null,
    editPermission: null,
    listable: true,
    filterable: false,
    position: 0,
    status: "ACTIVE",
    ...over,
  };
}

function view(columns: ListViewSchema["columns"], extra: Partial<ListViewSchema> = {}): ListViewSchema {
  return { version: 1, columns, defaultSort: null, defaultFilters: [], ...extra };
}

function testListView() {
  const refColumns = CUSTOMER_LIST_REF_COLUMNS;
  // Không schema / schema rỗng ⇒ y nguyên, KHÔNG phải cùng tham chiếu nhưng cùng nội dung và thứ tự.
  assert.deepEqual(ids(applyListView(BASE, null, { refColumns })), ids(BASE), "chưa xuất bản ⇒ cột mã nguồn y như cũ");
  assert.deepEqual(ids(applyListView(BASE, view([]), { refColumns })), ids(BASE), "danh sách không cột nào ⇒ y như cũ");

  // Đổi thứ tự: Đã mua lên đầu, Khách hàng xuống sau; cột không ai nhắc ("success", "source") giữ chỗ sau cột gốc đứng trước nó.
  const reordered = applyListView(
    BASE,
    view([
      { ref: "system:purchased_amount", visible: true },
      { ref: "system:name", visible: true },
      { ref: "system:order_count", visible: true },
      { ref: "system:address", visible: true },
      { ref: "system:last_order_at", visible: true },
    ]),
    { refColumns },
  );
  assert.deepEqual(ids(reordered), ["purchasedAmount", "name", "orderCount", "success", "address", "lastOrderAt", "source"]);

  // Ẩn: cột gánh HAI field chỉ ẩn khi CẢ HAI ẩn.
  const halfHidden = applyListView(BASE, view([{ ref: "system:address", visible: false }, { ref: "system:province", visible: true }]), { refColumns });
  assert.ok(ids(halfHidden).includes("address"), "một trong hai field của cột còn hiện ⇒ cột còn hiện");
  const hidden = applyListView(BASE, view([{ ref: "system:address", visible: false }, { ref: "system:province", visible: false }, { ref: "system:order_count", visible: false }]), { refColumns });
  assert.deepEqual(ids(hidden), ["name", "success", "purchasedAmount", "lastOrderAt", "source"], "ẩn đúng cột; cột 'success' đứng sau cột gốc còn hiện gần nhất");

  // Cột custom: chèn theo thứ tự schema; field không có cột (ARCHIVED / lạ) bị bỏ; ref hỏng bị bỏ.
  const custom = new Map<string, Col>([["vip", { id: "custom:vip" }]]);
  const withCustom = applyListView(
    BASE,
    view([
      { ref: "system:name", visible: true },
      { ref: "custom:vip", visible: true },
      { ref: "custom:archived", visible: true },
      { ref: "system:khong_co", visible: true },
      { ref: "system:" as "system:x", visible: true },
    ]),
    { refColumns, customColumns: custom },
  );
  assert.deepEqual(ids(withCustom).slice(0, 2), ["name", "custom:vip"], "cột custom đứng ngay sau cột schema đặt trước nó");
  assert.ok(!ids(withCustom).includes("custom:archived"));
  assert.equal(ids(withCustom).length, BASE.length + 1, "mọi cột mã nguồn không bị ẩn vẫn còn");
  const customHidden = applyListView(BASE, view([{ ref: "custom:vip", visible: false }]), { refColumns, customColumns: custom });
  assert.ok(!ids(customHidden).includes("custom:vip"), "cột custom ẩn ⇒ không vẽ");

  // Ẩn tất cả cột nhắc tới + không còn gì ⇒ cấu hình hỏng, trả nguyên.
  const onlyOne: Col[] = [{ id: "name" }];
  assert.deepEqual(ids(applyListView(onlyOne, view([{ ref: "system:name", visible: false }, { ref: "system:phone", visible: false }]), { refColumns })), ["name"]);

  // Sắp xếp mặc định: chỉ cột hệ thống mà truy vấn sắp được.
  const sortable = ["orderCount", "purchasedAmount", "lastOrderAt", "name", "insertedAt"];
  assert.deepEqual(listViewDefaultSort(view([], { defaultSort: { ref: "system:order_count", dir: "asc" } }), refColumns, sortable), { sort: "orderCount", dir: "asc" });
  assert.equal(listViewDefaultSort(view([], { defaultSort: { ref: "system:address", dir: "asc" } }), refColumns, sortable), null, "cột không sắp được ⇒ bỏ qua");
  assert.equal(listViewDefaultSort(view([], { defaultSort: { ref: "custom:vip", dir: "asc" } }), refColumns, sortable), null, "cột custom ⇒ truy vấn chưa sắp được");
  assert.equal(listViewDefaultSort(null, refColumns, sortable), null);

  const filters = customDefaultFilters(view([], { defaultFilters: [{ ref: "custom:vip", op: "eq", value: "x" }, { ref: "system:province", op: "eq", value: "HN" }] }));
  assert.deepEqual(filters.map((f) => f.ref), ["custom:vip"], "bộ lọc mặc định: chỉ field custom đi qua `customValuesFilterSql`");
  assert.deepEqual(visibleCustomKeys(view([{ ref: "custom:a", visible: true }, { ref: "custom:b", visible: false }, { ref: "custom:a", visible: true }])), ["a"]);
}

function testRefColumnsMatchSource() {
  const pairs: [string, Readonly<Record<string, readonly string[]>>, string][] = [
    ["customer", CUSTOMER_LIST_REF_COLUMNS, "app/(dashboard)/customers/columns.tsx"],
    ["order", ORDER_LIST_REF_COLUMNS, "app/(dashboard)/orders/columns.tsx"],
  ];
  for (const [objectKey, map, file] of pairs) {
    const src = readFileSync(path.join(process.cwd(), file), "utf8");
    const def = objectDef(objectKey);
    assert.ok(def);
    for (const f of def.fields.filter((x) => x.listable)) {
      const cols = map[f.key];
      assert.ok(cols?.length, `${objectKey}.${f.key} (listable) phải trỏ tới ít nhất một cột`);
      for (const id of cols) assert.ok(src.includes(`id: "${id}"`), `${file} phải có cột id "${id}" cho field ${f.key}`);
    }
    for (const k of Object.keys(map)) assert.ok(def.fields.some((x) => x.key === k), `${objectKey}: khoá "${k}" không có trong sổ đối tượng`);
  }
}

function testFormLayout() {
  const system = objectDef("customer")!.fields;
  const custom = [
    cf("vip", { type: "boolean" }),
    cf("hang", { type: "select", required: true, options: [{ value: "a", label: "A", active: true, position: 1 }, { value: "b", label: "B", active: false, position: 0 }] }),
    cf("ghi_chu", { type: "textarea", status: "ARCHIVED" }),
    cf("luong", { type: "currency", editPermission: "payroll:manage", defaultValue: 100 }),
    cf("ma", { type: "text", defaultValue: "X" }),
    cf("an", { type: "text" }),
  ];
  const schema: FormSchema = {
    version: 1,
    sections: [
      {
        key: "s1",
        label: "Cơ bản",
        fields: [
          { ref: "system:name", visible: true, readOnly: false, required: false },
          { ref: "system:order_count", visible: true, readOnly: false, required: false },
          { ref: "custom:vip", visible: false, readOnly: false, required: true },
          { ref: "custom:an", visible: false, readOnly: false, required: false },
          { ref: "custom:hang", visible: true, readOnly: false, required: false },
          { ref: "custom:hang", visible: true, readOnly: false, required: false },
        ],
      },
      { key: "s2", label: "Trống", fields: [{ ref: "custom:ghi_chu", visible: true, readOnly: false, required: false }, { ref: "custom:khong_co", visible: true, readOnly: false, required: false }] },
      { key: "s3", label: "Khác", fields: [{ ref: "custom:luong", visible: true, readOnly: false, required: false }, { ref: "custom:ma", visible: true, readOnly: true, required: true, defaultValue: "Y" }] },
    ],
  };
  const layout = buildFormLayout(schema, system, custom, { customEditable: ["vip", "hang", "ma", "an"] });
  assert.deepEqual(layout.map((s) => s.key), ["s1", "s3"], "section không còn field hiện nào bị bỏ");
  const all = layout.flatMap((s) => s.fields);
  const by = (ref: string) => all.find((f) => f.ref === ref);
  assert.equal(by("custom:an"), undefined, "field ẩn không vẽ");
  assert.ok(by("custom:vip"), "field BẮT BUỘC sửa được không ẩn được (cùng luật normalizeFormSchema) — ẩn là form không bao giờ lưu nổi");
  assert.equal(all.filter((f) => f.ref === "custom:hang").length, 1, "field nhắc hai lần chỉ vẽ một lần");
  assert.equal(by("custom:ghi_chu"), undefined, "field ARCHIVED không vẽ");
  assert.equal(by("system:name")!.required, true, "field hệ thống bắt buộc: form khai required=false KHÔNG nới được");
  assert.equal(by("custom:hang")!.required, true, "field custom bắt buộc: form không nới được");
  assert.equal(by("custom:ma")!.required, true, "form được làm CHẶT thêm");
  assert.equal(by("system:order_count")!.readOnly, true, "editable:false ⇒ luôn chỉ đọc");
  assert.equal(by("system:name")!.readOnly, false);
  assert.equal(by("custom:luong")!.readOnly, true, "máy chủ nói không sửa được (quyền ghi / editPermission) ⇒ chỉ đọc");
  assert.equal(by("custom:luong")!.readOnlyReason, "Không đủ quyền sửa trường này");
  assert.equal(buildFormLayout(schema, system, custom).flatMap((s) => s.fields).find((f) => f.ref === "custom:luong")!.readOnly, false, "không thu hẹp ⇒ sửa được");
  assert.equal(buildFormLayout(schema, system, custom, { customEditable: [], customLockedReason: { luong: "Tải tệp sau" } }).flatMap((s) => s.fields).find((f) => f.ref === "custom:luong")!.readOnlyReason, "Tải tệp sau");
  assert.deepEqual(by("custom:hang")!.options.map((o) => o.value), ["b", "a"], "tuỳ chọn theo position");

  const synced = buildFormLayout(schema, system, custom, { systemReadOnlyReason: "Đồng bộ từ Pancake" }).flatMap((s) => s.fields);
  assert.equal(synced.find((f) => f.ref === "system:name")!.readOnly, true, "đối tượng đồng bộ ⇒ field hệ thống chỉ đọc");
  assert.equal(synced.find((f) => f.ref === "system:name")!.readOnlyReason, "Đồng bộ từ Pancake");

  // Giá trị ban đầu: mặc định chỉ cho ô SỬA ĐƯỢC và đang trống; ô chỉ đọc không nhận mặc định.
  const init = initialFormValues(layout, { system: { name: "An" }, custom: {} });
  assert.equal(init.system.name, "An");
  assert.equal(init.custom.ma, null, "ô chỉ đọc không nhận mặc định — sẽ trông như đã lưu");
  assert.equal(init.custom.luong, null, "ô chỉ đọc (thiếu quyền) không nhận mặc định");
  const initAdmin = initialFormValues(buildFormLayout(schema, system, custom), { system: {}, custom: { luong: 5 } });
  assert.equal(initAdmin.custom.luong, 5, "đã có giá trị ⇒ không đè bằng mặc định");

  // Kiểm phía trình duyệt: bắt buộc trống ⇒ lỗi theo khoá hợp đồng; ô chỉ đọc không kiểm.
  // Field custom đi qua `validateCustomValues` của dịch vụ; `required` của FORM cũng áp (vip bắt buộc theo form).
  const errs = validateFormClient(layout, { system: { name: " " }, custom: { hang: "zz" } }, custom, null);
  assert.deepEqual(errs.map((e) => e.field).sort(), ["hang", "system:name", "vip"]);
  assert.ok(!errs.some((e) => e.field === "ma" || e.field === "luong"), "ô chỉ đọc không kiểm");
  const currencyLayout = buildFormLayout({ version: 1, sections: [{ key: "x", label: "", fields: [{ ref: "custom:luong", visible: true, readOnly: false, required: false }] }] }, system, custom);
  assert.equal(validateFormClient(currencyLayout, { system: {}, custom: { luong: 10.5 } }, custom, null).length, 1, "tiền VND phải nguyên");
  assert.equal(validateFormClient(currencyLayout, { system: {}, custom: { luong: null } }, custom, null).length, 0, "trống + không bắt buộc ⇒ hợp lệ");
}

function testStatusAndFormat() {
  const options = [
    { value: "moi", label: "Mới", active: true, position: 0 },
    { value: "dang", label: "Đang làm", active: true, position: 1 },
    { value: "xong", label: "Xong", active: true, position: 2 },
    { value: "cu", label: "Cũ", active: false, position: 3 },
  ];
  const transitions = { moi: ["dang"], dang: ["xong", "cu"] };
  assert.deepEqual(statusTargets(options, transitions, null).map((o) => o.value), ["moi", "dang", "xong"], "chưa có giá trị ⇒ mọi giá trị đang bật");
  assert.deepEqual(statusTargets(options, transitions, "moi").map((o) => o.value), ["moi", "dang"], "chỉ đích hợp lệ + chính nó");
  assert.deepEqual(statusTargets(options, transitions, "dang").map((o) => o.value), ["dang", "xong"], "giá trị đã tắt không là đích");
  assert.deepEqual(statusTargets(options, transitions, "xong").map((o) => o.value), ["xong"], "không có chuyển ⇒ đứng yên");
  assert.deepEqual(statusTargets(options, transitions, "cu").map((o) => o.value), ["cu"], "giá trị hiện tại đã tắt vẫn hiện");
  assert.deepEqual(statusTargets(options, {}, "moi").map((o) => o.value), ["moi", "dang", "xong"], "bảng chuyển rỗng ⇒ mọi chuyển đều được");

  assert.equal(formatCustomValue({ type: "currency", options: [] }, null), "—", "chưa có giá trị ⇒ —, không phải 0 ₫");
  assert.equal(formatCustomValue({ type: "currency", options: [] }, 0), "0 ₫", "0 thật in là 0 ₫");
  assert.equal(formatCustomValue({ type: "number", options: [] }, ""), "—");
  assert.equal(formatCustomValue({ type: "boolean", options: [] }, false), "Không");
  assert.equal(formatCustomValue({ type: "select", options }, "dang"), "Đang làm");
  assert.equal(formatCustomValue({ type: "multi_select", options }, ["moi", "zz"]), "Mới, zz");
  assert.equal(formatCustomValue({ type: "user", options: [] }, "u1", { userNames: { u1: "Lan" } }), "Lan");

  assert.equal(parseCurrencyInput("1.250.000"), 1_250_000);
  assert.equal(parseCurrencyInput(""), null, "ô tiền trống ⇒ null, không phải 0");
  assert.equal(parseCurrencyInput("-5.000"), -5000);

  // Ngày giờ: ô nhập hiểu là GIỜ VIỆT NAM, đi vòng không lệch.
  assert.equal(vnLocalInputToIso("2026-09-27T08:30"), "2026-09-27T01:30:00.000Z");
  assert.equal(isoToVnLocalInput("2026-09-27T01:30:00.000Z"), "2026-09-27T08:30");
  assert.equal(vnLocalInputToIso(""), null);
}

function testSystemStatus() {
  const defaults = objectDef("order")!.fields.find((f) => f.key === "stage")!.options!;
  assert.deepEqual(statusLabelOverrides(defaults, null), {}, "đọc cấu hình lỗi ⇒ không đổi gì");
  assert.deepEqual(statusLabelOverrides(defaults, defaults), {}, "chưa khai override ⇒ map rỗng ⇒ hiển thị như cũ (nhãn Pancake)");
  const resolved = defaults.map((o) => (o.value === "NEW" ? { ...o, label: "Đơn mới về", position: 99 } : o.value === "DELETED" ? { ...o, active: false } : o));
  assert.deepEqual(statusLabelOverrides(defaults, resolved), { NEW: "Đơn mới về" }, "chỉ giá trị ĐÃ khai nhãn khác");
  assert.equal(statusLabelOverrides(defaults, [...resolved, { value: "BIA", label: "Bịa", active: true, position: 0 }]).BIA, undefined, "giá trị lạ không bao giờ sinh ra");

  const sorted = [...resolved].sort((a, b) => a.position - b.position);
  const facet = [
    { value: "NEW", label: "Mới", count: 3 },
    { value: "DELETED", label: "Đã xóa", count: 1 },
    { value: "CANCELLED", label: "Đã hủy", count: 2 },
  ];
  assert.deepEqual(applyStatusFacet(facet, sorted).map((o) => `${o.value}:${o.label}`), ["CANCELLED:Đã hủy", "NEW:Đơn mới về"], "đổi nhãn + thứ tự; giá trị đã tắt ẩn khỏi bộ lọc");
  assert.ok(applyStatusFacet(facet, sorted, ["DELETED"]).some((o) => o.value === "DELETED"), "giá trị đang chọn trên URL KHÔNG bị ẩn");
  assert.equal(applyStatusFacet(facet, sorted)[1].count, 3, "số đếm giữ nguyên — chỉ đổi chữ");
  assert.deepEqual(applyStatusFacet(facet, null), facet, "không cấu hình ⇒ y nguyên");

  const vip = cf("vip", { type: "boolean" });
  assert.equal(describeListFilter({ ref: "custom:vip", op: "eq", value: true }, vip), "VIP = Có");
  assert.equal(describeListFilter({ ref: "custom:vip", op: "empty" }, vip), "VIP trống");
}

// ─────────────────────────── Hàng rào tạo khách (CSDL thật) ───────────────────────────

const ORG = "mr-create";

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

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function customerCount(): Promise<number> {
  const db = await getDb();
  const [r] = await db.select({ n: sql<number>`count(*)` }).from(schema.customers);
  return Number(r.n);
}

async function testCustomerCreateGuards() {
  // Tổ chức NHÀ bật `connector_pancake` ⇒ khách do đồng bộ tạo: cổng từ chối, 0 dòng mới.
  const homeAdmin = sessionOf({ id: "mr-home", email: "mr@home.local" });
  const gate = await customerCreateGate(homeAdmin);
  assert.equal(gate.allowed ? "ALLOWED" : gate.code, "NOT_SUPPORTED", "connector_pancake bật ⇒ không tạo tay, KỂ CẢ Quản trị");
  const before = await customerCount();
  const denied = await createCustomerCore(homeAdmin, { system: { name: "Khách tạo tay ở nhà" }, custom: {} });
  assert.equal(denied.ok ? "OK" : denied.code, "NOT_SUPPORTED");
  assert.equal(await customerCount(), before, "bị từ chối ⇒ không chèn dòng nào");

  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: ORG, name: "Tổ chức không dùng Pancake", modules: ["customers"], admin: { email: `admin@${ORG}.local`, name: "QT", password: "Meta@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(ORG, async () => {
      const db = await getDb();
      const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(u);
      const admin = sessionOf(u);
      const actor = { id: u.id, email: u.email };
      assert.equal((await customerCreateGate(admin)).allowed, true, "không bật Pancake + Quản trị ⇒ được tạo");

      const viewer = sessionOf(u, { role: "VIEWER", permissions: ["customers:view"] });
      const forbidden = await createCustomerCore(viewer, { system: { name: "A" }, custom: {} });
      assert.equal(forbidden.ok ? "OK" : forbidden.code, "FORBIDDEN", "thiếu customers:write ⇒ từ chối");

      const hang = await createCustomField("customer", { key: "hang", label: "Hạng", type: "select", required: true, options: [{ value: "vip", label: "VIP" }, { value: "thuong", label: "Thường" }] }, actor);
      assert.ok(hang.ok);
      const owner = await createCustomField("customer", { key: "phu_trach", label: "Phụ trách", type: "user" }, actor);
      assert.ok(owner.ok);
      const n0 = await customerCount();

      const fieldsOf = (r: Awaited<ReturnType<typeof createCustomerCore>>) => (r.ok ? [] : r.errors.map((e) => e.field));
      const missing = await createCustomerCore(admin, { system: { name: "Lan" }, custom: {} });
      assert.ok(fieldsOf(missing).includes("hang"), "field custom bắt buộc thiếu ⇒ lỗi đúng ô");
      const hidden = await createCustomerCore(admin, { system: { name: "Lan", order_count: 5 }, custom: { hang: "vip" } });
      assert.ok(fieldsOf(hidden).includes("system:order_count"), "field hệ thống không sửa được ⇒ không nhận ghi");
      const badPhone = await createCustomerCore(admin, { system: { name: "Lan", phone: "abc" }, custom: { hang: "vip" } });
      assert.ok(fieldsOf(badPhone).includes("system:phone"));
      const noName = await createCustomerCore(admin, { system: { name: "   " }, custom: { hang: "vip" } });
      assert.ok(fieldsOf(noName).includes("system:name"), "tên bắt buộc — khoảng trắng không phải tên");
      // Lượt ghi custom bị dịch vụ từ chối SAU khi chèn khách (tài khoản không tồn tại) ⇒ gỡ dòng vừa chèn.
      const ghost = await createCustomerCore(admin, { system: { name: "Ma" }, custom: { hang: "vip", phu_trach: "khong-ton-tai" } });
      assert.ok(fieldsOf(ghost).includes("phu_trach"));
      assert.equal(await customerCount(), n0, "mọi lượt bị từ chối ⇒ 0 dòng khách mới");

      const created = await createCustomerCore(admin, { system: { name: "  Lan  ", phone: "0901 234.567", province: "Hà Nội" }, custom: { hang: "vip", phu_trach: u.id } });
      assert.ok(created.ok, JSON.stringify(created));
      const row = await db.query.customers.findFirst({ where: eq(schema.customers.id, created.id) });
      assert.equal(row?.name, "Lan");
      assert.equal(row?.phone, "0901234567", "SĐT chuẩn hoá bỏ dấu cách / chấm");
      assert.equal(row?.pancakeId, null, "khách tạo tay không mang mã Pancake");
      assert.deepEqual((await getCustomValues("customer", [created.id], admin)).get(created.id), { hang: "vip", phu_trach: u.id });
      const logs = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "CUSTOMER_CREATE"), eq(schema.auditLogs.entityId, created.id)));
      assert.equal(logs.length, 1, "tạo khách để lại một dòng nhật ký");

      // Danh sách: chưa xuất bản ⇒ null (trang y như cũ). Bộ lọc mặc định trên field người xem KHÔNG được
      // xem thì không áp — `customValuesFilterSql` không nhận người xem, lọc theo nó là lộ giá trị.
      assert.equal(await getListMetadata("customer", "default", admin), null, "chưa xuất bản ⇒ không áp gì");
      const secret = await createCustomField("customer", { key: "bi_mat", label: "Bí mật", type: "text", filterable: true, viewPermission: "metadata:manage" }, actor);
      assert.ok(secret.ok);
      const hangFilterable = await updateCustomField("customer", "hang", { filterable: true }, actor);
      assert.ok(hangFilterable.ok);
      const draft = await saveListViewDraft(
        "customer",
        "default",
        {
          version: 1,
          columns: [{ ref: "system:name", visible: true }, { ref: "custom:hang", visible: true }, { ref: "custom:bi_mat", visible: true }, { ref: "custom:phu_trach", visible: true }],
          defaultSort: null,
          defaultFilters: [{ ref: "custom:hang", op: "eq", value: "vip" }, { ref: "custom:bi_mat", op: "not_empty" }],
        },
        actor,
      );
      assert.ok(draft.ok, JSON.stringify(draft));
      assert.ok((await publishListView("customer", "default", actor)).ok);
      const asAdmin = await getListMetadata("customer", "default", admin);
      assert.equal(asAdmin?.filters.length, 2);
      assert.equal(asAdmin?.filtersSkipped, 0);
      const asViewer = await getListMetadata("customer", "default", viewer);
      assert.deepEqual(asViewer?.filters.map((f) => f.ref), ["custom:hang"], "bộ lọc trên field không được xem bị bỏ");
      assert.equal(asViewer?.filtersSkipped, 1, "và được ĐẾM để màn hình nói ra");
      assert.ok(!asViewer?.customFields.some((f) => f.key === "bi_mat"), "không có cột cho field không được xem");
      assert.ok((await saveCustomValues("customer", created.id, { bi_mat: "x" }, admin)).ok);
      const vals = await listCustomValuesFor("customer", asViewer, [created.id], viewer);
      assert.deepEqual(vals.customValues[created.id], { hang: "vip", phu_trach: u.id }, "một lượt getCustomValues, KHÔNG có field không được xem");
      assert.equal(vals.userNames[u.id], "QT", "tên người cho field kiểu user");
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

export async function testMetadataRuntime() {
  testListView();
  testRefColumnsMatchSource();
  testFormLayout();
  testStatusAndFormat();
  testSystemStatus();
  await testCustomerCreateGuards();
  console.log("  ✓ metadata runtime: danh sách theo cấu hình, form section/field, nhãn trạng thái hệ thống, tạo khách chỉ khi không bật Pancake + có customers:write");
}
