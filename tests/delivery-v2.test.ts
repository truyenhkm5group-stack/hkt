import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CLOSED_STATES,
  ControlConflict,
  DEFAULT_CONFIG,
  checkPrMigrations,
  claimDecision,
  classifyRisk,
  inferOwnedPaths,
  intakeVerdict,
  isDestructiveSql,
  leaseDecision,
  main,
  migrationNumberOf,
  missionOverlaps,
  mutateControl,
  nextMigrationNumber,
  openRepo,
  orderQueue,
  parseConfig,
  parsePrDependencies,
  planDeploy,
  readControl,
  realDir,
  reviewedAt,
  reconcileEntry,
  validateEntry,
  verifyVerdict,
  writeControl,
  type Config,
  type EntryFacts,
  type Lease,
  type QueueItem,
  type RegistryEntry,
} from "../scripts/ai-tech";

/**
 * ═══════════ ĐIỀU PHỐI V2 — MẶT PHẲNG ĐIỀU KHIỂN + ĐƯỜNG GIAO HÀNG PHẢI ĐÚNG TRƯỚC KHI NÓ NHANH ═══════════
 *
 * `docs/ai-tech-room/delivery-v2.md`. Ba lớp:
 *   · WORKFLOW — cổng song song vẫn ĐỎ khi bất kỳ nhánh nào không xanh (chạy thật kịch bản gom bằng
 *     bash); deploy chỉ chạm máy chủ khi (cổng vừa xanh) HOẶC (bằng chứng xanh của ĐÚNG SHA).
 *   · HÀM THUẦN — khoá có hạn, chồng phạm vi xuyên sứ mệnh, đối chiếu sổ với git, số migration,
 *     rủi ro, hàng đợi gộp, kế hoạch deploy, hậu kiểm, chống trùng.
 *   · VÒNG ĐỜI THẬT — hai "phiên" (hai bản clone) tranh nhau một sổ trên một remote TẠM: từ chối
 *     chồng phạm vi, khoá một chủ, tiếp quản khoá hết hạn, so-và-ghi khi đẩy, giữ chỗ migration,
 *     phục hồi sổ sau khi phiên mất trạng thái. Không bao giờ chạm remote thật.
 *
 * Không mốc thời gian tuyệt đối (AGENTS.md mục 50) và không đọc biến môi trường / nền chạy (mục 65):
 * mọi mốc dựng từ đồng hồ thật lúc chạy.
 */

const goc = path.join(__dirname, "..");
const doc = (f: string) => readFileSync(path.join(goc, f), "utf8");

const CFG: Config = {
  ...DEFAULT_CONFIG,
  hotspots: [
    { path: "drizzle/", rule: "SERIAL", reason: "số hiệu migration" },
    { path: "tests/sync-fixtures.test.ts", rule: "SHARED", reason: "nơi đăng ký bài kiểm" },
  ],
  riskFloor: [
    { path: "lib/queries/return-rate.ts", risk: "CRITICAL", reason: "ORDER_OUTCOME" },
    { path: "drizzle/", risk: "HIGH", reason: "migration" },
    { path: "lib/auth/", risk: "HIGH", reason: "quyền" },
  ],
  lowRiskPaths: ["docs/", "tests/", "components/"],
};

/* ═════════════ 1 · CỔNG SONG SONG: MỘT CHECK BẮT BUỘC, ĐỎ KHI BẤT KỲ NHÁNH NÀO KHÔNG XANH ═════════════ */

