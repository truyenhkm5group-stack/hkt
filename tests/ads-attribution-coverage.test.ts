import assert from "node:assert/strict";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { adsAttributionCoverage, adsAttributionCoverageByDay, coverageVerdict } from "@/lib/queries/ads-attribution-coverage";
import { ADS_ANOMALY_RULES } from "@/lib/constants/ads-anomaly";

/**
 * ĐỘ PHỦ QUY KẾT QUẢNG CÁO — BA NHÓM, KHÔNG PHẢI HAI.
 *
 * Chủ shop đã chốt ~49% là GIỚI HẠN CỦA DỮ LIỆU chứ không phải lỗi: một bài viết được scale ra nhiều
 * quảng cáo → nhóm → chiến dịch → tài khoản, nên quan hệ bài ↔ chiến dịch là nhiều–nhiều THEO THIẾT
 * KẾ. Bài kiểm thử này khoá đúng chỗ dễ bị "tối ưu" sai nhất: gộp nhập nhằng vào phần quy kết được
 * để con số đẹp lên.
 */
export async function testAdsAttributionCoverage(db: Db) {
  // ───────── Dàn cảnh ─────────
  // Bài A: chỉ MỘT chiến dịch chạy ⇒ nối được.
  // Bài B: HAI chiến dịch cùng chạy ⇒ nhập nhằng, phải để yên.
  await db
    .insert(schema.fbAds)
    .values([
      { id: "cov-ad-1", name: "Mẩu A", campaignId: "cov-camp-1", postId: "700000000001", fetchedAt: new Date() },
      { id: "cov-ad-2", name: "Mẩu B1", campaignId: "cov-camp-2", postId: "700000000002", fetchedAt: new Date() },
      { id: "cov-ad-3", name: "Mẩu B2", campaignId: "cov-camp-3", postId: "700000000002", fetchedAt: new Date() },
    ])
    .onConflictDoNothing();

  await db
    .insert(schema.orders)
    .values([
      // (1) có mã quảng cáo THẬT ⇒ quy kết được
      { id: "cov-o1", stage: "CONFIRMED", status: 1, insertedAt: new Date(), adId: "cov-ad-1" },
      // (2) chỉ có bài, bài thuộc đúng một chiến dịch ⇒ quy kết được
      { id: "cov-o2", stage: "CONFIRMED", status: 1, insertedAt: new Date(), postId: "111_700000000001" },
      // (3) chỉ có bài, bài chạy ở HAI chiến dịch ⇒ NHẬP NHẰNG
      { id: "cov-o3", stage: "CONFIRMED", status: 1, insertedAt: new Date(), postId: "111_700000000002" },
      // (4) không có gì để nối
      { id: "cov-o4", stage: "CONFIRMED", status: 1, insertedAt: new Date() },
      // (5) có mã quảng cáo nhưng mã KHÔNG tồn tại trong bảng quảng cáo ⇒ không nối được
      { id: "cov-o5", stage: "CONFIRMED", status: 1, insertedAt: new Date(), adId: "khong-ton-tai" },
    ])
    .onConflictDoNothing();

  clearMemo();
  const cov = await adsAttributionCoverage(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));

  assert.ok(cov.uniqueDeterministic >= 2, "đơn có mã quảng cáo thật và đơn có bài thuộc đúng một chiến dịch đều phải quy kết được");
  assert.ok(cov.ambiguous >= 1, "bài chạy ở nhiều chiến dịch phải nằm ở NHẬP NHẰNG");
  assert.ok(cov.unmapped >= 2, "đơn không có gì để nối, và đơn có mã quảng cáo không tồn tại, đều là không nối được");

  // Ba nhóm phải phủ hết và không chồng nhau — nếu không, tổng cộng lại khác tổng đơn và mọi tỷ lệ
  // tính trên đó đều sai.
  assert.equal(cov.uniqueDeterministic + cov.ambiguous + cov.unmapped, cov.total, "ba nhóm phải cộng lại đúng bằng tổng đơn");

  // ĐIỀU QUAN TRỌNG NHẤT: nhập nhằng KHÔNG được tính là quy kết được.
  assert.ok(cov.coveragePct < 100, "còn đơn nhập nhằng mà báo phủ 100% là làm đẹp số");
  assert.equal(cov.coveragePct, Math.round((cov.uniqueDeterministic / cov.total) * 1000) / 10, "độ phủ chỉ tính trên nhóm XÁC ĐỊNH");

  // Dưới ngưỡng thì mọi khuyến nghị phải là CHƯA ĐỦ DỮ LIỆU, không phải một con số trông chắc chắn.
  const threshold = ADS_ANOMALY_RULES.minAttributionToJudgeProfit;
  assert.equal(coverageVerdict(49.2, threshold), "DATA_INSUFFICIENT", "49% không đủ để kết luận SCALE/CUT");
  assert.equal(coverageVerdict(threshold, threshold), "SUFFICIENT", "đúng ngưỡng là đủ");

  // Theo ngày: để nhìn xu hướng. Dữ liệu mới tốt lên thì đường này phải đi lên.
  clearMemo();
  const days = await adsAttributionCoverageByDay(7);
  assert.ok(Array.isArray(days), "phải trả về chuỗi theo ngày");
  for (const d of days) {
    assert.equal(d.uniqueDeterministic + d.ambiguous + d.unmapped, d.total, `ngày ${d.day}: ba nhóm phải cộng đúng tổng`);
  }

  console.log(
    `✓ Độ phủ quy kết: ${cov.uniqueDeterministic}/${cov.total} xác định (${cov.coveragePct}%) · ${cov.ambiguous} nhập nhằng KHÔNG được tính là quy kết được · dưới ngưỡng ⇒ CHƯA ĐỦ DỮ LIỆU`,
  );
}
