/**
 * ═══ VẬN ĐƠN BỊ THAY THẾ — SQL ≡ TS, DẪN XUẤT TỪ PRIMARY_ATTEMPT (lib/queries/shipment-superseded.ts, 25/10/2026) ═══
 *
 * Khoá: PKE chưa bàn giao + lần gửi tạo lại trên VTP đã lấy hàng ⇒ PKE bị thay thế (mẫu thật PKE1555563080 → 155555577235) ·
 * bàn giao bằng SỰ KIỆN (không có picked_up_at) cũng tính · hai lần đều chờ lấy ⇒ KHÔNG ai bị thay (đơn chưa đi lần nào phải còn
 * hiện ở «chờ lấy») · lần mới đã bàn giao rồi bị huỷ ⇒ không ai bị thay · lần đã giao thắng, lần chờ lấy sau đó bị thay · đơn một lần
 * gửi / vận đơn mồ côi ⇒ không · bản SQL và bản TS trả CÙNG kết quả trên từng dòng · mã thay thế đọc đúng · bí danh soát.
 */
import assert from "node:assert/strict";
import { inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { supersededBy } from "@/lib/constants/shipment-pick";
import { handedOffShipmentIds, withHandoff } from "@/lib/queries/shipment-handoff";
import { supersededAttemptSql, supersedingCodeSql } from "@/lib/queries/shipment-superseded";
import { rowsOf } from "@/lib/sql-rows";

type Seed = { code: string; attemptNo: number; stage: "PENDING" | "PICKED_UP" | "IN_TRANSIT" | "DELIVERED" | "CANCELLED"; pickedUp?: boolean; handoffEvent?: boolean };
const ORDERS: { id: string; attempts: Seed[]; expect: Record<string, string | null> }[] = [
  { id: "sup-a", attempts: [{ code: "PKESUP0000A1", attemptNo: 1, stage: "PENDING" }, { code: "999000000A02", attemptNo: 2, stage: "PICKED_UP", pickedUp: true }], expect: { PKESUP0000A1: "999000000A02", "999000000A02": null } },
  { id: "sup-b", attempts: [{ code: "PKESUP0000B1", attemptNo: 1, stage: "PENDING" }, { code: "999000000B02", attemptNo: 2, stage: "PENDING" }], expect: { PKESUP0000B1: null, "999000000B02": null } },
  { id: "sup-c", attempts: [{ code: "PKESUP0000C1", attemptNo: 1, stage: "PENDING" }, { code: "999000000C02", attemptNo: 2, stage: "CANCELLED", pickedUp: true }], expect: { PKESUP0000C1: null, "999000000C02": null } },
  { id: "sup-d", attempts: [{ code: "PKESUP0000D1", attemptNo: 1, stage: "DELIVERED", pickedUp: true }, { code: "999000000D02", attemptNo: 2, stage: "PENDING" }], expect: { PKESUP0000D1: null, "999000000D02": "PKESUP0000D1" } },
  { id: "sup-e", attempts: [{ code: "PKESUP0000E1", attemptNo: 1, stage: "PENDING" }], expect: { PKESUP0000E1: null } },
  { id: "sup-f", attempts: [{ code: "PKESUP0000F1", attemptNo: 1, stage: "PENDING" }, { code: "999000000F02", attemptNo: 2, stage: "IN_TRANSIT", handoffEvent: true }], expect: { PKESUP0000F1: "999000000F02", "999000000F02": null } },
  { id: "sup-g", attempts: [{ code: "PKESUP0000G1", attemptNo: 1, stage: "IN_TRANSIT", pickedUp: true }, { code: "999000000G02", attemptNo: 2, stage: "PENDING" }], expect: { PKESUP0000G1: null, "999000000G02": "PKESUP0000G1" } },
];

export async function testShipmentSuperseded() {
  assert.throws(() => supersededAttemptSql("sh"), /bí danh/, "bí danh trùng câu con bị chặn");
  assert.throws(() => supersededAttemptSql("s; drop"), /bí danh/);
  const db = await getDb();
  const ids: string[] = [];
  try {
    for (const o of ORDERS) {
      await db.insert(schema.orders).values({ id: o.id, status: 6, statusName: "Đã hủy", stage: "CANCELLED", insertedAt: new Date("2026-10-20T00:00:00Z") });
      for (const a of o.attempts) {
        const [r] = await db
          .insert(schema.shipments)
          .values({ orderId: o.id, attemptNo: a.attemptNo, direction: "OUTBOUND", stage: a.stage, vtpOrderNumber: a.code, carrier: "Viettel Post", codAmount: 499_000, createdAt: new Date(Date.UTC(2026, 9, 20 + a.attemptNo)), ...(a.pickedUp ? { pickedUpAt: new Date("2026-10-22T10:24:00Z") } : {}) })
          .returning({ id: schema.shipments.id });
        ids.push(r.id);
        if (a.handoffEvent) await db.insert(schema.shipmentEvents).values({ shipmentId: r.id, source: "VTP_WEBHOOK", status: "300", statusName: "Đóng bảng kê đi", occurredAt: new Date("2026-10-22T12:00:00Z"), normalizedStage: "IN_TRANSIT", legType: "OUTBOUND" });
      }
    }
    // Vận đơn mồ côi chờ lấy — không bao giờ bị thay.
    const [mo] = await db.insert(schema.shipments).values({ stage: "PENDING", vtpOrderNumber: "PKESUP0000Z1", carrier: "Viettel Post" }).returning({ id: schema.shipments.id });
    ids.push(mo.id);

    const sqlRows = rowsOf<{ id: string; code: string; sup: boolean; by: string | null }>(
      await db.execute(sql`select s.id, s.vtp_order_number as code, ${sql.raw(supersededAttemptSql("s"))} as sup, case when ${sql.raw(supersededAttemptSql("s"))} then ${sql.raw(supersedingCodeSql("s"))} end as by from shipments s where s.id in ${ids}`),
    );
    const all = await db.query.shipments.findMany({ where: inArray(schema.shipments.id, ids) });
    const handed = await handedOffShipmentIds(db, ids);
    const expect = Object.assign({ PKESUP0000Z1: null }, ...ORDERS.map((o) => o.expect)) as Record<string, string | null>;
    for (const r of sqlRows) {
      const attempts = withHandoff(all.filter((x) => x.orderId !== null && x.orderId === all.find((y) => y.id === r.id)?.orderId), handed);
      const ts = supersededBy(attempts, r.id);
      assert.equal(Boolean(r.sup), ts !== null, `SQL ≡ TS ở ${r.code}`);
      assert.equal(r.by ?? null, ts?.vtpOrderNumber ?? null, `mã thay thế SQL ≡ TS ở ${r.code}`);
      assert.equal(r.by ?? null, expect[r.code], `kỳ vọng ở ${r.code}`);
    }
    assert.equal(sqlRows.length, Object.keys(expect).length, "đọc đủ mọi dòng gieo");
  } finally {
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
    await db.delete(schema.orders).where(inArray(schema.orders.id, ORDERS.map((o) => o.id)));
  }
  console.log("✓ Vận đơn bị thay thế: SQL ≡ TS từng dòng · PKE chờ lấy + lần tạo lại đã lấy ⇒ bị thay · bàn giao bằng sự kiện cũng tính · hai lần đều chờ / lần mới bị huỷ / một lần gửi / mồ côi ⇒ không · lần đã giao thắng");
}
