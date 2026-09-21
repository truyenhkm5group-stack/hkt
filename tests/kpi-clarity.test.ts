import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  RETURN_REASONS,
  RETURN_REASON_GROUPS,
  RETURN_REASON_GROUP_OF,
  RETURN_REASON_LABEL,
  REASON_NEEDS_HUMAN,
  VTP_REASON_TO_RETURN_REASON,
  RETURN_REASON_TEXT_RULES,
} from "@/lib/constants/return-reason";
import { rescueRate } from "@/lib/constants/return-rescue";
import { CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL, TIME_BASES, TIME_BASIS_LABEL } from "@/lib/constants/report-time-basis";
import { getReturnReasonReport } from "@/lib/queries/return-reason-report";
import { getReturnRateByVariant } from "@/lib/queries/return-rate";

/**
 * ═══════════ BÁO CÁO PHẢI NÓI RÕ NÓ ĐANG ĐO GÌ, THEO MỐC NÀO ═══════════
 *
 * Bài này khoá những chỗ mà nếu hỏng thì bảng VẪN RA SỐ — chỉ là số đó trả lời một câu hỏi khác
 * với câu người đọc đang hỏi. Đó là kiểu hỏng không ai phát hiện cho tới lúc ra quyết định sai.
 */

/* ───── 1 · Taxonomy đủ và mỗi lý do thuộc ĐÚNG một nhóm ───── */
export function testReasonTaxonomy() {
  for (const r of RETURN_REASONS) {
    assert.ok(RETURN_REASON_LABEL[r], `${r}: thiếu nhãn tiếng Việt`);
    assert.ok(RETURN_REASON_GROUP_OF[r], `${r}: chưa xếp vào nhóm nào`);
    assert.ok(RETURN_REASON_GROUPS.includes(RETURN_REASON_GROUP_OF[r]), `${r}: xếp vào nhóm không có thật`);
  }
  // Nhóm CHƯA XÁC ĐỊNH chỉ chứa đúng UNKNOWN — gộp nó vào "lý do khác" là biến một khoảng trống
  // dữ liệu thành một nhóm nguyên nhân đã hiểu rõ.
  const trongNhomUnknown = RETURN_REASONS.filter((r) => RETURN_REASON_GROUP_OF[r] === "UNKNOWN");
  assert.deepEqual(trongNhomUnknown, ["UNKNOWN"], "nhóm 'chưa xác định' chỉ được chứa UNKNOWN");

  // Taxonomy của shop phải có mặt đủ (đối chiếu bảng Excel chủ shop đang dùng).
  for (const nhan of ["Vải xấu", "Chật", "Không giống mẫu", "Giao hàng quá lâu", "Khách đi vắng", "Trùng đơn", "SALE tư vấn sai size"]) {
    assert.ok(Object.values(RETURN_REASON_LABEL).includes(nhan), `thiếu lý do "${nhan}" của bảng chủ shop`);
  }
  console.log(`✓ Taxonomy lý do hoàn: ${RETURN_REASONS.length} lý do · ${RETURN_REASON_GROUPS.length} nhóm · mỗi lý do đúng một nhóm · UNKNOWN đứng riêng`);
}

