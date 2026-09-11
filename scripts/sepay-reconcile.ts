/**
 * Đối chiếu sổ ngân hàng với API SePay — vá những gói tin webhook không bao giờ tới.
 *
 * MẶC ĐỊNH CHẠY THỬ: chỉ nói sẽ vá gì, không ghi. `--apply` mới ghi. Cùng quy ước với
 * `vtp-rebuild-state`, `cod-rebuild`, `cod-status-repair` — và ở đây còn cần thiết hơn, vì mã đọc
 * API này chưa từng chạy với API thật.
 *
 * Dùng:
 *   npx tsx --tsconfig tsconfig.json scripts/sepay-reconcile.ts [--days=7] [--apply]
 */
import { env } from "@/lib/env";
import { reconcileSepay } from "@/lib/integrations/bank/sepay-reconcile";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const days = Number(arg("days") ?? 7);
const apply = process.argv.includes("--apply");

async function main() {
  if (!env.sepay.apiToken) {
    console.log("SEPAY_API_TOKEN chưa cấu hình — đường đối chiếu đang TẮT.");
    console.log("Tạo token ở my.sepay.vn → Cài đặt công ty → API Access, thêm Secret SEPAY_API_TOKEN rồi chạy ops `apply-sepay-env`.");
    console.log("Đường realtime (webhook) KHÔNG phụ thuộc token này và vẫn đang chạy bình thường.");
    process.exit(0);
  }

  console.log(`Đối chiếu ${days} ngày gần nhất · ${apply ? "GHI THẬT (--apply)" : "CHẠY THỬ (chưa ghi)"}`);
  const r = await reconcileSepay({ days, apply, trigger: "MANUAL", actor: "ops" });

  const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(38)} ${v}`);
  console.log("");
  line("giao dịch API trả về", r.scanned);
  line("đã có trong sổ", r.alreadyInLedger);
  line("THIẾU trong sổ (webhook đã mất)", r.missing);
  line(apply ? "đã vá vào sổ" : "sẽ vá nếu chạy --apply", r.patched || (apply ? 0 : r.missing));
  line("SePay tự báo gửi webhook hỏng", r.providerSaysWebhookFailed);
  line("dòng API đọc không ra", r.unreadable.length);
  line("mâu thuẫn sổ ↔ API", r.conflicts.length);
  if (r.shape) line("hình dạng phong bì API", r.shape);

  for (const u of r.unreadable.slice(0, 15)) console.log(`    · đọc không ra — ${u}`);
  for (const c of r.conflicts.slice(0, 15)) console.log(`    · MÂU THUẪN — ${c}`);

  if (!apply && r.missing > 0) {
    console.log(`\n${r.missing} giao dịch thiếu trong sổ. Xem lại danh sách trên rồi chạy lại với --apply để vá.`);
  }
  if (apply && r.patched > 0) {
    console.log(`\nĐã vá ${r.patched} giao dịch mà webhook làm mất. Chúng vào sổ với source='API' nên truy nguyên được.`);
  }
  if (r.scanned === 0) {
    console.log("\nAPI không trả về giao dịch nào. Nếu khoảng ngày chắc chắn có giao dịch thì hình dạng phong bì đã khác — xem dòng 'hình dạng phong bì API' ở trên.");
  }
  process.exit(0);
}

void main();
