import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getCashProfitReport } from "@/lib/queries/profit-cash";
import { dataQualitySummary } from "@/lib/queries/data-quality";
import { getDashboardData } from "@/lib/queries/dashboard";
import { adOrdersFromErp } from "@/lib/queries/expenses";
import { orderSummary } from "@/lib/queries/orders";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { listVariantsForReceipt } from "@/lib/queries/stock";
import { getReturnRateSummary } from "@/lib/queries/return-rate";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { getRecognizedCosts } from "@/lib/queries/cost-engine";
import { getDailyBreakdown, getProfitReport } from "@/lib/queries/reports";
import { getMarketerReport } from "@/lib/queries/payroll";
import { shipmentSummary } from "@/lib/queries/shipments";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import { parseListParams, type Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** ListParams "không lọc gì" để tổng hợp danh sách bằng đúng phạm vi báo cáo. */
function allParams() {
  return parseListParams({ period: "all" }, { defaultPeriod: "all", defaultPageSize: 50 });
}

/**
 * NGUỒN SỰ THẬT của bộ kiểm thử: đếm thẳng bằng ORDER_OUTCOME trên đúng phạm vi báo cáo.
 * Mọi màn hình phải khớp con số này; nếu một màn hình lệch thì màn hình đó sai, không phải test sai.
 */
async function truth(db: Db) {
  const [row] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
      inTransit: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'IN_TRANSIT')`,
      deliveredRevenue: sql<number>`coalesce(sum(${schema.orders.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${schema.orders.stage} <> 'NEW'`);

  // Grain VẬN ĐƠN: trang Vận đơn đếm vận đơn, không đếm đơn. Hai con số chỉ khác nhau đúng bằng
  // số đơn chưa có vận đơn nào (Pancake khai "đã giao" mà chưa đẩy sang ĐVVC) cộng vận đơn mồ côi.
  const [shipRow] = await db
    .select({
      delivered: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returned: sql<number>`count(*) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE'))`,
    })
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId));

  return {
    delivered: Number(row?.delivered ?? 0),
    returned: Number(row?.returned ?? 0),
    inTransit: Number(row?.inTransit ?? 0),
    deliveredRevenue: Number(row?.deliveredRevenue ?? 0),
    shipmentDelivered: Number(shipRow?.delivered ?? 0),
    shipmentReturned: Number(shipRow?.returned ?? 0),
  };
}

