import assert from "node:assert/strict";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { addCareNote, loadCareState, recordBusinessAction, setCareStatus, type CareActor } from "@/lib/care/service";
import { applyCarrierEventToCare } from "@/lib/care/lifecycle";
import { BUSINESS_ACTIONS, type BusinessAction } from "@/lib/constants/care-outcome";
import {
  FOLLOW_UP_CHOICES,
  RESOLUTION_ACTIONS,
  RESOLUTION_LABEL,
  RESOLUTION_NOTES_DEFAULT,
  RESOLUTION_TO_BUSINESS,
  WORK_DAY_END_HOUR,
  WORK_DAY_START_HOUR,
  followUpAtFrom,
  followUpBucket,
  resolutionOf,
} from "@/lib/constants/care-resolution";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { getCareCaseDetail } from "@/lib/queries/care-workbench";
import { journeyTone, parseCourier } from "@/lib/care/journey-display";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";

/**
 * ═══════════ BA KẾT QUẢ XỬ LÝ: ĐÃ HOÀN · PHÁT TIẾP · XỬ LÝ SAU ═══════════
 *
 * Bài này khoá đúng những điều đề bài 18/09/2026 gọi là "không được làm":
 *
 *  1. Ba nút KHÔNG sinh ra một sổ thứ hai — chúng ghi vào `care_business_actions` đã có, và "kết
 *     quả hiện tại" là một PHÉP ĐỌC trên sổ đó, không phải một cột song song.
 *  2. Ghi rồi thì ĐỌC LẠI PHẢI RA ĐÚNG THẾ (mục 11 / CASE 1-2 của đề bài): không có chuyện tải lại
 *     trang là mất trạng thái hay mất note.
 *  3. Nhân viên bấm "Đã hoàn" KHÔNG làm vận đơn thành hoàn (CASE 10) — `shipments.stage` không đổi
 *     một ký tự.
 *  4. Sự kiện ĐVVC ập tới SAU đó KHÔNG xoá quyết định và KHÔNG xoá note của người (CASE 5-6).
 *  5. Nhật ký trả lời đủ: ai · lúc nào · từ đâu sang đâu · note gì · hẹn gì (CASE 8).
 *  6. "Xử lý sau" không có giờ thì bị TỪ CHỐI — hẹn không giờ là ca chìm mất (CASE 3).
 *
 * Mọi mốc thời gian trong bài dựng TỪ ĐỒNG HỒ THẬT lúc chạy (`gio(n)`), không ghim một ngày tuyệt
 * đối rồi gieo dữ liệu tương đối so với nó — luật 50.
 */

const P = "cres-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

