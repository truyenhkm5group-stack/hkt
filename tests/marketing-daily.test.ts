import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { clearMemo } from "@/lib/cache";
import { getSettingJson } from "@/lib/settings";
import { MARKETING_METRICS, MARKETING_METRIC_BY_KEY, MARKETING_VIEW_COLUMNS, MATURITY, maturityState, ratioOf, type MaturityState } from "@/lib/constants/marketing-daily";
import { MARKETING_DIAGNOSIS, MARKETING_FINDING_ACTIONS, MARKETING_FINDING_KINDS, findingDedupeKey } from "@/lib/constants/marketing-diagnosis";
import { METRIC_BINDINGS } from "@/lib/constants/metric-bindings";
import { canTargetPerson } from "@/lib/constants/metric-registry";
import { MARKETING_AI_SYSTEM, buildAiContext } from "@/lib/marketing/ai-context";
import { MARKETING_TARGET_METRICS } from "@/lib/queries/marketing-targets";
import { baselineOf, diagnose, lossStreakOf, type DiagnoseSnapshot } from "@/lib/marketing/diagnose";
import { digestLines, runMarketingDigest, settledLines } from "@/lib/marketing/digest";
import { getMarketingBreakdown, getMarketingDaily, hasDimensionFilter, type MarketingDailyBase } from "@/lib/queries/marketing-daily";
import { getDailyBreakdown } from "@/lib/queries/reports";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/* ═══════════════════════════════════════════════════════════════════════════════════
   PHẦN A — HỢP ĐỒNG THUẦN (không cần CSDL)
   ═══════════════════════════════════════════════════════════════════════════════════ */

const ZERO: DiagnoseSnapshot = {
  adSpend: 0,
  messages: 0,
  orders: 0,
  posRevenue: 0,
  deliveredRevenue: 0,
  deliveredOrders: 0,
  returnedOrders: 0,
  finishedOrders: 0,
  pendingOrders: 0,
  contributionProfit: 0,
};

const snap = (over: Partial<DiagnoseSnapshot>): DiagnoseSnapshot => ({ ...ZERO, ...over });

/**
 * ═══════════ SỔ CHỈ SỐ PHẢI KHAI ĐỦ TRƯỚC KHI ĐƯỢC HIỂN THỊ ═══════════
 *
 * Một cột không khai được nguồn và cách xử lý CHƯA BIẾT sẽ được đọc bằng phỏng đoán. Bài kiểm này
 * chặn ở mức mã nguồn: thêm một cột mà quên viết hợp đồng của nó thì đỏ ngay, không đợi tới lúc
 * một người nhìn ô `0` rồi đi cắt ngân sách.
 */
export function testMarketingMetricContract() {
  for (const m of MARKETING_METRICS) {
    assert.ok(m.label.length > 1, `${m.key}: thiếu nhãn`);
    assert.ok(m.meaning.length > 10, `${m.key}: phải nói được ô này nghĩa là gì`);
    assert.ok(m.source.length > 5, `${m.key}: phải khai nguồn có thật`);
    assert.ok(m.timing.length > 5, `${m.key}: phải khai đo ở thời điểm nào`);
    assert.ok(m.nullRule.length > 5, `${m.key}: phải khai chưa biết thì in gì`);
    // Ô TỶ LỆ phải khai CẢ tử lẫn mẫu — thiếu một vế thì hàng tổng không tính lại được và sẽ
    // âm thầm rơi về trung bình phần trăm.
    if (m.numerator) assert.ok(m.num && m.den, `${m.key}: đã khai tử số thì phải khai khoá num/den để hàng tổng tính lại được`);
    if (m.num) assert.ok(MARKETING_METRIC_BY_KEY[m.num] || ["finishedOrders", "maturityBase"].includes(m.num), `${m.key}: khoá tử số ${m.num} không tồn tại`);
  }
  // Mọi bộ cột chỉ được dùng khoá có thật.
  for (const [view, keys] of Object.entries(MARKETING_VIEW_COLUMNS)) {
    for (const k of keys) assert.ok(MARKETING_METRIC_BY_KEY[k], `bộ cột ${view} dùng khoá lạ: ${k}`);
  }
  // Mỗi loại phát hiện phải có hành động cụ thể — không có loại nào chỉ báo mà không nói làm gì.
  for (const kind of MARKETING_FINDING_KINDS) {
    const actions = MARKETING_FINDING_ACTIONS[kind];
    assert.ok(actions?.length, `${kind}: phải có đề xuất hành động`);
    for (const a of actions) {
      assert.ok(a.length > 20, `${kind}: hành động phải cụ thể, không phải một câu chung chung`);
      assert.ok(!/^hãy tối ưu/i.test(a), `${kind}: "hãy tối ưu…" không nói được ai mở màn hình nào`);
    }
  }
}

/**
 * ═══════════ CHƯA BIẾT KHÔNG ĐƯỢC THÀNH 0, VÀ MẪU SỐ 0 KHÔNG ĐƯỢC THÀNH VÔ CỰC ═══════════
 */
export function testMarketingRatioNullSafety() {
  // Mẫu số 0 ⇒ null, KHÔNG phải Infinity.
  assert.equal(ratioOf("closeRate", { orders: 40, messages: 0 }), null, "0 tin nhắn ⇒ tỷ lệ chốt CHƯA BIẾT");
  assert.equal(ratioOf("costPerOrder", { adSpend: 5_000_000, orders: 0 }), null, "0 đơn ⇒ CPQC/đơn CHƯA BIẾT, không phải vô cực");
  assert.equal(ratioOf("roasDelivered", { deliveredRevenue: 9_000_000, adSpend: 0 }), null, "chưa chi đồng nào ⇒ ROAS CHƯA BIẾT, không phải 0");
  // Tử số CHƯA BIẾT ⇒ cả ô CHƯA BIẾT. Đây là ca đắt nhất: đồng bộ chi tiêu chết.
  assert.equal(ratioOf("costPerOrder", { adSpend: null, orders: 40 }), null, "chi tiêu chưa biết ⇒ CPQC/đơn chưa biết");
  assert.equal(ratioOf("margin", { contributionProfit: null, deliveredRevenue: 10_000_000 }), null);
  // Số hỏng đi cùng nhánh CHƯA BIẾT.
  assert.equal(ratioOf("closeRate", { orders: Number.NaN, messages: 100 }), null);
  assert.equal(ratioOf("closeRate", { orders: Number.POSITIVE_INFINITY, messages: 100 }), null);
  // Giá trị bình thường: phần trăm quy về 0–100 với một chữ số thập phân.
  assert.equal(ratioOf("closeRate", { orders: 40, messages: 160 }), 25);
  assert.equal(ratioOf("roasDelivered", { deliveredRevenue: 9_000_000, adSpend: 3_000_000 }), 3);
}

