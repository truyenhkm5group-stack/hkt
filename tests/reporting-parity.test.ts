import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { confidenceOf, CONFIDENCE_THRESHOLDS, MODELLED_SUBSTATES, PROJECTED_GTC_VERSION, projectedRateOf } from "@/lib/constants/projected-delivery";
import { inventoryRiskOnSold } from "@/lib/constants/cost-allocation";
import { adsRatio, PROFIT_ASSUMPTIONS_KEY } from "@/lib/constants/profit";
import { getProbabilityLookup, getProjectionBacktest, getStateDeliveryProbabilities } from "@/lib/queries/projected-delivery";

/**
 * ═══════════ CÙNG MỘT CHỈ SỐ PHẢI RA CÙNG MỘT SỐ Ở MỌI TRANG ═══════════
 *
 * Bài này khoá mô hình dự báo giao thành công: học từ lịch sử thật, một vận đơn một quan sát, kiện
 * chưa kết thúc không vào mẫu số, và không có con số nào được ghi cứng.
 *
 * Đây là bài kiểm CÔNG THỨC (formula test), không phải contract test nghiệp vụ: đổi hợp đồng thì đổi
 * kỳ vọng ở đây, kèm phiên bản.
 */

const P = "par-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);
/** Mốc ĐỦ CHÍN: xa hơn cửa sổ trưởng thành mặc định (14 ngày), để kiện vào tập huấn luyện. */
const CHIN = 24 * 30;

/* ───── 1 · Không một con số xác suất nào được ghi cứng trong mã ───── */
export function testNoHardcodedProbability() {
  /*
    Ngưỡng tin cậy là hằng số CÓ LÝ DO (sai số chuẩn của tỷ lệ nhị phân), khác hẳn một xác suất
    ghi cứng. Bài này khoá đúng ranh giới đó: ngưỡng được phép là hằng số, xác suất thì không.
  */
  assert.equal(confidenceOf(CONFIDENCE_THRESHOLDS.HIGH), "HIGH");
  assert.equal(confidenceOf(CONFIDENCE_THRESHOLDS.MEDIUM), "MEDIUM");
  assert.equal(confidenceOf(CONFIDENCE_THRESHOLDS.LOW), "LOW");
  assert.equal(confidenceOf(CONFIDENCE_THRESHOLDS.LOW - 1), "INSUFFICIENT_DATA", "dưới ngưỡng thì một kiện đổi kết cục làm tỷ lệ nhảy hơn 10 điểm — đó là tiếng ồn, không phải xác suất");
  assert.equal(PROJECTED_GTC_VERSION, "PROJECTED_GTC_V3", "đổi công thức phải đổi phiên bản, để kỳ cũ không bị đọc bằng luật mới");
}

