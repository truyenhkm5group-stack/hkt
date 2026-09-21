import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CARRIER_SUBSTATES, CARRIER_SUBSTATE_LABEL, carrierSubstate, SUBSTATE_IMPLIES_PICKED_UP, SUBSTATE_IS_FORWARD_ACTIVE } from "@/lib/constants/carrier-substate";
import { FULFILLMENT_BUCKETS, FULFILLMENT_BUCKET_LABEL, getOrderFulfillmentBucket, isActivelyShippedOrder, kiemTraBangRo, pickAttempt, type AttemptFacts } from "@/lib/constants/fulfillment-bucket";
import { canApproveReturn, canRequestCarrierAction, canRequestRedelivery } from "@/lib/care/redelivery-eligibility";
import { CARE_ENTRY_SUBSTATES, careEntryFor, legAwareStage, legAwareSubstate } from "@/lib/care/entry";
import { carrierSubstateSql } from "@/lib/queries/carrier-substate-sql";
import { getFulfillmentBuckets, tongRoDayDu } from "@/lib/queries/fulfillment-buckets";
import { IntegrationError, loiNghiepVu } from "@/lib/integrations/http";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { bulkRequestCarrierAction } from "@/lib/care/service";
import { getDeliveryTower } from "@/lib/queries/delivery-tower";
import { clearMemo } from "@/lib/cache";

/**
 * ═══════════ HAI CHIỀU, MỘT ĐỊNH NGHĨA "ĐÃ GỬI", VÀ MỘT ĐƯỜNG GỬI LỆNH ═══════════
 *
 * Bài này khoá đúng những chỗ mà hỏng thì **màn hình vẫn ra số** — chỉ là con số trả lời một câu
 * hỏi khác với câu người đọc đang hỏi, hoặc một nhóm kiện biến mất khỏi hàng đợi mà không lỗi nào
 * phát ra. Mọi mốc số trong bài lấy từ đo production 13/09/2026 (`docs/do-production-2026-09-13-care.md`).
 */

const moc = (giờTruoc: number) => new Date(Date.now() - giờTruoc * 3600_000);

function lanGui(p: Partial<AttemptFacts> & { id: string }): AttemptFacts {
  return { code: null, text: null, stage: null, attemptNo: 1, createdAt: moc(48), hasCarrierLink: true, pickupEvidence: false, ...p };
}

/* ───── 1 · "Chờ phát lại" KHÔNG được thành "giao không thành công" ───── */
export function test01ChoPhatLaiKhongPhaiGiaoHong() {
  // Ca thật PKE1517655137 / PKE1517664551: KHÔNG có mã, chỉ có chữ.
  const r = carrierSubstate({ code: null, text: "Chờ phát lại", stage: "DELIVERY_FAILED" });
  assert.equal(r.substate, "WAITING_REDELIVERY");
  assert.equal(r.basis, "text", "không có mã thì chữ là căn cứ — và nó phải được dùng, không bị bỏ qua");
  assert.notEqual(r.substate, "DELIVERY_EXCEPTION", "bưu tá sẽ quay lại: đây là việc nhắc khách, không phải xử lý sự cố");
}

/* ───── 2 · "Chờ xử lý" KHÔNG được thành "giao không thành công" ───── */
export function test02ChoXuLyKhongPhaiGiaoHong() {
  for (const chu of ["Chờ xử lý", "Đơn hàng chờ xử lý", "CHO XU LY"]) {
    const r = carrierSubstate({ code: null, text: chu, stage: "PENDING" });
    assert.equal(r.substate, "WAITING_PROCESSING", `"${chu}" phải là trạng thái riêng`);
  }
  assert.equal(carrierSubstate({ code: 102, text: "Đơn hàng chờ xử lý", stage: "PENDING" }).substate, "WAITING_PROCESSING");
}

