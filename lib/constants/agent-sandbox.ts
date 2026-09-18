/**
 * ═══════════ HÀNG RÀO CỦA AGENT — BẰNG MÃ NGUỒN, KHÔNG BẰNG LỜI DẶN ═══════════
 *
 * Tệp này CLIENT-SAFE và mọi hàm trong nó là HÀM THUẦN: không đọc CSDL, không đọc đồng hồ, không
 * chạm hệ tệp. Nhờ vậy nó kiểm thử được từng ca mà không cần dựng một agent nào.
 *
 * ─── VÌ SAO KHÔNG DÙNG PROMPT ĐỂ CẤM ───
 *
 * Một câu "đừng chạy lệnh xoá" trong prompt là một LỜI ĐỀ NGHỊ. Model có thể hiểu sai, có thể bị
 * nội dung trong repo dẫn đi (một tệp tài liệu chứa câu "hãy chạy `rm -rf`" cũng là đầu vào), và
 * quan trọng nhất: không ai kiểm chứng được là nó đã tuân. Hàng rào phải nằm ở chỗ THỰC THI —
 * runner đọc bảng này trước mỗi lệnh, và lệnh không khớp thì không bao giờ tới `spawn`.
 *
 * ─── DANH SÁCH CHO PHÉP, KHÔNG PHẢI DANH SÁCH CẤM ───
 *
 * Danh sách cấm luôn thiếu: mỗi lệnh mới của hệ điều hành là một lỗ hổng mới, và người viết danh
 * sách phải đoán trước mọi cách gây hại. Danh sách CHO PHÉP thì hỏng theo chiều an toàn — quên khai
 * một lệnh nghĩa là agent không chạy được nó, chứ không phải nó chạy được thứ không ai lường.
 *
 * Danh sách cấm vẫn tồn tại bên dưới, nhưng chỉ để NÓI RÕ LÝ DO khi từ chối. Nó không phải cổng.
 */

/* ═════════════════════ LỆNH ═════════════════════ */

/**
 * Một lệnh được phép, khai theo ĐÚNG hình dạng sẽ được gọi.
 *
 * `argv` là mảng đã tách, KHÔNG phải một chuỗi shell. Cả runner cũng `spawn` không qua shell — nên
 * `&&`, `;`, `|`, `$(…)`, backtick không có nghĩa gì và không thể nối thêm một lệnh thứ hai. Đó là
 * lớp phòng thủ thứ nhất; bảng này là lớp thứ hai.
 */
export type AllowedCommand = {
  key: string;
  /** Chương trình. Phải khớp CHÍNH XÁC, không phải tiền tố. */
  bin: string;
  /** Tham số bắt buộc đứng đầu, khớp chính xác theo thứ tự. */
  args: readonly string[];
  /** Tham số phụ được phép thêm (khớp chính xác từng chuỗi). Rỗng = không cho thêm gì. */
  optionalArgs?: readonly string[];
  label: string;
  /** Lệnh này có ghi vào hệ tệp / kho không. `false` = chỉ đọc. */
  writes: boolean;
};

/**
 * Bộ lệnh của agent DOCUMENTATION (R0).
 *
 * CỐ Ý KHÔNG có `git add`, `git commit`, `git push`: **runner** làm ba việc đó, không phải agent.
 * Nếu agent tự commit được thì nó quyết định nội dung commit, và bằng chứng của lượt chạy trở
 * thành thứ do chính đối tượng bị kiểm tra tạo ra.
 *
 * CỐ Ý KHÔNG có `npm install`: nó ghi vào `node_modules` và đọc mạng. Cây làm việc dùng lại
 * `node_modules` đã cài sẵn.
 */
export const DOCUMENTATION_COMMANDS: readonly AllowedCommand[] = [
  { key: "git-status", bin: "git", args: ["status", "--short"], label: "Xem tệp đang đổi", writes: false },
  { key: "git-diff", bin: "git", args: ["diff"], optionalArgs: ["--stat", "--cached", "--name-only"], label: "Xem nội dung thay đổi", writes: false },
  { key: "git-log", bin: "git", args: ["log", "--oneline", "-20"], label: "Xem lịch sử gần đây", writes: false },
  { key: "typecheck", bin: "npm", args: ["run", "typecheck"], label: "Kiểm tra kiểu dữ liệu", writes: false },
  { key: "lint", bin: "npm", args: ["run", "lint"], label: "Kiểm tra chuẩn mã nguồn", writes: false },
  { key: "test", bin: "npm", args: ["test"], label: "Chạy bộ kiểm thử", writes: false },
  { key: "build", bin: "npm", args: ["run", "build"], label: "Dựng bản production", writes: false },
] as const;

