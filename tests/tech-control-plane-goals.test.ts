import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  canTransitionTechTask,
  TECH_OWNER_ESCALATIONS,
  TECH_TASK_STATUSES,
  TECH_TASK_TERMINAL,
  TECH_TASK_TRANSITIONS,
  type TechTaskStatus,
} from "@/lib/constants/tech";
import {
  canonicalTaskState,
  CANONICAL_TASK_STATES,
  countOpenDependencies,
  deriveMissionExecution,
  missionDoneBlockers,
  STORED_TO_CANONICAL,
  TECH_EVENT_NAME_PATTERN,
  TECH_EVENT_NAMES,
  TECH_GOAL_STATUSES,
  TECH_GOAL_TRANSITIONS,
  TECH_MISSION_STATUSES,
  TECH_MISSION_TRANSITIONS,
  TECH_PROJECT_KEY_PATTERN,
  TECH_SEED_PROJECTS,
  type CanonicalTaskState,
} from "@/lib/constants/tech-control-plane";
import { getTechMission, listTechGoals, listTechProjects, techNeedsOwnerQueue } from "@/lib/queries/tech-control-plane";
import {
  attachTechTaskToMission,
  createTechGoal,
  createTechMission,
  recordTechEvent,
  setTechGoalStatus,
  setTechMissionStatus,
} from "@/lib/tech/control-plane";
import { createTechTask, setTechTaskStatus, type TechActor } from "@/lib/tech/service";

/**
 * ═══════════ MẶT PHẲNG ĐIỀU KHIỂN CÔNG TY — GOAL · MISSION · NEEDS_OWNER (0225) ═══════════
 *
 * docs/tech-control-plane/README.md. Bài này khoá:
 *  1. Vòng đời chuẩn là PHÉP CHIẾU đủ mọi trạng thái lưu, phụ thuộc chưa xong không bao giờ "sẵn sàng".
 *  2. Trạng thái thi hành của sứ mệnh SUY RA, ưu tiên "chờ chủ shop" trên mọi thứ khác.
 *  3. Agent không tự cấp phép thi hành (không bật mục tiêu / sứ mệnh, không tự gỡ NEEDS_OWNER, không huỷ việc).
 *  4. NEEDS_OWNER luôn mang đúng một trong chín lý do + việc phải làm — cả ở luật lẫn CHECK CSDL.
 *  5. Bỏ mục tiêu thì huỷ luôn sứ mệnh còn mở; chốt sứ mệnh đòi mọi việc kết thúc và ít nhất một việc xong.
 * Mốc thời gian theo đồng hồ thật (AGENTS.md mục 50). Dữ liệu tự dọn bằng tiền tố `tcp-t-`.
 */

const goc = path.resolve(__dirname, "..");
const MIGRATION = readFileSync(path.join(goc, "drizzle/0225_tech_control_plane_goals.sql"), "utf8");

/* ═════════════════════ 1. HÀM THUẦN ═════════════════════ */

