import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { applyCarrierEventToCare, reconcileCareCoverage } from "@/lib/care/lifecycle";
import {
  isRelayedReturnApproval,
  PANCAKE_RELAY_APPROVED_STATUSES,
  relayApprovedAfterProposal,
  RETURN_APPROVED_CODES,
  RETURN_APPROVED_TEXTS,
  RETURN_PROPOSED_CODES,
  returnApproved,
} from "@/lib/constants/care-return-approval";
import { VTP_STATUS } from "@/lib/constants/viettelpost";
import { mapVtpStatusText } from "@/lib/integrations/viettelpost/statement";
import { resolveVtpStatus } from "@/lib/integrations/viettelpost/status";
import { materializeShipmentState } from "@/lib/integrations/viettelpost/state";

/**
 * ═══════════ LỖI PRODUCTION 21/09/2026: VẬN ĐƠN ĐANG CHUYỂN HOÀN HIỆN LÀ "CHỜ XỬ LÝ" ═══════════
 *
 * Chủ shop mở PKE1521276709 và PKE1522238009: trên viettelpost.vn là "Đã duyệt hoàn", trên ERP là
 * "Chờ xử lý" — tức lùi về điểm xuất phát, như thể hàng còn nằm trong kho.
 *
 * ERP KHÔNG mất gói tin nào: cả hai vận đơn có đủ 24 sự kiện, gồm webhook 505 kết luận đúng là
 * `RETURNING`. Nhưng ~60–70 giây sau mỗi webhook ấy, một dòng tệp "Danh sách vận đơn" mang chữ
 * "Chờ xử lý" được ghi với mốc MỚI HƠN, và `deriveShipmentState()` xếp theo `occurred_at` nên dòng
 * tệp thắng.
 *
 * Đo trên toàn bộ dữ liệu:
 *
 *   295/295 dòng "Chờ xử lý" nhập từ tệp đều mang cờ Trả hàng = x  (không dòng nào là "chờ lấy hàng")
 *   269/295 tới SAU một webhook đã chứng minh gói hàng rời kho
 *   256     vận đơn từng mang trạng thái sai này
 *    20     vận đơn đang kẹt ở PENDING dù đã có sự kiện hoàn — 10.222.000 ₫ COD
 *
 * Bài này khoá ba việc: bộ dịch chữ, ranh giới "đề nghị hoàn" / "đã duyệt hoàn", và vòng đời ca.
 */

const P = "cra-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

async function dungKien(db: Db, id: string) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(96) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: `${P}${id}`,
      orderId: `${P}o-${id}`,
      carrier: "Viettel Post",
      vtpOrderNumber: `${P}${id}`.toUpperCase(),
      stage: "DELIVERY_FAILED",
      codAmount: 524_000,
      pickedUpAt: gio(90),
      isFinal: false,
    })
    .onConflictDoNothing();
  return `${P}${id}`;
}

async function suKien(db: Db, shipmentId: string, v: { source: string; status: string; name: string; stage: (typeof schema.shipmentEvents.$inferInsert)["normalizedStage"]; at: Date }) {
  await db
    .insert(schema.shipmentEvents)
    .values({ shipmentId, source: v.source, status: v.status, statusName: v.name, normalizedStage: v.stage, legType: "OUTBOUND", occurredAt: v.at })
    .onConflictDoNothing();
}

async function moCa(db: Db, shipmentId: string, at: Date) {
  const r = await applyCarrierEventToCare(db, {
    shipmentId,
    orderId: null,
    trackingNumber: shipmentId.toUpperCase(),
    stage: "DELIVERY_FAILED",
    vtpStatus: 506,
    vtpStatusName: "Tồn - Khách hàng nghỉ, không có nhà",
    legType: "OUTBOUND",
    occurredAt: at,
  });
  assert.ok(r.opened, "phải mở được đợt chăm sóc để bài kiểm có cái mà chốt");
  return r.careCaseId!;
}

