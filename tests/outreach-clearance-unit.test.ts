import assert from "node:assert/strict";
import { qualifiesForClearance } from "@/lib/outreach/build";
import { DEFAULT_OUTREACH } from "@/lib/constants/outreach";

/**
 * Tệp XẢ HÀNG so tỷ lệ hoàn theo PHẦN TRĂM với ngưỡng chủ shop đặt (mặc định 35%).
 *
 * Từ 05/09/2026 dòng so từng nhân `rate × 100` trong khi `productReturnHistory` đã trả phần trăm, nên
 * mã hoàn ~0,5% đã lọt vào tệp và được chào ưu đãi khách cũ / giá siêu hời. Bài này khoá đơn vị.
 */
export function testOutreachClearanceUnit() {
  const cfg = { clearanceReturnRatePct: 35, clearanceStockDays: 45 };
  assert.equal(DEFAULT_OUTREACH.clearanceReturnRatePct, 35, "ngưỡng mặc định vẫn 35% — bài này không đổi ngưỡng");

  // Đúng đơn vị: 20% < 35% ⇒ KHÔNG xả dù tồn rất nhiều. Lỗi cũ (20 × 100 = 2000 ≥ 35) cho vào tệp.
  assert.equal(qualifiesForClearance(20, 400, cfg), false, "hoàn 20% không phải hoàn cao với ngưỡng 35%");
  assert.equal(qualifiesForClearance(0.5, null, cfg), false, "hoàn 0,5% không bao giờ là hoàn cao");
  // Ngưỡng tính cả biên.
  assert.equal(qualifiesForClearance(35, 45, cfg), true, "đúng 35% và đúng 45 ngày ⇒ vào tệp");
  assert.equal(qualifiesForClearance(34.9, 400, cfg), false);
  assert.equal(qualifiesForClearance(60, 44, cfg), false, "hoàn cao nhưng tồn còn ít ⇒ chưa xả");
  // Tồn không vơi (không có nhịp ròng) ⇒ coi là tồn nhiều.
  assert.equal(qualifiesForClearance(60, null, cfg), true);

  console.log("✓ Tệp xả hàng: tỷ lệ hoàn so theo PHẦN TRĂM (không còn × 100), ngưỡng 35% / 45 ngày tính cả biên");
}
