/**
 * ═══════════ MIGRATION KHÔNG ĐƯỢC BỎ QUA TRONG IM LẶNG ═══════════
 *
 * Chạy SAU khi ứng dụng đã khởi động (migration tự áp lúc khởi động), TRÊN CHÍNH cơ sở dữ liệu
 * thật. Trả lời đúng một câu hỏi: **mọi mục trong sổ migration đã thực sự được áp chưa?**
 *
 * VÌ SAO KHÔNG BÀI KIỂM NÀO KHÁC BẮT ĐƯỢC:
 *
 * `drizzle` chỉ áp migration có mốc `when` MUỘN HƠN mốc lớn nhất đã áp. Một mục có mốc cũ hơn
 * sẽ bị bỏ qua **vĩnh viễn** — không lỗi, không cảnh báo. Mọi bài kiểm hiện có (kể cả
 * `scripts/bench/migration-verify.ts`) đều dựng cơ sở dữ liệu MỚI TỪ ĐẦU; từ CSDL trống thì
 * mọi migration đều áp theo thứ tự mảng bất kể mốc, nên lỗi này **không thể hiện ra**.
 * Nó chỉ hiện trên một cơ sở dữ liệu ĐÃ chạy — tức là chỉ trên production.
 *
 * ĐÃ XẢY RA HAI LẦN, 09/09/2026:
 *   - `0038_fb_ads_post_link` bị bỏ qua ⇒ `ERROR: column fa.post_id does not exist`, trang
 *     Quảng cáo lỗi trên production trong khi typecheck/test/build đều xanh.
 *   - `0041_shipment_return_leg_index` (mốc 1788940601682) vào kho SAU khi production đã áp
 *     `0042_bank_ledger` (mốc 1788945576898) ⇒ index sửa lỗi quét O(n²) sẽ không bao giờ được
 *     tạo, và bản phát hành hiệu năng vẫn báo deploy thành công.
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/verify-migrations.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";

type JournalEntry = { idx: number; tag: string; when: number };

async function main() {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: JournalEntry[] };
  const db = await getDb();

  // `created_at` của drizzle chính là `when` trong sổ (miligiây). Đó là khoá để đối chiếu.
  const res = await db.execute(sql`select created_at from "drizzle"."__drizzle_migrations"`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  const applied = new Set(rows.map((r) => Number(r.created_at)));

  const missing = journal.entries.filter((e) => !applied.has(e.when));
  const appliedMax = applied.size ? Math.max(...applied) : 0;

  console.log(`[migrations] sổ có ${journal.entries.length} mục · CSDL đã áp ${applied.size} · mốc lớn nhất đã áp ${appliedMax}`);

  if (!missing.length) {
    console.log("[migrations] ✓ Mọi mục trong sổ đều đã được áp.");
    return;
  }

  console.error(`\n[migrations] ✗ ${missing.length} MIGRATION CHƯA ĐƯỢC ÁP:`);
  for (const e of missing) {
    // Phân biệt hai nguyên nhân, vì cách sửa khác nhau hoàn toàn.
    const skippedForever = e.when < appliedMax;
    console.error(
      `  - ${e.tag} (mốc ${e.when})` +
        (skippedForever
          ? ` ⇒ BỊ BỎ QUA VĨNH VIỄN: mốc cũ hơn mốc đã áp (${appliedMax}). Sửa: nâng "when" của mục này lên lớn hơn ${appliedMax} trong drizzle/meta/_journal.json rồi deploy lại.`
          : " ⇒ chưa tới lượt hoặc migrator chưa chạy. Xem log khởi động của ứng dụng."),
    );
  }
  process.exit(1);
}

main().catch((error) => {
  console.error("[migrations] Không kiểm được:", error instanceof Error ? error.message : error);
  process.exit(1);
});
