/**
 * CỠ MẪU ĐỐI CHỨNG — và luật quan trọng nhất ở đây không phải một con số.
 *
 * Nó là: MÁY KHÔNG TỰ CHẤM MÁY. Bộ đối chứng chỉ nhận nhãn do NGƯỜI bấm, và bài kiểm quét mã
 * nguồn đã vào kho để không ai lặng lẽ thêm một đường "mô hình chấm mô hình".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  BENCHMARK_SAMPLE_TIERS,
  BENCHMARK_TIERS,
  benchmarkTierOf,
  canRankModels,
  isGroundedLabel,
} from "@/lib/constants/review-benchmark";
import { PILOT_REVIEWED_TURNS_TARGET } from "@/lib/constants/sales-copilot";

test("ngưỡng LẤY LẠI từ mục tiêu thí điểm, không gõ lại", () => {
  /*
    Gõ lại một con số là mở đường cho hai nơi nói hai số khác nhau — cùng lý do luật 22 bắt
    `getWorkConfig()` lấy mặc định từ chính hằng số đang chạy. Ở đây nếu chủ shop đổi mục tiêu
    thí điểm mà mức "đọc được xu hướng" vẫn đứng yên thì hai màn hình sẽ nói hai điều khác nhau
    về cùng một bộ dữ liệu.
  */
  assert.equal(BENCHMARK_SAMPLE_TIERS.PRELIMINARY_FROM, PILOT_REVIEWED_TURNS_TARGET.min);
  assert.equal(BENCHMARK_SAMPLE_TIERS.INSUFFICIENT_BELOW, PILOT_REVIEWED_TURNS_TARGET.min);
  assert.ok(BENCHMARK_SAMPLE_TIERS.MEANINGFUL_FROM > BENCHMARK_SAMPLE_TIERS.PRELIMINARY_FROM);
  assert.ok(BENCHMARK_SAMPLE_TIERS.STRONGER_FROM > BENCHMARK_SAMPLE_TIERS.MEANINGFUL_FROM);
  assert.equal(BENCHMARK_TIERS.length, 4);
});

test("bốn mức, và ranh giới ĐÓNG ở dưới", () => {
  assert.equal(benchmarkTierOf(0), "INSUFFICIENT");
  assert.equal(benchmarkTierOf(19), "INSUFFICIENT");
  assert.equal(benchmarkTierOf(20), "PRELIMINARY", "đúng bằng ngưỡng là ĐÃ TỚI mức đó");
  assert.equal(benchmarkTierOf(37), "PRELIMINARY");
  assert.equal(benchmarkTierOf(38), "MEANINGFUL");
  assert.equal(benchmarkTierOf(99), "MEANINGFUL");
  assert.equal(benchmarkTierOf(100), "STRONGER");

  /*
    DƯỚI MỨC DÙNG ĐƯỢC KHÔNG PHẢI "HAI MÔ HÌNH NGANG NHAU".

    Đó là CHƯA BIẾT, và hai câu ấy dẫn tới hai quyết định ngược nhau: một cái nói "giữ nguyên",
    cái kia nói "đi lấy thêm dữ liệu". Đúng luật 39 — LÀM KÉM phải phân biệt được với CHƯA ĐỦ
    DỮ LIỆU.
  */
  assert.equal(canRankModels(0), false);
  assert.equal(canRankModels(37), false);
  assert.equal(canRankModels(38), true);
});

test("ĐỦ ĐIỀU KIỆN ĐỐI CHỨNG đòi nói được LỖI Ở ĐÂU", () => {
  // Một cái tích trơ trọi nói được "có lỗi", không nói được lỗi ở đâu — nên không so được hai
  // mô hình trên cùng một lượt, mà đó là toàn bộ mục đích của bộ đối chứng.
  assert.equal(isGroundedLabel({ verdict: "BAD", reasonTags: [], expectedBehavior: "" }), false);
  assert.equal(isGroundedLabel({ verdict: null, reasonTags: ["WRONG_SIZE"], expectedBehavior: "x" }), false, "không kết luận thì không vào bộ");
  assert.equal(isGroundedLabel({ verdict: "BAD", reasonTags: ["WRONG_SIZE"], expectedBehavior: "" }), true);
  assert.equal(isGroundedLabel({ verdict: "BAD", reasonTags: [], expectedBehavior: "đáng lẽ phải hỏi số đo" }), true);
  assert.equal(isGroundedLabel({ verdict: "GOOD", reasonTags: null, expectedBehavior: null }), false);
  // Khoảng trắng không phải một câu trả lời.
  assert.equal(isGroundedLabel({ verdict: "BAD", reasonTags: [], expectedBehavior: "   " }), false);
});

test("MÁY KHÔNG TỰ CHẤM MÁY — không có đường nào cho mô hình sinh ra nhãn", () => {
  /*
    Một điểm số do máy sinh ra trông y hệt một điểm số có căn cứ. Nên nó sẽ lặng lẽ thay chỗ cho
    phần việc đắt nhất mà cũng là phần duy nhất đáng tin: một người đọc câu ấy và nói nó dùng
    được hay không. Chặn ở mức mã nguồn, trên bản ĐÃ VÀO KHO.
  */
  const duongGhiNhan = execFileSync("git", ["ls-files", "lib/actions", "lib/queries"], { encoding: "utf-8" })
    .split("\n")
    .filter((f) => f.trim());
  for (const tep of duongGhiNhan) {
    const nguon = execFileSync("git", ["show", `HEAD:${tep}`], { encoding: "utf-8" });
    if (!/salesReviewLabels/.test(nguon)) continue;
    const than = nguon
      .split("\n")
      .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
      .join("\n");
    for (const cam of [/runModelStep/, /\.complete\(/, /callModel/i]) {
      assert.ok(!cam.test(than), `${tep} chạm bảng nhãn người chấm thì KHÔNG được gọi mô hình (${cam})`);
    }
  }
});
