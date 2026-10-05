import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  classifyWorktree,
  cleanupDecision,
  deriveTaskStatus,
  fileInPattern,
  findCycle,
  githubFacts,
  main,
  mergeEvidence,
  NO_FACTS,
  parseConfig,
  parseGithubRemote,
  patternsOverlap,
  planNext,
  readManifest,
  realDir,
  reconcileVerdict,
  renderBrief,
  validateMission,
  type Config,
  type DerivedTask,
  type Mission,
  type Task,
  type TaskFacts,
  type TaskStatus,
  type WorktreeFacts,
} from "../scripts/ai-tech";

/**
 * ═══════════ AI TECH ROOM — BỘ ĐIỀU PHỐI PHẢI AN TOÀN TRƯỚC KHI NÓ TIỆN ═══════════
 *
 * Hai lớp:
 *   · HÀM THUẦN — DAG, suy trạng thái, xếp lịch, phân loại cây, quyết định dọn, đối chiếu. Mỗi ô
 *     của bảng quyết định một khẳng định, không cần kho git nào.
 *   · VÒNG ĐỜI THẬT trên một kho git TẠM (bare origin + clone + clone thứ hai đóng vai `main` chạy
 *     tiếp). Không bao giờ chạm một worktree thật của máy: công cụ dựng cây cạnh cây chính, và cây
 *     chính ở đây nằm trong thư mục tạm.
 *
 * Không mốc thời gian tuyệt đối nào (AGENTS.md mục 50): "vừa dùng" đo bằng mtime THẬT của tệp vừa
 * ghi so với đồng hồ thật — cùng nhịp với thứ nó đo.
 */

const CFG: Config = {
  ...DEFAULT_CONFIG,
  hotspots: [
    { path: "drizzle/", rule: "SERIAL", reason: "số hiệu migration" },
    { path: "tests/sync-fixtures.test.ts", rule: "SHARED", reason: "nơi đăng ký bài kiểm" },
  ],
  riskFloor: [
    { path: "lib/queries/return-rate.ts", risk: "CRITICAL", reason: "ORDER_OUTCOME" },
    { path: "drizzle/", risk: "HIGH", reason: "migration" },
  ],
};

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    title: `Việc ${id}`,
    objective: "làm",
    mode: "WORKER",
    priority: "P2",
    risk: "LOW",
    dependsOn: [],
    owns: [`src/${id}.ts`],
    readOnly: [],
    doNotTouch: [],
    tests: ["npm run typecheck"],
    definitionOfDone: ["xanh"],
    ...over,
  };
}

const rawMission = (tasks: unknown[], over: Record<string, unknown> = {}) => ({ schema: 1, id: "m1", title: "M", goal: "G", tasks, ...over });

/* ═════════════ 1 · KIỂM TRA TỆP SỨ MỆNH ═════════════ */

