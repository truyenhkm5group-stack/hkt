import { createPrivateKey, createSign, type KeyObject } from "node:crypto";

/**
 * ═══════════ DANH TÍNH GITHUB CỦA CODING AGENT — KHÔNG PHẢI CỦA CHỦ SHOP ═══════════
 *
 * ĐÃ ĐO THẬT 19/09/2026 trên chính kho này:
 *
 *     GET /user                              → truyenhkm5group-stack        (danh tính agent)
 *     GET /repos/…/collaborators             → truyenhkm5group-stack, admin (ĐÚNG MỘT người)
 *     PR #12: tác giả                        → truyenhkm5group-stack
 *     PR #12: số lượt duyệt APPROVED         → 0
 *     PUT /pulls/12/merge (REST chuẩn)       → THÀNH CÔNG
 *     GET /repos/…/rulesets/23697012         → required_approving_review_count: 0
 *
 * Agent = tác giả PR = collaborator duy nhất = admin, **cùng một tài khoản**. Ở tình trạng đó
 * cổng duyệt của người KHÔNG CÓ NẤC NÀO DÙNG ĐƯỢC:
 *
 *   · để 0 lượt duyệt ⇒ cổng vô hiệu, agent merge PR của chính nó;
 *   · nâng lên 1 lượt ⇒ GitHub cấm tự duyệt ⇒ không PR nào merge được nữa, kho tự khoá chết.
 *
 * Không công tắc nào của GitHub sửa được điều đó. Thứ còn thiếu là một **DANH TÍNH THỨ HAI**, và
 * tệp này là nó: agent đẩy nhánh và mở PR bằng danh tính GitHub App `erp-agent`, chủ shop duyệt
 * bằng tài khoản người của mình. Hai danh tính khác nhau ⇒ `required_approving_review_count: 1`
 * trở thành một luật CHẠY ĐƯỢC thay vì một cái bẫy.
 *
 * ─────────── BỐN LUẬT CỦA TỆP NÀY ───────────
 *
 * 1. **KHOÁ RIÊNG CHỈ SỐNG Ở BIẾN MÔI TRƯỜNG.** Không CSDL, không tệp trong kho, không prompt,
 *    không nhật ký. Kho này PUBLIC. Thứ duy nhất được in ra là `maskIdentity()`.
 * 2. **TOKEN CÀI ĐẶT LÀ NGẮN HẠN VÀ KHÔNG ĐƯỢC LƯU.** GitHub cấp tối đa 60 phút; ta giữ trong BỘ
 *    NHỚ của tiến trình và bỏ đi trước hạn `TOKEN_SAFETY_MS`. Ghi nó xuống đĩa hay xuống CSDL là
 *    biến một thứ tự hết hạn thành một thứ vĩnh viễn.
 * 3. **KHẢ NĂNG LÀ DANH SÁCH CHO PHÉP, VÀ NÓ ĐƯỢC THI HÀNH BẰNG SỰ VẮNG MẶT.** Tệp này KHÔNG CÓ
 *    hàm nào duyệt PR, gộp PR, sửa ruleset hay sửa cấu hình kho. Đó không phải một lời hứa trong
 *    chú thích — `tests/agent-identity.test.ts` quét mã nguồn và đỏ nếu một đường như thế xuất
 *    hiện. Một "cờ tắt" thì bật lại được; một hàm không tồn tại thì không.
 * 4. **KHÔNG ĐẨY ĐƯỢC VÀO NHÁNH MẶC ĐỊNH.** `assertAgentBranch()` chặn ở tầng mã, TRƯỚC khi
 *    ruleset của GitHub phải lên tiếng. Hai hàng rào cho cùng một việc là cố ý: ruleset là hàng
 *    rào thật, hàng rào này làm cho một lỗi lập trình hỏng ở chỗ đọc được thay vì ở một lượt 403.
 */

const API = "https://api.github.com";
const TIMEOUT_MS = 20_000;
/** Bỏ token trước hạn ngần này — token hết hạn giữa một lượt push là một lỗi rất khó đọc. */
const TOKEN_SAFETY_MS = 5 * 60_000;
/** Hạn của JWT ký bằng khoá riêng. GitHub cho tối đa 10 phút; 9 để trừ lệch đồng hồ. */
const APP_JWT_TTL_S = 9 * 60;

type FetchLike = typeof fetch;
let fetchImpl: FetchLike | null = null;

