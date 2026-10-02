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
 * ═══ CSDL CỦA TỔ CHỨC KHÁCH (docs/platform/scale-plan.md, ngưỡng 0 · việc B) ═══
 *
 * CSDL tổ chức khách migrate LƯỜI — lần đầu một tiến trình mở nó. Không có bước này thì sau mỗi lần deploy, request đầu
 * tiên của MỖI khách gánh cả lượt migrate, và một tổ chức migrate hỏng chỉ lộ ra khi khách chạm vào. Nên sau khi kiểm CSDL
 * nhà, script MỞ lần lượt CSDL của mọi tổ chức khách đang `ACTIVE` (mở = migrate, có khoá tư vấn theo CSDL — chạy cùng lúc
 * với ứng dụng vẫn an toàn) rồi đối chiếu sổ như với nhà. Tổ chức nào hỏng ⇒ in tên + lý do và mã thoát 1: người vận hành
 * thấy ở bước deploy, trước khách. Tổ chức đình chỉ / lưu trữ không mở (không ai dùng, không ai cần chờ).
 *
 * Chạy: docker exec erp-app npx tsx --tsconfig tsconfig.json scripts/verify-migrations.ts
 */
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, getDbFor, type Db } from "@/db";
import { fanOutOrganizationCodes, listOrganizations } from "@/lib/platform/organizations";

type JournalEntry = { idx: number; tag: string; when: number };

/** Đối chiếu sổ với MỘT CSDL. Trả số mục thiếu (0 = khớp). */
async function checkDb(label: string, db: Db, entries: readonly JournalEntry[]): Promise<number> {
  // `created_at` của drizzle chính là `when` trong sổ (miligiây). Đó là khoá để đối chiếu.
  const res = await db.execute(sql`select created_at from "drizzle"."__drizzle_migrations"`);
  const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as Record<string, unknown>[];
  const applied = new Set(rows.map((r) => Number(r.created_at)));

  const missing = entries.filter((e) => !applied.has(e.when));
  const appliedMax = applied.size ? Math.max(...applied) : 0;

  console.log(`[migrations] ${label}: sổ có ${entries.length} mục · CSDL đã áp ${applied.size} · mốc lớn nhất đã áp ${appliedMax}`);

  if (!missing.length) {
    console.log(`[migrations] ✓ ${label}: mọi mục trong sổ đều đã được áp.`);
    return 0;
  }

  console.error(`\n[migrations] ✗ ${label}: ${missing.length} MIGRATION CHƯA ĐƯỢC ÁP:`);
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
  return missing.length;
}

async function main() {
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: JournalEntry[] };
  let failed = (await checkDb("nhà", await getDb(), journal.entries)) > 0;

  const codes = fanOutOrganizationCodes(await listOrganizations());
  if (codes.length) console.log(`[migrations] ${codes.length} tổ chức khách đang hoạt động — mở (và migrate) lần lượt từng CSDL.`);
  for (const code of codes) {
    const started = Date.now();
    try {
      const db = await getDbFor({ code, isHome: false });
      const missing = await checkDb(`tổ chức «${code}» (${((Date.now() - started) / 1000).toFixed(1)} giây)`, db, journal.entries);
      if (missing > 0) failed = true;
    } catch (error) {
      failed = true;
      console.error(`[migrations] ✗ tổ chức «${code}»: không mở / migrate được — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (failed) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[migrations] Không kiểm được:", error instanceof Error ? error.message : error);
    process.exit(1);
  });
