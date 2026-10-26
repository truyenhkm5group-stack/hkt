/**
 * ops `vtp-direct-sync-probe` — số SAU / TRƯỚC của vtp-direct-sync (2) bằng ĐÚNG hàm của trang (26/10/2026). Quét mã nguồn: chỉ đọc từ
 * đầu · gọi đúng các hàm trang dùng (không viết lại truy vấn trang) · phần bị loại đo bằng CÙNG mệnh đề supersededAttemptSql · tham số
 * khớp trang /shipments · tóm tắt không mang mã vận đơn / mã đơn · khai đủ, mã hoá, làn đọc nặng.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function testVtpDirectSyncProbe() {
  const src = readFileSync("scripts/vtp-direct-sync-probe.ts", "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const readOnlyAt = code.search(/process\.env\.ERP_READ_ONLY = "1";/);
  assert.ok(readOnlyAt >= 0 && readOnlyAt < code.indexOf('await import("@/db")'), "chỉ đọc TRƯỚC khi nạp CSDL");
  for (const fn of ["shipmentFacets", "shipmentSummary", "getVtpReconcileQueue", "getDeliveryTower", "listOrders", "supersededAttemptSql"]) assert.match(code, new RegExp(`\\b${fn}\\b`), `gọi đúng hàm ${fn}`);
  assert.doesNotMatch(code, /\.(insert|update|delete)\(/, "không ghi");
  assert.doesNotMatch(code, /tomTat\([^)]*\$\{[^}]*(vtpOrderNumber|shippingDespitePosCancel)[^}]*\}/, "tóm tắt công khai không mang mã vận đơn");
  const page = readFileSync("app/(dashboard)/shipments/page.tsx", "utf8");
  const keys = /filterKeys: (\[[^\]]+\]),\s*sortable: SHIPMENT_SORTABLE,\s*defaultPeriod: "30d"/.exec(page)?.[1];
  assert.ok(keys && src.includes(`filterKeys: ${keys}`), "tham số /shipments khớp trang");
  const ops = readFileSync(".github/workflows/ops-vps.yml", "utf8");
  assert.match(ops, /- vtp-direct-sync-probe\s+#/, "lựa chọn");
  assert.match(ops, /OPS_THAO_TAC_MA_HOA: "[^"]*\bvtp-direct-sync-probe\b/, "kết quả MÃ HOÁ");
  assert.match(ops, /DOC_NANG="[^"]*\bvtp-direct-sync-probe\b/, "làn đọc NẶNG (dựng npx tsx)");
  assert.match(ops, /vtp-direct-sync-probe\)\n[\s\S]*?ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/vtp-direct-sync-probe\.ts ;;/, "nhánh chạy");
  console.log("✓ ops vtp-direct-sync-probe: chỉ đọc từ đầu · đúng hàm trang + cùng mệnh đề bị thay thế · tham số khớp /shipments · tóm tắt không mang mã · khai đủ, mã hoá");
}
