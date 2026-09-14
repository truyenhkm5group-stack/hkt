import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { DIMENSION_LABEL, WEIGHT_LABEL, sourceWeight } from "@/lib/constants/timeline";
import { getOrderTimeline } from "@/lib/queries/entity-timeline";

/**
 * DÒNG THỜI GIAN TRUY VẾT.
 *
 * Điều phải khoá: mỗi mốc phải nói được nó thuộc CHIỀU nào và đến từ NGUỒN nào, và nguồn của
 * Viettel Post phải có sức nặng khác nguồn Pancake. Trộn chung mà không phân biệt sẽ khiến người
 * đọc kết luận "đã giao" từ một dòng không đủ tư cách kết luận điều đó.
 */
export async function testEntityTimeline(db: Db) {
  // Chọn một đơn CÓ vận đơn để dòng thời gian đi qua nhiều chiều nhất.
  const [order] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(sql`exists (select 1 from shipments sh where sh.order_id = ${schema.orders.id})`)
    .limit(1);
  assert.ok(order, "fixture phải có ít nhất một đơn gắn vận đơn");

  const timeline = await getOrderTimeline(order.id);
  assert.ok(timeline.length > 0, "đơn có vận đơn phải có ít nhất vài mốc");

  // ───────── 1. Xếp theo thời gian, mới nhất trước ─────────
  for (let i = 1; i < timeline.length; i += 1) {
    assert.ok(timeline[i - 1].at.getTime() >= timeline[i].at.getTime(), "dòng thời gian phải xếp giảm dần theo thời gian");
  }

  // ───────── 2. Mỗi mốc phải nói được CHIỀU và NGUỒN ─────────
  for (const e of timeline) {
    assert.ok(DIMENSION_LABEL[e.dimension], `${e.title}: chiều phải hợp lệ`);
    assert.ok(e.source.length > 0, `${e.title}: phải ghi nguồn`);
    assert.ok(e.title.length > 0 && e.detail.length > 0, `${e.id}: phải có tiêu đề và chi tiết`);
    assert.ok(e.at instanceof Date && !Number.isNaN(e.at.getTime()), `${e.title}: mốc thời gian phải hợp lệ`);
    assert.ok(WEIGHT_LABEL[sourceWeight(e.source)], `${e.source}: phải phân loại được sức nặng bằng chứng`);
  }

  // ───────── 3. Nguồn ĐVVC quyết định kết quả đơn; Pancake thì KHÔNG ─────────
  // Đây là ranh giới cốt lõi của toàn ERP, và dòng thời gian không được làm mờ nó đi.
  assert.equal(sourceWeight("VTP_WEBHOOK"), "DECIDES", "sự kiện Viettel Post quyết định kết quả đơn");
  assert.equal(sourceWeight("VTP_UI_MANUAL_VERIFICATION"), "DECIDES", "chứng từ chủ shop chép tay từ web VTP cũng là chứng từ ĐVVC");
  assert.equal(sourceWeight("PANCAKE"), "CONTEXT", "trạng thái Pancake CHỈ là bối cảnh, không kết luận được gì về giao vận");
  assert.equal(sourceWeight("Bảng kê BK-2026-09-01"), "DECIDES", "dòng chứng từ bảng kê là bằng chứng tiền có sức nặng");

  // ───────── 4. Đơn không tồn tại thì trả rỗng, không nổ ─────────
  assert.deepEqual(await getOrderTimeline("khong-co-don-nay"), [], "đơn không tồn tại phải trả về rỗng");

  const dims = new Set(timeline.map((e) => e.dimension));
  console.log(
    `✓ Dòng thời gian đơn hàng: ${timeline.length} mốc qua ${dims.size} chiều (${[...dims].map((d) => DIMENSION_LABEL[d]).join(", ")}) · mỗi mốc ghi rõ nguồn và sức nặng bằng chứng`,
  );
}
