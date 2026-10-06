import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  BUDGET_DEFAULTS,
  EMPTY_BUDGET,
  apiSpendAlert,
  apiSpendAllowed,
  classifyTechPolicy,
  policyRequiresApproval,
  resolveBudget,
} from "@/lib/constants/tech-policy";
import { techCockpit } from "@/lib/queries/tech-cockpit";
import { apiSpend, setTechBudget } from "@/lib/tech/budget";
import { createTechGoal, createTechMission, setTechMissionStatus } from "@/lib/tech/control-plane";
import { createTechTask, reclassifyTechTaskPolicy, setTechTaskStatus, type TechActor } from "@/lib/tech/service";
import { runTechWatchdog } from "@/lib/tech/watchdog";
import { claimNextTechTask, completeTechWorkerRun, registerTechWorker, startTechWorkerRun, type TechWorkerRow } from "@/lib/tech/worker-service";

/**
 * ═══════════ CHÍNH SÁCH R0–R4 · NGÂN SÁCH · WATCHDOG · BUỒNG LÁI (Pha 4–5, docs/tech-control-plane/README.md mục 11–12) ═══════════
 *
 *  1. Chính sách chỉ NÂNG; mọi việc chạm secret / quyền / xoá dữ liệu / DNS / thanh toán / lách cổng là R4.
 *  2. R3/R4 bật cổng duyệt; chưa xếp chính sách ⇒ worker không nhận (đóng khi thiếu).
 *  3. Tiền API: chưa khai trần ⇒ không chi; chạm trần ⇒ dừng; tiền gói thuê bao KHÔNG cộng vào tiền API.
 *  4. Trần đồng thời cấp công ty chặn lượt nhận việc.
 *  5. Watchdog ghi worker mất nhịp tim và chi API chạm trần — mỗi sự việc MỘT dòng.
 * Đồng hồ thật (AGENTS.md mục 50). Tự dọn bằng tiền tố `tp-t`.
 */

export function testTechPolicyPure() {
  const base = { riskRules: [] as string[], taskType: "DOCS", title: "Viết tài liệu", description: "" };
  assert.equal(classifyTechPolicy({ ...base, risk: "R0" }).level, "R0");
  assert.equal(classifyTechPolicy({ ...base, risk: "R1", taskType: "FEATURE" }).level, "R1");
  assert.equal(classifyTechPolicy({ ...base, risk: "R2" }).level, "R3", "R2 của máy xếp rủi ro ⇒ R3 chính sách");
  assert.equal(classifyTechPolicy({ ...base, risk: "R1", riskRules: ["INFRA"] }).level, "R2");
  for (const r of ["SECRETS", "ACCESS", "DATA_FIX", "SCHEDULER"]) assert.equal(classifyTechPolicy({ ...base, risk: "R2", riskRules: [r] }).level, "R4", `${r} ⇒ R4`);
  assert.equal(classifyTechPolicy({ ...base, risk: "R0", taskType: "SECURITY" }).level, "R4");
  for (const tu of ["Xoá dữ liệu production cũ", "Đổi DNS tên miền", "Tắt bảo vệ nhánh: bypass ruleset", "DELETE FROM orders", "Sửa trang thanh toán"]) {
    assert.equal(classifyTechPolicy({ ...base, risk: "R0", title: tu }).level, "R4", `“${tu}” ⇒ R4`);
  }
  assert.equal(classifyTechPolicy({ ...base, risk: "R0", title: "Tài liệu domain_events" }).level, "R0", "từ khoá không bắt nhầm tên kỹ thuật vô hại");
  assert.ok(classifyTechPolicy({ ...base, risk: "R2", riskRules: ["SECRETS"] }).reasons.length >= 2, "mọi lần nâng đều có lý do");
  assert.ok(policyRequiresApproval("R3") && policyRequiresApproval("R4") && !policyRequiresApproval("R1"));

  const cty = { ...EMPTY_BUDGET, apiUsdDaily: 10, maxRunMinutes: 60 };
  const suMenh = { ...EMPTY_BUDGET, apiUsdDaily: 2 };
  const r = resolveBudget([cty, null, undefined, suMenh]);
  assert.equal(r.apiUsdDaily, 2, "tầng hẹp đè TỪNG Ô");
  assert.equal(r.maxRunMinutes, 60, "ô tầng hẹp chưa khai thì giữ tầng rộng");
  assert.equal(r.maxAttempts, null, "không ai khai ⇒ CHƯA KHAI, không phải 0");
  assert.deepEqual(apiSpendAllowed(EMPTY_BUDGET, 0, 0), { ok: false, reason: "NOT_DECLARED", detail: "Chưa khai trần chi API theo ngày — worker API không chạy." }, "chưa khai ⇒ không chi");
  assert.equal(apiSpendAllowed({ ...EMPTY_BUDGET, apiUsdDaily: 5 }, 5, 5).ok, false, "chạm trần ngày ⇒ dừng");
  assert.equal(apiSpendAllowed({ ...EMPTY_BUDGET, apiUsdDaily: 5, apiUsdTotal: 3 }, 1, 3).ok, false, "chạm trần tổng ⇒ dừng");
  assert.equal(apiSpendAllowed({ ...EMPTY_BUDGET, apiUsdDaily: 5 }, 1, 1).ok, true);
  assert.equal(apiSpendAlert(EMPTY_BUDGET, 100), null, "chưa khai ⇒ không kết luận");
  assert.equal(apiSpendAlert({ ...EMPTY_BUDGET, apiUsdDaily: 10 }, 8), "WARN");
  assert.equal(apiSpendAlert({ ...EMPTY_BUDGET, apiUsdDaily: 10 }, 10), "EXCEEDED");
  assert.equal(BUDGET_DEFAULTS.maxAttempts, 3);
  console.log("✓ Chính sách & ngân sách (thuần): R0–R4 chỉ nâng, có lý do · từ khoá nguy hiểm ⇒ R4 · tầng hẹp đè từng ô · tiền API chưa khai ⇒ không chi");
}