function testValidation() {
  const ok = validateMission(rawMission([task("a"), task("b", { dependsOn: ["a"] })]), CFG);
  assert.deepEqual(ok.errors, [], "sứ mệnh hợp lệ không được báo lỗi");
  assert.ok(ok.mission);

  // Tên việc thành tên nhánh và đường dẫn: chuỗi lạ phải chết ở cửa, không bao giờ tới git.
  for (const bad of ["../x", "a;rm -rf ~", "$(whoami)", "Ab", "a b", "-x", "x-", ""]) {
    const v = validateMission(rawMission([task(bad)]), CFG);
    assert.ok(v.errors.some((e) => e.includes("id phải khớp")), `id "${bad}" phải bị từ chối`);
  }
  const badMissionId = validateMission({ ...rawMission([task("a")]), id: "../../etc" }, CFG);
  assert.ok(badMissionId.errors.some((e) => e.startsWith("id:")), "id sứ mệnh cũng phải là slug");

  const dup = validateMission(rawMission([task("a"), task("a")]), CFG);
  assert.ok(dup.errors.some((e) => e.includes("id trùng")));

  const slugClash = validateMission(rawMission([task("a"), task("b", { slug: "a" })]), CFG);
  assert.ok(slugClash.errors.some((e) => e.includes("tranh một tên nhánh")), "hai việc cùng slug sẽ tranh một nhánh");

  const missing = validateMission(rawMission([task("a", { dependsOn: ["khong-co"] })]), CFG);
  assert.ok(missing.errors.some((e) => e.includes("không tồn tại")));

  const self = validateMission(rawMission([task("a", { dependsOn: ["a"] })]), CFG);
  assert.ok(self.errors.some((e) => e.includes("tự phụ thuộc")));

  const cyc = validateMission(rawMission([task("a", { dependsOn: ["c"] }), task("b", { dependsOn: ["a"] }), task("c", { dependsOn: ["b"] })]), CFG);
  assert.ok(cyc.errors.some((e) => e.startsWith("chu trình phụ thuộc: ")), "chu trình phải được nêu tên");
  assert.deepEqual(findCycle([{ id: "x", dependsOn: ["y"] }, { id: "y", dependsOn: ["x"] }]), ["x", "y", "x"]);
  assert.equal(findCycle([{ id: "x", dependsOn: [] }, { id: "y", dependsOn: ["x"] }]), null);

  const noScope = validateMission(rawMission([task("a", { owns: [] })]), CFG);
  assert.ok(noScope.errors.some((e) => e.includes("phải khai owns")), "WORKER không khai phạm vi ghi thì không biết nó đụng ai");
  const inlineNoScope = validateMission(rawMission([task("a", { mode: "INLINE", owns: [], tests: [] })]), CFG);
  assert.deepEqual(inlineNoScope.errors, [], "việc INLINE không bắt buộc khai phạm vi");

  const escape = validateMission(rawMission([task("a", { owns: ["../ngoai-kho.ts"] })]), CFG);
  assert.ok(escape.errors.some((e) => e.includes("không hợp lệ")), "phạm vi không được thoát ra ngoài kho");
  const abs = validateMission(rawMission([task("a", { owns: ["C:/Windows/x"] })]), CFG);
  assert.ok(abs.errors.length > 0, "phạm vi không được là đường dẫn tuyệt đối");

  // Rủi ro chỉ NÂNG: khai LOW cho việc sửa ORDER_OUTCOME là tự mở cổng bằng cửa sau.
  const low = validateMission(rawMission([task("a", { owns: ["lib/queries/return-rate.ts"], risk: "HIGH" })]), CFG);
  assert.ok(low.errors.some((e) => e.includes("thấp hơn sàn CRITICAL")));
  const right = validateMission(rawMission([task("a", { owns: ["lib/queries/"], risk: "CRITICAL" })]), CFG);
  assert.deepEqual(right.errors, [], "thư mục chứa tệp CRITICAL cũng mang sàn CRITICAL — và khai đúng thì qua");

  const contra = validateMission(rawMission([task("a", { owns: ["lib/x/y.ts"], doNotTouch: ["lib/x/"] })]), CFG);
  assert.ok(contra.errors.some((e) => e.includes("tự mâu thuẫn")));
  const carve = validateMission(rawMission([task("a", { owns: ["lib/x/"], doNotTouch: ["lib/x/khoa.ts"] })]), CFG);
  assert.deepEqual(carve.errors, [], "khoét một tệp KHỎI phạm vi rộng là hợp lệ");

  // Chặn bởi chủ shop phải nói ĐÚNG việc họ cần làm; chặn bởi hợp đồng khác thì không cần chủ shop.
  const block = validateMission(rawMission([task("a", { decision: { state: "BLOCKED", category: "CREDENTIAL_REQUIRED", reason: "thiếu khoá" } })]), CFG);
  assert.ok(block.errors.some((e) => e.includes("ownerAction")));
  const ext = validateMission(rawMission([task("a", { decision: { state: "BLOCKED", category: "EXTERNAL_DEPENDENCY", reason: "chờ hợp đồng SalesEvent" } })]), CFG);
  assert.deepEqual(ext.errors, []);
  const done = validateMission(rawMission([task("a", { decision: { state: "DONE", evidence: "" } })]), CFG);
  assert.ok(done.errors.some((e) => e.includes("evidence")), "DONE phải có bằng chứng");

  const base = validateMission(rawMission([task("a"), task("b", { base: "a" })]), CFG);
  assert.ok(base.errors.some((e) => e.includes("base")), "dựng chồng lên một việc mà không phụ thuộc nó là sai");

  // Chồng phạm vi giữa hai việc CÓ THỂ chạy song song ⇒ cảnh báo; đã có thứ tự ⇒ im.
  const par = validateMission(rawMission([task("a", { owns: ["lib/x/"] }), task("b", { owns: ["lib/x/y.ts"] })]), CFG);
  assert.ok(par.warnings.some((w) => w.includes("a ↔ b")));
  const ser = validateMission(rawMission([task("a", { owns: ["lib/x/"] }), task("b", { owns: ["lib/x/y.ts"], dependsOn: ["a"] })]), CFG);
  assert.deepEqual(ser.warnings, []);
  const shared = validateMission(rawMission([task("a", { owns: ["tests/sync-fixtures.test.ts", "src/a.ts"] }), task("b", { owns: ["tests/sync-fixtures.test.ts", "src/b.ts"] })]), CFG);
  assert.deepEqual(shared.warnings, [], "điểm nóng SHARED (chỉ nối thêm) không làm hai việc phải tuần tự");
  const mig = validateMission(rawMission([task("a", { owns: ["drizzle/0200_a.sql"], risk: "HIGH" }), task("b", { owns: ["drizzle/0201_b.sql"], risk: "HIGH" })]), CFG);
  assert.ok(mig.warnings.some((w) => w.includes("SERIAL drizzle/")), "hai việc cùng thêm migration phải bị tuần tự hoá dù khác tệp");

  const cap = validateMission(rawMission([task("a")], { maxWorkers: 9 }), CFG);
  assert.ok(cap.errors.some((e) => e.includes("maxWorkers")), "sứ mệnh không được vượt trần của máy");

  const cfgBad = parseConfig({ maxImplementationWorkers: 50, branchPrefix: "Bad Prefix", hotspots: [{ path: "../x", rule: "SERIAL", reason: "r" }] });
  assert.equal(cfgBad.errors.length, 3);
  assert.deepEqual(parseConfig(undefined).errors, []);
  assert.equal(parseConfig({ integrationRef: "--all" }).errors.length, 1, "ref bắt đầu bằng - là một CỜ của git, không phải ref");
  assert.equal(parseConfig({ integrationRef: "HEAD" }).errors.length, 1);
  assert.ok(validateMission(rawMission([task("a")], { integrationRef: "-x" }), CFG).errors.some((e) => e.includes("integrationRef")));
}

/* ═════════════ 2 · PHẠM VI ═════════════ */

function testScopes() {
  assert.equal(patternsOverlap("lib/a", "lib/ab"), false, "ranh giới thư mục: lib/a không chứa lib/ab");
  assert.equal(patternsOverlap("lib/", "lib/x.ts"), true);
  assert.equal(patternsOverlap("lib/x.ts", "lib/x.ts"), true);
  assert.equal(patternsOverlap("lib/*.ts", "lib/sub/x.ts"), true, "mẫu đại diện BÁO THỪA — an toàn");
  assert.equal(patternsOverlap("app/a/", "app/b/"), false);
  assert.equal(patternsOverlap("*.md", "lib/x.ts"), true, "mẫu ở gốc phủ cả kho");
  assert.equal(fileInPattern("lib/sub/x.ts", "lib/*.ts"), false, "nhưng KHI ĐO tệp thật thì khớp chính xác");
  assert.equal(fileInPattern("lib/x.ts", "lib/*.ts"), true);
  assert.equal(fileInPattern("docs/a/b.md", "docs/**/*.md"), true);
  assert.equal(fileInPattern("docs/b.md", "docs/**/*.md"), true);
  assert.equal(fileInPattern("lib/ab.ts", "lib/a"), false);
  assert.equal(fileInPattern("lib/a/b.ts", "lib/a"), true);
  assert.equal(fileInPattern("drizzle/0001_x.sql", "drizzle/"), true);
}

/* ═════════════ 3 · SUY TRẠNG THÁI ═════════════ */