/* ───── 2 · Xác suất học từ lịch sử: một vận đơn một quan sát ───── */
export async function testProbabilityFromHistory(db: Db) {
  // Ba kiện "chờ phát lại" đã kết thúc: 2 giao được, 1 hoàn ⇒ p = 2/3. Gửi 30 ngày trước: ĐỦ CHÍN.
  const ca: { id: string; stage: "DELIVERED" | "RETURNED"; soSuKien: number }[] = [
    { id: "h1", stage: "DELIVERED", soSuKien: 5 },
    { id: "h2", stage: "DELIVERED", soSuKien: 1 },
    { id: "h3", stage: "RETURNED", soSuKien: 3 },
  ];
  for (const c of ca) {
    await db.insert(schema.orders).values({ id: `${P}o-${c.id}`, stage: "SHIPPED", status: 2, insertedAt: gio(CHIN + 24) }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({ id: `${P}${c.id}`, orderId: `${P}o-${c.id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${c.id}`.toUpperCase(), stage: c.stage, isFinal: true, pickedUpAt: gio(CHIN), codAmount: 499_000, codCollected: c.stage === "DELIVERED" ? 499_000 : 0 })
      .onConflictDoNothing();
    // NHIỀU sự kiện CÙNG một trạng thái — đúng cách Viettel Post thử lại webhook tới 5 lần.
    for (let i = 0; i < c.soSuKien; i++) {
      await db
        .insert(schema.shipmentEvents)
        .values({ shipmentId: `${P}${c.id}`, source: "VTP_WEBHOOK", status: "", statusName: "Chờ phát lại", normalizedStage: "DELIVERY_FAILED", occurredAt: new Date(gio(CHIN - 24).getTime() + i * 60_000) })
        .onConflictDoNothing();
    }
  }
  // Một kiện CHƯA kết thúc, cũng "chờ phát lại" — KHÔNG được vào mẫu số.
  await db.insert(schema.orders).values({ id: `${P}o-h4`, stage: "SHIPPED", status: 2, insertedAt: gio(CHIN) }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: `${P}h4`, orderId: `${P}o-h4`, carrier: "Viettel Post", vtpOrderNumber: `${P}H4`, stage: "DELIVERY_FAILED", isFinal: false, pickedUpAt: gio(CHIN) }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}h4`, source: "VTP_WEBHOOK", status: "", statusName: "Chờ phát lại", normalizedStage: "DELIVERY_FAILED", occurredAt: gio(CHIN - 24) }).onConflictDoNothing();

  clearMemo();
  const { states, version, window } = await getStateDeliveryProbabilities();
  assert.equal(version, PROJECTED_GTC_VERSION);
  const cpl = states.find((s) => s.substate === "WAITING_REDELIVERY")!;
  assert.equal(cpl.sample, 3, "chín sự kiện của ba vận đơn phải cho ĐÚNG BA quan sát — số lần webhook lặp không được quyết định xác suất");
  assert.equal(cpl.delivered, 2);
  assert.ok(cpl.p !== null && Math.abs(cpl.p - 2 / 3) < 1e-9, "p = 2/3");
  assert.ok(window.maturityDays >= 1 && window.trainedUntil.getTime() < Date.now(), "cửa sổ huấn luyện phải loại kiện chưa đủ chín");

  // Mọi trạng thái ĐƯỢC DỰ BÁO đều có mặt trong bảng, kể cả trạng thái chưa có mẫu nào — và KHÔNG có trạng thái cuối.
  assert.equal(states.length, MODELLED_SUBSTATES.length, "bảng xác suất phải phủ hết trạng thái dự báo được, không im lặng bỏ trạng thái chưa gặp");
  for (const s of states) {
    assert.ok(!["DELIVERED", "RETURNED", "CANCELLED", "RETURNING"].includes(s.substate), `${s.substate}: trạng thái cuối không được là trạng thái dự báo — P = 1 ở đó là lộ đáp án`);
    if (s.sample === 0) assert.equal(s.p, null, `${s.substate}: chưa có mẫu ⇒ CHƯA ĐO ĐƯỢC (null), không phải 0`);
  }
}

/* ───── 3 · Mẫu nhỏ KHÔNG được dùng như một xác suất ───── */
export async function testLowSampleNotAuthoritative() {
  clearMemo();
  const lookup = await getProbabilityLookup();
  const cpl = lookup.of("WAITING_REDELIVERY");
  assert.equal(cpl.sample, 3);
  assert.equal(cpl.confidence, "INSUFFICIENT_DATA", "3 mẫu không phải một xác suất");
  assert.equal(cpl.basis, "NONE", "chưa đủ mẫu thì KHÔNG có căn cứ nào — và bậc lùi cố ý không có giá trị mặc định");
  assert.equal(cpl.p, null, "trả null để màn hình in “chưa đo được”, chứ không in một con số đoán trông như đã đo");

  const chuaGap = lookup.of("PICKUP_FAILED");
  assert.equal(chuaGap.p, null);
  assert.equal(chuaGap.confidence, "INSUFFICIENT_DATA");
  // Trạng thái cuối hỏi bảng tra thì cũng KHÔNG có xác suất — không phải 1, không phải 0.
  assert.equal(lookup.of("DELIVERED").p, null);
}

/* ───── 4 · Đối chiếu ngược chạy được và không bịa số khi thiếu dữ liệu ───── */
export async function testBacktestHonest() {
  clearMemo();
  const b = await getProjectionBacktest();
  assert.equal(b.version, PROJECTED_GTC_VERSION);
  if (b.overall.n === 0) {
    assert.equal(b.overall.mae, null, "không mẫu nào ⇒ không có sai số để báo, KHÔNG in 0");
    assert.equal(b.overall.bias, null);
    assert.equal(b.confidence, "INSUFFICIENT_DATA", "chưa thử được thì là CHƯA ĐỦ DỮ LIỆU — không phải tin cậy cao, cũng không phải sai");
  } else {
    assert.ok(b.overall.mae !== null && b.overall.mae >= 0 && b.overall.mae <= 1, "sai số tuyệt đối trung bình nằm trong [0,1]");
    assert.ok(b.overall.bias !== null && b.overall.bias >= -1 && b.overall.bias <= 1);
    assert.ok(b.overall.brier !== null && b.overall.brier >= 0 && b.overall.brier <= 1);
  }
  assert.ok(b.coverage === null || (b.coverage >= 0 && b.coverage <= 100));
  assert.ok(b.months.length <= 3, "thử ngược cuộn tối đa ba tháng gần nhất");
}

/* ───── 5 · Chỉ số ước tính chạy được trên dữ liệu thật và tự nhất quán ───── */
export async function testProjectedMetricsConsistent() {
  clearMemo();
  const { getProjectedDeliveryMetrics } = await import("@/lib/queries/projected-delivery");
  const m = await getProjectedDeliveryMetrics({ from: null, to: null });
  for (const r of m.rows) {
    assert.equal(r.eligibleSent, r.deliveredActual + r.failedActual + r.active, `${r.code}: đã gửi phải bằng đã giao + hoàn + đang chạy — không rổ nào rơi ra`);
    assert.ok(r.projectedDelivered >= r.deliveredActual - 1e-9, `${r.code}: ước tính không được THẤP HƠN số đã giao thật`);
    assert.ok(r.projectedDelivered <= r.eligibleSent + 1e-9, `${r.code}: ước tính không được vượt quá số đã gửi`);
    assert.ok(r.projectedDeliveredRevenue >= r.deliveredRevenueActual - 1, `${r.code}: doanh thu ước tính không được thấp hơn doanh thu đã giao thật`);
    const dangChay = Object.values(r.activeByState).reduce((a, n) => a + (n ?? 0), 0);
    assert.equal(dangChay, r.active, `${r.code}: phân rã trạng thái phải cộng đúng bằng số đơn đang chạy`);
    if (r.actualRate !== null) assert.ok(r.actualRate >= 0 && r.actualRate <= 100);
    if (r.projectedRate !== null) assert.ok(r.projectedRate >= 0 && r.projectedRate <= 100);
    // MỘT công thức: dòng nào cũng phải bằng đúng hàm chung.
    assert.equal(r.projectedRate, projectedRateOf(r), `${r.code}: tỷ lệ ước tính phải là ĐÚNG hàm projectedRateOf`);
  }
  // Đơn chưa lần được mã KHÔNG bị nhét vào một mã nào đó cho đủ bảng.
  assert.ok(m.unmappedOrders >= 0 && m.totalOrders >= m.unmappedOrders);
  assert.equal(m.version, PROJECTED_GTC_VERSION);

  /*
    CON SỐ TOÀN SHOP PHẢI Ở GRAIN ĐƠN, KHÔNG PHẢI TỔNG CÁC DÒNG THEO MÃ: đơn hai mã hàng được cộng
    cho cả hai mã (mẫu số phình), đơn chưa lần được về mã nào bị BỎ HẲN (mẫu số hụt).
  */
  const od = m.orderLevel;
  const dangGiao = Object.values(od.activeByState).reduce<number>((a, n) => a + (n ?? 0), 0);
  assert.equal(dangGiao, od.active, "phân rã trạng thái phải cộng đúng bằng số đơn đang giao");
  assert.equal(od.eligibleSent, od.deliveredActual + od.failedActual + od.active, "ở grain đơn cũng không rổ nào được rơi ra");
  /*
    Mẫu số ở grain đơn = ĐÚNG số đơn ĐÃ GỬI trong cohort — đơn chưa lần được về mã nào VẪN nằm trong
    đó; đơn huỷ / chưa gửi / CHỜ ĐVVC TỚI LẤY / không dấu vết ĐVVC được đếm RIÊNG, không trộn vào.

    Rổ `awaitingPickup` có mặt trong phép cộng này từ 21/09/2026. Trước đó nó KHÔNG tồn tại: kiện
    chưa rời kho bị nhánh `default:` của `canMotDon` cộng thẳng vào `eligibleSent`, nên phép cộng
    vẫn khớp — mà khớp vì SAI, không phải vì đúng. Đây đúng là bất biến sinh ra để bắt một nhóm
    đang lẫn vào nhóm khác, nên nó chỉ bắt được khi mọi rổ đều có tên.
  */
  assert.equal(
    od.eligibleSent + od.cancelled + od.unknown + od.pending + od.awaitingPickup,
    m.totalOrders,
    "mỗi đơn trong cohort đếm ĐÚNG MỘT LẦN: đã gửi + huỷ + không dấu vết + chưa gửi + chờ ĐVVC lấy",
  );
  assert.ok(od.awaitingPickup >= 0, "kiện chờ bưu tá tới lấy phải có rổ riêng — không nằm trong 'đã gửi'");
  assert.ok(od.unmodelledActive >= 0 && od.unmodelledActive <= od.active, "phần chưa dự báo được là một TẬP CON của phần đang giao");
  assert.ok(od.projectedDelivered >= od.deliveredActual - 1e-9, "ước tính không được THẤP HƠN số đã giao thật");
  assert.ok(od.projectedDelivered <= od.eligibleSent + 1e-9, "ước tính không được vượt quá số đơn đã gửi");
  assert.equal(od.projectedRate, projectedRateOf(od), "grain đơn cũng đi qua ĐÚNG một hàm");
  if (od.projectedRate !== null) assert.ok(od.projectedRate >= 0 && od.projectedRate <= 100);
  else assert.ok(od.eligibleSent - od.unmodelledActive === 0 || od.unmodelledActive / Math.max(1, od.active) > 0.5, "chỉ được CHƯA ĐO ĐƯỢC khi mẫu số rỗng hoặc phần ngoài ước tính quá lớn — có đơn dự báo được mà trả null là đang giấu số");
}

/* ───── 6 · Rủi ro tồn kho là CHI PHÍ CỦA KỲ, không phải của lô nhập ───── */
export function testInventoryRiskIsPeriodExpense() {
  const nguon = readFileSync(path.join(process.cwd(), "lib/queries/profit-nominal.ts"), "utf8");
  const dongLoiNhuan = nguon.split("\n").filter((l) => l.includes("profitOnPurchase =") || l.includes("const profitOnPurchase"));
  assert.ok(dongLoiNhuan.length >= 2, "phải tìm thấy cả công thức từng dòng lẫn công thức tổng");
  for (const d of dongLoiNhuan) {
    assert.ok(!d.includes("inventoryRiskOnPurchase"), `lợi nhuận theo hàng nhập KHÔNG được trừ rủi ro cả đời của lô: ${d.trim()}`);
    assert.ok(d.includes("inventoryRisk"), `phải trừ phần rủi ro PHÂN BỔ CHO KỲ: ${d.trim()}`);
  }

  // Luật 14 của AGENTS.md, kiểm ở mức số học: rủi ro đi theo hàng BÁN RA.
  const giaTriLo = 100_000_000;
  assert.equal(inventoryRiskOnSold(0, 10), 0, "kỳ không bán được gì ⇒ chưa giải phóng đồng dự phòng nào");
  let congDon = 0;
  for (let tuan = 0; tuan < 10; tuan += 1) congDon += inventoryRiskOnSold(giaTriLo / 10, 10);
  assert.equal(congDon, inventoryRiskOnSold(giaTriLo, 10), "bán hết lô qua 10 tuần ⇒ cộng lại đúng bằng dự phòng cả lô, không hơn không kém");
}

/* ───── 7 · Hai tỷ lệ quảng cáo: mẫu số 0 ⇒ N/A, không phải 0% ───── */
export function testAdsRatios() {
  assert.equal(adsRatio(10_000_000, 100_000_000), 10, "10tr / 100tr = 10%");
  assert.equal(adsRatio(10_000_000, 50_000_000), 20, "10tr / 50tr = 20%");
  assert.equal(adsRatio(10_000_000, 0), null, "mẫu số 0 ⇒ chưa tính được, không phải 0%");
  assert.equal(adsRatio(0, 0), null);
  assert.equal(adsRatio(10_000_000, -5), null, "mẫu số âm cũng không chia");
  assert.equal(adsRatio(0, 100_000_000), 0, "không chi quảng cáo mà vẫn bán được ⇒ 0% là sự thật");
}

export async function testReportingParity(db: Db) {
  testNoHardcodedProbability();
  /*
    THỨ TỰ CÓ Ý NGHĨA: khối 2 và 3 khoá cỡ mẫu của trạng thái "chờ phát lại" bằng con số ĐÚNG BA.
    Mọi khối gieo thêm vận đơn vào trạng thái ấy phải chạy SAU chúng.
  */
  await testProbabilityFromHistory(db);
  await testLowSampleNotAuthoritative();
  await testBacktestHonest();
  await testProjectedMetricsConsistent();
  testInventoryRiskIsPeriodExpense();
  testAdsRatios();
  await testCrossReportParity(db);
  await testBasisFlowsThrough(db);
  await testOverrideBeatsModel();

  const ids = [`${P}h1`, `${P}h2`, `${P}h3`, `${P}h4`];
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
  await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);

  // Fixture parity: dọn theo ĐÚNG thứ tự khoá ngoại, và dọn HẾT — khối khác cộng tổng trên cùng CSDL.
  const idX = [`${X}s-d1`, `${X}s-d2`, `${X}s-lech`];
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, idX));
  await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, idX));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, idX));
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like ${`${X}i-%`}`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${X}o-%`}`);
  await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, [`${X}v`, `${CHUA_CHIN}v`]));
  await db.delete(schema.products).where(inArray(schema.products.id, [`${X}p`, `${CHUA_CHIN}p`]));

  clearMemo();
  console.log("✓ Một hợp đồng cho “TL GTC ước tính” (V3): xác suất học từ lịch sử theo ORDER_OUTCOME · một vận đơn một quan sát · kiện chưa kết thúc / chưa đủ chín ngoài mẫu số · trạng thái cuối không dự báo · mẫu nhỏ KHÔNG thành xác suất · rủi ro tồn kho là chi phí CỦA KỲ · mẫu số 0 ⇒ N/A");
  console.log("✓ Parity chéo hai trang: cùng mã + cùng kỳ + cùng mốc ⇒ CÙNG MỘT SỐ · DT GTC ƯT cân theo từng đơn · hai grain khớp nhau · đổi mốc thì đổi cohort · ghi đè tay THẮNG mô hình");
}

