/**
 * PHASE 3 · BỘ MÁY WORKFLOW (docs/platform/phase-3-contracts.md mục 3–4, phase-3-plan.md mục 4).
 *
 * Hai phần:
 *  · THUẦN: `evaluateCondition` (so sánh an toàn kiểu, ref lạ ⇒ false, độ sâu ≤ 5, không ném), `triggerMatches`.
 *  · HAI TỔ CHỨC THẬT (`pw-a`, `pw-b` — hai CSDL PGlite riêng, `provisionOrganization`, tự dọn): lưu luật từ chối
 *    trigger / field / sự kiện lạ và vòng lặp trực tiếp; luật mới là NHÁP + CHẠY THỬ; KỊCH BẢN CHẤP NHẬN — khách
 *    lên `vip` ⇒ cần duyệt ⇒ tạo việc: chạy thử 0 việc; chạy thật ⇒ yêu cầu duyệt PENDING + lượt WAITING_APPROVAL
 *    + 0 việc; người KHÁC duyệt ⇒ đúng MỘT việc; chạy lại vẫn một việc; từ chối ⇒ REJECTED; vòng lặp gián tiếp bị
 *    chặn ở độ sâu nhân quả; lượt đầu không xử lý sự kiện cũ; B không thấy luật / lượt chạy / việc của A.
 */
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { decideApprovalCore } from "@/lib/approvals/service";
import type { SessionUser } from "@/lib/auth/session";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { saveCustomValues } from "@/lib/metadata/values";
import { adaptApprovals, adaptOwnedWork } from "@/lib/queries/work-adapters";
import { readEventCursor } from "@/lib/workflow/cursor";
import { listRuns, previewRule, runWorkflows, triggerMatches } from "@/lib/workflow/engine";
import { evaluateCondition, WORKFLOW_CONDITION_MAX_DEPTH } from "@/lib/workflow/evaluate";
import { getRule, listRules, saveRule, setRuleMode, setRuleStatus, type WorkflowFailure } from "@/lib/workflow/rules";
import type { WorkflowCondition, WorkflowRule } from "@/lib/workflow/types";

const A = "pw-a";
const B = "pw-b";

// ─────────────────────────── Phần thuần ───────────────────────────

