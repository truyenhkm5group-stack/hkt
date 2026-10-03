import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import { clearanceFloor, type ClearanceFloorInput } from "@/lib/constants/clearance-floor";
import { opsCosts } from "@/lib/constants/profit";
import { RETURN_RULE } from "@/lib/constants/returns";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";

/**
 * GIÁ SÀN XẢ (`lib/constants/clearance-floor.ts`).
 *
 * Điều phải khoá: sàn là chi phí kỳ vọng của MỘT đơn gửi chia cho phần doanh thu THẬT SỰ về (không phải
 * "giá vốn + cước"); tỷ lệ giao chưa biết / bằng 0 thì KHÔNG có sàn; thiếu giá nhập thì chỉ có sàn tiền mặt;
 * làm tròn LÊN; và giá đơn rơi vào vùng luật tiền COD xếp là hoàn thì phải nói ra.
 */

const base = (over: Partial<ClearanceFloorInput> = {}): ClearanceFloorInput => ({
  unitCost: 100_000,
  deliveryRatePct: 50,
  deliverySource: "history",
  returnRecoveryRate: 1,
  shipFeeDelivered: 20_000,
  shipFeeReturned: 40_000,
  assumptions: { packingFeePerOrder: 5_000, opsStaffPerOrder: 2_000, opsStaffPerRescued: 10_000, rescueRatePercent: 10, taxPercent: 0 },
  retailPrice: 300_000,
  ...over,
});

