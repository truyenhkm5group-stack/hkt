/**
 * NỀN TẢNG · GIAO DIỆN LUẬT TỰ ĐỘNG (Phase 3) — `/settings/workflows` và `/settings/workflows/[id]`.
 *
 * Server action đọc cookie của Next nên không gọi được ngoài request; bài này gọi LÕI của màn hình
 * (`lib/platform-ui/workflow-admin.ts`) với `SessionUser` dựng tay — cùng hàm action gọi, không nhánh riêng
 * cho kiểm thử. Phần thuần (`workflow-admin-shared.ts`) kiểm riêng: bản nháp của form đi một vòng về đúng
 * luật đã lưu, không làm phẳng điều kiện lồng nhau, không biến chữ lạ thành 0.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { visible, type NavUserLike } from "@/components/app-sidebar";
import type { SessionUser } from "@/lib/auth/session";
import { NAV_MODULES } from "@/lib/constants/department-modules";
import { DOMAIN_EVENTS } from "@/lib/constants/domain-events";
import { MODULE_KEYS, moduleOfPath } from "@/lib/constants/platform-modules";
import { createCustomField } from "@/lib/metadata/fields";
import { saveCustomValues } from "@/lib/metadata/values";
import { getEnabledModules, invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import {
  adminPreviewWorkflowRule,
  adminRunWorkflowsNow,
  adminSaveWorkflowRule,
  adminSetWorkflowMode,
  adminSetWorkflowStatus,
  loadWorkflowEditor,
  loadWorkflowList,
  workflowAdminDenial,
} from "@/lib/platform-ui/workflow-admin";
import {
  blankRuleDraft,
  checkRuleDraft,
  CUSTOM_STATUS_EVENT,
  draftToInput,
  liveConsequences,
  MODE_LABEL,
  parseValue,
  ruleToDraft,
  RULE_STATUS_LABEL,
  RUN_STATUS_LABEL,
  runStatusLabel,
  suggestRuleKey,
  triggerSummary,
  workflowEventOptions,
  type WorkflowRuleInput,
} from "@/lib/platform-ui/workflow-admin-shared";
import { buildCatalog } from "@/lib/platform-ui/metadata-admin-shared";
import { objectDef } from "@/lib/constants/object-registry";
import { WORKFLOW_MODES, WORKFLOW_RULE_STATUSES, WORKFLOW_RUN_STATUSES } from "@/lib/workflow/types";

function sessionUser(over: Partial<SessionUser>): SessionUser {
  return { id: "wa-user", email: "wa@local", name: "WA", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null, organization: { code: "nha", name: "Nhà", isHome: true }, modules: [...MODULE_KEYS], ...over };
}

function testMenu() {
  const item = NAV_MODULES.find((m) => m.href === "/settings/workflows");
  assert.ok(item, "sổ menu phải có /settings/workflows");
  assert.equal(item.zone, "SYSTEM", "Luật tự động thuộc vùng Hệ thống");
  assert.equal("permission" in item ? item.permission : null, "workflow:manage");
  assert.equal(moduleOfPath("/settings/workflows"), "core", "màn hình khai luật thuộc lõi — không module nào tắt được nó");
  const manager: NavUserLike = { role: "MANAGER", permissions: ["dashboard:view", "metadata:manage"], modules: [...MODULE_KEYS] };
  assert.equal(visible(item, manager), false, "không có workflow:manage ⇒ không thấy mục menu (kể cả khi có metadata:manage)");
  assert.equal(visible(item, { ...manager, permissions: ["workflow:manage"] }), true);
}

const CUSTOMER_RULE: WorkflowRuleInput = {
  key: "khach_vip_goi_cham_soc",
  name: "Khách lên VIP ⇒ gọi chăm sóc",
  description: "Kiểm chấp nhận Phase 3",
  trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "hang_kh", to: ["vip"], from: ["thuong"] },
  conditions: { all: [{ field: "custom:diem", op: "gte", value: 100 }, { field: "custom:hang_kh", op: "in", value: ["vip", "kim_cuong"] }, { field: "system:phone", op: "not_empty" }] },
  actions: [
    { kind: "create_task", title: "Gọi chăm sóc khách VIP", summary: "Cảm ơn và giới thiệu ưu đãi", departmentCode: "SALES", priority: "HIGH", dueInHours: 24 },
    { kind: "notify", message: "Có khách mới lên VIP" },
    { kind: "set_custom_value", field: "diem", value: 0 },
  ],
  gate: { kind: "approval", reason: "Quản lý duyệt trước khi giao việc" },
};

function testPure() {
  // Nhãn: mọi giá trị của hợp đồng đều có nhãn tiếng Việt, không hai giá trị chung một nhãn.
  for (const [name, labels, keys] of [
    ["trạng thái luật", RULE_STATUS_LABEL, WORKFLOW_RULE_STATUSES],
    ["chế độ", MODE_LABEL, WORKFLOW_MODES],
    ["trạng thái lượt chạy", RUN_STATUS_LABEL, WORKFLOW_RUN_STATUSES],
  ] as const) {
    const values = keys.map((k) => (labels as Record<string, string>)[k]);
    assert.ok(values.every((v) => typeof v === "string" && v.length > 2), `${name}: thiếu nhãn`);
    assert.equal(new Set(values).size, values.length, `${name}: hai giá trị chung một nhãn`);
  }
  assert.match(RUN_STATUS_LABEL.DRY_RUN, /không làm thật/, "lượt chạy thử phải NÓI RA là máy không làm thật");
  assert.notEqual(RUN_STATUS_LABEL.DRY_RUN, RUN_STATUS_LABEL.DONE);

  // Sự kiện chọn được: chỉ tên đang phát; không `workflow.*` (W7), không sự kiện trạng thái custom (khối riêng).
  const events = workflowEventOptions();
  const live = new Set<string>(DOMAIN_EVENTS.filter((e) => e.status === "LIVE").map((e) => e.name));
  assert.ok(events.length > 0);
  for (const e of events) {
    assert.ok(live.has(e.name), `${e.name}: chỉ sự kiện LIVE mới chọn được`);
    assert.ok(!e.name.startsWith("workflow."), "luật không nghe sự kiện của chính workflow");
    assert.notEqual(e.name, CUSTOM_STATUS_EVENT);
  }
  assert.equal(events.find((e) => e.name === "sample.approved")?.label, "Mẫu được duyệt", "sự kiện có nhãn trong sổ ⇒ hiện nhãn tiếng Việt");

  // Vòng một: luật đã lưu ⇒ bản nháp form ⇒ đầu vào lưu = đúng luật cũ (không mất, không đổi kiểu giá trị).
  const customer = objectDef("customer");
  assert.ok(customer);
  const catalog = buildCatalog(customer.fields, [
    { id: "1", objectKey: "customer", key: "hang_kh", label: "Hạng", type: "status", required: false, defaultValue: null, options: [{ value: "thuong", label: "Thường", active: true, position: 0 }, { value: "vip", label: "VIP", active: true, position: 1 }], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: true, position: 0, status: "ACTIVE" },
    { id: "2", objectKey: "customer", key: "diem", label: "Điểm", type: "number", required: false, defaultValue: null, options: [], validation: {}, transitions: {}, relationObject: null, helpText: null, viewPermission: null, editPermission: null, listable: true, filterable: true, position: 1, status: "ACTIVE" },
  ]);
  const draft = ruleToDraft(CUSTOMER_RULE);
  assert.equal(draft.lockedConditions, null, "điều kiện một tầng vẽ lại được");
  assert.deepEqual(draftToInput(draft, catalog), CUSTOMER_RULE, "bản nháp đi một vòng về đúng luật đã lưu");

  // Điều kiện lồng nhau: form một tầng KHÔNG làm phẳng — giữ nguyên khi lưu.
  const nested = { any: [{ all: [{ field: "custom:diem", op: "gte", value: 1 }] }, { field: "system:phone", op: "empty" }] } as const;
  const nestedDraft = ruleToDraft({ ...CUSTOMER_RULE, conditions: nested as unknown as WorkflowRuleInput["conditions"] });
  assert.deepEqual(nestedDraft.lockedConditions, nested);
  assert.deepEqual(draftToInput({ ...nestedDraft, name: "Đổi tên" }, catalog).conditions, nested, "sửa chỗ khác không đổi điều kiện lồng nhau");

  // Giá trị: số chỉ thành số khi field là số VÀ chữ là số — chữ lạ đi nguyên văn cho dịch vụ từ chối.
  assert.equal(parseValue("12", "gte", "number"), 12);
  assert.equal(parseValue("mười", "gte", "number"), "mười", "chữ lạ KHÔNG bị biến thành 0 hay NaN");
  assert.equal(parseValue("12", "eq", "text"), "12", "field chữ giữ chữ");
  assert.deepEqual(parseValue(" a, b ,,c ", "in", "select"), ["a", "b", "c"]);
  assert.equal(parseValue("x", "empty", "text"), undefined, "«đang trống» không mang giá trị");
  assert.equal(parseValue("true", "eq", "boolean"), true);

  // Kiểm sớm: đúng khoá ô để màn hình đặt câu báo dưới đúng chỗ.
  const blank = checkRuleDraft(blankRuleDraft(), { creating: true, takenKeys: new Set() });
  for (const field of ["name", "key", "trigger.event", "actions"]) assert.ok(blank.some((e) => e.field === field), `luật trống ⇒ báo ở ô «${field}»`);
  const gateNoReason = checkRuleDraft({ ...draft, gateReason: "  " }, { creating: false, takenKeys: new Set() });
  assert.deepEqual(gateNoReason.map((e) => e.field), ["gate.reason"], "bật cửa duyệt phải nói lý do");
  assert.ok(checkRuleDraft(draft, { creating: true, takenKeys: new Set([draft.key]) }).some((e) => e.field === "key"), "khoá trùng luật khác");
  assert.deepEqual(checkRuleDraft(draft, { creating: false, takenKeys: new Set([draft.key]) }), [], "sửa luật không kiểm khoá (bất biến)");
  const statusNoTarget = checkRuleDraft({ ...draft, to: [] }, { creating: false, takenKeys: new Set() });
  assert.ok(statusNoTarget.some((e) => e.field === "trigger.to"));
  assert.ok(checkRuleDraft({ ...draft, conditions: [{ field: "custom:diem", op: "gte", value: "" }] }, { creating: false, takenKeys: new Set() }).some((e) => e.field === "conditions.all.0.value"));
  const twoNotify = checkRuleDraft({ ...draft, actions: [...draft.actions, { kind: "notify", message: "lần hai" }] }, { creating: false, takenKeys: new Set() });
  assert.ok(twoNotify.some((e) => e.field === "actions" && /MỘT thông báo/.test(e.message)), "một luật tối đa một thông báo (luật 26)");
  const badHours = checkRuleDraft({ ...draft, actions: [{ kind: "create_task", title: "Gọi", summary: "", departmentCode: "", priority: "NORMAL", dueInHours: "1.5" }] }, { creating: false, takenKeys: new Set() });
  assert.deepEqual(badHours.map((e) => e.field), ["actions.0.dueInHours"], "hạn là số giờ nguyên");
  assert.equal(suggestRuleKey("Khách lên VIP ⇒ gọi chăm sóc"), "khach_len_vip_goi_cham_soc");

  // Hộp xác nhận chạy thật nói đúng những gì luật NÀY sẽ làm.
  const all = liveConsequences(CUSTOMER_RULE.actions, CUSTOMER_RULE.gate);
  assert.equal(all.length, 4);
  assert.ok(all.some((c) => /TẠO VIỆC/.test(c)) && all.some((c) => /GỬI BÁO/.test(c)) && all.some((c) => /GHI GIÁ TRỊ/.test(c)) && all.some((c) => /DUYỆT/.test(c)));
  assert.deepEqual(liveConsequences([{ kind: "notify", message: "x" }], null).length, 1, "không liệt kê việc luật không làm");

  assert.match(triggerSummary(CUSTOMER_RULE.trigger), /Khách hàng · hang_kh thuong → vip/);
  assert.match(triggerSummary({ kind: "event", event: "sample.approved" }), /Mẫu được duyệt/);
}

async function testCoreGates() {
  // Người thiếu `workflow:manage` bị từ chối Ở LÕI — kể cả khi gọi thẳng, bỏ qua trang — và dịch vụ không được gọi.
  const manager = sessionUser({ role: "MANAGER", permissions: ["customers:view", "metadata:manage"] });
  assert.match(workflowAdminDenial(manager) ?? "", /quyền/);
  for (const r of [
    await loadWorkflowList(manager),
    await loadWorkflowEditor(manager, null),
    await adminSaveWorkflowRule(manager, null, CUSTOMER_RULE),
    await adminSetWorkflowStatus(manager, "r1", "ACTIVE"),
    await adminSetWorkflowMode(manager, "r1", "LIVE"),
    await adminPreviewWorkflowRule(manager, "r1", { objectKey: "customer", recordId: "1" }),
    await adminRunWorkflowsNow(manager),
  ]) {
    assert.ok(!r.ok && /quyền/.test(r.errors[0]?.message ?? ""), "thiếu workflow:manage ⇒ từ chối ở lõi");
  }
  assert.match(workflowAdminDenial(sessionUser({ organization: undefined })) ?? "", /tổ chức/, "phiên không mang tổ chức ⇒ từ chối, không rơi về tổ chức nhà");
  const noOrgRun = await adminRunWorkflowsNow(sessionUser({ organization: undefined }));
  assert.ok(!noOrgRun.ok && /tổ chức/.test(noOrgRun.errors[0].message), "nút chạy ngay mà phiên không có tổ chức ⇒ từ chối, không chạy cho tổ chức nhà");
  assert.equal(workflowAdminDenial(sessionUser({ role: "VIEWER", permissions: ["workflow:manage"] })), null, "vai trò bất kỳ có khoá là được");

  // Đầu vào lạ bị chặn trước dịch vụ.
  const admin = sessionUser({});
  assert.ok(!(await adminSetWorkflowStatus(admin, "r1", "DRAFT")).ok, "không đặt NHÁP bằng nút trạng thái — chỉ lưu mới về nháp");
  assert.ok(!(await adminSetWorkflowMode(admin, "r1", "BOGUS")).ok);
  assert.ok(!(await adminSaveWorkflowRule(admin, null, "không phải object")).ok);
  const noRecord = await adminPreviewWorkflowRule(admin, "r1", { objectKey: "customer", recordId: " " });
  assert.ok(!noRecord.ok && noRecord.errors[0].field === "preview.recordId");
}

const ORG = "wa-wf";

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
 * Vòng đời THẬT qua lõi màn hình trên CSDL của một tổ chức riêng (`wa-wf`, tự cấp và tự dọn): lưu luật ⇒ NHÁP +
 * CHẠY THỬ; chuyển CHẠY THẬT khi chưa bật ⇒ từ chối; bật ⇒ ĐANG BẬT; «chạy lượt kiểm tra ngay» chỉ chạy cho tổ chức người
 * bấm; rồi mới chạy thật được; lưu lại ⇒ về NHÁP.
 */
