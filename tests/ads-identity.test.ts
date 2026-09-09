import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { isUsableAdId, isUsablePostKey, normalizePostKey } from "@/lib/constants/ads-identity";

/**
 * DANH TÍNH QUẢNG CÁO — KIỂM BẰNG ĐỊNH DẠNG PRODUCTION THẬT.
 *
 * Bài kiểm thử cũ dùng chuỗi tự bịa (`"post-kiem-thu-001"`) cho CẢ HAI phía, nên nó xanh trong khi
 * production không khớp một dòng nào. Một fixture không phản ánh sự thật thì tệ hơn không có
 * fixture: nó cho cảm giác an toàn sai.
 *
 * Giá trị dưới đây lấy từ sản phẩm thật (09/09/2026):
 *   orders.post_id   1092821970588849_122125401075345176   (1.809/1.809 có gạch dưới)
 *   fb_ads.post_id   122104683968493325                    (99/99 toàn chữ số)
 *   fb_ads.story_id  1089070007619448_122104683968493325
 *   orders.ad_id     120247872389140225
 */

const THAT = {
  donPostDayDu: "1092821970588849_122125401075345176",
  postRieng: "122125401075345176",
  qcPost: "122104683968493325",
  qcStory: "1089070007619448_122104683968493325",
  adId: "120247872389140225",
};

export async function testAdsIdentity(db: Db) {
  // ───────── 1. pageId_postId → khoá chung ─────────
  assert.equal(normalizePostKey(THAT.donPostDayDu), THAT.postRieng, "dạng đầy đủ phải cắt được tiền tố trang");

  // ───────── 2. postId riêng → giữ nguyên ─────────
  assert.equal(normalizePostKey(THAT.postRieng), THAT.postRieng, "dạng đã rút gọn phải giữ nguyên");

  // ───────── 3. Hai bên gặp nhau ở CÙNG một khoá ─────────
  // Đây chính là chỗ đã sai trên production: một bên có tiền tố, một bên không.
  assert.equal(normalizePostKey(THAT.qcStory), normalizePostKey(THAT.qcPost), "story_id và post_id của cùng một bài phải quy về cùng khoá");

  // ───────── 4. adId ─────────
  assert.ok(isUsableAdId(THAT.adId), "mã mẩu quảng cáo thật phải hợp lệ");
  assert.ok(!isUsableAdId(""), "chuỗi rỗng không phải mã quảng cáo");
  assert.ok(!isUsableAdId("abc123"), "mã có chữ cái không phải mã Facebook");

  // ───────── 5. Thiếu mã ─────────
  for (const missing of [null, undefined, "", "   "]) {
    assert.equal(normalizePostKey(missing), null, `giá trị thiếu (${JSON.stringify(missing)}) phải trả null, không phải chuỗi rỗng`);
    assert.ok(!isUsablePostKey(normalizePostKey(missing)), "thiếu mã thì không dùng để nối được");
  }

  // ───────── 6. Mã hỏng ─────────
  // Nối theo mã hỏng là gán doanh thu vào chỗ không có thật. Thà bỏ qua còn hơn nối nhầm.
  for (const bad of ["_", "abc_def", "1092821970588849_", "123", "post-kiem-thu-001", "1092821970588849_abc"]) {
    assert.ok(!isUsablePostKey(normalizePostKey(bad)), `mã hỏng "${bad}" KHÔNG được coi là dùng được`);
  }

  // ───────── 7. SQL và TypeScript phải chuẩn hoá GIỐNG HỆT NHAU ─────────
  // Hai bản trôi khỏi nhau thì không bao giờ báo lỗi — nó chỉ trả về ít kết quả hơn sự thật.
  const mau = [THAT.donPostDayDu, THAT.postRieng, THAT.qcStory, "abc_def", "1092821970588849_"];
  for (const raw of mau) {
    const [row] = await db.select({ key: sql<string>`regexp_replace(${raw}, '^.*_', '')` }).from(sql`(select 1) as t`);
    assert.equal(row.key, normalizePostKey(raw) ?? "", `SQL và TypeScript phải cho cùng kết quả với "${raw}"`);
  }

  // ───────── 8. Cùng một bài ở hai kỳ khác nhau vẫn là một bài ─────────
  // Khoá bài KHÔNG mang thông tin thời gian; phân giải theo kỳ (nếu có) phải dựa vào ngày chi tiêu,
  // không phải vào mã.
  assert.equal(normalizePostKey(`1111111111_${THAT.postRieng}`), normalizePostKey(`2222222222_${THAT.postRieng}`), "cùng bài đăng lại ở trang khác vẫn phải ra cùng khoá");

  console.log("✓ Danh tính quảng cáo: chuẩn hoá một chỗ duy nhất · khớp định dạng production thật · SQL và TypeScript cho cùng kết quả · mã hỏng bị loại thay vì nối bừa");
}
