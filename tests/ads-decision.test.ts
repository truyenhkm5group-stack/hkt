import assert from "node:assert/strict";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { ADS_DECISION_RULE, ADS_ACTION_HINT, ADS_ACTION_LABEL, ADS_DIMENSION_HAS_SPEND, type AdsAction, type DecisionBasis, isConclusive, rowsToRender, spendClassOf } from "@/lib/constants/ads-decision";
import { DECISION_METRIC_HINT, buildDecisionRow, decideAction, getAdsDecision, inheritVerdict } from "@/lib/queries/ads-decision";
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
    projectedHeadroom: 2,
    successRate: 90,
    maturity: 1,
    finishedOrders: r.minFinishedOrders * 5,
    bookedOrders: r.minFinishedOrders * 5,
    appliedDeliveryRate: 90,
    bookedRoas: 4,
    breakEvenBookedRoas: 2,
    deliveredOrders: 40,
  };

  const truth: { name: string; input: Partial<typeof healthy>; expect: AdsAction; basis?: DecisionBasis }[] = [
    // ── Cổng từ chối kết luận: phải chặn TRƯỚC mọi phán xét về tiền ──
    { name: "không có số chi (cấp mẩu/nhóm)", input: { spendKnown: false }, expect: "NO_SPEND_DATA" },
    { name: "chi dưới ngưỡng tối thiểu", input: { spend: r.minSpend - 1 }, expect: "INSUFFICIENT_DATA" },
    // Chưa đủ dữ liệu phải THẮNG cả khi con số tiền trông rất tệ — không được vội kết luận CẮT.
    { name: "lỗ nặng nhưng chưa đủ dữ liệu", input: { spend: r.minSpend - 1, headroom: 0.1 }, expect: "INSUFFICIENT_DATA" },

    /*
      ═══════════ ĐỘ CHÍN THẤP ĐỔI CĂN CỨ, KHÔNG CÒN CHẶN KẾT LUẬN ═══════════

      Hai dòng đầu của khối này TRƯỚC 22/09/2026 đều trả `INSUFFICIENT_DATA`. Với mô hình BÁN
      TRƯỚC đó là câu trả lời cho gần như MỌI dòng — đo trên production: 425/425 dòng cấp chiến
      dịch, độ chín trung bình 0,02. Nay chúng quyết trên LỢI NHUẬN TẠM TÍNH và mang nhãn
      `PROJECTED`.
    */
    { name: "chưa đủ đơn kết thúc ⇒ quyết trên tạm tính", input: { finishedOrders: r.minFinishedOrders - 1 }, expect: "SCALE", basis: "PROJECTED" },
    { name: "phần lớn đơn còn đang đi ⇒ quyết trên tạm tính", input: { maturity: r.minMaturity - 0.01 }, expect: "SCALE", basis: "PROJECTED" },
    // Tạm tính vẫn CẮT được: đây là vế phải của cùng một thang, không phải một chế độ "chỉ khen".
    {
      name: "tạm tính dưới mép cắt",
      input: { maturity: 0, finishedOrders: 0, projectedHeadroom: r.cutBelow - 0.01 },
      expect: "CUT",
      basis: "PROJECTED",
    },
    /*
      YÊU CẦU VỀ MẪU KHÔNG ĐƯỢC NỚI RA. Căn cứ tạm tính đếm đơn ĐÃ LÊN thay vì đã kết thúc, nhưng
      vẫn đòi đúng ngần ấy đơn — bỏ vế này thì một dòng ba đơn cũng có ý kiến.
    */
    {
      name: "chưa đủ đơn ĐÃ LÊN thì vẫn từ chối, kể cả ở căn cứ tạm tính",
      input: { maturity: 0, finishedOrders: 0, bookedOrders: r.minFinishedOrders - 1 },
      expect: "INSUFFICIENT_DATA",
      basis: "PROJECTED",
    },
    /*
      SỐ ĐO THẮNG SỐ ƯỚC TÍNH. Dòng đã đủ chín thì `projectedHeadroom` không được nhìn tới — nếu
      không, một giả định lạc quan sẽ ghi đè lên kết quả đã đo được.
    */
    { name: "đủ chín thì bỏ qua số tạm tính", input: { headroom: 2, projectedHeadroom: 0.1 }, expect: "SCALE", basis: "ACTUAL" },
    {
      name: "đủ chín và lỗ thật thì cắt, dù tạm tính đẹp",
      input: { headroom: 0.3, projectedHeadroom: 5 },
      expect: "CUT",
      basis: "ACTUAL",
    },

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
    /*
      "SỬA KHÂU GIAO" LÀ MỘT KHẲNG ĐỊNH VỀ THỰC TẾ, NÊN NÓ CHỈ ĐỨNG TRÊN SỐ ĐO.

      Ở căn cứ tạm tính, tỷ lệ giao thành công tính trên vài đơn đã ngã ngũ là tiếng ồn — và tệ hơn,
      phần đang treo đã được cân bằng CHÍNH tỷ lệ ước tính, nên kết luận "khâu giao đang kém" sẽ là
      đọc ngược lại giả định của chính mình.
    */
    {
      name: "căn cứ tạm tính không được kết luận sửa khâu giao",
      input: {
        maturity: 0,
        finishedOrders: 0,
        successRate: r.lowSuccessRate - 1,
        projectedHeadroom: 0.9,
        bookedRoas: 4,
        breakEvenBookedRoas: 2,
      },
      expect: "WATCH",
      basis: "PROJECTED",
    },
  ];

  for (const c of truth) {
    const got = decideAction({ ...healthy, ...c.input });
    assert.equal(got.action, c.expect, `quy tắc quyết định — ${c.name}: mong ${c.expect}, nhận ${got.action} (${got.reason})`);
    if (c.basis) assert.equal(got.basis, c.basis, `${c.name}: căn cứ phải là ${c.basis}, nhận ${got.basis}`);
    /*
      CĂN CỨ PHẢI ĐỌC ĐƯỢC TRÊN CHÍNH LỜI GIẢI THÍCH, không chỉ nằm trong một trường dữ liệu. Chủ
      shop đọc câu chữ, và một câu "đang lãi 158%" không nói ra rằng 158% ấy là giả định thì nó là
      một lời khẳng định sai (AGENTS.md mục 8.6).
    */
    if (got.basis === "PROJECTED" && got.action !== "INSUFFICIENT_DATA" && got.action !== "NO_SPEND_DATA") {
      assert.ok(got.reason.startsWith("[TẠM TÍNH]"), `${c.name}: lời giải thích ở căn cứ ước tính phải tự khai là ước tính — "${got.reason}"`);
    }
    if (got.basis === "ACTUAL") {
      assert.ok(!got.reason.includes("TẠM TÍNH"), `${c.name}: dòng đã đủ chín không được gắn nhãn ước tính`);
    }
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
      notShippedOrders: 0,
      notShippedRevenue: 0,
      inTransitOrders: 0,
      inTransitRevenue: 0,
      bookedRevenue: 10_000_000,
      deliveredRevenue: 8_000_000,
      cash: 7_000_000,
      cogs: 4_000_000,
      shipping: 500_000,
      openProjectedRevenue: 0,
      openProjectedCogs: 0,
      openProjectedShipping: 0,
      openProjectedOrders: 0,
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

  // Dòng đã đủ chín thì hai căn cứ phải TRÙNG NHAU: không có gì đang treo để mà ước tính.
  assert.equal(row.basis, "ACTUAL");
  assert.equal(row.appliedDeliveryRate, null, "không đơn nào đang treo ⇒ không có tỷ lệ nào được áp — null, không phải 0%");
  assert.equal(row.projectedDeliveredRevenue, row.deliveredRevenue, "không có phần treo thì doanh thu tạm tính = doanh thu đã đo");
  assert.equal(row.projectedProfitAfterAds, row.profitAfterAds);
  assert.equal(row.projectedHeadroom, row.headroom);

  /*
    ═══════════ PHẦN B2 — ĐỔI CĂN CỨ ĐẢO NGƯỢC KẾT LUẬN, VÀ ĐÓ LÀ MỤC ĐÍCH ═══════════

    Một chiến dịch ĐIỂN HÌNH của mô hình bán trước: 20 đơn đã lên, mới 5 đơn ngã ngũ, 15 đơn còn ở
    xưởng hoặc trên đường. Số tiền đã VỀ mới có 4 triệu trong khi quảng cáo đã tiêu 3 triệu.

      · căn cứ SỐ ĐO     → lợi nhuận góp 1.750.000đ ÷ 3.000.000đ = 0,58× hoà vốn ⇒ đọc như đang lỗ nặng
      · căn cứ TẠM TÍNH  → 15 triệu đang treo × GTC 80% = 12 triệu sẽ về ⇒ 2,58× hoà vốn ⇒ CÒN DƯ ĐỊA

    Bản trước không nói câu nào trong hai câu đó — nó trả `INSUFFICIENT_DATA` vì độ chín 25% dưới
    ngưỡng 60%. Đúng là nó không kết luận sai; nó chỉ không kết luận, mỗi ngày, cho mọi dòng.

    Con số 80% không phải tôi đặt: nó là tỷ lệ của chính mã hàng, đọc từ thang bậc đã được chủ shop
    duyệt ngày 21/09/2026 (`lib/constants/delivery-rate.ts`) — và thang ấy TỰ chuyển sang số thật
    khi mã đủ mẫu, nên dòng này sẽ tự rời căn cứ tạm tính mà không ai phải sửa gì.
  */
  const dangTreo = buildDecisionRow(
    {
      key: "camp-presell",
      name: "Chiến dịch bán trước",
      bookedOrders: 20,
      deliveredOrders: 4,
      returnedOrders: 1,
      openOrders: 15,
      notShippedOrders: 10,
      notShippedRevenue: 10_000_000,
      inTransitOrders: 5,
      inTransitRevenue: 5_000_000,
      bookedRevenue: 20_000_000,
      deliveredRevenue: 4_000_000,
      cash: 3_500_000,
      cogs: 2_000_000,
      shipping: 250_000,
      // 15.000.000 × 80% — phép nhân đã làm trong SQL bằng tỷ lệ của từng mã.
      openProjectedRevenue: 12_000_000,
      openProjectedCogs: 6_000_000,
      // 15 đơn đang treo × 30.000 cước. KHÔNG nhân 80%: cước mất cả khi giao được lẫn khi hoàn.
      openProjectedShipping: 450_000,
      openProjectedOrders: 12,
    },
    "campaign",
    3_000_000,
    true,
  );

  assert.equal(dangTreo.maturity, 0.25, "5 trên 20 đơn đã ngã ngũ");
  assert.equal(dangTreo.headroom, 0.58, "căn cứ SỐ ĐO: 1.750.000 ÷ 3.000.000");
  assert.equal(dangTreo.projectedDeliveredRevenue, 16_000_000, "4.000.000 đã giao + 12.000.000 dự kiến về");
  /*
    ─── CHI PHÍ TƯƠNG LAI ĐI CÙNG DOANH THU TƯƠNG LAI ───

    16.000.000 − 8.000.000 giá vốn − (250.000 cước đã phát sinh + 450.000 cước sẽ phát sinh)
                − 3.000.000 quảng cáo = 4.300.000

    Bản trước cho 4.750.000: nó cộng doanh thu của 15 đơn đang treo mà bỏ cước của đúng 15 đơn ấy.
    Đo production 23/09/2026 thì chỗ bỏ sót đó đáng 5.789.000 ₫ / 30 ngày.

    Và cước KHÔNG nhân 80%: 450.000 chứ không phải 360.000. Hàng hoàn vẫn tốn cước đi — nhân tỷ lệ
    giao thành công vào cước là giả định đơn hoàn được miễn cước.
  */
  assert.equal(dangTreo.projectedProfitAfterAds, 4_300_000, "trừ cả cước dự phóng của phần đang treo");
  assert.equal(dangTreo.projectedHeadroom, 2.43, "căn cứ TẠM TÍNH: 7.300.000 ÷ 3.000.000");
  assert.equal(dangTreo.appliedDeliveryRate, 80, "tỷ lệ đã áp đọc ngược ra từ chính phép nhân: 12.000.000 ÷ 15.000.000");
  assert.equal(dangTreo.basis, "PROJECTED");
  assert.equal(dangTreo.action, "SCALE", "quyết theo kế hoạch: phần đang treo đủ để vượt xa hoà vốn");
  assert.ok(
    dangTreo.reason.includes("TẠM TÍNH") && dangTreo.reason.includes("80"),
    `lời giải thích phải khai cả căn cứ lẫn tỷ lệ đã dùng — "${dangTreo.reason}"`,
  );
  /*
    SỐ ĐO KHÔNG ĐƯỢC BỊ GHI ĐÈ. `deliveredRevenue` và `profitAfterAds` là tiền THẬT đã về; ước tính
    sống ở những trường riêng mang chữ `projected`. Gộp hai thứ vào một cột là cách chắc chắn nhất
    để một hôm nào đó báo cáo lợi nhuận đọc phải một con số đoán (AGENTS.md mục 8.6).
  */
  assert.equal(dangTreo.deliveredRevenue, 4_000_000, "doanh thu đã giao vẫn là SỐ ĐO, không được cộng phần ước tính vào");
  assert.equal(dangTreo.profitAfterAds, -1_250_000, "lợi nhuận thật vẫn âm, và vẫn phải đọc được như vậy");
  assert.equal(dangTreo.shippingCost, 250_000, "cột cước vẫn là SỐ ĐO — phần dự phóng sống trong lợi nhuận tạm tính, không được trộn vào đây");

  /*
    ═══════════ PHẦN B3 — MƯỢN KẾT LUẬN CỦA MÃ HÀNG, VÀ BA ĐIỀU NÓ KHÔNG ĐƯỢC LÀM ═══════════

    Đo production 23/09/2026: shop chạy **619 chiến dịch trong một cửa sổ 14 ngày**, và trong nhóm
    đủ tiền (≥300K) thì chiến dịch nhiều đơn nhất cũng chỉ có **3 đơn** — cổng mẫu đòi 10 nên nó
    không bao giờ mở, và **45.726.057 ₫ (63% tiền quảng cáo) không nhận được kết luận nào**. Cùng
    ngày, cùng dữ liệu, ở cấp MÃ HÀNG: 3/4 mã có khuyến nghị, phủ 99,8% tiền.

    Bằng chứng tồn tại — chỉ không tồn tại ở độ mịn CHIẾN DỊCH.
  */
  const maLai = { key: "prod-1", name: "Đầm Q002", action: "SCALE" as const, reason: "lãi dày" };

  // Mượn được: dòng không tự kết luận, mã thì có.
  const muon = inheritVerdict("INSUFFICIENT_DATA", "prod-1", maLai);
  assert.equal(muon.bucket, "INHERITED");
  assert.equal(muon.inherited?.action, "SCALE");
  assert.equal(muon.inherited?.productName, "Đầm Q002", "tên mã BẮT BUỘC đi kèm — một chiến dịch dở trong một mã lãi vẫn mượn chữ tốt, người đọc phải thấy câu ấy nói về cái gì");

  /*
    KHÔNG ĐÈ LÊN KẾT LUẬN CỦA CHÍNH DÒNG. `HOLD` và `WATCH` là kết luận THẬT, không phải khoảng
    trống — thay chúng bằng kết luận của cả mã là đổi một câu đúng lấy một câu chung chung hơn.
  */
  for (const tuKetLuan of ["SCALE", "HOLD", "WATCH", "CUT", "FIX_DELIVERY"] as const) {
    const r = inheritVerdict(tuKetLuan, "prod-1", maLai);
    assert.equal(r.bucket, "OWN", `${tuKetLuan}: dòng tự kết luận được thì không mượn gì`);
    assert.equal(r.inherited, null);
  }

  /*
    `NO_SPEND_DATA` CŨNG KHÔNG MƯỢN, và đây là chỗ dễ nhầm nhất: nó TRÔNG như một khoảng trống dữ
    liệu. Nhưng ở đó ERP không đọc được cả số chi, nên gắn một kết luận về TIỀN vào đấy là nói về
    thứ mình không nhìn thấy.
  */
  assert.equal(inheritVerdict("NO_SPEND_DATA", "prod-1", maLai).bucket, "OWN", "không có số chi thì không mượn kết luận về tiền");

  /*
    BA NGẢ "KHÔNG MƯỢN ĐƯỢC" PHẢI TÁCH NHAU, vì mỗi cái sửa ở một chỗ khác. Gộp thành một nhãn
    "chưa đủ dữ liệu" là đúng thứ đã giấu 45,7 triệu (AGENTS.md mục 39 · mục 45).
  */
  assert.equal(inheritVerdict("INSUFFICIENT_DATA", undefined, maLai).bucket, "UNLINKED", "chưa nối được về mã — SỬA ĐƯỢC bằng cách khai mã cho chiến dịch");
  assert.equal(inheritVerdict("INSUFFICIENT_DATA", "prod-1", undefined).bucket, "PRODUCT_SILENT", "mã không có dòng nào — khác hẳn chưa nối được");
  assert.equal(
    inheritVerdict("INSUFFICIENT_DATA", "prod-1", { ...maLai, action: "INSUFFICIENT_DATA" }).bucket,
    "PRODUCT_SILENT",
    "mã cũng chưa kết luận được — mượn một câu 'chưa đủ dữ liệu' thì vô nghĩa",
  );
  assert.equal(
    inheritVerdict("INSUFFICIENT_DATA", "prod-1", { ...maLai, action: "NO_SPEND_DATA" }).bucket,
    "PRODUCT_SILENT",
    "mã không có số chi thì cũng không cho mượn được gì",
  );
  for (const r of [
    inheritVerdict("INSUFFICIENT_DATA", undefined, maLai),
    inheritVerdict("INSUFFICIENT_DATA", "prod-1", undefined),
  ]) {
    assert.equal(r.inherited, null, "không mượn được thì KHÔNG dựng một câu rỗng — null, không phải một đối tượng trống");
  }

  /*
    ═══════════ CHI PHÍ TEST KHÔNG PHẢI MỘT CHỖ TRỐNG ═══════════

    `resolveCampaign` phân biệt được `test` với `none`, nhưng `ad_spends` chỉ lưu `product_id` nên
    cả hai cùng thành NULL — và xuống tới bảng quyết định chúng đội chung một chữ "chưa đủ dữ liệu".

    Đo production 23/09/2026, 387 chiến dịch không nối được về mã (11.165.022 ₫):
      318 dòng · 7.457.012 ₫ mang chữ TEST · 62 dòng · 3.617.087 ₫ không test không mã · 7 dòng bộ ghép trượt

    Gộp lại sinh ra một lời khuyên SAI: "khai mã cho 387 chiến dịch" — tức gán mã hàng cho 318
    chiến dịch test, một việc bịa đặt.
  */
  assert.equal(spendClassOf("auto", "prod-1", false), "PRODUCT");
  assert.equal(spendClassOf("test", null, false), "TEST");
  assert.equal(spendClassOf("none", null, false), "UNCLASSIFIED", "không khớp mã VÀ không phải test ⇒ cần người, khác hẳn chi phí test");
  assert.equal(spendClassOf("manual", null, false), "TEST", "người khai tay mà không có mã nghĩa là họ đã nói 'đây là chi phí test'");
  assert.equal(spendClassOf("auto", "prod-1", true), "EXCLUDED", "đã loại khỏi phép tính thì thắng mọi nhánh khác");
  assert.notEqual(spendClassOf("test", null, false), spendClassOf("none", null, false), "hai thứ này KHÔNG được gộp — đó là cả điểm của phép phân loại");

  // Chi phí test KHÔNG đi mượn: gán cho một phép thử fanpage điểm hoà vốn của một mã bán là đo sai thứ.
  const testKhongMuon = inheritVerdict("INSUFFICIENT_DATA", "prod-1", maLai, "TEST");
  assert.equal(testKhongMuon.bucket, "TEST");
  assert.equal(testKhongMuon.inherited, null, "chi phí test không mượn kết luận của mã, kể cả khi nối được về một mã");
  // Chưa phân loại thì VẪN mượn được nếu nối được — nó chỉ thiếu NHÃN, không thiếu bằng chứng.
  assert.equal(inheritVerdict("INSUFFICIENT_DATA", "prod-1", maLai, "UNCLASSIFIED").bucket, "INHERITED");

  /*
    ═══════════ BẢNG VẼ BAO NHIÊU DÒNG — KHÔNG KHUYẾN NGHỊ NÀO ĐƯỢC RƠI KHỎI MÀN HÌNH ═══════════

    Đo 23/09/2026: `/ads` nặng 6.768 kB vì bảng VẼ đủ 742 dòng, hơn 600 dòng trong đó là "chưa đủ
    dữ liệu". Nay máy chủ chỉ gửi phần cần đọc — nhưng cắt một khuyến nghị CẮT khỏi màn hình là đúng
    thứ bảng này sinh ra để chặn, nên dòng có kết luận KHÔNG BAO GIỜ bị cắt.
  */
  const dong = (action: AdsAction, k: number) => ({ action, key: `r${k}` });
  const hon = [
    ...Array.from({ length: 5 }, (_, k) => dong("CUT", k)),
    ...Array.from({ length: 200 }, (_, k) => dong("INSUFFICIENT_DATA", 100 + k)),
  ];
  const chon = rowsToRender(hon, false, 80);
  assert.equal(chon.shown.length, 80, "trần hiển thị 80 dòng");
  assert.equal(chon.shown.filter((r) => r.action === "CUT").length, 5, "mọi dòng có kết luận đều hiện");
  assert.equal(chon.shown.length + chon.hidden.length, hon.length, "không dòng nào biến mất — hoặc hiện, hoặc được đếm là đang ẩn");
  assert.ok(chon.hidden.every((r) => r.action === "INSUFFICIENT_DATA"), "chỉ dòng CHƯA có kết luận mới bị ẩn");

  // Thứ tự đầu vào được giữ nguyên — bảng đã xếp theo việc cần làm và số tiền.
  assert.deepEqual(
    chon.shown.map((r) => r.key).slice(0, 7),
    ["r0", "r1", "r2", "r3", "r4", "r100", "r101"],
    "giữ nguyên thứ tự bảng vốn có",
  );

  /*
    NGÀY CÓ NHIỀU KHUYẾN NGHỊ HƠN TRẦN: tất cả vẫn phải hiện. Trần là con số hiển thị, không phải
    một giới hạn trên số việc cần làm.
  */
  const nhieuViec = Array.from({ length: 120 }, (_, k) => dong(k % 2 ? "SCALE" : "CUT", k));
  const chonNhieu = rowsToRender([...nhieuViec, ...Array.from({ length: 50 }, (_, k) => dong("INSUFFICIENT_DATA", 500 + k))], false, 80);
  assert.equal(chonNhieu.shown.filter((r) => r.action !== "INSUFFICIENT_DATA").length, 120, "120 khuyến nghị thì 120 dòng hiện, dù vượt trần 80");
  assert.equal(chonNhieu.shown.length, 120, "đã chạm trần bằng khuyến nghị thì không lấp thêm dòng chưa đủ dữ liệu");

  /*
    KHÔNG DỰA VÀO PHÉP SẮP XẾP. Nếu một ngày ai đó đổi thứ tự bảng và khuyến nghị nằm cuối, nó vẫn
    phải hiện — hàm giữ mọi dòng có kết luận dù chúng nằm ở đâu.
  */
  const cuoiBang = [...Array.from({ length: 200 }, (_, k) => dong("INSUFFICIENT_DATA", k)), dong("CUT", 999)];
  assert.ok(rowsToRender(cuoiBang, false, 80).shown.some((r) => r.key === "r999"), "khuyến nghị nằm cuối bảng vẫn phải hiện");

  // `all` = vẽ hết.
  assert.equal(rowsToRender(hon, true, 80).shown.length, hon.length);
  assert.equal(rowsToRender(hon, true, 80).hidden.length, 0);
  // NO_SPEND_DATA cũng là "chưa có kết luận" — không được giữ chỗ như một khuyến nghị.
  assert.equal(isConclusive("NO_SPEND_DATA"), false);
  assert.equal(isConclusive("WATCH"), true, "THEO DÕI là một kết luận thật");

  // CHƯA BIẾT LÀ NULL, KHÔNG PHẢI 0.
  const noSpend = buildDecisionRow(
    { key: "ad-1", name: "Mẩu 1", bookedOrders: 5, deliveredOrders: 4, returnedOrders: 1, openOrders: 0, notShippedOrders: 0, notShippedRevenue: 0, inTransitOrders: 0, inTransitRevenue: 0, bookedRevenue: 5_000_000, deliveredRevenue: 4_000_000, cash: 3_000_000, cogs: 2_000_000, shipping: 200_000, openProjectedRevenue: 0, openProjectedCogs: 0, openProjectedShipping: 0, openProjectedOrders: 0 },
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
    { key: "camp-burn", name: "Đốt tiền", bookedOrders: 0, deliveredOrders: 0, returnedOrders: 0, openOrders: 0, notShippedOrders: 0, notShippedRevenue: 0, inTransitOrders: 0, inTransitRevenue: 0, bookedRevenue: 0, deliveredRevenue: 0, cash: 0, cogs: 0, shipping: 0, openProjectedRevenue: 0, openProjectedCogs: 0, openProjectedShipping: 0, openProjectedOrders: 0 },
    "campaign",
    5_000_000,
    true,
  );
  assert.equal(burned.breakEvenDeliveredRoas, null, "không có doanh thu thì không có điểm hoà vốn");
  assert.equal(burned.breakEvenBookedRoas, null);
  assert.equal(burned.marginRate, null);
  assert.equal(burned.profitAfterAds, -5_000_000, "tiêu 5 triệu không ra đơn = lỗ đúng 5 triệu");

  // ═══════════ CHUỖI THỰC HIỆN & CHỈ SỐ QUẢNG CÁO ═══════════
  /*
    HAI ĐIỀU ĐƯỢC KHOÁ Ở ĐÂY.

    ① `openOrders` phải TÁCH ĐÚNG làm hai. Với mô hình bán trước, khoảng "đã chốt mà chưa rời kho"
       là SẢN XUẤT + ĐÓNG GÓI — việc của xưởng; còn "đang trên đường" là việc của ĐVVC. Gộp lại là
       xoá mất ranh giới giữa hai chỗ nghẽn khác nhau, và người đọc sẽ gọi nhầm phòng.

    ② Chỉ số quảng cáo CHƯA BIẾT phải là `null`, KHÔNG phải 0. Một cấp không có số chi (nhóm / mẩu)
       mà in "CPM 0đ · tỷ lệ chốt 0%" là nói ngược hẳn sự thật.
  */
  const chuoi = buildDecisionRow(
    {
      key: "camp-chuoi",
      name: "Chuỗi",
      bookedOrders: 10,
      deliveredOrders: 4,
      returnedOrders: 1,
      openOrders: 5,
      notShippedOrders: 3,
      notShippedRevenue: 3_000_000,
      inTransitOrders: 2,
      inTransitRevenue: 2_000_000,
      bookedRevenue: 10_000_000,
      deliveredRevenue: 4_000_000,
      cash: 3_500_000,
      cogs: 2_000_000,
      shipping: 300_000,
      openProjectedRevenue: 0,
      openProjectedCogs: 0,
      openProjectedShipping: 0,
      openProjectedOrders: 0,
    },
    "campaign",
    2_000_000,
    true,
    { impressions: 100_000, clicks: 500, messages: 200 },
  );

  assert.equal(chuoi.notShippedOrders + chuoi.inTransitOrders, chuoi.openOrders, "hai nhánh của chuỗi phải cộng đúng bằng đơn chưa ngã ngũ");
  assert.equal(chuoi.bookedOrders, chuoi.notShippedOrders + chuoi.inTransitOrders + chuoi.deliveredOrders + chuoi.returnedOrders, "bốn mốc phải phủ hết đơn đã chốt");
  assert.equal(chuoi.notShippedRevenue + chuoi.inTransitRevenue, 5_000_000, "tiền của hai nhánh chưa ngã ngũ phải giữ nguyên");

  // Chỉ số quảng cáo: tính bằng tay được.
  assert.equal(chuoi.impressions, 100_000);
  assert.equal(chuoi.cpm, 20_000, "CPM = 2.000.000đ ÷ 100.000 hiển thị × 1.000");
  assert.equal(chuoi.cpc, 4_000, "CPC = 2.000.000đ ÷ 500 click");
  assert.equal(chuoi.costPerMessage, 10_000, "giá một tin nhắn = 2.000.000đ ÷ 200 tin");
  assert.equal(chuoi.costPerOrder, 200_000, "giá một đơn CHỐT = 2.000.000đ ÷ 10 đơn");
  assert.equal(chuoi.closeRate, 5, "tỷ lệ chốt = 10 đơn ÷ 200 tin = 5%");
  assert.equal(chuoi.adsPctOverPos, 20, "%CPQC trên doanh số POS = 2tr ÷ 10tr");
  assert.equal(chuoi.adsPctOverDelivered, 50, "%CPQC trên doanh thu giao TC = 2tr ÷ 4tr — LUÔN cao hơn, vì phần hoàn không mang về đồng nào");
  assert.ok(
    (chuoi.adsPctOverDelivered ?? 0) > (chuoi.adsPctOverPos ?? 0),
    "hai mẫu số phải cho hai con số khác nhau — gộp chúng dưới một cái tên là lỗi mà adsRatios() đã phải đi dọn một lần",
  );

  /*
    KHÔNG CÓ SỐ CHI ⇒ MỌI CHỈ SỐ QUẢNG CÁO LÀ `null`.

    Kể cả khi nơi gọi lỡ truyền `metrics` xuống: `spendKnown = false` nghĩa là cấp này không có tiền,
    và một tỷ số chia cho số tiền không tồn tại thì không phải 0 — nó là chưa biết.
  */
  const khongChi = buildDecisionRow(
    {
      key: "ad-1",
      name: "Mẩu",
      bookedOrders: 5,
      deliveredOrders: 4,
      returnedOrders: 1,
      openOrders: 0,
      notShippedOrders: 0,
      notShippedRevenue: 0,
      inTransitOrders: 0,
      inTransitRevenue: 0,
      bookedRevenue: 5_000_000,
      deliveredRevenue: 4_000_000,
      cash: 3_000_000,
      cogs: 2_000_000,
      shipping: 200_000,
      openProjectedRevenue: 0,
      openProjectedCogs: 0,
      openProjectedShipping: 0,
      openProjectedOrders: 0,
    },
    "ad",
    0,
    false,
    { impressions: 999, clicks: 99, messages: 9 },
  );
  for (const [ten, gt] of Object.entries({
    impressions: khongChi.impressions,
    clicks: khongChi.clicks,
    messages: khongChi.messages,
    cpm: khongChi.cpm,
    cpc: khongChi.cpc,
    costPerMessage: khongChi.costPerMessage,
    costPerOrder: khongChi.costPerOrder,
    closeRate: khongChi.closeRate,
    adsPctOverPos: khongChi.adsPctOverPos,
    adsPctOverDelivered: khongChi.adsPctOverDelivered,
  })) {
    assert.equal(gt, null, `${ten}: không có số chi thì phải là CHƯA BIẾT (null), không phải 0`);
  }

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
  // Cước của đơn đã giao (2) + đơn hoàn (1) = 90.000đ; đơn hoàn không có return_fee trong fixture.
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
    assert.ok(
      d.confidence.coveragePct === null || (d.confidence.coveragePct >= 0 && d.confidence.coveragePct <= 100),
      `${dimension}: độ phủ phải là phần trăm hợp lệ hoặc null (CHƯA ĐO ĐƯỢC, không phải 0)`,
    );
    // Mẫu số phải là ĐƠN CÓ DẤU VẾT FACEBOOK, và nó không bao giờ lớn hơn tổng đơn.
    assert.ok(d.confidence.attributableOrders <= d.confidence.totalOrders, `${dimension}: mẫu số quy kết không được lớn hơn tổng đơn`);
    assert.equal(
      d.confidence.attributableOrders + d.confidence.notFromAdsOrders,
      d.confidence.totalOrders,
      `${dimension}: đơn trong mẫu số cộng đơn ngoài quảng cáo phải bằng tổng đơn`,
    );
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
