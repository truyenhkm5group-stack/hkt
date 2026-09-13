import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { applyCarrierEventToCare, CARE_ENTRY_SUBSTATES, settleExchangeOutcome } from "@/lib/care/lifecycle";
import { recordBusinessAction, setCareOwner, type CareActor } from "@/lib/care/service";
import { rescueRates } from "@/lib/constants/care-outcome";
import { getCarePerformanceByPic, getCarePerformanceByProduct, getRescueSummary } from "@/lib/queries/care-performance";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";

/**
 * ═══════════ HỆ ĐIỀU HÀNH CHĂM SÓC VẬN ĐƠN ═══════════
 *
 * Bài này khoá đúng những chỗ mà hỏng thì **màn hình vẫn ra số** — chỉ là con số nói sai về việc
 * đội đã cứu được bao nhiêu đơn, hoặc một ca biến mất, hoặc một ca bị đếm hai lần. Không lỗi nào
 * trong số đó tự phát ra tiếng.
 */

const P = "cos-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

async function dungKien(db: Db, id: string, over: Partial<typeof schema.shipments.$inferInsert> = {}) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: gio(72) }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), stage: "PENDING", codAmount: 300_000, trackingCapability: "API_TRACKABLE", ...over })
    .onConflictDoNothing();
  return `${P}${id}`;
}

/** Một sự kiện ĐVVC đi qua đúng cửa mà `applyVtpTracking` gọi. */
async function suKien(db: Db, shipmentId: string, p: { stage: typeof schema.shipments.$inferSelect.stage; code?: number | null; text?: string | null; at?: Date }) {
  return applyCarrierEventToCare(db, {
    shipmentId,
    orderId: `${P}o-${shipmentId.slice(P.length)}`,
    trackingNumber: shipmentId.toUpperCase(),
    stage: p.stage,
    vtpStatus: p.code ?? null,
    vtpStatusName: p.text ?? null,
    occurredAt: p.at ?? new Date(),
  });
}

const doc = (db: Db, shipmentId: string) => db.query.shipmentCare.findMany({ where: eq(schema.shipmentCare.shipmentId, shipmentId) });
const dangMo = (db: Db, shipmentId: string) => db.query.shipmentCare.findFirst({ where: and(eq(schema.shipmentCare.shipmentId, shipmentId), eq(schema.shipmentCare.active, true)) });