/* ───── 2b · Ba câu chữ có chung cụm "lấy hàng" nhưng ba kết luận khác nhau ───── */
export function test02bBaCauLayHang() {
  /*
    Phép khớp câu chữ là `includes` THUẦN, nên ba cụm dưới đây phân biệt được nhau chỉ nhờ độ dài.
    Rút gọn bất kỳ cụm nào thành "lay hang" là làm hai cụm kia đổ vào nhánh của nó — và hai kết
    luận ở hai đầu đối lập: PICKED_UP đưa kiện vào "đã gửi", AWAITING_PICKUP giữ nó ngoài.

    "Đang lấy hàng" đo được trên production 21/09/2026: 74 lần trong `vtp_status_registry`, dịch ra
    `UNKNOWN` và `mapped = false`. Chủ shop chốt cùng ngày: trên viettelpost.vn chỉ "Đã lấy hàng"
    và "Đang vận chuyển" mới chắc chắn ĐVVC đã cầm hàng.
  */
  assert.equal(carrierSubstate({ text: "Đang lấy hàng" }).substate, "AWAITING_PICKUP", "bưu tá đang trên đường tới lấy thì hàng VẪN trong kho");
  assert.equal(carrierSubstate({ text: "Đã lấy hàng" }).substate, "PICKED_UP", "và cụm này thì ngược lại — không được lẫn");
  assert.equal(carrierSubstate({ text: "Lấy hàng thất bại" }).substate, "PICKUP_FAILED");
  assert.equal(carrierSubstate({ text: "Lấy không thành công" }).substate, "PICKUP_FAILED", "câu chữ màn hình VTP dùng; ERP chưa từng nhận được nó qua webhook nhưng phải dịch được khi nó tới");

  // Cái quan trọng nhất: chỉ MỘT trong bốn cụm trên có nghĩa "đã rời kho".
  assert.equal(SUBSTATE_IMPLIES_PICKED_UP.AWAITING_PICKUP, "NO");
  assert.equal(SUBSTATE_IMPLIES_PICKED_UP.PICKUP_FAILED, "NO");
  assert.notEqual(SUBSTATE_IMPLIES_PICKED_UP.PICKED_UP, "NO");
}

/* ───── 3 · Mã ĐVVC thắng chữ, luôn luôn ───── */
export function test03MaThangChu() {
  // Mã 508 = "đơn vị yêu cầu phát tiếp" — đang đi giao, dù chữ có từ "tồn".
  const r = carrierSubstate({ code: 508, text: "Tồn - Khách hàng nghỉ, không có nhà", stage: "DELIVERY_FAILED" });
  assert.equal(r.substate, "OUT_FOR_DELIVERY");
  assert.equal(r.basis, "code");
}

/* ───── 4 · Mẫu chữ CỤ THỂ đứng trước mẫu CHUNG ───── */
export function test04MauCuTheTruocMauChung() {
  // "chờ phát lại" chứa cả "phát" lẫn "chờ"; nó phải thắng cả hai luật chung.
  assert.equal(carrierSubstate({ text: "Bưu cục hẹn phát lại ngày mai" }).substate, "WAITING_REDELIVERY");
  // "Tồn - Khách hàng nghỉ" là sự cố cụ thể, chưa hẹn được lần sau.
  assert.equal(carrierSubstate({ text: "Tồn - Khách hàng nghỉ, không có nhà" }).substate, "DELIVERY_EXCEPTION");
}

/* ───── 5 · Trạng thái lạ là UNKNOWN, KHÔNG âm thầm thành "giao hỏng" ───── */
export function test05LaThiNoiLaLa() {
  const r = carrierSubstate({ code: 9999, text: "Trạng thái chưa từng thấy XYZ", stage: null });
  assert.equal(r.substate, "UNKNOWN");
  assert.equal(r.basis, "unknown");
  assert.notEqual(r.substate, "DELIVERY_EXCEPTION", "trộn cái chưa biết vào nhóm giao hỏng là giấu mất chính nhóm cần đi tra");
}

/* ───── 6 · Mọi trạng thái con đều có nhãn và có mặt trong mọi bảng tra ───── */
export function test06BangTraDayDu() {
  for (const s of CARRIER_SUBSTATES) {
    assert.ok(CARRIER_SUBSTATE_LABEL[s], `${s}: thiếu nhãn tiếng Việt`);
    assert.ok(["YES", "NO", "AMBIGUOUS"].includes(SUBSTATE_IMPLIES_PICKED_UP[s]), `${s}: chưa khai đã-cầm-hàng`);
    assert.equal(typeof SUBSTATE_IS_FORWARD_ACTIVE[s], "boolean", `${s}: chưa khai còn-đi-tới-khách`);
  }
  assert.deepEqual(kiemTraBangRo(), [], "bảng rổ và bảng vòng đời phải nói cùng một điều");
}

/* ───── 7 · "Chờ xử lý" KHÔNG tự nhận là đã rời kho ───── */
export function test07ChoXuLyKhongTuSuyDaLayHang() {
  assert.equal(SUBSTATE_IMPLIES_PICKED_UP.WAITING_PROCESSING, "AMBIGUOUS");
  const chuaCoChungTu = getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "a", code: 102, text: "Đơn hàng chờ xử lý", stage: "PENDING", pickupEvidence: false })] });
  assert.equal(chuaCoChungTu.bucket, "NOT_SHIPPED", "169/225 kiện 'chờ xử lý' mang mã 102 — hàng còn trong kho");
  const coChungTu = getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "a", code: 102, text: "Đơn hàng chờ xử lý", stage: "PENDING", pickupEvidence: true })] });
  assert.equal(coChungTu.bucket, "IN_FLIGHT", "56 kiện còn lại đã có mốc lấy hàng — chúng đang đi");
}

