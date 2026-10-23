/**
 * ═══════════ KẾT QUẢ ĐƠN KHI SHOP GỬI LẠI TRÊN WEB VIETTEL POST (P0 chủ shop 22/10/2026 — ORDER_OUTCOME.md mục 12) ═══════════
 *
 * Khoá:
 *  1. LẦN GỬI CHÍNH = lần CÒN SỐNG (chứng từ bàn giao ∧ chưa huỷ) trước `attempt_no`; SQL (`PRIMARY_ATTEMPT`) và TypeScript
 *     (`vanDonDaiDien` + `handedOffShipmentIds`) chọn CÙNG một dòng trên mọi ca.
 *     · Ca đo 22/10 (27 đơn): lần mới CANCELLED + lần cũ PENDING chưa từng được lấy ⇒ KHÔNG đổi (vẫn lần mới) — vận đơn đứng yên
 *       không phải bằng chứng hàng đang đi.
 *     · Lần cũ đã bàn giao, lần mới bị VTP huỷ ⇒ lần cũ quyết.
 *  2. Đơn Pancake «Đã hủy» + lần gửi thay thế (`attempt_no > 1`) đang đi ⇒ IN_TRANSIT (chứng từ ĐVVC thắng trạng thái Pancake);
 *     cùng đơn mà chỉ MỘT lần gửi ⇒ CANCELLED như cũ; lần gửi thay thế mang mã huỷ 107 ⇒ CANCELLED.
 *  3. Sổ kho: lần cũ đã được lấy rồi bị huỷ + lần tạo lại chưa được lấy ⇒ đơn VẪN «đã xuất», không «quay lại» chờ xuất; hai lần
 *     gửi chiều đi cùng rời kho ⇒ luật đối soát ORDER_DOUBLE_LEFT_WAREHOUSE (việc cho người).
 * Tự dọn bằng tiền tố `vro-`. Dữ liệu dựng, không PII.
 */
