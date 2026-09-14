import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { schema, type Db } from "@/db";
import { AGE_BUCKETS, ageBucketOf, MIN_CELL_SAMPLE, PROBABILITY_FALLBACK, TRAINING_SNAPSHOT_OFFSETS_HOURS } from "@/lib/constants/projected-delivery";
import { MARKETER_UNRESOLVED, MARKETER_UNRESOLVED_LABEL, MARKETER_LINK_FIX, MARKETER_LINK_STATES } from "@/lib/constants/marketer-attribution";
import { ACTION_LIST_MAX, ALERT_MIN_SAMPLE, PROBLEM_CLASSES, PROBLEM_DEPARTMENT, PROBLEM_OF_REASON, PRODUCT_RISK_METRIC, RISK_LEVELS } from "@/lib/constants/return-intelligence";
import { RETURN_REASONS, RETURN_REASON_GROUP_OF } from "@/lib/constants/return-reason";
import { TARGETABLE_METRICS } from "@/lib/constants/metric-registry";
import { getReturnReasonReport, listReasonShipments } from "@/lib/queries/return-reason-report";
import { getReturnIntelligence } from "@/lib/queries/return-intelligence";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ HỢP ĐỒNG CỦA TẦNG QUYẾT ĐỊNH BÁO CÁO HOÀN ═══════════
 *
 * Bài này KHÔNG lặp lại những gì đã có bài khác khoá:
 *
 *   · "Đã gửi" · `AWAITING_PICKUP` · lấy hụt · shop huỷ lấy · vận đơn 1P1 · nhiều lần gửi
 *       → `tests/contract-order-outcome.test.ts` + `tests/multi-attempt-money.test.ts`
 *   · mốc lọc theo ngày ĐVVC nhận / ngày tạo đơn / ngày kết quả
 *       → `tests/kpi-clarity.test.ts`
 *   · công thức GTC ước tính · thử ngược · parity với trang lợi nhuận
 *       → `tests/projected-delivery.test.ts` + `tests/reporting-parity.test.ts`
 *
 * Chỗ này khoá những thứ CHỈ bản 14/09/2026 mới có, và mỗi mục là một cách hỏng đã nghĩ ra được:
 *
 *   1. bậc điều kiện hoá (mã hàng · trạng thái · tuổi kiện) và cổng cỡ mẫu;
 *   2. quy kết marketer đi bằng KHOÁ, và bật chiều marketer KHÔNG làm đổi tổng;
 *   3. hai mẫu số của bảng lý do (trên hoàn ≠ trên đã gửi) không được trộn;
 *   4. drilldown đếm ra đúng con số bảng in;
 *   5. nhãn rủi ro đọc ĐÍCH, không đọc một hằng số trong mã;
 *   6. lớp vấn đề phủ kín taxonomy và luôn trỏ tới PHÒNG BAN;
 *   7. khối "Cần chú ý" chỉ nói khi đủ mẫu, và không gán việc cho một cá nhân.
 */

const KY = (from: string, to: string): Period => ({ key: "custom", label: "thử", from: new Date(from), to: new Date(to), fromKey: from, toKey: to });

/* ═══════════════════ 1 · BẬC ĐIỀU KIỆN HOÁ ═══════════════════ */

