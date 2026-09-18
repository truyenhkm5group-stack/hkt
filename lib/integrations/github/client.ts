
/**
 * ═══════════ GITHUB — CHỈ ĐỌC, CHỈ MÁY CHỦ ═══════════
 *
 * ─── VÌ SAO KHÔNG DÙNG GÓI `server-only` ───
 *
 * Nó ném lỗi ngay khi mô-đun được nạp ngoài ngữ cảnh React Server Component — kể cả từ
 * `scripts/sync.ts` (CLI) và từ bộ kiểm thử, là hai nơi job đồng bộ THẬT SỰ chạy trong kho này.
 * Không tệp nào trong `lib/` dùng nó, và thêm vào đây sẽ làm job không chạy được bằng tay.
 *
 * Lá chắn thay thế đi theo đúng idiom của kho mã: một bài kiểm QUÉT MÃ NGUỒN
 * (`tests/tech-phase2a.test.ts`) chặn mọi tệp `"use client"` import tệp này — cùng cách
 * `tests/client-boundary-exports.test.ts` và `tests/use-server-exports.test.ts` đang làm.
 *
 * ─── BỐN LUẬT ───
 *
 * 1. **CHỈ ĐỌC.** Không hàm nào ở đây dùng `POST`/`PUT`/`PATCH`/`DELETE`. ERP không kích hoạt được
 *    một lượt deploy, không huỷ được, không đổi được. GitHub Actions là bên có thẩm quyền và bản
 *    này không tranh chỗ đó.
 * 2. **Token là TUỲ CHỌN, không phải điều kiện.** Kho này PUBLIC, và GitHub cho đọc workflow +
 *    lượt chạy của kho public mà không cần xác thực. Bắt chủ shop tạo một PAT chỉ để đọc thứ ai
 *    cũng đọc được là dựng một hàng rào không bảo vệ gì — và tệ hơn, nó làm "chưa cấu hình" và
 *    "không có lượt deploy nào" trông giống hệt nhau trên màn hình. Có token thì gửi kèm (hạn mức
 *    5.000 request/giờ thay vì 60, và đọc được cả kho private); không có thì gọi ẩn danh. Khi có,
 *    token chỉ sống ở biến môi trường máy chủ: không lưu CSDL, không vào prompt, không xuống trình
 *    duyệt, không vào nhật ký.
 * 3. **Không log token.** `maskToken()` là thứ duy nhất được in ra, và nó chỉ đủ để trả lời "có
 *    đúng token mình nghĩ không", không đủ để dùng lại.
 * 4. **Lỗi GitHub không được làm sập việc khác.** Mọi hàm ném lỗi có câu chữ đọc được; job gọi
 *    chúng bắt lại và ghi vào `sync_runs`.
 */

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;

/**
 * CHỈ DÙNG CHO KIỂM THỬ: tiêm `fetch` giả.
 *
 * Cùng idiom với `lib/ai/providers/openai.ts`. Lý do cần nó: phần dễ sai của tích hợp này không
 * phải lượt gọi mạng mà là phép ÁNH XẠ (`success`/`failure`/`cancelled`/`timed_out`/chưa xong →
 * trạng thái ERP) và tính IDEMPOTENT. Cả hai kiểm được trọn vẹn mà không cần token, không cần
 * mạng, và không phụ thuộc hôm nay GitHub có lượt chạy nào.
 */
export function __setGithubFetchForTests(f: FetchLike | null) {
  fetchImpl = f;
}

/** Token đọc. Ưu tiên khoá riêng của ERP để tách khỏi token của CI. */
function token(): string | null {
  const t = (process.env.ERP_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "").trim();
  return t || null;
}

/** `owner/repo`. Mặc định đọc từ biến môi trường; không gõ cứng tên kho vào mã. */
function repo(): string | null {
  const r = (process.env.ERP_GITHUB_REPO || process.env.GITHUB_REPOSITORY || "").trim();
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null;
}

/** Tệp workflow deploy. Đổi được bằng biến môi trường, mặc định đúng tệp kho mã đang dùng. */
export function deployWorkflowFile(): string {
  return (process.env.ERP_GITHUB_DEPLOY_WORKFLOW || "deploy-vps.yml").trim();
}

/**
 * Che token để in ra được mà không dùng lại được — cùng tinh thần `maskKey()` ở trang Kết nối dữ
 * liệu. Token ngắn bất thường thì che HẾT: một token 8 ký tự mà hiện 4 đầu 4 cuối là hiện cả token.
 */
export function maskToken(t: string): string {
  if (!t) return "";
  if (t.length <= 12) return "••••••••";
  return `${t.slice(0, 4)}••••${t.slice(-4)}`;
}

/**
 * ═══════════ NĂM CÁCH HỎNG, NĂM CÁCH SỬA ═══════════
 *
 * Gộp tất cả thành "không kết nối được" là đẩy người đọc đi sửa nhầm chỗ. Mỗi loại dưới đây sửa ở
 * một nơi khác hẳn: `NOT_CONFIGURED` sửa ở `.env`, `AUTH_FAILED` sửa ở token, `RATE_LIMITED` chỉ
 * cần CHỜ (hoặc thêm token), `NOT_FOUND` sửa ở tên kho / tên tệp workflow, `NETWORK` không phải
 * lỗi của ai cả.
 */
