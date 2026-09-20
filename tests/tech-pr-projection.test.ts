import assert from "node:assert/strict";
import { and, eq, inArray, like } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  SYNC_INCIDENT_RULE,
  classifySyncJobHealth,
  syncIncidentModule,
  syncIncidentTitle,
} from "@/lib/constants/sync-incidents";
import {
  techCiStateFromChecks,
  techMergeStateFromGithub,
  techPrStateFromGithub,
  techReviewStateFromReviews,
} from "@/lib/constants/tech";
import { __setGithubFetchForTests } from "@/lib/integrations/github/client";
import { PR_DETAIL_BUDGET, syncGithubPullRequests } from "@/lib/integrations/github/pull-requests";
import { lastGithubRead } from "@/lib/integrations/github/read-marker";
import { setTechTaskStatus } from "@/lib/tech/service";
import { watchSyncFailures } from "@/lib/tech/sync-incident-watch";
import { createTechTask, type TechActor } from "@/lib/tech/service";

/**
 * ═══════════ PHÉP CHIẾU PR + SỰ CỐ TỰ MỞ ═══════════
 *
 * Hai sợi dây được nối trong lượt này, và cả hai đều nối một thứ ĐÃ CÓ vào một thứ ĐÃ CÓ:
 *
 *  · Chín ô `pr_*` của `tech_tasks` (migration `0104`) — dựng từ lâu, tới 20/09/2026 không một
 *    dòng mã nào ghi hay đọc.
 *  · `sync_runs` FAILED → `tech_incidents` — sổ sự cố có 0 dòng đang mở trong khi `facebook-ads`
 *    hỏng lặp lại nhiều giờ.
 *
 * Mốc thời gian đi theo ĐỒNG HỒ THẬT (AGENTS.md mục 50): dữ liệu gieo tương đối so với `now()`,
 * và truy vấn cũng lọc theo `now()`. Dữ liệu tự nhận ra bằng tiền tố `prj-`.
 */

const MAY: TechActor = { kind: "SYSTEM", name: "test:pr-projection" };

/* ═════════════════ 1 · BỐN PHÉP ÁNH XẠ — HÀM THUẦN ═════════════════ */

