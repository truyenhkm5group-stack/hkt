/**
 * SỔ GIÁ MÔ HÌNH — MỘT NGUỒN, GHI ĐÚNG KHOÁ, VÀ CHƯA BIẾT KHÔNG THÀNH 0.
 *
 * Ba bài kiểm dưới đây khoá đúng ba lỗi ĐÃ THẬT SỰ XẢY RA trên bản chạy thử, không phải ba lỗi
 * tưởng tượng ra cho đẹp bộ kiểm thử:
 *
 *   ① Hai bảng giá cho cùng một mô hình (`lib/ai/provider.ts` và `lib/constants/ai-model-pricing.ts`).
 *   ② Trình khai giá ghi vào `settings["ai"]` trong khi bộ đọc đọc `settings["ai.config"]` — chạy
 *      xong, in "đã ghi", và không một lượt nào tính được tiền. Đo 19/09/2026: 660/660 lượt gọi
 *      `cost_vnd IS NULL`, bảng `settings` không có dòng `ai.config` nào.
 *   ③ Khai giá mà quên ô ĐỆM ⇒ chi phí vẫn CHƯA BIẾT ở đúng những lượt hay xảy ra nhất.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { AI_CONFIG_KEY } from "@/lib/constants/ai";
import { MODEL_USD_PRICES, buildVndPricing, pricingVersionLabel, usdPriceFor } from "@/lib/constants/ai-model-pricing";
import { estimateCostUsd } from "@/lib/ai/provider";
import { estimateCostVnd } from "@/lib/ai-workforce/model-router";

test("sổ giá: mỗi dòng khai đủ căn cứ, và không dòng nào bịa", () => {
  for (const [model, gia] of Object.entries(MODEL_USD_PRICES)) {
    assert.ok(gia.provider.length > 0, `${model} phải khai nhà cung cấp — khoá tra giá là "<nhà>:<mẫu>"`);
    assert.ok(gia.inputUsdPerMillion >= 0 && gia.outputUsdPerMillion >= 0, `${model}: đơn giá không được âm`);
    // Căn cứ là BẮT BUỘC: một con số tiền không nói được nó ở đâu ra thì không ai dám sửa, và
    // cũng không ai biết nó đã cũ tới mức nào.
    assert.ok(gia.sourceNote.length > 10, `${model} phải khai lấy con số này ở đâu ra`);
    assert.match(gia.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/, `${model}: mốc hiệu lực phải là ngày ISO`);
    // Giá ra KHÔNG BAO GIỜ rẻ hơn giá vào ở mọi nhà cung cấp hiện có — một dòng ngược lại gần như
    // chắc chắn là gõ nhầm thứ tự hai ô, và nó làm mọi ước tính lệch theo hướng khó thấy.
    assert.ok(gia.outputUsdPerMillion >= gia.inputUsdPerMillion, `${model}: giá RA rẻ hơn giá VÀO — nhiều khả năng gõ ngược hai ô`);
    if (gia.cachedInputUsdPerMillion !== undefined) {
      assert.ok(gia.cachedInputUsdPerMillion < gia.inputUsdPerMillion, `${model}: token đệm phải RẺ HƠN token vào đủ giá`);
    }
  }
  // Mô hình đang chạy thật CHƯA có giá — và đó là câu trả lời ĐÚNG, không phải thiếu sót cần lấp
  // bằng một con số nhớ mang máng. Bài kiểm ghi lại điều đó để không ai lặng lẽ chép đại vào.
  assert.equal(usdPriceFor("gpt-5.6-luna"), null, "chưa biết giá công bố thì để CHƯA KHAI — chép đại một con số là bịa hoá đơn");
});

test("một mô hình, MỘT đơn giá — không còn bảng giá thứ hai", () => {
  /*
    Trước bản này `lib/ai/provider.ts` giữ một bảng `PRICE_PER_MTOK` riêng. Hai bảng cho cùng một
    mô hình nghĩa là khi một bên đổi giá, hai tầng AI của cùng một shop báo hai con số khác nhau
    về cùng một hoá đơn — và không ai biết bên nào đúng.
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/ai/provider.ts"], { encoding: "utf-8" });
  assert.ok(!/PRICE_PER_MTOK/.test(nguon), "bảng giá thứ hai đã quay lại trong lib/ai/provider.ts");

  // Và hai đường tính phải đọc CÙNG một sổ: đổi sổ thì cả hai cùng đổi.
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(estimateCostUsd("claude-sonnet-5", usage), MODEL_USD_PRICES["claude-sonnet-5"].inputUsdPerMillion);
  assert.equal(estimateCostUsd("khong-co-mo-hinh-nay", usage), null, "mô hình chưa khai giá ⇒ CHƯA BIẾT, không phải 0");
});

test("trình khai giá ghi vào ĐÚNG khoá mà bộ đọc đọc", () => {
  /*
    LỖI ĐÃ XẢY RA: `ai-set-pricing.ts` ghi `settings["ai"]`, `getAiSettings()` đọc
    `settings["ai.config"]`. Không lỗi, không cảnh báo, chỉ là tiền không bao giờ được tính.

    Quét mã ĐÃ VÀO KHO thay vì chạy script: chạy script đòi một CSDL, còn cái sai ở đây đọc được
    ngay trên mã nguồn — và nó phải đỏ trên máy người viết, không đợi tới lúc ai đó thắc mắc vì sao
    cột chi phí toàn dấu gạch.
  */
  const nguon = execFileSync("git", ["show", "HEAD:scripts/ai-set-pricing.ts"], { encoding: "utf-8" });
  assert.ok(/AI_CONFIG_KEY/.test(nguon), "phải dùng hằng số AI_CONFIG_KEY, không gõ lại chuỗi khoá");
  assert.ok(
    !/setSettingJson\(\s*["']ai["']\s*,/.test(nguon),
    'vẫn còn ghi vào settings["ai"] — bộ đọc đọc "ai.config", nên lượt ghi ấy không có tác dụng gì',
  );
  assert.equal(AI_CONFIG_KEY, "ai.config");
});

