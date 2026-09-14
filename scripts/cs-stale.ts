/**
 * ĐỐI CHIẾU HÀNG ĐỢI CSKH VỚI THỰC TẾ HIỆN TẠI.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/cs-stale.ts            # CHẠY THỬ, không ghi gì
 *   npx tsx --tsconfig tsconfig.json scripts/cs-stale.ts --apply    # đóng mềm các case xác định
 *
 * MẶC ĐỊNH CHẠY THỬ. Đổi dữ liệu production phải là một quyết định tường minh, không phải tác dụng
 * phụ của việc chạy một lệnh xem thử.
 */
import "dotenv/config";
import { CS_KIND_LABEL } from "@/lib/constants/cs";
import { RECONCILE_REASONS, RECONCILE_REASON_LABEL } from "@/lib/cs/reconcile-order-created";
import { applyStaleReconciliation, staleReport, STALE_VERDICTS, STALE_VERDICT_LABEL } from "@/lib/cs/stale";

async function main() {
  const apply = process.argv.includes("--apply");
  const bc = await staleReport(20);

  console.log(`\n═══ HÀNG ĐỢI CSKH ĐANG MỞ: ${bc.openTotal} case ═══\n`);
  console.log("KẾT LUẬN (không tính “chưa tạo đơn” — loại đó có máy riêng, xem dưới):");
  for (const v of STALE_VERDICTS) console.log(`  ${v.padEnd(14)} ${String(bc.byVerdict[v]).padStart(5)}  ${STALE_VERDICT_LABEL[v]}`);

  console.log("\nTHEO LOẠI:");
  for (const k of bc.byKind) {
    const chiTiet = STALE_VERDICTS.filter((v) => k.counts[v]).map((v) => `${v}=${k.counts[v]}`).join(" · ");
    console.log(`  ${String(k.total).padStart(5)}  ${(CS_KIND_LABEL[k.kind] ?? k.kind).padEnd(34)} ${chiTiet}`);
  }

  const o = bc.orderNotCreated;
  console.log(`\n═══ "ĐỦ THÔNG TIN · CHƯA TẠO ĐƠN": ${o.openBefore} đang mở ═══`);
  for (const r of RECONCILE_REASONS) console.log(`  ${String(o.closed[r]).padStart(5)}  ${r.padEnd(22)} ${RECONCILE_REASON_LABEL[r]}`);
  console.log(`  ${String(o.humanTouched).padStart(5)}  ĐÃ CÓ NGƯỜI CHẠM        — máy KHÔNG đóng hộ, để người quyết`);
  console.log(`  ${String(o.stillPending).padStart(5)}  CÒN TREO THẬT           — chưa có chứng cứ nào nói đơn đã tồn tại`);

  console.log(`\n═══ MẪU ĐỂ KIỂM CHỨNG (${bc.samples.length} case máy sẽ đóng) ═══`);
  for (const s of bc.samples) console.log(`  ${s.id}  ${String(s.ageDays).padStart(3)}n  ${(CS_KIND_LABEL[s.kind] ?? s.kind).padEnd(24)} ${s.title.slice(0, 60)}\n        └─ ${s.reason}`);
  if (!bc.samples.length) console.log("  (không có case nào máy đóng được — hàng đợi đang phản ánh đúng thực tế)");

  if (!apply) {
    console.log(`\nCHẠY THỬ — KHÔNG ghi một dòng nào. Thêm --apply để đóng mềm ${bc.byVerdict.AUTO_RESOLVE + o.closedTotal} case xác định.\n`);
    return;
  }
  const kq = await applyStaleReconciliation({ dryRun: false, actor: "ops:cs-stale" });
  console.log(`\n═══ ĐÃ ÁP DỤNG ═══`);
  console.log(`  ${kq.closed}/${kq.planned} case đóng mềm (AUTO_RESOLVED, có lý do từng case)`);
  for (const k of kq.byKind) console.log(`    · ${CS_KIND_LABEL[k.kind] ?? k.kind}: ${k.n}`);
  console.log(`  ${kq.orderNotCreated.closedTotal} case "chưa tạo đơn" đóng theo bốn bậc chứng cứ`);
  console.log(`  CÒN LẠI: ${kq.orderNotCreated.stillPending} case "chưa tạo đơn" còn treo thật\n`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