export function testConditioningHierarchy() {
  /*
    THỨ TỰ BẬC LÀ HỢP ĐỒNG, KHÔNG PHẢI MỘT CHI TIẾT TRIỂN KHAI.

    Đảo hai bậc đầu (lấy toàn shop trước mã hàng) vẫn cho ra một con số hợp lý, và sẽ không có gì
    đỏ lên — chỉ là mã Q002 nhận xác suất của mã Q004.
  */
  assert.deepEqual(
    [...PROBABILITY_FALLBACK],
    ["PRODUCT_STATE_AGE", "PRODUCT_STATE", "GLOBAL_STATE_AGE", "GLOBAL_STATE", "NONE"],
    "bậc lùi phải đi từ HẸP tới RỘNG rồi mới tới 'chưa đo được' — không có bậc nào trả về một con số mặc định",
  );
  assert.equal(PROBABILITY_FALLBACK[PROBABILITY_FALLBACK.length - 1], "NONE", "bậc cuối phải là THỪA NHẬN KHÔNG BIẾT, không phải một giá trị đoán");

  // Rổ tuổi phải PHỦ KÍN và KHÔNG CHỒNG: một tuổi bất kỳ rơi vào đúng một rổ.
  for (const gio of [0, 1, 23.9, 24, 47.9, 48, 71.9, 72, 500, 100_000]) {
    const ro = AGE_BUCKETS.filter((b) => gio >= b.fromHours && gio < b.toHours);
    assert.equal(ro.length, 1, `tuổi ${gio}h rơi vào ${ro.length} rổ — phải đúng 1`);
    assert.equal(ageBucketOf(gio), ro[0].key, `ageBucketOf(${gio}) không khớp bảng rổ`);
  }
  // Tuổi âm (mốc bàn giao muộn hơn mốc quan sát — lệch đồng hồ) KHÔNG được rơi ra ngoài.
  assert.equal(ageBucketOf(-5), AGE_BUCKETS[0].key, "tuổi âm phải rơi vào rổ đầu, không được tạo ra một rổ thứ năm vô hình");

  // Mỗi rổ phải có ít nhất một mốc chụp ảnh, nếu không rổ đó không bao giờ học được gì.
  for (const b of AGE_BUCKETS) {
    const coMoc = TRAINING_SNAPSHOT_OFFSETS_HOURS.some((h) => h >= b.fromHours && h < b.toHours);
    assert.ok(coMoc, `rổ ${b.key} không có mốc chụp ảnh nào — nó sẽ vĩnh viễn rỗng và mọi kiện trong rổ rơi xuống bậc rộng hơn`);
  }
  assert.ok(MIN_CELL_SAMPLE >= 10, "cổng cỡ mẫu dưới 10 thì một kiện đổi kết cục làm tỷ lệ nhảy hơn 10 điểm — đó không phải xác suất");
  console.log(`✓ Bậc điều kiện hoá: ${PROBABILITY_FALLBACK.length} bậc hẹp→rộng→thừa nhận không biết · ${AGE_BUCKETS.length} rổ tuổi phủ kín không chồng · mỗi rổ có mốc học · cổng ${MIN_CELL_SAMPLE} quan sát`);
}

/* ═══════════════════ 2 · MỘT KIỆN KHÔNG ĐƯỢC ĐẾM HAI LẦN ═══════════════════ */

export function testNoDoubleCountAcrossEvents() {
  /*
    Webhook Viettel Post thử lại tới 5 lần, và ERP còn nhận cùng trạng thái qua tra API lẫn tệp
    nhập. Nếu mô hình đếm theo SỰ KIỆN thì số lần thử lại quyết định xác suất.

    Bài này đọc MÃ NGUỒN thay vì dựng dữ liệu: điều cần khoá là hàm huấn luyện phải giữ một tập
    khoá "đã đếm" cho mỗi ô. Một lượt viết lại bỏ mất `Set` đó sẽ không làm bài kiểm dữ liệu nào
    đỏ — con số chỉ lệch đi một chút, và không ai biết.
  */
  const src = readFileSync("lib/queries/projected-delivery.ts", "utf8");
  assert.ok(src.includes("const daDem = new Map<string, Set<string>>()"), "hàm học xác suất phải giữ tập khoá kiện ĐÃ ĐẾM cho từng ô");
  assert.ok(/if \(set\.has\(kienId\)\) return;/.test(src), "mỗi ô phải BỎ QUA kiện đã đếm — một kiện × một ô = một quan sát");
  assert.ok(!/count\(\*\)[^)]*shipment_events/.test(src), "không được đếm quan sát bằng số SỰ KIỆN");
  console.log("✓ Không đếm trùng: một vận đơn góp đúng một quan sát cho mỗi ô điều kiện hoá, dù bao nhiêu sự kiện hay bao nhiêu mốc rơi vào cùng ô");
}

/* ═══════════════════ 3 · QUY KẾT MARKETER ═══════════════════ */