/* ───── 2 · MÁY KHÔNG ĐƯỢC SUY RA LÝ DO CHỈ NGƯỜI MỚI BIẾT ───── */
export function testMachineNeverInventsHumanReason() {
  /*
    Đây là lá chắn quan trọng nhất của cả bản này.

    Viettel Post không biết vải nóng, không biết khách mặc có vừa không. Nếu một ngày ai đó thêm
    một luật đọc chữ ánh xạ "..." → "Vải xấu", báo cáo sẽ có một cột đầy số trông rất thuyết phục
    và hoàn toàn bịa. Bài này chặn ở mức mã nguồn.
  */
  for (const [ma, reason] of Object.entries(VTP_REASON_TO_RETURN_REASON)) {
    assert.equal(REASON_NEEDS_HUMAN[reason], false, `mã ĐVVC ${ma} ánh xạ tới "${RETURN_REASON_LABEL[reason]}" — lý do đó chỉ NGƯỜI của shop mới biết, ĐVVC không thể là nguồn`);
  }
  for (const luat of RETURN_REASON_TEXT_RULES) {
    assert.equal(REASON_NEEDS_HUMAN[luat.reason], false, `luật đọc chữ "${luat.match}" ánh xạ tới "${RETURN_REASON_LABEL[luat.reason]}" — lý do đó cần NGƯỜI ghi, không suy từ chữ của ĐVVC được`);
  }
  const canNguoi = RETURN_REASONS.filter((r) => REASON_NEEDS_HUMAN[r]);
  assert.ok(canNguoi.length >= 20, "phần lớn taxonomy của shop phải là lý do cần người ghi");
  console.log(`✓ Máy KHÔNG bịa lý do của người: ${canNguoi.length}/${RETURN_REASONS.length} lý do chỉ có khi người ghi · 0 luật ĐVVC nào chạm tới chúng`);
}

/* ───── 3 · Tỷ lệ cứu đơn: "chưa theo dõi" KHÁC 0% ───── */
export function testRescueRateNeverFakesZero() {
  assert.deepEqual(rescueRate({ eligible: 0, withIntervention: 0, rescued: 0 }), { value: null, state: "NO_CASES" }, "không có ca nào ⇒ không có tỷ lệ, KHÔNG phải 0%");
  /*
    12 ca có nguy cơ hoàn, KHÔNG ca nào được ghi thao tác của người ⇒ CHƯA THEO DÕI ĐƯỢC.
    In 0% ở đây là nói đội chăm sóc đã làm mà không cứu được ca nào — vu oan bằng một lỗ hổng dữ liệu.
  */
  assert.deepEqual(rescueRate({ eligible: 12, withIntervention: 0, rescued: 0 }), { value: null, state: "NOT_TRACKED" }, "có ca nhưng chưa ghi thao tác nào ⇒ chưa theo dõi được, KHÔNG phải 0%");
  assert.deepEqual(rescueRate({ eligible: 10, withIntervention: 10, rescued: 0 }), { value: 0, state: "MEASURED" }, "có ghi thao tác mà không cứu được ca nào ⇒ 0% THẬT");
  assert.deepEqual(rescueRate({ eligible: 10, withIntervention: 4, rescued: 3 }), { value: 30, state: "MEASURED" });
  console.log("✓ Tỷ lệ cứu đơn: ba lối ra tách bạch — không có ca · chưa theo dõi · 0% thật. Chỉ cái thứ ba mới được in ra một con số.");
}

/* ───── 4 · Mốc thời gian: không có fallback im lặng ───── */
export function testTimeBasisHasNoSilentFallback() {
  for (const b of TIME_BASES) assert.ok(TIME_BASIS_LABEL[b], `${b}: thiếu nhãn`);
  /*
    `created_at` KHÔNG được xuất hiện trong mốc bàn giao: nó là lúc người bán bấm nút tạo vận đơn,
    không phải lúc ĐVVC cầm hàng. Lấy nó lấp chỗ trống sẽ nhét kiện chưa ai lấy vào "lô gửi tuần này".
  */
  assert.ok(!CARRIER_HANDOFF_AT_SQL.includes("created_at"), "mốc ĐVVC tiếp nhận KHÔNG được rơi về created_at");
  assert.ok(CARRIER_HANDOFF_AT_SQL.includes("picked_up_at"), "bậc 1 phải là mốc lấy hàng của ĐVVC");
  assert.ok(CARRIER_HANDOFF_AT_SQL.includes("shipment_events"), "bậc 2 phải là sự kiện ĐVVC đầu tiên — 494 kiện production không có mốc lấy hàng");
  assert.ok(!FINAL_OUTCOME_AT_SQL.includes("updated_at"), "mốc kết quả cuối KHÔNG được rơi về updated_at: cột đó bị chạm bởi mọi lần đồng bộ");
  // Bí danh `s.` sẽ hỏng với "missing FROM-clause entry" — Drizzle phát ra tên bảng đầy đủ.
  for (const sql of [CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL]) {
    assert.ok(!/\bs\./.test(sql), "SQL thô phải dùng tên bảng đầy đủ, không dùng bí danh s.");
  }
  console.log('✓ Mốc thời gian: 3 lựa chọn có tên · mốc bàn giao KHÔNG rơi về ngày tạo đơn · mốc kết quả cuối KHÔNG rơi về updated_at');
}