function testDerivedStatus() {
  const none = new Map<string, TaskStatus>();
  const f = (o: Partial<TaskFacts>): TaskFacts => ({ ...NO_FACTS, ...o });
  const run = { branch: "claude/a", worktree: "/x/wt-a", baseRef: "origin/main", baseSha: "b".repeat(40), createdAt: "lúc dựng" };
  const s = (t: Task, facts: TaskFacts = NO_FACTS, deps = none) => deriveTaskStatus(t, facts, deps).status;

  assert.equal(s(task("a")), "READY");
  assert.equal(s(task("a", { dependsOn: ["z"] }), NO_FACTS, new Map([["z", "RUNNING"]])), "BACKLOG");
  assert.equal(s(task("a", { dependsOn: ["z"] }), NO_FACTS, new Map([["z", "MERGED"]])), "READY");
  assert.equal(s(task("a", { dependsOn: ["z"] }), NO_FACTS, new Map([["z", "DONE"]])), "READY");
  assert.equal(s(task("a", { dependsOn: ["z"], base: "z" }), NO_FACTS, new Map([["z", "REVIEW"]])), "READY", "dựng chồng: phụ thuộc đã đẩy là đủ");
  assert.equal(s(task("a", { dependsOn: ["z"] }), NO_FACTS, new Map([["z", "REVIEW"]])), "BACKLOG", "không dựng chồng: phải chờ vào nhánh tích hợp");

  const wt = { worktreeExists: true, localBranch: true, tip: "t" };
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 0 })), "RUNNING", "cây mới, chưa commit");
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 2, dirty: 3 })), "RUNNING");
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 2, pushed: false })), "RUNNING", "commit chưa đẩy là việc còn ở trên máy");
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 2, pushed: true, remoteBranch: true })), "REVIEW");
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 2, dirty: -1 })), "RUNNING", "không đọc được trạng thái ≠ sạch");
  assert.equal(s(task("a", { run }), f({ remoteBranch: true, tip: "t", commits: 2 })), "REVIEW", "cây đã gỡ, nhánh còn trên remote");
  assert.equal(s(task("a", { run }), f({ localBranch: true, tip: "t", commits: 2 })), "ORPHANED", "nhánh chỉ còn ở máy, không cây");
  assert.equal(s(task("a", { run }), f({})), "ORPHANED", "tệp khai nói đang chạy nhưng git không còn gì");

  assert.equal(s(task("a", { run }), f({ ...wt, commits: 2, merged: "CONTENT" })), "MERGED");
  assert.equal(s(task("a", { run }), f({ ...wt, commits: 0, merged: "EMPTY" })), "RUNNING", "EMPTY không phải đã vào");
  assert.equal(s(task("a", { run, deploy: { sha: "abc1234", evidence: "run 1" } }), f({ merged: "ANCESTOR" })), "DEPLOYED");
  assert.equal(s(task("a", { decision: { state: "BLOCKED", category: "APPROVAL_REQUIRED", reason: "r", ownerAction: "duyệt" } })), "BLOCKED");
  assert.equal(
    s(task("a", { run, decision: { state: "BLOCKED", category: "APPROVAL_REQUIRED", reason: "r", ownerAction: "x" } }), f({ merged: "PR_SUBJECT" })),
    "MERGED",
    "đã vào thì lời khai BLOCKED cũ không giữ nó lại — git thắng",
  );
  assert.equal(s(task("a", { decision: { state: "CANCELLED", reason: "bỏ" } }), f({ merged: "ANCESTOR" })), "CANCELLED");
  assert.equal(s(task("a", { mode: "INLINE", decision: { state: "DONE", evidence: "commit abc" } })), "DONE");
}

/* ═════════════ 4 · XẾP LỊCH ═════════════ */

function derived(t: Task, status: TaskStatus): DerivedTask {
  return { task: t, status, why: "", facts: NO_FACTS };
}
const mission = (tasks: Task[], over: Partial<Mission> = {}): Mission => ({ schema: 1, id: "m1", title: "M", goal: "G", tasks, ...over });

function testScheduler() {
  const ts = ["a", "b", "c", "d", "e", "f"].map((id) => task(id));
  const all = ts.map((t) => derived(t, "READY"));
  const p = planNext(all, mission(ts), CFG, 0);
  assert.equal(p.launch.length, 4, "trần mặc định 4");
  assert.equal(p.hold.length, 2);
  assert.ok(p.hold.every((h) => h.reason.includes("đủ trần")));

  assert.equal(planNext(all, mission(ts, { maxWorkers: 2 }), CFG, 0).launch.length, 2, "sứ mệnh hạ trần được");
  assert.equal(planNext(all, mission(ts, { maxWorkers: 0 }), CFG, 0).launch.length, 0);
  assert.equal(planNext(all, mission(ts), CFG, 3).launch.length, 1, "worker của sứ mệnh KHÁC trên cùng máy chiếm chỗ");
  assert.equal(planNext(all, mission(ts), CFG, 9).launch.length, 0);

  // Ưu tiên rồi tới đường găng: việc mở khoá nhiều việc khác đi trước.
  const crit = [task("z", { priority: "P2" }), task("y", { priority: "P2" }), task("x", { priority: "P2", dependsOn: ["y"] }), task("w", { priority: "P0" })];
  const pc = planNext([derived(crit[0], "READY"), derived(crit[1], "READY"), derived(crit[2], "BACKLOG"), derived(crit[3], "READY")], mission(crit, { maxWorkers: 2 }), CFG, 0);
  assert.deepEqual(pc.launch.map((l) => l.id), ["w", "y"], "P0 trước, rồi việc mở khoá x");

  // Chồng phạm vi với việc đang chạy ⇒ NẰM LẠI dù còn chỗ.
  const o1 = task("o1", { owns: ["lib/x/"] });
  const o2 = task("o2", { owns: ["lib/x/y.ts"] });
  const o3 = task("o3", { owns: ["lib/z/"] });
  const po = planNext([derived(o1, "RUNNING"), derived(o2, "READY"), derived(o3, "READY")], mission([o1, o2, o3]), CFG, 1);
  assert.deepEqual(po.launch.map((l) => l.id), ["o3"]);
  assert.ok(po.hold.find((h) => h.id === "o2")?.reason.includes("chồng phạm vi với o1"));
  const pr = planNext([derived(o1, "REVIEW"), derived(o2, "READY")], mission([o1, o2]), CFG, 0);
  assert.equal(pr.launch.length, 0, "việc đang chờ PR vẫn giữ phạm vi của nó cho tới khi vào");

  // Hai ứng viên chồng nhau trong CÙNG một lượt: chỉ một đi.
  const q1 = task("q1", { owns: ["app/"] });
  const q2 = task("q2", { owns: ["app/x/"] });
  assert.equal(planNext([derived(q1, "READY"), derived(q2, "READY")], mission([q1, q2]), CFG, 0).launch.length, 1);

  // Điểm nóng SERIAL: khác tệp vẫn tuần tự.
  const m1 = task("m1", { owns: ["drizzle/0200_a.sql"], risk: "HIGH" });
  const m2 = task("m2", { owns: ["drizzle/0201_b.sql"], risk: "HIGH" });
  const pm = planNext([derived(m1, "RUNNING"), derived(m2, "READY")], mission([m1, m2]), CFG, 1);
  assert.ok(pm.hold[0]?.reason.includes("SERIAL"));

  // CRITICAL chạy một mình.
  const c = task("c", { risk: "CRITICAL", owns: ["lib/queries/return-rate.ts"] });
  const n = task("n");
  assert.equal(planNext([derived(c, "RUNNING"), derived(n, "READY")], mission([c, n]), CFG, 1).launch.length, 0);
  assert.equal(planNext([derived(n, "RUNNING"), derived(c, "READY")], mission([c, n]), CFG, 1).launch.length, 0, "CRITICAL không chen vào khi còn cây mở");
  const solo = planNext([derived(c, "READY"), derived(n, "READY")], mission([c, n]), CFG, 0);
  assert.equal(solo.launch.length, 1);

  // INLINE: Lead làm, không ăn chỗ worker — nhưng vẫn không chen vào phạm vi đang có người giữ.
  const i1 = task("i1", { mode: "INLINE", owns: ["docs/a.md"] });
  const pi = planNext([derived(i1, "READY"), ...ts.slice(0, 4).map((t) => derived(t, "READY"))], mission([i1, ...ts.slice(0, 4)]), CFG, 0);
  assert.deepEqual(pi.inline.map((x) => x.id), ["i1"]);
  assert.equal(pi.launch.length, 4);
  const i2 = task("i2", { mode: "INLINE", owns: ["lib/x/a.ts"] });
  assert.equal(planNext([derived(o1, "RUNNING"), derived(i2, "READY")], mission([o1, i2]), CFG, 1).inline.length, 0);

  // Hàm thuần: hai lần ra một kết quả.
  assert.deepEqual(planNext(all, mission(ts), CFG, 0), planNext(all, mission(ts), CFG, 0));
}

