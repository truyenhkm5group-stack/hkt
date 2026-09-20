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
import { estimateCostVnd, priceUsedFor } from "@/lib/ai-workforce/model-router";

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
  // Bỏ dòng CHÚ THÍCH trước khi quét: chính chú thích giải thích "vì sao bảng giá thứ hai đã bị
  // gỡ" có nhắc tên nó, và một phép quét bắt cả chú thích sẽ cấm người sau kể lại lý do — tức là
  // ép xoá đúng phần khiến lỗi này không quay lại.
  const nguon = execFileSync("git", ["show", "HEAD:lib/ai/provider.ts"], { encoding: "utf-8" })
    .split("\n")
    .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
    .join("\n");
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

test("ảnh chụp giá: đổi giá tháng sau KHÔNG được viết lại chi phí lịch sử", () => {
  /*
    Đây là cả lý do ba cột ảnh chụp tồn tại. `pricing_version` nói ta đã dùng BẢNG GIÁ NÀO, nhưng
    bảng giá nằm trong `settings` và bị GHI ĐÈ khi chủ shop khai giá mới — nên chỉ có phiên bản
    thì tháng sau cái nhãn còn đó mà nội dung đã khác, và con số cũ không dựng lại được.
  */
  const thang6 = buildVndPricing(26_000);
  const thang7 = buildVndPricing(30_000); // chủ shop khai tỷ giá mới

  const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 };
  const chiPhiThang6 = estimateCostVnd("anthropic", "claude-sonnet-5", usage, thang6);
  const chiPhiThang7 = estimateCostVnd("anthropic", "claude-sonnet-5", usage, thang7);
  assert.notEqual(chiPhiThang6, chiPhiThang7, "đổi tỷ giá thì chi phí của CÙNG một lượt ra số khác — đó chính là mối nguy");

  // ẢNH CHỤP giữ lại đầu vào đã dùng, nên dựng lại được con số tháng 6 mà không cần bảng giá cũ.
  const anhChup = priceUsedFor("anthropic", "claude-sonnet-5", thang6);
  assert.ok(anhChup);
  const dungLai =
    (usage.inputTokens / 1_000_000) * anhChup.inputVndPerMillion + (usage.outputTokens / 1_000_000) * anhChup.outputVndPerMillion;
  assert.equal(Math.ceil(dungLai), chiPhiThang6, "từ ảnh chụp phải dựng lại ĐÚNG con số lịch sử");

  // Và phép tra khoá của ảnh chụp phải TRÙNG phép tra của `estimateCostVnd` — hai phép tra viết ở
  // hai chỗ là hai phép tra sẽ lệch nhau, và khi ấy ảnh chụp nói một đằng, chi phí nói một nẻo.
  assert.equal(priceUsedFor("khong-co", "cung-khong-co", thang6), null);
  assert.equal(estimateCostVnd("khong-co", "cung-khong-co", usage, thang6), null);
});

test("TÍNH RA = LƯU LẠI, sai số ĐÚNG BẰNG 0 — và đó là do cấu trúc, không phải do may", () => {
  /*
    Đặc tả phiên 20/09/2026 đòi: gọi thật 10–20 lượt rồi khẳng định "chi phí tính ra ≈ chi phí đã
    lưu, trong một sai số làm tròn có khai báo".

    Bài kiểm này trả lời câu ấy MẠNH HƠN một phép so xấp xỉ: sai số bằng ĐÚNG 0, vì đường ghi
    KHÔNG tính lại. `runModelStep` lấy thẳng giá trị `estimateCostVnd()` trả về và đem lưu; không
    có phép nhân thứ hai ở giữa để lệch. Một ngưỡng sai số ở đây sẽ là ngưỡng cho một phép tính
    KHÔNG TỒN TẠI — và tệ hơn, nó sẽ nuốt mất đúng cái lỗi mà nó tưởng đang canh.

    Nên thứ phải khoá là TÍNH CHẤT ẤY, ở mức mã nguồn. Phần này chạy được NGAY BÂY GIỜ, không
    phải đợi chủ shop khai tỷ giá — khác hẳn phần "gọi thật 10–20 lượt", vốn còn bị chặn.
  */
  const nguon = execFileSync("git", ["show", "HEAD:lib/ai-workforce/model-router.ts"], { encoding: "utf-8" });
  const than = nguon.slice(nguon.indexOf("const result = await provider.complete("));
  const khoiGhi = than.slice(0, than.indexOf("let parsed: T;"));
  assert.ok(/costVnd = estimateCostVnd\(/.test(khoiGhi), "chi phí phải lấy thẳng từ hàm tính, không tính lại");
  assert.ok(/costVnd,/.test(khoiGhi), "và đem lưu ĐÚNG giá trị ấy");
  assert.ok(
    !/costVnd\s*[*+\-/]/.test(khoiGhi.replace(/costVnd === null/g, "")),
    "không được có phép tính nào trên `costVnd` giữa lúc tính và lúc lưu",
  );

  /*
    DỰNG LẠI TỪ ẢNH CHỤP — kể cả rổ ĐỆM, rổ hay bị bỏ quên nhất.

    Ba cột đơn giá cộng với hai rổ token là đủ để dựng lại con số tiền mà không cần bảng giá lúc
    ấy. Nếu phép dựng lại này lệch thì ảnh chụp vô dụng: nó vẫn có mặt trong CSDL, vẫn trông như
    một bằng chứng, mà không tra ngược được về con số nào.
  */
  const bang = buildVndPricing(26_000);
  const gia = priceUsedFor("anthropic", "claude-sonnet-5", bang);
  assert.ok(gia, "mẫu dùng để kiểm phải có trong sổ giá");
  assert.ok(gia.cachedReadVndPerMillion !== undefined, "mẫu này phải có khai giá đệm, nếu không ca kiểm rỗng nghĩa");

  const usage = { inputTokens: 123_456, outputTokens: 7_890, cacheReadInputTokens: 45_678, cacheWriteInputTokens: 0 };
  const daLuu = estimateCostVnd("anthropic", "claude-sonnet-5", usage, bang);
  assert.ok(daLuu !== null);
  const dungLai = Math.ceil(
    (usage.inputTokens / 1_000_000) * gia.inputVndPerMillion +
      (usage.outputTokens / 1_000_000) * gia.outputVndPerMillion +
      (usage.cacheReadInputTokens / 1_000_000) * (gia.cachedReadVndPerMillion ?? 0),
  );
  assert.equal(dungLai, daLuu, "dựng lại từ ba cột ảnh chụp phải ra ĐÚNG con số đã lưu, không xấp xỉ");

  // Làm tròn LÊN, không làm tròn gần nhất: tiền trong ERP là số nguyên VND, và báo rẻ hơn thực tế
  // là hướng sai nguy hiểm hơn (nó làm một khoản lỗ trông như hoà vốn).
  const beXiu = estimateCostVnd("anthropic", "claude-sonnet-5", { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheWriteInputTokens: 0 }, bang);
  assert.equal(beXiu, 1, "một token vẫn phải ra 1đ chứ không ra 0đ — 0đ ở đây đọc như MIỄN PHÍ");
});
