import assert from "node:assert/strict";
import { INTRADAY_SCALE_RULE, intradayNextBudget, intradayRateCheck, intradayScaleVerdict } from "@/lib/constants/ads-intraday";
import { ADS_WRITE_LIMITS } from "@/lib/constants/ads-write";
import { BRAKE_OFF, gateIntradayScale, type IntradayGateInput } from "@/lib/marketing/ads-write-gate";

/**
 * ═══════════ LÀN NHANH: TĂNG NGÂN SÁCH TRONG NGÀY ═══════════
 *
 * Ngưỡng chủ shop chốt 24/09/2026 — bài kiểm khoá đúng các biên của chúng, và khoá rằng làn nhanh
 * KHÔNG nới một chốt an toàn nào của đường ghi (máy chủ, phanh, chiến dịch còn chạy, phiếu duyệt,
 * biên độ, trần tiền cả shop). Mốc thời gian dựng tương đối so với `now` lấy lúc chạy (mục 50).
 */
export function testAdsIntraday() {
  const R = INTRADAY_SCALE_RULE;
  assert.deepEqual(
    { ...R },
    { maxCpqcPct: 0.15, minSpendVnd: 300_000, minBookedOrders: 3, stepPct: 0.2, minGapHours: 2, maxPerDay: 3 },
    "bốn ngưỡng là quyết định của chủ shop 24/09/2026 — đổi là đổi quyết định kinh doanh, phải có chủ shop yêu cầu (AGENTS.md mục 7)",
  );
  assert.ok(R.stepPct <= ADS_WRITE_LIMITS.maxStepPct, "bước làn nhanh phải nằm trong trần biên độ chung — nếu không, mọi lượt đều bị cổng chặn");

  /* ─── 1 · NGƯỠNG "RẺ, TỐT" ─── */
  const v = (spend: number, orders: number, revenue: number, spendKnown = true) => intradayScaleVerdict({ spendKnown, spend, bookedOrders: orders, bookedRevenue: revenue });
  assert.equal(v(300_000, 3, 2_000_000).eligible, true, "đúng biên: chi 300k, 3 đơn, %CPQC 15% ⇒ ĐẠT (≤, không phải <)");
  assert.equal(v(300_000, 3, 1_999_000).eligible, false, "%CPQC nhích quá 15% ⇒ chưa đạt");
  assert.equal(v(300_000, 3, 1_999_000).blocker, "TOO_EXPENSIVE");
  assert.equal(v(299_999, 3, 5_000_000).blocker, "SMALL_SAMPLE", "chi thiếu 1 đồng ⇒ chưa đủ mẫu, dù rẻ tới đâu");
  assert.equal(v(500_000, 2, 9_000_000).blocker, "SMALL_SAMPLE", "một, hai đơn may mắn không đủ để bơm tiền");
  assert.equal(v(0, 0, 0, false).blocker, "NO_SPEND_DATA", "chưa có số chi hôm nay là CHƯA BIẾT, không phải chi 0đ (mục 0.3)");
  assert.equal(v(0, 0, 0, false).cpqcPct, null);
  assert.equal(v(400_000, 5, 0).blocker, "TOO_EXPENSIVE", "có đơn mà doanh số 0 ⇒ không tính được %CPQC ⇒ không đạt");
  assert.equal(v(400_000, 5, 0).cpqcPct, null);
  assert.ok(Math.abs((v(450_000, 4, 4_000_000).cpqcPct ?? 0) - 0.1125) < 1e-9);

  /* ─── 2 · NHỊP THEO GIỜ ─── */
  const now = new Date();
  const truoc = (h: number) => new Date(now.getTime() - h * 3_600_000);
  assert.deepEqual(intradayRateCheck([], now), { ok: true }, "chưa tăng lượt nào ⇒ được");
  assert.equal(intradayRateCheck([truoc(2.01)], now).ok, true, "lượt trước cách hơn 2 giờ ⇒ được");
  const gan = intradayRateCheck([truoc(1.5)], now);
  assert.equal(gan.ok, false, "lượt trước mới 1,5 giờ ⇒ chưa được");
  assert.ok(!gan.ok && gan.kind === "GAP" && gan.nextAt && Math.abs(gan.nextAt.getTime() - (truoc(1.5).getTime() + 2 * 3_600_000)) < 1000, "phải nói được MẤY GIỜ thì bấm tiếp được");
  const du = intradayRateCheck([truoc(7), truoc(5), truoc(3)], now);
  assert.ok(!du.ok && du.kind === "MAX_PER_DAY", "đã 3 lượt trong ngày ⇒ hết lượt, dù lượt cuối đã cách 3 giờ");
  assert.equal(intradayRateCheck([truoc(3), truoc(9)], now).ok, true, "thứ tự mốc đưa vào không quan trọng");
  assert.equal(intradayRateCheck([truoc(9), truoc(1)], now).ok, false, "khoảng cách tính từ lượt GẦN NHẤT — lượt 9 giờ trước không che được lượt 1 giờ trước");

  assert.equal(intradayNextBudget(500_000), 600_000, "+20%");
  assert.equal(intradayNextBudget(null), null, "chưa đọc được ngân sách ⇒ không bịa ngân sách đích");

  /* ─── 3 · CỔNG: LÀN NHANH KHÔNG NỚI CHỐT AN TOÀN NÀO ─── */
  const dat = v(450_000, 4, 4_000_000);
  const base: IntradayGateInput = {
    hardEnabled: true,
    mode: "COPILOT",
    confirmed: true,
    brake: BRAKE_OFF,
    status: "ACTIVE",
    verdict: dat,
    rate: { ok: true },
    currentBudgetVnd: 500_000,
    nextBudgetVnd: 600_000,
    shiftedTodayVnd: 0,
  };
  const g = (over: Partial<IntradayGateInput>) => gateIntradayScale({ ...base, ...over });
  const ok = g({});
  assert.ok(ok.allow && ok.action === "SET_DAILY_BUDGET" && ok.deltaVnd === 100_000, "đủ mọi điều kiện ⇒ tăng 100.000đ");
  const chan = (over: Partial<IntradayGateInput>) => {
    const r = g(over);
    return r.allow ? null : r.denial;
  };
  assert.equal(chan({ hardEnabled: false }), "HARD_DISABLED", "công tắc máy chủ vẫn là chốt ngoài cùng");
  assert.equal(chan({ mode: "OFF" }), "MODE_OFF");
  assert.equal(chan({ brake: { on: true, consecutiveWorse: 3, unmeasured: 0 } }), "BRAKE_ON", "phanh của đường ghi chặn cả làn nhanh");
  assert.equal(chan({ status: null }), "SUBJECT_UNREADABLE", "không đọc được Facebook ⇒ không ghi");
  assert.equal(chan({ status: "PAUSED" }), "SUBJECT_NOT_RUNNING", "chiến dịch đã tắt ⇒ tăng ngân sách không làm nó chạy lại");
  assert.equal(chan({ verdict: v(450_000, 4, 1_000_000) }), "INTRADAY_NOT_ELIGIBLE", "đắt hơn ngưỡng ⇒ chặn ở MÁY CHỦ, không tin client");
  assert.equal(chan({ confirmed: false }), "NOT_CONFIRMED", "nấc COPILOT: không có phiếu duyệt hợp lệ thì không ghi");
  assert.equal(chan({ rate: { ok: false, kind: "GAP", reason: "x", nextAt: null } }), "INTRADAY_RATE_LIMIT");
  assert.equal(chan({ currentBudgetVnd: null }), "STEP_TOO_BIG", "chưa biết ngân sách hiện tại ⇒ không ghi");
  assert.equal(chan({ nextBudgetVnd: 500_000 }), "DIRECTION_MISMATCH", "làn nhanh CHỈ TĂNG — ngân sách đích không lớn hơn là đường tính sai");
  assert.equal(chan({ nextBudgetVnd: 400_000 }), "DIRECTION_MISMATCH", "làn nhanh không bao giờ hạ tiền");
  assert.equal(chan({ nextBudgetVnd: 700_000 }), "STEP_TOO_BIG", "tăng 40% vượt trần biên độ 30%");
  assert.equal(chan({ shiftedTodayVnd: ADS_WRITE_LIMITS.maxDailyShiftVnd - 50_000 }), "DAILY_CAP", "trần tiền cả shop trong ngày vẫn giữ");
  // Thứ tự chốt: máy chủ đứng trước mọi thứ, kể cả khi mọi điều kiện khác cũng sai.
  assert.equal(chan({ hardEnabled: false, brake: { on: true, consecutiveWorse: 9, unmeasured: 0 }, status: null, confirmed: false }), "HARD_DISABLED");
  // Chiến dịch trước, căn cứ sau: một chiến dịch đã tắt không cần biết hôm nay nó rẻ hay đắt.
  assert.equal(chan({ status: "PAUSED", verdict: v(0, 0, 0, false) }), "SUBJECT_NOT_RUNNING");

  console.log("✓ Làn nhanh tăng ngân sách trong ngày: ngưỡng chủ shop chốt (≤15% · ≥300k · ≥3 đơn · +20% · cách 2 giờ · 3 lượt/ngày) · chỉ tăng · giữ đủ chốt an toàn của đường ghi");
}
