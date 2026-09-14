import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CUSTOMER_OUTCOMES, CUSTOMER_OUTCOME_LABEL, outreachEligibility } from "@/lib/constants/outreach-segment";
import { outreachOutcomeFacet } from "@/lib/queries/outreach";

/**
 * ═══════ KHÁCH NHẬN HÀNG VÀ KHÁCH HOÀN HÀNG PHẢI TÁCH ĐƯỢC ═══════
 *
 * Trang bán chéo chỉ dựng danh sách từ đơn `DELIVERED`, nên khách hoàn hàng và khách đang giao
 * đơn giản là KHÔNG TỒN TẠI trên màn hình — không chạy được chiến dịch hỏi lý do, và không ai
 * thấy danh sách đang đại diện cho bao nhiêu phần khách hàng.
 *
 * Đo production 13/09/2026: 936 khách từng có đơn HOÀN so với 485 khách từng có đơn GIAO THÀNH
 * CÔNG. Đó cũng là lý do luật lấy ĐƠN GẦN NHẤT chứ không phải "từng hoàn": lấy "từng hoàn" làm
 * nhãn thì gần hết khách quen bị dán nhãn xấu.
 */

/* ───── 1 · Chính sách mời mua theo kết quả ───── */
export function testOutreachEligibility() {
  const d = outreachEligibility("DELIVERED");
  assert.equal(d.allowed, true);
  assert.equal(d.campaign, "CROSS_SELL");

  const r = outreachEligibility("RETURNED");
  assert.equal(r.allowed, true, "khách hoàn vẫn nhắn được — nhưng bằng kịch bản khác");
  assert.equal(r.campaign, "RECOVERY", "KHÔNG dùng kịch bản bán chéo cho khách vừa hoàn hàng");

  const p = outreachEligibility("PENDING");
  assert.equal(p.allowed, false, "khách còn đang chờ hàng thì KHÔNG mời mua thêm");
  assert.ok(p.reason.includes("chặn tin"), "và nói rõ cái giá phải trả nếu vẫn nhắn");

  const u = outreachEligibility("UNKNOWN");
  assert.equal(u.allowed, false, "chưa kết luận được lần mua gần nhất thì nhắn lúc này là đoán");

  for (const o of CUSTOMER_OUTCOMES) assert.ok(CUSTOMER_OUTCOME_LABEL[o], `${o}: thiếu nhãn tiếng Việt`);
  console.log("✓ Chính sách mời mua: đã nhận ⇒ bán chéo · đã hoàn ⇒ hỏi lý do trước · đang giao và chưa xác định ⇒ chưa nhắn");
}

/* ───── 2 · Phân loại chạy thật trên CSDL, đọc lại ORDER_OUTCOME ───── */
export async function testOutreachOutcomeFacet(db: Db) {
  const P = "oseg-";
  try {
    const mk = async (suffix: string, outcome: string, insertedAt: Date) => {
      const oid = `${P}o-${suffix}`;
      await db.insert(schema.orders).values({ id: oid, stage: "CONFIRMED", status: 2, insertedAt, billPhone: `090000${suffix}`, billFullName: `Khách ${suffix}`, totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
      await db.insert(schema.canonicalOrderOutcome).values({ id: `${P}k-${suffix}`, orderId: oid, shipmentId: null, outcome, cogs: 0 }).onConflictDoNothing();
      await db
        .insert(schema.outreachTargets)
        .values({ id: `${P}t-${suffix}`, segment: `${P}SEG`, status: "PENDING", pageId: "", conversationId: "", pancakeCustomerId: "", customerName: `Khách ${suffix}`, phone: `090000${suffix}`, message: "x", dedupeKey: `${P}t-${suffix}` })
        .onConflictDoNothing();
    };
    await mk("1001", "DELIVERED", new Date("2026-08-01"));
    await mk("1002", "RETURNED", new Date("2026-08-01"));
    await mk("1003", "RETURNED_BY_RULE", new Date("2026-08-01"));
    await mk("1004", "IN_TRANSIT", new Date("2026-08-01"));
    // Khách KHÔNG có đơn nào ⇒ CHƯA XÁC ĐỊNH, không phải "đã hoàn".
    await db
      .insert(schema.outreachTargets)
      .values({ id: `${P}t-none`, segment: `${P}SEG`, status: "PENDING", pageId: "", conversationId: "", pancakeCustomerId: "", customerName: "Không đơn", phone: "0900009999", message: "x", dedupeKey: `${P}t-none` })
      .onConflictDoNothing();

    const facet = await outreachOutcomeFacet(`${P}SEG`);
    const dem = (v: string) => facet.find((f) => f.value === v)?.count ?? 0;
    assert.equal(dem("DELIVERED"), 1, "đơn giao thành công ⇒ Đã nhận hàng");
    assert.equal(dem("RETURNED"), 2, "RETURNED và RETURNED_BY_RULE cùng là Đã hoàn hàng — hai cái đều là hoàn");
    assert.equal(dem("PENDING"), 1, "đơn đang chạy ⇒ Đang giao");
    assert.equal(dem("UNKNOWN"), 1, "khách chưa có đơn nào ⇒ CHƯA XÁC ĐỊNH, KHÔNG được xếp nhầm vào nhóm nào khác");
    assert.equal(facet.length, 4, "đủ bốn nhóm, kể cả nhóm rỗng — nhóm biến mất là nhóm không ai đi tìm");

    /*
      ĐƠN GẦN NHẤT QUYẾT ĐỊNH, KHÔNG PHẢI "TỪNG HOÀN".

      Khách 1001 nay có thêm một đơn HOÀN mới hơn ⇒ nhãn phải chuyển sang Đã hoàn hàng. Nếu luật
      là "từng hoàn" thì một khách mua mười lần hoàn một lần cũng mang nhãn xấu vĩnh viễn.
    */
    await db.insert(schema.orders).values({ id: `${P}o-1001b`, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-09-01"), billPhone: "0900001001", billFullName: "Khách 1001", totalPriceAfterDiscount: 100_000 }).onConflictDoNothing();
    await db.insert(schema.canonicalOrderOutcome).values({ id: `${P}k-1001b`, orderId: `${P}o-1001b`, shipmentId: null, outcome: "RETURNED", cogs: 0 }).onConflictDoNothing();
    const sau = await outreachOutcomeFacet(`${P}SEG`);
    const demSau = (v: string) => sau.find((f) => f.value === v)?.count ?? 0;
    assert.equal(demSau("DELIVERED"), 0, "đơn hoàn MỚI HƠN thì nhãn chuyển — 'từng giao thành công' không giữ nhãn tốt mãi");
    assert.equal(demSau("RETURNED"), 3);

    console.log("✓ Phân loại khách bán chéo: đọc lại ORDER_OUTCOME (không dùng Pancake, không suy từ COD) · RETURNED_BY_RULE cũng là hoàn · chưa có đơn ⇒ CHƯA XÁC ĐỊNH · đơn GẦN NHẤT quyết định nhãn");
  } finally {
    await db.delete(schema.outreachTargets).where(sql`${schema.outreachTargets.id} like ${`${P}%`}`);
    await db.delete(schema.canonicalOrderOutcome).where(sql`${schema.canonicalOrderOutcome.id} like ${`${P}%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}%`}`);
  }
}