/* ───── 8 · "Đã gửi" KHÔNG gồm đơn đã giao, đang hoàn, đã hoàn, đã huỷ ───── */
export function test08DaGuiLaTrangThaiHienTai() {
  const loaiTru: { text: string; ro: string }[] = [
    { text: "Giao thành công", ro: "DELIVERED" },
    { text: "Chuyển hoàn bưu cục gốc", ro: "RETURNING" },
    { text: "Đã trả hàng", ro: "RETURNED" },
  ];
  for (const c of loaiTru) {
    const v = getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "x", text: c.text })] });
    assert.notEqual(v.bucket, "IN_FLIGHT", `"${c.text}" không còn đang đi tới khách`);
  }
  assert.equal(isActivelyShippedOrder({ orderStage: "SHIPPED", attempts: [lanGui({ id: "x", text: "Đang vận chuyển" })] }), true);
}

/* ───── 9 · "Đã gửi" KHÔNG gồm hàng còn trong kho ───── */
export function test09DaGuiKhongGomHangTrongKho() {
  for (const t of ["Mới tạo đơn", "Chờ lấy hàng", "Giao cho Bưu tá đi nhận"]) {
    assert.equal(getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "x", text: t })] }).bucket, "NOT_SHIPPED", `"${t}": hàng chưa rời kho`);
  }
  assert.equal(getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "x", text: "Lấy hàng thất bại" })] }).bucket, "PICKUP_FAILED");
}

/* ───── 10 · Trạng thái Pancake KHÔNG được nói gì về vị trí gói hàng ───── */
export function test10PancakeKhongKetLuanLogistics() {
  // Pancake ghi "Đã nhận" (DELIVERED) nhưng ĐVVC mới đang vận chuyển ⇒ vẫn là ĐANG ĐI.
  const v = getOrderFulfillmentBucket({ orderStage: "DELIVERED", attempts: [lanGui({ id: "x", text: "Đang vận chuyển" })] });
  assert.equal(v.bucket, "IN_FLIGHT");
  // Pancake ghi "Đã gửi hàng" nhưng chưa có vận đơn nào ⇒ CHƯA BÀN GIAO, không phải "đã gửi".
  assert.equal(getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [] }).bucket, "NOT_SHIPPED");
}

/* ───── 11 · Có vận đơn mà không một dấu vết ĐVVC nào ⇒ CHƯA BIẾT, không phải "đang gửi" ───── */
export function test11KhongDauVetLaChuaBiet() {
  const v = getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [lanGui({ id: "x", text: "Đang vận chuyển", hasCarrierLink: false })] });
  assert.equal(v.bucket, "UNKNOWN");
}

/* ───── 12 · Lần gửi hỏng cũ KHÔNG đè lên lần gửi đang chạy ───── */
export function test12LanGuiCuKhongDeLanMoi() {
  const attempts = [
    lanGui({ id: "cu", text: "Lấy hàng thất bại", attemptNo: 1, createdAt: moc(200) }),
    lanGui({ id: "moi", text: "Đang vận chuyển", attemptNo: 2, createdAt: moc(10) }),
  ];
  assert.equal(pickAttempt(attempts)?.id, "moi");
  assert.equal(getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts }).bucket, "IN_FLIGHT");
  // Đảo thứ tự mảng KHÔNG được đổi kết quả.
  assert.equal(getOrderFulfillmentBucket({ orderStage: "SHIPPED", attempts: [...attempts].reverse() }).bucket, "IN_FLIGHT");
}

/* ───── 13 · Lần gửi tới tay khách thắng mọi lần khác ───── */
export function test13DaGiaoThangMoiLanKhac() {
  const attempts = [
    lanGui({ id: "giao", stage: "DELIVERED", text: "Giao thành công", attemptNo: 1, createdAt: moc(300) }),
    lanGui({ id: "sau", text: "Đang vận chuyển", attemptNo: 2, createdAt: moc(5) }),
  ];
  assert.equal(pickAttempt(attempts)?.id, "giao", "khách đã nhận được hàng ở lần nào thì lần đó quyết định");
}