export function testPrPureMappers() {
  // ───────── 1.1 `closed` mang hai nghĩa, và `merged` là thứ phân biệt ─────────
  assert.equal(techPrStateFromGithub("open", false), "OPEN");
  assert.equal(techPrStateFromGithub("closed", false), "CLOSED");
  assert.equal(techPrStateFromGithub("closed", true), "MERGED", "PR đã gộp KHÔNG được đọc ra là 'đã đóng'");
  assert.equal(techPrStateFromGithub("", false), "", "trạng thái lạ ⇒ CHƯA BIẾT, không đoán");

  /*
    ───────── 1.2 CÁI BẪY: MẢNG RỖNG ─────────
    `[].every(...)` trả `true`, nên một bản viết tự nhiên sẽ kết luận "mọi check đều xanh" cho một
    PR mà cổng `gates` còn chưa khởi động. Một PR chưa ai chạy cổng mà hiện "cổng xanh" là đúng
    loại lời nói dối sẽ được dùng để bấm gộp.
  */
  assert.equal(techCiStateFromChecks([]), "", "KHÔNG có check nào ⇒ CHƯA BIẾT, tuyệt đối không phải SUCCESS");

  assert.equal(techCiStateFromChecks([{ status: "completed", conclusion: "success" }]), "SUCCESS");
  assert.equal(
    techCiStateFromChecks([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ]),
    "FAILURE",
    "một check đỏ thắng mọi check xanh",
  );
  assert.equal(
    techCiStateFromChecks([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ]),
    "PENDING",
    "còn check chưa xong ⇒ chưa kết luận được",
  );
  assert.equal(
    techCiStateFromChecks([
      { status: "completed", conclusion: "failure" },
      { status: "in_progress", conclusion: null },
    ]),
    "FAILURE",
    "đỏ thắng cả 'đang chạy' — biết chắc đã hỏng thì không phải chờ",
  );
  assert.equal(
    techCiStateFromChecks([
      { status: "completed", conclusion: "skipped" },
      { status: "completed", conclusion: "neutral" },
    ]),
    "SUCCESS",
    "job bị điều kiện `if` bỏ qua KHÔNG phải lỗi — xếp nó vào đỏ thì mọi PR đều đỏ",
  );
  assert.equal(techCiStateFromChecks([{ status: "completed", conclusion: "timed_out" }]), "FAILURE");
  assert.equal(techCiStateFromChecks([{ status: "completed", conclusion: "cancelled" }]), "FAILURE");

  // ───────── 1.3 Chỉ LƯỢT CUỐI của mỗi người mới tính ─────────
  assert.equal(techReviewStateFromReviews([]), "REVIEW_REQUIRED", "đọc được và không ai duyệt là một KẾT QUẢ, không phải chưa biết");
  assert.equal(
    techReviewStateFromReviews([
      { user: "a", state: "APPROVED" },
      { user: "a", state: "CHANGES_REQUESTED" },
    ]),
    "CHANGES_REQUESTED",
    "người đó đã đổi ý — đếm gộp cả lịch sử sẽ báo 'đã duyệt' cho một PR đang bị chặn",
  );
  assert.equal(
    techReviewStateFromReviews([
      { user: "a", state: "CHANGES_REQUESTED" },
      { user: "a", state: "APPROVED" },
    ]),
    "APPROVED",
  );
  assert.equal(
    techReviewStateFromReviews([
      { user: "a", state: "APPROVED" },
      { user: "b", state: "CHANGES_REQUESTED" },
    ]),
    "CHANGES_REQUESTED",
    "một người yêu cầu sửa thắng mọi lượt duyệt của người khác",
  );
  assert.equal(
    techReviewStateFromReviews([
      { user: "a", state: "APPROVED" },
      { user: "a", state: "DISMISSED" },
    ]),
    "REVIEW_REQUIRED",
    "ruleset của kho này HUỶ DUYỆT khi có push mới — lượt duyệt bị huỷ không còn là lượt duyệt",
  );
  assert.equal(
    techReviewStateFromReviews([
      { user: "a", state: "APPROVED" },
      { user: "b", state: "COMMENTED" },
    ]),
    "APPROVED",
    "bình luận không đổi lập trường của ai",
  );

  // ───────── 1.4 `mergeable = null` là GitHub CÒN ĐANG TÍNH, không phải một câu trả lời ─────────
  assert.equal(techMergeStateFromGithub(false, null), "", "chưa tính xong ⇒ CHƯA BIẾT");
  assert.equal(techMergeStateFromGithub(false, true), "MERGEABLE");
  assert.equal(techMergeStateFromGithub(false, false), "CONFLICT");
  assert.equal(techMergeStateFromGithub(true, null), "MERGED", "đã gộp thì thôi không hỏi gộp được chưa");

  console.log("✓ Phép chiếu PR: bốn ánh xạ thuần, mảng check rỗng KHÔNG ra 'xanh'");
}

/* ═════════════════ 2 · CHÉP TRẠNG THÁI PR VỀ VIỆC TECH ═════════════════ */

type GioPr = { number: number; headRef: string; sha: string; state?: string; merged?: boolean; mergeable?: boolean | null; title?: string };

/**
 * GitHub giả. Bốn endpoint, và nó ĐẾM số lượt gọi từng loại — để bài kiểm chứng minh được rằng
 * chỉ PR ĐÃ GẮN VIỆC mới phải trả giá ba lượt đọc chi tiết, chứ không tin vào lời kể.
 */
