import assert from "node:assert/strict";
import { eq, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { parseCsv } from "@/lib/constants/landing";
import { checkLayout, parseDate, parseMoney, parseNoteLines, planFromSheets } from "@/lib/workshop/sheet-import";
import { applySheetPreview, previewSheetRows } from "@/lib/workshop/sheet-import-db";

/**
 * ═══════════ NHẬP SỔ ĐẶT XƯỞNG TỪ BẢNG TÍNH ═══════════
 *
 * Dữ liệu dưới đây là GIẢ LẬP cùng bố cục với bảng tính "BÁO CÁO ĐẶT HÀNG" (kho mã PUBLIC — không đưa
 * số liệu thật của shop vào đây). Bốn chỗ dễ sai nhất:
 *  1. Đọc lệch cột khi bảng tính đổi bố cục (phải DỪNG).
 *  2. Đoán thứ bảng tính không có (xưởng, lô dùng vải, ngày trả tiền) mà không nói ra.
 *  3. Nhập lại lần hai nhân đôi lô / vải / tiền.
 *  4. Ghi đè một lô ERP đã có số liệu khác.
 */

const HEAD = `"Mã","","","","","","","Giá Báo MKT","","","Thưởng/Phạt","","","Trạng thái thanh toán","Trạng thái trả hàng","Ghi chú","Hoàn phạt MKT","Tháng","Tên MKT"`;
const THANH_PHAM = [
  HEAD,
  `"ZSI1","1","2/7/2027","100","110","10/07/2027","50.000 ₫","","5.500.000 ₫","0 đ","","5.000.000 đ","500.000 đ","","Đã xong","12/07: 60\n15/07: 50","","",""`,
  `"ZSI1","2","20/7/2027","200","","30/07/2027","50.000 ₫","","","1.000.000 đ","","1.000.000 đ","","","","25/07: 80c đỏ","","",""`,
  `"ZSI1","2","25/7/2027","40","40","30/7/2027","50.000 ₫","","2.030.000 ₫","","","2.030.000 đ","0 đ","Đã xong","Đã xong","31/07: 40c xanh","","",""`,
  `"","","","","","","","","0 ₫","","","","0 đ","","","","","",""`,
].join("\n");
const VAI = [
  HEAD,
  `"ZSI1","1","1/7/2027","4","4","03/07/2027","88 ₫","","6.900.000 ₫","0 đ","","6.900.000 đ","0 đ","Đã xong","Đã xong","01/07: 4","","",""`,
  `"ZSI1","2","18/7/2027","1","1","19/07/2027","","","2.000.000 ₫","0 đ","","","2.000.000 đ","","","18/07: đặt vải lô 2 cho ZSI1","","",""`,
].join("\n");

export function testWorkshopSheetImportPure() {
  assert.equal(parseMoney("11.625.500 ₫"), 11_625_500);
  assert.equal(parseMoney("0 đ"), 0, "0 trên bảng tính là 0 thật");
  assert.equal(parseMoney(""), null, "ô trống là CHƯA BIẾT, không phải 0");
  assert.equal(parseMoney("1.039"), 1039);
  assert.equal(parseDate("28/7/2026"), "2026-07-28");
  assert.equal(parseDate("31/02/x"), null);
  const note = parseNoteLines("30/12: 10\n02/01: 5c đỏ\nghi thêm", "2026-12-20");
  assert.deepEqual(note.lines.map((l) => [l.date, l.quantity, l.text]), [["2026-12-30", 10, ""], ["2027-01-02", 5, "đỏ"]], "ghi chú không có năm ⇒ sang năm mới khi lùi quá xa ngày đặt");
  assert.deepEqual(note.rest, ["ghi thêm"], "dòng ghi chú không đọc được KHÔNG bị bỏ — giữ lại cho người đọc");

  assert.match(checkLayout(["Mã", "", "", "", "", "", "", "Giá", "", "", "Thưởng/Phạt"]) ?? "", /bố cục bảng tính đã đổi/, "cột lệch ⇒ DỪNG, không đọc lệch");

  const plan = planFromSheets(parseCsv(THANH_PHAM), parseCsv(VAI));
  assert.ok(!("error" in plan));
  const [lo1, lo2, lo3] = plan.batches;
  assert.equal(plan.batches.length, 3, "dòng không có mã bị bỏ qua");
  assert.deepEqual([lo1.batchNo, lo1.agreedQty, lo1.laborUnitPrice, lo1.done], [1, 110, 50_000, true]);
  assert.deepEqual(lo1.deliveries.map((d) => [d.date, d.quantity]), [["2027-07-12", 60], ["2027-07-15", 50]], "ô Ghi chú tách thành từng đợt xưởng trả hàng");
  assert.deepEqual(lo1.payments.map((p) => [p.kind, p.amount, p.paidAt]), [["PAYMENT", 5_000_000, "2027-07-15"]], "bảng tính không có ngày trả ⇒ ghi TẠM ngày trả hàng cuối");
  assert.ok(lo1.payments[0].note.includes("tạm lấy"), "ngày tạm phải nói ra là tạm");
  assert.equal(lo2.agreedQty, null, "SL chốt trống ⇒ chưa chốt, không phải 0");
  assert.deepEqual(lo2.payments.map((p) => [p.kind, p.amount]), [["DEPOSIT", 1_000_000]], "đã trả = đúng số cọc ⇒ một đợt cọc, không đẻ thêm đợt thanh toán 0đ");
  assert.equal(lo2.done, false);
  assert.equal(lo3.batchNo, 3, "trùng mã + lô trong bảng tính ⇒ đặt tạm số lô kế tiếp");
  assert.equal(lo3.batchNoOnSheet, 2);
  assert.ok(lo3.warnings.some((w) => w.includes("trùng")), "và NÓI RA là đã đổi số lô");
  assert.equal(lo3.adjustment, 30_000, "TỔNG bảng tính (2.030.000) lệch SL × đơn giá (2.000.000) ⇒ phần lệch vào Thưởng/Phạt để tiền công khớp bảng tính");
  assert.ok(lo3.warnings.some((w) => w.includes("lệch")));

  const [v1, v2] = plan.fabrics;
  assert.equal(v1.unitPrice, null, "đơn giá 88 × 4 không ra thành tiền ⇒ để trống, không ghi một con số sai");
  assert.equal(v1.batchNoRef, null, "ghi chú không nói lô nào ⇒ để trống cho người chọn (cột Lô của trang Vải KHÔNG phải lô sản xuất)");
  assert.equal(v1.receivedAt, "2027-07-03");
  assert.equal(v2.batchNoRef, 2, "ghi chú nói rõ 'lô 2' ⇒ gắn lô 2");
  assert.equal(v2.receivedAt, null, "chưa 'Đã xong' ⇒ vải chưa về");
  assert.equal(v2.payments.length, 0, "chưa trả đồng nào ⇒ không có đợt thanh toán");
  console.log("✓ Nhập bảng tính (hàm thuần): đọc theo vị trí cột · bố cục đổi thì dừng · ô trống là CHƯA BIẾT · trùng lô / lệch TỔNG / ngày trả tạm đều được nói ra · vải chỉ gắn lô khi ghi chú nói rõ");
}

async function donDep(db: Db) {
  await db.delete(schema.supplierPayments).where(sql`${schema.supplierPayments.reference} like 'Bảng tính%' and (${schema.supplierPayments.batchId} in (select id from production_batches where product_code like 'ZSI%') or ${schema.supplierPayments.fabricOrderId} in (select id from fabric_orders where product_code like 'ZSI%'))`);
  await db.delete(schema.fabricOrders).where(like(schema.fabricOrders.productCode, "ZSI%"));
  await db.delete(schema.productionBatches).where(like(schema.productionBatches.productCode, "ZSI%"));
}

export async function testWorkshopSheetImportDb(db: Db) {
  await donDep(db);
  try {
    const tp = parseCsv(THANH_PHAM);
    const vai = parseCsv(VAI);
    // ERP đã có sẵn lô 2 với số liệu KHÁC ⇒ xung đột, không được ghi đè.
    await db.insert(schema.productionBatches).values({ productCode: "ZSI1", batchNo: 2, orderedAt: new Date("2027-07-19T17:00:00Z"), orderedQty: 999 });

    const xem = await previewSheetRows(tp, vai);
    assert.ok(!("error" in xem));
    assert.deepEqual(xem.batches.map((b) => b.status), ["NEW", "CONFLICT", "NEW"]);
    assert.ok(xem.batches[1].reason.includes("không ghi đè"));
    assert.equal(xem.fabrics[1].batchLinkable, true, "lô 2 có trong ERP ⇒ gắn được");

    const lan1 = await applySheetPreview(xem, { id: null, name: "Kiểm thử" });
    assert.deepEqual(lan1, { batches: 2, deliveries: 3, fabrics: 2, payments: 3 });
    const lo2 = await db.query.productionBatches.findFirst({ where: eq(schema.productionBatches.batchNo, 2), columns: { orderedQty: true } });
    assert.equal(lo2?.orderedQty, 999, "lô ERP đã có KHÔNG bị ghi đè");
    const lo1 = await db.query.productionBatches.findFirst({ where: sql`${schema.productionBatches.productCode} = 'ZSI1' and ${schema.productionBatches.batchNo} = 1` });
    assert.deepEqual([lo1?.status, lo1?.agreedQty, lo1?.supplier], ["DONE", 110, ""], "xưởng may bảng tính không có ⇒ để trống");
    const vaiLo2 = await db.select({ batchId: schema.fabricOrders.batchId }).from(schema.fabricOrders).where(sql`${schema.fabricOrders.productCode} = 'ZSI1' and ${schema.fabricOrders.amount} = 2000000`);
    assert.ok(vaiLo2[0]?.batchId, "đợt vải ghi chú 'lô 2' được gắn vào lô 2");

    // ── Nhập lại lần hai: không đẻ thêm dòng nào ──
    const xem2 = await previewSheetRows(tp, vai);
    assert.ok(!("error" in xem2));
    assert.deepEqual(xem2.batches.map((b) => b.status), ["EXISTS", "CONFLICT", "EXISTS"]);
    assert.deepEqual(xem2.fabrics.map((f) => f.status), ["EXISTS", "EXISTS"]);
    const lan2 = await applySheetPreview(xem2, { id: null, name: "Kiểm thử" });
    assert.deepEqual(lan2, { batches: 0, deliveries: 0, fabrics: 0, payments: 0 }, "nhập lại không nhân đôi lô / vải / tiền");
    console.log("✓ Nhập bảng tính (CSDL): lô ERP đã có số liệu khác là XUNG ĐỘT, không ghi đè · vải 'lô 2' gắn đúng lô · nhập lại lần hai không nhân đôi");
  } finally {
    await donDep(db);
  }
}