/* ───── 14 · Rổ loại trừ nhau và phủ hết: không đơn nào nằm hai rổ, không đơn nào rơi ra ───── */
export function test14RoKhongChongLanKhongBoSot() {
  const caThu: { orderStage: Parameters<typeof getOrderFulfillmentBucket>[0]["orderStage"]; attempts: AttemptFacts[] }[] = [
    { orderStage: "SHIPPED", attempts: [] },
    { orderStage: "CANCELLED", attempts: [] },
    { orderStage: "SHIPPED", attempts: [lanGui({ id: "1", text: "Chờ phát lại" })] },
    { orderStage: "SHIPPED", attempts: [lanGui({ id: "2", code: 102, text: "Đơn hàng chờ xử lý" })] },
    { orderStage: "SHIPPED", attempts: [lanGui({ id: "3", code: 501, text: "Giao thành công" })] },
    { orderStage: "SHIPPED", attempts: [lanGui({ id: "4", code: 504, text: "Chuyển trả người gửi" })] },
    { orderStage: "SHIPPED", attempts: [lanGui({ id: "5", text: "Rác XYZ" })] },
  ];
  for (const c of caThu) {
    const v = getOrderFulfillmentBucket(c);
    assert.ok(FULFILLMENT_BUCKETS.includes(v.bucket), "mọi đơn phải rơi vào đúng một rổ đã khai");
    assert.ok(FULFILLMENT_BUCKET_LABEL[v.bucket], `${v.bucket}: thiếu nhãn`);
  }
}

/* ───── 15 · Luật TypeScript và luật SQL phải ra CÙNG kết quả ───── */
export async function test15TsVaSqlNoiCungMotDieu(db: Db) {
  const caThu: { ma: number | null; chu: string | null; chang: string | null }[] = [
    { ma: null, chu: "Chờ phát lại", chang: "DELIVERY_FAILED" },
    { ma: 506, chu: "Tồn - Khách hàng nghỉ, không có nhà", chang: "DELIVERY_FAILED" },
    { ma: 102, chu: "Đơn hàng chờ xử lý", chang: "PENDING" },
    { ma: null, chu: "Chờ xử lý", chang: "PENDING" },
    { ma: 501, chu: "Giao thành công", chang: "DELIVERED" },
    { ma: 505, chu: "Tồn - Thông báo chuyển hoàn bưu cục gốc", chang: "RETURNING" },
    { ma: null, chu: "Đang giao hàng", chang: "OUT_FOR_DELIVERY" },
    { ma: null, chu: "Đang vận chuyển", chang: "IN_TRANSIT" },
    { ma: 508, chu: "Tồn - Khách hàng nghỉ, không có nhà", chang: "DELIVERY_FAILED" },
    { ma: null, chu: "Rác XYZ chưa từng thấy", chang: null },
    { ma: null, chu: null, chang: "RETURNED" },
    { ma: null, chu: "CHO PHAT LAI", chang: null },
  ];
  for (const c of caThu) {
    const ts = carrierSubstate({ code: c.ma, text: c.chu, stage: c.chang as never }).substate;
    const bieuThuc = carrierSubstateSql(sql`${c.ma}::int`, sql`${c.chu}::text`, sql`${c.chang}::text`);
    const [row] = (await db.execute(sql`select ${bieuThuc} as con`)).rows as { con: string }[];
    assert.equal(row.con, ts, `TS và SQL lệch nhau ở (mã=${c.ma}, chữ="${c.chu}", chặng=${c.chang})`);
  }
}

/* ───── 16 · Rổ đếm trên CSDL: tổng các rổ = tổng đơn, không đơn nào đếm hai lần ───── */
export async function test16TongRoBangTongDon(db: Db) {
  clearMemo();
  const tong = await getFulfillmentBuckets({ key: "all", label: "toàn bộ", from: null, to: null, fromKey: "", toKey: "" } as never);
  const kiem = tongRoDayDu(tong);
  assert.ok(kiem.ok, `có ${kiem.chenh} đơn không rổ nào nhận (tổng rổ ${kiem.tongRo} / tổng đơn ${tong.total})`);
  const [{ so }] = (await db.execute(sql`select count(*)::int as so from orders`)).rows as { so: number }[];
  assert.equal(tong.total, Number(so), "mỗi đơn đúng MỘT dòng — đơn nhiều lần gửi không được đếm hai lần");
}

