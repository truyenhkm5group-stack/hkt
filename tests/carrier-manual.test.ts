import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { carrierRequestView, derivedManualConfirmations, settleCarrierRequests } from "@/lib/care/carrier-requests";
import { MANUAL_CONFIRM_WAIT_HOURS, manualInstructionText, manualRequestVerdict, manualVerdictText } from "@/lib/constants/carrier-manual";
import { getCareCaseDetail } from "@/lib/queries/care-workbench";

/**
 * ═══════════ LỆNH ĐVVC LÀM TAY — WEBHOOK XÁC MINH ═══════════
 *
 * Viettel Post không cấp API cho shop, nên mọi lệnh là làm tay. Bốn chỗ vòng này dễ nói sai nhất:
 *  1. Không bao giờ khép — webhook tới mà lệnh vẫn "Phải làm tay" (lỗi trước bản này).
 *  2. Khép bằng sự kiện CŨ HƠN lệnh, bằng 501 CHIỀU HOÀN, hay bằng trạng thái Pancake.
 *  3. Ghi đè lời khai của người (`status`) bằng chứng từ ĐVVC, hoặc ngược lại.
 *  4. Backfill lệnh cũ — lệnh lập trước bản này phải được suy ra lúc đọc, cột vẫn trống.
 */
export function testCarrierManualPure() {
  const now = new Date("2026-09-24T12:00:00Z");
  const h = (x: number) => new Date(now.getTime() - x * 3_600_000);

  assert.equal(manualRequestVerdict({ actionKey: "redeliver", status: "ACKNOWLEDGED", at: h(2) }, now), null, "đường API có vòng đời riêng — không vẽ phán quyết làm tay");
  assert.deepEqual(manualRequestVerdict({ actionKey: "redeliver", status: "MANUAL_REQUIRED", at: h(30), confirmedAt: h(1) }, now), { state: "CARRIER_CONFIRMED", at: h(1) }, "có chứng từ thì thắng mọi đồng hồ");
  assert.equal(manualRequestVerdict({ actionKey: "edit", status: "MANUAL_DONE", at: h(30) }, now)?.state, "NOT_VERIFIABLE", "lệnh sửa không sinh chặng — webhook không xác minh được, KHÔNG được coi là đang chờ");
  const w = manualRequestVerdict({ actionKey: "redeliver", status: "MANUAL_REQUIRED", at: h(MANUAL_CONFIRM_WAIT_HOURS - 1) }, now);
  assert.equal(w?.state, "WAITING");
  assert.equal(manualRequestVerdict({ actionKey: "redeliver", status: "MANUAL_REQUIRED", at: h(MANUAL_CONFIRM_WAIT_HOURS) }, now)?.state, "OVERDUE", "đúng ngưỡng là quá hạn");
  // Đồng hồ của lệnh đã làm tay đếm từ lúc người bấm "Đã làm tay", không từ lúc lập lệnh.
  assert.equal(manualRequestVerdict({ actionKey: "approve-return", status: "MANUAL_DONE", at: h(40), doneAt: h(2) }, now)?.state, "WAITING", "vừa làm xong 2 giờ thì còn đang chờ webhook, dù lệnh lập 40 giờ trước");
  assert.equal(manualRequestVerdict({ actionKey: "approve-return", status: "MANUAL_DONE", at: h(40), doneAt: null }, now)?.state, "OVERDUE", "thiếu mốc làm tay thì lùi về mốc lập lệnh");
  // Ngày đi qua ranh giới RSC là chuỗi — phải đọc được.
  assert.equal(manualRequestVerdict({ actionKey: "redeliver", status: "MANUAL_REQUIRED", at: h(3).toISOString(), confirmedAt: h(1).toISOString() }, now)?.state, "CARRIER_CONFIRMED");

  assert.match(manualVerdictText({ state: "CARRIER_CONFIRMED", at: h(1) }, "MANUAL_REQUIRED"), /không còn phải làm tay/);
  assert.doesNotMatch(manualVerdictText({ state: "CARRIER_CONFIRMED", at: h(1) }, "MANUAL_DONE"), /thành công/, "không kết luận người đã gây ra kết quả — ĐVVC tự phục hồi được (mục 56)");
  assert.match(manualVerdictText({ state: "OVERDUE", hours: 30 }, "MANUAL_REQUIRED"), /chưa ai làm/, "quá hạn khi chưa ai bấm nghĩa là CHƯA AI LÀM, không phải ĐVVC chậm");

  const t = manualInstructionText({ actionKey: "edit", orderNumber: "VTP123", payload: { receiverName: "Chị Lan", receiverPhone: "0901234567", receiverAddress: "12 Lê Lợi, Q1", moneyCollection: 450000, note: "" } });
  assert.match(t, /Mã vận đơn: VTP123/);
  assert.match(t, /SĐT mới: 0901234567/);
  assert.match(t, /Tiền thu hộ \(COD\): 450\.000 ₫/, "COD in theo định dạng VND chung");
  assert.doesNotMatch(t, /Ghi chú:/, "ô trống không in dòng rỗng");
  const r = manualInstructionText({ actionKey: "redeliver", orderNumber: "VTP9", note: " gọi số phụ " });
  assert.match(r, /Việc cần làm: Phát tiếp — Yêu cầu bưu tá giao lại cho khách/);
  assert.match(r, /Ghi chú cho bưu cục: gọi số phụ$/);
  console.log("✓ Lệnh làm tay (hàm thuần): chứng từ thắng đồng hồ · lệnh sửa không xác minh được · đồng hồ đếm từ lúc làm tay · không nhận công hộ · nội dung soạn sẵn");
}

