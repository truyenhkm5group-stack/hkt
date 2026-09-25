import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { type Db, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CANCEL_MATCHES, classifyCancelled, type CancelledOrder } from "@/lib/constants/cancel-analysis";
import { cancelAgeBucket } from "@/lib/constants/conversion";
import { getCancelAnalysis } from "@/lib/queries/cancel-analysis";
import { getConversionFunnel } from "@/lib/queries/conversion-funnel";
import type { Period } from "@/lib/search-params";
import { cancelAnalysisLines } from "@/scripts/confirm-funnel-audit";

/**
 * ═══════════ ĐƠN HUỶ: MẤT THẬT HAY ĐÃ CÓ ĐƠN THAY ═══════════
 *
 * Khoá bốn điều:
 *  1. Phân loại dùng ĐÚNG luật đơn trùng (cùng SĐT, cửa sổ, tập mặt hàng) — cùng mẫu mã ⇒ lên lại;
 *     chồng lấn ⇒ có thể lên lại; khác mẫu mã ⇒ vẫn là MẤT (luật của shop: hai đơn hợp lệ).
 *  2. Không đủ SĐT là CHƯA BIẾT, không gộp vào "mất thật".
 *  3. Tổng huỷ trước / sau xác nhận BẰNG số của phễu — một vị từ, không phải hai.
 *  4. Huỷ sau xác nhận tách đúng khâu (chưa vận đơn / chưa bàn giao / đã bàn giao) và tuổi tính từ
 *     lúc XÁC NHẬN, không phải lúc lên đơn.
 *
 * Phần CSDL dùng một kỳ CỐ ĐỊNH (tháng 5/2016) — không "N ngày trước" (AGENTS.md mục 50).
 */

const H = 3_600_000;

function don(id: string, phone: string, at: Date, items: { v: string; q: number }[]): CancelledOrder {
  return { orderId: id, insertedAt: at, phone, receiverName: "", address: "", total: 0, items: items.map((x) => ({ variantId: x.v, sku: "", productName: "", variationDetail: "", quantity: x.q })) };
}

export function testCancelAnalysisPure() {
  const t = new Date("2020-01-01T00:00:00Z");
  const huy = don("x", "0987650001", t, [{ v: "V1", q: 1 }]);
  assert.equal(classifyCancelled(huy, [], 48), "LOST", "không có đơn nào thay ⇒ mất thật");
  assert.equal(classifyCancelled(don("x", "12", t, []), [], 48), "NO_PHONE", "SĐT không đủ 9 số ⇒ chưa biết, KHÔNG phải mất");
  assert.equal(classifyCancelled(huy, [don("a", "+84 987 650 001", new Date(t.getTime() + 2 * H), [{ v: "V1", q: 1 }])], 48), "REPLACED_SAME_ITEMS", "cùng SĐT (khác cách viết), cùng mẫu mã ⇒ đơn được lên lại");
  assert.equal(classifyCancelled(huy, [don("a", "0987650001", new Date(t.getTime() + 2 * H), [{ v: "V1", q: 1 }, { v: "V2", q: 1 }])], 48), "REPLACED_OVERLAP");
  assert.equal(classifyCancelled(huy, [don("a", "0987650001", new Date(t.getTime() + 2 * H), [{ v: "V9", q: 1 }])], 48), "SAME_CUSTOMER_OTHER", "khác mẫu mã ⇒ hai đơn hợp lệ, món trong đơn huỷ vẫn bị mất");
  assert.equal(classifyCancelled(huy, [don("a", "0911111111", new Date(t.getTime() + 2 * H), [{ v: "V1", q: 1 }])], 48), "LOST", "khác SĐT thì không phải đơn thay");
  const xa = [don("a", "0987650001", new Date(t.getTime() + 72 * H), [{ v: "V1", q: 1 }])];
  assert.equal(classifyCancelled(huy, xa, 48), "LOST", "ngoài cửa sổ luật ⇒ không tính là đơn thay");
  assert.equal(classifyCancelled(huy, xa, 168), "REPLACED_SAME_ITEMS", "cửa sổ nới 7 ngày thì có");
  assert.equal(classifyCancelled(huy, [don("x", "0987650001", t, [{ v: "V1", q: 1 }])], 48), "LOST", "chính nó không phải đơn thay của nó");
  // Có cả anh em khác mẫu và anh em cùng mẫu ⇒ lấy kết luận MẠNH nhất.
  assert.equal(
    classifyCancelled(huy, [don("a", "0987650001", new Date(t.getTime() + H), [{ v: "V9", q: 1 }]), don("b", "0987650001", new Date(t.getTime() + 3 * H), [{ v: "V1", q: 1 }])], 48),
    "REPLACED_SAME_ITEMS",
  );

  assert.equal(cancelAgeBucket(0.5), "H0_1");
  assert.equal(cancelAgeBucket(1), "H1_6", "cận trên HỞ");
  assert.equal(cancelAgeBucket(72), "D3");
  assert.equal(cancelAgeBucket(-1), null, "mốc ngược ⇒ không đo được");
  assert.equal(cancelAgeBucket(null), null);
  console.log(`✓ Phân tích đơn huỷ (thuần): ${CANCEL_MATCHES.length} loại theo luật đơn trùng · khác mẫu mã vẫn là mất · thiếu SĐT là chưa biết · cửa sổ luật và cửa sổ 7 ngày tách rời`);
}

