import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PURCHASING_RULE, UNKNOWN_SUPPLIER } from "@/lib/constants/purchasing";
import { getPurchasingReport, matchProductionToReceipts } from "@/lib/queries/purchasing";

/**
 * ───────── MUA HÀNG & XƯỞNG ─────────
 *
 * Điều phải khoá ở đây là ranh giới giữa BIẾT và ĐOÁN.
 *
 * Đơn sản xuất không có cột "ngày nhận hàng". Cách dễ nhất để có một con số "thời gian giao" là lấy
 * `updated_at` của đơn — và đó là con số bịa, vì `updated_at` đổi theo mọi lần sửa ghi chú. Cách
 * đúng là ghép lô đặt với phiếu nhập kho thật, và **chỉ ghép khi một-một**. Bài kiểm thử này chặn
 * đúng chỗ dễ trượt: ghép bừa khi có nhiều ứng viên, hoặc lặng lẽ biến CHƯA BIẾT thành 0.
 */

const DAY = 86_400_000;

function poFixture(id: string, sentAt: Date, opts: { productId?: string; supplier?: string; dueDate?: Date } = {}) {
  return {
    id,
    code: id.toUpperCase(),
    productId: opts.productId ?? "pur-prod",
    supplier: opts.supplier ?? "Xưởng A",
    sentAt,
    dueDate: opts.dueDate ?? null,
  };
}

function receiptFixture(id: string, receivedAt: Date, opts: { productIds?: string[]; supplier?: string } = {}) {
  return { id, supplier: opts.supplier ?? "Xưởng A", receivedAt, productIds: opts.productIds ?? ["pur-prod"] };
}

