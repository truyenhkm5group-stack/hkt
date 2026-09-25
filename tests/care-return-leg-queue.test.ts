import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { recordCareDecision, type CareActor } from "@/lib/care/service";
import { queueViewOf, returnLegSettled, type CareStateLike, type CarrierLegLike } from "@/lib/care/view";
import { getCareQueue } from "@/lib/queries/care-workbench";
import { subscribe, type RealtimeEvent } from "@/lib/realtime/bus";

/**
 * ═══ KIỆN ĐANG CHUYỂN HOÀN MÀ ĐỘI ĐÃ CHỐT "ĐÃ HOÀN" KHÔNG ĐỨNG Ở "CẦN CARE" ═══
 *
 * Chủ shop báo 25/09/2026 (PKE1527396993): kết quả case "Đã hoàn", trạng thái care "Đã xong",
 * Viettel Post "Đang chuyển hoàn" — vẫn nằm ở "Cần care" với nhãn "mở lại" + "vỡ SLA". Một case
 * còn mở kéo kiện vào (chiều hoàn chưa chốt), và `careViewOf` coi ca đã đóng là MỞ LẠI vì mốc vào
 * hàng đợi mới hơn lúc đóng. Từ 25/09/2026 (tối) chỉ case sai địa chỉ / SĐT còn kéo được kiện vào.
 *
 *  (A) đúng ca trong ảnh ⇒ KHÔNG ở "Cần care", về "Đã xử lý";
 *  (B) 505 "Yêu cầu chuyển hoàn" mà đội CHƯA chốt gì ⇒ VẪN ở "Cần care" (shop còn phát tiếp được);
 *  (C) ĐVVC đã duyệt hoàn (515) ⇒ rời "Cần care" dù chưa ai bấm gì (mục 66);
 *  (D) bấm "Đã hoàn" trên (B) ⇒ phát sự kiện realtime `care` cho mọi màn hình đang mở, hàng đợi dựng
 *      lại đưa kiện ra khỏi "Cần care", và luật vá dòng phía trình duyệt ra CÙNG câu trả lời.
 */