async function testLifecycleDb() {
  await cleanupOrg(ORG);
  rmSync(organizationDatabaseUrl({ code: ORG, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: ORG, name: "Tổ chức thử luật tự động", modules: ["customers"], admin: { email: `admin@${ORG}.local`, name: "QT WF", password: "Wf@123456" }, source: "TEST", actor: null });
  try {
    const { admin, id } = await withOrganization(ORG, async () => {
      const db = await getDb();
      const row = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${ORG}.local`) });
      assert.ok(row);
      const modules = [...(await getEnabledModules(ORG))];
      const admin = sessionUser({ id: row.id, email: row.email, organization: { code: ORG, name: "WF", isHome: false }, modules });
      const actor = { id: row.id, email: row.email, isAdmin: true };
      assert.ok((await createCustomField("customer", { key: "hang_kh", label: "Hạng", type: "status", options: [{ value: "thuong", label: "Thường", active: true, position: 0 }, { value: "vip", label: "VIP", active: true, position: 1 }] }, actor)).ok);
      assert.ok((await createCustomField("customer", { key: "diem", label: "Điểm", type: "number" }, actor)).ok);
      // Hai khách: một khớp điều kiện (điểm 150), một không (điểm 5). Ghi TRƯỚC khi bật — lượt đầu không xử lý lịch sử.
      await db.insert(schema.customers).values([
        { id: "wa-cus1", name: "Khách khớp", phone: "0900000001" },
        { id: "wa-cus2", name: "Khách không khớp", phone: "0900000002" },
      ]);
      assert.ok((await saveCustomValues("customer", "wa-cus1", { hang_kh: "thuong", diem: 150 }, admin)).ok);
      assert.ok((await saveCustomValues("customer", "wa-cus2", { hang_kh: "thuong", diem: 5 }, admin)).ok);

      // Form thấy field trạng thái custom của khách làm nguồn trigger.
      const blankView = await loadWorkflowEditor(admin, null);
      assert.ok(blankView.ok);
      assert.deepEqual(blankView.value.objects.find((o) => o.key === "customer")?.statusFields.map((f) => f.key), ["hang_kh"]);

      const saved = await adminSaveWorkflowRule(admin, null, CUSTOMER_RULE);
      assert.ok(saved.ok, `lưu luật hợp lệ: ${saved.ok ? "" : JSON.stringify(saved.errors)}`);
      const id = saved.id;
      const view = await loadWorkflowEditor(admin, id);
      assert.ok(view.ok && view.value.rule);
      assert.equal(view.value.rule.status, "DRAFT", "luật mới sinh ra ở NHÁP");
      assert.equal(view.value.rule.mode, "DRY_RUN", "luật mới sinh ra ở CHẠY THỬ");
      assert.deepEqual(ruleToDraft(view.value.rule), ruleToDraft(CUSTOMER_RULE), "luật đọc lại vẽ ra đúng form đã gửi");

      const dup = await adminSaveWorkflowRule(admin, null, CUSTOMER_RULE);
      assert.ok(!dup.ok && dup.errors.some((e) => e.field === "key"), "trùng khoá ⇒ lỗi của dịch vụ về tới đúng ô «key»");
      const badTarget = await adminSaveWorkflowRule(admin, null, { ...CUSTOMER_RULE, key: "sai_dich", trigger: { ...CUSTOMER_RULE.trigger, to: ["khong_co"] } });
      assert.ok(!badTarget.ok && badTarget.errors.some((e) => e.field === "trigger.to"), "giá trị đích lạ ⇒ lỗi gắn ô «trigger.to»");

      // Chạy thử trên một bản ghi: dịch vụ thật, không ghi gì.
      const notYet = await adminPreviewWorkflowRule(admin, id, { objectKey: "customer", recordId: "wa-cus1" });
      assert.ok(notYet.ok && !notYet.matched && notYet.wouldDo.length === 0, "khách còn hạng «Thường» ⇒ chạy thử không khớp");
      const miss = await adminPreviewWorkflowRule(admin, id, { objectKey: "customer", recordId: "khong-co" });
      assert.ok(miss.ok && !miss.matched && /không tồn tại/.test(miss.reason ?? ""), "bản ghi lạ ⇒ không khớp, nói rõ vì sao");
      assert.equal((await db.select().from(schema.workflowRuns)).length, 0, "chạy thử không ghi lượt chạy");

      const earlyLive = await adminSetWorkflowMode(admin, id, "LIVE");
      assert.ok(!earlyLive.ok && /ĐANG BẬT/.test(earlyLive.errors[0].message), "chuyển CHẠY THẬT khi chưa bật ⇒ từ chối");
      assert.equal(await getRuleMode(id), "DRY_RUN", "lượt bị từ chối không đổi gì");

      assert.deepEqual(await adminSetWorkflowStatus(admin, id, "ACTIVE"), { ok: true, id });
      const on = await loadWorkflowEditor(admin, id);
      assert.ok(on.ok && on.value.rule?.status === "ACTIVE", "bật ⇒ ĐANG BẬT");

      // Sự kiện MỚI sau khi bật: hai khách lên VIP.
      assert.ok((await saveCustomValues("customer", "wa-cus1", { hang_kh: "vip" }, admin)).ok);
      assert.ok((await saveCustomValues("customer", "wa-cus2", { hang_kh: "vip" }, admin)).ok);
      const hit = await adminPreviewWorkflowRule(admin, id, { objectKey: "customer", recordId: "wa-cus1" });
      assert.ok(hit.ok && hit.matched, `khách lên VIP, điểm 150 ⇒ chạy thử khớp: ${JSON.stringify(hit)}`);
      assert.deepEqual(hit.wouldDo.map((w) => w.action), CUSTOMER_RULE.actions.map((x) => x.kind), "chạy thử liệt kê đúng việc SẼ làm, đúng thứ tự");
      return { admin, id };
    });

    // ── «Chạy lượt kiểm tra ngay»: gọi từ ngữ cảnh NHÀ — lõi phải tự chạy cho tổ chức trong PHIÊN người bấm ──
    const homeDb = await getDb();
    const homeRunsBefore = (await homeDb.select().from(schema.workflowRuns)).length;
    const now = await adminRunWorkflowsNow(admin);
    assert.ok(now.ok, JSON.stringify(now));
    assert.equal(now.events, 2, "lượt chạy ngay đọc đúng hai sự kiện mới của tổ chức người bấm");
    assert.equal(now.runs, 2, "mỗi (luật, sự kiện) một lượt chạy");
    assert.equal(now.failed, 0);
    assert.equal((await homeDb.select().from(schema.workflowRuns)).length, homeRunsBefore, "tổ chức nhà KHÔNG có lượt chạy nào từ nút của tổ chức khác");
    const again = await adminRunWorkflowsNow(admin);
    assert.ok(again.ok && again.events === 0 && again.runs === 0, "bấm lại không làm lại (con trỏ chỉ tiến)");
    const viewerNoKey = sessionUser({ ...admin, role: "VIEWER", permissions: ["customers:view"] });
    assert.ok(!(await adminRunWorkflowsNow(viewerNoKey)).ok, "thiếu workflow:manage ⇒ nút chạy ngay bị lõi từ chối");

    await withOrganization(ORG, async () => {
      const view = await loadWorkflowEditor(admin, id);
      assert.ok(view.ok);
      const hitRun = view.value.runs.find((r) => r.subjectId?.includes("wa-cus1"));
      const missRun = view.value.runs.find((r) => r.subjectId?.includes("wa-cus2"));
      assert.equal(hitRun?.status, "DRY_RUN", "khách khớp ⇒ lượt CHẠY THỬ");
      assert.equal(hitRun?.steps.length, CUSTOMER_RULE.actions.length, "lượt chạy thử ghi đủ bước SẼ làm");
      assert.ok(missRun);
      assert.equal(missRun.status, "SKIPPED");
      assert.equal(runStatusLabel(missRun.status, missRun.error), "Bỏ qua — không khớp điều kiện", "không khớp điều kiện có nhãn riêng");
      const tasks = await (await getDb()).select().from(schema.workItems);
      assert.equal(tasks.filter((w) => w.creationSource === "WORKFLOW").length, 0, "CHẠY THỬ không tạo việc thật");

      assert.ok((await adminSetWorkflowMode(admin, id, "LIVE")).ok, "đang bật ⇒ chuyển chạy thật được");
      const viewer = sessionUser({ ...admin, role: "VIEWER", permissions: ["customers:view"] });
      assert.ok(!(await adminSetWorkflowStatus(viewer, id, "PAUSED")).ok, "thiếu quyền ⇒ lõi chặn trước dịch vụ");

      const resaved = await adminSaveWorkflowRule(admin, id, { ...CUSTOMER_RULE, name: "Khách VIP ⇒ gọi (sửa)" });
      assert.ok(resaved.ok, `sửa luật: ${resaved.ok ? "" : JSON.stringify(resaved.errors)}`);
      const after = await loadWorkflowEditor(admin, id);
      assert.ok(after.ok && after.value.rule);
      assert.equal(after.value.rule.status, "DRAFT", "lưu luôn đưa luật về NHÁP");
      assert.equal(after.value.rule.mode, "DRY_RUN", "lưu luôn đưa luật về CHẠY THỬ");
      assert.ok(after.value.rule.version > 1, "lưu tăng phiên bản");

      const list = await loadWorkflowList(admin);
      assert.ok(list.ok && list.value.some((r) => r.id === id));
    });
  } finally {
    await cleanupOrg(ORG);
  }
}

async function getRuleMode(id: string) {
  const rows = await (await getDb()).select({ mode: schema.workflowRules.mode }).from(schema.workflowRules).where(eq(schema.workflowRules.id, id));
  return rows[0]?.mode;
}

export async function testWorkflowAdmin() {
  testMenu();
  testPure();
  await testCoreGates();
  await testLifecycleDb();
  console.log("✓ Nền tảng · luật tự động (giao diện): menu gác bằng workflow:manage, lõi từ chối người thiếu quyền trước dịch vụ, bản nháp form đi một vòng về đúng luật (không làm phẳng điều kiện lồng nhau, chữ lạ không thành 0); vòng đời thật: lưu ⇒ NHÁP + CHẠY THỬ, chạy thử một bản ghi không ghi gì, chạy thật khi chưa bật ⇒ từ chối, bật ⇒ ĐANG BẬT; «chạy lượt kiểm tra ngay» chỉ chạy cho tổ chức người bấm (2 sự kiện ⇒ 1 chạy thử + 1 không khớp, bấm lại 0), chạy thật, lưu lại ⇒ về NHÁP + CHẠY THỬ");
}