/* ───── 8 · CÙNG MÃ + CÙNG KỲ + CÙNG MỐC ⇒ CÙNG MỘT SỐ Ở HAI TRANG ───── */

const X = "parx-";
/** Mã hàng của fixture — cố tình lạ để không đụng dữ liệu của khối khác. */
const MA = "PARX-GTC";

/**
 * Dựng HAI mã hàng, kết cục ĐÃ NGÃ NGŨ HẾT, 0 đơn đang chạy — khi ấy tỷ lệ ước tính KHÔNG phụ thuộc
 * bảng xác suất, nên bài khoá đúng một thứ: hai trang có cùng số.
 *
 * ─── VÌ SAO MÃ CHÍNH PHẢI CÓ ĐỦ 12 ĐƠN ───
 *
 * Bản trước dựng đúng 2 đơn (1 giao, 1 hoàn). Từ 23/09/2026, bậc `projected` chỉ chạy khi mã đạt
 * `rateMatureMinFinished` đơn đã kết thúc — 2 đơn là CHƯA CHÍN, nên bảng lợi nhuận cố ý KHÔNG còn
 * in con số của hợp đồng nữa mà in số co ngót. Giữ nguyên fixture 2 đơn sẽ biến bài kiểm parity
 * thành bài kiểm bậc co ngót, tức nó thôi khoá thứ nó sinh ra để khoá.
 *
 * 12 đơn (6 giao / 6 hoàn) vẫn ra ĐÚNG 50% như cũ, và vượt ngưỡng chín mặc định (10).
 */