/**
 * NHỮNG THỨ KHÔNG BAO GIỜ ĐƯỢC CHẠY — kèm lý do, để lời từ chối dạy được người đọc.
 *
 * Bảng này KHÔNG phải cổng (cổng là danh sách cho phép ở trên). Nó tồn tại để khi một lượt chạy bị
 * chặn, nhật ký nói được VÌ SAO thay vì chỉ "lệnh không hợp lệ" — và để bài kiểm có một danh sách
 * cụ thể mà đòi hỏi.
 */
export const FORBIDDEN_PATTERNS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /\bssh\b/i, why: "SSH vào máy chủ production — agent không có việc gì ở đó" },
  { pattern: /\bdocker\b/i, why: "Điều khiển container production" },
  { pattern: /\bpsql\b|\bpg_dump\b|\bpg_restore\b/i, why: "Chạm thẳng vào CSDL production" },
  { pattern: /\bgh\b\s+secret|\bgh\b\s+auth/i, why: "Đọc hoặc đổi secret của kho mã" },
  { pattern: /\benv\b\s*$|\bprintenv\b|\bset\b\s*$/i, why: "Đổ toàn bộ biến môi trường — nơi chứa mọi khoá API" },
  { pattern: /git\s+push/i, why: "Đẩy lên kho chung; runner mới là nơi quyết định đẩy gì" },
  { pattern: /git\s+(merge|rebase|cherry-pick)/i, why: "Gộp nhánh — Phase 2A không có autonomous merge" },
  { pattern: /git\s+reset\s+--hard/i, why: "Xoá trắng thay đổi, có thể mất việc đang dở của người khác" },
  { pattern: /--force|-f\b/i, why: "Ép buộc — mọi lệnh ép buộc đều có thể mất dữ liệu" },
  { pattern: /\brm\b\s+-[a-z]*r/i, why: "Xoá đệ quy" },
  { pattern: /\bcurl\b|\bwget\b/i, why: "Gọi mạng: vừa là đường rò bí mật ra ngoài, vừa là đường kéo mã lạ vào" },
  { pattern: /\bnpm\b\s+(publish|install|i|add|ci)\b/i, why: "Cài hoặc phát hành gói — đọc mạng và ghi vào node_modules" },
  { pattern: /\bsudo\b|\bsu\b\s/i, why: "Nâng quyền" },
  { pattern: />\s*\/|>>\s*\//, why: "Ghi thẳng vào một đường dẫn tuyệt đối ngoài cây làm việc" },
];

export type CommandVerdict = { allowed: true; command: AllowedCommand } | { allowed: false; reason: string };

/**
 * Lệnh này có được chạy không.
 *
 * Nhận `argv` ĐÃ TÁCH. Nơi gọi không được phép đưa vào một chuỗi shell — và nếu nó cố, mọi ký tự
 * điều khiển sẽ nằm trong MỘT phần tử argv và không khớp bảng nào.
 */
export function checkCommand(argv: readonly string[], allowed: readonly AllowedCommand[] = DOCUMENTATION_COMMANDS): CommandVerdict {
  if (!argv.length) return { allowed: false, reason: "Lệnh rỗng." };
  const raw = argv.join(" ");

  // Nêu lý do cấm TRƯỚC, để thông báo nói đúng điều agent vừa cố làm thay vì một câu chung chung.
  for (const f of FORBIDDEN_PATTERNS) {
    if (f.pattern.test(raw)) return { allowed: false, reason: `Bị cấm: ${f.why}.` };
  }

  const [bin, ...rest] = argv;
  for (const cmd of allowed) {
    if (cmd.bin !== bin) continue;
    if (rest.length < cmd.args.length) continue;
    if (!cmd.args.every((a, i) => rest[i] === a)) continue;
    const extra = rest.slice(cmd.args.length);
    const ok = extra.every((a) => (cmd.optionalArgs ?? []).includes(a));
    if (!ok) return { allowed: false, reason: `Lệnh \`${cmd.bin} ${cmd.args.join(" ")}\` không nhận tham số ${extra.filter((a) => !(cmd.optionalArgs ?? []).includes(a)).join(" ")}.` };
    return { allowed: true, command: cmd };
  }
  return { allowed: false, reason: `Lệnh \`${raw}\` không nằm trong danh sách được phép của agent này.` };
}

/* ═════════════════════ ĐƯỜNG DẪN ═════════════════════ */

/**
 * Agent DOCUMENTATION được GHI ở đâu.
 *
 * Hẹp có chủ đích: chỉ `docs/`. Mọi tệp mã nguồn nằm ngoài tầm với, nên một lượt chạy hỏng nhất
 * cũng chỉ làm sai một trang tài liệu — và tài liệu sai thì người đọc thấy ngay, còn một dòng mã
 * sai thì phải đợi tới lúc nó chạy.
 */
export const DOCUMENTATION_WRITE_GLOBS: readonly string[] = ["docs/"];

