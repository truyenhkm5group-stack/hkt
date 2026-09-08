import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { ORDER_SOURCE } from "@/lib/queries/order-source";
import { getReturnRateBySource, getReturnRateSummary } from "@/lib/queries/return-rate";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * NGUỒN ĐƠN: chat fanpage Facebook vs landing page.
 *
 * Hai điều phải đúng, nếu không con số chia theo nguồn sẽ vô dụng:
 *   1. Cộng các nguồn lại phải BẰNG tổng toàn shop — mỗi đơn thuộc đúng một nguồn, không đơn nào
 *      bị đếm hai lần hay rơi ra ngoài. Một đơn Pancake có thể có nhiều dòng landing trỏ tới (khách
 *      gửi form hai lần) nên phải dùng `exists`, join sẽ nhân đôi.
 *   2. Đơn có mặt ở cả hai kênh ghi cho nơi khách ĐẶT TRƯỚC — quy tắc chủ shop chốt.
 *
 * Và tuyệt đối không được đẻ ra định nghĩa "giao thành công" thứ hai: tỷ lệ theo nguồn phải dùng
 * lại đúng ORDER_OUTCOME như bảng tổng hợp.
 */
export async function testOrderSource() {
  const db = await getDb();
  const luc = (lech: number) => new Date(Date.now() + lech * 86_400_000);

  await db.insert(schema.orders).values([
    // Đơn chốt trong chat fanpage.
    { id: "ns-fb-1", systemId: 990001, stage: "DELIVERED", insertedAt: luc(-20), conversationId: "conv-1", pageId: "page-1", source: "Facebook", totalPriceAfterDiscount: 499000 },
    // Đơn từ landing, không có chat.
    { id: "ns-lp-1", systemId: 990002, stage: "DELIVERED", insertedAt: luc(-19), source: "Khác", totalPriceAfterDiscount: 499000 },
    // Đơn có CẢ hai dấu vết, khách điền form TRƯỚC khi đơn được tạo ⇒ landing.
    { id: "ns-ca-hai-landing-truoc", systemId: 990003, stage: "DELIVERED", insertedAt: luc(-10), conversationId: "conv-3", source: "Facebook", totalPriceAfterDiscount: 499000 },
    // Đơn có CẢ hai dấu vết, khách chốt trong chat TRƯỚC rồi mới điền form ⇒ facebook.
    { id: "ns-ca-hai-chat-truoc", systemId: 990004, stage: "DELIVERED", insertedAt: luc(-10), conversationId: "conv-4", source: "Facebook", totalPriceAfterDiscount: 499000 },
    // Đơn không dấu vết kênh nào ⇒ nguồn khác.
    { id: "ns-khac-1", systemId: 990005, stage: "DELIVERED", insertedAt: luc(-8), source: "Khác", totalPriceAfterDiscount: 499000 },
  ]).onConflictDoNothing();

  await db.insert(schema.landingOrders).values([
    { rowKey: "ns-row-1", submittedAt: luc(-20), orderId: "ns-lp-1", phone: "0900000001" },
    { rowKey: "ns-row-2", submittedAt: luc(-11), orderId: "ns-ca-hai-landing-truoc", phone: "0900000003" },
    // Khách gửi form SAU khi đã chốt đơn trong chat.
    { rowKey: "ns-row-3", submittedAt: luc(-9), orderId: "ns-ca-hai-chat-truoc", phone: "0900000004" },
    // Cùng một đơn nhưng khách gửi form hai lần — không được làm đơn bị đếm hai lần.
    { rowKey: "ns-row-4", submittedAt: luc(-19), orderId: "ns-lp-1", phone: "0900000001" },
  ]).onConflictDoNothing();
  clearMemo();

  const theoNguon = await getReturnRateBySource(ALL, "");

  // ───────── 1. Từng đơn được gán đúng nguồn ─────────
  const nguon = new Map(
    (await db
      .select({ id: schema.orders.id, nguon: ORDER_SOURCE })
      .from(schema.orders)
      .where(sql`${schema.orders.id} like 'ns-%'`)).map((r) => [r.id, r.nguon]),
  );
  assert.equal(nguon.get("ns-fb-1"), "FACEBOOK", "đơn chốt trong chat fanpage");
  assert.equal(nguon.get("ns-lp-1"), "LANDING", "đơn từ form landing, không có chat");
  assert.equal(nguon.get("ns-khac-1"), "OTHER", "không dấu vết kênh nào thì là nguồn khác");
  assert.equal(nguon.get("ns-ca-hai-landing-truoc"), "LANDING",
    "khách điền form TRƯỚC khi đơn được tạo ⇒ ghi cho landing");
  assert.equal(nguon.get("ns-ca-hai-chat-truoc"), "FACEBOOK",
    "khách đã chốt đơn trong chat rồi mới điền form ⇒ ghi cho facebook");

  // ───────── 2. Cộng các nguồn = tổng toàn shop ─────────
  const tong = await getReturnRateSummary(ALL, "");
  const cong = (f: (r: (typeof theoNguon)[number]) => number) => theoNguon.reduce((t, r) => t + f(r), 0);
  assert.equal(cong((r) => r.orders), tong.orders, "cộng đơn của các nguồn phải bằng tổng đơn toàn shop");
  assert.equal(cong((r) => r.delivered), tong.delivered, "cộng đơn giao thành công của các nguồn phải bằng tổng");
  assert.equal(cong((r) => r.returned), tong.returned, "cộng đơn hoàn của các nguồn phải bằng tổng");
  assert.equal(cong((r) => r.shipped), tong.shipped, "cộng đơn đã gửi của các nguồn phải bằng tổng");

  // Khách gửi form hai lần cho cùng một đơn KHÔNG được làm đơn bị đếm hai lần.
  const [demDongLanding] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.landingOrders)
    .where(eq(schema.landingOrders.orderId, "ns-lp-1"));
  assert.equal(Number(demDongLanding?.n ?? 0), 2, "fixture phải có đúng hai dòng landing cùng trỏ một đơn");
  const landing = theoNguon.find((r) => r.source === "LANDING");
  assert.ok(landing, "phải tách được nguồn landing");
  const demTrongBaoCao = (await db
    .select({ id: schema.orders.id, nguon: ORDER_SOURCE })
    .from(schema.orders)
    .where(sql`${schema.orders.id} like 'ns-%'`)).filter((r) => r.nguon === "LANDING").length;
  assert.equal(demTrongBaoCao, 2, "hai đơn landing (ns-lp-1 chỉ tính một lần dù có hai dòng form)");

  const lai = theoNguon;

  // ───────── 3. Tỷ lệ tính trên đơn đã kết thúc, không dùng công thức riêng ─────────
  for (const r of lai) {
    const ketThuc = r.delivered + r.returned;
    if (!ketThuc) {
      assert.equal(r.successRate, null, "chưa đơn nào kết thúc thì tỷ lệ là chưa xác định, không phải 0%");
      assert.equal(r.returnRate, null);
    } else {
      assert.ok(Math.abs((r.successRate ?? 0) + (r.returnRate ?? 0) - 100) < 0.01, "tỷ lệ GTC + tỷ lệ hoàn = 100% trên đơn đã kết thúc");
      assert.ok(r.delivered + r.returned <= r.orders, "đơn đã kết thúc không thể nhiều hơn tổng đơn của nguồn");
    }
  }

  // ───────── 4. Dọn dẹp ─────────
  await db.delete(schema.landingOrders).where(sql`${schema.landingOrders.rowKey} like 'ns-row-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'ns-%'`);
  clearMemo();

  console.log(`✓ Nguồn đơn: ${lai.map((r) => `${r.source} ${r.orders} đơn${r.successRate === null ? "" : ` GTC ${r.successRate.toFixed(1)}%`}`).join(" · ")} — cộng lại bằng tổng, đơn hai kênh ghi cho nơi đặt trước`);
}
