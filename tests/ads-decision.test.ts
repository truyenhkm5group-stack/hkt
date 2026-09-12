import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { ADS_DECISION_RULE, ADS_ACTION_HINT, ADS_ACTION_LABEL, ADS_DIMENSION_HAS_SPEND, type AdsAction } from "@/lib/constants/ads-decision";
import { DECISION_METRIC_HINT, buildDecisionRow, decideAction, getAdsDecision } from "@/lib/queries/ads-decision";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ═══════════ HỢP ĐỒNG CHỈ SỐ & QUY TẮC QUYẾT ĐỊNH QUẢNG CÁO ═══════════
 *
 * Đặc tả: `docs/ads-decision-contract.md`.
 *
 * Khối này khoá ba nhóm điều, và cả ba đều là chỗ đã từng sai ở các báo cáo khác:
 *
 *  1. **TÁCH BẠCH CHIỀU ĐO** — chi tiêu / đơn / giao thành công / GTC / doanh thu / giá vốn / lợi
 *     nhuận góp / lợi nhuận sau quảng cáo là tám con số KHÁC NHAU. Không cái nào được suy ra từ cái
 *     kia, và doanh thu lên đơn KHÔNG BAO GIỜ được dùng thay doanh thu giao thành công.
 *
 *  2. **CHƯA BIẾT LÀ NULL, KHÔNG PHẢI 0** — không có chi tiêu thì không có ROAS; không có đơn thì
 *     không có CAC. In ra số 0 ở những chỗ đó sẽ bị đọc như "quảng cáo miễn phí".
 *
 *  3. **KHÔNG KẾT LUẬN KHI THIẾU DỮ LIỆU** — bảng chân lý của `decideAction` phải từ chối kết luận
 *     trước khi kết luận, và mọi khuyến nghị phải giải thích được bằng số của chính dòng đó.
 */
