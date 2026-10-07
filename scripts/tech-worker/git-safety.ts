import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { WORKER_BRANCH_PATTERN } from "@/lib/constants/tech-worker";

/**
 * ═══════════ AN TOÀN GIT CỦA WORKER — ĐẨY NHÁNH BẰNG TOKEN · DỌN CÂY CŨ ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Tách khỏi `scripts/tech-worker.ts` (tệp đó chạy `main()` khi import) để bài
 * kiểm chạy THẬT các hàm này trên kho git tạm.
 *
 * ─── VÌ SAO ĐẨY NHÁNH PHẢI CỨNG TỚI MỨC NÀY (review bảo mật PR #631) ───
 *
 * Cổng (`npm ci` · lint · test) chạy MÃ AGENT VỪA VIẾT trong chính cây làm việc, nên trước lượt đẩy, mã đó có thể đã sửa
 * `.git/config` (dùng chung cho mọi worktree của kho): `core.hooksPath` (hook pre-push kế thừa biến môi trường ⇒ đọc
 * token), `remote.origin.pushurl` / `url.*.insteadOf` (đẩy token sang máy khác), `http.proxy`, `include.path`, một
 * credential helper… Token `contents: write` của bot gộp được PR khác. Nên lượt đẩy:
 *   · KHÔNG đọc cấu hình hệ thống / toàn cục (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` = tệp rỗng của worker);
 *   · KIỂM cấu hình cục bộ + worktree TRƯỚC khi đẩy — có khoá nguy hiểm ⇒ TỪ CHỐI (không "ghi đè rồi đẩy tiếp": một cấu
 *     hình bị cài là bằng chứng phải người xem);
 *   · VẪN ép lại bằng `-c` (lớp thứ hai): hook trỏ vào thư mục RỖNG của worker, mọi helper chung bị xoá, helper chỉ gắn
 *     `https://github.com`, proxy rỗng, `sslVerify=true`, chỉ giao thức https;
 *   · đẩy tới URL TƯỜNG MINH do máy chủ cấp (không qua remote đã cấu hình), refspec `HEAD:refs/heads/<nhánh máy chủ cấp>`;
 *   · token chỉ trong biến môi trường của đúng tiến trình `git push`, và bị THU HỒI ngay sau lượt đẩy.
 */

export const PUSH_TOKEN_ENV = "VNX_PUSH_TOKEN";

/** URL kho mà máy chủ cấp — hình dạng ĐÓNG, không credential, chỉ github.com. */
export const PUSH_URL_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/;

/**
 * Khoá cấu hình git làm lượt đẩy lộ token hoặc đổi đích. Kiểm trên `git config --list` (khoá: phần + khoá thường viết
 * thường). Có khoá nào ⇒ TỪ CHỐI đẩy.
 */
const NGUY_HIEM: { re: RegExp; why: string }[] = [
  { re: /^core\.(hookspath|askpass|sshcommand|gitproxy|fsmonitor)$/i, why: "hook / chương trình ngoài chạy trong lượt đẩy" },
  { re: /^remote\.[^=]*\.(pushurl|proxy|receivepack|uploadpack|vcs)$/i, why: "đổi đích / chương trình của remote" },
  { re: /^url\..*\.(insteadof|pushinsteadof)$/i, why: "viết lại URL đích" },
  { re: /^credential\./i, why: "credential helper do kho tự khai" },
  { re: /^https?\./i, why: "cấu hình HTTP (proxy · header · TLS)" },
  { re: /^include(if)?\./i, why: "nạp thêm tệp cấu hình" },
  { re: /^protocol\./i, why: "mở giao thức khác https" },
];

/** Các dòng cấu hình nguy hiểm trong bản liệt kê `git config --list` (dạng `khoá=giá trị`). Trả TÊN KHOÁ — không giá trị. */
export function pushConfigViolations(listing: string): string[] {
  const out: string[] = [];
  for (const dong of listing.split(/\r?\n/)) {
    const i = dong.indexOf("=");
    const khoa = (i < 0 ? dong : dong.slice(0, i)).trim();
    if (!khoa) continue;
    const hit = NGUY_HIEM.find((n) => n.re.test(khoa));
    if (hit) out.push(`${khoa} (${hit.why})`);
  }
  return out;
}

