import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { CI_FIX_MAX, OBSERVATION_MINUTES, ciFixDecision, deployCatchUpSteps, observationVerdict, prTransitionEvents } from "@/lib/constants/tech-delivery";
import { __setGithubFetchForTests } from "@/lib/integrations/github/client";
import { __setDispatchFetchForTests, dispatchAgentOpenPr } from "@/lib/integrations/github/dispatch";
import { advanceDeployedTasks, onPullRequestChanged, requestWorkerPullRequest, verifyObservedTasks } from "@/lib/tech/delivery";
import { createTechTask, setTechTaskStatus, type TechActor } from "@/lib/tech/service";

/**
 * ═══════════ ĐƯỜNG GIAO HÀNG: PR → CI → GỘP → DEPLOY → HẬU KIỂM (Pha 3, docs/tech-control-plane/README.md mục 10) ═══════════
 *
 * Không lượt gọi mạng thật nào: `fetch` của GitHub được tiêm giả. Khoá:
 *  1. PR của worker mở bằng ĐÚNG cầu nối bot (agent-open-pr.yml trên main), chỉ cho nhánh `ai/worker/…`.
 *  2. CI đỏ ⇒ đúng MỘT việc sửa trên chính nhánh PR; đang có việc sửa thì không đẻ thêm; hết trần ⇒ FAILED.
 *  3. Việc đã gộp chỉ tới OBSERVING khi commit đang chạy production CHỨA commit gộp (bằng chứng git, không bằng giờ),
 *     và R2 chưa duyệt thì không đi.
 *  4. Hậu kiểm: chưa đủ cửa sổ ⇒ chờ; sự cố nặng sau deploy ⇒ "Cần chủ shop"; đủ ⇒ ghi bằng chứng rồi DONE.
 * Đồng hồ thật (AGENTS.md mục 50). Tự dọn bằng tiền tố `td-t`.
 */

