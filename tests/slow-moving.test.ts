import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { SLOW_MOVING_RULES, STOCK_RISK_ACTION, STOCK_RISK_LABEL, type StockRisk } from "@/lib/constants/slow-moving";
import { getSlowMoving } from "@/lib/queries/slow-moving";

/**
 * HÀNG BÁN CHẬM & VỐN NẰM CHẾT.
 *
 * Điều phải khoá: chưa biết tồn thì KHÔNG kết luận vốn nằm chết; giá trị vốn tính theo GIÁ NHẬP
 * chứ không phải giá bán; và phần vốn vượt mức không bao giờ lớn hơn tổng vốn của chính lô hàng.
 */
export async function testSlowMoving(db: Db) {
  // Fixture không có mẫu mã nào tồn dương nên bảng rỗng và bài kiểm thử không kiểm được gì. Dựng
  // một lô hàng thật: 200 cái nhập từ lâu, không bán được cái nào — đúng định nghĩa HÀNG CHẾT.
  // Dọn sạch ở cuối để không đổi số tồn của các khối kiểm thử khác.
  const REF = "test-slow-moving";
  const [variant] = await db.select({ id: schema.productVariants.id }).from(schema.productVariants).limit(1);
  if (variant) {
    const [receipt] = await db
      .insert(schema.stockReceipts)
      .values({ kind: "RECEIPT", receivedAt: new Date(Date.now() - 200 * 86_400_000), reference: REF, totalQuantity: 200, totalCost: 20_000_000, createdBy: "test" })
      .returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: variant.id, quantity: 200, unitCost: 100_000 });
    clearMemo();
  }

  const report = await getSlowMoving();
  assert.ok(report.rows.length > 0, "phải nhìn thấy lô hàng vừa nhập — nếu rỗng thì bài kiểm thử không kiểm được gì");

  let sumStock = 0;
  let sumExcess = 0;
  for (const r of report.rows) {
    // Chỉ mẫu mã CÓ tồn dương và BIẾT tồn mới được đưa vào — chưa có phiếu nhập thì tồn là CHƯA
    // BIẾT, và kết luận "vốn nằm chết" trên dữ liệu chưa biết là bịa.
    assert.ok(r.available > 0, `${r.sku}: chỉ xét mẫu mã còn hàng`);

    // Giá trị vốn theo GIÁ NHẬP: đây là tiền đã bỏ ra và chưa thu lại, không phải doanh thu có thể thu.
    assert.equal(r.stockValue, r.available * r.unitCost, `${r.sku}: giá trị vốn phải bằng số lượng × giá nhập`);
    assert.ok(r.excessValue <= r.stockValue + 1e-6, `${r.sku}: phần vốn vượt mức không thể lớn hơn tổng vốn của lô`);
    assert.ok(r.excessValue >= 0, `${r.sku}: phần vốn vượt mức không được âm`);

    // Không có vô cực: không bán được cái nào thì số ngày còn hàng là CHƯA BIẾT.
    if (r.velocity === 0) assert.equal(r.daysOfCover, null, `${r.sku}: không bán được cái nào thì không có số ngày còn hàng`);
    if (r.daysOfCover !== null) assert.ok(Number.isFinite(r.daysOfCover), `${r.sku}: số ngày còn hàng phải hữu hạn`);

    // Mỗi dòng phải nói được vì sao và nên làm gì.
    assert.ok(STOCK_RISK_LABEL[r.risk], `${r.sku}: nhãn rủi ro phải hợp lệ`);
    assert.ok(r.reason.length > 5, `${r.sku}: phải nói rõ vì sao xếp vào nhóm đó`);
    assert.ok(STOCK_RISK_ACTION[r.risk].length > 10, `${r.risk}: phải nói nên làm gì`);

    // Hàng LÀNH MẠNH thì không có phần vốn vượt mức — nếu không thì con số tổng sẽ báo động giả.
    if (r.risk === "HEALTHY") assert.equal(r.excessValue, 0, `${r.sku}: hàng bình thường không được tính là vốn nằm chết`);
    // Phân loại phải khớp ngưỡng, không phải cảm tính.
    if (r.risk === "EXCESS") assert.ok((r.daysOfCover ?? 0) > SLOW_MOVING_RULES.excessCoverDays, `${r.sku}: xếp vốn nằm chết thì phải vượt ngưỡng`);
    if (r.risk === "DEAD") assert.equal(r.velocity, 0, `${r.sku}: hàng chết thì tốc độ bán phải bằng 0`);

    sumStock += r.stockValue;
    sumExcess += r.excessValue;
  }

  // Tổng phải cộng đúng — nếu không thì con số trên thẻ và bảng nói hai chuyện khác nhau.
  assert.ok(Math.abs(sumStock - report.totalStockValue) < 1, "tổng vốn tồn phải bằng tổng từng dòng");
  assert.ok(Math.abs(sumExcess - report.totalExcessValue) < 1, "tổng vốn nằm chết phải bằng tổng từng dòng");
  assert.ok(report.totalExcessValue <= report.totalStockValue + 1, "vốn nằm chết không thể vượt tổng vốn tồn");

  const counted = (Object.keys(report.byRisk) as StockRisk[]).reduce((t, k) => t + report.byRisk[k].count, 0);
  assert.equal(counted, report.rows.length, "cộng theo nhóm rủi ro phải bằng tổng số dòng");

  // Xếp theo vốn nằm chết giảm dần — đó là thứ đáng xả trước.
  for (let i = 1; i < report.rows.length; i += 1) {
    assert.ok(report.rows[i - 1].excessValue >= report.rows[i].excessValue, "phải xếp theo vốn nằm chết giảm dần");
  }

  // Lô 200 cái nhập từ 200 ngày trước, không bán được cái nào ⇒ HÀNG CHẾT, và TOÀN BỘ vốn là vốn
  // nằm chết: không có nhịp bán nào để giữ lại phần nào cả.
  if (variant) {
    const target = report.rows.find((r) => r.variantId === variant.id);
    assert.ok(target, "lô hàng vừa nhập phải có mặt trong bảng");
    assert.equal(target.risk, "DEAD", "nhập 200 ngày trước, không bán được cái nào ⇒ hàng chết");
    assert.equal(target.velocity, 0);
    assert.equal(target.daysOfCover, null, "không bán được cái nào thì KHÔNG có số ngày còn hàng");
    assert.equal(target.excessValue, target.stockValue, "hàng chết thì toàn bộ vốn là vốn nằm chết");
    assert.ok(target.stockValue > 0, "phải quy được ra tiền theo giá nhập");

    await db.delete(schema.stockReceipts).where(eq(schema.stockReceipts.reference, REF));
    clearMemo();
    const after = await getSlowMoving();
    assert.ok(!after.rows.some((r) => r.variantId === variant.id && r.risk === "DEAD" && r.available >= 200), "dữ liệu dựng cho kiểm thử phải được dọn sạch");
  }

  console.log(
    `✓ Hàng bán chậm: ${report.rows.length} mẫu mã còn hàng · ${report.byRisk.DEAD.count} chết · ${report.byRisk.EXCESS.count} vốn nằm chết · ${Math.round(report.totalExcessValue).toLocaleString("vi-VN")}đ vốn vượt mức trên tổng ${Math.round(report.totalStockValue).toLocaleString("vi-VN")}đ`,
  );
}
