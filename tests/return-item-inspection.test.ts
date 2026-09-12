import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { ITEM_CONDITIONS, ITEM_CONDITION_RESTOCKS } from "@/lib/constants/return-lifecycle";
import { listInspectedItems, listPendingInspections, markReturnsArrived, recordItemInspection } from "@/lib/returns/inspection";

/**
 * ───────── ĐẾM HÀNG HOÀN THEO TỪNG MÓN ─────────
 *
 * Điều được khoá ở đây: một kiện ba món có ba kết luận khác nhau phải ghi lại được đúng như thế,
 * và CHỈ phần thực sự còn bán được mới chạm tới tồn kho.
 *
 * Vì sao đáng khoá: cách sai hấp dẫn là "kiện đã kiểm ⇒ cộng lại đúng số đã xuất". Nó chạy đẹp
 * trên màn hình và ghi vào sổ một lượng hàng không có thật; phần chênh nằm im tới kỳ kiểm kê, còn
 * kế hoạch sản xuất suốt thời gian đó đặt thiếu đúng bằng phần chênh ấy.
 */
export async function testReturnItemInspection(db: Db) {
  // ───────── Dàn cảnh: kiện 3 món của 2 mẫu mã riêng ─────────
  await db.insert(schema.products).values({ id: "rii-prod", name: "Áo RII" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "rii-var-a", productId: "rii-prod", sku: "RII-A", color: "Đỏ", size: "L", retailPrice: 200000 },
      { id: "rii-var-b", productId: "rii-prod", sku: "RII-B", color: "Đen", size: "M", retailPrice: 200000 },
      { id: "rii-var-c", productId: "rii-prod", sku: "RII-C", color: "Xanh", size: "S", retailPrice: 200000 },
    ])
    .onConflictDoNothing();
  await db.insert(schema.orders).values({ id: "rii-order", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-01T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values([
      { id: "rii-ship", orderId: "rii-order", vtpOrderNumber: "RII001", stage: "RETURNED", returnedAt: new Date("2026-08-20T00:00:00Z") },
      { id: "rii-ship2", orderId: "rii-order", vtpOrderNumber: "RII002", stage: "RETURNED", returnedAt: new Date("2026-08-21T00:00:00Z") },
    ])
    .onConflictDoNothing();

  /** Tổng số món đã vào lại tồn của MỘT kiện — thước đo duy nhất đáng tin. */
  const daVaoTon = async (shipmentId: string) => {
    const rows = await db.select({ q: schema.stockReceiptItems.quantity, v: schema.stockReceiptItems.variantId }).from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.shipmentId, shipmentId));
    return { tong: rows.reduce((t, r) => t + Number(r.q ?? 0), 0), dong: rows };
  };

  // ───────── 1. Hằng số và ràng buộc CSDL phải khớp nhau ─────────
  // Đã có tiền lệ lệch: nút bấm hợp lệ ở giao diện nhưng CSDL từ chối, đúng lúc người kho đang đếm.
  for (const c of ITEM_CONDITIONS) {
    assert.equal(typeof ITEM_CONDITION_RESTOCKS[c], "boolean", `${c} phải khai rõ có cộng tồn hay không`);
  }
  assert.equal(
    ITEM_CONDITIONS.filter((c) => ITEM_CONDITION_RESTOCKS[c]).join(","),
    "OK",
    "CHỈ 'Đủ' mới được cộng tồn — hàng bẩn/hỏng/sai nằm trên bàn thật nhưng chưa bán lại được",
  );

  // ───────── 2. Chưa ghi nhận về kho thì không đếm được ─────────
  const chuaVe = await recordItemInspection({
    shipmentId: "rii-ship",
    actor: "kho",
    items: [{ expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 1, actualVariantId: null, actualSku: "", actualQty: 1, condition: "OK", note: "" }],
  });
  assert.ok("error" in chuaVe, "kiện chưa ghi nhận về kho thì không được đếm");

  // ───────── 3. RECEIVED_AT_WAREHOUSE KHÔNG cộng tồn ─────────
  const arrived = await markReturnsArrived(["rii-ship", "rii-ship2"], "nguoi-nhan");
  assert.equal(arrived.count, 2);
  assert.equal((await daVaoTon("rii-ship")).tong, 0, "bấm 'đã nhận' KHÔNG được cộng một món nào vào tồn");

  // ───────── 4. Kết luận không phải 'Đủ' mà không nêu lý do thì bị chặn ─────────
  const thieuLyDo = await recordItemInspection({
    shipmentId: "rii-ship",
    actor: "kho",
    items: [{ expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 2, actualVariantId: null, actualSku: "", actualQty: 1, condition: "SHORT", note: "  " }],
  });
  assert.ok("error" in thieuLyDo, "thiếu hàng mà không nói vì sao thì phần hàng mất biến mất không dấu vết");
  assert.equal((await daVaoTon("rii-ship")).tong, 0, "lần ghi bị từ chối KHÔNG được để lại phiếu kho nào");

  // ───────── 5. Ba món ba kết luận: chỉ phần 'Đủ' vào tồn ─────────
  const ket = await recordItemInspection({
    shipmentId: "rii-ship",
    actor: "kho-a",
    items: [
      // đủ 2 cái → vào tồn
      { expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 2, actualVariantId: null, actualSku: "", actualQty: 2, condition: "OK", note: "" },
      // kỳ vọng 2, chỉ về 1 → lệch số lượng, KHÔNG vào tồn
      { expectedVariantId: "rii-var-b", expectedSku: "RII-B", expectedName: "Áo RII", expectedColor: "Đen", expectedSize: "M", expectedQty: 2, actualVariantId: null, actualSku: "", actualQty: 1, condition: "SHORT", note: "chỉ thấy 1 cái trong kiện" },
      // khách trả nhầm mẫu khác → KHÔNG vào tồn dù hàng còn nguyên
      { expectedVariantId: "rii-var-c", expectedSku: "RII-C", expectedName: "Áo RII", expectedColor: "Xanh", expectedSize: "S", expectedQty: 1, actualVariantId: "rii-var-a", actualSku: "RII-A", actualQty: 1, condition: "WRONG_ITEM", note: "khách trả về mẫu đỏ" },
    ],
  });
  assert.ok("ok" in ket && ket.ok, "đếm theo món phải thành công");
  assert.equal(ket.restocked, 2, "chỉ 2 món kết luận 'Đủ' được vào tồn");
  assert.equal(ket.hasDiscrepancy, true, "có lệch số lượng và có hàng sai ⇒ phải bật cờ lệch");

  const ton = await daVaoTon("rii-ship");
  assert.equal(ton.tong, 2, "tồn chỉ tăng đúng 2 — không phải 5 món kỳ vọng, cũng không phải 4 món thực nhận");
  assert.equal(ton.dong.length, 1, "chỉ một dòng phiếu vì chỉ một mẫu mã còn bán được");
  assert.equal(ton.dong[0].v, "rii-var-a", "vào đúng mẫu mã đếm được, không phân bổ theo tỷ lệ dòng hàng của đơn");

  // Hàng SAI dù còn nguyên vẹn vẫn KHÔNG được cộng vào mẫu mã thực nhận — nó là thất thoát có tên.
  const vaoVarA = ton.dong.filter((d) => d.v === "rii-var-a").reduce((t, d) => t + Number(d.q ?? 0), 0);
  assert.equal(vaoVarA, 2, "món 'sai hàng' trả về mẫu đỏ KHÔNG được cộng thêm vào mẫu đỏ");

  // ───────── 6. Kết quả từng món đọc lại được, đủ căn cứ truy nguyên ─────────
  const items = await listInspectedItems("rii-ship");
  assert.equal(items.length, 3, "ba món phải còn nguyên ba dòng");
  const b = items.find((i) => i.expectedSku === "RII-B")!;
  assert.equal(b.expectedQty, 2);
  assert.equal(b.actualQty, 1);
  assert.equal(b.condition, "SHORT");
  assert.ok(b.note.length > 0 && b.inspectedBy === "kho-a" && b.inspectedAt, "mỗi món phải biết ai kiểm, lúc nào, vì sao");
  // Ảnh chụp hàng kỳ vọng nằm ngay trên dòng: đơn bị sửa hay mẫu mã bị xoá sau này cũng không xoá
  // được dấu vết phần lệch.
  assert.equal(b.expectedName, "Áo RII");
  assert.equal(b.expectedSize, "M");

  // ───────── 7. Phiếu kiện suy ra từ các món, số cũ vẫn đọc được ─────────
  const [phieu] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "rii-ship"));
  assert.equal(phieu.status, "INSPECTED");
  assert.equal(phieu.condition, "MISSING", "có món thiếu ⇒ kết luận cả kiện lấy mức nghiêm trọng nhất");
  assert.equal(phieu.restockQty, 2, "số cộng tồn của phiếu kiện phải khớp số thực vào tồn");
  assert.ok(phieu.note.includes("RII-B"), "lý do gộp phải nêu được món nào lệch");
  assert.ok(phieu.stockReceiptId, "phiếu kiểm phải trỏ tới phiếu kho để truy nguyên hai chiều");

  // ───────── 8. Đếm lần hai bị chặn (chống bấm trùng) ─────────
  const lanHai = await recordItemInspection({
    shipmentId: "rii-ship",
    actor: "kho-b",
    items: [{ expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 2, actualVariantId: null, actualSku: "", actualQty: 2, condition: "OK", note: "" }],
  });
  assert.ok("error" in lanHai, "đếm lại lần hai phải bị chặn — nếu không, phiếu tái nhập cộng tồn hai lần");
  assert.equal((await daVaoTon("rii-ship")).tong, 2, "sau lần bấm trùng, tồn vẫn đúng 2");

  // ───────── 8b. Nhận lần hai là vô hại: không tạo dòng mới, không đổi mốc nhận ─────────
  const lanNhanHai = await markReturnsArrived(["rii-ship"], "nguoi-nhan-2");
  assert.equal(lanNhanHai.count, 0, "kiện đã nhận thì bấm 'đã nhận' lần nữa không tạo thêm gì");
  const [phieuSauNhanHai] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "rii-ship"));
  assert.equal(phieuSauNhanHai.receivedBy, "nguoi-nhan", "mốc nhận đầu tiên phải giữ nguyên, không bị người sau ghi đè");

  // ───────── 8c. Danh sách kỳ vọng CHỈ suy từ cả đơn (không có phiếu trả từng món) ⇒ phải xác nhận đối chiếu ─────────
  await db.insert(schema.orders).values({ id: "rii-order3", stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-02T00:00:00Z") }).onConflictDoNothing();
  await db
    .insert(schema.orderItems)
    .values([
      { id: "rii-oi-3a", orderId: "rii-order3", variantId: "rii-var-a", productId: "rii-prod", productName: "Áo RII", sku: "RII-A", quantity: 2, unitPrice: 200000, returnQuantity: 0 },
      { id: "rii-oi-3b", orderId: "rii-order3", variantId: "rii-var-b", productId: "rii-prod", productName: "Áo RII", sku: "RII-B", quantity: 1, unitPrice: 200000, returnQuantity: 0 },
    ])
    .onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: "rii-ship3", orderId: "rii-order3", vtpOrderNumber: "RII003", stage: "RETURNED", returnedAt: new Date("2026-08-22T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["rii-ship3"], "nguoi-nhan");
  const choDem = (await listPendingInspections(500)).find((r) => r.shipmentId === "rii-ship3");
  assert.ok(choDem, "kiện vừa nhận phải nằm trong hàng đợi đếm");
  assert.equal(choDem.itemsBasis, "ORDER_ONLY", "đơn không có phiếu trả từng món ⇒ căn cứ chỉ là cả đơn");
  assert.equal(choDem.expectedQty, 3, "kỳ vọng suy từ cả đơn: 2 + 1");
  const mon3 = [{ expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 2, actualVariantId: null, actualSku: "", actualQty: 2, condition: "OK" as const, note: "" }];
  const chuaXacNhan = await recordItemInspection({ shipmentId: "rii-ship3", actor: "kho-a", items: mon3 });
  assert.ok("error" in chuaXacNhan, "ORDER_ONLY mà chưa xác nhận đối chiếu thì KHÔNG được lưu — hoàn một phần sẽ cộng tồn cả đơn");
  assert.equal((await daVaoTon("rii-ship3")).tong, 0, "bị từ chối thì không có phiếu kho");
  const daXacNhan = await recordItemInspection({ shipmentId: "rii-ship3", actor: "kho-a", items: mon3, orderOnlyConfirmed: true });
  assert.ok("ok" in daXacNhan && daXacNhan.ok, "xác nhận đã đối chiếu ⇒ lưu được");
  assert.equal((await daVaoTon("rii-ship3")).tong, 2, "chỉ 2 món đếm được vào tồn, không phải 3 món của cả đơn");

  // ───────── 9. Kiện không món nào bán lại được: KHÔNG sinh phiếu kho ─────────
  const hong = await recordItemInspection({
    shipmentId: "rii-ship2",
    actor: "kho-a",
    items: [{ expectedVariantId: "rii-var-a", expectedSku: "RII-A", expectedName: "Áo RII", expectedColor: "Đỏ", expectedSize: "L", expectedQty: 1, actualVariantId: null, actualSku: "", actualQty: 1, condition: "DAMAGED", note: "rách vai" }],
  });
  assert.ok("ok" in hong && hong.ok);
  assert.equal(hong.restocked, 0);
  assert.equal(hong.receiptId, null, "không món nào bán lại được thì KHÔNG lập phiếu kho rỗng");
  assert.equal((await daVaoTon("rii-ship2")).tong, 0, "hàng hỏng về tới nơi vẫn KHÔNG vào tồn");
  const [phieu2] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, "rii-ship2"));
  assert.equal(phieu2.unsellableQty, 1, "món về mà không bán được phải đếm riêng, không bị giấu");

  console.log(
    "✓ Đếm hàng hoàn theo món: nhận ≠ kiểm ≠ vào tồn · 3 món 3 kết luận, chỉ 'Đủ' vào tồn (2/5 kỳ vọng) · đúng mẫu mã đếm được, không phân bổ tỷ lệ · sai hàng/thiếu/hỏng KHÔNG vào tồn nhưng đếm riêng · thiếu lý do bị chặn · đếm trùng bị chặn · ảnh chụp kỳ vọng giữ được dấu vết lệch",
  );
}
