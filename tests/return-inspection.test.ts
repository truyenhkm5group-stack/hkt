import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { findPendingByCode, inspectionDashboard, inspectionSummary, listPendingInspections, markReturnsArrived, recordInspection, recordInspectionBulk, undoReturnArrived } from "@/lib/returns/inspection";
import { listPendingReturnedIds, settleReturnsForReceipt } from "@/lib/returns/warehouse";

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
  const chuaVe = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 4, unsellableQty: 0, note: "", actor: { id: null, label: "kho" } });
  assert.ok("error" in chuaVe, "kiện chưa ghi nhận về kho thì không được đếm — nếu không, ERP cộng tồn cho hàng chưa ai thấy");

  // ───────── 2. Ghi nhận đã về: KHÔNG sinh phiếu, KHÔNG cộng tồn ─────────
  const arrived = await markReturnsArrived(["ins-ship-1"], { id: null, label: "nguoi-nhan-hang" }, "Kiện về cùng lô ngày 20/8");
  assert.equal(arrived.count, 1, "ghi nhận được kiện đã về");
  assert.equal(await receiptQty(), 0, "ghi nhận đã về KHÔNG được sinh phiếu tái nhập nào");

  const lai = await markReturnsArrived(["ins-ship-1"], { id: null, label: "nguoi-khac" });
  assert.equal(lai.count, 0, "ghi nhận lại lần hai không tạo thêm phiếu");

  const pending = await listPendingInspections(50);
  const row = pending.find((p) => p.shipmentId === "ins-ship-1");
  assert.ok(row, "kiện đã về phải nằm trong hàng đợi ĐẾM");
  assert.equal(row.expectedQty, 4, "hàng đợi nêu đúng số món ERP đã xuất, để người đếm thấy ngay phần thiếu");
  assert.equal(row.receivedBy, "nguoi-nhan-hang", "giữ nguyên người ghi nhận lần đầu");

  // ───────── 3. Kết luận không bán được thì BẮT BUỘC có lý do ─────────
  const khongLyDo = await recordInspection({ shipmentId: "ins-ship-1", condition: "DAMAGED", restockQty: 0, unsellableQty: 4, note: "   ", actor: { id: null, label: "kho" } });
  assert.ok("error" in khongLyDo, "hàng hỏng mà không ghi lý do thì phần mất biến mất không dấu vết");

  // ───────── 4. Huỷ ghi nhận khi CHƯA đếm thì được ─────────
  const undo = await undoReturnArrived(["ins-ship-1"]);
  assert.equal(undo.count, 1, "kiện chưa đếm thì huỷ ghi nhận được");
  assert.equal(undo.blocked, 0);
  await markReturnsArrived(["ins-ship-1"], { id: null, label: "nguoi-nhan-hang" });

  // ───────── 5. ĐẾM XONG: chỉ phần đếm được vào tồn ─────────
  // Kho mở kiện: 3 món còn bán được, 1 món bẩn. Tồn chỉ được tăng 3.
  const done = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 1, note: "1 áo dính bẩn", actor: { id: null, label: "nguoi-dem" } });
  assert.ok("ok" in done, "kiện đã ghi nhận về thì đếm được");
  assert.equal("ok" in done && done.restocked, 3, "chỉ 3 món vào tồn, không phải 4 món đã xuất");
  assert.equal(await receiptQty(), 3, "phiếu tái nhập ghi đúng 3 món kho đếm được");

  const [ship] = await db.select({ at: schema.shipments.returnReceivedAt, by: schema.shipments.returnReceivedBy }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-1"));
  assert.ok(ship.at, "đếm xong mới đóng kiện trên vận đơn");
  assert.equal(ship.by, "nguoi-dem", "mốc kho nhận ghi tên người ĐẾM, không phải người bê hàng vào");

  // ───────── 6. Đếm lần hai bị chặn ─────────
  const demLai = await recordInspection({ shipmentId: "ins-ship-1", condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 0, note: "đếm lại", actor: { id: null, label: "nguoi-dem" } });
  assert.ok("error" in demLai, "đếm lại lần hai sẽ cộng tồn hai lần — phải bị chặn");
  assert.equal(await receiptQty(), 3, "không có phiếu tái nhập thứ hai");

  // ───────── 6b. Hai lượt bấm CÙNG LÚC trên một kiện: đúng một lượt được ghi ─────────
  // Trước đây đường đếm nhanh kiểm tra "đã đếm chưa" rồi mới ghi, hai bước rời nhau: hai người bấm
  // trong cùng một giây thì cả hai qua được bước kiểm, và tồn cộng hai lần. Giờ khoá dòng kiện trong
  // một giao dịch nên lượt sau phải chờ, thấy INSPECTED và dừng — không có phiếu kho thứ hai.
  await db.insert(schema.shipments).values({ id: "ins-ship-race", orderId: "ins-order-1", vtpOrderNumber: "INS001R", stage: "RETURNED", returnedAt: new Date("2026-08-21T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["ins-ship-race"], { id: null, label: "nguoi-be-hang" });
  const dua = await Promise.all([
    recordInspection({ shipmentId: "ins-ship-race", condition: "RESTOCKABLE", restockQty: 2, unsellableQty: 0, note: "", actor: { id: null, label: "kho-a" } }),
    recordInspection({ shipmentId: "ins-ship-race", condition: "RESTOCKABLE", restockQty: 2, unsellableQty: 0, note: "", actor: { id: null, label: "kho-b" } }),
  ]);
  assert.equal(dua.filter((r) => "ok" in r).length, 1, "hai lượt cùng lúc thì đúng MỘT lượt được ghi");
  assert.equal(dua.filter((r) => "error" in r).length, 1, "lượt còn lại phải báo lỗi, không im lặng");
  const raceRows = await db.select({ q: schema.stockReceiptItems.quantity }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.shipmentId, "ins-ship-race"));
  assert.equal(raceRows.reduce((a, r) => a + Number(r.q ?? 0), 0), 2, "tồn chỉ tăng đúng 2 — không phải 4");
  assert.equal(raceRows.length, 1, "chỉ MỘT phiếu tái nhập cho kiện đó");

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
  // Chỉ kiện MỘT mẫu mã đã ghép được đơn mới đủ điều kiện "nhận đủ" hàng loạt — kiện nhiều mẫu mã
  // được kiểm riêng ở phần 10 bên dưới.
  const motMauMa = (r: (typeof kienChoDem)[number]) => r.expectedQty !== null && r.items.length > 0 && r.items.every((i) => i.variantId) && new Set(r.items.map((i) => i.variantId)).size === 1;
  const duDieuKien = kienChoDem.filter(motMauMa).slice(0, 2);
  assert.ok(duDieuKien.length > 0, "fixture: phải có kiện một mẫu mã để kiểm đường hàng loạt");
  const loat = duDieuKien.map((r) => r.shipmentId);
  const tonTruocLoat = await tongTaiNhap();

  /*
    ─── "NHẬN ĐỦ" HÀNG LOẠT KHÔNG NHẬN MỘT CON SỐ ĐẾM NÀO, NÊN NÓ CẦN MỘT LỜI KHAI ───

    Đường đếm MỘT kiện có ô số: người kho gõ số họ đếm được, và một kiện hoàn một phần tự lộ ra ở
    con số đó. Đường HÀNG LOẠT không có ô số nào — bấm một cái là khẳng định "cả lô này về đủ theo
    đơn". Với kiện chưa có phiếu trả từng món (`ORDER_ONLY`) thì đó là khẳng định thay cho một thứ
    ERP không biết, và một kiện hoàn một phần sẽ cộng tồn dư mà không để lại dấu vết.

    Trước bản 14/09/2026 đường này không hỏi gì (nó chỉ chạy được cho kiện MỘT mẫu mã, nên phạm vi
    hẹp hơn và cái lỗ ít lộ ra). Nay nó chạy cho cả kiện nhiều mẫu mã, nên cái lỗ ấy phải bịt: máy
    chủ từ chối kèm LÝ DO, và người kho tick một ô nói rõ mình đã mở kiện đối chiếu thật.
  */
  const chuaKhai = await recordInspectionBulk(loat, "RESTOCKABLE", "", { id: null, label: "kho@test" });
  assert.equal(chuaKhai.done, 0, "chưa khai đã đối chiếu thì kiện ORDER_ONLY không được ghi 'về đủ' hàng loạt");
  assert.equal(chuaKhai.failed.length, loat.length, "và mỗi kiện bị chặn phải được nêu tên — không bỏ qua im lặng");
  assert.match(chuaKhai.failed[0].error, /đối chiếu/, "lý do phải nói rõ người kho cần làm gì, không chỉ 'không hợp lệ'");
  assert.equal(await tongTaiNhap(), tonTruocLoat, "lượt bị từ chối KHÔNG được cộng một món nào vào tồn");

  const kqLoat = await recordInspectionBulk(loat, "RESTOCKABLE", "", { id: null, label: "kho@test" }, true);
  assert.equal(kqLoat.done, loat.length, "khai đã đối chiếu thực tế ⇒ mọi kiện hợp lệ trong lượt phải được xử lý");
  assert.equal(kqLoat.failed.length, 0, "không kiện nào được phép hỏng im lặng");
  const congThem = duDieuKien.reduce((t, r) => t + (r.expectedQty ?? 0), 0);
  assert.equal(await tongTaiNhap(), tonTruocLoat + congThem, "hàng loạt “nhận đủ” cộng ĐÚNG BẰNG số ERP đã xuất, không hơn không kém");

  // Chạy lại đúng lượt đó: đã đếm rồi thì bị chặn, và LỖI PHẢI HIỆN RA kèm tên kiện.
  const lanHai = await recordInspectionBulk(loat, "RESTOCKABLE", "", { id: null, label: "kho@test" }, true);
  assert.equal(lanHai.done, 0, "kiện đã đếm không được đếm lại qua đường hàng loạt");
  assert.equal(lanHai.failed.length, loat.length, "kiện bị chặn phải được nêu tên, không nuốt lỗi");

  // Kết luận KHÔNG vào tồn thì phải có lý do — kể cả khi làm hàng loạt.
  const conLai = (await listPendingInspections(50))[0];
  if (conLai) {
    const tonTruocHong = await tongTaiNhap();
    const hong = await recordInspectionBulk([conLai.shipmentId], "DAMAGED", "vỡ khi vận chuyển", { id: null, label: "kho@test" });
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

  /**
   * ───────── 10. KIỆN NHIỀU MẪU MÃ: MỘT CON SỐ TỔNG KHÔNG PHÂN BỔ ĐƯỢC, "VỀ ĐỦ" THÌ CÓ ─────────
   *
   * Trước đây kiện 1 áo đỏ + 1 áo đen, kho bấm "nhận đủ" ⇒ ERP chia 2 món theo tỷ lệ dòng hàng rồi
   * làm tròn — một phép đoán ghi vào sổ như đã đếm.
   *
   * Ranh giới đúng KHÔNG nằm ở "kiện mấy mẫu mã" mà ở **con số đầu vào nói được gì**:
   *
   *  · MỘT SỐ TỔNG (`recordInspection`) trên kiện nhiều mẫu mã ⇒ vẫn TỪ CHỐI. Đếm được 2 trong kiện
   *    1 đỏ + 1 đen có thể là "2 đỏ" hoặc "1 đỏ 1 đen"; ghi bừa làm sai tồn HAI mẫu mã ngược chiều.
   *  · "VỀ ĐỦ" (`recordFullReturnInspection`) ⇒ CHẠY ĐƯỢC. Đó là khẳng định TỪNG DÒNG — mỗi mẫu mã
   *    về đúng số kỳ vọng của nó — nên phân bổ hoàn toàn xác định, không còn gì để đoán.
   *
   * Đo trên production 14/09/2026: 300 kiện vào hàng đợi đếm bằng lượt đối soát sổ giấy, phần lớn
   * là kiện hai mẫu mã. Ranh giới cũ bắt mở ngăn kéo đếm từng món ba trăm lần cho một kết luận
   * luôn giống nhau.
   */
  await db
    .insert(schema.productVariants)
    .values({ id: "ins-var-2", productId: "ins-prod", sku: "INS-002", color: "Đen", size: "L", retailPrice: 300000 })
    .onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "ins-order-mv", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-03T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values([
      { id: "ins-item-mv-1", orderId: "ins-order-mv", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 1, unitPrice: 300000, lineTotal: 300000 },
      { id: "ins-item-mv-2", orderId: "ins-order-mv", variantId: "ins-var-2", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-002", quantity: 1, unitPrice: 300000, lineTotal: 300000 },
    ])
    .onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "ins-ship-mv", orderId: "ins-order-mv", vtpOrderNumber: "INSMV01", stage: "RETURNED", returnedAt: new Date("2026-08-22T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["ins-ship-mv"], { id: null, label: "nguoi-nhan-hang" });

  const phieuTaiNhapCua = async (shipmentId: string) =>
    db.select({ v: schema.stockReceiptItems.variantId, q: schema.stockReceiptItems.quantity }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.shipmentId, shipmentId));

  const nhieuMau = await recordInspection({ shipmentId: "ins-ship-mv", condition: "RESTOCKABLE", restockQty: 2, unsellableQty: 0, note: "", actor: { id: null, label: "kho" } });
  assert.ok("error" in nhieuMau, "kiện nhiều mẫu mã: đường đếm nhanh phải TỪ CHỐI, không được phân bổ theo tỷ lệ");
  assert.ok("error" in nhieuMau && nhieuMau.error.includes("Kiểm từng món"), "lý do phải chỉ đường: đếm từng món");
  assert.equal((await phieuTaiNhapCua("ins-ship-mv")).length, 0, "bị từ chối thì không có phiếu kho nào");
  const [mvRow] = await db.select({ status: schema.returnInspections.status }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ins-ship-mv"));
  assert.equal(mvRow.status, "RECEIVED", "kiện vẫn CHỜ ĐẾM — không có phiếu 'bán lại được, 0 món' lặng lẽ");

  // Hàng loạt "nhận đủ" trên kiện chưa có phiếu trả từng món: chặn kèm LÝ DO, không bỏ qua im lặng.
  const loatChuaKhai = await recordInspectionBulk(["ins-ship-mv"], "RESTOCKABLE", "", { id: null, label: "kho" });
  assert.equal(loatChuaKhai.done, 0, "chưa khai đã đối chiếu thì không được ghi 'về đủ' hàng loạt");
  assert.equal(loatChuaKhai.failed.length, 1, "kiện bị bỏ qua phải được nêu tên");
  assert.equal(loatChuaKhai.failed[0].code, "INSMV01", "nêu MÃ KIỆN để người đếm nhận ra, không chỉ id");
  assert.match(loatChuaKhai.failed[0].error, /đối chiếu/, "và lý do nói rõ phải làm gì");
  assert.equal((await phieuTaiNhapCua("ins-ship-mv")).length, 0, "lượt bị từ chối không để lại phiếu kho");

  // Khai đã đối chiếu ⇒ chạy, và vào ĐÚNG từng mẫu mã — đây là điều bản 14/09/2026 mở ra.
  const loatNhieuMau = await recordInspectionBulk(["ins-ship-mv"], "RESTOCKABLE", "", { id: null, label: "kho" }, true);
  assert.equal(loatNhieuMau.done, 1, "kiện nhiều mẫu mã 'về đủ' phải chạy được qua đường hàng loạt");
  assert.equal(loatNhieuMau.failed.length, 0);
  const dongMv = await phieuTaiNhapCua("ins-ship-mv");
  assert.equal(dongMv.length, 2, "MỖI mẫu mã một dòng phiếu — không gộp 2 món vào một mẫu mã rồi mất dấu");
  assert.equal(dongMv.find((d) => d.v === "ins-var")?.q, 1, "mẫu đỏ về đúng 1, không phải nửa của 2 làm tròn");
  assert.equal(dongMv.find((d) => d.v === "ins-var-2")?.q, 1, "mẫu đen về đúng 1");

  // Kết luận KHÔNG vào tồn trên kiện nhiều mẫu mã: vẫn ghi được, và vẫn không cộng tồn.
  // (Kiện `ins-ship-mv` đã đếm xong ở trên nên dựng một kiện riêng — đếm lại lần hai bị chặn, đúng luật.)
  await db.insert(schema.orders).values({ id: "ins-order-mv2", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-03T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values([
      { id: "ins-item-mv2-1", orderId: "ins-order-mv2", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 1, unitPrice: 300000, lineTotal: 300000 },
      { id: "ins-item-mv2-2", orderId: "ins-order-mv2", variantId: "ins-var-2", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-002", quantity: 1, unitPrice: 300000, lineTotal: 300000 },
    ])
    .onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "ins-ship-mv2", orderId: "ins-order-mv2", vtpOrderNumber: "INSMV02", stage: "RETURNED", returnedAt: new Date("2026-08-22T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["ins-ship-mv2"], { id: null, label: "nguoi-nhan-hang" });
  const hongNhieuMau = await recordInspection({ shipmentId: "ins-ship-mv2", condition: "DAMAGED", restockQty: 0, unsellableQty: 2, note: "ướt cả kiện", actor: { id: null, label: "kho" } });
  assert.ok("ok" in hongNhieuMau && hongNhieuMau.restocked === 0, "kết luận hỏng không cần biết mẫu mã nào — ghi được, 0 món vào tồn");
  assert.equal((await phieuTaiNhapCua("ins-ship-mv2")).length, 0, "kết luận hỏng tuyệt đối không sinh phiếu kho");

  // Đếm được NHIỀU HƠN kỳ vọng trên kiện một mẫu mã cũng không đi đường tắt.
  await db.insert(schema.orders).values({ id: "ins-order-over", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-03T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ins-item-over", orderId: "ins-order-over", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 1, unitPrice: 300000, lineTotal: 300000 })
    .onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "ins-ship-over", orderId: "ins-order-over", vtpOrderNumber: "INSOVER1", stage: "RETURNED", returnedAt: new Date("2026-08-22T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["ins-ship-over"], { id: null, label: "nguoi-nhan-hang" });
  const vuot = await recordInspection({ shipmentId: "ins-ship-over", condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 0, note: "", actor: { id: null, label: "kho" } });
  assert.ok("error" in vuot, "đếm 3 khi đơn chỉ có 1: phải qua đường từng món kèm lý do, không cộng 3 lặng lẽ");
  assert.equal((await phieuTaiNhapCua("ins-ship-over")).length, 0);

  /**
   * ───────── 11. VẬN ĐƠN CHIỀU VỀ (mã gốc + 1P1): `order_id` NULL nhưng vẫn phải cộng đúng mẫu mã ─────────
   *
   * Trước đây `createRestockReceipt` đọc `return_inspections.order_id` — NULL cho mọi vận đơn chiều
   * về — nên trả `null` và phiếu ghi "bán lại được, 0 món" mà không ai hay. Nay đơn được lần lại
   * bằng ĐỊNH DANH (mã gốc → vận đơn chiều đi → đơn) ngay lúc đếm.
   */
  await db.insert(schema.orders).values({ id: "ins-order-leg", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-04T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ins-item-leg", orderId: "ins-order-leg", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 2, unitPrice: 300000, lineTotal: 600000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values([
      // Chiều đi: chưa nhận mã kết thúc (còn RETURNING) — chưa đủ điều kiện vào hàng chờ kho.
      { id: "ins-ship-leg-out", orderId: "ins-order-leg", vtpOrderNumber: "INSLEGBASE01", stage: "RETURNING" },
      // Chiều về: dòng riêng, không đơn, mang mã gốc ở order_reference (luật 7), đã phát về shop.
      { id: "ins-ship-leg-back", orderId: null, orderReference: "INSLEGBASE01", vtpOrderNumber: "INSLEGBASE011P1", stage: "RETURNED", returnedAt: new Date("2026-08-23T00:00:00Z") },
    ])
    .onConflictDoNothing();

  const choKho = await listPendingReturnedIds(1000);
  assert.ok(choKho.includes("ins-ship-leg-back"), "vận đơn chiều về đã phát về shop là bằng chứng duy nhất khi chiều đi chưa kết thúc — phải nằm trong hàng chờ kho");
  assert.ok(!choKho.includes("ins-ship-leg-out"), "chiều đi còn RETURNING thì chưa được vào hàng chờ");

  await markReturnsArrived(["ins-ship-leg-back"], { id: null, label: "nguoi-nhan-hang" });
  const legPending = (await listPendingInspections(1000)).find((r) => r.shipmentId === "ins-ship-leg-back");
  assert.ok(legPending, "kiện chiều về phải nằm trong hàng đợi đếm");
  assert.equal(legPending.linkBasis, "RETURN_LEG", "ghép đơn qua mã gốc, không phải 'chưa xác định'");
  assert.equal(legPending.expectedQty, 2, "số kỳ vọng lần ra từ đơn của vận đơn chiều đi");

  const demLeg = await recordInspection({ shipmentId: "ins-ship-leg-back", condition: "RESTOCKABLE", restockQty: 2, unsellableQty: 0, note: "", actor: { id: null, label: "kho-leg" } });
  assert.ok("ok" in demLeg, `đếm kiện chiều về phải thành công: ${"error" in demLeg ? demLeg.error : ""}`);
  assert.equal("ok" in demLeg && demLeg.restocked, 2, "2 món vào tồn — không phải 0 vì order_id NULL");
  const phieuLeg = await phieuTaiNhapCua("ins-ship-leg-back");
  assert.equal(phieuLeg.length, 1);
  assert.equal(phieuLeg[0].v, "ins-var", "vào đúng mẫu mã của đơn lần ra");
  assert.equal(Number(phieuLeg[0].q), 2);
  const [legIns] = await db.select({ orderId: schema.returnInspections.orderId, restockQty: schema.returnInspections.restockQty }).from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ins-ship-leg-back"));
  assert.equal(legIns.orderId, "ins-order-leg", "phiếu kiểm điền đơn vừa lần ra để lịch sử tra được theo đơn");
  assert.equal(legIns.restockQty, 2);
  const [legOut] = await db.select({ at: schema.shipments.returnReceivedAt }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-leg-out"));
  assert.ok(legOut.at, "vận đơn CHIỀU ĐI cùng mã gốc cũng được đóng — cùng một kiện vật lý không được hiện lại lần hai");

  // Chiều đi và chiều về CÙNG RETURNED: chỉ MỘT dòng vào hàng chờ, nếu không kho đếm hai lần.
  await db.insert(schema.orders).values({ id: "ins-order-dd", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-04T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ins-item-dd", orderId: "ins-order-dd", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 1, unitPrice: 300000, lineTotal: 300000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values([
      { id: "ins-ship-dd-out", orderId: "ins-order-dd", vtpOrderNumber: "INSDDBASE01", stage: "RETURNED", returnedAt: new Date("2026-08-23T00:00:00Z") },
      { id: "ins-ship-dd-back", orderId: null, orderReference: "INSDDBASE01", vtpOrderNumber: "INSDDBASE011P1", stage: "RETURNED", returnedAt: new Date("2026-08-23T00:00:00Z") },
    ])
    .onConflictDoNothing();
  const choKho2 = await listPendingReturnedIds(1000);
  assert.ok(choKho2.includes("ins-ship-dd-out"), "chiều đi đã RETURNED thì chính nó nằm trong hàng chờ");
  assert.ok(!choKho2.includes("ins-ship-dd-back"), "chiều về của CÙNG kiện không được hiện thêm một dòng — đếm hai lần là cộng tồn hai lần");

  // Kiện KHÔNG lần ra đơn nào: "nhận đủ" hàng loạt bỏ qua kèm lý do; kết luận hỏng vẫn ghi được.
  await db.insert(schema.shipments).values({ id: "ins-ship-unres", orderId: null, orderReference: "KHONG-CO-GOC", vtpOrderNumber: "INSUNRES1", stage: "RETURNED", returnedAt: new Date("2026-08-23T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["ins-ship-unres"], { id: null, label: "nguoi-nhan-hang" });
  const loatUnres = await recordInspectionBulk(["ins-ship-unres"], "RESTOCKABLE", "", { id: null, label: "kho" });
  assert.equal(loatUnres.done, 0, "chưa ghép được đơn thì không có số kỳ vọng để 'nhận đủ'");
  assert.equal(loatUnres.failed.length, 1);
  const demUnres = await recordInspection({ shipmentId: "ins-ship-unres", condition: "RESTOCKABLE", restockQty: 1, unsellableQty: 0, note: "", actor: { id: null, label: "kho" } });
  assert.ok("error" in demUnres, "cộng tồn mà không biết mẫu mã nào thì phải từ chối, không ghi 0 lặng lẽ");
  const hongUnres = await recordInspection({ shipmentId: "ins-ship-unres", condition: "WRONG_ITEM", restockQty: 0, unsellableQty: 1, note: "áo lạ, không có trong danh mục", actor: { id: null, label: "kho" } });
  assert.ok("ok" in hongUnres, "kết luận không vào tồn ghi được cho kiện chưa ghép đơn");

  /**
   * ───────── 12. PHIẾU TÁI NHẬP LẬP TAY chỉ đóng ĐÚNG vận đơn dòng phiếu chỉ tên ─────────
   *
   * Trước đây phiếu tái nhập ở trang Nhập kho gạch các vận đơn hoàn CŨ NHẤT có mẫu mã đó (FIFO) —
   * ERP tự kết luận kiện nào đã về mà không ai nhìn thấy kiện đó, không có biên bản đếm.
   */
  await db.insert(schema.orders).values({ id: "ins-order-rc", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-05T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values({ id: "ins-item-rc", orderId: "ins-order-rc", variantId: "ins-var", productId: "ins-prod", productName: "Áo kiểm hàng hoàn", sku: "INS-001", quantity: 3, unitPrice: 300000, lineTotal: 900000 })
    .onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values([
      { id: "ins-ship-rc", orderId: "ins-order-rc", vtpOrderNumber: "INSRC01", stage: "RETURNED", returnedAt: new Date("2026-08-10T00:00:00Z") },
      // Kiện CŨ HƠN cùng mẫu mã: FIFO cũ sẽ gạch kiện này trước — nay nó phải nằm yên.
      { id: "ins-ship-rc-cu", orderId: "ins-order-rc", vtpOrderNumber: "INSRC00", stage: "RETURNED", returnedAt: new Date("2026-08-01T00:00:00Z") },
    ])
    .onConflictDoNothing();

  const [phieuTay] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RETURN", receivedAt: new Date(), reference: "phieu-tay-1", totalQuantity: 4, totalCost: 0, createdBy: "kho-phieu" })
    .returning({ id: schema.stockReceipts.id });
  const dong = await db.transaction((tx) =>
    settleReturnsForReceipt(tx, {
      receiptId: phieuTay.id,
      lines: [
        { variantId: "ins-var", quantity: 3, shipmentId: "ins-ship-rc" },
        // Dòng KHÔNG nêu vận đơn: cộng tồn theo số đếm, nhưng không gạch kiện nào.
        { variantId: "ins-var", quantity: 1, shipmentId: null },
      ],
      actor: { id: null, label: "kho-phieu" },
      note: "phiếu tay",
    }),
  );
  assert.ok("ok" in dong, `phiếu tay hợp lệ phải đóng được kiện: ${"error" in dong ? dong.error : ""}`);
  assert.deepEqual("ok" in dong && dong.settledShipmentIds, ["ins-ship-rc"], "chỉ đóng ĐÚNG vận đơn dòng phiếu chỉ tên");
  const [rcIns] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ins-ship-rc"));
  assert.ok(rcIns, "phiếu tay phải để lại một phiếu kiểm — không có kiện 'đã về' mà không có biên bản");
  assert.equal(rcIns.status, "INSPECTED");
  assert.equal(rcIns.restockQty, 3, "số vào tồn của kiện = đúng số dòng phiếu ghi cho kiện đó");
  assert.equal(rcIns.stockReceiptId, phieuTay.id, "phiếu kiểm trỏ về phiếu kho để truy nguyên hai chiều");
  assert.equal(rcIns.inspectedBy, "kho-phieu");
  assert.equal(rcIns.receivedBy, "kho-phieu");
  const [rcShip] = await db.select({ at: schema.shipments.returnReceivedAt }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-rc"));
  assert.ok(rcShip.at, "vận đơn được chỉ tên phải được đóng");
  const [rcCu] = await db.select({ at: schema.shipments.returnReceivedAt }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-rc-cu"));
  assert.equal(rcCu.at, null, "kiện CŨ HƠN cùng mẫu mã KHÔNG bị gạch — không còn đoán FIFO");
  const rcCuIns = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "ins-ship-rc-cu"));
  assert.equal(rcCuIns.length, 0, "và cũng không có phiếu kiểm nào bị bịa cho nó");

  // Chỉ tên một kiện ĐÃ ĐẾM ⇒ từ chối cả phiếu.
  const lanHaiTay = await db.transaction((tx) =>
    settleReturnsForReceipt(tx, { receiptId: phieuTay.id, lines: [{ variantId: "ins-var", quantity: 1, shipmentId: "ins-ship-rc" }], actor: { id: null, label: "kho-phieu" } }),
  );
  assert.ok("error" in lanHaiTay, "kiện đã đếm thì phiếu tay chỉ tên nó phải bị từ chối — đếm hai lần là cộng tồn hai lần");

  // Phiếu KHÔNG nêu vận đơn nào ⇒ không gạch kiện nào, không bịa phiếu kiểm.
  const khongTen = await db.transaction((tx) =>
    settleReturnsForReceipt(tx, { receiptId: phieuTay.id, lines: [{ variantId: "ins-var", quantity: 5, shipmentId: null }], actor: { id: null, label: "kho-phieu" } }),
  );
  assert.ok("ok" in khongTen && khongTen.settledShipmentIds.length === 0, "không nêu vận đơn thì không gạch kiện nào");
  const [rcCu2] = await db.select({ at: schema.shipments.returnReceivedAt }).from(schema.shipments).where(eq(schema.shipments.id, "ins-ship-rc-cu"));
  assert.equal(rcCu2.at, null, "kiện cũ vẫn nằm yên trong hàng chờ");

  // Tổng hợp: số món CHƯA BIẾT là null, kiện chưa rõ hàng được đếm riêng — không phải 0.
  clearMemo();
  const tongCuoi = await inspectionSummary();
  assert.ok(typeof tongCuoi.unknownParcels === "number", "phải nêu số kiện chưa rõ hàng");
  assert.ok(tongCuoi.pendingItems === null || tongCuoi.pendingItems >= 0, "số món kỳ vọng là số thật hoặc CHƯA BIẾT (null)");

  console.log(
    "✓ Lá chắn đếm nhanh: kiện nhiều mẫu mã bị từ chối kèm lý do (không phân bổ) · vận đơn chiều về cộng đúng mẫu mã (không ghi 0) và đóng cả chiều đi · chiều đi/chiều về cùng kiện chỉ hiện một dòng · phiếu tái nhập tay chỉ đóng vận đơn được chỉ tên (không FIFO)",
  );

  console.log(
    `✓ Kiểm đếm hàng hoàn: ghi nhận đã về không cộng tồn · đếm 3/4 món → tồn +3, hao 1 · đếm lại bị chặn · huỷ sau khi đếm bị chặn · ${summary.pending} kiện đang chờ đếm`,
  );
  console.log(
    `✓ Trạm đếm: quét mã ra đúng kiện (không phân biệt hoa thường, mã lạ trả CHƯA THẤY) · hàng loạt cộng đúng số đã xuất · đếm lại bị chặn và nêu tên · kết luận hỏng KHÔNG cộng tồn · ${bang.aging.duoi1Ngay + bang.aging.tu1Den3Ngay + bang.aging.tu3Den7Ngay + bang.aging.tren7Ngay} kiện phân theo 4 nhóm tuổi`,
  );
}