/* ───── 5 · Cohort KPI lọc theo ngày ĐVVC tiếp nhận, không theo ngày tạo đơn ───── */
export async function testKpiCohortUsesHandoffDate(db: Db) {
  const P = "kpi-";
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm KPI", customId: "KPIQ9", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "KPIQ9-S", detail: "S" }).onConflictDoNothing();
  /*
    Đơn TẠO 01/08 nhưng ĐVVC chỉ tiếp nhận 20/08 — lệch 19 ngày. Trên production lệch trung bình
    4,5 ngày và cao nhất 26 ngày, nên đây là hình dạng dữ liệu thật, không phải ca dựng.
  */
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-08-01T03:00:00Z"), totalPriceAfterDiscount: 500_000, billFullName: "Khách KPI" }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}i1`, orderId: `${P}o1`, variantId: `${P}v1`, sku: "KPIQ9-S", productName: "Đầm KPI", quantity: 1, lineTotal: 500_000, isBonus: false }).onConflictDoNothing();
  await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}T1`, trackingCode: `${P}T1`, stage: "DELIVERED", codCollected: 500_000, pickedUpAt: new Date("2026-08-20T03:00:00Z"), deliveredAt: new Date("2026-08-24T03:00:00Z"), createdAt: new Date("2026-08-01T04:00:00Z"), isFinal: true }).onConflictDoNothing();

  const truyVan = (from: string, to: string, basis: "SHIPPED" | "ORDERED") =>
    getReturnRateByVariant({
      period: { key: "custom", label: "thử", from: new Date(from), to: new Date(to), fromKey: from, toKey: to },
      basis,
      q: "KPIQ9",
      minShipped: 1,
      sort: "successRate",
      dir: "asc",
      page: 1,
      pageSize: 50,
    });

  // Cửa sổ 18–26/08 chứa NGÀY GỬI nhưng không chứa ngày tạo đơn.
  const theoGui = await truyVan("2026-08-18T00:00:00Z", "2026-08-26T23:59:59Z", "SHIPPED");
  assert.equal(theoGui.all.length, 1, "lọc theo NGÀY GỬI phải thấy kiện gửi trong cửa sổ, dù đơn tạo từ 19 ngày trước");

  const theoTao = await truyVan("2026-08-18T00:00:00Z", "2026-08-26T23:59:59Z", "ORDERED");
  assert.equal(theoTao.all.length, 0, "cùng cửa sổ đó, lọc theo NGÀY TẠO ĐƠN KHÔNG thấy gì — hai mốc chọn ra hai tập khác nhau, đây chính là cái bẫy của bảng cũ");

  const taoDung = await truyVan("2026-07-30T00:00:00Z", "2026-08-05T23:59:59Z", "ORDERED");
  assert.equal(taoDung.all.length, 1, "cửa sổ chứa ngày tạo đơn thì lọc theo ngày tạo đơn phải thấy");

  for (const id of [`${P}s1`]) await db.delete(schema.shipments).where(eq(schema.shipments.id, id));
  await db.delete(schema.orderItems).where(eq(schema.orderItems.id, `${P}i1`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v1`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  console.log("✓ Cohort KPI theo NGÀY ĐVVC TIẾP NHẬN: cùng một cửa sổ, lọc theo ngày gửi thấy 1 kiện còn lọc theo ngày tạo đơn thấy 0 — hai câu hỏi khác nhau, hai câu trả lời khác nhau");
}