export function testTechDeliveryPure() {
  const p = (prNumber: number | null, prState: string, ciState: string, headSha = "a1") => ({ prNumber, prState, ciState, headSha });
  assert.deepEqual(prTransitionEvents(p(null, "", ""), p(7, "OPEN", "PENDING")).map((e) => e.name), ["pr.opened"]);
  assert.deepEqual(prTransitionEvents(p(7, "OPEN", "PENDING"), p(7, "OPEN", "FAILURE")).map((e) => e.name), ["ci.failed"]);
  const lai = prTransitionEvents(p(7, "OPEN", "FAILURE", "a1"), p(7, "OPEN", "FAILURE", "b2"));
  assert.deepEqual(lai.map((e) => e.name), ["ci.failed"], "đẩy commit mới rồi lại đỏ là MỘT sự kiện mới");
  assert.notEqual(lai[0].dedupe, prTransitionEvents(p(7, "OPEN", "PENDING", "a1"), p(7, "OPEN", "FAILURE", "a1"))[0].dedupe, "khoá chống trùng gắn với SHA");
  assert.deepEqual(prTransitionEvents(p(7, "OPEN", "FAILURE"), p(7, "OPEN", "FAILURE")), [], "không đổi ⇒ không sự kiện");
  assert.deepEqual(prTransitionEvents(p(7, "OPEN", "SUCCESS"), p(7, "MERGED", "SUCCESS")).map((e) => e.name), ["pr.merged"]);

  assert.equal(ciFixDecision({ branch: "claude/x", prState: "OPEN", fixTasksTotal: 0, fixTasksOpen: 0 }), "NOT_WORKER", "PR người mở thì người sửa");
  assert.equal(ciFixDecision({ branch: "ai/worker/TECH-1-a1", prState: "MERGED", fixTasksTotal: 0, fixTasksOpen: 0 }), "NOT_OPEN");
  assert.equal(ciFixDecision({ branch: "ai/worker/TECH-1-a1", prState: "OPEN", fixTasksTotal: 1, fixTasksOpen: 1 }), "FIX_IN_FLIGHT");
  assert.equal(ciFixDecision({ branch: "ai/worker/TECH-1-a1", prState: "OPEN", fixTasksTotal: CI_FIX_MAX, fixTasksOpen: 0 }), "EXHAUSTED");
  assert.equal(ciFixDecision({ branch: "ai/worker/TECH-1-a1", prState: "OPEN", fixTasksTotal: 0, fixTasksOpen: 0 }), "CREATE_FIX");

  assert.deepEqual(deployCatchUpSteps("QA"), ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING"], "đi qua ĐỦ khâu, nhật ký kể đúng đường");
  assert.deepEqual(deployCatchUpSteps("BUILDING"), [], "chưa gộp thì không có gì để đi");

  const now = new Date();
  const truoc = (phut: number) => new Date(now.getTime() - phut * 60_000);
  assert.equal(observationVerdict({ deployedAt: null, verified: true, severeIncidentsSince: 0, now }), "NO_EVIDENCE");
  assert.equal(observationVerdict({ deployedAt: truoc(90), verified: false, severeIncidentsSince: 0, now }), "NO_EVIDENCE", "chưa đối chiếu commit đang chạy ⇒ không kết luận");
  assert.equal(observationVerdict({ deployedAt: truoc(5), verified: true, severeIncidentsSince: 0, now }), "WAIT");
  assert.equal(observationVerdict({ deployedAt: truoc(5), verified: true, severeIncidentsSince: 1, now }), "INCIDENT", "sự cố nặng không đợi hết cửa sổ");
  assert.equal(observationVerdict({ deployedAt: truoc(OBSERVATION_MINUTES + 1), verified: true, severeIncidentsSince: 0, now }), "PASS");
  console.log("✓ Giao hàng (thuần): sự kiện PR/CI gắn SHA · việc sửa CI có trần, chỉ cho nhánh worker · nối deploy đi đủ khâu · hậu kiểm không biến chưa biết thành khoẻ");
}

type Call = { url: string; body: unknown };

export async function testTechDeliveryDb() {
  const db = await getDb();
  const chuShop: TechActor = { kind: "HUMAN", id: "td-t-user", name: "Chủ shop (kiểm thử giao hàng)" };
  await db.insert(schema.users).values({ id: "td-t-user", email: "td-t@shop.vn", name: chuShop.name, passwordHash: "x", role: "ADMIN" }).onConflictDoNothing();
  const env = { repo: process.env.ERP_GITHUB_REPO, token: process.env.ERP_GITHUB_DISPATCH_TOKEN };
  process.env.ERP_GITHUB_REPO = "vi-du/kho";
  process.env.ERP_GITHUB_DISPATCH_TOKEN = "ghp_khoa_gia_cho_bai_kiem_giao_hang";
  const dispatched: Call[] = [];
  __setDispatchFetchForTests((async (url: string, init: RequestInit) => {
    dispatched.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch);
  const MERGE = "abcdef1234567890abcdef1234567890abcdef12";
  const DEPLOY = "1234567890abcdef1234567890abcdef12345678";
  let chua = true;
  __setGithubFetchForTests((async (url: string | URL | Request) => {
    const u = String(url);
    if (/\/pulls\/\d+$/.test(u)) return new Response(JSON.stringify({ number: 901, state: "closed", merged: true, merge_commit_sha: MERGE, html_url: "https://x/pr/901", head: { ref: "ai/worker/X-a1", sha: "h" }, base: { ref: "main", sha: "b" } }), { status: 200 });
    if (u.includes("/compare/")) return new Response(JSON.stringify({ status: chua ? "ahead" : "behind" }), { status: 200 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch);

  try {
    // 1 · Yêu cầu PR: đúng cầu nối, đúng nhánh; nhánh lạ bị từ chối TRƯỚC khi gọi mạng.
    const sai = await dispatchAgentOpenPr({ head: "main", title: "x", body: "y" });
    assert.ok(!sai.ok && sai.kind === "FORBIDDEN", "không mở PR cho nhánh không phải nhánh worker");
    const t = (await createTechTask({ title: "td-t việc của worker", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER", branch: "ai/worker/TDT-1-a1" }, chuShop)) as { id: string; code: string };
    const r = await requestWorkerPullRequest({ id: t.id, code: t.code, title: "td-t việc của worker", missionId: null }, "ai/worker/TDT-1-a1", "Đã viết tài liệu");
    assert.ok(r.requested);
    assert.equal(dispatched.length, 1);
    assert.match(dispatched[0].url, /\/actions\/workflows\/agent-open-pr\.yml\/dispatches$/, "mở PR qua ĐÚNG cầu nối bot đã có");
    assert.deepEqual((dispatched[0].body as { ref: string }).ref, "main", "cầu nối chỉ chạy từ main");
    assert.equal((dispatched[0].body as { inputs: { head: string } }).inputs.head, "ai/worker/TDT-1-a1");

    // 2 · CI đỏ ⇒ đúng một việc sửa trên CHÍNH nhánh; đỏ tiếp khi việc sửa còn mở ⇒ không đẻ thêm; hết trần ⇒ FAILED.
    for (const to of ["TRIAGED", "BUILDING", "REVIEW"] as const) await setTechTaskStatus({ taskId: t.id, to }, chuShop);
    await db.update(schema.techTasks).set({ prNumber: 901, prState: "OPEN", headSha: "s1" }).where(eq(schema.techTasks.id, t.id));
    const goc = { id: t.id, code: t.code, missionId: null };
    await onPullRequestChanged(goc, { prNumber: 901, prState: "OPEN", ciState: "PENDING", headSha: "s1" }, { prNumber: 901, prState: "OPEN", ciState: "FAILURE", headSha: "s1" });
    const sua = () => db.select().from(schema.techTasks).where(eq(schema.techTasks.parentTaskId, t.id));
    let fixes = await sua();
    assert.equal(fixes.length, 1, "CI đỏ ⇒ một việc sửa");
    assert.equal(fixes[0].capability, "ci-debug");
    assert.equal(fixes[0].branch, "ai/worker/TDT-1-a1", "việc sửa làm trên CHÍNH nhánh của PR");
    assert.equal(fixes[0].status, "SPEC_READY", "việc sửa sẵn sàng cho worker nhận");
    await onPullRequestChanged(goc, { prNumber: 901, prState: "OPEN", ciState: "FAILURE", headSha: "s1" }, { prNumber: 901, prState: "OPEN", ciState: "FAILURE", headSha: "s2" });
    assert.equal((await sua()).length, 1, "việc sửa còn mở ⇒ không đẻ việc thứ hai");
    // Việc sửa 1 xong lượt (REVIEW), CI đỏ lần nữa ⇒ việc sửa 2; rồi lần nữa ⇒ hết trần.
    for (const to of ["BUILDING", "REVIEW"] as const) await setTechTaskStatus({ taskId: fixes[0].id, to }, chuShop);
    await onPullRequestChanged(goc, { prNumber: 901, prState: "OPEN", ciState: "PENDING", headSha: "s3" }, { prNumber: 901, prState: "OPEN", ciState: "FAILURE", headSha: "s3" });
    fixes = await sua();
    assert.equal(fixes.length, 2);
    const f2 = fixes.find((f) => f.status === "SPEC_READY")!;
    for (const to of ["BUILDING", "REVIEW"] as const) await setTechTaskStatus({ taskId: f2.id, to }, chuShop);
    await onPullRequestChanged(goc, { prNumber: 901, prState: "OPEN", ciState: "PENDING", headSha: "s4" }, { prNumber: 901, prState: "OPEN", ciState: "FAILURE", headSha: "s4" });
    assert.equal((await sua()).length, CI_FIX_MAX, "không vượt trần sửa CI");
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t.id) }))?.status, "FAILED", "hết trần ⇒ việc gốc FAILED, không vòng vô hạn");

    // 3 · Đã gộp + deploy đã đối chiếu CHỨA commit gộp ⇒ OBSERVING (đủ khâu). R2 chưa duyệt ⇒ không đi.
    const g = (await createTechTask({ title: "td-t việc đã gộp", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER" }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "BUILDING", "REVIEW", "QA"] as const) await setTechTaskStatus({ taskId: g.id, to }, chuShop);
    await db.update(schema.techTasks).set({ prNumber: 902, prState: "MERGED" }).where(eq(schema.techTasks.id, g.id));
    const r2 = (await createTechTask({ title: "td-t việc R2 đã gộp", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER", riskOverride: { risk: "R2", reason: "Chạm lương — người phải duyệt" } }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "BUILDING", "REVIEW", "QA"] as const) await setTechTaskStatus({ taskId: r2.id, to }, chuShop);
    await db.update(schema.techTasks).set({ prNumber: 903, prState: "MERGED" }).where(eq(schema.techTasks.id, r2.id));
    // Chưa có lượt deploy đã đối chiếu nào ⇒ không làm gì.
    assert.equal((await advanceDeployedTasks()).advanced, 0);
    const [dep] = await db
      .insert(schema.techDeployments)
      .values({ commitSha: DEPLOY, provider: "GITHUB_ACTIONS", externalRunId: "td-t-run", status: "SUCCEEDED", verification: "VERIFIED", actorKind: "SYSTEM", notes: "td-t", startedAt: new Date(Date.now() - 2 * 3600_000) })
      .returning({ id: schema.techDeployments.id });
    chua = false;
    let a = await advanceDeployedTasks();
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, g.id) }))?.status, "QA", "commit đang chạy KHÔNG chứa commit gộp ⇒ đứng yên");
    assert.ok(a.notContained >= 1);
    chua = true;
    a = await advanceDeployedTasks();
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, g.id) }))?.status, "OBSERVING");
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, r2.id) }))?.status, "QA", "R2 chưa duyệt ⇒ máy không đưa sang khâu deploy");
    assert.ok(a.skippedApproval >= 1);
    const duong = await db.select({ next: schema.techTaskEvents.nextValue }).from(schema.techTaskEvents).where(sql`${schema.techTaskEvents.taskId} = ${g.id} and ${schema.techTaskEvents.kind} = 'STATUS'`);
    for (const k of ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING"]) assert.ok(duong.some((d) => d.next === k), `nhật ký phải có khâu ${k}`);

    // 4 · Hậu kiểm: lượt deploy 2 giờ trước, không sự cố ⇒ xác minh + DONE. Việc khác có sự cố SEV1 sau deploy ⇒ Cần chủ shop.
    const v = await verifyObservedTasks();
    assert.ok(v.passed >= 1, JSON.stringify(v));
    const xong = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, g.id) }))!;
    assert.equal(xong.status, "DONE");
    assert.ok(xong.productionVerifiedAt && /Máy hậu kiểm/.test(xong.productionEvidence), "DONE luôn kèm bằng chứng xác minh ghi trước");
    const h = (await createTechTask({ title: "td-t việc gặp sự cố", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER" }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "BUILDING", "REVIEW", "QA"] as const) await setTechTaskStatus({ taskId: h.id, to }, chuShop);
    await db.update(schema.techTasks).set({ prNumber: 904, prState: "MERGED" }).where(eq(schema.techTasks.id, h.id));
    await advanceDeployedTasks();
    await db.insert(schema.techIncidents).values({ code: "INC-TDT1", title: "td-t sự cố sau deploy", severity: "SEV1", status: "OPEN", openedByKind: "SYSTEM", detectedAt: new Date() });
    await verifyObservedTasks();
    const sc = (await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, h.id) }))!;
    assert.equal(sc.status, "NEEDS_OWNER", "sự cố nặng sau deploy ⇒ Cần chủ shop, không tự đóng");
    assert.equal(sc.ownerEscalation, "PRODUCTION_INCIDENT");
    void dep;

    // 5 · Quay lui: lượt deploy MỚI hơn KHÔNG chứa commit gộp ⇒ việc đang quan sát thành ROLLED_BACK, không bao giờ DONE.
    const q = (await createTechTask({ title: "td-t việc bị quay lui", taskType: "DOCS", module: "TECH", priority: "P2", source: "OWNER" }, chuShop)) as { id: string };
    for (const to of ["TRIAGED", "BUILDING", "REVIEW", "QA"] as const) await setTechTaskStatus({ taskId: q.id, to }, chuShop);
    await db.update(schema.techTasks).set({ prNumber: 905, prState: "MERGED" }).where(eq(schema.techTasks.id, q.id));
    chua = true;
    await advanceDeployedTasks(50);
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, q.id) }))?.status, "OBSERVING");
    await db.insert(schema.techDeployments).values({ commitSha: "9999999999999999999999999999999999999999", provider: "GITHUB_ACTIONS", externalRunId: "td-t-run-2", status: "SUCCEEDED", verification: "VERIFIED", actorKind: "SYSTEM", notes: "td-t", startedAt: new Date(Date.now() - 3600_000) });
    chua = false;
    await verifyObservedTasks();
    assert.equal((await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, q.id) }))?.status, "ROLLED_BACK", "production không còn chứa mã của việc ⇒ ROLLED_BACK");
    chua = true;

    const ev = await db.select({ name: schema.techEvents.name }).from(schema.techEvents).where(sql`${schema.techEvents.taskId} in (${t.id}, ${g.id}, ${h.id})`);
    for (const n of ["pr.requested", "ci.failed", "ci.fix_requested", "ci.retry_exhausted", "deploy.reached", "verification.passed", "verification.failed"]) assert.ok(ev.some((e) => e.name === n), `thiếu sự kiện ${n}`);
    console.log("✓ Giao hàng (CSDL): PR mở qua cầu nối bot · CI đỏ ⇒ việc sửa trên chính nhánh, có trần ⇒ FAILED · deploy chỉ nối khi commit đang chạy CHỨA commit gộp, R2 chưa duyệt đứng yên · hậu kiểm ĐẠT ⇒ bằng chứng + DONE, sự cố nặng ⇒ Cần chủ shop");
  } finally {
    __setDispatchFetchForTests(null);
    __setGithubFetchForTests(null);
    if (env.repo === undefined) delete process.env.ERP_GITHUB_REPO;
    else process.env.ERP_GITHUB_REPO = env.repo;
    if (env.token === undefined) delete process.env.ERP_GITHUB_DISPATCH_TOKEN;
    else process.env.ERP_GITHUB_DISPATCH_TOKEN = env.token;
    await db.delete(schema.techEvents).where(sql`${schema.techEvents.taskId} in (select id from tech_tasks where title like 'td-t%' or title like 'Sửa CI đỏ: %')`);
    await db.delete(schema.techIncidents).where(eq(schema.techIncidents.code, "INC-TDT1"));
    await db.delete(schema.techDeployments).where(eq(schema.techDeployments.notes, "td-t"));
    await db.delete(schema.techTaskEvents).where(sql`${schema.techTaskEvents.taskId} in (select id from tech_tasks where title like 'td-t%' or title like 'Sửa CI đỏ: %')`);
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, "Sửa CI đỏ: %"));
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, "td-t%"));
    await db.delete(schema.users).where(eq(schema.users.id, "td-t-user"));
  }
}