/** CHỈ DÙNG CHO KIỂM THỬ: tiêm `fetch` giả (cùng idiom `lib/integrations/github/client.ts`). */
export function __setAgentGithubFetchForTests(f: FetchLike | null) {
  fetchImpl = f;
  cached = null;
}

/**
 * Việc agent ĐƯỢC làm bằng danh tính này. Danh sách CHO PHÉP, không phải danh sách cấm: quên khai
 * một việc ⇒ agent không làm được nó, còn danh sách cấm thì mỗi endpoint mới của GitHub là một lỗ
 * hổng mới (cùng luật với hàng rào lệnh ở `lib/constants/agent-sandbox.ts`).
 */
export const AGENT_GITHUB_ALLOWED = [
  "branch:create",
  "branch:push",
  "pr:open",
  "pr:update",
  "pr:update-branch",
  "checks:read",
] as const;
export type AgentGithubAction = (typeof AGENT_GITHUB_ALLOWED)[number];

/**
 * Việc agent KHÔNG được làm — khai ra để màn hình và tài liệu nói được, KHÔNG phải để mã đọc rồi
 * quyết định. Mã thi hành bằng cách KHÔNG CÓ đường nào làm những việc này, và bằng quyền của
 * GitHub App (xem `docs/agent-github-identity.md`).
 */
export const AGENT_GITHUB_DENIED = [
  "push:default-branch",
  "pr:approve",
  "pr:merge",
  "ruleset:write",
  "repo:settings:write",
  "secrets:write",
  "actions:write",
] as const;

export type AgentGithubConfig = { appId: string; installationId: string; privateKey: KeyObject; owner: string; repo: string };

export class AgentGithubNotConfiguredError extends Error {}

function trimmed(name: string): string {
  return (process.env[name] ?? "").trim();
}

/**
 * Khoá riêng nhận ở hai dạng: PEM nguyên văn (có xuống dòng) hoặc PEM đã mã hoá base64 — vì nhiều
 * nơi lưu secret (GitHub Actions Secrets, `.env` một dòng) không giữ được xuống dòng, và một khoá
 * bị mất xuống dòng thì lỗi hiện ra là "error:1E08010C" chứ không phải "khoá sai định dạng".
 * `createPrivateKey` nhận cả PKCS#1 (`BEGIN RSA PRIVATE KEY`, dạng GitHub tải về) lẫn PKCS#8.
 */
function readPrivateKey(raw: string): KeyObject {
  const pem = raw.includes("BEGIN") ? raw.replace(/\\n/g, "\n") : Buffer.from(raw, "base64").toString("utf8");
  return createPrivateKey(pem);
}

/**
 * Cấu hình danh tính agent. Thiếu bất kỳ mảnh nào ⇒ `null` (CHƯA CẤU HÌNH), không phải lỗi: máy
 * chủ và bộ kiểm thử phải chạy được khi chưa ai tạo App. Nói rõ thiếu gì là việc của
 * `agentGithubDisabledReason()`.
 */
export function agentGithubConfig(): AgentGithubConfig | null {
  const appId = trimmed("ERP_AGENT_GITHUB_APP_ID");
  const installationId = trimmed("ERP_AGENT_GITHUB_INSTALLATION_ID");
  const key = trimmed("ERP_AGENT_GITHUB_PRIVATE_KEY");
  const slug = trimmed("ERP_AGENT_GITHUB_REPO") || trimmed("ERP_GITHUB_REPO") || trimmed("GITHUB_REPOSITORY");
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(slug);
  if (!appId || !installationId || !key || !m) return null;
  try {
    return { appId, installationId, privateKey: readPrivateKey(key), owner: m[1]!, repo: m[2]! };
  } catch {
    return null;
  }
}

