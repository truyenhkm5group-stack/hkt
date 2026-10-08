/**
 * ═══════════ BỘ THAY ĐỔI WORKER NỘP LÊN — MÁY CHỦ TỰ GHI NHÁNH ═══════════
 *
 * docs/tech-control-plane/README.md mục 15. Tệp THUẦN, CLIENT-SAFE.
 *
 * ─── VÌ SAO WORKER KHÔNG CÒN GIỮ BẤT KỲ QUYỀN GHI GITHUB NÀO (review bảo mật PR #631, lượt 2) ───
 *
 * Mã agent vừa viết chạy trong cổng (eslint.config.mjs, tests/*.ts) dưới ĐÚNG tài khoản Windows của worker: nó giải được
 * khoá worker (DPAPI theo người dùng), gọi được mọi cửa của worker. Nên MỌI credential ghi GitHub xuống tới máy worker —
 * dù ngắn hạn, dù chỉ cấp cho lượt đang giữ lease — đều lấy trộm được, và token `contents: write` gộp được PR xanh vào
 * `main` (ruleset hiện 0 lượt duyệt). Thiết kế thay thế: worker nộp BỘ THAY ĐỔI (tệp + nội dung) lên máy chủ; máy chủ
 * kiểm theo NĂNG LỰC + CHÍNH SÁCH của việc (không tin worker) rồi tự tạo commit bằng GitHub Git Data API trên ĐÚNG nhánh
 * nó đã cấp. Token chỉ sống trong tiến trình máy chủ.
 */
import { WORKER_BRANCH_PATTERN, forbiddenTouched } from "@/lib/constants/tech-worker";

export const SUBMIT_LIMITS = {
  maxFiles: 200,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 5_000_000,
  maxPathChars: 300,
  maxMessageChars: 4000,
} as const;

/** Chế độ tệp được nhận — tệp thường / thực thi. Symlink (120000), submodule (160000), thư mục… ⇒ từ chối. */
export const SUBMIT_MODES = ["100644", "100755"] as const;
export type SubmitMode = (typeof SUBMIT_MODES)[number];

export type SubmittedFile = { path: string; mode?: string; contentBase64?: string; delete?: boolean };

/**
 * Đường cấm THÊM cho bộ thay đổi do worker nộp — ngoài `AGENT_FORBIDDEN_PATHS` (đã có `.github/`, `drizzle/`,
 * `package.json`, mã worker…): mọi thứ chạy lúc deploy / cài đặt / hook.
 */