/* ───── 5b · Dòng gộp theo mã đếm ĐƠN, không cộng các mẫu mã ───── */
export async function testProductRowCountsOrdersOnce(db: Db) {
  const P = "gop-";
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm GỘP", customId: "GOPQ9", isRemoved: false }).onConflictDoNothing();
  for (const v of ["S", "M"]) {
    await db.insert(schema.productVariants).values({ id: `${P}v-${v}`, productId: `${P}p1`, sku: `GOPQ9-${v}`, detail: v }).onConflictDoNothing();
  }
  /*
    MỘT đơn, HAI mẫu mã của CÙNG một mã hàng — hình dạng dữ liệu đã đo trên production 21/09/2026:
    Q003 có 365 đơn thật nhưng cộng các dòng mẫu mã lại ra 405 (+11,0%), Q005 202/175 (+15,4%).

    Ở grain MẪU MÃ mỗi dòng đếm đúng một đơn, nên TỔNG hai dòng là 2. Dòng gộp phải nói 1.
  */
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-08-10T03:00:00Z"), totalPriceAfterDiscount: 900_000, billFullName: "Khách GỘP" }).onConflictDoNothing();
  for (const v of ["S", "M"]) {
    await db.insert(schema.orderItems).values({ id: `${P}i-${v}`, orderId: `${P}o1`, variantId: `${P}v-${v}`, sku: `GOPQ9-${v}`, productName: "Đầm GỘP", variationDetail: v, quantity: 1, lineTotal: 450_000, isBonus: false }).onConflictDoNothing();
  }
  await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}T1`, trackingCode: `${P}T1`, stage: "DELIVERED", codCollected: 900_000, pickedUpAt: new Date("2026-08-11T03:00:00Z"), deliveredAt: new Date("2026-08-14T03:00:00Z"), createdAt: new Date("2026-08-10T04:00:00Z"), isFinal: true }).onConflictDoNothing();

  const r = await getReturnRateByVariant({
    period: { key: "custom", label: "thử", from: new Date("2026-08-09T00:00:00Z"), to: new Date("2026-08-20T23:59:59Z"), fromKey: "2026-08-09", toKey: "2026-08-20" },
    basis: "SHIPPED",
    q: "GOPQ9",
    minShipped: 1,
    sort: "successRate",
    dir: "asc",
    page: 1,
    pageSize: 50,
  });

  assert.equal(r.all.length, 2, "hai mẫu mã ⇒ hai dòng ở grain mẫu mã");
  const congLai = r.all.reduce((t, x) => t + x.shipped, 0);
  assert.equal(congLai, 2, "và cộng hai dòng ấy lại ra 2 — ĐÚNG cái mà dòng gộp cũ in ra");

  const ma = r.productRows.find((x) => x.productKey === `${P}p1`);
  assert.ok(ma, "phải có dòng gộp theo mã hàng do MÁY CHỦ dựng");
  assert.equal(ma.shipped, 1, "nhưng chỉ có MỘT đơn thật — dòng gộp đếm đơn, không cộng mẫu mã");
  assert.equal(ma.delivered, 1);
  assert.equal(ma.variants, 2, "vẫn nói rõ mã này có 2 mẫu mã phát sinh trong kỳ");
  assert.notEqual(ma.shipped, congLai, "hai con số PHẢI khác nhau ở ca này, nếu không bài kiểm chưa chứng minh được gì");

  // Mọi dòng mẫu mã mang khoá mã hàng để trình duyệt gộp theo ĐÚNG mã, không theo chuỗi tên.
  for (const x of r.all) assert.equal(x.productKey, `${P}p1`);

  await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s1`));
  for (const v of ["S", "M"]) await db.delete(schema.orderItems).where(eq(schema.orderItems.id, `${P}i-${v}`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  for (const v of ["S", "M"]) await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v-${v}`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  console.log("✓ Dòng gộp theo mã: 1 đơn 2 mẫu mã ⇒ dòng gộp nói 1 đơn, cộng các mẫu mã nói 2 — đếm ở máy chủ theo đơn, không cộng ở trình duyệt");
}

/* ───── 6 · Kiện không có chứng cứ ĐVVC tiếp nhận thì NGOÀI cohort, không bị gán ngày ───── */
export async function testNoHandoffEvidenceStaysOut(db: Db) {
  const P = "kpin-";
  await db.insert(schema.products).values({ id: `${P}p1`, name: "Đầm chưa lấy", customId: "KPIQ8", isRemoved: false }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}p1`, sku: "KPIQ8-S", detail: "S" }).onConflictDoNothing();
  await db.insert(schema.orders).values({ id: `${P}o1`, stage: "CONFIRMED", status: 2, insertedAt: new Date("2026-08-02T03:00:00Z"), totalPriceAfterDiscount: 400_000, billFullName: "Khách" }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}i1`, orderId: `${P}o1`, variantId: `${P}v1`, sku: "KPIQ8-S", productName: "Đầm chưa lấy", quantity: 1, lineTotal: 400_000, isBonus: false }).onConflictDoNothing();
  // Vận đơn đã tạo nhưng bưu tá CHƯA lấy: không mốc lấy hàng, không sự kiện ĐVVC nào.
  await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: `${P}T1`, trackingCode: `${P}T1`, stage: "PENDING", createdAt: new Date("2026-08-02T04:00:00Z") }).onConflictDoNothing();

  const kq = await getReturnRateByVariant({
    period: { key: "custom", label: "thử", from: new Date("2026-08-01T00:00:00Z"), to: new Date("2026-08-31T23:59:59Z"), fromKey: "2026-08-01", toKey: "2026-08-31" },
    basis: "SHIPPED",
    q: "KPIQ8",
    minShipped: 1,
    sort: "successRate",
    dir: "asc",
    page: 1,
    pageSize: 50,
  });
  /*
    Kiện này CÓ `created_at` trong kỳ. Nếu mốc bàn giao rơi về `created_at` thì nó sẽ lọt vào
    cohort "đã gửi" — trong khi bưu tá còn chưa cầm hàng. Đó đúng là con số giả mà bản này chặn.
  */
  assert.equal(kq.all.length, 0, "kiện chưa có chứng cứ ĐVVC tiếp nhận phải NẰM NGOÀI cohort, KHÔNG được lấy ngày tạo vận đơn lấp vào");

  await db.delete(schema.shipments).where(eq(schema.shipments.id, `${P}s1`));
  await db.delete(schema.orderItems).where(eq(schema.orderItems.id, `${P}i1`));
  await db.delete(schema.orders).where(eq(schema.orders.id, `${P}o1`));
  await db.delete(schema.productVariants).where(eq(schema.productVariants.id, `${P}v1`));
  await db.delete(schema.products).where(eq(schema.products.id, `${P}p1`));
  console.log("✓ Thiếu chứng cứ ĐVVC tiếp nhận ⇒ ngoài cohort: kiện PENDING có ngày tạo trong kỳ vẫn KHÔNG lọt vào 'đã gửi'");
}

/* ───── 7 · Báo cáo lý do: mặc định theo ngày kết quả cuối ───── */
export async function testReasonReportDefaultsToOutcomeDate() {
  const bc = await getReturnReasonReport({ period: { key: "all", label: "tất cả", from: null, to: null, fromKey: null, toKey: null } });
  assert.equal(bc.basis, "OUTCOME", "báo cáo lý do hoàn phải mặc định theo NGÀY KẾT QUẢ CUỐI — ca đóng hôm nay có thể là đơn của tháng trước");
  // Tổng nhóm phải bằng số đơn hoàn ĐÃ BIẾT lý do; UNKNOWN đứng ngoài mọi nhóm.
  const tongNhom = bc.groups.reduce((n, g) => n + g.count, 0);
  assert.equal(tongNhom, bc.reasonCoverage.known, "cộng các nhóm phải ra đúng số đơn hoàn đã biết lý do");
  assert.equal(bc.reasonCoverage.known + bc.reasonCoverage.unknown, bc.returned, "biết + chưa biết = tổng hoàn");
  console.log(`✓ Báo cáo lý do hoàn mặc định theo NGÀY XỬ LÝ · độ phủ ${bc.reasonCoverage.known}/${bc.returned} · ${bc.missingBasis} ca không có mốc kết quả cuối được nêu riêng thay vì gán bừa ngày khác`);
}
