import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { TECH_TASK_TYPES } from "@/lib/constants/tech";
import { CAPABILITY_BY_TASK_TYPE, TECH_AUTONOMOUS_CAPABILITIES, TECH_CAPABILITIES, taskCapability } from "@/lib/constants/tech-capabilities";
import {
  API_BILLING_ENV,
  TECH_LEASE,
  assertBillingBoundary,
  backoffMinutes,
  buildChildEnv,
  claimBlockers,
  decideCompletion,
  taskBranchName,
  workerLiveness,
  type ClaimCandidate,
} from "@/lib/constants/tech-worker";
import { createTechGoal, createTechMission, setTechGoalStatus, setTechMissionStatus } from "@/lib/tech/control-plane";
import { createTechTask, setTechTaskStatus, type TechActor } from "@/lib/tech/service";
import {
  authenticateTechWorker,
  claimNextTechTask,
  completeTechWorkerRun,
  reapExpiredTechLeases,
  registerTechWorker,
  setTechWorkerEnabled,
  startTechWorkerRun,
  techWorkerHeartbeat,
  type TechWorkerRow,
} from "@/lib/tech/worker-service";
import { buildAgentPrompt, parseAgentResult, toolAllowlist } from "../scripts/tech-worker/brief";

/**
 * ═══════════ WORKER · LEASE · NHỊP TIM (Pha 2, docs/tech-control-plane/README.md mục 4) ═══════════
 *
 * Khoá năm điều mà một hàng đợi agent hay nói dối:
 *  1. Hai worker không bao giờ nhận cùng một việc; việc chưa đủ điều kiện (phụ thuộc, R2, sứ mệnh dừng) không
 *     bao giờ được nhận — và luật bản TypeScript nói ĐÚNG điều câu SQL làm.
 *  2. Worker chết không làm mất việc: lease hết hạn ⇒ thu hồi ⇒ việc về hàng đợi, đếm lần thử, lùi dần, có trần.
 *  3. Fencing: worker cũ sống lại không ghi đè được kết quả của lượt mới.
 *  4. Huỷ / chờ chủ shop giữa chừng ⇒ worker nhận lệnh DỪNG, và kết quả nộp muộn không đè quyết định của người.
 *  5. Ranh giới thanh toán: worker gói thuê bao KHÔNG BAO GIỜ thấy khoá API.
 * Đồng hồ: mốc dựng từ `now` thật (AGENTS.md mục 50). Dữ liệu tự dọn bằng tiền tố `tw-t`.
 */

const goc = path.resolve(__dirname, "..");

/* ═════════════════════ 1. HÀM THUẦN ═════════════════════ */