/* ───── 17 · "Chờ xử lý" đã rời kho phải HIỆN RA trong hàng đợi chăm sóc ───── */
export async function test17ChoXuLyDaRoiKhoPhaiHienRa(db: Db) {
  await db.insert(schema.orders).values({ id: "cs-o1", stage: "SHIPPED", status: 2, insertedAt: moc(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: "cs-s1", orderId: "cs-o1", carrier: "Viettel Post", vtpOrderNumber: "CARESTATE-1", stage: "PENDING", vtpStatus: null, vtpStatusName: "Chờ xử lý", codAmount: 300_000, pickedUpAt: moc(50), isFinal: false })
    .onConflictDoNothing();
  await db
    .insert(schema.shipmentEvents)
    .values({ shipmentId: "cs-s1", source: "VTP_WEBHOOK", status: "105", statusName: "Đã lấy hàng", normalizedStage: "PICKED_UP", occurredAt: moc(50) })
    .onConflictDoNothing();
  clearMemo();
  const thap = await getDeliveryTower();
  const ro = thap.buckets.find((b) => b.key === "WAITING_CARRIER");
  assert.ok(ro, "phải có rổ 'ĐVVC để treo'");
  const dong = ro.rows.find((r) => r.shipmentId === "cs-s1");
  assert.ok(dong, "kiện đã rời kho mà ĐVVC ghi 'chờ xử lý' phải vào hàng đợi — trước bản này nó vô hình");
  assert.equal(dong.carrierSubstate, "WAITING_PROCESSING");
  assert.equal(dong.leftWarehouse, true);
  assert.equal(dong.stage, "PENDING", "chặng canonical GIỮ NGUYÊN — trạng thái con là lớp riêng, không ghi đè");

  // Cùng câu chữ nhưng CHƯA có chứng từ rời kho ⇒ KHÔNG vào rổ việc: hàng còn trong kho của shop.
  await db.insert(schema.orders).values({ id: "cs-o2", stage: "SHIPPED", status: 2, insertedAt: moc(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: "cs-s2", orderId: "cs-o2", carrier: "Viettel Post", vtpOrderNumber: "CARESTATE-2", stage: "PENDING", vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", codAmount: 300_000, isFinal: false })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: "cs-s2", source: "VTP_WEBHOOK", status: "102", statusName: "Đơn hàng chờ xử lý", normalizedStage: "PENDING", occurredAt: moc(70) }).onConflictDoNothing();
  clearMemo();
  const thap2 = await getDeliveryTower();
  const ro2 = thap2.buckets.find((b) => b.key === "WAITING_CARRIER")!;
  assert.ok(!ro2.rows.some((r) => r.shipmentId === "cs-s2"), "kiện còn trong kho KHÔNG được bắt người đi gọi bưu cục");

  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ["cs-s1", "cs-s2"]));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, ["cs-s1", "cs-s2"]));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ["cs-o1", "cs-o2"]));
  clearMemo();
}

/* ───── 18 · "Chờ phát lại" và "Tồn - …" phải nằm ở HAI rổ khác nhau ───── */
export async function test18HaiTinhHuongHaiRo(db: Db) {
  const ca = [
    { o: "cs-o3", s: "cs-s3", num: "PKE1517655137-T", ma: null as number | null, chu: "Chờ phát lại", ro: "AWAITING_REDELIVERY" },
    { o: "cs-o4", s: "cs-s4", num: "PKE1517655128-T", ma: 506 as number | null, chu: "Tồn - Khách hàng nghỉ, không có nhà", ro: "DELIVERY_FAILED" },
  ];
  for (const c of ca) {
    await db.insert(schema.orders).values({ id: c.o, stage: "SHIPPED", status: 2, insertedAt: moc(72) }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({ id: c.s, orderId: c.o, carrier: "Viettel Post", vtpOrderNumber: c.num, stage: "DELIVERY_FAILED", vtpStatus: c.ma, vtpStatusName: c.chu, codAmount: 250_000, pickedUpAt: moc(60), isFinal: false })
      .onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ shipmentId: c.s, source: "VTP_WEBHOOK", status: String(c.ma ?? ""), statusName: c.chu, normalizedStage: "DELIVERY_FAILED", occurredAt: moc(20) }).onConflictDoNothing();
  }
  clearMemo();
  const thap = await getDeliveryTower();
  const roCua = (sid: string) => thap.buckets.filter((b) => !b.rollupOf).find((b) => b.rows.some((r) => r.shipmentId === sid))?.key;
  assert.equal(roCua("cs-s3"), "AWAITING_REDELIVERY", "bưu tá sẽ quay lại ⇒ việc là NHẮC KHÁCH");
  // "khách nghỉ, không có nhà" là NOT_HOME chứ không phải "không liên lạc được" — hai việc khác
  // nhau: một bên gọi xin lịch, một bên đi tìm số điện thoại khác.
  assert.equal(roCua("cs-s4"), "DELIVERY_FAILED", "vướng khi đang phát ⇒ việc là XỬ LÝ ĐÚNG LÝ DO bưu tá ghi");
  assert.notEqual(roCua("cs-s3"), roCua("cs-s4"), "hai tình huống khác nhau không được mang cùng một nhãn");

  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ["cs-s3", "cs-s4"]));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, ["cs-s3", "cs-s4"]));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ["cs-o3", "cs-o4"]));
  clearMemo();
}

