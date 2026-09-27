import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * TOÀN VẸN SỔ MIGRATION.
 *
 * Sự cố có thật, phát hiện 09/09/2026: hai phiên làm việc song song cùng sinh migration và cùng lấy
 * số 0032 — `0032_webhook_dedupe` và `0032_marketing_ideas`. Sổ migration có hai mục cùng `idx`.
 *
 * Vì sao lần này KHÔNG gây sự cố: drizzle áp migration theo THỨ TỰ MẢNG trong sổ và theo dõi bằng
 * băm nội dung, không theo số hiệu. Nên cả hai vẫn áp đúng một lần.
 *
 * Vì sao vẫn phải chặn: lần sinh migration tiếp theo sẽ lại lấy số kế tiếp của số lớn nhất, và
 * người đọc `drizzle/` không còn suy được thứ tự áp từ tên file. Một kho mã mà thứ tự migration
 * không đọc được là kho mã mà người sửa sau phải đoán.
 *
 * CỐ Ý KHÔNG tự đổi tên migration đã áp trên production: tên file nằm trong sổ, đổi tên là tạo ra
 * một mục mới và drizzle sẽ áp LẠI nó. Việc cần làm là chặn từ lần sau, không phải viết lại quá khứ.
 */
export function testMigrationJournal() {
  /**
   * KIỂM TRẠNG THÁI ĐÃ VÀO KHO, KHÔNG PHẢI CÂY LÀM VIỆC.
   *
   * Kho mã này có lúc hai phiên làm việc song song trên cùng thư mục. File `.sql` chưa `git add`
   * là việc ĐANG DỞ của người khác — nó bị tạo, đổi tên và xoá liên tục, và bắt lỗi theo nó chỉ làm
   * hỏng bộ kiểm thử của người thứ ba mà không sửa được gì.
   *
   * Điều thật sự phải chặn là trạng thái ĐÃ VÀO KHO: file có mà sổ không có (sẽ không bao giờ được
   * áp), hoặc sổ có mà file không có (migrator sẽ hỏng ngay lúc khởi động).
   */
  const fromHead = (path: string) => {
    try {
      return execSync(`git show HEAD:${path}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };

  const journalRaw = fromHead("drizzle/meta/_journal.json") ?? readFileSync("drizzle/meta/_journal.json", "utf8");
  const journal = JSON.parse(journalRaw) as { entries: { idx: number; tag: string; when: number }[] };

  const files = execSync("git ls-files drizzle", { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.endsWith(".sql"))
    .map((l) => l.slice("drizzle/".length));

  // ───────── 1. Mọi mục trong sổ phải có file thật ─────────
  for (const e of journal.entries) {
    assert.ok(files.includes(`${e.tag}.sql`), `sổ migration trỏ tới ${e.tag}.sql nhưng kho không có file đó — migrator sẽ hỏng ngay lúc khởi động`);
  }

  // ───────── 2. Mọi file phải có mục trong sổ ─────────
  // File nằm trong kho mà không có trong sổ thì KHÔNG BAO GIỜ được áp — và người viết nó sẽ tưởng
  // là đã áp.
  for (const f of files) {
    const tag = f.replace(/\.sql$/, "");
    assert.ok(
      journal.entries.some((e) => e.tag === tag),
      `${f} đã vào kho nhưng không có trong sổ migration nên sẽ KHÔNG BAO GIỜ được áp`,
    );
  }

  // ───────── 3a. Mốc thời gian quyết định migration có được áp hay không ─────────
  // SỰ CỐ THẬT 09/09/2026: drizzle chỉ áp migration có mốc MUỘN HƠN migration cuối đã áp. Một mục
  // được thêm vào giữa sổ với mốc cũ hơn sẽ bị BỎ QUA VĨNH VIỄN — file có, sổ có, kiểm thử xanh
  // (vì cơ sở dữ liệu kiểm thử dựng mới từ đầu), nhưng production thiếu cột và trang liên quan lỗi.
  //
  // Nên mốc phải TĂNG NGHIÊM NGẶT, không chỉ không giảm.
  for (let i = 1; i < journal.entries.length; i += 1) {
    assert.ok(
      journal.entries[i].when > journal.entries[i - 1].when,
      `mốc migration phải TĂNG NGHIÊM NGẶT — ${journal.entries[i].tag} (${journal.entries[i].when}) không muộn hơn ${journal.entries[i - 1].tag} (${journal.entries[i - 1].when}). Mục có mốc cũ hơn sẽ bị bỏ qua vĩnh viễn trên cơ sở dữ liệu đã chạy. Sửa bằng: "npm run migration:renumber" (chạy thử) rồi "-- --apply".`,
    );
  }

  // ───────── 3. Thứ tự áp phải tăng dần theo thời gian ─────────
  // Drizzle áp theo thứ tự mảng; nếu `when` không tăng thì thứ tự đọc được của con người khác với
  // thứ tự máy chạy.
  for (let i = 1; i < journal.entries.length; i += 1) {
    assert.ok(
      journal.entries[i].when >= journal.entries[i - 1].when,
      `sổ migration không xếp theo thời gian: ${journal.entries[i - 1].tag} → ${journal.entries[i].tag}`,
    );
  }

  // ───────── 4. Hình dạng sổ: số hiệu · tên · liên tục (Phase 3.1 — `journalProblems`, có kiểm đột biến) ─────────
  // Trước 3.1 phần này chỉ CẢNH BÁO và cho phép một số hiệu trùng (idx 32, 09/09/2026). Đo sổ thật 28/09/2026:
  // KHÔNG còn số hiệu trùng nào, không tên trùng — nên nay trùng là ĐỎ, và thêm hai luật sổ thật đã giữ được từ
  // 0045 trở đi (tiền tố tên = idx, idx liên tục) với đúng một vùng lịch sử lệch được ghim tên (LICH_SU_LECH_SO).
  tuKiemJournalProblems();
  const problems = journalProblems(journal.entries, files);
  assert.deepEqual(problems, [], `SỔ MIGRATION SAI HÌNH DẠNG:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  console.log(
    `✓ Sổ migration: ${journal.entries.length} migration, mọi mục có ĐÚNG MỘT file và mọi file có ĐÚNG MỘT mục · thứ tự áp tăng nghiêm ngặt · 0 số hiệu / tên trùng · tiền tố = idx và liên tục (trừ ${LICH_SU_LECH_SO.length} mục lịch sử đã ghim) · bộ kiểm hình dạng tự kiểm đột biến 8 kiểu hỏng`,
  );
}

export type JournalEntryShape = { idx: number; tag: string; when: number };

/**
 * VÙNG LỆCH LỊCH SỬ — sáu migration 0038–0044 đã áp trên production với số hiệu KHÔNG khớp tên / KHÔNG liên tục
 * (đo sổ thật 28/09/2026: idx 38 không tồn tại; `0038_fb_ads_post_link` mang idx 40; thứ tự mảng 43 → 42 → 44 → 41).
 * Đổi tên hay đánh lại số chúng bây giờ là tạo mục mới và drizzle áp LẠI (mục 4 AGENTS.md) — nên chúng được GHIM
 * TÊN ở đây và chỉ chúng được miễn hai luật "tiền tố = idx" và "idx liên tục". Danh sách này KHÔNG được dài thêm:
 * migration mới lệch số thì sửa bằng `npm run migration:renumber`, không thêm vào đây.
 */
export const LICH_SU_LECH_SO: readonly string[] = [
  "0039_marketing_ideas",
  "0038_fb_ads_post_link",
  "0043_return_inspections",
  "0042_bank_ledger",
  "0044_cost_authority",
  "0041_shipment_return_leg_index",
];

const TAG_SHAPE = /^(\d{4})_[a-z0-9_]+$/;

/**
 * Mọi điều sai về HÌNH DẠNG của sổ migration — hàm THUẦN (sổ + danh sách tệp `.sql` đã vào kho), mỗi điều một câu.
 *  a. số hiệu trùng · tên trùng;
 *  b. tên sai dạng `NNNN_ten`; tiền tố tên ≠ idx; idx không liên tục (mục sau = mục trước + 1, mục đầu = 0) — trừ
 *     vùng lịch sử đã ghim;
 *  c. mỗi tệp `.sql` có ĐÚNG MỘT mục và mỗi mục có ĐÚNG MỘT tệp;
 *  d. `when` tăng NGHIÊM NGẶT theo thứ tự áp (thứ tự mảng — drizzle bỏ qua VĨNH VIỄN mục có mốc không muộn hơn mục
 *     cuối đã áp). Ngoài vùng lịch sử, thứ tự mảng trùng thứ tự idx (luật b), nên đây cũng là "tăng theo idx".
 */
export function journalProblems(entries: readonly JournalEntryShape[], files: readonly string[]): string[] {
  const out: string[] = [];
  const hint = ' Sửa bằng: "npm run migration:renumber" (chạy thử) rồi "-- --apply" — KHÔNG sửa mục đã áp.';
  const count = <T,>(xs: readonly T[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<T, number>());
  for (const [idx, n] of count(entries.map((e) => e.idx))) if (n > 1) out.push(`số hiệu ${idx} dùng ${n} lần: ${entries.filter((e) => e.idx === idx).map((e) => e.tag).join(" + ")}.${hint}`);
  for (const [tag, n] of count(entries.map((e) => e.tag))) if (n > 1) out.push(`tên ${tag} có ${n} mục trong sổ — một tệp chỉ được áp một lần.`);
  const lech = new Set(LICH_SU_LECH_SO);
  entries.forEach((e, i) => {
    const m = TAG_SHAPE.exec(e.tag);
    if (!m) out.push(`tên "${e.tag}" sai dạng NNNN_ten_chu_thuong.`);
    else if (!lech.has(e.tag) && Number(m[1]) !== e.idx) out.push(`${e.tag}: tiền tố tên ${m[1]} khác idx ${e.idx}.${hint}`);
    if (i === 0 && e.idx !== 0) out.push(`mục đầu tiên phải là idx 0, đang là ${e.idx}.`);
    const prev = entries[i - 1];
    if (prev && !lech.has(e.tag) && !lech.has(prev.tag) && e.idx !== prev.idx + 1) out.push(`idx không liên tục: ${prev.tag} (${prev.idx}) → ${e.tag} (${e.idx}).${hint}`);
    if (prev && !(e.when > prev.when)) out.push(`mốc không tăng nghiêm ngặt: ${prev.tag} (${prev.when}) → ${e.tag} (${e.when}) — drizzle sẽ BỎ QUA VĨNH VIỄN mục sau trên CSDL đã chạy.${hint}`);
  });
  for (const t of LICH_SU_LECH_SO) if (!entries.some((e) => e.tag === t)) out.push(`mục lịch sử đã ghim "${t}" không còn trong sổ — sổ đã bị viết lại?`);
  const fileCount = count(files.map((f) => f.replace(/\.sql$/, "")));
  const tags = new Set(entries.map((e) => e.tag));
  for (const [tag, n] of fileCount) {
    if (n > 1) out.push(`tệp ${tag}.sql xuất hiện ${n} lần.`);
    if (!tags.has(tag)) out.push(`${tag}.sql đã vào kho nhưng không có mục trong sổ — sẽ KHÔNG BAO GIỜ được áp.`);
  }
  for (const tag of tags) if (!fileCount.has(tag)) out.push(`sổ trỏ tới ${tag}.sql nhưng kho không có tệp — migrator hỏng lúc khởi động.`);
  return out;
}

/** Kiểm ĐỘT BIẾN của `journalProblems`: mỗi kiểu hỏng phải bị bắt, sổ lành phải sạch. */
function tuKiemJournalProblems() {
  const lanh: JournalEntryShape[] = [
    { idx: 0, tag: "0000_a", when: 10 },
    { idx: 1, tag: "0001_b", when: 20 },
    { idx: 2, tag: "0002_c", when: 30 },
  ];
  const tep = (es: readonly JournalEntryShape[]) => es.map((e) => `${e.tag}.sql`);
  const khongGhim = (ps: string[]) => ps.filter((p) => !p.includes("mục lịch sử đã ghim"));
  assert.deepEqual(khongGhim(journalProblems(lanh, tep(lanh))), [], "sổ lành ⇒ không vấn đề nào");
  const dotBien: [string, JournalEntryShape[], string[] | null, RegExp][] = [
    ["trùng số hiệu", [...lanh, { idx: 2, tag: "0002_d", when: 40 }], null, /số hiệu 2 dùng 2 lần/],
    ["trùng tên", [...lanh, { idx: 3, tag: "0002_c", when: 40 }], null, /tên 0002_c có 2 mục/],
    ["tiền tố ≠ idx", [...lanh, { idx: 3, tag: "0004_d", when: 40 }], null, /tiền tố tên 0004 khác idx 3/],
    ["lỗ số", [...lanh, { idx: 4, tag: "0004_d", when: 40 }], null, /idx không liên tục: 0002_c \(2\) → 0004_d \(4\)/],
    ["mốc chèn giữa", [lanh[0], lanh[1], { ...lanh[2], when: 15 }], null, /mốc không tăng nghiêm ngặt/],
    ["tệp không có mục", lanh, [...tep(lanh), "0003_mo_coi.sql"], /0003_mo_coi\.sql đã vào kho nhưng không có mục/],
    ["mục không có tệp", lanh, tep(lanh).slice(0, 2), /sổ trỏ tới 0002_c\.sql nhưng kho không có tệp/],
    ["tên sai dạng", [...lanh, { idx: 3, tag: "3_thieu_so", when: 40 }], null, /sai dạng/],
  ];
  for (const [ten, es, files, re] of dotBien) {
    const ps = journalProblems(es, files ?? tep(es));
    assert.ok(ps.some((p) => re.test(p)), `đột biến "${ten}" phải bị bắt — nhận ${JSON.stringify(ps)}`);
  }
  // Vùng lịch sử: chỉ ĐÚNG các tên đã ghim được miễn; cùng hình dạng lệch mà tên khác thì đỏ.
  const lechThat: JournalEntryShape[] = [
    { idx: 37, tag: "0037_x", when: 1 },
    { idx: 39, tag: "0039_marketing_ideas", when: 2 },
    { idx: 40, tag: "0038_fb_ads_post_link", when: 3 },
  ];
  assert.ok(!journalProblems(lechThat, tep(lechThat)).some((p) => /0039_marketing_ideas|0038_fb_ads_post_link/.test(p) && /tiền tố|liên tục/.test(p)), "mục lịch sử đã ghim được miễn");
  const lechMoi = [{ idx: 37, tag: "0037_x", when: 1 }, { idx: 39, tag: "0039_moi", when: 2 }];
  assert.ok(journalProblems(lechMoi, tep(lechMoi)).some((p) => /idx không liên tục: 0037_x/.test(p)), "tên mới không được hưởng miễn trừ lịch sử");
}
