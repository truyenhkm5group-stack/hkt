import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { xetGhiNhanhViec } from "@/lib/constants/agent-branch-claim";
import { ingestAgentRun } from "@/lib/tech/agent-run-ingest";

/**
 * ═══════════ LỚP HÁ CHỤI LUẬT "NHÁNH AGENT VỀ TỚI DÒNG VIỆC" TRÊN CSDL THẬT ═══════════
 *
 * `lib/constants/agent-branch-claim.ts` có bài kiểm hàm thuần `xetGhiNhanhViec()` với nhiều ca
 * lẻ. Bài này kiểm tranh chấp thực tế trên CSDL: hai lượt chạy nối tiếp trên cùng MỘT việc,
 * mỗi lượt đẩy nhánh KHÁC, phải dẫn tới:
 *
 *  · Dòng việc PHẢI TRỎ NHÁNH MỚI (lượt sau thắng);
 *  · Sự kiện BRANCH ĐÚNG HAI SỰ KIỆN, KHÔNG PHẢI BA (không vết của phần xử lý lặp).
 *
 * Mốc thời gian đi theo đồng hồ thật (AGENTS.md mục 50 / 65). Dữ liệu tự dọn bằng tiền tố `tech-3-`.
 */

const TIEN_TO = "tech-3-";

