/**
 * Nhập bảng kê tiền COD Viettel Post (tổng hợp) không cần giao diện.
 *   npm run import:vtp-statements -- '<JSON mảng {reference, receivedAt, codGross, feeTotal, netAmount}>'
 *   cat bang-ke.txt | npm run import:vtp-statements -- --stdin     # dán bảng "Tiền hàng đã trả" từ viettelpost.vn
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { parseStatementSummaryText, type StatementSummary } from "@/lib/integrations/viettelpost/statement";
import { upsertStatementBatches } from "@/lib/integrations/viettelpost/statement-db";

async function main() {
  const args = process.argv.slice(2);
  const text = args.includes("--stdin") ? readFileSync(0, "utf8") : (args.find((a) => !a.startsWith("--")) ?? "");
  if (!text.trim()) throw new Error("Truyền JSON hoặc --stdin");
  let rows: StatementSummary[];
  if (text.trim().startsWith("[")) rows = JSON.parse(text) as StatementSummary[];
  else rows = parseStatementSummaryText(text);
  if (!rows.length) throw new Error("Không có bảng kê nào");
  const result = await upsertStatementBatches(rows, "import:vtp-statements");
  const net = rows.reduce((a, r) => a + r.netAmount, 0);
  console.log(`Bảng kê: ${rows.length} (mới ${result.created}, cập nhật ${result.updated}) · tiền thu về ${net.toLocaleString("vi-VN")}đ`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