export function testTechWorkerPure() {
  const now = new Date();
  // Kết cục ⇒ bước kế tiếp.
  assert.deepEqual(decideCompletion("SUCCEEDED", 1, 3), { runStatus: "SUCCEEDED", taskTo: "REVIEW", requeue: false, backoffMinutes: null });
  assert.equal(decideCompletion("FAILED", 1, 3).taskTo, "SPEC_READY", "còn lần thử ⇒ về hàng đợi");
  assert.equal(decideCompletion("FAILED", 1, 3).backoffMinutes, 5);
  assert.equal(decideCompletion("FAILED", 3, 3).taskTo, "FAILED", "hết lần ⇒ FAILED, không thử mãi");
  assert.equal(decideCompletion("BLOCKED", 1, 3).taskTo, "BLOCKED", "đề bài / môi trường hỏng ⇒ không thử lại y nguyên");
  assert.equal(decideCompletion("NEEDS_OWNER", 1, 3).taskTo, "NEEDS_OWNER");
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMinutes), [5, 10, 20, 40, 60, 60], "lùi dần có trần");

  // Sống / chập chờn / mất.
  assert.equal(workerLiveness(null, now), "NEVER");
  assert.equal(workerLiveness(new Date(now.getTime() - 10_000), now), "ONLINE");
  assert.equal(workerLiveness(new Date(now.getTime() - (TECH_LEASE.staleAfterSeconds + 5) * 1000), now), "STALE");
  assert.equal(workerLiveness(new Date(now.getTime() - (TECH_LEASE.ttlSeconds + 5) * 1000), now), "LOST");

  // Điều kiện nhận việc — mỗi lá chắn một phép thử.
  const base: ClaimCandidate = {
    status: "SPEC_READY",
    risk: "R0",
    approvalStatus: "NOT_REQUIRED",
    openDependencies: 0,
    missionStatus: "ACTIVE",
    goalStatus: "ACTIVE",
    leaseWorkerId: null,
    leaseExpiresAt: null,
    attempts: 0,
    maxAttempts: 3,
    nextAttemptAt: null,
    capability: "write-docs",
  };
  const w = { capabilities: ["write-docs"] };
  assert.deepEqual(claimBlockers(base, w, now), []);
  const thu: [Partial<ClaimCandidate>, string][] = [
    [{ status: "TRIAGED" }, "STATUS"],
    [{ openDependencies: 1 }, "DEPENDENCIES"],
    [{ missionStatus: "PAUSED" }, "MISSION_NOT_ACTIVE"],
    [{ goalStatus: "DRAFT" }, "GOAL_NOT_ACTIVE"],
    [{ risk: "R2" }, "RISK"],
    [{ approvalStatus: "PENDING" }, "APPROVAL"],
    [{ leaseWorkerId: "x", leaseExpiresAt: new Date(now.getTime() + 60_000) }, "LEASED"],
    [{ attempts: 3 }, "ATTEMPTS_EXHAUSTED"],
    [{ nextAttemptAt: new Date(now.getTime() + 60_000) }, "BACKOFF"],
    [{ capability: "implement-feature" }, "CAPABILITY"],
  ];
  for (const [doi, mong] of thu) assert.deepEqual(claimBlockers({ ...base, ...doi }, w, now), [mong], `${mong} phải chặn`);
  assert.deepEqual(claimBlockers({ ...base, leaseWorkerId: "x", leaseExpiresAt: new Date(now.getTime() - 1) }, w, now), [], "lease hết hạn không còn chặn");
  assert.deepEqual(claimBlockers({ ...base, missionStatus: null, goalStatus: null }, w, now), [], "việc lẻ không thuộc sứ mệnh vẫn chạy được");

  // Tên nhánh tất định theo mã việc + lần thử.
  assert.equal(taskBranchName("TECH-12", 2), "tech/TECH-12-a2");
  assert.equal(taskBranchName("TECH-12; rm -rf /", 1), "tech/TECH-12rm-rf-a1", "không ký tự lạ nào lọt vào tên nhánh");

  // Ranh giới thanh toán.
  const cha = { PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "sk-ant-THAT", ANTHROPIC_AUTH_TOKEN: "x", DATABASE_URL: "postgres://prod", TECH_WORKER_TOKEN: "tw_x.y", GITHUB_TOKEN: "ghp" };
  const sub = buildChildEnv("SUBSCRIPTION_CLAUDE_CODE", cha, null);
  for (const k of [...API_BILLING_ENV, "DATABASE_URL", "TECH_WORKER_TOKEN", "GITHUB_TOKEN"]) assert.equal(sub[k], undefined, `worker gói thuê bao không được thấy ${k}`);
  assert.equal(sub.PATH, "/bin");
  assert.equal(sub.ERP_READ_ONLY, "1");
  assert.throws(() => buildChildEnv("ANTHROPIC_API", cha, null), /khoá riêng/, "worker API không mượn khoá của máy");
  assert.equal(buildChildEnv("ANTHROPIC_API", cha, "sk-ant-RIENG").ANTHROPIC_API_KEY, "sk-ant-RIENG", "worker API dùng đúng khoá riêng");
  assert.throws(() => assertBillingBoundary("SUBSCRIPTION_CLAUDE_CODE", { ANTHROPIC_API_KEY: "x" }), /Ranh giới thanh toán/);

  // Sổ năng lực: trỏ tệp có thật, phủ mọi loại việc, worker không tự deploy / migration.
  for (const c of TECH_CAPABILITIES) assert.ok(existsSync(path.join(goc, c.source)), `năng lực ${c.key} trỏ tệp không tồn tại: ${c.source}`);
  for (const t of TECH_TASK_TYPES) assert.ok(CAPABILITY_BY_TASK_TYPE[t], `loại việc ${t} chưa có năng lực`);
  for (const k of ["deploy-production", "database-migration", "security-review", "code-review"]) assert.ok(!TECH_AUTONOMOUS_CAPABILITIES.includes(k as never), `${k} không được tự động`);
  assert.equal(taskCapability({ capability: "", taskType: "DOCS" }), "write-docs");
  assert.equal(taskCapability({ capability: "fix-bug", taskType: "DOCS" }), "fix-bug");

  // Đề bài + công cụ: không git ghi, có đường thoát NEEDS_OWNER; lời khai hỏng không thành "thành công".
  const tools = toolAllowlist().join(" ");
  for (const cam of ["git add", "git commit", "git push", "npm install", "rm "]) assert.ok(!tools.includes(cam), `agent không được ${cam}`);
  const de = buildAgentPrompt({ code: "TECH-1", title: "x", description: "y", taskType: "DOCS", module: "TECH", risk: "R0", capability: "write-docs", attempt: 1, maxAttempts: 3, mission: null });
  assert.match(de, /NEEDS_OWNER/);
  assert.match(de, /AGENTS\.md/);
  assert.equal(parseAgentResult("không phải json").outcome, null);
  assert.equal(parseAgentResult('{"outcome":"DEPLOYED"}').outcome, null, "kết cục ngoài danh sách đóng bị bỏ");
  assert.equal(parseAgentResult('{"outcome":"NEEDS_OWNER","ownerAction":"cấp quyền"}').ownerAction, "cấp quyền");

  // Migration: CHECK provider / concurrency khớp hằng số.
  const mig = readFileSync(path.join(goc, "drizzle/0226_tech_workers.sql"), "utf8");
  assert.match(mig, /"max_concurrency" BETWEEN 1 AND 4/);
  assert.equal(TECH_LEASE.maxConcurrencyCeiling, 4);
  assert.match(mig, /"provider" IN \('SUBSCRIPTION_CLAUDE_CODE','ANTHROPIC_API'\)/);

  console.log("✓ Worker (thuần): kết cục → bước kế tiếp tất định · lùi dần có trần · 10 lá chắn nhận việc · nhánh tất định · worker gói thuê bao không thấy khoá API · năng lực trỏ tệp thật");
}

