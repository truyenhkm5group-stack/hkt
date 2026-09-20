import { and, eq, isNotNull, ne, notInArray, or } from "drizzle-orm";
import { getDb, schema } from "@/db";
import {
  techCiStateFromChecks,
  techMergeStateFromGithub,
  techPrStateFromGithub,
  techReviewStateFromReviews,
  type TechCiState,
  type TechMergeState,
  type TechPrState,
  type TechReviewState,
} from "@/lib/constants/tech";
import {
  GithubError,
  getPull,
  githubConfig,
  listCheckRuns,
  listPullReviews,
  listRecentPulls,
  type GithubAuthMode,
  type GithubErrorKind,
  type GithubPull,
} from "@/lib/integrations/github/client";
import { markGithubRead } from "@/lib/integrations/github/read-marker";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { recordTechTaskEvent } from "@/lib/tech/service";

/**
 * ═══════════ CHÉP TRẠNG THÁI PR VỀ `tech_tasks` — GITHUB LÀ BÊN CÓ THẨM QUYỀN ═══════════
 *
 * Chín ô `pr_*` / `ci_state` / `review_state` / `merge_state` / `head_sha` / `base_sha` có từ
 * migration `0104`. Tới 20/09/2026 **không một dòng mã nào ghi hay đọc chúng** — nên một việc
 * Tech đang nằm ở đâu chỉ trả lời được bằng cách mở GitHub. Tệp này là sợi dây còn thiếu.
 *
 * ─── NỐI VIỆC VỚI PR BẰNG KHOÁ, KHÔNG BẰNG PHỎNG ĐOÁN ───
 *
 * Hai khoá, theo đúng thứ tự:
 *
 *  1. `tech_tasks.pr_number` — đã biết thì không đoán lại.
 *  2. `tech_tasks.branch` **bằng đúng** `head.ref` của PR. Runner đặt nhánh theo mã việc
 *     (`ai/<vai>/<TECH-n>-<hậu tố>`), nên nhánh LÀ khoá tự nhiên.
 *
 * KHÔNG có đường thứ ba. Dò mã việc trong tiêu đề hay mô tả PR là phép đoán: một PR nhắc "nối tiếp
 * TECH-7" sẽ bị nhận là PR của TECH-7, và việc ấy hiện trạng thái của một nhánh không phải của nó.
 * Sai ở đây không dừng ở một dòng hiển thị — cổng deploy tương lai đọc chính bốn cột này.
 *
 * PR không gắn được việc nào KHÔNG bị bỏ đi trong im lặng: `unmatchedPulls` đếm chúng, để màn
 * hình nói được "GitHub có N PR mở mà hàng đợi Tech không biết" thay vì hiện một hàng đợi sạch.
 *
 * ─── CHỈ CHÉP PHẦN GITHUB SỞ HỮU ───
 *
 * Lượt đồng bộ KHÔNG đụng `status`, `risk`, `approval_*`, `agent_id`, `description` — đó là miền
 * của ERP và của người. Nó cũng KHÔNG tự chuyển trạng thái việc: "PR đã gộp" không phải "việc đã
 * xong" (một việc còn phải lên production và được xác minh), và một job suy ra điều đó là job tự
 * đóng việc của người khác.
 *
 * ─── KHÔNG LÀM `updated_at` NHẢY ───
 *
 * `updated_at` của việc là mốc VIỆC có chuyện xảy ra, và `/tech/tasks` sắp theo nó. Một job chạy
 * 10 phút một lần mà chạm vào nó sẽ đẩy mọi việc có nhánh lên đầu danh sách mãi mãi, và thứ tự ấy
 * mất hết nghĩa. Nên lượt ghi giữ NGUYÊN `updated_at` cũ; mốc của phép chiếu nằm ở `pr_synced_at`.
 */

