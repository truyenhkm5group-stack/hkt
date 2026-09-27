/**
 * ═══════════ ĐÁNH LẠI SỐ MIGRATION CỦA NHÁNH SAU KHI MAIN ĐÃ ĐI TRƯỚC ═══════════
 *
 * Nhiều phiên làm việc song song cùng lấy "số kế tiếp" (AGENTS.md mục 9). Nhánh nào vào `main` sau
 * phải đánh số lại migration CỦA MÌNH cho nối tiếp cuối sổ (mục 4). Làm tay thì đã hỏng ba kiểu có
 * thật trong hai ngày 25–26/09/2026: sổ bị SẮP LẠI làm đảo thứ tự ba mục của main; tìm-thay bằng
 * `\b0143\b` trượt tên đầy đủ `0143_company_os_…` (vì `_` là ký tự chữ); và mốc `when` không vượt mốc
 * lớn nhất của main — drizzle sẽ bỏ qua mục đó VĨNH VIỄN trên máy chủ.
 *
 * Công cụ này làm đúng một việc, và mặc định CHỈ CHẠY THỬ:
 *
 *   npm run migration:renumber                    # so với origin/main, in kế hoạch, không ghi gì
 *   npm run migration:renumber -- --apply         # ghi
 *   npm run migration:renumber -- --base <ref>    # so với ref khác
 *
 * LUẬT (hàm thuần `planRenumber`, có bài kiểm):
 *  · Sổ của BASE giữ NGUYÊN VĂN, đúng thứ tự của nó — không bao giờ sắp lại (sổ của main có đoạn
 *    không theo thứ tự idx và production đã áp đúng như thế).
 *  · Migration CỦA NHÁNH = tệp `drizzle/NNNN_*.sql` trên đĩa mà base không có. Chúng nối vào cuối,
 *    giữ thứ tự số cũ, số mới = số lớn nhất của base + 1, + 2, …
 *  · Mốc `when` của mỗi mục mới phải > mốc lớn nhất của base VÀ > mục trước nó: giữ mốc cũ nếu đã
 *    thoả, không thì lấy mục trước + 60 giây.
 *  · Sổ đang xung đột (còn dấu `<<<<<<<`) KHÔNG sao: sổ được dựng lại từ base + tệp trên đĩa, không
 *    đọc sổ đang hỏng.
 *  · Đổi tên thay TOÀN BỘ chuỗi tên đầy đủ trong các tệp đã vào kho (bài kiểm, tài liệu, chú thích).
 *    Số trần đứng một mình ("migration 0156") không tự thay — in ra cho người đọc lại.
 *
 * KHÔNG dùng cho migration ĐÃ vào base: tệp nào base có thì không bao giờ bị đổi tên (đổi tên một
 * migration đã áp là tạo mục mới và drizzle áp LẠI nó).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export type JournalEntry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
export type OwnMigration = { tag: string; when: number | null };
export type RenumberStep = { from: string; to: string; when: number; whenChanged: boolean };
export type RenumberPlan = { entries: JournalEntry[]; steps: RenumberStep[]; changed: boolean };

const TAG = /^(\d{4})_([a-z0-9_]+)$/;
const STEP_MS = 60_000;

/** Tách tên migration thành (số, phần chữ). Tên sai dạng ⇒ ném lỗi — không đoán. */
export function splitTag(tag: string): { num: number; name: string } {
  const m = TAG.exec(tag);
  if (!m) throw new Error(`tên migration sai dạng "${tag}" — phải là NNNN_ten_chu_thuong`);
  return { num: Number(m[1]), name: m[2] };
}

