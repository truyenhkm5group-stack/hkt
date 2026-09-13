import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARRIER_SUBSTATES } from "@/lib/constants/carrier-substate";
import { confidenceOf, CONFIDENCE_THRESHOLDS, PROJECTED_GTC_VERSION } from "@/lib/constants/projected-delivery";
import { inventoryRiskOnSold } from "@/lib/constants/cost-allocation";
import { adsRatio, PROFIT_ASSUMPTIONS_KEY } from "@/lib/constants/profit";
import { backtestProjectedDelivery, getProbabilityLookup, getStateDeliveryProbabilities } from "@/lib/queries/projected-delivery";

/**
 * ═══════════ CÙNG MỘT CHỈ SỐ PHẢI RA CÙNG MỘT SỐ Ở MỌI TRANG ═══════════
 *
 * Bài này khoá mô hình dự báo giao thành công: học từ lịch sử thật, một vận đơn một quan sát, kiện
 * chưa kết thúc không vào mẫu số, và không có con số nào được ghi cứng.
 */

const P = "par-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

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
  assert.equal(PROJECTED_GTC_VERSION, "PROJECTED_GTC_V2", "đổi công thức phải đổi phiên bản, để kỳ cũ không bị đọc bằng luật mới");
}

/* ───── 2 · Xác suất học từ lịch sử: một vận đơn một quan sát ───── */
export async function testProbabilityFromHistory(db: Db) {
  // Ba kiện "chờ phát lại" đã kết thúc: 2 giao được, 1 hoàn ⇒ p = 2/3.
  const ca: { id: string; stage: "DELIVERED" | "RETURNED"; soSuKien: number }[] = [
    { id: "h1", stage: "DELIVERED", soSuKien: 5 },
    { id: "h2", stage: "DELIVERED", soSuKien: 1 },
    { id: "h3", stage: "RETURNED", soSuKien: 3 },
  ];
  for (const c of ca) {
    await db.insert(schema.orders).values({ id: `${P}o-${c.id}`, stage: "SHIPPED", status: 2, insertedAt: gio(200) }).onConflictDoNothing();
    await db.insert(schema.shipments).values({ id: `${P}${c.id}`, orderId: `${P}o-${c.id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${c.id}`.toUpperCase(), stage: c.stage, isFinal: true }).onConflictDoNothing();
    // NHIỀU sự kiện CÙNG một trạng thái — đúng cách Viettel Post thử lại webhook tới 5 lần.
    for (let i = 0; i < c.soSuKien; i++) {
      await db
        .insert(schema.shipmentEvents)
        .values({ shipmentId: `${P}${c.id}`, source: "VTP_WEBHOOK", status: "", statusName: "Chờ phát lại", occurredAt: new Date(gio(150).getTime() + i * 60_000) })
        .onConflictDoNothing();
    }
  }
  // Một kiện CHƯA kết thúc, cũng "chờ phát lại" — KHÔNG được vào mẫu số.
  await db.insert(schema.orders).values({ id: `${P}o-h4`, stage: "SHIPPED", status: 2, insertedAt: gio(50) }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: `${P}h4`, orderId: `${P}o-h4`, carrier: "Viettel Post", vtpOrderNumber: `${P}H4`, stage: "DELIVERY_FAILED", isFinal: false }).onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}h4`, source: "VTP_WEBHOOK", status: "", statusName: "Chờ phát lại", occurredAt: gio(40) }).onConflictDoNothing();

  clearMemo();
  const { states, version } = await getStateDeliveryProbabilities();
  assert.equal(version, PROJECTED_GTC_VERSION);
  const cpl = states.find((s) => s.substate === "WAITING_REDELIVERY")!;
  assert.equal(cpl.sample, 3, "chín sự kiện của ba vận đơn phải cho ĐÚNG BA quan sát — số lần webhook lặp không được quyết định xác suất");
  assert.equal(cpl.delivered, 2);
  assert.ok(cpl.p !== null && Math.abs(cpl.p - 2 / 3) < 1e-9, "p = 2/3");

  // Mọi trạng thái đều có mặt trong bảng, kể cả trạng thái chưa có mẫu nào.
  assert.equal(states.length, CARRIER_SUBSTATES.length, "bảng xác suất phải phủ hết trạng thái, không im lặng bỏ trạng thái chưa gặp");
  for (const s of states) {
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
}

/* ───── 4 · Đối chiếu ngược chạy được và không bịa số khi thiếu dữ liệu ───── */
export async function testBacktestHonest() {
  clearMemo();
  const b = await backtestProjectedDelivery();
  if (b.sample === 0) {
    assert.equal(b.mae, null, "không mẫu nào ⇒ không có sai số để báo, KHÔNG in 0");
    assert.equal(b.bias, null);
  } else {
    assert.ok(b.mae !== null && b.mae >= 0 && b.mae <= 1, "sai số tuyệt đối trung bình nằm trong [0,1]");
    assert.ok(b.bias !== null && b.bias >= -1 && b.bias <= 1);
  }
  assert.ok(b.coverage === null || (b.coverage >= 0 && b.coverage <= 100));
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
  }
  // Đơn chưa lần được mã KHÔNG bị nhét vào một mã nào đó cho đủ bảng.
  assert.ok(m.unmappedOrders >= 0 && m.totalOrders >= m.unmappedOrders);
  assert.equal(m.version, PROJECTED_GTC_VERSION);
}

/* ───── 6 · Rủi ro tồn kho là CHI PHÍ CỦA KỲ, không phải của lô nhập ───── */
export function testInventoryRiskIsPeriodExpense() {
  /*
    Bài này khoá bằng ĐỌC MÃ NGUỒN, vì chỗ hỏng nằm ở CHỌN BIẾN NÀO chứ không ở phép tính: bảng
    "lợi nhuận theo hàng nhập" từng trừ `inventoryRiskOnPurchase` (rủi ro CẢ ĐỜI của lô) vào lợi
    nhuận kỳ chứa phiếu nhập. Hệ quả đo được trên production: kỳ 7 ngày không có phiếu nhập nào ⇒
    cột rủi ro bằng ĐÚNG 0, và bảng nói hàng đang bán không mang rủi ro nào.
  */
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
  // Đúng ví dụ trong đặc tả.
  assert.equal(adsRatio(10_000_000, 100_000_000), 10, "10tr / 100tr = 10%");
  assert.equal(adsRatio(10_000_000, 50_000_000), 20, "10tr / 50tr = 20%");
  /*
    MẪU SỐ 0 ⇒ `null`, KHÔNG phải 0%.

    Chưa bán được đồng nào mà hiện "0%" sẽ bị đọc thành "quảng cáo không tốn gì" — ngược hoàn toàn
    sự thật, và ngược đúng vào lúc nguy hiểm nhất (mã mới chạy, chưa ra đơn).
  */
  assert.equal(adsRatio(10_000_000, 0), null, "mẫu số 0 ⇒ chưa tính được, không phải 0%");
  assert.equal(adsRatio(0, 0), null);
  assert.equal(adsRatio(10_000_000, -5), null, "mẫu số âm cũng không chia");
  // Chi 0 đồng quảng cáo mà CÓ doanh số thì 0% là con số THẬT — không được biến nó thành N/A.
  assert.equal(adsRatio(0, 100_000_000), 0, "không chi quảng cáo mà vẫn bán được ⇒ 0% là sự thật");
}

export async function testReportingParity(db: Db) {
  testNoHardcodedProbability();
  /*
    THỨ TỰ CÓ Ý NGHĨA: khối 2 và 3 khoá cỡ mẫu của trạng thái "chờ phát lại" bằng con số ĐÚNG BA.
    Mọi khối gieo thêm vận đơn vào trạng thái ấy phải chạy SAU chúng, nếu không thì bài không hỏng
    vì mã sai mà hỏng vì bài đứng nhầm chỗ.
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
  await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, [`${X}v`]));
  await db.delete(schema.products).where(inArray(schema.products.id, [`${X}p`]));

  clearMemo();
  console.log("✓ Một hợp đồng cho “TL GTC ước tính”: xác suất học từ lịch sử · một vận đơn một quan sát · kiện chưa kết thúc ngoài mẫu số · mẫu nhỏ KHÔNG thành xác suất · không con số nào ghi cứng · rủi ro tồn kho là chi phí CỦA KỲ · mẫu số 0 ⇒ N/A không phải 0%");
  console.log("✓ Parity chéo hai trang: cùng mã + cùng kỳ + cùng mốc ⇒ CÙNG MỘT SỐ · hai grain khớp nhau · đổi mốc thì đổi cohort (không ghim cứng) · ghi đè tay THẮNG mô hình");
}

/* ───── 8 · CÙNG MÃ + CÙNG KỲ + CÙNG MỐC ⇒ CÙNG MỘT SỐ Ở HAI TRANG ───── */

const X = "parx-";
/** Mã hàng của fixture — cố tình lạ để không đụng dữ liệu của khối khác. */
const MA = "PARX-GTC";

/**
 * Dựng một mã hàng có kết cục ĐÃ NGÃ NGŨ HẾT: 1 giao thành công, 1 hoàn, 0 đơn đang chạy.
 *
 * Chọn "hết đơn đang chạy" là cố ý: khi ấy tỷ lệ ước tính KHÔNG phụ thuộc bảng xác suất học được
 * (vốn đổi theo dữ liệu của các khối khác trong cùng CSDL dùng chung), nên bài này khoá đúng một
 * thứ — HAI TRANG CÓ CÙNG MỘT SỐ HAY KHÔNG — chứ không khoá kèm giá trị của mô hình.
 */
async function dungFixtureParity(db: Db, luc: Date) {
  await db.insert(schema.products).values({ id: `${X}p`, name: "Hàng kiểm parity", customId: MA }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${X}v`, productId: `${X}p`, sku: `${MA}-S`, retailPrice: 500_000 }).onConflictDoNothing();

  const don: { id: string; giao: boolean }[] = [
    { id: "d1", giao: true },
    { id: "d2", giao: false },
  ];
  for (const d of don) {
    await db.insert(schema.orders).values({ id: `${X}o-${d.id}`, stage: "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 500_000 }).onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${X}i-${d.id}`, orderId: `${X}o-${d.id}`, variantId: `${X}v`, productId: `${X}p`, sku: `${MA}-S`, productName: "Hàng kiểm parity", variationDetail: "S", quantity: 1, lineTotal: 500_000, unitCost: 200_000, isBonus: false }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({
        id: `${X}s-${d.id}`,
        orderId: `${X}o-${d.id}`,
        carrier: "Viettel Post",
        vtpOrderNumber: `${X}${d.id}`.toUpperCase(),
        // `vtp_status` 501 / 504 là CHỨNG TỪ ĐVVC — đúng bậc căn cứ cao nhất của luật kết quả đơn.
        vtpStatus: d.giao ? 501 : 504,
        vtpStatusName: d.giao ? "Giao thành công" : "Chuyển hoàn",
        stage: d.giao ? "DELIVERED" : "RETURNED",
        isFinal: true,
        // COD thực thu > 100K cho đơn giao được: bảng lợi nhuận đếm "đã giao" theo TIỀN, không theo stage.
        codAmount: 500_000,
        codCollected: d.giao ? 500_000 : 0,
        pickedUpAt: luc,
        deliveredAt: d.giao ? luc : null,
      })
      .onConflictDoNothing();
    await db.insert(schema.shipmentEvents).values({ shipmentId: `${X}s-${d.id}`, source: "VTP_WEBHOOK", status: d.giao ? "501" : "504", statusName: d.giao ? "Giao thành công" : "Chuyển hoàn", occurredAt: luc }).onConflictDoNothing();
  }
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
  assert.equal(dongHopDong.eligibleSent, 2);
  assert.equal(dongHopDong.active, 0, "fixture cố ý KHÔNG có đơn đang chạy, để số không phụ thuộc bảng xác suất");
  assert.equal(dongHopDong.projectedRate, 50, "1 giao / 2 gửi = 50%");

  const nominal = await getNominalProfitReport(ky);
  const dongLoiNhuan = nominal.rows.find((r) => r.code === MA);
  assert.ok(dongLoiNhuan, "bảng lợi nhuận phải thấy mã fixture");

  /*
    ĐÂY LÀ BẤT BIẾN CHÍNH CỦA CẢ BẢN NÀY.

    Trước bản này bảng lợi nhuận tự trộn `(hoàn + chờ_phát_lại × p + chưa_rõ × giả_định) ÷ tổng_đơn`
    còn trang hiệu quả theo mã trộn một kiểu khác — bốn khác biệt độc lập (mẫu số, cách xử lý nhóm
    chưa rõ, mốc cohort, grain) nhân nhau thành hai con số không bao giờ gặp nhau.

    Bài này so THẲNG hai đầu ra, không so hai công thức: dù ai sửa chỗ nào, hai trang vẫn phải nói
    cùng một câu về cùng một mã trong cùng một kỳ.
  */
  assert.equal(dongLoiNhuan.deliveryRate, dongHopDong.projectedRate, "TL GTC ước tính của bảng lợi nhuận phải TRÙNG KHÍT con số của hợp đồng — cùng mã, cùng kỳ, cùng mốc");
  assert.equal(dongLoiNhuan.returnRate, Math.round((100 - dongHopDong.projectedRate) * 10) / 10);
  assert.equal(dongLoiNhuan.returnRateSource, "projected", "phải khai đúng nguồn: con số này do mô hình dựng, không phải tỷ lệ lịch sử của mã");
  assert.ok(dongLoiNhuan.projection && dongLoiNhuan.projection.eligibleSent === 2, "phải mang theo xuất xứ để màn hình nói ra được");

  /* ─── Trang hiệu quả theo mã: cùng hợp đồng, chỉ khác grain và mốc ─── */
  const { getReturnRateSummary, getReturnRateByVariant } = await import("@/lib/queries/return-rate");
  const tong = await getReturnRateSummary(ky, "", "SHIPPED");
  const hopDongGui = await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT");
  const tuSo = hopDongGui.rows.reduce((a, r) => a + r.projectedDelivered, 0);
  const mauSo = hopDongGui.rows.reduce((a, r) => a + r.eligibleSent, 0);
  const mongDoi = mauSo > 0 ? Math.round((tuSo / mauSo) * 1000) / 10 : null;
  assert.equal(tong.expectedSuccessRate, mongDoi, "thẻ “Tỷ lệ giao thành công” phải là ĐÚNG con số của hợp đồng ở cùng mốc, không phải một phép trộn riêng");
  assert.ok(tong.projection !== null && tong.projection.version === PROJECTED_GTC_VERSION, "thẻ phải mang theo phiên bản hợp đồng để màn hình khai ra");

  /* ─── Grain MẪU MÃ: cùng hợp đồng, dòng của mã fixture phải khớp ─── */
  const bang = await getReturnRateByVariant({ period: ky, basis: "SHIPPED", q: "", minShipped: 0, sort: "successRate", dir: "asc", page: 1, pageSize: 50 });
  const dongMauMa = bang.all.find((r) => r.sku === `${MA}-S`);
  assert.ok(dongMauMa, "bảng theo mẫu mã phải thấy fixture");
  assert.equal(dongMauMa.expectedSuccessRate, 50, "một mẫu mã duy nhất của một mã duy nhất ⇒ hai grain phải ra cùng một số");
  assert.equal(dongMauMa.projectedSent, 2, "phải mang tử số / mẫu số THÔ để dòng gộp cộng được thay vì bình quân các tỷ lệ");
  assert.equal(dongMauMa.projectedDelivered, 1);
}

