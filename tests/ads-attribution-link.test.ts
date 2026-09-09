import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { getAttributionLinkReport } from "@/lib/queries/ads-attribution-link";
import { getAdsRoas } from "@/lib/queries/ads-roas";

const ALL = { key: "all" as const, from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * NỐI ĐƠN VỀ CHIẾN DỊCH QUA BÀI VIẾT.
 *
 * Điều phải khoá — cả ba đều là ranh giới giữa "nối bằng dữ kiện" và "bịa quy kết":
 *  1. Bài viết do NHIỀU chiến dịch cùng chạy thì KHÔNG được nối;
 *  2. Nối chỉ có nghĩa ở cấp CHIẾN DỊCH, không được suy ra mẩu quảng cáo cụ thể;
 *  3. Không ghi ngược `ad_id` suy ra vào bảng đơn.
 */
export async function testAdsAttributionLink(db: Db) {
  const [order] = await db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(sql`${schema.orders.adId} is null or ${schema.orders.adId} = ''`)
    .limit(1);
  assert.ok(order, "fixture phải có đơn không mang ad_id");

  // Pancake ghi post_id dạng ĐẦY ĐỦ "<page_id>_<post_id>"; Facebook cho phần sau. Fixture phải
  // phản ánh đúng hai định dạng đó, nếu không bài kiểm thử sẽ xanh trong khi production không khớp
  // — đúng lỗi đã xảy ra thật.
  const PAGE = "1092821970588849";
  const POST = "post-kiem-thu-001";
  const AMBIG = "post-kiem-thu-nhap-nhang";
  const before = await db.select({ adId: schema.orders.adId, postId: schema.orders.postId }).from(schema.orders).where(sql`${schema.orders.id} = ${order.id}`);

  // ───────── 1. Một bài, MỘT chiến dịch ⇒ nối được ─────────
  await db.insert(schema.fbAds).values({ id: "999000001", name: "QC kiểm thử A", campaignId: "camp-kt-1", campaignName: "Chiến dịch kiểm thử", postId: POST, storyId: `123_${POST}` }).onConflictDoNothing();
  await db.insert(schema.fbAds).values({ id: "999000002", name: "QC kiểm thử B", campaignId: "camp-kt-1", campaignName: "Chiến dịch kiểm thử", postId: POST, storyId: `123_${POST}` }).onConflictDoNothing();
  await db.update(schema.orders).set({ postId: `${PAGE}_${POST}` }).where(sql`${schema.orders.id} = ${order.id}`);

  const linked = await getAttributionLinkReport(3650);
  assert.ok(
    linked.byPost >= 1,
    "đơn chỉ có post_id phải nối được khi mọi mẩu quảng cáo của bài thuộc CÙNG một chiến dịch — kể cả khi đơn lưu dạng '<page>_<post>' còn quảng cáo lưu phần sau",
  );
  assert.ok(linked.coverageAfter >= linked.coverageBefore, "nối thêm thì độ phủ chỉ được tăng");

  // ───────── 2. Một bài, NHIỀU chiến dịch ⇒ KHÔNG nối, phải đếm là nhập nhằng ─────────
  // Đây là ranh giới quan trọng nhất: chọn bừa một chiến dịch sẽ gán doanh thu cho sai chỗ, và
  // không ai phát hiện được vì con số trông vẫn hợp lý.
  await db.insert(schema.fbAds).values({ id: "999000003", name: "QC kiểm thử C", campaignId: "camp-kt-2", campaignName: "Chiến dịch khác", postId: AMBIG, storyId: `123_${AMBIG}` }).onConflictDoNothing();
  await db.insert(schema.fbAds).values({ id: "999000004", name: "QC kiểm thử D", campaignId: "camp-kt-3", campaignName: "Chiến dịch khác nữa", postId: AMBIG, storyId: `123_${AMBIG}` }).onConflictDoNothing();
  await db.update(schema.orders).set({ postId: `${PAGE}_${AMBIG}` }).where(sql`${schema.orders.id} = ${order.id}`);

  const ambiguous = await getAttributionLinkReport(3650);
  assert.ok(ambiguous.ambiguous >= 1, "bài do nhiều chiến dịch chạy PHẢI được đếm là nhập nhằng");
  assert.equal(ambiguous.byPost, 0, "nhập nhằng thì KHÔNG được nối — thà thiếu còn hơn gán sai chỗ");

  // ───────── 3. KHÔNG ghi ngược vào bảng đơn ─────────
  // Đơn phải giữ nguyên sự thật thô Pancake gửi; phần nối chỉ tồn tại lúc truy vấn.
  const after = await db.select({ adId: schema.orders.adId }).from(schema.orders).where(sql`${schema.orders.id} = ${order.id}`);
  assert.equal(after[0].adId, before[0].adId, "tuyệt đối KHÔNG ghi ad_id suy ra ngược vào bảng đơn");

  // ───────── 4. Cấp mẩu quảng cáo KHÔNG được hưởng phần nối qua bài ─────────
  // Một bài có thể do nhiều mẩu chạy; nối qua bài chỉ xác định tới chiến dịch.
  const byAd = await getAdsRoas(ALL, "ad");
  for (const row of byAd.rows) {
    assert.ok(row.key && row.key !== "camp-kt-1", "bảng theo mẩu quảng cáo không được chứa khoá cấp chiến dịch");
  }

  // ───────── 5. Các con số độ phủ phải nhất quán ─────────
  assert.ok(linked.total > 0, "phải có đơn để đo");
  assert.ok(linked.ceiling >= linked.coverageAfter, "trần lý thuyết không thể thấp hơn độ phủ đạt được");
  assert.ok(linked.coverageAfter >= 0 && linked.coverageAfter <= 100, "độ phủ phải trong 0–100");

  // Dọn sạch để không đổi số của khối kiểm thử khác.
  await db.delete(schema.fbAds).where(sql`${schema.fbAds.id} in ('999000001','999000002','999000003','999000004')`);
  await db.update(schema.orders).set({ postId: before[0].postId }).where(sql`${schema.orders.id} = ${order.id}`);

  console.log(
    `✓ Nối quy kết qua bài viết: độ phủ ${linked.coverageBefore}% → ${linked.coverageAfter}% (trần ${linked.ceiling}%) · bài do nhiều chiến dịch chạy giữ nguyên NHẬP NHẰNG · không ghi ngược vào bảng đơn`,
  );
}
