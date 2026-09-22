import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { getAttributionLinkReport } from "@/lib/queries/ads-attribution-link";
import { getAdsDecision } from "@/lib/queries/ads-decision";
import { clearMemo } from "@/lib/cache";
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
  // Dùng ĐÚNG định dạng production: trang và bài đều là chuỗi chữ số dài.
  const PAGE = "1092821970588849";
  const POST = "990000000000000001";
  const AMBIG = "990000000000000002";
  const HONG = "khong-phai-so";
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

  // ───────── 2b. Mã bài HỎNG thì không nối, cũng không tính là nhập nhằng ─────────
  // Nối theo mã hỏng là gán doanh thu vào chỗ không có thật.
  await db.update(schema.orders).set({ postId: `${PAGE}_${HONG}` }).where(sql`${schema.orders.id} = ${order.id}`);
  const broken = await getAttributionLinkReport(3650);
  assert.equal(broken.byPost, 0, "mã bài hỏng KHÔNG được nối");
  assert.ok(broken.invalidPostKey >= 1, "mã bài hỏng phải được đếm riêng để nhìn thấy, không im lặng bỏ qua");

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

  /*
    ───────── 6. BA MỨC NỐI QUA BÀI VIẾT LÀ BA PHÉP TÍNH RIÊNG ─────────

    Đây là tính chất dễ bị "đơn giản hoá" nhất, và đơn giản hoá nó là bịa quy kết.

    Một bài do HAI mẩu cùng chạy nhưng cả hai ở CÙNG một nhóm: cấp mẩu là NHẬP NHẰNG (chọn bừa một
    mẩu là gán doanh thu cho sai chỗ), trong khi cấp NHÓM và cấp CHIẾN DỊCH vẫn xác định. Nếu ba
    mức được suy ra từ nhau thì hoặc mất phần nối được ở cấp nhóm, hoặc bịa ra một mẩu ở cấp mẩu.

    Fixture ở mục 1 đúng là hình dạng ấy — thêm `adset_id` cho hai mẩu là đủ để kiểm.
  */
  await db.update(schema.fbAds).set({ adsetId: "set-kt-1" }).where(sql`${schema.fbAds.id} in ('999000001','999000002')`);
  await db.update(schema.orders).set({ postId: `${PAGE}_${POST}` }).where(sql`${schema.orders.id} = ${order.id}`);
  clearMemo();

  const theoNhom = await getAdsDecision(ALL, "adset");
  assert.ok(
    theoNhom.rows.some((r) => r.key === "set-kt-1"),
    "bài viết ứng với ĐÚNG MỘT nhóm phải nối được ở cấp NHÓM — kể cả khi nó do hai mẩu cùng chạy",
  );

  clearMemo();
  const theoMau = await getAdsDecision(ALL, "ad");
  assert.ok(
    !theoMau.rows.some((r) => r.key === "999000001" || r.key === "999000002"),
    "bài do HAI mẩu cùng chạy phải để NHẬP NHẰNG ở cấp mẩu — chọn bừa một mẩu là gán doanh thu cho sai chỗ",
  );

  /*
    Và khi bài chỉ do MỘT mẩu chạy thì cấp mẩu nối được. Đây là phần mở ra nhờ sổ mẩu được điền từ
    TIỀN (1.254 mẩu thay vì 185) — trước bản ấy gần như không bài nào có mẩu để nối.
  */
  const POST_SOLO = "990000000000000009";
  await db
    .insert(schema.fbAds)
    .values({ id: "999000005", name: "QC một mình", adsetId: "set-kt-2", campaignId: "camp-kt-2", campaignName: "CD 2", postId: POST_SOLO, storyId: `123_${POST_SOLO}` })
    .onConflictDoNothing();
  await db.update(schema.orders).set({ postId: `${PAGE}_${POST_SOLO}` }).where(sql`${schema.orders.id} = ${order.id}`);
  clearMemo();
  const soloMau = await getAdsDecision(ALL, "ad");
  assert.ok(soloMau.rows.some((r) => r.key === "999000005"), "bài do ĐÚNG MỘT mẩu chạy phải nối được tới tận cấp mẩu");

  // Dọn sạch để không đổi số của khối kiểm thử khác.
  clearMemo();
  await db.delete(schema.fbAds).where(sql`${schema.fbAds.id} in ('999000001','999000002','999000003','999000004','999000005')`);
  await db.update(schema.orders).set({ postId: before[0].postId }).where(sql`${schema.orders.id} = ${order.id}`);

  console.log(
    `✓ Nối quy kết qua bài viết: độ phủ ${linked.coverageBefore}% → ${linked.coverageAfter}% (trần ${linked.ceiling}%) · ba mức tính RIÊNG (một bài hai mẩu cùng nhóm: nối được ở cấp nhóm, nhập nhằng ở cấp mẩu) · không ghi ngược vào bảng đơn`,
  );
}