export async function testCareResolution(db: Db) {
  /* ═══════════ 1. BA NÚT PHỦ ĐÚNG BA QUYẾT ĐỊNH, KHÔNG HƠN KHÔNG KÉM ═══════════ */

  assert.equal(RESOLUTION_ACTIONS.length, 3, "chủ shop chốt BA kết quả — thêm cái thứ tư là đổi đề bài, không phải sửa mã");
  const daPhu = new Set(RESOLUTION_ACTIONS.map((r) => RESOLUTION_TO_BUSINESS[r]));
  assert.equal(daPhu.size, 3, "ba nút phải trỏ tới BA quyết định KHÁC nhau — hai nút cùng một đích là một nút chết");
  for (const r of RESOLUTION_ACTIONS) assert.equal(resolutionOf(RESOLUTION_TO_BUSINESS[r]), r, `${r}: ánh xạ phải đi về được`);
  // `EXCHANGE` là quyết định THẬT nhưng KHÔNG thuộc ba nút: ép nó vào một rổ là đếm sai báo cáo.
  const ngoaiBaNut = BUSINESS_ACTIONS.filter((a) => !daPhu.has(a));
  assert.deepEqual(ngoaiBaNut, ["EXCHANGE"], "đúng một quyết định nằm ngoài ba nút, và nó phải trả về null");
  assert.equal(resolutionOf("EXCHANGE"), null, "Đổi KHÔNG được ánh xạ thành một trong ba kết quả");
  assert.equal(resolutionOf(null), null, "chưa quyết gì ⇒ null, không phải một giá trị mặc định");
  for (const r of RESOLUTION_ACTIONS) assert.ok(RESOLUTION_NOTES_DEFAULT[r].length >= 3, `${r}: phải có mẫu note mặc định để bấm một phát`);
  assert.deepEqual(
    RESOLUTION_ACTIONS.map((r) => RESOLUTION_LABEL[r]),
    ["Đã hoàn", "Phát tiếp", "Xử lý sau"],
    "đúng ba chữ chủ shop yêu cầu, theo đúng thứ tự phím tắt 1 · 2 · 3",
  );

  /* ═══════════ 2. HẸN XEM LẠI LÀ HÀM THUẦN, VÀ "CUỐI BUỔI" NEO VÀO GIỜ LÀM VIỆC ═══════════ */

  const moc = new Date();
  // Chạy hai lần ra CÙNG kết quả — không có `Date.now()` ẩn bên trong.
  for (const c of FOLLOW_UP_CHOICES) assert.equal(followUpAtFrom(c.key, moc).getTime(), followUpAtFrom(c.key, moc).getTime(), `${c.key}: hàm phải thuần`);
  for (const c of FOLLOW_UP_CHOICES) assert.ok(followUpAtFrom(c.key, moc).getTime() > moc.getTime(), `${c.key}: hẹn phải ở PHÍA TRƯỚC — hẹn vào quá khứ là ca nhảy lại hàng đợi ngay lập tức`);
  // Sáng 8 giờ: "cuối buổi" là 18 giờ CÙNG NGÀY. Tối 20 giờ: là 18 giờ NGÀY MAI, không phải hôm qua.
  const sang = new Date(moc);
  sang.setHours(8, 0, 0, 0);
  const cuoiBuoiSang = followUpAtFrom("end_of_day", sang);
  assert.equal(cuoiBuoiSang.getHours(), WORK_DAY_END_HOUR);
  assert.equal(cuoiBuoiSang.getDate(), sang.getDate(), "bấm buổi sáng ⇒ cuối buổi HÔM NAY");
  const toi = new Date(moc);
  toi.setHours(20, 0, 0, 0);
  const cuoiBuoiToi = followUpAtFrom("end_of_day", toi);
  assert.ok(cuoiBuoiToi.getTime() > toi.getTime(), "bấm sau giờ tan làm ⇒ cuối buổi NGÀY MAI, không phải một mốc đã trôi qua");
  assert.equal(followUpAtFrom("tomorrow", moc).getHours(), WORK_DAY_START_HOUR);
  // Hai người cùng bấm "cuối buổi" trong cùng một buổi phải ra CÙNG một mốc — cộng N giờ thì không.
  const a1 = new Date(moc);
  a1.setHours(9, 15, 0, 0);
  const a2 = new Date(moc);
  a2.setHours(16, 40, 0, 0);
  assert.equal(followUpAtFrom("end_of_day", a1).getTime(), followUpAtFrom("end_of_day", a2).getTime(), "“cuối buổi” phải neo vào giờ làm việc, không cộng thêm N giờ");

  /* ═══════════ 3. RỔ CÁI HẸN: BIÊN LÀ CHỖ DỄ SAI NHẤT ═══════════ */

  const bayGio = new Date(moc);
  bayGio.setHours(10, 0, 0, 0);
  assert.equal(followUpBucket(null, bayGio), "none", "chưa hẹn là một rổ RIÊNG — không phải “đến hạn hôm nay”");
  assert.equal(followUpBucket(new Date(bayGio.getTime() - 1000), bayGio), "overdue", "đã qua một giây cũng là quá hẹn");
  assert.equal(followUpBucket(bayGio, bayGio), "overdue", "đúng giờ hẹn là ĐẾN LƯỢT, không phải “còn thời gian”");
  assert.equal(followUpBucket(new Date(bayGio.getTime() + 3600_000), bayGio), "today");
  const maiSom = new Date(bayGio);
  maiSom.setDate(maiSom.getDate() + 1);
  maiSom.setHours(1, 0, 0, 0);
  assert.equal(followUpBucket(maiSom, bayGio), "tomorrow", "1 giờ sáng mai là NGÀY MAI dù chỉ cách 15 tiếng — người đọc nghĩ theo ngày lịch, không theo 24 giờ");
  const tuanSau = new Date(bayGio);
  tuanSau.setDate(tuanSau.getDate() + 7);
  assert.equal(followUpBucket(tuanSau, bayGio), "later", "hẹn xa hơn ngày mai KHÔNG phải “chưa hẹn” — gộp là làm mất một cái hẹn có thật");

  /* ═══════════ 4. LIÊN KẾT TRA CỨU CHỈ DỰNG TỪ MÃ VIETTEL POST ═══════════ */

  assert.equal(getViettelPostTrackingUrl(null), null, "chưa có mã VTP ⇒ KHÔNG vẽ liên kết, không vẽ nút mờ");
  assert.equal(getViettelPostTrackingUrl("   "), null);
  assert.ok(getViettelPostTrackingUrl(`${P}1`)?.includes(encodeURIComponent(`${P}1`)), "mã phải nằm trong địa chỉ và được mã hoá");

  /* ═══════════ 5. BƯU TÁ ĐỌC RA TỪ CÂU CHỮ — KHÔNG NHẬN RA THÌ KHÔNG BỊA ═══════════ */

  assert.deepEqual(parseCourier("Phân công phát - Bưu tá: Nguyễn Thanh Phong - 0394154474"), { name: "Nguyễn Thanh Phong", phone: "0394154474" });
  assert.equal(parseCourier("Nhận bảng kê đến"), null, "câu không có bưu tá ⇒ null, không phải một tên rỗng");
  assert.equal(parseCourier("Bưu tá: Trần Lê Nhựt Bình"), null, "thiếu số điện thoại ⇒ null — nút gọi không được trỏ vào hư không");
  // Màu hành trình: "Phát không thành công" KHÔNG được ăn nhánh "thành công" — đó là lỗi dò chuỗi
  // cổ điển, và nó tô xanh đúng những dòng cần đỏ.
  assert.equal(journeyTone("Phát không thành công"), journeyTone("Giao thất bại"), "hai câu cùng nghĩa phải cùng màu");
  assert.notEqual(journeyTone("Phát không thành công"), journeyTone("Phát thành công"), "“không thành công” không được tô như “thành công”");
  assert.equal(journeyTone("Nhận bảng kê đến"), "", "câu bình thường thì KHÔNG tô — hành trình tô lung tung là hành trình không ai đọc màu nữa");

  /* ═══════════ 6. GHI MỘT QUYẾT ĐỊNH RỒI ĐỌC LẠI: PHẢI RA ĐÚNG THẾ ═══════════ */

  const nv: CareActor = { id: null, email: "cres@test", name: "NV Kết quả", source: "UI" };
  /*
    KHAI TÀI KHOẢN ĐVVC GIẢ cho phần còn lại của bài.

    Hai trong ba kết quả ("Đã hoàn", "Phát tiếp") GỬI MỘT LỆNH sang Viettel Post, nên ERP chưa khai
    tài khoản API thì chúng bị chặn ngay từ khâu điều kiện — đúng luật, và chính vì thế bài kiểm
    phải khai tài khoản, không được nới luật. Kiện dưới đây mang `WEBHOOK_ONLY` (đúng như 2.138/2.151
    vận đơn thật của shop), nên đường đi phải là LÀM TAY CÓ GHI VẾT chứ không phải một lệnh API.
  */
  setViettelPostClientForTests({ configured: true, getOrderDetail: async () => null, updateOrder: async () => ({ error: false, status: 200, message: "ok", data: null }) });
  try {
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "SHIPPED", status: 3, insertedAt: gio(48), billFullName: "Khách Kết Quả", billPhone: "0911000111", moneyToCollect: 499_000 }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}s1`, orderId: `${P}o1`, carrier: "Viettel Post", vtpOrderNumber: `${P}VTP1`, stage: "DELIVERY_FAILED", codAmount: 499_000, trackingCapability: "WEBHOOK_ONLY", vtpStatus: 506, vtpStatusName: "Tồn - Khách hàng nghỉ, không có nhà", vtpStatusDate: gio(6) })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(6), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  clearMemo();

  const chuaQuyet = await loadCareState(`${P}s1`);
  assert.equal(chuaQuyet.lastDecision ?? null, null, "chưa ai bấm gì ⇒ CHƯA QUYẾT ĐỊNH, không phải một giá trị mặc định");

  const henLuc = new Date(Date.now() + 2 * 3600_000);
  const xuLySau = await recordBusinessAction(nv, { shipmentId: `${P}s1`, action: RESOLUTION_TO_BUSINESS.FOLLOW_UP_LATER, note: "Chờ khách phản hồi", followUpAt: henLuc });
  assert.ok("ok" in xuLySau, `“Xử lý sau” phải ghi được: ${"error" in xuLySau ? xuLySau.error : ""}`);

  // ĐỌC LẠI BẰNG MỘT PHÉP ĐỌC KHÁC (không dùng lại kết quả trả về) — đây chính là "tải lại trang".
  const sauKhiGhi = await loadCareState(`${P}s1`);
  assert.equal(sauKhiGhi.lastDecision?.action, "CONTINUE_MONITORING", "tải lại phải thấy ĐÚNG kết quả vừa chọn (CASE 1 của đề bài)");
  assert.equal(resolutionOf(sauKhiGhi.lastDecision!.action), "FOLLOW_UP_LATER");
  assert.equal(sauKhiGhi.lastNote, "Chờ khách phản hồi", "note đi kèm quyết định KHÔNG được mất sau khi tải lại (CASE 2)");
  assert.equal(sauKhiGhi.followUpAt?.getTime(), henLuc.getTime(), "giờ hẹn lưu ĐÚNG mốc người chọn (CASE 3)");
  assert.equal(sauKhiGhi.lastDecision?.by, nv.email, "quyết định phải nói được AI đã bấm");

  /* ═══════════ 7. "XỬ LÝ SAU" KHÔNG CÓ GIỜ THÌ TỪ CHỐI ═══════════ */

  const khongGio = await recordBusinessAction(nv, { shipmentId: `${P}s1`, action: "CONTINUE_MONITORING", note: "quên chọn giờ" });
  assert.ok("error" in khongGio, "hẹn không có giờ phải bị TỪ CHỐI — một cái hẹn không giờ là ca chìm xuống đáy hàng đợi");

  /* ═══════════ 8. NHÂN VIÊN BẤM "ĐÃ HOÀN" ≠ VIETTEL POST ĐÃ HOÀN (CASE 10) ═══════════ */

  const truocKhiHoan = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, `${P}s1`), columns: { stage: true, vtpStatus: true, vtpStatusName: true } });
  const daHoan = await recordBusinessAction(nv, { shipmentId: `${P}s1`, action: RESOLUTION_TO_BUSINESS.RETURNED, reasonCode: "CUSTOMER_REFUSED", note: "Khách xác nhận không lấy nữa" });
  assert.ok("ok" in daHoan, `“Đã hoàn” phải ghi được: ${"error" in daHoan ? daHoan.error : ""}`);
  const sauKhiHoan = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, `${P}s1`), columns: { stage: true, vtpStatus: true, vtpStatusName: true } });
  assert.deepEqual(sauKhiHoan, truocKhiHoan, "QUYẾT ĐỊNH CỦA SHOP KHÔNG ĐƯỢC CHẠM VÀO CHỨNG TỪ ĐVVC — kiện vẫn đang giao hụt cho tới khi Viettel Post nói khác");

  const dot = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, `${P}s1`), eq(schema.shipmentCare.active, true)) });
  assert.equal(dot?.resolution, "RETURN_APPROVED", "quyết định duyệt hoàn ghi vào cột QUYẾT ĐỊNH");
  assert.equal(dot?.finalLogisticsOutcome ?? null, null, "kết cục LOGISTICS vẫn CHƯA BIẾT — nó chỉ do chứng từ ĐVVC chốt");
  assert.notEqual(dot?.careOutcome, "RESCUE_FAILED", "bấm “Đã hoàn” không tự kết luận ca là không cứu được");

  /* ═══════════ 9. "ĐÃ HOÀN" KHÔNG CÓ LÝ DO THÌ TỪ CHỐI ═══════════ */

  const khongLyDo = await recordBusinessAction(nv, { shipmentId: `${P}s1`, action: "APPROVE_RETURN", note: "thôi khỏi nói vì sao" });
  assert.ok("error" in khongLyDo, "duyệt hoàn không lý do phải bị từ chối — báo cáo lý do hoàn rỗng vĩnh viễn nếu bước này bỏ qua");

  /* ═══════════ 10. NHẬT KÝ CHỈ THÊM: AI · LÚC NÀO · TRƯỚC/SAU · NOTE · HẸN (CASE 8) ═══════════ */

  const so = await db.select().from(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, `${P}s1`)).orderBy(desc(schema.careBusinessActions.requestedAt));
  assert.equal(so.length, 2, "hai lần bấm thành công ⇒ hai dòng; lần bị từ chối KHÔNG được ghi gì");
  assert.deepEqual(new Set(so.map((r) => r.actionType as BusinessAction)), new Set(["CONTINUE_MONITORING", "APPROVE_RETURN"]));
  for (const r of so) {
    assert.equal(r.actorEmail, nv.email, "mỗi dòng phải nói ai bấm");
    assert.ok(r.previousCareStatus && r.nextCareStatus, "mỗi dòng phải nói trạng thái TRƯỚC và SAU");
    assert.ok(r.requestedAt instanceof Date, "mỗi dòng phải có mốc");
  }
  const dongHoan = so.find((r) => r.actionType === "APPROVE_RETURN")!;
  assert.equal(dongHoan.reasonCode, "CUSTOMER_REFUSED", "lý do lưu theo DANH MỤC (đếm được), không chỉ là ô chữ");
  assert.equal(dongHoan.reasonNote, "Khách xác nhận không lấy nữa");

  const chiTiet = await getCareCaseDetail(`${P}s1`);
  assert.equal(chiTiet?.decisions.length, 2, "panel phải đọc được cả hai quyết định");
  assert.equal(chiTiet?.decisions[0].action, "APPROVE_RETURN", "mới nhất đứng trước");
  assert.ok(chiTiet?.decisions.every((d) => d.actor), "mỗi dòng nhật ký phải quy được về một người");
  assert.equal(chiTiet?.care.lastDecision?.action, "APPROVE_RETURN", "“kết quả hiện tại” = quyết định MỚI NHẤT của đợt");
  assert.equal(chiTiet?.shipment.vtpOrderNumber, `${P}VTP1`, "panel phải có mã Viettel Post THẬT để dựng liên kết tra cứu (CASE 4)");
  assert.ok(chiTiet?.shipment.substate, "panel phải có trạng thái con của ĐVVC, không chỉ có chặng gộp");

  /* ═══════════ 11. SỰ KIỆN ĐVVC KHÔNG XOÁ QUYẾT ĐỊNH VÀ KHÔNG XOÁ NOTE (CASE 5 & 6) ═══════════ */

  await addCareNote(nv, { shipmentId: `${P}s1`, note: "Đã gọi lần 3, khách không nghe", kind: "CALLED_NO_ANSWER" });
  const truocWebhook = await loadCareState(`${P}s1`);

  // Webhook / import ập tới với một trạng thái MỚI của ĐVVC — đúng đường mà `applyCarrierEventToCare` đi.
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: "202", statusName: "Đang chuyển hoàn", occurredAt: new Date(), normalizedStage: "RETURNING", legType: "RETURN" }).onConflictDoNothing();
  await db.update(schema.shipments).set({ stage: "RETURNING", vtpStatus: 202, vtpStatusName: "Đang chuyển hoàn", vtpStatusDate: new Date() }).where(eq(schema.shipments.id, `${P}s1`));
  await applyCarrierEventToCare(db, { shipmentId: `${P}s1`, orderId: `${P}o1`, trackingNumber: `${P}VTP1`, stage: "RETURNING", vtpStatus: 202, vtpStatusName: "Đang chuyển hoàn", occurredAt: new Date(), source: "VTP_WEBHOOK" });
  clearMemo();

  const sauWebhook = await loadCareState(`${P}s1`);
  assert.equal(sauWebhook.lastDecision?.action, truocWebhook.lastDecision?.action, "sự kiện ĐVVC KHÔNG được xoá quyết định của người (CASE 5)");
  assert.equal(sauWebhook.lastNote, truocWebhook.lastNote, "sự kiện ĐVVC KHÔNG được xoá note của người");
  const [{ n: soSauWebhook }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, `${P}s1`));
  assert.equal(Number(soSauWebhook), 2, "so quyết định CHỈ THÊM — webhook không xoá, không sửa một dòng nào");

  /* ═══════════ 12. ĐÓNG CA RỒI, QUYẾT ĐỊNH VẪN ĐỌC LẠI ĐƯỢC ═══════════ */

  await setCareStatus(nv, { shipmentIds: [`${P}s1`], status: "RESOLVED", note: "xong" });
  const sauKhiDong = await loadCareState(`${P}s1`);
  assert.equal(sauKhiDong.status, "RESOLVED");
  assert.equal(sauKhiDong.lastDecision?.action, "APPROVE_RETURN", "đóng ca KHÔNG làm mất kết quả đã quyết — tab “Đã xử lý” vẫn phải in ra được");

  /*
    KIỆN WEBHOOK_ONLY ⇒ ERP KHÔNG gọi API, mà ghi một yêu cầu PHẢI LÀM TAY. Nếu chỗ này thành
    "đã gửi" thì nghĩa là luật năng lực tài khoản đã bị nới ở đâu đó, và mọi lệnh sẽ bị ĐVVC từ chối
    trong im lặng.
  */
  const lenh = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, `${P}s1`));
  assert.ok(lenh.length >= 1, "“Đã hoàn” trên kiện có mã VTP phải để lại một dòng yêu cầu ĐVVC — không có dòng nào thì không truy lại được vì sao");
  assert.ok(lenh.every((r) => r.status === "MANUAL_REQUIRED"), "vận đơn Pancake tạo KHÔNG thuộc tài khoản API ⇒ phải ghi LÀM TAY, không gọi API");

  } finally {
    setViettelPostClientForTests(null);
  }

  /* ───────── DỌN SẠCH: mọi dòng bài này thêm vào đều mang tiền tố, không dòng nào ở lại ───────── */
  await db.delete(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, `${P}s1`));
  await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, `${P}s1`));
  await db.delete(schema.careActions).where(eq(schema.careActions.shipmentId, `${P}s1`));
  await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, `${P}s1`));
  await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, `${P}s1`));
  await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s1`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  clearMemo();

  console.log("✓ Kết quả xử lý: ba nút phủ đúng ba quyết định (Đổi nằm ngoài, trả null) · hẹn xem lại là hàm thuần và “cuối buổi” neo vào giờ làm · ghi rồi đọc lại ra đúng trạng thái + note + giờ hẹn · “Đã hoàn” của người KHÔNG chạm chứng từ ĐVVC · webhook không xoá quyết định/note · nhật ký chỉ thêm, đủ ai/lúc nào/trước-sau/lý do");
}