/** Tham số `git push` — hàm thuần. `url` đã được kiểm bởi người gọi (bài kiểm truyền kho tạm cục bộ). */
export function buildPushArgs(input: { branch: string; url: string; hooksDir: string; allowFileProtocol?: boolean }): string[] {
  if (!WORKER_BRANCH_PATTERN.test(input.branch)) throw new Error(`Worker chỉ đẩy nhánh ai/worker/* (thấy "${input.branch}")`);
  return [
    "-c",
    `core.hooksPath=${input.hooksDir}`,
    "-c",
    "credential.helper=",
    "-c",
    `credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$${PUSH_TOKEN_ENV}"; }; f`,
    "-c",
    "core.askPass=",
    "-c",
    "http.proxy=",
    "-c",
    "https.proxy=",
    "-c",
    "http.sslVerify=true",
    "-c",
    "protocol.allow=never",
    "-c",
    "protocol.https.allow=always",
    ...(input.allowFileProtocol ? ["-c", "protocol.file.allow=always"] : []),
    "push",
    "--no-verify",
    "-q",
    input.url,
    `HEAD:refs/heads/${input.branch}`,
  ];
}

/** Thư mục hook RỖNG + tệp cấu hình toàn cục RỖNG của worker — dựng lại mỗi lần (rỗng là bất biến). */
export function pushSandbox(root: string): { hooksDir: string; globalConfig: string } {
  const goc = path.join(root, ".push-sandbox");
  const hooksDir = path.join(goc, "hooks-empty");
  mkdirSync(hooksDir, { recursive: true });
  const globalConfig = path.join(goc, "empty.gitconfig");
  writeFileSync(globalConfig, "", "utf8");
  return { hooksDir, globalConfig };
}

