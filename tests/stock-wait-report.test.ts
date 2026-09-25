import assert from "node:assert/strict";
import { inArray, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { writeStockWaitLog } from "@/lib/alerts/stock-wait-log";
import type { OrderStockVerdict, StockShortageSnapshot } from "@/lib/constants/stock-shortage";
import {
  PANCAKE_CANCEL_CODES,
  PANCAKE_WAITING_CODES,
  WAIT_BUCKETS,
  WAIT_ORIGINS,
  buildRecommendations,
  buildWaitReport,
  dailyWaitingSeries,
  dayRange,
  expectedRateFor,
  findWaitBreakpoint,
  parseWaitOrigin,
  twoProportionZ,
  waitBucketOf,
  type CurrentWaitingOrder,
  type WaitCell,
} from "@/lib/constants/stock-wait-report";
import { APPROX_REGION_PROVINCES, provinceCatalog, provinceRegion } from "@/lib/constants/vn-regions";
import { MIN_TIER_SAMPLE } from "@/lib/queries/return-rate";
import { getStockWaitReport } from "@/lib/queries/stock-wait-report";
import { SUMMARY_MAX_LINES, mocBatDau, soNgay, stockWaitSummaryLines } from "@/scripts/stock-wait-summary";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ CHỜ HÀNG, VÙNG MIỀN VÀ GTC ═══════════
 *
 * Khoá năm điều:
 *  1. TỈNH → VÙNG → MIỀN: đủ 63 tỉnh cũ, nhận mọi tên 34 tỉnh mới, mọi cách viết thường gặp; chữ lạ là
 *     CHƯA RÕ (null), không bao giờ một vùng đoán mò.
 *  2. KHOẢNG CHỜ nối liền, không chồng; mốc âm / NaN là '?', không rơi vào khoảng đầu.
 *  3. Nhóm dưới ngưỡng mẫu trả `null` (chưa đủ dữ liệu, không phải 0%), và ĐIỂM GÃY chỉ được gọi tên khi
 *     kiểm định hai tỷ lệ đạt 95% — không có thì đề xuất nói "chưa thấy", không bịa.
 *  4. Chuỗi theo ngày: ngày trước khi sổ ERP bật là `null` (CHƯA ĐO), không phải 0.
 *  5. Trên CSDL thật: số ngày chờ đo bằng MỐC BÀN GIAO, kết quả đơn đi qua ORDER_OUTCOME, sổ ghi đúng
 *     vòng đời mở / đóng / mở lại, lịch sử "Chờ hàng" của Pancake thành khoảng theo ngày.
 *
 * Phần CSDL dùng một kỳ CỐ ĐỊNH truyền vào (tháng 3/2017), không phải "N ngày trước" (AGENTS.md mục 50).
 */

const P = "swr-";

function cell(over: Partial<WaitCell>): WaitCell {
  return { province: "Hà Nội", bucket: "D0", segment: "NONE", orders: 0, delivered: 0, returned: 0, inTransit: 0, cancelledBeforeShip: 0, deliveredValue: 0, returnedValue: 0, ...over };
}

export function testStockWaitReportPure() {
  // ───────── 1. Tỉnh → vùng → miền ─────────
  const all = provinceCatalog().flatMap((g) => g.names);
  assert.equal(all.length, 63, "đủ 63 tỉnh / thành trước sáp nhập");
  assert.equal(new Set(all).size, 63, "không tên nào khai hai lần");
  const NEW_34 = [
    "Hà Nội", "Huế", "Lai Châu", "Điện Biên", "Sơn La", "Lạng Sơn", "Quảng Ninh", "Thanh Hóa", "Nghệ An", "Hà Tĩnh", "Cao Bằng",
    "Tuyên Quang", "Lào Cai", "Thái Nguyên", "Phú Thọ", "Bắc Ninh", "Hưng Yên", "Hải Phòng", "Ninh Bình", "Quảng Trị", "Đà Nẵng",
    "Quảng Ngãi", "Gia Lai", "Khánh Hòa", "Lâm Đồng", "Đắk Lắk", "Thành phố Hồ Chí Minh", "Đồng Nai", "Tây Ninh", "Cần Thơ",
    "Vĩnh Long", "Đồng Tháp", "Cà Mau", "An Giang",
  ];
  assert.equal(NEW_34.length, 34);
  for (const name of NEW_34) assert.ok(provinceRegion(name), `tên tỉnh mới "${name}" phải quy được về vùng`);
  const cases: [string, string, string][] = [
    ["TP. Hồ Chí Minh", "DNB", "NAM"],
    ["Hồ Chí Minh", "DNB", "NAM"],
    ["Tỉnh Thừa Thiên Huế", "BTB_DHMT", "TRUNG"],
    ["Đăk Lăk", "TAY_NGUYEN", "TRUNG"],
    ["Hoà Bình", "TDMNPB", "BAC"],
    ["Bà Rịa - Vũng Tàu", "DNB", "NAM"],
    ["  thành phố hà nội ", "DBSH", "BAC"],
    ["Tỉnh Kiên Giang", "DBSCL", "NAM"],
  ];
  for (const [raw, vung, mien] of cases) {
    const r = provinceRegion(raw);
    assert.equal(r?.vung, vung, `"${raw}" phải về vùng ${vung}`);
    assert.equal(r?.mien, mien, `"${raw}" phải về ${mien}`);
  }
  for (const bad of ["", "   ", "Mars", "Quận 1", null, undefined]) assert.equal(provinceRegion(bad), null, `"${bad}" là CHƯA RÕ VÙNG, không phải một vùng đoán`);
  assert.equal(provinceRegion("Gia Lai")?.approxRegion, true, "Gia Lai mới gộp Bình Định ⇒ vùng gần đúng");
  assert.equal(provinceRegion("Kon Tum")?.approxRegion, false, "tên cũ không bị gộp ⇒ vùng chính xác");
  for (const k of APPROX_REGION_PROVINCES) assert.ok(provinceRegion(k), `tỉnh gần đúng "${k}" vẫn phải có trong danh mục`);

  // ───────── 2. Khoảng chờ ─────────
  for (let i = 1; i < WAIT_BUCKETS.length; i++) assert.equal(WAIT_BUCKETS[i].minDays, WAIT_BUCKETS[i - 1].maxDays, `khoảng ${WAIT_BUCKETS[i].key} phải nối liền khoảng trước`);
  assert.equal(WAIT_BUCKETS[WAIT_BUCKETS.length - 1].maxDays, null, "khoảng cuối không chặn trên");
  assert.equal(waitBucketOf(0), "D0");
  assert.equal(waitBucketOf(0.999), "D0");
  assert.equal(waitBucketOf(1), "D1", "cận trên HỞ: đúng 1 ngày thuộc khoảng 1–2");
  assert.equal(waitBucketOf(13.99), "D7_14");
  assert.equal(waitBucketOf(14), "D14");
  assert.equal(waitBucketOf(400), "D14");
  assert.equal(waitBucketOf(-0.01), "?", "mốc ngược không được nhét vào khoảng đầu");
  assert.equal(waitBucketOf(Number.NaN), "?");
  assert.deepEqual(PANCAKE_WAITING_CODES.sort((a, b) => a - b), [11, 20], "nhóm Chờ hàng suy từ bảng trạng thái Pancake");
  assert.deepEqual([...WAIT_ORIGINS], ["ORDERED", "CONFIRMED"]);
  assert.equal(parseWaitOrigin("confirmed"), "CONFIRMED");
  assert.equal(parseWaitOrigin("ORDERED"), "ORDERED");
  assert.equal(parseWaitOrigin("lung tung"), "ORDERED", "giá trị lạ rơi về mốc mặc định, không ném lỗi");
  assert.equal(parseWaitOrigin(undefined), "ORDERED", "không chọn ⇒ giữ đúng mốc của bản đầu, link cũ không đổi nghĩa");
  const noOrigin = buildWaitReport([cell({ bucket: "D0", orders: 4, delivered: 4 }), cell({ bucket: "NO_ORIGIN", orders: 3, delivered: 2, returned: 1 })], MIN_TIER_SAMPLE);
  assert.equal(noOrigin.noOriginOrders, 3, "đơn không có mốc bắt đầu được ĐẾM riêng");
  assert.equal(noOrigin.byWait.reduce((t, r) => t + r.orders, 0), 4, "và KHÔNG rơi vào khoảng chờ nào");
  assert.equal(noOrigin.overall.orders, 7);
  assert.ok(PANCAKE_CANCEL_CODES.includes(6), "Đã huỷ nằm trong nhóm mốc huỷ");

  // ───────── 3. Gộp bảng, ngưỡng mẫu, điểm gãy ─────────
  const m = MIN_TIER_SAMPLE;
  const cells: WaitCell[] = [
    cell({ province: "Hà Nội", bucket: "D0", orders: 20, delivered: 18, returned: 2 }),
    cell({ province: "Hồ Chí Minh", bucket: "D7_14", orders: 20, delivered: 8, returned: 12 }),
    cell({ province: "Mars", bucket: "D1", orders: 3, delivered: 1, returned: 1 }),
    cell({ province: "Gia Lai", bucket: "D2", orders: 2, delivered: 1, returned: 0 }),
    cell({ province: "Đà Nẵng", bucket: "OPEN", orders: 5 }),
    cell({ province: "Đà Nẵng", bucket: "?", orders: 1, delivered: 1 }),
    cell({ province: "Hà Nội", bucket: "D3_5", orders: 2, cancelledBeforeShip: 2 }),
  ];
  const rep = buildWaitReport(cells, m);
  const w = (k: string) => rep.byWait.find((r) => r.key === k)!;
  assert.equal(w("D0").successRate, 90);
  assert.equal(w("D7_14").successRate, 40);
  assert.equal(w("D1").successRate, null, "2 đơn đã kết thúc ⇒ chưa đủ mẫu, KHÔNG phải 50%");
  assert.equal(w("D3_5").cancelledBeforeShip, 2);
  assert.equal(rep.byWait.reduce((t, r) => t + r.orders, 0), 47, "OPEN và '?' nằm ngoài mọi khoảng chờ");
  assert.equal(rep.openOrders, 5);
  assert.equal(rep.anomalyOrders, 1);
  assert.equal(rep.overall.orders, 53, "tổng phủ MỌI đơn, kể cả chưa gửi / thiếu mốc");
  assert.equal(rep.unknownRegion.orders, 3);
  assert.deepEqual(rep.unknownRegion.samples, ["Mars"]);
  assert.equal(rep.approxRegionOrders, 2);
  assert.equal(rep.byMien.find((r) => r.key === "BAC")!.orders, 22);
  assert.equal(rep.matrix.find((x) => x.mien === "NAM")!.cells.find((c) => c.key === "D7_14")!.successRate, 40);

  assert.equal(twoProportionZ(1, 0, 1, 1), null, "nhóm rỗng không so được");
  assert.equal(twoProportionZ(5, 5, 7, 7), null, "cả hai 100% ⇒ không có phương sai");
  assert.ok((twoProportionZ(18, 20, 8, 20) as number) > 0 && (twoProportionZ(8, 20, 18, 20) as number) < 0, "dấu z theo nhóm cao hơn");

  const bp = findWaitBreakpoint(rep.byWait, m);
  assert.ok(bp, "90% so với 40% trên 20/20 đơn phải là một điểm gãy");
  assert.ok(bp!.beforeRate > bp!.afterRate);
  assert.ok(bp!.z >= 1.96);
  // Cùng tỷ lệ hai phía ⇒ không điểm gãy nào.
  const flat = buildWaitReport([cell({ bucket: "D0", orders: 20, delivered: 14, returned: 6 }), cell({ bucket: "D7_14", orders: 20, delivered: 14, returned: 6 })], m);
  assert.equal(findWaitBreakpoint(flat.byWait, m), null, "không khác biệt thì không có điểm gãy");
  // Mẫu mỏng ⇒ không kết luận dù chênh lệch lớn.
  const thin = buildWaitReport([cell({ bucket: "D0", orders: 5, delivered: 5 }), cell({ bucket: "D7_14", orders: 5, returned: 5 })], m);
  assert.equal(findWaitBreakpoint(thin.byWait, m), null, "dưới ngưỡng mẫu mỗi phía ⇒ chưa kết luận");

  // GTC lịch sử cho đơn đang chờ: ô chéo trước, rơi về khoảng chờ khi ô chéo thiếu.
  assert.deepEqual(expectedRateFor(rep, "D7_14", "NAM"), { rate: 40, basis: "MATRIX" });
  assert.deepEqual(expectedRateFor(rep, "D0", "TRUNG"), { rate: 90, basis: "WAIT" });
  assert.deepEqual(expectedRateFor(rep, "D1", null), { rate: null, basis: null });

  // ───────── 4. Chuỗi theo ngày ─────────
  const now = new Date("2020-01-10T05:00:00Z");
  const days = dayRange("2020-01-01", "2020-01-10", 60);
  assert.equal(days.length, 10);
  assert.equal(dayRange("2020-01-01", "2020-03-31", 7).length, 7, "cắt còn N ngày GẦN NHẤT");
  assert.equal(dayRange("2020-01-01", "2020-03-31", 7)[6], "2020-03-31");
  const series = dailyWaitingSeries(
    days,
    [{ orderId: "a", start: new Date("2020-01-05T02:00:00Z"), end: new Date("2020-01-06T02:00:00Z") }, { orderId: "b", start: new Date("2020-01-08T02:00:00Z"), end: null }],
    [{ orderId: "p", start: new Date("2020-01-02T02:00:00Z"), end: new Date("2020-01-03T02:00:00Z") }],
    new Date("2020-01-05T02:00:00Z"),
    now,
  );
  const day = (d: string) => series.find((x) => x.day === d)!;
  assert.equal(day("2020-01-04").erpWaiting, null, "ngày trước khi sổ bật là CHƯA ĐO, không phải 0");
  assert.equal(day("2020-01-05").erpWaiting, 1);
  assert.equal(day("2020-01-05").erpNew, 1);
  assert.equal(day("2020-01-07").erpWaiting, 0, "sau khi sổ bật, không đơn nào chờ là 0 THẬT");
  assert.equal(day("2020-01-10").erpWaiting, 1, "khoảng còn mở kéo tới bây giờ");
  assert.equal(day("2020-01-02").pancakeWaiting, 1);
  assert.equal(day("2020-01-04").pancakeWaiting, 0);

  // ───────── 3b. Đề xuất sinh từ số ─────────
  const waitingOrder = (id: string, days: number, over: Partial<CurrentWaitingOrder> = {}): CurrentWaitingOrder => ({
    orderId: id, systemId: 1, customer: "K", value: 500_000, insertedAt: now, province: "Hồ Chí Minh", mien: "NAM", vung: "DNB",
    sources: ["ERP"], shortText: "", waitDays: days, bucket: waitBucketOf(days), expectedRate: null, expectedBasis: null, ...over,
  });
  const recs = buildRecommendations({
    report: rep,
    breakpoint: bp,
    current: [waitingOrder("x1", 9), waitingOrder("x2", 0.2), waitingOrder("x3", 0, { waitDays: null, bucket: "?" })],
    topShortVariants: [{ label: "Q005 Đen/M", waitingOrders: 2 }],
    erpSince: null,
    pancakeOnlyWaiting: 3,
  });
  const keys = recs.map((r) => r.key);
  assert.ok(keys.includes("WAIT_BREAKPOINT"));
  const late = recs.find((r) => r.key === "LATE_BACKLOG");
  assert.ok(late, "có đơn đang chờ quá điểm gãy ⇒ phải có việc gọi lại");
  assert.equal(late!.estimated, true, "phần nhân tỷ lệ lịch sử lên đơn đang chờ phải mang nhãn ước tính");
  assert.ok(late!.title.startsWith("1 đơn"), "chỉ đơn đã QUA điểm gãy mới vào danh sách gọi lại — đơn chưa có mốc bắt đầu không bị coi là chờ lâu");
  assert.ok(keys.includes("PANCAKE_WAITING_GAP"));
  assert.ok(keys.includes("ERP_LOG_EMPTY"));
  assert.ok(keys.includes("UNKNOWN_REGION"));
  assert.ok(keys.some((k) => k === "REGION_NAM" || k === "REGION_DNB"), "miền Nam 40% so với 90% trên 20/20 đơn phải được nêu tên");
  for (const r of recs) assert.ok(r.evidence.length > 0 && r.action.length > 0, `đề xuất ${r.key} phải có căn cứ và việc cần làm`);
  const none = buildRecommendations({ report: flat, breakpoint: null, current: [], topShortVariants: [], erpSince: now, pancakeOnlyWaiting: 0 });
  assert.deepEqual(
    none.map((r) => r.key),
    ["WAIT_NO_BREAKPOINT"],
    "dữ liệu phẳng, đủ nguồn ⇒ chỉ một câu 'chưa thấy khác biệt', không bịa khuyến nghị",
  );

  console.log(`✓ Chờ hàng & GTC (thuần): 63 tỉnh cũ + 34 tỉnh mới quy đúng miền, chữ lạ là chưa rõ · ${WAIT_BUCKETS.length} khoảng chờ nối liền · nhóm mỏng ra "—" · điểm gãy chỉ khi z ≥ 1,96 · ngày trước sổ là chưa đo · đề xuất luôn kèm căn cứ`);
}

/* ═══════════════════ TRÊN CSDL ═══════════════════ */

const KY: Period = {
  key: "custom",
  from: new Date("2017-02-28T17:00:00Z"),
  to: new Date("2017-03-31T16:59:59Z"),
  label: "Tháng 3/2017 (bài kiểm chờ hàng)",
  fromKey: "2017-03-01",
  toKey: "2017-03-31",
};
const DAY = 86_400_000;
const at = (iso: string) => new Date(iso);

async function cleanup(db: Db) {
  const ids = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (!ids.length) return;
  await db.delete(schema.stockWaitLog).where(inArray(schema.stockWaitLog.orderId, ids));
  await db.delete(schema.orderStatusHistory).where(inArray(schema.orderStatusHistory.orderId, ids));
  await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, ids));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ids));
}