const P = "cm-";

async function donDep(db: Db) {
  const ids = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(like(schema.shipments.id, `${P}%`))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.carrierActionRequests).where(inArray(schema.carrierActionRequests.shipmentId, ids));
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  }
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
}

export async function testCarrierManualDb(db: Db) {
  await donDep(db);
  const T0 = Date.now();
  const gio = (x: number) => new Date(T0 - x * 3_600_000);
  const lenh = async (id: string, shipmentId: string, actionKey: string, status: string, createdAt: Date, payload: unknown = null) => {
    await db.insert(schema.carrierActionRequests).values({ id: `${P}${id}`, shipmentId, orderNumber: `VTP-${shipmentId}`, actionKey, status, idempotencyKey: `${P}${id}`, payload, note: "", actorEmail: "cs@test", createdAt, finishedAt: createdAt });
    return `${P}${id}`;
  };
  const doc = async (id: string) => (await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.id, id)))[0];
  try {
    for (const n of [1, 2]) {
      await db.insert(schema.orders).values({ id: `${P}o${n}`, stage: "SHIPPED", status: 3, insertedAt: gio(80), billFullName: `Khách ${n}`, billPhone: `090000000${n}`, totalPriceAfterDiscount: 400_000 });
      await db.insert(schema.shipments).values({ id: `${P}s${n}`, orderId: `${P}o${n}`, carrier: "Viettel Post", vtpOrderNumber: `CM00${n}`, stage: "DELIVERY_FAILED", codAmount: 400_000, trackingCapability: "WEBHOOK_ONLY", vtpStatusDate: gio(6) });
    }

    // ── 1–3. Đường ghi: webhook đóng dấu lệnh làm tay, chỉ khi đúng chặng · đúng chiều · sau lúc lập lệnh ──
    const r1 = await lenh("r1", `${P}s1`, "redeliver", "MANUAL_REQUIRED", gio(5));
    const e1 = await lenh("e1", `${P}s1`, "edit", "MANUAL_DONE", gio(5), { receiverPhone: "0911111111" });

    assert.equal(await settleCarrierRequests(db, `${P}s1`, "OUT_FOR_DELIVERY", gio(6)), 0, "sự kiện CŨ HƠN lệnh không xác nhận được lệnh");
    assert.equal(await settleCarrierRequests(db, `${P}s1`, "DELIVERED", gio(4), "RETURN"), 0, "501 CHIỀU HOÀN là hàng về shop — ngược hẳn với phát tiếp");
    assert.equal((await doc(r1)).confirmedAt, null);

    const luc = gio(3);
    assert.equal(await settleCarrierRequests(db, `${P}s1`, "OUT_FOR_DELIVERY", luc, "OUTBOUND"), 1, "bưu tá đi phát sau lúc lập lệnh ⇒ webhook xác minh");
    const d1 = await doc(r1);
    assert.equal(d1.confirmedAt?.getTime(), luc.getTime());
    assert.equal(d1.status, "MANUAL_REQUIRED", "KHÔNG đổi lời khai của người: chưa ai bấm “Đã làm tay” thì vẫn là chưa ai khai đã làm");
    assert.equal(await settleCarrierRequests(db, `${P}s1`, "DELIVERED", gio(1), "OUTBOUND"), 0, "idempotent — mốc đã đóng không bị sự kiện sau ghi đè");
    assert.equal((await doc(r1)).confirmedAt?.getTime(), luc.getTime());
    assert.equal((await doc(e1)).confirmedAt, null, "lệnh sửa không có chặng xác nhận — không sự kiện nào đóng được nó");

    // ── 4. Đường đọc: lệnh lập TRƯỚC bản này — chứng từ có sẵn, cột trống, suy ra lúc đọc ──
    const r2 = await lenh("r2", `${P}s2`, "redeliver", "MANUAL_DONE", gio(10));
    await db.insert(schema.shipmentEvents).values([
      { shipmentId: `${P}s2`, source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát", occurredAt: gio(12), normalizedStage: "OUT_FOR_DELIVERY", legType: "OUTBOUND" },
      { shipmentId: `${P}s2`, source: "PANCAKE", status: "delivering", statusName: "Đang giao", occurredAt: gio(9), normalizedStage: "OUT_FOR_DELIVERY", legType: "OUTBOUND" },
      { shipmentId: `${P}s2`, source: "VTP_WEBHOOK", status: "501", statusName: "Phát thành công", occurredAt: gio(8), normalizedStage: "DELIVERED", legType: "RETURN" },
      { shipmentId: `${P}s2`, source: "VTP_WEBHOOK", status: "500", statusName: "Giao bưu tá đi phát", occurredAt: gio(7), normalizedStage: "OUT_FOR_DELIVERY", legType: "OUTBOUND" },
    ]);
    const rows = await db.select().from(schema.carrierActionRequests).where(eq(schema.carrierActionRequests.id, r2));
    const derived = await derivedManualConfirmations(db, rows);
    assert.equal(derived.get(r2)?.getTime(), gio(7).getTime(), "mốc SỚM NHẤT khớp — bỏ sự kiện trước lệnh, bỏ Pancake, bỏ 501 chiều hoàn");

    clearMemo();
    const detail = await getCareCaseDetail(`${P}s2`);
    assert.ok(detail, "phải dựng được ngăn kéo");
    const v = detail.carrierRequests.find((x) => x.id === r2);
    assert.ok(v && v.confirmedAt, "ngăn kéo phải thấy mốc xác minh suy ra");
    assert.equal(new Date(v.confirmedAt).getTime(), gio(7).getTime());
    assert.equal(v.status, "MANUAL_DONE");
    assert.ok(v.copyText?.includes("Mã vận đơn: VTP-cm-s2"), "lệnh làm tay mang nội dung soạn sẵn");
    assert.equal((await doc(r2)).confirmedAt, null, "KHÔNG backfill — suy ra lúc đọc, cột vẫn trống (mục 8.8)");

    // Khung nhìn: mốc đã ghi thắng mốc suy ra; lệnh API không nhận mốc suy ra, không có nội dung làm tay.
    const base = { id: "x", actionKey: "redeliver", createdAt: gio(5), error: null, note: "", actorEmail: "", attempts: 1, finishedAt: null, orderNumber: "V", payload: null };
    assert.equal(carrierRequestView({ ...base, status: "MANUAL_REQUIRED", confirmedAt: gio(2) }, gio(4)).confirmedAt?.getTime(), gio(2).getTime());
    const api = carrierRequestView({ ...base, status: "ACKNOWLEDGED", confirmedAt: null }, gio(4));
    assert.equal(api.confirmedAt, null, "mốc suy ra chỉ dành cho lệnh làm tay — đường API có SUCCESS riêng");
    assert.equal(api.copyText, null);
    console.log("✓ Lệnh làm tay (CSDL): webhook đóng dấu đúng chặng · đúng chiều · sau lúc lập lệnh · không đổi lời khai · lệnh cũ suy ra lúc đọc, không backfill");
  } finally {
    await donDep(db);
    clearMemo();
  }
}
