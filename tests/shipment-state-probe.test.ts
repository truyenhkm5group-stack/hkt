/**
 * ops `shipment-state-probe` — đo cửa nội bộ bot → ERP, CHỈ ĐỌC (24/10/2026). Quét mã nguồn: chỉ đọc từ đầu · khoá không bao giờ in ·
 * đo ĐÚNG hàm của route (không viết lại câu PRIMARY_ATTEMPT) · EXPLAIN qua getDb() trong giao dịch chỉ đọc + rollback · ops khai đủ, mã hoá.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function testShipmentStateProbe() {
  const src = readFileSync("scripts/shipment-state-probe.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  // Tìm bằng regex đã thoát (không phải chuỗi literal): bài này KHÔNG đọc môi trường, chỉ đọc mã nguồn của script.
  const readOnlyAt = code.search(/process\.env\.ERP_READ_ONLY = "1";/);
  assert.ok(readOnlyAt >= 0 && readOnlyAt < code.indexOf('await import("@/db")'), "chỉ đọc TRƯỚC khi nạp CSDL");
  assert.match(code, /import\("@\/lib\/queries\/shipment-state-internal"\)/, "đo đúng hàm route dùng");
  assert.doesNotMatch(code, /PRIMARY_ATTEMPT|order by \(sh\.stage/, "không viết bản thứ hai của câu lần gửi chính — câu EXPLAIN lấy từ primaryShipmentsQuery của chính route");
  assert.doesNotMatch(code, /console\.log\([^)]*\btoken\b/, "khoá không bao giờ đi vào log");
  assert.doesNotMatch(code, /tomTat\([^)]*\$\{(ids|codes|url|mau)(\.join[^}]*)?\}/, "tóm tắt công khai không mang danh sách mã đơn / mã vận đơn / URL (số đếm thì được)");
  assert.match(code, /db\s*\.transaction\(async \(tx\) => \{\s*await tx\.execute\(sql\.raw\("set transaction read only"\)\);[\s\S]*?tx\.rollback\(\);/, "EXPLAIN trong giao dịch chỉ đọc của getDb(), kết thúc rollback");
  assert.match(code, /explain \(analyze, buffers, timing\) \$\{primaryShipmentsQuery\(ids\)\}/, "EXPLAIN đúng câu route dùng (primaryShipmentsQuery), không bắt lại câu từ driver");
  assert.doesNotMatch(code, /import\(\s*["']pg["']\s*\)|new\s+(?:pg\.)?Pool\s*\(/, "không mở kết nối CSDL thứ hai (S1 · ISO-17)");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- shipment-state-probe\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bshipment-state-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bshipment-state-probe\b/, "làn đọc NẶNG (có khoá): script dựng tiến trình npx tsx trong container");
  assert.doesNotMatch(ops, /DOC_NHE="[^"]*\bshipment-state-probe\b/, "không ở làn nhẹ chạy song song không giới hạn");
  assert.match(ops, /shipment-state-probe\)\n[\s\S]*?ma_hoa_ket_qua docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/shipment-state-probe\.ts ;;/, "nhánh chạy");
  console.log("✓ ops shipment-state-probe: chỉ đọc từ đầu · đo đúng hàm route · không lộ khoá / mã · EXPLAIN chỉ đọc + rollback · khai đủ, mã hoá");
}
