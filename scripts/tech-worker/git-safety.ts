import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { WORKER_BRANCH_PATTERN } from "@/lib/constants/tech-worker";

/**
 * ═══════════ AN TOÀN GIT CỦA WORKER — DỌN CÂY CŨ ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Tách khỏi `scripts/tech-worker.ts` (tệp đó chạy `main()` khi import) để bài
 * kiểm chạy THẬT bộ dọn cây trên kho git tạm.
 *
 * Worker KHÔNG đẩy nhánh nữa (review bảo mật PR #631, lượt 2): mọi credential ghi GitHub xuống tới máy worker đều lấy
 * trộm được bởi mã agent chạy trong cổng, nên máy chủ tự ghi nhánh từ bộ thay đổi worker nộp. Không còn hàm đẩy nào ở
 * đây — đừng thêm lại.
 */

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