export async function testPurchasing(db: Db) {
  clearMemo();
  const base = new Date("2026-05-01T03:00:00Z");
  const plus = (days: number) => new Date(base.getTime() + days * DAY);

  // ───────── 1. Ghép một-một: đúng một lô, đúng một phiếu ─────────
  {
    const r = matchProductionToReceipts([poFixture("po-1", base)], [receiptFixture("r-1", plus(12))]);
    assert.equal(r.matched.length, 1, "một lô ứng với đúng một phiếu thì phải ghép được");
    assert.equal(r.matched[0].leadDays, 12, "thời gian giao tính từ ngày gửi xưởng tới ngày lập phiếu nhập");
    assert.equal(r.ambiguous.length, 0);
    assert.equal(r.unmatched.length, 0);
  }

  // ───────── 2. Hai lô cùng mẫu, hai phiếu ⇒ NHẬP NHẰNG, tuyệt đối không bốc đại ─────────
  // Đây là ca dễ sai nhất: cả hai lô đều "hợp lý" với cả hai phiếu. Ghép theo thứ tự thời gian
  // trông rất thuyết phục nhưng không có gì bảo đảm phiếu đầu là của lô đầu.
  {
    const r = matchProductionToReceipts(
      [poFixture("po-1", base), poFixture("po-2", plus(1))],
      [receiptFixture("r-1", plus(10)), receiptFixture("r-2", plus(20))],
    );
    assert.equal(r.matched.length, 0, "nhiều ứng viên thì KHÔNG được ghép — thà chưa biết còn hơn biết sai");
    assert.equal(r.ambiguous.length, 2, "cả hai lô phải nằm ở nhóm nhập nhằng");
  }

  // ───────── 3. Một phiếu nhưng hai lô cùng nhận là của mình ⇒ vẫn nhập nhằng ─────────
  // Mỗi lô chỉ thấy MỘT ứng viên, nhưng ứng viên đó bị hai lô tranh nhau. Chỉ kiểm một chiều là
  // ghép sai cả hai.
  {
    const r = matchProductionToReceipts([poFixture("po-1", base), poFixture("po-2", plus(2))], [receiptFixture("r-1", plus(9))]);
    assert.equal(r.matched.length, 0, "một phiếu bị hai lô tranh thì không kết luận được cho lô nào");
    assert.equal(r.ambiguous.length, 2);
  }

  // ───────── 4. Phiếu trước ngày gửi, hoặc quá xa, thì không phải của lô này ─────────
  {
    const truoc = matchProductionToReceipts([poFixture("po-1", plus(30))], [receiptFixture("r-1", plus(10))]);
    assert.equal(truoc.unmatched.length, 1, "phiếu lập TRƯỚC khi gửi xưởng không thể là hàng của lô đó");

    const qua_xa = matchProductionToReceipts([poFixture("po-1", base)], [receiptFixture("r-1", plus(PURCHASING_RULE.maxLeadDays + 1))]);
    assert.equal(qua_xa.unmatched.length, 1, `xa hơn ${PURCHASING_RULE.maxLeadDays} ngày thì gần như chắc chắn là lô khác`);
  }

  // ───────── 5. Khác xưởng thì không ghép; thiếu tên xưởng thì không loại oan ─────────
  {
    const khac = matchProductionToReceipts([poFixture("po-1", base, { supplier: "Xưởng A" })], [receiptFixture("r-1", plus(5), { supplier: "Xưởng B" })]);
    assert.equal(khac.matched.length, 0, "hai bên khai hai xưởng khác nhau thì không phải một lô");

    const thieu = matchProductionToReceipts([poFixture("po-1", base, { supplier: "" })], [receiptFixture("r-1", plus(5), { supplier: "Xưởng B" })]);
    assert.equal(thieu.matched.length, 1, "một bên bỏ trống tên xưởng là THIẾU DỮ LIỆU, không phải bằng chứng khác xưởng");
  }

  // ───────── 6. Khác mẫu thì không ghép ─────────
  {
    const r = matchProductionToReceipts([poFixture("po-1", base)], [receiptFixture("r-1", plus(5), { productIds: ["mau-khac"] })]);
    assert.equal(r.unmatched.length, 1, "phiếu nhập mẫu khác không phải hàng của lô này");
  }

  // ───────── 7. Đúng hạn tính theo hạn hẹn, không có hạn thì để CHƯA BIẾT ─────────
  {
    const dung = matchProductionToReceipts([poFixture("po-1", base, { dueDate: plus(15) })], [receiptFixture("r-1", plus(12))]);
    assert.equal(dung.matched[0].onTime, true);

    const tre = matchProductionToReceipts([poFixture("po-2", base, { dueDate: plus(10) })], [receiptFixture("r-2", plus(12))]);
    assert.equal(tre.matched[0].onTime, false);

    const khong_han = matchProductionToReceipts([poFixture("po-3", base)], [receiptFixture("r-3", plus(12))]);
    assert.equal(khong_han.matched[0].onTime, null, "lô không ghi hạn thì đúng hạn là CHƯA BIẾT, không phải trễ");
  }

  // ───────── 8. Báo cáo thật trên CSDL: cam kết, quá hạn, giá nhập tăng, độ phủ ─────────
  const poIds = ["pur-po-open", "pur-po-late", "pur-po-done"];
  const receiptIds = ["pur-rc-1", "pur-rc-2"];
  const truoc = await getPurchasingReport(90);
  try {
    await db.insert(schema.products).values({ id: "pur-prod", name: "Áo kiểm thử mua hàng" }).onConflictDoNothing();
    await db
      .insert(schema.productVariants)
      .values({ id: "pur-var", productId: "pur-prod", sku: "PUR-001", color: "Đen", size: "M", retailPrice: 499000 })
      .onConflictDoNothing();

    const now = Date.now();
    const at = (daysAgo: number) => new Date(now - daysAgo * DAY);
    await db.insert(schema.productionOrders).values([
      // Lô đã gửi, còn hạn → cam kết nhưng chưa trễ.
      { id: poIds[0], code: "PUR-OPEN", productId: "pur-prod", productName: "Áo kiểm thử mua hàng", status: "SENT", supplier: "Xưởng kiểm thử", totalQty: 100, unitCost: 90_000, sentAt: at(10), dueDate: at(-20) },
      // Lô đã gửi, quá hạn 5 ngày.
      { id: poIds[1], code: "PUR-LATE", productId: "pur-prod", productName: "Áo kiểm thử mua hàng", status: "SENT", supplier: "Xưởng kiểm thử", totalQty: 50, unitCost: 100_000, sentAt: at(40), dueDate: at(5) },
      // Lô đã nhận, có đúng một phiếu nhập tương ứng → ghép được.
      { id: poIds[2], code: "PUR-DONE", productId: "pur-prod", productName: "Áo kiểm thử mua hàng", status: "RECEIVED", supplier: "Xưởng kiểm thử", totalQty: 30, unitCost: 80_000, sentAt: at(30), dueDate: at(12) },
    ]);
    await db.insert(schema.stockReceipts).values([
      { id: receiptIds[0], kind: "RECEIPT", receivedAt: at(60), supplier: "Xưởng kiểm thử", reference: "PUR-1", totalQuantity: 10, totalCost: 800_000 },
      { id: receiptIds[1], kind: "RECEIPT", receivedAt: at(20), supplier: "Xưởng kiểm thử", reference: "PUR-2", totalQuantity: 10, totalCost: 1_000_000 },
    ]);
    await db.insert(schema.stockReceiptItems).values([
      { id: "pur-rci-1", receiptId: receiptIds[0], variantId: "pur-var", quantity: 10, unitCost: 80_000 },
      { id: "pur-rci-2", receiptId: receiptIds[1], variantId: "pur-var", quantity: 10, unitCost: 100_000 },
    ]);

    clearMemo();
    const r = await getPurchasingReport(90);

    // Cam kết = số lượng × đơn giá của các lô ĐÃ GỬI, không tính lô đã nhận.
    const camKet = 100 * 90_000 + 50 * 100_000;
    assert.equal(r.open.committed - truoc.open.committed, camKet, "tiền cam kết phải đúng bằng số lượng × đơn giá của lô đã gửi chưa nhận");
    assert.equal(r.open.count - truoc.open.count, 2, "chỉ lô SENT mới là cam kết đang mở");
    assert.ok(r.open.overdueCount >= 1, "lô quá hạn hẹn phải được đếm");
    assert.ok((r.open.maxLateDays ?? 0) >= 5, "phải biết lô trễ nhất trễ bao nhiêu ngày");
    assert.ok(
      r.openOrders.some((o) => o.code === "PUR-LATE" && (o.lateDays ?? 0) >= 5),
      "lô quá hạn phải có mặt trong danh sách kèm số ngày trễ",
    );
    assert.ok(
      r.openOrders.every((o) => o.committed >= 0 && Number.isInteger(o.committed)),
      "tiền là số nguyên VND, không âm",
    );

    // Giá nhập của cùng mẫu mã tăng 80K → 100K = +25% ⇒ phải nêu ra.
    const jump = r.priceJumps.find((j) => j.sku === "PUR-001");
    assert.ok(jump, "mẫu mã có lần nhập gần nhất đắt hơn lần trước phải được nêu");
    assert.equal(jump?.previousCost, 80_000);
    assert.equal(jump?.latestCost, 100_000);
    assert.equal(jump?.changePercent, 25);

    // Xưởng: giá bình quân kỳ này có căn cứ; lô ghép được đúng một.
    const xuong = r.suppliers.find((s) => s.supplier === "Xưởng kiểm thử");
    assert.ok(xuong, "xưởng có phát sinh phải xuất hiện trong bảng");
    assert.equal(xuong?.avgUnitCost, 90_000, "giá nhập bình quân gia quyền của hai phiếu 80K và 100K cùng số lượng là 90K");
    assert.equal(xuong?.committed, camKet, "cam kết theo xưởng phải khớp với tổng cam kết của xưởng đó");
    assert.equal(xuong?.leadMatched, 1, "lô đã nhận ghép được đúng một phiếu");
    assert.equal(
      xuong?.leadDaysP50,
      null,
      `một lô chưa đủ ${PURCHASING_RULE.minLeadSamples} mẫu — phải để trống thay vì xếp hạng xưởng theo một lô lẻ`,
    );

    assert.equal(
      xuong?.onTimeRate,
      null,
      "một lô đúng hạn KHÔNG được hiện thành 'đúng hạn 100%' — con số đó đọc như một xưởng hoàn hảo",
    );
    assert.equal(xuong?.onTimeBasis, 1, "vẫn phải nói ra có bao nhiêu lô làm căn cứ, để người đọc biết vì sao còn trống");

    // CHƯA BIẾT ≠ 0.
    for (const s of r.suppliers) {
      assert.ok(s.avgUnitCost === null || s.avgUnitCost > 0, `${s.supplier}: giá bình quân phải là null khi chưa khai giá, không phải 0`);
      assert.ok(s.onTimeRate === null || s.onTimeBasis >= PURCHASING_RULE.minLeadSamples, `${s.supplier}: chỉ được nêu tỷ lệ đúng hạn khi đủ số lô làm căn cứ`);
      assert.ok(s.leadDaysP50 === null || s.leadMatched >= PURCHASING_RULE.minLeadSamples, `${s.supplier}: chỉ được nêu thời gian giao khi đủ số lô`);
    }

    // Ba nhóm ghép phải rời nhau và cộng đúng tổng.
    const tong = r.coverage.leadMatched + r.coverage.leadAmbiguous + r.coverage.leadUnmatched;
    assert.ok(tong >= 1, "phải có ít nhất lô vừa dựng để xét");
    if (r.coverage.leadCoveragePercent !== null) {
      assert.equal(r.coverage.leadCoveragePercent, Math.round((r.coverage.leadMatched / tong) * 1000) / 10, "độ phủ ghép phải đúng bằng ghép được / tổng");
    }

    // Không được im lặng: phải nói rõ cái gì là ước tính và cái gì ERP không biết.
    assert.ok(r.estimated.some((e) => e.includes("ƯỚC TÍNH")), "phải nói thẳng thời gian giao là ước tính");
    assert.ok(r.limitations.some((l) => l.includes("KHÔNG có cột ngày nhận hàng")), "phải nói rõ giới hạn gốc của dữ liệu");
    assert.ok(r.limitations.some((l) => l.includes("CHỈ ĐỌC")), "phải khẳng định ranh giới chỉ-đọc");

    // Cửa sổ lạ không được làm sập trang, phải rơi về mặc định.
    clearMemo();
    const la = await getPurchasingReport(7);
    assert.equal(la.windowDays, PURCHASING_RULE.defaultWindowDays, "cửa sổ ngoài danh sách cho phép phải rơi về mặc định");

    assert.equal(UNKNOWN_SUPPLIER.length > 3, true, "phải có nhãn tiếng Việt cho phiếu không ghi xưởng");
  } finally {
    // Dọn sạch: bộ kiểm thử dùng CHUNG một CSDL, để lại phiếu nhập là làm lệch tồn kho của bài khác.
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receiptIds));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receiptIds));
    await db.delete(schema.productionOrders).where(inArray(schema.productionOrders.id, poIds));
    clearMemo();
  }

  console.log(
    `✓ Mua hàng & xưởng: ghép lô ↔ phiếu nhập một-một (nhập nhằng KHÔNG ghép, 7 ca) · cam kết và quá hạn tính đúng · giá nhập +25% được nêu · CHƯA BIẾT không thành 0`,
  );
}