export async function testNhanhAgentVeToiViec() {
  const db = await getDb();
  await cleanupBranchClaimFixtures();

  // ─────────── Dựng fixture ───────────
  const [agent] = await db
    .insert(schema.techAgents)
    .values({
      key: `${TIEN_TO}agent`,
      name: `${TIEN_TO}Agent-test`,
      role: "DOCUMENTATION",
      enabled: true,
      allowedRisks: ["R0"],
    })
    .returning({ id: schema.techAgents.id });

  const [task] = await db
    .insert(schema.techTasks)
    .values({
      code: `${TIEN_TO}TASK`,
      title: `${TIEN_TO}Bài kiểm hai nhánh`,
      status: "TRIAGED",
      risk: "R0",
      agentId: agent.id,
    })
    .returning({ id: schema.techTasks.id });

  // ─────────── Chuẩn bị dữ liệu chung cho hai lượt ───────────
  const gayCo = {
    agentKey: `${TIEN_TO}agent`,
    taskCode: `${TIEN_TO}TASK`,
    status: "SUCCEEDED" as const,
    baseCommit: "a".repeat(40),
    resultCommit: "b".repeat(40),
    summary: `${TIEN_TO}Tóm tắt`,
    filesChanged: [`docs/${TIEN_TO}file.md`],
    startedAt: new Date(Date.now() - 120_000),
  };

  // ─────────── Lượt chạy thứ nhất: đẩy nhánh A ───────────
  const nhanAMoi = `ai/documentation/${TIEN_TO}TASK-nhanh-A`;
  const lucEnded1 = new Date(Date.now() - 60_000);
  const ket1 = await ingestAgentRun({
    ...gayCo,
    externalRef: `${TIEN_TO}gh:900001:1`,
    branch: nhanAMoi,
    endedAt: lucEnded1,
    gates: { typecheck: "PASSED", lint: "PASSED", test: "PASSED", build: "PASSED" },
  });

  assert.ok("ok" in ket1 && ket1.ok, `lượt 1 phải ghi được: ${JSON.stringify(ket1)}`);
  assert.ok("ok" in ket1 && ket1.created, "lượt 1 phải là TẠO MỚI");
  assert.ok("nhanhViec" in ket1 && ket1.nhanhViec?.ghi === true, "lượt 1 phải ghi nhánh");

  // Kiểm dòng việc sau lượt 1
  let tsk = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.id, task.id),
    columns: { id: true, branch: true, status: true },
  });
  assert.equal(tsk!.branch, nhanAMoi, "dòng việc phải trỏ nhánh A sau lượt 1");

  // Kiểm sự kiện sau lượt 1: phải có đúng 1 sự kiện BRANCH
  let skBranch = await db.query.techTaskEvents.findMany({
    where: eq(schema.techTaskEvents.taskId, task.id),
    columns: { kind: true, previousValue: true, nextValue: true, actorKind: true, createdAt: true },
  });
  const sk1Branch = skBranch.filter((x) => x.kind === "BRANCH");
  assert.equal(
    sk1Branch.length,
    1,
    `sau lượt 1 phải có đúng 1 sự kiện BRANCH, hiện có ${sk1Branch.length}`,
  );
  assert.equal(sk1Branch[0].previousValue, "", "sự kiện BRANCH lượt 1: từ rỗng");
  assert.equal(sk1Branch[0].nextValue, nhanAMoi, "sự kiện BRANCH lượt 1: sang nhánh A");

  // ─────────── Lượt chạy thứ hai: đẩy nhánh B (khác A), cùng mã việc ───────────
  const nhanBMoi = `ai/documentation/${TIEN_TO}TASK-nhanh-B`;
  const lucEnded2 = new Date(Date.now() - 30_000);
  const ket2 = await ingestAgentRun({
    ...gayCo,
    externalRef: `${TIEN_TO}gh:900002:1`, // External ref KHÁC (attempt 2 hoặc lượt chạy khác)
    branch: nhanBMoi,
    endedAt: lucEnded2,
    gates: { typecheck: "PASSED", lint: "PASSED", test: "PASSED", build: "PASSED" },
  });

  assert.ok("ok" in ket2 && ket2.ok, `lượt 2 phải ghi được: ${JSON.stringify(ket2)}`);
  assert.ok("ok" in ket2 && ket2.created, "lượt 2 phải là TẠO MỚI (external ref khác)");
  assert.ok("nhanhViec" in ket2 && ket2.nhanhViec?.ghi === true, "lượt 2 phải ghi nhánh");

  // Kiểm dòng việc sau lượt 2
  tsk = await db.query.techTasks.findFirst({
    where: eq(schema.techTasks.id, task.id),
    columns: { id: true, branch: true, status: true },
  });
  assert.equal(tsk!.branch, nhanBMoi, "dòng việc PHẢI TRỎ NHÁNH B sau lượt 2 — lượt sau thắng");
  assert.notEqual(
    tsk!.branch,
    nhanAMoi,
    "nhánh A PHẢI BỊ THAY thế, không còn trỏ A nữa",
  );

  // ─────────── KIỂM TRA CHÍNH: SỰ KIỆN BRANCH ĐÚNG HAI, KHÔNG PHẢI BA ───────────
  skBranch = await db.query.techTaskEvents.findMany({
    where: eq(schema.techTaskEvents.taskId, task.id),
    columns: { kind: true, previousValue: true, nextValue: true, actorKind: true, createdAt: true },
  });

  const skBranchAll = skBranch.filter((x) => x.kind === "BRANCH");
  assert.equal(
    skBranchAll.length,
    2,
    `CHÍNH: sau cả hai lượt phải có ĐỨC HAI sự kiện BRANCH, không phải ba. Hiện có ${skBranchAll.length}`,
  );

  // Sự kiện BRANCH thứ nhất
  assert.equal(skBranchAll[0].previousValue, "", "sự kiện BRANCH 1: từ rỗng");
  assert.equal(skBranchAll[0].nextValue, nhanAMoi, "sự kiện BRANCH 1: sang nhánh A");
  assert.equal(skBranchAll[0].actorKind, "SYSTEM", "sự kiện BRANCH 1: hành động của máy");

  // Sự kiện BRANCH thứ hai
  assert.equal(skBranchAll[1].previousValue, nhanAMoi, "sự kiện BRANCH 2: từ nhánh A");
  assert.equal(skBranchAll[1].nextValue, nhanBMoi, "sự kiện BRANCH 2: sang nhánh B");
  assert.equal(skBranchAll[1].actorKind, "SYSTEM", "sự kiện BRANCH 2: hành động của máy");

  // Mốc thời gian phải tăng dần (đồng hồ thật)
  const t1 = skBranchAll[0].createdAt!.getTime();
  const t2 = skBranchAll[1].createdAt!.getTime();
  assert.ok(t2 >= t1, "mốc thời gian sự kiện BRANCH 2 phải >= sự kiện 1 (theo đồng hồ thật)");

  // ─────────── Kiểm tra luật thuần ───────────
  // Chắc chắn rằng hàm thuần cũng khuyến cáo ghi cho cả hai trường hợp này
  const luatA = xetGhiNhanhViec({ hienTai: "", moi: nhanAMoi });
  assert.ok(luatA.ghi, "luật thuần: ô rỗng, nhánh A → phải ghi");

  const luatB = xetGhiNhanhViec({ hienTai: nhanAMoi, moi: nhanBMoi });
  assert.ok(luatB.ghi, "luật thuần: nhánh A cũ, nhánh B mới (cùng tiền tố agent) → phải ghi");

  // Dọn dữ liệu
  await cleanupBranchClaimFixtures();

  console.log(
    `✓ Nhánh agent về dòng việc: hai lượt chạy nối tiếp · lượt sau đẩy nhánh khác · dòng việc trỏ nhánh mới · đúng HAI sự kiện BRANCH (không ba)`,
  );
}

async function cleanupBranchClaimFixtures() {
  const db = await getDb();

  // Xoá sự kiện trước
  const tasks = await db.query.techTasks.findMany({
    where: like(schema.techTasks.code, `${TIEN_TO}%`),
    columns: { id: true },
  });
  if (tasks.length) {
    await db
      .delete(schema.techTaskEvents)
      .where(eq(schema.techTaskEvents.taskId, tasks[0].id));
  }

  // Xoá lượt chạy
  const agents = await db.query.techAgents.findMany({
    where: like(schema.techAgents.key, `${TIEN_TO}%`),
    columns: { id: true },
  });
  if (agents.length) {
    await db
      .delete(schema.techAgentRuns)
      .where(eq(schema.techAgentRuns.agentId, agents[0].id));
  }

  // Xoá việc
  if (tasks.length) {
    await db.delete(schema.techTasks).where(eq(schema.techTasks.id, tasks[0].id));
  }

  // Xoá agent
  if (agents.length) {
    await db.delete(schema.techAgents).where(eq(schema.techAgents.id, agents[0].id));
  }
}
