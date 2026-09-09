import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

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
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
    entries: { idx: number; tag: string; when: number }[];
  };
  const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql"));

  // ───────── 1. Mọi mục trong sổ phải có file thật ─────────
  for (const e of journal.entries) {
    assert.ok(files.includes(`${e.tag}.sql`), `sổ migration trỏ tới ${e.tag}.sql nhưng không có file đó`);
  }

  // ───────── 2. Mọi file phải có mục trong sổ ─────────
  // File nằm trong thư mục mà không có trong sổ thì KHÔNG BAO GIỜ được áp — và người viết nó sẽ
  // tưởng là đã áp.
  for (const f of files) {
    const tag = f.replace(/\.sql$/, "");
    assert.ok(
      journal.entries.some((e) => e.tag === tag),
      `${f} không có trong sổ migration nên sẽ KHÔNG BAO GIỜ được áp`,
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

  // ───────── 4. Cảnh báo trùng số hiệu ─────────
  // Không dùng `assert` cứng cho phần lịch sử đã trùng (đổi tên bây giờ là áp lại migration trên
  // production). Nhưng số lượng trùng KHÔNG được tăng thêm.
  const byIdx = new Map<number, string[]>();
  for (const e of journal.entries) byIdx.set(e.idx, [...(byIdx.get(e.idx) ?? []), e.tag]);
  const duplicates = [...byIdx.entries()].filter(([, tags]) => tags.length > 1);
  const KNOWN_DUPLICATES = 1; // idx 32 — hai phiên song song, 09/09/2026
  assert.ok(
    duplicates.length <= KNOWN_DUPLICATES,
    `có ${duplicates.length} số hiệu migration bị trùng (cho phép ${KNOWN_DUPLICATES} trường hợp lịch sử): ` +
      duplicates.map(([idx, tags]) => `${idx} = ${tags.join(" + ")}`).join(", ") +
      ". Sinh migration mới thì phải lấy số LỚN HƠN số lớn nhất đang có.",
  );

  // Số hiệu lớn nhất phải khớp số file — bảo đảm lần sinh sau không lấy trùng nữa.
  const maxIdx = Math.max(...journal.entries.map((e) => e.idx));
  assert.ok(maxIdx >= journal.entries.length - 1 - KNOWN_DUPLICATES, "số hiệu lớn nhất phải theo kịp số lượng migration");

  console.log(
    `✓ Sổ migration: ${journal.entries.length} migration, mọi mục có file và mọi file có mục · thứ tự áp tăng dần · ${duplicates.length} số hiệu trùng (đã biết, không được tăng thêm)`,
  );
}
