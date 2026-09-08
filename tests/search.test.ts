import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { searchEntities } from "@/lib/queries/search";

/**
 * TÌM KIẾM TOÀN HỆ THỐNG.
 *
 * Điều phải khoá: MỘT SỐ ĐIỆN THOẠI KHÔNG PHẢI MỘT ĐƠN. Cùng một số có thể có nhiều đơn và nhiều
 * vận đơn (mua nhiều lần, gửi lại, vận đơn chiều hoàn). Tìm kiếm phải trả về TẤT CẢ và nói rõ có
 * bao nhiêu — tuyệt đối không nhảy thẳng vào cái đầu tiên.
 */
export async function testSearch(db: Db) {
  // Từ khoá quá ngắn không được quét cả bảng.
  const tooShort = await searchEntities("a");
  assert.equal(tooShort.hits.length, 0, "dưới 2 ký tự thì không tìm gì cả");

  // ───────── Số điện thoại có nhiều đơn ─────────
  const [busiest] = await db
    .select({ phone: schema.orders.billPhone, n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(sql`${schema.orders.billPhone} <> ''`)
    .groupBy(schema.orders.billPhone)
    .orderBy(sql`count(*) desc`)
    .limit(1);

  if (busiest && Number(busiest.n) > 1) {
    const r = await searchEntities(busiest.phone);
    const orderHits = r.hits.filter((h) => h.kind === "ORDER");
    assert.ok(orderHits.length > 1, "một số điện thoại có nhiều đơn PHẢI trả về nhiều dòng, không phải một");
    assert.equal(r.counts.orders, Number(busiest.n), "phải nói đúng tổng số đơn của số này, kể cả khi chỉ hiện vài dòng");
    assert.ok(r.ambiguous, "khớp nhiều bản ghi thì PHẢI cảnh báo để không ai tưởng dòng đầu là dòng duy nhất");
    assert.ok(r.ambiguous.includes(String(r.counts.orders)), "cảnh báo phải nói rõ có bao nhiêu bản ghi");
  }

  // ───────── Mọi kết quả phải mở được và nói đủ để chọn ─────────
  const [anyOrder] = await db.select({ id: schema.orders.id, phone: schema.orders.billPhone }).from(schema.orders).where(sql`${schema.orders.billPhone} <> ''`).limit(1);
  if (anyOrder) {
    const r = await searchEntities(anyOrder.phone);
    for (const h of r.hits) {
      assert.ok(h.href.startsWith("/"), `${h.title}: phải mở được bằng đường dẫn nội bộ`);
      assert.ok(h.title.length > 0, "mỗi kết quả phải có tiêu đề");
      // Phụ đề là thứ giúp phân biệt hai đơn của CÙNG một khách — thiếu nó thì người dùng phải mở
      // từng cái ra mới biết cái nào là cái mình cần.
      assert.ok(h.subtitle.length > 0, `${h.title}: phải có phụ đề để phân biệt được với bản ghi cùng loại`);
      assert.ok(["ORDER", "SHIPMENT", "CUSTOMER", "PRODUCT"].includes(h.kind));
    }
  }

  // ───────── Vận đơn tra được bằng mã, kể cả vận đơn KHÔNG gắn đơn ─────────
  const [orphan] = await db
    .select({ code: schema.shipments.vtpOrderNumber })
    .from(schema.shipments)
    .where(sql`${schema.shipments.orderId} is null and ${schema.shipments.vtpOrderNumber} is not null`)
    .limit(1);
  if (orphan?.code) {
    const r = await searchEntities(orphan.code);
    const hit = r.hits.find((h) => h.kind === "SHIPMENT");
    assert.ok(hit, "vận đơn không gắn đơn vẫn phải tra được — đó là vận đơn chiều hoàn, hoàn toàn bình thường");
    assert.ok(hit.subtitle.includes("không gắn đơn"), "phải nói rõ vận đơn này không gắn đơn nào, thay vì để trống khó hiểu");
  }

  const sample = await searchEntities(anyOrder?.phone ?? "0");
  console.log(
    `✓ Tìm kiếm toàn hệ thống: ${sample.hits.length} kết quả cho một số điện thoại · trả về NHIỀU đơn/vận đơn thay vì đoán một · cảnh báo khi khớp nhiều bản ghi`,
  );
}
