import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { inspectionSummary, listPendingInspections, markReturnsArrived, recordInspection, undoReturnArrived } from "@/lib/returns/inspection";

/**
 * KIỂM ĐẾM HÀNG HOÀN — ranh giới giữa "hàng về tới nơi" và "hàng có trong sổ".
 *
 * Luật bị khoá ở đây: ghi nhận kiện đã về KHÔNG cộng tồn; chỉ số người ĐẾM ĐƯỢC và còn bán được mới
 * vào tồn; đếm lần hai bị chặn; kết luận không bán được thì bắt buộc có lý do.
 *
 * Vì sao đáng khoá bằng test: cách làm cũ (xác nhận nhận hàng = tự lập phiếu tái nhập bằng đúng số
 * đã xuất) trông đúng trên màn hình và sai trong kho. Một lần ai đó "tối ưu" trở lại như cũ thì tồn
 * lại phình lên bằng hàng không có thật, và không có gì báo động.
 */
export async function testReturnInspection(db: Db) {
  // ───────── Dàn cảnh: một kiện hoàn 4 món của MẪU MÃ RIÊNG của bài kiểm thử này ─────────
  // Cố ý không dùng `rr-var` của fixture chung: thêm đơn vào đó sẽ đổi tổng của hàng loạt assertion
  // khác và biến một bài kiểm thử thành nguồn lỗi giả cho bài khác.
  await db.insert(schema.products).values({ id: "ins-prod", name: "Áo kiểm hàng hoàn" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: "ins-var", productId: "ins-prod", sku: "INS-001", color: "Trắng", size: "M", retailPrice: 300000 }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "ins-order-1", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-01T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ins-item-1", orderId: "ins-order-1", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 4, unitPrice: 300000, lineTotal: 1200000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: "ins-ship-1", orderId: "ins-order-1", vtpOrderNumber: "INS001", stage: "RETURNED", returnedAt: new Date("2026-08-20T00:00:00Z") })
    .onConflictDoNothing();

  const receiptQty = async () => {
    const rows = await db.select({ q: schema.stockReceiptItems.quantity }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.shipmentId, "ins-ship-1"));
    return rows.reduce((t, r) => t + Number(r.q ?? 0), 0);
  };

  // ───────── 1. Chưa ghi nhận đã về thì không đếm được ─────────
  const chuaVe = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 4, unsellableQty: 0, note: "", actor: "kho" });
  assert.ok("error" in chuaVe, "kiện chưa ghi nhận về kho thì không được đếm — nếu không, ERP cộng tồn cho hàng chưa ai thấy");

  // ───────── 2. Ghi nhận đã về: KHÔNG sinh phiếu, KHÔNG cộng tồn ─────────
  const arrived = await markReturnsArrived(["ins-ship-1"], "nguoi-nhan-hang", "Kiện về cùng lô ngày 20/8");
  assert.equal(arrived.count, 1, "ghi nhận được kiện đã về");
  assert.equal(await receiptQty(), 0, "ghi nhận đã về KHÔNG được sinh phiếu tái nhập nào");

  const lai = await markReturnsArrived(["ins-ship-1"], "nguoi-khac");
  assert.equal(lai.count, 0, "ghi nhận lại lần hai không tạo thêm phiếu");

  const pending = await listPendingInspections(50);
  const row = pending.find((p) => p.shipmentId === "ins-ship-1");
  assert.ok(row, "kiện đã về phải nằm trong hàng đợi ĐẾM");
  assert.equal(row.expectedQty, 4, "hàng đợi nêu đúng số món ERP đã xuất, để người đếm thấy ngay phần thiếu");
  assert.equal(row.receivedBy, "nguoi-nhan-hang", "giữ nguyên người ghi nhận lần đầu");

  // ───────── 3. Kết luận không bán được thì BẮT BUỘC có lý do ─────────
  const khongLyDo = await recordInspection({ shipmentId: "ins-ship-1", condition: "DAMAGED", restockQty: 0, unsellableQty: 4, note: "   ", actor: "kho" });
  assert.ok("error" in khongLyDo, "hàng hỏng mà không ghi lý do thì phần mất biến mất không dấu vết");

  // ───────── 4. Huỷ ghi nhận khi CHƯA đếm thì được ─────────
  const undo = await undoReturnArrived(["ins-ship-1"]);
  assert.equal(undo.count, 1, "kiện chưa đếm thì huỷ ghi nhận được");
  assert.equal(undo.blocked, 0);
  await markReturnsArrived(["ins-ship-1"], "nguoi-nhan-hang");

  // ───────── 5. ĐẾM XONG: chỉ phần đếm được vào tồn ─────────
  // Kho mở kiện: 3 món còn bán được, 1 món bẩn. Tồn chỉ được tăng 3.
  const done = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 1, note: "1 áo dính bẩn", actor: "nguoi-dem" });
  assert.ok("ok" in done, "kiện đã ghi nhận về thì đếm được");
  assert.equal("ok" in done && done.restocked, 3, "chỉ 3 món vào tồn, không phải 4 món đã xuất");
  assert.equal(await receiptQty(), 3, "phiếu tái nhập ghi đúng 3 món kho đếm được");

  const [ship] = await db.select({ at: schema.shipments.returnReceivedAt, by: schema.shipments.returnReceivedBy }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-1"));
  assert.ok(ship.at, "đếm xong mới đóng kiện trên vận đơn");
  assert.equal(ship.by, "nguoi-dem", "mốc kho nhận ghi tên người ĐẾM, không phải người bê hàng vào");

  // ───────── 6. Đếm lần hai bị chặn ─────────
  const demLai = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 0, note: "đếm lại", actor: "nguoi-dem" });
  assert.ok("error" in demLai, "đếm lại lần hai sẽ cộng tồn hai lần — phải bị chặn");
  assert.equal(await receiptQty(), 3, "không có phiếu tái nhập thứ hai");

  // ───────── 7. Đã đếm rồi thì không huỷ ngược được ─────────
  const undoSau = await undoReturnArrived(["ins-ship-1"]);
  assert.equal(undoSau.count, 0, "kiện đã đếm thì không huỷ ghi nhận được");
  assert.equal(undoSau.blocked, 1, "phải nói rõ có bao nhiêu kiện bị chặn để người dùng biết vì sao không có gì xảy ra");

  // ───────── 8. Tổng hợp phản ánh đúng phần hao ─────────
  clearMemo();
  const summary = await inspectionSummary();
  assert.ok(summary.inspected >= 1, "đếm xong phải vào số kiện đã kiểm");
  assert.ok(summary.restockedQty >= 3, "tổng số vào lại tồn tính đúng");
  assert.ok(summary.unsellableQty >= 1, "phần không bán được phải HIỆN RA, không được giấu bằng cách bỏ qua");

  console.log(
    `✓ Kiểm đếm hàng hoàn: ghi nhận đã về không cộng tồn · đếm 3/4 món → tồn +3, hao 1 · đếm lại bị chặn · huỷ sau khi đếm bị chặn · ${summary.pending} kiện đang chờ đếm`,
  );
}
