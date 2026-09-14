/**
 * ĐÓNG MỀM CASE SINH BỞI LUẬT CŨ, RỒI QUÉT LẠI BẰNG LUẬT MỚI.
 *
 * Mặc định CHỈ ĐẾM (`dry run`). Muốn ghi thật phải truyền `--apply` — đổi dữ liệu production là
 * quyết định tường minh, không phải tác dụng phụ của việc chạy thử.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/cs-rule-update.ts            # chỉ đếm
 *   npx tsx --tsconfig tsconfig.json scripts/cs-rule-update.ts --apply    # đóng thật rồi quét lại
 */
import "dotenv/config";
import { invalidateOldOrderNotCreatedCases } from "@/lib/cs/invalidate";
import { syncPancakeChatCases } from "@/lib/cs/chat-detect";

async function main() {
  const apply = process.argv.includes("--apply");
  const r = await invalidateOldOrderNotCreatedCases({ dryRun: !apply, actor: "ops:cs-rule-update" });

  console.log(`\n── CASE "ĐỦ THÔNG TIN · CHƯA TẠO ĐƠN" ${apply ? "(ĐÃ GHI)" : "(chỉ đếm — thêm --apply để ghi)"} ──`);
  console.log(`  OLD_OPEN_CASES            ${r.openBefore}`);
  console.log(`  AUTO_RESOLVED_OLD_RULE    ${r.autoResolved}`);
  console.log(`  HUMAN_TOUCHED_PRESERVED   ${r.humanTouched}   (có người nhận / có kết luận ⇒ giữ nguyên)`);
  console.log(`  NOT_OLD_RULE_UNTOUCHED    ${r.notOldRule}   (không mang dấu vết luật cũ ⇒ không đụng)`);

  if (!apply) {
    console.log("\n  Chưa ghi gì. Chạy lại với --apply để đóng mềm và quét lại.");
    process.exit(0);
  }

  console.log("\n── QUÉT LẠI BẰNG LUẬT MỚI (7 ngày) ──");
  try {
    const q = await syncPancakeChatCases({ hours: 24 * 7 });
    console.log(`  CONVERSATIONS_SCANNED     ${q.scanned}`);
    console.log(`  CUSTOMER_INFO_COMPLETE    ${q.infoComplete}   (khách đã cho đủ SĐT + địa chỉ)`);
    console.log(`  MATCHED_EXISTING_ORDER    ${q.alreadyOrdered}   (đã có đơn ⇒ KHÔNG tạo case)`);
    console.log(`  AMBIGUOUS                 ${q.ambiguous}   (một SĐT nhiều đơn ⇒ không kết luận)`);
    console.log(`  NEW_VALID_CASES           ${q.created}`);
    if (q.errorCount) console.log(`  LỖI                       ${q.errorCount}: ${q.errors.slice(0, 3).join(" · ")}`);
  } catch (e) {
    console.log(`  Không quét lại được: ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error("cs-rule-update lỗi:", error instanceof Error ? error.message : error);
  process.exit(1);
});
