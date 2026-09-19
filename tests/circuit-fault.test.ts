/**
 * KIỂM LỖI CẦU DAO QUA CHÍNH BỘ ĐỊNH TUYẾN — năm tình huống, và một ranh giới.
 *
 * Bài kiểm đơn vị (`tests/provider-circuit.test.ts`) đã canh bảng chính sách. Bài này khác: nó
 * chạy `runModelStep()` THẬT, đếm SỐ LẦN nhà cung cấp bị gọi, và chứng minh cầu dao làm đúng thứ
 * nó sinh ra để làm — CẮT được cơn mưa yêu cầu vô ích.
 *
 * Đếm số lần gọi là phép đo đúng ở đây, vì sự cố 17–19/09 không phải "xử sai một lượt" mà là
 * "xử đúng một lượt, lặp lại 470 lần".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { runModelStep, parseRouting } from "@/lib/ai-workforce/model-router";
import { queueStubResponse, resetStub, stubCalls } from "@/lib/ai-workforce/providers/stub";
import { metricsFor, resetCircuits } from "@/lib/ai-workforce/circuit";
import { missingOrderRequirements } from "@/lib/ai-workforce/agents/sales/confirm";
import { EMPTY_SALES_STATE } from "@/lib/ai-workforce/agents/sales/state";
import type { AiSettings } from "@/lib/ai-workforce/config";

const schema = z.object({ text: z.string() });
const routing = parseRouting({ provider: "stub", tiers: ["ECONOMY", "STRONG"] });

/** Cấu hình tối thiểu để `runModelStep` chịu chạy, không đụng CSDL. */
const SETTINGS = {
  enabled: true,
  modelCallsEnabled: true,
  ingestEnabled: false,
  maxRunsPerHour: 1000,
  autoReplyEnabled: false,
  humanApprovalRequired: true,
  modes: {},
  pricing: {},
  pricingVersion: "",
  hardLimits: { allowAutoSend: false, allowHumanApprovedSend: false, allowOrderCreate: false, maxAllowedMode: "SHADOW" as const },
} as unknown as AiSettings;

async function goiMot() {
  return runModelStep({ step: "fault", system: "s", messages: [{ role: "user", content: "x" }], schema, routing, settings: SETTINGS });
}

/** Dựng N lượt hỏng liên tiếp cùng một nhóm lỗi, rồi đếm nhà cung cấp thật sự bị gọi bao nhiêu lần. */
async function chayNhieuLuot(soLuot: number, loi: string, bat: boolean) {
  const cu = process.env.AI_CIRCUIT_BREAKER_ENABLED;
  process.env.AI_CIRCUIT_BREAKER_ENABLED = bat ? "1" : "0";
  resetStub();
  resetCircuits();
  try {
    const ketQua = [];
    for (let i = 0; i < soLuot; i += 1) {
      // Xếp sẵn dư cho cả hai nấc của mỗi lượt.
      queueStubResponse({ behavior: "error", errorMessage: loi });
      queueStubResponse({ behavior: "error", errorMessage: loi });
      ketQua.push(await goiMot());
    }
    return { ketQua, soLanGoi: stubCalls().length, doAc: metricsFor("stub") };
  } finally {
    if (cu === undefined) delete process.env.AI_CIRCUIT_BREAKER_ENABLED;
    else process.env.AI_CIRCUIT_BREAKER_ENABLED = cu;
  }
}

