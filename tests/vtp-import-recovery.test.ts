import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { orders, shipmentEvents, shipments } from "@/db/schema";
import { parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyVtpOrderList, compareRowSnapshots, matchVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";

/**
 * ═══════ PHỤC HỒI LỊCH SỬ VẬN ĐƠN — ba lỗi đo được trên production 08/09/2026 ═══════
 *
 * 1. Thêm khoá vào `snapshot` biến 1.582/1.597 dòng đã nhập thành "xung đột" giả.
 * 2. Cột "Mã đơn hàng" của Viettel Post bị đem so với bản đồ MÃ VẬN ĐƠN, làm dòng chưa ghép được
 *    bị loại khỏi bước dò theo SĐT chỉ vì trùng chuỗi với vận đơn của đơn khác.
 * 3. Vòng áp dụng xếp theo chuỗi mã vận đơn nên vận đơn ĐÃ HUỶ luôn chiếm chỗ của vận đơn thay thế.
 */

const HEADER =
  "Mã Vận Đơn,Mã đơn hàng,Ngày tạo,Tổng phí (9)= (3)+(5)+(6)+(7)-(8),Tiền thu hộ (4),Trạng Thái,ĐT Nhận,Ngày chuyển trạng thái";

function file(...lines: string[]) {
  return parseVtpOrderList([HEADER, ...lines].join("\n"));
}

export async function testVtpImportRecovery(db: Db) {
  // ══ 1. THÊM KHOÁ MỚI KHÔNG PHẢI LÀ DỮ LIỆU ĐÃ ĐỔI ══
  const cu = { trackingCode: "PKE7000000001", orderCode: "REF-1", statusText: "Giao thành công", cod: 474_000, fee: 17_000 };
  const moi = { ...cu, codPaymentText: "", paymentText: "", codReconciliationText: "", returnFlag: false, forwardFlag: false };
  assert.equal(compareRowSnapshots(cu, moi), "same", "1. ảnh chụp cũ thiếu khoá mới ⇒ KHÔNG phải xung đột");
  assert.equal(compareRowSnapshots(moi, cu), "same", "1. so hai chiều cho cùng kết quả — xác định");
  assert.equal(compareRowSnapshots(cu, { ...moi, codPaymentText: "Đã nhận COD" }), "changed", "1. trường bổ trợ đổi ⇒ là cập nhật, không phải xung đột");
  assert.equal(compareRowSnapshots(cu, { ...moi, statusText: "Chuyển hoàn bưu cục gốc" }), "conflict", "1. trạng thái ĐVVC khác ⇒ phải dừng cho người đối chiếu");
  assert.equal(compareRowSnapshots(cu, { ...moi, cod: 499_000 }), "conflict", "1. cùng mốc mà tiền khác ⇒ KHÔNG lặng lẽ ghi đè");
  assert.equal(compareRowSnapshots(cu, { ...moi, trackingCode: "PKE7000000002" }), "conflict", "1. khác mã vận đơn ⇒ hai chứng từ khác nhau");
  assert.equal(compareRowSnapshots({ ...cu, orderCode: "" }, { ...moi, orderCode: "REF-9" }), "changed", "1. bên cũ để trống ⇒ điền thêm thông tin, KHÔNG phải mâu thuẫn");
  assert.equal(compareRowSnapshots(null, moi), "changed", "1. chưa có gì để so thì coi là mới");

  // Nhập lại đúng một tệp đã nhập: phải ra "trùng", không phải "xung đột".
  await db.insert(orders).values({ id: "rec-order-1", stage: "CONFIRMED", cod: 474_000, insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-1", orderId: "rec-order-1", vtpOrderNumber: "PKE7000000001",
    codAmount: 474_000, codStatus: "PENDING", stage: "IN_TRANSIT" });
  const rowsLan1 = file("PKE7000000001,REF-1,01/08/2026 09:00:00,17000,474000,Giao thành công,0900000001,02/08/2026 10:00:00");
  const lan1 = await applyVtpOrderList(rowsLan1, "test:recovery");
  assert.equal(lan1.updated, 1, "1. lần nhập đầu phải ghi được");
  // Giả lập ảnh chụp CŨ (thiếu các khoá thêm sau) đúng như dữ liệu production trước bản vá.
  const [ev] = await db.select().from(shipmentEvents).where(and(eq(shipmentEvents.shipmentId, "rec-ship-1"), eq(shipmentEvents.source, "VTP_IMPORT")));
  const raw = ev.raw as { snapshot: Record<string, unknown> };
  await db.update(shipmentEvents).set({
    raw: { ...raw, snapshot: { trackingCode: "PKE7000000001", orderCode: "REF-1", statusText: "Giao thành công", cod: 474_000, fee: 17_000 } },
  }).where(eq(shipmentEvents.id, ev.id));
  const lan2 = await applyVtpOrderList(rowsLan1, "test:recovery");
  assert.equal(lan2.conflicts, 0, "1. nhập lại tệp cũ KHÔNG được sinh xung đột giả");
  assert.equal(lan2.duplicate, 1, "1. phải nhận ra là dòng đã nhập");

  // ══ 2. HAI CỘT, HAI KHÔNG GIAN ĐỊNH DANH ══
  // Ca thật: PKE1508295104 mang "Mã đơn hàng" trùng tracking_code của vận đơn KHÁC.
  await db.insert(orders).values({ id: "rec-order-2", stage: "CONFIRMED", cod: 849_000, shipPhone: "0900000002", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-2", orderId: "rec-order-2", trackingCode: "REF-COLLIDE",
    vtpOrderNumber: "PKE7000000009", codAmount: 849_000, codStatus: "PENDING", stage: "IN_TRANSIT" });
  await db.insert(orders).values({ id: "rec-order-3", stage: "CONFIRMED", cod: 849_000, shipPhone: "0900000003", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-3", orderId: "rec-order-3", codAmount: 849_000, codStatus: "PENDING", stage: "PENDING" });
  const vaCham = file("PKE7000000010,REF-COLLIDE,20/08/2026 09:00:00,17000,849000,Shop hủy lấy,0900000003,21/08/2026 10:00:00");
  const khop = await matchVtpOrderList(vaCham);
  assert.equal(khop[0].matchKind, "phone", "2. mã tham chiếu trùng chuỗi KHÔNG được loại dòng khỏi bước dò theo SĐT");
  assert.equal(khop[0].shipmentId, "rec-ship-3", "2. phải ghép đúng vận đơn của SĐT đó, không phải vận đơn mang mã trùng");

  // ══ 3. LẦN GỬI BỊ HUỶ KHÔNG ĐƯỢC CHIẾM CHỖ CỦA LẦN GỬI THAY THẾ ══
  await db.insert(orders).values({ id: "rec-order-4", stage: "CONFIRMED", cod: 474_000, shipPhone: "0900000004", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-4", orderId: "rec-order-4", codAmount: 474_000, codStatus: "PENDING", stage: "PENDING" });
  const haiLanGui = file(
    // Lần gửi 1 tạo TRƯỚC, mã NHỎ HƠN, và đã bị huỷ — trước bản vá dòng này luôn thắng.
    "PKE7000000100,REF-A,02/08/2026 18:19:00,17000,474000,Shop hủy lấy,0900000004,02/08/2026 18:30:00",
    // Lần gửi 2 tạo SAU, giao thành công.
    "PKE7000000200,REF-B,02/08/2026 19:50:00,17000,474000,Giao thành công,0900000004,05/08/2026 09:00:00",
  );
  const khopLanGui = await matchVtpOrderList(haiLanGui);
  const huy = khopLanGui.find((m) => m.trackingCode === "PKE7000000100")!;
  const giao = khopLanGui.find((m) => m.trackingCode === "PKE7000000200")!;
  assert.equal(giao.shipmentId, "rec-ship-4", "3. lần gửi thay thế (giao thành công) phải thắng");
  assert.equal(huy.shipmentId, null, "3. lần gửi đã huỷ KHÔNG được chiếm chỗ");
  assert.match(String(huy.matchIssue), /lần gửi/, "3. lần gửi bị bỏ qua vẫn phải nêu lý do để đối chiếu");
  const ketQua = await applyVtpOrderList(haiLanGui, "test:recovery");
  const [sau] = await db.select().from(shipments).where(eq(shipments.id, "rec-ship-4"));
  assert.equal(sau.vtpOrderNumber, "PKE7000000200", "3. vận đơn ERP mang mã của lần gửi thay thế");
  assert.equal(sau.stage, "DELIVERED", "3. kết quả cuối là GIAO THÀNH CÔNG, không phải HUỶ");
  assert.ok(ketQua.conflicts >= 1, "3. lần gửi còn lại được đếm là cần đối chiếu, không bị nuốt im lặng");

  // ══ 4. SĐT CHỈ LÀ MANH MỐI — NHẬP NHẰNG THÌ GIỮ NGUYÊN NHẬP NHẰNG ══
  // Hai vận đơn chưa có mã, cùng SĐT, CÙNG một mức COD: bằng chứng không phân biệt được.
  await db.insert(orders).values({ id: "rec-order-5", stage: "CONFIRMED", cod: 400_000, shipPhone: "0900000005", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-5", orderId: "rec-order-5", codAmount: 400_000, codStatus: "PENDING", stage: "PENDING" });
  await db.insert(orders).values({ id: "rec-order-6", stage: "CONFIRMED", cod: 400_000, shipPhone: "0900000005", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "rec-ship-6", orderId: "rec-order-6", codAmount: 400_000, codStatus: "PENDING", stage: "PENDING" });
  const mo = await matchVtpOrderList(file("PKE7000000300,REF-C,03/08/2026 09:00:00,17000,400000,Giao thành công,0900000005,04/08/2026 09:00:00"));
  assert.equal(mo[0].shipmentId, null, "4. hai ứng viên không phân biệt được ⇒ KHÔNG ép ghép");
  assert.match(String(mo[0].matchIssue), /cần đối chiếu/, "4. phải hiện ra ở Chất lượng dữ liệu để người đối chiếu");

  console.log(
    "✓ Phục hồi nhập tệp VTP: thêm khoá không tạo xung đột giả · mã tham chiếu không lấn không gian mã vận đơn · lần gửi huỷ không đè lần gửi thay thế · SĐT chỉ là manh mối",
  );
}