export function testMarketerAttributionGoesByKey() {
  const src = readFileSync("lib/queries/order-marketer.ts", "utf8");
  /*
    KHÔNG DÒ CHỮ. `Employee.aliases` tồn tại sẵn trong kho mã (những mẩu như "QA4", "QUAN TA") và
    cám dỗ là `campaign ilike '%QA4%'`. Quy kết sai ở đây ghi tỷ lệ hoàn của người này lên thẻ điểm
    người kia — và `lib/queries/product-code.ts` đã ghi lại bằng số đo vì sao khớp chuỗi không có
    ngưỡng nào đúng.
  */
  assert.ok(!/ilike/i.test(src), "quy kết marketer KHÔNG được dùng `ilike` — đi bằng khoá chiến dịch, không dò chữ");
  assert.ok(!/aliases/.test(src), "quy kết marketer KHÔNG được đọc `Employee.aliases`");
  assert.ok(src.includes("having count(distinct a.marketer_id) = 1"), "chiến dịch phải có ĐÚNG MỘT người phụ trách mới được quy kết — nhiều người là nhập nhằng");
  assert.ok(src.includes("having count(distinct fa.campaign_id) = 1") || src.includes("POST_TO_CAMPAIGN"), "nối qua bài viết chỉ khi bài thuộc đúng một chiến dịch");

  // Bốn tình trạng, và ba trong số đó đều hiện ra dưới nhãn "Chưa xác định" nhưng đếm RIÊNG.
  assert.equal(MARKETER_LINK_STATES.length, 4, "bốn tình trạng quy kết");
  for (const s of MARKETER_LINK_STATES) {
    if (s === "RESOLVED") continue;
    assert.ok(MARKETER_LINK_FIX[s].length > 20, `${s}: phải khai VIỆC PHẢI LÀM để lấp chỗ trống, không chỉ in một con số`);
  }
  assert.equal(MARKETER_UNRESOLVED_LABEL, "Chưa xác định", "nhóm không quy kết được phải mang đúng cái tên đó — không phải 'Khác', không phải rỗng");
  console.log("✓ Quy kết marketer: đi bằng KHOÁ chiến dịch (0 phép dò chữ) · chiến dịch nhiều người = nhập nhằng · 4 tình trạng, 3 loại chỗ trống đều có việc phải làm");
}

/* ═══════════════════ 4 · LỚP VẤN ĐỀ PHỦ KÍN VÀ TRỎ TỚI PHÒNG BAN ═══════════════════ */

export function testProblemClassification() {
  for (const r of RETURN_REASONS) {
    const lop = PROBLEM_OF_REASON[r];
    assert.ok(lop, `${r}: chưa khai lớp vấn đề — một lý do không có lớp là một lý do không ai nhận`);
    assert.ok(PROBLEM_CLASSES.includes(lop), `${r}: lớp "${lop}" không có thật`);
    assert.ok(PROBLEM_DEPARTMENT[lop], `${lop}: chưa khai phòng ban sở hữu`);
  }
  /*
    "CHƯA XÁC ĐỊNH" KHÔNG PHẢI MỘT NGUYÊN NHÂN. Xếp nó vào bất kỳ lớp nào khác `DATA_GAP` là biến
    một khoảng trống dữ liệu thành một kết luận về sản phẩm hoặc về khách.
  */
  assert.equal(PROBLEM_OF_REASON.UNKNOWN, "DATA_GAP", "lý do CHƯA XÁC ĐỊNH phải thuộc lớp THIẾU DỮ LIỆU");
  assert.equal(PROBLEM_OF_REASON.OTHER, "DATA_GAP", "lý do KHÁC cũng chưa giao được cho phòng nào sửa");

  // Nhóm lý do và lớp vấn đề là HAI câu hỏi khác nhau — nhóm `OTHER` phải tách ra ít nhất hai lớp,
  // nếu không thì lớp vấn đề chỉ là một tên gọi khác của nhóm và không thêm được gì.
  const lopCuaNhomOther = new Set(RETURN_REASONS.filter((r) => RETURN_REASON_GROUP_OF[r] === "OTHER").map((r) => PROBLEM_OF_REASON[r]));
  assert.ok(lopCuaNhomOther.size >= 2, "nhóm 'Lý do khác' phải tách ra nhiều lớp vấn đề — kho đóng nhầm và sale chốt sai đi tới hai phòng khác nhau");
  console.log(`✓ Lớp vấn đề: ${RETURN_REASONS.length}/${RETURN_REASONS.length} lý do có lớp · mọi lớp có PHÒNG BAN sở hữu · 'chưa xác định' KHÔNG bị xếp thành một nguyên nhân · nhóm 'khác' tách ${lopCuaNhomOther.size} lớp`);
}

