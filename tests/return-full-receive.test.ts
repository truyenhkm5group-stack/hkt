import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { markReturnsArrived, recordFullReturnInspection, recordInspection, recordInspectionBulk } from "@/lib/returns/inspection";

/**
 * ═══════ "NHẬN ĐỦ" MỘT KIỆN NHIỀU MẪU MÃ ═══════
 *
 * Bối cảnh có thật (production 14/09/2026): 300 kiện vào hàng đợi đếm bằng lượt đối soát sổ hàng
 * hoàn viết tay, phần lớn là kiện HAI mẫu mã. Đường đếm nhanh cũ chỉ nhận kiện MỘT mẫu mã, nên cả
 * ba trăm kiện đó bắt buộc phải mở ngăn kéo đếm từng món — ba trăm lần, cho việc mà kết luận luôn
 * giống nhau: về đủ.
 *
 * ─── VÌ SAO ĐƯỜNG NHANH CŨ CHẶN KIỆN NHIỀU MẪU MÃ, VÀ VÌ SAO ĐƯỜNG NÀY KHÔNG ───
 *
 * Đường cũ nhận MỘT CON SỐ TỔNG. Kiện 2 đỏ + 1 đen mà nhận số 2 thì không ai biết đó là "2 đỏ" hay
 * "1 đỏ 1 đen" — ghi bừa là làm sai tồn của HAI mẫu mã theo hai chiều ngược nhau, và sai lặng lẽ
 * cho tới kỳ kiểm kê. Chặn là đúng.
 *
 * "Nhận đủ" thì KHÔNG phải một con số tổng: nó là lời khẳng định TỪNG DÒNG — mỗi mẫu mã về đúng số
 * kỳ vọng của nó. Phân bổ hoàn toàn xác định, không còn gì để đoán. Đó là toàn bộ khác biệt, và
 * đây là chỗ khoá nó lại.
 *
 * Bài kiểm này cũng khoá phần KHÔNG được nới: đếm THIẾU trên kiện nhiều mẫu mã vẫn phải bị chặn.
 */