test("giá đệm: khai thiếu ⇒ CHƯA BIẾT, khai đủ ⇒ tính đúng rổ đệm", () => {
  const bang = buildVndPricing(26_000);
  // Khoá CÓ TÊN NHÀ và khoá trần phải cùng tồn tại: `estimateCostVnd` tra khoá có tên nhà trước,
  // còn cầu nối ERP báo về `provider` dạng khác (`erp:openai`), nên thiếu khoá trần là tra trượt.
  assert.ok(bang["anthropic:claude-sonnet-5"], "phải có khoá '<nhà>:<mẫu>'");
  assert.ok(bang["claude-sonnet-5"], "phải có khoá trần làm đường lui");
  assert.equal(bang["claude-sonnet-5"].inputVndPerMillion, 2 * 26_000);
  assert.equal(bang["claude-sonnet-5"].cachedReadVndPerMillion, Math.round(0.2 * 26_000));

  const coDem = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1_000_000, cacheWriteInputTokens: 0 };
  assert.equal(estimateCostVnd("anthropic", "claude-sonnet-5", coDem, bang), Math.round(0.2 * 26_000), "khai đủ giá đệm thì token đệm tính theo giá đệm");

  // Và chiều ngược lại: một mẫu KHÔNG khai giá đệm mà lượt gọi có token đệm ⇒ CHƯA BIẾT.
  const thieuDem = { "x:y": { inputVndPerMillion: 1000, outputVndPerMillion: 2000 } };
  assert.equal(estimateCostVnd("x", "y", coDem, thieuDem), null, "có token đệm mà chưa khai giá đệm ⇒ CHƯA BIẾT, không phải bỏ qua rổ đệm");

  // Nhãn phiên bản mang cả ngày chép giá lẫn tỷ giá: đổi một trong hai là ra con số khác, và hai
  // kỳ mang nhãn khác nhau thì không ai vẽ nhầm một đường xu hướng qua chúng.
  assert.notEqual(pricingVersionLabel(26_000), pricingVersionLabel(27_000));
});