import assert from "node:assert/strict";
import { eq, inArray, like, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { vanDonDaiDien } from "@/lib/constants/shipment-pick";
import { getControlTower } from "@/lib/queries/control-tower";
import { ORDER_LEFT_WAREHOUSE, ORDER_OUTCOME, ORDER_OUTCOME_VERIFIED, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { handedOffShipmentIds, withHandoff } from "@/lib/queries/shipment-handoff";
import { RESERVED_IN_WAREHOUSE } from "@/lib/queries/stock";

const AT = new Date("2026-10-15T00:00:00Z");

async function seed(orderId: string, stage: "CANCELLED" | "CONFIRMED" | "SHIPPED", attempts: { n: number; stage: "PENDING" | "PICKED_UP" | "IN_TRANSIT" | "CANCELLED" | "DELIVERED"; events: [string, string][]; pickedUp?: boolean; cod?: number }[]) {
  const db = await getDb();
  await db.insert(schema.orders).values({ id: orderId, systemId: null, stage, insertedAt: AT }).onConflictDoNothing();
  for (const a of attempts) {
    const id = `${orderId}-s${a.n}`;
    await db.insert(schema.shipments).values({ id, orderId, carrier: "Viettel Post", vtpOrderNumber: `${orderId.toUpperCase()}S${a.n}`, attemptNo: a.n, direction: "OUTBOUND", stage: a.stage, ...(a.cod ? { codCollected: a.cod, codStatus: "COLLECTED" as const } : {}), createdAt: new Date(AT.getTime() + a.n * 60_000), pickedUpAt: a.pickedUp ? new Date(AT.getTime() + a.n * 3_600_000) : null }).onConflictDoNothing();
    for (const [status, normalized] of a.events) {
      await db.insert(schema.shipmentEvents).values({ shipmentId: id, source: "VTP_WEBHOOK", status, statusName: status, occurredAt: new Date(AT.getTime() + a.n * 3_600_000 + Number(status)), normalizedStage: normalized as never, legType: "OUTBOUND" }).onConflictDoNothing();
    }
  }
}

async function primaryOf(orderId: string) {
  const db = await getDb();
  const [r] = await db
    .select({ id: schema.shipments.id, outcome: ORDER_OUTCOME, verified: ORDER_OUTCOME_VERIFIED, left: ORDER_LEFT_WAREHOUSE, reserved: RESERVED_IN_WAREHOUSE })
    .from(schema.orders)
    .leftJoin(schema.shipments, sql`${schema.shipments.orderId} = ${schema.orders.id} and ${PRIMARY_ATTEMPT}`)
    .where(eq(schema.orders.id, orderId));
  const rows = await db.query.shipments.findMany({ where: eq(schema.shipments.orderId, orderId) });
  const ts = vanDonDaiDien(withHandoff(rows, await handedOffShipmentIds(db, rows.map((x) => x.id))));
  assert.equal(ts?.id, r.id, `[${orderId}] SQL và TypeScript phải chọn CÙNG lần gửi chính`);
  return r;
}

async function donDep() {
  const db = await getDb();
  const ids = (await db.select({ id: schema.shipments.id }).from(schema.shipments).where(or(like(schema.shipments.id, "vro-%"), like(schema.shipments.id, "erp-vro-%")))).map((r) => r.id);
  if (ids.length) {
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  }
  await db.delete(schema.canonicalOrderOutcome).where(or(like(schema.canonicalOrderOutcome.orderId, "vro-%"), like(schema.canonicalOrderOutcome.orderId, "erp-vro-%")));
  await db.delete(schema.orders).where(or(like(schema.orders.id, "vro-%"), like(schema.orders.id, "erp-vro-%")));
  clearMemo();
}

export async function testVtpReshipOutcome() {
  try {
    // ── 1a. Ca 27 đơn đo 22/10: lần mới bị huỷ, lần cũ CHƯA TỪNG được lấy ⇒ không đổi — lần mới vẫn quyết.
    await seed("vro-27", "CANCELLED", [
      { n: 1, stage: "PENDING", events: [["100", "PENDING"]] },
      { n: 2, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
    ]);
    const a = await primaryOf("vro-27");
    assert.equal(a.id, "vro-27-s2", "vận đơn PENDING đứng yên không phải bằng chứng hàng đang đi ⇒ thứ tự cũ");
    assert.equal(a.outcome, "CANCELLED");

    // ── 1b. Lần cũ ĐÃ BÀN GIAO (đang đi), lần tạo lại bị VTP huỷ ⇒ lần cũ quyết.
    await seed("vro-song", "SHIPPED", [
      { n: 1, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"], ["300", "IN_TRANSIT"]] },
      { n: 2, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
    ]);
    const b = await primaryOf("vro-song");
    assert.equal(b.id, "vro-song-s1", "lần gửi CÒN SỐNG (có bàn giao, chưa huỷ) thắng attempt_no cao hơn mà đã huỷ");
    assert.equal(b.outcome, "IN_TRANSIT");

    // ── 2. Pancake huỷ đơn gốc, shop gửi lại trên web VTP ⇒ chứng từ của lần gửi thay thế thắng.
    await seed("vro-gl", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"], ["300", "IN_TRANSIT"]] },
    ]);
    const c = await primaryOf("vro-gl");
    assert.deepEqual([c.id, c.outcome], ["vro-gl-s2", "IN_TRANSIT"], "Pancake «Đã hủy» + lần gửi thay thế đang đi ⇒ IN_TRANSIT (mục 3.2)");
    await seed("vro-mot", "CANCELLED", [{ n: 1, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"], ["300", "IN_TRANSIT"]] }]);
    assert.equal((await primaryOf("vro-mot")).outcome, "CANCELLED", "chỉ MỘT lần gửi ⇒ luật cũ giữ nguyên (đơn huỷ khi hàng đang đi vẫn là huỷ)");
    await seed("vro-gl107", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "CANCELLED", events: [["200", "PICKED_UP"], ["107", "CANCELLED"]] },
    ]);
    assert.equal((await primaryOf("vro-gl107")).outcome, "CANCELLED", "lần gửi thay thế mang mã huỷ 107 ⇒ CANCELLED như cũ");
    assert.equal(c.verified, "IN_TRANSIT", "chiều tiền thật cùng kết luận: lần gửi thay thế đang đi ⇒ ĐANG GIAO, không HUỶ");

    // ── 2b. Lần gửi lại tạo rồi BỎ (PENDING, ĐVVC chưa từng cầm hàng, không ai huỷ) ⇒ không làm đơn Pancake «Đã hủy» sống lại.
    await seed("vro-bo", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "PENDING", events: [["100", "PENDING"]] },
    ]);
    assert.equal((await primaryOf("vro-bo")).outcome, "CANCELLED", "vận đơn đứng yên không phải bằng chứng đơn còn sống — không «chờ lấy» vô thời hạn");

    // ── 2c. Đơn TAY ERP do NGƯỜI huỷ: lần gửi 2 chờ lấy / đang đi vẫn ⇒ CANCELLED (mục 11.5 «Người huỷ đơn ⇒ CANCELLED như cũ»).
    await seed("erp-vro-cho", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "PENDING", events: [["100", "PENDING"]] },
    ]);
    assert.equal((await primaryOf("erp-vro-cho")).outcome, "CANCELLED", "đơn tay người huỷ + lần gửi 2 chờ lấy ⇒ CANCELLED");
    await seed("erp-vro-di", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"], ["300", "IN_TRANSIT"]] },
    ]);
    const e = await primaryOf("erp-vro-di");
    assert.deepEqual([e.outcome, e.verified], ["CANCELLED", "CANCELLED"], "đơn tay người huỷ + lần gửi 2 đang đi ⇒ CANCELLED ở cả hai chiều");

    // ── 2d. Lần gửi thay thế GIAO THÀNH CÔNG, COD thật 450.000 ⇒ logistics và tiền thật cùng nói ĐÃ GIAO (trước đây tiền thật = HUỶ).
    await seed("vro-giao", "CANCELLED", [
      { n: 1, stage: "CANCELLED", events: [["107", "CANCELLED"]] },
      { n: 2, stage: "DELIVERED", events: [["200", "PICKED_UP"], ["300", "IN_TRANSIT"], ["501", "DELIVERED"]], cod: 450_000 },
    ]);
    const g = await primaryOf("vro-giao");
    assert.deepEqual([g.id, g.outcome, g.verified], ["vro-giao-s2", "DELIVERED", "DELIVERED"], "một đơn không vừa DELIVERED (logistics) vừa CANCELLED (tiền thật)");

    // ── 3. Sổ kho: lần cũ đã được lấy rồi bị huỷ, lần tạo lại CHƯA được lấy ⇒ đơn vẫn «đã xuất».
    await seed("vro-kho", "CONFIRMED", [
      { n: 1, stage: "CANCELLED", events: [["200", "PICKED_UP"], ["107", "CANCELLED"]], pickedUp: true },
      { n: 2, stage: "PENDING", events: [["100", "PENDING"]] },
    ]);
    const d = await primaryOf("vro-kho");
    assert.equal(d.id, "vro-kho-s2", "không lần nào còn sống ⇒ lần gửi chính là lần mới");
    assert.deepEqual([d.left, d.reserved], [true, false], "hàng đã đi bằng lần cũ KHÔNG «quay lại» chờ xuất — đơn vẫn đã xuất, đếm một lần");

    // Hai lần gửi chiều đi cùng rời kho ⇒ cảnh báo đối soát cho người (không trừ tồn hai lần).
    await seed("vro-hai", "SHIPPED", [
      { n: 1, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"]], pickedUp: true },
      { n: 2, stage: "IN_TRANSIT", events: [["200", "PICKED_UP"]], pickedUp: true },
    ]);
    assert.equal((await primaryOf("vro-hai")).left, true);
    clearMemo();
    const thap = await getControlTower();
    const luat = thap.issues.find((i) => i.rule === "ORDER_DOUBLE_LEFT_WAREHOUSE");
    assert.ok(luat && luat.count >= 1, `hai lần gửi cùng rời kho ⇒ ORDER_DOUBLE_LEFT_WAREHOUSE: ${JSON.stringify(luat ?? null)}`);
    console.log("✓ Gửi lại trên web VTP (ORDER_OUTCOME.md mục 12): lần gửi chính = lần còn sống (bàn giao ∧ chưa huỷ), SQL ≡ TS · ca 27 đơn PENDING đứng yên không đổi · Pancake huỷ + lần thay thế đang đi ⇒ IN_TRANSIT · một lần gửi / mã 107 / lần gửi lại đứng yên / đơn tay người huỷ ⇒ CANCELLED · tiền thật cùng kết luận · đã xuất theo đơn · hai lần rời kho ⇒ cảnh báo");
  } finally {
    await donDep();
  }
}
