/**
 * CẦU DAO NHÀ CUNG CẤP — phân loại lỗi, chính sách theo NHÓM, và ranh giới với lưới nghiệp vụ.
 *
 * Bài kiểm này viết quanh một sự cố CÓ THẬT (17–19/09/2026: 470/470 lượt hỏng vì hết hạn mức),
 * nên mỗi khối dưới đây khoá một chỗ mà sự cố ấy đã đi qua được.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  ERROR_POLICY,
  PROVIDER_ERROR_KINDS,
  PROVIDER_HEALTH_STATES,
  circuitOpen,
  healthForError,
  normalizeProviderError,
  probeAfterFor,
} from "@/lib/constants/provider-health";
import { allMetrics, circuitEnabled, metricsFor, recordFailure, recordSuccess, resetCircuits, retriesFor, shouldSkip } from "@/lib/ai-workforce/circuit";

test("429 HẾT TIỀN không được gộp với 429 CHẶN TỐC ĐỘ", () => {
  /*
    Đây là cái lỗi đã làm hệ thống kiên nhẫn thử lại suốt hai ngày. Cùng mã HTTP, hai thế giới:
    chặn tốc độ thì chờ vài giây là qua; hết tiền thì chờ bao lâu cũng không qua.
  */
  const thatSu = "openai: 429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com";
  assert.equal(normalizeProviderError({ message: thatSu }), "QUOTA_EXHAUSTED", "đúng lời lỗi đã xảy ra thật mà còn đọc nhầm thì mọi thứ còn lại vô nghĩa");
  assert.equal(normalizeProviderError({ status: 429, message: "Rate limit reached for requests per minute" }), "RATE_LIMITED");
  assert.equal(normalizeProviderError({ status: 429, message: "insufficient_quota: You exceeded your current quota" }), "QUOTA_EXHAUSTED");
  assert.equal(normalizeProviderError({ message: "Your credit balance is too low to access the API" }), "QUOTA_EXHAUSTED");

  // NGÂN SÁCH TỔ CHỨC / DỰ ÁN là một dạng hết hạn mức: người phải vào bảng điều khiển nới nó.
  // Xếp nó vào "chặn tốc độ" là lặp lại đúng sai lầm cũ, chỉ với một cái tên khác.
  assert.equal(normalizeProviderError({ status: 429, message: "Organization spend limit reached" }), "QUOTA_EXHAUSTED");
  assert.equal(normalizeProviderError({ status: 429, message: "Project budget exceeded" }), "QUOTA_EXHAUSTED");

  // KHOÁ SAI / SAI DỰ ÁN là nhóm thứ tư, không phải hết hạn mức và cũng không phải chặn tốc độ.
  assert.equal(normalizeProviderError({ status: 401, message: "Incorrect API key provided" }), "AUTH_ERROR");
  assert.equal(normalizeProviderError({ status: 403, message: "invalid_project" }), "AUTH_ERROR");

  // Bốn nhóm ấy phải RA BỐN kết quả khác nhau — đặc tả đòi đúng điều này.
  const bon = new Set([
    normalizeProviderError({ message: thatSu }),
    normalizeProviderError({ status: 429, message: "rate limit" }),
    normalizeProviderError({ status: 401, message: "invalid api key" }),
    normalizeProviderError({ message: "socket hang up" }),
  ]);
  assert.equal(bon.size, 4, "bốn nguyên nhân khác nhau phải ra bốn nhóm khác nhau, không gộp thành RATE_LIMIT");
});

test("chính sách đi theo NHÓM LỖI, và thử lại vô ích thì không thử lại", () => {
  for (const k of PROVIDER_ERROR_KINDS) {
    const p = ERROR_POLICY[k];
    assert.ok(p.retries >= 0 && p.retries <= 3, `${k}: số lần thử lại phải nhỏ và có hạn`);
    assert.ok(p.why.length > 20, `${k}: phải nói được VÌ SAO chính sách là vậy`);
    assert.ok((PROVIDER_HEALTH_STATES as readonly string[]).includes(p.health));
  }
  // Hết tiền và khoá sai: KHÔNG thử lại lần nào. Đây là cả bài học của sự cố.
  assert.equal(retriesFor("QUOTA_EXHAUSTED"), 0);
  assert.equal(retriesFor("AUTH_ERROR"), 0);
  // Chặn tốc độ: được thử lại, vì chờ là qua.
  assert.ok(retriesFor("RATE_LIMITED") > 0);

  // Hết tiền mở cầu dao và chờ LÂU; chặn tốc độ mở cầu dao nhưng chờ NGẮN.
  assert.ok(ERROR_POLICY.QUOTA_EXHAUSTED.cooldownMs > ERROR_POLICY.RATE_LIMITED.cooldownMs);
  // Khoá sai: KHÔNG tự dò lại — khoá sai không tự đúng, và spam thêm chỉ tổ khoá tài khoản.
  assert.equal(probeAfterFor("AUTH_ERROR", new Date()), null);

  // Mô hình trả sai cấu trúc KHÔNG được tắt một nhà cung cấp đang khoẻ: đó là chuyện của một câu
  // trả lời, và bộ định tuyến đã có sẵn đường leo nấc.
  assert.equal(ERROR_POLICY.SCHEMA_INVALID.openCircuit, false);
  assert.equal(healthForError("SCHEMA_INVALID"), "HEALTHY");
  assert.equal(healthForError(null), "HEALTHY");
});