/* ───── 19 · Điều kiện "Phát tiếp": một hàm, và nó KHÔNG đọc `stage` thô ───── */
export function test19DieuKienPhatTiep() {
  const nen = { orderNumber: "PKE1", trackingCapability: "API_TRACKABLE", configured: true };
  // Chờ phát lại ⇒ được, và gửi thẳng API.
  const a = canRequestRedelivery({ ...nen, stage: "DELIVERY_FAILED", vtpStatus: null, vtpStatusName: "Chờ phát lại" });
  assert.ok(a.ok && a.callsApi && a.code === "OK");
  // Đã giao ⇒ không còn nghĩa.
  const b = canRequestRedelivery({ ...nen, stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Giao thành công" });
  assert.equal(b.ok, false);
  assert.equal(b.code, "ALREADY_FINISHED");
  // Chưa lấy hàng ⇒ không phát tiếp được.
  const c = canRequestRedelivery({ ...nen, stage: "PENDING", vtpStatus: 100, vtpStatusName: "Mới tạo đơn" });
  assert.equal(c.code, "WRONG_SUBSTATE");
  // Chưa có mã vận đơn ⇒ chặn trước mọi thứ khác.
  assert.equal(canRequestRedelivery({ ...nen, orderNumber: null, stage: "DELIVERY_FAILED", vtpStatus: null, vtpStatusName: "Chờ phát lại" }).code, "NO_TRACKING_NUMBER");
  // Duyệt hoàn dùng chung cửa.
  assert.ok(canApproveReturn({ ...nen, stage: "RETURNING", vtpStatus: 502, vtpStatusName: "Chuyển hoàn bưu cục gốc" }).ok);
  // Hành động ngoài phạm vi bản này GIỮ NGUYÊN luật chặng cũ.
  assert.equal(canRequestCarrierAction("approve", { ...nen, stage: "OUT_FOR_DELIVERY", vtpStatus: 500, vtpStatusName: "Đang giao hàng" }).ok, false);
}

/* ───── 20 · Tài khoản không sở hữu kiện ⇒ KHÔNG gọi API, và nói rõ phải làm tay ───── */
export function test20KhongSoHuuThiKhongGoiApi() {
  const v = canRequestRedelivery({ orderNumber: "PKE1", trackingCapability: "WEBHOOK_ONLY", configured: true, stage: "DELIVERY_FAILED", vtpStatus: null, vtpStatusName: "Chờ phát lại" });
  assert.equal(v.ok, true, "vẫn cho người thao tác — nhưng đi đường làm tay");
  assert.equal(v.callsApi, false, "KHÔNG gửi lệnh chắc chắn bị từ chối rồi in ra một mã HTTP");
  assert.equal(v.code, "MANUAL_ONLY");
  assert.match(v.reason, /viettelpost\.vn/, "phải chỉ đúng nơi làm tay");
  // Chưa cấu hình tài khoản là chuyện khác hẳn — chặn hẳn, và nói đi khai ở đâu.
  const w = canRequestRedelivery({ orderNumber: "PKE1", trackingCapability: "API_TRACKABLE", configured: false, stage: "DELIVERY_FAILED", vtpStatus: null, vtpStatusName: "Chờ phát lại" });
  assert.equal(w.code, "NOT_CONFIGURED");
}

/* ───── 21 · Lời từ chối của ĐVVC phải đọc được, dù nó nằm ở tầng nào ───── */
export function test21LoiTuChoiDocDuoc() {
  assert.equal(loiNghiepVu({ message: "Vận đơn không thuộc tài khoản" }, "").message, "Vận đơn không thuộc tài khoản");
  assert.equal(loiNghiepVu({ data: { message: "Đơn đã phát, không phát tiếp được" } }, "").message, "Đơn đã phát, không phát tiếp được");
  assert.equal(loiNghiepVu({ error_description: "TOKEN_INVALID" }, "").message, "TOKEN_INVALID");
  assert.equal(loiNghiepVu({ errors: [{ field: "TYPE", message: "TYPE không hợp lệ" }] }, "").message, "TYPE không hợp lệ");
  // Không tìm thấy gì thì KHÔNG bịa: trả lại chính chuỗi thô.
  assert.equal(loiNghiepVu(null, "<html>502</html>").message, "<html>502</html>");
}

/* ───── 22 · Gửi hàng loạt: thành công MỘT PHẦN, kết quả TỪNG KIỆN ───── */
export async function test22GuiHangLoatThanhCongMotPhan(db: Db) {
  const ca = [
    // Đủ điều kiện, tài khoản sở hữu kiện ⇒ gửi thật.
    { o: "bk-o1", s: "bk-s1", num: "BULK-OK", stage: "DELIVERY_FAILED" as const, chu: "Chờ phát lại", cap: "API_TRACKABLE", mong: "SUCCESS" },
    // Đã giao xong ⇒ BỎ QUA, và tuyệt đối không gửi gói tin nào.
    { o: "bk-o2", s: "bk-s2", num: "BULK-DONE", stage: "DELIVERED" as const, chu: "Giao thành công", cap: "API_TRACKABLE", mong: "SKIPPED" },
    // Tài khoản không sở hữu kiện ⇒ ghi vết, chỉ đường làm tay, KHÔNG gửi.
    { o: "bk-o3", s: "bk-s3", num: "BULK-OTHER", stage: "DELIVERY_FAILED" as const, chu: "Chờ phát lại", cap: "WEBHOOK_ONLY", mong: "MANUAL_REQUIRED" },
    // ĐVVC từ chối ⇒ lưu đúng câu ĐVVC nói.
    { o: "bk-o4", s: "bk-s4", num: "BULK-DENIED", stage: "DELIVERY_FAILED" as const, chu: "Chờ phát lại", cap: "API_TRACKABLE", mong: "FAILED" },
  ];
  for (const c of ca) {
    await db.insert(schema.orders).values({ id: c.o, stage: "SHIPPED", status: 2, insertedAt: moc(72) }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({ id: c.s, orderId: c.o, carrier: "Viettel Post", vtpOrderNumber: c.num, stage: c.stage, vtpStatusName: c.chu, codAmount: 200_000, trackingCapability: c.cap, pickedUpAt: moc(60) })
      .onConflictDoNothing();
  }

  let goiApi = 0;
  const daGoi: string[] = [];
  setViettelPostClientForTests({
    configured: true,
    getOrderDetail: async () => null,
    updateOrder: async (orderNumber: string) => {
      goiApi += 1;
      daGoi.push(orderNumber);
      if (orderNumber === "BULK-DENIED") throw new IntegrationError("ViettelPost: Vận đơn không thuộc tài khoản", 200, false, null, { status: 203, message: "Vận đơn không thuộc tài khoản" });
      return { error: false, status: 200, message: "Cập nhật thành công", data: null };
    },
  } as never);
  try {
    const r = await bulkRequestCarrierAction({ id: null, email: "cs@test", name: "CS", source: "API" }, { shipmentIds: ca.map((c) => c.s), actionKey: "redeliver", note: "" });
    assert.ok("ok" in r && r.ok, "một phần hỏng KHÔNG được làm hỏng cả lượt");
    const theoId = new Map(r.data.rows.map((x) => [x.shipmentId, x]));
    for (const c of ca) assert.equal(theoId.get(c.s)?.outcome, c.mong, `${c.num}: kết quả phải là ${c.mong}`);

    // KIỆN KHÔNG ĐỦ ĐIỀU KIỆN KHÔNG SINH MỘT GÓI TIN NÀO.
    assert.equal(goiApi, 2, "chỉ 2 kiện đủ điều kiện + sở hữu được gửi lên ĐVVC");
    assert.ok(!daGoi.includes("BULK-DONE"), "kiện đã giao xong không được gửi lệnh");
    assert.ok(!daGoi.includes("BULK-OTHER"), "kiện thuộc tài khoản khác không được gửi lệnh");

    // Câu từ chối của ĐVVC phải đọc được, không phải một mã HTTP.
    assert.match(theoId.get("bk-s4")!.message, /không thuộc tài khoản/i);
    assert.match(theoId.get("bk-s2")!.message, /đã giao|kết thúc/i, "bỏ qua phải nói lý do CỦA CHÍNH kiện đó");
    assert.deepEqual(r.data.counts, { SUCCESS: 1, MANUAL_REQUIRED: 1, SKIPPED: 1, FAILED: 1 });

    // Lời từ chối phải được LƯU LẠI — bảng rỗng chính là lý do câu hỏi "vì sao 400" từng không trả
    // lời được bằng dữ liệu.
    const [luu] = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, "bk-s4"));
    assert.ok(luu, "lệnh thất bại vẫn phải để lại một dòng");
    assert.match(String(luu.error), /không thuộc tài khoản/i);
  } finally {
    setViettelPostClientForTests(null);
  }

  await db.delete(schema.carrierActionRequests).where(inArray(schema.carrierActionRequests.shipmentId, ca.map((c) => c.s)));
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ca.map((c) => c.s)));
  await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ca.map((c) => c.s)));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, ca.map((c) => c.s)));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ca.map((c) => c.o)));
  clearMemo();
}