/** Câu chữ nói ĐÚNG mảnh còn thiếu — "chưa cấu hình" mà không nói thiếu gì là một ngõ cụt. */
export function agentGithubDisabledReason(): string | null {
  const missing: string[] = [];
  if (!trimmed("ERP_AGENT_GITHUB_APP_ID")) missing.push("ERP_AGENT_GITHUB_APP_ID");
  if (!trimmed("ERP_AGENT_GITHUB_INSTALLATION_ID")) missing.push("ERP_AGENT_GITHUB_INSTALLATION_ID");
  if (!trimmed("ERP_AGENT_GITHUB_PRIVATE_KEY")) missing.push("ERP_AGENT_GITHUB_PRIVATE_KEY");
  if (!(trimmed("ERP_AGENT_GITHUB_REPO") || trimmed("ERP_GITHUB_REPO") || trimmed("GITHUB_REPOSITORY"))) missing.push("ERP_AGENT_GITHUB_REPO");
  if (missing.length) return `Chưa có ${missing.join(", ")}`;
  return agentGithubConfig() ? null : "ERP_AGENT_GITHUB_PRIVATE_KEY không đọc được (PEM hoặc base64 của PEM)";
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * JWT của APP (không phải của cài đặt): ký RS256 bằng khoá riêng, chỉ dùng để ĐỔI lấy token cài
 * đặt. Ký tay bằng `node:crypto` thay vì thêm một lớp thư viện — ba dòng, và không có mặc định ẩn
 * nào quyết định hộ thuật toán.
 */
export function appJwt(cfg: AgentGithubConfig, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000) - 60; // lệch đồng hồ
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + APP_JWT_TTL_S, iss: cfg.appId }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(cfg.privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

type CachedToken = { token: string; expiresAt: number; installationId: string };
/** CHỈ TRONG BỘ NHỚ. Không CSDL, không tệp — xem luật 2 ở đầu tệp. */
let cached: CachedToken | null = null;

async function call(url: string, init: RequestInit & { auth: string }): Promise<Response> {
  const { auth, ...rest } = init;
  const f = fetchImpl ?? fetch;
  return f(url, {
    ...rest,
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", authorization: `Bearer ${auth}`, ...(rest.headers ?? {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Token cài đặt NGẮN HẠN. Nó KHÔNG được trả ra khỏi mô-đun này ở dạng dùng lại được trong bất kỳ
 * đường nào đi tới model hay tới màn hình — chỉ các hàm bên dưới dùng, và `agentRemoteUrl()` (dành
 * cho `git push`) được khai rõ là KHÔNG ĐƯỢC IN.
 */
async function installationToken(cfg: AgentGithubConfig, now: Date = new Date()): Promise<string> {
  if (cached && cached.installationId === cfg.installationId && cached.expiresAt - now.getTime() > TOKEN_SAFETY_MS) return cached.token;
  const res = await call(`${API}/app/installations/${encodeURIComponent(cfg.installationId)}/access_tokens`, {
    method: "POST",
    auth: appJwt(cfg, now),
    headers: { "content-type": "application/json" },
    // Thu hẹp lần nữa ở MỖI lượt xin: token chỉ có hiệu lực trên đúng kho này. Quyền của App đã
    // hẹp rồi, nhưng một cài đặt có thể được thêm kho về sau mà không ai sửa mã ở đây.
    body: JSON.stringify({ repositories: [cfg.repo] }),
  });
  if (!res.ok) throw new Error(`Không xin được token cài đặt (HTTP ${res.status}) — kiểm App id, installation id và khoá riêng.`);
  const json = (await res.json()) as { token?: string; expires_at?: string };
  if (!json.token) throw new Error("GitHub không trả token cài đặt");
  cached = { token: json.token, expiresAt: json.expires_at ? Date.parse(json.expires_at) : now.getTime() + 60 * 60_000, installationId: cfg.installationId };
  return json.token;
}

/** Vứt token đang giữ. Gọi khi đổi cấu hình hoặc khi một lượt trả 401. */
export function forgetAgentToken() {
  cached = null;
}

function must(): AgentGithubConfig {
  const cfg = agentGithubConfig();
  if (!cfg) throw new AgentGithubNotConfiguredError(agentGithubDisabledReason() ?? "Danh tính GitHub của agent chưa được cấu hình");
  return cfg;
}

/**
 * Nhánh mà agent được đẩy. Chặn nhánh mặc định và mọi nhánh không mang tiền tố của agent.
 *
 * Tiền tố mặc định là `ai/`: một cái tên nhìn là biết ai đẩy, và nó làm cho "lọc ra mọi thứ agent
 * đã làm" thành một lệnh `git branch --list 'ai/*'` chứ không phải một cuộc điều tra.
 */
export const AGENT_BRANCH_PREFIXES = ["ai/", "claude/"] as const;

export function assertAgentBranch(ref: string, defaultBranch = "main"): string {
  const branch = ref.replace(/^refs\/heads\//, "").trim();
  if (!branch) throw new Error("Thiếu tên nhánh");
  if (branch === defaultBranch) throw new Error(`Agent không được đẩy thẳng vào ${defaultBranch} — mọi thay đổi đi bằng pull request`);
  if (!AGENT_BRANCH_PREFIXES.some((p) => branch.startsWith(p))) throw new Error(`Nhánh của agent phải bắt đầu bằng ${AGENT_BRANCH_PREFIXES.join(" hoặc ")} (thấy "${branch}")`);
  if (branch.includes("..") || branch.startsWith("/")) throw new Error(`Tên nhánh không hợp lệ: ${branch}`);
  return branch;
}

/**
 * Danh tính đang dùng, ở dạng IN RA ĐƯỢC. Không có token, không có khoá riêng, không có gì dùng
 * lại được — đủ để trả lời câu hỏi duy nhất đáng hỏi: *"đây có phải cùng tài khoản với chủ shop
 * không?"*
 */
export async function getAgentGithubIdentity(now: Date = new Date()): Promise<{ appId: string; appSlug: string; botLogin: string; installationId: string; repo: string; permissions: Record<string, string>; repositorySelection: string }> {
  const cfg = must();
  const res = await call(`${API}/app`, { auth: appJwt(cfg, now) });
  if (!res.ok) throw new Error(`Không đọc được hồ sơ GitHub App (HTTP ${res.status})`);
  const app = (await res.json()) as { slug?: string; name?: string };
  const insRes = await call(`${API}/app/installations/${encodeURIComponent(cfg.installationId)}`, { auth: appJwt(cfg, now) });
  if (!insRes.ok) throw new Error(`Không đọc được cài đặt ${cfg.installationId} (HTTP ${insRes.status})`);
  const ins = (await insRes.json()) as { permissions?: Record<string, string>; repository_selection?: string };
  const slug = app.slug ?? "";
  return {
    appId: cfg.appId,
    appSlug: slug,
    // Danh tính hiện trên PR là `<slug>[bot]` — đây chính là chuỗi phải KHÁC login của chủ shop.
    botLogin: slug ? `${slug}[bot]` : "",
    installationId: cfg.installationId,
    repo: `${cfg.owner}/${cfg.repo}`,
    permissions: ins.permissions ?? {},
    repositorySelection: ins.repository_selection ?? "",
  };
}

/**
 * URL remote để `git push` bằng danh tính agent. **KHÔNG ĐƯỢC IN, KHÔNG ĐƯỢC GHI NHẬT KÝ, KHÔNG
 * ĐƯỢC ĐƯA VÀO PROMPT** — nó mang token. Dùng `maskRemote()` khi cần nói về nó.
 */
export async function agentRemoteUrl(now: Date = new Date()): Promise<string> {
  const cfg = must();
  const token = await installationToken(cfg, now);
  return `https://x-access-token:${token}@github.com/${cfg.owner}/${cfg.repo}.git`;
}

export function maskRemote(url: string): string {
  return url.replace(/\/\/[^@]*@/, "//***@");
}

/**
 * ═══════════ TẠO NHÁNH VÀ GHI COMMIT BẰNG API, KHÔNG BẰNG `git` ═══════════
 *
 * `agentRemoteUrl()` (git push) và hai hàm dưới đây làm cùng một việc bằng hai đường, và đường
 * nào dùng được là chuyện của MÔI TRƯỜNG chứ không phải của sở thích:
 *
 *   · `git push` cần một tiến trình `git` mà credential của nó KHÔNG bị ai khác tiêm vào. Đo thật
 *     19/09/2026 trong một phiên agent: một lượt đẩy mang token RÁC vẫn THÀNH CÔNG vào kho này,
 *     vì lớp proxy của phiên tự gắn credential của phiên. Ở môi trường như thế, lượt đẩy nói về
 *     danh tính của PHIÊN, không nói gì về danh tính của App — và một bằng chứng danh tính rút ra
 *     từ đó là bằng chứng giả.
 *   · Lời gọi API mang `Authorization` TƯỜNG MINH. Kiểm được bằng một câu hỏi: `GET /user` với
 *     token cài đặt phải trả 403 (token cài đặt không có ngữ cảnh người dùng). Trả về một hồ sơ
 *     người dùng nghĩa là có ai đó đã tráo token.
 *
 * Nên đường API là đường CHỨNG MINH ĐƯỢC, và nó cũng đủ cho một agent chỉ có `contents: write`.
 */

/** Tạo nhánh mới từ một ref có sẵn. Nhánh phải mang tiền tố của agent. */
export async function createAgentBranch(input: { branch: string; fromRef?: string; now?: Date }): Promise<{ branch: string; baseSha: string }> {
  const cfg = must();
  const base = input.fromRef ?? "main";
  const branch = assertAgentBranch(input.branch, base);
  const token = await installationToken(cfg, input.now ?? new Date());
  const baseRes = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/git/ref/heads/${encodeURIComponent(base)}`, { auth: token });
  if (!baseRes.ok) throw new Error(`Không đọc được nhánh gốc ${base} (HTTP ${baseRes.status})`);
  const baseSha = ((await baseRes.json()) as { object?: { sha?: string } }).object?.sha;
  if (!baseSha) throw new Error(`Nhánh gốc ${base} không có SHA`);
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/git/refs`, {
    method: "POST",
    auth: token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: baseSha }),
  });
  if (!res.ok) throw new Error(`Không tạo được nhánh ${branch} (HTTP ${res.status})`);
  return { branch, baseSha };
}

/**
 * Ghi MỘT tệp thành MỘT commit trên nhánh của agent. Tác giả commit do TOKEN quyết định (GitHub
 * ghi `<slug>[bot]`), nên không có ô nào để gõ một cái tên khác vào — cùng tinh thần AGENTS.md
 * mục 34: quy kết đi bằng khoá, không bằng ô chữ.
 */
export async function commitAgentFile(input: { branch: string; path: string; content: string; message: string; baseBranch?: string; now?: Date }): Promise<{ sha: string }> {
  const cfg = must();
  const branch = assertAgentBranch(input.branch, input.baseBranch ?? "main");
  if (!input.path || input.path.startsWith("/") || input.path.includes("..")) throw new Error(`Đường dẫn không hợp lệ: ${input.path}`);
  const token = await installationToken(cfg, input.now ?? new Date());
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`, {
    method: "PUT",
    auth: token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: input.message, content: Buffer.from(input.content, "utf8").toString("base64"), branch }),
  });
  if (!res.ok) throw new Error(`Không ghi được ${input.path} lên ${branch} (HTTP ${res.status})`);
  const sha = ((await res.json()) as { commit?: { sha?: string } }).commit?.sha;
  if (!sha) throw new Error("GitHub không trả SHA của commit");
  return { sha };
}

/** Mở PR bằng danh tính agent. Base mặc định là nhánh mặc định; head phải là nhánh của agent. */
export async function openAgentPullRequest(input: { head: string; base?: string; title: string; body: string; now?: Date }): Promise<{ number: number; url: string }> {
  const cfg = must();
  const base = input.base ?? "main";
  const head = assertAgentBranch(input.head, base);
  const token = await installationToken(cfg, input.now ?? new Date());
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls`, {
    method: "POST",
    auth: token,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ head, base, title: input.title, body: input.body }),
  });
  if (!res.ok) throw new Error(`Không mở được pull request (HTTP ${res.status})`);
  const json = (await res.json()) as { number?: number; html_url?: string };
  if (!json.number) throw new Error("GitHub không trả số hiệu pull request");
  return { number: json.number, url: json.html_url ?? "" };
}