function testEvaluatePure() {
  const s: Record<string, unknown> = {
    "custom:n": 10,
    "custom:ns": "10",
    "custom:tags": ["a", "b"],
    "custom:stage": "vip",
    "custom:empty": null,
    "custom:blank": "  ",
    "system:name": "Nguyễn Văn Á",
    "system:last_order_at": new Date("2026-09-27T07:30:00.000Z"),
    "system:payload.to": "vip",
  };
  const ev = (c: unknown) => evaluateCondition(c as WorkflowCondition, s);
  assert.equal(evaluateCondition(null, s), true, "không điều kiện ⇒ khớp");
  assert.equal(ev({ field: "custom:n", op: "eq", value: 10 }), true);
  assert.equal(ev({ field: "custom:ns", op: "eq", value: 10 }), false, "chuỗi \"10\" KHÔNG bằng số 10 — không ép kiểu ngầm");
  assert.equal(ev({ field: "custom:n", op: "eq", value: "10" }), false, "số 10 KHÔNG bằng chuỗi \"10\"");
  assert.equal(ev({ field: "custom:tags", op: "eq", value: "b" }), true, "chọn nhiều: eq = có chứa");
  assert.equal(ev({ field: "custom:empty", op: "neq", value: "x" }), true, "chưa biết ≠ bằng");
  assert.equal(ev({ field: "custom:empty", op: "eq", value: "x" }), false);
  assert.equal(ev({ field: "custom:stage", op: "in", value: ["lead", "vip"] }), true);
  assert.equal(ev({ field: "custom:stage", op: "in", value: "vip" }), false, "in cần danh sách");
  assert.equal(ev({ field: "system:name", op: "contains", value: "văn á" }), true, "contains không phân biệt hoa thường");
  assert.equal(ev({ field: "custom:n", op: "gte", value: 10 }), true);
  assert.equal(ev({ field: "custom:n", op: "lte", value: 9 }), false);
  assert.equal(ev({ field: "custom:ns", op: "gte", value: 5 }), false, "khác kiểu ⇒ không so được ⇒ không khớp");
  assert.equal(ev({ field: "custom:empty", op: "gte", value: 0 }), false, "chưa biết không lớn hơn 0");
  assert.equal(ev({ field: "system:last_order_at", op: "gte", value: "2026-09-27" }), true, "ngày ISO so theo mốc");
  assert.equal(ev({ field: "system:last_order_at", op: "lte", value: "2026-09-27T07:29:59Z" }), false);
  assert.equal(ev({ field: "system:last_order_at", op: "eq", value: "2026-09-27T14:30:00+07:00" }), true, "hai cách viết cùng thời điểm là bằng");
  assert.equal(ev({ field: "custom:empty", op: "empty" }), true);
  assert.equal(ev({ field: "custom:blank", op: "empty" }), true, "chuỗi trắng là rỗng");
  assert.equal(ev({ field: "custom:tags", op: "not_empty" }), true);
  assert.equal(ev({ field: "custom:khong_co", op: "empty" }), false, "ref lạ ⇒ false kể cả với empty");
  assert.equal(ev({ field: "custom:khong_co", op: "neq", value: "x" }), false, "ref lạ ⇒ false kể cả với neq");
  assert.equal(ev({ field: "orders.total", op: "eq", value: 1 }), false, "ref không có tiền tố system:/custom: ⇒ false");
  assert.equal(ev({ field: "custom:n", op: "regex", value: ".*" }), false, "phép lạ ⇒ false");
  assert.equal(ev({ all: [] }), true);
  assert.equal(ev({ any: [] }), false);
  assert.equal(ev({ all: [{ field: "custom:n", op: "eq", value: 10 }, { any: [{ field: "custom:stage", op: "eq", value: "lost" }, { field: "system:payload.to", op: "eq", value: "vip" }] }] }), true);
  assert.equal(ev({ foo: 1 }), false, "cây sai hình ⇒ false, không ném");
  assert.equal(ev("chuỗi"), false);
  assert.equal(ev({ all: "x" }), false);
  const sau = (n: number): unknown => (n <= 1 ? { field: "custom:n", op: "eq", value: 10 } : { all: [sau(n - 1)] });
  assert.equal(ev(sau(WORKFLOW_CONDITION_MAX_DEPTH)), true, `độ sâu ${WORKFLOW_CONDITION_MAX_DEPTH} vẫn chạy`);
  assert.equal(ev(sau(WORKFLOW_CONDITION_MAX_DEPTH + 1)), false, "sâu hơn trần ⇒ không khớp");

  const t = { kind: "custom_status" as const, objectKey: "customer", fieldKey: "customer_stage", to: ["vip"] };
  const e = (payload: Record<string, unknown>, name = "custom_status.changed") => triggerMatches(t, { name, payload });
  assert.equal(e({ objectKey: "customer", fieldKey: "customer_stage", from: "lead", to: "vip" }), true);
  assert.equal(e({ objectKey: "customer", fieldKey: "customer_stage", from: "vip", to: "lead" }), false, "chỉ khớp trạng thái ĐÍCH");
  assert.equal(e({ objectKey: "customer", fieldKey: "khac", to: "vip" }), false);
  assert.equal(e({ objectKey: "order", fieldKey: "customer_stage", to: "vip" }), false);
  assert.equal(e({ objectKey: "customer", fieldKey: "customer_stage", to: "vip" }, "model.linked"), false);
  assert.equal(triggerMatches({ ...t, from: ["lead"] }, { name: "custom_status.changed", payload: { objectKey: "customer", fieldKey: "customer_stage", from: null, to: "vip" } }), false, "from khai thì from chưa biết không khớp");
  assert.equal(triggerMatches({ kind: "event", event: "sample.approved" }, { name: "sample.approved", payload: {} }), true);
  console.log("✓ Workflow · điều kiện thuần: so sánh cùng kiểu (không ép ngầm), ngày ISO theo mốc, chưa biết không so được, ref lạ ⇒ false, cây sâu > 5 ⇒ false, không ném · trigger khớp đúng đối tượng/field/trạng thái đích");
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

function sessionOf(u: { id: string; email: string }): SessionUser {
  return { id: u.id, email: u.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
}

async function adminOf(org: string) {
  return withOrganization(org, async () => {
    const db = await getDb();
    const u = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${org}.local`) });
    assert.ok(u, `quản trị của ${org}`);
    return { id: u.id, email: u.email };
  });
}

function expectFail(r: { ok: boolean }, field: string, re: RegExp, msg: string) {
  assert.equal(r.ok, false, `${msg}: phải bị từ chối`);
  const errs = (r as WorkflowFailure).errors;
  assert.ok(
    errs.some((e) => e.field.startsWith(field) && re.test(e.message)),
    `${msg}: mong lỗi ở "${field}" khớp ${re}, nhận ${JSON.stringify(errs)}`,
  );
}

async function count(table: "workflowRuns" | "workTasks" | "workflowApprovals" | "workflowNotifications"): Promise<number> {
  const db = await getDb();
  if (table === "workflowRuns") return Number((await db.select({ n: sql<number>`count(*)` }).from(schema.workflowRuns))[0].n);
  if (table === "workTasks") return Number((await db.select({ n: sql<number>`count(*)` }).from(schema.workItems).where(eq(schema.workItems.sourceType, "WORKFLOW_TASK")))[0].n);
  if (table === "workflowApprovals") return Number((await db.select({ n: sql<number>`count(*)` }).from(schema.approvalRequests).where(eq(schema.approvalRequests.group, "WORKFLOW")))[0].n);
  return Number((await db.select({ n: sql<number>`count(*)` }).from(schema.notifications).where(sql`${schema.notifications.dedupeKey} like 'workflow:%'`))[0].n);
}

const VIP_RULE = {
  key: "vip_call",
  name: "Khách lên VIP ⇒ gọi chăm sóc",
  trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "customer_stage", to: ["vip"] },
  conditions: { all: [{ field: "system:name", op: "not_empty" }] },
  actions: [
    { kind: "create_task", title: "Gọi chăm sóc khách VIP", departmentCode: "SALES", priority: "HIGH", dueInHours: 24 },
    { kind: "notify", message: "Có khách mới lên VIP" },
  ],
  gate: { kind: "approval", reason: "Quản lý xác nhận khách đủ điều kiện VIP" },
};

async function activateLive(id: string, actor: MetadataActor): Promise<WorkflowRule> {
  const on = await setRuleStatus(id, "ACTIVE", actor);
  assert.ok(on.ok, JSON.stringify(on));
  const live = await setRuleMode(id, "LIVE", actor);
  assert.ok(live.ok, JSON.stringify(live));
  return live.rule;
}

export async function testWorkflowEngine() {
  testEvaluatePure();

  for (const code of [A, B]) {
    await cleanupOrg(code);
    rmSync(organizationDatabaseUrl({ code, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
    await provisionOrganization({ code, name: `Tổ chức ${code}`, modules: ["customers"], admin: { email: `admin@${code}.local`, name: `QT ${code}`, password: "Flow@12345" }, source: "TEST", actor: null });
  }
  try {
    const adminA = await adminOf(A);
    const adminB = await adminOf(B);
    const actorA: MetadataActor = { id: adminA.id, email: adminA.email };
    const actorB: MetadataActor = { id: adminB.id, email: adminB.email };
    const viewerA = sessionOf(adminA);
    const viewerB = sessionOf(adminB);
    const managerA = { id: "pw-a-mgr", email: "mgr@pw-a.local" };
    let vipRuleId = "";

    await withOrganization(A, async () => {
      const db = await getDb();
      await db.insert(schema.users).values({ id: managerA.id, email: managerA.email, name: "Quản lý A", passwordHash: "x", role: "MANAGER", active: true });
      await db.insert(schema.customers).values([
        { id: "pw-a-cus1", name: "Khách A1" },
        { id: "pw-a-cus2", name: "Khách A2" },
        { id: "pw-a-cus3", name: "Khách A3" },
      ]);
      for (const input of [
        { key: "customer_stage", label: "Giai đoạn khách", type: "status", options: [{ value: "lead", label: "Tiềm năng" }, { value: "vip", label: "VIP" }, { value: "lost", label: "Mất" }] },
        { key: "note_x", label: "Ghi chú", type: "text" },
        { key: "ping", label: "Ping", type: "status", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
        { key: "pong", label: "Pong", type: "status", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
      ]) {
        const f = await createCustomField("customer", input, actorA);
        assert.ok(f.ok, `${input.key}: ${JSON.stringify(f)}`);
      }

      // Sự kiện CŨ — xảy ra trước khi tổ chức bật luật nào: không bao giờ được xử lý.
      const cu = await saveCustomValues("customer", "pw-a-cus3", { customer_stage: "vip" }, viewerA);
      assert.ok(cu.ok, JSON.stringify(cu));
      const ev = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.name, "custom_status.changed"));
      assert.equal(ev.length, 1, "đổi field trạng thái ⇒ đúng một sự kiện custom_status.changed");
      assert.equal(ev[0].subjectType, "custom_record");
      assert.equal(ev[0].subjectId, "customer:pw-a-cus3");
      assert.deepEqual(ev[0].payload, { objectKey: "customer", recordId: "pw-a-cus3", fieldKey: "customer_stage", from: null, to: "vip" });
      assert.equal(ev[0].actorKind, "USER");
      assert.equal(ev[0].actorId, adminA.id);
      assert.equal(ev[0].dedupeKey, "custom_status:customer:pw-a-cus3:customer_stage:1");
      assert.ok((await saveCustomValues("customer", "pw-a-cus3", { note_x: "chỉ đổi chữ" }, viewerA)).ok);
      assert.equal((await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.name, "custom_status.changed"))).length, 1, "field không phải trạng thái ⇒ không phát sự kiện");

      // ── 1. Lưu luật: mọi tham chiếu phải có thật ──
      const r = (over: Record<string, unknown>) => saveRule({ ...VIP_RULE, ...over }, actorA);
      expectFail(await r({ key: "Vip-Rule" }), "key", /chữ thường/, "khoá sai mẫu");
      expectFail(await r({ trigger: { kind: "event", event: "khong.co_that" } }), "trigger.event", /không có trong sổ sự kiện/, "sự kiện lạ");
      expectFail(await r({ trigger: { kind: "event", event: "workflow.run_done" } }), "trigger.event", /chính workflow/, "nghe sự kiện workflow.*");
      expectFail(await r({ trigger: { kind: "cron", every: "1h" } }), "trigger", /./, "loại trigger lạ");
      expectFail(await r({ trigger: { ...VIP_RULE.trigger, fieldKey: "khong_co" } }), "trigger.fieldKey", /không tồn tại/, "field trạng thái lạ");
      expectFail(await r({ trigger: { ...VIP_RULE.trigger, fieldKey: "note_x" } }), "trigger.fieldKey", /không phải kiểu trạng thái/, "field không phải status");
      expectFail(await r({ trigger: { ...VIP_RULE.trigger, to: ["gold"] } }), "trigger.to", /không có trong tuỳ chọn/, "giá trị đích lạ");
      expectFail(await r({ trigger: { ...VIP_RULE.trigger, objectKey: "khong_co" } }), "trigger.objectKey", /./, "đối tượng lạ");
      expectFail(await r({ conditions: { field: "custom:khong_co", op: "eq", value: 1 } }), "conditions", /không tồn tại/, "điều kiện trỏ field lạ");
      expectFail(await r({ conditions: { field: "system:khong_co", op: "eq", value: 1 } }), "conditions", /không có field hệ thống/, "điều kiện trỏ field hệ thống lạ");
      expectFail(await r({ conditions: { field: "custom:note_x", op: "regex", value: ".*" } }), "conditions", /tập phép/, "phép lạ");
      const sau = (n: number): unknown => (n <= 1 ? { field: "custom:note_x", op: "not_empty" } : { all: [sau(n - 1)] });
      expectFail(await r({ conditions: sau(6) }), "conditions", /sâu tối đa/, "cây quá sâu");
      expectFail(await r({ actions: [{ kind: "set_custom_value", field: "khong_co", value: "x" }] }), "actions.0.field", /không tồn tại/, "ghi field lạ");
      expectFail(await r({ actions: [{ kind: "set_custom_value", field: "customer_stage", value: "lost" }] }), "actions.0.field", /vòng lặp trực tiếp/, "vòng lặp trực tiếp");
      expectFail(await r({ trigger: { kind: "event", event: "custom_status.changed" }, conditions: null, actions: [{ kind: "set_custom_value", field: "note_x", value: "x" }] }), "actions.0.field", /./, "nghe mọi lượt đổi trạng thái rồi ghi giá trị");
      expectFail(await r({ actions: [{ kind: "set_custom_value", field: "ping", value: "c" }] }), "actions.0.value", /./, "giá trị ghi không nằm trong tuỳ chọn");
      expectFail(await r({ actions: [{ kind: "create_task", title: "Gọi", departmentCode: "KHONG_CO" }] }), "actions.0.departmentCode", /không tồn tại/, "phòng ban lạ");
      expectFail(await r({ actions: [{ kind: "notify", message: "một" }, { kind: "notify", message: "hai" }] }), "actions", /MỘT thông báo/, "hai thông báo");
      expectFail(await r({ actions: [{ kind: "http_call", url: "https://x" }] }), "actions", /./, "hành động ngoài tập đóng");
      expectFail(await r({ actions: [] }), "actions", /ít nhất một/, "không hành động");
      assert.equal((await listRules()).length, 0, "không lượt lưu hỏng nào để lại dòng");

      // ── 2. Luật mới: NHÁP + CHẠY THỬ; chưa bật thì không chạy thật được ──
      const saved = await r({});
      assert.ok(saved.ok, JSON.stringify(saved));
      assert.equal(saved.rule.status, "DRAFT");
      assert.equal(saved.rule.mode, "DRY_RUN");
      assert.equal(saved.rule.version, 1);
      vipRuleId = saved.rule.id;
      expectFail(await r({}), "key", /Đã có luật/, "trùng khoá");
      expectFail(await setRuleMode(vipRuleId, "LIVE", actorA), "mode", /đang BẬT/, "nháp không chạy thật được");
      expectFail(await saveRule({ ...VIP_RULE, id: vipRuleId, key: "vip_call_2" }, actorA), "key", /bất biến/, "đổi khoá");
      const nhatKy = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.entity, "WORKFLOW_RULE"), eq(schema.auditLogs.entityId, vipRuleId)));
      assert.equal(nhatKy.length, 1, "tạo luật ⇒ một dòng nhật ký trước/sau");

      // Luật NHÁP không chạy: đổi trạng thái lúc này không sinh lượt chạy nào.
      assert.equal(await readEventCursor(db), null, "chưa bật luật nào ⇒ chưa có con trỏ");

      // ── 3. Bật: ảnh chụp phiên bản + con trỏ khởi tạo ở sự kiện mới nhất ──
      const on = await setRuleStatus(vipRuleId, "ACTIVE", actorA);
      assert.ok(on.ok && on.rule.status === "ACTIVE" && on.rule.mode === "DRY_RUN", JSON.stringify(on));
      const anh = await db.select().from(schema.metaConfigVersions).where(and(eq(schema.metaConfigVersions.kind, "WORKFLOW"), eq(schema.metaConfigVersions.configKey, "vip_call")));
      assert.equal(anh.length, 1, "bật ⇒ một ảnh chụp bất biến kind WORKFLOW");
      assert.equal(anh[0].version, 1);
      assert.equal((await readEventCursor(db))?.id, ev[0].id, "con trỏ khởi tạo ở sự kiện MỚI NHẤT lúc bật");
      const r0 = await runWorkflows();
      assert.equal(r0.events, 0, "lượt đầu KHÔNG xử lý sự kiện cũ");
      assert.equal(await count("workflowRuns"), 0, "sự kiện của khách A3 (trước lúc bật) không sinh lượt chạy");

      // ── 4. CHẠY THỬ: lượt DRY_RUN với việc SẼ làm, không làm gì ──
      assert.ok((await saveCustomValues("customer", "pw-a-cus1", { customer_stage: "vip" }, viewerA)).ok);
      const r1 = await runWorkflows();
      assert.equal(r1.events, 1);
      assert.equal(r1.runs, 1);
      const dry = await listRuns({ ruleId: vipRuleId });
      assert.equal(dry.length, 1);
      assert.equal(dry[0].status, "DRY_RUN");
      assert.equal(dry[0].subjectType, "customer");
      assert.equal(dry[0].subjectId, "pw-a-cus1");
      assert.deepEqual(dry[0].steps.map((s) => s.status), ["PLANNED", "PLANNED"]);
      assert.match(dry[0].steps[0].detail, /Sau khi được duyệt: Tạo việc "Gọi chăm sóc khách VIP" cho phòng SALES/);
      assert.match(dry[0].steps[0].detail, /Khách hàng "Khách A1"/);
      assert.equal(await count("workTasks"), 0, "chạy thử: 0 việc");
      assert.equal(await count("workflowApprovals"), 0, "chạy thử: 0 yêu cầu duyệt");
      assert.equal(await count("workflowNotifications"), 0, "chạy thử: 0 thông báo");
      assert.equal((await runWorkflows()).runs, 0, "chạy lại không nhân đôi");

      // Chạy thử trên một bản ghi: KHÔNG ghi gì.
      const truocXem = await count("workflowRuns");
      const xem = await previewRule(vipRuleId, { objectKey: "customer", recordId: "pw-a-cus1" });
      assert.equal(xem.matched, true);
      assert.equal(xem.wouldDo.length, 2);
      assert.ok(xem.wouldDo.every((s) => s.status === "PLANNED"));
      assert.equal(await count("workflowRuns"), truocXem, "chạy thử không ghi lượt chạy");
      assert.equal(await count("workTasks"), 0);
      const xemLa = await previewRule(vipRuleId, { objectKey: "customer", recordId: "pw-b-cus1" });
      assert.equal(xemLa.matched, false, "bản ghi không có trong tổ chức ⇒ không khớp");
      assert.equal((await previewRule(vipRuleId, { objectKey: "order", recordId: "x" })).matched, false, "đối tượng khác của luật");

      // ── 5. CHẠY THẬT + cửa duyệt ──
      await activateLive(vipRuleId, actorA);
      assert.ok((await saveCustomValues("customer", "pw-a-cus2", { customer_stage: "lead" }, viewerA)).ok);
      assert.ok((await saveCustomValues("customer", "pw-a-cus2", { customer_stage: "vip" }, viewerA)).ok);
      const r2 = await runWorkflows();
      assert.equal(r2.events, 2, "hai lượt đổi trạng thái");
      assert.equal(r2.waiting, 1, "chỉ lượt sang vip khớp trigger");
      const cho = (await listRuns({ ruleId: vipRuleId, status: "WAITING_APPROVAL" }))[0];
      assert.ok(cho, "lượt chạy WAITING_APPROVAL");
      assert.equal(cho.mode, "LIVE");
      assert.equal(cho.subjectId, "pw-a-cus2");
      const [req] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.group, "WORKFLOW"));
      assert.ok(req, "yêu cầu duyệt nhóm WORKFLOW");
      assert.equal(req.status, "PENDING");
      assert.equal(req.requestedBy, null, "người xin là MÁY");
      assert.equal(req.requestedByEmail, "workflow:vip_call");
      assert.deepEqual(req.payload, { runId: cho.id, ruleId: vipRuleId, reason: VIP_RULE.gate.reason });
      assert.equal(cho.approvalRequestId, req.id);
      assert.equal(await count("workTasks"), 0, "chờ duyệt: 0 việc");
      const hangDoi = await adaptApprovals(new Date());
      assert.ok(hangDoi.some((w) => w.sourceKey === req.id && w.status === "NEW"), "yêu cầu duyệt hiện ở /work (nguồn APPROVAL)");
      const r2b = await runWorkflows();
      assert.equal(r2b.runs + r2b.executed, 0, "chưa ai quyết ⇒ lượt sau không làm gì");
      assert.equal(await count("workflowApprovals"), 1, "không đẻ yêu cầu duyệt thứ hai");

      // Người KHÁC duyệt qua đường duyệt có sẵn.
      const duyet = await decideApprovalCore(db, { ...managerA, canDecide: true }, req.id, true, "Khách đủ điều kiện");
      assert.ok("ok" in duyet, JSON.stringify(duyet));
      // Hai lượt chạy CHỒNG nhau (job alerts + webhook cùng lúc): chiếm lượt chạy bằng so-sánh-rồi-đổi ⇒ đúng một lượt thắng.
      const [r3a, r3b] = await Promise.all([runWorkflows(), runWorkflows()]);
      assert.equal(r3a.executed + r3b.executed, 1, "lượt sau thực thi lượt đã được duyệt — ĐÚNG MỘT LẦN dù hai lượt chạy chồng");
      assert.equal(await count("workTasks"), 1, "đúng MỘT việc");
      const [viec] = await db.select().from(schema.workItems).where(eq(schema.workItems.sourceType, "WORKFLOW_TASK"));
      assert.equal(viec.sourceKey, `${cho.id}:0`);
      assert.equal(viec.creationSource, "WORKFLOW");
      assert.equal(viec.authority, "WORK");
      assert.equal(viec.status, "NEW");
      assert.equal(viec.priority, "HIGH");
      assert.equal(viec.createdBy, null, "máy tạo — không gán cho người nào");
      assert.equal(viec.businessEntityId, "customer:pw-a-cus2");
      assert.ok(viec.dueAt && Math.abs(viec.dueAt.getTime() - Date.now() - 24 * 3_600_000) < 5 * 60_000, "hạn 24 giờ");
      const [phong] = await db.select({ code: schema.departments.code }).from(schema.departments).where(eq(schema.departments.id, viec.departmentId!));
      assert.equal(phong.code, "SALES");
      const vk = await db.select().from(schema.workItemEvents).where(eq(schema.workItemEvents.workItemId, viec.id));
      assert.equal(vk.length, 1);
      assert.equal(vk[0].source, "WORKFLOW");
      assert.equal(vk[0].actorId, null);
      assert.equal(vk[0].actorEmail, "workflow:vip_call");
      assert.ok((await adaptOwnedWork(new Date(), false)).some((w) => w.sourceType === "WORKFLOW_TASK" && w.creationSource === "WORKFLOW"), "việc hiện ở /work");
      const xong = (await listRuns({ ruleId: vipRuleId })).find((x) => x.id === cho.id)!;
      assert.equal(xong.status, "DONE");
      assert.deepEqual(xong.steps.map((s) => s.status), ["DONE", "DONE"]);
      const [reqSau] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, req.id));
      assert.equal(reqSau.status, "EXECUTED", "lời duyệt đã dùng");
      const daLam = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, `approval.executed:${req.id}`));
      assert.equal(daLam.length, 1, "approval.executed đúng một lần");
      assert.equal(daLam[0].actorKind, "SYSTEM");
      assert.equal(daLam[0].actorId, null);
      assert.equal(await count("workflowNotifications"), 1, "một thông báo cho lượt chạy");
      const [tb] = await db.select().from(schema.notifications).where(eq(schema.notifications.dedupeKey, `workflow:${cho.id}`));
      assert.equal(tb.kind, "SYSTEM");

      // Chạy lại: không nhân đôi gì.
      const r4 = await runWorkflows();
      assert.equal(r4.runs + r4.executed + r4.waiting, 0);
      assert.equal(await count("workTasks"), 1, "chạy lại vẫn một việc");
      assert.equal(await count("workflowNotifications"), 1);

      // ── 6. Từ chối ⇒ REJECTED, không việc nào ──
      assert.ok((await saveCustomValues("customer", "pw-a-cus3", { customer_stage: "lead" }, viewerA)).ok);
      assert.ok((await saveCustomValues("customer", "pw-a-cus3", { customer_stage: "vip" }, viewerA)).ok);
      await runWorkflows();
      const [req2] = await db.select().from(schema.approvalRequests).where(and(eq(schema.approvalRequests.group, "WORKFLOW"), eq(schema.approvalRequests.status, "PENDING")));
      assert.ok(req2);
      assert.ok("error" in (await decideApprovalCore(db, { ...managerA, canDecide: true }, req2.id, false, undefined)), "từ chối phải nêu lý do");
      assert.ok("ok" in (await decideApprovalCore(db, { ...managerA, canDecide: true }, req2.id, false, "Khách chưa đủ doanh số")));
      await runWorkflows();
      const tuChoi = (await listRuns({ ruleId: vipRuleId, status: "REJECTED" }))[0];
      assert.ok(tuChoi && /Khách chưa đủ doanh số/.test(tuChoi.error ?? ""), "lượt chạy REJECTED mang lý do");
      assert.equal(await count("workTasks"), 1, "bị từ chối ⇒ không thêm việc");

      // ── 7. Sửa luật đang chạy thật ⇒ về NHÁP + CHẠY THỬ, phiên bản +1 ──
      const sua = await saveRule({ ...VIP_RULE, id: vipRuleId, name: "Khách lên VIP ⇒ gọi ngay" }, actorA);
      assert.ok(sua.ok && sua.rule.status === "DRAFT" && sua.rule.mode === "DRY_RUN" && sua.rule.version === 2, JSON.stringify(sua));
      assert.ok((await saveCustomValues("customer", "pw-a-cus1", { customer_stage: "lead" }, viewerA)).ok);
      assert.ok((await saveCustomValues("customer", "pw-a-cus1", { customer_stage: "vip" }, viewerA)).ok);
      const r5 = await runWorkflows();
      assert.equal(r5.runs, 0, "luật nháp không chạy");

      // ── 8. Vòng lặp gián tiếp: bốn luật kích hoạt nhau ⇒ dừng ở độ sâu nhân quả ──
      const loop = [
        { key: "loop_1", on: ["ping", "a"], set: ["pong", "a"] },
        { key: "loop_2", on: ["pong", "a"], set: ["ping", "b"] },
        { key: "loop_3", on: ["ping", "b"], set: ["pong", "b"] },
        { key: "loop_4", on: ["pong", "b"], set: ["ping", "a"] },
      ];
      const loopIds: string[] = [];
      for (const l of loop) {
        const s = await saveRule(
          { key: l.key, name: l.key, trigger: { kind: "custom_status", objectKey: "customer", fieldKey: l.on[0], to: [l.on[1]] }, actions: [{ kind: "set_custom_value", field: l.set[0], value: l.set[1] }] },
          actorA,
        );
        assert.ok(s.ok, JSON.stringify(s));
        await activateLive(s.rule.id, actorA);
        loopIds.push(s.rule.id);
      }
      assert.ok((await saveCustomValues("customer", "pw-a-cus1", { ping: "a" }, viewerA)).ok);
      for (let i = 0; i < 8; i++) await runWorkflows();
      const loopRuns = (await listRuns({ limit: 200 })).filter((x) => loopIds.includes(x.ruleId));
      assert.equal(loopRuns.filter((x) => x.status === "DONE").length, 4, "bốn bước (độ sâu 0–3) chạy thật");
      const vongLap = loopRuns.filter((x) => x.status === "FAILED");
      assert.equal(vongLap.length, 1, "bước thứ năm bị chặn");
      assert.match(vongLap[0].error ?? "", /Vòng lặp/);
      assert.equal(vongLap[0].causationDepth, 4);
      assert.deepEqual(loopRuns.map((x) => x.causationDepth).sort(), [0, 1, 2, 3, 4]);
      const loopEvents = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "custom_status.changed"), eq(schema.domainEvents.actorKind, "SYSTEM")));
      assert.equal(loopEvents.length, 4, "máy ghi bốn lần, mỗi lần mang causation = lượt chạy");
      assert.ok(loopEvents.every((e) => e.actorId === null && loopRuns.some((x) => x.id === e.causationId)));
      const [cv] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, "pw-a-cus1")));
      assert.deepEqual([cv.values.ping, cv.values.pong], ["a", "b"], "vòng lặp dừng — giá trị cuối là của bước độ sâu 3");
      // Máy vẫn qua kiểm hợp lệ: không ghi được giá trị ngoài tuỳ chọn.
      const may = await saveCustomValues("customer", "pw-a-cus1", { ping: "zzz" }, { kind: "MACHINE", id: null, email: "workflow:thu" });
      assert.ok(!may.ok && may.code === "INVALID", "người ghi MÁY vẫn qua kiểm hợp lệ");
    });

    // ── 9. Tổ chức B: không thấy gì của A; lượt đầu không xử lý lịch sử ──
    await withOrganization(B, async () => {
      assert.deepEqual(await listRules(), [], "B không thấy luật của A");
      assert.deepEqual(await listRuns(), [], "B không thấy lượt chạy của A");
      assert.equal(await getRule(vipRuleId), null, "id luật của A không tồn tại trong B");
      assert.equal(await count("workTasks"), 0, "B không thấy việc của A");
      assert.equal(await count("workflowApprovals"), 0);
      expectFail(await setRuleStatus(vipRuleId, "ACTIVE", actorB), "id", /không tồn tại/, "B bật luật của A theo id");
      assert.equal((await previewRule(vipRuleId, { objectKey: "customer", recordId: "pw-a-cus1" })).matched, false);

      const db = await getDb();
      await db.insert(schema.customers).values({ id: "pw-b-cus1", name: "Khách B1" });
      assert.ok((await createCustomField("customer", { key: "customer_stage", label: "Giai đoạn", type: "status", options: [{ value: "lead", label: "L" }, { value: "vip", label: "V" }] }, actorB)).ok);
      assert.ok((await saveCustomValues("customer", "pw-b-cus1", { customer_stage: "vip" }, viewerB)).ok);
      const b0 = await runWorkflows();
      assert.equal(b0.events, 0, "B: lượt đầu khởi tạo con trỏ, không xử lý lịch sử");
      const s = await saveRule({ ...VIP_RULE, gate: null }, actorB);
      assert.ok(s.ok, JSON.stringify(s));
      assert.ok((await setRuleStatus(s.rule.id, "ACTIVE", actorB)).ok);
      assert.equal((await runWorkflows()).runs, 0, "B: sự kiện trước lúc bật không sinh lượt chạy");
      assert.ok((await saveCustomValues("customer", "pw-b-cus1", { customer_stage: "lead" }, viewerB)).ok);
      assert.ok((await saveCustomValues("customer", "pw-b-cus1", { customer_stage: "vip" }, viewerB)).ok);
      const b1 = await runWorkflows();
      assert.equal(b1.runs, 1, "B: sự kiện sau lúc bật chạy (chạy thử)");
      assert.equal((await listRuns())[0].status, "DRY_RUN");
    });
    await withOrganization(A, async () => {
      assert.equal((await listRules()).filter((x) => x.key === "vip_call").length, 1, "luật cùng khoá của B không lẫn sang A");
    });

    console.log(
      "✓ Workflow · bộ máy hai tổ chức: lưu luật từ chối sự kiện / đối tượng / field / giá trị / phòng ban lạ và vòng lặp trực tiếp · luật mới NHÁP + CHẠY THỬ · chạy thử 0 việc · chạy thật ⇒ yêu cầu duyệt (người xin là máy) + chờ duyệt · người khác duyệt ⇒ đúng MỘT việc + một thông báo, chạy lại không nhân đôi · từ chối ⇒ REJECTED · vòng lặp gián tiếp dừng ở độ sâu 4 · lượt đầu không xử lý lịch sử · B không thấy luật / lượt chạy / việc của A",
    );
  } finally {
    for (const code of [A, B]) await cleanupOrg(code);
  }
}