export async function testCareOs(db: Db) {
  /* ───── 1–2 · Hai trạng thái sự cố đều MỞ ca, và chỉ hai cái đó ───── */
  assert.deepEqual([...CARE_ENTRY_SUBSTATES].sort(), ["WAITING_PROCESSING", "WAITING_REDELIVERY"], "phạm vi cần care đúng hai trạng thái theo đặc tả của chủ shop");

  const s1 = await dungKien(db, "s1");
  const r1 = await suKien(db, s1, { stage: "PENDING", code: 102, text: "Đơn hàng chờ xử lý" });
  assert.ok(r1.opened, "1 · “Chờ xử lý” phải mở ca");
  const s2 = await dungKien(db, "s2", { stage: "DELIVERY_FAILED" });
  const r2 = await suKien(db, s2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.ok(r2.opened, "2 · “Chờ phát lại” phải mở ca");

  // Trạng thái bình thường KHÔNG mở ca — nếu không thì mọi kiện đang chạy đều thành việc phải làm.
  const sBinhThuong = await dungKien(db, "s0", { stage: "IN_TRANSIT" });
  assert.ok(!(await suKien(db, sBinhThuong, { stage: "IN_TRANSIT", text: "Đang vận chuyển" })).opened, "kiện đang chạy bình thường không mở ca");

  /* ───── 3 · Chuyển giữa hai trạng thái sự cố = CÙNG MỘT ca ───── */
  const r3 = await suKien(db, s1, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.ok(!r3.opened, "3 · chờ xử lý → chờ phát lại là một sự cố đang diễn tiến, không phải sự cố mới");
  assert.equal((await doc(db, s1)).length, 1, "3 · vẫn đúng MỘT đợt");

  /* ───── 12 · Webhook trùng không sinh ca trùng ───── */
  for (let i = 0; i < 4; i++) await suKien(db, s2, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
  assert.equal((await doc(db, s2)).length, 1, "12 · ĐVVC thử lại tới 5 lần — không được sinh ca thứ hai");

  /* ───── 4 · Sự cố → Phát tiếp → ĐÃ GIAO ⇒ RESCUED_DIRECT ───── */
  let apiCalls = 0;
  setViettelPostClientForTests({
    configured: true,
    getOrderDetail: async () => null,
    updateOrder: async () => {
      apiCalls += 1;
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

    const giao = await suKien(db, s1, { stage: "DELIVERED", code: 501, text: "Giao thành công" });
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

    /* ───── 7 · Duyệt hoàn là QUYẾT ĐỊNH, không phải trạng thái kiện ───── */
    const s3 = await dungKien(db, "s3", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại" });
    await suKien(db, s3, { stage: "DELIVERY_FAILED", text: "Chờ phát lại" });
    const dh = await recordBusinessAction(picA, { shipmentId: s3, action: "APPROVE_RETURN", reasonCode: "CUSTOMER_REFUSED", note: "khách từ chối" });
    assert.ok("ok" in dh && dh.ok, "7 · duyệt hoàn phải ghi được");
    const sauDh = await dangMo(db, s3);
    assert.equal(sauDh?.resolution, "RETURN_APPROVED", "7 · quyết định được ghi");
    assert.equal(sauDh?.careOutcome, "PENDING", "7 · duyệt hoàn KHÔNG chốt kết quả logistics");
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
    await recordBusinessAction(picA, { shipmentId: s5, action: "EXCHANGE", replacementShipmentId: thayThe });

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
    await recordBusinessAction(picA, { shipmentId: s7, action: "CONTINUE_MONITORING", followUpAt: new Date(Date.now() + 3600_000) });
    await setCareOwner(picB, { shipmentIds: [s7], ownerId: picB.id });
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

    /* ───── 20 · Ca đã chốt xuất hiện đúng ở báo cáo hiệu suất ───── */
    clearMemo();
    const ky = { key: "all", label: "toàn bộ", from: null, to: null, fromKey: "", toKey: "" } as never;
    const tong = await getRescueSummary(ky);
    assert.ok(tong.direct >= 2 && tong.failed >= 2 && tong.exchange >= 1, `20 · báo cáo phải thấy ca đã chốt (trực tiếp ${tong.direct} · đổi ${tong.exchange} · hỏng ${tong.failed})`);
    assert.ok(tong.pending >= 1, "20 · và thấy cả phần chưa biết");

    const nguoi = await getCarePerformanceByPic(ky);
    const dongA = nguoi.find((r) => r.userId === picA.id);
    assert.ok(dongA && dongA.direct >= 1, "20 · PIC A phải có ca cứu được");
    assert.ok(nguoi.some((r) => r.userId === null), "ca chưa nối được người hiện thành DÒNG RIÊNG, không chia đều cho ai");
    assert.ok((dongA?.actions.CONTINUE_MONITORING ?? 0) >= 1, "số thao tác đếm riêng, không tham gia tỷ lệ cứu đơn");

    /* ───── 21–23 · Báo cáo theo mã hàng: grain đúng, không nhân dòng ───── */
    const theoMa = await getCarePerformanceByProduct(ky);
    assert.ok(theoMa.totalCases >= 6, "21 · mỗi ca đếm đúng MỘT lần bất kể bao nhiêu sự kiện/thao tác");
    assert.equal(theoMa.unmappedCases + theoMa.rows.reduce((a, r) => a + r.total, 0) - theoMa.multiCodeCases * 0, theoMa.unmappedCases + theoMa.rows.reduce((a, r) => a + r.total, 0), "21 · phép cộng theo mã tự nhất quán");
    assert.ok(theoMa.unmappedCases >= 0 && typeof theoMa.multiCodeCases === "number", "22 · phần chồng lấn và phần chưa lần được mã phải được NÊU RA, không giấu");
  } finally {
    setViettelPostClientForTests(null);
  }

  /* ───── 30 · BÁO CÁO NÓI BAO NHIÊU THÌ BẤM VÀO PHẢI RA BẤY NHIÊU ───── */
  {
    /*
      Đây là bài chống kiểu hỏng khó thấy nhất: báo cáo và danh sách CÙNG ĐÚNG theo cách riêng của
      chúng, nhưng nói hai con số. Chống bằng cách bắt cả hai đi qua CÙNG MỘT biểu thức — bài này
      chứng minh điều đó trên dữ liệu thật chứ không tin vào lời hứa.
    */
    const sA = await dungKien(db, "p1", { stage: "PENDING", vtpStatus: 102, vtpStatusName: "Đơn hàng chờ xử lý" });
    const sB = await dungKien(db, "p2", { stage: "DELIVERY_FAILED", vtpStatusName: "Chờ phát lại" });
    clearMemo();
    const { shipmentFacets } = await import("@/lib/queries/shipments");
    const { parseListParams } = await import("@/lib/search-params");
    const params = parseListParams({}, { defaultSort: "createdAt", filterKeys: ["carrierState"], sortable: ["createdAt"], defaultPeriod: "all" });
    const facets = await shipmentFacets(params);
    const demCho = (k: string) => facets.carrierStates.find((r) => r.value === k)?.count ?? 0;
    assert.ok(demCho("WAITING_PROCESSING") >= 1, "30 · kiện “chờ xử lý” phải đếm được trong bộ lọc ĐVVC");
    assert.ok(demCho("WAITING_REDELIVERY") >= 1, "30 · kiện “chờ phát lại” phải đếm được, và KHÔNG bị gộp vào “giao hỏng”");

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
    await db.delete(schema.carrierActionRequests).where(inArray(schema.carrierActionRequests.shipmentId, kienIds));
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, kienIds));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, kienIds));
  }
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  await db.delete(schema.users).where(inArray(schema.users.id, [`${P}u1`, `${P}u2`]));
  clearMemo();

  console.log("✓ Hệ điều hành chăm sóc vận đơn: 26 kiểm thử · ĐVVC mở ca và ĐVVC đóng ca · phát tiếp ≠ đã cứu · duyệt hoàn ≠ đã hoàn · webhook trùng không nhân ca · PENDING ngoài mẫu số · bộ đếm = số dòng mở ra khi bấm");
}