const KY: Period = { key: "custom", from: new Date("2016-04-30T17:00:00Z"), to: new Date("2016-05-31T16:59:59Z"), label: "Tháng 5/2016 (bài kiểm đơn huỷ)", fromKey: "2016-05-01", toKey: "2016-05-31" };
const P = "cax-";

async function cleanup(db: Db) {
  const ids = ["pre-rep", "pre-rep-new", "pre-lost", "pre-del", "post-a", "post-a-other", "post-b", "post-c"].map((x) => `${P}${x}`);
  await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, ids));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ids));
}

export async function testCancelAnalysisDb(db: Db) {
  await cleanup(db);
  const t = new Date("2016-05-10T03:00:00Z");
  const at = (h: number) => new Date(t.getTime() + h * H);
  const order = (id: string, stage: string, status: number, phone: string, inserted: Date) => ({ id: `${P}${id}`, stage: stage as never, status, billPhone: phone, insertedAt: inserted, totalPriceAfterDiscount: 400_000, source: "Facebook" });
  await db.insert(schema.orders).values([
    order("pre-rep", "CANCELLED", 6, "0987650011", t), // huỷ khi chưa xác nhận…
    order("pre-rep-new", "CONFIRMED", 1, "0987650011", at(2)), // …vì đã lên lại đơn mới cùng mẫu
    order("pre-lost", "CANCELLED", 6, "0987650022", t),
    order("pre-del", "DELETED", 7, "12", t),
    order("post-a", "CANCELLED", 6, "0987650033", t), // xác nhận rồi huỷ trước khi tạo vận đơn
    order("post-a-other", "CONFIRMED", 1, "0987650033", at(1)), // khách có đơn khác nhưng KHÁC mẫu
    order("post-b", "CANCELLED", 6, "0987650044", t), // có vận đơn, ĐVVC chưa lấy
    order("post-c", "CANCELLED", 6, "0987650055", t), // ĐVVC đã cầm hàng rồi huỷ
  ]);
  const item = (id: string, v: string) => ({ id: `${P}${id}-i`, orderId: `${P}${id}`, productId: null, variantId: null, sku: v, productName: "Đầm kiểm huỷ", quantity: 1, unitPrice: 400_000, lineTotal: 400_000 });
  await db.insert(schema.orderItems).values([item("pre-rep", "CAX-V1"), item("pre-rep-new", "CAX-V1"), item("pre-lost", "CAX-V1"), item("post-a", "CAX-V1"), item("post-a-other", "CAX-V9")]);
  await db.insert(schema.orderStatusHistory).values([
    { orderId: `${P}pre-rep`, status: 6, updatedAt: at(1) },
    { orderId: `${P}pre-lost`, status: 0, updatedAt: t },
    { orderId: `${P}pre-lost`, status: 6, updatedAt: at(30) },
    { orderId: `${P}post-a`, status: 1, updatedAt: at(1) },
    { orderId: `${P}post-a`, status: 6, updatedAt: at(3) },
    { orderId: `${P}post-b`, status: 1, updatedAt: at(1) },
    { orderId: `${P}post-b`, status: 6, updatedAt: at(50) },
    { orderId: `${P}post-c`, status: 1, updatedAt: at(1) },
    { orderId: `${P}post-c`, status: 6, updatedAt: at(100) },
  ]);
  await db.insert(schema.shipments).values([
    { orderId: `${P}post-b`, vtpOrderNumber: "CAX-VB", stage: "PENDING" as never },
    { orderId: `${P}post-c`, vtpOrderNumber: "CAX-VC", stage: "CANCELLED" as never, pickedUpAt: at(20) },
  ]);

  try {
    clearMemo();
    const a = await getCancelAnalysis(KY, { fresh: true });
    const f = await getConversionFunnel(KY);
    assert.equal(a.pre.total, f.preConfirmCancel.count, "tổng huỷ trước XN phải BẰNG số của phễu — một vị từ");
    assert.equal(a.post.total, f.cancelledAfterConfirm, "tổng huỷ sau XN phải BẰNG số của phễu");
    assert.equal(a.pre.total, 3);
    assert.equal(a.pre.byMatch.REPLACED_SAME_ITEMS, 1, "đơn huỷ đã có đơn mới cùng mẫu, xác nhận 2 giờ sau ⇒ KHÔNG phải khách mất");
    assert.equal(a.pre.byMatch.LOST, 1);
    assert.equal(a.pre.byMatch.NO_PHONE, 1);
    assert.equal(a.pre.lost, 1, "mất thật KHÔNG gồm đơn thiếu SĐT");
    assert.equal(a.pre.replaced, 1);
    assert.equal(a.pre.deleted, 1);
    assert.equal(a.pre.ageBuckets.find((b) => b.key === "D1_3")?.count, 1, "Mới → huỷ sau 30 giờ ⇒ khoảng 1–3 ngày");

    assert.equal(a.post.total, 3);
    assert.equal(a.post.byStage.BEFORE_SHIPMENT, 1);
    assert.equal(a.post.byStage.BEFORE_HANDOFF, 1, "có vận đơn nhưng ĐVVC chưa cầm hàng");
    assert.equal(a.post.byStage.AFTER_HANDOFF, 1, "ĐVVC đã cầm hàng rồi huỷ");
    assert.equal(a.post.byMatch.SAME_CUSTOMER_OTHER, 1, "khách có đơn khác nhưng khác mẫu ⇒ món trong đơn huỷ vẫn là mất");
    assert.equal(a.post.lost, 3);
    assert.equal(a.post.ageBuckets.find((b) => b.key === "H1_6")?.count, 1, "post-a: xác nhận giờ 1, huỷ giờ 3 ⇒ 2 giờ TÍNH TỪ LÚC XÁC NHẬN");
    assert.equal(a.post.ageBuckets.find((b) => b.key === "D1_3")?.count, 1, "post-b: 49 giờ sau xác nhận");
    assert.equal(a.post.ageBuckets.find((b) => b.key === "D3")?.count, 1, "post-c: 99 giờ sau xác nhận");
    const fb = a.bySource.find((r) => r.pre > 0);
    assert.ok(fb && fb.pre === 3 && fb.preLost === 1 && fb.post === 3 && fb.postLost === 3);

    const lines = cancelAnalysisLines(a);
    assert.ok(lines.every((l) => !l.includes("0987650011")), "tóm tắt ops không in SĐT");
    assert.ok(lines.some((l) => l.startsWith("HUỶ TRƯỚC XÁC NHẬN: 3 đơn")));
  } finally {
    await cleanup(db);
  }
  console.log("✓ Phân tích đơn huỷ (CSDL): tổng khớp phễu · đơn được lên lại không tính là mất · huỷ sau XN tách đúng ba khâu · tuổi lúc huỷ tính từ lúc xác nhận");
}