/**
 * ═══════════ HÀNG TỔNG TÍNH LẠI TỪ TỬ/MẪU, KHÔNG BAO GIỜ TRUNG BÌNH PHẦN TRĂM ═══════════
 *
 * Bài kiểm dựng đúng cái bẫy: hai ngày lệch hẳn quy mô. Trung bình phần trăm cho ra 37,5%; tính
 * lại từ tử/mẫu cho ra 12,7%. Khoảng cách giữa hai con số ấy là khoảng cách giữa "đội chốt đơn
 * đang tốt" và "đội chốt đơn đang rơi".
 */
export function testMarketingTotalsRecomputeRatios() {
  const d1 = { orders: 5, messages: 10 }; // 50%
  const d2 = { orders: 9, messages: 100 }; // 9%
  const naiveAverage = ((ratioOf("closeRate", d1) as number) + (ratioOf("closeRate", d2) as number)) / 2;
  const correct = ratioOf("closeRate", { orders: d1.orders + d2.orders, messages: d1.messages + d2.messages });
  assert.equal(naiveAverage, 29.5, "trung bình phần trăm của hai ngày");
  assert.equal(correct, 12.7, "tỷ lệ chốt thật của cả kỳ = 14 đơn ÷ 110 tin nhắn");
  assert.notEqual(naiveAverage, correct, "hai cách cho ra hai con số — đó là lý do hàng tổng phải tính lại");

  // CPQC/đơn của cả kỳ cũng vậy.
  const cpa = ratioOf("costPerOrder", { adSpend: 1_000_000 + 9_000_000, orders: 5 + 90 });
  assert.equal(Math.round(cpa as number), 105_263);
}

/** ═══════════ ĐỘ CHÍN: BA NGƯỠNG, VÀ ĐƠN HUỶ KHÔNG NẰM TRONG PHÂN SỐ ═══════════ */
export function testMarketingMaturity() {
  assert.equal(maturityState(0, 0), "NO_ORDERS", "không đơn nào ⇒ không có gì để chín");
  assert.equal(maturityState(100, 0), "FINAL");
  assert.equal(maturityState(96, 4), "FINAL", "96% ≥ ngưỡng ngã ngũ");
  assert.equal(maturityState(80, 20), "PARTIAL");
  assert.equal(maturityState(10, 90), "TOO_EARLY");
  // Biên phải đúng bằng hằng số, không phải một con số gõ lại.
  assert.equal(maturityState(MATURITY.final * 100, (1 - MATURITY.final) * 100), "FINAL");
  assert.equal(maturityState(MATURITY.tooEarly * 100 - 1, 100 - MATURITY.tooEarly * 100 + 1), "TOO_EARLY");
  assert.equal(ratioOf("maturity", { finishedOrders: 80, maturityBase: 100 }), 80);
}

/**
 * ═══════════ MÁY PHÂN TÍCH: BẢNG CHÂN LÝ ═══════════
 *
 * Điều quan trọng nhất ở đây KHÔNG phải là nó phát hiện được gì, mà là nó TỪ CHỐI kết luận ở đâu.
 */