/* ═══════════════════ 5 · NHÃN RỦI RO ĐỌC ĐÍCH, KHÔNG ĐỌC HẰNG SỐ ═══════════════════ */

export function testRiskBadgeReadsTargets() {
  const src = readFileSync("lib/queries/return-intelligence.ts", "utf8");
  /*
    AGENTS.md mục 38: không hard-code ngưỡng đạt/không đạt ở bất kỳ đâu, kể cả trong màu của một ô.
    Hàm chấm rủi ro phải đi qua `resolveTarget` + `verdict` của hợp đồng đích.
  */
  assert.ok(src.includes("resolveTarget("), "chấm rủi ro phải ĐỌC ĐÍCH từ metric_targets");
  assert.ok(src.includes("targetVerdict(") || src.includes("verdict("), "phải dùng lại phép so của hợp đồng đích, không viết lại");
  assert.ok(!/SUCCESS_RATE_GOOD|SUCCESS_RATE_OK/.test(src), "tầng quyết định KHÔNG được dùng ngưỡng màu của bảng làm ngưỡng kết luận");
  assert.ok(/return \{ risk: "NO_TARGET"/.test(src), "chưa đặt đích ⇒ NO_TARGET, hiện thực tế và KHÔNG kết luận");
  assert.ok(/return \{ risk: "INSUFFICIENT"/.test(src), "chưa đủ mẫu ⇒ INSUFFICIENT — tách hẳn khỏi 'rủi ro cao'");

  // `NO_TARGET` và `INSUFFICIENT` phải tồn tại như hai mức RIÊNG: gộp chúng vào "tốt" hay "xấu" là
  // biến "chưa biết" thành một lời khen hoặc một lời chê.
  for (const m of ["GOOD", "WATCH", "HIGH_RISK", "NO_TARGET", "INSUFFICIENT"]) assert.ok(RISK_LEVELS.includes(m as never), `thiếu mức rủi ro ${m}`);

  // Khoá chỉ số dùng để chấm phải CÓ THẬT trong sổ gộp, nếu không đích sẽ không bao giờ khớp.
  assert.ok(TARGETABLE_METRICS[PRODUCT_RISK_METRIC], `khoá chỉ số "${PRODUCT_RISK_METRIC}" không có trong sổ gộp — đích đặt ra sẽ không bao giờ được đọc`);
  console.log("✓ Nhãn rủi ro: đọc ĐÍCH từ metric_targets (0 ngưỡng ghi cứng) · chưa đặt đích và chưa đủ mẫu là HAI mức riêng, không phải 'xấu'");
}

/* ═══════════════════ 6 · KHỐI "CẦN CHÚ Ý" ═══════════════════ */

export function testActionEngineGates() {
  const src = readFileSync("lib/queries/return-intelligence.ts", "utf8");
  assert.ok(src.includes("ALERT_MIN_SAMPLE.minFinished"), "cảnh báo theo mã hàng phải qua cổng cỡ mẫu");
  assert.ok(src.includes("m.comparable"), "cảnh báo theo marketer chỉ nêu tên khi đủ mẫu để so với mặt bằng");
  assert.ok(src.includes('if (m.marketerId === null) continue'), "nhóm 'Chưa xác định' KHÔNG được nhắc tên như một người làm kém");
  assert.ok(ALERT_MIN_SAMPLE.minFinished >= 20, "mã hàng cần ít nhất 20 đơn đã kết thúc mới được nêu — bằng đúng ngưỡng 'mẫu quá nhỏ' của bảng");
  assert.ok(ALERT_MIN_SAMPLE.minMarketerFinished >= ALERT_MIN_SAMPLE.minFinished, "so người với người cần mẫu lớn hơn so mã với đích");

  const ui = readFileSync("app/(dashboard)/reports/returns/action-board.tsx", "utf8");
  /*
    AGENTS.md mục 22 và 25: việc chỉ được giao cho PHÒNG BAN. Máy không biết hôm nay ai nghỉ, và
    một việc mang tên người không làm được nó sẽ biến mất khỏi hàng đợi phòng.
  */
  assert.ok(/assigneeId:\s*null/.test(ui), "nút tạo việc KHÔNG được gán người — phòng ban nhận rồi trưởng phòng giao");
  assert.ok(ui.includes("department: a.department"), "việc phải mang phòng ban của lớp vấn đề");
  assert.ok(ui.includes("a.key"), "tiêu đề việc phải mang khoá ổn định của cảnh báo để hai việc trùng nhìn ra ngay");
  assert.ok(ACTION_LIST_MAX <= 10, "danh sách dài hơn 10 việc thì không ai xử lý hết — và biết vậy");
  console.log(`✓ Khối "Cần chú ý": chỉ nói khi đủ mẫu (${ALERT_MIN_SAMPLE.minFinished} đơn / ${ALERT_MIN_SAMPLE.minMarketerFinished} đơn) · không nêu tên nhóm chưa xác định · tạo việc cho PHÒNG BAN, không gán cá nhân · tối đa ${ACTION_LIST_MAX} dòng`);
}

/* ═══════════════════ 7 · HAI MẪU SỐ, BỐN BỘ LỌC, MỘT DRILLDOWN ═══════════════════ */

const P = "ri-";

async function dungDuLieu(db: Db) {
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm RI", customId: "RIQ1", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.products).values({ id: `${P}p2`, name: "Áo RI", customId: "RIQ2", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "RIQ1-S", detail: "S" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v2`, productId: `${P}p2`, sku: "RIQ2-M", detail: "M" }).onConflictDoNothing();

  /*
    Bốn đơn, đủ để hỏi mọi câu: một giao được, hai hoàn (một có lý do đọc được, một không), một
    ĐANG CHẠY. Đơn đang chạy có mặt ở mẫu số "đã gửi" nhưng KHÔNG ở mẫu số "đã kết thúc" — đó
    chính là chỗ hai tỷ lệ phải khác nhau.
  */
  const don = [
    { id: `${P}o1`, v: `${P}v1`, sku: "RIQ1-S", name: "Đầm RI", cod: 500_000, stage: "DELIVERED" as const, status: "Giao thành công", code: 501 },
    { id: `${P}o2`, v: `${P}v1`, sku: "RIQ1-S", name: "Đầm RI", cod: 0, stage: "RETURNED" as const, status: "Tồn - Khách hàng nghỉ, không có nhà", code: 506 },
    { id: `${P}o3`, v: `${P}v1`, sku: "RIQ1-S", name: "Đầm RI", cod: 0, stage: "RETURNED" as const, status: "Đã trả", code: null },
    { id: `${P}o4`, v: `${P}v2`, sku: "RIQ2-M", name: "Áo RI", cod: 0, stage: "IN_TRANSIT" as const, status: "Đơn hàng chờ xử lý", code: 102 },
  ];
  for (const [i, d] of don.entries()) {
    await db
      .insert(schema.orders)
      .values({ id: d.id, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-08-10T03:00:00Z"), totalPriceAfterDiscount: 500_000, billFullName: `Khách RI ${i + 1}`, billPhone: `090000000${i}` })
      .onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i${i}`, orderId: d.id, variantId: d.v, sku: d.sku, productName: d.name, quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
    await db
      .insert(schema.shipments)
      .values({
        id: `${P}s${i}`,
        orderId: d.id,
        vtpOrderNumber: `${P}T${i}`,
        trackingCode: `${P}T${i}`,
        stage: d.stage,
        vtpStatus: d.code,
        vtpStatusName: d.status,
        vtpStatusDate: new Date("2026-08-24T03:00:00Z"),
        codCollected: d.cod,
        pickedUpAt: new Date("2026-08-20T03:00:00Z"),
        deliveredAt: d.stage === "DELIVERED" ? new Date("2026-08-24T03:00:00Z") : null,
        returnedAt: d.stage === "RETURNED" ? new Date("2026-08-24T03:00:00Z") : null,
        createdAt: new Date("2026-08-10T04:00:00Z"),
        isFinal: d.stage !== "IN_TRANSIT",
      })
      .onConflictDoNothing();
    // Một sự kiện chứng minh ĐVVC đã cầm hàng — nếu không, kiện nằm NGOÀI cohort theo ngày gửi.
    await db
      .insert(schema.shipmentEvents)
      .values({
        id: `${P}e${i}`,
        shipmentId: `${P}s${i}`,
        source: "VTP_WEBHOOK",
        status: String(d.code ?? 300),
        statusName: d.status,
        normalizedStage: d.stage === "IN_TRANSIT" ? "IN_TRANSIT" : d.stage,
        occurredAt: new Date("2026-08-20T03:00:00Z"),
      })
      .onConflictDoNothing();
  }
}

async function donDep(db: Db) {
  for (let i = 0; i < 4; i += 1) {
    await db.delete(schema.shipmentEvents).where(eq(schema.shipmentEvents.id, `${P}e${i}`));
    await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s${i}`));
    await db.delete(schema.orderItems).where(eq(schema.orderItems.id, `${P}i${i}`));
    await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o${i + 1}`));
  }
  await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v1`));
  await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v2`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p2`));
}

