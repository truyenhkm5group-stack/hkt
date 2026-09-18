import { and, desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { techDeployStatusFromGithub, verifyDeployment, type TechDeployStatus, type TechVerification } from "@/lib/constants/tech";
import { runSyncJob, type SyncTrigger } from "@/lib/sync/runner";
import { runningVersion } from "@/lib/version";
import { GithubError, deployWorkflowFile, githubConfig, listRecentDeployRuns, type GithubErrorKind, type GithubRun } from "@/lib/integrations/github/client";

/**
 * ═══════════ ĐỌC LƯỢT DEPLOY TỪ GITHUB VÀO SỔ QUAN SÁT ═══════════
 *
 * ERP KHÔNG deploy. Hàm này chỉ chép lại thứ đã xảy ra để `/tech` trả lời được "lần deploy gần
 * nhất là commit nào, do ai, kết quả ra sao" mà không phải mở GitHub — và để thẻ "Deploy hôm nay"
 * đứng trên dữ liệu ĐO ĐƯỢC thay vì dữ liệu ĐƯỢC KHAI.
 *
 * ─── IDEMPOTENT THEO KHOÁ TỰ NHIÊN ───
 *
 * Khoá là `(provider, external_run_id, external_run_attempt)`. Chạy job mười lần vẫn đúng một dòng
 * cho một lượt chạy. `run_attempt` nằm TRONG khoá vì chạy lại một workflow là một sự việc mới đáng
 * xem — gộp hai lượt chạy lại thành một dòng là giấu mất đúng cái lần người ta quan tâm.
 *
 * ─── CHỈ CẬP NHẬT PHẦN GITHUB SỞ HỮU ───
 *
 * Lượt đồng bộ KHÔNG đụng `task_id`, `notes`, `rollback_of_id`, `health_result`, `smoke_result`,
 * `observation_result` — đó là những ô NGƯỜI điền. Một job chạy 10 phút một lần mà xoá ghi chú của
 * người là cách chắc chắn nhất để không ai ghi chú nữa.
 */

export type GithubDeploySyncResult = {
  scanned: number;
  inserted: number;
  updated: number;
  unchanged: number;
  errors: number;
  /** Đối chiếu với bản đang chạy sau khi đã nạp. */
  verified: number;
  mismatched: number;
  /** `null` = production chưa khai commit (chạy dev, hoặc `.env` thiếu `ERP_COMMIT`). */
  productionCommit: string | null;
  /** Vì sao lượt chạy không quét được gì. `null` = có quét thật. */
  skippedReason: string | null;
  /**
   * PHÂN LOẠI của `skippedReason`, vì ba lý do dưới đây sửa ở ba nơi khác hẳn:
   *
   * · `NOT_CONFIGURED` — thiếu tên kho, sửa ở `.env` / chạy một lượt deploy.
   * · `RATE_LIMITED`   — KHÔNG phải lỗi cấu hình, chỉ cần CHỜ (hoặc thêm token cho hạn mức cao hơn).
   * · `AUTH_FAILED`    — có token nhưng token sai; với kho public thì XOÁ token cũng xong.
   *
   * Gộp cả ba thành một dòng "chưa đồng bộ được" là đẩy người vận hành đi sửa nhầm chỗ — và với
   * `RATE_LIMITED` thì "sửa" đúng nghĩa là không làm gì cả.
   */
  skippedKind: GithubErrorKind | null;
};

function rowFromRun(run: GithubRun): {
  commitSha: string;
  branch: string;
  provider: "GITHUB_ACTIONS";
  workflow: string;
  externalRunId: string;
  externalRunAttempt: number;
  externalConclusion: string;
  status: TechDeployStatus;
  startedAt: Date;
  finishedAt: Date | null;
  actorKind: "SYSTEM";
  actorName: string;
  externalRef: string;
} {
  const status = techDeployStatusFromGithub(run.status, run.conclusion);
  return {
    commitSha: run.headSha,
    branch: run.headBranch || "main",
    provider: "GITHUB_ACTIONS",
    workflow: deployWorkflowFile(),
    externalRunId: String(run.id),
    externalRunAttempt: run.runAttempt,
    externalConclusion: run.conclusion ?? "",
    status,
    startedAt: run.runStartedAt ?? run.createdAt,
    // Lượt chưa xong KHÔNG có mốc kết thúc. `updated_at` của GitHub đổi cả khi lượt còn chạy, nên
    // dùng nó làm mốc kết thúc là bịa ra một thời điểm chưa tới.
    finishedAt: status === "PENDING" || status === "RUNNING" ? null : (run.updatedAt ?? null),
    /*
      NGƯỜI BẤM WORKFLOW KHÔNG PHẢI MỘT TÀI KHOẢN ERP. Tài khoản GitHub và `users.id` là hai không
      gian danh tính khác nhau; nối bừa chúng là quy kết sai (AGENTS.md mục 34). Nên dòng này mang
      `actor_kind = 'SYSTEM'` (máy đọc về) và giữ tên GitHub như một ẢNH CHỤP để người đọc.
    */
    actorKind: "SYSTEM",
    actorName: run.actor ? `github:${run.actor}` : "github",
    externalRef: run.htmlUrl,
  };
}

/**
 * Nạp N lượt chạy gần nhất. Trả về số liệu ĐẾM ĐƯỢC, không trả về "thành công".
 *
 * Chưa cấu hình GitHub ⇒ `skippedReason` có chữ và mọi con số bằng 0. Đó KHÔNG phải lỗi — nó là
 * "chưa bật", và job phải phân biệt được hai thứ đó.
 */
export async function syncGithubDeployments(opts: { limit?: number } = {}): Promise<GithubDeploySyncResult> {
  const base: GithubDeploySyncResult = { scanned: 0, inserted: 0, updated: 0, unchanged: 0, errors: 0, verified: 0, mismatched: 0, productionCommit: null, skippedReason: null, skippedKind: null };
  const cfg = githubConfig();
  if (!cfg.configured) return { ...base, skippedReason: cfg.reason, skippedKind: "NOT_CONFIGURED" };

  const db = await getDb();
  /*
    LỖI ĐỌC KHÔNG ĐƯỢC NÉM RA NGOÀI THÀNH MỘT DÒNG "JOB HỎNG" KHÔNG TÊN.

    Hết hạn mức là tình huống BÌNH THƯỜNG của đường gọi ẩn danh (60 request/giờ theo IP) và cách
    xử lý của nó là CHỜ — khác hẳn token sai hay sai tên kho. Nên bắt ở đây, phân loại, rồi trả về
    số liệu bằng 0 KÈM LÝ DO, thay vì để nguyên một ngoại lệ mà người đọc phải tự đoán.
  */
  let runs: Awaited<ReturnType<typeof listRecentDeployRuns>>;
  try {
    runs = await listRecentDeployRuns(opts.limit ?? 20);
  } catch (e) {
    if (e instanceof GithubError) return { ...base, skippedReason: e.message, skippedKind: e.kind };
    throw e;
  }
  const out: GithubDeploySyncResult = { ...base, scanned: runs.length };

  for (const run of runs) {
    try {
      const v = rowFromRun(run);
      const existing = await db.query.techDeployments.findFirst({
        where: and(
          eq(schema.techDeployments.provider, "GITHUB_ACTIONS"),
          eq(schema.techDeployments.externalRunId, v.externalRunId),
          eq(schema.techDeployments.externalRunAttempt, v.externalRunAttempt),
        ),
      });
      if (!existing) {
        await db.insert(schema.techDeployments).values(v);
        out.inserted += 1;
        continue;
      }
      // Chỉ ghi khi CÓ GÌ ĐỔI: một lượt đã kết thúc thì không bao giờ đổi nữa, và ghi đè vô ích làm
      // `updated_at` nhảy mỗi lần job chạy, khiến "vừa cập nhật" mất hết ý nghĩa.
      const doi =
        existing.status !== v.status ||
        existing.externalConclusion !== v.externalConclusion ||
        existing.commitSha !== v.commitSha ||
        existing.branch !== v.branch ||
        (existing.finishedAt?.getTime() ?? null) !== (v.finishedAt?.getTime() ?? null);
      if (!doi) {
        out.unchanged += 1;
        continue;
      }
      await db
        .update(schema.techDeployments)
        .set({
          status: v.status,
          externalConclusion: v.externalConclusion,
          commitSha: v.commitSha,
          branch: v.branch,
          finishedAt: v.finishedAt,
          externalRef: v.externalRef,
          actorName: v.actorName,
        })
        .where(eq(schema.techDeployments.id, existing.id));
      out.updated += 1;
    } catch {
      // Một lượt chạy hỏng KHÔNG được làm sập cả lượt đồng bộ — đếm lại và đi tiếp.
      out.errors += 1;
    }
  }

  const doiChieu = await verifyDeployments();
  return { ...out, verified: doiChieu.verified, mismatched: doiChieu.mismatched, productionCommit: doiChieu.productionCommit };
}

/**
 * ĐỐI CHIẾU SỔ VỚI BẢN ĐANG CHẠY.
 *
 * Nguồn của "production đang chạy commit nào" là `lib/version.ts` — lời khai của CHÍNH tiến trình
 * đang dựng trang này, cùng chỗ `/api/health` đọc. Không gọi mạng: ERP tự hỏi mình.
 *
 * Chưa biết commit đang chạy ⇒ KHÔNG đổi gì và trả `productionCommit: null`. Ghi `MISMATCH` khi
 * chưa biết mình đang chạy gì là biến CHƯA BIẾT thành một lời buộc tội.
 */
export async function verifyDeployments(): Promise<{ verified: number; mismatched: number; superseded: number; productionCommit: string | null }> {
  const db = await getDb();
  const running = runningVersion().commit;
  if (!running) return { verified: 0, mismatched: 0, superseded: 0, productionCommit: null };

  // Chỉ xét lượt THÀNH CÔNG: lượt hỏng không bao giờ lên máy chủ, nên nó không có gì để đối chiếu.
  const rows = await db.query.techDeployments.findMany({
    where: eq(schema.techDeployments.status, "SUCCEEDED"),
    orderBy: [desc(schema.techDeployments.startedAt)],
    limit: 100,
  });
  const latestId = rows[0]?.id ?? null;

  let verified = 0;
  let mismatched = 0;
  let superseded = 0;
  const now = new Date();
  for (const r of rows) {
    const verification: TechVerification = verifyDeployment({
      status: "SUCCEEDED",
      commitSha: r.commitSha,
      productionCommit: running,
      isLatestSuccess: r.id === latestId,
    });
    if (verification === "VERIFIED") verified += 1;
    else if (verification === "MISMATCH") mismatched += 1;
    else if (verification === "SUPERSEDED") superseded += 1;
    if (r.verification === verification && r.productionCommit === running) continue;
    await db
      .update(schema.techDeployments)
      .set({ verification, productionCommit: running, verifiedAt: now })
      .where(eq(schema.techDeployments.id, r.id));
  }
  return { verified, mismatched, superseded, productionCommit: running };
}

/**
 * Job `github-deployments`. CHỈ ĐỌC từ GitHub, chỉ ghi vào sổ quan sát của chính ERP.
 *
 * Ghi `sync_runs` theo đúng convention: `imported` = dòng mới, `updated` = dòng đổi, `skipped` =
 * dòng không đổi, `failed` = lượt chạy đọc hỏng. Lỗi GitHub làm job này PARTIAL/FAILED chứ không
 * ném ra ngoài — nó không được làm sập job nào khác.
 */
export async function runGithubDeploymentSync(options: { trigger?: SyncTrigger; actor?: string; limit?: number } = {}) {
  return runSyncJob({ source: "GITHUB", job: "deploy_runs", trigger: options.trigger, actor: options.actor }, async (ctx) => {
    const res = await syncGithubDeployments({ limit: options.limit });
    ctx.summary.imported = res.inserted;
    ctx.summary.updated = res.updated;
    ctx.summary.skipped = res.unchanged;
    ctx.summary.failed = res.errors;
    if (res.skippedReason) {
      /*
        BA CÂU TRẢ LỜI KHÁC NHAU, KHÔNG PHẢI MỘT.

        `CHƯA BẬT` và `HỎNG` đã là hai thứ; `TẠM HẾT HẠN MỨC` là thứ thứ ba và nó KHÔNG phải lỗi
        của ai — lượt sau tự chạy được. Chỉ nhánh cuối mới đếm là `failed`, vì chỉ nó cần người
        đi sửa một cái gì đó.
      */
      ctx.summary.warning = `Chưa đồng bộ được: ${res.skippedReason}`;
      if (res.skippedKind === "NOT_CONFIGURED") {
        ctx.summary.detail = "Bỏ qua — chưa biết đang đọc kho nào.";
      } else if (res.skippedKind === "RATE_LIMITED") {
        ctx.summary.detail = "Bỏ qua — GitHub tạm khoá vì hạn mức. Lượt sau tự chạy lại được, không phải sửa gì.";
      } else {
        ctx.summary.detail = `Đọc GitHub hỏng (${res.skippedKind ?? "HTTP"}).`;
        ctx.summary.failed = 1;
      }
      return res;
    }
    const doiChieu =
      res.productionCommit === null
        ? "chưa đối chiếu được (production chưa khai commit đang chạy)"
        : `${res.verified} khớp · ${res.mismatched} LỆCH`;
    ctx.summary.detail = `Quét ${res.scanned} lượt chạy · thêm ${res.inserted} · cập nhật ${res.updated} · không đổi ${res.unchanged} · ${doiChieu}`;
    if (res.mismatched > 0) {
      ctx.summary.warning = `${res.mismatched} lượt deploy thành công nhưng production đang chạy commit khác — xem /tech/deployments.`;
    }
    return res;
  });
}