export function testMarketingDiagnose() {
  const R = MARKETING_DIAGNOSIS;
  const kinds = (fs: ReturnType<typeof diagnose>) => fs.map((f) => f.kind);

  // ── 1. Chưa có nền ⇒ chỉ những phát hiện TUYỆT ĐỐI, không bịa một nền ──
  const noBaseline = diagnose({ day: "2026-09-18", current: snap({ adSpend: 5_000_000, messages: 200, orders: 50 }), baseline: null });
  assert.deepEqual(kinds(noBaseline), [], "không nền, không bất thường tuyệt đối ⇒ im lặng");

  // ── 2. Tiêu tiền mà không ra đơn: NÓNG, và KHÔNG chờ độ chín ──
  const hot = diagnose({ day: "2026-09-18", current: snap({ adSpend: R.spendNoOrderHot, messages: 120, orders: 0, pendingOrders: 0 }), baseline: null });
  assert.ok(kinds(hot).includes("SPEND_NO_ORDERS"), "chi đủ lớn mà 0 đơn phải kêu ngay, không đợi hàng giao xong");
  assert.equal(hot[0].severity, "CRITICAL");
  assert.ok(hot[0].evidence.some((e) => e.includes("120")), "phải nêu số tin nhắn thật để phân biệt đứt ở khâu nào");
  // Dưới ngưỡng thì im.
  assert.ok(!kinds(diagnose({ day: "d", current: snap({ adSpend: R.spendNoOrderHot - 1, orders: 0 }), baseline: null })).includes("SPEND_NO_ORDERS"));

  // ── 3. Dưới ngưỡng MẪU thì không kết luận, dù chênh lệch rất lớn ──
  const tinyBase = snap({ adSpend: 1_000_000, messages: 100, orders: 20, finishedOrders: 20, deliveredOrders: 18, returnedOrders: 2, posRevenue: 20_000_000, deliveredRevenue: 18_000_000, contributionProfit: 2_000_000 });
  const tinySample = diagnose({
    day: "d",
    current: snap({ adSpend: 200_000, messages: R.minMessages - 1, orders: 1, finishedOrders: 1, deliveredOrders: 0, returnedOrders: 1 }),
    baseline: tinyBase,
  });
  assert.ok(!kinds(tinySample).includes("CLOSE_RATE_DROP"), `dưới ${R.minMessages} tin nhắn thì tỷ lệ chốt là may rủi, không phải phát hiện`);
  assert.ok(!kinds(tinySample).includes("DELIVERY_DROP"), `dưới ${R.minFinished} đơn đã kết thúc thì GTC dao động quá mạnh để kết luận`);

  // ── 4. CASE B: tin nhắn vẫn về, đơn tụt ⇒ vấn đề ở khâu CHỐT ──
  const closeDrop = diagnose({
    day: "d",
    current: snap({ adSpend: 1_000_000, messages: 200, orders: 10, posRevenue: 10_000_000 }),
    baseline: snap({ adSpend: 1_000_000, messages: 200, orders: 40, posRevenue: 40_000_000 }),
  });
  assert.ok(kinds(closeDrop).includes("CLOSE_RATE_DROP"));
  const cd = closeDrop.find((f) => f.kind === "CLOSE_RATE_DROP");
  assert.ok(cd?.evidence.join(" ").includes("200"), "bằng chứng phải mang số thật của chính ngày đó");
  assert.ok(cd?.actions.some((a) => /kịch bản|phản hồi|hội thoại/i.test(a)), "hành động phải trỏ tới khâu chốt, không phải khâu quảng cáo");

  // ── 5. CPA tăng mà giá tin nhắn KHÔNG tăng ⇒ chẩn đoán phải nói traffic không phải nguyên nhân ──
  const cpaOnly = diagnose({
    day: "d",
    current: snap({ adSpend: 2_000_000, messages: 400, orders: 10 }),
    baseline: snap({ adSpend: 1_000_000, messages: 200, orders: 20 }),
  });
  const cpa = cpaOnly.find((f) => f.kind === "CPA_UP");
  assert.ok(cpa, "CPA gấp đôi phải được phát hiện");
  assert.ok(cpa.evidence.join(" ").includes("KHÔNG tăng tương ứng"), "phải phân biệt được traffic đắt lên với chuyển đổi kém");

  // ── 6. GTC tụt: toàn shop ra DELIVERY_DROP, phạm vi MÃ HÀNG ra RETURN_UP — không bao giờ cả hai ──
  const delivered = { adSpend: 1_000_000, messages: 100, orders: 40, finishedOrders: 40 };
  const now = snap({ ...delivered, deliveredOrders: 24, returnedOrders: 16 }); // 60%
  const before = snap({ ...delivered, deliveredOrders: 34, returnedOrders: 6 }); // 85%
  const shopLevel = kinds(diagnose({ day: "d", current: now, baseline: before }));
  assert.ok(shopLevel.includes("DELIVERY_DROP"), "mức shop: khâu giao đang hỏng");
  assert.ok(!shopLevel.includes("RETURN_UP"), "cùng một phép trừ không được phát ra hai việc");
  const productLevel = kinds(diagnose({ day: "d", scope: "product:Q002", scopeLabel: "Q002", current: now, baseline: before }));
  assert.ok(productLevel.includes("RETURN_UP"), "mức mã hàng: mã này đang bị trả về");
  assert.ok(!productLevel.includes("DELIVERY_DROP"));

  // ── 7. Chưa ngã ngũ ⇒ KHÔNG kết luận về tiền ──
  const immature = diagnose({
    day: "d",
    current: snap({ adSpend: 3_000_000, messages: 200, orders: 50, deliveredRevenue: 2_000_000, finishedOrders: 5, pendingOrders: 45, contributionProfit: -5_000_000 }),
    baseline: snap({ adSpend: 1_000_000, messages: 200, orders: 50, deliveredRevenue: 40_000_000, finishedOrders: 50, pendingOrders: 0, contributionProfit: 10_000_000 }),
  });
  assert.ok(!kinds(immature).includes("COST_OUTRUNS_REVENUE"), "ngày còn 45/50 đơn đang đi luôn trông như lỗ — không được kết luận");

  // ── 8. Khoá chống trùng mang NGÀY: vấn đề kéo dài ba ngày là ba việc thật, không phải một việc lặp ──
  assert.notEqual(findingDedupeKey("CPA_UP", "", "2026-09-18"), findingDedupeKey("CPA_UP", "", "2026-09-19"));
  assert.equal(findingDedupeKey("CPA_UP", "", "2026-09-18"), findingDedupeKey("CPA_UP", "", "2026-09-18"), "cùng ngày cùng phạm vi ⇒ đúng một việc");
  assert.notEqual(findingDedupeKey("CPA_UP", "marketer:a", "2026-09-18"), findingDedupeKey("CPA_UP", "marketer:b", "2026-09-18"));

  // ── 9. Máy phân tích là HÀM THUẦN: chạy hai lần ra đúng cùng kết quả ──
  const a = diagnose({ day: "d", current: now, baseline: before });
  const b = diagnose({ day: "d", current: now, baseline: before });
  assert.deepEqual(a, b, "hàm thuần thì hai lượt phải giống hệt nhau");
}

/** ═══════════ CHUỖI LỖ CHỈ ĐẾM NGÀY ĐÃ NGÃ NGŨ ═══════════ */
export function testMarketingLossStreak() {
  const mature = (profit: number) => ({ contributionProfit: profit, finishedOrders: 95, pendingOrders: 5 });
  const green = (profit: number) => ({ contributionProfit: profit, finishedOrders: 95, pendingOrders: 5 });
  const tooEarly = { contributionProfit: -9_000_000, finishedOrders: 5, pendingOrders: 95 };

  assert.equal(lossStreakOf([mature(-1), mature(-1), mature(-1)]), 3);
  assert.equal(lossStreakOf([mature(-1), green(5), mature(-1)]), 1, "một ngày dương làm đứt chuỗi");
  /*
    NGÀY CHƯA CHÍN KHÔNG KÉO DÀI CHUỖI VÀ CŨNG KHÔNG LÀM ĐỨT CHUỖI.
    Đếm nó là để chuỗi lỗ gần như không bao giờ đứt (ngày mới nào cũng âm), và cảnh báo leo thang
    sẽ kêu mỗi sáng cho tới khi không ai đọc nữa.
  */
  assert.equal(lossStreakOf([mature(-1), mature(-1), tooEarly]), 2, "ngày chưa ngã ngũ bị bỏ qua, không cộng vào chuỗi");
  assert.equal(lossStreakOf([green(5), tooEarly]), 0, "ngày chưa ngã ngũ không tự tạo ra một chuỗi lỗ");
  assert.equal(lossStreakOf([]), 0);
  // Lợi nhuận CHƯA BIẾT (chi tiêu chưa đồng bộ) không được coi là lỗ.
  assert.equal(lossStreakOf([mature(-1), { contributionProfit: null, finishedOrders: 95, pendingOrders: 5 }]), 0, "chưa biết lãi hay lỗ thì không phải một ngày lỗ");
}

