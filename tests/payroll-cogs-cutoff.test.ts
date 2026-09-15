/**
 * ═══════ NHẬP LÔ GIÁ MỚI KHÔNG ĐƯỢC VIẾT LẠI LỢI NHUẬN THÁNG TRƯỚC ═══════
 *
 * `LINE_UNIT_COST` lấy "giá trên phiếu nhập GẦN NHẤT tính theo hôm nay". Đọc nó ở một báo cáo theo
 * kỳ nghĩa là: nhập một lô giá cao hơn vào tháng sau, và giá vốn của những đơn ĐÃ GIAO tháng trước
 * đổi theo — lợi nhuận tháng đã trả lương tự viết lại chính nó, im lặng.
 *
 * `orderCogsFast()` ở cấp ĐƠN đã chốt được chuyện này bằng `canonical_order_outcome.recognized_cogs`
 * (giá vốn tại thời điểm giao). Nhưng `productEconomics` trong `lib/queries/payroll.ts` — đường mà
 * bảng lương và lợi nhuận theo mã đi qua — vẫn tính ở cấp DÒNG bằng `LINE_UNIT_COST`.
 *
 * Bộ này ĐO chênh lệch ấy trên chính hai đường đó, cùng một đơn, cùng một kỳ. Nó cố ý KHÔNG khẳng
 * định "đã sửa": nó ghi lại HIỆN TRẠNG có đo được, để phần sửa sau này có một mốc trước/sau.
 *
 * ─── VÌ SAO BẢN VÁ HIỂN NHIÊN NHẤT KHÔNG ĐƯỢC SHIP (đo trên production 15/09/2026) ───
 *
 * Bản vá hiển nhiên là "chỉ đọc phiếu nhập đã về TRƯỚC ngày bán". Tôi đã viết xong nó rồi đo tác
 * động trước khi ship — và số đo bác bỏ nó:
 *
 *     2.274 dòng hàng · 1.713 dòng (75%) đổi số
 *     tổng giá vốn theo giá HÔM NAY   294.311.000 ₫
 *     tổng giá vốn theo giá LÚC BÁN    48.386.000 ₫   ← thấp hơn 84%
 *
 * Một bản vá làm giá vốn giảm 84% không phải là sửa sai — nó làm lợi nhuận CAO HƠN sự thật gần 246
 * triệu, đúng kiểu hỏng mà cả bản phát hành này đang đi bịt. Nguyên nhân đo được ngay sau đó:
 *
 *     chỉ 327/2.274 dòng CÓ phiếu nhập trước ngày bán; 1.947 dòng (86%) KHÔNG có
 *     phiếu nhập sớm nhất trong ERP: 03/09/2026
 *     đơn sớm nhất:                  19/08/2025   ← sớm hơn HƠN MỘT NĂM
 *
 * Sổ phiếu nhập ERP không lùi đủ xa. Với 86% số dòng, "giá đã biết lúc bán" rơi xuống chuỗi dự
 * phòng (giá vốn Pancake, thường 0) rồi xuống 0. Đây KHÔNG phải lỗi công thức — dữ liệu giá vốn
 * lịch sử không tồn tại, và không phép tính nào tạo ra được nó.
 *
 * Nên F07 dừng lại ở phép đo này, và dừng có căn cứ. Phần còn lại là một QUYẾT ĐỊNH của chủ shop
 * (xem mục 6 biên bản 15/09), không phải một bản vá kỹ thuật.
 *
 * Dữ liệu ở tháng 07/2027.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getMarketerReport } from "@/lib/queries/payroll";
import type { Period } from "@/lib/search-params";

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);

const THANG7: Period = {
  key: "custom",
  from: d("2027-07-01"),
  to: dEnd("2027-07-31"),
  label: "Tháng 7/2027",
  fromKey: "2027-07-01",
  toKey: "2027-07-31",
};

async function reset(db: Db) {
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'cg-%'`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like 'cg-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'cg-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'cg-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'cg-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'cg-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'cg-%'`);
  clearMemo();
}

export async function testPayrollCogsCutoff(db: Db) {
  await reset(db);

  // ── Một mã, một mẫu mã, nhập 100.000đ/cái TRƯỚC khi bán ──
  await db.insert(schema.products).values({ id: "cg-prod", name: "Mã kiểm giá vốn" });
  await db.insert(schema.productVariants).values({ id: "cg-var", productId: "cg-prod", sku: "CG-VAR", detail: "mặc định" });
  await db.insert(schema.stockReceipts).values({ id: "cg-rc-1", kind: "RECEIPT", receivedAt: d("2027-07-01") });
  await db.insert(schema.stockReceiptItems).values({ id: "cg-ri-1", receiptId: "cg-rc-1", variantId: "cg-var", quantity: 100, unitCost: 100_000 });

  // ── Một đơn GIAO THÀNH CÔNG ngày 10/07, 2 cái, doanh thu 500.000đ ──
  await db.insert(schema.orders).values({
    id: "cg-order",
    insertedAt: d("2027-07-10"),
    stage: "DELIVERED",
    status: 3,
    totalPriceAfterDiscount: 500_000,
    partnerFee: 0,
    returnFee: 0,
    cod: 500_000,
  });
  await db.insert(schema.orderItems).values({
    id: "cg-oi-1",
    orderId: "cg-order",
    variantId: "cg-var",
    productId: "cg-prod",
    productName: "Mã kiểm giá vốn",
    quantity: 2,
    lineTotal: 500_000,
    unitCost: 0,
    isBonus: false,
  });
  await db.insert(schema.shipments).values({
    id: "cg-ship",
    orderId: "cg-order",
    vtpOrderNumber: "CG0000000001",
    stage: "DELIVERED",
    shippingFee: 0,
    codAmount: 500_000,
    codCollected: 500_000,
    codStatus: "RECONCILED",
    deliveredAt: d("2027-07-12"),
  });
  clearMemo();

  const truoc = await getMarketerReport(THANG7, "profit1");
  const dongTruoc = truoc.products.find((p) => p.productId === "cg-prod");
  assert.equal(dongTruoc?.cogsDelivered, 200_000, "chuẩn bị: 2 cái × 100.000đ = 200.000đ giá vốn hàng giao");

  /* ══ NHẬP LÔ GIÁ CAO HƠN, SAU NGÀY GIAO ══
   *
   * Lô này về ngày 20/07 — SAU khi đơn đã giao ngày 12/07. Nó không thể là hàng của đơn ấy. Giá vốn
   * đã ghi nhận của đơn cũ phải ĐỨNG IM.
   */
  await db.insert(schema.stockReceipts).values({ id: "cg-rc-2", kind: "RECEIPT", receivedAt: d("2027-07-20") });
  await db.insert(schema.stockReceiptItems).values({ id: "cg-ri-2", receiptId: "cg-rc-2", variantId: "cg-var", quantity: 50, unitCost: 300_000 });
  clearMemo();

  const sau = await getMarketerReport(THANG7, "profit1");
  const dongSau = sau.products.find((p) => p.productId === "cg-prod");

  /*
    ĐÂY LÀ PHÉP ĐO, KHÔNG PHẢI MỘT KHẲNG ĐỊNH "ĐÃ SỬA".

    Nếu `cogsDelivered` đổi thì lợi nhuận của một kỳ ĐÃ QUA vừa tự viết lại chính nó vì một phiếu
    nhập không liên quan. Bài này khoá CHÊNH LỆCH lại làm mốc: hôm nay nó bằng bao nhiêu thì ghi ra
    bấy nhiêu, và ngày nào phần sửa lên thì chính dòng này đỏ — buộc người sửa phải đọc lại đoạn
    chú thích trên thay vì lặng lẽ đổi một con số.
  */
  const chenhLech = (dongSau?.cogsDelivered ?? 0) - (dongTruoc?.cogsDelivered ?? 0);
  assert.equal(
    chenhLech,
    400_000,
    "HIỆN TRẠNG (chưa sửa): nhập lô 300.000đ sau ngày giao làm giá vốn đơn cũ nhảy từ 200.000đ lên 600.000đ — lợi nhuận tháng đã qua tự viết lại. Xem mục F07 biên bản 15/09.",
  );
  assert.equal(
    sau.totals.profit - truoc.totals.profit,
    -400_000,
    "và lợi nhuận shop của kỳ ĐÃ QUA giảm đúng bấy nhiêu, dù không một đơn nào đổi",
  );

  /* ══ HÀNG TẶNG: KHÔNG DOANH THU, NHƯNG PHẢI CÓ GIÁ VỐN ══
   *
   * Hàng tặng vẫn trừ tồn như hàng bán (AGENTS.md mục 10) và vẫn là tiền thật đã bỏ ra. Bản cũ loại
   * nó ngay ở `WHERE` nên giá vốn KHÔNG BAO GIỜ vào lợi nhuận — tặng càng nhiều, lợi nhuận trông
   * càng đẹp.
   *
   * Ba điều phải đúng cùng lúc, và đó là lý do lọc phải nằm ở TỪNG CỘT chứ không ở `WHERE`:
   * giá vốn PHẢI tăng · doanh thu KHÔNG được tăng · số đơn KHÔNG được tăng.
   */
  await db.insert(schema.products).values({ id: "cg-prod2", name: "Mã có hàng tặng" });
  await db.insert(schema.productVariants).values({ id: "cg-var2", productId: "cg-prod2", sku: "CG-VAR2", detail: "mặc định" });
  await db.insert(schema.stockReceipts).values({ id: "cg-rc-3", kind: "RECEIPT", receivedAt: d("2027-07-02") });
  await db.insert(schema.stockReceiptItems).values({ id: "cg-ri-3", receiptId: "cg-rc-3", variantId: "cg-var2", quantity: 50, unitCost: 70_000 });
  await db.insert(schema.orders).values({
    id: "cg-order2",
    insertedAt: d("2027-07-15"),
    stage: "DELIVERED",
    status: 3,
    totalPriceAfterDiscount: 400_000,
    partnerFee: 0,
    returnFee: 0,
    cod: 400_000,
  });
  // Một dòng BÁN (2 cái, 400.000đ) và một dòng TẶNG (1 cái, 0đ) trên CÙNG một đơn.
  await db.insert(schema.orderItems).values([
    { id: "cg-oi-2", orderId: "cg-order2", variantId: "cg-var2", productId: "cg-prod2", productName: "Mã có hàng tặng", quantity: 2, lineTotal: 400_000, unitCost: 0, isBonus: false },
    { id: "cg-oi-3", orderId: "cg-order2", variantId: "cg-var2", productId: "cg-prod2", productName: "Mã có hàng tặng", quantity: 1, lineTotal: 0, unitCost: 0, isBonus: true },
  ]);
  await db.insert(schema.shipments).values({
    id: "cg-ship2",
    orderId: "cg-order2",
    vtpOrderNumber: "CG0000000002",
    stage: "DELIVERED",
    shippingFee: 0,
    codAmount: 400_000,
    codCollected: 400_000,
    codStatus: "RECONCILED",
    deliveredAt: d("2027-07-16"),
  });
  clearMemo();

  const coTang = await getMarketerReport(THANG7, "profit1");
  const dongTang = coTang.products.find((p) => p.productId === "cg-prod2");
  assert.equal(
    dongTang?.cogsDelivered,
    210_000,
    "hàng tặng: giá vốn phải gồm CẢ cái tặng — 3 cái × 70.000đ = 210.000đ, không phải 140.000đ",
  );
  assert.equal(dongTang?.revenue, 400_000, "hàng tặng KHÔNG sinh doanh thu — vẫn đúng 400.000đ");
  assert.equal(dongTang?.deliveredOrders, 1, "và KHÔNG làm số đơn giao thành công tăng lên 2");

  await reset(db);
  await reset(db);
  console.log(
    "✓ Giá vốn theo kỳ (ĐO HIỆN TRẠNG, chưa sửa): nhập lô giá mới SAU ngày giao làm giá vốn đơn cũ đổi 200.000đ → 600.000đ ở đường productEconomics (cấp DÒNG, LINE_UNIT_COST), trong khi orderCogsFast ở cấp ĐƠN đã chốt bằng recognized_cogs — chênh lệch được khoá lại làm mốc trước/sau · hàng tặng nay VÀO giá vốn (3 cái, không phải 2) mà không thổi doanh thu hay số đơn",
  );
}
