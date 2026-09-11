import { and, count, desc, eq, gte, inArray, isNotNull, lte, ne, sql, sum } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { adsRatio } from "@/lib/constants/profit";
import { codCashSummary } from "@/lib/queries/cod";
import { memo, periodKey } from "@/lib/cache";
import { stockRiskSummary } from "@/lib/queries/stock";
import { getProductIntelligence } from "@/lib/queries/product-intelligence";
import { getFinancialTruth } from "@/lib/queries/financial-truth";
import { getControlTower } from "@/lib/queries/control-tower";
import type { OrderStage, ShipmentStage } from "@/db/schema";
import { vnDateKey } from "@/lib/format";
import { previousPeriod, type Period } from "@/lib/search-params";
// Giữ bảng dẫn xuất của phiên hiệu năng, và lấy chi phí vận hành qua Profit Engine.
import { getOperatingCost } from "@/lib/queries/cost-engine";
import { averageOrderValue, factMetrics, metricScope, orderMetricFacts, successRate } from "@/lib/queries/metrics";

function inPeriod(column: typeof schema.orders.insertedAt, from: Date | null, to: Date | null) {
  const conds = [];
  if (from) conds.push(gte(column, from));
  if (to) conds.push(lte(column, to));
  return conds.length ? and(...conds) : undefined;
}

export type OrderKpis = {
  orders: number;
  revenue: number; // doanh thu lên đơn (không tính đơn huỷ/xoá)
  cogs: number;
  successOrders: number;
  /** Doanh thu của đơn ĐÃ GIAO THÀNH CÔNG (earned revenue) — khác doanh thu lên đơn. */
  successRevenue: number;
  /** Giá vốn của ĐÚNG những đơn đã sinh ra `successRevenue`. Cùng population, cùng bộ lọc. */
  successCogs: number;
  failedOrders: number;
  returnedOrders: number;
  activeOrders: number;
  /** Đơn CHƯA KẾT LUẬN ĐƯỢC vì thiếu chứng từ ĐVVC — cần người xử lý, không phải chờ đợi. */
  unknownOrders: number;
  aov: number;
  /** GTC (%) = giao TC ÷ (giao TC + hoàn). null khi chưa có đơn nào kết thúc — hiển thị "—", không phải 0%. */
  successRate: number | null;
};

async function orderKpis(from: Date | null, to: Date | null): Promise<OrderKpis> {
  const db = await getDb();
  // Chỉ đơn ĐÃ XÁC NHẬN trên Pancake (bỏ đơn Mới chưa chốt, huỷ, xoá) — khớp báo cáo lợi nhuận
  const where = metricScope({ key: "custom", from, to, label: "", fromKey: null, toKey: null }, "confirmed");
  // Kết quả đơn theo trạng thái vận đơn Viettel Post kết hợp Pancake (ORDER_OUTCOME)
  // MỌI con số dưới đây đi qua lớp chân lý chỉ số (lib/queries/metrics.ts) và dùng CHUNG một
  // population — nếu không thì doanh thu lấy theo tập đơn này, giá vốn lấy theo tập đơn khác.
  // 10 cột gộp trên cùng biểu thức kết quả đơn ⇒ đọc trên BẢNG DẪN XUẤT để nó chỉ tính một lần
  // cho mỗi đơn. Cùng định nghĩa, cùng population, cùng con số — xem lib/queries/metrics.ts.
  const base = orderMetricFacts(db, where);
  const m = factMetrics(base);
  /*
    JIT TAT - do duoc: cau lenh nay 8.318ms va 8.182ms trong mot luot probe (chay hai lan: ky nay
    va ky truoc). Cung ho da tach bach duoc JIT: 8.578ms bat / 26ms tat, cung so khoi dem.
  */
  const [row] = await chayKhongJit(db, (tx) => tx
    .select({
      orders: m.countBooked,
      revenue: m.bookedRevenue,
      cogs: m.bookedCogs,
      successOrders: m.countDelivered,
      successRevenue: m.deliveredRevenue,
      // Giá vốn của ĐÚNG những đơn đã sinh ra `successRevenue` — cùng bộ lọc, cùng câu truy vấn.
      successCogs: m.deliveredCogs,
      failedOrders: sql<number>`${m.countReturned} + ${m.countCancelled}`,
      // Riêng đơn HOÀN (không gồm huỷ) — mẫu số của tỷ lệ giao thành công, phải cùng định nghĩa
      // với báo cáo Tỷ lệ giao thành công: GTC = giao TC ÷ (giao TC + hoàn), KHÔNG chia cho tổng đơn.
      returnedOrders: m.countReturned,
      activeOrders: m.countOpen,
      unknownOrders: m.countUnknown,
    })
    .from(base));
  const kpi: OrderKpis = {
    orders: Number(row?.orders ?? 0),
    revenue: Number(row?.revenue ?? 0),
    cogs: Number(row?.cogs ?? 0),
    successOrders: Number(row?.successOrders ?? 0),
    successRevenue: Number(row?.successRevenue ?? 0),
    successCogs: Number(row?.successCogs ?? 0),
    failedOrders: Number(row?.failedOrders ?? 0),
    returnedOrders: Number(row?.returnedOrders ?? 0),
    activeOrders: Number(row?.activeOrders ?? 0),
    unknownOrders: Number(row?.unknownOrders ?? 0),
    aov: 0,
    successRate: null,
  };
  kpi.aov = averageOrderValue(kpi.revenue, kpi.orders);
  kpi.successRate = successRate(kpi.successOrders, kpi.returnedOrders);
  return kpi;
}

