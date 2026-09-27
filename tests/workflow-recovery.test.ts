/**
 * PHASE 3.1 · PHỤC HỒI LƯỢT CHẠY LUẬT TỰ ĐỘNG BỊ TREO (`lib/workflow/engine.ts`, `lib/workflow/stale.ts`).
 *
 * Rủi ro đã xác minh trong bộ máy Phase 3 (trước bản vá): lượt chạy chỉ ở PENDING trong lúc một tiến trình đang
 * thực thi, và không đường nào đưa nó ra khỏi PENDING nếu tiến trình chết — lượt kẹt VĨNH VIỄN, lời duyệt nằm
 * APPROVED không ai thanh toán, sự kiện không bao giờ được xử lý lại (dedupe_key đã có).
 *
 * Một tổ chức thật (`pr-a` — PGlite riêng, `provisionOrganization`, tự dọn). Tiến trình "chết" được giả lập đúng
 * như thật: (a) chiếm lượt bằng CHÍNH `claimRun` rồi không làm gì nữa; (b) móc bước ném lỗi SAU khi bước đã ghi
 * vào sổ — lỗi đi thẳng ra khỏi `runWorkflows`, không bị bắt thành bước FAILED.
 *
 *  1. Chết SAU khi chiếm (lượt có cửa duyệt): còn hạn giữ ⇒ không ai đụng; quá hạn ⇒ `listStaleRuns` thấy
 *     LEASE_EXPIRED ⇒ `runWorkflows` chiếm lại, hoàn tất ⇒ ĐÚNG MỘT việc + MỘT thông báo, lời duyệt EXECUTED.
 *  2. Chết GIỮA hai hành động (lượt không cửa duyệt): bước đã `DONE` KHÔNG làm lại (chữ của bước giữ nguyên
 *     "Đã tạo việc"), phần còn lại chạy tiếp.
 *  3. Chết sau khi ghi giá trị mà CHƯA kịp ghi sổ: làm lại `set_custom_value` cùng giá trị ⇒ không phát
 *     `custom_status.changed` lần hai; làm lại `create_task` ⇒ vẫn một việc.
 *  4. Hai `runWorkflows` chạy CHỒNG trên cùng lượt treo ⇒ đúng một lượt chiếm, không nhân đôi.
 *  5. Quá số lần thử ⇒ FAILED "Treo quá số lần thử", lời duyệt thanh toán BẰNG LỖI, không thử nữa.
 *  6. Hành động chưa chứng minh được lũy đẳng ⇒ không tự thử lại (FAILED, ghi rõ).
 *  7. `listStaleRuns`: lời duyệt đã có mà luật tạm dừng ⇒ DECISION_NOT_APPLIED; lượt đã chốt mà lời duyệt chưa
 *     thanh toán ⇒ UNSETTLED_APPROVAL, lượt kế tiếp tự thanh toán.
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { and, eq, like, sql } from "drizzle-orm";
import { getDb, getPlatformDb, organizationDatabaseUrl, schema } from "@/db";
import { decideApprovalCore } from "@/lib/approvals/service";
import type { SessionUser } from "@/lib/auth/session";
import { createCustomField } from "@/lib/metadata/fields";
import type { MetadataActor } from "@/lib/metadata/types";
import { saveCustomValues } from "@/lib/metadata/values";
import { invalidateCapabilities } from "@/lib/platform/capabilities";
import { withOrganization } from "@/lib/platform/context";
import { invalidateOrganizations } from "@/lib/platform/organizations";
import { provisionOrganization } from "@/lib/platform/provision";
import { getPlatformHealth, summarizeHealth } from "@/lib/queries/platform-health";
import { ACTION_RETRY_SAFETY, retryBlocker } from "@/lib/workflow/actions";
import { claimRun, listRuns, listStaleRuns, runWorkflows, setWorkflowStepHookForTests } from "@/lib/workflow/engine";
import { saveRule, setRuleMode, setRuleStatus } from "@/lib/workflow/rules";
import { WORKFLOW_MAX_ATTEMPTS, type WorkflowAction, type WorkflowRunRow } from "@/lib/workflow/types";

const A = "pr-a";

function testPure() {
  const acts: WorkflowAction[] = [
    { kind: "create_task", title: "Gọi" },
    { kind: "notify", message: "Báo" },
  ];
  assert.equal(retryBlocker(acts, []), null, "mọi hành động của tập đóng đã khai làm lại an toàn");
  const unsafe = { ...ACTION_RETRY_SAFETY, notify: { retrySafe: false, why: "thử" } };
  assert.equal(retryBlocker(acts, [], unsafe), "notify", "hành động chưa chứng minh lũy đẳng chặn thử lại");
  assert.equal(retryBlocker(acts, [{ action: "create_task", status: "DONE", detail: "" }, { action: "notify", status: "DONE", detail: "" }], unsafe), null, "bước đã DONE không làm lại ⇒ không chặn");
  assert.equal(retryBlocker(acts, [{ action: "notify", status: "DONE", detail: "" }], unsafe), "notify", "DONE ở vị trí khác / loại khác không tính");
  for (const [k, v] of Object.entries(ACTION_RETRY_SAFETY)) assert.ok(v.why.length >= 40, `${k}: phải khai căn cứ làm lại an toàn`);
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

async function n(q: Promise<{ n: number }[]>): Promise<number> {
  return Number((await q)[0].n);
}

export async function testWorkflowRecovery() {
  testPure();
  await cleanupOrg(A);
  rmSync(organizationDatabaseUrl({ code: A, isHome: false }).replace(/^pglite:\/\//, ""), { recursive: true, force: true });
  await provisionOrganization({ code: A, name: "Tổ chức PR-A", modules: ["customers"], admin: { email: `admin@${A}.local`, name: "QT", password: "Recover@12345" }, source: "TEST", actor: null });
  try {
    await withOrganization(A, async () => {
      const db = await getDb();
      const admin = await db.query.users.findFirst({ where: eq(schema.users.email, `admin@${A}.local`) });
      assert.ok(admin);
      const actor: MetadataActor = { id: admin.id, email: admin.email };
      const viewer: SessionUser = { id: admin.id, email: admin.email, name: "QT", role: "ADMIN", permissions: [], scope: "ALL", departmentCodes: [], positionId: null };
      const manager = { id: "pr-a-mgr", email: "mgr@pr-a.local" };
      await db.insert(schema.users).values({ id: manager.id, email: manager.email, name: "Quản lý", passwordHash: "x", role: "MANAGER", active: true });
      await db.insert(schema.customers).values(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"].map((x) => ({ id: `pr-a-${x}`, name: `Khách ${x}` })));
      const two = [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ];
      for (const input of [
        { key: "stage", label: "Giai đoạn", type: "status", options: two },
        { key: "tier", label: "Hạng", type: "status", options: two },
        { key: "ping", label: "Ping", type: "status", options: two },
        { key: "pong", label: "Pong", type: "status", options: two },
        { key: "note_x", label: "Ghi chú", type: "text" },
      ]) assert.ok((await createCustomField("customer", input, actor)).ok, input.key);

      const live = async (input: Record<string, unknown>) => {
        const s = await saveRule(input, actor);
        assert.ok(s.ok, JSON.stringify(s));
        assert.ok((await setRuleStatus(s.rule.id, "ACTIVE", actor)).ok);
        const m = await setRuleMode(s.rule.id, "LIVE", actor);
        assert.ok(m.ok, JSON.stringify(m));
        return s.rule.id;
      };
      // Luật có cửa duyệt: việc + thông báo.
      const gated = await live({
        key: "gated",
        name: "Cần duyệt",
        trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "stage", to: ["b"] },
        actions: [
          { kind: "create_task", title: "Gọi khách", departmentCode: "SALES" },
          { kind: "notify", message: "Có khách sang B" },
        ],
        gate: { kind: "approval", reason: "Quản lý xác nhận" },
      });
      // Luật không cửa duyệt: ba hành động.
      const direct = await live({
        key: "direct",
        name: "Chạy ngay",
        trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "tier", to: ["b"] },
        actions: [
          { kind: "create_task", title: "Chăm khách hạng B" },
          { kind: "notify", message: "Khách lên hạng B" },
          { kind: "set_custom_value", field: "note_x", value: "đã chăm" },
        ],
      });
      // Luật ghi một field TRẠNG THÁI: làm lại phải không phát sự kiện lần hai.
      const writer = await live({
        key: "writer",
        name: "Ghi trạng thái",
        trigger: { kind: "custom_status", objectKey: "customer", fieldKey: "ping", to: ["b"] },
        actions: [
          { kind: "set_custom_value", field: "pong", value: "b" },
          { kind: "create_task", title: "Sau khi ghi pong" },
        ],
      });
      assert.equal((await runWorkflows()).events, 0, "lượt đầu khởi tạo con trỏ");

      const tasks = (key?: string) =>
        n(db.select({ n: sql<number>`count(*)` }).from(schema.workItems).where(key ? and(eq(schema.workItems.sourceType, "WORKFLOW_TASK"), like(schema.workItems.sourceKey, `${key}:%`)) : eq(schema.workItems.sourceType, "WORKFLOW_TASK")));
      const notes = (runId: string) => n(db.select({ n: sql<number>`count(*)` }).from(schema.notifications).where(eq(schema.notifications.dedupeKey, `workflow:${runId}`)));
      const runOf = async (ruleId: string, subjectId: string): Promise<WorkflowRunRow> => {
        const r = (await listRuns({ ruleId, limit: 200 })).find((x) => x.subjectId === subjectId);
        assert.ok(r, `lượt chạy của ${subjectId}`);
        return r;
      };
      const expireLease = (runId: string) => db.update(schema.workflowRuns).set({ leaseUntil: sql`now() - interval '1 minute'` }).where(eq(schema.workflowRuns.id, runId));
      const approve = async (runId: string) => {
        const run = (await listRuns({ limit: 200 })).find((x) => x.id === runId)!;
        const d = await decideApprovalCore(db, { ...manager, canDecide: true }, run.approvalRequestId!, true, "Đồng ý");
        assert.ok("ok" in d, JSON.stringify(d));
        return run.approvalRequestId!;
      };
      const waitingRun = async (customer: string) => {
        assert.ok((await saveCustomValues("customer", customer, { stage: "b" }, viewer)).ok);
        await runWorkflows();
        const r = await runOf(gated, customer);
        assert.equal(r.status, "WAITING_APPROVAL");
        return r;
      };

      // ── 1. Chết SAU khi chiếm lượt đã được duyệt ──
      const w1 = await waitingRun("pr-a-c1");
      const req1 = await approve(w1.id);
      const claim1 = await claimRun(db, w1.id);
      assert.ok(claim1 && claim1.attempt === 1, "chiếm lượt bằng đúng claimRun — rồi tiến trình chết");
      assert.equal(await claimRun(db, w1.id), null, "đang trong hạn giữ ⇒ không ai chiếm được lần hai");
      const r1a = await runWorkflows();
      assert.equal(r1a.recovered + r1a.executed, 0, "còn hạn giữ ⇒ lượt kế tiếp không đụng tới");
      assert.equal(await tasks(w1.id), 0);
      assert.equal((await listStaleRuns()).some((s) => s.id === w1.id), false, "còn hạn giữ ⇒ chưa phải treo");
      await expireLease(w1.id);
      const stale1 = (await listStaleRuns()).find((s) => s.id === w1.id);
      assert.equal(stale1?.kind, "LEASE_EXPIRED", "quá hạn giữ ⇒ listStaleRuns thấy LEASE_EXPIRED");
      const r1b = await runWorkflows();
      assert.equal(r1b.recovered, 1, "lượt kế tiếp chiếm lại");
      const done1 = await runOf(gated, "pr-a-c1");
      assert.equal(done1.status, "DONE");
      assert.equal(done1.attempt, 2, "lần chiếm thứ hai");
      assert.equal(done1.leaseUntil, null, "chốt xong thì bỏ hạn giữ");
      assert.equal(await tasks(w1.id), 1, "ĐÚNG MỘT việc");
      assert.equal(await notes(w1.id), 1, "ĐÚNG MỘT thông báo");
      const [a1] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, req1));
      assert.equal(a1.status, "EXECUTED", "lời duyệt được thanh toán sau khi phục hồi");
      await runWorkflows();
      assert.equal(await tasks(w1.id), 1, "chạy lại vẫn một việc");
      assert.equal((await listStaleRuns()).some((s) => s.id === w1.id), false);

      // ── 2. Chết GIỮA hai hành động — bước đã xong không làm lại ──
      let armed = true;
      setWorkflowStepHookForTests((_id, i) => {
        if (armed && i === 0) {
          armed = false;
          throw new Error("TIẾN TRÌNH CHẾT (giả lập)");
        }
      });
      assert.ok((await saveCustomValues("customer", "pr-a-c2", { tier: "b" }, viewer)).ok);
      await assert.rejects(runWorkflows(), /TIẾN TRÌNH CHẾT/, "tiến trình chết sau bước 1");
      setWorkflowStepHookForTests(null);
      const mid = await runOf(direct, "pr-a-c2");
      assert.equal(mid.status, "PENDING");
      assert.deepEqual(mid.steps.map((s) => s.status), ["DONE", "PLANNED", "PLANNED"], "bước 1 đã ghi DONE ngay khi xong");
      assert.equal(await tasks(mid.id), 1);
      assert.equal(await notes(mid.id), 0, "bước 2 chưa chạy");
      assert.equal((await runWorkflows()).recovered, 0, "còn hạn giữ ⇒ chưa chiếm lại");
      await expireLease(mid.id);
      const r2 = await runWorkflows();
      assert.equal(r2.recovered, 1);
      const done2 = await runOf(direct, "pr-a-c2");
      assert.equal(done2.status, "DONE");
      assert.deepEqual(done2.steps.map((s) => s.status), ["DONE", "DONE", "DONE"]);
      assert.match(done2.steps[0].detail, /^Đã tạo việc/, "bước 1 KHÔNG làm lại — chữ của lần đầu giữ nguyên");
      assert.equal(await tasks(mid.id), 1, "vẫn đúng một việc");
      assert.equal(await notes(mid.id), 1, "đúng một thông báo");
      const [cv2] = await db.select().from(schema.customValues).where(and(eq(schema.customValues.objectKey, "customer"), eq(schema.customValues.recordId, "pr-a-c2")));
      assert.equal(cv2.values.note_x, "đã chăm");

      // ── 3. Chết sau khi GHI mà chưa kịp ghi sổ ⇒ làm lại an toàn ──
      armed = true;
      setWorkflowStepHookForTests((_id, i) => {
        if (armed && i === 1) {
          armed = false;
          throw new Error("TIẾN TRÌNH CHẾT (giả lập)");
        }
      });
      assert.ok((await saveCustomValues("customer", "pr-a-c3", { ping: "b" }, viewer)).ok);
      await assert.rejects(runWorkflows(), /TIẾN TRÌNH CHẾT/);
      setWorkflowStepHookForTests(null);
      const w3 = await runOf(writer, "pr-a-c3");
      // Chết TRƯỚC khi hai bước kịp ghi sổ: đưa cả hai về PLANNED — đúng trạng thái sổ nếu tiến trình chết giữa
      // lệnh ghi giá trị và lệnh ghi bước.
      await db.update(schema.workflowRuns).set({ steps: w3.steps.map((s) => ({ ...s, status: "PLANNED" })) }).where(eq(schema.workflowRuns.id, w3.id));
      const pongEvents = () => n(db.select({ n: sql<number>`count(*)` }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "custom_status.changed"), sql`${schema.domainEvents.payload}->>'fieldKey' = 'pong'`)));
      assert.equal(await pongEvents(), 1, "lần ghi đầu phát một sự kiện pong");
      assert.equal(await tasks(w3.id), 1);
      await expireLease(w3.id);
      assert.equal((await runWorkflows()).recovered, 1);
      const done3 = await runOf(writer, "pr-a-c3");
      assert.equal(done3.status, "DONE");
      assert.match(done3.steps[0].detail, /đã mang giá trị đó — không đổi gì/, "ghi lại cùng giá trị ⇒ không đổi gì");
      assert.match(done3.steps[1].detail, /đã có từ lượt trước — không tạo thêm/, "tạo lại việc ⇒ gặp việc cũ");
      assert.equal(await pongEvents(), 1, "làm lại set_custom_value KHÔNG phát custom_status.changed lần hai");
      assert.equal(await tasks(w3.id), 1, "làm lại create_task vẫn một việc");

      // ── 4. Hai runWorkflows chạy chồng trên cùng lượt treo ──
      const w4 = await waitingRun("pr-a-c4");
      await approve(w4.id);
      assert.ok(await claimRun(db, w4.id));
      await expireLease(w4.id);
      const [p, q] = await Promise.all([runWorkflows(), runWorkflows()]);
      assert.equal(p.recovered + q.recovered, 1, "đúng một tiến trình chiếm lại");
      assert.equal(await tasks(w4.id), 1, "không nhân đôi việc");
      assert.equal(await notes(w4.id), 1, "không nhân đôi thông báo");
      assert.equal((await runOf(gated, "pr-a-c4")).status, "DONE");

      // ── 5. Quá số lần thử ⇒ FAILED, không thử nữa ──
      const w5 = await waitingRun("pr-a-c5");
      const req5 = await approve(w5.id);
      assert.ok(await claimRun(db, w5.id));
      await db.update(schema.workflowRuns).set({ attempt: WORKFLOW_MAX_ATTEMPTS }).where(eq(schema.workflowRuns.id, w5.id));
      await expireLease(w5.id);
      assert.equal(await claimRun(db, w5.id), null, "đã đủ số lần thử ⇒ claimRun từ chối");
      const r5 = await runWorkflows();
      assert.equal(r5.recovered, 0);
      const f5 = await runOf(gated, "pr-a-c5");
      assert.equal(f5.status, "FAILED");
      assert.match(f5.error ?? "", /^Treo quá số lần thử: 3 lần chiếm/);
      assert.equal(await tasks(w5.id), 0, "không thử nữa ⇒ không việc nào");
      const [a5] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, req5));
      assert.equal(a5.status, "APPROVED", "lời duyệt KHÔNG bị tính là đã làm");
      assert.match(a5.executionError ?? "", /Treo quá số lần thử/, "…nhưng mang lỗi thực thi");
      assert.equal((await listStaleRuns()).find((s) => s.id === w5.id)?.kind, "STUCK_FAILED");
      await runWorkflows();
      assert.equal((await runOf(gated, "pr-a-c5")).status, "FAILED", "lượt sau không hồi sinh lượt đã dừng");
      assert.equal(await tasks(w5.id), 0);

      // ── 6. Hành động chưa chứng minh được lũy đẳng ⇒ không tự thử lại ──
      const w6 = await waitingRun("pr-a-c6");
      await approve(w6.id);
      assert.ok(await claimRun(db, w6.id));
      await expireLease(w6.id);
      const saved = ACTION_RETRY_SAFETY.notify.retrySafe;
      ACTION_RETRY_SAFETY.notify.retrySafe = false;
      try {
        await runWorkflows();
      } finally {
        ACTION_RETRY_SAFETY.notify.retrySafe = saved;
      }
      const f6 = await runOf(gated, "pr-a-c6");
      assert.equal(f6.status, "FAILED", "không tự thử lại ⇒ FAILED, ghi rõ");
      assert.match(f6.error ?? "", /hành động «notify» chưa chứng minh được/);
      assert.equal(await tasks(w6.id), 0, "không tự thử lại");
      assert.equal((await listStaleRuns()).find((s) => s.id === w6.id)?.kind, "STUCK_FAILED", "người phải xem");

      // ── 7. Chẩn đoán: lời duyệt đã có mà luật tạm dừng · lượt đã chốt mà lời duyệt chưa thanh toán ──
      const w7 = await waitingRun("pr-a-c7");
      const req7 = await approve(w7.id);
      assert.ok((await setRuleStatus(gated, "PAUSED", actor)).ok);
      await db.update(schema.approvalRequests).set({ decidedAt: sql`now() - interval '31 minutes'` }).where(eq(schema.approvalRequests.id, req7));
      await runWorkflows();
      assert.equal((await runOf(gated, "pr-a-c7")).status, "WAITING_APPROVAL", "luật tạm dừng ⇒ chờ, không chạy");
      assert.equal((await listStaleRuns()).find((s) => s.id === w7.id)?.kind, "DECISION_NOT_APPLIED");
      // Lượt 4 đã DONE: đưa lời duyệt của nó về APPROVED chưa thanh toán = chết giữa lúc chốt lượt và lúc thanh toán.
      const done4 = await runOf(gated, "pr-a-c4");
      await db.update(schema.approvalRequests).set({ status: "APPROVED", executedAt: null }).where(eq(schema.approvalRequests.id, done4.approvalRequestId!));
      await db.update(schema.workflowRuns).set({ finishedAt: sql`now() - interval '31 minutes'` }).where(eq(schema.workflowRuns.id, done4.id));
      assert.equal((await listStaleRuns()).find((s) => s.id === done4.id)?.kind, "UNSETTLED_APPROVAL");
      await runWorkflows();
      const [a4] = await db.select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, done4.approvalRequestId!));
      assert.equal(a4.status, "EXECUTED", "lượt kế tiếp tự thanh toán");
      assert.equal((await listStaleRuns()).some((s) => s.id === done4.id), false);
      assert.equal(await tasks(done4.id), 1, "thanh toán không chạy lại hành động");
      const kinds = new Set((await listStaleRuns()).map((s) => s.kind));
      assert.deepEqual([...kinds].sort(), ["DECISION_NOT_APPLIED", "STUCK_FAILED"], "còn đúng hai loại cần người xem");
      assert.deepEqual((await listStaleRuns()).map((s) => s.id).sort(), [w5.id, w6.id, w7.id].sort(), "đúng ba lượt: quá số lần thử · chặn vì lũy đẳng · lời duyệt chưa xử lý");
    });

    // ── 8. Cùng câu hỏi ở chẩn đoán CLI (chỉ đọc) và ở /settings/workflows ──
    const health = await getPlatformHealth({ mode: "READ_ONLY" });
    const orgA = health.organizations.find((o) => o.code === A);
    assert.equal(orgA?.workflowStaleRuns, 3, "platform:diagnostics đếm đúng ba lượt treo của A");
    assert.ok(orgA?.problems.some((p) => /3 lượt chạy luật tự động đang treo/.test(p)), "…và báo thành vấn đề");
    assert.equal(summarizeHealth(health).rows.find((r) => r.code === A)?.workflowStale, "3");
    const page = readFileSync(path.join(process.cwd(), "app/(dashboard)/settings/workflows/page.tsx"), "utf8");
    assert.ok(page.includes("loadStaleWorkflowRuns(user)") && page.includes("/settings/workflows?view=stale"), "/settings/workflows hiện dòng cảnh báo + liên kết lọc lượt treo");
    console.log(
      "✓ Workflow · phục hồi lượt treo: chết sau khi chiếm ⇒ quá hạn giữ thì chiếm lại, ĐÚNG MỘT việc + MỘT thông báo · chết giữa hai hành động ⇒ bước đã DONE không làm lại · làm lại set_custom_value / create_task không sinh bản sao, không phát sự kiện lần hai · hai lượt chạy chồng ⇒ một lượt chiếm · quá số lần thử ⇒ FAILED, lời duyệt mang lỗi, không thử nữa · hành động chưa chứng minh lũy đẳng ⇒ không tự thử lại · listStaleRuns thấy đúng bốn loại · platform:diagnostics và /settings/workflows đọc cùng câu hỏi",
    );
  } finally {
    setWorkflowStepHookForTests(null);
    await cleanupOrg(A);
  }
}
