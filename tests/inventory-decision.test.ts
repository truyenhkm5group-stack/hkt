import assert from "node:assert/strict";
import type { Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  DECISION_ACTION,
  DECISION_LABEL,
  DECISION_RULE,
  decideInventory,
  type DecisionInput,
} from "@/lib/constants/inventory-decision";
import { SLOW_MOVING_RULES } from "@/lib/constants/slow-moving";
import { backtestInventoryDecisions, getInventoryDecisionReport } from "@/lib/queries/inventory-decision";

/**
 * QUYẾT ĐỊNH VỐN TỒN KHO.
 *
 * Điều phải khoá: CHƯA BIẾT không bao giờ thành 0 (thiếu giá nhập ⇒ tiền vốn `null`; chưa có phiếu
 * nhập ⇒ không kết luận); mẫu mới không bị kết tội hàng chết; hàng đã đặt xưởng phải được trừ khỏi
 * đề xuất; và mọi kết luận đều nói được lý do.
 */

/** Đầu vào nền: mẫu mã bình thường, đủ dữ liệu — từng ca kiểm chỉ đổi đúng chiều nó muốn thử. */
function base(over: Partial<DecisionInput> = {}): DecisionInput {
  return {
    stockKnown: true,
    stock: 50,
    available: 40,
    incomingFromReturns: 0,
    openPoQty: 0,
    velocity: 2,
    velocityTrimmed: false,
    soldInWindow: 28,
    sold30: 60,
    daysOfCover: 20,
    leadTimeDays: 7,
    leadTimeSource: "override",
    safetyDays: 3,
    suggested: 0,
    unitCost: 100_000,
    retailPrice: 300_000,
    returnRate: 0.2,
    returnRateSource: "variant",
    daysSinceLastSale: 1,
    ageDays: 120,
    ...over,
  };
}