async function getDashboardDataUncached(period: Period) {
  const db = await getDb();
  /**
   * KHÔNG await Ở ĐÂY. Hai truy vấn KPI không phụ thuộc gì vào 19 truy vấn bên dưới, nên `await` tại
   * chỗ này biến trang chủ thành HAI PHA NỐI TIẾP: chờ KPI xong rồi mới bắt đầu phần còn lại.
   *
   * Đo trên production 10/09/2026 trước khi sửa: trang chủ 40.704ms và quá hạn 60 giây trong smoke.
   * Gộp vào cùng một lượt thì tổng thời gian bằng truy vấn CHẬM NHẤT, không phải tổng hai pha.
   */
  const prevPeriod = previousPeriod(period);
  const currentPromise = orderKpis(period.from, period.to);
  const previousPromise = prevPeriod.from ? orderKpis(prevPeriod.from, prevPeriod.to) : Promise.resolve(null);

  // ĐO TRƯỚC, SỬA SAU (TASK 16): Tổng quan là trang chậm nhất — 324ms so với 40ms của trang kế
  // tiếp — vì 15 truy vấn độc lập chạy NỐI TIẾP, mỗi cái chờ cái trước xong. Chúng không phụ
  // thuộc nhau nên gom vào một lượt; số liệu không đổi một chữ số nào, chỉ hết chờ vô ích.
  // MỘT bảng dẫn xuất dùng chung cho cả hai truy vấn theo ngày và theo kênh: cùng population
  // ("đơn đã xác nhận"), cùng kỳ, và kết quả đơn tính đúng một lần cho mỗi đơn.
  const scopeFacts = orderMetricFacts(db, metricScope(period, "confirmed"));
  const scopeMetrics = factMetrics(scopeFacts);

  const [
    stageRows,
    dailyRows,
    channelRows,
    shipmentRows,
    codRows,
    expenseRows,
    adsRows,
    failedDeliveryRows,
    stockRisk,
    staleRows,
    newOrderRows,
    codCash,
    financial,
    tower,
    recentOrders,
    topProducts,
    lastSyncRows,
    orderTotalRows,
    current,
    previous,
  ] = await Promise.all([
    // Trạng thái đơn theo giai đoạn
    db
      .select({ stage: schema.orders.stage, count: count(), revenue: sum(schema.orders.totalPriceAfterDiscount) })
      .from(schema.orders)
      .where(inPeriod(schema.orders.insertedAt, period.from, period.to))
      .groupBy(schema.orders.stage),
    // Doanh thu theo ngày (giờ VN) — trên bảng dẫn xuất, kết quả đơn tính một lần cho mỗi đơn
    // JIT tat: chuoi doanh thu theo ngay do duoc 8.024ms trong luot probe.
    chayKhongJit(db, (tx) =>
      tx
        .select({
          day: scopeFacts.day,
          orders: count(),
          revenue: sum(scopeFacts.revenue),
          success: sql<number>`sum(case when ${scopeMetrics.isDelivered} then 1 else 0 end)`,
          successRevenue: sql<number>`sum(case when ${scopeMetrics.isDelivered} then ${scopeFacts.revenue} else 0 end)`,
        })
        .from(scopeFacts)
        .groupBy(scopeFacts.day)
        .orderBy(scopeFacts.day),
    ),
    // Theo kênh bán — cùng bảng dẫn xuất, cùng lý do.
    chayKhongJit(db, (tx) =>
      tx
        .select({ source: scopeFacts.source, orders: count(), revenue: sum(scopeFacts.revenue), success: sql<number>`sum(case when ${scopeMetrics.isDelivered} then 1 else 0 end)` })
        .from(scopeFacts)
        .groupBy(scopeFacts.source)
        .orderBy(desc(sum(scopeFacts.revenue))),
    ),
    // Vận đơn theo giai đoạn (toàn bộ đang hoạt động, không theo kỳ)
    db.select({ stage: schema.shipments.stage, count: count(), cod: sum(schema.shipments.codAmount) }).from(schema.shipments).groupBy(schema.shipments.stage),
    // COD
    db.select({ status: schema.shipments.codStatus, count: count(), amount: sum(schema.shipments.codAmount) }).from(schema.shipments).where(ne(schema.shipments.codStatus, "NOT_APPLICABLE")).groupBy(schema.shipments.codStatus),
    // Chi phí vận hành trong kỳ: không gồm quảng cáo (đã lấy từ tài khoản QC) và nhập hàng (đã nằm trong giá vốn)
    // MỘT đường duy nhất qua Profit Engine: thẻ này và báo cáo lợi nhuận không được nói hai con số.
    getOperatingCost(period),
    db
      .select({ amount: sum(schema.adSpends.spend) })
      .from(schema.adSpends)
      .where(and(eq(schema.adSpends.excluded, false), period.from ? gte(schema.adSpends.spendDate, period.from) : undefined, period.to ? lte(schema.adSpends.spendDate, period.to) : undefined)),
    db.select({ count: count() }).from(schema.shipments).where(inArray(schema.shipments.stage, ["DELIVERY_FAILED", "RETURNING"])),
    // THIẾU HÀNG TÍNH THEO RỦI RO, KHÔNG THEO NGƯỠNG CỨNG — cùng bộ máy days-of-cover với trang
    // Kế hoạch SX và cảnh báo vận hành, nên ba nơi không thể ra ba con số khác nhau (F5).
    // ═══ SỔ KHO KHÔNG ĐƯỢC GIỮ TRANG CHỦ LÀM CON TIN ═══
    //
    // SỰ CỐ THẬT (10/09/2026): trang chủ quá hạn 60 giây, ba lượt đo liên tiếp. Đo bằng perf-probe
    // trên máy rảnh: `getDashboardData` mất 71,8 GIÂY, và câu lệnh nặng nhất là sổ kho — 61,4s,
    // trong khi một giờ trước đó nó là 32,5s. Chi phí này có sẵn từ lâu; nó vừa vượt ngưỡng.
    //
    // Trang chủ cần đúng MỘT con số từ đây: bao nhiêu mẫu mã cần sản xuất gấp. Bắt cả trang — doanh
    // thu, đơn mới, COD, cảnh báo — chờ một phút vì một dòng chữ ở chân thẻ là đổi sai.
    //
    // Nên đặt hạn chờ. Quá hạn thì con số đó là CHƯA TÍNH ĐƯỢC (không phải 0 — 0 nghĩa là "không
    // mẫu nào cần sản xuất gấp", một câu nói dối đúng theo hướng dễ chịu). Phép tính vẫn chạy tiếp
    // phía sau và ghi vào đệm, nên lượt mở sau đã có số.
    //
    // Đây KHÔNG phải bản vá cho truy vấn chậm: sổ kho vẫn chậm và vẫn phải sửa. Nó chỉ chặn việc
    // một mục nặng kéo sập cả trang.
    coHanCho(stockRiskSummary(), TRAN_SO_KHO_MS),
    db
      .select({ count: count() })
      .from(schema.shipments)
      .where(and(inArray(schema.shipments.stage, ["PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY"]), lte(schema.shipments.updatedAt, new Date(Date.now() - 4 * 86_400_000)))),
    db.select({ count: count() }).from(schema.orders).where(eq(schema.orders.stage, "NEW")),
    // COD đã thu chờ về / đã về ngân hàng: cùng cách tính với Báo cáo lợi nhuận & Đối soát COD
    codCashSummary(period),
    // BA CON SỐ TIỀN và SỐ VI PHẠM NGHIÊM TRỌNG lấy từ đúng nơi định nghĩa chúng, không tính lại.
    getFinancialTruth(period),
    getControlTower(),
    db.query.orders.findMany({
      orderBy: [desc(schema.orders.insertedAt)],
      limit: 8,
      columns: { id: true, systemId: true, billFullName: true, billPhone: true, source: true, stage: true, totalPriceAfterDiscount: true, insertedAt: true, itemsCount: true },
      with: { shipment: { columns: { stage: true, carrier: true } }, items: { columns: { productName: true, variationDetail: true, quantity: true }, limit: 2 } },
    }),
    // TOP MẪU MÃ — xếp theo DOANH THU GIAO THÀNH CÔNG, không theo số lượng lên đơn.
    getProductIntelligence({ period, limit: 6 }),
    db.select().from(schema.syncRuns).where(isNotNull(schema.syncRuns.finishedAt)).orderBy(desc(schema.syncRuns.startedAt)).limit(3),
    db.select({ count: count() }).from(schema.orders),
    currentPromise,
    previousPromise,
  ]);

  const byStage = Object.fromEntries(stageRows.map((r) => [r.stage, { count: Number(r.count), revenue: Number(r.revenue ?? 0) }])) as Record<OrderStage, { count: number; revenue: number }>;
  const daily = dailyRows.map((r) => ({ day: r.day, orders: Number(r.orders), revenue: Number(r.revenue ?? 0), success: Number(r.success ?? 0), successRevenue: Number(r.successRevenue ?? 0) }));
  const channels = channelRows.map((r) => ({ source: r.source, orders: Number(r.orders), revenue: Number(r.revenue ?? 0), success: Number(r.success ?? 0) }));
  const shipmentsByStage = Object.fromEntries(shipmentRows.map((r) => [r.stage, { count: Number(r.count), cod: Number(r.cod ?? 0) }])) as Record<ShipmentStage, { count: number; cod: number }>;
  const cod = Object.fromEntries(codRows.map((r) => [r.status, { count: Number(r.count), amount: Number(r.amount ?? 0) }]));
  const expense = expenseRows;
  const [ads] = adsRows;
  const [failedDelivery] = failedDeliveryRows;
  const [stale] = staleRows;
  const [newOrders] = newOrderRows;
  const [orderTotal] = orderTotalRows;

  const netRevenue = current.successRevenue;
  const realized = codCash.codPaid.amount;
  const expenses = Number(expense?.amount ?? 0);
  const adSpend = Number(ads?.amount ?? 0);
  /*
    MỘT CÔNG THỨC LỢI NHUẬN ƯỚC TÍNH — CỦA SỰ THẬT TÀI CHÍNH.

    Trước đây thẻ này tự cộng cước theo `orders.partner_fee` của MỌI đơn không huỷ trong kỳ (kể cả
    đơn mới, đang giao, chưa rõ) và phí hoàn của mọi đơn không huỷ, rồi trỏ sang tab Sự thật tài
    chính — nơi cước chỉ tính cho đơn đã giao + đơn hoàn và phí hoàn chỉ cho đơn hoàn. Cùng nhãn,
    cùng kỳ, hai con số. Nay cước và phí hoàn lấy đúng từ bậc thang của Sự thật tài chính; doanh thu
    và giá vốn vẫn là của `orderKpis` (cùng population, cùng bộ lọc — đã khoá bằng
    tests/metrics-contract.test.ts) và bằng đúng hai dòng đầu của bậc thang.
  */
  const line = (key: string) => Math.abs(financial.waterfall.find((l) => l.key === key)?.amount ?? 0);
  const shipping = line("shipping_out");
  const returnFee = line("shipping_return");
  // Giá vốn LẤY TỪ CHÍNH `orderKpis` — cùng population, cùng bộ lọc với doanh thu giao thành công.
  // Trước đây đây là một truy vấn riêng THIẾU bộ lọc đơn đã xác nhận, nên lợi nhuận ước tính lấy
  // doanh thu của một tập đơn và giá vốn của một tập đơn khác (F4).
  const successCogs = current.successCogs;
  const estimatedProfit = netRevenue - successCogs - shipping - returnFee - adSpend - expenses;

  return {
    period,
    kpi: current,
    previous,
    byStage,
    daily,
    channels,
    shipmentsByStage,
    cod,
    realized: { amount: realized, count: codCash.codPaid.source === "statements" ? codCash.codPaid.batches.count : codCash.codPaid.count, source: codCash.codPaid.source, net: codCash.cashInCod },
    finance: { netRevenue, successCogs, shipping, returnFee, adSpend, expenses, estimatedProfit },
    attention: {
      newOrders: Number(newOrders?.count ?? 0),
      failedDelivery: Number(failedDelivery?.count ?? 0),
      lowStock: stockRisk ? stockRisk.atRisk : null,
      staleShipments: Number(stale?.count ?? 0),
      codWaiting: { count: codCash.codWaiting.count, amount: codCash.codWaiting.amount, collected: codCash.codWaiting.collected, deductedByStatements: codCash.codWaiting.deductedByStatements },
    },
    stockRisk,
    /** Ba con số tiền tách bạch + lợi nhuận góp — dùng lại từ lib/queries/financial-truth.ts. */
    money: {
      booked: financial.revenue.booked,
      delivered: financial.revenue.delivered,
      cashReceived: financial.cash.total,
      codOutstanding: financial.cod.outstanding,
      codOutstandingCount: financial.cod.outstandingCount,
      contribution: financial.contribution,
      realizedProfit: financial.realizedProfit,
      /**
       * Hai tỷ lệ quảng cáo — dùng CHUNG công thức với Báo cáo lợi nhuận (`adsRatio`), không viết
       * lại. Mẫu số khác nhau có chủ đích và KHÔNG thay thế cho nhau: một bên là số khách chốt,
       * một bên là số hàng thật sự tới tay khách.
       */
      adsOverBooked: adsRatio(adSpend, financial.revenue.booked),
      adsOverDelivered: adsRatio(adSpend, financial.revenue.delivered),
    },
    /** Vi phạm dữ liệu mức NGHIÊM TRỌNG — số liệu đang sai, không phải việc vận hành. */
    dataIssues: { critical: tower.totals.ERROR, firing: tower.firing, ruleCount: tower.ruleCount },
    recentOrders,
    topProducts,
    lastSyncRows,
    orderTotal: Number(orderTotal?.count ?? 0),
    todayKey: vnDateKey(new Date()),
  };
}