export async function testTechPolicyDb() {
  const db = await getDb();
  const chuShop: TechActor = { kind: "HUMAN", id: "tp-t-user", name: "Chủ shop (kiểm thử chính sách)" };
  await db.insert(schema.users).values({ id: "tp-t-user", email: "tp-t@shop.vn", name: chuShop.name, passwordHash: "x", role: "ADMIN" }).onConflictDoNothing();
  const wid: string[] = [];
  try {
    // 1 · Ghi việc tính chính sách; R4 bật cổng duyệt; xếp lại chỉ NÂNG cổng duyệt.
    const r4 = (await createTechTask({ title: "tp-t Đổi DNS tên miền chính", taskType: "INFRA", module: "PLATFORM", priority: "P2", source: "OWNER" }, chuShop)) as { id: string };
    const r4Row = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r4.id) }))!;
    assert.equal(r4Row.policyLevel, "R4");
    assert.equal(r4Row.approvalStatus, "PENDING", "R4 ⇒ phải có người duyệt");
    const cu = (await createTechTask({ title: "tp-t việc cũ chưa xếp", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER" }, chuShop)) as { id: string };
    await db.update(schema.techTasks).set({ policyLevel: null, policyReasons: [] }).where(eq(schema.techTasks.id, cu.id));
    assert.ok("error" in (await reclassifyTechTaskPolicy({ taskId: cu.id }, { kind: "SYSTEM", name: "job" })), "chỉ người xếp lại");
    const xl = await reclassifyTechTaskPolicy({ taskId: cu.id }, chuShop);
    assert.ok("ok" in xl && xl.level === "R0");

    // 2 · Hàng đợi: việc chưa xếp chính sách không nhận được; API chưa khai trần ⇒ không chạy.
    const g = (await createTechGoal({ title: "tp-t mục tiêu", priority: "P1", activate: true }, chuShop)) as { id: string };
    const m = (await createTechMission({ title: "tp-t sứ mệnh", priority: "P1", goalId: g.id }, chuShop)) as { id: string };
    await setTechMissionStatus({ missionId: m.id, to: "ACTIVE" }, chuShop);
    const t = (await createTechTask({ title: "tp-t tài liệu cho worker API", taskType: "DOCS", module: "TECH", priority: "P0", source: "OWNER", missionId: m.id }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: t.id, to }, chuShop);
    const api = (await registerTechWorker({ key: "tp-t-api", name: "Worker API", provider: "ANTHROPIC_API", capabilities: ["write-docs"] }, chuShop)) as { id: string };
    wid.push(api.id);
    const w = async (id: string) => (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, id) }))! as TechWorkerRow;
    assert.equal((await claimNextTechTask(await w(api.id))).reason, "API_BUDGET_NOT_DECLARED", "chưa khai trần ⇒ worker API không nhận việc");
    assert.ok("error" in (await setTechBudget({ scopeKind: "COMPANY", apiUsdDaily: 5 }, { kind: "AI_AGENT", agentId: null, name: "agent" })), "agent không tự nới trần tiền");
    assert.ok("ok" in (await setTechBudget({ scopeKind: "COMPANY", apiUsdDaily: 5, maxConcurrentRuns: 1 }, chuShop)));
    await db.update(schema.techTasks).set({ policyLevel: null }).where(eq(schema.techTasks.id, t.id));
    assert.equal((await claimNextTechTask(await w(api.id))).task, null, "chưa xếp chính sách ⇒ không ai nhận");
    await reclassifyTechTaskPolicy({ taskId: t.id }, chuShop);
    const c = (await claimNextTechTask(await w(api.id))).task;
    assert.ok(c && c.taskId === t.id, "đã khai trần + chính sách R0 ⇒ nhận được");
    assert.equal(c!.timeoutMinutes, BUDGET_DEFAULTS.maxRunMinutes);

    // 3 · Trần đồng thời cấp công ty = 1 ⇒ worker thứ hai không nhận dù còn việc.
    const sub = (await registerTechWorker({ key: "tp-t-sub", name: "Worker gói", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"] }, chuShop)) as { id: string };
    wid.push(sub.id);
    const t2 = (await createTechTask({ title: "tp-t tài liệu hai", taskType: "DOCS", module: "TECH", priority: "P1", source: "OWNER", missionId: m.id }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: t2.id, to }, chuShop);
    assert.equal((await claimNextTechTask(await w(sub.id))).reason, "COMPANY_AT_CAPACITY");

    // 4 · Tiền: lượt API kết thúc với $5 ⇒ chạm trần ngày ⇒ worker API dừng; tiền gói thuê bao không cộng vào.
    await startTechWorkerRun(await w(api.id), { runId: c!.runId, leaseGeneration: c!.leaseGeneration });
    await completeTechWorkerRun(await w(api.id), { runId: c!.runId, leaseGeneration: c!.leaseGeneration, outcome: "SUCCEEDED", branch: c!.branch, cost: { usd: 5 } });
    const chi = await apiSpend();
    assert.ok(chi.todayUsd >= 5, `tiền API hôm nay phải gồm lượt $5, đọc ${chi.todayUsd}`);
    const c2 = (await claimNextTechTask(await w(sub.id))).task!;
    await completeTechWorkerRun(await w(sub.id), { runId: c2.runId, leaseGeneration: c2.leaseGeneration, outcome: "SUCCEEDED", branch: c2.branch, cost: { usd: 3 } });
    assert.equal((await apiSpend()).todayUsd, chi.todayUsd, "ước tính của gói thuê bao KHÔNG cộng vào tiền API");
    const t3 = (await createTechTask({ title: "tp-t tài liệu ba", taskType: "DOCS", module: "TECH", priority: "P1", source: "OWNER", missionId: m.id }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: t3.id, to }, chuShop);
    assert.equal((await claimNextTechTask(await w(api.id))).reason, "API_BUDGET_DAILY_CAP", "chạm trần ngày ⇒ worker API dừng");

    // 5 · Watchdog: chi chạm trần ⇒ MỘT sự kiện; worker giữ việc mà mất nhịp tim ⇒ MỘT sự kiện.
    const c3 = (await claimNextTechTask(await w(sub.id))).task!;
    await db.update(schema.techWorkers).set({ lastHeartbeatAt: new Date(Date.now() - 3600_000) }).where(eq(schema.techWorkers.id, sub.id));
    const w1 = await runTechWatchdog();
    const w2 = await runTechWatchdog();
    assert.equal(w1.apiAlert, "EXCEEDED");
    assert.equal(w1.lostWorkers, 1);
    assert.equal(w2.lostWorkers, 0, "chạy lại không đẻ sự kiện thứ hai cho cùng một lần mất");
    const ev = await db.select({ name: schema.techEvents.name }).from(schema.techEvents).where(sql`${schema.techEvents.name} in ('budget.exceeded','worker.lost')`);
    assert.equal(ev.filter((e) => e.name === "budget.exceeded").length, 1);
    void c3;

    // 6 · Buồng lái: tiền API và ước tính gói thuê bao là HAI con số; đang chạy hiện đủ thông tin.
    const bl = await techCockpit();
    assert.ok(bl.spend.apiTodayUsd >= 5 && bl.spend.subscriptionEstimateUsdMonth >= 3);
    assert.equal(bl.spend.apiAlert, "EXCEEDED");
    assert.ok(bl.executions.some((e) => e.task?.id === t3.id || e.worker?.name === "Worker gói"), "lượt đang chạy phải hiện trên buồng lái");
    console.log("✓ Chính sách & ngân sách (CSDL): R4 bật cổng duyệt · chưa xếp chính sách ⇒ không tự động · API chưa khai trần ⇒ không chạy, chạm trần ⇒ dừng · trần đồng thời công ty · gói thuê bao không cộng vào tiền API · watchdog một sự kiện mỗi lần · buồng lái tách hai loại tiền");
  } finally {
    await db.delete(schema.techBudgets).where(eq(schema.techBudgets.scopeKind, "COMPANY"));
    await db.delete(schema.techEvents).where(sql`${schema.techEvents.name} in ('budget.updated','budget.exceeded','budget.warning','worker.lost') or ${schema.techEvents.taskId} in (select id from tech_tasks where title like 'tp-t%') or ${schema.techEvents.goalId} in (select id from tech_goals where title like 'tp-t%') or ${schema.techEvents.subjectId} in (select id from tech_workers where key like 'tp-t%')`);
    await db.delete(schema.techAgentRuns).where(sql`${schema.techAgentRuns.taskId} in (select id from tech_tasks where title like 'tp-t%')`);
    await db.delete(schema.techTaskEvents).where(sql`${schema.techTaskEvents.taskId} in (select id from tech_tasks where title like 'tp-t%')`);
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, "tp-t%"));
    await db.delete(schema.techMissions).where(like(schema.techMissions.title, "tp-t%"));
    await db.delete(schema.techGoals).where(like(schema.techGoals.title, "tp-t%"));
    await db.delete(schema.techWorkers).where(like(schema.techWorkers.key, "tp-t%"));
    await db.delete(schema.users).where(eq(schema.users.id, "tp-t-user"));
    void wid;
  }
}