/* ───── 23 · "CẦN CARE" LÀ MỘT HÀM — chờ xử lý chỉ vào khi có chứng từ rời kho ───── */
export function test23LuatVaoCareMotHam() {
  // Đo production 13/09/2026: 106 kiện mã 102 CHƯA lấy hàng có đợt (sai), 48 kiện đã lấy chỉ 6 có đợt (sót).
  assert.equal(careEntryFor("WAITING_PROCESSING", false).enters, false, "mã 102 còn trong kho KHÔNG phải việc của đội chăm sóc");
  assert.equal(careEntryFor("WAITING_PROCESSING", true).enters, true, "chờ xử lý đã rời kho ⇒ cần người gọi bưu cục");
  assert.equal(careEntryFor("WAITING_REDELIVERY", false).enters, true, "chờ phát lại luôn vào: phát hụt thì chắc chắn đã cầm hàng");
  assert.equal(careEntryFor("DELIVERY_EXCEPTION", false).enters, true, "tồn - khách nghỉ vào care: cùng việc với chờ phát lại, chỉ chưa có giờ hẹn");
  for (const s of ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNING", "RETURNED", "CANCELLED", "AWAITING_PICKUP", "UNKNOWN"] as const) {
    assert.equal(careEntryFor(s, true).enters, false, `${s} không phải điều kiện cần care`);
  }
  assert.deepEqual([...CARE_ENTRY_SUBSTATES].sort(), ["DELIVERY_EXCEPTION", "WAITING_PROCESSING", "WAITING_REDELIVERY"], "tập điều kiện vào care khai tường minh — thêm bớt phải qua bài này");
}