export function testClearanceFloorPure() {
  // ───────── Ca tính tay: g = 50% ─────────
  //   đóng gói 5.000 + nhân công 2.000 + 10% × 10.000 = 8.000
  //   kỳ vọng / đơn gửi = 8.000 + 0,5 × 20.000 + 0,5 × 40.000 = 38.000
  //   sàn tiền mặt = 38.000 ÷ 0,5 = 76.000 · hoà vốn = (38.000 + 0,5 × 100.000) ÷ 0,5 = 176.000
  {
    const f = clearanceFloor(base());
    assert.equal(f.expectedCostPerSent, 38_000);
    assert.equal(f.cashFloor, 76_000, "sàn = chi phí kỳ vọng ÷ phần doanh thu thật sự về, không phải giá vốn + cước");
    assert.equal(f.bookFloor, 176_000);
    assert.equal(f.maxDiscountPct, 74, "giảm tối đa = 1 − sàn ÷ giá bán, làm tròn XUỐNG");
    assert.equal(f.belowCodRule, true, `76.000đ ≤ ${RETURN_RULE.maxCodForFakeDelivery}đ phải bị cảnh báo luật tiền COD`);
    assert.ok(f.notes.some((n) => n.includes("KHÔNG THÀNH CÔNG")));
    assert.equal(f.retailBelowCashFloor, false);
  }

  // ───────── Chi phí vận hành mỗi đơn phải đúng phép tính của báo cáo lợi nhuận danh nghĩa ─────────
  {
    const a = base().assumptions;
    const ops = opsCosts({ orders: 1, rescued: a.rescueRatePercent / 100 }, a);
    assert.equal(ops.packingCost + ops.opsStaffCost, 8_000);
  }

  // ───────── Thuế làm phần tiền về nhỏ đi ⇒ sàn cao hơn; làm tròn LÊN tới nghìn ─────────
  {
    const f = clearanceFloor(base({ assumptions: { ...base().assumptions, taxPercent: 10 } }));
    assert.equal(f.cashFloor, 85_000, "38.000 ÷ (0,5 × 0,9) = 84.444 ⇒ làm tròn LÊN 85.000, không phải 84.000");
  }

  // ───────── Hàng hoàn không nhập lại được thì mất thêm giá vốn ⇒ hoà vốn cao hơn; sàn tiền mặt không đổi ─────────
  {
    const f = clearanceFloor(base({ returnRecoveryRate: 0.5 }));
    assert.equal(f.bookFloor, 226_000, "(38.000 + 50.000 + 0,5 × 0,5 × 100.000) ÷ 0,5");
    assert.equal(f.cashFloor, 76_000, "giá vốn đã chi — sàn tiền mặt không phụ thuộc hàng hoàn có nhập lại được không");
  }

  // ───────── Giao 100% ⇒ không có đơn hoàn; tỷ lệ giao giảm ⇒ sàn tăng ─────────
  {
    const all = clearanceFloor(base({ deliveryRatePct: 100 }));
    assert.equal(all.cashFloor, 28_000);
    assert.equal(all.bookFloor, 128_000);
    const lo = clearanceFloor(base({ deliveryRatePct: 30 }));
    assert.ok((lo.cashFloor as number) > 76_000 && (lo.bookFloor as number) > 176_000, "giao ít đi thì mỗi đơn về phải gánh nhiều đơn hoàn hơn");
  }

  // ───────── Tỷ lệ giao CHƯA BIẾT / BẰNG 0 ⇒ KHÔNG có sàn ─────────
  {
    const unknown = clearanceFloor(base({ deliveryRatePct: null, deliverySource: null }));
    assert.equal(unknown.cashFloor, null, "chưa biết tỷ lệ giao thì không có sàn — không lấy 100%");
    assert.equal(unknown.bookFloor, null);
    assert.equal(unknown.maxDiscountPct, null);
    assert.equal(unknown.belowCodRule, false);
    assert.ok(unknown.notes.length > 0);
    const zero = clearanceFloor(base({ deliveryRatePct: 0 }));
    assert.equal(zero.cashFloor, null, "giao 0% thì giá nào cũng lỗ — không có sàn để in");
    assert.ok(zero.notes.some((n) => n.includes("0%")));
  }

  // ───────── Thiếu giá nhập ⇒ chỉ có sàn tiền mặt ─────────
  {
    const f = clearanceFloor(base({ unitCost: null }));
    assert.equal(f.cashFloor, 76_000);
    assert.equal(f.bookFloor, null, "thiếu giá nhập thì hoà vốn sổ sách là CHƯA BIẾT, không phải sàn tiền mặt");
    assert.ok(f.notes.some((n) => n.includes("giá nhập")));
  }

  // ───────── Giá bán đã dưới sàn ⇒ đang mất tiền mỗi đơn; không có giá bán ⇒ không có % giảm ─────────
  {
    const f = clearanceFloor(base({ retailPrice: 60_000 }));
    assert.equal(f.retailBelowCashFloor, true);
    assert.equal(f.maxDiscountPct, 0, "dưới sàn rồi thì không còn chỗ giảm — 0%, không âm");
    assert.equal(clearanceFloor(base({ retailPrice: null })).maxDiscountPct, null);
  }

  // ───────── Sàn cao hơn ngưỡng luật tiền ⇒ không cảnh báo ─────────
  {
    const f = clearanceFloor(base({ deliveryRatePct: 30 }));
    assert.ok((f.cashFloor as number) > RETURN_RULE.maxCodForFakeDelivery);
    assert.equal(f.belowCodRule, false);
  }

  // ───────── Tỷ lệ giao là MỤC TIÊU khai chung / co ngót thì phải nói ra ─────────
  {
    assert.ok(clearanceFloor(base({ deliverySource: "default" })).notes.some((n) => n.includes("MỤC TIÊU")));
    assert.ok(clearanceFloor(base({ deliverySource: "blended" })).notes.some((n) => n.includes("CO NGÓT")));
    assert.equal(clearanceFloor(base({ deliverySource: "history", retailPrice: 300_000 })).notes.length, 1, "số đo của mã thì chỉ còn cảnh báo luật tiền");
  }
}

/** Mức CSDL: giá sàn chỉ gắn vào dòng đang chôn vốn / nên xả, và hai mức không bao giờ đảo thứ tự. */
export async function testClearanceFloorReport() {
  clearMemo();
  const report = await getInventoryDecisionReport();
  for (const r of report.rows) {
    const shouldHave = r.decision === "OVERSTOCK" || r.decision === "CLEARANCE_CANDIDATE";
    assert.equal(r.clearanceFloor !== null, shouldHave, `${r.sku}: giá sàn chỉ có ở dòng chôn vốn / nên xả (${r.decision})`);
    const f = r.clearanceFloor;
    if (!f) continue;
    if (f.cashFloor !== null) {
      assert.ok(f.cashFloor > 0 && f.cashFloor % 1000 === 0, `${r.sku}: sàn dương, tròn nghìn`);
      if (f.bookFloor !== null) assert.ok(f.bookFloor >= f.cashFloor, `${r.sku}: hoà vốn sổ sách không thể thấp hơn sàn tiền mặt`);
    }
    if (r.unitCost === null) assert.equal(f.bookFloor, null, `${r.sku}: thiếu giá nhập thì không có hoà vốn sổ sách`);
  }
  clearMemo();
}
