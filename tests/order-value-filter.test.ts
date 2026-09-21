import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { rowsOf } from "@/lib/sql-rows";
import {
  NO_ORDER_VALUE_FILTER,
  ORDER_VALUE_PRESETS,
  ORDER_VALUE_TIERS,
  orderValueActive,
  orderValueKey,
  orderValueLabel,
  orderValueMatches,
  orderValueWhereSql,
  parseAdsIncluded,
  parseOrderValue,
  type OrderValueFilter,
} from "@/lib/constants/order-value";
import { getReturnRateByTier, getReturnRateSummary, MIN_TIER_SAMPLE } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ BỘ LỌC THEO GIÁ TRỊ ĐƠN ═══════════
 *
 * Ba điều được khoá ở đây, và cả ba đều là chỗ đã từng làm hỏng một báo cáo trong kho này:
 *
 *  1. **HAI BẢN LUẬT PHẢI NÓI CÙNG MỘT ĐIỀU.** Bộ lọc tồn tại ở bản SQL (`orderValueWhereSql`, cho
 *     truy vấn) và bản TypeScript (`orderValueMatches`, cho bảng lợi nhuận đã có sẵn từng đơn
 *     trong bộ nhớ). Bài kiểm chạy CẢ HAI trên cùng bộ mốc biên rồi so từng giá trị — đúng cách
 *     mục 59 giữ hai bản luật mở ca không trôi xa nhau.
 *  2. **CẬN TRÊN LÀ HỞ.** "Đơn dưới 300K" phải loại đúng 300.000. Lệch một đồng ở đây là lệch cả
 *     một bậc giá trong mọi bảng.
 *  3. **0 ĐỒNG KHÔNG PHẢI MỘT BẬC GIÁ** (mục 42). Đơn không khai được giá trị nằm ngoài mọi bậc
 *     và được ĐẾM RIÊNG; nhét chúng vào bậc thấp nhất là khẳng định điều không chứng minh được.
 *
 * Mốc thời gian trong phần CSDL là một KHOẢNG TRUYỀN VÀO, không phải "N ngày trước" so với đồng hồ
 * thật (mục 50): truy vấn lọc theo đúng khoảng ấy nên bài kiểm cho cùng kết quả ở mọi giờ chạy.
 */

/** Kỳ riêng của bài kiểm — xa mọi fixture khác để không đếm nhầm đơn của bài kiểm bên cạnh. */
const KY: Period = {
  key: "custom",
  from: new Date("2018-07-01T00:00:00Z"),
  to: new Date("2018-07-31T23:59:59Z"),
  label: "Tháng 7/2018 (bài kiểm bộ lọc giá trị đơn)",
  fromKey: "2018-07-01",
  toKey: "2018-07-31",
};

const NGAY = new Date("2018-07-10T03:00:00Z");

let seq = 0;

/** Một đơn có kết cục do CHỨNG TỪ ĐVVC quyết định (mã 501/504), không phụ thuộc suy luận theo tiền. */
async function donCoKetCuc(db: Db, tongTien: number, ketCuc: "DELIVERED" | "RETURNED") {
  const id = `ov-${++seq}`;
  const code = `PKE-OV-${seq}`;
  await db.insert(schema.orders).values({
    id,
    stage: "SHIPPED" as never,
    totalPrice: tongTien,
    totalPriceAfterDiscount: tongTien,
    cod: tongTien,
    insertedAt: NGAY,
  });
  const [ship] = await db
    .insert(schema.shipments)
    .values({
      orderId: id,
      vtpOrderNumber: code,
      trackingCode: code,
      stage: (ketCuc === "DELIVERED" ? "DELIVERED" : "RETURNED") as never,
      codAmount: tongTien,
      codCollected: ketCuc === "DELIVERED" ? tongTien : 0,
      vtpStatusDate: NGAY,
      pickedUpAt: NGAY,
    })
    .returning({ id: schema.shipments.id });
  await db.insert(schema.shipmentEvents).values({
    shipmentId: ship.id,
    source: "VTP_WEBHOOK",
    status: ketCuc === "DELIVERED" ? "501" : "504",
    statusName: ketCuc === "DELIVERED" ? "Phát thành công" : "Chuyển hoàn",
    occurredAt: NGAY,
    normalizedStage: (ketCuc === "DELIVERED" ? "DELIVERED" : "RETURNED") as never,
    legType: "OUTBOUND",
  });
  return id;
}