export async function testAdsDecision(db: Db) {
  // ═══════════ PHẦN A — BẢNG CHÂN LÝ CỦA QUY TẮC QUYẾT ĐỊNH (không cần CSDL) ═══════════
  const r = ADS_DECISION_RULE;
  /** Đầu vào "khoẻ mạnh": đủ tiền, đủ đơn kết thúc, đơn đã ngã ngũ, GTC tốt. */
  const healthy = {
    spendKnown: true,
    spend: r.minSpend * 10,
    headroom: 2,
    successRate: 90,
    maturity: 1,
    finishedOrders: r.minFinishedOrders * 5,
    bookedRoas: 4,
    breakEvenBookedRoas: 2,
    deliveredOrders: 40,
  };

  const truth: { name: string; input: Partial<typeof healthy>; expect: AdsAction }[] = [
    // ── Cổng từ chối kết luận: phải chặn TRƯỚC mọi phán xét về tiền ──
    { name: "không có số chi (cấp mẩu/nhóm)", input: { spendKnown: false }, expect: "NO_SPEND_DATA" },
    { name: "chi dưới ngưỡng tối thiểu", input: { spend: r.minSpend - 1 }, expect: "INSUFFICIENT_DATA" },
    { name: "quá ít đơn đã kết thúc", input: { finishedOrders: r.minFinishedOrders - 1 }, expect: "INSUFFICIENT_DATA" },
    { name: "phần lớn đơn còn đang đi", input: { maturity: r.minMaturity - 0.01 }, expect: "INSUFFICIENT_DATA" },
    // Chưa đủ dữ liệu phải THẮNG cả khi con số tiền trông rất tệ — không được vội kết luận CẮT.
    { name: "lỗ nặng nhưng chưa đủ dữ liệu", input: { spend: r.minSpend - 1, headroom: 0.1 }, expect: "INSUFFICIENT_DATA" },

    // ── Thang lợi nhuận, đo bằng khoảng cách tới điểm hoà vốn ──
    { name: "trên hoà vốn nhiều", input: { headroom: r.scaleAbove }, expect: "SCALE" },
    { name: "trên hoà vốn nhưng mỏng", input: { headroom: 1 }, expect: "HOLD" },
    { name: "ngay dưới hoà vốn", input: { headroom: 0.99 }, expect: "WATCH" },
    { name: "đúng mép cắt", input: { headroom: r.cutBelow }, expect: "WATCH" },
    { name: "dưới mép cắt", input: { headroom: r.cutBelow - 0.01 }, expect: "CUT" },

    // ── Quảng cáo tốt nhưng giao kém: phải chỉ đúng bệnh, không đổ cho quảng cáo ──
    {
      name: "GTC thấp nhưng ROAS lên đơn đã vượt hoà vốn",
      input: { successRate: r.lowSuccessRate - 1, headroom: 0.9, bookedRoas: 4, breakEvenBookedRoas: 2 },
      expect: "FIX_DELIVERY",
    },
    // GTC thấp VÀ quảng cáo cũng kém ⇒ đây là vấn đề của quảng cáo, phải CẮT chứ không phải sửa khâu giao.
    {
      name: "GTC thấp và ROAS lên đơn cũng dưới hoà vốn",
      input: { successRate: r.lowSuccessRate - 1, headroom: 0.3, bookedRoas: 1.2, breakEvenBookedRoas: 2 },
      expect: "CUT",
    },
    // Đang lãi dày thì dù GTC thấp vẫn là SCALE — nhưng cờ `lowDelivery` phải bật để không ai bỏ sót.
    { name: "GTC thấp nhưng vẫn lãi dày", input: { successRate: r.lowSuccessRate - 1, headroom: 3 }, expect: "SCALE" },
  ];

  for (const c of truth) {
    const got = decideAction({ ...healthy, ...c.input });
    assert.equal(got.action, c.expect, `quy tắc quyết định — ${c.name}: mong ${c.expect}, nhận ${got.action} (${got.reason})`);
    // MỌI khuyến nghị phải giải thích được, và lời giải thích phải có SỐ chứ không chỉ có chữ.
    assert.ok(got.reason.length > 20, `${c.name}: khuyến nghị phải có lời giải thích`);
    if (c.expect !== "NO_SPEND_DATA") {
      assert.ok(/\d/.test(got.reason), `${c.name}: lời giải thích phải dẫn số thật, không được chung chung — "${got.reason}"`);
    }
  }

  // Cờ "giao kém" là dấu hiệu ĐỘC LẬP với hành động: bật bất cứ khi nào GTC dưới ngưỡng.
  assert.equal(decideAction({ ...healthy, successRate: r.lowSuccessRate - 1, headroom: 3 }).lowDelivery, true);
  assert.equal(decideAction({ ...healthy, successRate: r.lowSuccessRate + 1 }).lowDelivery, false);
  // Chưa có đơn nào kết thúc ⇒ GTC là null ⇒ KHÔNG được coi là "giao kém".
  assert.equal(decideAction({ ...healthy, successRate: null }).lowDelivery, false, "GTC chưa biết không phải là GTC thấp");

  // ═══════════ PHẦN B — CÔNG THỨC TIỀN TRÊN MỘT DÒNG DỰNG SẴN ═══════════
  /**
   * Một dòng có số tròn để kiểm được từng phép tính bằng tay:
   * 10 đơn lên (10.000.000đ), 8 giao thành công (8.000.000đ), 2 hoàn, giá vốn 4.000.000đ,
   * cước 500.000đ (tính trên CẢ 10 đơn), chi quảng cáo 1.000.000đ.
   */
  const row = buildDecisionRow(
    {
      key: "camp-x",
      name: "Chiến dịch X",
      bookedOrders: 10,
      deliveredOrders: 8,
      returnedOrders: 2,
      openOrders: 0,
      bookedRevenue: 10_000_000,
      deliveredRevenue: 8_000_000,
      cash: 7_000_000,
      cogs: 4_000_000,
      shipping: 500_000,
    },
    "campaign",
    1_000_000,
    true,
  );

  assert.equal(row.contributionBeforeAds, 3_500_000, "lợi nhuận góp trước QC = 8.000.000 − 4.000.000 − 500.000");
  assert.equal(row.profitAfterAds, 2_500_000, "lợi nhuận góp sau QC = 3.500.000 − 1.000.000 tiền quảng cáo");
  assert.equal(row.successRate, 80, "GTC = 8 ÷ (8 + 2), đơn đang đi không nằm ở mẫu số");
  assert.equal(row.maturity, 1, "10/10 đơn đã ngã ngũ");
  assert.equal(row.marginRate, 0.44, "biên lợi nhuận góp = 3.500.000 ÷ 8.000.000 (làm tròn 2 chữ số)");
  assert.equal(row.bookedRoas, 10, "ROAS lên đơn = 10.000.000 ÷ 1.000.000");
  assert.equal(row.deliveredRoas, 8, "ROAS giao thành công = 8.000.000 ÷ 1.000.000");
  assert.equal(row.cashRoas, 7, "ROAS tiền về = 7.000.000 ÷ 1.000.000");
  assert.equal(row.headroom, 3.5, "khoảng cách tới hoà vốn = lợi nhuận góp trước QC ÷ chi QC");
  assert.equal(row.cacDelivered, 125_000, "CAC giao thành công = 1.000.000 ÷ 8 đơn tới tay khách");
  assert.equal(row.action, "SCALE");

  // ROAS HOÀ VỐN: hai con số, hai cơ sở khác nhau — và cái trên ĐƠN LÊN luôn cao hơn.
  assert.equal(row.breakEvenDeliveredRoas, 2.27, "ROAS giao TC hoà vốn = 1 ÷ 0,44");
  assert.ok(
    row.breakEvenBookedRoas !== null && row.breakEvenBookedRoas > row.breakEvenDeliveredRoas!,
    "ROAS LÊN ĐƠN hoà vốn phải cao hơn ROAS GIAO TC hoà vốn — vì còn phải gánh phần đơn sẽ hoàn",
  );

  /**
   * ĐIỂM HOÀ VỐN PHẢI TỰ NHẤT QUÁN: ở đúng mức ROAS hoà vốn thì lợi nhuận sau quảng cáo bằng 0.
   * Đây là phép thử khoá chặt nhất — nó bắt mọi sai lệch trong định nghĩa biên.
   */
  const spendAtBreakEven = row.deliveredRevenue / row.breakEvenDeliveredRoas!;
  assert.ok(
    Math.abs(row.contributionBeforeAds - spendAtBreakEven) < row.deliveredRevenue * 0.01,
    `chi đúng mức hoà vốn (${Math.round(spendAtBreakEven)}đ) thì lợi nhuận góp sau QC phải ≈ 0`,
  );

  // CHƯA BIẾT LÀ NULL, KHÔNG PHẢI 0.
  const noSpend = buildDecisionRow(
    { key: "ad-1", name: "Mẩu 1", bookedOrders: 5, deliveredOrders: 4, returnedOrders: 1, openOrders: 0, bookedRevenue: 5_000_000, deliveredRevenue: 4_000_000, cash: 3_000_000, cogs: 2_000_000, shipping: 200_000 },
    "ad",
    0,
    false,
  );
  assert.equal(noSpend.spendKnown, false);
  for (const key of ["bookedRoas", "deliveredRoas", "cashRoas", "headroom", "cacDelivered"] as const) {
    assert.equal(noSpend[key], null, `không biết chi tiêu thì ${key} phải là null, không phải 0`);
  }
  assert.equal(noSpend.action, "NO_SPEND_DATA");
  // Nhưng những chỉ số KHÔNG phụ thuộc tiền thì vẫn phải tính được ở cấp mẩu quảng cáo.
  assert.equal(noSpend.successRate, 80, "GTC không cần biết chi tiêu vẫn tính được");
  assert.equal(noSpend.deliveredRevenue, 4_000_000);

  // Chưa có doanh thu giao thành công ⇒ không có biên ⇒ KHÔNG có điểm hoà vốn (không phải 0).
  const burned = buildDecisionRow(
    { key: "camp-burn", name: "Đốt tiền", bookedOrders: 0, deliveredOrders: 0, returnedOrders: 0, openOrders: 0, bookedRevenue: 0, deliveredRevenue: 0, cash: 0, cogs: 0, shipping: 0 },
    "campaign",
    5_000_000,
    true,
  );
  assert.equal(burned.breakEvenDeliveredRoas, null, "không có doanh thu thì không có điểm hoà vốn");
  assert.equal(burned.breakEvenBookedRoas, null);
  assert.equal(burned.marginRate, null);
  assert.equal(burned.profitAfterAds, -5_000_000, "tiêu 5 triệu không ra đơn = lỗ đúng 5 triệu");

  // ═══════════ PHẦN C — CHẠY THẬT TRÊN CSDL ═══════════
  await db.insert(schema.fbAds).values({ id: "ad-dec-1", name: "Mẩu QC quyết định", adsetId: "adset-dec-1", campaignId: "camp-dec-1", campaignName: "Chiến dịch quyết định" }).onConflictDoNothing();
  await db.insert(schema.adSpends).values({
    platform: "FACEBOOK",
    campaign: "Chiến dịch quyết định",
    campaignId: "camp-dec-1",
    spend: 2_000_000,
    spendDate: new Date("2026-09-01T00:00:00Z"),
    createdBy: "test",
  });
  for (const [idx, spec] of [
    { stage: "DELIVERED", collected: 900_000, total: 1_000_000, code: "DEC-OK-1" },
    { stage: "DELIVERED", collected: 900_000, total: 1_000_000, code: "DEC-OK-2" },
    { stage: "RETURNED", collected: 0, total: 1_000_000, code: "DEC-HOAN" },
  ].entries()) {
    const orderId = `dec-order-${idx}`;
    await db.insert(schema.orders).values({
      id: orderId,
      stage: "SHIPPED",
      adId: "ad-dec-1",
      cod: spec.total,
      totalPriceAfterDiscount: spec.total,
      prepaid: 0,
      insertedAt: new Date("2026-09-02T00:00:00Z"),
    });
    await db.insert(schema.shipments).values({
      orderId,
      vtpOrderNumber: spec.code,
      trackingCode: spec.code,
      stage: spec.stage as never,
      codAmount: spec.total,
      codCollected: spec.collected,
      shippingFee: 30_000,
      vtpStatusDate: new Date("2026-09-03T00:00:00Z"),
      deliveredAt: spec.stage === "DELIVERED" ? new Date("2026-09-03T00:00:00Z") : null,
    });
  }

  clearMemo();
  const decision = await getAdsDecision(ALL, "campaign");
  const camp = decision.rows.find((x) => x.key === "camp-dec-1");
  assert.ok(camp, "chiến dịch có đơn gắn ad_id phải xuất hiện trong bảng quyết định");
  assert.equal(camp.spend, 2_000_000);
  assert.equal(camp.bookedOrders, 3, "cả ba đơn đều tính vào doanh thu lên đơn");
  assert.equal(camp.deliveredOrders, 2);
  assert.equal(camp.returnedOrders, 1);
  assert.equal(camp.bookedRevenue, 3_000_000);
  assert.equal(camp.deliveredRevenue, 2_000_000, "đơn hoàn KHÔNG được tính vào doanh thu giao thành công");
  assert.equal(camp.cashReceived, 1_800_000, "tiền về là số THỰC THU có chứng từ, không phải COD khai báo");
  assert.equal(camp.successRate, 66.7, "GTC = 2 ÷ 3 đơn đã kết thúc, giữ một chữ số thập phân như successRate()");
  // Cước tính trên CẢ BA đơn (đơn hoàn vẫn tốn cước) = 90.000đ.
  assert.equal(camp.shippingCost, 90_000, "cước phải tính cả trên đơn hoàn");

  // ───────── Bất biến của mọi dòng, mọi cấp ─────────
  for (const dimension of ["campaign", "product", "adset", "ad"] as const) {
    clearMemo();
    const d = await getAdsDecision(ALL, dimension);
    assert.equal(d.dimension, dimension);
    for (const x of d.rows) {
      assert.equal(x.spendKnown, ADS_DIMENSION_HAS_SPEND[dimension], `${dimension}/${x.name}: cờ biết-chi-tiêu phải theo đúng khả năng của DỮ LIỆU`);
      // DOANH THU LÊN ĐƠN KHÔNG BAO GIỜ ĐƯỢC DÙNG THAY DOANH THU GIAO THÀNH CÔNG.
      assert.ok(x.bookedRevenue >= x.deliveredRevenue, `${x.name}: doanh thu lên đơn phải ≥ doanh thu giao thành công`);
      assert.ok(x.bookedOrders >= x.deliveredOrders, `${x.name}: đơn lên phải ≥ đơn giao thành công`);
      assert.equal(x.contributionBeforeAds, x.deliveredRevenue - x.cogs - x.shippingCost, `${x.name}: lợi nhuận góp phải đúng định nghĩa`);
      assert.equal(x.profitAfterAds, x.contributionBeforeAds - x.spend, `${x.name}: lợi nhuận sau QC phải đúng định nghĩa`);
      if (!x.spendKnown) {
        assert.equal(x.deliveredRoas, null, `${x.name}: không biết chi tiêu thì không có ROAS`);
        assert.equal(x.headroom, null);
        assert.equal(x.action, "NO_SPEND_DATA", `${x.name}: không có tiền thì không có khuyến nghị về tiền`);
      }
      if (x.spendKnown && x.spend === 0) assert.equal(x.deliveredRoas, null, `${x.name}: chia cho 0 là vô nghĩa, phải trả null`);
      if (x.deliveredOrders === 0) assert.equal(x.cacDelivered, null, `${x.name}: chưa giao đơn nào thì không có CAC`);
      assert.ok(x.reason.length > 0, `${x.name}: mọi dòng phải nói được VÌ SAO`);
    }
    // Tổng phải bằng tổng các dòng — không được cộng thêm hay bớt đi thứ gì.
    assert.equal(d.totals.spend, d.rows.reduce((t, x) => t + x.spend, 0), `${dimension}: tổng chi phải bằng tổng các dòng`);
    assert.equal(d.totals.deliveredRevenue, d.rows.reduce((t, x) => t + x.deliveredRevenue, 0), `${dimension}: tổng doanh thu giao TC phải bằng tổng các dòng`);
    assert.equal(d.totals.profitAfterAds, d.rows.reduce((t, x) => t + x.profitAfterAds, 0), `${dimension}: tổng lợi nhuận sau QC phải bằng tổng các dòng`);
    // Độ tin cậy phải luôn đi kèm — bảng không được im lặng về việc mình chỉ mô tả phần quy kết được.
    assert.ok(d.confidence.coveragePct >= 0 && d.confidence.coveragePct <= 100, `${dimension}: độ phủ phải là phần trăm hợp lệ`);
    assert.ok(["SUFFICIENT", "DATA_INSUFFICIENT"].includes(d.confidence.verdict));
    assert.ok(d.pending.spendInsufficientData >= 0 && d.pending.spendWithoutOrders >= 0);
  }

  // Cấp mẩu/nhóm KHÔNG được kết luận tiền chiến dịch là "không có đơn nào" — khoá không cùng không gian.
  for (const dimension of ["ad", "adset"] as const) {
    clearMemo();
    const d = await getAdsDecision(ALL, dimension);
    assert.equal(d.pending.spendWithoutOrders, 0, `${dimension}: không được quy tiền chiến dịch vào cấp này`);
    assert.equal(d.totals.spend, 0, `${dimension}: cấp này không có tiền, và 0 ở đây nghĩa là KHÔNG BIẾT`);
  }

  // Nhãn & giải thích: giao diện dựa hoàn toàn vào đây nên không được thiếu.
  for (const action of Object.keys(ADS_ACTION_LABEL) as AdsAction[]) {
    assert.ok(ADS_ACTION_LABEL[action].length > 0, `${action} phải có nhãn tiếng Việt`);
    assert.ok(ADS_ACTION_HINT[action].length > 40, `${action} phải có giải nghĩa đủ dài để hiện tooltip`);
  }
  for (const [key, hint] of Object.entries(DECISION_METRIC_HINT)) {
    assert.ok(hint.length > 40, `chỉ số ${key} phải có giải nghĩa cho tooltip`);
  }

  console.log(
    `✓ Quyết định quảng cáo: ${truth.length} nhánh quy tắc · ${decision.rows.length} chiến dịch · ` +
      `chi ${decision.totals.spend}đ · LN sau QC ${decision.totals.profitAfterAds}đ · độ phủ ${decision.confidence.coveragePct}%`,
  );
}