export type DashboardData = Awaited<ReturnType<typeof getDashboardData>>;

/**
 * Hạn chờ cho một mục KHÔNG thiết yếu của trang chủ.
 *
 * Quá hạn thì trả `null` (CHƯA BIẾT) chứ không phải giá trị mặc định — và phép tính vẫn chạy tiếp
 * để ghi vào đệm, nên lượt mở sau không phải trả giá lại từ đầu.
 */
const TRAN_SO_KHO_MS = 3_000;

function coHanCho<T>(p: Promise<T>, ms: number): Promise<T | null> {
  // Nuốt lỗi của lượt bị bỏ lại: nó không còn ai đọc, nhưng một lời hứa bị từ chối mà không ai bắt
  // sẽ làm sập tiến trình Node.
  p.catch(() => {});
  return Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);
}

export async function getDashboardData(period: Period) {
  // TTL 60 giây quá ngắn cho một trang tốn hàng chục giây khi đệm nguội: người thứ hai mở trang
  // trong cùng phút được hưởng đệm, người mở sau 61 giây lại trả giá đầy đủ. Năm phút là khoảng mà
  // số liệu vẫn còn tươi với người vận hành nhưng chi phí dựng lại giảm ba lần.
  return memo(`getDashboardData:${periodKey(period)}`, 300_000, () => getDashboardDataUncached(period));
}
