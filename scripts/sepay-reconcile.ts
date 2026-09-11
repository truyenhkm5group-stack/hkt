/**
 * Đối chiếu sổ ngân hàng với API SePay — vá những gói tin webhook không bao giờ tới.
 *
 * MẶC ĐỊNH CHẠY THỬ: chỉ nói sẽ vá gì, không ghi. `--apply` mới ghi. Cùng quy ước với
 * `vtp-rebuild-state`, `cod-rebuild`, `cod-status-repair` — và ở đây còn cần thiết hơn, vì mã đọc
 * API này chưa từng chạy với API thật.
 *
 * Ở lượt GHI THẬT, script in TỔNG SỔ TRƯỚC VÀ SAU rồi tự đối chiếu. Đó là cách đọc một dòng là biết
 * ngay có nhân đôi hay không — số dòng phải tăng đúng bằng số đã vá, tiền vào/ra tăng đúng bằng số
 * đã dự báo. Bắt người đọc tự trừ hai con số trong đầu là cách một lần nhân đôi lọt qua.
 *
 * Dùng:
 *   npx tsx --tsconfig tsconfig.json scripts/sepay-reconcile.ts [--days=7] [--apply]
 */
import { getDb } from "@/db";
import { env } from "@/lib/env";
import { bankLedgerTotals, reconcileSepay } from "@/lib/integrations/bank/sepay-reconcile";

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
const days = Number(arg("days") ?? 7);
const apply = process.argv.includes("--apply");

const vnd = (n: number) => n.toLocaleString("vi-VN");
const line = (k: string, v: unknown) => console.log(`  ${k.padEnd(40)} ${v}`);

async function main() {
  if (!env.sepay.apiToken) {
    console.log("SEPAY_API_TOKEN chưa cấu hình — đường đối chiếu đang TẮT.");
    console.log("Tạo token ở my.sepay.vn → Cài đặt công ty → API Access, thêm Secret SEPAY_API_TOKEN rồi chạy ops `apply-sepay-env`.");
    console.log("Đường realtime (webhook) KHÔNG phụ thuộc token này và vẫn đang chạy bình thường.");
    process.exit(0);
  }

  const db = await getDb();
  const truoc = await bankLedgerTotals(db);
  console.log(`Đối chiếu ${days} ngày gần nhất · ${apply ? "GHI THẬT (--apply)" : "CHẠY THỬ (chưa ghi)"}`);
  console.log("");
  line("SỔ TRƯỚC", `${vnd(truoc.rows)} dòng · vào ${vnd(truoc.inflow)}₫ · ra ${vnd(truoc.outflow)}₫`);
  console.log("");

  const r = await reconcileSepay({ days, apply, trigger: "MANUAL", actor: "ops" });

  line("API thấy bao nhiêu giao dịch", r.scanned);
  line("· đã có trong sổ", r.alreadyInLedger);
  line("    - từ WEBHOOK (realtime)", r.inLedgerFromWebhook);
  line("    - từ FILE_IMPORT (sao kê tay)", r.inLedgerFromImport);
  line("    - từ API (lượt đối chiếu trước)", r.inLedgerFromApi);
  line("    - từ nguồn khác / gõ tay", r.inLedgerFromManual);
  line("· GIAO DỊCH MỚI (webhook đã mất)", r.missing);
  console.log("");
  line("nghi trùng cần người xem", r.duplicateSuspects);
  line("thuộc tài khoản chưa xác nhận", r.accountUnconfirmed);
  line("SePay tự báo gửi webhook hỏng", r.providerSaysWebhookFailed);
  line("dòng API đọc không ra", r.unreadable.length);
  line("mâu thuẫn sổ / API", r.conflicts.length);
  console.log("");
  line(apply ? "tiền vào ĐÃ tăng thêm" : "tiền vào SẼ tăng thêm", `${vnd(r.projectedIn)}₫`);
  line(apply ? "tiền ra ĐÃ tăng thêm" : "tiền ra SẼ tăng thêm", `${vnd(r.projectedOut)}₫`);
  if (r.shape) line("hình dạng phong bì API", r.shape);

  for (const u of r.unreadable.slice(0, 15)) console.log(`    · đọc không ra — ${u}`);
  for (const c of r.conflicts.slice(0, 15)) console.log(`    · MÂU THUẪN — ${c}`);

  if (apply) {
    const sau = await bankLedgerTotals(db);
    console.log("");
    line("SỔ SAU", `${vnd(sau.rows)} dòng · vào ${vnd(sau.inflow)}₫ · ra ${vnd(sau.outflow)}₫`);

    // KIỂM CHỨNG NGAY TẠI CHỖ: tăng nhiều hơn = nhân đôi, tăng ít hơn = mất giao dịch.
    const loi: string[] = [];
    if (sau.rows - truoc.rows !== r.patched) loi.push(`số dòng tăng ${sau.rows - truoc.rows} nhưng chỉ vá ${r.patched} giao dịch`);
    if (sau.inflow - truoc.inflow !== r.projectedIn) loi.push(`tiền vào tăng ${vnd(sau.inflow - truoc.inflow)} nhưng dự báo ${vnd(r.projectedIn)}`);
    if (sau.outflow - truoc.outflow !== r.projectedOut) loi.push(`tiền ra tăng ${vnd(sau.outflow - truoc.outflow)} nhưng dự báo ${vnd(r.projectedOut)}`);

    console.log("");
    if (loi.length) {
      console.error("✗ SỔ KHÔNG KHỚP VỚI VIỆC ĐÃ LÀM:");
      for (const l of loi) console.error(`    · ${l}`);
      process.exit(1);
    }
    console.log(`✓ Sổ tăng ĐÚNG ${r.patched} dòng · vào +${vnd(r.projectedIn)}₫ · ra +${vnd(r.projectedOut)}₫ — không nhân đôi, không thiếu.`);
  } else if (r.missing > 0) {
    console.log("");
    console.log(`${r.missing} giao dịch thiếu trong sổ. Xem lại số trên rồi chạy lại với --apply để vá.`);
  } else if (r.scanned > 0) {
    console.log("");
    console.log("Sổ đã đầy đủ: mọi giao dịch API trả về đều có trong sổ. Đường realtime đang làm đúng việc của nó.");
  }

  if (r.scanned === 0) {
    console.log("");
    console.log("API không trả về giao dịch nào. Nếu khoảng ngày chắc chắn có giao dịch thì hình dạng phong bì đã khác — xem dòng 'hình dạng phong bì API' ở trên.");
  }
  process.exit(0);
}

void main();
