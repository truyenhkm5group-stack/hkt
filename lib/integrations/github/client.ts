
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
 * 2. **Token chỉ ở biến môi trường máy chủ.** Không lưu CSDL, không đi vào prompt, không xuống
 *    trình duyệt, không vào nhật ký.
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

export type GithubConfigState = { configured: boolean; reason: string | null; repo: string | null; tokenMasked: string | null };

/**
 * Đã cấu hình chưa — và nếu chưa thì THIẾU ĐÚNG CÁI GÌ.
 *
 * Trả lời "chưa cấu hình" mà không nói thiếu gì là bắt người vận hành đi đoán. Cùng hình dạng với
 * `aiDisabledReason()`.
 */
export function githubConfig(): GithubConfigState {
  const t = token();
  const r = repo();
  if (!t && !r) return { configured: false, reason: "Chưa có ERP_GITHUB_TOKEN và ERP_GITHUB_REPO.", repo: null, tokenMasked: null };
  if (!t) return { configured: false, reason: "Chưa có ERP_GITHUB_TOKEN (token CHỈ ĐỌC, quyền Actions: read).", repo: r, tokenMasked: null };
  if (!r) return { configured: false, reason: "Chưa có ERP_GITHUB_REPO dạng `chu-so-huu/ten-kho`.", repo: null, tokenMasked: maskToken(t) };
  return { configured: true, reason: null, repo: r, tokenMasked: maskToken(t) };
}

async function get<T>(path: string): Promise<T> {
  const t = token();
  const r = repo();
  if (!t || !r) throw new Error(githubConfig().reason ?? "Chưa cấu hình GitHub.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await (fetchImpl ?? fetch)(`${API}/repos/${r}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "vnxcommerce-erp",
      },
      signal: controller.signal,
      cache: "no-store",
    });
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
      throw new Error(`GitHub trả ${res.status}${message ? `: ${message.slice(0, 200)}` : ""}`);
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
export async function testConnection(): Promise<{ ok: boolean; detail: string }> {
  const cfg = githubConfig();
  if (!cfg.configured) return { ok: false, detail: cfg.reason ?? "Chưa cấu hình." };
  try {
    const wf = await get<{ name?: string; state?: string }>(`/actions/workflows/${encodeURIComponent(deployWorkflowFile())}`);
    return { ok: true, detail: `Đọc được workflow "${wf.name ?? deployWorkflowFile()}" (${wf.state ?? "?"}) của ${cfg.repo} · token ${cfg.tokenMasked}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
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