function fakeGithubPr(prs: GioPr[], checks: Record<number, { status: string; conclusion: string | null }[]>, reviews: Record<number, { user: string; state: string }[]>) {
  const goi = { list: 0, detail: 0, checks: 0, reviews: 0 };
  const raw = (p: GioPr) => ({
    number: p.number,
    title: p.title ?? `PR ${p.number}`,
    state: p.state ?? "open",
    merged: p.merged ?? false,
    merged_at: p.merged ? new Date().toISOString() : null,
    mergeable: p.mergeable === undefined ? null : p.mergeable,
    html_url: `https://github.com/owner/repo/pull/${p.number}`,
    updated_at: new Date().toISOString(),
    head: { ref: p.headRef, sha: p.sha },
    base: { ref: "main", sha: "base".padEnd(40, "0") },
  });
  __setGithubFetchForTests((async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/pulls?")) {
      goi.list += 1;
      return new Response(JSON.stringify(prs.map(raw)), { status: 200 });
    }
    const rv = /\/pulls\/(\d+)\/reviews/.exec(u);
    if (rv) {
      goi.reviews += 1;
      const n = Number(rv[1]);
      return new Response(JSON.stringify((reviews[n] ?? []).map((r) => ({ user: { login: r.user }, state: r.state, submitted_at: new Date().toISOString() }))), { status: 200 });
    }
    const ck = /\/commits\/([^/]+)\/check-runs/.exec(u);
    if (ck) {
      goi.checks += 1;
      const p = prs.find((x) => x.sha === decodeURIComponent(ck[1]));
      return new Response(JSON.stringify({ check_runs: p ? (checks[p.number] ?? []) : [] }), { status: 200 });
    }
    const ct = /\/pulls\/(\d+)$/.exec(u);
    if (ct) {
      goi.detail += 1;
      const p = prs.find((x) => x.number === Number(ct[1]));
      return new Response(JSON.stringify(p ? raw(p) : {}), { status: p ? 200 : 404 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }) as typeof fetch);
  return goi;
}

export async function testGithubPrSync() {
  const db = await getDb();
  process.env.ERP_GITHUB_REPO = "owner/repo";
  delete process.env.ERP_GITHUB_TOKEN;

  const nhanh = "ai/backend/prj-1-abc";
  const tao = await createTechTask(
    { title: "prj- việc có nhánh và sẽ có PR", taskType: "BUGFIX", module: "TECH", priority: "P2", source: "OWNER", branch: nhanh },
    MAY,
  );
  assert.ok("ok" in tao, "tạo việc kiểm thử phải thành công");
  const taskId = "ok" in tao ? tao.id : "";

  const tao2 = await createTechTask(
    { title: "prj- việc có nhánh nhưng CHƯA có PR", taskType: "BUGFIX", module: "TECH", priority: "P2", source: "OWNER", branch: "ai/backend/prj-2-khongcopr" },
    MAY,
  );
  assert.ok("ok" in tao2);
  const taskId2 = "ok" in tao2 ? tao2.id : "";

  const truoc = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId) });
  assert.ok(truoc);
  assert.equal(truoc.prState, "", "việc mới phải ở CHƯA BIẾT, không phải 'chưa có PR'");
  const mocViec = truoc.updatedAt;

  const sha = "a".repeat(40);
  const goi = fakeGithubPr(
    [
      { number: 101, headRef: nhanh, sha },
      // PR mở, KHÔNG việc nào nhận — phải được ĐẾM, không được nuốt.
      { number: 102, headRef: "claude/ai-nguoi-khac", sha: "b".repeat(40) },
      // Tiêu đề nhắc mã việc: KHÔNG được nối. Nối bằng khoá, không bằng ô chữ.
      { number: 103, headRef: "claude/khac-han", sha: "c".repeat(40), title: `Nối tiếp ${truoc.code}` },
    ],
    { 101: [{ status: "completed", conclusion: "success" }] },
    { 101: [{ user: "chu-shop", state: "APPROVED" }] },
  );

  // ───────── 2.1 Nối bằng NHÁNH, và chỉ bằng nhánh ─────────
  const lan1 = await syncGithubPullRequests({ limit: 50 });
  assert.equal(lan1.pullsScanned, 3);
  assert.equal(lan1.matched, 1, "đúng MỘT việc gắn được PR — tiêu đề nhắc mã việc KHÔNG phải một khoá");
  assert.equal(lan1.updated, 1);
  assert.equal(lan1.errors, 0);
  assert.equal(lan1.unmatchedOpenPulls, 2, "hai PR mở không ai nhận phải được đếm, không được nuốt");
  assert.ok(lan1.unmatchedTasks >= 1, "việc có nhánh mà chưa có PR phải nằm ở 'chưa thấy PR'");
  assert.equal(goi.detail, 1, "chỉ PR ĐÃ GẮN VIỆC mới phải đọc chi tiết — số lượt gọi đi theo việc đang chạy, không theo số PR của kho");

  const sau = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId) });
  assert.ok(sau);
  assert.equal(sau.prNumber, 101);
  assert.equal(sau.prState, "OPEN");
  assert.equal(sau.ciState, "SUCCESS");
  assert.equal(sau.reviewState, "APPROVED");
  assert.equal(sau.mergeState, "", "GitHub giả trả `mergeable: null` ⇒ CHƯA BIẾT, không được thành MERGEABLE");
  assert.equal(sau.headSha, sha);
  assert.ok(sau.prSyncedAt, "mốc đọc phải được ghi");

  /*
    ───────── 2.2 KHÔNG LÀM `updated_at` CỦA VIỆC NHẢY ─────────
    `/tech/tasks` sắp theo cột này. Một job 15 phút/lần chạm vào nó sẽ đẩy mọi việc có nhánh lên
    đầu danh sách mãi mãi, và thứ tự "vừa cập nhật" mất sạch nghĩa.
  */
  assert.equal(sau.updatedAt.getTime(), mocViec.getTime(), "lượt đồng bộ PR KHÔNG được chạm `updated_at` của việc");

  // Việc chưa có PR phải được GIỮ NGUYÊN, không bị ghi đè bằng giá trị rỗng "cho đồng bộ".
  const chuaCo = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId2) });
  assert.equal(chuaCo?.prNumber, null);
  assert.equal(chuaCo?.prSyncedAt, null, "không đọc được gì thì không ghi mốc đọc — mốc rỗng là câu trả lời thật");

  // ───────── 2.3 Nhật ký: MỘT dòng cho một lần đổi, bốn chiều đứng cạnh nhau ─────────
  const nk = await db.query.techTaskEvents.findMany({ where: and(eq(schema.techTaskEvents.taskId, taskId), eq(schema.techTaskEvents.kind, "PR")) });
  assert.equal(nk.length, 1, "một lần đổi ⇒ đúng một dòng nhật ký, không phải bốn");
  assert.equal(nk[0].actorKind, "SYSTEM", "lượt đọc là MÁY làm — không được ghi thành một con người (AGENTS.md mục 36)");
  assert.ok(nk[0].nextValue.includes("CI SUCCESS"), `dòng nhật ký phải in cả bốn chiều, thực tế: ${nk[0].nextValue}`);

  // ───────── 2.4 IDEMPOTENT: chạy lại không đổi gì, và không đẻ dòng nhật ký thứ hai ─────────
  const lan2 = await syncGithubPullRequests({ limit: 50 });
  assert.equal(lan2.updated, 0, "không có gì đổi thì không được đếm là 'đã cập nhật'");
  assert.equal(lan2.unchanged, 1);
  const nk2 = await db.query.techTaskEvents.findMany({ where: and(eq(schema.techTaskEvents.taskId, taskId), eq(schema.techTaskEvents.kind, "PR")) });
  assert.equal(nk2.length, 1, "chạy lại KHÔNG được đẻ thêm dòng nhật ký — nhật ký là chỗ đọc 'ai làm gì', không phải chỗ đổ số đo");

  // Nhưng mốc ĐỌC vẫn phải mới: `pr_synced_at` trả lời "ảnh chụp này cũ bao nhiêu", không phải "đổi lần cuối khi nào".
  const sau2 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId) });
  assert.ok(sau2 && sau2.prSyncedAt && sau!.prSyncedAt && sau2.prSyncedAt.getTime() >= sau!.prSyncedAt.getTime(), "mốc đọc phải được làm mới cả ở lượt không đổi gì");

  // ───────── 2.5 PR gộp rồi: việc KHÔNG tự chuyển trạng thái ─────────
  fakeGithubPr(
    [{ number: 101, headRef: nhanh, sha, state: "closed", merged: true }],
    { 101: [{ status: "completed", conclusion: "success" }] },
    { 101: [{ user: "chu-shop", state: "APPROVED" }] },
  );
  await syncGithubPullRequests({ limit: 50 });
  const sau3 = await db.query.techTasks.findFirst({ where: eq(schema.techTasks.id, taskId) });
  assert.equal(sau3?.prState, "MERGED");
  assert.equal(sau3?.mergeState, "MERGED");
  assert.equal(
    sau3?.status,
    truoc.status,
    "'PR đã gộp' KHÔNG phải 'việc đã xong' — việc còn phải lên production và được xác minh. Một job tự chuyển trạng thái là job tự đóng việc của người khác.",
  );

  /*
    ───────── 2.6 MỐC "ĐỌC ĐƯỢC THẬT" KHÔNG ĐƯỢC NHÍCH KHI GITHUB TỪ CHỐI TRẢ LỜI ─────────

    Bản vá đầu tiên đọc độ tươi từ `sync_runs`: lượt `SUCCESS` hoặc `PARTIAL` thì coi là đã đọc.
    Sai, và sai đúng ở ca cần đúng nhất — mọi nhánh BỎ QUA đều đặt `warning`, mà một lượt có
    `warning` được ghi `PARTIAL`. Nên một lượt đọc được 0 dòng vẫn làm sổ trông MỚI: hết hạn mức
    là lúc sổ CHẮC CHẮN đứng im, mà cũng là lúc nó trông tươi nhất.
  */
  const mocTruoc = await lastGithubRead("pulls");
  assert.ok(mocTruoc, "lượt đọc thành công ở trên phải để lại mốc");
  __setGithubFetchForTests((async () =>
    new Response(JSON.stringify({ message: "API rate limit exceeded" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.round(Date.now() / 1000) + 900) },
    })) as typeof fetch);
  const hetHanMuc = await syncGithubPullRequests({});
  assert.equal(hetHanMuc.skippedKind, "RATE_LIMITED");
  const mocSau = await lastGithubRead("pulls");
  assert.equal(
    mocSau?.getTime(),
    mocTruoc.getTime(),
    "hết hạn mức ⇒ KHÔNG đọc được gì ⇒ mốc đọc PHẢI đứng yên. Nhích nó lên là làm sổ trông tươi nhất đúng lúc nó chắc chắn đứng im",
  );

  /*
    ───────── 2.7 TRẦN LƯỢT GỌI: HOÃN, KHÔNG PHẢI CẮT BỎ ─────────

    Mỗi PR gắn được việc tốn BA lượt gọi. Không có trần thì xấu nhất là 1 + 3×50 = 151 request mỗi
    lượt chạy, tức 604/giờ ở nhịp 15 phút — trong khi đường gọi ẩn danh chỉ có 60/giờ, và hết hạn
    mức thì CẢ `github-deployments` cũng chết theo.
  */
  const nhieu = Array.from({ length: PR_DETAIL_BUDGET + 3 }, (_, i) => ({ number: 400 + i, headRef: `ai/backend/prj-budget-${i}`, sha: `${i}`.padStart(40, "e") }));
  for (const [i] of nhieu.entries()) {
    const t = await createTechTask(
      { title: `prj- việc trần ${i}`, taskType: "BUGFIX", module: "TECH", priority: "P2", source: "OWNER", branch: `ai/backend/prj-budget-${i}` },
      MAY,
    );
    assert.ok("ok" in t);
  }
  const goiNhieu = fakeGithubPr(nhieu, {}, {});
  const coTran = await syncGithubPullRequests({ limit: 60 });
  assert.ok(coTran.deferred >= 3, `phải hoãn phần vượt trần, thực tế hoãn ${coTran.deferred}`);
  assert.ok(goiNhieu.detail <= PR_DETAIL_BUDGET, `số lượt đọc chi tiết phải nằm dưới trần ${PR_DETAIL_BUDGET}, thực tế ${goiNhieu.detail}`);

  /*
    Lượt SAU phải đọc được những việc bị hoãn: thứ tự ưu tiên là "lâu chưa đọc nhất trước"
    (`pr_synced_at` rỗng đứng đầu), nên cái trần là một phép XOAY VÒNG chứ không phải một phép
    cắt bỏ. Không có tính chất này thì vài việc bị bỏ đói vĩnh viễn.
  */
  const goiLan2 = fakeGithubPr(nhieu, {}, {});
  await syncGithubPullRequests({ limit: 60 });
  assert.ok(goiLan2.detail > 0, "lượt sau phải đọc tiếp những việc bị hoãn, không được bỏ đói chúng");
  const daDoc = await db.query.techTasks.findMany({ where: like(schema.techTasks.title, "prj- việc trần%"), columns: { prNumber: true, prSyncedAt: true } });
  assert.ok(daDoc.filter((t) => t.prSyncedAt).length > PR_DETAIL_BUDGET, "sau hai lượt, số việc đã được đọc phải VƯỢT trần của một lượt — đó là bằng chứng nó xoay vòng");

  /*
    ───────── 2.8 VIỆC ĐÃ XONG VỚI PR ĐÃ GỘP THÌ THÔI ĐỌC LẠI ─────────
    GitHub không đổi trạng thái của một PR đã gộp nữa, nên đọc lại chúng mỗi 15 phút là tiêu hạn
    mức vào quá khứ — và chính nhóm này phình to nhất theo thời gian.
  */
  const xong = await setTechTaskStatus({ taskId, to: "DONE", note: "prj- đóng để kiểm cửa sổ đọc lại" }, MAY);
  if ("ok" in xong) {
    const goiSauKhiXong = fakeGithubPr([{ number: 101, headRef: nhanh, sha, state: "closed", merged: true }], {}, {});
    await syncGithubPullRequests({ limit: 60 });
    assert.equal(goiSauKhiXong.detail, 0, "việc DONE + PR MERGED không được đọc lại lần nào nữa");
  }

  // ───────── 2.9 Chưa cấu hình kho ⇒ BỎ QUA có lý do, không phải lỗi ─────────
  delete process.env.ERP_GITHUB_REPO;
  const bq = await syncGithubPullRequests({});
  assert.equal(bq.skippedKind, "NOT_CONFIGURED");
  assert.equal(bq.matched, 0);
  assert.ok(bq.skippedReason && bq.skippedReason.length > 20, "bỏ qua thì phải nói THIẾU ĐÚNG CÁI GÌ");
  process.env.ERP_GITHUB_REPO = "owner/repo";

  __setGithubFetchForTests(null);
  console.log(`✓ Chép PR về việc Tech: nối bằng khoá (1/3 PR), ${lan1.unmatchedOpenPulls} PR mở không ai nhận được đếm, updated_at giữ nguyên`);
}