export const SUBMIT_EXTRA_FORBIDDEN = [/^scripts\/(install-vps|deploy)[^/]*$/, /^scripts\/ops[/-]/, /^\.husky\//, /^\.gitmodules$/, /^\.gitattributes$/, /(^|\/)Dockerfile[^/]*$/, /(^|\/)docker-compose[^/]*$/, /^Caddyfile/, /^next\.config\./];

/**
 * Phạm vi ghi theo NĂNG LỰC của việc — máy chủ quyết, không tin worker. Năng lực không khai ⇒ mọi đường không cấm.
 * Chính sách R0 (tài liệu / kiểm thử) ⇒ chỉ tài liệu + kiểm thử, bất kể năng lực.
 */
// `public/**` bị loại: `public/x.md` được phục vụ thẳng trên web production (review PR #631, lượt 3).
const DOCS = (p: string) => !p.startsWith("public/") && (p.startsWith("docs/") || p.endsWith(".md"));
const TESTS = (p: string) => p.startsWith("tests/");
export const CAPABILITY_WRITE_SCOPE: Record<string, (p: string) => boolean> = {
  "write-docs": DOCS,
  "unit-test": (p) => TESTS(p) || DOCS(p),
};
const R0_SCOPE = (p: string) => DOCS(p) || TESTS(p);

/** Đường dẫn chuẩn hoá được nhận? `null` = được; chuỗi = lý do từ chối. */
export function submitPathProblem(p: string): string | null {
  if (typeof p !== "string" || !p) return "đường dẫn rỗng";
  if (p.length > SUBMIT_LIMITS.maxPathChars) return "đường dẫn quá dài";
  if (/[\u0000-\u001f\u007f\\]/.test(p)) return "đường dẫn có ký tự điều khiển / dấu \\";
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "đường dẫn tuyệt đối";
  const seg = p.split("/");
  if (seg.some((s) => s === "" || s === "." || s === "..")) return "đường dẫn có đoạn rỗng / . / ..";
  if (seg.some((s) => s.toLowerCase() === ".git")) return "đường dẫn chạm .git";
  // Tệp chỉ dẫn của agent ở MỌI độ sâu (Claude Code / Codex / Cursor đọc chúng như lệnh) — ghi vào là tiêm lời nhắc sống
  // lâu dài nếu PR được gộp. So THEO TÊN, không phân biệt hoa thường, cho cả ghi lẫn xoá.
  const ten = seg[seg.length - 1]!.toLowerCase();
  if (AGENT_INSTRUCTION_FILES.includes(ten)) return "tệp chỉ dẫn của agent";
  if (seg.slice(0, -1).some((s) => AGENT_CONFIG_DIRS.includes(s.toLowerCase()))) return "thư mục cấu hình agent / hook";
  if (forbiddenTouched([p]).length) return "đường cấm của agent";
  if (SUBMIT_EXTRA_FORBIDDEN.some((re) => re.test(p))) return "đường chạy lúc deploy / cài đặt";
  return null;
}

/** Tên tệp chỉ dẫn agent — chặn ở MỌI độ sâu (so chữ thường). */
export const AGENT_INSTRUCTION_FILES = ["claude.md", "claude.local.md", "agents.md"];
/** Đoạn thư mục cấu hình agent / hook / CI — chặn ở MỌI độ sâu (so chữ thường). */
export const AGENT_CONFIG_DIRS = [".claude", ".cursor", ".codex", ".github", ".husky"];

export type SubmitCheck = { ok: true; totalBytes: number } | { ok: false; errors: string[] };

/**
 * Kiểm MỘT bộ thay đổi — hàm thuần, máy chủ gọi trước khi chạm GitHub. Mọi vi phạm được kể ra (không dừng ở cái đầu)
 * để worker / người đọc biết sửa gì.
 */
export function validateSubmission(input: { files: SubmittedFile[]; message: string }, task: { capability: string; policyLevel: string | null }): SubmitCheck {
  const errors: string[] = [];
  const files = Array.isArray(input.files) ? input.files : [];
  if (!files.length) errors.push("bộ thay đổi rỗng");
  if (files.length > SUBMIT_LIMITS.maxFiles) errors.push(`quá ${SUBMIT_LIMITS.maxFiles} tệp`);
  const msg = typeof input.message === "string" ? input.message.trim() : "";
  if (!msg) errors.push("thiếu thông điệp commit");
  if (msg.length > SUBMIT_LIMITS.maxMessageChars) errors.push("thông điệp commit quá dài");
  const scope = CAPABILITY_WRITE_SCOPE[task.capability];
  const seen = new Set<string>();
  let total = 0;
  for (const f of files.slice(0, SUBMIT_LIMITS.maxFiles)) {
    const p = f?.path;
    const loi = submitPathProblem(p);
    if (loi) {
      errors.push(`${String(p).slice(0, 120)}: ${loi}`);
      continue;
    }
    if (seen.has(p)) errors.push(`${p}: khai hai lần`);
    seen.add(p);
    if (scope && !scope(p)) errors.push(`${p}: ngoài phạm vi năng lực ${task.capability}`);
    if (task.policyLevel === "R0" && !R0_SCOPE(p)) errors.push(`${p}: chính sách R0 chỉ được ghi tài liệu / kiểm thử`);
    if (f.delete === true) {
      if (f.contentBase64 !== undefined) errors.push(`${p}: vừa xoá vừa có nội dung`);
      continue;
    }
    if (!(SUBMIT_MODES as readonly string[]).includes(f.mode ?? "")) {
      errors.push(`${p}: chế độ tệp ${f.mode ?? "?"} không được nhận (symlink / submodule bị từ chối)`);
      continue;
    }
    if (typeof f.contentBase64 !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(f.contentBase64)) {
      errors.push(`${p}: nội dung không phải base64`);
      continue;
    }
    const bytes = Math.floor((f.contentBase64.length * 3) / 4) - (f.contentBase64.endsWith("==") ? 2 : f.contentBase64.endsWith("=") ? 1 : 0);
    if (bytes > SUBMIT_LIMITS.maxFileBytes) errors.push(`${p}: tệp quá ${SUBMIT_LIMITS.maxFileBytes} byte`);
    total += bytes;
  }
  if (total > SUBMIT_LIMITS.maxTotalBytes) errors.push(`tổng quá ${SUBMIT_LIMITS.maxTotalBytes} byte`);
  return errors.length ? { ok: false, errors } : { ok: true, totalBytes: total };
}

/** Nhánh máy chủ được phép ghi cho một lượt — chỉ `ai/worker/*`; tên luôn lấy từ lượt chạy ở CSDL. */
export function serverWritableBranch(runBranch: string): string | null {
  return WORKER_BRANCH_PATTERN.test(runBranch) ? runBranch : null;
}