export type GithubErrorKind = "NOT_CONFIGURED" | "AUTH_FAILED" | "RATE_LIMITED" | "NOT_FOUND" | "NETWORK" | "HTTP";

export class GithubError extends Error {
  readonly kind: GithubErrorKind;
  readonly status: number | null;
  /** Giây còn phải chờ, CHỈ khi `kind = "RATE_LIMITED"` và GitHub nói ra. `null` = không biết. */
  readonly retryAfterSec: number | null;
  constructor(kind: GithubErrorKind, message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = "GithubError";
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

/** `auth` nói ĐANG gọi kiểu nào — chứ không phải "nên" gọi kiểu nào. Màn hình in thẳng giá trị này. */
export type GithubAuthMode = "TOKEN" | "PUBLIC";

export type GithubConfigState = { configured: boolean; reason: string | null; repo: string | null; auth: GithubAuthMode; tokenMasked: string | null };

/**
 * Đã cấu hình chưa — và nếu chưa thì THIẾU ĐÚNG CÁI GÌ.
 *
 * Trả lời "chưa cấu hình" mà không nói thiếu gì là bắt người vận hành đi đoán. Cùng hình dạng với
 * `aiDisabledReason()`.
 */
export function githubConfig(): GithubConfigState {
  const t = token();
  const r = repo();
  /*
    CHỈ TÊN KHO LÀ BẮT BUỘC.

    Thiếu token KHÔNG phải "chưa cấu hình": với kho public, gọi ẩn danh đọc được đúng những thứ
    ERP cần. Trả `configured: false` ở đây là dán nhãn BLOCKED lên một đường đang chạy được, và
    trang Deploy sẽ nói "chưa cấu hình" mãi mãi trong khi nó chỉ cần bấm đọc.

    Tên kho thì máy không đoán được. Nó đến từ `deploy-vps.yml` (`github.repository`) — chính
    workflow deploy là chỗ biết chắc hôm nay đang triển khai kho nào.
  */
  if (!r) {
    return {
      configured: false,
      reason: "Chưa có ERP_GITHUB_REPO dạng `chu-so-huu/ten-kho` — biến này do workflow deploy tự truyền xuống, nên máy chủ chưa chạy lượt deploy nào sau khi bản này lên thì nó còn trống.",
      repo: null,
      auth: t ? "TOKEN" : "PUBLIC",
      tokenMasked: t ? maskToken(t) : null,
    };
  }
  return { configured: true, reason: null, repo: r, auth: t ? "TOKEN" : "PUBLIC", tokenMasked: t ? maskToken(t) : null };
}

/**
 * Đọc hạn mức còn lại từ header phản hồi. GitHub trả `x-ratelimit-remaining: 0` kèm 403 khi hết —
 * KHÔNG phải 429, nên một bộ dò chỉ nhìn mã trạng thái sẽ gọi nhầm nó là "thiếu quyền" và gửi
 * người vận hành đi tạo token mới cho một thứ chỉ cần chờ.
 */
function rateLimited(res: { status: number; headers: { get(name: string): string | null } }): number | null {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status !== 403 && res.status !== 429) return null;
  if (remaining !== null && remaining.trim() !== "0") return null;
  if (res.status === 403 && remaining === null) return null;
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, Math.round(reset - Date.now() / 1000));
  const retryAfter = Number(res.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter > 0 ? Math.round(retryAfter) : null;
}

async function get<T>(path: string): Promise<T> {
  const t = token();
  const r = repo();
  if (!r) throw new GithubError("NOT_CONFIGURED", githubConfig().reason ?? "Chưa cấu hình GitHub.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    /*
      KHÔNG có token thì KHÔNG gửi header `Authorization` — gửi một header rỗng hay `Bearer `
      không phải là "gọi ẩn danh", GitHub trả 401 cho nó. Đây là chỗ duy nhất quyết định chế độ.
    */
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "vnxcommerce-erp",
    };
    if (t) headers.Authorization = `Bearer ${t}`;

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await (fetchImpl ?? fetch)(`${API}/repos/${r}${path}`, { method: "GET", headers, signal: controller.signal, cache: "no-store" });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      throw new GithubError("NETWORK", controller.signal.aborted ? `Hết ${TIMEOUT_MS / 1000} giây chờ GitHub trả lời.` : `Không gọi được GitHub: ${m}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      /*
        KHÔNG in nguyên phần thân lỗi: phản hồi 4xx của GitHub có thể vọng lại chính header yêu cầu.
        Lấy đúng trường `message` — thứ duy nhất nói được điều cần biết — và cắt ngắn.
      */
      let message = "";
      try {
        message = String((JSON.parse(body) as { message?: unknown }).message ?? "");
      } catch {
        message = "";
      }
      const doi = rateLimited(res);
      if (doi !== null) {
        const phut = Math.ceil(doi / 60);
        throw new GithubError(
          "RATE_LIMITED",
          t
            ? `GitHub tạm khoá vì vượt hạn mức (5.000 request/giờ cho token). Thử lại sau ~${phut} phút.`
            : `GitHub tạm khoá vì vượt hạn mức GỌI ẨN DANH (60 request/giờ, tính theo địa chỉ IP của máy chủ). Thử lại sau ~${phut} phút, hoặc đặt ERP_GITHUB_TOKEN để được 5.000/giờ.`,
          res.status,
          doi,
        );
      }
      if (res.status === 401) {
        throw new GithubError(
          "AUTH_FAILED",
          `GitHub từ chối token đang dùng (401${message ? `: ${message.slice(0, 120)}` : ""}). Kho này PUBLIC nên đọc được mà KHÔNG cần token — hoặc xoá ERP_GITHUB_TOKEN/GITHUB_TOKEN/GH_TOKEN khỏi .env, hoặc thay bằng token còn hiệu lực.`,
          401,
        );
      }
      if (res.status === 404) {
        throw new GithubError(
          "NOT_FOUND",
          `GitHub không thấy \`${r}\` hoặc tệp workflow \`${deployWorkflowFile()}\` (404). Kiểm tra ERP_GITHUB_REPO và ERP_GITHUB_DEPLOY_WORKFLOW${t ? "" : " — nếu kho là PRIVATE thì lượt gọi ẩn danh luôn thấy 404, lúc đó mới cần token"}.`,
          404,
        );
      }
      throw new GithubError("HTTP", `GitHub trả ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`, res.status);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export type GithubRun = {
  id: number;
  runNumber: number;
  runAttempt: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string;
  actor: string;
  event: string;
  htmlUrl: string;
  createdAt: Date;
  runStartedAt: Date | null;
  updatedAt: Date | null;
};

type RawRun = {
  id: number;
  run_number: number;
  run_attempt?: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  event: string;
  html_url: string;
  created_at: string;
  run_started_at?: string | null;
  updated_at?: string | null;
  actor?: { login?: string } | null;
  triggering_actor?: { login?: string } | null;
};

function toRun(r: RawRun): GithubRun {
  const d = (v: string | null | undefined) => (v ? new Date(v) : null);
  return {
    id: r.id,
    runNumber: r.run_number,
    runAttempt: r.run_attempt ?? 1,
    status: r.status,
    conclusion: r.conclusion,
    headSha: r.head_sha,
    headBranch: r.head_branch,
    // Ảnh chụp TÊN người bấm — để đọc, không phải để quy kết: tài khoản GitHub không phải `users.id`.
    actor: r.triggering_actor?.login ?? r.actor?.login ?? "",
    event: r.event,
    htmlUrl: r.html_url,
    createdAt: new Date(r.created_at),
    runStartedAt: d(r.run_started_at),
    updatedAt: d(r.updated_at),
  };
}

/**
 * Thử kết nối — theo đúng hợp đồng mọi tích hợp trong kho này phải có (AGENTS.md mục 5).
 *
 * Gọi một endpoint RẺ và CHỈ ĐỌC. Không in token, chỉ in dạng đã che.
 */
export async function testConnection(): Promise<{ ok: boolean; detail: string; kind: GithubErrorKind | null; auth: GithubAuthMode }> {
  const cfg = githubConfig();
  if (!cfg.configured) return { ok: false, detail: cfg.reason ?? "Chưa cấu hình.", kind: "NOT_CONFIGURED", auth: cfg.auth };
  try {
    const wf = await get<{ name?: string; state?: string }>(`/actions/workflows/${encodeURIComponent(deployWorkflowFile())}`);
    const cach = cfg.auth === "TOKEN" ? `token ${cfg.tokenMasked}` : "gọi ẩn danh (kho public, không cần token)";
    return { ok: true, detail: `Đọc được workflow "${wf.name ?? deployWorkflowFile()}" (${wf.state ?? "?"}) của ${cfg.repo} · ${cach}`, kind: null, auth: cfg.auth };
  } catch (e) {
    if (e instanceof GithubError) return { ok: false, detail: e.message, kind: e.kind, auth: cfg.auth };
    return { ok: false, detail: e instanceof Error ? e.message : String(e), kind: "HTTP", auth: cfg.auth };
  }
}

/** N lượt chạy gần nhất của workflow deploy. CHỈ ĐỌC. */
export async function listRecentDeployRuns(limit = 20): Promise<GithubRun[]> {
  const n = Math.max(1, Math.min(100, limit));
  const data = await get<{ workflow_runs?: RawRun[] }>(`/actions/workflows/${encodeURIComponent(deployWorkflowFile())}/runs?per_page=${n}`);
  return (data.workflow_runs ?? []).map(toRun);
}

/** Một lượt chạy cụ thể. CHỈ ĐỌC. */
export async function getDeployRun(runId: number): Promise<GithubRun> {
  return toRun(await get<RawRun>(`/actions/runs/${runId}`));
}