/* ═════════════════ 3 · JOB HỎNG LIÊN TIẾP → SỰ CỐ ═════════════════ */

export function testSyncIncidentPure() {
  const t = (phut: number) => new Date(Date.now() - phut * 60_000);

  // ───────── 3.1 Một lượt hỏng KHÔNG phải một sự cố ─────────
  const motLan = classifySyncJobHealth([{ status: "FAILED", startedAt: t(5) }, { status: "SUCCESS", startedAt: t(65) }]);
  assert.equal(motLan.consecutiveFailures, 1);
  assert.equal(motLan.warrantsIncident, false, "một lần chập mạng KHÔNG được mở sự cố — sổ đầy nhiễu thì người trực bỏ qua sổ");

  // ───────── 3.2 Lượt ĐANG CHẠY không nối dài chuỗi, cũng không cắt nó ─────────
  const dangChay = classifySyncJobHealth([
    { status: "RUNNING", startedAt: t(1) },
    { status: "FAILED", startedAt: t(20), error: "lỗi A" },
    { status: "FAILED", startedAt: t(40) },
    { status: "FAILED", startedAt: t(60) },
  ]);
  assert.equal(dangChay.consecutiveFailures, 3, "RUNNING chưa phán quyết gì — bỏ qua");
  assert.equal(dangChay.warrantsIncident, true);
  assert.equal(dangChay.lastError, "lỗi A");
  assert.equal(dangChay.firstFailureAt?.getTime(), t(60).getTime(), "mốc phát hiện phải là lượt hỏng ĐẦU chuỗi, không phải lượt gần nhất");

  // ───────── 3.3 `PARTIAL` CẮT chuỗi: job có chạy, có làm được việc ─────────
  const batPhan = classifySyncJobHealth([
    { status: "FAILED", startedAt: t(5) },
    { status: "PARTIAL", startedAt: t(25) },
    { status: "FAILED", startedAt: t(45) },
    { status: "FAILED", startedAt: t(65) },
  ]);
  assert.equal(batPhan.consecutiveFailures, 1, "PARTIAL không phải FAILED — đếm nó là hỏng thì mọi job có một dòng cảnh báo đều thành sự cố");
  assert.equal(batPhan.warrantsIncident, false);

  // ───────── 3.4 Job đã khỏi: lượt gần nhất SUCCESS ⇒ không mở gì ─────────
  const daKhoi = classifySyncJobHealth([
    { status: "SUCCESS", startedAt: t(5) },
    { status: "FAILED", startedAt: t(25) },
    { status: "FAILED", startedAt: t(45) },
    { status: "FAILED", startedAt: t(65) },
  ]);
  assert.equal(daKhoi.consecutiveFailures, 0);
  assert.equal(daKhoi.warrantsIncident, false);

  // ───────── 3.5 Mô-đun đi theo NGUỒN, và nguồn lạ rơi về INTEGRATIONS ─────────
  assert.equal(syncIncidentModule("PANCAKE"), "ORDERS");
  assert.equal(syncIncidentModule("VIETTELPOST"), "SHIPMENTS");
  assert.equal(syncIncidentModule("FACEBOOK"), "ADS");
  assert.equal(syncIncidentModule("GITHUB"), "TECH");
  assert.equal(syncIncidentModule("NGUON_LA"), "INTEGRATIONS", "job đồng bộ hỏng là chuyện của kết nối dữ liệu cho tới khi có người chứng minh ngược lại");

  /*
    ───────── 3.6 TIÊU ĐỀ LÀ KHOÁ CHỐNG TRÙNG — GHIM NGUYÊN CHUỖI ─────────
    Không có cột khoá riêng (thêm cột là một migration, mà nhiều phiên đang cùng sinh migration —
    AGENTS.md mục 9). Nên tiêu đề giữ vai trò đó, và đổi công thức tiêu đề = MỞ LẠI một sự cố cho
    mọi job đang hỏng. Dòng dưới biến việc đổi nó thành một hành động có chủ ý với một bài kiểm đỏ.
  */
  assert.equal(syncIncidentTitle("FACEBOOK", "facebook-ads"), "Job đồng bộ hỏng liên tiếp: facebook-ads (FACEBOOK)");
  assert.equal(SYNC_INCIDENT_RULE.severity, "SEV2", "máy đo được job có chạy không, KHÔNG đo được hậu quả kinh doanh — nên nó không tự xếp thang");

  console.log("✓ Luật mở sự cố: 1 lượt hỏng không đủ, RUNNING không tính, PARTIAL cắt chuỗi, tiêu đề là khoá");
}