/** ═══════════ NỀN SO SÁNH: DƯỚI NGƯỠNG NGÀY THÌ KHÔNG CÓ NỀN, KHÔNG PHẢI NỀN YẾU ═══════════ */
export function testMarketingBaseline() {
  const day = (over: Partial<DiagnoseSnapshot>) => snap(over);
  assert.equal(baselineOf([day({ orders: 10 }), day({ orders: 10 })], 3), null, "hai ngày không đủ để dựng nền — nền yếu còn tệ hơn không có nền");
  const b = baselineOf([day({ orders: 10, adSpend: 1_000_000 }), day({ orders: 20, adSpend: 2_000_000 }), day({ orders: 30, adSpend: 3_000_000 })], 3);
  assert.ok(b);
  assert.equal(b.orders, 20, "nền là TRUNG BÌNH NGÀY, không phải tổng — tổng đem so với một ngày thì ngày nào cũng 'tụt'");
  assert.equal(b.adSpend, 2_000_000);
  // Ngày chưa biết chi tiêu không kéo trung bình xuống bằng cách coi nó là 0.
  const withUnknown = baselineOf([day({ adSpend: null }), day({ adSpend: 3_000_000 }), day({ adSpend: 3_000_000 })], 3);
  assert.equal(withUnknown?.adSpend, 2_000_000, "chia cho SỐ NGÀY của kỳ; ngày chưa biết không đóng góp tử số");
}

/** ═══════════ BẢN TIN KHÔNG BAO GIỜ IN 0 CHO MỘT Ô CHƯA BIẾT ═══════════ */
export function testMarketingDigestLines() {
  const totals: MarketingDailyBase & { maturity: MaturityState } = {
    adSpend: null,
    messages: null,
    orders: 0,
    units: 0,
    posRevenue: 0,
    deliveredRevenue: 0,
    deliveredOrders: 0,
    returnedOrders: 0,
    cancelledOrders: 0,
    pendingOrders: 0,
    shippedOrders: 0,
    finishedOrders: 0,
    maturityBase: 0,
    cogs: 0,
    shippingCost: 0,
    operatingCost: null,
    contributionProfit: null,
    netProfit: null,
    maturity: "NO_ORDERS",
  };
  const lines = digestLines("2026-09-18", { key: "", label: "Toàn shop", totals, findings: [] }, null, "");
  const text = lines.join("\n");
  assert.ok(text.includes("Chi QC: —"), "chi tiêu chưa đồng bộ phải in — chứ không phải 0đ");
  assert.ok(text.includes("Tin nhắn: —"));
  assert.ok(text.includes("Lợi nhuận góp: —"), "chi tiêu chưa biết ⇒ lợi nhuận chưa biết, không phải lỗ 0đ");
  assert.ok(text.includes("Không phát hiện bất thường"), "không có phát hiện thì phải nói ra, không để bản tin cụt");
  // ĐỘ CHÍN luôn đứng CÙNG DÒNG với lợi nhuận — tách ra là mời người đọc dừng ở dòng đầu.
  const profitLine = lines.find((l) => l.startsWith("Lợi nhuận góp"));
  assert.ok(profitLine?.includes("độ chín"), "lợi nhuận và độ chín phải nằm trên cùng một dòng");

  /*
    KHỐI "NGÀY VỪA NGÃ NGŨ" — lý do tồn tại đo được trên production 19/09/2026: 12/14 ngày gần nhất
    có độ chín dưới 60%, nên bản tin về HÔM QUA không bao giờ kết luận được lãi/lỗ. Khối này mang
    câu trả lời cuối cùng của ngày gần nhất đã đủ chín (~10 ngày trước).
  */
  const settled = settledLines({
    ...totals,
    day: "2026-09-08",
    maturity: "FINAL",
    adSpend: 8_000_000,
    orders: 28,
    deliveredOrders: 8,
    returnedOrders: 12,
    deliveredRevenue: 6_000_000,
    finishedOrders: 20,
    maturityBase: 20,
    pendingOrders: 0,
    contributionProfit: -3_000_000,
  });
  const settledText = settled.join("\n");
  assert.ok(settledText.includes("2026-09-08"), "phải nói rõ đang kết luận về NGÀY NÀO");
  assert.ok(settledText.includes("Lợi nhuận góp -3.000.000đ"), "ngày đã chín thì được phép kết luận về tiền");
  assert.ok(settledText.includes("độ chín 100%"), "vẫn in độ chín — kết luận phải mang theo căn cứ của nó");
  // Phễu KHÔNG xuất hiện ở khối này: tin nhắn của một ngày cũ 10 hôm không còn hành động được.
  assert.ok(!settledText.includes("Tin nhắn"), "khối ngày đã chín chỉ in KẾT QUẢ TIỀN, không in phễu");
}

/**
 * ═══════════ BỐI CẢNH ĐƯA CHO AI: KHÔNG DỮ LIỆU THÔ, KHÔNG BIẾN NULL THÀNH 0 ═══════════
 *
 * Bài kiểm này bảo vệ hai thứ khác nhau. Thứ nhất là RIÊNG TƯ: bối cảnh rời khỏi máy chủ, nên nó
 * không được mang đơn hàng, tên khách hay số điện thoại. Thứ hai là TÍNH TRUNG THỰC: một khoá mang
 * giá trị 0 sẽ được mô hình đọc là "không đổi", trong khi sự thật có thể là "không so được".
 */