/* ═════════════════════ 2. CSDL ═════════════════════ */

async function worker(id: string): Promise<TechWorkerRow> {
  const db = await getDb();
  return (await db.query.techWorkers.findFirst({ where: eq(schema.techWorkers.id, id) }))!;
}

export async function testTechWorkerDb() {
  const db = await getDb();
  await db.insert(schema.users).values({ id: "tw-t-user", email: "tw-t@shop.vn", name: "Chủ shop (kiểm thử worker)", passwordHash: "x", role: "ADMIN" }).onConflictDoNothing();
  const chuShop: TechActor = { kind: "HUMAN", id: "tw-t-user", name: "Chủ shop (kiểm thử worker)" };
  const taskIds: string[] = [];
  const workerIds: string[] = [];
  try {
    // 2.1 Đăng ký: chỉ người; năng lực phải tự động được; khoá in một lần, CSDL giữ băm.
    assert.ok("error" in (await registerTechWorker({ key: "tw-t-may", name: "x", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"] }, { kind: "SYSTEM", name: "job" })));
    assert.ok("error" in (await registerTechWorker({ key: "tw-t-deploy", name: "x", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["deploy-production"] }, chuShop)), "không cấp được năng lực deploy cho worker");
    const a = await registerTechWorker({ key: "tw-t-a", name: "Worker A", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs", "fix-bug"] }, chuShop);
    const b = await registerTechWorker({ key: "tw-t-b", name: "Worker B", provider: "SUBSCRIPTION_CLAUDE_CODE", capabilities: ["write-docs"] }, chuShop);
    assert.ok("ok" in a && "ok" in b);
    const A = a as { id: string; token: string };
    const B = b as { id: string; token: string };
    workerIds.push(A.id, B.id);
    const row = await worker(A.id);
    assert.ok(!JSON.stringify(row).includes(A.token.split(".")[1]), "CSDL không được giữ khoá thô");
    assert.equal((await authenticateTechWorker(`Bearer ${A.token}`))?.id, A.id);
    assert.equal(await authenticateTechWorker(`Bearer ${A.token}x`), null, "khoá sai một ký tự ⇒ từ chối");
    assert.equal(await authenticateTechWorker(`Bearer ${B.token.split(".")[0]}.${A.token.split(".")[1]}`), null, "khoá của worker này không mở được worker kia");
    assert.equal(await authenticateTechWorker(null), null);

    // 2.2 Dựng hàng đợi: mục tiêu + sứ mệnh bật; bốn việc.
    const g = (await createTechGoal({ title: "tw-t mục tiêu", priority: "P1", activate: true }, chuShop)) as { id: string };
    const m = (await createTechMission({ title: "tw-t sứ mệnh chạy", priority: "P1", goalId: g.id }, chuShop)) as { id: string };
    await setTechMissionStatus({ missionId: m.id, to: "ACTIVE" }, chuShop);
    const mDung = (await createTechMission({ title: "tw-t sứ mệnh dừng", priority: "P0", goalId: g.id }, chuShop)) as { id: string };
    const tao = async (title: string, extra: Record<string, unknown> = {}) => {
      const r = (await createTechTask({ title, taskType: "DOCS", module: "TECH", priority: "P1", source: "OWNER", ...extra }, chuShop)) as { id: string };
      taskIds.push(r.id);
      for (const to of ["TRIAGED", "SPEC_READY"] as const) await setTechTaskStatus({ taskId: r.id, to }, chuShop);
      return r.id;
    };
    const t1 = await tao("tw-t viết tài liệu một", { missionId: m.id });
    const t2 = await tao("tw-t viết tài liệu hai (phụ thuộc)", { missionId: m.id, dependsOn: [t1] });
    const tDung = await tao("tw-t việc của sứ mệnh dừng", { missionId: mDung.id, priority: "P0" });
    const tR2 = await tao("tw-t việc rủi ro cao", { missionId: m.id, riskOverride: { risk: "R2", reason: "Chạm lương — người phải duyệt" } });

    // 2.3 Nhận việc: đúng MỘT worker được t1; không ai nhận t2 (phụ thuộc), tDung (sứ mệnh dừng), tR2 (rủi ro).
    const [ca, cb] = await Promise.all([claimNextTechTask(await worker(A.id)), claimNextTechTask(await worker(B.id))]);
    const got = [ca.task, cb.task].filter(Boolean);
    assert.equal(got.length, 1, `đúng một worker nhận được việc, nhận: ${JSON.stringify([ca.reason, cb.reason])}`);
    const c1 = got[0]!;
    assert.equal(c1.taskId, t1);
    assert.equal(c1.leaseGeneration, 1);
    assert.equal(c1.branch, `tech/${c1.code}-a1`);
    const giu = c1 === ca.task ? await worker(A.id) : await worker(B.id);
    const kia = giu.id === A.id ? await worker(B.id) : await worker(A.id);
    // Bản TS nói đúng điều SQL làm, trên CÙNG dữ liệu.
    const nowCheck = new Date();
    for (const id of [t2, tDung, tR2]) {
      const t = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, id), with: { mission: { columns: { status: true, goalId: true } } } }))!;
      const deps = (t.dependsOn as string[]).length ? (await db.select({ s: schema.techTasks.status }).from(schema.techTasks).where(inArray(schema.techTasks.id, t.dependsOn as string[]))).filter((x) => x.s !== "DONE").length : 0;
      const bl = claimBlockers(
        { status: t.status as never, risk: t.risk as never, approvalStatus: t.approvalStatus, openDependencies: deps, missionStatus: t.mission?.status ?? null, goalStatus: "ACTIVE", leaseWorkerId: t.leaseWorkerId, leaseExpiresAt: t.leaseExpiresAt, attempts: t.attempts, maxAttempts: t.maxAttempts, nextAttemptAt: t.nextAttemptAt, capability: taskCapability(t) },
        { capabilities: ["write-docs"] },
        nowCheck,
      );
      assert.ok(bl.length > 0, `${t.title}: SQL không nhận thì TS cũng phải nói vì sao — TS nói rỗng`);
    }
    const lai = await claimNextTechTask(kia);
    assert.equal(lai.task, null, "không còn việc đủ điều kiện");

    // 2.4 Bắt đầu ⇒ BUILDING; nhịp tim gia hạn + nhật ký có trần; generation sai ⇒ DỪNG.
    assert.ok("ok" in (await startTechWorkerRun(giu, { runId: c1.runId, leaseGeneration: 1, baseCommit: "abc" })));
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))?.status, "BUILDING");
    const truoc = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))!.leaseExpiresAt!;
    const logs = Array.from({ length: TECH_LEASE.maxLogLinesPerBeat + 50 }, (_, i) => ({ line: `dòng ${i}` }));
    const hb = await techWorkerHeartbeat(giu, { version: "t", runs: [{ runId: c1.runId, leaseGeneration: 1, progressPct: 40, step: "agent", logs }] }, new Date(Date.now() + 1000));
    assert.equal(hb.runs[0].action, "CONTINUE");
    const sau = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))!.leaseExpiresAt!;
    assert.ok(sau.getTime() > truoc.getTime(), "nhịp tim gia hạn lease");
    const [nLog] = await db.select({ n: sql<number>`count(*)` }).from(schema.techRunLogs).where(eq(schema.techRunLogs.runId, c1.runId));
    assert.equal(Number(nLog.n), TECH_LEASE.maxLogLinesPerBeat, "mỗi nhịp tối đa maxLogLinesPerBeat dòng — nhật ký có trần");
    const sai = await techWorkerHeartbeat(giu, { runs: [{ runId: c1.runId, leaseGeneration: 9 }] });
    assert.equal(sai.runs[0].action, "ABORT");
    const nguoiKhac = await techWorkerHeartbeat(kia, { runs: [{ runId: c1.runId, leaseGeneration: 1 }] });
    assert.equal(nguoiKhac.runs[0].reason, "RUN_NOT_YOURS");

    // 2.5 Lần 1 thất bại ⇒ về hàng đợi + lùi dần; ngay lúc đó không ai nhận lại được.
    const f1 = await completeTechWorkerRun(giu, { runId: c1.runId, leaseGeneration: 1, outcome: "FAILED", error: "cổng lint đỏ", gates: { typecheck: "PASSED", lint: "FAILED" } });
    assert.ok("ok" in f1 && f1.taskStatus === "SPEC_READY", JSON.stringify(f1));
    const sauF1 = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))!;
    assert.equal(sauF1.leaseWorkerId, null, "kết thúc lượt ⇒ nhả lease");
    assert.ok(sauF1.nextAttemptAt && sauF1.nextAttemptAt.getTime() > Date.now(), "lùi dần trước lần thử kế");
    assert.equal(sauF1.lastError, "cổng lint đỏ");
    assert.equal((await claimNextTechTask(kia)).task, null, "đang lùi dần ⇒ không ai nhận");
    const nopLai = await completeTechWorkerRun(giu, { runId: c1.runId, leaseGeneration: 1, outcome: "SUCCEEDED" });
    assert.ok("error" in nopLai && nopLai.error === "RUN_CLOSED", "nộp lại kết quả cho lượt đã đóng ⇒ từ chối");

    // 2.6 Sập worker: hết lùi dần → B nhận (generation 2) → B "chết" (lease hết hạn) → A nhận lại sau thu hồi.
    await db.update(schema.techTasks).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.techTasks.id, t1));
    const c2 = (await claimNextTechTask(kia)).task!;
    assert.equal(c2.leaseGeneration, 2);
    assert.equal(c2.attempt, 2);
    await startTechWorkerRun(kia, { runId: c2.runId, leaseGeneration: 2 });
    await db.update(schema.techTasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(schema.techTasks.id, t1));
    const thu = await reapExpiredTechLeases();
    assert.equal(thu.reaped, 1);
    const run2 = (await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, c2.runId) }))!;
    assert.equal(run2.status, "FAILED");
    assert.match(run2.error, /Lease hết hạn/);
    const sauThu = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))!;
    assert.equal(sauThu.status, "SPEC_READY", "worker chết ⇒ việc về hàng đợi, không mất");
    assert.equal(sauThu.leaseWorkerId, null);
    assert.equal((await reapExpiredTechLeases()).reaped, 0, "thu hồi lần hai không làm gì");
    // Worker B sống lại, nộp kết quả của generation 2 ⇒ bị từ chối.
    const ma = await completeTechWorkerRun(kia, { runId: c2.runId, leaseGeneration: 2, outcome: "SUCCEEDED", branch: c2.branch });
    assert.ok("error" in ma, "worker cũ sống lại không ghi đè được");

    // 2.7 Lần 3 (cuối): thành công ⇒ REVIEW, nhánh ghi vào việc (khoá nối PR), tiền gói thuê bao là ƯỚC TÍNH.
    await db.update(schema.techTasks).set({ nextAttemptAt: null }).where(eq(schema.techTasks.id, t1));
    const c3 = (await claimNextTechTask(giu)).task!;
    assert.equal(c3.attempt, 3);
    assert.equal(c3.leaseGeneration, 3);
    await startTechWorkerRun(giu, { runId: c3.runId, leaseGeneration: 3 });
    const ok3 = await completeTechWorkerRun(giu, { runId: c3.runId, leaseGeneration: 3, outcome: "SUCCEEDED", branch: c3.branch, resultCommit: "def", summary: "Đã viết tài liệu", gates: { typecheck: "PASSED", lint: "PASSED" }, cost: { usd: 0.42 } });
    assert.ok("ok" in ok3 && ok3.taskStatus === "REVIEW", JSON.stringify(ok3));
    const t1Xong = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1) }))!;
    assert.equal(t1Xong.branch, c3.branch, "nhánh vào việc ⇒ bộ đồng bộ PR ghép được");
    const run3 = (await db.query.techAgentRuns.findFirst({ where: eq(schema.techAgentRuns.id, c3.runId) }))!;
    assert.equal((run3.metadata as { cost: { estimated: boolean } }).cost.estimated, true, "tiền của lượt gói thuê bao chỉ là ƯỚC TÍNH");
    assert.equal(run3.provider, "SUBSCRIPTION_CLAUDE_CODE");
    assert.equal(run3.workerId, giu.id);

    // 2.8 Phụ thuộc chưa DONE (t1 mới ở REVIEW) ⇒ t2 vẫn chưa nhận được.
    assert.equal((await claimNextTechTask(kia)).task, null);
    // Bỏ phụ thuộc để thử nhánh huỷ giữa chừng.
    await db.update(schema.techTasks).set({ dependsOn: [] }).where(eq(schema.techTasks.id, t2));
    const c4 = (await claimNextTechTask(kia)).task!;
    assert.equal(c4.taskId, t2);
    await startTechWorkerRun(kia, { runId: c4.runId, leaseGeneration: c4.leaseGeneration });
    await setTechTaskStatus({ taskId: t2, to: "NEEDS_OWNER", ownerEscalation: "APPROVAL_REQUIRED", ownerAction: "Chủ shop quyết có làm tài liệu này nữa không" }, chuShop);
    const dung = await techWorkerHeartbeat(kia, { runs: [{ runId: c4.runId, leaseGeneration: c4.leaseGeneration }] });
    assert.equal(dung.runs[0].action, "ABORT", "người chuyển việc sang chờ chủ shop ⇒ worker nhận lệnh DỪNG");
    const muon = await completeTechWorkerRun(kia, { runId: c4.runId, leaseGeneration: c4.leaseGeneration, outcome: "SUCCEEDED", branch: c4.branch });
    assert.ok("ok" in muon && muon.taskStatus === "NEEDS_OWNER", "kết quả nộp muộn KHÔNG đè quyết định của người");

    // 2.9 NEEDS_OWNER do worker báo (OAuth / quyền) ⇒ việc chờ chủ shop kèm đúng việc phải làm.
    await setTechMissionStatus({ missionId: mDung.id, to: "ACTIVE" }, chuShop);
    const c5 = (await claimNextTechTask(giu)).task!;
    assert.equal(c5.taskId, tDung, "sứ mệnh bật lại ⇒ việc của nó nhận được (P0 đứng trước)");
    const no = await completeTechWorkerRun(giu, { runId: c5.runId, leaseGeneration: c5.leaseGeneration, outcome: "NEEDS_OWNER", summary: "Cần quyền", ownerEscalation: "EXTERNAL_AUTH_REQUIRED", ownerAction: "Đăng nhập Meta và cấp quyền pages_messaging cho app" });
    assert.ok("ok" in no && no.taskStatus === "NEEDS_OWNER");
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, tDung) }))?.ownerEscalation, "EXTERNAL_AUTH_REQUIRED");

    // 2.10 Worker bị tắt ⇒ không nhận việc; mục tiêu tạm dừng ⇒ không việc nào của nó được nhận.
    await setTechWorkerEnabled({ workerId: giu.id, enabled: false, reason: "bảo trì máy" }, chuShop);
    assert.equal((await claimNextTechTask(await worker(giu.id))).reason, "WORKER_DISABLED");
    await setTechGoalStatus({ goalId: g.id, to: "PAUSED" }, chuShop);
    void tR2;

    const ev = await db.select({ name: schema.techEvents.name }).from(schema.techEvents).where(inArray(schema.techEvents.subjectId, [A.id, B.id, t1, c1.runId, c3.runId]));
    for (const n of ["worker.registered", "worker.claimed", "run.lease_expired", "run.succeeded", "run.failed"]) assert.ok(ev.some((e) => e.name === n), `thiếu sự kiện ${n}`);

    console.log("✓ Worker (CSDL): hai worker không nhận trùng · phụ thuộc / R2 / sứ mệnh dừng không bao giờ nhận · TS nói đúng điều SQL làm · lease gia hạn theo nhịp tim, nhật ký có trần · thất bại ⇒ lùi dần · worker chết ⇒ thu hồi, việc về hàng đợi · fencing chặn worker cũ · huỷ giữa chừng ⇒ DỪNG, nộp muộn không đè người · tiền gói thuê bao là ước tính");
  } finally {
    await db.delete(schema.techEvents).where(sql`${schema.techEvents.goalId} in (select id from tech_goals where title like 'tw-t%') or ${schema.techEvents.subjectId} in (select id from tech_workers where key like 'tw-t%') or ${schema.techEvents.taskId} in (select id from tech_tasks where title like 'tw-t%')`);
    await db.delete(schema.techAgentRuns).where(sql`${schema.techAgentRuns.taskId} in (select id from tech_tasks where title like 'tw-t%')`);
    await db.delete(schema.techTaskEvents).where(sql`${schema.techTaskEvents.taskId} in (select id from tech_tasks where title like 'tw-t%')`);
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, "tw-t%"));
    await db.delete(schema.techMissions).where(like(schema.techMissions.title, "tw-t%"));
    await db.delete(schema.techGoals).where(like(schema.techGoals.title, "tw-t%"));
    await db.delete(schema.techWorkers).where(like(schema.techWorkers.key, "tw-t%"));
    await db.delete(schema.users).where(eq(schema.users.id, "tw-t-user"));
    void taskIds;
    void workerIds;
  }
}