export async function testConsistency(db: Db) {
  clearMemo();
  const t = await truth(db);
  assert.ok(t.delivered > 0 && t.returned > 0, "fixture phải có cả đơn giao thành công lẫn đơn hoàn");

  // ───────── 1. Cùng "đơn giao thành công" trên mọi màn hình ─────────
  const params = allParams();
  const [orders, ships, gtc, ads, dq] = await Promise.all([
    orderSummary(params),
    shipmentSummary(params),
    getReturnRateSummary(ALL, ""),
    adOrdersFromErp(null, null),
    dataQualitySummary(ALL),
  ]);

  // ───────── ĐỊA CHỈ CHƯA CHUẨN HOÁ: ĐẾM PHẢI ĐỘC LẬP VỚI CHÍNH BỘ LỌC ĐÓ ─────────
  //
  // Pancake chỉ giao được khi đã ghép địa chỉ khách vào đơn vị hành chính. Không ghép được thì
  // `ship_province` rỗng, đơn đứng im ở POS với dòng "Vui lòng cung cấp địa chỉ cần chuẩn hoá", và
  // trước đây ERP KHÔNG hề báo. Đo trên production 09/09/2026: 386/2.423 đơn trong 60 ngày, 231 đơn
  // còn sống.
  //
  // Con số trên NHÃN BỘ LỌC phải bỏ qua chính bộ lọc địa chỉ — nếu không, bấm vào "Chưa chuẩn hoá"
  // rồi thì nhãn tự đổi theo lựa chọn của mình và không còn nói lên tổng nữa.
  const [{ n: liveUnnormalized }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .where(sql`coalesce(${schema.orders.shipProvince}, '') = '' and ${schema.orders.stage} not in ('CANCELLED','DELETED')`);
  assert.equal(orders.unnormalizedAddress, Number(liveUnnormalized), "đếm địa chỉ chưa chuẩn hoá phải khớp đơn còn sống");
  const locked = await orderSummary({ ...params, filters: { ...params.filters, address: ["normalized"] } });
  assert.equal(
    locked.unnormalizedAddress,
    orders.unnormalizedAddress,
    "nhãn bộ lọc phải giữ nguyên khi đang lọc 'đã chuẩn hoá' — nếu không nó đếm chính tập vừa lọc ra",
  );

  assert.equal(gtc.delivered, t.delivered, "Báo cáo Tỷ lệ giao thành công phải khớp nguồn sự thật");
  assert.equal(orders.success, t.delivered, "KPI 'giao thành công' trang Đơn hàng phải khớp");
  assert.equal(ads.delivered, t.delivered, "Quảng cáo/Marketing phải khớp");
  assert.equal(dq.legacyDelivered, t.delivered, "Chất lượng dữ liệu (cột legacy) phải khớp");
  // Trang Vận đơn đếm ở GRAIN VẬN ĐƠN nên con số nhỏ hơn; điều bắt buộc là nó dùng CÙNG QUY TẮC,
  // và phần chênh phải giải thích được hết bằng đơn chưa có vận đơn — không được là chênh lệch bí ẩn.
  assert.equal(ships.delivered, t.shipmentDelivered, "Trang Vận đơn phải dùng cùng quy tắc ORDER_OUTCOME, không dùng bản rút gọn riêng");
  const [{ n: deliveredNoShipment }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.orders)
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${schema.orders.stage} <> 'NEW' and ${schema.shipments.id} is null and ${ORDER_OUTCOME} = 'DELIVERED'`);
  const [{ n: orphanDelivered }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.shipments)
    .leftJoin(schema.orders, eq(schema.orders.id, schema.shipments.orderId))
    .where(sql`${schema.shipments.orderId} is null and ${ORDER_OUTCOME} = 'DELIVERED'`);
  assert.equal(
    t.delivered - Number(deliveredNoShipment) + Number(orphanDelivered),
    t.shipmentDelivered,
    "chênh lệch đơn ↔ vận đơn phải giải thích hết bằng đơn chưa có vận đơn + vận đơn chưa ghép đơn",
  );

  // ───────── 2. Cùng "đơn hoàn" ─────────
  assert.equal(gtc.returned, t.returned, "đơn hoàn: Tỷ lệ giao thành công");
  assert.equal(ships.returning, t.shipmentReturned, "đơn hoàn: trang Vận đơn (grain vận đơn, cùng quy tắc)");
  assert.equal(dq.legacyDelivered + dq.returned >= 0, true);

  // ───────── 3. Cùng doanh thu đơn giao thành công ─────────
  assert.equal(ads.deliveredRevenue, t.deliveredRevenue, "doanh thu giao thành công: Marketing");

  // ───────── 4a. Tổng quan phải dùng CÙNG định nghĩa GTC với báo cáo ─────────
  const dash = await getDashboardData(ALL);
  assert.equal(dash.kpi.successRate, gtc.successRate === null ? null : Math.round(gtc.successRate * 10) / 10,
    "Tổng quan và Báo cáo GTC phải cho cùng tỷ lệ giao thành công");
  assert.equal(dash.kpi.successOrders + dash.kpi.returnedOrders > 0, true);

  // ───────── 4. Tỷ lệ GTC tính từ cùng tử số / mẫu số ─────────
  const expectedRate = t.delivered + t.returned ? (t.delivered / (t.delivered + t.returned)) * 100 : null;
  assert.equal(gtc.successRate, expectedRate, "GTC = giao thành công ÷ (giao thành công + hoàn)");
  assert.ok(gtc.rate !== null && gtc.successRate !== null && Math.abs(gtc.rate + gtc.successRate - 100) < 1e-9, "tỷ lệ hoàn + GTC = 100");

  // ───────── 5. Dòng tiền: COD "đã thu chờ về" phải loại vận đơn đã hoàn/huỷ ─────────
  const cash = await getCashProfitReport(ALL);
  const [{ n: badWaiting }] = await db
    .select({ n: sql<number>`count(*)` })
    .from(schema.shipments)
    .where(sql`${schema.shipments.codStatus} in ('COLLECTED','RECONCILED') and ${schema.shipments.stage} in ('RETURNING','RETURNED','CANCELLED')`);
  if (Number(badWaiting) > 0) {
    const [{ amount }] = await db
      .select({ amount: sql<number>`coalesce(sum(${schema.shipments.codAmount}), 0)` })
      .from(schema.shipments)
      // Đang hoàn về cũng là tiền không bao giờ về — cùng định nghĩa với COD_COLLECTABLE.
      .where(sql`${schema.shipments.codStatus} in ('COLLECTED','RECONCILED') and ${schema.shipments.stage} not in ('RETURNING','RETURNED','CANCELLED')`);
    assert.equal(cash.pending.codCollectedWaiting, Number(amount), "COD chờ về không được tính vận đơn đang hoàn/đã hoàn/huỷ");
  }

  // ───────── 6. Tồn kho: hàng hoàn chưa về kho không được nằm trong tồn ─────────
  const stock = await listVariantsForReceipt();
  const plan = await getReplenishmentPlan();
  for (const variantId of ["rr-var", "dq-var"]) {
    const inStock = stock.find((v) => v.id === variantId);
    const inPlan = plan.rows.find((r) => r.variantId === variantId);
    if (inStock && inPlan) {
      assert.equal(inPlan.stock, inStock.currentStock, `Kế hoạch SX và Tồn kho phải cùng số tồn (${variantId})`);
    }
  }

  // Tồn ERP không được vượt quá tổng nhập — dấu hiệu kinh điển của tồn ảo do cộng nhầm hàng hoàn.
  const [{ received }] = await db
    .select({ received: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)` })
    .from(schema.stockReceiptItems)
    .where(eq(schema.stockReceiptItems.variantId, "rr-var"));
  const rrStock = stock.find((v) => v.id === "rr-var");
  assert.ok(rrStock !== undefined && rrStock.currentStock <= Number(received), "tồn ERP không được lớn hơn tổng nhập");

  // ───────── 7. Kế hoạch SX không lấy đơn hoàn làm tín hiệu nhu cầu ─────────
  const planned = plan.rows.find((r) => r.variantId === "rr-var");
  if (planned) {
    const [{ n: returnedQty }] = await db
      .select({ n: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
      .from(schema.orderItems)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
      .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
      .where(sql`${schema.orderItems.variantId} = 'rr-var' and ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')`);
    assert.ok(Number(returnedQty) > 0, "fixture phải có hàng hoàn để kiểm tra");
    const [{ n: totalQty }] = await db
      .select({ n: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
      .from(schema.orderItems)
      .where(eq(schema.orderItems.variantId, "rr-var"));
    assert.ok(planned.sold30 <= Number(totalQty) - Number(returnedQty), "nhu cầu 30 ngày không được gồm đơn hoàn");
  }

  // ───────── 8. MỘT con số "chi phí vận hành trong kỳ" cho MỌI màn hình ─────────
  // Trước đây mỗi trang tự cộng `sum(expenses.amount) where occurred_at ...`, nên Bảng điều khiển,
  // Sự thật tài chính, Báo cáo lợi nhuận, Dòng tiền và Lương cho tới BỐN con số khác nhau cho cùng
  // một chỉ số. Khoản theo kỳ (thuê mặt bằng) là chỗ chúng lệch nhau nhiều nhất.
  /**
   * KỲ PHẢI ĐI THEO DỮ LIỆU, KHÔNG ĐI THEO NGÀY TRÊN LỊCH.
   *
   * Sự cố thật 10/09/2026: kỳ ở đây từng ghim cứng 01–07/09, còn đơn trong bộ dữ liệu mẫu lại dùng
   * ngày TƯƠNG ĐỐI ("hôm nay trừ N ngày"). Qua nửa đêm, đơn rời khỏi cửa sổ ghim cứng, bảng lợi
   * nhuận theo mã không còn dòng nào, và phép cộng phân bổ ra 0 — bài kiểm thử đỏ mà mã nguồn không
   * đổi một dòng. Một cổng ra đỏ theo ngày trên lịch thì không ai còn tin nó nữa.
   *
   * Nay kỳ được dựng QUANH chính hôm nay, nên nó luôn chứa dữ liệu mẫu.
   */
  // Ranh giới NGÀY theo giờ Việt Nam — cắt giữa ngày sẽ đếm lệch một ngày và mọi con số prorata sai.
  const ngay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(d);
  const dauNgayVN = (key: string) => new Date(`${key}T00:00:00+07:00`);
  const cuoiNgayVN = (key: string) => new Date(`${key}T23:59:59+07:00`);
  const homNay = new Date();
  const [nam, thang] = ngay(homNay).split("-").map(Number);
  const dauThang = dauNgayVN(`${nam}-${String(thang).padStart(2, "0")}-01`);
  const soNgayThang = new Date(Date.UTC(nam, thang, 0)).getUTCDate();
  const cuoiThang = cuoiNgayVN(`${nam}-${String(thang).padStart(2, "0")}-${String(soNgayThang).padStart(2, "0")}`);
  const kyThang: Period = { key: "custom", from: dauThang, to: cuoiThang, label: "Tháng này", fromKey: ngay(dauThang), toKey: ngay(cuoiThang) };
  await db.insert(schema.expenses).values([
    { id: "cs-rent", category: "RENT", description: "Thuê mặt bằng tháng này", amount: 3_000_000,
      occurredAt: dauThang, allocationMethod: "PERIOD_PRORATA", periodStart: dauThang, periodEnd: cuoiThang },
  ]);
  clearMemo();
  // Bảy ngày KẾT THÚC HÔM NAY, cắt trong tháng — luôn chứa đơn của bộ dữ liệu mẫu.
  const tuanDenKey = ngay(homNay);
  const tuanTuKey = ngay(new Date(dauNgayVN(tuanDenKey).getTime() - 6 * 86_400_000));
  const tuanTu = new Date(Math.max(dauThang.getTime(), dauNgayVN(tuanTuKey).getTime()));
  const tuanDen = cuoiNgayVN(tuanDenKey);
  const soNgayTuan = Math.round((tuanDen.getTime() - tuanTu.getTime()) / 86_400_000);
  const tuan1: Period = { key: "custom", from: tuanTu, to: tuanDen, label: `${soNgayTuan} ngày gần nhất`, fromKey: ngay(tuanTu), toKey: ngay(tuanDen) };
  const [dashThang, truthThang, nominalThang, cashThang] = await Promise.all([
    getDashboardData(kyThang), getFinancialTruth(kyThang), getNominalProfitReport(kyThang), getCashProfitReport(kyThang),
  ]);
  const opexThang = nominalThang.operatingExpenses;
  assert.equal(dashThang.finance.expenses, opexThang, "Bảng điều khiển và Báo cáo lợi nhuận phải cùng một CP vận hành");
  assert.equal(Math.abs(truthThang.waterfall.find((w) => w.key === "operating")?.amount ?? 0), opexThang, "Sự thật tài chính phải cùng một CP vận hành");
  assert.equal(cashThang.cashOut.operating, opexThang, "Dòng tiền thực phải cùng một CP vận hành");
  assert.ok(opexThang >= 3_000_000, "cả tháng ⇒ tiền thuê vào trọn khoản");

  clearMemo();
  const [dashTuan, truthTuan, nominalTuan] = await Promise.all([getDashboardData(tuan1), getFinancialTruth(tuan1), getNominalProfitReport(tuan1)]);
  const opexTuan = nominalTuan.operatingExpenses;
  assert.equal(dashTuan.finance.expenses, opexTuan, "xem một tuần: Bảng điều khiển vẫn khớp Báo cáo lợi nhuận");
  assert.equal(Math.abs(truthTuan.waterfall.find((w) => w.key === "operating")?.amount ?? 0), opexTuan, "xem một tuần: Sự thật tài chính vẫn khớp");
  assert.ok(opexTuan < opexThang, "một tuần phải NHỎ HƠN cả tháng — không được cộng nguyên khoản thuê vào tuần");
  // Fixture chuẩn của hợp đồng: thuê 3.000.000đ / 30 ngày, lọc 7 ngày ⇒ MỌI nơi phải ra 700.000đ.
  assert.equal(opexThang, 3_000_000, "cả tháng = trọn khoản thuê");
  // Prorata theo SỐ NGÀY CHỒNG LẤN — tính từ chính cửa sổ, không ghim cứng theo tháng 9.
  assert.equal(
    opexTuan,
    Math.round((3_000_000 * soNgayTuan) / soNgayThang),
    `${soNgayTuan}/${soNgayThang} ngày của 3.000.000đ — con số này phải giống nhau ở mọi module`,
  );

  // BÁO CÁO TỔNG HỢP + BIỂU ĐỒ THEO NGÀY: cộng các cột trong khoảng phải bằng đúng phần phân bổ.
  const [pnlThang, pnlTuan, ngayThang, ngayTuan] = await Promise.all([
    getProfitReport(kyThang, "created"), getProfitReport(tuan1, "created"),
    getDailyBreakdown(kyThang, "created"), getDailyBreakdown(tuan1, "created"),
  ]);
  assert.equal(pnlThang.current.operating, opexThang, "Báo cáo tổng hợp (tháng) phải cùng một CP vận hành");
  assert.equal(pnlTuan.current.operating, opexTuan, "Báo cáo tổng hợp (tuần) phải cùng một CP vận hành");
  const congNgayThang = ngayThang.reduce((t, r) => t + r.operating, 0);
  const congNgayTuan = ngayTuan.reduce((t, r) => t + r.operating, 0);
  assert.equal(congNgayThang, opexThang, "cộng 30 cột của biểu đồ theo ngày = đúng phần phân bổ của tháng");
  assert.equal(congNgayTuan, opexTuan, "cộng các cột của biểu đồ theo ngày = đúng phần phân bổ của tuần");
  // Không cột nào được ôm trọn khoản thuê: đó chính là hình dạng bug cũ.
  const cotLonNhat = Math.max(0, ...ngayThang.map((r) => r.operating));
  assert.ok(cotLonNhat < 200_000, `không ngày nào được ôm cả khoản thuê (cột lớn nhất ${cotLonNhat}đ)`);
  assert.ok(ngayTuan.filter((r) => r.operating > 0).length >= 7, "mọi ngày trong tuần đều có chi phí, không phải chỉ ngày ghi sổ");

  // LỢI NHUẬN THEO MÃ: phần phân bổ xuống từng mã cộng lại = đúng tổng của kỳ (largest remainder).
  assert.equal(nominalTuan.rows.reduce((a, r) => a + r.operatingAlloc, 0), opexTuan, "Σ phân bổ xuống mã (tuần) phải bằng đúng phần phân bổ của kỳ, không lệch vì làm tròn");
  assert.equal(nominalThang.rows.reduce((a, r) => a + r.operatingAlloc, 0), opexThang, "Σ phân bổ xuống mã (tháng) = 3.000.000đ");

  // LƯƠNG / HOA HỒNG: nền chi phí của bảng lương phải là CÙNG con số, không phải bản cộng thô riêng.
  for (const basis of ["profit1", "nominal"] as const) {
    const mk = await getMarketerReport(tuan1, basis);
    assert.equal(mk.totals.operatingEntered, opexTuan, `bảng lương (${basis}) dùng chung CP vận hành đã phân bổ`);
  }

  // ── BẤT BIẾN CUỐI: engine là nguồn duy nhất, và Σ thành phần = tổng engine ──
  const engineThang = await getRecognizedCosts(kyThang);
  const engineTuan = await getRecognizedCosts(tuan1);
  assert.equal(engineThang.operatingTotal, opexThang, "Profit Engine và Báo cáo lợi nhuận là CÙNG một con số (tháng)");
  assert.equal(engineTuan.operatingTotal, opexTuan, "Profit Engine và Báo cáo lợi nhuận là CÙNG một con số (tuần)");
  const congThanhPhan = Object.values(engineThang.components).reduce((t, c) => t + c.amount, 0);
  assert.equal(congThanhPhan, engineThang.total, "Σ thành phần = tổng engine, không đồng nào rơi ngoài");
  // Mỗi đồng thuộc ĐÚNG MỘT thành phần: khoản thuê chỉ được xuất hiện ở RENT.
  assert.equal(engineThang.components.RENT.amount, 3_000_000, "khoản thuê nằm ở đúng thành phần Mặt bằng");
  assert.equal(engineThang.components.OTHER_OPERATING.amount, 0, "và KHÔNG xuất hiện lần nữa ở Chi phí vận hành khác");
  assert.equal(engineThang.components.UTILITIES.amount, 0, "điện nước chưa tách khỏi Mặt bằng ⇒ bằng 0, không đếm chồng");

  await db.delete(schema.expenses).where(eq(schema.expenses.id, "cs-rent"));
  clearMemo();

  console.log(`✓ Nhất quán: chi phí vận hành ${opexThang}đ (tháng) / ${opexTuan}đ (tuần) GIỐNG NHAU ở Profit Engine · Bảng điều khiển · Sự thật tài chính · Lợi nhuận · Dòng tiền · Báo cáo tổng hợp · biểu đồ theo ngày · phân bổ theo mã · bảng lương`);
  console.log(`✓ Nhất quán: giao thành công ${t.delivered} khớp ở Đơn hàng / Vận đơn / GTC / Marketing / Chất lượng dữ liệu; hoàn ${t.returned}; GTC ${gtc.successRate}%`);
  console.log(`✓ Nhất quán: tồn kho khớp giữa Sản phẩm và Kế hoạch SX; nhu cầu SX không gồm đơn hoàn`);
}