let seq = 0;
/** Đơn có kết cục do chứng từ ĐVVC (501/504), mốc bàn giao = `handoff`. */
async function shipped(db: Db, id: string, province: string, inserted: Date, waitDays: number, outcome: "DELIVERED" | "RETURNED") {
  const handoff = new Date(inserted.getTime() + waitDays * DAY);
  const code = `PKE-SWR-${++seq}`;
  await db.insert(schema.orders).values({ id: `${P}${id}`, stage: "SHIPPED" as never, shipProvince: province, totalPrice: 400_000, totalPriceAfterDiscount: 400_000, cod: 400_000, insertedAt: inserted });
  const [ship] = await db
    .insert(schema.shipments)
    .values({ orderId: `${P}${id}`, vtpOrderNumber: code, trackingCode: code, stage: outcome as never, codAmount: 400_000, codCollected: outcome === "DELIVERED" ? 400_000 : 0, vtpStatusDate: handoff, pickedUpAt: handoff })
    .returning({ id: schema.shipments.id });
  await db.insert(schema.shipmentEvents).values({
    shipmentId: ship.id,
    source: "VTP_WEBHOOK",
    status: outcome === "DELIVERED" ? "501" : "504",
    statusName: outcome === "DELIVERED" ? "Phát thành công" : "Chuyển hoàn",
    occurredAt: handoff,
    normalizedStage: outcome as never,
    legType: "OUTBOUND",
  });
}