/** Môi trường của tiến trình `git` trong lượt đẩy: không cấu hình hệ thống / toàn cục, không lời nhắc. */
export function pushEnv(base: Record<string, string>, globalConfig: string, token: string | null): Record<string, string> {
  const env: Record<string, string> = { ...base, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfig, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  delete env.GIT_SSH_COMMAND;
  if (token) env[PUSH_TOKEN_ENV] = token;
  return env;
}

export type SafePushInput = { dir: string; branch: string; url: string; token: string; root: string; baseEnv: Record<string, string>; allowLocalUrl?: boolean };

/**
 * Đẩy nhánh an toàn. Kiểm URL + nhánh + cấu hình cục bộ TRƯỚC; có vi phạm ⇒ `{ ok: false }` kèm tên khoá (không đẩy).
 * `allowLocalUrl` CHỈ cho bài kiểm (kho tạm trên đĩa) — đường worker không bao giờ đặt.
 */
export function safePush(input: SafePushInput): { ok: true } | { ok: false; error: string } {
  if (!input.allowLocalUrl && !PUSH_URL_PATTERN.test(input.url)) return { ok: false, error: `URL kho máy chủ cấp không hợp lệ` };
  if (!WORKER_BRANCH_PATTERN.test(input.branch)) return { ok: false, error: `Nhánh không phải ai/worker/*: ${input.branch}` };
  const sb = pushSandbox(input.root);
  const kiemEnv = pushEnv(input.baseEnv, sb.globalConfig, null);
  let listing = "";
  try {
    listing = execFileSync("git", ["config", "--list"], { cwd: input.dir, env: kiemEnv as NodeJS.ProcessEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  } catch {
    return { ok: false, error: "Không đọc được cấu hình git của cây làm việc — không đẩy." };
  }
  const sai = pushConfigViolations(listing);
  if (sai.length) return { ok: false, error: `Cấu hình git cục bộ có khoá nguy hiểm — KHÔNG đẩy (có thể mã trong cổng đã sửa .git/config): ${sai.join(", ")}` };
  try {
    execFileSync("git", buildPushArgs({ branch: input.branch, url: input.url, hooksDir: sb.hooksDir, allowFileProtocol: input.allowLocalUrl === true }), {
      cwd: input.dir,
      env: pushEnv(input.baseEnv, sb.globalConfig, input.token) as NodeJS.ProcessEnv,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5 * 60_000,
      windowsHide: true,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n").slice(0, 3).join(" ").slice(0, 400) : "lỗi";
    return { ok: false, error: `git push thất bại: ${msg.split(input.token).join("[đã che]")}` };
  }
  // Ghi lại "đã đẩy" vào ref theo dõi cục bộ — để bộ dọn cây biết commit này đã có trên remote.
  try {
    execFileSync("git", ["update-ref", `refs/remotes/origin/${input.branch}`, "HEAD"], { cwd: input.dir, env: kiemEnv as NodeJS.ProcessEnv, stdio: "ignore", windowsHide: true });
  } catch {
    /* không chặn */
  }
  return { ok: true };
}

/** Thu hồi token cài đặt ngay sau lượt đẩy (`DELETE /installation/token`) — token không sống quá lượt đẩy. */
export async function revokeInstallationToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl("https://api.github.com/installation/token", {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      signal: AbortSignal.timeout(15_000),
    });
    return r.status === 204;
  } catch {
    return false;
  }
}

/* ═════════════════════ DỌN CÂY CŨ (PRUNE_WORKTREES) ═════════════════════ */

export type WorktreeEntry = { path: string; branch: string | null };

/** Đọc `git worktree list --porcelain`. */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const dong of porcelain.split(/\r?\n/)) {
    if (dong.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: dong.slice("worktree ".length).trim(), branch: null };
    } else if (dong.startsWith("branch ") && cur) {
      cur.branch = dong.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  return out;
}

const chuan = (p: string) => path.resolve(p).split(path.sep).join("/").replace(/\/+$/, "").toLowerCase();

/**
 * Cây nào ĐƯỢC PHÉP dọn — hàm thuần: có trong danh sách worktree của CHÍNH kho worker, nằm DƯỚI `root`
 * (TECH_WORKER_ROOT — bắt buộc), tên `wt-tech-*`, nhánh `ai/worker/*`, không thuộc lượt đang chạy. Cây của người (nhánh
 * claude/…, nằm cạnh kho, tên trùng tiền tố) KHÔNG BAO GIỜ lọt qua.
 */
export function pruneCandidates(entries: WorktreeEntry[], opts: { root: string; activeDirs: string[] }): WorktreeEntry[] {
  if (!opts.root) return [];
  const goc = `${chuan(opts.root)}/`;
  const dangChay = new Set(opts.activeDirs.map(chuan));
  return entries.filter((e) => {
    const p = chuan(e.path);
    return p.startsWith(goc) && /^wt-tech-[a-z0-9-]+$/.test(path.basename(e.path)) && !!e.branch && WORKER_BRANCH_PATTERN.test(e.branch) && !dangChay.has(p);
  });
}

/**
 * Dọn cây cũ của worker. Mỗi ứng viên còn phải: SẠCH (`git status --porcelain` rỗng, kể cả tệp chưa theo dõi) và
 * KHÔNG có commit chưa nằm trên remote (`rev-list HEAD --not --remotes`). Không đạt ⇒ BỎ QUA và báo. Gỡ bằng
 * `git worktree remove` KHÔNG `--force`, không bao giờ xoá đệ quy bằng tay.
 */
export function pruneWorkerWorktrees(opts: { repo: string; root: string; activeDirs: string[]; env?: Record<string, string> }): { removed: string[]; skipped: string[] } {
  const removed: string[] = [];
  const skipped: string[] = [];
  if (!opts.root) return { removed, skipped: ["Không có TECH_WORKER_ROOT — không dọn gì (chạy tay)."] };
  const run = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: (opts.env ?? process.env) as NodeJS.ProcessEnv, windowsHide: true }).trim();
  try {
    run(opts.repo, "worktree", "prune");
  } catch {
    /* tiếp */
  }
  const ds = pruneCandidates(parseWorktreeList(run(opts.repo, "worktree", "list", "--porcelain")), opts);
  for (const c of ds) {
    if (!existsSync(c.path)) continue;
    try {
      if (run(c.path, "status", "--porcelain")) {
        skipped.push(`${path.basename(c.path)}: còn thay đổi chưa commit`);
        continue;
      }
      if (run(c.path, "rev-list", "HEAD", "--not", "--remotes")) {
        skipped.push(`${path.basename(c.path)}: còn commit chưa đẩy`);
        continue;
      }
      run(opts.repo, "worktree", "remove", c.path);
      removed.push(path.basename(c.path));
    } catch {
      skipped.push(`${path.basename(c.path)}: git từ chối gỡ`);
    }
  }
  return { removed, skipped };
}