/** Sửa tiêu đề / mô tả PR của chính agent. KHÔNG đổi được base, KHÔNG đóng, KHÔNG gộp. */
export async function updateAgentPullRequest(input: { number: number; title?: string; body?: string; now?: Date }): Promise<void> {
  const cfg = must();
  const patch: Record<string, string> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.body !== undefined) patch.body = input.body;
  // Không có gì để sửa thì không xin token và không gọi mạng — một lượt gọi rỗng vẫn tiêu hạn mức
  // và vẫn để lại một dòng trong nhật ký kho như thể có thay đổi.
  if (!Object.keys(patch).length) return;
  const token = await installationToken(cfg, input.now ?? new Date());
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${input.number}`, { method: "PATCH", auth: token, headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  if (!res.ok) throw new Error(`Không cập nhật được pull request #${input.number} (HTTP ${res.status})`);
}

/**
 * Nhập nhánh đích vào nhánh của PR để nó hết "behind" — GitHub gọi là *Update branch*.
 *
 * VÌ SAO AGENT CẦN VIỆC NÀY, VÀ VÌ SAO NÓ AN TOÀN: `strict_required_status_checks_policy` bắt PR
 * phải cập nhật với nhánh đích NGAY TẠI LÚC merge. Với nhiều phiên chạy song song, nhánh đích
 * nhảy liên tục, nên một PR của agent sẽ "behind" vài phút sau khi mở. Nếu NGƯỜI phải bấm nút ấy
 * thì mỗi lần bấm lại biến người thành **người đẩy cuối**, và `require_last_push_approval` sẽ cấm
 * chính họ duyệt — cổng đóng lại với người mà nó đang chờ.
 *
 * Việc này KHÔNG mở thêm quyền nào: nó là một lượt ghi vào nhánh CỦA AGENT, đúng thứ
 * `contents: write` đã cho phép, và `assertAgentBranch` vẫn chặn nhánh mặc định. Nó KHÔNG gộp PR,
 * KHÔNG duyệt, KHÔNG đụng nhánh đích.
 */