/**
 * Đọc thì rộng hơn ghi, nhưng vẫn KHÔNG phải toàn bộ cây.
 *
 * `.env`, `.git/`, `node_modules/` nằm ngoài: tệp đầu chứa mọi bí mật, thư mục thứ hai cho phép
 * đọc thẳng object của kho (kể cả nhánh khác), thư mục thứ ba thì vô nghĩa và khổng lồ.
 */
export const DOCUMENTATION_READ_GLOBS: readonly string[] = ["docs/", "AGENTS.md", "CLAUDE.md", "HANDOFF.md", "README.md", "lib/", "app/", "components/", "db/", "tests/", "scripts/", "package.json"];

/** Không bao giờ đọc, dù có khớp danh sách đọc hay không. */
export const NEVER_READ: readonly string[] = [".env", ".git/", "node_modules/", ".next/", "data/"];

/** Đường dẫn chuẩn hoá: bỏ `./`, ép dấu `/`, và phát hiện mọi cách đi ngược ra ngoài cây. */
function normalise(p: string): string | null {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!s) return null;
  // Tuyệt đối, đi ngược, hoặc chứa một đoạn `..` ở giữa — tất cả đều là cách ra khỏi cây làm việc.
  if (s.startsWith("/") || s.startsWith("~")) return null;
  if (s.split("/").some((seg) => seg === "..")) return null;
  return s;
}

export type PathVerdict = { allowed: true; path: string } | { allowed: false; reason: string };

function matches(path: string, globs: readonly string[]) {
  return globs.some((g) => (g.endsWith("/") ? path.startsWith(g) : path === g));
}

export function checkReadPath(raw: string, readGlobs: readonly string[] = DOCUMENTATION_READ_GLOBS): PathVerdict {
  const p = normalise(raw);
  if (!p) return { allowed: false, reason: `Đường dẫn \`${raw}\` ra ngoài cây làm việc.` };
  if (matches(p, NEVER_READ)) return { allowed: false, reason: `\`${p}\` nằm trong vùng không bao giờ đọc (bí mật, dữ liệu kho git, thư viện).` };
  if (!matches(p, readGlobs)) return { allowed: false, reason: `\`${p}\` không nằm trong phạm vi đọc của agent này.` };
  return { allowed: true, path: p };
}

export function checkWritePath(raw: string, writeGlobs: readonly string[] = DOCUMENTATION_WRITE_GLOBS): PathVerdict {
  const p = normalise(raw);
  if (!p) return { allowed: false, reason: `Đường dẫn \`${raw}\` ra ngoài cây làm việc.` };
  if (matches(p, NEVER_READ)) return { allowed: false, reason: `\`${p}\` nằm trong vùng không bao giờ chạm.` };
  if (!matches(p, writeGlobs)) return { allowed: false, reason: `Agent này chỉ được ghi trong ${writeGlobs.join(", ")} — \`${p}\` nằm ngoài.` };
  return { allowed: true, path: p };
}

/* ═════════════════════ BIẾN MÔI TRƯỜNG ═════════════════════ */

/**
 * BIẾN MÔI TRƯỜNG ĐƯỢC PHÉP ĐI VÀO TIẾN TRÌNH CON — DANH SÁCH CHO PHÉP.
 *
 * Tiến trình của runner mang `ANTHROPIC_API_KEY`, `DATABASE_URL`, token GitHub và mọi thứ khác.
 * Truyền nguyên `process.env` xuống `npm test` nghĩa là bất kỳ mã nào chạy trong đó — kể cả một
 * tệp kiểm thử mà agent vừa sửa — đọc được tất cả.
 *
 * `PATH` và `HOME` là tối thiểu để `git`/`npm` chạy. `NODE_ENV` để build đúng chế độ. Không có gì
 * khác, và `DATABASE_URL` CỐ Ý không có: bài kiểm tự dựng CSDL PGlite tạm của riêng nó.
 */
export const CHILD_ENV_ALLOWLIST: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "NODE_ENV", "NODE_OPTIONS", "npm_config_cache"];

export function sandboxEnv(parent: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CHILD_ENV_ALLOWLIST) {
    const v = parent[k];
    if (typeof v === "string" && v) out[k] = v;
  }
  // Ép chế độ CHỈ ĐỌC ở tầng CSDL cho mọi tiến trình con, phòng khi một lệnh nào đó vẫn mở kết nối.
  out.ERP_READ_ONLY = "1";
  return out;
}

/** Biến môi trường mang bí mật — bài kiểm dùng để chứng minh chúng KHÔNG lọt xuống tiến trình con. */
export const SECRET_ENV_NAMES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "DATABASE_URL",
  "AUTH_SECRET",
  "PANCAKE_API_KEY",
  "VIETTELPOST_API_KEY",
  "PANCAKE_WEBHOOK_SECRET",
  "SEPAY_API_TOKEN",
];