export type GithubPrSyncResult = {
  /** Việc CÓ khoá để nối (đã có số PR, hoặc đã có nhánh). Việc chưa có nhánh không nằm trong mẫu số. */
  tasksConsidered: number;
  pullsScanned: number;
  matched: number;
  updated: number;
  unchanged: number;
  /**
   * Việc có khoá nối nhưng KHÔNG thấy PR nào mang khoá đó **trong cửa sổ N PR cập nhật gần nhất**.
   *
   * Đây KHÔNG phải "chưa mở PR" — một PR đã gộp từ lâu cũng rơi ra khỏi cửa sổ. Gọi nó là "chưa
   * mở PR" là nói ngược sự thật với đúng những việc đã xong. Tên và câu chữ phải nói đúng chừng
   * đó: *không thấy trong cửa sổ*.
   */
  unmatchedTasks: number;
  /** Việc bị hoãn đọc sang lượt sau vì đã chạm trần lượt gọi. KHÔNG phải lỗi — xem `prDetailBudget`. */
  deferred: number;
  /** Trần ĐÃ DÙNG cho lượt này. In con số này ra, không in hằng số: hai thứ lệch nhau khi gọi ẩn danh. */
  budget: number;
  /** PR đang MỞ mà không việc Tech nào nhận. Con số này phải được in ra, không được nuốt. */
  unmatchedOpenPulls: number;
  errors: number;
  skippedReason: string | null;
  skippedKind: GithubErrorKind | null;
};

/** Ảnh chụp bốn chiều + hai SHA của một PR, sau khi đã đọc đủ ba nguồn. */
type PrProjection = {
  prNumber: number;
  prUrl: string;
  prState: TechPrState;
  headSha: string;
  baseSha: string;
  ciState: TechCiState;
  reviewState: TechReviewState;
  mergeState: TechMergeState;
};

/**
 * Đọc đủ ba nguồn cho MỘT PR rồi quy về bốn chiều.
 *
 * Lượt đọc danh sách không có `mergeable` (GitHub chỉ tính khi đọc từng PR), nên phải đọc lại PR.
 * Ba lượt gọi cho mỗi PR là giá phải trả để bốn cột nói đúng — và chỉ những PR ĐÃ GẮN ĐƯỢC VIỆC
 * mới phải trả giá đó, nên số lượt gọi đi theo số việc đang chạy, không theo số PR của cả kho.
 *
 * Nguồn nào đọc hỏng thì chiều ĐÓ để trống (CHƯA BIẾT) và các chiều khác vẫn được ghi — mất cả
 * lượt đồng bộ vì một endpoint lỗi là biến một thông tin thiếu thành bốn thông tin thiếu.
 */
async function projectPull(base: GithubPull): Promise<PrProjection> {
  let chiTiet = base;
  try {
    chiTiet = await getPull(base.number);
  } catch {
    // Giữ bản từ danh sách: nó đủ cho `prState`, `headSha`, `baseSha`. Chỉ `mergeable` là mất.
  }

  let ciState: TechCiState = "";
  if (chiTiet.headSha) {
    try {
      ciState = techCiStateFromChecks(await listCheckRuns(chiTiet.headSha));
    } catch {
      ciState = "";
    }
  }

  let reviewState: TechReviewState = "";
  try {
    reviewState = techReviewStateFromReviews(await listPullReviews(base.number));
  } catch {
    reviewState = "";
  }

  return {
    prNumber: chiTiet.number,
    prUrl: chiTiet.htmlUrl,
    prState: techPrStateFromGithub(chiTiet.state, chiTiet.merged),
    headSha: chiTiet.headSha,
    baseSha: chiTiet.baseSha,
    ciState,
    reviewState,
    mergeState: techMergeStateFromGithub(chiTiet.merged, chiTiet.mergeable),
  };
}

/** Câu một dòng cho nhật ký việc — bốn chiều đứng cạnh nhau, không gộp. */
function motDong(p: { prState: string; ciState: string; reviewState: string; mergeState: string }) {
  const o = (v: string) => v || "—";
  return `PR ${o(p.prState)} · CI ${o(p.ciState)} · duyệt ${o(p.reviewState)} · gộp ${o(p.mergeState)}`;
}