export function testMarketingAiContext() {
  const totals = {
    adSpend: null,
    messages: null,
    orders: 10,
    units: 12,
    posRevenue: 10_000_000,
    deliveredRevenue: 4_000_000,
    deliveredOrders: 4,
    returnedOrders: 1,
    cancelledOrders: 0,
    pendingOrders: 5,
    shippedOrders: 10,
    finishedOrders: 5,
    maturityBase: 10,
    cogs: 1_000_000,
    shippingCost: 300_000,
    operatingCost: null,
    contributionProfit: null,
    netProfit: null,
  };
  const ctx = buildAiContext({ scopeLabel: "Toàn shop", periodLabel: "30 ngày", basisLabel: "cohort", totals, baseline: null, findings: [], warnings: ["cảnh báo cũ"] });

  // CHƯA BIẾT đi qua nguyên vẹn thành `null`, KHÔNG bị hạ thành 0.
  assert.equal(ctx.funnel.adSpend, null);
  assert.equal(ctx.funnel.costPerOrder, null, "chi tiêu chưa biết ⇒ CPA chưa biết");
  assert.equal(ctx.profit.contributionProfit, null);
  // Không có nền ⇒ KHÔNG có khoá so sánh nào, chứ không phải một loạt khoá bằng 0.
  assert.deepEqual(ctx.vsBaseline, {}, "thiếu nền thì không so — không điền 0");
  // Độ chín 50% ⇒ phải có câu cấm kết luận lãi/lỗ.
  assert.equal(ctx.delivery.maturityPct, 50);
  assert.ok(ctx.caveats.some((c) => c.includes("không phải kết quả cuối cùng")), "chưa chín thì bối cảnh phải nói ra");
  assert.ok(ctx.caveats.includes("cảnh báo cũ"), "cảnh báo của bảng phải đi kèm sang AI");

  // KHÔNG RÒ DỮ LIỆU THÔ: bối cảnh chỉ có số tổng hợp và bằng chứng đã có.
  const json = JSON.stringify(ctx);
  for (const forbidden of ["orderId", "order_id", "customer", "phone", "address", "sku", "trackingCode"]) {
    assert.ok(!json.includes(forbidden), `bối cảnh gửi cho AI không được mang ${forbidden}`);
  }

  // Lời nhắc hệ thống phải cấm đúng ba điều — đây là ranh giới, không phải lời khuyên.
  assert.ok(MARKETING_AI_SYSTEM.includes("KHÔNG tự tính"), "phải cấm mô hình tự tính số tài chính");
  assert.ok(MARKETING_AI_SYSTEM.includes("độ chín"), "phải cấm kết luận lãi/lỗ khi chưa đủ độ chín");
  assert.ok(MARKETING_AI_SYSTEM.includes("hãy tối ưu quảng cáo"), "phải cấm lời khuyên chung chung");
}

/**
 * ═══════════ ĐÍCH ĐI QUA SỔ CHỈ SỐ CHUNG, KHÔNG PHẢI MỘT BẢNG NGƯỠNG RIÊNG ═══════════
 */
export function testMarketingTargetRegistration() {
  for (const m of MARKETING_TARGET_METRICS) {
    const binding = METRIC_BINDINGS[m.metricKey];
    assert.ok(binding, `${m.metricKey}: phải được khai trong METRIC_BINDINGS thì mới đặt đích được`);
    assert.ok(binding.basis.includes("getMarketingDaily"), `${m.metricKey}: phải khai rõ nó đọc cùng bộ máy với màn hình`);
    /*
      CHỈ SỐ DÙNG CHUNG VỚI SỔ CHÍNH phải khai CẢ HAI lối đọc.

      `delivery_success_rate` và `return_rate` cố ý KHÔNG có bản sao mang tiền tố `marketing_`:
      hai khoá cho một phép đo là hai đích có thể nói hai con số (AGENTS.md mục 43). Cái giá là
      một khoá được đọc từ hai truy vấn, và AGENTS.md mục 40 gọi đúng tên nó — "đổi nguồn". Nên ô
      `basis` phải kể ra cả hai, kèm khác biệt population, chứ không được im lặng nhận thêm một
      nguồn thứ hai.
    */
    if (!m.metricKey.startsWith("marketing_")) {
      assert.ok(binding.basis.includes("Hai lối đọc"), `${m.metricKey}: khoá dùng chung phải khai RA cả hai lối đọc trong basis`);
      assert.ok(binding.basis.includes("loại đơn trùng"), `${m.metricKey}: phải nói rõ khác biệt population giữa hai lối đọc`);
    }
    /*
      ĐÍCH CHO MỘT CON NGƯỜI. Chỉ số mà ĐVVC đồng quyết định KHÔNG được mở tầng `USER` — chấm một
      marketer bằng tỷ lệ giao của tuyến đường là chấm họ bằng thứ họ không quyết được
      (AGENTS.md mục 24 và 27). Khoá ở đây, không ở màn hình, vì màn hình nào cũng có thể quên.
    */
    const NGOAI_QUYET = ["marketing_roas_delivered", "marketing_margin", "delivery_success_rate", "return_rate"];
    if (NGOAI_QUYET.includes(m.metricKey)) {
      assert.equal(binding.shared, true, `${m.metricKey}: kết quả do bên ngoài đồng quyết định thì phải mang cờ shared`);
      assert.equal(canTargetPerson(m.metricKey).ok, false, `${m.metricKey}: không được mở đích cho một cá nhân`);
    } else {
      assert.equal(canTargetPerson(m.metricKey).ok, true, `${m.metricKey}: đo được ở mức người thì phải đặt đích cho cá nhân được`);
    }
    // Chiều phải đúng: CPA càng thấp càng tốt. Ghi cứng "UP" sẽ làm điểm ĐẢO NGƯỢC.
    if (m.metricKey === "marketing_cpa") assert.equal(binding.direction, "DOWN", "chi phí một đơn: càng thấp càng tốt");
    if (m.metricKey === "marketing_roas_delivered") assert.equal(binding.direction, "UP");
    // Khoá phải nối được về một ô CÓ THẬT của bảng.
    assert.ok(MARKETING_METRIC_BY_KEY[m.cellKey], `${m.metricKey}: ô ${m.cellKey} không tồn tại trong bảng`);
  }
  // KHÔNG được có bộ ngưỡng mặc định ở bất kỳ đâu trong mã của tính năng này.
  const files = ["lib/constants/marketing-daily.ts", "lib/queries/marketing-targets.ts"].map((f) => readFileSync(f, "utf8")).join("\n");
  assert.ok(!/DEFAULT_TARGET|defaultTarget|targetCpa|TARGET_CPA/i.test(files), "không được khai một đích mặc định — đích là quyết định kinh doanh, sống ở metric_targets");
}

