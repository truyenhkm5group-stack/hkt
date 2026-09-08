import assert from "node:assert/strict";
import type { Db } from "@/db";
import { VERDICT_LABEL, VERDICT_RULES, classifyProduct, type VerdictInput } from "@/lib/constants/product-verdict";
import { adSpendByProduct, getProductIntelligence } from "@/lib/queries/product-intelligence";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** Một mẫu mã hoàn hảo, dùng làm gốc rồi phá từng chiều một. */
const GOOD: VerdictInput = {
  deliveredQty: 50,
  successRate: 90,
  returnRate: 10,
  deliveredRevenue: 20_000_000,
  contribution: 8_000_000,
  adSpend: 3_000_000,
  daysOfCover: 30,
  available: 100,
};

/**
 * PHÂN LOẠI MẪU MÃ.
 *
 * Điều phải khoá: "đáng nhân bản" cần ĐỦ CẢ SÁU chiều; thiếu dữ liệu chiều nào thì KHÔNG phán.
 * Gắn nhãn "bán chạy" dựa trên hai chiều rồi để chủ shop đặt sản xuất hàng nghìn cái là thiệt hại
 * lớn nhất mà một báo cáo có thể gây ra.
 */
export async function testProductVerdict(db: Db) {
  void db;

  // ───────── 1. Đủ cả sáu mới được gọi là đáng nhân bản ─────────
  const winner = classifyProduct(GOOD);
  assert.equal(winner.verdict, "WINNER");
  assert.equal(winner.checks.length, 6, "phải xét đủ sáu chiều");
  assert.ok(winner.checks.every((c) => c.passed === true), "đáng nhân bản thì không chiều nào được trượt");

  // ───────── 2. THIẾU DỮ LIỆU thì KHÔNG phán, dù mọi chiều đo được đều đạt ─────────
  // Đây là chiều dễ bị bỏ qua nhất: một mẫu bán 100 cái, giao 95%, doanh thu cao — mà lãi gộp âm vì
  // tiền quảng cáo — vẫn là mẫu phải dừng, và chỉ chiều quảng cáo mới nói ra điều đó.
  const noAds = classifyProduct({ ...GOOD, adSpend: null });
  assert.equal(noAds.verdict, "INSUFFICIENT_DATA", "không biết chi quảng cáo thì KHÔNG được gọi là đáng nhân bản");
  assert.ok(noAds.reason.includes("chi quảng cáo"), "phải nói rõ chiều nào chưa xét được");

  const noCost = classifyProduct({ ...GOOD, contribution: null });
  assert.equal(noCost.verdict, "INSUFFICIENT_DATA", "không biết giá vốn thì KHÔNG được gọi là đáng nhân bản");

  const noStock = classifyProduct({ ...GOOD, daysOfCover: null, available: null });
  assert.equal(noStock.verdict, "INSUFFICIENT_DATA", "chưa có phiếu nhập thì chưa xét được sức khoẻ tồn kho");

  // ───────── 3. Lãi gộp âm là kết luận dứt khoát ─────────
  const losing = classifyProduct({ ...GOOD, contribution: -1_000_000 });
  assert.equal(losing.verdict, "LOSER", "lãi gộp âm thì bán càng nhiều càng lỗ");
  assert.ok(losing.reason.includes("âm"));

  // ───────── 4. Một dấu hiệu nặng là đủ để gọi là đáng lo ─────────
  // Cảnh báo sai làm mất một cơ hội; bỏ sót làm mất tiền thật.
  assert.equal(classifyProduct({ ...GOOD, returnRate: VERDICT_RULES.riskReturnRatePct, successRate: 60 }).verdict, "RISK", "tỷ lệ hoàn cao là đáng lo dù doanh thu đẹp");
  assert.equal(classifyProduct({ ...GOOD, successRate: 40, returnRate: 60 }).verdict, "RISK", "giao thành công dưới ngưỡng là hỏng, không phải dao động");
  assert.equal(classifyProduct({ ...GOOD, daysOfCover: VERDICT_RULES.stuckCoverDays + 1 }).verdict, "RISK", "tồn quá lâu là vốn nằm chết");

  // ───────── 5. Bán quá ít thì mọi tỷ lệ là nhiễu ─────────
  const tiny = classifyProduct({ ...GOOD, deliveredQty: 1, deliveredRevenue: 400_000 });
  assert.notEqual(tiny.verdict, "WINNER", "bán một cái không đủ để kết luận gì");
  assert.ok(tiny.checks.find((c) => c.key === "volume")?.passed === false);

  // ───────── 6. Mọi chiều phải giải thích được ─────────
  for (const c of winner.checks) assert.ok(c.detail.length > 5, `${c.label}: phải nói rõ con số và ngưỡng`);
  for (const v of Object.values(VERDICT_LABEL)) assert.ok(v.length > 0, "mọi nhãn phải có tiếng Việt");

  // ───────── 7. Chạy trên dữ liệu thật: không mẫu nào được phán bừa ─────────
  const rows = await getProductIntelligence({ period: ALL, limit: 50 });
  const adSpend = await adSpendByProduct(ALL);
  let winners = 0;
  for (const row of rows) {
    const result = classifyProduct({
      deliveredQty: row.deliveredQty,
      successRate: row.successRate,
      returnRate: row.returnRate,
      deliveredRevenue: row.deliveredRevenue,
      contribution: row.contribution,
      adSpend: row.productId ? (adSpend.get(row.productId) ?? null) : null,
      daysOfCover: row.daysOfCover,
      available: row.available,
    });
    assert.ok(VERDICT_LABEL[result.verdict], `${row.sku}: nhãn phải hợp lệ`);
    assert.ok(result.reason.length > 10, `${row.sku}: phải nói được vì sao`);
    if (result.verdict === "WINNER") {
      winners += 1;
      assert.ok(result.checks.every((c) => c.passed === true), `${row.sku}: gọi là đáng nhân bản thì phải đủ cả sáu chiều`);
    }
  }

  console.log(`✓ Phân loại mẫu mã: ${rows.length} mẫu mã · ${winners} đáng nhân bản (đủ CẢ SÁU chiều) · thiếu dữ liệu chiều nào thì KHÔNG phán`);
}
