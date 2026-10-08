/**
 * Ghi lại SỐ ĐO HIỆN TRẠNG của bộ đo đơn vàng v2 sau một thay đổi CỐ Ý (luật chốt đơn · lời nhắc · công cụ · bộ chuẩn hoá địa
 * chỉ · dataset).
 *
 *   npx tsx tests/order-golden/update-baseline.ts
 *
 * Chạy trên PGlite thử (giống `npm test`), không gọi mạng. Ghi `tests/order-golden/baseline.json`, khối bảng số và dòng «nền đo»
 * trong `tests/order-golden/BASELINE.md`. Phần chữ người viết của BASELINE.md GIỮ NGUYÊN — sửa nhận định cho khớp số mới là việc
 * của người chạy lệnh; đọc `git diff tests/order-golden` như đọc mã: một con số đổi mà không ai giải thích được là một hành vi
 * chốt đơn đổi mà không ai muốn.
 */
import "../setup-env";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { ensureMigrated } from "@/db/migrate";
import { ORDER_GOLDEN_BASELINE_JSON, ORDER_GOLDEN_BASELINE_MD } from "./order-golden.test";
import { ORDER_GOLDEN_VARIANTS, runOrderGolden, type OrderGoldenRun } from "./harness";
import { compactBaseline, renderBaselineTables, replaceTablesBlock } from "./report";

const BASE_START = "<!-- NỀN ĐO -->";
const BASE_END = "<!-- HẾT NỀN ĐO -->";

/** JSON thụt lề, nhưng mảng chỉ chứa giá trị đơn (số, chữ) nằm gọn MỘT dòng — diff của baseline đọc được theo từng ô. */
function readableJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/\[\n\s+([^[\]{}]*?)\n\s+\]/g, (_m, inner: string) => `[${inner.split(/,\n\s+/).join(", ")}]`);
}

void (async () => {
  await ensureMigrated();
  const runs: OrderGoldenRun[] = [];
  for (const v of ORDER_GOLDEN_VARIANTS) runs.push(await runOrderGolden(v));
  writeFileSync(ORDER_GOLDEN_BASELINE_JSON, `${readableJson(compactBaseline(runs))}\n`, { encoding: "utf8" });
  let md = replaceTablesBlock(readFileSync(ORDER_GOLDEN_BASELINE_MD, "utf8").replace(/\r\n/g, "\n"), renderBaselineTables(runs));
  const s = md.indexOf(BASE_START);
  const e = md.indexOf(BASE_END);
  if (s >= 0 && e > s) {
    const sha = execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { encoding: "utf8" }).trim();
    const day = new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date());
    md = `${md.slice(0, s + BASE_START.length)}\n> Đo lúc ${day} (giờ Việt Nam) trên SHA nền \`${sha}\` — \`npx tsx tests/order-golden/update-baseline.ts\`.\n${md.slice(e)}`;
  }
  writeFileSync(ORDER_GOLDEN_BASELINE_MD, md, { encoding: "utf8" });
  for (const r of runs) console.log(`${r.variant}: chốt sai ${r.summary.metrics.false_auto_confirm_rate.numerator}/${r.summary.metrics.false_auto_confirm_rate.denominator} · đơn trùng ${r.summary.metrics.duplicate_order_rate.numerator}/${r.summary.metrics.duplicate_order_rate.denominator} · thiếu đơn ${r.summary.metrics.missing_order_rate.numerator}/${r.summary.metrics.missing_order_rate.denominator}`);
  console.log("Đã ghi baseline.json + bảng số của BASELINE.md — đọc git diff tests/order-golden trước khi commit.");
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
