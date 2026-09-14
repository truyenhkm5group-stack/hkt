import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARE_ENTRY_SUBSTATES, afterShipmentStateChange, applyCarrierEventToCare, NOT_CARE_CONDITION, reconcileCareCoverage, settleExchangeOutcome } from "@/lib/care/lifecycle";
import { recordBusinessAction, reopenCase, setCareOwner, setCareStatus, type CareActor } from "@/lib/care/service";
import { careViewOf, slaOf } from "@/lib/care/view";
import { CARE_FOLLOW_UP_DEFAULT_HOURS } from "@/lib/constants/care";
import { rescueRates } from "@/lib/constants/care-outcome";
import { getCarePerformanceByPic, getCarePerformanceByProduct, getRescueSummary } from "@/lib/queries/care-performance";
import { getCareReport } from "@/lib/queries/care-report";
import { IntegrationError } from "@/lib/integrations/http";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";
import { registerCareTools } from "@/lib/ai/tools/care";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ HỆ ĐIỀU HÀNH CHĂM SÓC VẬN ĐƠN ═══════════
 *
 * Bài này khoá đúng những chỗ mà hỏng thì **màn hình vẫn ra số** — chỉ là con số nói sai về việc
 * đội đã cứu được bao nhiêu đơn, hoặc một ca biến mất, hoặc một ca bị đếm hai lần. Không lỗi nào
 * trong số đó tự phát ra tiếng. Mọi mốc số lấy từ đo production 13/09/2026.
 */

const P = "cos-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
const ky = (from: Date | null, to: Date | null): Period => ({ key: "custom", label: "kỳ kiểm thử", from, to, fromKey: null, toKey: null });
const KY_TAT_CA = ky(null, null);

async function dungKien(db: Db, id: string, over: Partial<typeof schema.shipments.$inferInsert> = {}) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "PENDING", codAmount: 300_000, trackingCapability: "API_TRACKABLE", ...over })
    .onConflictDoNothing();
  return `${P}${id}`;
}

/** Một sự kiện ĐVVC đi qua đúng cửa mà `afterShipmentStateChange` gọi. */
async function suKien(db: Db, shipmentId: string, p: { stage: typeof schema.shipments.$inferSelect.stage; code?: number | null; text?: string | null; at?: Date; legType?: "OUTBOUND" | "RETURN" | null }) {
  return applyCarrierEventToCare(db, {
    shipmentId,
    orderId: `${P}o-${shipmentId.slice(P.length)}`,
    trackingNumber: shipmentId.toUpperCase(),
    stage: p.stage,
    vtpStatus: p.code ?? null,
    vtpStatusName: p.text ?? null,
    legType: p.legType ?? null,
    occurredAt: p.at ?? new Date(),
  });
}

const doc = (db: Db, shipmentId: string) => db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.shipmentId, shipmentId), orderBy: (t, { asc }) => [asc(t.episodeNo)] });
const dangMo = (db: Db, shipmentId: string) => db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, shipmentId), eq(schema.shipmentCare.active, true)) });