const doc = async (db: Db, id: string) =>
  (
    await db.query.shipmentCare.findFirst({
      where: sql`${schema.shipmentCare.id} = ${id}`,
      columns: { active: true, careStatus: true, careOutcome: true, finalCarrierState: true, finalLogisticsOutcome: true, outcomeAt: true },
    })
  )!;

export async function testCareReturnApproval(db: Db) {
  /* ───── 1 · "Chờ xử lý" + cột Trả hàng = CHỜ XỬ LÝ HOÀN, không phải chờ lấy hàng ───── */
  assert.equal(mapVtpStatusText("Chờ xử lý", { returnFlag: true }).stage, "RETURNING", "dòng tệp có cờ Trả hàng: kiện đang trên đường hoàn, không phải còn trong kho");
  assert.equal(
    mapVtpStatusText("Chờ xử lý").stage,
    "UNKNOWN",
    "không có cờ thì KHÔNG kết luận: một dòng chỉ-có-chữ không chứng minh được hàng còn trong kho, và UNKNOWN để webhook giữ nguyên kết luận (luật 47)",
  );
  assert.notEqual(mapVtpStatusText("Chờ xử lý").stage, "PENDING", "đây chính là con đường đã kéo 20 vận đơn đang hoàn về điểm xuất phát");

  /* ───── 2 · Câu của ĐVVC tự nói rõ hàng chưa đi thì vẫn là PENDING ───── */
  assert.equal(mapVtpStatusText("Đơn hàng chờ xử lý").stage, "PENDING", "tên mã 102 — hàng còn trong kho, và nó chứa sẵn chuỗi “chờ xử lý” nên phải được xét TRƯỚC");
  assert.equal(mapVtpStatusText("Lấy hàng thất bại / chờ xử lý").stage, "PENDING");
  assert.equal(mapVtpStatusText("Chờ lấy hàng").stage, "PENDING");
  // Mã số vẫn thắng chữ: webhook 102 không bị bản sửa này đụng tới.
  assert.equal(resolveVtpStatus({ code: 102, text: "Đơn hàng chờ xử lý" }).stage, "PENDING");
  assert.equal(resolveVtpStatus({ code: null, text: "Chờ xử lý", returnFlag: true }).stage, "RETURNING");
  assert.equal(resolveVtpStatus({ code: null, text: "Chờ xử lý", returnFlag: true }).basis, "text");

  /* ───── 3 · "Đề nghị hoàn" và "đã duyệt hoàn" phải tách được bằng MÃ, vì chữ không tách nổi ───── */
  assert.equal(returnApproved({ code: 515 }), true, "515 “Bưu cục phát duyệt hoàn” = chữ “Đã duyệt hoàn” trên viettelpost.vn");
  assert.equal(returnApproved({ code: 502 }), true, "502 — hàng đã trên đường về");
  assert.equal(
    returnApproved({ code: 505, text: "Tồn - Thông báo chuyển hoàn bưu cục gốc" }),
    false,
    "505 MỚI LÀ ĐỀ NGHỊ: shop còn bấm được 508/550 phát tiếp. Chốt ca ở đây là giết việc đúng lúc nó còn làm được",
  );
  assert.equal(returnApproved({ code: 501 }), false);
  assert.equal(returnApproved({ code: null, text: "Đã duyệt hoàn" }), true, "dòng tệp không có mã thì chữ được dùng");
  assert.equal(returnApproved({ code: null, text: "Đơn vị yêu cầu hoàn về" }), true);
  assert.equal(returnApproved({ code: null, text: "Chờ xử lý" }), false, "chờ xử lý HOÀN vẫn là đang chờ một quyết định — chưa duyệt");
  assert.equal(returnApproved({}), false, "không mã không chữ thì không kết luận");

  /*
    TÍNH CHẤT GIỮ HAI NHÓM KHÔNG DÍNH VÀO NHAU.

    Tên của 505 và của 502 chứa cùng chuỗi con "chuyển hoàn bưu cục gốc". Nếu một câu trong danh
    sách chữ lại là chuỗi con của tên một mã "mới đề nghị", thì một dòng tệp 505 sẽ bị đọc thành
    đã duyệt và ca bị chốt sớm — âm thầm, không lỗi nào phát ra.
  */
  const bodau = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/đ/g, "d")
      .toLowerCase();
  for (const ma of RETURN_PROPOSED_CODES) {
    const ten = bodau(VTP_STATUS[ma]?.name ?? "");
    for (const k of RETURN_APPROVED_TEXTS) {
      assert.equal(ten.includes(k), false, `"${k}" là chuỗi con của tên mã ${ma} — hai nhóm đã dính vào nhau`);
    }
  }
  // Câu chữ THẬT mà production ghi cho 505, không chỉ tên trong bảng mã.
  for (const k of RETURN_APPROVED_TEXTS) {
    assert.equal(bodau("Tồn - Thông báo chuyển hoàn bưu cục gốc").includes(k), false, `"${k}" khớp cả câu 505 mà Viettel Post thật sự gửi`);
  }
  assert.equal(
    RETURN_APPROVED_CODES.some((c) => RETURN_PROPOSED_CODES.includes(c)),
    false,
    "một mã không thể vừa là đề nghị vừa là đã duyệt",
  );

  /* ───── 4 · Vòng đời ca: 505 KHÔNG chốt, 515 chốt, 504 tới sau không đếm hai lần ───── */
  const sA = await dungKien(db, "s1");
  const caA = await moCa(db, sA, gio(6));

  const r505 = await applyCarrierEventToCare(db, {
    shipmentId: sA,
    orderId: null,
    trackingNumber: sA.toUpperCase(),
    stage: "RETURNING",
    vtpStatus: 505,
    vtpStatusName: "Tồn - Thông báo chuyển hoàn bưu cục gốc",
    legType: "OUTBOUND",
    occurredAt: gio(5),
  });
  assert.equal(r505.resolved, false, "505 chỉ là đề nghị hoàn — ca phải còn mở để đội xin phát tiếp");
  assert.equal((await doc(db, caA)).active, true);
  assert.equal((await doc(db, caA)).careOutcome, "PENDING");

  const mocDuyet = gio(4);
  const r515 = await applyCarrierEventToCare(db, {
    shipmentId: sA,
    orderId: null,
    trackingNumber: sA.toUpperCase(),
    stage: "RETURNING",
    vtpStatus: 515,
    vtpStatusName: "Bưu cục phát duyệt hoàn",
    legType: "OUTBOUND",
    occurredAt: mocDuyet,
  });
  assert.equal(r515.resolved, true, "ĐVVC đã duyệt hoàn ⇒ đội chăm sóc hết cửa can thiệp, ca không được nằm lại hàng đợi");
  const sauDuyet = await doc(db, caA);
  assert.equal(sauDuyet.careOutcome, "RESCUE_FAILED");
  assert.equal(sauDuyet.active, false);
  assert.equal(sauDuyet.careStatus, "RESOLVED");
  assert.equal(sauDuyet.finalLogisticsOutcome, "FAILED");
  assert.equal(sauDuyet.outcomeAt?.getTime(), mocDuyet.getTime(), "mốc kết quả là mốc ĐVVC duyệt hoàn, không phải lúc ERP xử lý");

  const r504 = await applyCarrierEventToCare(db, {
    shipmentId: sA,
    orderId: null,
    trackingNumber: sA.toUpperCase(),
    stage: "RETURNED",
    vtpStatus: 504,
    vtpStatusName: "Thành công - Chuyển trả người gửi",
    legType: "OUTBOUND",
    occurredAt: gio(1),
  });
  assert.equal(r504.resolved, false, "504 tới sau không được ghi đè — đợt đã có kết quả thì thôi (chặn đếm hai lần)");
  assert.equal((await doc(db, caA)).outcomeAt?.getTime(), mocDuyet.getTime(), "và mốc kết quả phải giữ nguyên ở lần chốt đầu");

  /* ───── 5 · HỒI QUY CHÍNH CA GỐC: dòng tệp đến sau không được kéo vận đơn về điểm xuất phát ───── */
  const sB = await dungKien(db, "s2");
  await suKien(db, sB, { source: "VTP_WEBHOOK", status: "505", name: "Tồn - Thông báo chuyển hoàn bưu cục gốc", stage: "RETURNING", at: gio(3) });
  // Dòng tệp mang mốc MỚI HƠN 70 giây — đúng khoảng cách đo được trên PKE1521276709.
  const mapped = resolveVtpStatus({ code: null, text: "Chờ xử lý", returnFlag: true });
  await suKien(db, sB, { source: "VTP_IMPORT", status: "Chờ xử lý", name: "Chờ xử lý", stage: mapped.stage as never, at: new Date(gio(3).getTime() + 70_000) });
  const dung = await materializeShipmentState(db, sB);
  assert.equal(dung.after, "RETURNING", "dòng tệp “Chờ xử lý” tới sau webhook 505 KHÔNG được biến vận đơn đang hoàn thành “chờ xử lý”");

  /* ───── 6 · BỘ ĐỐI CHIẾU PHẢI NÓI CÙNG MỘT ĐIỀU VỚI ĐƯỜNG SỰ KIỆN ───── */
  /*
    Đường sự kiện chỉ chạy khi có gói tin MỚI. Kiện nhận bằng chứng duyệt hoàn trước khi luật tồn
    tại thì không đường nào chạm tới nó nữa — đo được 29 ca như vậy trên production ngay sau khi
    luật lên máy chủ (15.086.000 ₫), vì bộ đối chiếu có một câu `continue` bỏ qua cả chiều hoàn.
  */
  const sC = await dungKien(db, "s3");
  const caC = await moCa(db, sC, gio(8));
  // Ảnh chụp kiện nói ĐÃ DUYỆT HOÀN, nhưng KHÔNG gói tin nào chạy qua vòng đời — đúng tình huống
  // của 29 ca tồn đọng.
  await db
    .update(schema.shipments)
    .set({ stage: "RETURNING", vtpStatus: null, vtpStatusName: "Đang chuyển hoàn", vtpStatusDate: gio(2), isFinal: false })
    .where(sql`${schema.shipments.id} = ${sC}`);
  assert.equal((await doc(db, caC)).careOutcome, "PENDING", "trước khi đối chiếu thì ca vẫn treo");
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sC] });
  const sauDoiChieu = await doc(db, caC);
  assert.equal(sauDoiChieu.careOutcome, "RESCUE_FAILED", "bộ đối chiếu phải chốt được ca trên kiện ĐÃ duyệt hoàn, không bỏ qua cả chiều hoàn");
  assert.equal(sauDoiChieu.active, false, "và đưa nó ra khỏi hàng đợi");

  /* ───── 7 · 505 vẫn phải được ĐỂ YÊN ở cả đường đối chiếu ───── */
  const sD = await dungKien(db, "s4");
  const caD = await moCa(db, sD, gio(8));
  await db
    .update(schema.shipments)
    .set({ stage: "RETURNING", vtpStatus: 505, vtpStatusName: "Tồn - Thông báo chuyển hoàn bưu cục gốc", vtpStatusDate: gio(2), isFinal: false })
    .where(sql`${schema.shipments.id} = ${sD}`);
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sD] });
  const sau505 = await doc(db, caD);
  assert.equal(sau505.careOutcome, "PENDING", "505 mới là ĐỀ NGHỊ hoàn — shop còn xin phát tiếp được, ca phải còn mở");
  assert.equal(sau505.active, true);

  /* ───── 8 · LỜI DUYỆT HOÀN ĐẾN QUA PANCAKE (webhook VTP không bao giờ gửi 515 — đo 28/09/2026) ───── */
  // Luật thuần: khớp NGUYÊN VĂN, không khớp chuỗi con — tên 505 CHỨA tên 502.
  const TEN_505 = "Tồn - Thông báo chuyển hoàn bưu cục gốc";
  assert.ok(!PANCAKE_RELAY_APPROVED_STATUSES.some((t) => t.toLowerCase() === TEN_505.toLowerCase()), "không câu nào trong danh sách là tên của 505");
  assert.equal(isRelayedReturnApproval(TEN_505), false, "505 (đề nghị) KHÔNG phải lời duyệt, dù chứa chữ “chuyển hoàn bưu cục gốc”");
  assert.equal(isRelayedReturnApproval("Bưu cục phát duyệt hoàn"), true);
  assert.equal(isRelayedReturnApproval("  chuyển hoàn   bưu cục gốc "), true, "chuẩn hoá khoảng trắng + chữ hoa");
  assert.equal(isRelayedReturnApproval(null), false);
  assert.equal(relayApprovedAfterProposal({ relayApprovedAt: gio(1), proposalAt: gio(2) }), true);
  assert.equal(relayApprovedAfterProposal({ relayApprovedAt: gio(3), proposalAt: gio(2) }), false, "duyệt CŨ hơn đề nghị hiện tại ⇒ lần hỏng này chưa ai duyệt");
  assert.equal(relayApprovedAfterProposal({ relayApprovedAt: gio(1), proposalAt: null }), false, "không có mốc đề nghị thì không kết luận");

  const dat505 = async (id: string, luc: Date) =>
    db
      .update(schema.shipments)
      .set({ stage: "RETURNING", vtpStatus: 505, vtpStatusName: TEN_505, vtpStatusDate: luc, isFinal: false })
      .where(sql`${schema.shipments.id} = ${id}`);

  // (E) Pancake chuyển tiếp "Bưu cục phát duyệt hoàn" MỚI HƠN 505 ⇒ đóng ca, KHÔNG đổi trạng thái vận đơn.
  const sE = await dungKien(db, "s5");
  const caE = await moCa(db, sE, gio(8));
  await dat505(sE, gio(3));
  await suKien(db, sE, { source: "PANCAKE", status: "Bưu cục phát duyệt hoàn", name: "Duyệt hoàn", stage: null, at: gio(1) });
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sE] });
  const sauE = await doc(db, caE);
  assert.equal(sauE.careOutcome, "RESCUE_FAILED", "VTP đã duyệt hoàn (qua Pancake) ⇒ ca chốt không cứu được");
  assert.equal(sauE.active, false, "và rời hàng đợi care");
  const kienE = await db.query.shipments.findFirst({ where: sql`${schema.shipments.id} = ${sE}`, columns: { stage: true, vtpStatus: true } });
  assert.deepEqual(kienE, { stage: "RETURNING", vtpStatus: 505 }, "dòng Pancake KHÔNG được dựng trạng thái vận đơn — chỉ đóng ca");

  // (F) Lời duyệt CŨ HƠN lần 505 hiện tại (kiện từng hoàn, được xin phát tiếp, lại hỏng) ⇒ ca còn mở.
  const sF = await dungKien(db, "s6");
  const caF = await moCa(db, sF, gio(8));
  await suKien(db, sF, { source: "PANCAKE", status: "Bưu cục phát duyệt hoàn", name: "Duyệt hoàn", stage: null, at: gio(6) });
  await dat505(sF, gio(2));
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sF] });
  assert.equal((await doc(db, caF)).active, true, "lời duyệt cũ hơn đề nghị hiện tại không đóng ca");

  // (G) Pancake chuyển tiếp chính tên 505 ⇒ vẫn là ĐỀ NGHỊ, ca còn mở.
  const sG = await dungKien(db, "s7");
  const caG = await moCa(db, sG, gio(8));
  await dat505(sG, gio(3));
  await suKien(db, sG, { source: "PANCAKE", status: TEN_505, name: "Phát thất bại nhiều lần", stage: null, at: gio(1) });
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sG] });
  assert.equal((await doc(db, caG)).active, true, "tên 505 qua Pancake vẫn chỉ là đề nghị hoàn");

  // (H) Chữ duyệt đến từ NGUỒN KHÁC Pancake theo đường này không được tính (đường VTP có luật riêng của nó).
  const sH = await dungKien(db, "s8");
  const caH = await moCa(db, sH, gio(8));
  await dat505(sH, gio(3));
  await suKien(db, sH, { source: "VTP_WEBHOOK", status: "Bưu cục phát duyệt hoàn", name: "Bưu cục phát duyệt hoàn", stage: null, at: gio(1) });
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sH] });
  assert.equal((await doc(db, caH)).active, true, "đường này chỉ đọc dòng PANCAKE; ảnh chụp VTP đi đường returnApproved");

  // (I) Đúng hình dạng PKE1529361891 (28/09/2026): ảnh chụp là dòng tệp "Chờ xử lý" KHÔNG mang mã (tới
  // sau webhook 505 sáu giây nên thắng), chặng RETURNING — vẫn là đề nghị hoàn. Pancake chuyển tiếp lời
  // duyệt mới hơn ⇒ đóng ca. Bản đầu của luật đòi mã 505 trên ảnh chụp và bỏ sót đúng ca chủ shop báo.
  const sI = await dungKien(db, "s9");
  const caI = await moCa(db, sI, gio(8));
  await db
    .update(schema.shipments)
    .set({ stage: "RETURNING", vtpStatus: null, vtpStatusName: "Chờ xử lý", vtpStatusDate: gio(3), isFinal: false })
    .where(sql`${schema.shipments.id} = ${sI}`);
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sI] });
  assert.equal((await doc(db, caI)).active, true, "chưa có lời duyệt nào ⇒ ca còn mở (“Chờ xử lý” chỉ là chờ quyết định hoàn)");
  await suKien(db, sI, { source: "PANCAKE", status: "Bưu cục phát duyệt hoàn", name: "Duyệt hoàn", stage: null, at: gio(1) });
  await reconcileCareCoverage(db, new Date(), { shipmentIds: [sI] });
  const sauI = await doc(db, caI);
  assert.equal(sauI.active, false, "ảnh chụp “Chờ xử lý” mã rỗng + Pancake đã duyệt ⇒ rời hàng đợi");
  assert.equal(sauI.careOutcome, "RESCUE_FAILED");

  /* ───── dọn ───── */
  const ids = [sA, sB, sC, sD, sE, sF, sG, sH, sI];
  await db.delete(schema.careActions).where(sql`${schema.careActions.shipmentId} in ${ids}`);
  await db.delete(schema.careCaseEvents).where(sql`${schema.careCaseEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentCare).where(sql`${schema.shipmentCare.shipmentId} in ${ids}`);
  await db.delete(schema.shipmentEvents).where(sql`${schema.shipmentEvents.shipmentId} in ${ids}`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} in ${ids}`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  clearMemo();

  console.log(
    "✓ Chờ xử lý + Trả hàng = chờ xử lý HOÀN (không phải chờ lấy hàng) · mã 102 vẫn PENDING · 505 đề nghị ≠ 515 đã duyệt và chữ không tách nổi nên mã quyết định · ca chốt ở 515, 504 tới sau không đếm lại · dòng tệp đến sau không kéo vận đơn đang hoàn về điểm xuất phát · ĐƯỜNG SỰ KIỆN và BỘ ĐỐI CHIẾU nói cùng một điều",
  );
}