export async function updateAgentPullRequestBranch(input: { number: number; baseBranch?: string; now?: Date }): Promise<{ head: string }> {
  const cfg = must();
  const token = await installationToken(cfg, input.now ?? new Date());
  const prRes = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${input.number}`, { auth: token });
  if (!prRes.ok) throw new Error(`Không đọc được pull request #${input.number} (HTTP ${prRes.status})`);
  const pr = (await prRes.json()) as { head?: { ref?: string }; base?: { ref?: string } };
  // Chặn ở tầng mã TRƯỚC khi gọi: nhánh của PR phải là nhánh của agent, không phải nhánh mặc định.
  assertAgentBranch(pr.head?.ref ?? "", input.baseBranch ?? pr.base?.ref ?? "main");
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/pulls/${input.number}/update-branch`, {
    method: "PUT",
    auth: token,
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  // 202 = GitHub nhận việc và làm bất đồng bộ; nơi gọi phải đọc lại SHA để biết nó xong chưa.
  if (res.status !== 202) throw new Error(`Không cập nhật được nhánh của #${input.number} (HTTP ${res.status})`);
  return { head: pr.head?.ref ?? "" };
}

/** Đọc kết quả cổng của một commit. CHỈ ĐỌC. */
export async function readAgentCheckRuns(sha: string, now: Date = new Date()): Promise<{ name: string; status: string; conclusion: string | null }[]> {
  const cfg = must();
  const token = await installationToken(cfg, now);
  const res = await call(`${API}/repos/${cfg.owner}/${cfg.repo}/commits/${encodeURIComponent(sha)}/check-runs`, { auth: token });
  if (!res.ok) throw new Error(`Không đọc được check runs của ${sha.slice(0, 7)} (HTTP ${res.status})`);
  const json = (await res.json()) as { check_runs?: { name?: string; status?: string; conclusion?: string | null }[] };
  return (json.check_runs ?? []).map((c) => ({ name: c.name ?? "", status: c.status ?? "", conclusion: c.conclusion ?? null }));
}