test("HẾT HẠN MỨC — mở cầu dao, bỏ qua nhà cung cấp, KHÔNG mưa yêu cầu", async () => {
  const HET_TIEN = "openai: 429 You have no credits remaining. Add credits to continue using the API";

  // ── TẮT cầu dao: đúng hành vi cũ, mỗi lượt vẫn gọi đủ hai nấc ──
  const tat = await chayNhieuLuot(10, HET_TIEN, false);
  assert.equal(tat.soLanGoi, 20, "cầu dao tắt ⇒ 10 lượt × 2 nấc = 20 lần gọi — đây chính là cơn mưa yêu cầu của sự cố 17–19/09");
  assert.ok(tat.ketQua.every((r) => r.tier === "HUMAN"), "mọi lượt vẫn phải chuyển người");

  // ── BẬT cầu dao: lượt đầu gọi, các lượt sau bị cắt ──
  const bat = await chayNhieuLuot(10, HET_TIEN, true);
  assert.ok(bat.soLanGoi <= 2, `cầu dao bật ⇒ chỉ lượt ĐẦU được gọi (≤2 lần), đang thấy ${bat.soLanGoi}`);
  assert.ok(bat.soLanGoi < tat.soLanGoi / 4, "phải cắt được phần lớn lượt gọi vô ích");
  assert.equal(bat.doAc.health, "QUOTA_EXHAUSTED");
  assert.equal(bat.doAc.opens, 1, "470 lượt hỏng liên tiếp là MỘT lần mở, không phải 470");
  assert.ok(bat.doAc.skipped >= 8, "phải đếm được số lượt đã bỏ qua — đó là cái giá tiết kiệm được");

  // KẾT LUẬN NGHIỆP VỤ KHÔNG ĐỔI: vẫn là CHUYỂN NGƯỜI, không phải một giá trị bịa.
  assert.ok(bat.ketQua.every((r) => r.tier === "HUMAN" && r.value === null));
});

test("KHOÁ SAI — mở nhanh, và KHÔNG tự dò lại", async () => {
  const bat = await chayNhieuLuot(6, "401 Incorrect API key provided", true);
  assert.ok(bat.soLanGoi <= 2, "khoá sai thì phải cắt ngay từ lượt sau");
  assert.equal(bat.doAc.health, "AUTH_ERROR");
  assert.equal(bat.doAc.probeAfter, null, "khoá sai KHÔNG tự đúng — không được tự dò lại, người phải sửa");
});

test("CHẶN TỐC ĐỘ — vẫn cắt, nhưng mốc dò lại NGẮN hơn hết hạn mức", async () => {
  const chan = await chayNhieuLuot(6, "429 Rate limit reached for requests per minute", true);
  assert.equal(chan.doAc.health, "RATE_LIMITED");
  assert.ok(chan.doAc.probeAfter, "chặn tốc độ PHẢI có mốc dò lại — chờ là qua");

  const het = await chayNhieuLuot(1, "429 You have no credits remaining", true);
  const choChan = chan.doAc.probeAfter!.getTime() - chan.doAc.openedAt!.getTime();
  const choHet = het.doAc.probeAfter!.getTime() - het.doAc.openedAt!.getTime();
  assert.ok(choChan < choHet, "chờ sau chặn tốc độ phải NGẮN hơn chờ sau hết hạn mức");
});

test("QUÁ THỜI GIAN — thử lại có hạn, KHÔNG mở cầu dao", async () => {
  const cu = process.env.AI_CIRCUIT_BREAKER_ENABLED;
  process.env.AI_CIRCUIT_BREAKER_ENABLED = "1";
  resetStub();
  resetCircuits();
  try {
    for (let i = 0; i < 4; i += 1) {
      queueStubResponse({ behavior: "timeout" });
      queueStubResponse({ behavior: "timeout" });
      const r = await goiMot();
      assert.equal(r.tier, "HUMAN");
      assert.equal(r.escalation, "MODEL_TIMEOUT");
    }
    const m = metricsFor("stub");
    // Hết giờ là DẤU HIỆU CHẬP CHỜN, không phải bằng chứng nhà cung cấp chết: có thể là một lượt
    // xui. Mở cầu dao ở đây là tắt một nhà cung cấp còn sống vì mạng vừa nghẽn một nhịp.
    assert.equal(m.health, "DEGRADED");
    assert.equal(m.opens, 0, "hết giờ KHÔNG được mở cầu dao");
    assert.equal(stubCalls().length, 8, "mọi lượt vẫn được thử — hết giờ không cắt đường");
  } finally {
    if (cu === undefined) delete process.env.AI_CIRCUIT_BREAKER_ENABLED;
    else process.env.AI_CIRCUIT_BREAKER_ENABLED = cu;
  }
});

