import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { AUDIT_MAX_LINES, deletedAudit, deletedAuditLines, hourAudit, hourAuditLines, spikeHours, type HourRow } from "@/scripts/confirm-funnel-audit";

/**
 * ═══════════ ĐO GIỜ LÊN ĐƠN BẤT THƯỜNG VÀ ĐƠN "ĐÃ XOÁ" (ops `confirm-funnel-audit --gio | --xoa`) ═══════════
 *
 * Hai phép đo CHỈ ĐỌC để trả lời hai câu hỏi trước khi đổi định nghĩa nào:
 *  · 1.006 đơn "lên lúc 15h", 126 đơn lúc 3h sáng — giờ khách đặt thật, hay dấu vân tay của một lượt
 *    nhập / đồng bộ hàng loạt (nhiều đơn cùng một phút, Pancake không gửi `inserted_at`)?
 *  · "Đã xoá" khác "Đã huỷ" ở đâu — có hàng, có tiền, từng xác nhận, có vận đơn, cùng SĐT có đơn sống?
 * Khoá: câu SQL chạy được trên CSDL thật (không chỉ đúng kiểu), đếm đúng, và dòng in ra KHÔNG mang mã
 * đơn / SĐT / tên (log ops là công khai).
 */

const P = "oha-";
const vn = (iso: string) => new Date(`${iso}+07:00`);
const KY_TU = vn("2034-05-01T00:00:00");
const KY_DEN = vn("2034-05-31T23:59:59");

export function testOrderHourAuditPure() {
  const gio = (h: number, n: number): HourRow => ({ hour: h, created: n, missingStamp: 0, laterThanHistory: 0, preCancel: 0 });
  const bang = Array.from({ length: 24 }, (_, h) => gio(h, 10));
  bang[15] = gio(15, 100);
  bang[3] = gio(3, 31);
  assert.deepEqual(spikeHours(bang), [3, 15], "giờ dồn = nhiều hơn 3 lần trung vị 24 giờ");
  assert.deepEqual(spikeHours(Array.from({ length: 24 }, (_, h) => gio(h, 0))), [], "không đơn nào ⇒ không có giờ dồn, không chia cho 0");
  const dong = hourAuditLines(90, bang, [], []);
  assert.ok(dong.length <= AUDIT_MAX_LINES);
  assert.ok(dong.some((l) => l.includes("GIỜ DỒN") && l.includes("03h") && l.includes("15h")));
  assert.ok(dong.some((l) => l.includes("không có phút nào dồn")), "không có phút dồn thì nói ra, không bỏ trống");
  console.log("✓ Đo giờ lên đơn (hàm thuần): giờ dồn so với trung vị 24 giờ · không đơn nào ⇒ không kết luận");
}

async function donDep(db: Db) {
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'oha-%'`);
  await db.delete(schema.orderStatusHistory).where(sql`${schema.orderStatusHistory.orderId} like 'oha-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'oha-%'`);
}