export async function testCareReturnLegQueue(db: Db) {
  const actor: CareActor = { id: null, email: "lead@test", name: "Trưởng nhóm", source: "API" };
  const gio = (h: number) => new Date(Date.now() - h * 3600_000);

  // ─── Luật thuần: bảng chân lý ───
  const hoan505: CarrierLegLike = { stage: "RETURNING", substate: "RETURNING", vtpStatus: 505, rawStatus: "Yêu cầu chuyển hoàn" };
  const hoan515: CarrierLegLike = { stage: "RETURNING", substate: "RETURNING", vtpStatus: 515, rawStatus: "Bưu cục phát duyệt hoàn" };
  const chuaGiao: CarrierLegLike = { stage: "DELIVERY_FAILED", substate: "WAITING_REDELIVERY", vtpStatus: 507, rawStatus: "Chờ phát lại" };
  const caDaHoan: CareStateLike = { status: "RESOLVED", followUpAt: null, doneAt: gio(48), firstResponseAt: gio(50), lastDecision: { decision: "CARE_RETURN" } };
  const caTrong: CareStateLike = { status: "NEW", followUpAt: null, doneAt: null, firstResponseAt: null, lastDecision: null };
  assert.equal(returnLegSettled(hoan505, caDaHoan), true, "đang chuyển hoàn + đội chốt Đã hoàn ⇒ hết việc");
  assert.equal(returnLegSettled(hoan505, caTrong), false, "505 là ĐỀ NGHỊ hoàn, chưa ai chốt ⇒ còn việc (phát tiếp được)");
  assert.equal(returnLegSettled(hoan515, caTrong), true, "515 đã DUYỆT hoàn ⇒ hết cửa can thiệp");
  assert.equal(returnLegSettled({ stage: "RETURNING", substate: "RETURNING", vtpStatus: null, rawStatus: "Đang chuyển hoàn" }, caTrong), true, "dòng tệp không mã: chữ 'Đang chuyển hoàn' là đã duyệt");
  assert.equal(returnLegSettled(chuaGiao, caDaHoan), false, "chiều đi: kết quả 'Đã hoàn' không tự đẩy kiện ra — luật chỉ áp cho chiều hoàn");
  assert.equal(returnLegSettled(hoan505, { ...caDaHoan, lastDecision: { decision: "CARE_CONTINUE_DELIVERY" } }), false, "đội chọn Phát tiếp ⇒ còn việc");
  assert.equal(queueViewOf({ inCareCondition: true, carrier: hoan505, queueSince: gio(1) }, caDaHoan).view, "done", "ca đã đóng không bị 'mở lại' bởi tin của chiều hoàn");
  assert.equal(queueViewOf({ inCareCondition: true, carrier: hoan505, queueSince: gio(1) }, caDaHoan).reopened, false);
  assert.equal(queueViewOf({ inCareCondition: true, carrier: chuaGiao, queueSince: gio(1) }, caDaHoan).reopened, true, "chiều đi có sự cố mới sau lúc đóng ⇒ vẫn là mở lại như cũ");
  assert.equal(queueViewOf({ inCareCondition: false, carrier: chuaGiao, queueSince: gio(1) }, caTrong).view, "done");

  // ─── Dữ liệu: ba kiện đang ở chiều hoàn, mỗi kiện có một case còn mở kéo nó vào bàn care ───
  const kien = [
    { id: "crl-a", code: 505, name: "Yêu cầu chuyển hoàn" },
    { id: "crl-b", code: 505, name: "Yêu cầu chuyển hoàn" },
    { id: "crl-c", code: 515, name: "Bưu cục phát duyệt hoàn" },
  ];
  for (const [i, k] of kien.entries()) {
    await db.insert(schema.orders).values({ id: `${k.id}-o`, stage: "SHIPPED", status: 3, insertedAt: gio(200), billFullName: `Khách Hoàn ${i}`, billPhone: `090000020${i}` }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: k.id, orderId: `${k.id}-o`, carrier: "Viettel Post", vtpOrderNumber: `CRL00${i}`, stage: "RETURNING", pickedUpAt: gio(150), codAmount: 849_000, vtpStatus: k.code, vtpStatusDate: gio(2), vtpStatusName: k.name }).onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values([
      { shipmentId: k.id, source: "VTP_WEBHOOK", status: "507", statusName: "Chờ phát lại", occurredAt: gio(100), normalizedStage: "DELIVERY_FAILED", legType: "OUTBOUND" },
      { shipmentId: k.id, source: "VTP_WEBHOOK", status: String(k.code), statusName: k.name, occurredAt: gio(44), normalizedStage: "RETURNING", legType: "RETURN" },
      // Tin của CHIỀU HOÀN tới đều đặn SAU lúc đội đóng ca — chính thứ từng "mở lại" ca.
      { shipmentId: k.id, source: "VTP_WEBHOOK", status: String(k.code), statusName: k.name, occurredAt: gio(2), normalizedStage: "RETURNING", legType: "RETURN" },
    ]).onConflictDoNothing();
    // Từ 25/09/2026 (tối) chỉ sai địa chỉ / SĐT còn kéo kiện đang chạy vào bàn care.
    await db.insert(schema.csCases).values({ orderId: `${k.id}-o`, kind: "WRONG_ADDRESS", status: "OPEN", source: "MANUAL", title: "Sai địa chỉ · kiện đang chuyển hoàn" });
  }
  // (A) đúng hình ca trong ảnh: đợt 2 đã đóng "Đã xong", kết quả "Đã hoàn" từ 2 ngày trước.
  await db.insert(schema.shipmentCare).values({ shipmentId: "crl-a", orderId: "crl-a-o", trackingNumber: "CRL000", episodeNo: 1, active: false, careStatus: "RESOLVED", openedAt: gio(100), doneAt: gio(90), careOutcome: "PENDING" });
  const [dot2] = await db
    .insert(schema.shipmentCare)
    .values({ shipmentId: "crl-a", orderId: "crl-a-o", trackingNumber: "CRL000", episodeNo: 2, active: false, careStatus: "RESOLVED", openedAt: gio(60), doneAt: gio(48), firstResponseAt: gio(55), careOutcome: "PENDING" })
    .returning({ id: schema.shipmentCare.id });
  await db.insert(schema.careDecisions).values({ careCaseId: dot2!.id, shipmentId: "crl-a", decision: "CARE_RETURN", reasonCode: "OTHER", note: "Khách không nhận", actorEmail: "quan@test", decidedAt: gio(48) });

  clearMemo();
  const q = await getCareQueue();
  const a = q.cases.find((c) => c.shipmentId === "crl-a");
  assert.notEqual(a?.view, "care", "(A) Đã hoàn + Đã xong + VTP đang chuyển hoàn ⇒ KHÔNG ở Cần care (lỗi chủ shop báo 25/09/2026)");
  assert.equal(a?.reopened ?? false, false, "(A) tin của chiều hoàn không 'mở lại' ca đội đã chốt");
  const b = q.cases.find((c) => c.shipmentId === "crl-b");
  assert.equal(b?.view, "care", "(B) 505 mà đội chưa chốt gì ⇒ vẫn là việc: shop còn phát tiếp được");
  assert.notEqual(q.cases.find((c) => c.shipmentId === "crl-c")?.view, "care", "(C) ĐVVC đã duyệt hoàn (515) ⇒ không còn cửa can thiệp, rời Cần care");
  assert.ok(!q.cases.some((c) => c.view === "care" && ["crl-a", "crl-c"].includes(c.shipmentId)), "số đếm 'Cần care' không cộng kiện đã hết việc");

  // (D) Bấm "Đã hoàn" trên (B): sự kiện realtime + hàng đợi dựng lại + luật vá dòng phía trình duyệt.
  const nghe: RealtimeEvent[] = [];
  const bo = subscribe((e) => nghe.push(e));
  const r = await recordCareDecision(actor, { shipmentId: "crl-b", decision: "CARE_RETURN", note: "Khách không nhận nữa" });
  bo();
  assert.ok("ok" in r && r.ok, "ghi được kết quả Đã hoàn");
  assert.ok(
    nghe.some((e) => e.type === "care" && e.shipmentId === "crl-b"),
    "ghi care xong phải phát sự kiện `care` — không có nó thì màn hình đồng nghiệp đứng yên tới gói tin ĐVVC kế tiếp",
  );
  const sauBam = queueViewOf({ inCareCondition: b!.inCareCondition, carrier: b!.carrier, queueSince: b!.queueSince }, { ...r.data, lastDecision: r.data.lastDecision ?? null });
  assert.equal(sauBam.view, "done", "(D) trình duyệt vá dòng bằng cùng luật ⇒ rời Cần care ngay sau cú bấm");
  const b2 = (await getCareQueue()).cases.find((c) => c.shipmentId === "crl-b");
  assert.notEqual(b2?.view, "care", "(D) máy chủ dựng lại cũng nói như vậy — hai bên không lệch nhau");

  // Màn hình dùng CÙNG luật với máy chủ — không có bản thứ hai.
  const wb = readFileSync("app/(dashboard)/shipments/workbench.tsx", "utf8");
  assert.ok(wb.includes("queueViewOf(") && !wb.includes("careViewOf("), "workbench.tsx vá dòng qua queueViewOf, không tự gọi careViewOf");
  const q2 = readFileSync("lib/queries/care-workbench.ts", "utf8");
  assert.ok(q2.includes("queueViewOf(") && !/\bcareViewOf\(/.test(q2), "hàng đợi máy chủ đi qua queueViewOf");

  const ids = kien.map((k) => k.id);
  await db.delete(schema.csCases).where(inArray(schema.csCases.orderId, ids.map((id) => `${id}-o`)));
  await db.delete(schema.careCaseEvents).where(inArray(schema.careCaseEvents.shipmentId, ids));
  await db.delete(schema.careActions).where(inArray(schema.careActions.shipmentId, ids));
  await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
  for (const id of ids) await db.delete(schema.shipments).where(eq(schema.shipments.id, id));
  clearMemo();
  console.log("✓ Kiện đang chuyển hoàn mà đội đã chốt Đã hoàn (hoặc ĐVVC đã duyệt hoàn) rời Cần care; 505 chưa chốt vẫn là việc; ghi care phát sự kiện realtime và trình duyệt vá dòng cùng luật máy chủ");
}
