import assert from "node:assert/strict";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import type { Period } from "@/lib/search-params";

/**
 * ───────────── TIỀN TRẢ TRƯỚC: DÒNG TIỀN THEO NGÀY TIỀN VỀ (chủ shop chốt 11/09/2026) ─────────────
 *
 * Trước đây báo cáo Dòng tiền chỉ cộng trả trước của đơn GIAO THÀNH CÔNG, theo mốc kết thúc đơn —
 * tức tiền đã nằm trong tài khoản từ tháng 3 nhưng tới tháng 4 giao xong mới "vào". Còn /reports
 * lại tính theo ngày lên đơn: hai màn hình, hai mốc, cùng một nhãn.
 *
 * Nay: Dòng tiền ghi theo NGÀY TIỀN THỰC TRẢ (lúc lên đơn — Pancake không có mốc riêng); lợi nhuận
 * vẫn phân bổ theo kỳ đơn giao. Phần đã trả cho đơn chưa kết thúc là SỐ DƯ TRẢ TRƯỚC, không phải lãi.
 */
export async function testPrepaidCash(db: Db) {
  const ky = (thang: number): Period => {
    const from = new Date(Date.UTC(2025, thang - 1, 1) - 7 * 3600_000);
    const to = new Date(Date.UTC(2025, thang, 1) - 7 * 3600_000 - 1);
    return { key: "custom", from, to, label: `Tháng ${thang}/2025`, fromKey: from.toISOString().slice(0, 10), toKey: to.toISOString().slice(0, 10) };
  };

  // Chưa có gì trong 3/2025 và 4/2025 — mốc xa fixture chung để phép đo sạch.
  clearMemo();
  const truoc3 = await getCashProfitReport(ky(3));
  const truoc4 = await getCashProfitReport(ky(4));

  // Khách chuyển khoản 200.000 lúc lên đơn ngày 10/03; hàng chưa giao.
  await db.insert(schema.orders).values({ id: "prepaid-o1", stage: "CONFIRMED", status: 1, insertedAt: new Date("2025-03-10T03:00:00Z"), transferMoney: 200_000, totalPriceAfterDiscount: 500_000, moneyToCollect: 300_000 }).onConflictDoNothing();
  // Đơn huỷ vẫn mang số trả trước trên Pancake — không có chứng từ tiền về ⇒ không tính.
  await db.insert(schema.orders).values({ id: "prepaid-o2", stage: "CANCELLED", status: 6, insertedAt: new Date("2025-03-12T03:00:00Z"), prepaid: 50_000, totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();

  clearMemo();
  const thang3 = await getCashProfitReport(ky(3));
  assert.equal(thang3.cashIn.prepaid - truoc3.cashIn.prepaid, 200_000, "tiền trả trước vào dòng tiền THÁNG TIỀN VỀ, không đợi giao");
  assert.equal(thang3.cashIn.prepaidOrders - truoc3.cashIn.prepaidOrders, 1, "đơn huỷ có ghi trả trước không được tính là tiền vào");
  assert.ok(thang3.pending.prepaidUnallocated - truoc3.pending.prepaidUnallocated >= 200_000, "đơn chưa kết thúc ⇒ tiền nằm ở SỐ DƯ TRẢ TRƯỚC (chưa vào lợi nhuận kỳ nào)");

  // Giao thành công ngày 05/04: dòng tiền tháng 3 KHÔNG đổi, tháng 4 KHÔNG cộng lần nữa, số dư giảm.
  await db
    .insert(schema.shipments)
    .values({ id: "prepaid-s1", orderId: "prepaid-o1", vtpOrderNumber: "PREPAID001", stage: "DELIVERED", isFinal: true, deliveredAt: new Date("2025-04-05T03:00:00Z"), codAmount: 300_000, codCollected: 300_000, codStatus: "PAID_TO_BANK" })
    .onConflictDoNothing();
  clearMemo();
  const thang3Sau = await getCashProfitReport(ky(3));
  const thang4Sau = await getCashProfitReport(ky(4));
  assert.equal(thang3Sau.cashIn.prepaid, thang3.cashIn.prepaid, "giao xong không dời tiền sang tháng khác — tiền đã về từ tháng 3");
  assert.equal(thang4Sau.cashIn.prepaid, truoc4.cashIn.prepaid, "và không được cộng lần thứ hai vào tháng giao (không đếm trùng)");
  assert.equal(thang4Sau.pending.prepaidUnallocated, truoc4.pending.prepaidUnallocated + (thang3.pending.prepaidUnallocated - truoc3.pending.prepaidUnallocated) - 200_000, "đơn kết thúc thì rời khỏi số dư trả trước");

  console.log("✓ Trả trước: dòng tiền theo ngày tiền về (tháng 3) · giao tháng 4 không đếm trùng · đơn huỷ không tính · số dư trả trước của đơn chưa kết thúc hiện riêng");
}
