import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * ═══════════ ĐO CHI TIÊU HAI CẤP — BỘ DÒ PHẢI CHỈ ĐỌC, VÀ PHÉP BÓC CHỈ SỐ PHẢI CÓ MỘT BẢN ═══════════
 *
 * Đặc tả: `docs/ads-measurement-audit-2026-09-22.md`.
 *
 * Hai điều được khoá ở đây, và cả hai đều là chỗ sai không lộ ra khi chạy:
 *
 *  1. **Bộ dò không được ghi.** Nó tồn tại để trả lời "hạ hạt `ad_spends` xuống cấp mẩu có làm đổi
 *     một đồng nào không" TRƯỚC khi ai đó hạ hạt. Một bộ dò tự ghi thì nó không còn là bộ dò, và
 *     câu trả lời của nó nói về một CSDL đã bị chính nó thay đổi.
 *
 *  2. **Phép bóc `actions` / `action_values` chỉ được có MỘT bản.** Facebook trả nhiều `action_type`
 *     chồng nhau cho cùng một sự kiện; luật "chỉ lấy một loại theo thứ tự ưu tiên, không cộng dồn"
 *     mà tồn tại hai bản là mời hai con số "tin nhắn" khác nhau sống song song — và khi chúng lệch
 *     thì không ai biết cái nào đúng. Báo cáo lợi nhuận đã phải đi dọn đúng lớp lỗi này một lần
 *     (`adsRatios()` trong `lib/constants/profit.ts`).
 */

const CLIENT = "lib/integrations/facebook/client.ts";
const PROBE = "scripts/ads-level-probe.ts";

/** Bỏ chú thích trước khi quét — cái bẫy chú thích đã cắn năm lần trong kho này. */
function boChuThich(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function testAdsLevelProbe() {
  const probe = boChuThich(readFileSync(PROBE, "utf8"));
  for (const pattern of [/\.insert\s*\(/, /\.update\s*\(/, /\.delete\s*\(/, /\bdrop\s+table\b/i, /\btruncate\b/i]) {
    assert.ok(!pattern.test(probe), `${PROBE} phải CHỈ ĐỌC nhưng khớp ${pattern}. Bộ dò mà tự ghi thì câu trả lời của nó nói về một CSDL đã bị chính nó đổi.`);
  }
  // Và nó cũng không được gọi API GHI của Facebook.
  assert.ok(!probe.includes("ads-write"), `${PROBE} không được đụng tới cửa ghi quảng cáo`);
  assert.ok(probe.includes("CHỈ ĐỌC"), `${PROBE} phải khai thẳng trong mã rằng nó chỉ đọc`);

  const client = readFileSync(CLIENT, "utf8");
  const sach = boChuThich(client);

  /*
    MỘT BẢN DUY NHẤT CỦA LUẬT BÓC CHỈ SỐ.

    Đếm ở mức chuỗi vì đây là thứ dễ bị chép lại nhất khi thêm một cấp mới: người viết cấp `ad` chỉ
    cần copy khối của cấp `campaign` là xong, và không gì đỏ.
  */
  const soBanPurchase = (sach.match(/const PURCHASE = \[/g) ?? []).length;
  assert.equal(soBanPurchase, 1, `Luật bóc action phải có ĐÚNG MỘT bản trong ${CLIENT}, đang thấy ${soBanPurchase}. Hai bản là hai con số "tin nhắn" sống song song.`);

  // Cấp mẩu phải xin ĐỦ cây định danh — thiếu một trường là cấp trên không cộng lên được.
  assert.ok(sach.includes('"ad"'), "client phải có đường đọc insights ở cấp ad");
  for (const field of ["ad_id", "ad_name", "adset_id", "adset_name", "campaign_id", "campaign_name"]) {
    assert.ok(sach.includes(field), `insights cấp mẩu phải xin trường ${field} — thiếu nó thì không dựng lại được cây ad → adset → campaign`);
  }

  /*
    `client.ts` VẪN PHẢI CHỈ-ĐỌC.

    Nấc 3 dựng cửa ghi ở một tệp riêng (`ads-write.ts`) đúng để câu "chưa bật thì không đổi được
    ngân sách nào" kiểm chứng được bằng cách đọc một tệp. Thêm insights cấp mẩu KHÔNG được làm hỏng
    tính chất ấy — `tests/ads-write.test.ts` cũng canh, và hai bài kiểm cùng canh là cố ý.
  */
  for (const cam of ['method: "POST"', "daily_budget"]) {
    assert.ok(!sach.includes(cam), `${CLIENT} phải giữ nguyên CHỈ-ĐỌC, nhưng có "${cam}"`);
  }

  console.log("  ✓ Dò chi tiêu hai cấp: bộ dò chỉ đọc · luật bóc chỉ số một bản · cấp mẩu xin đủ cây định danh · client vẫn chỉ-đọc");
}
