/**
 * ops `returns-page-probe` (Lead 23/10/2026): đo vòng sự kiện bị chặn khi dựng /reports/returns + đầu phản hồi thật. Khoá:
 *  · đo ĐÚNG đường trang: tham số dựng qua returnsPageParams + withDefaultReturnsBasis, nạp qua loadReturnsPage — không tự dựng kỳ / mốc;
 *  · intelligence đo trên đường trang (nhận sẵn báo cáo lý do kỳ này), không phải đường perf-probe (tự dựng cả hai báo cáo);
 *  · ép chỉ đọc trước lần mở kết nối đầu, và Postgres phải xác nhận (thoát 70 nếu không);
 *  · khai ở ops-vps.yml (lựa chọn · chỉ đọc · nhánh chạy) + mục chú thích trong docs.
 * Script tự chạy khi được nạp, nên bài này chỉ ĐỌC mã nguồn.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function testReturnsPageProbe() {
  const src = readFileSync("scripts/returns-page-probe.ts", "utf8");
  const datChiDoc = src.indexOf('process.env.ERP_READ_ONLY = "1"');
  assert.ok(datChiDoc > 0, "ép chỉ đọc");
  assert.ok(datChiDoc < src.indexOf('await import("@/db")'), "ép chỉ đọc TRƯỚC lần nạp @/db");
  assert.doesNotMatch(src.slice(0, datChiDoc), /from "@\/db"/, "không import tĩnh @/db trước khi ép chỉ đọc");
  assert.match(src, /show default_transaction_read_only/);
  assert.match(src, /process\.exit\(70\)/, "Postgres không xác nhận chỉ đọc ⇒ dừng");
  assert.match(src, /returnsPageParams\(withDefaultReturnsBasis\(\{\}, await canUseModule\("logistics"\)\)\)/, "tham số dựng qua đúng hai hàm của trang");
  assert.match(src, /loadReturnsPage\(thamSo\)/, "đo bằng CHÍNH hàm trang gọi");
  assert.match(src, /reasonReport: baoCao/, "intelligence đo trên đường trang (nhận sẵn báo cáo kỳ này)");
  assert.match(src, /monitorEventLoopDelay/);
  assert.doesNotMatch(src, /\binsert\s+into\b|\.insert\(|\.update\(|\.delete\(/i, "không ghi gì");

  const wf = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(wf, /- returns-page-probe +#/, "có trong danh sách lựa chọn");
  assert.match(wf, /DOC_NANG="[^"]*\breturns-page-probe\b/, "khai là thao tác chỉ đọc");
  assert.match(wf, /returns-page-probe\)\n[\s\S]{0,400}scripts\/returns-page-probe\.ts ;;/, "có nhánh chạy");
  assert.match(readFileSync("docs/ops-vps-script-notes.md", "utf8"), /### `returns-page-probe\)`/, "có mục chú thích trong docs");
  console.log("✓ ops returns-page-probe: đo đúng đường trang (returnsPageParams · loadReturnsPage · intelligence nhận sẵn báo cáo) · chỉ đọc do Postgres xác nhận · khai ops-vps + docs");
}