export async function testInventoryDecision(db: Db) {
  // ───────── 1. Hết hàng mà vẫn bán ⇒ NGUY CƠ HẾT HÀNG, có tiền vốn và ước lãi gộp mất ─────────
  {
    const r = decideInventory(base({ stock: 0, available: 0, daysOfCover: 0, suggested: 30 }));
    assert.equal(r.decision, "STOCKOUT_RISK", "tồn 0 mà đang bán phải là nguy cơ hết hàng");
    assert.equal(r.suggestedQty, 30);
    assert.equal(r.capitalRequired, 30 * 100_000, "tiền vốn = số đặt × giá nhập");
    // Ước lãi gộp mất = tốc độ × leadTime × biên × (1 − tỷ lệ hoàn) — phải là ước tính DƯƠNG.
    assert.equal(r.grossImpactEstimate, Math.round(2 * 7 * 200_000 * 0.8), "ước lãi gộp mất phải tính đúng công thức");
    assert.ok(r.reason.length > 10, "phải nói được vì sao");
  }

  // ───────── 2. Khả dụng ÂM: có bán ⇒ vẫn báo hết hàng nhưng tin cậy THẤP + ghi chú kiểm kê;
  //            không bán ⇒ sổ lệch, KHÔNG đề xuất gì ─────────
  {
    const dangBan = decideInventory(base({ available: -5, daysOfCover: 0, suggested: 20 }));
    assert.equal(dangBan.decision, "STOCKOUT_RISK");
    assert.equal(dangBan.confidence, "LOW", "tồn âm là số liệu lệch — không được nói chắc");
    assert.ok(dangBan.notes.some((n) => n.includes("kiểm kê")), "phải nhắc kiểm kê khi tồn âm");
    const khongBan = decideInventory(base({ available: -5, velocity: 0, soldInWindow: 0, sold30: 0, daysOfCover: null }));
    assert.equal(khongBan.decision, "DATA_INSUFFICIENT", "tồn âm không nhịp bán = sổ kho lệch, không phải việc đặt hàng");
    assert.equal(khongBan.suggestedQty, null, "không được đề xuất số nào trên sổ lệch");
  }

  // ───────── 3. Hàng ĐÃ ĐẶT XƯỞNG phải được trừ: cam kết 60 cái phủ nhu cầu 50 ⇒ GIỮ NGUYÊN ─────────
  {
    const r = decideInventory(base({ daysOfCover: 12, suggested: 50, openPoQty: 60 }));
    assert.equal(r.decision, "HOLD", "nhu cầu đã được đơn xưởng đang mở phủ đủ thì không kêu đặt thêm");
    assert.ok(r.reason.includes("đặt xưởng"), "phải nói rõ nhu cầu được phủ bởi đơn xưởng");
    const thieu = decideInventory(base({ daysOfCover: 12, suggested: 50, openPoQty: 20 }));
    assert.equal(thieu.decision, "REORDER");
    assert.equal(thieu.suggestedQty, 30, "đề xuất = nhu cầu − hàng đã đặt xưởng");
    assert.equal(thieu.capitalRequired, 30 * 100_000);
  }

  // ───────── 4. Mẫu hoàn cao: cảnh báo trong ghi chú và tin cậy không còn CAO ─────────
  {
    const r = decideInventory(base({ daysOfCover: 12, suggested: 40, returnRate: 0.5, returnRateSource: "variant" }));
    assert.equal(r.decision, "REORDER");
    assert.ok(r.notes.some((n) => n.includes("hoàn")), "tỷ lệ hoàn cao phải được nói ra");
    assert.notEqual(r.confidence, "HIGH", "đặt thêm cho mẫu hoàn 50% không thể là kết luận đủ căn cứ");
  }

  // ───────── 5. MẪU MỚI chưa bán được: KHÔNG phải hàng chết — chờ, tin cậy THẤP ─────────
  {
    const r = decideInventory(base({ velocity: 0, soldInWindow: 0, sold30: 0, daysOfCover: null, daysSinceLastSale: null, ageDays: 5 }));
    assert.equal(r.decision, "HOLD", `mẫu ${5} ngày tuổi chưa bán không được kết tội hàng chết`);
    assert.equal(r.confidence, "LOW");
    assert.ok(r.reason.includes("Mẫu mới"), "phải nói rõ là mẫu mới chưa đủ lịch sử");
  }

  // ───────── 6. ĐỘT BIẾN (livestream): cờ cắt tốc độ phải kéo tin cậy xuống và được nói ra ─────────
  {
    const r = decideInventory(base({ velocityTrimmed: true, daysOfCover: 10, suggested: 25 }));
    assert.ok(r.notes.some((n) => n.includes("đột biến")), "ngày đột biến phải được nói ra");
    assert.notEqual(r.confidence, "HIGH");
  }

  // ───────── 7. THIẾU GIÁ NHẬP: tiền vốn là CHƯA BIẾT (`null`), tuyệt đối không phải 0đ ─────────
  {
    const r = decideInventory(base({ daysOfCover: 3, suggested: 40, unitCost: null }));
    assert.equal(r.decision, "STOCKOUT_RISK");
    assert.equal(r.capitalRequired, null, "thiếu giá nhập thì tiền vốn phải là null, không phải 0");
    assert.equal(r.grossImpactEstimate, null, "thiếu giá nhập thì không ước được lãi gộp");
    assert.ok(r.notes.some((n) => n.includes("giá nhập")));
    const chet = decideInventory(base({ velocity: 0, soldInWindow: 0, sold30: 0, daysOfCover: null, daysSinceLastSale: 200, unitCost: null }));
    assert.equal(chet.decision, "CLEARANCE_CANDIDATE");
    assert.equal(chet.capitalFreeable, null, "vốn giải phóng cũng CHƯA BIẾT khi thiếu giá nhập");
  }

  // ───────── 8. THIẾU THỜI GIAN SẢN XUẤT: không bịa hạn đặt, vẫn kết luận được phần còn lại ─────────
  {
    const r = decideInventory(base({ leadTimeDays: null, leadTimeSource: null, daysOfCover: 10, suggested: 20 }));
    assert.equal(r.decision, "REORDER", "thiếu lead time vẫn đặt được theo nhu cầu, chỉ không nói được hạn");
    assert.ok(r.notes.some((n) => n.includes("thời gian sản xuất")), "phải nói CHƯA BIẾT thời gian sản xuất");
    const hetHang = decideInventory(base({ available: 0, daysOfCover: 0, leadTimeDays: null, leadTimeSource: null, suggested: 20 }));
    assert.equal(hetHang.decision, "STOCKOUT_RISK", "đã hết hàng thì thiếu lead time không che được việc đang mất doanh thu");
    assert.equal(hetHang.grossImpactEstimate, null, "không biết trống hàng bao lâu thì không ước tiền — không bịa");
  }

  // ───────── 9. BÁN CHẬM (tồn 130 ngày) ⇒ CHÔN VỐN, vốn giải phóng = phần vượt mức × giá nhập ─────────
  {
    const available = 130;
    const velocity = 1;
    const r = decideInventory(base({ stock: 135, available, velocity, soldInWindow: 14, daysOfCover: 130 }));
    assert.equal(r.decision, "OVERSTOCK");
    const excess = available - Math.ceil(velocity * SLOW_MOVING_RULES.healthyCoverDays);
    assert.equal(r.excessQty, excess, "phần vượt mức = khả dụng − mức đủ bán lành mạnh");
    assert.equal(r.capitalFreeable, excess * 100_000);
    assert.ok((r.suggestedQty ?? 0) === 0 || r.suggestedQty === null, "đang chôn vốn thì không được đề xuất đặt thêm");
  }

  // ───────── 10. BÁN NHANH, đủ dữ liệu ⇒ REORDER tin cậy CAO; đủ hàng thật sự ⇒ HOLD ─────────
  {
    const r = decideInventory(base({ velocity: 8, soldInWindow: 112, sold30: 240, daysOfCover: 9, suggested: 80 }));
    assert.equal(r.decision, "REORDER");
    assert.equal(r.confidence, "HIGH", "đủ mọi chiều dữ liệu thì phải dám nói chắc");
    assert.equal(r.capitalRequired, 80 * 100_000);
    const on = decideInventory(base({ daysOfCover: 30, suggested: 0 }));
    assert.equal(on.decision, "HOLD");
  }

  // ───────── Hàng chết lâu ngày ⇒ NÊN XẢ, giải phóng TOÀN BỘ tồn theo giá nhập ─────────
  {
    const r = decideInventory(base({ velocity: 0, soldInWindow: 0, sold30: 0, daysOfCover: null, available: 80, daysSinceLastSale: null, ageDays: 200 }));
    assert.equal(r.decision, "CLEARANCE_CANDIDATE", "nhập 200 ngày chưa bán cái nào là hàng chết");
    assert.equal(r.excessQty, 80, "hàng chết thì toàn bộ tồn là vượt mức");
    assert.equal(r.capitalFreeable, 80 * 100_000);
  }

  // ───────── Ngừng bán nhưng CHƯA tới ngưỡng hàng chết ⇒ giữ nguyên, không kết tội sớm ─────────
  {
    const r = decideInventory(base({ velocity: 0, soldInWindow: 0, sold30: 0, daysOfCover: null, daysSinceLastSale: SLOW_MOVING_RULES.deadDays - 10, ageDays: 100 }));
    assert.equal(r.decision, "HOLD", "chưa đủ ngày im ắng thì chưa được gọi là hàng chết");
  }

  // ───────── Chưa có phiếu nhập ⇒ DATA_INSUFFICIENT, không một con số đề xuất nào ─────────
  {
    const r = decideInventory(base({ stockKnown: false }));
    assert.equal(r.decision, "DATA_INSUFFICIENT");
    assert.equal(r.suggestedQty, null);
    assert.equal(r.capitalRequired, null);
  }

  // ───────── Mọi nhãn quyết định phải có nhãn tiếng Việt + hành động ─────────
  for (const k of Object.keys(DECISION_LABEL) as (keyof typeof DECISION_LABEL)[]) {
    assert.ok(DECISION_LABEL[k].length > 2, `thiếu nhãn cho ${k}`);
    assert.ok(DECISION_ACTION[k].length > 10, `quyết định ${k} phải nói nên làm gì`);
  }
  assert.ok(DECISION_RULE.minHistoryDays >= 7, "mẫu mới phải được cho ít nhất một tuần lịch sử");

  // ───────── Mức DB: báo cáo phải tự nhất quán trên dữ liệu mẫu ─────────
  void db;
  clearMemo();
  const report = await getInventoryDecisionReport();
  const counted = Object.values(report.byDecision).reduce((t, n) => t + n, 0);
  assert.equal(counted, report.summary.variants, "cộng theo nhóm quyết định phải bằng tổng mẫu mã theo dõi");
  assert.equal(report.byDecision.HOLD, report.holdCount, "số mẫu giữ nguyên trên thẻ phải khớp phân nhóm");
  assert.equal(report.rows.length + report.holdCount, report.summary.variants, "bảng + giữ nguyên phải phủ đủ mọi mẫu");
  let capReq = 0;
  for (const r of report.rows) {
    assert.ok(DECISION_LABEL[r.decision], `${r.sku}: nhãn quyết định hợp lệ`);
    assert.notEqual(r.decision, "HOLD", "bảng không hiện dòng giữ nguyên");
    assert.ok(r.reason.length > 10, `${r.sku}: phải có lý do đọc được`);
    if (r.daysOfCover !== null) assert.ok(Number.isFinite(r.daysOfCover), `${r.sku}: không hiện vô cực`);
    if (r.unitCost === null) {
      assert.equal(r.capitalRequired === null || r.capitalRequired === 0, true, `${r.sku}: thiếu giá nhập thì tiền vốn không được là số dương bịa`);
      assert.equal(r.capitalFreeable, null, `${r.sku}: thiếu giá nhập thì vốn giải phóng phải CHƯA BIẾT`);
    }
    if (r.decision === "DATA_INSUFFICIENT" && !r.stock) assert.equal(r.suggestedQty, null, `${r.sku}: chưa đủ dữ liệu thì không đề xuất`);
    if ((r.decision === "STOCKOUT_RISK" || r.decision === "REORDER") && r.capitalRequired !== null) capReq += r.capitalRequired;
  }
  assert.equal(capReq, report.summary.capitalRequired, "tổng vốn cần trên thẻ phải bằng cộng từng dòng");
  assert.ok(report.summary.capitalFreeable >= 0 && Number.isFinite(report.summary.capitalFreeable));
  // Thứ tự: việc mất tiền ngay đứng trước việc tiền nằm chờ.
  const ranks = report.rows.map((r) => ["STOCKOUT_RISK", "REORDER", "OVERSTOCK", "CLEARANCE_CANDIDATE", "DATA_INSUFFICIENT", "HOLD"].indexOf(r.decision));
  for (let i = 1; i < ranks.length; i += 1) assert.ok(ranks[i - 1] <= ranks[i], "bảng phải xếp theo mức khẩn cấp");

  // ───────── Đối chứng lịch sử: dựng một lô nhập 100 ngày trước, không bán được cái nào —
  //            tại mốc 30 ngày trước bộ máy phải thấy nó và báo NÊN XẢ, và sau đó nó thật sự
  //            tiếp tục không bán. Dọn sạch ở cuối để không đổi tồn của khối kiểm thử khác. ─────────
  const REF = "test-inv-decision-backtest";
  const { schema } = await import("@/db");
  const { eq, sql } = await import("drizzle-orm");
  // Chọn mẫu mã CHƯA có đơn giao thành công nào trước mốc cắt — không dựa vào thứ tự ngẫu nhiên của `limit 1`.
  const [variant] =
    (await db
      .select({ id: schema.productVariants.id })
      .from(schema.productVariants)
      .where(sql`not exists (select 1 from order_items oi where oi.variant_id = ${schema.productVariants.id})`)
      .orderBy(schema.productVariants.id)
      .limit(1)) ?? [];
  assert.ok(variant, "fixture phải có ít nhất một mẫu mã");
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: new Date(Date.now() - 100 * 86_400_000), reference: REF, totalQuantity: 40, totalCost: 4_800_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: receipt.id, variantId: variant.id, quantity: 40, unitCost: 120_000 });
  clearMemo();

  const bt = await backtestInventoryDecisions(30);
  assert.ok(bt.evaluated >= 1, "lô nhập 100 ngày trước phải được đánh giá tại mốc cắt — 0 mẫu nghĩa là backtest không kiểm được gì");
  assert.ok(bt.clearance.predicted >= 1, "mẫu nhập 70 ngày trước mốc cắt mà chưa bán cái nào phải bị báo NÊN XẢ tại mốc đó");
  assert.ok(bt.clearance.noSales >= 1, "và sau mốc cắt nó thật sự tiếp tục không bán — dự báo phải được xác nhận");
  assert.ok(bt.stockout.confirmed <= bt.stockout.predicted, "số xác nhận không thể vượt số dự báo");
  assert.ok(bt.overstock.stillExcess <= bt.overstock.predicted);
  assert.ok(bt.clearance.noSales <= bt.clearance.predicted);
  assert.ok(bt.notes.some((n) => n.includes("ƯỚC TÍNH")), "backtest phải tự nhận là ước tính");

  await db.delete(schema.stockReceipts).where(eq(schema.stockReceipts.reference, REF));
  clearMemo();

  console.log(`✓ Quyết định vốn tồn kho: ${report.summary.variants} mẫu theo dõi, ${report.rows.length} cần hành động, backtest ${bt.evaluated} mẫu tại mốc ${bt.daysBack} ngày`);
}