export function planRenumber(base: readonly JournalEntry[], own: readonly OwnMigration[]): RenumberPlan {
  const baseTags = new Set(base.map((e) => e.tag));
  const clash = own.filter((o) => baseTags.has(o.tag));
  if (clash.length) throw new Error(`migration đã có ở base không được đánh lại số: ${clash.map((o) => o.tag).join(", ")}`);
  const baseMaxIdx = base.reduce((m, e) => Math.max(m, e.idx), -1);
  const baseMaxWhen = base.reduce((m, e) => Math.max(m, e.when), 0);
  const ordered = [...own].sort((a, b) => splitTag(a.tag).num - splitTag(b.tag).num || a.tag.localeCompare(b.tag));

  const entries: JournalEntry[] = base.map((e) => ({ ...e }));
  const steps: RenumberStep[] = [];
  let prevWhen = baseMaxWhen;
  ordered.forEach((o, i) => {
    const idx = baseMaxIdx + 1 + i;
    const to = `${String(idx).padStart(4, "0")}_${splitTag(o.tag).name}`;
    const when = o.when !== null && o.when > prevWhen ? o.when : prevWhen + STEP_MS;
    prevWhen = when;
    entries.push({ idx, version: "7", when, tag: to, breakpoints: true });
    steps.push({ from: o.tag, to, when, whenChanged: when !== o.when });
  });
  return { entries, steps, changed: steps.some((s) => s.from !== s.to || s.whenChanged) };
}

/**
 * Thay tên cũ → tên mới trong một đoạn chữ, qua chỗ giữ tạm: đổi 0156→0157 và 0157→0158 cùng lượt
 * thì thay thẳng sẽ biến 0156 thành 0158.
 */
export function replaceTags(text: string, steps: readonly Pick<RenumberStep, "from" | "to">[]): string {
  const moving = steps.filter((s) => s.from !== s.to);
  let out = text;
  moving.forEach((s, i) => {
    out = out.split(s.from).join(`\u0000MIG${i}\u0000`);
  });
  moving.forEach((s, i) => {
    out = out.split(`\u0000MIG${i}\u0000`).join(s.to);
  });
  return out;
}

