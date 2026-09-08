/**
 * DỰNG LẠI CHÂN LÝ LỊCH SỬ — chạy thử trước, ghi sau.
 *
 * Mặc định CHẠY THỬ: in ra đủ số liệu để chủ shop quyết định, không ghi một dòng nào.
 * Chỉ ghi khi có `--apply`, và nếu chạy thử có cảnh báo bất thường thì phải thêm `--force`.
 *
 * Dùng:
 *   npx tsx scripts/erp-backfill.ts                  # chạy thử toàn bộ
 *   npx tsx scripts/erp-backfill.ts --batch=500      # chạy thử từng lô
 *   npx tsx scripts/erp-backfill.ts --apply          # ghi thật
 *   npx tsx scripts/erp-backfill.ts --apply --resume # chạy tiếp chỗ dở dang
 */
import { backfillWarnings, runCanonicalBackfill } from "@/lib/sync/backfill";

const apply = process.argv.includes("--apply");
const resume = process.argv.includes("--resume");
const force = process.argv.includes("--force");
const batchArg = process.argv.find((a) => a.startsWith("--batch="));
const batchSize = batchArg ? Number(batchArg.split("=")[1]) : 0;

async function main() {
  // Bước 1: LUÔN chạy thử trước để biết sẽ đổi những gì.
  const dry = await runCanonicalBackfill({ apply: false, batchSize, resume, actor: "script:erp-backfill" });
  const warnings = backfillWarnings(dry);
  console.log(JSON.stringify({ che_do: "CHAY THU", ...dry, canh_bao: warnings }, null, 2));

  if (!apply) return;
  if (warnings.length && !force) {
    console.error("\nDỪNG: chạy thử có cảnh báo bất thường. Điều tra trước, hoặc thêm --force nếu chủ shop đã duyệt.");
    process.exitCode = 2;
    return;
  }

  // Bước 2: ghi thật.
  const applied = await runCanonicalBackfill({ apply: true, batchSize, resume, actor: "script:erp-backfill" });
  console.log(JSON.stringify({ che_do: "GHI THAT", ...applied }, null, 2));

  // Bước 3: chạy lại lần nữa — phải báo 0 thay đổi (idempotent).
  const again = await runCanonicalBackfill({ apply: false, batchSize, resume, actor: "script:erp-backfill" });
  console.log(JSON.stringify({ che_do: "KIEM TRA IDEMPOTENT", van_don_con_lech: again.changed }, null, 2));
  if (again.changed > 0) {
    console.error("CẢNH BÁO: dựng lại lần hai vẫn còn lệch — trạng thái chưa hội tụ, cần xem lại bộ dịch trạng thái.");
    process.exitCode = 3;
  }
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => {
  console.error(error);
  process.exit(1);
});