/**
 * Thử kết nối cho trang Kết nối dữ liệu / `check:integrations`. KHÔNG GHI GÌ và KHÔNG IN SECRET —
 * cùng luật với `lib/actions/vtp-capability.ts` (AGENTS.md mục 55).
 *
 * Trả về BA tình huống phân biệt được, vì cách sửa mỗi cái là một việc khác:
 *   · `NOT_CONFIGURED` — chưa ai tạo App / chưa đặt secret (nói rõ thiếu biến nào);
 *   · `ERROR`          — có cấu hình nhưng không đổi được token (App id sai, khoá sai, chưa cài);
 *   · `OK`             — đổi được token và đọc được danh tính.
 */
export async function testAgentGithubIdentity(now: Date = new Date()): Promise<{ status: "OK" | "ERROR" | "NOT_CONFIGURED"; message: string; identity: Awaited<ReturnType<typeof getAgentGithubIdentity>> | null }> {
  const reason = agentGithubDisabledReason();
  if (reason) return { status: "NOT_CONFIGURED", message: reason, identity: null };
  try {
    const identity = await getAgentGithubIdentity(now);
    // Đổi token thật một lần: đọc được hồ sơ App chưa chứng minh cài đặt còn sống.
    await installationToken(must(), now);
    return { status: "OK", message: `Danh tính agent: ${identity.botLogin || identity.appSlug} · cài đặt ${identity.installationId} · kho ${identity.repo}`, identity };
  } catch (e) {
    return { status: "ERROR", message: e instanceof Error ? e.message : String(e), identity: null };
  }
}