/**
 * ═══════════ TRẦN LƯỢT GỌI — VÀ NÓ PHẢI TÍNH THEO GIỜ, KHÔNG THEO LƯỢT ═══════════
 *
 * Mỗi PR gắn được việc tốn BA lượt gọi (chi tiết · check run · review), cộng 1 cho danh sách.
 *
 * Bản đầu đặt trần 12 PR/lượt rồi kết luận là "an toàn" — sai, vì nó tính theo LƯỢT trong khi
 * hạn mức của GitHub tính theo GIỜ: 1 + 3×12 = 37 request/lượt × 4 lượt/giờ = **148/giờ**, gấp
 * hơn hai lần hạn mức 60/giờ của đường gọi ẩn danh mà chính đoạn chú thích ấy trích dẫn. Hết hạn
 * mức thì `github-deployments` chết theo, tức sổ deploy lại đứng im: đúng cái cả lượt này đi sửa.
 *
 * Nên trần đi theo CHẾ ĐỘ GỌI, vì hai chế độ khác nhau hơn hai bậc độ lớn:
 *
 *  · **Có token** — 5.000 request/giờ. 12 PR/lượt ⇒ 148/giờ, chiếm 3%. Thoải mái.
 *  · **Ẩn danh** — 60 request/giờ TÍNH THEO IP MÁY CHỦ, và `github-deployments` đã ăn 4/giờ.
 *    3 PR/lượt ⇒ 10 request/lượt × 4 = 40/giờ; cộng 4 của sổ deploy là 44, còn chừa chỗ cho
 *    người bấm tay. Chậm, nhưng phép xoay vòng bên dưới bảo đảm mọi việc đều tới lượt.
 *
 * Việc quá trần KHÔNG bị bỏ — nó được đọc ở lượt sau, vì thứ tự ưu tiên là **việc lâu chưa đọc
 * nhất trước** (`pr_synced_at` rỗng đứng đầu). Xoay vòng như vậy thì không việc nào bị bỏ đói.
 */
export const PR_DETAIL_BUDGET = 12;
export const PR_DETAIL_BUDGET_ANONYMOUS = 3;

/** Trần thực tế của lượt chạy này. Tách ra để bài kiểm gọi được, và để màn hình in đúng con số. */
export function prDetailBudget(auth: GithubAuthMode): number {
  return auth === "TOKEN" ? PR_DETAIL_BUDGET : PR_DETAIL_BUDGET_ANONYMOUS;
}

