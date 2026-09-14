import assert from "node:assert/strict";
import type { Db } from "@/db";
import { VELOCITY_MIN_WINDOW_FOR_TRIM, computePlan, computeVelocity } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";

const BASE = {
  stock: 100,
  committed: 0,
  soldInWindow: 28,
  windowDays: 14,
  leadTimeDays: 7,
  coverDays: 14,
  safetyDays: 3,
  roundTo: 1,
};

/**
 * DỰ BÁO TỒN KHO & ĐẶT SẢN XUẤT.
 *
 * Điều phải khoá: một ngày đột biến không được quyết định kế hoạch cả tháng; không biết tồn thì
 * không đề xuất; và số đề xuất phải là số ĐẶT ĐƯỢC ở xưởng.
 */
export async function testInventoryForecast(db: Db) {
  void db;

  // ───────── 1. Một ngày livestream không được phá dự báo ─────────
  // 60 cái trong một ngày của cửa sổ 14 ngày: tốc độ thô 4,4 cái/ngày, trong khi ngày thường bán
  // khoảng 1. Đặt sản xuất theo 4,4 là đặt thừa gấp bốn.
  const spike = computeVelocity(60 + 13, 14, 60);
  assert.equal(spike.trimmed, true, "một ngày chiếm hơn nửa tổng bán PHẢI bị coi là đột biến");
  assert.ok(spike.velocity < spike.rawVelocity, "bỏ ngày đột biến thì tốc độ phải giảm");
  assert.equal(spike.velocity, 1, "bỏ ngày đột biến ra thì còn đúng nhịp bán ngày thường");

  // ───────── 2. Dao động BÌNH THƯỜNG là thông tin thật, không được dập ─────────
  // Dập mọi dao động sẽ khiến kế hoạch luôn đặt thiếu.
  const normal = computeVelocity(28, 14, 5);
  assert.equal(normal.trimmed, false, "ngày bán mạnh nhưng không áp đảo thì KHÔNG được cắt");
  assert.equal(normal.velocity, normal.rawVelocity);

  // Cửa sổ quá ngắn thì không cắt: bỏ một ngày trong ba ngày là bỏ một phần ba bằng chứng.
  const shortWindow = computeVelocity(10, VELOCITY_MIN_WINDOW_FOR_TRIM - 1, 9);
  assert.equal(shortWindow.trimmed, false, "cửa sổ ngắn thì không đủ căn cứ để gọi là đột biến");

  // Bán đúng một ngày duy nhất trong cả cửa sổ: KHÔNG cắt, vì cắt xong tốc độ bằng 0 và kế hoạch
  // sẽ kết luận "mẫu này không bán" — sai hoàn toàn.
  const onlyOneDay = computeVelocity(20, 14, 20);
  assert.equal(onlyOneDay.trimmed, false, "cắt hết dữ liệu thì không còn gì để dự báo");
  assert.ok(onlyOneDay.velocity > 0);

  // ───────── 3. Mức đặt tối thiểu của xưởng ─────────
  // Đề xuất 5 cái trong khi xưởng chỉ nhận từ 50 là con số vô dụng: bảng trông chính xác nhưng
  // đơn hàng không đặt được.
  const withMoq = computePlan({ ...BASE, stock: 30, soldInWindow: 14, minOrderQty: 50 });
  if (withMoq.suggestedBeforeMoq > 0 && withMoq.suggestedBeforeMoq < 50) {
    assert.equal(withMoq.moqApplied, true, "phải nâng lên mức đặt tối thiểu");
    assert.equal(withMoq.suggested, 50, "số đề xuất phải là số ĐẶT ĐƯỢC");
    assert.ok(withMoq.suggested > withMoq.suggestedBeforeMoq, "phải giữ lại số trước khi nâng để giải thích phần chênh");
  }
  // Không cần đặt thì mức tối thiểu KHÔNG được tạo ra một đơn hàng từ hư không.
  const noNeed = computePlan({ ...BASE, stock: 10_000, minOrderQty: 50 });
  assert.equal(noNeed.suggested, 0, "đủ hàng rồi thì mức đặt tối thiểu không được đẻ ra đơn đặt");
  assert.equal(noNeed.moqApplied, false);

  // ───────── 4. Không biết tồn thì KHÔNG đề xuất ─────────
  // Đề xuất dựa trên dữ liệu bịa còn tệ hơn không đề xuất.
  const unknown = computePlan({ ...BASE, stockKnown: false, minOrderQty: 50 });
  assert.equal(unknown.status, "UNKNOWN");
  assert.equal(unknown.suggested, 0, "chưa có phiếu nhập thì không được đề xuất số lượng nào");
  assert.equal(unknown.moqApplied, false, "không đề xuất thì cũng không nâng theo mức tối thiểu");

  // ───────── 5. Không có Infinity trên giao diện ─────────
  const idle = computePlan({ ...BASE, soldInWindow: 0, peakDayQty: 0 });
  assert.equal(idle.daysOfCover, null, "không bán được cái nào thì số ngày còn hàng là CHƯA BIẾT, không phải vô cực");
  assert.equal(idle.status, "IDLE");
  const outOfStock = computePlan({ ...BASE, stock: -5 });
  assert.equal(outOfStock.status, "OUT");
  assert.ok(Number.isFinite(outOfStock.suggested), "tồn âm vẫn phải ra một con số hữu hạn");

  // ───────── 5b. Hạn đặt hàng phải lùi đúng thời gian sản xuất ─────────
  const soon = computePlan({ ...BASE, stock: 30, soldInWindow: 28, windowDays: 14, leadTimeDays: 7 });
  assert.ok(soon.stockOutDate, "phải dự báo được ngày hết hàng");
  assert.ok(soon.reorderByDate, "phải tính được hạn đặt hàng");
  const gap = (new Date(`${soon.stockOutDate}T00:00:00Z`).getTime() - new Date(`${soon.reorderByDate}T00:00:00Z`).getTime()) / 86_400_000;
  assert.equal(gap, 7, "hạn đặt hàng phải lùi đúng bằng thời gian sản xuất");

  // Đã hết hàng: hạn đặt nằm ở QUÁ KHỨ. Vẫn phải hiện ra — giấu đi thì mẫu đang đứt hàng trông y
  // hệt mẫu còn kịp.
  const late = computePlan({ ...BASE, stock: 0, soldInWindow: 28, leadTimeDays: 7 });
  assert.ok(late.reorderByDate, "đã muộn vẫn phải có hạn đặt để biết muộn bao nhiêu");
  assert.ok(new Date(`${late.reorderByDate}T00:00:00Z`).getTime() < Date.now(), "hạn đặt của mẫu đã hết hàng phải nằm ở quá khứ");

  // Chưa biết tồn thì không có hạn đặt nào cả.
  assert.equal(computePlan({ ...BASE, stockKnown: false }).reorderByDate, null, "chưa biết tồn thì không đặt ra hạn nào");

  // ───────── 6. Chạy trên dữ liệu thật ─────────
  const plan = await getReplenishmentPlan({});
  for (const row of plan.rows) {
    assert.ok(Number.isFinite(row.velocity) && row.velocity >= 0, `${row.sku}: tốc độ bán phải hữu hạn, không âm`);
    assert.ok(row.velocity <= row.rawVelocity + 1e-9, `${row.sku}: tốc độ dùng để lập kế hoạch không được cao hơn tốc độ thô`);
    if (row.daysOfCover !== null) assert.ok(Number.isFinite(row.daysOfCover), `${row.sku}: số ngày còn hàng phải hữu hạn`);
    if (row.status === "UNKNOWN") assert.equal(row.suggested, 0, `${row.sku}: chưa biết tồn thì không đề xuất`);
    assert.ok(row.suggested >= row.suggestedBeforeMoq || row.suggestedBeforeMoq === 0, `${row.sku}: nâng theo mức tối thiểu chỉ được tăng, không được giảm`);
  }

  const trimmed = plan.rows.filter((r) => r.velocityTrimmed).length;
  console.log(
    `✓ Dự báo tồn kho: ${plan.rows.length} mẫu mã · ${trimmed} mẫu bị bỏ ngày đột biến khỏi tốc độ bán · chưa biết tồn thì KHÔNG đề xuất · không có vô cực trên giao diện`,
  );
}