/* ───── 9 · MỐC LỌC ĐI THEO NGƯỜI DÙNG CHỌN, KHÔNG GHIM CỨNG ───── */
export async function testBasisFlowsThrough(db: Db) {
  /*
    Đơn CHỐT trong kỳ nhưng ĐVVC mới cầm hàng TRƯỚC kỳ. Đo production 13/09/2026: 73,6% vận đơn có
    hai mốc rơi vào hai ngày khác nhau, lệch trung bình 4,5 ngày — nên đây không phải ca hiếm.

    Trang hiệu quả theo mã cho người dùng đổi mốc. Nếu bảng lọc theo mốc đang chọn mà con số ước
    tính vẫn ghim "ngày gửi", màn hình sẽ in một bảng của lô này kèm một tỷ lệ của lô khác.
  */
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
  assert.equal(theoGui?.eligibleSent, 2, "mốc NGÀY GỬI: đơn có mốc lấy hàng 40 ngày trước nằm NGOÀI cohort");
  assert.equal(theoChot?.eligibleSent, 3, "mốc NGÀY CHỐT ĐƠN: chính đơn đó nằm TRONG cohort");
  assert.notEqual(theoGui?.projectedRate, theoChot?.projectedRate, "hai mốc phải cho hai con số khác nhau — nếu không thì fixture chưa chứng minh được điều gì");

  // Và thẻ tổng hợp phải ĐI THEO mốc được truyền vào, không ghim cứng một mốc.
  const { getReturnRateSummary } = await import("@/lib/queries/return-rate");
  const gui = await getReturnRateSummary(ky, "", "SHIPPED");
  const chot = await getReturnRateSummary(ky, "", "ORDERED");
  assert.equal(gui.projection?.eligibleSent, (await getProjectedDeliveryMetrics(ky, "SHIPPED", "PRODUCT")).rows.reduce((a, r) => a + r.eligibleSent, 0));
  assert.equal(chot.projection?.eligibleSent, (await getProjectedDeliveryMetrics(ky, "ORDERED", "PRODUCT")).rows.reduce((a, r) => a + r.eligibleSent, 0));
  assert.notEqual(gui.projection?.eligibleSent, chot.projection?.eligibleSent, "đổi mốc phải đổi cohort — ghim cứng thì hai con số này bằng nhau");
}

