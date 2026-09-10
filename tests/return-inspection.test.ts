import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { findPendingByCode, inspectionDashboard, inspectionSummary, listPendingInspections, markReturnsArrived, recordInspection, recordInspectionBulk, undoReturnArrived } from "@/lib/returns/inspection";

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

  /** Tổng số món ĐÃ VÀO LẠI TỒN qua phiếu tái nhập — thước đo duy nhất đáng tin cho phần này. */
  const tongTaiNhap = async () => {
    const rows = await db
      .select({ q: schema.stockReceiptItems.quantity })
      .from(schema.stockReceiptItems)
      .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
      .where(eq(schema.stockReceipts.kind, "RETURN"));
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

  /**
   * ───────── 9. TRẠM ĐẾM: quét mã, xử lý hàng loạt, bảng điều khiển ─────────
   *
   * 453 kiện tồn đọng trên production không phải vì thiếu tính năng ghi nhận — nó đã có từ lâu. Nó
   * tồn đọng vì nhịp thao tác: mở đơn ở tab khác để xem màu/size, bấm từng kiện một. Ba thứ dưới đây
   * là thứ biến việc đó thành làm được, nên chúng phải được khoá như luật nghiệp vụ.
   */
  const kienChoDem = await listPendingInspections(50);
  assert.ok(kienChoDem.length > 0, "fixture: phải còn kiện chờ đếm để kiểm phần trạm đếm");
  const mau = kienChoDem[0];

  // Người đếm cầm kiện trên tay cần thấy NGAY phải có gì trong đó — không phải mở đơn ở tab khác.
  assert.ok(Array.isArray(mau.items), "mỗi kiện phải kèm sẵn danh sách dòng hàng");
  assert.ok("customerName" in mau && "customerPhone" in mau, "phải kèm khách + SĐT để đối chiếu khi kiện không có mã rõ");

  // QUÉT MÃ: bắn đúng mã ra đúng kiện; bắn mã lạ thì nói rõ vì sao, không im lặng.
  const quetDung = await findPendingByCode(mau.code ?? mau.shipmentId);
  assert.equal(quetDung?.shipmentId, mau.shipmentId, "bắn đúng mã phải ra đúng kiện đó");
  const quetHoaThuong = await findPendingByCode((mau.code ?? mau.shipmentId).toUpperCase());
  assert.equal(quetHoaThuong?.shipmentId, mau.shipmentId, "máy quét hay trả hoa/thường khác nhau — so khớp KHÔNG được phân biệt");
  assert.equal(await findPendingByCode("khong-co-ma-nay"), null, "mã không có thật phải trả về CHƯA THẤY, không trả bừa một kiện gần giống");
  assert.equal(await findPendingByCode("   "), null, "bắn hụt (chuỗi rỗng) không được trả về kiện nào");

  // HÀNG LOẠT: nhiều kiện cùng kết luận, và "nhận đủ" = đúng bằng số ERP đã xuất.
  const loat = kienChoDem.slice(0, 2).map((r) => r.shipmentId);
  const tonTruocLoat = await tongTaiNhap();
  const kqLoat = await recordInspectionBulk(loat, "RESTOCKABLE", "", "kho@test");
  assert.equal(kqLoat.done, loat.length, "mọi kiện hợp lệ trong lượt phải được xử lý");
  assert.equal(kqLoat.failed.length, 0, "không kiện nào được phép hỏng im lặng");
  const congThem = kienChoDem.slice(0, 2).reduce((t, r) => t + r.expectedQty, 0);
  assert.equal(await tongTaiNhap(), tonTruocLoat + congThem, "hàng loạt “nhận đủ” cộng ĐÚNG BẰNG số ERP đã xuất, không hơn không kém");

  // Chạy lại đúng lượt đó: đã đếm rồi thì bị chặn, và LỖI PHẢI HIỆN RA kèm tên kiện.
  const lanHai = await recordInspectionBulk(loat, "RESTOCKABLE", "", "kho@test");
  assert.equal(lanHai.done, 0, "kiện đã đếm không được đếm lại qua đường hàng loạt");
  assert.equal(lanHai.failed.length, loat.length, "kiện bị chặn phải được nêu tên, không nuốt lỗi");

  // Kết luận KHÔNG vào tồn thì phải có lý do — kể cả khi làm hàng loạt.
  const conLai = (await listPendingInspections(50))[0];
  if (conLai) {
    const tonTruocHong = await tongTaiNhap();
    const hong = await recordInspectionBulk([conLai.shipmentId], "DAMAGED", "vỡ khi vận chuyển", "kho@test");
    assert.equal(hong.done, 1, "kết luận hỏng có lý do thì ghi được");
    assert.equal(await tongTaiNhap(), tonTruocHong, "kết luận HỎNG tuyệt đối không cộng tồn");
  }

  // BẢNG ĐIỀU KHIỂN: tách "chờ nhận" khỏi "chờ đếm" — hai việc tắc ở hai chỗ, thuộc hai người.
  clearMemo();
  const bang = await inspectionDashboard();
  assert.ok(bang.pendingInspection >= 0 && bang.awaitingArrival >= 0, "hai con số phải tách rời nhau");
  assert.ok(bang.restocked >= 1, "kiện đã vào lại tồn phải được đếm vào bảng");
  assert.equal(
    bang.aging.duoi1Ngay + bang.aging.tu1Den3Ngay + bang.aging.tu3Den7Ngay + bang.aging.tren7Ngay,
    bang.pendingInspection,
    "bốn nhóm tuổi phải cộng lại đúng bằng số kiện chờ đếm — thiếu một nhóm là có kiện biến mất khỏi tầm nhìn",
  );

  console.log(
    `✓ Kiểm đếm hàng hoàn: ghi nhận đã về không cộng tồn · đếm 3/4 món → tồn +3, hao 1 · đếm lại bị chặn · huỷ sau khi đếm bị chặn · ${summary.pending} kiện đang chờ đếm`,
  );
  console.log(
    `✓ Trạm đếm: quét mã ra đúng kiện (không phân biệt hoa thường, mã lạ trả CHƯA THẤY) · hàng loạt cộng đúng số đã xuất · đếm lại bị chặn và nêu tên · kết luận hỏng KHÔNG cộng tồn · ${bang.aging.duoi1Ngay + bang.aging.tu1Den3Ngay + bang.aging.tu3Den7Ngay + bang.aging.tren7Ngay} kiện phân theo 4 nhóm tuổi`,
  );
}