/* ───── 24 · Cùng một mã, hai chiều: 501 chiều hoàn là HÀNG VỀ SHOP ───── */
export function test24MotMaHaiChieu() {
  assert.equal(legAwareStage("DELIVERED", "RETURN"), "RETURNED", "501 + IS_RETURNING = phát thành công CHIỀU HOÀN = đơn hoàn (luật 2a)");
  assert.equal(legAwareStage("DELIVERED", "OUTBOUND"), "DELIVERED");
  assert.equal(legAwareStage("DELIVERED", null), "DELIVERED", "không có cờ thì không đoán — chặng đã dựng từ lịch sử là lưới an toàn");
  assert.equal(legAwareStage("OUT_FOR_DELIVERY", "RETURN"), "RETURNING", "đang đi phát trên chiều hoàn là đang về shop");
  assert.equal(legAwareSubstate({ code: 501, text: "Thành công - Phát thành công", stage: "RETURNED" }).valueOf(), "RETURNED", "trạng thái con phải nói cùng một điều với chặng leg-aware");
  assert.equal(legAwareSubstate({ code: 506, text: "Tồn - Khách hàng nghỉ", stage: "RETURNING" }), "RETURNING", "sự cố trên chiều hoàn không phải sự cố cần care");
  assert.equal(legAwareSubstate({ code: 506, text: "Tồn - Khách hàng nghỉ", stage: "DELIVERY_FAILED" }), "DELIVERY_EXCEPTION");
}

export async function testCareStates(db: Db) {
  test01ChoPhatLaiKhongPhaiGiaoHong();
  test23LuatVaoCareMotHam();
  test24MotMaHaiChieu();
  test02ChoXuLyKhongPhaiGiaoHong();
  test02bBaCauLayHang();
  test03MaThangChu();
  test04MauCuTheTruocMauChung();
  test05LaThiNoiLaLa();
  test06BangTraDayDu();
  test07ChoXuLyKhongTuSuyDaLayHang();
  test08DaGuiLaTrangThaiHienTai();
  test09DaGuiKhongGomHangTrongKho();
  test10PancakeKhongKetLuanLogistics();
  test11KhongDauVetLaChuaBiet();
  test12LanGuiCuKhongDeLanMoi();
  test13DaGiaoThangMoiLanKhac();
  test14RoKhongChongLanKhongBoSot();
  test19DieuKienPhatTiep();
  test20KhongSoHuuThiKhongGoiApi();
  test21LoiTuChoiDocDuoc();
  await test15TsVaSqlNoiCungMotDieu(db);
  await test16TongRoBangTongDon(db);
  await test17ChoXuLyDaRoiKhoPhaiHienRa(db);
  await test18HaiTinhHuongHaiRo(db);
  await test22GuiHangLoatThanhCongMotPhan(db);
  console.log("✓ Hai chiều trạng thái + “Đã gửi” theo chứng từ: 24 kiểm thử · luật vào care một hàm · 501 chiều hoàn = hàng về shop · chờ phát lại ≠ tồn ≠ chờ xử lý · TS và SQL cùng kết quả · mỗi đơn một rổ");
}