export async function testOrderHourAuditDb(db: Db) {
  await donDep(db);
  try {
    // Lượt nhập hàng loạt: 6 đơn cùng phút 15:03, Pancake không gửi inserted_at, trạng thái đầu có TRƯỚC mốc lên đơn 2 giờ.
    for (let k = 0; k < 6; k += 1) {
      await db.insert(schema.orders).values({ id: `${P}bulk${k}`, insertedAt: vn("2034-05-10T15:03:20"), stage: k < 2 ? "DELETED" : "NEW", status: k < 2 ? 7 : 0, source: "Nguồn khác", raw: {}, billPhone: `09000000${10 + k}` });
      await db.insert(schema.orderStatusHistory).values({ orderId: `${P}bulk${k}`, status: 0, updatedAt: vn("2034-05-10T13:03:20") });
    }
    // Đơn thường: có inserted_at từ Pancake.
    await db.insert(schema.orders).values([
      { id: `${P}a`, insertedAt: vn("2034-05-11T09:15:00"), stage: "CANCELLED", status: 6, source: "Chat fanpage Facebook", raw: { inserted_at: "2034-05-11T02:15:00" }, billPhone: "0912345678", totalPriceAfterDiscount: 400_000 },
      { id: `${P}b`, insertedAt: vn("2034-05-11T20:00:00"), stage: "CONFIRMED", status: 1, source: "Chat fanpage Facebook", raw: { inserted_at: "2034-05-11T13:00:00" }, billPhone: "0912345678", totalPriceAfterDiscount: 400_000 },
    ]);
    await db.insert(schema.orderItems).values({ id: `${P}a-i`, orderId: `${P}a`, productName: "Hàng đo giờ", quantity: 1, unitPrice: 400_000, lineTotal: 400_000 });
    await db.insert(schema.orderStatusHistory).values([
      { orderId: `${P}a`, status: 0, updatedAt: vn("2034-05-11T09:15:00") },
      { orderId: `${P}a`, status: 6, updatedAt: vn("2034-05-11T12:15:00") },
      { orderId: `${P}bulk0`, status: 7, updatedAt: vn("2034-05-10T16:03:20") },
    ]);

    const h = await hourAudit(KY_TU, KY_DEN);
    const g15 = h.hours.find((r) => r.hour === 15);
    assert.equal(g15?.created, 6);
    assert.equal(g15?.missingStamp, 6, "đơn không có inserted_at của Pancake ⇒ ERP đã lùi về giờ đồng bộ — phải đếm ra");
    assert.equal(g15?.laterThanHistory, 6, "mốc lên đơn muộn hơn trạng thái đầu 2 giờ ⇒ mốc lên đơn không phải giờ khách đặt");
    assert.equal(g15?.preCancel, 2);
    assert.equal(h.hours.find((r) => r.hour === 9)?.missingStamp, 0);
    const phut = h.minutes.find((m) => m.minute === "2034-05-10 15:03");
    assert.ok(phut, "6 đơn cùng một phút phải hiện ở PHÚT DỒN");
    assert.equal(phut?.created, 6);
    assert.equal(phut?.cancelled, 2);
    assert.equal(phut?.medHistoryGapMin, -120, "trạng thái đầu có trước mốc lên đơn 2 giờ");
    const dong = hourAuditLines(30, h.hours, h.minutes, h.spikeDays);
    assert.ok(dong.length <= AUDIT_MAX_LINES);
    assert.ok(!dong.some((l) => l.includes(P) || l.includes("0912345678")), "không mã đơn, không SĐT ra log công khai");

    const x = await deletedAudit(KY_TU, KY_DEN);
    const xoa = x.find((r) => r.stage === "DELETED")!;
    const huy = x.find((r) => r.stage === "CANCELLED")!;
    assert.equal(xoa.total, 2);
    assert.equal(xoa.noItems, 2, "đơn xoá không có dòng hàng");
    assert.equal(xoa.zeroValue, 2);
    assert.equal(xoa.deadMeasured, 1, "chỉ đơn có lịch sử chuyển sang trạng thái chết mới đo được thời gian");
    assert.equal(xoa.medHoursToDead, 1);
    assert.equal(huy.total, 1);
    assert.equal(huy.noItems, 0);
    assert.equal(huy.samePhoneAlive, 1, "cùng SĐT có đơn sống trong ±48 giờ");
    assert.equal(huy.medHoursToDead, 3);
    assert.deepEqual(huy.bySource, [{ source: "Chat fanpage Facebook", n: 1 }]);
    const dongXoa = deletedAuditLines(30, x);
    assert.ok(!dongXoa.some((l) => l.includes(P) || l.includes("0912345678")));
    console.log("✓ Đo giờ lên đơn + đơn Đã xoá (CSDL): câu SQL chạy thật · đếm thiếu mốc / muộn hơn lịch sử / phút dồn · Đã xoá vs Đã huỷ tách từng dấu hiệu · không PII ra log");
  } finally {
    await donDep(db);
  }
}