/* ───── 10 · GHI ĐÈ TAY THẮNG MÔ HÌNH ───── */
export async function testOverrideBeatsModel() {
  /*
    Chủ shop gõ một tỷ lệ cho mã là một QUYẾT ĐỊNH, không phải một ước lượng cần được cải thiện.
    Khi nối mô hình vào bảng lợi nhuận, nhánh mới rất dễ đè lên nhánh ghi đè — và hỏng theo kiểu
    khó thấy nhất: ô nhập vẫn nhận số, vẫn lưu, mà bảng không đổi.
  */
  const { getSettingJson, setSettingJson } = await import("@/lib/settings");
  const cu = await getSettingJson<Record<string, unknown>>(PROFIT_ASSUMPTIONS_KEY, {});
  // Khoá ĐÚNG như `ProfitAssumptions` khai: `overrides`, đánh theo `productId` (không phải mã hàng).
  const overrides = { ...(cu.overrides as Record<string, number> | undefined) };
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, { ...cu, overrides: { ...overrides, [`${X}p`]: 12.5 } });

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  clearMemo();
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const dong = (await getNominalProfitReport(ky)).rows.find((r) => r.code === MA);
  assert.ok(dong);
  assert.equal(dong.returnRateSource, "override", "ghi đè tay phải THẮNG mô hình");
  assert.equal(dong.returnRate, 12.5, "và giữ nguyên con số chủ shop đã gõ, không bị mô hình làm tròn lại");
  assert.equal(dong.projection, null, "nguồn là ghi đè ⇒ không được khai xuất xứ mô hình cho một con số mô hình không sinh ra");

  // Trả lại đúng trạng thái cũ: khối khác đọc chung cấu hình này.
  await setSettingJson(PROFIT_ASSUMPTIONS_KEY, cu);
  clearMemo();
}
