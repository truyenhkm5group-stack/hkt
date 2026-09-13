import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { CARRIER_SUBSTATES } from "@/lib/constants/carrier-substate";
import { confidenceOf, CONFIDENCE_THRESHOLDS, PROJECTED_GTC_VERSION } from "@/lib/constants/projected-delivery";
import { inventoryRiskOnSold } from "@/lib/constants/cost-allocation";
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

export async function testReportingParity(db: Db) {
  testNoHardcodedProbability();
  await testProbabilityFromHistory(db);
  await testLowSampleNotAuthoritative();
  await testBacktestHonest();
  await testProjectedMetricsConsistent();
  testInventoryRiskIsPeriodExpense();

  const ids = [`${P}h1`, `${P}h2`, `${P}h3`, `${P}h4`];
  await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ids));
  await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ids));
  await db.delete(schema.shipments).where(inArray(schema.shipments.id, ids));
  await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
  clearMemo();
  console.log("✓ Một hợp đồng cho “TL GTC ước tính”: xác suất học từ lịch sử · một vận đơn một quan sát · kiện chưa kết thúc ngoài mẫu số · mẫu nhỏ KHÔNG thành xác suất · không con số nào ghi cứng · rủi ro tồn kho là chi phí CỦA KỲ");
}