export async function testOrderValueFilter(db: Db) {
  // ───────────────────── 1. ĐỌC THAM SỐ TỪ URL ─────────────────────
  assert.deepEqual(parseOrderValue({ vmax: "300000" }), { min: null, max: 300_000 }, "vmax số trơn");
  assert.deepEqual(parseOrderValue({ vmax: "300.000" }), { min: null, max: 300_000 }, "người dùng gõ dấu chấm ngăn nghìn");
  assert.deepEqual(parseOrderValue({ vmax: "300,000" }), { min: null, max: 300_000 }, "người dùng gõ dấu phẩy ngăn nghìn");
  assert.deepEqual(parseOrderValue({ vmin: "200000", vmax: "300000" }), { min: 200_000, max: 300_000 }, "khoảng hai đầu");
  assert.deepEqual(parseOrderValue({ vmin: "abc" }), NO_ORDER_VALUE_FILTER, "chữ không phải số tiền");
  assert.deepEqual(parseOrderValue({ vmin: "-500" }), NO_ORDER_VALUE_FILTER, "số âm không phải giá trị đơn");
  assert.deepEqual(parseOrderValue({ vmin: "0" }), NO_ORDER_VALUE_FILTER, "0 không phải một cận");
  // Khoảng ngược bị bỏ NGUYÊN CẢ CẶP, không tự hoán vị: hoán vị hộ là đoán ý người gõ và người đọc
  // sẽ tin mình đang xem một khoảng mình không hề chọn.
  assert.deepEqual(parseOrderValue({ vmin: "300000", vmax: "200000" }), NO_ORDER_VALUE_FILTER, "min > max ⇒ bỏ cả cặp");
  assert.deepEqual(parseOrderValue({ vmin: "300000", vmax: "300000" }), NO_ORDER_VALUE_FILTER, "khoảng rỗng ⇒ bỏ cả cặp");
  assert.equal(orderValueActive(parseOrderValue({})), false, "không tham số ⇒ không lọc");

  // Công tắc CPQC: MẶC ĐỊNH BẬT. Mọi báo cáo cũ không mang `ads` trong URL phải giữ nguyên số.
  assert.equal(parseAdsIncluded({}), true, "mặc định có tính CPQC");
  assert.equal(parseAdsIncluded({ ads: "0" }), false, "ads=0 ⇒ không tính CPQC");
  assert.equal(parseAdsIncluded({ ads: "1" }), true, "ads=1 ⇒ có tính CPQC");

  // ───────────────────── 2. MỐC BIÊN: CẬN TRÊN LÀ HỞ ─────────────────────
  const duoi300: OrderValueFilter = { min: null, max: 300_000 };
  assert.equal(orderValueMatches(duoi300, 299_999), true, "299.999 nằm trong “dưới 300K”");
  assert.equal(orderValueMatches(duoi300, 300_000), false, "ĐÚNG 300.000 KHÔNG nằm trong “dưới 300K”");
  const bac: OrderValueFilter = { min: 200_000, max: 300_000 };
  assert.equal(orderValueMatches(bac, 199_999), false, "dưới cận dưới");
  assert.equal(orderValueMatches(bac, 200_000), true, "cận dưới là ĐÓNG");
  assert.equal(orderValueMatches(bac, 300_000), false, "cận trên là HỞ");
  // 0đ = CHƯA BIẾT: ngoài mọi khoảng khi đang lọc, nhưng không lọc thì không loại ai (mục 42).
  assert.equal(orderValueMatches(duoi300, 0), false, "đơn 0đ KHÔNG được coi là “đơn dưới 300K”");
  assert.equal(orderValueMatches(NO_ORDER_VALUE_FILTER, 0), true, "không lọc thì không loại đơn nào");

  // ───────────────────── 3. HAI BẢN LUẬT (SQL ↔ TypeScript) ─────────────────────
  /*
    Chạy CHÍNH mệnh đề SQL của đường ghi trên một danh sách giá trị, rồi so với bản TypeScript.
    Không viết lại điều kiện bằng SQL thứ hai ở đây — làm vậy là kiểm một bản sao, không kiểm thứ
    đang chạy thật.
  */
  const mocBien = [0, 1, 199_999, 200_000, 200_001, 299_999, 300_000, 300_001, 499_999, 500_000, 999_999, 1_000_000, 5_000_000];
  const boLoc: OrderValueFilter[] = [
    { min: null, max: 300_000 },
    { min: 200_000, max: 300_000 },
    { min: 500_000, max: null },
    { min: 1_000_000, max: null },
    ...ORDER_VALUE_TIERS.map((t) => ({ min: t.min, max: t.max })),
  ];
  for (const f of boLoc) {
    const menhDe = orderValueWhereSql(f);
    assert.ok(menhDe, `bộ lọc ${orderValueKey(f)} phải sinh ra mệnh đề SQL`);
    const danhSach = mocBien.map((v) => `(${v})`).join(",");
    const res = await db.execute(sql.raw(`select "orders"."total_price_after_discount" as v, (${menhDe}) as ok from (values ${danhSach}) as orders(total_price_after_discount)`));
    const rows = rowsOf<{ v: number; ok: boolean }>(res);
    assert.equal(rows.length, mocBien.length, "SQL phải trả đúng số dòng đã đưa vào");
    for (const r of rows) {
      const v = Number(r.v);
      assert.equal(
        Boolean(r.ok),
        orderValueMatches(f, v),
        `SQL và TypeScript nói khác nhau về đơn ${v}đ với bộ lọc ${orderValueKey(f)} — hai bản luật đã trôi xa nhau`,
      );
    }
  }
  // Không lọc gì thì KHÔNG sinh mệnh đề: một mệnh đề "true" thừa ở mọi truy vấn là thứ che mất chỗ
  // quên nối bộ lọc.
  assert.equal(orderValueWhereSql(NO_ORDER_VALUE_FILTER), null, "không lọc ⇒ không có mệnh đề");

  // ───────────────────── 4. CÁC BẬC PHỦ KÍN VÀ KHÔNG CHỒNG NHAU ─────────────────────
  assert.equal(ORDER_VALUE_TIERS[0].min, null, "bậc đầu không chặn dưới");
  assert.equal(ORDER_VALUE_TIERS[ORDER_VALUE_TIERS.length - 1].max, null, "bậc cuối không chặn trên");
  for (let i = 1; i < ORDER_VALUE_TIERS.length; i++) {
    assert.equal(ORDER_VALUE_TIERS[i].min, ORDER_VALUE_TIERS[i - 1].max, `bậc ${ORDER_VALUE_TIERS[i].key} phải nối liền bậc trước — hở một khoảng là mất đơn, chồng nhau là đếm hai lần`);
  }
  for (const v of [1, 150_000, 250_000, 400_000, 750_000, 9_000_000]) {
    const thuoc = ORDER_VALUE_TIERS.filter((t) => orderValueMatches({ min: t.min, max: t.max }, v));
    assert.equal(thuoc.length, 1, `đơn ${v}đ phải thuộc ĐÚNG một bậc, đang thuộc ${thuoc.length}`);
  }
  // Mức tắt của bộ lọc được phép chồng nhau (mỗi lần chỉ chọn một) nhưng phải là khoảng hợp lệ.
  for (const m of ORDER_VALUE_PRESETS) {
    assert.ok(m.min !== null || m.max !== null, `mức "${m.label}" phải chặn ít nhất một đầu`);
    if (m.min !== null && m.max !== null) assert.ok(m.min < m.max, `mức "${m.label}" có khoảng ngược`);
  }
  assert.equal(orderValueLabel(NO_ORDER_VALUE_FILTER), "Mọi giá trị đơn");
  assert.ok(orderValueLabel(duoi300).includes("300K"), "nhãn phải nói ra con số đang lọc");
  assert.notEqual(orderValueKey({ min: null, max: 300_000 }), orderValueKey({ min: 300_000, max: null }), "hai khoảng khác nhau phải ra hai khoá cache khác nhau");

  // ───────────────────── 5. TRÊN CSDL: BẢNG THEO BẬC GIÁ ─────────────────────
  /*
    Gieo đủ `MIN_TIER_SAMPLE` đơn kết thúc cho một bậc để bậc ấy KẾT LUẬN ĐƯỢC, và cố ý để một bậc
    khác chỉ có vài đơn — nó phải trả `null`, không phải một tỷ lệ trông như đo được.
  */
  const soGiaoTC = MIN_TIER_SAMPLE; // bậc "dưới 200K": toàn giao thành công
  for (let k = 0; k < soGiaoTC; k++) await donCoKetCuc(db, 150_000, "DELIVERED");
  for (let k = 0; k < MIN_TIER_SAMPLE; k++) await donCoKetCuc(db, 350_000, k < 2 ? "DELIVERED" : "RETURNED"); // bậc 300–500K: phần lớn hoàn
  await donCoKetCuc(db, 2_000_000, "DELIVERED"); // bậc ≥ 1tr: chỉ 1 đơn ⇒ chưa kết luận được
  const donKhongGia = await donCoKetCuc(db, 0, "DELIVERED"); // không khai được giá trị

  const bang = await getReturnRateByTier(KY, "", "ORDERED");
  const cua = (key: string) => bang.rows.find((r) => r.key === key)!;

  assert.equal(cua("lt200").orders, soGiaoTC, "bậc dưới 200K đếm đúng số đơn đã gieo");
  assert.equal(cua("lt200").successRate, 100, "bậc dưới 200K toàn giao thành công");
  assert.equal(cua("200-300").orders, 0, "không gieo đơn nào vào bậc 200–300K");
  assert.equal(cua("300-500").orders, MIN_TIER_SAMPLE, "bậc 300–500K đếm đúng");
  assert.equal(cua("300-500").returned, MIN_TIER_SAMPLE - 2, "bậc 300–500K đếm đúng số đơn hoàn");
  assert.ok((cua("300-500").successRate ?? 0) < 50, "bậc 300–500K phải tệ hơn hẳn bậc dưới 200K");
  // MẪU MỎNG ⇒ "—", KHÔNG phải một con số. Đây là vế mục 39: chưa đủ dữ liệu khác hẳn làm kém.
  assert.equal(cua("gte1m").orders, 1, "bậc ≥ 1tr chỉ có một đơn");
  assert.equal(cua("gte1m").successRate, null, `bậc mới ${1} đơn kết thúc (< ${MIN_TIER_SAMPLE}) phải trả null, không phải 100%`);
  assert.equal(cua("gte1m").returnRate, null, "cùng lý do với tỷ lệ GTC");
  // Đơn 0đ KHÔNG rơi vào bậc thấp nhất, và được đếm riêng để màn hình in ra.
  assert.ok(bang.unknownValueOrders >= 1, "đơn không khai giá trị phải được đếm riêng");
  assert.equal(
    bang.rows.reduce((t, r) => t + r.orders, 0),
    soGiaoTC + MIN_TIER_SAMPLE + 1,
    "tổng các bậc = số đơn CÓ giá trị, đơn 0đ đứng ngoài",
  );
  assert.ok(donKhongGia, "đơn 0đ vẫn nằm trong CSDL, chỉ là ngoài mọi bậc");

  // ───────────────────── 6. TRÊN CSDL: BỘ LỌC THU HẸP KHỐI TỔNG ─────────────────────
  const tatCa = await getReturnRateSummary(KY, "", "ORDERED", NO_ORDER_VALUE_FILTER);
  const chiDuoi200 = await getReturnRateSummary(KY, "", "ORDERED", { min: null, max: 200_000 });
  const chi300toi500 = await getReturnRateSummary(KY, "", "ORDERED", { min: 300_000, max: 500_000 });
  assert.equal(chiDuoi200.delivered, soGiaoTC, "lọc dưới 200K chỉ còn đơn của bậc đó");
  assert.equal(chiDuoi200.returned, 0, "bậc dưới 200K không có đơn hoàn nào trong dữ liệu gieo");
  assert.equal(chi300toi500.returned, MIN_TIER_SAMPLE - 2, "lọc 300–500K giữ đúng số đơn hoàn của bậc");
  assert.ok(tatCa.delivered >= chiDuoi200.delivered + chi300toi500.delivered, "tập lọc phải là TẬP CON của tập không lọc");
  assert.notEqual(chiDuoi200.successRate, chi300toi500.successRate, "hai bậc giá phải cho hai tỷ lệ khác nhau — nếu bằng nhau thì bộ lọc chưa được nối vào truy vấn");
}