function fakeSnapshot(now: Date, waiting: string[]): StockShortageSnapshot {
  const orders = new Map<string, OrderStockVerdict>(
    waiting.map((id) => [
      id,
      { orderId: id, systemId: null, state: "WAITING_STOCK", shortLines: [{ variantId: "v", label: "Q005 Đen/M", qty: 1, short: 1 }], unknownLines: [], insertedAt: now, customer: "K", value: 1 },
    ]),
  );
  return {
    variants: [],
    orders,
    totals: { variants: 0, shortUnits: 0, waitingOrders: waiting.length, waitingValue: 0, urgentOrders: 0, readyOrders: 0, unknownOrders: 0, unknownVariants: 0, ledgerNegativeVariants: 0, mutedVariants: 0 },
    urgentAfterHours: 24,
    measuredAt: now,
  };
}

export async function testStockWaitReportDb(db: Db) {
  await cleanup(db);
  const base = at("2017-03-01T03:00:00Z");
  // Gửi trong nửa ngày, miền Bắc: 11/12 giao thành công.
  for (let k = 0; k < 12; k++) await shipped(db, `e${k}`, "Hà Nội", base, 0.5, k < 11 ? "DELIVERED" : "RETURNED");
  // Chờ 8 ngày, miền Nam: 4/12 giao thành công.
  for (let k = 0; k < 12; k++) await shipped(db, `l${k}`, "TP. Hồ Chí Minh", base, 8, k < 4 ? "DELIVERED" : "RETURNED");
  // Chữ tỉnh lạ, chờ 2,5 ngày.
  await shipped(db, "mars", "Mars", base, 2.5, "DELIVERED");
  // Huỷ trước khi gửi sau 3 ngày.
  await db.insert(schema.orders).values({ id: `${P}cx`, stage: "CANCELLED" as never, status: 6, shipProvince: "Hà Nội", totalPriceAfterDiscount: 400_000, insertedAt: base });
  await db.insert(schema.orderStatusHistory).values({ orderId: `${P}cx`, status: 6, updatedAt: new Date(base.getTime() + 3.2 * DAY) });
  // Chưa gửi, chưa huỷ.
  await db.insert(schema.orders).values({ id: `${P}open`, stage: "CONFIRMED" as never, status: 1, shipProvince: "Đà Nẵng", totalPriceAfterDiscount: 400_000, insertedAt: base });
  // Đơn Pancake "Chờ hàng" đã qua: chờ 02/03 → 05/03 rồi xác nhận.
  await db.insert(schema.orderStatusHistory).values([
    { orderId: `${P}l0`, status: 11, updatedAt: at("2017-03-02T03:00:00Z") },
    { orderId: `${P}l0`, status: 1, updatedAt: at("2017-03-05T03:00:00Z") },
  ]);
  // Mốc XÁC NHẬN: nhóm chờ lâu (l1..l11) rời nhóm chờ sau 6 ngày ⇒ tính từ xác nhận chỉ còn 2 ngày.
  // Nhóm gửi sớm (e*) và đơn "Mars" KHÔNG có lịch sử trạng thái ⇒ không có mốc xác nhận.
  await db.insert(schema.orderStatusHistory).values(Array.from({ length: 11 }, (_, k) => ({ orderId: `${P}l${k + 1}`, status: 1, updatedAt: new Date(base.getTime() + 6 * DAY) })));
  // Đơn Pancake đang ở "Chờ hàng" từ 20/03 tới giờ.
  await db.insert(schema.orders).values({ id: `${P}wait`, stage: "WAITING" as never, status: 11, shipProvince: "Cần Thơ", billFullName: "Trần Thị Mẫu-SWR-7731", totalPriceAfterDiscount: 300_000, insertedAt: at("2017-03-20T03:00:00Z") });
  await db.insert(schema.orderStatusHistory).values({ orderId: `${P}wait`, status: 11, updatedAt: at("2017-03-20T03:00:00Z") });

  // ───────── Sổ: mở → đóng → mở lại → đóng ─────────
  const e0 = `${P}e0`;
  const t0 = at("2017-03-10T03:00:00Z");
  let res = await writeStockWaitLog(fakeSnapshot(t0, [e0]), t0);
  assert.equal(res.opened, 1);
  res = await writeStockWaitLog(fakeSnapshot(at("2017-03-12T03:00:00Z"), []), at("2017-03-12T03:00:00Z"));
  assert.ok(res.closed >= 1, "đơn hết chờ ⇒ dòng được đóng");
  await writeStockWaitLog(fakeSnapshot(at("2017-03-14T03:00:00Z"), [e0]), at("2017-03-14T03:00:00Z"));
  const [row] = await db.select().from(schema.stockWaitLog).where(inArray(schema.stockWaitLog.orderId, [e0]));
  assert.equal(row.episodes, 2, "chờ lại sau khi đã đóng ⇒ đợt thứ hai");
  assert.equal(row.firstSeenAt.getTime(), t0.getTime(), "mốc đầu GIỮ NGUYÊN khi mở lại");
  assert.equal(row.clearedAt, null);
  assert.equal(row.shortLabels, "Q005 Đen/M ×1");
  await writeStockWaitLog(fakeSnapshot(at("2017-03-15T03:00:00Z"), []), at("2017-03-15T03:00:00Z"));
  // Chạy lại cùng ảnh chụp không đẻ dòng thứ hai.
  await writeStockWaitLog(fakeSnapshot(at("2017-03-15T04:00:00Z"), []), at("2017-03-15T04:00:00Z"));
  assert.equal((await db.select().from(schema.stockWaitLog).where(inArray(schema.stockWaitLog.orderId, [e0]))).length, 1);

  // ───────── Báo cáo ─────────
  const d = await getStockWaitReport(KY, { fresh: true });
  const r = d.report;
  const w = (k: string) => r.byWait.find((x) => x.key === k)!;
  assert.equal(w("D0").orders, 12, "số ngày chờ đo bằng MỐC BÀN GIAO − lúc lên đơn");
  assert.equal(w("D0").delivered, 11);
  assert.equal(w("D7_14").delivered, 4);
  assert.equal(w("D7_14").returned, 8);
  assert.equal(w("D2").orders, 1);
  assert.equal(w("D3_5").cancelledBeforeShip, 1, "huỷ trước khi gửi xếp theo mốc huỷ, không vào GTC");
  assert.equal(w("D3_5").finished, 0);
  assert.equal(r.openOrders, 2, "đơn chưa gửi (kể cả đang Chờ hàng) nằm ngoài mọi khoảng chờ");
  assert.equal(r.unknownRegion.orders, 1);
  assert.equal(r.byMien.find((x) => x.key === "NAM")!.finished, 12);
  assert.equal(r.bySegment.find((x) => x.key === "ERP_LOG")!.orders, 1, "đơn có trong sổ ⇒ nguồn ERP");
  assert.equal(r.bySegment.find((x) => x.key === "PANCAKE_WAITING")!.orders, 2, "đơn từng ở trạng thái Chờ hàng ⇒ nguồn Pancake");

  assert.ok(d.breakpoint, "91,7% so với 33,3% phải là một điểm gãy");
  assert.equal(d.breakpoint!.fromDays, 3, "ranh giới có z lớn nhất: gom cả đơn 2,5 ngày vào phía gửi sớm");

  const day = (k: string) => d.daily.find((x) => x.day === k)!;
  assert.equal(d.daily.length, 31);
  assert.ok(d.erpSince && d.erpSince.getTime() <= t0.getTime());
  assert.equal(day("2017-03-02").pancakeWaiting, 1, "lịch sử Chờ hàng của Pancake thành khoảng theo ngày");
  assert.equal(day("2017-03-06").pancakeWaiting, 0);
  assert.equal(day("2017-03-25").pancakeWaiting, 1, "đơn vẫn đang Chờ hàng kéo tới bây giờ");
  assert.equal(day("2017-03-11").erpWaiting, 1);
  assert.equal(day("2017-03-13").erpWaiting, 1, "khoảng hở giữa hai đợt vẫn tính liền (sổ chỉ giữ mốc đầu và mốc đóng cuối)");
  assert.equal(day("2017-03-16").erpWaiting, 0);
  if (d.erpSince && d.erpSince.getTime() === t0.getTime()) assert.equal(day("2017-03-09").erpWaiting, null, "trước lần ghi đầu tiên là CHƯA ĐO");

  const cur = d.current.find((x) => x.orderId === `${P}wait`);
  assert.ok(cur, "đơn đang Chờ hàng của Pancake phải có trong danh sách đang chờ");
  assert.deepEqual(cur!.sources, ["PANCAKE"]);
  assert.equal(cur!.mien, "NAM");
  assert.equal(cur!.bucket, "D14");
  assert.ok(d.pancakeOnlyWaiting >= 1);
  assert.ok(d.recommendations.some((x) => x.key === "WAIT_BREAKPOINT"));
  assert.ok(d.recommendations.some((x) => x.key === "PANCAKE_WAITING_GAP"));

  // ───────── Mốc XÁC NHẬN: cùng bộ đơn, bảng khác ─────────
  assert.equal(d.origin, "ORDERED");
  assert.equal(r.noOriginOrders, 0, "tính từ lúc lên đơn thì mọi đơn đều có mốc");
  const c = await getStockWaitReport(KY, { fresh: true, origin: "CONFIRMED" });
  const cw = (k: string) => c.report.byWait.find((x) => x.key === k)!;
  assert.equal(c.origin, "CONFIRMED");
  assert.equal(cw("D2").orders, 11, "l1..l11: xác nhận sau 6 ngày, ĐVVC cầm hàng ngày thứ 8 ⇒ chờ 2 ngày tính từ xác nhận");
  assert.equal(cw("D3_5").orders, 1, "l0: rời nhóm Chờ hàng ngày 05/03 ⇒ 4 ngày tính từ xác nhận");
  assert.equal(cw("D7_14").orders, 0, "không đơn nào còn ở khoảng 7–14 ngày khi tính từ xác nhận");
  assert.equal(
    c.report.noOriginOrders,
    14,
    "12 đơn gửi sớm + đơn Mars chưa có lịch sử trạng thái ⇒ KHÔNG có mốc xác nhận, không rơi về mốc lên đơn; + đơn huỷ khi chưa từng xác nhận",
  );
  assert.equal(cw("D0").orders, 0, "đơn huỷ khi còn ở nhóm chờ KHÔNG phải 'chờ 0 ngày rồi huỷ' — nó chưa từng được xác nhận");
  assert.equal(c.report.byWait.reduce((t, x) => t + x.cancelledBeforeShip, 0), 0);
  assert.equal(w("D3_5").cancelledBeforeShip, 1, "tính từ lúc lên đơn thì chính đơn đó vẫn là huỷ sau 3,2 ngày chờ");
  assert.equal(c.report.openOrders, 2);
  const cwait = c.current.find((x) => x.orderId === `${P}wait`);
  assert.equal(cwait?.waitDays, null, "đơn chưa xác nhận: số ngày chờ từ xác nhận là CHƯA BIẾT, không phải 0");
  assert.equal(cwait?.bucket, "?");
  assert.ok(stockWaitSummaryLines(c, 30).some((l) => l.includes("từ lúc xác nhận đơn")), "tóm tắt ops nói rõ đang tính từ mốc nào");
  // Mốc nằm trong khoá đệm: hai lời gọi không-tươi liên tiếp với hai mốc phải ra hai kết quả.
  const memoA = await getStockWaitReport(KY);
  const memoB = await getStockWaitReport(KY, { origin: "CONFIRMED" });
  assert.equal(memoA.origin, "ORDERED");
  assert.equal(memoB.origin, "CONFIRMED", "đệm theo kỳ mà quên mốc thì lượt thứ hai trả nhầm bảng của mốc kia");
  assert.equal(mocBatDau(["--days=30", "--origin=confirmed"]), "CONFIRMED");
  assert.equal(mocBatDau([]), "ORDERED");

  // ───────── Tóm tắt ops: số tổng hợp, KHÔNG BAO GIỜ tên khách, lọt trần 60 dòng ─────────
  const lines = stockWaitSummaryLines(d, 30);
  assert.ok(lines.length <= SUMMARY_MAX_LINES, `kênh tóm tắt chỉ cho ${SUMMARY_MAX_LINES} dòng`);
  assert.ok(lines.every((l) => l.length <= 300));
  assert.ok(!lines.some((l) => l.includes("Mẫu-SWR-7731")), "tên khách của đơn đang chờ KHÔNG được ra log công khai");
  assert.ok(lines.some((l) => l.startsWith("ĐIỂM GÃY: chờ từ 3 ngày")), "tóm tắt in đúng điểm gãy của trang");
  assert.ok(lines.some((l) => l.startsWith("ĐỀ XUẤT:")));
  assert.equal(soNgay([]), 90);
  assert.equal(soNgay(["--days=9999"]), 365);
  assert.equal(soNgay(["--days=1"]), 7);

  await cleanup(db);
  console.log("✓ Chờ hàng & GTC (CSDL): ngày chờ = mốc bàn giao − lên đơn, kết quả qua ORDER_OUTCOME · sổ mở/đóng/mở lại giữ mốc đầu · lịch sử Chờ hàng Pancake thành số theo ngày · điểm gãy + đề xuất sinh từ số");
}