test("cầu dao nhớ giữa các lượt, và tính trạng thái LÚC ĐỌC", () => {
  resetCircuits();
  const t0 = new Date("2026-09-17T08:00:00Z");
  assert.equal(shouldSkip("nha-a", t0), false, "chưa hỏng lần nào thì không bỏ qua");

  recordFailure("nha-a", "QUOTA_EXHAUSTED", t0);
  const m = metricsFor("nha-a", t0);
  assert.equal(m.health, "QUOTA_EXHAUSTED");
  assert.equal(m.opens, 1);
  assert.ok(m.probeAfter && m.probeAfter > t0, "phải có mốc dò lại");

  // Trạng thái là hàm của THỜI GIAN, không phải một cờ ghi vào đâu đó.
  assert.equal(circuitOpen({ ...m, skipped: 0 }, new Date(t0.getTime() + 60_000)), true, "chưa tới mốc thì vẫn mở");
  assert.equal(circuitOpen({ ...m, skipped: 0 }, new Date(t0.getTime() + 31 * 60_000)), false, "quá mốc thì cho dò lại");

  // Hỏng liên tiếp KHÔNG được đếm thành nhiều lần mở: nếu không, "số lần mở" chỉ nói lại số lần
  // hỏng, và con số đáng đọc (bao nhiêu lần phải cắt một nhà cung cấp) biến mất.
  for (let i = 0; i < 50; i += 1) recordFailure("nha-a", "QUOTA_EXHAUSTED", new Date(t0.getTime() + i * 1000));
  assert.equal(metricsFor("nha-a", t0).opens, 1, "470 lượt hỏng liên tiếp là MỘT lần mở, không phải 470");

  // Hồi phục: đóng lại, ghi mốc, và chốt quãng đã hỏng.
  const t1 = new Date(t0.getTime() + 40 * 60_000);
  recordSuccess("nha-a", t1);
  const m2 = metricsFor("nha-a", t1);
  assert.equal(m2.health, "HEALTHY");
  assert.equal(m2.openedBy, null);
  assert.deepEqual(m2.recoveredAt, t1);
  assert.ok(m2.degradedMs > 0, "phải đo được đã hỏng bao lâu");
  assert.equal(shouldSkip("nha-a", t1), false);
});

test("TẮT mặc định — nhưng vẫn ĐẾM, để đọc số trước khi bật", () => {
  resetCircuits();
  assert.equal(circuitEnabled(), false, "cầu dao phải TẮT mặc định: một cơ chế bắt đầu bỏ qua lượt gọi là thứ người bật, không phải thứ tự có hiệu lực vì một lượt phát hành");

  const t = new Date("2026-09-17T08:00:00Z");
  recordFailure("nha-b", "QUOTA_EXHAUSTED", t);
  // Khi tắt: KHÔNG bỏ qua lượt nào (hành vi không đổi)…
  assert.equal(shouldSkip("nha-b", t), false);
  // …nhưng vẫn đếm được là "nếu bật thì đã bỏ qua lượt này".
  assert.equal(metricsFor("nha-b", t).skipped, 1, "phải đo được cái giá TRƯỚC khi bật, không phải bật lên mới biết");
  assert.ok(allMetrics(t).some((x) => x.provider === "nha-b"));
});

test("CẦU DAO KHÔNG ĐƯỢC LÀM THAY LƯỚI NGHIỆP VỤ", () => {
  /*
    Đặc tả mục 3, và đây là chỗ một cơ chế hạ tầng dễ biến thành một lỗ hổng nghiệp vụ nhất:
    đổi nhà cung cấp mà đổi luôn mức kiểm tra thì một sự cố mạng trở thành một đơn hàng sai.

    Quét mã ĐÃ VÀO KHO: hai tệp cầu dao không được nhắc tới bất kỳ khái niệm nghiệp vụ nào —
    không điều kiện lên đơn, không máy trạng thái, không chính sách rủi ro, không luật chuyển
    người. Chúng chỉ được nói về nhà cung cấp, lỗi và thời gian.
  */
  const CAM = /missingOrderRequirements|ORDER_REQUIREMENTS|buildOrderDraft|checkContextualConfirmation|salesState|SalesState|handoffReason|HANDOFF_REASONS|nextStage|decide\(/;
  for (const f of ["lib/ai-workforce/circuit.ts", "lib/constants/provider-health.ts"]) {
    const nguon = execFileSync("git", ["show", `HEAD:${f}`], { encoding: "utf-8" })
      .split("\n")
      .filter((d) => !/^\s*(\/\/|\*|\/\*)/.test(d))
      .join("\n");
    assert.ok(!CAM.test(nguon), `${f} đang chạm vào lưới nghiệp vụ — cầu dao chỉ được chọn nhà cung cấp, không được đổi mức kiểm tra`);

    // Và không rẽ nhánh theo TÊN nhà cung cấp: chính sách đi theo nhóm lỗi.
    assert.ok(
      !/["'`](openai|anthropic|google|gemini)["'`]/i.test(nguon),
      `${f} nhắc đích danh một nhà cung cấp — chính sách phải đi theo NHÓM LỖI, không theo logo trên hoá đơn`,
    );
  }
});