/* ═══════════════════════════════════════════════════════════════════════════════════
   PHẦN B — ĐỐI SOÁT VỚI BỘ MÁY LỢI NHUẬN (cần CSDL)
   ═══════════════════════════════════════════════════════════════════════════════════ */

/**
 * ═══════════ CỔNG QUAN TRỌNG NHẤT CỦA TỆP NÀY ═══════════
 *
 * Báo cáo Hiệu quả marketing theo ngày và Báo cáo lợi nhuận phải nói CÙNG một con số cho cùng một
 * ngày. Không phải "gần đúng" — bằng nhau tới từng đồng, sau khi cộng lại phần đơn TRÙNG mà báo
 * cáo marketing cố ý loại ra (và in ra thành số).
 *
 * Đây là điều kiện để cả hai trang cùng tồn tại. Thiếu nó thì trong vài tuần sẽ có hai con số lợi
 * nhuận cho cùng một tháng, và không ai biết tin cái nào.
 */
export async function testMarketingDailyReconciliation() {
  clearMemo();
  const [daily, canonical] = await Promise.all([getMarketingDaily(ALL, "created"), getDailyBreakdown(ALL, "created")]);

  const canonicalByDay = new Map(canonical.map((r) => [r.day, r]));
  let checked = 0;
  let reconciled = 0;
  let unknownSpendDays = 0;
  for (const row of daily.rows) {
    const c = canonicalByDay.get(row.day);
    if (!c) {
      // Ngày chỉ có chi quảng cáo mà không có đơn nào vẫn là một dòng hợp lệ ở báo cáo marketing.
      assert.equal(row.orders, 0, `ngày ${row.day} có đơn nhưng Báo cáo lợi nhuận không có dòng nào`);
      continue;
    }
    checked += 1;
    assert.equal(row.orders + row.duplicates.orders, c.orders, `ngày ${row.day}: số đơn phải khớp sau khi cộng lại phần trùng`);
    assert.equal(row.deliveredRevenue + row.duplicates.deliveredRevenue, c.revenue, `ngày ${row.day}: doanh thu giao thành công phải khớp`);
    assert.equal(row.deliveredOrders, c.success - 0, `ngày ${row.day}: đơn giao thành công`);
    assert.equal(row.adSpend ?? 0, c.adSpend, `ngày ${row.day}: chi quảng cáo phải đọc cùng một nguồn`);
    assert.equal(row.operatingCost ?? 0, c.operating, `ngày ${row.day}: chi phí vận hành phân bổ phải đi qua cùng bộ máy`);
    // Cước gộp = cước + phí hoàn + phí sàn, đúng cách Báo cáo lợi nhuận cộng ba khoản đó.
    assert.equal(row.shippingCost, c.shipping + c.returnFee + c.marketplaceFee, `ngày ${row.day}: cước và phí`);
    // Lợi nhuận canonical: bằng nhau sau khi cộng lại phần trùng.
    assert.equal(row.cogs, c.cogs, `ngày ${row.day}: giá vốn phải khớp`);

    /*
      LỢI NHUẬN: BẰNG NHAU TỚI TỪNG ĐỒNG, TRỪ ĐÚNG MỘT NGOẠI LỆ ĐƯỢC KHAI TRƯỚC.

      Ngày nằm NGOÀI biên quan sát chi tiêu thì ở đây lợi nhuận là CHƯA BIẾT, còn Báo cáo lợi nhuận
      coi chi tiêu chưa có là 0 rồi vẫn chốt một con số. Đó là khác biệt CÓ CHỦ Ý giữa hai báo cáo,
      không phải sai số — và bài kiểm chặn nó lại đúng ở đó: ngoại lệ chỉ được phép xảy ra khi
      `spendKnown = false`, và khi đó lợi nhuận PHẢI là `null` chứ không phải một con số gần đúng.
    */
    if (!row.spendKnown) {
      assert.equal(row.netProfit, null, `ngày ${row.day}: chi tiêu chưa quan sát được ⇒ lợi nhuận phải là CHƯA BIẾT, không phải một con số`);
      assert.equal(row.contributionProfit, null, `ngày ${row.day}: trừ đi một số chưa biết không ra một con số`);
      assert.ok(daily.spendObservedThrough === null || row.day > daily.spendObservedThrough, `ngày ${row.day}: chỉ ngày NGOÀI biên quan sát mới được phép chưa biết chi tiêu`);
      unknownSpendDays += 1;
      continue;
    }
    const dupProfit = row.duplicates.profitDelta;
    assert.equal(
      (row.netProfit ?? 0) + dupProfit,
      c.netProfit,
      `ngày ${row.day}: LỢI NHUẬN phải khớp Báo cáo lợi nhuận · marketing=${JSON.stringify({ dt: row.deliveredRevenue, cogs: row.cogs, ship: row.shippingCost, ads: row.adSpend, op: row.operatingCost, cp: row.contributionProfit, np: row.netProfit })} · canonical=${JSON.stringify(c)}`,
    );
    reconciled += 1;
  }
  assert.ok(checked > 0, "phải có ít nhất một ngày để đối soát — nếu không, cổng này không kiểm được gì");
  assert.ok(reconciled > 0, "phải có ít nhất một ngày ĐỐI SOÁT ĐƯỢC lợi nhuận — nếu mọi ngày đều 'chưa biết' thì cổng này rỗng");

  // Tổng của cả kỳ cũng phải khớp, trên ĐÚNG những ngày đối soát được.
  const comparable = new Set(daily.rows.filter((r) => r.spendKnown).map((r) => r.day));
  const totalCanonicalProfit = canonical.filter((r) => comparable.has(r.day)).reduce((s, r) => s + r.netProfit, 0);
  const totalDaily = daily.rows.filter((r) => comparable.has(r.day)).reduce((s, r) => s + (r.netProfit ?? 0) + r.duplicates.profitDelta, 0);
  assert.equal(totalDaily, totalCanonicalProfit, "tổng lợi nhuận cả kỳ phải khớp Báo cáo lợi nhuận");

  // Ngày chưa quan sát được chi tiêu phải được NÓI RA, không im lặng để trống.
  if (unknownSpendDays > 0) {
    assert.ok(daily.warnings.some((w) => w.includes("chi quảng cáo")), "có ngày chưa biết chi tiêu thì màn hình phải nói ra, không để người đọc tự đoán");
  }
}

