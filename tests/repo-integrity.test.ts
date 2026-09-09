/**
 * ═══════════ TOÀN VẸN KHO MÃ: MÃ ĐÃ VÀO KHO KHÔNG ĐƯỢC TRỎ RA NGOÀI KHO ═══════════
 *
 * SỰ CỐ THẬT, LẶP LẠI BA LẦN trong ngày 09/09/2026 giữa hai phiên làm việc song song trên cùng
 * một cây làm việc:
 *
 *   tests/sync-fixtures.test.ts(23,44): error TS2307:
 *     Cannot find module './metric-shape-consistency.test'
 *
 * Một phiên `git add` tệp kiểm thử có dòng `import` trỏ tới tệp của phiên kia — tệp đó CÓ trên
 * đĩa nhưng CHƯA vào kho. Ở cây làm việc mọi thứ xanh, vì tệp nằm ngay đó. Chỉ bản checkout sạch
 * mới đỏ — tức là CI, tức là **chặn deploy của cả hai phiên**.
 *
 * Vì sao cần bài kiểm này khi `tsc` trên bản checkout sạch đã bắt được:
 * `tsc` chỉ bắt được SAU khi đã đẩy lên, ở máy chạy CI. Bài kiểm này đọc trạng thái ĐÃ VÀO KHO
 * (`git ls-files`) chứ không đọc đĩa, nên nó đỏ NGAY TRÊN MÁY người viết, trước khi đẩy — đúng
 * lúc còn sửa được rẻ.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/repo-integrity.test.ts
 */
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import path from "node:path";

/** Đuôi mà một đường dẫn import không đuôi có thể tương ứng, theo thứ tự TypeScript tra. */
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".json", "/index.ts", "/index.tsx", "/index.js"];

/**
 * Bắt cả `import ... from "x"`, `export ... from "x"`, `import("x")` và `require("x")`.
 *
 * Quan tâm hai dạng đường dẫn TRONG KHO:
 *   - tương đối: `./x`, `../x`
 *   - bí danh `@/x` → `./x` (tsconfig `paths`: `"@/*": ["./*"]`)
 *
 * Bí danh `@/` KHÔNG được bỏ qua: sự cố `@/components/nav-progress` (09/09/2026) đúng là dạng
 * này — bỏ qua nó thì bài kiểm mù đúng nửa số đường dẫn nội bộ của kho.
 * Gói ngoài (`react`, `drizzle-orm`…) thì do `node_modules` lo, không thuộc phạm vi bài kiểm.
 */
