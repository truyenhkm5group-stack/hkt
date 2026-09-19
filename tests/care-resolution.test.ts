import assert from "node:assert/strict";
import { and, desc, eq, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { addCareNote, loadCareState, recordCareDecision, requestCarrierAction, setCareStatus, type CareActor } from "@/lib/care/service";
import { applyCarrierEventToCare } from "@/lib/care/lifecycle";
import {
  CARE_DECISIONS,
  DECISION_NEEDS_FOLLOW_UP,
  DECISION_NEEDS_REASON,
  DECISION_NEXT_CARE_STATUS,
  FOLLOW_UP_CHOICES,
  RESOLUTION_LABEL,
  RESOLUTION_NOTES_DEFAULT,
  WORK_DAY_END_HOUR,
  WORK_DAY_START_HOUR,
  careDecisionOf,
  followUpAtFrom,
  followUpBucket,
} from "@/lib/constants/care-resolution";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { getCareCaseDetail } from "@/lib/queries/care-workbench";
import { journeyTone, parseCourier } from "@/lib/care/journey-display";
import { getViettelPostTrackingUrl } from "@/lib/constants/viettelpost";
import { rowsOf } from "@/lib/sql-rows";

/**
 * ═══════════ BA KẾT QUẢ CARE: ĐÃ HOÀN · PHÁT TIẾP · XỬ LÝ SAU ═══════════
 *
 * ─── LUẬT MÀ BÀI NÀY KHOÁ (chủ shop chốt 19/09/2026) ───
 *
 * **CARE DECISION ≠ VTP COMMAND.** Ba lựa chọn này là KẾT QUẢ CÔNG VIỆC của người trực, không phải
 * một lệnh gửi đi. Bản đầu tiên ánh xạ chúng về `BusinessAction` — và hai trong ba cái đó gửi lệnh
 * sang Viettel Post, nên đường ghi từ chối khi ĐVVC không nhận lệnh. Hệ quả: **năng lực API của ERP
 * quyết định xem NHÂN VIÊN có ghi nhận được việc mình vừa làm hay không.**
 *
 * Tám tình huống dưới đây (CASE A–H trong đề bài) là tám cách lỗi đó quay lại, nên chúng được khoá
 * bằng dữ liệu thật chứ không bằng một lời hứa trong chú thích:
 *
 *   A · ERP chưa khai `VIETTELPOST_API_KEY`        ⇒ vẫn ghi được cả ba kết quả
 *   B · kiện KHÔNG có mã vận đơn Viettel Post       ⇒ vẫn ghi được
 *   C · ĐVVC đã kết thúc (đã giao / đã hoàn / huỷ)  ⇒ vẫn ghi được
 *   D · chọn "Phát tiếp"                            ⇒ KHÔNG một lệnh ĐVVC nào được gửi
 *   E · chọn "Đã hoàn"                              ⇒ `shipments.stage` / trạng thái con KHÔNG đổi
 *   F · webhook ĐVVC chạy sau đó                    ⇒ quyết định + note còn nguyên
 *   G · lệnh gửi ĐVVC THẤT BẠI                      ⇒ quyết định care trước đó còn nguyên
 *   H · tải lại trang                               ⇒ kết quả + note + giờ hẹn còn nguyên
 *
 * Mọi mốc thời gian trong bài dựng TỪ ĐỒNG HỒ THẬT lúc chạy (`gio(n)`), không ghim một ngày tuyệt
 * đối rồi gieo dữ liệu tương đối so với nó — luật 50.
 */

const P = "cres-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

/** Đếm lệnh ĐVVC đã ghi cho một kiện — `carrier_action_requests` là NƠI DUY NHẤT một lệnh để lại vết. */
async function soLenhDVVC(db: Db, shipmentId: string): Promise<number> {
  const [r] = rowsOf<{ n: number }>(await db.execute(sql`select count(*)::int as n from carrier_action_requests where shipment_id = ${shipmentId}`));
  return Number(r?.n ?? 0);
}

export async function testCareResolution(db: Db) {
  /* ═══════════ 1. BA KẾT QUẢ, VÀ KHOÁ CỦA CHÚNG KHÔNG ĐỌC NHẦM THÀNH TRẠNG THÁI ĐVVC ═══════════ */

  assert.equal(CARE_DECISIONS.length, 3, "chủ shop chốt BA kết quả — thêm cái thứ tư là đổi đề bài, không phải sửa mã");
  assert.deepEqual(
    CARE_DECISIONS.map((r) => RESOLUTION_LABEL[r]),
    ["Đã hoàn", "Phát tiếp", "Xử lý sau"],
    "đúng ba chữ chủ shop yêu cầu, theo đúng thứ tự phím tắt 1 · 2 · 3",
  );
  /*
    TIỀN TỐ `CARE_` LÀ MỘT RÀNG BUỘC, KHÔNG PHẢI MỘT SỞ THÍCH ĐẶT TÊN.

    Một lập trình viên sáu tháng sau đọc `decision = 'RETURNED'` trong CSDL sẽ tin rằng kiện đã hoàn
    thật. `RETURNED` / `DELIVERED` / `CANCELLED` là từ vựng của ĐVVC; từ vựng của bàn care phải nói
    ra được rằng nó là quyết định của NGƯỜI.
  */
  for (const k of CARE_DECISIONS) assert.ok(k.startsWith("CARE_"), `${k}: khoá kết quả care phải mang tiền tố CARE_ để không đọc nhầm thành trạng thái ĐVVC`);
  assert.equal(careDecisionOf("RETURNED"), null, "trạng thái ĐVVC KHÔNG phải một kết quả care — không được ánh xạ vào");
  assert.equal(careDecisionOf("APPROVE_RETURN"), null, "lệnh gửi ĐVVC KHÔNG phải một kết quả care");
  assert.equal(careDecisionOf(null), null, "chưa quyết gì ⇒ null, không phải một giá trị mặc định");
  for (const r of CARE_DECISIONS) assert.equal(careDecisionOf(r), r);
  for (const r of CARE_DECISIONS) assert.ok(RESOLUTION_NOTES_DEFAULT[r].length >= 3, `${r}: phải có mẫu note mặc định để bấm một phát`);
  // Chỉ "Đã hoàn" cần lý do, chỉ "Xử lý sau" cần giờ. Bắt thêm dữ kiện nào nữa là thêm ma sát không có căn cứ.
  assert.deepEqual(CARE_DECISIONS.filter((r) => DECISION_NEEDS_REASON[r]), ["CARE_RETURN"]);
  assert.deepEqual(CARE_DECISIONS.filter((r) => DECISION_NEEDS_FOLLOW_UP[r]), ["CARE_FOLLOW_UP"]);
  // Trạng thái đích phải là trạng thái ĐANG CHẠY trên production — không đẻ giá trị thứ mười.
  for (const r of CARE_DECISIONS) assert.ok(["WAITING_CARRIER", "WAITING_REDELIVERY"].includes(DECISION_NEXT_CARE_STATUS[r]), `${r}: trạng thái đích phải nằm trong bộ đang chạy`);

  /* ═══════════ 2. HẸN XEM LẠI LÀ HÀM THUẦN, VÀ "CUỐI BUỔI" NEO VÀO GIỜ LÀM VIỆC ═══════════ */

  const moc = new Date();
  for (const c of FOLLOW_UP_CHOICES) assert.equal(followUpAtFrom(c.key, moc).getTime(), followUpAtFrom(c.key, moc).getTime(), `${c.key}: hàm phải thuần`);
  for (const c of FOLLOW_UP_CHOICES) assert.ok(followUpAtFrom(c.key, moc).getTime() > moc.getTime(), `${c.key}: hẹn phải ở PHÍA TRƯỚC — hẹn vào quá khứ là ca nhảy lại hàng đợi ngay lập tức`);
  const sang = new Date(moc);
  sang.setHours(8, 0, 0, 0);
  const cuoiBuoiSang = followUpAtFrom("end_of_day", sang);
  assert.equal(cuoiBuoiSang.getHours(), WORK_DAY_END_HOUR);
  assert.equal(cuoiBuoiSang.getDate(), sang.getDate(), "bấm buổi sáng ⇒ cuối buổi HÔM NAY");
  const toi = new Date(moc);
  toi.setHours(20, 0, 0, 0);
  assert.ok(followUpAtFrom("end_of_day", toi).getTime() > toi.getTime(), "bấm sau giờ tan làm ⇒ cuối buổi NGÀY MAI, không phải một mốc đã trôi qua");
  assert.equal(followUpAtFrom("tomorrow", moc).getHours(), WORK_DAY_START_HOUR);
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
  assert.equal(journeyTone("Phát không thành công"), journeyTone("Giao thất bại"), "hai câu cùng nghĩa phải cùng màu");
  assert.notEqual(journeyTone("Phát không thành công"), journeyTone("Phát thành công"), "“không thành công” không được tô như “thành công”");
  assert.equal(journeyTone("Nhận bảng kê đến"), "", "câu bình thường thì KHÔNG tô — hành trình tô lung tung là hành trình không ai đọc màu nữa");

  /* ═══════════════════════════════════════════════════════════════════════════════════════════
     CASE A · ERP CHƯA KHAI TÀI KHOẢN API VIETTEL POST ⇒ BA KẾT QUẢ VẪN GHI ĐƯỢC

     Đây là tình huống làm hỏng bản đầu tiên. `setViettelPostClientForTests(null)` đưa ERP về đúng
     trạng thái "chưa cấu hình" — và toàn bộ khối dưới đây chạy TRONG trạng thái đó, cố ý.
     ═══════════════════════════════════════════════════════════════════════════════════════════ */

  setViettelPostClientForTests(null);

  const nv: CareActor = { id: null, email: "cres@test", name: "NV Kết quả", source: "UI" };
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "SHIPPED", status: 3, insertedAt: gio(48), billFullName: "Khách Kết Quả", billPhone: "0911000111", moneyToCollect: 499_000 }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}s1`, orderId: `${P}o1`, carrier: "Viettel Post", vtpOrderNumber: `${P}VTP1`, stage: "DELIVERY_FAILED", codAmount: 499_000, trackingCapability: "WEBHOOK_ONLY", vtpStatus: 506, vtpStatusName: "Tồn - Khách hàng nghỉ, không có nhà", vtpStatusDate: gio(6) })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: "502", statusName: "Phát không thành công", occurredAt: gio(6), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
  clearMemo();

  assert.equal((await loadCareState(`${P}s1`)).lastDecision ?? null, null, "chưa ai bấm gì ⇒ CHƯA QUYẾT ĐỊNH, không phải một giá trị mặc định");

  // Cả BA kết quả đều ghi được khi ERP không có tài khoản API nào.
  const henLuc = new Date(Date.now() + 2 * 3600_000);
  for (const [decision, extra] of [
    ["CARE_CONTINUE_DELIVERY", {}],
    ["CARE_FOLLOW_UP", { followUpAt: henLuc }],
    ["CARE_RETURN", { reasonCode: "CUSTOMER_REFUSED" }],
  ] as const) {
    const r = await recordCareDecision(nv, { shipmentId: `${P}s1`, decision, note: `ghi khi ERP chưa có API · ${decision}`, ...extra });
    assert.ok("ok" in r, `CASE A · ${RESOLUTION_LABEL[decision]} phải ghi được khi ERP chưa khai VIETTELPOST_API_KEY — nhận: ${"error" in r ? r.error : ""}`);
  }
  assert.equal(await soLenhDVVC(db, `${P}s1`), 0, "CASE D · ba kết quả care KHÔNG được sinh một lệnh ĐVVC nào — kể cả “Phát tiếp” và “Đã hoàn”");

  /* ═══════════ CASE E · "ĐÃ HOÀN" CỦA NGƯỜI KHÔNG CHẠM MỘT KÝ TỰ NÀO CỦA CHỨNG TỪ ═══════════ */

  const truocKhiHoan = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, `${P}s1`), columns: { stage: true, vtpStatus: true, vtpStatusName: true, isFinal: true, codStatus: true } });
  await recordCareDecision(nv, { shipmentId: `${P}s1`, decision: "CARE_RETURN", reasonCode: "CUSTOMER_REFUSED", note: "Khách xác nhận không lấy nữa" });
  const sauKhiHoan = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, `${P}s1`), columns: { stage: true, vtpStatus: true, vtpStatusName: true, isFinal: true, codStatus: true } });
  assert.deepEqual(sauKhiHoan, truocKhiHoan, "CASE E · QUYẾT ĐỊNH CỦA NGƯỜI KHÔNG ĐƯỢC CHẠM CHỨNG TỪ ĐVVC — kiện vẫn đang giao hụt cho tới khi Viettel Post nói khác");

  const dot = await db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, `${P}s1`), eq(schema.shipmentCare.active, true)) });
  assert.equal(dot?.resolution, "RETURN_APPROVED", "quyết định duyệt hoàn ghi vào cột QUYẾT ĐỊNH của shop");
  assert.equal(dot?.finalLogisticsOutcome ?? null, null, "kết cục LOGISTICS vẫn CHƯA BIẾT — nó chỉ do chứng từ ĐVVC chốt");
  assert.notEqual(dot?.careOutcome, "RESCUE_FAILED", "bấm “Đã hoàn” không tự kết luận ca là không cứu được");

  /* ═══════════ CASE H · TẢI LẠI TRANG: KẾT QUẢ + NOTE + GIỜ HẸN CÒN NGUYÊN ═══════════ */

  const taiLai = await loadCareState(`${P}s1`);
  assert.equal(taiLai.lastDecision?.decision, "CARE_RETURN", "CASE H · đọc lại phải ra ĐÚNG kết quả mới nhất");
  assert.equal(taiLai.lastNote, "Khách xác nhận không lấy nữa", "CASE H · note đi kèm quyết định KHÔNG được mất");
  assert.equal(taiLai.lastDecision?.by, nv.email, "quyết định phải nói được AI đã bấm");
  // Giờ hẹn của "Xử lý sau" được ghi đúng mốc người chọn (đọc lại từ chính sổ quyết định).
  const [dongHen] = await db.select().from(schema.careDecisions).where(and(eq(schema.careDecisions.shipmentId, `${P}s1`), eq(schema.careDecisions.decision, "CARE_FOLLOW_UP")));
  assert.equal(dongHen.followUpAt?.getTime(), henLuc.getTime(), "CASE H · giờ hẹn lưu ĐÚNG mốc người chọn");

  /* ═══════════ DỮ KIỆN BẮT BUỘC: THIẾU THÌ TỪ CHỐI, VÀ KHÔNG GHI GÌ ═══════════ */

  const truocKhiThu = await db.$count(schema.careDecisions, eq(schema.careDecisions.shipmentId, `${P}s1`));
  assert.ok("error" in (await recordCareDecision(nv, { shipmentId: `${P}s1`, decision: "CARE_FOLLOW_UP", note: "quên chọn giờ" })), "hẹn không có giờ phải bị TỪ CHỐI — hẹn không giờ là ca chìm xuống đáy hàng đợi");
  assert.ok("error" in (await recordCareDecision(nv, { shipmentId: `${P}s1`, decision: "CARE_RETURN", note: "thôi khỏi nói vì sao" })), "duyệt hoàn không lý do phải bị từ chối — báo cáo lý do hoàn rỗng vĩnh viễn nếu bước này bỏ qua");
  assert.equal(await db.$count(schema.careDecisions, eq(schema.careDecisions.shipmentId, `${P}s1`)), truocKhiThu, "lượt bị từ chối KHÔNG được ghi một dòng nào");

  /* ═══════════ NHẬT KÝ: AI · LÚC NÀO · TRƯỚC/SAU · LÝ DO · VÀ ĐVVC LÚC ĐÓ NÓI GÌ ═══════════ */

  const so = await db.select().from(schema.careDecisions).where(eq(schema.careDecisions.shipmentId, `${P}s1`)).orderBy(desc(schema.careDecisions.decidedAt));
  assert.equal(so.length, 4, "bốn lượt bấm thành công ⇒ bốn dòng, chỉ thêm, không ghi đè");
  for (const r of so) {
    assert.equal(r.actorEmail, nv.email, "mỗi dòng phải nói ai bấm");
    assert.ok(r.previousCareStatus && r.nextCareStatus, "mỗi dòng phải nói trạng thái xử lý TRƯỚC và SAU");
    /*
      ẢNH CHỤP CHIỀU ĐVVC LÚC BẤM — đây là bằng chứng đọc lại được rằng hai chiều là hai chiều. Một
      dòng "Đã hoàn" mang `carrier_substate_at_decision = DELIVERY_EXCEPTION` nói thẳng: lúc người
      bấm, Viettel Post vẫn đang báo kiện tồn, và ERP KHÔNG suy chiều nọ từ chiều kia.
    */
    assert.equal(r.carrierStageAtDecision, "DELIVERY_FAILED", "phải chụp lại chặng ĐVVC lúc bấm");
    assert.ok(r.carrierSubstateAtDecision, "phải chụp lại trạng thái con của ĐVVC lúc bấm");
  }
  assert.equal(so.filter((r) => r.decision === "CARE_RETURN")[0].reasonCode, "CUSTOMER_REFUSED", "lý do lưu theo DANH MỤC (đếm được), không chỉ là ô chữ");
  assert.ok(so.some((r) => r.previousDecision !== null), "dòng sau phải nhớ kết quả TRƯỚC đó — không có nó thì “đổi ý mấy lần” phải tự nối tay");

  const chiTiet = await getCareCaseDetail(`${P}s1`);
  assert.equal(chiTiet?.decisions.length, 4, "panel phải đọc được cả bốn quyết định");
  assert.equal(chiTiet?.decisions[0].decision, "CARE_RETURN", "mới nhất đứng trước");
  assert.equal(chiTiet?.carrierDecisions.length, 0, "sổ LỆNH GỬI ĐVVC phải RỖNG — ba nút care không gửi gì");
  assert.equal(chiTiet?.care.lastDecision?.decision, "CARE_RETURN", "“kết quả hiện tại” = quyết định MỚI NHẤT của đợt");
  assert.equal(chiTiet?.shipment.vtpOrderNumber, `${P}VTP1`, "panel phải có mã Viettel Post THẬT để dựng liên kết tra cứu");

  /* ═══════════ CASE F · WEBHOOK ĐVVC CHẠY SAU ĐÓ ⇒ QUYẾT ĐỊNH + NOTE CÒN NGUYÊN ═══════════ */

  await addCareNote(nv, { shipmentId: `${P}s1`, note: "Đã gọi lần 3, khách không nghe", kind: "CALLED_NO_ANSWER" });
  const truocWebhook = await loadCareState(`${P}s1`);

  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s1`, source: "VTP_WEBHOOK", status: "202", statusName: "Đang chuyển hoàn", occurredAt: new Date(), normalizedStage: "RETURNING", legType: "RETURN" }).onConflictDoNothing();
  await db.update(schema.shipments).set({ stage: "RETURNING", vtpStatus: 202, vtpStatusName: "Đang chuyển hoàn", vtpStatusDate: new Date() }).where(eq(schema.shipments.id, `${P}s1`));
  await applyCarrierEventToCare(db, { shipmentId: `${P}s1`, orderId: `${P}o1`, trackingNumber: `${P}VTP1`, stage: "RETURNING", vtpStatus: 202, vtpStatusName: "Đang chuyển hoàn", occurredAt: new Date(), source: "VTP_WEBHOOK" });
  clearMemo();

  const sauWebhook = await loadCareState(`${P}s1`);
  assert.equal(sauWebhook.lastDecision?.decision, truocWebhook.lastDecision?.decision, "CASE F · sự kiện ĐVVC KHÔNG được xoá quyết định của người");
  assert.equal(sauWebhook.lastNote, truocWebhook.lastNote, "CASE F · sự kiện ĐVVC KHÔNG được xoá note của người");
  assert.equal(await db.$count(schema.careDecisions, eq(schema.careDecisions.shipmentId, `${P}s1`)), 4, "CASE F · sổ quyết định CHỈ THÊM — webhook không xoá, không sửa một dòng nào");

  /* ═══════════ CASE C · ĐVVC ĐÃ KẾT THÚC ⇒ VẪN GHI ĐƯỢC KẾT QUẢ CARE ═══════════ */

  await db.update(schema.shipments).set({ stage: "RETURNED", isFinal: true, vtpStatus: 504, vtpStatusName: "Đã chuyển hoàn" }).where(eq(schema.shipments.id, `${P}s1`));
  clearMemo();
  const khiDaKetThuc = await recordCareDecision(nv, { shipmentId: `${P}s1`, decision: "CARE_RETURN", reasonCode: "CUSTOMER_REFUSED", note: "Chốt lại sau khi ĐVVC báo đã hoàn" });
  assert.ok("ok" in khiDaKetThuc, `CASE C · kiện đã kết thúc vẫn phải ghi được kết quả care — nhận: ${"error" in khiDaKetThuc ? khiDaKetThuc.error : ""}`);
  assert.equal(await soLenhDVVC(db, `${P}s1`), 0, "CASE C · và vẫn KHÔNG gửi lệnh nào sang ĐVVC");

  /* ═══════════ CASE B · KIỆN KHÔNG CÓ MÃ VẬN ĐƠN ĐVVC ⇒ VẪN GHI ĐƯỢC ═══════════ */

  await db.insert(schema.orders).values({ id: `${P}o2`, stage: "SHIPPED", status: 3, insertedAt: gio(30), billFullName: "Khách Chưa Có Mã", billPhone: "0911000222" }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: `${P}s2`, orderId: `${P}o2`, carrier: "Viettel Post", vtpOrderNumber: "", trackingCode: "", stage: "PENDING", codAmount: 350_000, trackingCapability: "UNKNOWN_CAPABILITY" }).onConflictDoNothing();
  clearMemo();
  for (const decision of CARE_DECISIONS) {
    const r = await recordCareDecision(nv, {
      shipmentId: `${P}s2`,
      decision,
      note: `kiện chưa có mã VTP · ${decision}`,
      reasonCode: DECISION_NEEDS_REASON[decision] ? "CUSTOMER_REFUSED" : undefined,
      followUpAt: DECISION_NEEDS_FOLLOW_UP[decision] ? new Date(Date.now() + 3600_000) : undefined,
    });
    assert.ok("ok" in r, `CASE B · ${RESOLUTION_LABEL[decision]} phải ghi được trên kiện CHƯA CÓ mã vận đơn — nhận: ${"error" in r ? r.error : ""}`);
  }
  assert.equal(await soLenhDVVC(db, `${P}s2`), 0, "CASE B · vẫn không một lệnh ĐVVC nào được sinh ra");

  /* ═══════════ CASE G · LỆNH GỬI ĐVVC THẤT BẠI ⇒ KẾT QUẢ CARE TRƯỚC ĐÓ CÒN NGUYÊN ═══════════ */

  const truocLenh = await loadCareState(`${P}s2`);
  assert.equal(truocLenh.lastDecision?.decision, "CARE_FOLLOW_UP", "kết quả gần nhất của kiện 2 là “Xử lý sau”");

  // ERP chưa khai tài khoản ⇒ `requestCarrierAction` phải TỪ CHỐI. Đó đúng là điều cần: lệnh gửi
  // ĐVVC được phép thất bại — miễn là nó không kéo theo kết quả care của người.
  const lenhHong = await requestCarrierAction(nv, { shipmentId: `${P}s2`, actionKey: "redeliver", note: "" });
  assert.ok("error" in lenhHong, "kiện chưa có mã vận đơn ⇒ lệnh ĐVVC phải bị từ chối");
  const sauLenh = await loadCareState(`${P}s2`);
  assert.equal(sauLenh.lastDecision?.decision, truocLenh.lastDecision?.decision, "CASE G · lệnh ĐVVC thất bại KHÔNG được làm mất kết quả care đã ghi");
  assert.equal(sauLenh.lastNote, truocLenh.lastNote, "CASE G · và không được làm mất note");

  /* ═══════════ ĐÓNG CA RỒI, KẾT QUẢ VẪN ĐỌC LẠI ĐƯỢC ═══════════ */

  await setCareStatus(nv, { shipmentIds: [`${P}s2`], status: "RESOLVED", note: "xong" });
  const sauKhiDong = await loadCareState(`${P}s2`);
  assert.equal(sauKhiDong.status, "RESOLVED");
  assert.equal(sauKhiDong.lastDecision?.decision, "CARE_FOLLOW_UP", "đóng ca KHÔNG làm mất kết quả đã quyết — tab “Đã xử lý” vẫn phải in ra được");
  // Ca ĐÃ ĐÓNG mà người vẫn cần ghi một kết quả: ghi được, và KHÔNG được tự mở lại ca (mở lại là
  // `reopenCase`, một thao tác có chủ đích của người).
  const ghiTrenCaDong = await recordCareDecision(nv, { shipmentId: `${P}s2`, decision: "CARE_RETURN", reasonCode: "CUSTOMER_REFUSED", note: "chốt lại trên ca đã đóng" });
  assert.ok("ok" in ghiTrenCaDong, `ca đã đóng vẫn phải ghi được kết quả — nhận: ${"error" in ghiTrenCaDong ? ghiTrenCaDong.error : ""}`);
  assert.equal((await loadCareState(`${P}s2`)).status, "RESOLVED", "ghi kết quả trên ca đã đóng KHÔNG được tự mở lại ca");

  /* ───────── DỌN SẠCH: mọi dòng bài này thêm vào đều mang tiền tố, không dòng nào ở lại ───────── */
  for (const sid of [`${P}s1`, `${P}s2`]) {
    await db.delete(schema.careDecisions).where(eq(schema.careDecisions.shipmentId, sid));
    await db.delete(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, sid));
    await db.delete(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, sid));
    await db.delete(schema.careCaseEvents).where(eq(schema.careCaseEvents.shipmentId, sid));
    await db.delete(schema.careActions).where(eq(schema.careActions.shipmentId, sid));
    await db.delete(schema.shipmentCare).where(eq(schema.shipmentCare.shipmentId, sid));
    await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.shipmentId, sid));
    await db.delete(schema.shipments).where(eq(schema.shipments.id, sid));
  }
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o2`));
  clearMemo();

  console.log(
    "✓ Kết quả care ĐỘC LẬP với ĐVVC: ghi được khi ERP chưa khai API (A) · kiện chưa có mã vận đơn (B) · kiện đã kết thúc (C) · không sinh lệnh ĐVVC nào (D) · không chạm chứng từ (E) · webhook không xoá quyết định/note (F) · lệnh ĐVVC hỏng không kéo theo kết quả care (G) · tải lại còn nguyên kết quả + note + giờ hẹn (H)",
  );
}