export async function testReasonDenominatorsAndFilters(db: Db) {
  await dungDuLieu(db);
  const ky = KY("2026-08-18T00:00:00Z", "2026-08-28T23:59:59Z");

  /*
    LỌC THEO HAI MÃ CỦA CHÍNH BỘ DỮ LIỆU NÀY.

    Bộ kiểm thử dùng CHUNG một CSDL với mọi bài khác, nên "toàn shop" ở đây không phải một tập ổn
    định — thêm một fixture ở bài khác là bài này đỏ mà không có gì sai. Mọi khẳng định về CON SỐ
    phải đứng trên đúng tập mà bài này dựng ra.
  */
  const CUA_TA = ["RIQ1", "RIQ2"];
  const tatCa = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: CUA_TA });

  /*
    ─── HAI MẪU SỐ, VÀ CHÚNG PHẢI KHÁC NHAU ───

    `finished` = đơn ĐÃ NGÃ NGŨ. `eligibleSent` = cả lô hàng đã bàn giao ĐVVC, tức có thêm đơn đang
    chạy. Bộ dữ liệu này cố ý có ĐÚNG một đơn đang chạy, nên hai con số phải lệch đúng 1 — nếu
    chúng bằng nhau thì một trong hai đang đọc sai tập.
  */
  assert.ok(tatCa.eligibleSent >= tatCa.finished, "đã gửi không thể nhỏ hơn đã kết thúc");
  assert.equal(tatCa.eligibleSent - tatCa.finished, tatCa.active, "phần chênh giữa hai mẫu số phải đúng bằng số đơn đang chạy");
  assert.equal(tatCa.active, 1, "bộ dữ liệu này có ĐÚNG một đơn đang chạy — nếu bằng 0 thì hai mẫu số đang đọc cùng một tập");

  const riq1 = tatCa.products.find((p) => p.code === "RIQ1");
  assert.ok(riq1, "phải thấy mã RIQ1");
  assert.equal(riq1.finished, 3, "RIQ1 có 3 đơn đã ngã ngũ (1 giao · 2 hoàn)");
  assert.equal(riq1.delivered, 1);
  assert.equal(riq1.returned, 2);

  /*
    ─── TỶ TRỌNG TRÊN HOÀN ≠ TỶ LỆ TRÊN ĐÃ GỬI ───

    Cùng một lý do, hai mẫu số, hai con số. Trộn chúng là phóng đại quy mô của lý do.
  */
  const nhomCoCa = tatCa.groups.filter((g) => g.count > 0);
  const tongTyTrong = nhomCoCa.reduce((n, g) => n + g.share, 0);
  if (tatCa.reasonCoverage.known > 0) {
    assert.ok(Math.abs(tongTyTrong - 100) < 0.5, `tỷ trọng của các nhóm phải cộng lại đúng 100% trên ca ĐÃ BIẾT lý do, đang là ${tongTyTrong.toFixed(1)}%`);
  }
  for (const g of nhomCoCa) {
    assert.ok(g.incidence !== null, "có ca thì phải tính được tỷ lệ trên đã gửi");
    assert.ok(g.incidence <= g.share + 0.001, `nhóm ${g.group}: tỷ lệ trên ĐÃ GỬI phải ≤ tỷ trọng trên HOÀN (mẫu số lớn hơn) — đang là ${g.incidence} vs ${g.share}`);
  }

  /* ─── BỘ LỌC MÃ HÀNG ─── */
  const chiRiq1 = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: ["RIQ1"] });
  assert.equal(chiRiq1.products.length, 1, "lọc theo RIQ1 chỉ còn một mã");
  assert.equal(chiRiq1.products[0].code, "RIQ1");
  assert.equal(chiRiq1.finished, 3, "lọc mã không được làm đổi số ca của chính mã đó");

  const chiRiq2 = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: ["RIQ2"] });
  assert.equal(chiRiq2.finished, 0, "RIQ2 chỉ có một đơn ĐANG CHẠY — chưa ca nào ngã ngũ");
  assert.equal(chiRiq2.eligibleSent, 1, "…nhưng nó VẪN nằm trong lô hàng đã gửi");

  /* ─── BỘ LỌC MARKETER: nhóm "Chưa xác định" là một lựa chọn hợp lệ ─── */
  const chuaXacDinh = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: CUA_TA, marketerIds: [MARKETER_UNRESOLVED] });
  assert.equal(chuaXacDinh.finished, tatCa.finished, "bộ dữ liệu này không đơn nào nối được chiến dịch, nên lọc 'Chưa xác định' phải ra đúng tập đầy đủ");

  const nguoiKhongCo = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: CUA_TA, marketerIds: ["ri-khong-ton-tai"] });
  assert.equal(nguoiKhongCo.finished, 0, "lọc theo một marketer không có đơn nào phải ra RỖNG, không rơi về 'không lọc gì'");

  /* ─── BẬT CHIỀU MARKETER KHÔNG LÀM ĐỔI TỔNG ─── */
  const tongTheoNguoi = tatCa.marketers.reduce((n, m) => n + m.finished, 0);
  assert.equal(tongTheoNguoi, tatCa.finished, "cộng mọi dòng marketer (kể cả 'Chưa xác định') phải bằng đúng tổng khi không chia");
  assert.ok(
    tatCa.marketers.some((m) => m.marketerId === null),
    "nhóm 'Chưa xác định' phải LUÔN có mặt khi có ca chưa quy kết được — bỏ nó đi là làm tổng hụt trong im lặng",
  );

  /* ─── LỌC KẾT HỢP: mã hàng + marketer ─── */
  const ketHop = await getReturnReasonReport({ period: ky, basis: "SHIPPED", codes: ["RIQ1"], marketerIds: [MARKETER_UNRESOLVED] });
  assert.equal(ketHop.finished, 3, "lọc kết hợp phải là GIAO của hai bộ lọc, không phải hợp");

  /* ─── DRILLDOWN ĐẾM RA ĐÚNG CON SỐ BẢNG IN ─── */
  const moiCaHoan = await listReasonShipments({ period: ky, basis: "SHIPPED", codes: CUA_TA });
  assert.equal(moiCaHoan.length, tatCa.returned, "drilldown không lọc lý do phải ra đúng số đơn hoàn của bảng");
  for (const g of tatCa.groups) {
    for (const d of g.details) {
      if (!d.count) continue;
      const list = await listReasonShipments({ period: ky, basis: "SHIPPED", codes: CUA_TA, reason: d.reason });
      assert.equal(list.length, d.count, `drilldown lý do "${d.label}" ra ${list.length} dòng nhưng bảng in ${d.count} — hai con số cho cùng một câu hỏi`);
      for (const r of list) assert.equal(r.reason, d.reason, "mọi dòng drilldown phải mang đúng lý do đã bấm");
    }
  }

  /* ─── DRILLDOWN GIỮ NGUYÊN BỘ LỌC ─── */
  const drillRiq2 = await listReasonShipments({ period: ky, basis: "SHIPPED", codes: ["RIQ2"] });
  assert.equal(drillRiq2.length, 0, "RIQ2 chưa có ca hoàn nào — drilldown phải tôn trọng bộ lọc mã hàng");

  /* ─── KỲ TUỲ CHỌN: ngoài kỳ thì không thấy gì ─── */
  const ngoaiKy = await getReturnReasonReport({ period: KY("2026-09-01T00:00:00Z", "2026-09-05T23:59:59Z"), basis: "SHIPPED", codes: CUA_TA });
  assert.equal(ngoaiKy.eligibleSent, 0, "cửa sổ không chứa mốc bàn giao nào thì tập phải rỗng");

  await donDep(db);
  console.log(
    `✓ Lý do hoàn: hai mẫu số tách bạch (đã gửi ${tatCa.eligibleSent} ≠ đã kết thúc ${tatCa.finished}) · tỷ trọng cộng 100% · lọc mã/marketer/kết hợp/kỳ đều đúng · bật chiều marketer KHÔNG đổi tổng · drilldown khớp từng lý do`,
  );
}