/* ═════════════ 5 · CÂY LÀM VIỆC: PHÂN LOẠI + DỌN ═════════════ */

function testWorktreePolicy() {
  const base: WorktreeFacts = {
    path: "/x/wt-a",
    head: "h",
    branch: "claude/a",
    detached: false,
    locked: false,
    prunable: false,
    isMain: false,
    isCurrent: false,
    owner: { mission: "m1", task: "a" },
    dirty: 0,
    uniqueLocal: 0,
    merged: "CONTENT",
    idleHours: 48,
    localSecrets: [],
  };
  const w = (o: Partial<WorktreeFacts>) => ({ ...base, ...o });
  const cls = (o: Partial<WorktreeFacts>) => classifyWorktree(w(o), CFG).cls;
  const can = (o: Partial<WorktreeFacts>, allowUnowned = false) => cleanupDecision(w(o), CFG, { allowUnowned });

  assert.equal(cls({}), "MERGED_SAFE_TO_CLEAN");
  assert.equal(cls({ isMain: true }), "MAIN");
  assert.equal(cls({ isCurrent: true }), "CURRENT");
  assert.equal(cls({ dirty: 2, merged: null }), "ACTIVE");
  assert.equal(cls({ dirty: 2, merged: null, idleHours: 24 * 30 }), "STALE_DIRTY");
  assert.equal(cls({ dirty: 2, idleHours: 24 * 30 }), "STALE_DIRTY", "đã vào nhưng còn thay đổi chưa commit: KHÔNG an toàn để dọn");
  assert.equal(cls({ merged: null, idleHours: 2 }), "ACTIVE");
  assert.equal(cls({ merged: null, idleHours: 48 }), "IDLE");
  assert.equal(cls({ merged: null, idleHours: 24 * 30 }), "STALE_CLEAN");
  assert.equal(cls({ merged: "CONTENT", uniqueLocal: 3, idleHours: 48 }), "IDLE", "đã vào theo nội dung nhưng còn commit chỉ ở máy");
  assert.equal(cls({ idleHours: 0.2 }), "ACTIVE", "vừa có người động thì KHÔNG BAO GIỜ là an toàn để dọn, dù đã vào");
  assert.equal(cls({ merged: "EMPTY" }), "MERGED_SAFE_TO_CLEAN", "không commit riêng nào + lâu không động: không có gì để mất");
  assert.equal(cls({ merged: "EMPTY", idleHours: 2 }), "ACTIVE");
  assert.equal(cls({ dirty: -1 }), "UNKNOWN");
  assert.equal(cls({ prunable: true }), "UNKNOWN");

  assert.equal(can({}).ok, true);
  assert.equal(can({}).deleteBranch, true);
  const refuse = (o: Partial<WorktreeFacts>, code: string, allow = false) => {
    const d = can(o, allow);
    assert.equal(d.ok, false, `${code} phải bị từ chối`);
    assert.ok(d.refusals.some((r) => r.startsWith(code)), `${code}: ${d.refusals.join(" | ")}`);
  };
  refuse({ isMain: true }, "MAIN");
  refuse({ isCurrent: true }, "CURRENT");
  refuse({ locked: true }, "LOCKED");
  refuse({ dirty: 1 }, "DIRTY");
  refuse({ dirty: -1 }, "UNKNOWN");
  refuse({ merged: null }, "NOT_MERGED");
  refuse({ uniqueLocal: 2 }, "UNPUSHED");
  refuse({ uniqueLocal: -1 }, "UNPUSHED?");
  refuse({ owner: null }, "UNOWNED");
  refuse({ owner: null, idleHours: 2 }, "UNOWNED_RECENT", true);
  refuse({ idleHours: 0.1 }, "RECENT");
  refuse({ idleHours: null }, "RECENT");
  refuse({ localSecrets: [".env.local"] }, "LOCAL_SECRETS");
  assert.equal(cleanupDecision(w({ idleHours: 0.1 }), { ...CFG, cleanupGraceMinutes: 0 }, { allowUnowned: false }).ok, true, "thời gian chờ chỉnh được — 0 là không chờ");
  refuse({ merged: "EMPTY", idleHours: 2 }, "EMPTY_BUT_RECENT");
  assert.equal(can({ owner: null, idleHours: 72 }, true).ok, true, "cây không rõ chủ, đã vào, sạch, lâu không động: dọn được KHI chủ shop cho phép");
  assert.equal(can({ merged: "EMPTY", idleHours: 72 }).ok, true, "cây của mình dựng rồi bỏ, không commit nào, lâu không động");
  assert.equal(can({ merged: "ANCESTOR", uniqueLocal: 1 }).ok, true, "đầu nhánh nằm trong nhánh tích hợp ⇒ không commit nào mất");
}