const CHUA_CHIN = "parx-nc-";
/** Mã thứ hai: CỐ Ý chưa chín — 3 đơn kết thúc, dưới ngưỡng. */
const MA_CHUA_CHIN = "PARX-GTC-NC";

async function dungMotDon(db: Db, tienTo: string, maSp: string, bienThe: string, id: string, giao: boolean, luc: Date) {
  await db.insert(schema.orders).values({ id: `${tienTo}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${tienTo}i-${id}`, orderId: `${tienTo}o-${id}`, variantId: bienThe, productId: maSp, sku: `${MA}-S`, productName: "Hàng kiểm parity", variationDetail: "S", quantity: 1, lineTotal: 500_000, unitCost: 200_000, isBonus: false }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: `${tienTo}s-${id}`,
      orderId: `${tienTo}o-${id}`,
      carrier: "Viettel Post",
      vtpOrderNumber: `${tienTo}${id}`.toUpperCase(),
      // `vtp_status` 501 / 504 là CHỨNG TỪ ĐVVC — đúng bậc căn cứ cao nhất của luật kết quả đơn.
      vtpStatus: giao ? 501 : 504,
      vtpStatusName: giao ? "Giao thành công" : "Chuyển hoàn",
      stage: giao ? "DELIVERED" : "RETURNED",
      isFinal: true,
      codAmount: 500_000,
      codCollected: giao ? 500_000 : 0,
      pickedUpAt: luc,
      deliveredAt: giao ? luc : null,
    })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${tienTo}s-${id}`, source: "VTP_WEBHOOK", status: giao ? "501" : "504", statusName: giao ? "Giao thành công" : "Chuyển hoàn", legType: "OUTBOUND", occurredAt: luc }).onConflictDoNothing();
}

async function dungFixtureParity(db: Db, luc: Date) {
  await db.insert(schema.products).values({ id: `${X}p`, name: "Hàng kiểm parity", customId: MA }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${X}v`, productId: `${X}p`, sku: `${MA}-S`, retailPrice: 500_000 }).onConflictDoNothing();
  for (let i = 0; i < 12; i += 1) await dungMotDon(db, X, `${X}p`, `${X}v`, `d${i}`, i % 2 === 0, luc);

  await db.insert(schema.products).values({ id: `${CHUA_CHIN}p`, name: "Hàng kiểm parity chưa chín", customId: MA_CHUA_CHIN }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${CHUA_CHIN}v`, productId: `${CHUA_CHIN}p`, sku: `${MA_CHUA_CHIN}-S`, retailPrice: 500_000 }).onConflictDoNothing();
  // 2 giao / 1 hoàn = 66,7% số đo thật, 3 đơn — dưới ngưỡng chín.
  for (let i = 0; i < 3; i += 1) await dungMotDon(db, CHUA_CHIN, `${CHUA_CHIN}p`, `${CHUA_CHIN}v`, `n${i}`, i < 2, luc);
}

export async function testCrossReportParity(db: Db) {
  const luc = gio(72);
  await dungFixtureParity(db, luc);

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  clearMemo();

  const { getProjectedDeliveryMetrics } = await import("@/lib/queries/projected-delivery");
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");

  // Bảng lợi nhuận đi theo NGÀY TẠO ĐƠN, nên hợp đồng phải được hỏi bằng đúng mốc đó.
  const hopDong = await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT");
  const dongHopDong = hopDong.rows.find((r) => r.code === MA);
  assert.ok(dongHopDong, "hợp đồng phải thấy mã fixture — nếu không thì bài này rỗng và không khoá được gì");
  assert.equal(dongHopDong.key, `${X}p`, "grain PRODUCT khoá theo product_id — đúng khoá bảng lợi nhuận dùng");
  assert.equal(dongHopDong.eligibleSent, 12);
  assert.equal(dongHopDong.active, 0, "fixture cố ý KHÔNG có đơn đang chạy, để số không phụ thuộc bảng xác suất");
  assert.equal(dongHopDong.projectedRate, 50, "6 giao / 12 gửi = 50%");
  assert.equal(dongHopDong.projectedDeliveredRevenue, 3_000_000, "DT GTC ước tính = DT 6 đơn đã giao (cân theo từng đơn)");

  const nominal = await getNominalProfitReport(ky);
  const dongLoiNhuan = nominal.rows.find((r) => r.code === MA);
  assert.ok(dongLoiNhuan, "bảng lợi nhuận phải thấy mã fixture");

  /*
    BẤT BIẾN CHÍNH: so THẲNG hai đầu ra, không so hai công thức — dù ai sửa chỗ nào, hai trang vẫn
    phải nói cùng một câu về cùng một mã trong cùng một kỳ.
  */
  assert.equal(dongLoiNhuan.deliveryRate, dongHopDong.projectedRate, "TL GTC ước tính của bảng lợi nhuận phải TRÙNG KHÍT con số của hợp đồng — cùng mã, cùng kỳ, cùng mốc");
  assert.equal(dongLoiNhuan.returnRate, Math.round((100 - dongHopDong.projectedRate!) * 10) / 10);
  assert.equal(dongLoiNhuan.returnRateSource, "projected", "phải khai đúng nguồn: con số này do mô hình dựng, không phải tỷ lệ lịch sử của mã");
  assert.ok(dongLoiNhuan.projection && dongLoiNhuan.projection.eligibleSent === 12, "phải mang theo xuất xứ để màn hình nói ra được");
  assert.equal(dongLoiNhuan.revenueBasis, "ORDER_LEVEL", "nguồn projected ⇒ tiền cân theo TỪNG ĐƠN, không phải doanh số × tỷ lệ");
  assert.equal(dongLoiNhuan.expectedRevenue, dongHopDong.projectedDeliveredRevenue, "DT GTC ƯT của bảng lợi nhuận = ĐÚNG doanh thu cân theo đơn của hợp đồng");
  assert.equal(dongLoiNhuan.expectedCogs, dongHopDong.projectedCogs, "giá vốn ước tính cũng cân theo đơn");
  assert.equal(dongLoiNhuan.expectedCogs, 1_200_000, "chỉ 6 đơn đã giao mang giá vốn");

  /*
    ═══ BẤT BIẾN THỨ HAI: MÃ CHƯA CHÍN CỐ Ý KHÔNG LẤY SỐ CỦA HỢP ĐỒNG ═══

    Parity ở trên khoá "hai trang nói cùng một câu". Nhưng nó chỉ đúng KHI mã đã chín. Với mã chưa
    chín, hợp đồng vẫn ra một con số — và con số ấy phần lớn là xác suất học từ MÃ KHÁC. Bảng lợi
    nhuận phải TỪ CHỐI nó và dùng bậc co ngót, nếu không thì lỗi Đầm Q005 (23/09/2026) quay lại:
    mã giao được 5/6 mà ô in 35,9% vì tỷ lệ nền của shop là 33%.

    Bài này khoá đúng vế đó: cùng một fixture, cùng một kỳ, hai mã — một chín, một chưa.
  */
  const hopDongNC = hopDong.rows.find((r) => r.code === MA_CHUA_CHIN);
  assert.ok(hopDongNC, "hợp đồng phải thấy cả mã chưa chín");
  assert.equal(hopDongNC.eligibleSent, 3);
  assert.equal(hopDongNC.actualRate, 66.7, "2 giao / 3 kết thúc = 66,7% — SỐ ĐO THẬT của chính mã");

  const loiNhuanNC = nominal.rows.find((r) => r.code === MA_CHUA_CHIN);
  assert.ok(loiNhuanNC, "bảng lợi nhuận phải thấy mã chưa chín");
  assert.equal(loiNhuanNC.rateMature, false, "3 đơn kết thúc là CHƯA CHÍN");
  assert.equal(loiNhuanNC.rateOwnFinished, 3);
  assert.equal(loiNhuanNC.returnRateSource, "blended", "mã chưa chín KHÔNG được mang nhãn số đo");
  assert.equal(loiNhuanNC.revenueBasis, "RATE", "chưa chín ⇒ tiền = Doanh số POS × tỷ lệ, không cân theo đơn");
  /*
    Con số phải nằm GIỮA số đo của chính mã và tỷ lệ khai — đó là định nghĩa của co ngót. Hai cận
    lấy từ chính dữ liệu đang chạy, KHÔNG gõ lại một hằng số: ngưỡng và tỷ lệ khai sửa được ở Giả
    định mà không cần deploy, nên một con số gõ cứng ở đây sẽ đỏ vào ngày chủ shop đổi chúng.
  */
  const khai = 100 - nominal.assumptions.defaultReturnRate;
  const soDo = hopDongNC.actualRate!;
  assert.ok(loiNhuanNC.deliveryRate !== null);
  assert.ok(
    loiNhuanNC.deliveryRate! > Math.min(khai, soDo) && loiNhuanNC.deliveryRate! < Math.max(khai, soDo),
    `co ngót phải nằm giữa ${khai}% (tỷ lệ khai) và ${soDo}% (số đo của mã), đang là ${loiNhuanNC.deliveryRate}%`,
  );

  /* ─── Trang hiệu quả theo mã: cùng hợp đồng, chỉ khác grain và mốc ─── */
  const { getReturnRateSummary, getReturnRateByVariant } = await import("@/lib/queries/return-rate");
  const tong = await getReturnRateSummary(ky, "", "SHIPPED");
  const hopDongGui = await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT");
  assert.equal(tong.projectionError, null, "không có lỗi thì trường lỗi phải rỗng");
  assert.equal(tong.expectedSuccessRate, hopDongGui.orderLevel.projectedRate, "thẻ “Tỷ lệ giao thành công” phải là ĐÚNG con số của hợp đồng ở cùng mốc, không phải một phép trộn riêng");
  assert.ok(tong.projection !== null && tong.projection.version === PROJECTED_GTC_VERSION, "thẻ phải mang theo phiên bản hợp đồng để màn hình khai ra");
  assert.ok(tong.projection.backtest !== null || tong.projection.backtestError !== null, "nhãn tin cậy (hoặc lỗi thử ngược) phải đi kèm con số ước tính");

  /* ─── Grain MẪU MÃ: cùng hợp đồng, dòng của mã fixture phải khớp ─── */
  const bang = await getReturnRateByVariant({ period: ky, basis: "SHIPPED", q: "", minShipped: 0, sort: "successRate", dir: "asc", page: 1, pageSize: 50 });
  const dongMauMa = bang.all.find((r) => r.sku === `${MA}-S`);
  assert.ok(dongMauMa, "bảng theo mẫu mã phải thấy fixture");
  assert.equal(dongMauMa.expectedSuccessRate, 50, "một mẫu mã duy nhất của một mã duy nhất ⇒ hai grain phải ra cùng một số");
  assert.equal(dongMauMa.projectedSent, 12, "phải mang tử số / mẫu số THÔ để dòng gộp cộng được thay vì bình quân các tỷ lệ");
  assert.equal(dongMauMa.projectedDelivered, 6);
}

/* ───── 9 · MỐC LỌC ĐI THEO NGƯỜI DÙNG CHỌN, KHÔNG GHIM CỨNG ───── */
export async function testBasisFlowsThrough(db: Db) {
  const luc = gio(72);
  await db.insert(schema.orders).values({ id: `${X}o-lech`, stage: "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${X}i-lech`, orderId: `${X}o-lech`, variantId: `${X}v`, productId: `${X}p`, sku: `${MA}-S`, productName: "Hàng kiểm parity", variationDetail: "S", quantity: 1, lineTotal: 500_000, unitCost: 200_000, isBonus: false }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: `${X}s-lech`,
      orderId: `${X}o-lech`,
      carrier: "Viettel Post",
      vtpOrderNumber: `${X}LECH`,
      vtpStatus: 501,
      vtpStatusName: "Giao thành công",
      stage: "DELIVERED",
      isFinal: true,
      codAmount: 500_000,
      codCollected: 500_000,
      // ĐVVC cầm hàng 40 NGÀY trước — ngoài cửa sổ 30 ngày, dù đơn chốt trong cửa sổ.
      pickedUpAt: gio(24 * 40),
      deliveredAt: luc,
    })
    .onConflictDoNothing();

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  clearMemo();
  const { getProjectedDeliveryMetrics } = await import("@/lib/queries/projected-delivery");

  const theoGui = (await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT")).rows.find((r) => r.code === MA);
  const theoChot = (await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT")).rows.find((r) => r.code === MA);
  assert.equal(theoGui?.eligibleSent, 12, "mốc NGÀY GỬI: đơn có mốc lấy hàng 40 ngày trước nằm NGOÀI cohort");
  assert.equal(theoChot?.eligibleSent, 13, "mốc NGÀY CHỐT ĐƠN: chính đơn đó nằm TRONG cohort");
  assert.notEqual(theoGui?.projectedRate, theoChot?.projectedRate, "hai mốc phải cho hai con số khác nhau — nếu không thì fixture chưa chứng minh được điều gì");

  // Và thẻ tổng hợp phải ĐI THEO mốc được truyền vào, không ghim cứng một mốc.
  const { getReturnRateSummary } = await import("@/lib/queries/return-rate");
  const gui = await getReturnRateSummary(ky, "", "SHIPPED");
  const chot = await getReturnRateSummary(ky, "", "ORDERED");
  assert.equal(gui.projection?.eligibleSent, (await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT")).orderLevel.eligibleSent);
  assert.equal(chot.projection?.eligibleSent, (await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT")).orderLevel.eligibleSent);
  assert.notEqual(gui.projection?.eligibleSent, chot.projection?.eligibleSent, "đổi mốc phải đổi cohort — ghim cứng thì hai con số này bằng nhau");
}

/* ───── 10 · GHI ĐÈ TAY THẮNG MÔ HÌNH ───── */
export async function testOverrideBeatsModel() {
  const { getSettingJson, setSettingJson } = await import("@/lib/settings");
  const cu = await getSettingJson<Record<string, unknown>>(PROFIT_ASSUMPTIONS_KEY, {});
  const overrides = { ...(cu.overrides as Record<string, number> | undefined) };
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...cu, overrides: { ...overrides, [`${X}p`]: 12.5 } });

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  clearMemo();
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const bao = await getNominalProfitReport(ky);
  const dong = bao.rows.find((r) => r.code === MA);
  assert.ok(dong);
  assert.equal(dong.returnRateSource, "override", "ghi đè tay phải THẮNG mô hình");
  assert.equal(dong.returnRate, 12.5, "và giữ nguyên con số chủ shop đã gõ, không bị mô hình làm tròn lại");
  assert.equal(dong.projection, null, "nguồn là ghi đè ⇒ không được khai xuất xứ mô hình cho một con số mô hình không sinh ra");
  assert.equal(dong.revenueBasis, "RATE", "ghi đè ⇒ tiền tính theo tỷ lệ, và nhãn phải nói “ước tính theo tỷ lệ”");
  assert.equal(dong.expectedRevenue, Math.round(dong.grossSales * (1 - 0.125)), "ghi đè: DT = doanh số POS × (1 − r)");
  // Thẻ tổng của trang KHÔNG đổi theo ghi đè: nó là con số của hợp đồng ở grain đơn.
  const { getProjectedDeliveryMetrics } = await import("@/lib/queries/projected-delivery");
  assert.equal(bao.totals.weightedDeliveryRate, (await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT")).orderLevel.projectedRate, "thẻ TL GTC ước tính toàn shop = orderLevel.projectedRate của hợp đồng, kể cả khi có ghi đè");

  // Trả lại đúng trạng thái cũ: khối khác đọc chung cấu hình này.
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, cu);
  clearMemo();
}