export async function testReturnFullReceive(db: Db) {
  const nguoiKho = { id: null, label: "kho-full" };

  // Mã mẫu mã đặt riêng (RFR-*): bài kiểm dùng CHUNG một cơ sở dữ liệu với mọi bài khác, nên một
  // mã trùng với fixture của bài khác sẽ làm bộ tra danh mục báo mơ hồ — đã có tiền lệ.
  await db.insert(schema.products).values({ id: "rfr-prod", name: "Đầm RFR" }).onConflictDoNothing();
  await db
    .insert(schema.productVariants)
    .values([
      { id: "rfr-var-a", productId: "rfr-prod", sku: "RFR-A", color: "Đỏ", size: "L", retailPrice: 300000 },
      { id: "rfr-var-b", productId: "rfr-prod", sku: "RFR-B", color: "Đen", size: "M", retailPrice: 300000 },
    ])
    .onConflictDoNothing();

  const daVaoTon = async (shipmentId: string) => {
    const rows = await db
      .select({ q: schema.stockReceiptItems.quantity, v: schema.stockReceiptItems.variantId })
      .from(schema.stockReceiptItems)
      .where(eq(schema.stockReceiptItems.shipmentId, shipmentId));
    return { tong: rows.reduce((t, r) => t + Number(r.q ?? 0), 0), dong: rows };
  };

  /** Đơn + vận đơn hoàn, có/không phiếu trả từng món. */
  async function dungKien(hau: string, opts: { evidence: boolean }) {
    const orderId = `rfr-order-${hau}`;
    const shipmentId = `rfr-ship-${hau}`;
    await db.insert(schema.orders).values({ id: orderId, stage: "SHIPPED", status: 3, insertedAt: new Date("2026-08-01T00:00:00Z") }).onConflictDoNothing();
    await db
      .insert(schema.orderItems)
      .values([
        // Hai mẫu mã, số lượng KHÁC nhau: nếu ở đâu đó còn phân bổ theo tỷ lệ thì chênh lệch lộ ra ngay.
        { id: `rfr-oi-${hau}-a`, orderId, variantId: "rfr-var-a", productId: "rfr-prod", productName: "Đầm RFR", sku: "RFR-A", quantity: 2, unitPrice: 300000, returnQuantity: opts.evidence ? 2 : 0 },
        { id: `rfr-oi-${hau}-b`, orderId, variantId: "rfr-var-b", productId: "rfr-prod", productName: "Đầm RFR", sku: "RFR-B", quantity: 1, unitPrice: 300000, returnQuantity: opts.evidence ? 1 : 0 },
      ])
      .onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({ id: shipmentId, orderId, vtpOrderNumber: `RFR${hau}`, stage: "RETURNED", returnedAt: new Date("2026-08-20T00:00:00Z") })
      .onConflictDoNothing();
    await markReturnsArrived([shipmentId], nguoiKho);
    return shipmentId;
  }

  // ───────── 1. ĐƯỜNG CŨ VẪN CHẶN — và chặn vì đúng lý do ─────────
  const k1 = await dungKien("1", { evidence: true });
  const soTong = await recordInspection({ shipmentId: k1, condition: "RESTOCKABLE", restockQty: 3, unsellableQty: 0, note: "", actor: nguoiKho });
  assert.ok("error" in soTong, "một con số tổng KHÔNG được cộng tồn cho kiện nhiều mẫu mã");
  assert.match(soTong.error, /mẫu mã/, "lý do phải nói rõ vì sao, để người đếm biết chuyển sang đếm từng món");
  assert.equal((await daVaoTon(k1)).tong, 0, "lần bị từ chối không được để lại phiếu kho nào");

  // ───────── 2. "NHẬN ĐỦ" CHẠY ĐƯỢC, và vào ĐÚNG từng mẫu mã ─────────
  const du = await recordFullReturnInspection({ shipmentId: k1, actor: nguoiKho });
  assert.ok("ok" in du, `nhận đủ kiện nhiều mẫu mã phải chạy được: ${"error" in du ? du.error : ""}`);
  assert.equal(du.restocked, 3, "2 + 1 = 3 món vào lại tồn");
  assert.equal(du.variants, 2);
  const ton1 = await daVaoTon(k1);
  assert.equal(ton1.dong.length, 2, "MỖI mẫu mã một dòng phiếu — không gộp thành một dòng rồi mất dấu");
  assert.equal(ton1.dong.find((d) => d.v === "rfr-var-a")?.q, 2, "mẫu A về đúng 2, không phải một nửa của 3");
  assert.equal(ton1.dong.find((d) => d.v === "rfr-var-b")?.q, 1);
  const [phieu1] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, k1));
  assert.equal(phieu1.status, "INSPECTED");
  assert.equal(phieu1.condition, "RESTOCKABLE", "về đủ và còn bán được ⇒ kết luận cả kiện là bán lại được");
  assert.ok(phieu1.stockReceiptId, "phải trỏ tới phiếu kho để truy nguyên hai chiều");

  // ───────── 3. KHÔNG ĐẾM HAI LẦN ─────────
  const lanHai = await recordFullReturnInspection({ shipmentId: k1, actor: nguoiKho });
  assert.ok("error" in lanHai, "bấm lại lần hai phải bị chặn — nếu không, phiếu tái nhập cộng tồn hai lần");
  assert.equal((await daVaoTon(k1)).tong, 3, "sau lần bấm trùng, tồn vẫn đúng 3");

  // ───────── 4. CHỈ SUY TỪ CẢ ĐƠN ⇒ PHẢI CÓ LỜI KHAI ĐỐI CHIẾU ─────────
  // Đây là chỗ dễ nới lỏng nhất: "nhận đủ" nghe như một thao tác vô hại, nhưng với kiện chưa có
  // phiếu trả từng món thì nó khẳng định cả đơn đã quay về — một kiện hoàn MỘT PHẦN sẽ cộng tồn dư.
  const k2 = await dungKien("2", { evidence: false });
  const chuaKhai = await recordFullReturnInspection({ shipmentId: k2, actor: nguoiKho });
  assert.ok("error" in chuaKhai, "ORDER_ONLY mà chưa xác nhận đối chiếu thì không được ghi đủ");
  assert.equal((await daVaoTon(k2)).tong, 0);
  const daKhai = await recordFullReturnInspection({ shipmentId: k2, actor: nguoiKho, orderOnlyConfirmed: true });
  assert.ok("ok" in daKhai && daKhai.restocked === 3, "khai đã đối chiếu thực tế ⇒ ghi được");

  // ───────── 5. KHÔNG GHÉP ĐƯỢC ĐƠN ⇒ KHÔNG CÓ GÌ ĐỂ "ĐỦ" ─────────
  await db.insert(schema.shipments).values({ id: "rfr-ship-mo", vtpOrderNumber: "RFRMO", stage: "RETURNED", returnedAt: new Date("2026-08-20T00:00:00Z") }).onConflictDoNothing();
  await markReturnsArrived(["rfr-ship-mo"], nguoiKho);
  const mo = await recordFullReturnInspection({ shipmentId: "rfr-ship-mo", actor: nguoiKho });
  assert.ok("error" in mo, "kiện chưa ghép được đơn thì không có danh sách kỳ vọng — không có gì để gọi là 'đủ'");
  assert.equal((await daVaoTon("rfr-ship-mo")).tong, 0);

  // ───────── 6. HÀNG LOẠT: kiện nhiều mẫu mã CHẠY, kiện không ghép được BỊ TỪ CHỐI CÓ TÊN ─────────
  // Cái phải chặn ở đây là "bỏ qua im lặng": 40 kiện chọn, 12 kiện lỗi, thông báo nói "đã kiểm 28"
  // và người kho không bao giờ biết 12 kiện kia còn nằm đó.
  const k3 = await dungKien("3", { evidence: true });
  const k4 = await dungKien("4", { evidence: true });
  const loat = await recordInspectionBulk([k3, k4, "rfr-ship-mo"], "RESTOCKABLE", "", nguoiKho);
  assert.equal(loat.done, 2, "hai kiện nhiều mẫu mã phải qua được đường hàng loạt");
  assert.equal(loat.failed.length, 1, "kiện không ghép được đơn phải nằm trong danh sách trượt");
  assert.equal(loat.failed[0].shipmentId, "rfr-ship-mo");
  assert.ok(loat.failed[0].error.length > 0, "mỗi kiện trượt phải mang theo LÝ DO, không chỉ một con số");
  const ton3 = await daVaoTon(k3);
  assert.equal(ton3.tong, 3);
  assert.equal(ton3.dong.length, 2, "hàng loạt cũng phải ghi từng mẫu mã, không gộp");

  // ───────── 7. ĐẾM THIẾU TRÊN KIỆN NHIỀU MẪU MÃ VẪN BỊ CHẶN ─────────
  // Nới đường "đủ" không được nới luôn đường "thiếu": một con số tổng nhỏ hơn kỳ vọng vẫn không nói
  // được mẫu nào hụt.
  const k5 = await dungKien("5", { evidence: true });
  const thieu = await recordInspection({ shipmentId: k5, condition: "RESTOCKABLE", restockQty: 2, unsellableQty: 1, note: "hụt 1", actor: nguoiKho });
  assert.ok("error" in thieu, "đếm thiếu trên kiện nhiều mẫu mã phải mở ngăn kéo đếm từng món");
  assert.equal((await daVaoTon(k5)).tong, 0);

  // ───────── 8. HÀNG LOẠT VỚI KẾT LUẬN KHÔNG VÀO TỒN: không đụng tới tồn ─────────
  const k6 = await dungKien("6", { evidence: true });
  const hong = await recordInspectionBulk([k6], "DAMAGED", "ướt nước", nguoiKho);
  assert.equal(hong.done, 1);
  assert.equal((await daVaoTon(k6)).tong, 0, "kết luận hỏng KHÔNG được cộng một món nào vào tồn, kể cả kiện nhiều mẫu mã");
  const [phieu6] = await db.select().from(schema.returnInspections).where(eq(schema.returnInspections.shipmentId, k6));
  assert.equal(phieu6.unsellableQty, 3, "cả 3 món kỳ vọng được ghi là không bán lại được");
}