/* ═════════════ 6 · ĐỐI CHIẾU KHI MAIN CHẠY TIẾP ═════════════ */

function testReconcile() {
  const t = { owns: ["src/a.ts"], readOnly: ["lib/shared/"] };
  const v = (o: Partial<Parameters<typeof reconcileVerdict>[0]>) =>
    reconcileVerdict({ behind: 3, upstreamFiles: [], branchFiles: ["src/a.ts"], conflictFiles: [], task: t, ...o }, CFG).verdict;
  assert.equal(v({ behind: 0 }), "UP_TO_DATE");
  assert.equal(v({ upstreamFiles: ["docs/x.md"] }), "NO_EFFECT");
  assert.equal(v({ upstreamFiles: ["lib/shared/q.ts"] }), "AFFECTS_READ_ONLY");
  assert.equal(v({ upstreamFiles: ["tests/sync-fixtures.test.ts"] }), "SHARED_CONTRACT", "điểm nóng là hợp đồng chung");
  assert.equal(v({ upstreamFiles: ["src/a.ts"] }), "REQUIRES_REFRESH");
  assert.equal(v({ upstreamFiles: ["src/a.ts"], conflictFiles: ["src/a.ts"] }), "CONFLICTS");
  assert.equal(
    v({ upstreamFiles: ["drizzle/0300_main.sql"], branchFiles: ["drizzle/0300_minh.sql"] }),
    "CONFLICTS",
    "hai bên cùng thêm migration = trùng số, kể cả khi git merge sạch",
  );
  const mig = reconcileVerdict({ behind: 1, upstreamFiles: ["drizzle/0300_main.sql"], branchFiles: ["drizzle/0300_minh.sql"], conflictFiles: [], task: t }, CFG);
  assert.ok(mig.action.includes("migration:renumber"), "phải chỉ đúng công cụ đánh số lại đã có");
}

/* ═════════════ 7 · GITHUB CHỈ ĐỌC, LỖI KHÔNG LÀM HỎNG LỆNH ═════════════ */