test("KHOẺ — bật cầu dao KHÔNG đổi một hành vi nào", async () => {
  const chay = async (bat: boolean) => {
    const cu = process.env.AI_CIRCUIT_BREAKER_ENABLED;
    process.env.AI_CIRCUIT_BREAKER_ENABLED = bat ? "1" : "0";
    resetStub();
    resetCircuits();
    try {
      const out = [];
      for (let i = 0; i < 5; i += 1) {
        queueStubResponse({ text: JSON.stringify({ text: "ổn" }), inputTokens: 10, outputTokens: 5 });
        const r = await goiMot();
        out.push({ tier: r.tier, value: r.value, lanGoi: r.attempts.length, escalation: r.escalation });
      }
      return { out, tong: stubCalls().length, health: metricsFor("stub").health };
    } finally {
      if (cu === undefined) delete process.env.AI_CIRCUIT_BREAKER_ENABLED;
      else process.env.AI_CIRCUIT_BREAKER_ENABLED = cu;
    }
  };
  const tat = await chay(false);
  const bat = await chay(true);
  // ĐÂY là điều kiện để dám bật trên bản chạy thử: đường khoẻ phải giống hệt nhau tới từng ô.
  assert.deepEqual(bat.out, tat.out, "nhà cung cấp khoẻ thì bật/tắt cầu dao phải ra kết quả GIỐNG HỆT");
  assert.equal(bat.tong, tat.tong, "và gọi đúng bằng ấy lần");
  assert.equal(bat.health, "HEALTHY");
});

test("CẦU DAO KHÔNG ĐƯỢC ĐI VÒNG QUA LƯỚI NGHIỆP VỤ", async () => {
  /*
    Đây là mục 3 của đặc tả, và là chỗ một cơ chế hạ tầng dễ biến thành một lỗ hổng nghiệp vụ
    nhất: nếu "mô hình hỏng" mà lại nới điều kiện lên đơn thì một sự cố mạng thành một đơn sai.

    Dựng đúng tình huống xấu: cầu dao ĐANG MỞ, mô hình không chạy được lượt nào, và trạng thái đơn
    còn thiếu gần hết. Lưới nghiệp vụ phải nói y hệt như lúc mọi thứ bình thường.
  */
  const bat = await chayNhieuLuot(5, "429 You have no credits remaining", true);
  assert.ok(bat.ketQua.every((r) => r.tier === "HUMAN"), "cầu dao mở ⇒ chuyển người");

  const thieu = missingOrderRequirements(EMPTY_SALES_STATE);
  /*
    BỐN, không phải năm. `EMPTY_SALES_STATE.quantity` là 1 — một mặc định hợp lệ, nên số lượng
    KHÔNG thiếu ngay cả trên trạng thái trắng. Bản đầu của bài kiểm này đòi đủ năm và đỏ; cái sai
    nằm ở giả định của bài kiểm, không ở mã. Ghi lại ở đây để lần sau không ai "sửa" mã cho khớp
    một kỳ vọng viết vội.
  */
  for (const k of ["VARIANT", "PHONE", "ADDRESS", "PRICE"]) {
    assert.ok(thieu.includes(k as never), `${k} phải vẫn bị đòi khi cầu dao đang mở`);
  }
  assert.ok(!thieu.includes("QUANTITY"), "số lượng mặc định là 1 nên không thiếu — và cầu dao không được đổi điều đó");

  // Và điều kiện phải GIỐNG HỆT lúc cầu dao đóng: so hai danh sách, không chỉ kiểm từng cái.
  resetCircuits();
  assert.deepEqual(missingOrderRequirements(EMPTY_SALES_STATE), thieu, "đóng hay mở cầu dao, lưới nghiệp vụ nói y hệt");

  // Và chặn cứng cấp môi trường không đổi: máy vẫn không được tự gửi, không được tạo đơn.
  assert.equal(SETTINGS.hardLimits.allowAutoSend, false);
  assert.equal(SETTINGS.hardLimits.allowOrderCreate, false);
});