export function testTechControlPlaneVocabulary() {
  // 1.1 Phép chiếu phủ ĐỦ mọi trạng thái lưu (bảng `Record` đã ép ở mức kiểu; ở đây ép ở mức giá trị).
  for (const s of TECH_TASK_STATUSES) assert.ok(CANONICAL_TASK_STATES.includes(STORED_TO_CANONICAL[s]), `${s} phải chiếu sang một trạng thái chuẩn`);
  // Mọi trạng thái chuẩn đều có thể xuất hiện (không trạng thái chết trên màn hình).
  const coThe = new Set<CanonicalTaskState>(Object.values(STORED_TO_CANONICAL));
  coThe.add("CLAIMED");
  assert.deepEqual(CANONICAL_TASK_STATES.filter((s) => !coThe.has(s)), [], "trạng thái chuẩn nào cũng phải có đường xuất hiện");

  // 1.2 Phụ thuộc + lease.
  assert.equal(canonicalTaskState({ status: "SPEC_READY" }), "READY");
  assert.equal(canonicalTaskState({ status: "SPEC_READY", openDependencies: 1 }), "BACKLOG", "còn phụ thuộc chưa xong thì KHÔNG sẵn sàng");
  assert.equal(canonicalTaskState({ status: "SPEC_READY", openDependencies: null }), "READY", "chưa đọc phụ thuộc ≠ có phụ thuộc mở");
  assert.equal(canonicalTaskState({ status: "SPEC_READY", leaseActive: true }), "CLAIMED");
  assert.equal(canonicalTaskState({ status: "BUILDING", leaseActive: true }), "RUNNING");
  assert.equal(canonicalTaskState({ status: "READY_TO_DEPLOY" }), "DEPLOYING");
  assert.equal(canonicalTaskState({ status: "OBSERVING" }), "VERIFYING");
  assert.equal(canonicalTaskState({ status: "ROLLED_BACK" }), "FAILED");

  const st = new Map<string, TechTaskStatus>([["a", "DONE"], ["b", "CANCELLED"], ["c", "BUILDING"]]);
  assert.equal(countOpenDependencies(["a"], st), 0);
  assert.equal(countOpenDependencies(["b"], st), 1, "phụ thuộc vào việc ĐÃ HUỶ không tự mở khoá — huỷ ≠ xong");
  assert.equal(countOpenDependencies(["zz"], st), 1, "phụ thuộc mất dấu KHÔNG được coi là xong");
  assert.equal(countOpenDependencies(["a", "c", "zz"], st), 2);

  // 1.3 Trạng thái thi hành suy ra: chờ chủ shop thắng mọi thứ; rỗng là rỗng, không phải 0%.
  const rong = deriveMissionExecution([]);
  assert.equal(rong.state, "EMPTY");
  assert.equal(rong.progressPct, null, "chưa có việc thì tiến độ là CHƯA BIẾT, không phải 0%");
  assert.equal(deriveMissionExecution(["RUNNING", "NEEDS_OWNER", "FAILED"]).state, "NEEDS_OWNER");
  assert.equal(deriveMissionExecution(["RUNNING", "FAILED"]).state, "FAILED");
  assert.equal(deriveMissionExecution(["RUNNING", "BLOCKED"]).state, "BLOCKED");
  assert.equal(deriveMissionExecution(["READY", "CLAIMED"]).state, "RUNNING");
  assert.equal(deriveMissionExecution(["READY", "BACKLOG"]).state, "READY");
  assert.equal(deriveMissionExecution(["DONE", "CANCELLED"]).state, "COMPLETE");
  const tienDo = deriveMissionExecution(["DONE", "DONE", "RUNNING", "CANCELLED"]);
  assert.equal(tienDo.progressPct, 67, "việc huỷ không nằm trong mẫu số tiến độ");
  assert.equal(deriveMissionExecution(["CANCELLED"]).progressPct, null);

  // 1.4 Chốt sứ mệnh.
  assert.equal(missionDoneBlockers([]).length, 1);
  assert.equal(missionDoneBlockers(["DONE", "BUILDING"]).length, 1, "còn việc mở thì không chốt");
  assert.equal(missionDoneBlockers(["CANCELLED"]).length, 1, "toàn việc huỷ thì không phải xong");
  assert.deepEqual(missionDoneBlockers(["DONE", "CANCELLED"]), []);

  // 1.5 NEEDS_OWNER không phải lối tắt tới deploy; huỷ không áp dụng cho thứ đã lên production.
  for (const to of ["READY_TO_DEPLOY", "DEPLOYING", "OBSERVING", "DONE"] as TechTaskStatus[]) {
    assert.ok(!canTransitionTechTask("NEEDS_OWNER", to), `NEEDS_OWNER → ${to} là lách cổng deploy`);
  }
  assert.ok(!canTransitionTechTask("DEPLOYING", "CANCELLED"));
  assert.ok(!canTransitionTechTask("OBSERVING", "CANCELLED"));
  for (const s of TECH_TASK_STATUSES) {
    if (TECH_TASK_TERMINAL.includes(s)) continue;
    assert.ok(TECH_TASK_TRANSITIONS[s].includes("NEEDS_OWNER") || s === "NEEDS_OWNER", `${s}: phải gọi chủ shop được từ mọi trạng thái mở`);
  }

  // 1.6 Goal / Mission: trạng thái kết thúc không đi đâu; mọi trạng thái tới được từ trạng thái đầu.
  for (const [ten, statuses, map, dau] of [
    ["goal", TECH_GOAL_STATUSES, TECH_GOAL_TRANSITIONS, "DRAFT"],
    ["mission", TECH_MISSION_STATUSES, TECH_MISSION_TRANSITIONS, "PLANNING"],
  ] as const) {
    const toi = new Set<string>([dau]);
    for (let i = 0; i < statuses.length; i += 1) for (const f of [...toi]) for (const t of (map as Record<string, readonly string[]>)[f]) toi.add(t);
    assert.deepEqual(statuses.filter((s) => !toi.has(s)), [], `${ten}: trạng thái không tới được`);
  }

  // 1.7 Mã nguồn và migration nói CÙNG một danh sách — một CHECK lệch hằng số là một trạng thái không ghi được.
  const checkStatus = /"tech_tasks_status_check" CHECK \("tech_tasks"\."status" IN \(([^)]+)\)\)/.exec(MIGRATION);
  assert.ok(checkStatus, "migration phải mở rộng CHECK trạng thái việc");
  assert.deepEqual(checkStatus![1].split(",").map((x) => x.trim().replace(/'/g, "")), [...TECH_TASK_STATUSES]);
  const checkOwner = /"tech_tasks_needs_owner_check" CHECK \(.*?"owner_escalation" IN \(([^)]+)\)/.exec(MIGRATION);
  assert.ok(checkOwner, "migration phải có CHECK cho NEEDS_OWNER");
  assert.deepEqual(checkOwner![1].split(",").map((x) => x.trim().replace(/'/g, "")), [...TECH_OWNER_ESCALATIONS]);
  for (const p of TECH_SEED_PROJECTS) {
    assert.match(p.key, TECH_PROJECT_KEY_PATTERN);
    assert.ok(MIGRATION.includes(`'${p.key}', '${p.name}'`), `migration phải gieo dự án ${p.key}`);
  }
  for (const n of TECH_EVENT_NAMES) assert.match(n, TECH_EVENT_NAME_PATTERN);
  assert.ok(MIGRATION.includes("ON CONFLICT (\"key\") DO NOTHING"), "gieo dự án phải chạy lại được mà không đè dòng người đã sửa");
  assert.ok(!/\bUPDATE\s+"tech_tasks"/i.test(MIGRATION), "migration KHÔNG được ghi lại dữ liệu việc cũ");

  console.log(`✓ Mặt phẳng điều khiển: ${TECH_TASK_STATUSES.length} trạng thái lưu → ${CANONICAL_TASK_STATES.length} trạng thái chuẩn, phụ thuộc chặn READY, "chờ chủ shop" ưu tiên nhất, CHECK khớp hằng số`);
}

/* ═════════════════════ 2. CSDL — LUẬT GHI ═════════════════════ */

export async function testTechControlPlaneGoalsDb() {
  const db = await getDb();
  const [nguoi] = await db
    .insert(schema.users)
    .values({ id: "tcp-t-user", email: "tcp-t@shop.vn", name: "Chủ shop (kiểm thử CP)", passwordHash: "x", role: "ADMIN" })
    .onConflictDoNothing()
    .returning({ id: schema.users.id });
  const userId = nguoi?.id ?? "tcp-t-user";
  const chuShop: TechActor = { kind: "HUMAN", id: userId, name: "Chủ shop (kiểm thử CP)" };
  const may: TechActor = { kind: "SYSTEM", name: "job:tcp-test" };
  const agent: TechActor = { kind: "AI_AGENT", agentId: null, name: "planner (kiểm thử)" };
  const taskIds: string[] = [];

  try {
    // 2.1 Dự án gieo sẵn.
    const projects = await listTechProjects();
    for (const p of TECH_SEED_PROJECTS) assert.ok(projects.some((x) => x.key === p.key), `thiếu dự án gieo sẵn ${p.key}`);

    // 2.2 Mục tiêu: agent chỉ tạo nháp, không bật được; người bật.
    const agentBat = await createTechGoal({ title: "tcp-t mục tiêu agent tự bật", priority: "P2", activate: true }, agent);
    assert.ok("error" in agentBat, "agent KHÔNG được tạo mục tiêu ở trạng thái đang chạy");
    const g = await createTechGoal({ title: "tcp-t ChotDonTuDong sẵn sàng cho 10 khách trả tiền đầu tiên", priority: "P1", project: "chotdon" }, agent);
    assert.ok("ok" in g, JSON.stringify(g));
    const goalId = (g as { id: string }).id;
    assert.ok("error" in (await setTechGoalStatus({ goalId, to: "ACTIVE" }, agent)), "agent không đổi trạng thái mục tiêu");
    assert.ok("error" in (await setTechGoalStatus({ goalId, to: "ACTIVE" }, may)), "máy không đổi trạng thái mục tiêu");

    // 2.3 Sứ mệnh dưới mục tiêu NHÁP không bật được.
    const m1 = await createTechMission({ title: "tcp-t Thu phí gói đầu tiên", priority: "P1", goalId }, agent);
    assert.ok("ok" in m1, JSON.stringify(m1));
    const m1Id = (m1 as { id: string }).id;
    const m1Row = await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, m1Id) });
    assert.equal(m1Row?.projectId, projects.find((p) => p.key === "chotdon")?.id, "sứ mệnh kế thừa dự án của mục tiêu");
    const batSom = await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, chuShop);
    assert.ok("error" in batSom && batSom.error.includes("GOAL-"), "mục tiêu chưa bật thì sứ mệnh không chạy");
    assert.ok("ok" in (await setTechGoalStatus({ goalId, to: "ACTIVE" }, chuShop)));
    assert.ok("error" in (await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, agent)), "agent không tự bật sứ mệnh");
    assert.ok("error" in (await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, may)), "máy không bật sứ mệnh — chỉ dừng / chốt");
    assert.ok("ok" in (await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, chuShop)));
    const lai = await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, chuShop);
    assert.ok("ok" in lai && lai.skipped, "bấm lại đúng trạng thái đang có ⇒ bỏ qua, không ghi");
    assert.ok("ok" in (await setTechMissionStatus({ missionId: m1Id, to: "PAUSED" }, may)), "máy (watchdog / ngân sách) được đạp phanh");
    assert.ok("ok" in (await setTechMissionStatus({ missionId: m1Id, to: "ACTIVE" }, chuShop)));

    // 2.4 Việc trong sứ mệnh: tạo thẳng + gắn sau.
    const t1 = await createTechTask({ title: "tcp-t Viết tài liệu gói giá", taskType: "DOCS", module: "PLATFORM", priority: "P2", source: "OWNER", missionId: m1Id }, chuShop);
    assert.ok("ok" in t1, JSON.stringify(t1));
    const t1Id = (t1 as { id: string }).id;
    taskIds.push(t1Id);
    const t1Row = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1Id) });
    assert.equal(t1Row?.projectId, m1Row?.projectId, "việc kế thừa dự án của sứ mệnh");
    const t2 = await createTechTask({ title: "tcp-t Trang thanh toán", taskType: "FEATURE", module: "PLATFORM", priority: "P2", source: "OWNER", dependsOn: [t1Id] }, chuShop);
    const t2Id = (t2 as { id: string }).id;
    taskIds.push(t2Id);
    assert.ok("ok" in (await attachTechTaskToMission({ taskId: t2Id, missionId: m1Id }, chuShop)));
    assert.ok("ok" in (await attachTechTaskToMission({ taskId: t2Id, missionId: m1Id }, chuShop)) );
    const attachEvents = await db.select().from(schema.techEvents).where(eq(schema.techEvents.name, "mission.task_attached"));
    assert.equal(attachEvents.filter((e) => e.taskId === t2Id).length, 1, "gắn lại đúng sứ mệnh cũ không đẻ sự kiện thứ hai");

    // t2 phụ thuộc t1 ⇒ dù đã đặc tả xong vẫn là tồn đọng.
    for (const to of ["TRIAGED", "SPEC_READY"] as const) assert.ok("ok" in (await setTechTaskStatus({ taskId: t2Id, to }, chuShop)));
    let chiTiet = (await getTechMission(m1Id))!;
    assert.equal(chiTiet.tasks.find((t) => t.id === t2Id)?.canonical, "BACKLOG", "phụ thuộc chưa xong ⇒ BACKLOG, không READY");

    // 2.5 NEEDS_OWNER — luật.
    const thieuLy = await setTechTaskStatus({ taskId: t1Id, to: "NEEDS_OWNER", ownerAction: "Đăng nhập Meta và cấp quyền pages_messaging" }, agent);
    assert.ok("error" in thieuLy, "thiếu lý do thì không gọi chủ shop được");
    const thieuViec = await setTechTaskStatus({ taskId: t1Id, to: "NEEDS_OWNER", ownerEscalation: "EXTERNAL_AUTH_REQUIRED", ownerAction: "xem" }, agent);
    assert.ok("error" in thieuViec, "câu hướng dẫn phải đủ để làm theo");
    const goi = await setTechTaskStatus(
      { taskId: t1Id, to: "NEEDS_OWNER", ownerEscalation: "EXTERNAL_AUTH_REQUIRED", ownerAction: "Đăng nhập Meta App Dashboard và cấp quyền pages_messaging" },
      agent,
    );
    assert.ok("ok" in goi, JSON.stringify(goi));
    chiTiet = (await getTechMission(m1Id))!;
    assert.equal(chiTiet.execution.state, "NEEDS_OWNER", "sứ mệnh có việc chờ chủ shop thì in đúng câu đó");
    const hang = await techNeedsOwnerQueue();
    const dong = hang.find((x) => x.id === t1Id);
    assert.ok(dong && dong.ownerAction.includes("pages_messaging") && dong.mission?.id === m1Id, "hàng Cần chủ shop phải có việc kèm hướng dẫn và sứ mệnh");
    assert.ok("error" in (await setTechTaskStatus({ taskId: t1Id, to: "TRIAGED", note: "agent tự gỡ" }, agent)), "agent KHÔNG tự gỡ NEEDS_OWNER");
    assert.ok("error" in (await setTechTaskStatus({ taskId: t1Id, to: "TRIAGED" }, chuShop)), "gỡ phải ghi chủ shop đã làm gì");
    assert.ok("ok" in (await setTechTaskStatus({ taskId: t1Id, to: "TRIAGED", note: "Đã cấp quyền trên Meta" }, chuShop)));
    const sauGo = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, t1Id) });
    assert.equal(sauGo?.ownerAction, "", "rời NEEDS_OWNER thì xoá câu hướng dẫn cũ — lần gọi sau không được hiện câu cũ");
    assert.equal(sauGo?.ownerEscalation, "");

    // CHECK ở CSDL đứng sau luật: ghi thẳng NEEDS_OWNER không lý do phải hỏng.
    let checkChan = false;
    try {
      await db.update(schema.techTasks).set({ status: "NEEDS_OWNER" }).where(eq(schema.techTasks.id, t1Id));
    } catch {
      checkChan = true;
    }
    assert.ok(checkChan, "CHECK tech_tasks_needs_owner_check phải chặn NEEDS_OWNER thiếu lý do");

    // 2.6 Huỷ: chỉ người, có lý do.
    assert.ok("error" in (await setTechTaskStatus({ taskId: t2Id, to: "CANCELLED", note: "agent thấy khó quá nên bỏ" }, agent)), "agent không tự bỏ việc");
    assert.ok("error" in (await setTechTaskStatus({ taskId: t2Id, to: "CANCELLED", note: "bỏ" }, chuShop)), "huỷ phải nói vì sao");

    // 2.7 Chốt sứ mệnh: còn việc mở ⇒ chặn; đưa t1 tới DONE theo đúng đường, huỷ t2 ⇒ được.
    assert.ok("error" in (await setTechMissionStatus({ missionId: m1Id, to: "DONE", note: "xong hết rồi nhé" }, chuShop)), "còn việc mở thì chưa chốt");
    for (const to of ["BUILDING", "REVIEW", "QA", "READY_TO_DEPLOY", "DEPLOYING", "OBSERVING"] as const) {
      const r = await setTechTaskStatus({ taskId: t1Id, to }, chuShop);
      assert.ok("ok" in r, `${to}: ${JSON.stringify(r)}`);
    }
    assert.ok("ok" in (await setTechTaskStatus({ taskId: t1Id, to: "DONE", note: "Tài liệu, không có gì chạy trên production" }, chuShop)));
    chiTiet = (await getTechMission(m1Id))!;
    assert.equal(chiTiet.tasks.find((t) => t.id === t2Id)?.canonical, "READY", "phụ thuộc xong ⇒ việc sau tự thành READY, không cần ai ghi gì");
    assert.ok("ok" in (await setTechTaskStatus({ taskId: t2Id, to: "CANCELLED", note: "Chủ shop đổi hướng, làm ở sứ mệnh khác" }, chuShop)));
    assert.ok("error" in (await attachTechTaskToMission({ taskId: t2Id, missionId: null }, chuShop)), "việc đã kết thúc không đổi sứ mệnh");
    assert.ok("error" in (await setTechMissionStatus({ missionId: m1Id, to: "DONE", note: "ngắn" }, chuShop)), "chốt sứ mệnh phải có câu kết quả");
    assert.ok("ok" in (await setTechMissionStatus({ missionId: m1Id, to: "DONE", note: "Tài liệu gói giá đã lên, trang thanh toán dời sang sứ mệnh sau" }, chuShop)));
    chiTiet = (await getTechMission(m1Id))!;
    assert.equal(chiTiet.execution.state, "COMPLETE");
    assert.equal(chiTiet.execution.progressPct, 100);
    assert.ok("error" in (await createTechTask({ title: "tcp-t việc vào sứ mệnh đã chốt", taskType: "DOCS", module: "PLATFORM", priority: "P3", source: "OWNER", missionId: m1Id }, chuShop)));

    // 2.8 Mục tiêu: còn sứ mệnh mở ⇒ không "đạt"; bỏ mục tiêu ⇒ huỷ dây chuyền sứ mệnh còn mở.
    const m2 = await createTechMission({ title: "tcp-t Onboarding khách thứ nhất", priority: "P2", goalId }, chuShop);
    const m2Id = (m2 as { id: string }).id;
    assert.ok("error" in (await setTechGoalStatus({ goalId, to: "ACHIEVED", note: "Đã có 10 khách trả tiền" }, chuShop)), "còn sứ mệnh mở thì chưa đạt");
    const goals = await listTechGoals();
    const gl = goals.find((x) => x.id === goalId)!;
    assert.equal(gl.missionCount, 2);
    assert.equal(gl.openMissionCount, 1);
    assert.equal(gl.execution.done, 1, "tiến độ mục tiêu gộp việc của mọi sứ mệnh");
    const bo = await setTechGoalStatus({ goalId, to: "ABANDONED", note: "Đổi chiến lược: bán qua đại lý trước" }, chuShop);
    assert.ok("ok" in bo && bo.cancelledMissions === 1, JSON.stringify(bo));
    const m2Row = await db.query.techMissions.findFirst({ where: eq(schema.techMissions.id, m2Id) });
    assert.equal(m2Row?.status, "CANCELLED", "bỏ mục tiêu thì sứ mệnh còn mở phải dừng — không ai làm việc cho thứ đã bỏ");
    assert.ok((m2Row?.outcomeNote ?? "").includes("GOAL-"), "sứ mệnh bị huỷ dây chuyền phải nói vì mục tiêu nào");

    // 2.9 Luồng sự kiện: đủ dòng, đúng người, gửi lại cùng khoá không nhân đôi.
    const ev = await db.select().from(schema.techEvents).where(eq(schema.techEvents.goalId, goalId));
    const ten = ev.map((e) => e.name);
    for (const n of ["goal.created", "goal.status_changed", "mission.created", "mission.status_changed", "mission.task_attached"]) {
      assert.ok(ten.includes(n), `thiếu sự kiện ${n}`);
    }
    assert.equal(ev.find((e) => e.name === "goal.created")?.actorKind, "AI_AGENT", "mục tiêu do planner tạo ⇒ ghi là agent, không phải người");
    const k1 = await recordTechEvent(db, { name: "goal.status_changed", subjectType: "GOAL", subjectId: goalId, goalId, dedupeKey: "tcp-t-dedupe" }, may);
    const k2 = await recordTechEvent(db, { name: "goal.status_changed", subjectType: "GOAL", subjectId: goalId, goalId, dedupeKey: "tcp-t-dedupe" }, may);
    assert.ok(k1 && k2 === null, "cùng khoá chống trùng ⇒ một dòng");
    await assert.rejects(() => recordTechEvent(db, { name: "goal.lam_bua" as never, subjectType: "GOAL", subjectId: goalId }, may), "tên chưa khai phải ném lỗi");

    console.log("✓ Goal/Mission: agent không tự cấp phép thi hành, NEEDS_OWNER đòi lý do + việc (luật + CHECK), chỉ người gỡ / huỷ, phụ thuộc tự mở khoá, bỏ mục tiêu huỷ dây chuyền, sự kiện đủ và không trùng");
  } finally {
    await db.delete(schema.techEvents).where(sql`${schema.techEvents.goalId} in (select id from tech_goals where title like 'tcp-t%') or ${schema.techEvents.dedupeKey} = 'tcp-t-dedupe'`);
    if (taskIds.length) {
      await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, taskIds));
      await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, taskIds));
    }
    await db.delete(schema.techTasks).where(like(schema.techTasks.title, "tcp-t%"));
    await db.delete(schema.techMissions).where(like(schema.techMissions.title, "tcp-t%"));
    await db.delete(schema.techGoals).where(like(schema.techGoals.title, "tcp-t%"));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
}
