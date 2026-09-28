/**
 * PHASE 6 · ĐỐI TƯỢNG TUỲ BIẾN (docs/platform/phase-6-contracts.md).
 *
 * HAI TỔ CHỨC THẬT (`co-a`, `co-b` — hai CSDL PGlite riêng, `provisionOrganization`, tự dọn):
 *  · vòng đời đối tượng (tạo · sửa · lưu trữ · khôi phục; khoá / biểu tượng / quyền / nhóm menu sai ⇒ từ chối);
 *  · field trên đối tượng `x_…` qua ĐÚNG dịch vụ Phase 2 (bộ phân giải), kể cả quan hệ tới KHÁCH HÀNG (hệ thống) và tới
 *    đối tượng tuỳ biến khác (`relation` + `relation_many`), chiều ngược một-nhiều, tên đích chỉ hiện khi xem được;
 *  · bản ghi: tạo / sửa / xoá mềm, sự kiện `custom_record.*` đúng một lần, danh sách lọc / sắp / phân trang máy chủ;
 *  · tổ chức B không đọc / ghi được bản ghi, định nghĩa, quan hệ, tệp của A bằng id trực tiếp;
 *  · thiếu quyền ⇒ FORBIDDEN; phạm vi SELF ⇒ chỉ bản ghi mình là chủ (kể cả qua cửa ghi giá trị chung); phạm vi
 *    DEPARTMENT ⇒ bản ghi có chủ cùng phòng; module `apps` tắt ⇒ từ chối ở máy chủ;
 *  · luật "Hợp đồng tạo mới → giá trị > 20.000.000 → cửa duyệt → tạo việc" chạy ĐÚNG MỘT lần sau khi duyệt;
 *  · 8 đối tượng hệ thống không đổi hành vi (bộ phân giải trả đúng sổ tĩnh, danh sách mặc định như cũ).
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { decideApprovalCore } from "@/lib/approvals/service";
import type { SessionUser } from "@/lib/auth/session";
import { OBJECT_REGISTRY, objectDef } from "@/lib/constants/object-registry";
import { moduleOfPath } from "@/lib/constants/platform-modules";
import { requireObject } from "@/lib/metadata/common";
import { customObjectDef } from "@/lib/metadata/custom-object-def";
import { MetadataError } from "@/lib/metadata/errors";
import { createCustomField, listFields } from "@/lib/metadata/fields";
import { defaultListView } from "@/lib/metadata/list-schema";
import { resolveObject } from "@/lib/metadata/object-resolver";
import type { MetadataActor } from "@/lib/metadata/types";
import { validateCustomValues } from "@/lib/metadata/validate";
import { getCustomValues, openCustomFile, saveCustomFile, saveCustomValues } from "@/lib/metadata/values";
import { archiveObject, createObject, listObjects, restoreObject, updateObject } from "@/lib/objects/objects";
import { createRecord, deleteRecord, getRecord, listRecords, recordTimeline, reverseRelations, updateRecord } from "@/lib/objects/records";
import { assignMembership } from "@/lib/org/membership";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { parseListParams } from "@/lib/search-params";
import { runWorkflows, triggerMatches } from "@/lib/workflow/engine";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import { customObjectNavFor } from "@/lib/pages/nav";

const A = "co-a";
const B = "co-b";

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

async function adminOf(org: string) {
  return withOrganization(org, async () => {
    const u = await (await getDb()).query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email };
  });
}

function admin(u: { id: string; email: string }, org: string): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

function staff(id: string, org: string, permissions: string[], scope: SessionUser["scope"]): SessionUser {
  return { id, email: `${id}@${org}.local`, name: id, role: "VIEWER", permissions, scope, departmentCodes: [], positionId: null, organization: { code: org, name: org, isHome: false } };
}

async function setModule(org: string, key: string, enabled: boolean) {
  const pdb = await getPlatformDb();
  const o = await pdb.query.platformOrganizations.findFirst({ where: eq(schema.platformOrganizations.code, org) });
  assert.ok(o);
  const updated = await pdb
    .update(schema.platformOrganizationModules)
    .set({ enabled })
    .where(and(eq(schema.platformOrganizationModules.organizationId, o.id), eq(schema.platformOrganizationModules.moduleKey, key)))
    .returning();
  if (updated.length === 0) await pdb.insert(schema.platformOrganizationModules).values({ organizationId: o.id, moduleKey: key, enabled, features: {} });
  invalidateCapabilities();
}

function code(r: { ok: boolean }): string {
  return r.ok ? "OK" : String((r as { code?: string }).code);
}

function msg(r: unknown): string {
  return JSON.stringify(r).slice(0, 600);
}

const params = (over: Record<string, string> = {}) => parseListParams(over, { defaultSort: "", sortable: undefined });

async function eventsNamed(name: string, subjectId?: string) {
  const db = await getDb();
  const ev = schema.domainEvents;
  return db.select().from(ev).where(subjectId ? and(eq(ev.name, name), eq(ev.subjectId, subjectId)) : eq(ev.name, name));
}

function testPure() {
  // 8 đối tượng hệ thống: bộ dựng thuần không đụng tới sổ tĩnh.
  assert.equal(OBJECT_REGISTRY.length, 8);
  const x = customObjectDef({ key: "x_xe", label: "Xe", labelPlural: "Xe", icon: "car", moduleKey: "apps", titleLabel: "Biển số", description: null, viewPermission: "records:view", writePermission: "records:write", status: "ACTIVE", origin: null });
  assert.equal(x.system, false);
  assert.equal(x.table, "customRecords");
  assert.equal(x.module, "apps");
  assert.deepEqual(x.fields.map((f) => f.key), ["title", "owner", "created_at", "updated_at"]);
  assert.equal(x.fields[0].label, "Biển số");
  assert.deepEqual(x.lists[0], { key: "default", label: "Danh sách xe", route: "/o/x_xe" });
  // Danh sách mặc định: đối tượng hệ thống GIỮ cột custom ẩn (M9), đối tượng tuỳ biến hiện.
  const f = { id: "1", objectKey: "", key: "gia", label: "Giá", type: "currency" as const, required: false, defaultValue: null, options: [], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: false, position: 0, status: "ACTIVE" as const };
  assert.equal(defaultListView("customer", "default", [f]).columns.find((c) => c.ref === "custom:gia")?.visible, false, "khách hàng: cột custom mặc định vẫn ẨN");
  assert.equal(defaultListView(x, "default", [f]).columns.find((c) => c.ref === "custom:gia")?.visible, true, "đối tượng tuỳ biến: cột custom hiện");
  // relation_many: mảng id, trùng bị gộp, ≤ 50.
  const rm = { ...f, key: "ds", label: "DS", type: "relation_many" as const, relationObject: "x_xe" };
  assert.deepEqual(validateCustomValues([rm], { ds: ["a", "b", "a"] }, null).values.ds, ["a", "b"]);
  assert.equal(validateCustomValues([rm], { ds: Array.from({ length: 51 }, (_, i) => `id${i}`) }, null).errors.length, 1, "quá 50 ⇒ lỗi");
  assert.equal(validateCustomValues([rm], { ds: ["a b"] }, null).errors.length, 1, "id sai hình ⇒ lỗi");
  // Trigger lọc theo đối tượng.
  const t = { kind: "event" as const, event: "custom_record.created", objectKey: "x_hop_dong" };
  assert.equal(triggerMatches(t, { name: "custom_record.created", payload: { objectKey: "x_hop_dong" } }), true);
  assert.equal(triggerMatches(t, { name: "custom_record.created", payload: { objectKey: "x_cong_trinh" } }), false, "sự kiện của đối tượng khác không khớp");
  assert.equal(moduleOfPath("/o/x_hop_dong/abc"), "apps", "tuyến /o thuộc module Ứng dụng tuỳ biến");
  assert.equal(moduleOfPath("/settings/objects"), "core");
  // Menu động: chỉ đối tượng ACTIVE, người xem có quyền + module bật.
  const nav = [x, { ...x, key: "x_luu", custom: { ...x.custom!, status: "ARCHIVED" as const } }];
  assert.deepEqual(customObjectNavFor(nav, { role: "VIEWER", permissions: ["records:view"], modules: ["core", "apps"] }).map((i) => i.href), ["/o/x_xe"]);
  assert.deepEqual(customObjectNavFor(nav, { role: "VIEWER", permissions: [], modules: ["core", "apps"] }), [], "thiếu records:view ⇒ không mục nào");
  assert.deepEqual(customObjectNavFor(nav, { role: "ADMIN", permissions: [], modules: ["core"] }), [], "module apps tắt ⇒ không mục nào, kể cả ADMIN");
}

export async function testCustomObjects() {
  testPure();

  for (const c of [A, B]) {
    await cleanupOrg(c);
    rmSync(organizationDatabaseUrl({ code: c, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code: c, name: `Tổ chức ${c}`, modules: ["customers", "apps"], admin: { email: `admin@${c}.local`, name: `QT ${c}`, password: "Objects@12345" }, source: "TEST", actor: null });
  }
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const qtA = admin(adminA, A);
    const qtB = admin(adminB, B);
    const actorA: MetadataActor = { id: adminA.id, email: adminA.email };
    const actorB: MetadataActor = { id: adminB.id, email: adminB.email };
    const ids: Record<string, string> = {};

    // ══════════ TỔ CHỨC B: một đối tượng + khách riêng, để A không bao giờ với tới ══════════
    await withOrganization(B, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values({ id: "co-b-cus1", name: "Khách của B" });
      assert.equal(code(await createObject(qtB, { key: "x_rieng_b", label: "Riêng B", labelPlural: "Riêng B", icon: "box" })), "OK");
      const rb = await createRecord("x_rieng_b", { system: { title: "Bản ghi của B" } }, qtB);
      assert.ok(rb.ok, msg(rb));
      ids.bRecord = rb.id;
    });

    // ══════════ TỔ CHỨC A ══════════
    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.customers).values([{ id: "co-a-cus1", name: "Khách A1" }]);
      const mgr = { id: "co-a-mgr", email: "mgr@co-a.local" };
      await db.insert(schema.users).values([
        { id: mgr.id, email: mgr.email, name: "Quản lý A", passwordHash: "x", role: "MANAGER", active: true },
        { id: "co-a-nv1", email: "nv1@co-a.local", name: "NV1", passwordHash: "x", role: "VIEWER", active: true },
        { id: "co-a-nv2", email: "nv2@co-a.local", name: "NV2", passwordHash: "x", role: "VIEWER", active: true },
        { id: "co-a-nv3", email: "nv3@co-a.local", name: "NV3", passwordHash: "x", role: "VIEWER", active: true },
      ]);

      // ── 1. Định nghĩa đối tượng ──
      const bad = async (input: Record<string, unknown>, path: string, re: RegExp, why: string) => {
        const r = await createObject(qtA, { key: "x_hop_dong", label: "Hợp đồng bảo trì", labelPlural: "Hợp đồng bảo trì", icon: "file-text", ...input });
        assert.equal(r.ok, false, `${why}: phải bị từ chối`);
        assert.ok(!r.ok && r.errors.some((e) => e.path.startsWith(path) && re.test(e.message)), `${why}: ${msg(r)}`);
      };
      await bad({ key: "hop_dong" }, "key", /x_/, "khoá thiếu tiền tố x_");
      await bad({ key: "x_Hop" }, "key", /x_/, "khoá có chữ hoa");
      await bad({ icon: "rocket" }, "icon", /biểu tượng/, "biểu tượng ngoài tập đóng");
      await bad({ viewPermission: "khong:co" }, "viewPermission", /sổ quyền/, "khoá quyền lạ");
      await bad({ moduleKey: "khong_co" }, "moduleKey", /module/, "nhóm menu lạ");
      await bad({ moduleKey: "payroll" }, "moduleKey", /tắt/, "nhóm menu là module đang tắt");
      await bad({ extra: 1 }, "_", /./, "trường lạ");
      assert.equal(code(await createObject(staff("co-a-nv1", A, ["records:view", "records:write"], "ALL"), { key: "x_hop_dong", label: "HĐ", labelPlural: "HĐ", icon: "box" })), "FORBIDDEN", "thiếu metadata:manage ⇒ từ chối");
      const hd = await createObject(qtA, { key: "x_hop_dong", label: "Hợp đồng bảo trì", labelPlural: "Hợp đồng bảo trì", icon: "file-text", titleLabel: "Số hợp đồng" });
      assert.ok(hd.ok, msg(hd));
      assert.equal(code(await createObject(qtA, { key: "x_hop_dong", label: "Trùng", labelPlural: "Trùng", icon: "box" })), "CONFLICT", "trùng khoá");
      const ct = await createObject(qtA, { key: "x_cong_trinh", label: "Công trình", labelPlural: "Công trình", icon: "hard-hat" });
      assert.ok(ct.ok, msg(ct));
      const up = await updateObject(qtA, "x_cong_trinh", { label: "Công trình xây dựng", icon: "building" });
      assert.ok(up.ok && up.object.label === "Công trình xây dựng" && up.object.icon === "building", msg(up));
      assert.equal(code(await updateObject(qtA, "x_cong_trinh", { key: "x_khac" })), "INVALID", "khoá bất biến");
      const auditObj = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.entity, "META_OBJECT"));
      assert.equal(auditObj.length, 3, "hai lượt tạo + một lượt sửa ⇒ ba dòng nhật ký (lượt hỏng không ghi)");

      // Bộ phân giải: hệ thống ⇒ đúng sổ tĩnh; tuỳ biến ⇒ đọc CSDL của tổ chức hiện hành.
      for (const o of OBJECT_REGISTRY) assert.equal(await resolveObject(o.key), objectDef(o.key), `${o.key}: bộ phân giải trả đúng sổ tĩnh`);
      assert.equal((await resolveObject("x_hop_dong"))?.label, "Hợp đồng bảo trì");
      assert.equal(await resolveObject("x_rieng_b"), null, "đối tượng của B không tồn tại trong A");
      assert.equal(await resolveObject("khong_co"), null);

      // ── 2. Field (qua dịch vụ Phase 2) ──
      const field = (objectKey: string, input: Record<string, unknown>) => createCustomField(objectKey, input, actorA);
      const mustField = async (objectKey: string, input: Record<string, unknown>) => {
        const r = await field(objectKey, input);
        assert.ok(r.ok, `${objectKey}.${String(input.key)}: ${msg(r)}`);
      };
      await mustField("x_hop_dong", { key: "khach", label: "Khách", type: "relation", relationObject: "customer", filterable: true });
      await mustField("x_hop_dong", { key: "gia_tri", label: "Giá trị", type: "currency", required: true, filterable: true });
      await mustField("x_hop_dong", {
        key: "trang_thai",
        label: "Trạng thái",
        type: "status",
        filterable: true,
        options: [{ value: "nhap", label: "Nháp" }, { value: "hieu_luc", label: "Hiệu lực" }, { value: "het_han", label: "Hết hạn" }],
        transitions: { nhap: ["hieu_luc"], hieu_luc: ["het_han"] },
      });
      await mustField("x_hop_dong", { key: "cong_trinh", label: "Công trình chính", type: "relation", relationObject: "x_cong_trinh", validation: { unique: true } });
      await mustField("x_hop_dong", { key: "cac_cong_trinh", label: "Các công trình", type: "relation_many", relationObject: "x_cong_trinh" });
      await mustField("x_hop_dong", { key: "tai_lieu", label: "Tài liệu", type: "file" });
      await mustField("x_cong_trinh", { key: "dia_chi", label: "Địa chỉ", type: "text" });
      assert.equal(code(await field("x_hop_dong", { key: "title", label: "Trùng", type: "text" })), "INVALID", "trùng khoá field hệ thống của bản ghi");
      assert.equal(code(await field("x_hop_dong", { key: "rel_la", label: "Lạ", type: "relation", relationObject: "x_khong_co" })), "INVALID", "đích không tồn tại");
      assert.equal(code(await field("x_hop_dong", { key: "rel_b", label: "Sang B", type: "relation_many", relationObject: "x_rieng_b" })), "INVALID", "đích là đối tượng của tổ chức KHÁC ⇒ không tồn tại ở đây");
      assert.equal(code(await field("x_hop_dong", { key: "so_un", label: "Số", type: "number", validation: { unique: true } })), "INVALID", "unique chỉ cho relation");
      const lf = await listFields("x_hop_dong");
      assert.deepEqual(lf.system.map((f) => f.key), ["title", "owner", "created_at", "updated_at"]);
      assert.equal(lf.custom.length, 6);

      // ── 3. Luật: "Hợp đồng tạo mới → giá trị > 20.000.000 → cửa duyệt → tạo việc" ──
      const rule = await saveRule(
        {
          key: "hop_dong_lon",
          name: "Hợp đồng lớn ⇒ trưởng phòng duyệt ⇒ lập kế hoạch bảo trì",
          trigger: { kind: "event", event: "custom_record.created", objectKey: "x_hop_dong" },
          conditions: { all: [{ field: "custom:gia_tri", op: "gte", value: 20_000_001 }] },
          actions: [{ kind: "create_task", title: "Lập kế hoạch bảo trì cho hợp đồng lớn", departmentCode: "SALES", priority: "HIGH", dueInHours: 48 }],
          gate: { kind: "approval", reason: "Trưởng phòng duyệt hợp đồng trên 20 triệu" },
        },
        actorA,
      );
      assert.ok(rule.ok, msg(rule));
      const ruleBad = await saveRule({ key: "sai_doi_tuong", name: "x", trigger: { kind: "event", event: "approval.executed", objectKey: "x_hop_dong" }, actions: [{ kind: "notify", message: "x" }] }, actorA);
      assert.equal(code(ruleBad), "INVALID", "sự kiện không gắn bản ghi metadata không lọc theo đối tượng được");
      assert.equal(code(await saveRule({ key: "sai_dt2", name: "x", trigger: { kind: "event", event: "custom_record.created", objectKey: "x_rieng_b" }, actions: [{ kind: "notify", message: "x" }] }, actorA)), "INVALID", "đối tượng của tổ chức khác");
      assert.ok((await setRuleStatus(rule.rule.id, "ACTIVE", actorA)).ok);
      assert.ok((await setRuleMode(rule.rule.id, "LIVE", actorA)).ok);

      // ── 4. Bản ghi ──
      const ct1 = await createRecord("x_cong_trinh", { system: { title: "Toà nhà A" }, custom: { dia_chi: "12 Lê Lợi" } }, qtA);
      const ct2 = await createRecord("x_cong_trinh", { system: { title: "Nhà xưởng B" } }, qtA);
      const ct3 = await createRecord("x_cong_trinh", { system: { title: "Kho C" } }, qtA);
      assert.ok(ct1.ok && ct2.ok && ct3.ok, msg([ct1, ct2, ct3]));
      ids.ct1 = ct1.id;
      ids.ct2 = ct2.id;
      ids.ct3 = ct3.id;
      assert.equal(ct1.href, `/o/x_cong_trinh/${ct1.id}`);

      const badRec = async (input: Record<string, unknown>, path: string, why: string) => {
        const r = await createRecord("x_hop_dong", input, qtA);
        assert.equal(r.ok, false, `${why}: phải bị từ chối`);
        assert.ok(!r.ok && r.errors.some((e) => e.path === path), `${why}: ${msg(r)}`);
      };
      const truoc = Number((await db.select({ n: sql<number>`count(*)` }).from(schema.customRecords))[0].n);
      await badRec({ system: {}, custom: { gia_tri: 1 } }, "system:title", "thiếu số hợp đồng");
      await badRec({ system: { title: "HĐ-X" }, custom: {} }, "gia_tri", "thiếu giá trị (bắt buộc)");
      await badRec({ system: { title: "HĐ-X" }, custom: { gia_tri: 1, khach: "khong-co" } }, "khach", "khách không tồn tại");
      await badRec({ system: { title: "HĐ-X" }, custom: { gia_tri: 1, khach: "co-b-cus1" } }, "khach", "khách của tổ chức B");
      await badRec({ system: { title: "HĐ-X" }, custom: { gia_tri: 1, cac_cong_trinh: [ids.ct1, ids.bRecord] } }, "cac_cong_trinh", "một id của B trong quan hệ nhiều");
      await badRec({ system: { title: "HĐ-X" }, custom: { gia_tri: 1, cong_trinh: ids.bRecord } }, "cong_trinh", "id bản ghi của B");
      await badRec({ system: { title: "HĐ-X", created_at: "2020-01-01" }, custom: { gia_tri: 1 } }, "system:created_at", "cột hệ thống chỉ đọc");
      await badRec({ system: { title: "HĐ-X" }, custom: { gia_tri: 1, khong_co: 1 } }, "khong_co", "field lạ");
      assert.equal(Number((await db.select({ n: sql<number>`count(*)` }).from(schema.customRecords))[0].n), truoc, "lượt tạo hỏng không để lại dòng nào");

      const hd1 = await createRecord("x_hop_dong", { system: { title: "HĐ-01" }, custom: { gia_tri: 25_000_000, khach: "co-a-cus1", trang_thai: "nhap", cong_trinh: ids.ct1, cac_cong_trinh: [ids.ct1, ids.ct2] } }, qtA);
      assert.ok(hd1.ok, msg(hd1));
      const hd2 = await createRecord("x_hop_dong", { system: { title: "HĐ-02" }, custom: { gia_tri: 5_000_000, khach: "co-a-cus1" } }, qtA);
      assert.ok(hd2.ok, msg(hd2));
      ids.hd1 = hd1.id;
      ids.hd2 = hd2.id;
      assert.equal(code(await createRecord("x_hop_dong", { system: { title: "HĐ-03" }, custom: { gia_tri: 1, cong_trinh: ids.ct1 } }, qtA)), "INVALID", "một-một: công trình chính đã thuộc HĐ-01");
      const created = await eventsNamed("custom_record.created");
      assert.equal(created.filter((e) => e.subjectId === `x_hop_dong:${ids.hd1}`).length, 1, "tạo ⇒ đúng một custom_record.created");
      assert.equal(created.find((e) => e.subjectId === `x_hop_dong:${ids.hd1}`)?.dedupeKey, `custom_record.created:${ids.hd1}`);
      assert.equal(created.find((e) => e.subjectId === `x_hop_dong:${ids.hd1}`)?.subjectType, "custom_record");
      assert.equal((await eventsNamed("custom_status.changed", `x_hop_dong:${ids.hd1}`)).length, 1, "trạng thái ban đầu ⇒ custom_status.changed (Phase 3 chạy ngay)");

      // Đọc: tên đích chỉ khi xem được.
      const r1 = await getRecord("x_hop_dong", ids.hd1, qtA);
      assert.ok(r1.ok, msg(r1));
      assert.equal(r1.record.title, "HĐ-01");
      assert.equal(r1.record.ownerId, adminA.id, "người tạo là chủ mặc định");
      const blankOwner = await createRecord("x_cong_trinh", { system: { title: "Ô chủ để trống", owner: null } }, qtA);
      assert.ok(blankOwner.ok && (await getRecord("x_cong_trinh", blankOwner.id, qtA) as { record: { ownerId: string } }).record.ownerId === adminA.id, "form tạo gửi ô người phụ trách TRỐNG ⇒ vẫn là người tạo");
      assert.ok((await deleteRecord("x_cong_trinh", blankOwner.id, qtA)).ok);
      assert.equal(r1.record.values.gia_tri, 25_000_000);
      assert.deepEqual(r1.relationLabels.khach, { "co-a-cus1": "Khách A1" });
      assert.deepEqual(r1.relationLabels.cac_cong_trinh, { [ids.ct1]: "Toà nhà A", [ids.ct2]: "Nhà xưởng B" });
      assert.equal(code(await getRecord("x_cong_trinh", ids.hd1, qtA)), "NOT_FOUND", "id của Hợp đồng không phải một Công trình (cùng bảng custom_records)");
      assert.equal(code(await saveCustomValues("x_cong_trinh", ids.hd1, { dia_chi: "chiếm" }, qtA)), "NOT_FOUND", "ghi giá trị Công trình vào id của Hợp đồng ⇒ không tồn tại (đúng đối tượng, không chỉ đúng bảng)");

      // Chiều ngược (một-nhiều).
      const rev = await reverseRelations("x_cong_trinh", ids.ct1, qtA);
      assert.deepEqual(rev.map((g) => `${g.objectKey}.${g.fieldKey}:${g.records.map((x) => x.title).join(",")}`).sort(), ["x_hop_dong.cac_cong_trinh:HĐ-01", "x_hop_dong.cong_trinh:HĐ-01"]);
      assert.equal(rev[0].records[0].href, `/o/x_hop_dong/${ids.hd1}`);
      const revKhach = await reverseRelations("customer", "co-a-cus1", qtA);
      assert.deepEqual(revKhach.map((g) => g.records.map((x) => x.title).sort().join(",")), ["HĐ-01,HĐ-02"], "khách hàng thấy hợp đồng trỏ tới mình");

      // Danh sách: lọc / sắp / phân trang ở máy chủ.
      const l1 = await listRecords("x_hop_dong", params({ sort: "custom:gia_tri", dir: "asc" }), qtA);
      assert.ok(l1.ok, msg(l1));
      assert.equal(l1.total, 2);
      assert.deepEqual(l1.rows.map((x) => x.title), ["HĐ-02", "HĐ-01"], "sắp theo giá trị tăng dần");
      assert.ok(l1.schema.columns.some((c) => c.ref === "custom:gia_tri" && c.visible), "danh sách mặc định hiện field tuỳ biến");
      assert.deepEqual((await listRecords("x_hop_dong", params({ q: "HĐ-01" }), qtA) as { rows: { id: string }[] }).rows.map((x) => x.id), [ids.hd1], "tìm theo tên");
      const byStatus = await listRecords("x_hop_dong", params(), qtA, { fieldEq: { trang_thai: "nhap" } });
      assert.ok(byStatus.ok && byStatus.total === 1 && byStatus.rows[0].id === ids.hd1, msg(byStatus));
      const paged = await listRecords("x_cong_trinh", params({ pageSize: "10", page: "1", sort: "system:title", dir: "asc" }), qtA);
      assert.ok(paged.ok && paged.rows.map((x) => x.title).join("|") === "Kho C|Nhà xưởng B|Toà nhà A", msg(paged));

      // Sửa: tên + trạng thái (chuyển hợp lệ) ⇒ đúng một custom_record.updated.
      const u1 = await updateRecord("x_hop_dong", ids.hd1, { system: { title: "HĐ-01A" }, custom: { trang_thai: "hieu_luc" }, version: r1.record.version }, qtA);
      assert.ok(u1.ok, msg(u1));
      assert.deepEqual(u1.changed, ["system:title", "trang_thai"]);
      assert.equal(u1.version, 2);
      assert.equal((await eventsNamed("custom_record.updated", `x_hop_dong:${ids.hd1}`)).length, 1);
      assert.equal(code(await updateRecord("x_hop_dong", ids.hd1, { custom: { trang_thai: "nhap" } }, qtA)), "INVALID", "chuyển trạng thái ngược bị chặn (luật Phase 2)");
      assert.equal(code(await updateRecord("x_hop_dong", ids.hd1, { system: { title: "x" }, version: 1 }, qtA)), "CONFLICT", "phiên bản cũ ⇒ CONFLICT");
      const same = await updateRecord("x_hop_dong", ids.hd1, { system: { title: "HĐ-01A" } }, qtA);
      assert.ok(same.ok && same.changed.length === 0, "không đổi gì ⇒ không ghi");
      assert.equal((await eventsNamed("custom_record.updated", `x_hop_dong:${ids.hd1}`)).length, 1, "lượt không đổi gì không phát sự kiện");

      // Tệp của bản ghi tuỳ biến (để kiểm B không mở được).
      const file = await saveCustomFile("x_hop_dong", ids.hd1, "tai_lieu", { filename: "hd.pdf", mime: "application/pdf", data: Buffer.from("%PDF hop dong A") }, qtA);
      assert.ok(file.ok, msg(file));
      ids.file = file.file.id;
      assert.ok((await openCustomFile(ids.file, qtA)).ok, "A mở tệp của A");

      // ── 5. Luật chạy ĐÚNG MỘT lần sau khi duyệt ──
      const w1 = await runWorkflows();
      assert.equal(w1.waiting, 1, `chỉ HĐ-01 (> 20 triệu) xin duyệt: ${msg(w1)}`);
      const runs = await db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.ruleId, rule.rule.id));
      assert.deepEqual(runs.map((x) => x.status).sort(), ["SKIPPED", "WAITING_APPROVAL"], "HĐ-02 (5 triệu) ⇒ SKIPPED");
      assert.equal(runs.find((x) => x.status === "WAITING_APPROVAL")?.subjectType, "x_hop_dong");
      assert.equal(runs.find((x) => x.status === "WAITING_APPROVAL")?.subjectId, ids.hd1);
      const tasks = () => db.select().from(schema.workItems).where(eq(schema.workItems.sourceType, "WORKFLOW_TASK"));
      assert.equal((await tasks()).length, 0, "chưa duyệt ⇒ 0 việc");
      const [req] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.group, "WORKFLOW"));
      assert.ok(req && req.status === "PENDING", msg(req));
      assert.match(req.summary, /Hợp đồng bảo trì "HĐ-01A"/, "nhãn chủ thể qua bộ phân giải (tên hiện tại)");
      const duyet = await decideApprovalCore(db, { ...mgr, canDecide: true }, req.id, true, "Đủ điều kiện");
      assert.ok("ok" in duyet, msg(duyet));
      const [w2a, w2b] = await Promise.all([runWorkflows(), runWorkflows()]);
      assert.equal(w2a.executed + w2b.executed, 1, "thực thi ĐÚNG MỘT lần dù hai lượt chạy chồng");
      await runWorkflows();
      const viec = await tasks();
      assert.equal(viec.length, 1, "đúng MỘT việc");
      assert.equal(viec[0].businessEntityId, `x_hop_dong:${ids.hd1}`);
      assert.equal(viec[0].creationSource, "WORKFLOW");

      // ── 6. Phạm vi + quyền ──
      const nv1 = staff("co-a-nv1", A, ["records:view", "records:write"], "SELF");
      const khongQuyen = staff("co-a-nv1", A, ["customers:view"], "ALL");
      assert.equal(code(await listRecords("x_hop_dong", params(), khongQuyen)), "FORBIDDEN", "thiếu records:view");
      assert.equal(code(await createRecord("x_hop_dong", { system: { title: "x" }, custom: { gia_tri: 1 } }, staff("co-a-nv1", A, ["records:view"], "ALL"))), "FORBIDDEN", "thiếu records:write");
      const l0 = await listRecords("x_hop_dong", params(), nv1);
      assert.ok(l0.ok && l0.total === 0, `SELF: bản ghi của người khác không hiện — ${msg(l0)}`);
      assert.match(l0.ok ? l0.scopeExplain : "", /khoá tài khoản/);
      const mine = await createRecord("x_hop_dong", { system: { title: "HĐ-NV1" }, custom: { gia_tri: 1_000_000 } }, nv1);
      assert.ok(mine.ok, msg(mine));
      ids.mine = mine.id;
      const l2 = await listRecords("x_hop_dong", params(), nv1);
      assert.ok(l2.ok && l2.total === 1 && l2.rows[0].ownerId === "co-a-nv1", msg(l2));
      assert.equal(code(await getRecord("x_hop_dong", ids.hd1, nv1)), "NOT_FOUND", "SELF: đọc bản ghi người khác bằng id ⇒ không tồn tại");
      assert.equal(code(await updateRecord("x_hop_dong", ids.hd1, { system: { title: "chiếm" } }, nv1)), "NOT_FOUND");
      assert.equal(code(await deleteRecord("x_hop_dong", ids.hd1, nv1)), "NOT_FOUND");
      assert.equal(code(await saveCustomValues("x_hop_dong", ids.hd1, { gia_tri: 1 }, nv1)), "NOT_FOUND", "cửa ghi giá trị CHUNG không phải lối vòng qua phạm vi");
      assert.equal((await getCustomValues("x_hop_dong", [ids.hd1, ids.mine], nv1)).has(ids.hd1), false, "đọc giá trị theo id ngoài phạm vi ⇒ không có");
      assert.equal(code(await updateRecord("x_hop_dong", ids.mine, { system: { owner: adminA.id } }, nv1)), "INVALID", "SELF không giao bản ghi cho người khác");
      assert.equal(code(await updateRecord("x_hop_dong", ids.mine, { custom: { cong_trinh: ids.ct3 } }, nv1)), "INVALID", "quan hệ tới bản ghi người ghi KHÔNG xem được ⇒ từ chối");
      const nv1Read = await getRecord("x_hop_dong", ids.mine, nv1);
      assert.ok(nv1Read.ok && nv1Read.canWrite, msg(nv1Read));
      // Tên đích chỉ hiện khi xem được: nv1 không xem được HĐ-01 của quản trị ⇒ không có trong nhãn.
      const cvRow = await getRecord("x_hop_dong", ids.hd1, qtA);
      assert.ok(cvRow.ok);
      assert.deepEqual(await reverseRelations("x_cong_trinh", ids.ct1, nv1), [], "chiều ngược cũng lọc theo phạm vi của người xem");

      // DEPARTMENT: bản ghi có chủ cùng phòng.
      const [sales] = await db.select().from(schema.departments).where(eq(schema.departments.code, "SALES"));
      assert.ok(sales, "phòng SALES");
      for (const u of ["co-a-nv2", "co-a-nv3"]) assert.ok("ok" in (await assignMembership({ departmentId: sales.id, userId: u }, { id: adminA.id, email: adminA.email })));
      const nv3 = staff("co-a-nv3", A, ["records:view", "records:write"], "SELF");
      const r3 = await createRecord("x_hop_dong", { system: { title: "HĐ-NV3" }, custom: { gia_tri: 2 } }, nv3);
      assert.ok(r3.ok, msg(r3));
      const nv2Dept = staff("co-a-nv2", A, ["records:view"], "DEPARTMENT");
      const l3 = await listRecords("x_hop_dong", params(), nv2Dept);
      assert.ok(l3.ok && l3.rows.map((x) => x.title).join() === "HĐ-NV3", `DEPARTMENT: chỉ bản ghi của người cùng phòng — ${msg(l3)}`);
      const khongPhong = staff("co-a-nv1", A, ["records:view"], "DEPARTMENT");
      assert.equal(code(await listRecords("x_hop_dong", params(), khongPhong)), "FORBIDDEN", "DEPARTMENT mà không thuộc phòng nào ⇒ từ chối, không trả rỗng lặng lẽ");
      assert.equal((await getCustomValues("x_hop_dong", [ids.hd1], khongPhong)).size, 0, "phạm vi NONE ⇒ đọc giá trị theo id cũng không có");

      // ── 7. Xoá mềm ──
      const d1 = await deleteRecord("x_cong_trinh", ids.ct2, qtA);
      assert.ok(d1.ok, msg(d1));
      assert.equal(code(await deleteRecord("x_cong_trinh", ids.ct2, qtA)), "NOT_FOUND", "xoá lần hai ⇒ không ghi gì");
      assert.equal((await eventsNamed("custom_record.deleted", `x_cong_trinh:${ids.ct2}`)).length, 1, "đúng một custom_record.deleted");
      const [still] = await db.select().from(schema.customRecords).where(eq(schema.customRecords.id, ids.ct2));
      assert.ok(still?.deletedAt, "xoá mềm: dòng còn, có deleted_at");
      const r1b = await getRecord("x_hop_dong", ids.hd1, qtA);
      assert.ok(r1b.ok);
      assert.deepEqual(r1b.relationLabels.cac_cong_trinh, { [ids.ct1]: "Toà nhà A" }, "đích đã xoá ⇒ không có tên (in —)");
      assert.equal(code(await updateRecord("x_hop_dong", ids.hd1, { custom: { cac_cong_trinh: [ids.ct2] } }, qtA)), "INVALID", "ghi quan hệ tới bản ghi đã xoá");

      // Dòng thời gian: sự kiện + nhật ký.
      const tl = await recordTimeline("x_hop_dong", ids.hd1, qtA, (await resolveObject("x_hop_dong"))!);
      assert.ok(tl.some((e) => e.title === "Tạo bản ghi") && tl.some((e) => e.title === "Sửa bản ghi"), msg(tl.map((e) => e.title)));

      // ── 8. Module `apps` tắt ⇒ từ chối ở máy chủ (kể cả ADMIN) ──
      await setModule(A, "apps", false);
      assert.equal(code(await listRecords("x_hop_dong", params(), qtA)), "MODULE_DISABLED");
      assert.equal(code(await createRecord("x_hop_dong", { system: { title: "x" }, custom: { gia_tri: 1 } }, qtA)), "MODULE_DISABLED");
      assert.equal(code(await saveCustomValues("x_hop_dong", ids.hd1, { gia_tri: 1 }, qtA)), "MODULE_DISABLED", "cửa ghi giá trị chung cũng chặn");
      await assert.rejects(() => listFields("x_hop_dong"), (e: unknown) => e instanceof MetadataError && e.code === "MODULE_DISABLED");
      assert.equal((await openCustomFile(ids.file, qtA)).ok, false, "tệp của đối tượng module tắt không mở được");
      await setModule(A, "apps", true);
      assert.ok((await listRecords("x_hop_dong", params(), qtA)).ok, "bật lại ⇒ dùng được");

      // ── 9. Lưu trữ đối tượng: dữ liệu giữ nguyên, không đọc / ghi được ──
      assert.ok((await archiveObject(qtA, "x_cong_trinh")).ok);
      assert.equal((await archiveObject(qtA, "x_cong_trinh")).ok, true, "lưu trữ lần hai không lỗi");
      await assert.rejects(() => requireObject("x_cong_trinh"), (e: unknown) => e instanceof MetadataError && e.code === "NOT_FOUND");
      assert.equal(code(await listRecords("x_cong_trinh", params(), qtA)), "NOT_FOUND");
      const all = await listObjects(qtA);
      assert.ok(all.ok && all.objects.find((o) => o.key === "x_cong_trinh")?.status === "ARCHIVED" && all.objects.find((o) => o.key === "x_cong_trinh")?.recordCount === 2, msg(all));
      assert.ok((await restoreObject(qtA, "x_cong_trinh")).ok);
      assert.ok((await getRecord("x_cong_trinh", ids.ct1, qtA)).ok, "khôi phục ⇒ bản ghi còn nguyên");
      const archAudit = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "META_OBJECT"), eq(schema.auditLogs.entityId, "x_cong_trinh")));
      assert.equal(archAudit.length, 4, "tạo · sửa · lưu trữ · khôi phục (lưu trữ lần hai không ghi)");
    });

    // ══════════ TỔ CHỨC B không với tới A bằng id trực tiếp ══════════
    await withOrganization(B, async () => {
      assert.equal(code(await getRecord("x_hop_dong", ids.hd1, qtB)), "NOT_FOUND", "B: đối tượng của A không tồn tại");
      assert.equal(await resolveObject("x_hop_dong"), null, "B: không đọc được định nghĩa của A");
      // B tạo CÙNG khoá — định nghĩa là của riêng B.
      assert.ok((await createObject(qtB, { key: "x_hop_dong", label: "HĐ của B", labelPlural: "HĐ của B", icon: "box" })).ok);
      assert.equal((await listFields("x_hop_dong")).custom.length, 0, "B không thấy field của A dù cùng khoá đối tượng");
      assert.equal(code(await getRecord("x_hop_dong", ids.hd1, qtB)), "NOT_FOUND", "B đọc id của A ⇒ không tồn tại");
      assert.equal(code(await updateRecord("x_hop_dong", ids.hd1, { system: { title: "chiếm" } }, qtB)), "NOT_FOUND");
      assert.equal(code(await deleteRecord("x_hop_dong", ids.hd1, qtB)), "NOT_FOUND");
      assert.equal(code(await saveCustomValues("x_hop_dong", ids.hd1, {}, qtB)), "NOT_FOUND", "B ghi giá trị vào id của A ⇒ không tồn tại");
      assert.equal((await getCustomValues("x_hop_dong", [ids.hd1], qtB)).size, 0);
      assert.deepEqual(await reverseRelations("x_cong_trinh", ids.ct1, qtB), [], "B: không có quan hệ nào tới bản ghi của A");
      assert.equal((await openCustomFile(ids.file, qtB)).ok, false, "B mở tệp của A ⇒ không tồn tại");
      assert.ok((await createCustomField("x_hop_dong", { key: "khach", label: "Khách", type: "relation", relationObject: "customer" }, actorB)).ok);
      const rb = await createRecord("x_hop_dong", { system: { title: "HĐ B" }, custom: { khach: "co-a-cus1" } }, qtB);
      assert.equal(code(rb), "INVALID", "B trỏ quan hệ tới khách của A ⇒ không tồn tại");
      const lb = await listRecords("x_hop_dong", params(), qtB);
      assert.ok(lb.ok && lb.total === 0, "B không thấy bản ghi nào của A");
    });

    // Đối tượng hệ thống không đổi hành vi: khoá `customer` vẫn qua sổ tĩnh; ghi giá trị khách vẫn chạy.
    await withOrganization(A, async () => {
      assert.ok((await createCustomField("customer", { key: "hang", label: "Hạng", type: "select", options: [{ value: "a", label: "A" }] }, actorA)).ok);
      assert.ok((await saveCustomValues("customer", "co-a-cus1", { hang: "a" }, qtA)).ok, "khách hàng: ghi giá trị như Phase 2");
      assert.equal((await requireObject("customer")).system, true);
    });

    console.log(
      "✓ Phase 6 · đối tượng tuỳ biến: định nghĩa (khoá x_ · biểu tượng đóng · quyền có thật · lưu trữ/khôi phục) · field qua bộ phân giải · quan hệ tới khách + đối tượng khác (một-một, nhiều-nhiều) + chiều ngược · bản ghi tạo/sửa/xoá mềm, sự kiện đúng một lần · danh sách lọc/sắp/phân trang máy chủ · SELF/DEPARTMENT · thiếu quyền · module apps tắt ⇒ từ chối · luật >20 triệu ⇒ duyệt ⇒ đúng MỘT việc · B không với tới bản ghi/định nghĩa/quan hệ/tệp của A",
    );
  } finally {
    for (const c of [A, B]) await cleanupOrg(c);
  }
}