export async function syncGithubPullRequests(opts: { limit?: number; budget?: number } = {}): Promise<GithubPrSyncResult> {
  const base: GithubPrSyncResult = {
    tasksConsidered: 0,
    pullsScanned: 0,
    matched: 0,
    updated: 0,
    unchanged: 0,
    unmatchedTasks: 0,
    deferred: 0,
    budget: 0,
    unmatchedOpenPulls: 0,
    errors: 0,
    skippedReason: null,
    skippedKind: null,
  };
  const cfg = githubConfig();
  if (!cfg.configured) return { ...base, skippedReason: cfg.reason, skippedKind: "NOT_CONFIGURED" };

  let pulls: GithubPull[];
  try {
    pulls = await listRecentPulls(opts.limit ?? 50);
  } catch (e) {
    // Hết hạn mức là tình huống BÌNH THƯỜNG của đường gọi ẩn danh và cách xử lý của nó là CHỜ.
    if (e instanceof GithubError) return { ...base, skippedReason: e.message, skippedKind: e.kind };
    throw e;
  }

  // Tới đây GitHub đã trả về danh sách; mọi nhánh bỏ qua đã `return` phía trên. Xem `read-marker.ts`.
  await markGithubRead("pulls");

  const db = await getDb();
  /*
    KHÔNG ĐỌC LẠI THỨ ĐÃ KẾT THÚC.

    Một việc `DONE` mà PR của nó đã `MERGED`/`CLOSED` thì không còn gì để học: GitHub không đổi
    trạng thái của một PR đã gộp nữa. Đọc lại chúng mỗi 15 phút là tiêu hạn mức vào quá khứ, và
    chính chúng là nhóm phình to nhất theo thời gian.

    Việc `DONE` mà PR CHƯA kết thúc thì VẪN đọc — hai thứ đó lệch nhau là một dấu hiệu thật
    (đánh dấu xong trong khi PR còn mở), và giấu nó đi là giấu đúng cái đáng nhìn.
  */
  const tasks = await db.query.techTasks.findMany({
    where: and(
      or(isNotNull(schema.techTasks.prNumber), ne(schema.techTasks.branch, "")),
      or(ne(schema.techTasks.status, "DONE"), notInArray(schema.techTasks.prState, ["MERGED", "CLOSED"])),
    ),
    // Lâu chưa đọc nhất đi trước; chưa đọc lần nào (`NULL`) đứng đầu. Đây là thứ làm cái trần ở
    // trên thành một phép XOAY VÒNG thay vì một phép cắt bỏ.
    orderBy: (t, { asc, sql: raw }) => [raw`${t.prSyncedAt} asc nulls first`, asc(t.createdAt)],
    columns: {
      id: true,
      code: true,
      branch: true,
      prNumber: true,
      prUrl: true,
      prState: true,
      headSha: true,
      baseSha: true,
      ciState: true,
      reviewState: true,
      mergeState: true,
      updatedAt: true,
      status: true,
    },
  });

  const theoSo = new Map<number, GithubPull>();
  const theoNhanh = new Map<string, GithubPull>();
  for (const p of pulls) {
    theoSo.set(p.number, p);
    // PR mới hơn thắng: danh sách đã sắp theo `updated` giảm dần, nên chỉ ghi lần ĐẦU gặp nhánh.
    if (p.headRef && !theoNhanh.has(p.headRef)) theoNhanh.set(p.headRef, p);
  }

  const out: GithubPrSyncResult = { ...base, pullsScanned: pulls.length, tasksConsidered: tasks.length };
  const tran = Math.max(1, opts.budget ?? prDetailBudget(cfg.auth));
  out.budget = tran;
  const daGan = new Set<number>();
  // Một PR có thể gắn hai việc (việc con dùng chung nhánh); đọc chi tiết đúng MỘT lần cho mỗi PR.
  const dem = new Map<number, PrProjection>();

  for (const t of tasks) {
    const pr = (t.prNumber !== null ? theoSo.get(t.prNumber) : undefined) ?? (t.branch ? theoNhanh.get(t.branch) : undefined);
    if (!pr) {
      out.unmatchedTasks += 1;
      continue;
    }
    out.matched += 1;
    daGan.add(pr.number);
    // Trần tính theo số PR PHẢI ĐỌC CHI TIẾT, không theo số việc: hai việc dùng chung một nhánh
    // chỉ tốn một lần đọc, và tính chúng thành hai là tự thắt hầu bao vì một phép đếm sai.
    if (!dem.has(pr.number) && dem.size >= tran) {
      out.deferred += 1;
      continue;
    }
    try {
      let chieu = dem.get(pr.number);
      if (!chieu) {
        chieu = await projectPull(pr);
        dem.set(pr.number, chieu);
      }
      const doi =
        t.prNumber !== chieu.prNumber ||
        t.prUrl !== chieu.prUrl ||
        t.prState !== chieu.prState ||
        t.headSha !== chieu.headSha ||
        t.baseSha !== chieu.baseSha ||
        t.ciState !== chieu.ciState ||
        t.reviewState !== chieu.reviewState ||
        t.mergeState !== chieu.mergeState;

      await db
        .update(schema.techTasks)
        .set({
          ...chieu,
          // `pr_synced_at` là mốc ĐỌC, không phải mốc đổi: ghi mỗi lượt đọc được, kể cả lượt không đổi gì.
          prSyncedAt: new Date(),
          // Giữ nguyên mốc của VIỆC. Xem phần đầu tệp: không có dòng này thì thứ tự "vừa cập nhật" chết.
          updatedAt: t.updatedAt,
        })
        .where(eq(schema.techTasks.id, t.id));

      if (!doi) {
        out.unchanged += 1;
        continue;
      }
      out.updated += 1;
      /*
        NHẬT KÝ CHỈ GHI KHI CÓ ĐỔI, và ghi cả bốn chiều trong MỘT dòng.

        Bốn dòng cho một lần đẩy nhánh sẽ chôn mất mọi dòng do người ghi — nhật ký việc là chỗ đọc
        lại "ai đã làm gì", không phải chỗ đổ số đo.
      */
      await recordTechTaskEvent(
        {
          taskId: t.id,
          kind: "PR",
          note: `#${chieu.prNumber} ${chieu.prUrl}`,
          previousValue: motDong(t),
          nextValue: motDong(chieu),
          payload: { source: "GITHUB", prNumber: chieu.prNumber, headSha: chieu.headSha },
        },
        // Lượt đọc là MÁY làm. `id: null` ở đây có nghĩa rõ ràng, khác hẳn "chưa biết ai" (AGENTS.md mục 34).
        { kind: "SYSTEM", name: "job:github-pr-sync" },
      );
    } catch {
      // Một việc hỏng KHÔNG được làm sập cả lượt đồng bộ.
      out.errors += 1;
    }
  }

  out.unmatchedOpenPulls = pulls.filter((p) => p.state === "open" && !p.merged && !daGan.has(p.number)).length;
  return out;
}