/* ═══════════════════ 8 · TẦNG QUYẾT ĐỊNH CHẠY THẬT ═══════════════════ */

export async function testIntelligenceRuns(db: Db) {
  await dungDuLieu(db);
  const ky = KY("2026-08-18T00:00:00Z", "2026-08-28T23:59:59Z");
  const intel = await getReturnIntelligence({
    period: ky,
    previous: { from: new Date("2026-08-07T00:00:00Z"), to: new Date("2026-08-17T23:59:59Z") },
    basis: "SHIPPED",
    codes: ["RIQ1", "RIQ2"],
  });

  /*
    CHƯA ĐẶT ĐÍCH ⇒ KHÔNG KẾT LUẬN. Bộ kiểm thử không có dòng nào trong `metric_targets`, nên mọi
    mã phải mang nhãn `NO_TARGET` hoặc `INSUFFICIENT` — tuyệt đối không được có mã nào bị gọi là
    "rủi ro cao" khi không có đích để so.
  */
  assert.equal(intel.hasTarget, false, "bộ kiểm thử không đặt đích nào");
  for (const p of intel.products) {
    assert.ok(["NO_TARGET", "INSUFFICIENT"].includes(p.risk), `${p.code}: chưa có đích mà đã kết luận "${p.risk}" — đó là kết luận không có căn cứ`);
    assert.ok(p.riskReason.length > 10, `${p.code}: phải nói VÌ SAO chưa kết luận được, không im lặng`);
  }

  // Độ phủ là số THẬT, và mẫu số rỗng ⇒ `null`, KHÔNG phải 0%.
  for (const [ten, c] of Object.entries(intel.coverage)) {
    if (c.total === 0) assert.equal(c.pct, null, `${ten}: mẫu số 0 phải ra null (chưa đo được), không phải 0%`);
    else assert.ok(c.pct !== null && c.pct >= 0 && c.pct <= 100, `${ten}: độ phủ ngoài dải 0–100`);
  }

  // Cảnh báo chỉ được xuất hiện khi đủ mẫu — bộ dữ liệu 4 đơn thì không mã nào đủ.
  for (const a of intel.actions) {
    if (a.key.startsWith("product:")) assert.fail(`cảnh báo theo mã "${a.key}" xuất hiện trên mẫu 3 đơn — cổng cỡ mẫu không chạy`);
    if (a.key.startsWith("marketer:")) assert.fail(`cảnh báo theo marketer "${a.key}" xuất hiện trên mẫu quá nhỏ`);
  }
  assert.ok(intel.actions.length <= ACTION_LIST_MAX, "danh sách việc phải bị chặn trần");

  // Chăm sóc: không có ca nào trong bộ kiểm thử ⇒ tỷ lệ cứu là `null`, không phải 0%.
  for (const s of intel.care.byState) {
    if (s.delivered + s.failed === 0) assert.equal(s.rescueRate, null, `${s.state}: chưa ca nào ngã ngũ ⇒ chưa có tỷ lệ cứu, KHÔNG phải 0%`);
  }

  await donDep(db);
  console.log(
    `✓ Tầng quyết định chạy thật: ${intel.products.length} mã · chưa đặt đích ⇒ 0 kết luận đạt/không đạt · độ phủ mẫu số rỗng ⇒ null · 0 cảnh báo trên mẫu nhỏ · ${intel.actions.length} việc, trần ${ACTION_LIST_MAX}`,
  );
}