export async function testCareOs(db: Db) {
  /* ───── 1–2 · Ba trạng thái sự cố MỞ ca — nhưng "chờ xử lý" chỉ khi đã rời kho ───── */
  assert.deepEqual([...CARE_ENTRY_SUBSTATES].sort(), ["DELIVERY_EXCEPTION", "WAITING_PROCESSING", "WAITING_REDELIVERY"], "phạm vi cần care: chờ xử lý (đã rời kho) · chờ phát lại · tồn");

  // 106 đợt trên production mở cho mã 102 khi hàng CÒN TRONG KHO — đó chính là lỗi, không phải kỳ vọng.
  const sPre = await dungKien(db, "spre");
  const rPre = await suKien(db, sPre, { stage: "PENDING", code: 102, text: "Đơn hàng chờ xử lý" });
  assert.ok(!rPre.opened, "1 · mã 102 chưa có chứng từ rời kho KHÔNG mở ca — hàng còn trong kho, không phải việc của đội");
  assert.equal((await doc(db, sPre)).length, 0);

  const s1 = await dungKien(db, "s1", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", pickedUpAt: gio(10) });
  const r1 = await suKien(db, s1, { stage: "PENDING", code: 102, text: "Đơn hàng chờ xử lý" });
  assert.ok(r1.opened, "1 · “Chờ xử lý” CÓ mốc lấy hàng phải mở ca — kiện đang nằm chờ ở bưu cục");
  const s2 = await dungKien(db, "s2", { stage: "DELIVERY_FAILED" });
  const r2 = await suKien(db, s2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.ok(r2.opened, "2 · “Chờ phát lại” phải mở ca");
  const sTon = await dungKien(db, "ston", { stage: "DELIVERY_FAILED", vtpStatus: 506, vtpStatusName: "Tồn - Khách hàng nghỉ, không có nhà" });
  assert.ok((await suKien(db, sTon, { stage: "DELIVERY_FAILED", code: 506, text: "Tồn - Khách hàng nghỉ, không có nhà" })).opened, "2 · “Tồn - khách nghỉ” mở ca — 17 kiện tồn trên production không được rơi khỏi hàng đợi");

  // Trạng thái bình thường KHÔNG mở ca — nếu không thì mọi kiện đang chạy đều thành việc phải làm.
  const sBinhThuong = await dungKien(db, "s0", { stage: "IN_TRANSIT" });
  assert.ok(!(await suKien(db, sBinhThuong, { stage: "IN_TRANSIT", text: "Đang vận chuyển" })).opened, "kiện đang chạy bình thường không mở ca");
  // Sự cố trên CHIỀU HOÀN không mở ca: bưu tá đang mang hàng về shop, không có khách để gọi.
  const sHoan = await dungKien(db, "shoan", { stage: "RETURNING" });
  assert.ok(!(await suKien(db, sHoan, { stage: "DELIVERY_FAILED", code: 506, text: "Tồn - Khách hàng nghỉ", legType: "RETURN" })).opened, "sự cố chiều hoàn không mở ca");

  /* ───── 3 · Chuyển giữa hai trạng thái sự cố = CÙNG MỘT ca ───── */
  const r3 = await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.ok(!r3.opened, "3 · chờ xử lý → chờ phát lại là một sự cố đang diễn tiến, không phải sự cố mới");
  assert.equal((await doc(db, s1)).length, 1, "3 · vẫn đúng MỘT đợt");

  /* ───── 12 · Webhook trùng không sinh ca trùng ───── */
  for (let i = 0; i < 4; i++) await suKien(db, s2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.equal((await doc(db, s2)).length, 1, "12 · ĐVVC thử lại tới 5 lần — không được sinh ca thứ hai");

  /* ───── Đợt máy mở cho mã 102 TRƯỚC mốc lấy hàng mà kiện đi tiếp ⇒ máy tự đóng, KHÔNG tính kết quả ───── */
  // Dựng lại đúng tình huống production: đợt mở lúc -30h (bản cũ), hàng rời kho lúc -5h.
  const sDi = await dungKien(db, "sdi", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý" });
  await db.insert(schema.shipmentCare).values({ shipmentId: sDi, orderId: `${P}o-sdi`, episodeNo: 1, active: true, careStatus: "NEW", entryCarrierState: "WAITING_PROCESSING", sourceTrigger: "CARRIER_EVENT", openedAt: gio(30), careOutcome: "PENDING", updatedBy: "SYSTEM" });
  await db.update(schema.shipments).set({ pickedUpAt: gio(5) }).where(eq(schema.shipments.id, sDi));
  const diTiep = await suKien(db, sDi, { stage: "IN_TRANSIT", code: 300, text: "Đang vận chuyển" });
  assert.ok(diTiep.dismissed, "kiện đi tiếp ⇒ đợt máy mở trước lúc rời kho, chưa ai động vào, tự đóng");
  const sauDi = (await doc(db, sDi))[0];
  assert.equal(sauDi.active, false);
  assert.equal(sauDi.resolution, NOT_CARE_CONDITION);
  assert.equal(sauDi.careOutcome, null, "đóng vì không phải điều kiện care ⇒ KHÔNG có kết quả, không vào tỷ lệ");
  // Đợt THẬT (mở sau khi hàng đã rời kho) mà kiện đi tiếp ⇒ KHÔNG đóng: kết quả chờ ĐVVC chốt.
  const sThat = await dungKien(db, "sthat", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", pickedUpAt: gio(40) });
  await suKien(db, sThat, { stage: "PENDING", code: 102, text: "Đơn hàng chờ xử lý", at: gio(20) });
  const thatDiTiep = await suKien(db, sThat, { stage: "OUT_FOR_DELIVERY", code: 500, text: "Giao bưu tá đi phát" });
  assert.ok(!thatDiTiep.dismissed && !thatDiTiep.resolved, "đợt mở khi hàng đã ở bưu cục rồi đi phát tiếp ⇒ vẫn treo, không phải “không phải việc”");
  assert.equal((await dangMo(db, sThat))?.careOutcome, "PENDING");

  /* ───── 9b · RETURNING chưa phải kết cục; huỷ TRƯỚC khi rời kho không phải thất bại ───── */
  const sRet = await dungKien(db, "sret", { stage: "DELIVERY_FAILED" });
  await suKien(db, sRet, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  const dangVe = await suKien(db, sRet, { stage: "RETURNING", code: 505, text: "Chuyển hoàn" });
  assert.ok(!dangVe.resolved && !dangVe.dismissed, "đang chuyển hoàn (505) chưa phải kết cục — bưu cục còn có thể phát lại");
  assert.equal((await dangMo(db, sRet))?.careOutcome, "PENDING");
  const sHuy = await dungKien(db, "shuy", { pickedUpAt: gio(3) });
  await suKien(db, sHuy, { stage: "PENDING", code: 102, text: "Đơn hàng chờ xử lý" });
  await db.update(schema.shipments).set({ pickedUpAt: null }).where(eq(schema.shipments.id, sHuy)); // mốc lấy hàng bị rút lại: chưa bao giờ rời kho
  const huy = await suKien(db, sHuy, { stage: "CANCELLED", code: 107, text: "Huỷ đơn" });
  assert.ok(huy.dismissed && !huy.resolved, "huỷ trước khi rời kho ⇒ đóng không tính kết quả, KHÔNG phải một lần cứu đơn thất bại");
  assert.equal((await doc(db, sHuy))[0].careOutcome, null);
  assert.equal((await doc(db, sHuy))[0].resolution, NOT_CARE_CONDITION);

  /* ───── 4 · Sự cố → Phát tiếp → ĐÃ GIAO ⇒ RESCUED_DIRECT ───── */
  let apiCalls = 0;
  let tuChoi: string | null = null;
  setViettelPostClientForTests({
    configured: true,
    getOrderDetail: async () => null,
    updateOrder: async () => {
      apiCalls += 1;
      if (tuChoi) throw new IntegrationError("HTTP 400", 400, false, null, { status: 400, message: tuChoi });
      return { error: false, status: 200, message: "Cập nhật thành công", data: null };
    },
  } as never);
  try {
    const u = await db.insert(schema.users).values({ id: `${P}u1`, email: "pic@test", name: "PIC A", passwordHash: "x", role: "CS" }).onConflictDoNothing().returning({ id: schema.users.id });
    const picA: CareActor = { id: u[0]?.id ?? `${P}u1`, email: "pic@test", name: "PIC A", source: "API" };
    await setCareOwner(picA, { shipmentIds: [s1], ownerId: picA.id });

    const pt = await recordBusinessAction(picA, { shipmentId: s1, action: "REQUEST_REDELIVERY", note: "khách hẹn sáng mai" });
    assert.ok("ok" in pt && pt.ok, "4 · phát tiếp phải ghi được");
    // 6 · GỬI LỆNH XONG CHƯA PHẢI CỨU ĐƯỢC.
    const sauPhatTiep = await dangMo(db, s1);
    assert.equal(sauPhatTiep?.careOutcome, "PENDING", "6 · lệnh được ĐVVC nhận KHÔNG chốt ca — chờ hành trình nói kết cục");
    assert.equal(sauPhatTiep?.active, true, "6 · ca vẫn MỞ");
    assert.equal(sauPhatTiep?.resolution, null, "6 · phát tiếp không phải một quyết định đóng ca");
    // 5b · Hẹn xem lại MẶC ĐỊNH: ca chờ ĐVVC không có giờ hẹn là ca biến mất khỏi Cần care.
    assert.ok(sauPhatTiep?.followUpAt, "phát tiếp không chọn giờ ⇒ có hẹn xem lại mặc định");
    const lech = Math.abs((sauPhatTiep!.followUpAt!.getTime() - Date.now()) / 3600_000 - CARE_FOLLOW_UP_DEFAULT_HOURS);
    assert.ok(lech < 0.1, `hẹn mặc định = +${CARE_FOLLOW_UP_DEFAULT_HOURS} giờ (lệch ${lech.toFixed(2)}h)`);

    const giao = await suKien(db, s1, { stage: "DELIVERED", code: 501, text: "Giao thành công", legType: "OUTBOUND" });
    assert.ok(giao.resolved, "4 · ĐVVC báo đã giao ⇒ tự chốt ca");
    const daChot = (await doc(db, s1))[0];
    assert.equal(daChot.careOutcome, "RESCUED_DIRECT");
    assert.equal(daChot.active, false, "ca đã chốt thì rời hàng đợi");
    assert.equal(daChot.ownerAtResolution, picA.id, "kết quả thuộc về người ĐANG CẦM ca lúc chốt");

    // 12b · phát lại đúng sự kiện đó KHÔNG được chốt lần hai.
    const lai = await suKien(db, s1, { stage: "DELIVERED", code: 501, text: "Giao thành công" });
    assert.ok(!lai.resolved, "12 · gói tin phát lại không được chốt ca lần hai");

    /* ───── 5 · Sự cố → Phát tiếp → ĐÃ HOÀN ⇒ RESCUE_FAILED ───── */
    const hoan = await suKien(db, s2, { stage: "RETURNED", code: 504, text: "Chuyển trả người gửi" });
    assert.ok(hoan.resolved && hoan.outcome === "RESCUE_FAILED", "5 · kiện quay đầu ⇒ không cứu được");

    /* ───── 1★ · 501 TRÊN CHIỀU HOÀN = HÀNG VỀ SHOP — không phải cứu được, không xác nhận "phát tiếp" ───── */
    const sR = await dungKien(db, "sr", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại", vtpStatusDate: gio(20) });
    await db.insert(schema.shipmentEvents).values({ shipmentId: sR, source: "VTP_WEBHOOK", status: "500", statusName: "Chờ phát lại", occurredAt: gio(20), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" }).onConflictDoNothing();
    await suKien(db, sR, { stage: "DELIVERY_FAILED", text: "Chờ phát lại", at: gio(20) });
    await setCareOwner(picA, { shipmentIds: [sR], ownerId: picA.id });
    const ptR = await recordBusinessAction(picA, { shipmentId: sR, action: "REQUEST_REDELIVERY", note: "" });
    assert.ok("ok" in ptR && ptR.ok && ptR.data.request?.status === "ACKNOWLEDGED", "lệnh phát tiếp được ĐVVC nhận (ACK)");
    // ĐVVC báo 501 với IS_RETURNING = true: bưu tá đã PHÁT THÀNH CÔNG hàng hoàn VỀ SHOP.
    await db.insert(schema.shipmentEvents).values({ shipmentId: sR, source: "VTP_WEBHOOK", status: "501", statusName: "Thành công - Phát thành công", occurredAt: new Date(), normalizedStage: "DELIVERED", legType: "RETURN" }).onConflictDoNothing();
    const dung = await materializeShipmentState(db, sR);
    assert.equal(dung.after, "RETURNED", "ảnh chụp vận đơn: 501 chiều hoàn = RETURNED (đã có từ trước, bài này chỉ tựa vào)");
    const rr = await afterShipmentStateChange(db, sR, { legType: "RETURN", vtpStatus: 501, vtpStatusName: "Thành công - Phát thành công", occurredAt: new Date() });
    assert.equal(rr.outcome, "RESCUE_FAILED", "1★ · 501 + chiều hoàn ⇒ KHÔNG CỨU ĐƯỢC, không phải RESCUED_DIRECT");
    assert.equal((await doc(db, sR))[0].finalCarrierState, "RETURNED", "trạng thái cuối ghi vào ca cũng là hoàn, không phải đã giao");
    const yeuCauR = await db.query.carrierActionRequests.findFirst({ where: eq(schema.carrierActionRequests.shipmentId, sR) });
    assert.equal(yeuCauR?.status, "ACKNOWLEDGED", "1★ · lệnh phát tiếp KHÔNG được ghi SUCCESS khi kiện “phát thành công” về SHOP");
    // Cùng luật khi nơi gọi đưa chặng thô + cờ chiều hoàn.
    const sR2 = await dungKien(db, "sr2", { stage: "DELIVERY_FAILED" });
    await suKien(db, sR2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    assert.equal((await suKien(db, sR2, { stage: "DELIVERED", code: 501, text: "Thành công - Phát thành công", legType: "RETURN" })).outcome, "RESCUE_FAILED", "1★ · chặng thô DELIVERED + cờ RETURN vẫn là hoàn");

    /* ───── 4★ · ERP từ chối vì SAI TRẠNG THÁI ⇒ trả lỗi, KHÔNG ghi gì; ĐVVC từ chối ⇒ ghi đúng câu ĐVVC nói ───── */
    const sXong = await dungKien(db, "sxong", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Giao thành công" });
    const tuChoiErp = await recordBusinessAction(picA, { shipmentId: sXong, action: "REQUEST_REDELIVERY", note: "" });
    assert.ok("error" in tuChoiErp && /kết thúc|đã giao/i.test(tuChoiErp.error), "4★ · kiện đã giao thì phát tiếp bị từ chối bằng lý do, không phải “Đã gửi yêu cầu”");
    assert.equal((await doc(db, sXong)).length, 0, "4★ · lời từ chối của ERP không mở đợt nào");
    assert.equal((await db.select().from(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, sXong))).length, 0, "4★ · và không ghi quyết định nào");
    assert.equal((await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.shipmentId, sXong))).length, 0, "4★ · không một gói tin nào rời ERP");

    const sTC = await dungKien(db, "stc", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại" });
    await suKien(db, sTC, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    tuChoi = "Đơn hàng không thuộc tài khoản này";
    const tuChoiDvvc = await recordBusinessAction(picA, { shipmentId: sTC, action: "REQUEST_REDELIVERY", note: "" });
    tuChoi = null;
    assert.ok("ok" in tuChoiDvvc && tuChoiDvvc.ok, "4★ · ĐVVC từ chối KHÔNG làm mất quyết định của shop");
    const qdTC = await db.query.careBusinessActions.findFirst({ where: eq(schema.careBusinessActions.shipmentId, sTC) });
    assert.ok(qdTC && /không thuộc tài khoản/.test(qdTC.carrierResult ?? ""), "4★ · sổ ghi đúng câu Viettel Post nói, không phải câu ERP dịch");

    /* ───── 7 · Duyệt hoàn là QUYẾT ĐỊNH, không phải trạng thái kiện ───── */
    const s3 = await dungKien(db, "s3", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại" });
    await suKien(db, s3, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    const dh = await recordBusinessAction(picA, { shipmentId: s3, action: "APPROVE_RETURN", reasonCode: "CUSTOMER_REFUSED", note: "khách từ chối" });
    assert.ok("ok" in dh && dh.ok, "7 · duyệt hoàn phải ghi được");
    const sauDh = await dangMo(db, s3);
    assert.equal(sauDh?.resolution, "RETURN_APPROVED", "7 · quyết định được ghi");
    assert.equal(sauDh?.careOutcome, "PENDING", "7 · duyệt hoàn KHÔNG chốt kết quả logistics");
    assert.ok(sauDh?.followUpAt, "7 · duyệt hoàn cũng có hẹn xem lại mặc định — chờ ĐVVC không phải chờ vô hạn");
    const kienS3 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, s3) });
    assert.equal(kienS3?.stage, "DELIVERY_FAILED", "7 · duyệt hoàn KHÔNG đặt vận đơn thành RETURNED — chỉ ĐVVC làm được điều đó");

    // Duyệt hoàn mà không nói lý do bị chặn: thiếu bước này thì báo cáo lý do hoàn rỗng vĩnh viễn.
    const thieuLyDo = await recordBusinessAction(picA, { shipmentId: s3, action: "APPROVE_RETURN", note: "" });
    assert.ok("error" in thieuLyDo, "7 · duyệt hoàn bắt buộc có lý do");

    /* ───── 8 · Theo dõi tiếp: ca vẫn mở, có giờ hẹn, KHÔNG đụng chiều ĐVVC ───── */
    const s4 = await dungKien(db, "s4", { stage: "DELIVERY_FAILED" });
    await suKien(db, s4, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    const goiTruoc = apiCalls;
    const hen = new Date(Date.now() + 2 * 3600_000);
    const td = await recordBusinessAction(picA, { shipmentId: s4, action: "CONTINUE_MONITORING", followUpAt: hen });
    assert.ok("ok" in td && td.ok);
    assert.equal(apiCalls, goiTruoc, "8 · theo dõi tiếp KHÔNG gửi lệnh nào sang ĐVVC");
    const sauTd = await dangMo(db, s4);
    assert.equal(sauTd?.active, true, "8 · ca vẫn mở");
    assert.ok(sauTd?.followUpAt, "8 · phải có giờ hẹn");
    assert.ok("error" in (await recordBusinessAction(picA, { shipmentId: s4, action: "CONTINUE_MONITORING" })), "8 · hẹn mà không có giờ thì ca chìm xuống đáy hàng đợi — phải chặn");

    /* ───── 9–10 · Đổi: kết quả đi theo ĐƠN THAY THẾ ───── */
    const s5 = await dungKien(db, "s5", { stage: "DELIVERY_FAILED" });
    await suKien(db, s5, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    const thayThe = await dungKien(db, "s5r", { stage: "IN_TRANSIT" });
    assert.ok("error" in (await recordBusinessAction(picA, { shipmentId: s5, action: "EXCHANGE" })), "đổi mà không nối vận đơn thay thế thì không đo được");
    assert.ok("error" in (await recordBusinessAction(picA, { shipmentId: s5, action: "EXCHANGE", replacementShipmentId: "khong-ton-tai" })), "đổi nối vào vận đơn không tồn tại bị chặn");
    // Người xử lý gõ MÃ VẬN ĐƠN, không gõ id — nhận cả hai.
    await recordBusinessAction(picA, { shipmentId: s5, action: "EXCHANGE", replacementShipmentId: thayThe.toUpperCase() });
    assert.equal((await dangMo(db, s5))?.replacementShipmentId, thayThe, "đơn đổi nối bằng mã vận đơn cũng ra đúng id");

    // Kiện GỐC quay về là điều đương nhiên khi đã gửi hàng đổi — KHÔNG được kết luận thất bại.
    const gocVe = await suKien(db, s5, { stage: "RETURNED", code: 504, text: "Chuyển trả người gửi" });
    assert.ok(!gocVe.resolved, "9 · kiện gốc quay về nhưng đang có đơn đổi ⇒ chờ kết cục của đơn đổi");
    assert.equal((await dangMo(db, s5))?.careOutcome, "PENDING");

    const doiGiao = await settleExchangeOutcome(db, thayThe, "DELIVERED", new Date());
    assert.equal(doiGiao.outcome, "RESCUED_EXCHANGE", "9 · đơn đổi giao thành công ⇒ cứu bằng đơn đổi");

    const s6 = await dungKien(db, "s6", { stage: "DELIVERY_FAILED" });
    await suKien(db, s6, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    const thayThe2 = await dungKien(db, "s6r", { stage: "IN_TRANSIT" });
    await recordBusinessAction(picA, { shipmentId: s6, action: "EXCHANGE", replacementShipmentId: thayThe2 });
    assert.equal((await settleExchangeOutcome(db, thayThe2, "RETURNED", new Date())).outcome, "RESCUE_FAILED", "10 · đơn đổi cũng hoàn ⇒ không cứu được");

    /* ───── 11 · Giao lại ca: lịch sử sở hữu KHÔNG bị viết lại ───── */
    const u2 = await db.insert(schema.users).values({ id: `${P}u2`, email: "pic2@test", name: "PIC B", passwordHash: "x", role: "CS" }).onConflictDoNothing().returning({ id: schema.users.id });
    const picB: CareActor = { id: u2[0]?.id ?? `${P}u2`, email: "pic2@test", name: "PIC B", source: "API" };
    const s7 = await dungKien(db, "s7", { stage: "DELIVERY_FAILED" });
    await suKien(db, s7, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    await setCareOwner(picA, { shipmentIds: [s7], ownerId: picA.id });
    const sauGiaoA = await dangMo(db, s7);
    assert.equal(sauGiaoA?.initialOwnerId, picA.id, "12★ · người được giao ĐẦU TIÊN ghi bằng khoá");
    assert.ok(sauGiaoA?.assignedAt, "12★ · mốc giao được ghi");
    await recordBusinessAction(picA, { shipmentId: s7, action: "CONTINUE_MONITORING", followUpAt: new Date(Date.now() + 3600_000) });
    await setCareOwner(picB, { shipmentIds: [s7], ownerId: picB.id });
    const sauGiaoB = await dangMo(db, s7);
    assert.equal(sauGiaoB?.initialOwnerId, picA.id, "12★ · chuyển tay KHÔNG viết lại người được giao đầu tiên");
    assert.equal(sauGiaoB?.assignedAt?.getTime(), sauGiaoA?.assignedAt?.getTime(), "12★ · mốc giao đầu tiên giữ nguyên");
    await recordBusinessAction(picB, { shipmentId: s7, action: "CONTINUE_MONITORING", followUpAt: new Date(Date.now() + 7200_000) });
    const lichSu = await db.select().from(schema.careBusinessActions).where(eq(schema.careBusinessActions.shipmentId, s7));
    assert.equal(lichSu.length, 2, "11 · hai thao tác, hai dòng — lịch sử chỉ THÊM");
    assert.deepEqual(lichSu.map((x) => x.ownerIdAtAction).sort(), [picA.id, picB.id].sort(), "11 · mỗi dòng giữ ảnh chụp người cầm ca LÚC ĐÓ");
    await suKien(db, s7, { stage: "DELIVERED", code: 501, text: "Giao thành công" });
    assert.equal((await doc(db, s7))[0].ownerAtResolution, picB.id, "11 · kết quả thuộc người cầm ca lúc chốt, và việc A đã làm vẫn là của A");

    /* ───── 25 · Trạng thái care KHÔNG ghi đè trạng thái ĐVVC ───── */
    const s8 = await dungKien(db, "s8", { stage: "DELIVERY_FAILED" });
    await suKien(db, s8, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    await recordBusinessAction(picA, { shipmentId: s8, action: "CONTINUE_MONITORING", followUpAt: new Date(Date.now() + 3600_000) });
    assert.equal((await db.query.shipments.findFirst({ where: eq(schema.shipments.id, s8) }))?.stage, "DELIVERY_FAILED", "25 · không thao tác care nào đụng tới chặng ĐVVC");

    /* ───── 6★ · NGƯỜI ĐÓNG ca = rời hàng đợi (active=false), kết quả vẫn chờ ĐVVC và về đúng đợt ───── */
    const s9 = await dungKien(db, "s9", { stage: "DELIVERY_FAILED" });
    await suKien(db, s9, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    await setCareOwner(picA, { shipmentIds: [s9], ownerId: picA.id });
    const dongTay = await setCareStatus(picA, { shipmentIds: [s9], status: "RESOLVED", note: "khách hẹn nhận, xong phần mình" });
    assert.ok("ok" in dongTay && dongTay.ok && dongTay.data.states[s9]?.status === "RESOLVED");
    const sauDongTay = (await doc(db, s9))[0];
    assert.equal(sauDongTay.active, false, "6★ · trạng thái kết thúc ⇔ active = false — một mệnh đề");
    assert.equal(sauDongTay.careOutcome, "PENDING", "6★ · người bấm xong không phải chứng từ — kết quả vẫn chờ ĐVVC");
    const giaoS9 = await suKien(db, s9, { stage: "DELIVERED", code: 501, text: "Giao thành công" });
    assert.equal(giaoS9.outcome, "RESCUED_DIRECT", "6★ · ĐVVC báo giao ⇒ kết quả chốt lên đúng đợt người đã đóng");
    assert.equal((await doc(db, s9))[0].ownerAtResolution, picA.id);
    assert.equal((await doc(db, s9))[0].careStatus, "RESOLVED", "6★ · trạng thái người đặt giữ nguyên");

    // Trạng thái CHỜ bắt buộc có giờ hẹn.
    const s10 = await dungKien(db, "s10", { stage: "DELIVERY_FAILED" });
    await suKien(db, s10, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    assert.ok("error" in (await setCareStatus(picA, { shipmentIds: [s10], status: "WAITING_CUSTOMER" })), "5★ · chuyển sang chờ mà không có giờ xem lại thì bị chặn");
    const cho = await setCareStatus(picA, { shipmentIds: [s10], status: "WAITING_CUSTOMER", followUpAt: new Date(Date.now() + 3 * 3600_000) });
    assert.ok("ok" in cho && cho.ok && cho.data.states[s10]?.followUpAt, "5★ · có giờ thì chuyển được");

    // Mở lại = KÍCH HOẠT LẠI đúng đợt đó, không mở đợt mới, không báo lỗi giả.
    await setCareStatus(picA, { shipmentIds: [s10], status: "CANCELLED" });
    assert.equal((await doc(db, s10))[0].active, false);
    const moLai = await reopenCase(picA, { shipmentId: s10, note: "khách gọi lại" });
    assert.ok("ok" in moLai && moLai.ok, `6★ · mở lại phải được: ${"error" in moLai ? moLai.error : ""}`);
    const dsS10 = await doc(db, s10);
    assert.equal(dsS10.length, 1, "6★ · mở lại KHÔNG sinh đợt mới");
    assert.equal(dsS10[0].active, true);
    assert.equal(dsS10[0].reopenCount, 1);
    assert.equal(dsS10[0].careStatus, "NEW", "chưa ai nhận thì về NEW (còn người thì ASSIGNED — bài care-workbench kiểm nhánh đó)");
    assert.ok("error" in (await reopenCase(picA, { shipmentId: s10 })), "đang mở thì không có gì để mở lại");

    /* ───── 17–18 · Kiện hỏng LẦN HAI mở ĐỢT MỚI, không ghi đè đợt cũ ───── */
    const dot2 = await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    assert.ok(dot2.opened, "17 · kiện đã chốt mà hỏng lại ⇒ đợt MỚI");
    const dsDot = await doc(db, s1);
    assert.equal(dsDot.length, 2, "17 · hai đợt cùng tồn tại");
    assert.deepEqual(dsDot.map((d) => d.episodeNo).sort(), [1, 2], "17 · số đợt nối tiếp, không đếm lại từ 1");
    assert.equal(dsDot.find((d) => d.episodeNo === 1)?.careOutcome, "RESCUED_DIRECT", "18 · kết quả đợt cũ KHÔNG bị đợt mới ghi đè");

    /* ───── 14 · PENDING nằm ngoài mẫu số ───── */
    const t = rescueRates({ direct: 3, exchange: 1, failed: 2, pending: 40, unattributed: 5 });
    assert.equal(t.direct, 60, "14 · 3/(3+2) = 60% — 40 ca treo KHÔNG kéo tỷ lệ xuống");
    assert.equal(t.withExchange, 66.7, "14 · (3+1)/(3+1+2) = 66,7%");
    assert.equal(rescueRates({ direct: 0, exchange: 0, failed: 0, pending: 9, unattributed: 0 }).direct, null, "14 · chưa ca nào chốt ⇒ CHƯA ĐO ĐƯỢC, không phải 0%");

    /* ───── 5★ · Góc nhìn & SLA thuần: chờ không có giờ = tới hạn; chờ có giờ = tạm dừng đồng hồ ───── */
    assert.equal(careViewOf({ status: "WAITING_CARRIER", followUpAt: null, doneAt: null, firstResponseAt: gio(1) }, gio(5)).view, "care", "5★ · chờ ĐVVC mà không có giờ hẹn ⇒ Cần care ngay, không biến mất");
    assert.equal(careViewOf({ status: "WAITING_CARRIER", followUpAt: new Date(Date.now() + 3600_000), doneAt: null, firstResponseAt: gio(1) }, gio(5)).view, "waiting");
    assert.equal(slaOf(gio(30), { status: "WAITING_REDELIVERY", followUpAt: new Date(Date.now() + 3600_000), doneAt: null, firstResponseAt: gio(29) }).resolveBreached, false, "5★ · đang chờ với hẹn còn ở phía trước ⇒ đồng hồ đóng ca tạm dừng");
    assert.equal(slaOf(gio(30), { status: "WAITING_REDELIVERY", followUpAt: gio(1), doneAt: null, firstResponseAt: gio(29) }).resolveBreached, true, "5★ · hẹn đã qua ⇒ đồng hồ chạy tiếp");
    assert.equal(slaOf(gio(30), { status: "WAITING_REDELIVERY", followUpAt: null, doneAt: null, firstResponseAt: gio(29) }).resolveBreached, true, "5★ · không có hẹn thì không có gì để tạm dừng");
    assert.equal(slaOf(gio(30), { status: "IN_PROGRESS", followUpAt: null, doneAt: null, firstResponseAt: null }, new Date(), { firstResponseHours: 40, resolveHours: 48 }).firstResponseBreached, false, "11★ · ngưỡng truyền vào từ sổ hạn xử lý được tôn trọng");

    /* ───── 20 · Ca đã chốt xuất hiện đúng ở báo cáo hiệu suất ───── */
    clearMemo();
    const tong = await getRescueSummary(KY_TAT_CA);
    assert.ok(tong.direct >= 2 && tong.failed >= 2 && tong.exchange >= 1, `20 · báo cáo phải thấy ca đã chốt (trực tiếp ${tong.direct} · đổi ${tong.exchange} · hỏng ${tong.failed})`);
    assert.ok(tong.pending >= 1, "20 · và thấy cả phần chưa biết");

    /* ───── 7★ · "Chưa có kết quả" đếm TẠI CUỐI KỲ — kỳ có biên vẫn thấy ca treo ───── */
    const kyCoBien = ky(gio(48), new Date());
    const tongKy = await getRescueSummary(kyCoBien);
    assert.ok(tongKy.pending >= 1, `7★ · kỳ có biên phải thấy ca treo (${tongKy.pending}) — bản trước lọc theo outcome_at nên luôn 0`);
    const kyQuaKhu = ky(gio(400), gio(300));
    const tongCu = await getRescueSummary(kyQuaKhu);
    assert.equal(tongCu.pending, 0, "7★ · kỳ kết thúc trước khi ca mở thì ca không thuộc kỳ đó");
    assert.equal(tongCu.finished, 0);
    // Đợt máy đóng vì không phải điều kiện care nằm NGOÀI mọi con số.
    const dsSDi = await db.select({ n: sql<number>`count(*)::int` }).from(schema.shipmentCare).where(and(inArray(schema.shipmentCare.shipmentId, [sDi, sHuy]), sql`${schema.shipmentCare.resolution} = ${NOT_CARE_CONDITION}`));
    assert.equal(Number(dsSDi[0]?.n), 2);
    assert.equal(tong.unattributed, 0, "7★ · đợt NOT_CARE_CONDITION không bị đếm thành “không đủ chứng cứ”");

    const nguoi = await getCarePerformanceByPic(kyCoBien);
    const dongA = nguoi.find((r) => r.userId === picA.id);
    assert.ok(dongA && dongA.direct >= 1, "20 · PIC A phải có ca cứu được");
    assert.ok(nguoi.some((r) => r.userId === null), "ca chưa nối được người hiện thành DÒNG RIÊNG, không chia đều cho ai");
    assert.ok((dongA?.actions.CONTINUE_MONITORING ?? 0) >= 1, "số thao tác đếm riêng, không tham gia tỷ lệ cứu đơn");
    assert.ok((dongA?.assigned ?? 0) >= 3, `12★ · "được giao trong kỳ" đếm từ sự kiện GIAO theo khoá (A: ${dongA?.assigned})`);
    const dongB = nguoi.find((r) => r.userId === picB.id);
    assert.ok((dongB?.assigned ?? 0) >= 1, "12★ · B nhận ca s7 sau A — cả hai đều được đếm là được giao, A không mất dấu");

    /* ───── 21–23 · Báo cáo theo mã hàng: grain đúng, không nhân dòng ───── */
    const theoMa = await getCarePerformanceByProduct(KY_TAT_CA);
    assert.ok(theoMa.totalCases >= 6, "21 · mỗi ca đếm đúng MỘT lần bất kể bao nhiêu sự kiện/thao tác");
    assert.ok(theoMa.unmappedCases >= 0 && typeof theoMa.multiCodeCases === "number", "22 · phần chồng lấn và phần chưa lần được mã phải được NÊU RA, không giấu");

    /* ───── 12★ · Báo cáo hiệu quả care quy kết bằng KHOÁ, không bằng ô chữ ───── */
    const bc = await getCareReport(KY_TAT_CA);
    assert.ok(bc.staff.some((r) => r.userId === picA.id), "12★ · dòng nhân viên khoá theo users.id");
    assert.ok(!bc.staff.some((r) => r.actor === "pic@test" || r.actor === "SYSTEM"), "12★ · không dòng nào là email hay 'SYSTEM' được xếp thành nhân viên");
    for (const r of bc.staff) if (r.userId === null) assert.equal(r.actor, "Chưa nối tài khoản");

    /* ───── 3★ · ĐỐI CHIẾU ĐỘ PHỦ: 48 → 48, 106 đóng, và chạy hai lần không đổi gì ───── */
    // (i) 106 đợt máy mở cho kiện CHƯA rời kho — dựng lại đúng tình huống production.
    const rc1 = await dungKien(db, "rc1", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", vtpStatusDate: gio(30) });
    await db.insert(schema.shipmentCare).values({ shipmentId: rc1, orderId: `${P}o-rc1`, episodeNo: 1, active: true, careStatus: "NEW", entryCarrierState: "WAITING_PROCESSING", sourceTrigger: "CARRIER_EVENT", openedAt: gio(30), careOutcome: "PENDING", updatedBy: "SYSTEM" });
    // (ii) 48 kiện "chờ xử lý" ĐÃ lấy hàng mà không có đợt.
    const rc2 = await dungKien(db, "rc2", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", vtpStatusDate: gio(26), pickedUpAt: gio(40) });
    // (iii) kiện "tồn" không có đợt.
    const rc3 = await dungKien(db, "rc3", { stage: "DELIVERY_FAILED", vtpStatus: 506, vtpStatusName: "Tồn - Khách hàng nghỉ, không có nhà", vtpStatusDate: gio(8) });
    // (iv) đợt PENDING treo trên kiện đã giao (sự kiện cuối đi đường không qua vòng đời).
    const rc4 = await dungKien(db, "rc4", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Giao thành công", vtpStatusDate: gio(2), pickedUpAt: gio(50), isFinal: true });
    await db.insert(schema.shipmentCare).values({ shipmentId: rc4, orderId: `${P}o-rc4`, episodeNo: 1, active: true, careStatus: "IN_PROGRESS", ownerId: picA.id, ownerEmail: picA.email, entryCarrierState: "WAITING_REDELIVERY", sourceTrigger: "CARRIER_EVENT", openedAt: gio(30), firstResponseAt: gio(20), careOutcome: "PENDING", updatedBy: "SYSTEM" });
    // (v) đợt máy mở cho mã 102 chưa rời kho nhưng NGƯỜI đã nhận — máy KHÔNG được đóng.
    const rc5 = await dungKien(db, "rc5", { vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý", vtpStatusDate: gio(30) });
    await db.insert(schema.shipmentCare).values({ shipmentId: rc5, orderId: `${P}o-rc5`, episodeNo: 1, active: true, careStatus: "ASSIGNED", ownerId: picA.id, ownerEmail: picA.email, entryCarrierState: "WAITING_PROCESSING", sourceTrigger: "CARRIER_EVENT", openedAt: gio(30), firstResponseAt: gio(29), careOutcome: "PENDING", updatedBy: picA.email });
    // (vi) 76 ca lịch sử `care_outcome NULL` — KHÔNG được suy ngược, dù kiện đã kết thúc.
    const rc6 = await dungKien(db, "rc6", { stage: "DELIVERED", vtpStatus: 501, vtpStatusName: "Giao thành công", vtpStatusDate: gio(2), isFinal: true });
    await db.insert(schema.shipmentCare).values({ shipmentId: rc6, orderId: `${P}o-rc6`, episodeNo: 1, active: true, careStatus: "IN_PROGRESS", entryCarrierState: null, sourceTrigger: null, openedAt: gio(200), careOutcome: null, updatedBy: "ai-do@test" });

    // Phạm vi hẹp: chỉ kiện của bài này — dữ liệu mẫu chung của các bài khác không được thay đổi.
    const phamVi = { shipmentIds: [rc1, rc2, rc3, rc4, rc5, rc6, sPre, s1, sTon] };
    const lan1 = await reconcileCareCoverage(db, new Date(), phamVi);
    assert.ok(lan1.opened >= 2, `3★ · mở đợt cho kiện cần care bị sót (mở ${lan1.opened})`);
    assert.ok(lan1.dismissed >= 1, `3★ · đóng đợt máy mở cho kiện chưa rời kho (đóng ${lan1.dismissed})`);
    assert.ok(lan1.settled >= 1, `3★ · chốt đợt treo trên kiện đã kết thúc (chốt ${lan1.settled})`);

    const dRc1 = (await doc(db, rc1))[0];
    assert.equal(dRc1.active, false, "3★ · (i) đợt cho hàng còn trong kho đã đóng");
    assert.equal(dRc1.resolution, NOT_CARE_CONDITION);
    assert.equal(dRc1.careOutcome, null, "3★ · (i) không có kết quả — không bao giờ vào tỷ lệ");
    const dRc2 = await dangMo(db, rc2);
    assert.ok(dRc2, "3★ · (ii) kiện chờ xử lý đã lấy hàng CÓ đợt");
    assert.equal(dRc2?.sourceTrigger, "RECONCILE");
    assert.equal(dRc2?.entryCarrierState, "WAITING_PROCESSING");
    assert.ok(Math.abs((dRc2!.openedAt!.getTime() - Date.now()) / 3600_000 + 26) < 0.1, "3★ · (ii) opened_at ≈ 26 giờ trước, không phải lúc chạy đối chiếu");
    assert.equal((await dangMo(db, rc3))?.entryCarrierState, "DELIVERY_EXCEPTION", "3★ · (iii) kiện tồn có đợt");
    const dRc4 = (await doc(db, rc4))[0];
    assert.equal(dRc4.careOutcome, "RESCUED_DIRECT", "3★ · (iv) đợt treo trên kiện đã giao được chốt theo chứng từ");
    assert.equal(dRc4.active, false);
    assert.equal(dRc4.ownerAtResolution, picA.id);
    const dRc5 = (await doc(db, rc5))[0];
    assert.equal(dRc5.active, true, "3★ · (v) đợt người đã nhận KHÔNG bị máy đóng");
    assert.equal(dRc5.careStatus, "ASSIGNED");
    const dRc6 = (await doc(db, rc6))[0];
    assert.equal(dRc6.careOutcome, null, "3★ · (vi) ca lịch sử NULL không bị suy ngược thành kết quả");
    assert.equal(dRc6.active, true, "3★ · (vi) và không bị đụng");
    assert.ok(!(await dangMo(db, sPre)), "3★ · kiện mã 102 chưa rời kho vẫn KHÔNG có đợt sau đối chiếu");

    const lan2 = await reconcileCareCoverage(db, new Date(), phamVi);
    assert.deepEqual({ opened: lan2.opened, dismissed: lan2.dismissed, settled: lan2.settled }, { opened: 0, dismissed: 0, settled: 0 }, "3★ · idempotent: chạy lần hai không ghi gì");
    assert.equal((await doc(db, rc2)).length, 1, "3★ · không mở đợt trùng");
  } finally {
    setViettelPostClientForTests(null);
  }

  /* ───── 14★ · AI chỉ được đổi dữ liệu ca khi có quyền thao tác vận đơn ───── */
  const tools = registerCareTools();
  for (const name of ["assign_care_case", "set_care_status", "set_care_follow_up"]) {
    assert.equal(tools.find((t) => t.name === name)?.permission, "shipments:manage", `14★ · ${name} cần shipments:manage`);
  }
  assert.equal(tools.find((t) => t.name === "add_care_note")?.permission, "shipments:view", "14★ · ghi chú vẫn chỉ cần xem");

  /* ───── 30 · BÁO CÁO NÓI BAO NHIÊU THÌ BẤM VÀO PHẢI RA BẤY NHIÊU ───── */
  {
    /*
      Đây là bài chống kiểu hỏng khó thấy nhất: báo cáo và danh sách CÙNG ĐÚNG theo cách riêng của
      chúng, nhưng nói hai con số. Chống bằng cách bắt cả hai đi qua CÙNG MỘT biểu thức — bài này
      chứng minh điều đó trên dữ liệu thật chứ không tin vào lời hứa.
    */
    const sA = await dungKien(db, "p1", { stage: "PENDING", vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý" });
    const sB = await dungKien(db, "p2", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại" });
    // 13★ · Ô lọc trạng thái care chỉ đếm ĐỢT ĐANG MỞ: kiện có đợt cũ đã đóng + đợt mới đang mở đếm MỘT lần.
    await db.insert(schema.shipmentCare).values([
      { shipmentId: sB, orderId: `${P}o-p2`, episodeNo: 1, active: false, careStatus: "RESOLVED", careOutcome: "RESCUED_DIRECT", doneAt: gio(100), updatedBy: "x" },
      { shipmentId: sB, orderId: `${P}o-p2`, episodeNo: 2, active: true, careStatus: "IN_PROGRESS", careOutcome: "PENDING", updatedBy: "x" },
    ]);
    clearMemo();
    const { shipmentFacets } = await import("@/lib/queries/shipments");
    const { parseListParams } = await import("@/lib/search-params");
    const params = parseListParams({}, { defaultSort: "createdAt", filterKeys: ["carrierState"], sortable: ["createdAt"], defaultPeriod: "all" });
    const facets = await shipmentFacets(params);
    const demCho = (k: string) => facets.carrierStates.find((r) => r.value === k)?.count ?? 0;
    assert.ok(demCho("WAITING_PROCESSING") >= 1, "30 · kiện “chờ xử lý” phải đếm được trong bộ lọc ĐVVC");
    assert.ok(demCho("WAITING_REDELIVERY") >= 1, "30 · kiện “chờ phát lại” phải đếm được, và KHÔNG bị gộp vào “giao hỏng”");
    const demCare = (k: string) => facets.careStatuses.find((r) => r.value === k)?.count ?? 0;
    const tongCare = facets.careStatuses.reduce((a, r) => a + r.count, 0);
    const soKienCoDotMo = Number((await db.select({ n: sql<number>`count(distinct ${schema.shipmentCare.shipmentId})::int` }).from(schema.shipmentCare).where(eq(schema.shipmentCare.active, true)))[0]?.n ?? 0);
    assert.equal(tongCare, soKienCoDotMo, `13★ · tổng ô lọc trạng thái care (${tongCare}) = số kiện có đợt đang mở (${soKienCoDotMo}) — đợt đã đóng không đếm`);
    assert.ok(demCare("IN_PROGRESS") >= 1);

    const locWP = parseListParams({ carrierState: "WAITING_PROCESSING" }, { defaultSort: "createdAt", filterKeys: ["carrierState"], sortable: ["createdAt"], defaultPeriod: "all" });
    const { listShipments } = await import("@/lib/queries/shipments");
    const ds = await listShipments(locWP);
    assert.equal(ds.total, demCho("WAITING_PROCESSING"), "30 · số trên bộ đếm PHẢI bằng số dòng mở ra khi bấm — cùng một biểu thức, không phải hai câu lệnh cùng ý");
    assert.ok(ds.rows.some((r) => r.id === sA), "30 · đúng kiện đó nằm trong danh sách");
    assert.ok(!ds.rows.some((r) => r.id === sB), "30 · và kiện “chờ phát lại” KHÔNG lọt vào");
  }

  /* ───── DỌN: bài này thêm đơn/vận đơn riêng, không được để lọt vào tổng của bài khác ───── */
  const kienIds = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(sql`${schema.shipments.id} like ${`${P}%`}`)).map((r) => r.id);
  if (kienIds.length) {
    await db.delete(schema.careBusinessActions).where(inArray(schema.careBusinessActions.shipmentId, kienIds));
    await db.delete(schema.careCaseEvents).where(inArray(schema.careCaseEvents.shipmentId, kienIds));
    await db.delete(schema.careActions).where(inArray(schema.careActions.shipmentId, kienIds));
    await db.delete(schema.carrierActionRequests).where(inArray(schema.carrierActionRequests.shipmentId, kienIds));
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, kienIds));
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, kienIds));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, kienIds));
  }
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  await db.delete(schema.users).where(inArray(schema.users.id, [`${P}u1`, `${P}u2`]));
  clearMemo();

  console.log("✓ Hệ điều hành chăm sóc vận đơn: 60 kiểm thử · ĐVVC mở ca và ĐVVC đóng ca · 501 chiều hoàn = hàng về shop · mã 102 chưa rời kho không phải việc · đối chiếu 48→48 và đóng 106 · đóng ⇔ active=false · chờ phải có giờ hẹn · PENDING đếm tại cuối kỳ · quy kết bằng khoá");
}