/** Job: chép trạng thái PR về việc Tech. CHỈ ĐỌC phía GitHub. */
export async function runGithubPrSync(opts: { trigger: SyncTrigger; actor: string; limit?: number; budget?: number }) {
  return runSyncJob({ source: "GITHUB", job: "github-pr-sync", trigger: opts.trigger, actor: opts.actor }, async (ctx) => {
    const r = await syncGithubPullRequests({ limit: opts.limit, budget: opts.budget });
    ctx.summary.updated = r.updated;
    ctx.summary.skipped = r.unchanged;
    ctx.summary.failed = r.errors;
    if (r.skippedReason) {
      ctx.summary.detail = r.skippedReason;
      /*
        HẾT HẠN MỨC KHÔNG PHẢI LỖI CẤU HÌNH, VÀ "CHƯA BẬT" KHÔNG PHẢI "HỎNG".

        Chỉ `AUTH_FAILED` và `NOT_FOUND` mới là thứ có người phải đi sửa; `NOT_CONFIGURED` là chưa
        bật, `RATE_LIMITED` và `NETWORK` chỉ cần chờ. Gắn cờ cảnh báo cho cả năm là dạy người đọc
        bỏ qua cờ cảnh báo.
      */
      if (r.skippedKind === "AUTH_FAILED" || r.skippedKind === "NOT_FOUND") ctx.summary.warning = r.skippedReason;
      return r;
    }
    /*
      CÂU NÀY ĐƯỢC IN THẲNG LÊN `/tech/tasks`, nên nó phải nói đúng chừng nó biết.

      `unmatchedTasks` KHÔNG phải "chưa mở PR": một PR đã gộp từ lâu cũng rơi khỏi cửa sổ N PR
      cập nhật gần nhất. Gọi nó là "chưa mở PR" là nói ngược sự thật với đúng những việc đã xong.
    */
    ctx.summary.detail =
      `Quét ${r.pullsScanned} PR gần nhất · ${r.tasksConsidered} việc có khoá nối: gắn ${r.matched}, cập nhật ${r.updated}, không đổi ${r.unchanged}. ` +
      `${r.unmatchedTasks} việc không thấy PR trong cửa sổ này · ${r.unmatchedOpenPulls} PR đang MỞ không gắn việc nào` +
      `${r.deferred ? ` · ${r.deferred} việc hoãn sang lượt sau (chạm trần ${r.budget} PR/lượt, ưu tiên việc lâu chưa đọc nhất)` : ""}.`;
    if (r.errors) ctx.summary.warning = `${r.errors} việc không chép được trạng thái PR.`;
    return r;
  });
}