// ═══════════ PHẦN CHẠM ĐĨA / GIT ═══════════

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function readWorkingJournal(): Map<string, number> {
  const out = new Map<string, number>();
  try {
    const j = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: JournalEntry[] };
    for (const e of j.entries) out.set(e.tag, e.when);
  } catch {
    // Sổ đang xung đột / hỏng: bỏ qua, mốc của mục nhánh sẽ được cấp mới.
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const bi = args.indexOf("--base");
  const base = bi >= 0 ? args[bi + 1] : "origin/main";
  if (!base) throw new Error("--base cần một ref");
  if (!existsSync("drizzle/meta")) throw new Error("chạy ở gốc kho mã (không thấy drizzle/meta)");

  const baseJournal = JSON.parse(git(["show", `${base}:drizzle/meta/_journal.json`])) as { entries: JournalEntry[] } & Record<string, unknown>;
  const baseFiles = new Set(git(["ls-tree", "--name-only", `${base}`, "drizzle/"]).split("\n").map((l) => path.posix.basename(l.trim())));
  const workingWhen = readWorkingJournal();
  const own: OwnMigration[] = readdirSync("drizzle")
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && !baseFiles.has(f))
    .map((f) => {
      const tag = f.replace(/\.sql$/, "");
      return { tag, when: workingWhen.get(tag) ?? null };
    });

  console.log(`Base: ${base} · sổ base ${baseJournal.entries.length} mục · migration của nhánh: ${own.length}`);
  if (own.length === 0) {
    console.log("Nhánh không có migration riêng — không có gì để đánh lại số.");
    return;
  }
  const plan = planRenumber(baseJournal.entries, own);
  for (const s of plan.steps) console.log(`  ${s.from === s.to ? "giữ " : "đổi "} ${s.from} → ${s.to} · when ${s.when}${s.whenChanged ? " (mốc mới)" : ""}`);

  // Giữa một lượt rebase/merge đang xung đột, `ls-files` in tệp chưa gộp MỘT LẦN CHO MỖI GIAI ĐOẠN — gộp lại.
  const tracked = [...new Set(git(["ls-files"]).split("\n").map((l) => l.trim()).filter(Boolean))];
  const unmerged = [...new Set(git(["diff", "--name-only", "--diff-filter=U"]).split("\n").map((l) => l.trim()).filter(Boolean))].filter(
    (f) => f !== "drizzle/meta/_journal.json",
  );
  const textFiles = tracked.filter((f) => /\.(ts|tsx|mts|mjs|js|json|md|sql|yml|yaml)$/.test(f) && f !== "drizzle/meta/_journal.json");
  const touched = textFiles.filter((f) => {
    if (!existsSync(f)) return false;
    const src = readFileSync(f, "utf8");
    return plan.steps.some((s) => s.from !== s.to && src.includes(s.from));
  });
  if (touched.length) console.log(`  Tệp chứa tên cũ (sẽ thay tên đầy đủ): ${touched.join(", ")}`);

  const upgrade = existsSync("tests/migration-upgrade-path.test.ts") ? readFileSync("tests/migration-upgrade-path.test.ts", "utf8") : "";
  const chuaKhai = plan.steps.filter((s) => !upgrade.includes(`"${s.from}"`) && !upgrade.includes(`"${s.to}"`));
  if (chuaKhai.length) console.log(`  ⚠ Chưa có trong danh sách MOI của tests/migration-upgrade-path.test.ts: ${chuaKhai.map((s) => s.to).join(", ")}`);

  if (unmerged.length) {
    console.log(`  ⚠ Còn xung đột ngoài sổ migration (công cụ KHÔNG tự gỡ): ${unmerged.join(", ")} — gỡ tay trước (danh sách MOI thường là giữ CẢ HAI dòng), rồi chạy lại.`);
  }
  if (!plan.changed) {
    console.log("Số và mốc đã đúng — không cần đổi gì.");
    return;
  }
  if (apply && unmerged.length) {
    console.log("DỪNG — không ghi khi còn tệp xung đột: thay tên bên trong dấu xung đột là làm bẩn cả hai vế.");
    process.exitCode = 1;
    return;
  }
  if (!apply) {
    console.log("CHẠY THỬ — chưa ghi gì. Thêm --apply để ghi.");
    return;
  }

  for (const s of plan.steps) {
    if (s.from === s.to) continue;
    const from = `drizzle/${s.from}.sql`;
    const to = `drizzle/${s.to}.sql`;
    if (existsSync(to)) throw new Error(`${to} đã tồn tại — dừng, không ghi đè`);
    if (tracked.includes(from)) git(["mv", from, to]);
    else renameSync(from, to);
  }
  for (const f of touched) writeFileSync(f, replaceTags(readFileSync(f, "utf8"), plan.steps), "utf8");
  // Dòng đầu của chính tệp migration thường là "-- NNNN · …": đổi theo số mới.
  for (const s of plan.steps) {
    if (s.from === s.to) continue;
    const f = `drizzle/${s.to}.sql`;
    const src = readFileSync(f, "utf8");
    writeFileSync(f, src.replace(new RegExp(`^-- ${s.from.slice(0, 4)}\\b`), `-- ${s.to.slice(0, 4)}`), "utf8");
  }
  writeFileSync("drizzle/meta/_journal.json", `${JSON.stringify({ ...baseJournal, entries: plan.entries }, null, 2)}\n`, "utf8");

  const bare = plan.steps.filter((s) => s.from !== s.to).map((s) => s.from.slice(0, 4));
  const changedVsBase = git(["diff", "--name-only", base]).split("\n").map((l) => l.trim()).filter(Boolean);
  // Bỏ chính tệp này: chú thích của nó có số làm ví dụ, báo nó ra chỉ là tiếng ồn.
  const leftover = changedVsBase.filter((f) => f !== "scripts/migration-renumber.ts" && existsSync(f) && bare.some((n) => new RegExp(`(^|[^0-9])${n}([^0-9_]|$)`).test(readFileSync(f, "utf8"))));
  console.log("ĐÃ GHI. Việc còn lại của người:");
  console.log("  1. `git add drizzle tests docs` và gộp vào commit TẠO migration (commit đổi số đứng riêng làm repo-integrity đỏ giả).");
  console.log("  2. Chạy lại npm test (migration-journal · repo-integrity · migration-upgrade-path).");
  if (leftover.length) console.log(`  3. Số trần cũ (${bare.join(", ")}) còn nhắc trong: ${leftover.join(", ")} — đọc lại, có thể là số của main chứ không phải của mình.`);
}

const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("migration-renumber.ts"));
if (CHAY_THANG) {
  try {
    main();
  } catch (e) {
    console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