async function testGithub() {
  assert.deepEqual(parseGithubRemote("https://github.com/truyenhkm5group-stack/hkt.git"), { owner: "truyenhkm5group-stack", repo: "hkt" });
  assert.deepEqual(parseGithubRemote("git@github.com:o/r.git"), { owner: "o", repo: "r" });
  assert.equal(parseGithubRemote("https://gitlab.com/o/r"), null);

  const seen: { url: string; auth?: string }[] = [];
  const fake = async (url: string, init: { headers: Record<string, string> }) => {
    seen.push({ url, auth: init.headers.Authorization });
    if (url.includes("/pulls?")) return { ok: true, status: 200, json: async () => [{ number: 7, state: "closed", merged_at: "x", draft: false, html_url: "u" }] };
    return { ok: true, status: 200, json: async () => ({ check_runs: [{ name: "gates / gates", status: "completed", conclusion: "success" }] }) };
  };
  const g = await githubFacts({ owner: "o", repo: "r" }, "claude/a b", "sha1", fake, null);
  assert.equal(g.pr?.number, 7);
  assert.equal(g.pr?.merged, true);
  assert.equal(g.checks[0].conclusion, "success");
  assert.ok(seen[0].url.includes(encodeURIComponent("o:claude/a b")), "tên nhánh phải được mã hoá trong URL");
  assert.equal(seen[0].auth, undefined, "không token thì không gửi Authorization");
  assert.ok(seen.every((s) => /^https:\/\/api\.github\.com\/repos\/o\/r\//.test(s.url)), "chỉ đọc đúng kho");

  const down = await githubFacts({ owner: "o", repo: "r" }, "b", null, async () => ({ ok: false, status: 503, json: async () => ({}) }), "t");
  assert.equal(down.error, "GitHub 503", "lỗi mạng trả error, không ném");
  const thrown = await githubFacts({ owner: "o", repo: "r" }, "b", null, async () => {
    throw new Error("mất mạng");
  }, null);
  assert.equal(thrown.error, "mất mạng");
}

/* ═════════════ 8 · MÃ NGUỒN KHÔNG CÓ ĐƯỜNG PHÁ ═════════════ */

function testSourceGuards() {
  const src = readFileSync(path.join(__dirname, "..", "scripts", "ai-tech.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(!/shell:\s*true/.test(src), "không chạy git qua shell");
  assert.ok(!/\bexecSync\b|\bexecFile\b|[^.\w]exec\(/.test(src), "chỉ spawnSync với mảng tham số (RegExp.exec thì được)");
  assert.ok(!src.includes('"--force"') && !src.includes("'--force'") && !/"-f"/.test(src), "không --force ở bất kỳ lệnh git nào");
  assert.ok(!/"push"/.test(src), "công cụ không tự đẩy gì lên remote");
  assert.ok(!/"stash"|"reset"|"clean"/.test(src), "không stash / reset / clean");
  assert.ok(src.includes('"--no-optional-locks"'), "đọc trạng thái cây khác không được làm mới index của họ");
  // Nhánh chỉ bị xoá TRONG cmdCleanup, SAU lời gọi cleanupDecision, và bằng so-và-xoá theo SHA đã đo.
  const body = src.slice(src.indexOf("function cmdCleanup("), src.indexOf("function markCleaned("));
  const iDec = body.indexOf("cleanupDecision(");
  const iDel = body.indexOf('"update-ref", "-d"');
  assert.ok(iDec > 0 && iDel > iDec, "xoá nhánh phải đứng sau quyết định dọn trong cùng hàm");
  assert.ok(/"update-ref", "-d", `refs\/heads\/\$\{f\.branch\}`, f\.head\]/.test(body), "xoá nhánh phải so với SHA đã đo (chống commit chen giữa)");
  assert.ok(!/"branch", "-D"/.test(src), "không xoá nhánh vô điều kiện");
  const repoCfg = parseConfig(JSON.parse(readFileSync(path.join(__dirname, "..", ".ai", "config.json"), "utf8")));
  assert.deepEqual(repoCfg.errors, [], ".ai/config.json của kho phải hợp lệ");
  assert.ok(repoCfg.config.maxImplementationWorkers <= 4, "trần mặc định của kho là 4");
}

function testMissionFilesInRepo() {
  const dir = path.join(__dirname, "..", ".ai", "missions");
  if (!existsSync(dir)) return;
  const { config } = parseConfig(JSON.parse(readFileSync(path.join(__dirname, "..", ".ai", "config.json"), "utf8")));
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const v = validateMission(JSON.parse(readFileSync(path.join(dir, f), "utf8")), config);
    assert.deepEqual(v.errors, [], `.ai/missions/${f} phải hợp lệ — tệp sứ mệnh hỏng thì Lead sau không phục hồi được`);
  }
}

/* ═════════════ 9 · VÒNG ĐỜI THẬT TRÊN KHO TẠM ═════════════ */

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=kiem-thu", "-c", "user.email=kiem-thu@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

async function ai(cwd: string, ...args: string[]): Promise<{ code: number; text: string }> {
  const write = process.stdout.write.bind(process.stdout);
  let text = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(args, cwd);
    return { code, text };
  } catch (e) {
    return { code: 1, text: `${text}${(e as Error).message}` };
  } finally {
    process.stdout.write = write;
  }
}

const put = (file: string, body: string) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
};

async function testLifecycle() {
  const tmp = realDir(mkdtempSync(path.join(tmpdir(), "ai-tech-room-")));
  try {
    const origin = path.join(tmp, "origin.git");
    const repo = path.join(tmp, "kho");
    const other = path.join(tmp, "ben-khac");
    g(tmp, "init", "--bare", "--initial-branch=main", origin);
    g(tmp, "init", "--initial-branch=main", repo);
    // Kho thật ghim LF bằng .gitattributes (AGENTS.md mục 65); kho tạm ghim cùng điều đó, nếu không
    // `core.autocrlf` của máy chạy (Windows) sẽ quyết định cây mới dựng có "bẩn" hay không.
    put(path.join(repo, ".gitattributes"), "* text=auto eol=lf\n");
    put(path.join(repo, "src", "a.ts"), "export const a = 1;\n");
    put(path.join(repo, "src", "b.ts"), "export const b = 1;\n");
    put(path.join(repo, ".ai", "config.json"), JSON.stringify({ maxImplementationWorkers: 4, cleanupGraceMinutes: 0, hotspots: [{ path: "drizzle/", rule: "SERIAL", reason: "số hiệu" }] }));
    g(repo, "add", "-A");
    g(repo, "commit", "-m", "gốc");
    g(repo, "remote", "add", "origin", origin);
    g(repo, "push", "-u", "origin", "main");

    // Một phiên KHÁC đẩy tiếp main ⇒ main cục bộ của Lead giờ là gốc CŨ.
    g(tmp, "clone", origin, other);
    put(path.join(other, "src", "d.ts"), "export const d = 1;\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "main chạy tiếp");
    g(other, "push", "origin", "main");
    const originTip = g(other, "rev-parse", "HEAD");
    const staleLocal = g(repo, "rev-parse", "main");
    assert.notEqual(originTip, staleLocal);

    const mfile = path.join(repo, ".ai", "missions", "m1.json");
    put(
      mfile,
      JSON.stringify(
        rawMission([
          task("t1", { owns: ["src/a.ts"], priority: "P1" }),
          task("t2", { owns: ["src/b.ts"] }),
          task("t3", { owns: ["src/c.ts"], dependsOn: ["t1"] }),
        ]),
        null,
        2,
      ),
    );
    assert.equal((await ai(repo, "validate", "m1")).code, 0);

    // ── ĐIỂM VÀO: `lead` dựng cây Lead từ origin/main VỪA FETCH, không ghi gì vào checkout đang đứng ──
    const headBefore = g(repo, "rev-parse", "HEAD");
    const statusBefore = g(repo, "status", "--porcelain");
    const ldry = await ai(repo, "lead", "m2", "--dry-run");
    assert.equal(ldry.code, 0, ldry.text);
    assert.equal(existsSync(path.join(tmp, "wt-m2")), false, "chạy thử không dựng cây Lead");
    const ld = await ai(repo, "lead", "m2", "Sứ", "mệnh", "hai");
    assert.equal(ld.code, 0, ld.text);
    const wtLead = path.join(tmp, "wt-m2");
    assert.equal(g(wtLead, "rev-parse", "HEAD"), originTip, "cây Lead dựng từ origin/main vừa fetch, không từ main cục bộ cũ");
    assert.equal(g(wtLead, "rev-parse", "--abbrev-ref", "HEAD"), "claude/m2", "nhánh Lead mang tiền tố mà cầu nối mở PR chấp nhận");
    const leadMission = JSON.parse(readFileSync(path.join(wtLead, ".ai", "missions", "m2.json"), "utf8")) as { title: string };
    assert.equal(leadMission.title, "Sứ mệnh hai");
    assert.deepEqual(validateMission(leadMission, CFG).errors, [], "khung sứ mệnh mới phải hợp lệ ngay");
    assert.equal(existsSync(path.join(repo, ".ai", "missions", "m2.json")), false, "không ghi vào checkout đang đứng");
    assert.equal(g(repo, "rev-parse", "HEAD"), headBefore);
    assert.equal(g(repo, "status", "--porcelain"), statusBefore);
    assert.equal(readManifest(wtLead)?.role, "LEAD");
    assert.match((await ai(wtLead, "whoami")).text, /CÂY LEAD — sứ mệnh m2/);
    assert.match((await ai(repo, "status", "m1")).text, /0\/4 worker đang chạy/, "cây Lead không ăn chỗ worker");
    const ld2 = await ai(repo, "lead", "m2");
    assert.equal(ld2.code, 1);
    assert.match(ld2.text, /nhánh claude\/m2 đã tồn tại/);
    assert.equal((await ai(repo, "lead", "Bad_Name")).code, 1, "tên sứ mệnh phải là slug");

    let st = await ai(repo, "status", "m1");
    assert.match(st.text, /READY\s+P1\s+LOW\s+t1/);
    assert.match(st.text, /BACKLOG .*t3\s+chờ t1\(READY\)/);
    assert.match(st.text, /VIỆC CHỦ SHOP CẦN LÀM \(0\)/);

    // ── CHẠY THỬ không đổi gì ──
    const before = readFileSync(mfile, "utf8");
    const dry = await ai(repo, "spawn", "m1", "t1", "--dry-run");
    assert.equal(dry.code, 0, dry.text);
    assert.match(dry.text, /\[CHẠY THỬ\]/);
    assert.equal(existsSync(path.join(tmp, "wt-t1")), false, "chạy thử không được dựng cây");
    assert.equal(readFileSync(mfile, "utf8"), before, "chạy thử không được ghi tệp sứ mệnh");

    // ── DỰNG THẬT: gốc là origin/main VỪA FETCH, không phải main cục bộ cũ ──
    const sp = await ai(repo, "spawn", "m1", "t1");
    assert.equal(sp.code, 0, sp.text);
    const wt1 = path.join(tmp, "wt-t1");
    assert.equal(g(wt1, "rev-parse", "HEAD"), originTip, "cây phải dựng từ origin/main vừa fetch");
    assert.equal(g(wt1, "rev-parse", "--abbrev-ref", "HEAD"), "claude/t1");
    const saved = JSON.parse(readFileSync(mfile, "utf8")) as { tasks: { id: string; run?: { baseSha: string; branch: string } }[] };
    assert.equal(saved.tasks[0].run?.baseSha, originTip);
    assert.equal(readManifest(wt1)?.task.id, "t1", "phiếu giao việc nằm trong thư mục quản trị git của cây");
    assert.equal(g(wt1, "status", "--porcelain"), "", "phiếu KHÔNG nằm trong cây làm việc — không bao giờ bị git add nhầm");
    const who = await ai(wt1, "whoami");
    assert.match(who.text, /PHIẾU GIAO VIỆC — m1 \/ t1/);
    assert.match(who.text, /`src\/a\.ts`/);
    assert.ok(renderBrief(readManifest(wt1) as NonNullable<ReturnType<typeof readManifest>>).includes("`.ai/`"), "phiếu cấm worker sửa trạng thái điều phối");

    // ── LẦN HAI: phục hồi, không dựng lần hai ──
    const again = await ai(repo, "spawn", "m1", "t1");
    assert.equal(again.code, 0);
    assert.match(again.text, /đã có cây/);

    // ── VA CHẠM: nhánh có sẵn · thư mục có sẵn ──
    g(repo, "branch", "claude/t2", "main");
    const c1 = await ai(repo, "spawn", "m1", "t2");
    assert.equal(c1.code, 1);
    assert.match(c1.text, /nhánh claude\/t2 đã tồn tại/);
    g(repo, "branch", "-D", "claude/t2");
    mkdirSync(path.join(tmp, "wt-t2"));
    const c2 = await ai(repo, "spawn", "m1", "t2");
    assert.equal(c2.code, 1);
    assert.match(c2.text, /thư mục .*wt-t2 đã tồn tại/);
    rmSync(path.join(tmp, "wt-t2"), { recursive: true });
    assert.equal((await ai(repo, "spawn", "m1", "t2")).code, 0);
    const wt2 = path.join(tmp, "wt-t2");

    // Việc chưa READY không dựng được.
    const early = await ai(repo, "spawn", "m1", "t3");
    assert.equal(early.code, 1);
    assert.match(early.text, /BACKLOG/);

    // ── WORKER LÀM VIỆC ──
    put(path.join(wt1, "src", "a.ts"), "export const a = 2;\n");
    put(path.join(wt1, "nhap.txt"), "chưa commit\n");
    st = await ai(repo, "status", "m1");
    assert.match(st.text, /RUNNING .*t1\s+bẩn 2/);
    const dirtyClean = await ai(repo, "cleanup", "m1:t1", "--apply");
    assert.equal(dirtyClean.code, 1);
    assert.match(dirtyClean.text, /DIRTY/);
    assert.ok(existsSync(path.join(wt1, "nhap.txt")), "cây bẩn KHÔNG bao giờ bị dọn");
    rmSync(path.join(wt1, "nhap.txt"));
    g(wt1, "commit", "-am", "t1: a = 2");
    st = await ai(repo, "status", "m1");
    assert.match(st.text, /RUNNING .*t1\s+1 commit · chưa đẩy/);
    g(wt1, "push", "-u", "origin", "claude/t1");
    st = await ai(repo, "status", "m1");
    assert.match(st.text, /REVIEW .*t1\s+đã đẩy 1 commit/);
    const r1 = await ai(repo, "ready", "m1", "t1");
    assert.equal(r1.code, 0, r1.text);
    assert.match(r1.text, /MỞ PR/);

    // Worker t2 sửa NGOÀI phạm vi ⇒ không sẵn sàng PR.
    put(path.join(wt2, "src", "b.ts"), "export const b = 2;\n");
    put(path.join(wt2, "src", "ngoai.ts"), "export const x = 1;\n");
    g(wt2, "add", "-A");
    g(wt2, "commit", "-m", "t2");
    g(wt2, "push", "-u", "origin", "claude/t2");
    const r2 = await ai(repo, "ready", "m1", "t2");
    assert.equal(r2.code, 1);
    assert.match(r2.text, /NGOÀI PHẠM VI src\/ngoai\.ts/);

    // ── MAIN CHẠY TIẾP: squash-merge t1 (có số PR) + một thay đổi đè lên đúng dòng t2 đang sửa ──
    g(other, "pull", "--ff-only", "origin", "main");
    put(path.join(other, "src", "a.ts"), "export const a = 2;\n");
    put(path.join(other, "src", "b.ts"), "export const b = 3;\n");
    g(other, "commit", "-am", "Việc t1 (#42)");
    g(other, "push", "origin", "main");

    const rec = await ai(repo, "reconcile", "m1");
    assert.match(rec.text, /CONFLICTS\s+t2/, rec.text);
    assert.match(rec.text, /xung đột: src\/b\.ts/);

    const t1tip = g(repo, "rev-parse", "claude/t1");
    assert.equal(mergeEvidence(repo, t1tip, "origin/main", { pr: 42 }), "PR_SUBJECT");
    assert.equal(mergeEvidence(repo, t1tip, "origin/main"), "CONTENT", "squash không ghi số PR vẫn nhận ra bằng nội dung");
    assert.equal(mergeEvidence(repo, g(repo, "rev-parse", "claude/t2"), "origin/main"), null);

    st = await ai(repo, "status", "m1");
    assert.match(st.text, /MERGED .*t1\s+bằng chứng CONTENT/);
    assert.match(st.text, /READY .*t3/, "t1 vào xong thì t3 tự mở khoá");
    const nx = await ai(repo, "next", "m1");
    assert.match(nx.text, /DỰNG CÂY\s+t3/);

    // ── WORKER CHƯA COMMIT GÌ MÀ FAST-FORWARD LÊN MAIN: không được thành "đã vào" (reviewer, HIGH) ──
    assert.equal((await ai(repo, "spawn", "m1", "t3")).code, 0);
    const wt3 = path.join(tmp, "wt-t3");
    g(other, "pull", "--ff-only", "origin", "main");
    put(path.join(other, "src", "e.ts"), "export const e = 1;\n");
    g(other, "add", "-A");
    g(other, "commit", "-m", "main chạy tiếp lần nữa");
    g(other, "push", "origin", "main");
    g(wt3, "fetch", "origin");
    g(wt3, "merge", "--ff-only", "origin/main");
    st = await ai(repo, "status", "m1");
    assert.match(st.text, /RUNNING .*t3\s+0 commit/, st.text);
    assert.equal(mergeEvidence(repo, g(wt3, "rev-parse", "HEAD"), "origin/main", { baseSha: originTip }), "EMPTY");
    const c3ff = await ai(repo, "cleanup", "m1:t3", "--apply");
    assert.equal(c3ff.code, 1);
    assert.match(c3ff.text, /EMPTY_BUT_RECENT/);
    assert.ok(existsSync(wt3), "cây của worker đang làm không bao giờ bị dọn");

    // ── WORKER MERGE MAIN VÀO RỒI MỚI XIN PR: tệp của main không bị tính là "ngoài phạm vi" ──
    g(wt2, "rm", "-q", "src/ngoai.ts");
    g(wt2, "commit", "-m", "t2: bỏ tệp ngoài phạm vi");
    g(wt2, "fetch", "origin");
    const mg = spawnSync("git", ["-c", "user.name=k", "-c", "user.email=k@example.invalid", "merge", "origin/main"], { cwd: wt2, encoding: "utf8" });
    assert.notEqual(mg.status, 0, "phải xung đột ở src/b.ts như reconcile đã báo");
    put(path.join(wt2, "src", "b.ts"), "export const b = 4;\n");
    g(wt2, "add", "src/b.ts");
    g(wt2, "commit", "--no-edit");
    g(wt2, "push", "origin", "claude/t2");
    const r2b = await ai(repo, "ready", "m1", "t2");
    assert.equal(r2b.code, 0, r2b.text);

    // ── DỌN: chạy thử trước, rồi làm thật ──
    const cdry = await ai(repo, "cleanup", "m1:t1");
    assert.equal(cdry.code, 0, cdry.text);
    assert.ok(existsSync(wt1), "cleanup mặc định là chạy thử");
    const cdo = await ai(repo, "cleanup", "m1:t1", "--apply");
    assert.equal(cdo.code, 0, cdo.text);
    assert.equal(existsSync(wt1), false);
    assert.equal(spawnSync("git", ["rev-parse", "--verify", "--quiet", "refs/heads/claude/t1"], { cwd: repo }).status, 1, "nhánh cục bộ đã xoá");
    g(repo, "rev-parse", "--verify", "refs/remotes/origin/claude/t1"); // nhánh remote GIỮ NGUYÊN
    const after = JSON.parse(readFileSync(mfile, "utf8")) as { tasks: { id: string; run?: { cleanedAt?: string; mergedEvidence?: string } }[] };
    assert.ok(after.tasks[0].run?.cleanedAt);
    assert.equal(after.tasks[0].run?.mergedEvidence, "CONTENT");

    // GitHub tự xoá nhánh sau merge ⇒ git không còn dấu gì; bằng chứng đã ghi lúc dọn giữ việc ở MERGED.
    g(repo, "push", "origin", "--delete", "claude/t1");
    g(repo, "fetch", "--prune", "origin");
    st = await ai(repo, "status", "m1");
    assert.match(st.text, /MERGED .*t1/, "việc xong không được thành ORPHANED sau khi mọi nhánh đã dọn");

    // ── PHIÊN KHÁC DỰNG LẠI wt-t1 CHO VIỆC CỦA HỌ: không phải cây của t1, không nhận phiếu của t1 ──
    g(repo, "worktree", "add", "-b", "viec-khac", wt1, "origin/main");
    const reuse = await ai(repo, "spawn", "m1", "t1");
    assert.equal(reuse.code, 1, reuse.text);
    assert.equal(readManifest(wt1), null, "không bao giờ ghi phiếu vào cây của phiên khác");
    const cm = await ai(repo, "cleanup", "--merged", "--apply");
    assert.ok(existsSync(wt1), "cleanup --merged chỉ chọn cây CÓ phiếu");
    assert.ok(!cm.text.includes("wt-t1"));

    // Chưa vào thì không dọn.
    const c3 = await ai(repo, "cleanup", "m1:t2", "--apply");
    assert.equal(c3.code, 1);
    assert.match(c3.text, /NOT_MERGED/);
    assert.ok(existsSync(wt2));

    // ── CÂY KHÔNG RÕ CHỦ (phiên khác dựng tay) ──
    const legacy = path.join(tmp, "wt-cu");
    g(repo, "worktree", "add", "-b", "cu", legacy, "origin/main");
    const u1 = await ai(repo, "cleanup", legacy, "--apply");
    assert.equal(u1.code, 1);
    assert.match(u1.text, /UNOWNED/);
    const u2 = await ai(repo, "cleanup", legacy, "--apply", "--allow-unowned");
    assert.equal(u2.code, 1);
    assert.match(u2.text, /UNOWNED_RECENT/, "kể cả được phép: cây vừa dùng của người khác thì không dọn");
    assert.ok(existsSync(legacy));
    const main1 = await ai(repo, "cleanup", repo, "--apply");
    assert.equal(main1.code, 1);
    assert.match(main1.text, /MAIN/);

    const census = JSON.parse((await ai(repo, "worktrees", "--json")).text) as { path: string; class: string; owner: unknown }[];
    const byName = (n: string) => census.find((c) => path.basename(c.path) === n);
    assert.equal(byName("kho")?.class, "MAIN");
    assert.equal(byName("wt-cu")?.class, "ACTIVE", "cây lạ vừa dựng, 0 commit: đang được dùng, không phải rác (reviewer)");
    assert.equal(byName("wt-cu")?.owner, null);
    assert.equal(byName("wt-t2")?.class, "ACTIVE");
    assert.deepEqual(byName("wt-t2")?.owner, { mission: "m1", task: "t2" });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function testAiTechRoom() {
  testValidation();
  testScopes();
  testDerivedStatus();
  testScheduler();
  testWorktreePolicy();
  testReconcile();
  await testGithub();
  testSourceGuards();
  testMissionFilesInRepo();
  await testLifecycle();
  console.log("✓ AI Tech Room: DAG · trạng thái suy từ git · xếp lịch · dựng cây từ origin/main · dọn an toàn · đối chiếu");
}

if (/ai-tech-room\.test\.ts$/.test(process.argv[1] ?? "")) {
  testAiTechRoom().then(
    () => console.log("ĐẠT"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
