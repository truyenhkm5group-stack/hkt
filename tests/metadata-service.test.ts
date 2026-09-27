/**
 * PHASE 2 · TẦNG DỊCH VỤ METADATA (docs/platform/phase-2-contracts.md mục 4) — field custom, giá trị, form,
 * danh sách, trạng thái hệ thống, tệp, xuất CSV, lọc SQL.
 *
 * Hai phần:
 *  · THUẦN: `validateCustomValues` (mọi kiểu, bắt buộc, giới hạn, mẫu kiểm chống ReDoS, chuyển trạng thái, khoá
 *    lạ), chuẩn hoá form / danh sách.
 *  · HAI TỔ CHỨC THẬT (`pm-a`, `pm-b` — hai CSDL PGlite riêng, `provisionOrganization`): định nghĩa field và giá
 *    trị của A không lộ sang B và ngược lại; phiên B ghi theo id khách của A ⇒ "bản ghi không tồn tại", 0 dòng.
 *
 * Tự dọn: thư mục CSDL của `pm-*` xoá TRƯỚC khi cấp; dòng mặt phẳng điều khiển xoá khi xong (nhật ký nền tảng
 * giữ lại — chỉ thêm, đúng như production).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import type { SessionUser } from "@/lib/auth/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { MetadataError } from "@/lib/metadata/errors";
import { archiveCustomField, createCustomField, listFields, updateCustomField } from "@/lib/metadata/fields";
import { defaultFormSchema, normalizeFormSchema } from "@/lib/metadata/form-schema";
import { getFormDraft, getPublishedForm, publishForm, saveFormDraft } from "@/lib/metadata/forms";
import { defaultListView, normalizeListView } from "@/lib/metadata/list-schema";
import { getListViewDraft, getPublishedListView, publishListView, saveListViewDraft } from "@/lib/metadata/lists";
import { getStatusOverrides, resolveStatusLabel, resolveStatusOptions, saveStatusOverrides } from "@/lib/metadata/statuses";
import type { CustomFieldDef, FormSchema, MetadataActor } from "@/lib/metadata/types";
import { compilePattern, unsafePatternReason, validateCustomValues } from "@/lib/metadata/validate";
import { customValuesFilterSql, exportCustomValues, getCustomValues, readCustomFile, saveCustomFile, saveCustomValues } from "@/lib/metadata/values";
import { objectDef } from "@/lib/constants/object-registry";

const A = "pm-a";
const B = "pm-b";

// ─────────────────────────── Phần thuần ───────────────────────────

function fd(key: string, type: CustomFieldDef["type"], extra: Partial<CustomFieldDef> = {}): CustomFieldDef {
  return {
    id: `id-${key}`,
    objectKey: "customer",
    key,
    label: key,
    type,
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
    filterable: true,
    position: 0,
    status: "ACTIVE",
    ...extra,
  };
}

const opts = (...vals: [string, boolean?][]) => vals.map(([value, active], i) => ({ value, label: value.toUpperCase(), active: active !== false, position: i }));

function ok(defs: CustomFieldDef[], input: Record<string, unknown>, previous: Record<string, unknown> | null = null) {
  const r = validateCustomValues(defs, input, previous);
  assert.deepEqual(r.errors, [], `không mong lỗi: ${JSON.stringify(r.errors)}`);
  return r.values;
}

function bad(defs: CustomFieldDef[], input: Record<string, unknown>, field: string, re: RegExp, previous: Record<string, unknown> | null = null) {
  const r = validateCustomValues(defs, input, previous);
  const e = r.errors.find((x) => x.field === field);
  assert.ok(e, `mong lỗi ở "${field}", nhận ${JSON.stringify(r.errors)}`);
  assert.match(e.message, re);
}

function testValidatePure() {
  const text = fd("note", "text", { validation: { minLength: 2, maxLength: 5 } });
  assert.deepEqual(ok([text], { note: "  abc  " }), { note: "abc" }, "chữ được cắt khoảng trắng");
  assert.deepEqual(ok([text], { note: "   " }, { note: "cu" }), {}, "rỗng ⇒ XOÁ khoá, không lưu chuỗi rỗng");
  bad([text], { note: "a" }, "note", /ít nhất 2/);
  bad([text], { note: "abcdef" }, "note", /tối đa 5/);
  bad([text], { note: { x: 1 } }, "note", /phải là chữ/);

  const num = fd("qty", "number", { validation: { min: 0, max: 10 } });
  assert.deepEqual(ok([num], { qty: "2.5" }), { qty: 2.5 });
  bad([num], { qty: "abc" }, "qty", /phải là số/);
  bad([num], { qty: 11 }, "qty", /≤ 10/);
  bad([num], { qty: -1 }, "qty", /≥ 0/);
  bad([num], { qty: Number.POSITIVE_INFINITY }, "qty", /hữu hạn/);

  const money = fd("amount", "currency");
  assert.deepEqual(ok([money], { amount: "150.000" }), { amount: 150000 }, "VND có dấu phân cách nghìn");
  assert.deepEqual(ok([money], { amount: "1,000,000" }), { amount: 1000000 });
  assert.deepEqual(ok([money], { amount: 0 }), { amount: 0 }, "0 THẬT được lưu là 0");
  bad([money], { amount: 1000.5 }, "amount", /nguyên VND/);
  bad([money], { amount: "12,5" }, "amount", /nguyên VND/);
  const none = ok([money], { amount: null }, null);
  assert.equal("amount" in none, false, "null ⇒ vắng mặt (CHƯA BIẾT), KHÔNG BAO GIỜ thành 0");

  const flag = fd("vip", "boolean");
  assert.deepEqual(ok([flag], { vip: "true" }), { vip: true });
  assert.deepEqual(ok([flag], { vip: false }), { vip: false }, "false là một giá trị, không phải rỗng");
  bad([flag], { vip: "có lẽ" }, "vip", /có \/ không/);

  const day = fd("birthday", "date");
  assert.deepEqual(ok([day], { birthday: "2026-02-28" }), { birthday: "2026-02-28" });
  bad([day], { birthday: "2026-02-30" }, "birthday", /YYYY-MM-DD/);
  bad([day], { birthday: "28/02/2026" }, "birthday", /YYYY-MM-DD/);

  const at = fd("met_at", "datetime");
  assert.deepEqual(ok([at], { met_at: "2026-09-27T14:30" }), { met_at: "2026-09-27T07:30:00.000Z" }, "không múi giờ ⇒ giờ Việt Nam");
  assert.deepEqual(ok([at], { met_at: "2026-09-27T14:30:05Z" }), { met_at: "2026-09-27T14:30:05.000Z" });
  assert.deepEqual(ok([at], { met_at: "2026-09-27T14:30+0700" }), { met_at: "2026-09-27T07:30:00.000Z" });
  bad([at], { met_at: "2026-09-27T25:00" }, "met_at", /ISO/);
  bad([at], { met_at: "2026-09-27T14:30:4599" }, "met_at", /ISO/);

  const tier = fd("tier", "select", { options: opts(["vip"], ["normal"], ["old", false]) });
  assert.deepEqual(ok([tier], { tier: "vip" }), { tier: "vip" });
  bad([tier], { tier: "gold" }, "tier", /không nằm trong/);
  bad([tier], { tier: "old" }, "tier", /ngừng dùng/);
  assert.deepEqual(ok([tier], { tier: "old" }, { tier: "old" }), { tier: "old" }, "giá trị ĐÃ LƯU của tuỳ chọn đã tắt vẫn gửi lại được");

  const tags = fd("tags", "multi_select", { options: opts(["a"], ["b"], ["c", false]) });
  assert.deepEqual(ok([tags], { tags: ["b", "a", "b"] }), { tags: ["a", "b"] }, "bỏ trùng, xếp theo thứ tự tuỳ chọn");
  assert.deepEqual(ok([tags], { tags: [] }, { tags: ["a"] }), {}, "mảng rỗng ⇒ xoá khoá");
  bad([tags], { tags: ["c"] }, "tags", /ngừng dùng/);
  bad([tags], { tags: [1] }, "tags", /danh sách/);

  const st = fd("stage", "status", { options: opts(["new"], ["doing"], ["done"]), transitions: { new: ["doing"], doing: ["done"] } });
  assert.deepEqual(ok([st], { stage: "done" }), { stage: "done" }, "chưa có giá trị trước ⇒ đặt được bất kỳ tuỳ chọn nào");
  assert.deepEqual(ok([st], { stage: "doing" }, { stage: "new" }), { stage: "doing" });
  bad([st], { stage: "done" }, "stage", /không được chuyển từ "NEW" sang "DONE"/, { stage: "new" });
  bad([st], { stage: "new" }, "stage", /không được chuyển/, { stage: "done" });
  assert.deepEqual(ok([fd("s2", "status", { options: opts(["x"], ["y"]) })], { s2: "y" }, { s2: "x" }), { s2: "y" }, "không khai chuyển ⇒ mọi chuyển đều được");

  const mail = fd("mail", "email");
  assert.deepEqual(ok([mail], { mail: " An@Shop.VN " }), { mail: "an@shop.vn" });
  bad([mail], { mail: "an@shop" }, "mail", /email/);
  const phone = fd("phone2", "phone");
  assert.deepEqual(ok([phone], { phone2: "+84 912.345.678" }), { phone2: "0912345678" });
  assert.deepEqual(ok([phone], { phone2: "024 3826 1234" }), { phone2: "02438261234" }, "số cố định 11 số");
  bad([phone], { phone2: "12345" }, "phone2", /Việt Nam/);
  const link = fd("site", "url");
  assert.deepEqual(ok([link], { site: "https://shop.vn/a" }), { site: "https://shop.vn/a" });
  bad([link], { site: "javascript:alert(1)" }, "site", /http/);
  bad([fd("owner", "user")], { owner: "a b" }, "owner", /tham chiếu/);

  // Khoá lạ / đã lưu trữ ⇒ LỖI, không âm thầm bỏ.
  bad([text], { khong_co: "x" }, "khong_co", /không tồn tại/);
  bad([fd("gone", "text", { status: "ARCHIVED" })], { gone: "x" }, "gone", /không tồn tại/);
  const kept = validateCustomValues([text, fd("gone", "text", { status: "ARCHIVED" })], { note: "abc" }, { gone: "giữ" });
  assert.deepEqual(kept.values, { note: "abc", gone: "giữ" }, "giá trị của field đã lưu trữ GIỮ NGUYÊN khi gộp");
  assert.equal(validateCustomValues([text], [] as unknown as Record<string, unknown>, null).errors[0]?.field, "_", "đầu vào không phải object ⇒ lỗi");

  // Bắt buộc xét trên bản ĐÃ GỘP.
  const req = fd("must", "text", { required: true });
  bad([req, text], { note: "abc" }, "must", /bắt buộc/);
  assert.deepEqual(ok([req, text], { note: "abc" }, { must: "có" }), { must: "có", note: "abc" }, "đã có từ trước ⇒ không bắt nhập lại");
  bad([req], { must: "" }, "must", /bắt buộc/, { must: "có" });

  // Mẫu kiểm: neo hai đầu, lỗi cấu hình không ném, ReDoS bị chặn trước khi chạy.
  const code = fd("code", "text", { validation: { pattern: "KH\\d{4}", patternMessage: "Mã dạng KH0000" } });
  assert.deepEqual(ok([code], { code: "KH1234" }), { code: "KH1234" });
  bad([code], { code: "xKH1234" }, "code", /Mã dạng KH0000/);
  for (const p of ["(a+)+", "(a|aa)*", "(a*)*b", "((a)+)+", "(\\d+\\s?)+$", "(x)\\1", "\\d*\\d*\\d*\\d*x"]) assert.ok(unsafePatternReason(p), `mẫu nguy hiểm phải bị chặn: ${p}`);
  for (const p of ["[A-Z]{2}\\d{6}", "(\\+84|0)?\\d{9}", "[^@]+@[^@]+", "(ab){2}", "\\d{1,3}(\\.\\d{3})*"]) assert.equal(unsafePatternReason(p), null, `mẫu thường phải được nhận: ${p}`);
  const evil = fd("evil", "text", { validation: { pattern: "(a+)+" } });
  const t0 = Date.now();
  bad([evil], { evil: `${"a".repeat(1_900)}!` }, "evil", /Cấu hình field "evil" lỗi/);
  assert.ok(Date.now() - t0 < 500, "mẫu ReDoS không được chạy");
  bad([fd("broken", "text", { validation: { pattern: "([a-z" } })], { broken: "abc" }, "broken", /không biên dịch được/);
  bad([fd("long", "text", { validation: { pattern: "a".repeat(201) } })], { long: "a" }, "long", /dài quá 200/);
  bad([fd("big", "textarea", { validation: { pattern: "[a-z\\n]*" } })], { big: "a".repeat(2_001) }, "big", /2\.000/);
  assert.equal(compilePattern("abc").ok, true);

  console.log("✓ Metadata · kiểm hợp lệ thuần: 16 kiểu, bắt buộc trên bản gộp, rỗng ⇒ xoá (không 0), khoá lạ ⇒ lỗi, chuyển trạng thái, mẫu ReDoS bị chặn trước khi chạy");
}

function testSchemasPure() {
  const tier = fd("customer_tier", "select", { options: opts(["vip"]) });
  const archived = fd("old_field", "text", { status: "ARCHIVED" });
  const def = objectDef("customer")!;
  const dflt = defaultFormSchema("customer", "profile", [tier, archived]);
  const refs = dflt.sections.flatMap((s) => s.fields.map((f) => f.ref));
  assert.deepEqual(refs, ["system:name", "system:phone", "system:address", "system:province", "custom:customer_tier"], "form mặc định: field hệ thống sửa được + field custom ACTIVE");

  const published: FormSchema = {
    version: 1,
    sections: [
      {
        key: "main",
        label: "Chính",
        fields: [
          { ref: "system:name", visible: false, readOnly: false, required: false },
          { ref: "system:order_count", visible: true, readOnly: false, required: false },
          { ref: "system:khong_co", visible: true, readOnly: false, required: false },
          { ref: "custom:old_field", visible: true, readOnly: false, required: false },
          { ref: "custom:customer_tier", visible: true, readOnly: false, required: false },
          { ref: "custom:customer_tier", visible: false, readOnly: true, required: false },
        ],
      },
    ],
  };
  const newOptional = fd("new_optional", "text");
  const newRequired = fd("new_required", "text", { required: true });
  const n = normalizeFormSchema(published, def.fields, [tier, archived, newOptional, newRequired]);
  const f = n.sections[0].fields;
  assert.deepEqual(
    f.map((x) => x.ref),
    ["system:name", "system:order_count", "custom:customer_tier", "custom:new_required"],
    "ref lạ / ARCHIVED / trùng bị bỏ; field mới KHÔNG tự hiện trừ field BẮT BUỘC",
  );
  assert.equal(f[0].required, true, "required của hệ thống không nới được");
  assert.equal(f[0].visible, true, "field bắt buộc sửa được thì luôn hiện");
  assert.equal(f[1].readOnly, true, "field hệ thống editable:false luôn chỉ đọc");
  assert.equal(f[3].visible, true);
  const draft = normalizeFormSchema(published, def.fields, [tier, newOptional], { appendMissing: true });
  const added = draft.sections[0].fields.find((x) => x.ref === "custom:new_optional");
  assert.ok(added && added.visible === false, "bản nháp nối field mới vào cuối ở trạng thái ẨN");

  const list = defaultListView("customer", "default", [tier, fd("hidden_col", "text", { listable: false })]);
  assert.ok(list.columns.find((c) => c.ref === "system:name")?.visible, "cột hệ thống hiện như mã nguồn");
  assert.equal(list.columns.find((c) => c.ref === "custom:customer_tier")?.visible, false, "cột custom có mặt nhưng ẩn — trang y như cũ");
  assert.equal(list.columns.some((c) => c.ref === "custom:hidden_col"), false, "field không listable không thành cột");
  const nl = normalizeListView(
    {
      version: 1,
      columns: [{ ref: "custom:hidden_col", visible: true }, { ref: "system:name", visible: true }],
      defaultSort: { ref: "custom:khong_co", dir: "asc" },
      defaultFilters: [
        { ref: "custom:customer_tier", op: "in", value: [] },
        { ref: "custom:customer_tier", op: "eq", value: "vip" },
        { ref: "system:address", op: "eq", value: "x" },
      ],
    },
    def.fields,
    [tier, fd("hidden_col", "text", { listable: false })],
  );
  assert.deepEqual(nl.columns, [{ ref: "system:name", visible: true }]);
  assert.equal(nl.defaultSort, null, "sắp theo field không còn ⇒ không sắp");
  assert.deepEqual(nl.defaultFilters, [{ ref: "custom:customer_tier", op: "eq", value: "vip" }], "bộ lọc sai hình / field không lọc được bị bỏ");
  console.log("✓ Metadata · form & danh sách thuần: mặc định từ sổ, required chỉ chặt hơn, field mới không tự vào bản đã xuất bản (trừ bắt buộc)");
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

function sessionOf(u: { id: string; email: string }, over: Partial<SessionUser> = {}): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, ...over };
}

async function adminOf(org: string) {
  return withOrganization(org, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email };
  });
}

async function auditRows(entity: string, entityId?: string) {
  const db = await getDb();
  const t = schema.auditLogs;
  return db
    .select()
    .from(t)
    .where(entityId ? and(eq(t.entity, entity), eq(t.entityId, entityId)) : eq(t.entity, entity));
}

async function expectMetaError(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof MetadataError && e.code === code);
}

async function idsMatching(filters: Parameters<typeof customValuesFilterSql>[1]): Promise<string[]> {
  const db = await getDb();
  const cond = customValuesFilterSql("customer", filters);
  const rows = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(cond ? and(sql`${schema.customers.id} like 'pm-a-%'`, cond) : sql`${schema.customers.id} like 'pm-a-%'`);
  return rows.map((r) => r.id).sort();
}

export async function testMetadataService() {
  testValidatePure();
  testSchemasPure();

  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers", "products", "orders"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Meta@12345" }, source: "TEST", actor: null });
  }
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const actorA: MetadataActor = { id: adminA.id, email: adminA.email };
    const actorB: MetadataActor = { id: adminB.id, email: adminB.email };
    const viewerA = sessionOf(adminA);
    const viewerB = sessionOf(adminB);

    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values([
        { id: "pm-a-cus1", name: "Khách A1" },
        { id: "pm-a-cus2", name: "Khách A2" },
        { id: "pm-a-cus3", name: "Khách A3" },
      ]);
    });
    await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "pm-b-cus1", name: "Khách B1" });
    });

    // ── 1. Định nghĩa field: tạo, và mọi lối sai đều bị chặn ──
    await withOrganization(A, async () => {
      const tier = await createCustomField("customer", { key: "customer_tier", label: "Hạng khách", type: "select", options: [{ value: "vip", label: "VIP" }, { value: "thuong", label: "Thường" }], filterable: true }, actorA);
      assert.ok(tier.ok, JSON.stringify(tier));
      for (const input of [
        { key: "region", label: "Vùng", type: "text", filterable: true },
        { key: "amount", label: "Hạn mức", type: "currency", validation: { min: 0 } },
        { key: "owner", label: "Người phụ trách", type: "user" },
        { key: "secret_note", label: "Ghi chú nhạy cảm", type: "text", viewPermission: "users:manage" },
        { key: "contract_file", label: "Hợp đồng", type: "file" },
        { key: "stage_x", label: "Giai đoạn", type: "status", options: [{ value: "new", label: "Mới" }, { value: "won", label: "Thắng" }, { value: "lost", label: "Thua" }], transitions: { new: ["won", "lost"] } },
        { key: "ref_order", label: "Đơn liên quan", type: "relation", relationObject: "order" },
      ]) {
        const r = await createCustomField("customer", input, actorA);
        assert.ok(r.ok, `${input.key}: ${JSON.stringify(r)}`);
      }
      const expectInvalid = async (input: Record<string, unknown>, field: string, re: RegExp, objectKey = "customer") => {
        const r = await createCustomField(objectKey, input, actorA);
        assert.equal(r.ok, false, `phải lỗi: ${JSON.stringify(input)}`);
        if (!r.ok) {
          const e = r.errors.find((x) => x.field === field);
          assert.ok(e, `lỗi ở ${field}: ${JSON.stringify(r.errors)}`);
          assert.match(e.message, re);
        }
      };
      await expectInvalid({ key: "Bad-Key", label: "x", type: "text" }, "key", /chữ thường/);
      await expectInvalid({ key: "x", label: "x", type: "text" }, "key", /2–41/);
      await expectInvalid({ key: "name", label: "x", type: "text" }, "key", /trùng field hệ thống/);
      await expectInvalid({ key: "region", label: "x", type: "text" }, "key", /đã có/);
      await expectInvalid({ key: "weird_x", label: "x", type: "weird" }, "type", /không hỗ trợ/);
      await expectInvalid({ key: "sel_x", label: "x", type: "select", options: [] }, "options", /ít nhất một/);
      await expectInvalid({ key: "sel_y", label: "x", type: "select", options: [{ value: "a", label: "A" }, { value: "a", label: "B" }] }, "options", /bị trùng/);
      await expectInvalid({ key: "rel_x", label: "x", type: "relation", relationObject: "khong_co" }, "relationObject", /trong sổ/);
      await expectInvalid({ key: "perm_x", label: "x", type: "text", viewPermission: "khong:co" }, "viewPermission", /không tồn tại/);
      await expectInvalid({ key: "pat_x", label: "x", type: "text", validation: { pattern: "(a+)+" } }, "validation.pattern", /không an toàn/);
      await expectInvalid({ key: "st_x", label: "x", type: "status", options: [{ value: "a", label: "A" }], transitions: { a: ["z"] } }, "transitions", /không có trong tuỳ chọn/);
      await expectInvalid({ key: "dv_x", label: "x", type: "number", defaultValue: "abc" }, "defaultValue", /phải là số/);
      await expectInvalid({ key: "mm_x", label: "x", type: "text", validation: { min: 1 } }, "validation", /min \/ max/);

      const off = await createCustomField("shipment", { key: "ship_x", label: "x", type: "text" }, actorA);
      assert.ok(!off.ok && off.code === "MODULE_DISABLED", "module Vận chuyển tắt ⇒ MODULE_DISABLED");
      const unsupported = await createCustomField("order_item", { key: "oi_x", label: "x", type: "text" }, actorA);
      assert.ok(!unsupported.ok && unsupported.code === "NOT_SUPPORTED");
      const unknown = await createCustomField("khong_co", { key: "k_x", label: "x", type: "text" }, actorA);
      assert.ok(!unknown.ok && unknown.code === "OBJECT_UNKNOWN");
      await expectMetaError(getCustomValues("shipment", ["x"], viewerA), "MODULE_DISABLED");

      const created = await auditRows("META_FIELD", "customer.customer_tier");
      assert.equal(created.length, 1, "một lượt tạo = một dòng nhật ký");
      const detail = created[0].detail as { before: unknown; after: { key: string; type: string } };
      assert.equal(detail.before, null);
      assert.equal(detail.after.key, "customer_tier");
      assert.equal(created[0].userId, adminA.id, "nhật ký mang khoá tài khoản (luật 34)");
    });

    await withOrganization(B, async () => {
      const r = await createCustomField("customer", { key: "contract_type", label: "Loại hợp đồng", type: "text" }, actorB);
      assert.ok(r.ok);
    });

    // ── 2. Cô lập định nghĩa ──
    const keysA = await withOrganization(A, async () => (await listFields("customer")).custom.map((c) => c.key));
    const keysB = await withOrganization(B, async () => (await listFields("customer")).custom.map((c) => c.key));
    assert.ok(keysA.includes("customer_tier") && keysA.includes("region"));
    assert.equal(keysA.includes("contract_type"), false, "A không thấy field của B");
    assert.deepEqual(keysB, ["contract_type"], "B chỉ thấy field của mình");
    assert.ok((await withOrganization(A, () => listFields("customer"))).system.some((s) => s.key === "name"), "field hệ thống lấy từ sổ");

    // ── 3. Lưu giá trị: gộp, phiên bản, nhật ký chỉ khoá đổi, không đổi ⇒ không ghi ──
    await withOrganization(A, async () => {
      const s1 = await saveCustomValues("customer", "pm-a-cus1", { customer_tier: "vip", region: "Hà Nội", amount: "5.000.000", owner: adminA.id }, viewerA);
      assert.ok(s1.ok, JSON.stringify(s1));
      assert.equal(s1.version, 1);
      assert.deepEqual(s1.values, { customer_tier: "vip", region: "Hà Nội", amount: 5000000, owner: adminA.id });
      const s2 = await saveCustomValues("customer", "pm-a-cus1", { region: "TP HCM" }, viewerA);
      assert.ok(s2.ok && s2.version === 2 && s2.values.customer_tier === "vip" && s2.values.region === "TP HCM", "khoá không gửi lên giữ nguyên");
      const logs = await auditRows("CUSTOM_VALUES", "customer:pm-a-cus1");
      assert.equal(logs.length, 2);
      const last = logs.map((l) => l.detail as { before: Record<string, unknown>; after: Record<string, unknown>; version: number }).find((d) => d.version === 2)!;
      assert.deepEqual(last.before, { region: "Hà Nội" }, "trước: CHỈ khoá đổi");
      assert.deepEqual(last.after, { region: "TP HCM" }, "sau: CHỈ khoá đổi");
      const s3 = await saveCustomValues("customer", "pm-a-cus1", { region: "TP HCM" }, viewerA);
      assert.ok(s3.ok && s3.version === 2 && s3.changed.length === 0, "không đổi gì ⇒ không tăng phiên bản");
      assert.equal((await auditRows("CUSTOM_VALUES", "customer:pm-a-cus1")).length, 2, "không đổi gì ⇒ không thêm nhật ký");
      const s4 = await saveCustomValues("customer", "pm-a-cus1", { amount: null }, viewerA);
      assert.ok(s4.ok && !("amount" in s4.values), "xoá giá trị tiền ⇒ vắng mặt, không thành 0");

      const badUser = await saveCustomValues("customer", "pm-a-cus2", { owner: adminB.id }, viewerA);
      assert.ok(!badUser.ok && /tài khoản không tồn tại/.test(badUser.errors[0].message), "id người của tổ chức B không tồn tại trong A");
      const badRel = await saveCustomValues("customer", "pm-a-cus2", { ref_order: "khong-co-don" }, viewerA);
      assert.ok(!badRel.ok && /không tồn tại/.test(badRel.errors[0].message));
      const badStage = await saveCustomValues("customer", "pm-a-cus2", { stage_x: "won" }, viewerA);
      assert.ok(badStage.ok);
      const back = await saveCustomValues("customer", "pm-a-cus2", { stage_x: "new" }, viewerA);
      assert.ok(!back.ok && back.code === "INVALID", "won ⇒ new không có trong chuyển trạng thái");
      const s5 = await saveCustomValues("customer", "pm-a-cus2", { customer_tier: "thuong", amount: 200000 }, viewerA);
      assert.ok(s5.ok);
      const missing = await saveCustomValues("customer", "pm-a-khong-co", { region: "x" }, viewerA);
      assert.ok(!missing.ok && missing.code === "NOT_FOUND");

      // Quyền: thiếu `customers:write` ⇒ chặn; field có viewPermission ⇒ người thiếu quyền không thấy, không ghi được.
      const viewerOnly = sessionOf({ id: "pm-viewer", email: "v@pm-a.local" }, { role: "CS", permissions: ["customers:view"] });
      const denied = await saveCustomValues("customer", "pm-a-cus1", { region: "x" }, viewerOnly);
      assert.ok(!denied.ok && denied.code === "FORBIDDEN" && /dữ liệu bổ sung của Khách hàng/.test(denied.errors[0].message), "chỉ xem (thiếu customers:write) ⇒ chặn ở cửa ĐỐI TƯỢNG, trước mọi bước khác");
      const writer = sessionOf({ id: "pm-writer", email: "w@pm-a.local" }, { role: "CS", permissions: ["customers:view", "customers:write"] });
      const adminSecret = await saveCustomValues("customer", "pm-a-cus1", { secret_note: "bí mật" }, viewerA);
      assert.ok(adminSecret.ok);
      const seen = (await getCustomValues("customer", ["pm-a-cus1"], writer)).get("pm-a-cus1")!;
      assert.equal("secret_note" in seen, false, "field có viewPermission bị lọc khi đọc");
      assert.equal(seen.customer_tier, "vip");
      const writeSecret = await saveCustomValues("customer", "pm-a-cus1", { secret_note: "đổi" }, writer);
      assert.ok(!writeSecret.ok && writeSecret.code === "FORBIDDEN", "không xem được thì không ghi được");
      assert.equal((await getCustomValues("customer", ["pm-a-cus1"], viewerA)).get("pm-a-cus1")?.secret_note, "bí mật");
      assert.equal((await getCustomValues("customer", ["pm-a-cus1"], sessionOf({ id: "x", email: "x" }, { role: "VIEWER", permissions: [] }))).size, 0, "không có quyền xem khách ⇒ rỗng");
    });

    // ── 4. TẤN CÔNG THEO ID CHÉO TỔ CHỨC: phiên B, id khách của A ──
    await withOrganization(B, async () => {
      const db = await getDb();
      const attack = await saveCustomValues("customer", "pm-a-cus1", { contract_type: "x" }, viewerB);
      assert.ok(!attack.ok && attack.code === "NOT_FOUND" && /Bản ghi không tồn tại/.test(attack.errors[0].message), "B ghi theo id khách của A ⇒ bản ghi không tồn tại");
      const rowsB = await db.select().from(schema.customValues);
      assert.equal(rowsB.length, 0, "0 dòng được ghi trong CSDL B");
      assert.equal((await getCustomValues("customer", ["pm-a-cus1", "pm-a-cus2"], viewerB)).size, 0, "đọc chéo ⇒ rỗng");
      const foreignField = await saveCustomValues("customer", "pm-b-cus1", { customer_tier: "vip" }, viewerB);
      assert.ok(!foreignField.ok && /không tồn tại/.test(foreignField.errors[0].message), "khoá field của A không tồn tại ở B");
      const own = await saveCustomValues("customer", "pm-b-cus1", { contract_type: "Đại lý" }, viewerB);
      assert.ok(own.ok);
    });
    await withOrganization(A, async () => {
      const db = await getDb();
      const [row] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, "pm-a-cus1")));
      assert.equal(row.values.contract_type, undefined, "dòng của A không bị chạm");
      assert.equal((await getCustomValues("customer", ["pm-b-cus1"], viewerA)).size, 0);
    });

    // ── 5. Lọc SQL: tham số hoá, đúng bản ghi ──
    await withOrganization(A, async () => {
      assert.deepEqual(await idsMatching([{ ref: "custom:customer_tier", op: "eq", value: "vip" }]), ["pm-a-cus1"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:customer_tier", op: "neq", value: "vip" }]), ["pm-a-cus2", "pm-a-cus3"], "neq gồm cả bản ghi chưa có giá trị");
      assert.deepEqual(await idsMatching([{ ref: "custom:customer_tier", op: "in", value: ["vip", "thuong"] }]), ["pm-a-cus1", "pm-a-cus2"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:region", op: "contains", value: "hcm" }]), ["pm-a-cus1"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:region", op: "contains", value: "%" }]), [], "ký tự đại diện của LIKE được thoát");
      assert.deepEqual(await idsMatching([{ ref: "custom:amount", op: "gte", value: 100000 }]), ["pm-a-cus2"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:amount", op: "lte", value: 100000 }]), []);
      assert.deepEqual(await idsMatching([{ ref: "custom:region", op: "empty" }]), ["pm-a-cus2", "pm-a-cus3"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:region", op: "not_empty" }]), ["pm-a-cus1"]);
      assert.deepEqual(await idsMatching([{ ref: "custom:customer_tier", op: "eq", value: "vip' or '1'='1" }]), [], "chuỗi người dùng không bao giờ thành SQL");
      assert.deepEqual(
        await idsMatching([
          { ref: "custom:customer_tier", op: "in", value: ["vip", "thuong"] },
          { ref: "custom:amount", op: "gte", value: 100000 },
        ]),
        ["pm-a-cus2"],
        "nhiều bộ lọc ⇒ AND",
      );
      assert.equal(customValuesFilterSql("customer", [{ ref: "system:name", op: "eq", value: "x" }]), undefined, "ref hệ thống là việc của truy vấn gốc");
      assert.throws(() => customValuesFilterSql("customer", [{ ref: "custom:Bad;drop", op: "eq", value: "x" } as never]), MetadataError);
      assert.throws(() => customValuesFilterSql("customer", [{ ref: "custom:region", op: "in", value: [] }]), MetadataError, "bộ lọc sai hình ⇒ ném, không trả rỗng im lặng");
    });

    // ── 6. Sửa / lưu trữ field ──
    await withOrganization(A, async () => {
      const typeChange = await updateCustomField("customer", "customer_tier", { type: "text" }, actorA);
      assert.ok(!typeChange.ok && /đã có 2 bản ghi/.test(typeChange.errors[0].message), "không đổi kiểu khi đã có giá trị");
      const keyChange = await updateCustomField("customer", "customer_tier", { key: "tier2" }, actorA);
      assert.ok(!keyChange.ok, "không đổi khoá khi đã có giá trị");
      const removeOpt = await updateCustomField("customer", "customer_tier", { options: [{ value: "vip", label: "VIP" }] }, actorA);
      assert.ok(!removeOpt.ok && /tắt nó/.test(removeOpt.errors[0].message), "không xoá tuỳ chọn đã khai");
      const deactivate = await updateCustomField("customer", "customer_tier", { label: "Hạng", options: [{ value: "vip", label: "VIP" }, { value: "thuong", label: "Thường", active: false }] }, actorA);
      assert.ok(deactivate.ok && deactivate.field.label === "Hạng");
      const useInactive = await saveCustomValues("customer", "pm-a-cus3", { customer_tier: "thuong" }, viewerA);
      assert.ok(!useInactive.ok && /ngừng dùng/.test(useInactive.errors[0].message));
      const upd = (await auditRows("META_FIELD", "customer.customer_tier")).find((r) => r.action === "META_FIELD_UPDATE");
      assert.ok(upd && (upd.detail as { before: { label: string } }).before.label === "Hạng khách", "nhật ký sửa có TRƯỚC");

      const temp = await createCustomField("customer", { key: "temp_x", label: "Tạm", type: "text" }, actorA);
      assert.ok(temp.ok);
      const renamed = await updateCustomField("customer", "temp_x", { key: "temp_y", type: "number" }, actorA);
      assert.ok(renamed.ok && renamed.field.key === "temp_y" && renamed.field.type === "number", "chưa có giá trị ⇒ đổi được khoá / kiểu");

      const arch = await archiveCustomField("customer", "region", actorA);
      assert.ok(arch.ok && arch.field.status === "ARCHIVED");
      const archAgain = await archiveCustomField("customer", "region", actorA);
      assert.ok(archAgain.ok);
      assert.equal((await auditRows("META_FIELD", "customer.region")).filter((r) => r.action === "META_FIELD_ARCHIVE").length, 1, "lưu trữ lần hai không ghi thêm");
      assert.equal("region" in ((await getCustomValues("customer", ["pm-a-cus1"], viewerA)).get("pm-a-cus1") ?? {}), false, "field ARCHIVED không trả");
      const writeArchived = await saveCustomValues("customer", "pm-a-cus1", { region: "x" }, viewerA);
      assert.ok(!writeArchived.ok && /không tồn tại/.test(writeArchived.errors[0].message), "field ARCHIVED không nhận ghi");
      const db = await getDb();
      const [raw] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, "pm-a-cus1")));
      assert.equal(raw.values.region, "TP HCM", "giá trị của field ARCHIVED GIỮ NGUYÊN trong CSDL");
      const reuse = await createCustomField("customer", { key: "region", label: "Vùng mới", type: "text" }, actorA);
      assert.ok(!reuse.ok, "khoá đã lưu trữ không dùng lại được");
      const editArchived = await updateCustomField("customer", "region", { label: "x" }, actorA);
      assert.ok(!editArchived.ok);
      assert.equal((await listFields("customer", { includeArchived: true })).custom.some((c) => c.key === "region"), true);
      assert.equal((await listFields("customer")).custom.some((c) => c.key === "region"), false);
    });

    // ── 7. Form: nháp / xuất bản / phiên bản / ảnh chụp ──
    await withOrganization(A, async () => {
      const d0 = await getPublishedForm("customer", "profile");
      assert.equal(d0.isDefault, true);
      assert.equal(d0.version, 0);
      assert.ok(d0.schema.sections.some((s) => s.fields.some((f) => f.ref === "custom:customer_tier")), "form mặc định có field custom");
      await expectMetaError(getPublishedForm("order", "profile"), "NOT_SUPPORTED");
      await expectMetaError(getPublishedForm("customer", "khong_co"), "NOT_FOUND");

      const draft1: FormSchema = { version: 1, sections: [{ key: "extra", label: "Bổ sung", fields: [{ ref: "custom:customer_tier", visible: true, readOnly: false, required: false }] }] };
      const badRef = await saveFormDraft("customer", "profile", { version: 1, sections: [{ key: "s", label: "S", fields: [{ ref: "custom:region", visible: true, readOnly: false, required: false }] }] }, actorA);
      assert.ok(!badRef.ok && /không tồn tại hoặc đã lưu trữ/.test(badRef.errors[0].message), "ref tới field ARCHIVED ⇒ lỗi khi lưu nháp");
      const badShape = await saveFormDraft("customer", "profile", { version: 2, sections: [] }, actorA);
      assert.ok(!badShape.ok && badShape.code === "INVALID");
      // Chưa ai lưu nháp: trình soạn hiện bản MẶC ĐỊNH, "Lưu nháp" khoá vì chưa đổi gì ⇒ "Xuất bản" phải xuất
      // bản ĐÚNG bản đang hiện (lỗi bắt được ở bài chạy thử trình duyệt 27/09: trước đây trả "Chưa có bản nháp"
      // và không có đường nào xuất bản form mặc định lần đầu). Dùng form `create` để không xáo phiên bản của `profile`.
      const shownCreate = await getFormDraft("customer", "create");
      const noDraft = await publishForm("customer", "create", actorA);
      assert.ok(noDraft.ok && noDraft.version === 1, "chưa có nháp ⇒ xuất bản bản mặc định đang hiện, phiên bản 1");
      assert.deepEqual((await getPublishedForm("customer", "create")).schema, shownCreate, "bản xuất bản ĐÚNG là thứ trình soạn đang hiện");
      assert.ok((await saveFormDraft("customer", "profile", draft1, actorA)).ok);
      assert.equal((await getPublishedForm("customer", "profile")).isDefault, true, "lưu nháp KHÔNG đổi bản người dùng thấy");
      const p1 = await publishForm("customer", "profile", actorA);
      assert.ok(p1.ok && p1.version === 1);
      const pub1 = await getPublishedForm("customer", "profile");
      assert.equal(pub1.isDefault, false);
      assert.equal(pub1.version, 1);
      assert.equal(pub1.publishedBy, adminA.email, "người xuất bản (email ảnh chụp) để in lên màn quản trị");
      assert.ok(pub1.publishedAt instanceof Date);
      assert.equal(d0.publishedAt, null, "form mặc định: chưa ai xuất bản");
      assert.deepEqual(
        pub1.schema.sections.flatMap((s) => s.fields.map((f) => f.ref)),
        ["custom:customer_tier"],
      );
      // Sửa nháp sau khi xuất bản không đổi bản đã xuất bản.
      const draft2: FormSchema = { version: 1, sections: [{ key: "extra", label: "Bổ sung", fields: [{ ref: "custom:customer_tier", visible: true, readOnly: false, required: false }, { ref: "custom:amount", visible: true, readOnly: false, required: false }] }] };
      assert.ok((await saveFormDraft("customer", "profile", draft2, actorA)).ok);
      assert.deepEqual((await getPublishedForm("customer", "profile")).schema.sections[0].fields.map((f) => f.ref), ["custom:customer_tier"], "nháp sửa không ảnh hưởng bản đã xuất bản");
      // "Field ẩn không nhận ghi": lượt ghi qua form chỉ nhận field hiện của bản ĐÃ XUẤT BẢN.
      const viaForm = await saveCustomValues("customer", "pm-a-cus3", { amount: 1000 }, viewerA, { formKey: "profile" });
      assert.ok(!viaForm.ok && viaForm.code === "FORBIDDEN", "field không có trong form đã xuất bản ⇒ không ghi qua form");
      const viaForm2 = await saveCustomValues("customer", "pm-a-cus3", { customer_tier: "vip" }, viewerA, { formKey: "profile" });
      assert.ok(viaForm2.ok);
      const p2 = await publishForm("customer", "profile", actorA);
      assert.ok(p2.ok && p2.version === 2, "phiên bản tăng");
      const db = await getDb();
      const versions = await db
        .select()
        .from(schema.metaConfigVersions)
        .where(and(eq(schema.metaConfigVersions.kind, "FORM"), eq(schema.metaConfigVersions.objectKey, "customer"), eq(schema.metaConfigVersions.configKey, "profile")));
      assert.deepEqual(versions.map((v) => v.version).sort(), [1, 2], "mỗi lượt xuất bản một ảnh chụp");
      const snap1 = versions.find((v) => v.version === 1)!.snapshot as { schema: FormSchema; fields: CustomFieldDef[] };
      assert.equal(snap1.schema.sections[0].fields.length, 1, "ảnh chụp v1 BẤT BIẾN sau khi xuất bản v2");
      assert.equal(snap1.fields[0].key, "customer_tier", "ảnh chụp mang định nghĩa field lúc xuất bản");
      assert.equal(versions[0].actorId, adminA.id);
      const pubLogs = (await auditRows("META_FORM", "customer.profile")).filter((r) => r.action === "META_FORM_PUBLISH");
      assert.equal(pubLogs.length, 2);
      const pl = pubLogs.map((r) => r.detail as { before: { version: number }; after: { version: number } }).find((d) => d.after.version === 2)!;
      assert.equal(pl.before.version, 1, "nhật ký xuất bản có TRƯỚC / SAU");

      // Field mới: không tự vào form đã xuất bản; có mặt (ẩn) trong bản nháp của trình soạn.
      assert.ok((await createCustomField("customer", { key: "late_field", label: "Mới thêm", type: "text" }, actorA)).ok);
      assert.equal((await getPublishedForm("customer", "profile")).schema.sections.flatMap((s) => s.fields).some((f) => f.ref === "custom:late_field"), false);
      const editor = await getFormDraft("customer", "profile");
      assert.equal(editor.sections.flatMap((s) => s.fields).find((f) => f.ref === "custom:late_field")?.visible, false);
    });
    assert.equal((await withOrganization(B, () => getPublishedForm("customer", "profile"))).isDefault, true, "xuất bản ở A không đổi form của B");

    // ── 8. Danh sách ──
    await withOrganization(A, async () => {
      const l0 = await getPublishedListView("customer", "default");
      assert.equal(l0.isDefault, true);
      const badCol = await saveListViewDraft("customer", "default", { version: 1, columns: [{ ref: "custom:khong_co", visible: true }], defaultSort: null, defaultFilters: [] }, actorA);
      assert.ok(!badCol.ok);
      const saved = await saveListViewDraft(
        "customer",
        "default",
        { version: 1, columns: [{ ref: "system:name", visible: true }, { ref: "custom:customer_tier", visible: true }], defaultSort: { ref: "system:name", dir: "asc" }, defaultFilters: [{ ref: "custom:customer_tier", op: "eq", value: "vip" }] },
        actorA,
      );
      assert.ok(saved.ok, JSON.stringify(saved));
      const lp = await publishListView("customer", "default", actorA);
      assert.ok(lp.ok && lp.version === 1);
      const l1 = await getPublishedListView("customer", "default");
      assert.equal(l1.publishedBy, adminA.email);
      assert.deepEqual(l1.schema.columns, [{ ref: "system:name", visible: true }, { ref: "custom:customer_tier", visible: true }]);
      const draft = await getListViewDraft("customer", "default");
      assert.ok(draft.columns.some((c) => c.ref === "custom:late_field" && !c.visible), "nháp danh sách nối cột mới ở trạng thái ẩn");
      const db = await getDb();
      const v = await db.select().from(schema.metaConfigVersions).where(eq(schema.metaConfigVersions.kind, "LIST_VIEW"));
      assert.equal(v.length, 1);
    });

    // ── 9. Trạng thái hệ thống: chỉ nhãn / thứ tự / ẩn — không thêm giá trị ──
    await withOrganization(A, async () => {
      const r = await saveStatusOverrides("order", "stage", [{ value: "NEW", label: "Mới tạo", position: 20 }, { value: "CANCELLED", active: false }], actorA);
      assert.ok(r.ok, JSON.stringify(r));
      const add = await saveStatusOverrides("order", "stage", [{ value: "FOO", label: "Giá trị mới" }], actorA);
      assert.ok(!add.ok && /không thêm được giá trị mới/.test(add.errors[0].message));
      const notStatus = await saveStatusOverrides("order", "id", [], actorA);
      assert.ok(!notStatus.ok && notStatus.code === "NOT_FOUND");
      const customerStatus = await saveStatusOverrides("customer", "name", [], actorA);
      assert.ok(!customerStatus.ok && customerStatus.code === "NOT_SUPPORTED");
      assert.equal(await resolveStatusLabel("order", "stage", "NEW"), "Mới tạo");
      assert.equal(await resolveStatusLabel("order", "stage", "SHIPPED"), "Đã gửi hàng", "không ghi đè ⇒ nhãn của sổ");
      assert.equal(await resolveStatusLabel("order", "stage", "LA_LAM"), "LA_LAM", "giá trị lạ ⇒ in nguyên, không đoán");
      const optsA = await resolveStatusOptions("order", "stage");
      assert.equal(optsA.length, objectDef("order")!.fields.find((f) => f.key === "stage")!.options!.length, "không thêm, không bớt giá trị");
      assert.equal(optsA[optsA.length - 1].value, "NEW", "thứ tự theo ghi đè");
      assert.equal(optsA.find((o) => o.value === "CANCELLED")?.active, false);
      assert.equal((await getStatusOverrides("order", "stage")).length, 2);
      assert.equal(await resolveStatusLabel("customer", "customer_tier", "vip"), "VIP", "field custom kiểu chọn: nhãn từ tuỳ chọn");
      assert.equal((await auditRows("META_STATUS", "order.stage")).length, 1);
    });
    assert.equal(await withOrganization(B, () => resolveStatusLabel("order", "stage", "NEW")), "Mới", "nhãn của A không sang B");

    // ── 10. Tệp + xuất CSV ──
    const fileId = await withOrganization(A, async () => {
      const big = await saveCustomFile("customer", "pm-a-cus1", "contract_file", { filename: "to.pdf", mime: "application/pdf", data: Buffer.alloc(5 * 1024 * 1024 + 1) }, viewerA);
      assert.ok(!big.ok && /5 MB/.test(big.errors[0].message), "trần 5 MB");
      const up = await saveCustomFile("customer", "pm-a-cus1", "contract_file", { filename: "../../hop-dong.pdf", mime: "application/pdf", data: Buffer.from("%PDF-1.4 thử") }, viewerA);
      assert.ok(up.ok, JSON.stringify(up));
      assert.equal(up.file.filename, "hop-dong.pdf", "tên tệp bỏ đường dẫn");
      assert.equal(up.values.contract_file, up.file.id);
      const back = await readCustomFile(up.file.id, viewerA);
      assert.equal(back?.data.toString(), "%PDF-1.4 thử");
      const forged = await saveCustomValues("customer", "pm-a-cus2", { contract_file: up.file.id }, viewerA);
      assert.ok(!forged.ok, "id tệp của bản ghi khác không gán được");
      const exp = await exportCustomValues("customer", ["pm-a-cus1", "pm-a-cus2", "pm-a-khong-co"], viewerA);
      assert.deepEqual([...exp.rows.keys()], ["pm-a-cus1", "pm-a-cus2"], "bản ghi không tồn tại không vào tệp xuất");
      assert.equal(exp.rows.get("pm-a-cus1")?.customer_tier, "VIP", "xuất theo nhãn");
      assert.equal(exp.rows.get("pm-a-cus1")?.amount, "", "ô trống = CHƯA BIẾT, không phải 0");
      assert.equal(exp.rows.get("pm-a-cus2")?.amount, "200000");
      assert.equal(exp.columns.some((c) => c.key === "region"), false, "field ARCHIVED không thành cột");
      const writer = sessionOf({ id: "pm-writer", email: "w@pm-a.local" }, { role: "CS", permissions: ["customers:view", "customers:write"] });
      assert.equal((await exportCustomValues("customer", ["pm-a-cus1"], writer)).columns.some((c) => c.key === "secret_note"), false, "xuất tôn trọng viewPermission");
      return up.file.id;
    });
    assert.equal(await withOrganization(B, () => readCustomFile(fileId, viewerB)), null, "B không đọc được tệp của A theo id");

    console.log("✓ Metadata · dịch vụ hai tổ chức: field/giá trị/form/danh sách/trạng thái cô lập · id chéo tổ chức ⇒ không tồn tại, 0 dòng · xuất bản có phiên bản + ảnh chụp + nhật ký trước/sau · lọc SQL tham số hoá");
  } finally {
    for (const code of [A, B]) await cleanupOrg(code);
  }
}