/**
 * ═══════════ HÀNG TỔNG BẰNG TỔNG CÁC NGÀY, VÀ TỶ LỆ ĐƯỢC TÍNH LẠI ═══════════
 */
export async function testMarketingDailyTotals() {
  clearMemo();
  const data = await getMarketingDaily(ALL, "created");
  const sum = (pick: (r: (typeof data.rows)[number]) => number) => data.rows.reduce((s, r) => s + pick(r), 0);
  assert.equal(data.totals.orders, sum((r) => r.orders), "hàng tổng phải bằng tổng các ngày");
  assert.equal(data.totals.deliveredRevenue, sum((r) => r.deliveredRevenue));
  assert.equal(data.totals.cogs, sum((r) => r.cogs));

  // Tỷ lệ của hàng tổng KHÔNG được là trung bình tỷ lệ các ngày.
  const totalRate = ratioOf("deliveryRate", data.totals as unknown as Record<string, unknown>);
  if (totalRate !== null) {
    const expected = ratioOf("deliveryRate", { deliveredOrders: sum((r) => r.deliveredOrders), finishedOrders: sum((r) => r.finishedOrders) });
    assert.equal(totalRate, expected, "tỷ lệ giao của cả kỳ = tổng tử ÷ tổng mẫu");
  }

  // Đơn huỷ KHÔNG nằm trong mẫu số của độ chín.
  assert.equal(data.totals.maturityBase, data.totals.finishedOrders + data.totals.pendingOrders, "đơn huỷ không tham gia độ chín");
}

/**
 * ═══════════ LỌC THEO CHIỀU: CHI PHÍ VẬN HÀNH THÀNH CHƯA BIẾT, KHÔNG THÀNH 0 ═══════════
 *
 * Đây là chỗ dễ sai nhất và tốn tiền nhất. Không có căn cứ nào chia tiền thuê nhà cho một chiến
 * dịch, nên khi lọc thì `netProfit` phải là CHƯA BIẾT. Cho nó rơi về lợi nhuận góp sẽ in ra một
 * khoản lãi không có thật — và người đọc sẽ tăng ngân sách dựa trên đó.
 */
export async function testMarketingDailyFilterHonesty() {
  clearMemo();
  assert.equal(hasDimensionFilter({}), false);
  assert.equal(hasDimensionFilter({ campaignId: "x" }), true);

  const unfiltered = await getMarketingDaily(ALL, "created");
  for (const row of unfiltered.rows) {
    assert.notEqual(row.operatingCost, null, "không lọc ⇒ chi phí vận hành phải đọc được");
  }

  const filtered = await getMarketingDaily(ALL, "created", { campaignId: "khong-ton-tai-campaign" });
  for (const row of filtered.rows) {
    assert.equal(row.operatingCost, null, "có lọc ⇒ chi phí vận hành là CHƯA BIẾT");
    assert.equal(row.netProfit, null, "có lọc ⇒ lợi nhuận canonical là CHƯA BIẾT, KHÔNG rơi về lợi nhuận góp");
  }
  assert.ok(filtered.warnings.some((w) => w.includes("CHƯA BIẾT")), "màn hình phải nói ra vì sao cột trống");

  // Chiều không có số chi: phải nói ra, không âm thầm in 0.
  const adLevel = await getMarketingDaily(ALL, "created", { adId: "khong-ton-tai-ad" });
  assert.ok(adLevel.warnings.some((w) => w.includes("chi quảng cáo")), "lọc theo mẩu quảng cáo ⇒ phải cảnh báo không có số chi");
  for (const row of adLevel.rows) assert.equal(row.spendKnown, false, "cấp mẩu quảng cáo không có số chi — không được chia đều tiền chiến dịch xuống");
}

/**
 * ═══════════ BÓC TÁCH: TỔNG CÁC NHÓM KHÔNG ĐƯỢC VƯỢT DÒNG GỐC ═══════════
 *
 * Mỗi đơn thuộc ĐÚNG MỘT nhóm (kể cả nhóm "Chưa quy kết"), nên bật một chiều lên không được làm
 * đổi tổng. Nhóm chưa quy kết phải có mặt — giấu nó đi là làm tổng của bảng bóc tách nhỏ hơn dòng
 * gốc mà không ai giải thích được.
 */
