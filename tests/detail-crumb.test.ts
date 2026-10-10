/**
 * DÒNG VỊ TRÍ Ở TRANG CHI TIẾT (`components/detail-crumb.tsx`) — chủ shop 09/10/2026: breadcrumb không in route kỹ thuật,
 * và «quay lại» giữ bộ lọc của danh sách.
 *
 * Chạy riêng: npx tsx --tsconfig tsconfig.json tests/detail-crumb.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { crumbLabel } from "@/components/detail-crumb";

export function testDetailCrumb() {
  assert.equal(crumbLabel("new"), "Tạo mới");
  assert.equal(crumbLabel("edit"), "Sửa");
  assert.equal(crumbLabel("demo-o-5209"), "Chi tiết", "mã đơn không in thô");
  assert.equal(crumbLabel("erp-b4aee602-7c70-49d8-a8c5-47c83475abbe"), "Chi tiết", "uuid không in thô");
  assert.equal(crumbLabel("%C4%90%E1%BA%A7m"), "Đầm", "chữ thường vẫn giải mã URL");
  const src = readFileSync("components/detail-crumb.tsx", "utf8");
  // Lưu trữ trình duyệt bọc try/catch, lỗi ⇒ về danh sách trần (không bao giờ vỡ trang).
  assert.match(src, /try \{[\s\S]*sessionStorage[\s\S]*\} catch \{/);
  assert.match(src, /href=\{backHref \?\? parentHref\}/);
  console.log("✓ dòng vị trí: không in mã / route thô (Tạo mới · Sửa · Chi tiết) · quay lại giữ URL danh sách của phiên");
}

if (process.argv[1] && /detail-crumb\.test\.ts$/.test(process.argv[1])) testDetailCrumb();