function testCongSongSong() {
  const g = doc(".github/workflows/gates.yml");
  assert.match(g, /^jobs:\n {2}gates:\n {4}needs: \[tinh, kiem_thu, kiem_thu_token, dung_ban\]\n {4}if: \$\{\{ always\(\) \}\}\n/m, "job gom `gates` đứng đầu, cần cả bốn nhánh và LUÔN chạy");
  for (const job of ["tinh", "kiem_thu", "kiem_thu_token", "dung_ban"]) {
    const i = g.indexOf(`\n  ${job}:\n`);
    assert.ok(i > 0, `thiếu nhánh ${job}`);
    const rest = g.slice(i + 1);
    const next = rest.search(/\n {2}[a-z_]+:\n/);
    const own = next > 0 ? rest.slice(0, next) : rest;
    assert.match(own, /ref: \$\{\{ inputs\.ref \|\| github\.sha \}\}/, `${job} phải ghim đúng SHA được kiểm`);
    assert.match(own, /sha: \$\{\{ steps\.ghim\.outputs\.sha \}\}/, `${job} phải đưa SHA THẬT nó đã checkout ra cho job gom`);
  }
  assert.equal(g.split("run: npm test").length - 1, 2, "vẫn đúng HAI lượt bộ kiểm thử (ẩn danh + token giả) — song song, không bỏ lượt nào");
  for (const lenh of ["npx tsc --noEmit", "npx eslint --max-warnings=0", "npm run build", "tests/repo-integrity.test.ts"]) assert.ok(g.includes(lenh), `cổng phải còn ${lenh}`);
  assert.ok(!/\n\s*strategy:\s*\n\s*matrix:/.test(g), "không matrix — tên check bắt buộc sẽ mất");

  // Chạy THẬT kịch bản gom bằng bash với từng tổ hợp kết quả: không một tổ hợp nào ngoài "bốn xanh,
  // bốn SHA trùng" được thoát 0.
  const i = g.indexOf("id: gom");
  const run = g.slice(g.indexOf("run: |\n", i) + 7, g.indexOf("\n\n", i));
  const script = run
    .split("\n")
    .map((l) => l.replace(/^ {10}/, ""))
    .join("\n");
  const tmp = realDir(mkdtempSync(path.join(tmpdir(), "gom-")));
  try {
    const chay = (kq: string[], sha: string[]) => {
      const outFile = path.join(tmp, `out-${Math.random().toString(36).slice(2)}`).replace(/\\/g, "/");
      writeFileSync(outFile, "");
      const pre = [
        `export KQ_TINH='${kq[0]}' KQ_KIEM_THU='${kq[1]}' KQ_KIEM_THU_TOKEN='${kq[2]}' KQ_DUNG_BAN='${kq[3]}'`,
        `export SHA_TINH='${sha[0]}' SHA_KIEM_THU='${sha[1]}' SHA_KIEM_THU_TOKEN='${sha[2]}' SHA_DUNG_BAN='${sha[3]}'`,
        `export GITHUB_OUTPUT='${outFile}'`,
      ].join("\n");
      const r = spawnSync("bash", ["-c", `${pre}\n${script}`], { encoding: "utf8" });
      assert.ok(!r.error, `cần bash để chạy kịch bản gom (${r.error?.message ?? ""}) — bash có trên mọi nền chạy cổng`);
      return { code: r.status, out: readFileSync(outFile, "utf8") };
    };
    const S = "a".repeat(40);
    const ok = chay(["success", "success", "success", "success"], [S, S, S, S]);
    assert.equal(ok.code, 0, "bốn xanh + bốn SHA trùng ⇒ cổng xanh");
    assert.match(ok.out, new RegExp(`sha=${S}`), "và đưa ra đúng SHA đã kiểm");
    for (const xau of ["failure", "cancelled", "skipped", ""]) {
      for (let k = 0; k < 4; k++) {
        const kq = ["success", "success", "success", "success"];
        kq[k] = xau;
        assert.notEqual(chay(kq, [S, S, S, S]).code, 0, `nhánh ${k} = "${xau}" ⇒ cổng phải ĐỎ (skipped trên check bắt buộc là ĐẠT nếu không chặn ở đây)`);
      }
    }
    assert.notEqual(chay(["success", "success", "success", "success"], [S, S, "b".repeat(40), S]).code, 0, "bốn nhánh đứng trên hai SHA ⇒ ĐỎ");
    assert.notEqual(chay(["success", "success", "success", "success"], ["", "", "", ""]).code, 0, "không SHA nào ⇒ ĐỎ");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ═════════════ 2 · DEPLOY: CỔNG HOẶC BẰNG CHỨNG CỔNG CỦA ĐÚNG SHA — KHÔNG CÓ ĐƯỜNG THỨ BA ═════════════ */

function testDeployDungLaiBangChung() {
  const d = doc(".github/workflows/deploy-vps.yml");
  assert.match(d, /\n {2}gates:\n {4}needs: bang_chung\n {4}if: \$\{\{ needs\.bang_chung\.outputs\.reuse != 'true' \}\}\n/, "gates chỉ bỏ qua khi có bằng chứng; KHÔNG hàm trạng thái nào — bang_chung đỏ ⇒ gates bị bỏ qua ⇒ release không chạy");
  const rel = /\n {2}release:\n {4}needs: \[bang_chung, gates, build_image\]\n(?: {4}#.*\n)* {4}if: \$\{\{ (.+) \}\}\n/.exec(d);
  assert.ok(rel, "release phải khai needs + if tường minh");
  const expr = rel[1];
  const evalIf = (v: { cancelled: boolean; build: string; gates: string; bang: string; reuse: string }) => {
    const js = expr
      .replace(/!cancelled\(\)/g, String(!v.cancelled))
      .replace(/needs\.build_image\.result/g, JSON.stringify(v.build))
      .replace(/needs\.gates\.result/g, JSON.stringify(v.gates))
      .replace(/needs\.bang_chung\.result/g, JSON.stringify(v.bang))
      .replace(/needs\.bang_chung\.outputs\.reuse/g, JSON.stringify(v.reuse))
      .replace(/'/g, '"')
      .replace(/==/g, "===")
      .replace(/!===/g, "!==");
    assert.ok(/^[\s()!&|="a-z_A-Z]*$/.test(js.replace(/"[^"]*"/g, "")), `biểu thức release chỉ được dùng các biến đã biết: ${js}`);
    return Boolean(new Function(`return (${js});`)());
  };
  const KQ = ["success", "failure", "cancelled", "skipped"];
  let soToHop = 0;
  for (const cancelled of [false, true])
    for (const build of KQ)
      for (const gates of KQ)
        for (const bang of ["success", "failure", "skipped"])
          for (const reuse of ["true", "false", ""]) {
            soToHop++;
            const chay = evalIf({ cancelled, build, gates, bang, reuse });
            const dung = !cancelled && build === "success" && (gates === "success" || (gates === "skipped" && bang === "success" && reuse === "true"));
            assert.equal(chay, dung, `release ${chay ? "CHẠY" : "không chạy"} sai với build=${build} gates=${gates} bang_chung=${bang} reuse=${reuse} huỷ=${cancelled}`);
            if (gates !== "success" && reuse !== "true") assert.equal(chay, false, "không cổng xanh, không bằng chứng ⇒ KHÔNG BAO GIỜ chạm máy chủ");
          }
  assert.equal(soToHop, 2 * 4 * 4 * 3 * 3);

  // Bằng chứng phải là LƯỢT CHẠY WORKFLOW ci.yml trên push vào main của đúng SHA — thứ GitHub ghi, không giả được bằng một check run.
  const bc = d.slice(d.indexOf("\n  bang_chung:\n"), d.indexOf("\n  gates:\n", d.indexOf("\n  bang_chung:\n")));
  assert.match(bc, /permissions:\n {6}actions: read\n {6}contents: read\n/, "bang_chung chỉ ĐỌC");
  assert.ok(!/write/.test(bc.replace(/#.*$/gm, "").replace(/GITHUB_OUTPUT/g, "")), "bang_chung không có quyền ghi nào");
  const iDefault = bc.indexOf('echo "reuse=false" >> "$GITHUB_OUTPUT"');
  const iTrue = bc.indexOf('echo "reuse=true" >> "$GITHUB_OUTPUT"');
  assert.ok(iDefault > 0 && iTrue > iDefault, "mặc định reuse=false được ghi TRƯỚC mọi nhánh; chỉ đúng một chỗ ghi reuse=true");
  assert.equal(bc.split('echo "reuse=true"').length - 1, 1);
  const filter = bc.slice(bc.indexOf("select(", bc.indexOf("ok=")), iTrue);
  for (const dk of ['.head_sha == $sha', '.event == "push"', '.head_branch == "main"', '.path == ".github/workflows/ci.yml"', '.status == "completed"', '.conclusion == "success"'])
    assert.ok(filter.includes(dk), `bằng chứng phải lọc ${dk}`);
  assert.match(bc, /if \[ "\$REF" != "refs\/heads\/main" \]/, "deploy không từ main ⇒ không dùng lại bằng chứng của main");
  assert.ok(bc.includes('echo "sha=$ok_sha"') && !bc.includes('echo "sha=$SHA"'), "SHA xuất ra đọc từ chính lượt CI được chọn (.head_sha), không chép lại đầu vào");
  assert.match(bc, /if \[ -n "\$ok" \] && \[ "\$ok_sha" = "\$SHA" \]; then/, "và phải trùng SHA đang triển khai mới được dùng lại");
  assert.match(d, /GATES_SHA: \$\{\{ needs\.gates\.result == 'success' && needs\.gates\.outputs\.sha \|\| needs\.bang_chung\.outputs\.sha \}\}/, "bước ba SHA so SHA của cổng vừa chạy, hoặc của bằng chứng");

  const ci = doc(".github/workflows/ci.yml");
  const mig = ci.slice(ci.indexOf("\n  migration:\n"));
  assert.match(mig, /if: \$\{\{ github\.event_name == 'pull_request' \}\}/, "job va số migration chỉ chạy trên PR — không bao giờ làm đỏ lượt push vào main (thứ deploy dùng làm bằng chứng)");
  assert.ok(!mig.includes("secrets."), "job va số migration không cần secret");
  assert.match(mig, /node scripts\/ai-tech\.ts migration check --pr=/);
}

/* ═════════════ 3 · HÀM THUẦN ═════════════ */

const now = Date.now();
const iso = (deltaMin: number) => new Date(now + deltaMin * 60_000).toISOString();

function entry(id: string, over: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    schema: 1,
    mission_id: id,
    title: `Sứ mệnh ${id}`,
    business_goal: "đo được",
    status: "RUNNING",
    priority: "P2",
    risk: "MEDIUM",
    owner: "may:wt-lead",
    worker: null,
    worktree: null,
    branch: null,
    base_sha: null,
    domains: [],
    owned_paths: [`lib/${id}/`],
    dependencies: [],
    blocked_by: [],
    related_prs: [],
    migration_reservations: [],
    created_at: iso(-120),
    updated_at: iso(-10),
    last_heartbeat: iso(-10),
    definition_of_done: ["xong"],
    ...over,
  };
}

function testKhoa() {
  const ttl = 60 * 60_000;
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const me = { name: "integration-lead" as const, holder: "may:wt-a", purpose: "gộp lô", tokenHash: null, freshTokenHash: H1 };
  const a = leaseDecision(null, "acquire", me, now, ttl);
  assert.ok(a.ok && a.next?.holder === "may:wt-a" && a.next.generation === 1 && a.next.token_hash === H1, "khoá trống ⇒ lấy được, gắn mã phiên mới");
  const held = a.next as Lease;
  const b = leaseDecision(held, "acquire", { ...me, holder: "may:wt-b", freshTokenHash: H2 }, now + 60_000, ttl);
  assert.ok(!b.ok && /may:wt-a/.test(b.reason), "đang có chủ còn hạn ⇒ người khác bị từ chối, và biết ai giữ");
  // Review 06/10/2026: hai phiên mở trong CÙNG một cây có cùng nhãn máy:cây — nhãn không phải danh tính.
  const cungCay = leaseDecision(held, "acquire", { ...me, freshTokenHash: H2 }, now + 60_000, ttl);
  assert.ok(!cungCay.ok && /KHÔNG đúng mã phiên/.test(cungCay.reason), "cùng nhãn mà không trình mã phiên ⇒ bị từ chối như người lạ");
  assert.ok(!leaseDecision(held, "acquire", { ...me, tokenHash: H2 }, now, ttl).ok, "trình SAI mã ⇒ bị từ chối");
  const reenter = leaseDecision(held, "acquire", { ...me, tokenHash: H1 }, now + 30 * 60_000, ttl);
  assert.ok(reenter.ok && reenter.next?.generation === 1 && reenter.next.token_hash === H1 && Date.parse(reenter.next.expires_at) > Date.parse(held.expires_at), "đúng mã (phục hồi sau sập) ⇒ nhận lại + gia hạn, không đổi đời, không đổi mã");
  const take = leaseDecision(held, "acquire", { ...me, holder: "may:wt-b", freshTokenHash: H2 }, now + ttl + 1000, ttl);
  assert.ok(take.ok && take.takeoverFrom?.holder === "may:wt-a" && take.next?.generation === 2 && take.next.token_hash === H2, "hết hạn ⇒ tiếp quản được, ghi rõ tiếp quản từ ai, đời tăng, mã mới");
  assert.ok(!leaseDecision(held, "release", { ...me, holder: "may:wt-b" }, now, ttl).ok, "không nhả hộ khoá người khác");
  assert.ok(!leaseDecision(held, "release", me, now, ttl).ok, "cùng cây mà không có mã cũng không nhả được");
  assert.ok(!leaseDecision(held, "renew", { ...me, holder: "may:wt-b" }, now, ttl).ok, "không gia hạn hộ");
  assert.equal(leaseDecision(held, "release", { ...me, tokenHash: H1 }, now, ttl).next, null, "chủ (đúng mã) nhả ⇒ khoá trống");
  assert.ok(!leaseDecision(null, "renew", me, now, ttl).ok, "không có gì để gia hạn");
  // Khoá CŨ (trước khi có mã phiên — sổ thật từng có): người trùng nhãn chạm vào thì NÂNG CẤP, gắn mã mới;
  // từ đó phiên thứ hai cùng cây bị từ chối. Trước bản vá nó được gia hạn mãi ở dạng cũ (review lần hai).
  const cu: Lease = { name: "integration-lead", holder: "may:wt-a", purpose: "", acquired_at: iso(-5), heartbeat_at: iso(-5), expires_at: iso(30), generation: 3 };
  const nang = leaseDecision(cu, "acquire", me, now, ttl);
  assert.ok(nang.ok && nang.next?.token_hash === H1 && nang.next.generation === 3, "khoá cũ ⇒ gắn mã phiên khi chủ (trùng nhãn) lấy lại");
  assert.ok(!leaseDecision(nang.next, "acquire", { ...me, freshTokenHash: H2 }, now, ttl).ok, "sau nâng cấp, phiên thứ hai cùng cây (không mã) bị từ chối");
  assert.equal(leaseDecision(cu, "renew", me, now, ttl).next?.token_hash, H1, "gia hạn khoá cũ cũng nâng cấp");
}

function testChongPhamVi() {
  const a = entry("a", { owned_paths: ["lib/sales-chatbot/"] });
  const b = entry("b", { owned_paths: ["lib/sales-chatbot/engine.ts"] });
  assert.equal(missionOverlaps(b, [a], CFG).length, 1, "thư mục ↔ tệp bên trong là chồng");
  const r = claimDecision(b, [a], CFG);
  assert.ok(!r.ok && /OVERLAP với a/.test(r.refusals[0]) && /--after=a/.test(r.refusals[0]), "chồng phạm vi ⇒ từ chối, chỉ đúng hai lối ra");
  assert.ok(claimDecision({ ...b, dependencies: ["a"] }, [a], CFG).ok, "tuần tự hoá (b sau a) ⇒ được");
  const acc = claimDecision(b, [a], CFG, { acceptOverlap: "a chỉ thêm hàm mới cuối tệp" });
  assert.ok(acc.ok && /OVERLAP_ACCEPTED/.test(acc.warnings[0]), "khai cách tích hợp ⇒ được, nhưng ghi lại");
  assert.ok(claimDecision(b, [{ ...a, status: "DONE" }], CFG).ok, "sứ mệnh đã khép nhả phạm vi");
  const m1 = entry("m1", { owned_paths: ["drizzle/0300_a.sql"] });
  const m2 = entry("m2", { owned_paths: ["drizzle/0301_b.sql"] });
  assert.match(claimDecision(m2, [m1], CFG).refusals.join(), /điểm nóng SERIAL drizzle\//, "hai tệp khác nhau trong cùng điểm nóng SERIAL vẫn là chồng");
  const s1 = entry("s1", { owned_paths: ["tests/sync-fixtures.test.ts"] });
  const s2 = entry("s2", { owned_paths: ["tests/sync-fixtures.test.ts"] });
  assert.ok(claimDecision(s2, [s1], CFG).ok, "điểm nóng SHARED (chỉ nối thêm) không chặn");
  assert.match(claimDecision(entry("x", { dependencies: ["khong-co"] }), [], CFG).refusals.join(), /không có trong sổ/);
  assert.match(claimDecision(entry("p", { dependencies: ["q"] }), [entry("q", { dependencies: ["p"] })], CFG).refusals.join(), /thành vòng/);
  const dup = claimDecision(entry("d", { intake: { verdict: "IN_PROGRESS", evidence: ["PR #600"] } }), [], CFG);
  assert.ok(!dup.ok && /DUPLICATE/.test(dup.refusals[0]), "intake nói đang có người làm ⇒ không dựng việc thứ hai");
  assert.ok(claimDecision(entry("d", { intake: { verdict: "PARTIAL", evidence: [] } }), [], CFG).ok, "PARTIAL ⇒ mở rộng, được đăng ký");
  const mg = claimDecision(entry("g", { migration_reservations: ["0300"] }), [entry("h", { migration_reservations: ["0300"], owned_paths: ["lib/h/"] })], CFG);
  assert.match(mg.refusals.join(), /MIGRATION: 0300/, "trùng số giữ chỗ ⇒ từ chối");
  assert.deepEqual(inferOwnedPaths(["lib/sales-chatbot/a.ts", "lib/sales-chatbot/x/b.ts", "tests/a.test.ts", "app/(dashboard)/ai/page.tsx"]).sort(), ["app/(dashboard)/ai/", "lib/sales-chatbot/", "tests/a.test.ts"].sort(), "phạm vi suy từ nhánh: thư mục chứa tệp, tests/ giữ tệp");
  assert.deepEqual(inferOwnedPaths(["docs/pancake-runbook.md", "scripts/x.ts"]), ["docs/pancake-runbook.md", "scripts/x.ts"], "tệp thẳng trong docs/ · scripts/ giữ tệp — lấy cả thư mục là báo chồng giả với mọi sứ mệnh có tài liệu");
}

function testDoiChieu() {
  const f = (over: Partial<EntryFacts> = {}): EntryFacts => ({ branch: { local: true, remote: true, tip: "a".repeat(40) }, merged: null, pr: null, inProduction: null, touched: [], openDependencies: [], ...over });
  const e = entry("e", { branch: "claude/e" });
  assert.equal(reconcileEntry(e, f(), CFG, now).effective, "RUNNING");
  const m = reconcileEntry(e, f({ merged: "PR_SUBJECT", inProduction: false }), CFG, now);
  assert.equal(m.effective, "INTEGRATING", "sổ nói RUNNING mà git nói đã vào ⇒ git thắng");
  assert.match(m.drift.join(), /đã vào main/);
  assert.equal(reconcileEntry(e, f({ merged: "ANCESTOR", inProduction: true }), CFG, now).effective, "VERIFYING", "đã lên production ⇒ chờ hậu kiểm, chưa DONE");
  assert.equal(reconcileEntry(e, f({ pr: { number: 9, state: "open", merged: false, gates: "success" } }), CFG, now).effective, "PR_READY");
  assert.equal(reconcileEntry(e, f({ pr: { number: 9, state: "open", merged: false, gates: "failure" } }), CFG, now).effective, "FAILED");
  assert.match(reconcileEntry(entry("e", { last_heartbeat: iso(-60 * 30) }), f({ branch: null }), CFG, now).drift.join(), /nhịp tim cũ/, "im lặng quá ngưỡng ⇒ báo phiên có thể đã chết");
  assert.match(reconcileEntry(e, f({ touched: ["lib/e/a.ts", "lib/khac/b.ts"] }), CFG, now).drift.join(), /NGOÀI phạm vi khai: lib\/khac\/b\.ts/, "nhánh chạm ngoài phạm vi khai ⇒ lệch, in ra");
  const o = reconcileEntry(e, f({ branch: { local: false, remote: false, tip: null } }), CFG, now);
  assert.equal(o.effective, "BLOCKED");
  assert.match(o.drift.join(), /ORPHANED/);
  assert.equal(reconcileEntry(entry("e", { status: "READY" }), f({ branch: null, openDependencies: ["a"] }), CFG, now).effective, "BACKLOG", "phụ thuộc chưa xong ⇒ chưa được bắt đầu");
  assert.match(reconcileEntry(entry("e", { status: "DONE" }), f(), CFG, now).drift.join(), /không có bằng chứng/, "DONE không bằng chứng ⇒ lệch");
  assert.ok(CLOSED_STATES.has("DONE") && CLOSED_STATES.has("CANCELLED") && !CLOSED_STATES.has("FAILED"), "FAILED vẫn giữ phạm vi");
}

function testMigration() {
  assert.equal(migrationNumberOf("drizzle/0219_sales_ai_reviews.sql"), "0219");
  assert.equal(migrationNumberOf("drizzle/meta/_journal.json"), null);
  assert.equal(nextMigrationNumber({ main: ["drizzle/0220_a.sql", "drizzle/0221_b.sql"], branches: ["drizzle/0222_c.sql"], reserved: ["0224"] }), "0225", "số kế tiếp vượt main, nhánh mở, giữ chỗ");
  assert.equal(nextMigrationNumber({ main: [], branches: [], reserved: [] }), "0000");
  const main_ = ["drizzle/0218_x.sql"];
  // Ca #598/#599: hai PR cùng lấy 0219.
  const p598 = { pr: 598, createdAt: iso(-300), added: ["drizzle/0219_sales_ai_reviews.sql"] };
  const p599 = { pr: 599, createdAt: iso(-200), added: ["drizzle/0219_sales_inbox_history.sql"] };
  const sau = checkPrMigrations({ ...p599, main: main_, others: [p598], reservations: [], ownMission: null });
  assert.match(sau.problems.join(), /PR #598 \(mở trước\) cũng thêm số 0219/, "PR mở SAU đỏ");
  const truoc = checkPrMigrations({ ...p598, main: main_, others: [p599], reservations: [], ownMission: null });
  assert.deepEqual(truoc.problems, [], "PR mở TRƯỚC không đỏ vì lỗi của người khác");
  assert.match(truoc.warnings.join(), /PR #599 \(mở sau\)/);
  assert.match(checkPrMigrations({ pr: 1, createdAt: iso(0), added: ["drizzle/0217_y.sql"], main: main_, others: [], reservations: [], ownMission: null }).problems.join(), /không lớn hơn số cuối trên main/, "lùi số ⇒ drizzle bỏ qua vĩnh viễn ⇒ đỏ");
  assert.match(checkPrMigrations({ pr: 1, createdAt: iso(0), added: ["drizzle/0218_khac.sql"], main: main_, others: [], reservations: [], ownMission: null }).problems.join(), /đã thuộc 0218_x\.sql trên main/);
  const hoa = iso(-300);
  const hoa598 = checkPrMigrations({ pr: 598, createdAt: hoa, added: ["drizzle/0219_a.sql"], main: main_, others: [{ pr: 599, createdAt: hoa, added: ["drizzle/0219_b.sql"] }], reservations: [], ownMission: null });
  const hoa599 = checkPrMigrations({ pr: 599, createdAt: hoa, added: ["drizzle/0219_b.sql"], main: main_, others: [{ pr: 598, createdAt: hoa, added: ["drizzle/0219_a.sql"] }], reservations: [], ownMission: null });
  assert.ok(hoa598.problems.length === 0 && hoa599.problems.length === 1, "hoà mốc mở ⇒ số PR nhỏ hơn là bên trước; ĐÚNG MỘT bên đỏ");
  assert.equal(checkPrMigrations({ pr: 9, createdAt: "không-phải-ngày", added: ["drizzle/0219_a.sql"], main: main_, others: [{ pr: 8, createdAt: iso(0), added: ["drizzle/0219_b.sql"] }], reservations: [], ownMission: null }).problems.length, 1, "mốc không đọc được ⇒ coi là va (đóng cửa khi không chắc)");
  const giu = [{ mission: "khac", number: "0219", at: iso(-500) }];
  assert.match(checkPrMigrations({ ...p598, main: main_, others: [], reservations: giu, ownMission: null }).problems.join(), /giữ chỗ/, "số đã có sứ mệnh khác giữ chỗ trước ⇒ đỏ");
  assert.deepEqual(checkPrMigrations({ ...p598, main: main_, others: [], reservations: giu, ownMission: "khac" }).problems, [], "giữ chỗ của CHÍNH sứ mệnh mình không tính");
}

function testRuiRo() {
  assert.equal(classifyRisk(["docs/a.md", "tests/a.test.ts"], CFG).risk, "LOW");
  assert.equal(classifyRisk(["components/x.tsx"], CFG).risk, "LOW", "UI cô lập ⇒ LOW");
  assert.equal(classifyRisk(["lib/queries/report.ts"], CFG).risk, "MEDIUM", "logic nghiệp vụ ⇒ MEDIUM");
  assert.equal(classifyRisk(["lib/auth/access.ts", "docs/a.md"], CFG).risk, "HIGH");
  assert.equal(classifyRisk(["lib/queries/return-rate.ts"], CFG).risk, "CRITICAL");
  assert.equal(classifyRisk(["drizzle/0300_x.sql"], CFG, { destructiveMigration: true }).risk, "CRITICAL", "migration phá dữ liệu ⇒ CRITICAL");
  assert.ok(isDestructiveSql("ALTER TABLE orders DROP COLUMN note;"));
  assert.ok(isDestructiveSql("DROP TABLE x;") && isDestructiveSql("delete from orders where 1=1") && isDestructiveSql("TRUNCATE t"));
  for (const x of ["DROP TYPE order_stage;", "DROP VIEW v;", "DROP MATERIALIZED VIEW mv;", "ALTER TABLE t ALTER COLUMN c TYPE int;", "ALTER TABLE t ALTER COLUMN c SET DATA TYPE text;", 'UPDATE "orders" SET status = 1;', "UPDATE ONLY orders SET a = 1;", "UPDATE orders AS o SET a = 1;", 'ALTER TABLE t ALTER COLUMN "ten cot" TYPE int;'])
    assert.ok(isDestructiveSql(x), `phải nhận ra câu phá / đổi dữ liệu: ${x}`);
  assert.ok(!isDestructiveSql("ALTER TABLE t ALTER COLUMN c DROP DEFAULT; ALTER TABLE t DROP CONSTRAINT k; CREATE TABLE IF NOT EXISTS z (id int); -- DROP TABLE trong chú thích"), "bỏ ràng buộc / mặc định / chú thích không phải phá dữ liệu");
  // Chính sách không nới được ở bậc CRITICAL, và nhánh điều khiển không trỏ được vào main.
  assert.match(parseConfig({ mergePolicy: { CRITICAL: "AUTO" } }).errors.join(), /CRITICAL: phải là OWNER/);
  assert.match(parseConfig({ controlBranch: "main" }).errors.join(), /ai-control\//);
  assert.match(parseConfig({ controlBranch: "claude/x" }).errors.join(), /ai-control\//);
  assert.deepEqual(parseConfig({ controlBranch: "ai-control/registry", mergePolicy: { HIGH: "AUTO" } }).errors, []);
  assert.deepEqual(parsePrDependencies("Mục tiêu\nPhụ thuộc: #12, #15\n- Depends-on: #3\nkhông phải #99"), [3, 12, 15]);
}

function qi(pr: number, over: Partial<QueueItem> = {}): QueueItem {
  return { pr, title: `PR ${pr}`, branch: `claude/p${pr}`, sha: String(pr).padStart(40, "0"), draft: false, risk: "LOW", gates: "success", mergeable: "clean", deps: [], files: [`docs/p${pr}.md`], migrationProblems: [], createdAt: iso(-1000 + pr), reviewed: false, ...over };
}

function testHangDoi() {
  const v = (rows: ReturnType<typeof orderQueue>, pr: number) => rows.find((r) => r.item.pr === pr)?.verdict;
  const rows = orderQueue(
    [
      qi(1),
      qi(2, { risk: "MEDIUM", files: ["lib/x.ts"] }),
      qi(3, { deps: [1] }),
      qi(4, { gates: "pending" }),
      qi(5, { gates: "failure" }),
      qi(6, { mergeable: "dirty" }),
      qi(7, { risk: "HIGH", files: ["lib/auth/a.ts"] }),
      qi(8, { risk: "HIGH", files: ["lib/auth/b.ts"], reviewed: true }),
      qi(9, { risk: "CRITICAL", files: ["lib/queries/return-rate.ts"], reviewed: true }),
      qi(10, { files: ["lib/x.ts"] }),
      qi(11, { migrationProblems: ["va số"] }),
      qi(12, { draft: true }),
    ],
    CFG,
  );
  assert.equal(v(rows, 1), "MERGE_NOW");
  assert.equal(v(rows, 10), "MERGE_NOW", "LOW đi trước MEDIUM; nhiều PR rủi ro thấp cùng một lô — một lần deploy");
  assert.equal(v(rows, 3), "WAIT_DEPENDENCY", "phụ thuộc #1 còn mở ⇒ chờ");
  assert.equal(v(rows, 4), "WAIT_GATES");
  assert.equal(v(rows, 5), "FIX_GATES");
  assert.equal(v(rows, 6), "FIX_CONFLICT");
  assert.equal(v(rows, 7), "NEEDS_REVIEW", "HIGH chưa có review độc lập ⇒ không gộp");
  assert.equal(v(rows, 8), "WAIT_SERIAL", "HIGH đã review vẫn đi RIÊNG — chờ lô hiện tại deploy xong");
  assert.equal(v(rows, 9), "NEEDS_OWNER", "CRITICAL ⇒ chủ shop");
  assert.equal(v(rows, 2), "WAIT_SERIAL", "chạm cùng tệp với #10 trong lô ⇒ không cùng lô (ruleset strict đang tắt — xung đột ngữ nghĩa lọt qua nếu gộp cả hai)");
  assert.equal(v(rows, 11), "MIGRATION_COLLISION");
  assert.equal(v(rows, 12), "DRAFT");
  assert.equal(rows[0].verdict, "MERGE_NOW", "việc gộp được đứng đầu");
  const alone = orderQueue([qi(20, { risk: "HIGH", files: ["lib/auth/a.ts"], reviewed: true }), qi(21, { risk: "HIGH", files: ["lib/auth/z.ts"], reviewed: true })], CFG);
  assert.equal(v(alone, 20), "MERGE_ISOLATED", "lô trống ⇒ HIGH đi một mình");
  assert.equal(v(alone, 21), "WAIT_SERIAL", "HIGH thứ hai chờ HIGH thứ nhất deploy + hậu kiểm");
}

function testDeployVaHauKiem() {
  const base = { productionSha: "p".repeat(40), mainSha: "m".repeat(40), undeployed: [{ sha: "m".repeat(40), subject: "x", risk: "LOW" as const, migrations: [] }], mainGates: "success" as const, deployActive: [], leaseHolder: "me", me: "me" };
  assert.equal(planDeploy(base).action, "DEPLOY");
  assert.equal(planDeploy({ ...base, productionSha: base.mainSha }).action, "NOTHING");
  assert.equal(planDeploy({ ...base, productionSha: null }).action, "UNKNOWN_PRODUCTION");
  assert.equal(planDeploy({ ...base, deployActive: [{ id: 1, sha: base.mainSha, status: "in_progress" }] }).action, "WAIT_DEPLOY", "không deploy chồng");
  assert.equal(planDeploy({ ...base, mainGates: "failure" }).action, "FIX_MAIN", "main đỏ ⇒ không lên production");
  assert.equal(planDeploy({ ...base, leaseHolder: "nguoi-khac" }).action, "NEED_LEASE", "một chủ deploy");
  assert.equal(planDeploy({ ...base, leaseHolder: null }).action, "NEED_LEASE");
  assert.match(planDeploy({ ...base, undeployed: [{ ...base.undeployed[0], risk: "HIGH" }, { ...base.undeployed[0], risk: "HIGH" }] }).notes.join(), /rủi ro cao trong cùng một lô/);
  assert.match(planDeploy({ ...base, mainGates: "pending" }).notes.join(), /CHỜ đúng lượt đó/);

  const sha = "abcdef123456".padEnd(40, "0");
  const good = { expectedSha: sha, health: { ok: true, commit: "abcdef123456", platform: { migrations: 222 } }, expectedMigrations: 222, deployRun: { conclusion: "success", status: "completed", url: "u" }, endpoints: [{ path: "/login", status: 200 }] };
  assert.equal(verifyVerdict(good).pass, true);
  assert.equal(verifyVerdict({ ...good, health: { ...good.health, commit: "999999999999" } }).pass, false, "bản đang chạy khác bản mong đợi ⇒ KHÔNG ĐẠT, dù deploy xanh");
  assert.equal(verifyVerdict({ ...good, health: { ...good.health, platform: { migrations: 221 } } }).pass, false, "thiếu một migration ⇒ KHÔNG ĐẠT");
  assert.equal(verifyVerdict({ ...good, deployRun: null }).pass, false);
  assert.equal(verifyVerdict({ ...good, deployRun: { conclusion: "failure", status: "completed", url: "u" } }).pass, false);
  assert.equal(verifyVerdict({ ...good, endpoints: [{ path: "/login", status: 502 }] }).pass, false);
  assert.equal(verifyVerdict({ ...good, health: null, healthError: "timeout" }).pass, false);
}

function testChongTrung() {
  assert.equal(intakeVerdict({ keywords: ["ai", "sales", "fanpage"], mainFiles: [], active: [{ kind: "PR", id: "#600", title: "AI sales theo fanpage", matched: ["sales", "fanpage"], pathOverlap: [] }] }).verdict, "IN_PROGRESS");
  assert.equal(intakeVerdict({ keywords: ["a"], mainFiles: [], active: [{ kind: "MISSION", id: "x", title: "x", matched: [], pathOverlap: ["lib/x/"] }] }).verdict, "IN_PROGRESS", "chồng phạm vi với việc đang chạy là tín hiệu mạnh");
  assert.equal(intakeVerdict({ keywords: ["logistics", "canh", "bao"], mainFiles: ["lib/alerts/x.ts"], active: [{ kind: "BRANCH", id: "b", title: "logistics", matched: ["logistics"], pathOverlap: [] }] }).verdict, "PARTIAL", "khớp 1/3 từ khoá không đủ gọi là đang làm");
  assert.equal(intakeVerdict({ keywords: ["x"], mainFiles: [], active: [] }).verdict, "MISSING");
  assert.equal(validateEntry({ ...entry("v"), status: "XONG" }).entry, null);
  assert.equal(validateEntry({ ...entry("v"), branch: "--all" }).entry, null, "nhánh trong sổ không được đọc thành cờ git");
  assert.equal(validateEntry({ ...entry("v"), migration_reservations: ["219"] }).entry, null);
  assert.ok(validateEntry(entry("v")).entry);
}

/* ═════════════ 4 · VÒNG ĐỜI THẬT: HAI PHIÊN, MỘT SỔ, MỘT REMOTE TẠM ═════════════ */

function g(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.name=kiem-thu", "-c", "user.email=kiem-thu@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8" });
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
    return { code: await main(args, cwd, { actor: `may:${path.basename(cwd)}` }), text };
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

async function testVongDoi() {
  const tmp = realDir(mkdtempSync(path.join(tmpdir(), "dieu-phoi-v2-")));
  try {
    const origin = path.join(tmp, "origin.git");
    const seed = path.join(tmp, "seed");
    g(tmp, "init", "--bare", "--initial-branch=main", origin);
    g(tmp, "init", "--initial-branch=main", seed);
    put(path.join(seed, ".gitattributes"), "* text=auto eol=lf\n");
    put(path.join(seed, ".ai", "config.json"), JSON.stringify({ hotspots: [{ path: "drizzle/", rule: "SERIAL", reason: "số hiệu" }], riskFloor: [{ path: "drizzle/", risk: "HIGH", reason: "migration" }] }));
    put(path.join(seed, "drizzle", "0000_a.sql"), "select 1;\n");
    put(path.join(seed, "drizzle", "0001_b.sql"), "select 1;\n");
    put(path.join(seed, "src", "a", "x.ts"), "export const x = 1;\n");
    g(seed, "add", "-A");
    g(seed, "commit", "-m", "gốc");
    g(seed, "remote", "add", "origin", origin);
    g(seed, "push", "-u", "origin", "main");
    // Hai PHIÊN = hai bản clone ở hai thư mục ⇒ hai nhãn phiên khác nhau (máy:tên-cây).
    const A = path.join(tmp, "phien-a");
    const B = path.join(tmp, "phien-b");
    g(tmp, "clone", origin, A);
    g(tmp, "clone", origin, B);

    // ── Đăng ký + chặn chồng phạm vi xuyên phiên ──
    const ca = await ai(A, "claim", "m-a", "--title=Sứ mệnh A", "--paths=src/a/", "--status=RUNNING");
    assert.equal(ca.code, 0, ca.text);
    assert.ok(g(A, "ls-remote", "origin", "refs/heads/ai-control/registry").length > 0, "sổ nằm trên REMOTE, không chỉ trong phiên");
    const cb = await ai(B, "claim", "m-b", "--title=Sứ mệnh B", "--paths=src/a/x.ts", "--status=RUNNING");
    assert.equal(cb.code, 1, "phiên B thấy phạm vi phiên A đã giữ dù hai phiên không chung thư mục nào");
    assert.match(cb.text, /OVERLAP với m-a/);
    const cb2 = await ai(B, "claim", "m-b", "--title=Sứ mệnh B", "--paths=src/a/x.ts", "--status=RUNNING", "--after=m-a");
    assert.equal(cb2.code, 0, cb2.text);
    const intake = await ai(B, "claim", "m-c", "--title=C", "--paths=src/c/", "--intake=IN_PROGRESS", "--intake-evidence=PR #7");
    assert.equal(intake.code, 1);
    assert.match(intake.text, /DUPLICATE/);
    assert.equal((await ai(B, "claim", "m-c", "--title=C", "--paths=src/c/", "--intake=PARTIAL")).code, 0);
    const lach = await ai(B, "claim", "m-c", "--status=DONE");
    assert.notEqual(lach.code, 0, "claim --status=DONE là cửa lách bằng chứng của close");
    assert.match(lach.text, /DONE đi qua `close/);
    assert.notEqual((await ai(B, "claim", "m-c", "--status=CANCELLED")).code, 0, "huỷ không bằng chứng qua claim ⇒ từ chối (huỷ là nhả phạm vi)");
    assert.notEqual((await ai(B, "heartbeat", "m-c", "--status=CANCELLED")).code, 0, "…và qua heartbeat cũng vậy");

    // ── Khoá: một chủ = nhãn + MÃ PHIÊN; cùng cây mà không có mã là người lạ; phục hồi bằng --resume ──
    const la = await ai(A, "lease", "acquire", "integration-lead", "--purpose=gộp lô");
    assert.equal(la.code, 0, la.text);
    const ma = /mã phiên: ([0-9a-f]{32})/.exec(la.text)?.[1];
    assert.ok(ma, "lấy khoá phải cấp mã phiên");
    const lb = await ai(B, "lease", "acquire", "integration-lead");
    assert.equal(lb.code, 1);
    assert.match(lb.text, /phien-a/, "bên thua biết ai đang giữ");
    const cungCay = await ai(A, "lease", "acquire", "integration-lead");
    assert.equal(cungCay.code, 1, "phiên THỨ HAI trong cùng cây (cùng nhãn máy:cây, không có mã) ⇒ bị từ chối — review 06/10/2026");
    assert.match(cungCay.text, /KHÔNG đúng mã phiên/);
    assert.equal((await ai(A, "lease", "renew", "integration-lead", `--token=${ma}`)).code, 0, "chủ trình đúng mã ⇒ gia hạn");
    assert.equal((await ai(A, "lease", "acquire", "integration-lead", "--resume")).code, 0, "phục hồi sau sập trong cùng cây: --resume đọc mã đã lưu");
    assert.equal((await ai(B, "lease", "release", "integration-lead")).code, 1, "không nhả hộ");
    const mo = readControl(openRepo(A), { fetch: true }).leases.find((l) => l.name === "integration-lead");
    assert.ok(mo?.token_hash && !JSON.stringify(mo).includes(ma), "sổ (kho PUBLIC) chỉ giữ BĂM của mã phiên");

    // ── Phiên giữ khoá CHẾT: khoá hết hạn ⇒ phiên khác tiếp quản, nhật ký ghi rõ ──
    const ctxB = openRepo(B);
    mutateControl(ctxB, "kiem-thu:mo-phong", (st) => ({
      change: {
        put: { "lease.integration-lead.json": `${JSON.stringify({ name: "integration-lead", holder: "may:phien-chet", purpose: "deploy", acquired_at: iso(-200), heartbeat_at: iso(-200), expires_at: iso(-5), generation: (st.leases[0]?.generation ?? 0) + 1 })}\n` },
        message: "mô phỏng phiên chết giữa chừng",
      },
      result: null,
    }));
    const tk = await ai(B, "lease", "acquire", "integration-lead");
    assert.equal(tk.code, 0, tk.text);
    assert.match(tk.text, /hết hạn .* tiếp quản/);
    assert.ok(readControl(ctxB, { fetch: true }).events.some((e) => e.kind === "LEASE_TAKEOVER" && /phien-chet/.test(e.detail)), "tiếp quản phải để lại dấu vết");

    // ── So-và-ghi: ghi trên một đỉnh cũ bị REMOTE từ chối (không mất lượt ghi của người kia) ──
    const ctxA = openRepo(A);
    const cu = readControl(ctxA, { fetch: true });
    assert.equal((await ai(B, "heartbeat", "m-b")).code, 0);
    assert.throws(() => writeControl(ctxA, cu, { put: { "mission.m-a.json": "{}" }, message: "ghi đè mù" }, "a"), ControlConflict, "đỉnh đã đổi ⇒ bị từ chối, không ghi đè");
    const sau = readControl(ctxA, { fetch: true });
    assert.ok(sau.entries.find((e) => e.mission_id === "m-a")?.title === "Sứ mệnh A", "dòng của A còn nguyên — lượt ghi mù không lọt");

    // ── Dấu review độc lập: trong SỔ, gắn đúng SHA đầu nhánh ──
    const shaReview = "c".repeat(40);
    const tuCham = await ai(A, "review", "42", `--sha=${shaReview}`, "--verdict=PASS");
    assert.equal(tuCham.code, 1, "phiên KHÔNG cầm khoá Lead (vd worker tự chấm mình) không ghi được PASS");
    assert.match(tuCham.text, /worker không tự chấm mình/);
    assert.equal((await ai(B, "review", "42", `--sha=${shaReview}`, "--verdict=PASS", "--resume", "--note=ai-tech-reviewer ĐẠT")).code, 0, "phiên cầm integration-lead (đúng mã) ghi được PASS");
    const rv = readControl(openRepo(B), { fetch: true }).reviews;
    assert.ok(reviewedAt(rv, 42, shaReview), "dấu review đọc được từ phiên khác");
    assert.ok(!reviewedAt(rv, 42, "d".repeat(40)), "đầu nhánh đổi (commit mới sau review) ⇒ dấu MẤT hiệu lực");
    assert.ok(!reviewedAt(rv, 43, shaReview), "dấu của PR này không dùng được cho PR khác");
    assert.notEqual((await ai(A, "review", "42", "--sha=abc", "--verdict=PASS")).code, 0, "SHA phải đủ 40 ký tự");

    // ── Giữ chỗ migration xuyên phiên ──
    const ra = await ai(A, "migration", "reserve", "--mission=m-a");
    assert.match(ra.text, /✓ 0002/, ra.text);
    const rb = await ai(B, "migration", "reserve", "--mission=m-b");
    assert.match(rb.text, /✓ 0003/, "phiên B không lấy lại số A vừa giữ");
    assert.equal((await ai(A, "migration", "next")).text.trim(), "0004");
    g(B, "checkout", "-q", "-b", "claude/m-b");
    put(path.join(B, "drizzle", "0002_cua_b.sql"), "create table b (id int);\n");
    g(B, "add", "-A");
    g(B, "commit", "-q", "-m", "B lấy nhầm số của A");
    assert.equal((await ai(B, "claim", "m-b", "--branch=claude/m-b")).code, 0);
    const chk = await ai(B, "migration", "check");
    assert.equal(chk.code, 1, chk.text);
    assert.match(chk.text, /0002 đã được sứ mệnh m-a giữ chỗ/);
    g(B, "mv", "drizzle/0002_cua_b.sql", "drizzle/0003_cua_b.sql");
    g(B, "commit", "-q", "-m", "B dùng đúng số mình giữ");
    const chk2 = await ai(B, "migration", "check");
    assert.equal(chk2.code, 0, chk2.text);

    // ── Phục hồi: phiên mới không có gì trong bộ nhớ ⇒ đọc lại toàn bộ từ remote ──
    g(B, "update-ref", "-d", "refs/remotes/origin/ai-control/registry");
    const off = await ai(B, "board", "--offline");
    assert.match(off.text, /sổ chưa có sứ mệnh nào/, "mất bản sao cục bộ ⇒ không đoán");
    const on = await ai(B, "board");
    assert.equal(on.code, 0, on.text);
    for (const id of ["m-a", "m-b", "m-c"]) assert.match(on.text, new RegExp(id), `phục hồi thấy lại ${id}`);
    assert.match(on.text, /BACKLOG .* m-b/, "m-b khai sau m-a ⇒ bảng nói BACKLOG (chờ), không nói RUNNING");
    assert.match(on.text, /integration-lead — \S*phien-b/, "bảng nói ai đang cầm khoá");

    // ── Sự thật thắng lời khai: nhánh của A đã vào main ⇒ bảng nói INTEGRATING, kèm "lệch" ──
    g(A, "checkout", "-q", "-b", "claude/m-a");
    put(path.join(A, "src", "a", "y.ts"), "export const y = 2;\n");
    g(A, "add", "-A");
    g(A, "commit", "-q", "-m", "việc của A");
    g(A, "push", "-q", "origin", "claude/m-a");
    assert.equal((await ai(A, "claim", "m-a", "--branch=claude/m-a")).code, 0);
    g(A, "checkout", "-q", "main");
    g(A, "merge", "-q", "--no-ff", "-m", "gộp A", "claude/m-a");
    g(A, "push", "-q", "origin", "main");
    const bd = await ai(B, "board");
    assert.match(bd.text, /INTEGRATING .* m-a/, bd.text);
    assert.match(bd.text, /đã vào main/);
    assert.ok(!/BACKLOG .* m-b/.test(bd.text), "phụ thuộc đã VÀO MAIN là xong cho bên chờ — không phải đợi một dòng sổ");
    const khongRuntime = await ai(A, "close", "m-a", "--status=DONE", "--evidence=gộp A", "--no-runtime");
    assert.equal(khongRuntime.code, 1, "--no-runtime là khẳng định về TỆP — nhánh chạm src/a/y.ts (chạy trên VPS) ⇒ từ chối");
    assert.match(khongRuntime.text, /tệp chạy trên VPS \(src\/a\/y\.ts\)/);
    assert.equal((await ai(A, "claim", "m-x", "--title=X", "--paths=src/x/")).code, 0);
    const traiTay = await ai(A, "close", "m-x", "--status=DONE", "--evidence=tin tôi đi", "--no-runtime");
    assert.equal(traiTay.code, 1, "không nhánh lẫn PR ⇒ DONE không chứng minh được");
    assert.match(traiTay.text, /không có nhánh lẫn PR/);
    assert.equal((await ai(A, "close", "m-x", "--status=CANCELLED", "--evidence=thử nghiệm của bài kiểm")).code, 0);
    const close1 = await ai(A, "close", "m-a", "--status=DONE", "--evidence=gộp A");
    assert.equal(close1.code, 1, "DONE khi chưa hậu kiểm production ⇒ từ chối");
    assert.match(close1.text, /verify --record/);
    const datVerify = (sha: string) =>
      mutateControl(openRepo(A), "kiem-thu:verify", (st) => {
        const e = st.entries.find((x) => x.mission_id === "m-a") as RegistryEntry;
        return { change: { put: { "mission.m-a.json": `${JSON.stringify({ ...e, evidence: { ...(e.evidence ?? {}), verify: `PASS ${sha} ${iso(0)}` } }, null, 2)}\n` }, message: "mô phỏng verify --record" }, result: null };
      });
    datVerify(g(A, "rev-parse", "main~1"));
    const close2 = await ai(A, "close", "m-a", "--status=DONE", "--evidence=gộp A");
    assert.equal(close2.code, 1, "verify ĐẠT trên một bản CŨ (chưa chứa việc của sứ mệnh) không chứng minh gì");
    assert.match(close2.text, /CHƯA chứa commit đưa sứ mệnh vào main/);
    datVerify(g(A, "rev-parse", "main"));
    const close3 = await ai(A, "close", "m-a", "--status=DONE", "--evidence=gộp A · verify ĐẠT");
    assert.equal(close3.code, 0, close3.text);
    const bd2 = await ai(B, "board");
    assert.ok(!/BACKLOG .* m-b/.test(bd2.text), "phụ thuộc đã khép ⇒ m-b hết phải chờ");
    // Đã khép ⇒ phạm vi nhả: một sứ mệnh mới giữ src/a/ được ngay.
    assert.equal((await ai(B, "claim", "m-d", "--title=D", "--paths=src/a/")).code, 1, "m-b còn mở và giữ src/a/x.ts ⇒ chồng");
    assert.equal((await ai(B, "claim", "m-d", "--title=D", "--paths=src/a/", "--accept-overlap=m-d chỉ thêm tệp mới, không sửa x.ts")).code, 0);
    const kinds = readControl(ctxA, { fetch: true }).events.map((e) => e.kind);
    for (const k of ["CLAIM", "OVERLAP_DETECTED", "DUPLICATE_PREVENTED", "LEASE_ACQUIRED", "LEASE_TAKEOVER", "MIGRATION_RESERVED", "DONE", "OVERLAP_ACCEPTED"]) assert.ok(kinds.includes(k), `nhật ký sổ phải có ${k} (để đo được trùng việc đã chặn, khoá đổi tay…)`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ═════════════ 5 · MÃ NGUỒN: CHỈ MỘT CHỖ ĐẨY, VÀ CHỈ LÊN NHÁNH ĐIỀU KHIỂN ═════════════ */

function testChiMotChoDay() {
  const src = doc("scripts/ai-tech.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.equal(src.split('"push"').length - 1, 1, "công cụ đẩy lên remote ở ĐÚNG một chỗ");
  const fn = src.slice(src.indexOf("function pushControlCommit("), src.indexOf("export function mutateControl"));
  assert.ok(fn.includes('"push"'), "chỗ đẩy duy nhất nằm trong pushControlCommit");
  assert.match(fn, /\[\s*"push", "--quiet", "--porcelain", ctx\.config\.remote, `\$\{commit\}:refs\/heads\/\$\{ctx\.config\.controlBranch\}`\s*\]/, "refspec cố định: một commit → đúng nhánh điều khiển, không `+`");
  assert.match(fn, /CONTROL_BRANCH_RE\.test\(ctx\.config\.controlBranch\)/, "kiểm lại tên nhánh ngay trước khi đẩy");
  assert.ok(!/"--force(?:-with-lease)?[="]|"-f"|`\+\$\{|"\+refs\//.test(src), "không tham số đẩy ép / refspec `+` nào trong lời gọi git");
}

export async function testDeliveryV2() {
  testCongSongSong();
  testDeployDungLaiBangChung();
  testKhoa();
  testChongPhamVi();
  testDoiChieu();
  testMigration();
  testRuiRo();
  testHangDoi();
  testDeployVaHauKiem();
  testChongTrung();
  testChiMotChoDay();
  await testVongDoi();
  console.log("✓ Điều phối V2: cổng song song đỏ đúng chỗ · deploy chỉ với cổng/bằng chứng của đúng SHA · sổ xuyên phiên · khoá một chủ có hạn · giữ chỗ migration · hàng đợi gộp · hậu kiểm");
}

if (/delivery-v2\.test\.ts$/.test(process.argv[1] ?? "")) {
  testDeliveryV2().then(
    () => console.log("ĐẠT"),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