export async function testMarketingBreakdownConservation() {
  clearMemo();
  const total = await getMarketingDaily(ALL, "created");
  const bd = await getMarketingBreakdown(ALL, "created", "marketer", {}, 50);
  const sumOrders = bd.rows.reduce((s, r) => s + r.orders, 0);
  assert.ok(sumOrders <= total.totals.orders, "bóc tách không được đẻ thêm đơn so với dòng gốc");
  if (total.totals.orders > 0) {
    assert.equal(sumOrders, total.totals.orders, "mỗi đơn thuộc đúng một nhóm marketer (kể cả nhóm chưa quy kết) ⇒ tổng phải bằng");
  }
  // Chiều mẩu quảng cáo không có số chi — cờ phải nói đúng, vì mọi tỷ lệ chia cho chi tiêu phụ thuộc nó.
  const adBd = await getMarketingBreakdown(ALL, "created", "ad", {}, 5);
  assert.equal(adBd.spendGrain, false);
  const campBd = await getMarketingBreakdown(ALL, "created", "campaign", {}, 5);
  assert.equal(campBd.spendGrain, true);

  /*
    ═══ MỘT DÒNG BÓC TÁCH PHẢI BẰNG ĐÚNG BẢNG CHÍNH KHI LỌC THEO CHÍNH NHÓM ẤY ═══

    Đây là cổng quan trọng nhất của phần bóc tách, và nó tồn tại vì một quyết định kỹ thuật cụ thể:
    bản đầu bảo đảm khớp bằng cách CHẠY LẠI đúng đường của bảng chính cho từng nhóm — đúng nhưng
    tốn 48 câu truy vấn và làm trang mất 15,9 giây trên production. Bản này gộp bằng MỘT câu
    `group by` trên cùng bảng dẫn xuất, nên hai bên giờ đi HAI đường mã nguồn khác nhau.

    Hai đường thì phải có người buộc chúng bằng nhau. Bài kiểm này là người đó.
  */
  for (const row of bd.rows.slice(0, 3)) {
    const filtered = await getMarketingDaily(ALL, "created", { marketerId: row.key });
    const t = filtered.totals;
    assert.equal(row.orders, t.orders, `nhóm ${row.label}: số đơn của bóc tách phải bằng bảng chính khi lọc theo chính nhóm ấy`);
    assert.equal(row.deliveredRevenue, t.deliveredRevenue, `nhóm ${row.label}: doanh thu thực`);
    assert.equal(row.deliveredOrders, t.deliveredOrders, `nhóm ${row.label}: đơn giao thành công`);
    assert.equal(row.cogs, t.cogs, `nhóm ${row.label}: giá vốn`);
    assert.equal(row.shippingCost, t.shippingCost, `nhóm ${row.label}: cước và phí`);
    assert.equal(row.units, t.units, `nhóm ${row.label}: số lượng sản phẩm`);
    assert.equal(row.adSpend, t.adSpend, `nhóm ${row.label}: chi quảng cáo`);
    assert.equal(row.contributionProfit, t.contributionProfit, `nhóm ${row.label}: LỢI NHUẬN GÓP`);
    // Cả hai đường đều phải trả `null` cho lợi nhuận canonical: chi phí vận hành không chia được.
    assert.equal(row.netProfit, null, `nhóm ${row.label}: lợi nhuận canonical phải là CHƯA BIẾT`);
    assert.equal(t.netProfit, null);
  }
}

/**
 * ═══════════ XEM TRƯỚC KHÔNG ĐƯỢC GỬI, VÀ KHÔNG ĐƯỢC GHI SỔ ═══════════
 *
 * Một nút "xem trước" lỡ ghi vào sổ chống gửi lại sẽ làm bản tin THẬT của hôm đó bị bỏ qua — và
 * hỏng đúng theo kiểu không ai phát hiện, vì màn hình vẫn hiện đủ nội dung và lượt chạy vẫn báo
 * "đã gửi cho ngày này". Nên bài kiểm này đo hai thứ ở mức TRẠNG THÁI, không tin lời hàm:
 *
 *   1. Sổ `marketing.digest.sent` KHÔNG đổi một byte sau lượt xem trước.
 *   2. Lượt xem trước không báo đã gửi cho phạm vi nào.
 *
 * Nó cũng đo điều ngược lại của bản vá: khối "sẽ KHÔNG gửi" vẫn phải có mặt kèm LÝ DO, vì một bản
 * xem trước chỉ in khối gửi được sẽ làm người bấm tin rằng cả đội đều nhận.
 */
export async function testMarketingDigestPreview() {
  const truoc = JSON.stringify(await getSettingJson<Record<string, string>>("marketing.digest.sent", {}));
  const r = await runMarketingDigest(new Date(), { preview: true });
  const sau = JSON.stringify(await getSettingJson<Record<string, string>>("marketing.digest.sent", {}));

  assert.equal(sau, truoc, "xem trước KHÔNG được chạm sổ chống gửi lại — chạm là bản tin thật của hôm đó biến mất");
  assert.deepEqual(r.sent, [], "xem trước không được gửi một tin nào");
  assert.ok(r.preview.length > 0, "phải dựng được ít nhất bản tổng để xem");

  for (const b of r.preview) {
    assert.ok(b.title.includes(r.day), `khối "${b.scope}" phải nói rõ nó là bản tin của ngày nào`);
    assert.ok(b.lines.length > 0, `khối "${b.scope}" không được rỗng`);
    // Khối không gửi được PHẢI kèm lý do; khối gửi được thì không được bịa ra một lý do.
    if (b.willSend) assert.equal(b.reason, null);
    else assert.ok(b.reason && b.reason.length > 0, `khối "${b.scope}" không gửi thì phải nói vì sao`);
  }
}

/** Điểm vào cho bộ chạy chung. Phần CSDL đi qua `getDb()` như các truy vấn thật, nên không cần tham số. */
export async function testMarketingDaily() {
  testMarketingMetricContract();
  testMarketingRatioNullSafety();
  testMarketingTotalsRecomputeRatios();
  testMarketingMaturity();
  testMarketingDiagnose();
  testMarketingLossStreak();
  testMarketingBaseline();
  testMarketingDigestLines();
  testMarketingAiContext();
  testMarketingTargetRegistration();
  await testMarketingDailyReconciliation();
  await testMarketingDailyTotals();
  await testMarketingDailyFilterHonesty();
  await testMarketingBreakdownConservation();
  await testMarketingDigestPreview();
}