export async function testSyncIncidentWatch() {
  const db = await getDb();
  const job = "prj-job-hong";
  const source = "PANCAKE";
  const title = syncIncidentTitle(source, job);
  const t = (phut: number) => new Date(Date.now() - phut * 60_000);

  await db.delete(schema.techIncidents).where(eq(schema.techIncidents.title, title));
  await db.delete(schema.syncRuns).where(eq(schema.syncRuns.job, job));

  // ───────── 4.1 Dưới ngưỡng: KHÔNG mở sự cố ─────────
  await db.insert(schema.syncRuns).values([
    { source, job, status: "FAILED", startedAt: t(10), error: "connect ECONNREFUSED", finishedAt: t(10) },
    { source, job, status: "FAILED", startedAt: t(70), error: "connect ECONNREFUSED", finishedAt: t(70) },
  ]);
  const duoiNguong = await watchSyncFailures({ lookbackHours: 24 });
  assert.ok(!duoiNguong.details.some((d) => d.job === job), "hai lượt hỏng chưa đủ ngưỡng ba — chưa được mở sự cố");
  assert.equal((await db.query.techIncidents.findMany({ where: eq(schema.techIncidents.title, title) })).length, 0);

  // ───────── 4.2 Đủ ngưỡng: mở ĐÚNG MỘT sự cố, mốc phát hiện là lượt hỏng ĐẦU chuỗi ─────────
  await db.insert(schema.syncRuns).values({ source, job, status: "FAILED", startedAt: t(130), error: "connect ECONNREFUSED", finishedAt: t(130) });
  const duNguong = await watchSyncFailures({ lookbackHours: 24 });
  const dong = duNguong.details.find((d) => d.job === job);
  assert.ok(dong?.opened, "ba lượt hỏng liên tiếp phải mở một sự cố");
  assert.equal(dong?.consecutiveFailures, 3);

  const sc = await db.query.techIncidents.findMany({ where: eq(schema.techIncidents.title, title) });
  assert.equal(sc.length, 1);
  assert.equal(sc[0].severity, "SEV2");
  assert.equal(sc[0].module, "ORDERS", "nguồn PANCAKE ⇒ mô-đun Đơn hàng");
  assert.equal(sc[0].openedByKind, "SYSTEM");
  assert.equal(sc[0].status, "OPEN");
  assert.ok(sc[0].evidence.includes("ECONNREFUSED"), "bằng chứng phải mang câu lỗi thật");
  assert.ok(sc[0].evidence.includes("select status"), "bằng chứng phải kèm câu tra lại được — một sự cố không tra lại được là một dòng chữ");
  assert.equal(
    Math.round(Math.abs(sc[0].detectedAt.getTime() - t(130).getTime()) / 60_000),
    0,
    "mốc PHÁT HIỆN phải là lúc chuỗi hỏng BẮT ĐẦU, không phải lúc bộ quét chạy — lấy now() là làm mọi phép đo 'bao lâu mới phát hiện' bằng 0",
  );

  // ───────── 4.3 Chạy lại KHÔNG nhân đôi ─────────
  const lai = await watchSyncFailures({ lookbackHours: 24 });
  assert.ok(lai.details.find((d) => d.job === job && !d.opened), "đã có sự cố chưa đóng ⇒ không mở thêm");
  assert.equal((await db.query.techIncidents.findMany({ where: eq(schema.techIncidents.title, title) })).length, 1);

  /*
    ───────── 4.4 SỰ CỐ ĐÃ ĐÓNG KHÔNG CHẶN SỰ CỐ MỚI ─────────
    Khoá chống trùng chỉ tính sự cố CHƯA ĐÓNG. Nếu nó tính cả sự cố đã đóng thì job hỏng lại lần
    thứ hai sẽ im lặng mãi mãi — và một hệ thống cảnh báo chỉ báo đúng một lần trong đời là một hệ
    thống không có cảnh báo.
  */
  await db
    .update(schema.techIncidents)
    .set({ status: "RESOLVED", resolvedAt: new Date(), resolution: "Đã khôi phục kết nối Pancake trong bài kiểm thử." })
    .where(eq(schema.techIncidents.title, title));
  const langThu2 = await watchSyncFailures({ lookbackHours: 24 });
  assert.ok(langThu2.details.find((d) => d.job === job && d.opened), "job hỏng lại sau khi sự cố cũ ĐÃ ĐÓNG thì phải mở sự cố mới");
  assert.equal((await db.query.techIncidents.findMany({ where: eq(schema.techIncidents.title, title) })).length, 2);

  // ───────── 4.5 Cửa sổ: chuỗi hỏng đã cũ KHÔNG mở sự cố hôm nay ─────────
  await db.delete(schema.techIncidents).where(eq(schema.techIncidents.title, title));
  const hepLai = await watchSyncFailures({ lookbackHours: 1 });
  assert.ok(
    !hepLai.details.find((d) => d.job === job && d.opened),
    "trong cửa sổ 1 giờ chỉ còn 1 lượt hỏng — chuỗi cũ nằm ngoài cửa sổ thì không được mở sự cố cho một chuyện đã qua",
  );

  await db.delete(schema.techIncidents).where(eq(schema.techIncidents.title, title));
  await db.delete(schema.syncRuns).where(eq(schema.syncRuns.job, job));
  console.log("✓ Sự cố tự mở: đủ ngưỡng mới mở, chạy lại không nhân đôi, sự cố đã đóng không bịt miệng lần sau");
}

/** Dọn dữ liệu kiểm thử — tiền tố `prj-` nhận ra được, và không đụng dữ liệu thật. */
export async function cleanupPrProjectionFixtures() {
  const db = await getDb();
  const viec = await db.query.techTasks.findMany({ where: like(schema.techTasks.title, "prj-%"), columns: { id: true } });
  if (viec.length) {
    await db.delete(schema.techTaskEvents).where(inArray(schema.techTaskEvents.taskId, viec.map((v) => v.id)));
    await db.delete(schema.techTasks).where(inArray(schema.techTasks.id, viec.map((v) => v.id)));
  }
}