const IMPORT_RE = /(?:from|import|require)\s*\(?\s*["']((?:\.\.?|@)\/[^"']+)["']/g;

export function testRepoIntegrity() {
  const tracked = new Set(
    execSync("git ls-files", { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );

  const sources = [...tracked].filter((f) => /\.(ts|tsx)$/.test(f) && !f.endsWith(".d.ts"));
  assert.ok(sources.length > 0, "không tìm thấy tệp nguồn nào đã vào kho — lệnh git ls-files hỏng?");

  const broken: string[] = [];
  let checked = 0;

  for (const file of sources) {
    // Đọc từ KHO, không đọc từ đĩa: nội dung đang sửa dở của phiên khác không được ảnh hưởng
    // kết quả, và ngược lại bài kiểm này phải phản ánh đúng cái mà một bản checkout sạch thấy.
    let src: string;
    try {
      src = execSync(`git show HEAD:${file}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 * 1024 * 1024 });
    } catch {
      // Tệp đã `git add` nhưng chưa commit — chưa có ở HEAD. Bỏ qua, commit sau sẽ kiểm.
      continue;
    }

    const dir = path.posix.dirname(file);
    for (const match of src.matchAll(IMPORT_RE)) {
      const spec = match[1];
      checked += 1;
      // `@/x` neo ở gốc kho; `./x` và `../x` neo theo thư mục của tệp đang xét.
      const base = spec.startsWith("@/")
        ? path.posix.normalize(spec.slice(2))
        : path.posix.normalize(path.posix.join(dir, spec));
      const found = CANDIDATE_SUFFIXES.some((suffix) => tracked.has(`${base}${suffix}`));
      if (!found) {
        broken.push(`${file} → import "${spec}" (không có tệp nào đã vào kho khớp ${base}[.ts|.tsx|/index.ts])`);
      }
    }
  }

  assert.deepEqual(
    broken,
    [],
    "MÃ ĐÃ VÀO KHO TRỎ TỚI TỆP CHƯA VÀO KHO — bản checkout sạch sẽ đỏ tsc và deploy bị chặn:\n" + broken.map((b) => `  - ${b}`).join("\n"),
  );

  console.log(`✓ Toàn vẹn kho mã: ${sources.length} tệp nguồn · ${checked} import tương đối · mọi đích đến đều đã vào kho`);
}

/**
 * ═══════════ MIGRATION MỚI CHỈ ĐƯỢC NỐI VÀO CUỐI, KHÔNG CHÈN VÀO GIỮA ═══════════
 *
 * SỰ CỐ THẬT 09/09/2026 (mục F2 trong `docs/claude-final-erp-report.md`): drizzle chỉ áp
 * migration có mốc `when` MUỘN HƠN migration cuối cùng đã áp. Một mục được thêm vào sổ với mốc
 * CŨ HƠN một mục đã áp trên production sẽ bị **BỎ QUA VĨNH VIỄN** — tệp có, sổ có, kiểm thử
 * xanh (cơ sở dữ liệu kiểm thử dựng mới từ đầu nên áp tuần tự tất cả), nhưng production thiếu
 * cột và trang liên quan lỗi.
 *
 * Bài kiểm sổ migration hiện có chỉ đòi mốc TĂNG DẦN TRONG SỔ — điều đó vẫn đúng khi chèn một
 * mục vào giữa, nên nó KHÔNG bắt được lỗi này. Điều phải chặn là: mục MỚI XUẤT HIỆN ở commit
 * này phải có mốc muộn hơn MỌI mục đã có từ trước, vì mọi mục cũ đều có thể đã chạy trên
 * production rồi.
 *
 * Rủi ro đang hiện hữu lúc viết bài kiểm này: `0041_shipment_return_leg_index`
 * (when = 1788940601682) còn nằm ngoài kho, trong khi `0042_bank_ledger`
 * (when = 1788945576898) đã vào kho và đã áp lên production. Commit `0041` nguyên trạng là
 * tái diễn đúng sự cố trên — phải nâng mốc của nó lên sau `0042` trước khi commit.
 */
export function testMigrationAppendOnly() {
  const read = (rev: string) => {
    try {
      return JSON.parse(
        execSync(`git show ${rev}:drizzle/meta/_journal.json`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }),
      ) as { entries: { idx: number; tag: string; when: number }[] };
    } catch {
      return null;
    }
  };

  const current = read("HEAD");
  if (!current) {
    console.log("⊘ Bỏ qua kiểm sổ migration: không đọc được sổ ở HEAD");
    return;
  }
  const previous = read("HEAD~1");
  if (!previous) {
    // Kho vừa được clone nông (fetch-depth: 1) hoặc đây là commit đầu tiên — không có gì để so.
    console.log("⊘ Bỏ qua kiểm 'chỉ nối vào cuối': không có commit trước để đối chiếu");
    return;
  }

  const before = new Set(previous.entries.map((e) => e.tag));
  const maxWhenBefore = Math.max(...previous.entries.map((e) => e.when));
  const added = current.entries.filter((e) => !before.has(e.tag));

  for (const e of added) {
    assert.ok(
      e.when > maxWhenBefore,
      `migration MỚI "${e.tag}" có mốc ${e.when} KHÔNG muộn hơn mốc lớn nhất đã có (${maxWhenBefore}). ` +
        "Những mục cũ có thể đã chạy trên production; drizzle chỉ áp mốc muộn hơn mốc cuối đã áp, " +
        "nên mục này sẽ BỊ BỎ QUA VĨNH VIỄN trên máy chủ. Sinh lại migration hoặc nâng mốc lên sau mốc lớn nhất.",
    );
  }

  console.log(
    `✓ Sổ migration chỉ nối vào cuối: ${added.length} mục mới ở commit này` +
      (added.length ? ` (${added.map((e) => e.tag).join(", ")}) đều muộn hơn mốc lớn nhất trước đó` : ""),
  );
}

// Chạy được độc lập (CI gọi thẳng tệp này), và cũng export để bộ kiểm thử chung dùng lại.
if (process.argv[1] && /repo-integrity\.test\.ts$/.test(process.argv[1])) {
  try {
    testRepoIntegrity();
    testMigrationAppendOnly();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
