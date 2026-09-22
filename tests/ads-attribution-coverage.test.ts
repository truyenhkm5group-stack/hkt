import assert from "node:assert/strict";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { adsAttributionCoverage, adsAttributionCoverageByDay, coverageVerdict } from "@/lib/queries/ads-attribution-coverage";
import { ADS_ANOMALY_RULES } from "@/lib/constants/ads-anomaly";

/**
 * ĐỘ PHỦ QUY KẾT QUẢNG CÁO — BỐN NHÓM, VÀ MẪU SỐ KHÔNG PHẢI LÀ TỔNG ĐƠN.
 *
 * Chủ shop đã chốt: quan hệ bài ↔ chiến dịch là nhiều–nhiều THEO THIẾT KẾ (một bài được scale ra
 * nhiều quảng cáo → nhóm → chiến dịch), nên phần nhập nhằng là giới hạn của dữ liệu chứ không phải
 * lỗi. Bài kiểm này khoá ba chỗ dễ sai nhất:
 *
 *  ① gộp NHẬP NHẰNG vào phần quy kết được để con số đẹp lên;
 *  ② để đơn CHƯA BAO GIỜ đi qua quảng cáo nằm trong MẪU SỐ của một tỷ lệ quảng cáo — đo production
 *    22/09/2026: 228/1.395 đơn không có fanpage, bài viết hay mẩu nào, và chúng kéo độ phủ từ 72,5%
 *    xuống 60,6%. Hai con số ấy dẫn tới hai kết luận khác nhau;
 *  ③ PHẠM VI ĐƠN không khớp với bảng mà con số này dán nhãn — đơn `NEW` / `CANCELLED` / `DELETED`
 *    lọt vào mẫu số của một tỷ lệ mà bảng quyết định không hề đếm chúng.
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
      // (4) KHÔNG có fanpage, bài, mẩu nào ⇒ chưa bao giờ đi qua quảng cáo ⇒ NGOÀI mẫu số
      { id: "cov-o4", stage: "CONFIRMED", status: 1, insertedAt: new Date() },
      // (5) có mã quảng cáo nhưng mã KHÔNG tồn tại trong bảng quảng cáo ⇒ MẤT DẤU (vẫn trong mẫu số)
      { id: "cov-o5", stage: "CONFIRMED", status: 1, insertedAt: new Date(), adId: "khong-ton-tai" },
      // (6) đến từ fanpage nhưng không có bài/mẩu nào ⇒ MẤT DẤU, không phải "ngoài quảng cáo"
      { id: "cov-o6", stage: "CONFIRMED", status: 1, insertedAt: new Date(), pageId: "111" },
    ])
    .onConflictDoNothing();

  clearMemo();
  const cov = await adsAttributionCoverage(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));

  assert.ok(cov.uniqueDeterministic >= 2, "đơn có mã quảng cáo thật và đơn có bài thuộc đúng một chiến dịch đều phải quy kết được");
  assert.ok(cov.ambiguous >= 1, "bài chạy ở nhiều chiến dịch phải nằm ở NHẬP NHẰNG");
  assert.ok(cov.lostFacebook >= 2, "mã quảng cáo không tồn tại, và đơn chỉ có fanpage, đều là MẤT DẤU — chúng CÓ dấu vết Facebook");
  assert.ok(cov.notFromAds >= 1, "đơn không fanpage / không bài / không mẩu phải nằm ở nhóm KHÔNG ĐẾN TỪ QUẢNG CÁO");

  // Bốn nhóm phải phủ hết và không chồng nhau.
  assert.equal(
    cov.uniqueDeterministic + cov.ambiguous + cov.lostFacebook + cov.notFromAds,
    cov.total,
    "bốn nhóm phải cộng lại đúng bằng tổng đơn đã chốt",
  );
  assert.equal(cov.attributable, cov.total - cov.notFromAds, "mẫu số = tổng đơn TRỪ đơn không đến từ quảng cáo");

  // ĐIỀU QUAN TRỌNG NHẤT ①: nhập nhằng KHÔNG được tính là quy kết được.
  assert.ok(cov.coveragePct !== null && cov.coveragePct < 100, "còn đơn nhập nhằng mà báo phủ 100% là làm đẹp số");
  // ĐIỀU QUAN TRỌNG NHẤT ②: mẫu số là ĐƠN CÓ DẤU VẾT FACEBOOK, không phải tổng đơn.
  assert.equal(
    cov.coveragePct,
    Math.round((cov.uniqueDeterministic / cov.attributable) * 1000) / 10,
    "độ phủ = nhóm XÁC ĐỊNH ÷ đơn CÓ DẤU VẾT FACEBOOK",
  );
  assert.ok(
    cov.notFromAds === 0 || cov.coveragePct > Math.round((cov.uniqueDeterministic / cov.total) * 1000) / 10,
    "để đơn ngoài quảng cáo trong mẫu số thì độ phủ bị dìm xuống — đó đúng là lỗi đang sửa",
  );

  /*
    ─── ③ PHẠM VI: ĐƠN HUỶ KHÔNG ĐƯỢC LỌT VÀO MẪU SỐ ───

    Kiểm bằng phép ĐO HAI LẦN, không bằng một khẳng định về nội tâm của truy vấn: thêm một đơn HUỶ
    mang mã quảng cáo THẬT (thứ lẽ ra sẽ làm mọi con số nhúc nhích nếu nó được đếm), rồi đo lại.
    Không con số nào được đổi.

    Bản trước của truy vấn này đếm mọi dòng `orders` trong khoảng ngày, nên nó SẼ đổi — và bài kiểm
    đỏ đúng lúc ấy.
  */
  await db
    .insert(schema.orders)
    .values([{ id: "cov-o7-huy", stage: "CANCELLED", status: 1, insertedAt: new Date(), adId: "cov-ad-1" }])
    .onConflictDoNothing();
  clearMemo();
  const sauKhiThemDonHuy = await adsAttributionCoverage(new Date(Date.now() - 86_400_000), new Date(Date.now() + 86_400_000));
  assert.deepEqual(sauKhiThemDonHuy, cov, "thêm một đơn HUỶ không được làm đổi một con số nào — phạm vi phải khớp với bảng quyết định");

  // Dưới ngưỡng thì mọi khuyến nghị phải là CHƯA ĐỦ DỮ LIỆU, không phải một con số trông chắc chắn.
  const threshold = ADS_ANOMALY_RULES.minAttributionToJudgeProfit;
  assert.equal(coverageVerdict(49.2, threshold), "DATA_INSUFFICIENT", "49% không đủ để kết luận SCALE/CUT");
  assert.equal(coverageVerdict(threshold, threshold), "SUFFICIENT", "đúng ngưỡng là đủ");
  // CHƯA ĐO ĐƯỢC rơi về phía HẸP HƠN, và nó khác hẳn "dưới ngưỡng".
  assert.equal(coverageVerdict(null, threshold), "DATA_INSUFFICIENT", "chưa đo được thì không được coi là đủ");

  // Theo ngày: để nhìn xu hướng. Dữ liệu mới tốt lên thì đường này phải đi lên.
  clearMemo();
  const days = await adsAttributionCoverageByDay(7);
  assert.ok(Array.isArray(days), "phải trả về chuỗi theo ngày");
  for (const d of days) {
    assert.equal(d.uniqueDeterministic + d.ambiguous + d.lostFacebook + d.notFromAds, d.total, `ngày ${d.day}: bốn nhóm phải cộng đúng tổng`);
  }

  console.log(
    `✓ Độ phủ quy kết: ${cov.uniqueDeterministic}/${cov.attributable} trên đơn CÓ DẤU VẾT FACEBOOK (${cov.coveragePct}%) · ${cov.ambiguous} nhập nhằng · ${cov.lostFacebook} mất dấu · ${cov.notFromAds} ngoài quảng cáo (ngoài mẫu số) · đơn huỷ không lọt vào · chưa-đo-được ⇒ CHƯA ĐỦ DỮ LIỆU`,
  );
}
