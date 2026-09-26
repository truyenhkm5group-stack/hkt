import { and, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { adsRatio, adsRatios, type AdsRatios } from "@/lib/constants/profit";
import { CONFIRMED_STAGES } from "@/lib/queries/expenses";
import { memo, periodKey } from "@/lib/cache";
import { DEFAULT_PROFIT_ASSUMPTIONS, FALLBACK_SHIP_FEE_DELIVERED, fixedCostForPeriod, opsCosts, periodMonths, PROFIT_ASSUMPTIONS_KEY, rescuedFromRate, type ProfitAssumptions } from "@/lib/constants/profit";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { LINE_MARKETER_PRICE } from "@/lib/queries/marketer-price";
import type { Period } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";
import { getOperatingCost } from "@/lib/queries/cost-engine";
import { CARRIER_HANDOFF_AT_SQL, FINAL_OUTCOME_AT_SQL, type TimeBasis } from "@/lib/constants/report-time-basis";
import { distributeProportionally, inventoryRiskExposure, inventoryRiskOnSold } from "@/lib/constants/cost-allocation";
import { parseDeliveryRateOverride, resolveDeliveryRate, type DeliveryRateOverride } from "@/lib/constants/delivery-rate";
import { getProjectedDeliveryMetrics, type BacktestSummary } from "@/lib/queries/projected-delivery";
import { NO_ORDER_VALUE_FILTER, orderValueActive, orderValueKey, orderValueMatches, orderValueWhereSql, type OrderValueFilter } from "@/lib/constants/order-value";
import { erpStockExpr, LAST_RECEIPT_COST, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { FINISHED_OUTCOMES_SQL, RETURNED_OUTCOMES_SQL } from "@/lib/constants/truth";
import { ESTIMATED_COST_KEY, estimatedCostsWithMarketerPrice, parseEstimatedCosts, type EstimatedCost, type EstimatedCostMap } from "@/lib/constants/estimated-cost";
import { marketerPriceEntriesByProduct } from "@/lib/queries/marketer-price";

const o = schema.orders;
const s = schema.shipments;
const i = schema.orderItems;
const pv = schema.productVariants;
const p = schema.products;
const ads = schema.adSpends;

const NOT_CANCELLED = sql`${o.stage} not in ('CANCELLED','DELETED')`;
const IS_RETURNED = sql`${ORDER_OUTCOME_FAST} in (${sql.raw(RETURNED_OUTCOMES_SQL)})`;

/**
 * ═══════════ MỐC COHORT LÀ MỘT LỰA CHỌN CÓ TÊN, KHÔNG PHẢI MỘT HẰNG SỐ ═══════════
 *
 * Mặc định `ORDERED` (ngày tạo đơn) — đúng câu hỏi bảng lợi nhuận trả lời: *"đơn chốt trong khoảng
 * này ra bao nhiêu tiền"*, và là mốc duy nhất so sánh được với chi phí quảng cáo cùng khoảng. Giữ
 * mặc định nghĩa là không con số nào của kỳ đang xem bị xê dịch.
 *
 * Nhưng trang Tỷ lệ giao thành công mặc định `SHIPPED`, nên CÙNG một mã trong CÙNG 30 ngày ra hai
 * con số ở hai màn hình — hai câu trả lời đúng cho hai câu hỏi khác nhau, mà người đọc không có
 * cách nào biết điều đó. Nay mốc là một ô chọn ở CẢ HAI trang: đặt cả hai về cùng một mốc thì hai
 * màn hình phải nói CÙNG một số, và `tests/projected-delivery.test.ts` khoá đúng điều ấy.
 *
 * Ba biểu thức lấy nguyên từ `lib/constants/report-time-basis.ts` — không viết lại ở đây, vì hai
 * bản chép tay của cùng một mốc là đúng thứ làm hai trang trôi xa nhau.
 */
function mocCuaBasis(basis: TimeBasis): SQL {
  if (basis === "ORDERED") return sql`${o.insertedAt}`;
  return sql.raw(basis === "SHIPPED" ? CARRIER_HANDOFF_AT_SQL : FINAL_OUTCOME_AT_SQL);
}

/**
 * `moc is not null` CHỈ áp cho mốc khác `ORDERED`: đơn chưa bàn giao ĐVVC không có `handoff_at`, và
 * một đơn không có mốc thì nằm NGOÀI cohort chứ không phải trong cohort với giá trị 0 (§42).
 */
function periodCond(from: Date | null, to: Date | null, basis: TimeBasis = "ORDERED"): SQL[] {
  if (basis === "ORDERED") {
    const conds: SQL[] = [];
    if (from) conds.push(gte(o.insertedAt, from));
    if (to) conds.push(lte(o.insertedAt, to));
    return conds;
  }
  const moc = mocCuaBasis(basis);
  const conds: SQL[] = [];
  if (from) conds.push(sql`${moc} >= ${from}`);
  if (to) conds.push(sql`${moc} <= ${to}`);
  if (from || to) conds.push(sql`${moc} is not null`);
  return conds;
}

export type ResolvedAssumptions = ProfitAssumptions & {
  shipFeeDeliveredUsed: number;
  shipFeeReturnedUsed: number;
  shipFeeSource: "setting" | "data" | "fallback";
  /** Phí hoàn về bình quân đọc được từ dữ liệu (đơn hoàn có return_fee > 0), 0 = chưa có dữ liệu */
  returnFeeFromData: number;
  /** Số đơn hoàn 90 ngày có ghi phí hoàn về */
  returnFeeSample: number;
};

/**
 * Đọc giả định + tự tính cước từ dữ liệu 90 ngày cho ô để trống:
 *  - cước gửi/đơn: bình quân cước ĐVVC của đơn đã giao (Pancake partner_fee / shipments.shipping_fee), không có thì 17.000đ;
 *  - cước đơn hoàn: cước gửi + phí hoàn về bình quân của các đơn hoàn CÓ ghi phí hoàn; Pancake/Viettel Post webhook không đẩy phí hoàn nên
 *    thường bằng 0 → giả định phí hoàn về = cước gửi (đơn hoàn tốn gấp đôi). Nhập tay ở "Sửa giả định" nếu hợp đồng VTP khác.
 */
export async function resolveAssumptions(): Promise<ResolvedAssumptions> {
  const db = await getDb();
  const saved = await getSettingJson<ProfitAssumptions>(PROFIT_ASSUMPTIONS_KEY, DEFAULT_PROFIT_ASSUMPTIONS);
  let shipFeeDeliveredUsed = Math.max(0, Number(saved.shipFeeDelivered) || 0);
  let shipFeeReturnedUsed = Math.max(0, Number(saved.shipFeeReturned) || 0);
  let shipFeeSource: ResolvedAssumptions["shipFeeSource"] = "setting";
  let returnFeeFromData = 0;
  let returnFeeSample = 0;
  if (!shipFeeDeliveredUsed || !shipFeeReturnedUsed) {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const [row] = await db
      .select({
        delivered: sql<number>`avg(nullif(coalesce(nullif(${s.shippingFee}, 0), ${o.partnerFee}), 0)) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
        returnFee: sql<number>`avg(nullif(${o.returnFee}, 0)) filter (where ${IS_RETURNED})`,
        returnFeeSample: sql<number>`count(*) filter (where ${IS_RETURNED} and ${o.returnFee} > 0)`,
      })
      .from(o)
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .where(gte(o.insertedAt, since));
    const d = Math.round(Number(row?.delivered ?? 0));
    returnFeeFromData = Math.round(Number(row?.returnFee ?? 0));
    returnFeeSample = Number(row?.returnFeeSample ?? 0);
    if (!shipFeeDeliveredUsed) {
      shipFeeDeliveredUsed = d || FALLBACK_SHIP_FEE_DELIVERED;
      shipFeeSource = d ? "data" : "fallback";
    }
    if (!shipFeeReturnedUsed) {
      shipFeeReturnedUsed = shipFeeDeliveredUsed + (returnFeeFromData || shipFeeDeliveredUsed);
      if (shipFeeSource === "setting") shipFeeSource = returnFeeFromData ? "data" : "fallback";
    }
  }
  return { ...saved, shipFeeDeliveredUsed, shipFeeReturnedUsed, shipFeeSource, returnFeeFromData, returnFeeSample };
}

/** Trạng thái hành trình cho biết đã từng phát không thành (Pancake: "Tồn - …", "Phát tiếp"; Viettel Post: 505/506/507/508) */
const FAILED_EVENT = sql`(${schema.shipmentEvents.status} ilike 'Tồn%' or ${schema.shipmentEvents.status} ilike 'Phát tiếp%' or ${schema.shipmentEvents.status} in ('505','506','507','508'))`;

/** Số đơn "cứu được": đã từng phát không thành nhưng cuối cùng giao thành công, gộp theo mã hàng (đơn đã xác nhận lên trong kỳ) */
export async function rescuedOrdersByProduct(period: Period, basis: TimeBasis = "ORDERED"): Promise<Map<string, number>> {
  const db = await getDb();
  const rows = await db
    .select({
      productId: sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`,
      rescued: sql<number>`count(distinct ${o.id})`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .innerJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .where(
      and(
        eq(i.isBonus, false),
        inArray(o.stage, [...CONFIRMED_STAGES]),
        sql`${ORDER_OUTCOME_FAST} = 'DELIVERED'`,
        sql`exists (select 1 from ${schema.shipmentEvents} where ${schema.shipmentEvents.shipmentId} = ${s.id} and ${FAILED_EVENT})`,
        ...periodCond(period.from, period.to, basis),
      ),
    )
    .groupBy(sql`1`);
  return new Map(rows.filter((r) => r.productId).map((r) => [r.productId, Number(r.rescued)]));
}

export type ProductReturnHistory = { productId: string; finished: number; returned: number; rate: number | null };

/** Tỷ lệ hoàn lịch sử theo sản phẩm trong N ngày gần nhất (đơn có kết quả: giao thật + hoàn) */
export async function productReturnHistory(windowDays: number): Promise<Map<string, ProductReturnHistory>> {
  const db = await getDb();
  const since = new Date(Date.now() - windowDays * 86_400_000);
  /*
    ═══════════ CÂU CHẬM NHẤT CỦA CẢ HỆ THỐNG — VÀ 98% THỜI GIAN LÀ BIÊN DỊCH ═══════════

    ĐO TRÊN PRODUCTION 22/09/2026 (`ops perf-probe`, kế hoạch thực thi thật của chính câu này):

        cost=1300.84..2033735.80        chi phí ƯỚC LƯỢNG 2 triệu (ngưỡng bật JIT: 100.000)
        Buffers: shared hit=28055       đọc 100% từ đệm — KHÔNG chạm đĩa một lần nào
        JIT: Functions: 357
             Optimization 3111 ms · Emission 2524 ms · Total 5766,034 ms
        Execution Time: 5876,015 ms     ⇒ biên dịch chiếm 98,1%

    Dấu vân tay nằm ngay ở nút đáy: `Seq Scan on order_items … actual time=5731.966..5733.397
    rows=3302`. Quét 3.302 dòng mất 1,4 ms; 5.731 ms còn lại là thời gian ĐỨNG CHỜ trước khi dòng
    đầu tiên ra — chỗ PostgreSQL tính giờ biên dịch JIT.

    Chi phí ước lượng 2 triệu KHÔNG đến từ khối lượng dữ liệu (3.302 dòng, 8 mã hàng). Nó đến từ
    `ORDER_OUTCOME_FAST` và `PRIMARY_ATTEMPT` — hai truy vấn con tương quan bị nội tuyến lại vào
    TỪNG cột `filter (where …)`. Cùng hình dạng đã cắn `marketing-daily` (4.048ms → 276ms),
    `sales-funnel` và `staff-performance`; đây là tệp thứ tư mang nó.

    VÌ SAO CHỈ MỘT CÂU MÀ SỬA ĐƯỢC NHIỀU MÀN HÌNH: `productReturnHistory` nằm dưới
    `productDeliveryRates` (đệm 90 giây, dùng chung), nên LƯỢT ĐẦU của Báo cáo lợi nhuận danh
    nghĩa, `/ads/daily` và mọi bảng bóc tách marketing đều trả đúng khoản 5,7 giây này.

    Không tắt JIT toàn máy chủ — `set local` chỉ sống trong giao dịch này (xem `chayKhongJit`).
    Cùng truy vấn, cùng kết quả, cùng thứ tự.
  */
  const rows = await chayKhongJit(db, (tx) =>
    tx
      .select({
        productId: sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`,
        finished: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} in (${sql.raw(FINISHED_OUTCOMES_SQL)}))`,
        returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .where(and(gte(o.insertedAt, since), eq(i.isBonus, false)))
      .groupBy(sql`1`),
  );
  const map = new Map<string, ProductReturnHistory>();
  for (const r of rows) {
    const finished = Number(r.finished);
    const returned = Number(r.returned);
    if (r.productId) map.set(r.productId, { productId: r.productId, finished, returned, rate: finished ? (returned / finished) * 100 : null });
  }
  return map;
}

export type NominalRow = {
  productId: string;
  productName: string;
  code: string;
  image: string | null;
  orders: number;
  /** Đơn đã xác nhận chia đều cho các mã trong đơn (1/N) — cộng mọi mã = số đơn đếm 1 lần (khớp thẻ "Đơn đã xác nhận") */
  ordersWeighted: number;
  items: number;
  grossSales: number;
  /** Doanh số ĐƠN sau giảm giá phân bổ cho mã theo tỷ trọng tiền hàng — cộng mọi mã = thẻ "Doanh số đơn đã xác nhận" */
  salesAfterDiscount: number;
  adSpend: number;
  /** CPQC ÷ doanh số POS / ÷ DT đã giao thật / ÷ DT GTC ước tính — một hàm, xem `adsRatios`. */
  ads: AdsRatios;
  /**
   * Tỷ lệ hoàn ước tính (%) = 100 − `deliveryRate`. Xem `returnRateSource` để biết nó từ đâu ra.
   * `null` = CHƯA ĐO ĐƯỢC (`unmeasured`) — không phải 0, không phải giả định.
   */
  returnRate: number | null;
  /** TỶ LỆ GIAO THÀNH CÔNG ước tính (%) — chỉ số hiển thị chính. `null` = chưa đo được. */
  deliveryRate: number | null;
  /**
   * `override`   — chủ shop gõ tay, THẮNG mọi nguồn khác.
   * `projected`  — hợp đồng `PROJECTED_GTC_V4`: mỗi đơn cân theo xác suất của CHÍNH trạng thái ĐVVC nó đang ở.
   * `unmeasured` — mô hình có cohort nhưng CHƯA ĐO ĐƯỢC (phần ngoài ước tính quá lớn / chưa đủ mẫu).
   *                KHÔNG lùi về lịch sử hay giả định: một con số đoán trông y hệt con số đo được.
   * `blended`    — mã CHƯA CHÍN: số đo của CHÍNH MÃ co ngót về tỷ lệ khai ở Giả định.
   *                KHÔNG mượn tỷ lệ nền toàn shop — xem `lib/constants/delivery-rate.ts`.
   * `history`    — tỷ lệ hoàn lịch sử của mã — chỉ khi mã KHÔNG có đơn nào trong cohort mô hình.
   * `default`    — giả định chung của shop; yếu nhất, cùng điều kiện với `history`.
   */
  returnRateSource: "override" | "projected" | "blended" | "unmeasured" | "history" | "default";
  /** Xuất xứ con số ước tính — để màn hình nói ra thay vì để người đọc đoán. */
  projection: { eligibleSent: number; active: number; unmodelledActive: number; pending: number; pendingUnmodelled: number; awaitingPickup: number; unmodelledRevenue: number;
    /** Đơn CỦA CHÍNH MÃ đã đi tới kết cục trong cohort — thước đo con số kia dựa trên bao nhiêu sự thật. */
    finished: number } | null;
  /**
   * `ORDER_LEVEL` — DT/giá vốn GTC ước tính cân THEO TỪNG ĐƠN (nguồn `projected` / `unmeasured`).
   * `RATE`        — Doanh số POS × TL GTC — chỉ cho nguồn ghi đè / lịch sử / mặc định ("ước tính theo tỷ lệ").
   */
  revenueBasis: "ORDER_LEVEL" | "RATE";
  /** Doanh số POS của đơn NGOÀI ước tính (trạng thái chưa đủ mẫu) — không nằm trong `expectedRevenue`. */
  unmodelledRevenue: number;
  /** Giá vốn có biết không: `false` khi có sản phẩm không phiếu nhập, không giá Pancake — giá vốn đang bị tính 0. */
  cogsKnown: boolean;
  /** Số sản phẩm bán ra KHÔNG có giá vốn THẬT (không phiếu nhập, không giá Pancake) — kể cả phần đã được lấp bằng giá dự tính. */
  cogsUnknownQty: number;
  /**
   * GIÁ BÁO MKT: phần giá vốn MKT chịu THÊM (âm = ít hơn) so với giá vốn thật, ở mức giao thành công
   * ước tính. `0` khi mã chưa có giá báo áp được. CHỈ đường "theo MKT" đọc số này
   * (`getNominalMarketerBreakdown`); mọi cột của bảng theo mã vẫn đứng trên giá vốn thật.
   */
  marketerCostDelta: number;
  /**
   * Số sản phẩm vẫn CHƯA BIẾT giá vốn sau khi đã lấp giá dự tính — `0` khi mã có giá dự tính.
   * `cogsKnown` = (số này bằng 0).
   */
  cogsUncoveredQty: number;
  /** Giá vốn dự tính chủ shop đặt cho mã (chỉ khi báo cáo được gọi với `withEstimatedCost`). `null` = không có / không áp. */
  estimatedCost: EstimatedCost | null;
  /**
   * PHẦN của `expectedCogs` đến từ giá DỰ TÍNH, không phải chứng từ — tách riêng để màn hình dán
   * nhãn được (AGENTS.md mục 8.6). `0` khi không có giá dự tính.
   */
  expectedCogsEstimated: number;
  /**
   * Giá trị hàng nhập có biết không: `false` khi phiếu nhập trong kỳ có dòng KHÔNG ghi đơn giá VÀ mã
   * chưa có giá vốn dự tính để định giá phần đó (xem `valuePurchase`).
   */
  purchaseCostKnown: boolean;
  /** Số sản phẩm trên các dòng phiếu nhập KHÔNG ghi đơn giá (trước khi lấp giá dự tính). */
  purchaseUnpricedQty: number;
  /** PHẦN của `purchaseCost` định giá bằng giá DỰ TÍNH, không phải chứng từ — để màn hình dán nhãn (mục 8.6). */
  purchaseCostEstimated: number;
  /** LN theo hàng nhập tính được không — `false` khi giá trị hàng nhập chưa biết (mục 42: không in 0). */
  profitOnPurchaseKnown: boolean;
  /** Tỷ lệ hoàn lịch sử / mặc định dùng cho phần đơn chưa có kết quả (%) */
  baseReturnRate: number;
  historyFinished: number;
  /**
   * Mã đã đủ chín để máy tự đo chưa — số đơn đã kết thúc của CHÍNH MÃ đạt `minFinishedOrders`.
   * `false` ⇒ dòng thuộc bảng "Mã mới · chưa đủ căn cứ", nơi chủ shop đặt tay được tỷ lệ.
   */
  rateMature: boolean;
  /** Số đơn đã kết thúc của chính mã trong cohort — vạch tiến tới ngưỡng chín. */
  rateOwnFinished: number;
  /** Ghi đè tay đang áp cho mã này (đã chuẩn hoá). `null` = không có. */
  rateOverride: DeliveryRateOverride | null;
  /**
   * Bao nhiêu đơn kết thúc thì mã được coi là CHÍN (`minFinishedOrders` đang khai ở Giả định).
   * Đi kèm dòng chứ không để màn hình tự đọc lại giả định: hai nơi cùng nói "đủ mấy đơn" mà nói
   * hai số là cách chắc chắn để nhãn in ra không khớp với phép tính vừa chạy.
   */
  rateMatureAt: number;
  /**
   * TỶ LỆ GTC THẬT của chính mã trên đơn đã kết thúc (%). Đây là số đo thô, KHÔNG chứa xác suất
   * mượn — nó đứng cạnh `deliveryRate` để người đọc so được ước tính với thực tế.
   */
  measuredDeliveryRate: number | null;
  /** Phần tử số dự báo ĐI MƯỢN của mã khác (0–1). `null` = chưa đo được. */
  borrowedShare: number | null;
  /** Vì sao rơi xuống bậc co ngót — `IMMATURE` (đợi thêm đơn) hay `MOSTLY_BORROWED` (mô hình chưa biết mã này). */
  blendReason: "IMMATURE" | "MOSTLY_BORROWED" | null;
  expectedRevenue: number;
  expectedCogs: number;
  /**
   * SỐ SẢN PHẨM giao thành công ước tính — CÙNG phép cân với `expectedCogs`, nhưng đo được cả ở
   * mã chưa biết giá vốn (ở đó `expectedCogs` bị ép về 0).
   */
  expectedQty: number;
  shipCost: number;
  expectedProfit: number;
  margin: number | null;
  cpo: number | null;
  revenuePerOrder: number | null;
  /** Thực tế tới nay */
  delivered: number;
  returned: number;
  inTransit: number;
  /** Giao thất bại, chờ xử lý / chờ phát lại (nằm trong inTransit) */
  failed: number;
  pending: number;
  actualRevenue: number;
  /** Chi phí vận hành đã nhập ở bảng Chi phí trong kỳ, phân bổ theo tỷ trọng doanh số POS */
  operatingAlloc: number;
  /** Đơn giao thất bại rồi giao thành công (nhân viên vận đơn cứu được) */
  rescued: number;
  /** Chi phí đóng hàng = đơn gửi × đơn giá đóng hàng */
  packingCost: number;
  /** Chi phí nhân viên vận đơn = đơn × đơn giá + đơn cứu được × thưởng */
  opsStaffCost: number;
  /** Chi phí cố định (văn phòng, điện nước…) của kỳ phân bổ theo tỷ trọng doanh số POS */
  fixedAlloc: number;
  /** Tổng vận hành = CP vận hành đã nhập + đóng hàng + nhân viên vận đơn + cố định */
  opexTotal: number;
  /** Mọi chi phí ngoài tiền hàng / QC / vận chuyển = tổng vận hành + rủi ro tồn kho + thuế + CP khác */
  otherCostsTotal: number;
  /** Chi phí ngoài hàng-QC-VC / đơn lên (trước hoàn huỷ) */
  opexPerOrder: number | null;
  /** Chi phí ngoài hàng-QC-VC / đơn giao thành công ước tính (sau hoàn huỷ) */
  opexPerDelivered: number | null;
  /** Hàng nhập trong kỳ theo phiếu nhập (số lượng, giá trị) */
  purchaseQty: number;
  purchaseCost: number;
  /**
   * Dự phòng rủi ro tồn kho GHI VÀO KỲ = % giả định × GIÁ VỐN HÀNG BÁN RA trong kỳ.
   * KHÔNG phải % × giá trị hàng nhập: hàng nhập là sự kiện một lần, ném trọn vào kỳ chứa nó thì
   * tuần bán 100/1.000 đơn của lô vẫn gánh đủ dự phòng cả lô. Xem `lib/constants/cost-allocation.ts`.
   */
  inventoryRisk: number;
  /**
   * Rủi ro trên TOÀN BỘ hàng nhập trong kỳ (% × `purchaseCost`) — chỉ dùng cho bảng "LN theo hàng
   * nhập", nơi đã trừ trọn giá trị hàng nhập nên phải trừ trọn phần rủi ro đi kèm.
   */
  /**
   * GHI CHÚ, KHÔNG TRỪ VÀO LỢI NHUẬN: rủi ro CẢ ĐỜI của lô hàng nhập trong kỳ.
   *
   * Có ích để biết lô vừa nhập đang mang bao nhiêu rủi ro, nhưng nó là phơi nhiễm TẠI MỘT THỜI
   * ĐIỂM chứ không phải chi phí CỦA MỘT KỲ. Trừ nó vào lợi nhuận kỳ chứa phiếu nhập là bắt tuần
   * đó gánh rủi ro của hàng sẽ bán trong nhiều tháng tới.
   */
  inventoryRiskOnPurchase: number;
  /** Giá trị hàng còn trong kho của mã (chỉ mẫu mã đã có phiếu nhập) */
  stockValue: number;
  /** Tồn thực tế theo SỔ KHO (số lượng) — mốc để đối chiếu với phép trừ "nhập − giao TC". */
  stockQty: number;
  /** Mã đã có phiếu nhập chưa. `false` ⇒ tồn CHƯA BIẾT, màn hình in "—" chứ không in 0. */
  stockKnown: boolean;
  /** Hàng đã rời kho, đang trên đường (chưa kết thúc) — không nằm trong kho, cũng chưa tới khách. */
  outInTransitQty: number;
  /** Hàng phải quay về mà kho CHƯA lập phiếu tái nhập — chưa được cộng lại tồn (mục 10). */
  outAwaitingReturnQty: number;
  /** Rủi ro CÒN TREO trên hàng tồn = % × `stockValue` — memo, KHÔNG trừ vào lợi nhuận kỳ */
  inventoryRiskPending: number;
  /** LN theo tổng giá trị hàng nhập = DT GTC ƯT − CPQC − hàng nhập − VC − vận hành − rủi ro TK cả lô − thuế − CP khác */
  profitOnPurchase: number;
  marginOnPurchase: number | null;
  /** Dự trù thuế = DT GTC ước tính × % */
  tax: number;
  /** Chi phí khác = CPQC × % (phí thanh toán thẻ ngoại tệ…) */
  otherCost: number;
  /** LN ròng ước tính = LN danh nghĩa − tổng vận hành (đã nhập + đóng hàng + NV vận đơn + cố định) − rủi ro tồn kho − thuế − chi phí khác */
  netProfit: number;
  netMargin: number | null;
};

export type NominalReport = {
  assumptions: ResolvedAssumptions;
  rows: NominalRow[];
  /** Khoảng giá trị đơn đang lọc — màn hình phải in ra, không để người đọc đoán mình đang xem tập nào. */
  valueFilter: OrderValueFilter;
  /** Công tắc CPQC. `false` ⇒ mọi CPQC hiện 0 và lợi nhuận KHÔNG trừ quảng cáo (xem `ADS_EXCLUDED_NOTE`). */
  adsIncluded: boolean;
  /**
   * Tỷ trọng doanh số của tập đang lọc trong TOÀN KỲ — mẫu số đã dùng để chia CPQC và chi phí
   * chung. `1` khi không lọc. In ra để người đọc kiểm được vì sao chi phí chung nhỏ đi.
   */
  costShare: number;
  /** Đơn KHÔNG khai được giá trị (tổng tiền <= 0), rơi khỏi bộ lọc — đếm riêng, không giấu (mục 42). */
  unknownValueOrders: number;
  unmatchedAdSpend: number;
  /** Chi phí vận hành trong kỳ (bảng Chi phí, trừ Quảng cáo & Nhập hàng): lương, mặt bằng, phần mềm, đóng gói… */
  operatingExpenses: number;
  /** Số khoản chi vận hành trong kỳ */
  operatingCount: number;
  /** Số tháng của kỳ dùng quy đổi chi phí cố định (kỳ "Toàn bộ" tính từ đơn đầu tiên tới đơn cuối) */
  periodMonths: number;
  /** Chi phí cố định của kỳ = chi phí tháng × số tháng */
  fixedCost: number;
  totals: {
    /** Σ đơn theo mã (đơn nhiều mã đếm nhiều lần) */
    orders: number;
    /** Đơn đã xác nhận đếm 1 lần (khớp thẻ "Đơn đã xác nhận") — bằng Σ ordersWeighted các mã */
    ordersDistinct: number;
    ordersWeighted: number;
    /** Tổng tiền sau giảm giá của đơn đã xác nhận (khớp thẻ "Doanh số đơn đã xác nhận") */
    salesAfterDiscount: number;
    items: number;
    grossSales: number;
    adSpend: number;
    expectedRevenue: number;
    expectedCogs: number;
    /** Σ số sản phẩm giao thành công ước tính — đo được cả ở mã chưa biết giá vốn. */
    expectedQty: number;
    shipCost: number;
    /**
     * Phần của `shipCost` là cước / phí hoàn gõ tay khai ĐIỀU CHỈNH có lý do (Profit Engine) — tiền
     * THẬT, không phải ước tính; đã chia vào cột cước của từng mã theo số đơn. `count` là số khoản của
     * cả kỳ (không thu nhỏ theo bộ lọc bậc giá).
     */
    logisticsAdjustment: { amount: number; count: number };
    expectedProfit: number;
    margin: number | null;
    delivered: number;
    returned: number;
    inTransit: number;
    actualRevenue: number;
    /**
     * TL GTC ƯỚC TÍNH TOÀN SHOP (%) — ĐÚNG con số `orderLevel.projectedRate` của hợp đồng chung, cùng
     * mốc `ORDERED`, cùng kỳ. Trang hiệu quả theo mã hỏi cùng hợp đồng ở mốc của nó; cùng mốc thì
     * hai trang ra cùng một số. `null` = chưa đo được.
     */
    weightedDeliveryRate: number | null;
    weightedReturnRate: number | null;
    /**
     * Tỷ lệ bình quân theo đơn của các tỷ lệ ĐANG DÙNG trong phép tính tiền của từng dòng (kể cả
     * ghi đè tay, lịch sử, mặc định). Khác `weightedDeliveryRate` khi có ghi đè — hiện riêng, không
     * thay thế con số hợp đồng.
     */
    assumedDeliveryRate: number | null;
    /** Xuất xứ + nhãn tin cậy của `weightedDeliveryRate`, để in cạnh con số. */
    projection: { version: string; eligibleSent: number; active: number; unmodelledActive: number; pending: number; awaitingPickup: number; unmodelledRevenue: number; backtest: BacktestSummary | null; backtestError: string | null } | null;
    /** Lỗi khi tính ước tính — hiện đúng là LỖI, không hiện "chưa đủ dữ liệu". */
    projectionError: string | null;
    /** CPQC ĐÃ QUY KẾT về mã hàng (Σ các dòng). `adSpend` = số này + `unmatchedAdSpend`. */
    adSpendAttributed: number;
    /** Ba tỷ lệ QC trên TỔNG chi (kể cả chưa quy kết) — thẻ tổng của trang. */
    ads: AdsRatios;
    /** Ba tỷ lệ QC trên CPQC ĐÃ QUY KẾT — dòng tổng của bảng theo mã, để Σ dòng và dòng tổng nói cùng một tử số. */
    adsAttributed: AdsRatios;
    /** QC / Doanh số POS (%) — giữ để tương thích; = `ads.overPosSales`. */
    adsOverPosSales: number | null;
    /** QC / DT giao thành công THẬT (%) — giữ để tương thích; = `ads.overDeliveredActual`. */
    adsOverDeliveredRevenue: number | null;
    /** Đơn chưa gửi ĐVVC trong kỳ (theo hợp đồng) — phần doanh thu cân theo P(chưa gửi). */
    pendingOrders: number;
    /** Doanh số POS của đơn NGOÀI ước tính toàn shop. */
    unmodelledRevenue: number;
    cogsKnown: boolean;
    cogsUnknownQty: number;
    /** Σ sản phẩm vẫn chưa biết giá vốn sau khi đã lấp giá dự tính. */
    cogsUncoveredQty: number;
    /** Σ phần giá vốn đến từ giá DỰ TÍNH (đã nằm trong `expectedCogs`). */
    expectedCogsEstimated: number;
    /** Số mã đang dùng giá vốn dự tính (có sản phẩm thật sự được lấp). */
    estimatedCostProducts: number;
    purchaseCostKnown: boolean;
    /** Phần giá trị hàng nhập định giá bằng giá dự tính (xem `valuePurchase`). */
    purchaseCostEstimated: number;
    /** Số mã có phiếu nhập thiếu giá mà CHƯA có giá dự tính. */
    purchaseUnknownProducts: number;
    profitOnPurchaseKnown: boolean;
    operatingExpenses: number;
    rescued: number;
    packingCost: number;
    opsStaffCost: number;
    fixedCost: number;
    opexTotal: number;
    otherCostsTotal: number;
    inventoryRisk: number;
    inventoryRiskOnPurchase: number;
    stockValue: number;
    stockQty: number;
    /** `false` khi CÓ mã chưa có phiếu nhập nào ⇒ tổng tồn là CHƯA BIẾT, không phải một con số. */
    stockKnown: boolean;
    outInTransitQty: number;
    outAwaitingReturnQty: number;
    inventoryRiskPending: number;
    netProfit: number;
    failed: number;
    pending: number;
    tax: number;
    otherCost: number;
    opexPerOrder: number | null;
    opexPerDelivered: number | null;
    purchaseQty: number;
    purchaseCost: number;
    profitOnPurchase: number;
    marginOnPurchase: number | null;
    netMargin: number | null;
  };
};

/**
 * Tiền của một dòng từ tỷ lệ + giả định.
 *
 * `orderLevel` (khi có) THAY THẾ phép nhân `grossSales × (1 − r)` bằng doanh thu / giá vốn đã cân theo
 * từng đơn của hợp đồng — đúng thứ mà tooltip cột "DT GTC ƯT" vẫn khai từ trước nhưng mã chưa làm.
 * Cước vận chuyển vẫn đi theo tỷ lệ (số đơn × cước theo giao/hoàn) vì cước là theo ĐƠN, không theo tiền.
 *
 * `rate = null` (chưa đo được) ⇒ cước tính bằng cước gửi cho MỌI đơn (không biết đơn nào hoàn thì
 * không cộng phí hoàn của đơn nào) — và dòng mang nguồn `unmeasured` để màn hình nói rõ.
 */
function applyAssumptions(
  base: { orders: number; items: number; grossSales: number; cogsFull: number; adSpend: number; cogsUnknownQty?: number },
  rate: number | null,
  a: ResolvedAssumptions,
  orderLevel?: { revenue: number; cogs: number; qty: number; unknownQty?: number } | null,
  /** Giá vốn dự tính / sp cho phần sản phẩm CHƯA có giá thật — xem `lib/constants/estimated-cost.ts`. */
  estimatedUnitCost: number | null = null,
) {
  const r = rate === null ? 0 : Math.min(Math.max(rate, 0), 100) / 100;
  const expectedRevenue = orderLevel ? orderLevel.revenue : Math.round(base.grossSales * (1 - r));
  /*
    GIÁ DỰ TÍNH ĐI ĐÚNG ĐƯỜNG CỦA SỐ LƯỢNG: nhánh hợp đồng nhân với số sản phẩm-chưa-có-giá ĐÃ CÂN
    theo từng đơn (`projectedUnknownQty`), nhánh "theo tỷ lệ" nhân với số ấy × TL GTC. Không nhân
    với `expectedQty` của cả mã: mã có mẫu mã đã có phiếu nhập thì phần đó đã mang giá thật.
  */
  const soChuaCoGia = orderLevel ? (orderLevel.unknownQty ?? 0) : (base.cogsUnknownQty ?? 0) * (1 - r);
  const expectedCogsEstimated = estimatedUnitCost && estimatedUnitCost > 0 ? Math.round(soChuaCoGia * estimatedUnitCost) : 0;
  const expectedCogs = (orderLevel ? orderLevel.cogs : Math.round(base.cogsFull * (1 - r))) + expectedCogsEstimated;
  /*
    SỐ SẢN PHẨM GIAO THÀNH CÔNG ƯỚC TÍNH đi ĐÚNG cùng một đường với tiền: cân theo từng đơn ở
    nhánh hợp đồng, nhân tỷ lệ ở nhánh "ước tính theo tỷ lệ". Không được suy ra từ `expectedCogs`
    chia đơn giá — mẫu mã chưa biết giá vốn thì `expectedCogs` bằng 0 và phép chia ấy sẽ nói là
    "chưa giao được sản phẩm nào" trong khi số lượng vẫn đo được bình thường.
  */
  const expectedQty = orderLevel ? orderLevel.qty : Math.round(base.items * (1 - r));
  const shipCost = Math.round(base.orders * ((1 - r) * a.shipFeeDeliveredUsed + r * a.shipFeeReturnedUsed));
  const expectedProfit = expectedRevenue - expectedCogs - shipCost - base.adSpend;
  return { expectedRevenue, expectedCogs, expectedCogsEstimated, expectedQty, shipCost, expectedProfit, margin: expectedRevenue ? (expectedProfit / expectedRevenue) * 100 : null };
}

/**
 * ═══ GIÁ TRỊ HÀNG NHẬP CỦA MỘT MÃ, KHI PHIẾU NHẬP CÓ DÒNG KHÔNG GHI ĐƠN GIÁ ═══
 *
 * Chủ shop chốt 25/09/2026: dòng phiếu nhập không ghi đơn giá được định giá bằng GIÁ VỐN DỰ TÍNH
 * đặt tay ở "Bàn dự tính" — cùng một con số chủ shop đã khai cho mã. Trước đó phần này bị tính
 * 0 ₫ và cột "LN theo hàng nhập" in ra một khoản lãi giả (Q005 +42 tr, Q004 +23,6 tr trong khi toàn bộ
 * tiền hàng của hai mã chưa được trừ).
 *
 *   · Không có dòng thiếu giá            ⇒ giá trên phiếu, `known`.
 *   · Có dòng thiếu giá + có giá dự tính ⇒ phiếu + số sp thiếu giá × giá dự tính, `known`, phần
 *                                          dự tính tách riêng ở `estimated` để màn hình dán nhãn.
 *   · Có dòng thiếu giá, KHÔNG giá dự tính ⇒ CHƯA BIẾT (`known = false`) — LN theo hàng nhập cũng
 *                                          chưa biết, không bao giờ in bằng cách coi phần đó 0 ₫.
 *
 * CHỈ báo cáo lợi nhuận danh nghĩa dùng: `purchaseByProduct` giữ nguyên số trên phiếu, và lương
 * (`lib/queries/payroll.ts`) tự tính hàng nhập riêng, không đọc giá dự tính. Hàm THUẦN.
 */
export function valuePurchase(
  pur: { cost: number; unknownQty: number } | undefined,
  estimate: { unitCost: number } | null,
): { cost: number; known: boolean; unpricedQty: number; estimated: number } {
  if (!pur) return { cost: 0, known: true, unpricedQty: 0, estimated: 0 };
  const unpricedQty = Math.max(0, pur.unknownQty);
  if (unpricedQty === 0) return { cost: pur.cost, known: true, unpricedQty: 0, estimated: 0 };
  if (estimate && estimate.unitCost > 0) {
    const estimated = Math.round(unpricedQty * estimate.unitCost);
    return { cost: pur.cost + estimated, known: true, unpricedQty, estimated };
  }
  return { cost: pur.cost, known: false, unpricedQty, estimated: 0 };
}

/** Hàng nhập trong kỳ theo phiếu nhập (kind RECEIPT, số lượng dương) gộp theo mã */
export async function purchaseByProduct(period: Period): Promise<Map<string, { qty: number; cost: number; name: string; code: string; costKnown: boolean; unknownQty: number }>> {
  const db = await getDb();
  const conds: SQL[] = [eq(schema.stockReceipts.kind, "RECEIPT"), sql`${schema.stockReceiptItems.quantity} > 0`];
  if (period.from) conds.push(gte(schema.stockReceipts.receivedAt, period.from));
  if (period.to) conds.push(lte(schema.stockReceipts.receivedAt, period.to));
  const rows = await db
    .select({
      productId: pv.productId,
      name: sql<string>`max(${p.name})`,
      code: sql<string>`max(coalesce(${p.customId}, ''))`,
      qty: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}), 0)`,
      cost: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity} * ${schema.stockReceiptItems.unitCost}), 0)`,
      // Dòng phiếu nhập KHÔNG ghi đơn giá: giá trị hàng nhập đang bị tính 0 — là CHƯA BIẾT, không phải 0đ.
      unknownQty: sql<number>`coalesce(sum(${schema.stockReceiptItems.quantity}) filter (where coalesce(${schema.stockReceiptItems.unitCost}, 0) <= 0), 0)`,
    })
    .from(schema.stockReceiptItems)
    .innerJoin(schema.stockReceipts, eq(schema.stockReceipts.id, schema.stockReceiptItems.receiptId))
    .innerJoin(pv, eq(pv.id, schema.stockReceiptItems.variantId))
    .leftJoin(p, eq(p.id, pv.productId))
    .where(and(...conds))
    .groupBy(pv.productId);
  return new Map(rows.filter((r) => r.productId).map((r) => [r.productId as string, { qty: Number(r.qty), cost: Number(r.cost), name: r.name ?? "", code: r.code ?? "", costKnown: Number(r.unknownQty) === 0, unknownQty: Number(r.unknownQty) }]));
}

/** Tồn kho của một mã theo SỔ KHO, kèm hai nhóm hàng ĐÃ RỜI KHO mà chưa về lại. */
export type StockSnapshot = {
  /** Tồn thực tế (số lượng) theo sổ kho — chỉ mẫu mã đã có phiếu nhập. */
  qty: number;
  /** Giá trị tồn thực tế — cơ sở của phần rủi ro còn treo (memo). */
  value: number;
  /** Mã đã có ÍT NHẤT một phiếu nhập chưa. `false` ⇒ tồn là CHƯA BIẾT, không phải 0. */
  known: boolean;
  /** Hàng đã rời kho, đang trên đường, chưa kết thúc — không ở trong kho, cũng chưa tới khách. */
  inTransitQty: number;
  /** Hàng phải quay về mà kho CHƯA lập phiếu tái nhập — chưa được tính vào tồn (mục 10). */
  awaitingReturnQty: number;
};

/**
 * TỒN KHO THEO MÃ — cơ sở của phần rủi ro còn treo (memo) VÀ của phép đối chiếu
 * "hàng nhập − hàng đã giao thành công" ở bảng Lợi nhuận theo hàng nhập.
 *
 * Dùng lại đúng định nghĩa tồn của SỔ KHO (`lib/queries/stock.ts`), không tự dựng công thức tồn thứ
 * hai. Mẫu mã CHƯA CÓ PHIẾU NHẬP nào bị loại hẳn: ở đó "nhập = 0" là THIẾU DỮ LIỆU chứ không phải
 * "nhập 0 cái", lấy 0 trừ số đã xuất sẽ ra tồn âm bịa ra.
 *
 * ═══ VÌ SAO HAI NHÓM "ĐÃ RỜI KHO" ĐI CÙNG, CHỨ KHÔNG PHẢI MỘT CON SỐ TỒN TRƠ TRỌI ═══
 *
 * `SL nhập − SL giao thành công` KHÔNG bằng tồn kho, và khoảng cách giữa hai con số không nhỏ.
 * Đo production 21/09/2026, toàn bộ lịch sử:
 *
 *     mã     nhập   giao TC   nhập − giao   tồn SỔ KHO   hoàn chưa tái nhập
 *     Q002   1.374      321         1.053          352                  301
 *     Q003     388      230           158           −5                  184
 *     Q004     217       62           155           35                   48
 *     Q001     146       36           110           95                   47
 *     Q005      74        0            74            6                    0
 *     X001      40       14            26           26                    0
 *
 * Chênh lệch của Q002 là **701 cái** — gấp ba lần con số tồn thật. Nó không phải sai số làm tròn
 * mà là hai nhóm hàng CÓ THẬT: hàng đang trên đường, và hàng hoàn mà kho chưa đếm lại. In một
 * mình "nhập − giao" là khẳng định 701 cái ấy đang nằm trên kệ. Nên phép trừ chỉ được hiện KÈM
 * chỗ hàng thật sự đang ở.
 */
async function stockByProduct(): Promise<Map<string, StockSnapshot>> {
  const db = await getDb();
  /*
    JIT TẮT — đo production 24/09/2026 (ops perf-probe): câu này 4.908 ms trong `getNominalProfitReport`.
    Nó dựng trên đúng phép gộp `vsales` mà `lib/queries/stock.ts` đã đo 8.578 ms → 26 ms khi tắt JIT;
    trang Kế hoạch SX và bảng thiếu hàng đã bọc từ trước, riêng chỗ này sót.
  */
  const rows = await chayKhongJit(db, (tx) => {
    const salesAgg = variantSalesSubquery(tx);
    const receiptsAgg = variantReceiptsSubquery(tx);
    const unitCost = sql<number>`coalesce(nullif(${LAST_RECEIPT_COST}, 0), ${pv.lastImportedPrice}, 0)`;
    return tx
      .select({
        productId: pv.productId,
        qty: sql<number>`coalesce(sum(greatest(${erpStockExpr(salesAgg, receiptsAgg)}, 0)) filter (where ${stockKnownExpr(receiptsAgg)}), 0)`,
        value: sql<number>`coalesce(sum(greatest(${erpStockExpr(salesAgg, receiptsAgg)}, 0) * ${unitCost}) filter (where ${stockKnownExpr(receiptsAgg)}), 0)`,
        knownVariants: sql<number>`count(*) filter (where ${stockKnownExpr(receiptsAgg)})`,
        inTransitQty: sql<number>`coalesce(sum(coalesce(${salesAgg.inTransit}, 0)), 0)`,
        awaitingReturnQty: sql<number>`coalesce(sum(coalesce(${salesAgg.awaitingReturn}, 0)), 0)`,
      })
      .from(pv)
      .leftJoin(salesAgg, eq(salesAgg.variantId, pv.id))
      .leftJoin(receiptsAgg, eq(receiptsAgg.variantId, pv.id))
      .where(eq(pv.isRemoved, false))
      .groupBy(pv.productId);
  });
  return new Map(
    rows
      .filter((r) => r.productId)
      .map((r) => [
        r.productId as string,
        {
          qty: Number(r.qty),
          value: Number(r.value),
          known: Number(r.knownVariants) > 0,
          inTransitQty: Number(r.inTransitQty),
          awaitingReturnQty: Number(r.awaitingReturnQty),
        } satisfies StockSnapshot,
      ]),
  );
}

/** Mã chưa có phiếu nhập nào: tồn là CHƯA BIẾT (mục 10), không phải 0. */
const TON_CHUA_BIET: StockSnapshot = { qty: 0, value: 0, known: false, inTransitQty: 0, awaitingReturnQty: 0 };

/** Lợi nhuận danh nghĩa theo mã hàng: đơn lên trong kỳ × (1 − tỷ lệ hoàn ước tính) − giá vốn − vận chuyển − quảng cáo */
async function getNominalProfitReportUncached(period: Period, basis: TimeBasis, value: OrderValueFilter, includeAds: boolean, withEstimatedCost: boolean, withStock: boolean): Promise<NominalReport> {
  const locGiaTri = orderValueWhereSql(value);
  const dangLoc = orderValueActive(value);
  const db = await getDb();
  const assumptions = await resolveAssumptions();
  // Chỉ đọc khi được hỏi: mọi đường gọi khác (lương, marketer, AI) giữ nguyên giá vốn 0 ₫ = chưa biết.
  // Giá báo MKT hiệu lực vào CUỐI KỲ (luật 5) — kỳ "Toàn bộ" không có mốc cuối thì lấy hôm nay.
  const giaDuTinh: EstimatedCostMap = withEstimatedCost ? await getEstimatedCosts(period.to ?? new Date()) : {};
  /*
    MỘT NGUỒN cho tỷ lệ / doanh thu GTC ước tính — xem lib/constants/projected-delivery.ts.
    LỖI LÀ LỖI: hợp đồng hỏng thì bảng vẫn dựng được (tiền theo tỷ lệ lịch sử, có nhãn) nhưng lỗi
    được trả lên màn hình bằng tên của nó, không hoá thành "chưa đủ dữ liệu".
  */
  const duBaoHoacLoi = await getProjectedDeliveryMetrics(period, basis, "PRODUCT", value).then(
    (v) => ({ v, e: null as string | null }),
    (e: unknown) => ({ v: null, e: e instanceof Error ? e.message : String(e) }),
  );
  const duBaoGiaoVan = duBaoHoacLoi.v;
  const projectionError = duBaoHoacLoi.e;
  const [history, purchases, stocks] = await Promise.all([
    productReturnHistory(assumptions.returnRateWindowDays),
    purchaseByProduct(period),
    // Không đọc tồn ⇒ bản đồ RỖNG ⇒ mọi mã rơi về `TON_CHUA_BIET` (`stockKnown = false`, in "—"),
    // không bao giờ thành 0 cái. Xem tham số `withStock` ở `getNominalProfitReport`.
    withStock ? stockByProduct() : Promise.resolve(new Map<string, StockSnapshot>()),
  ]);
  // Khoá theo `product_id` — ĐÚNG khoá `coalesce(pv.product_id, order_items.product_id)` của bảng này,
  // không theo mã hàng (`custom_id` có thể trống hoặc trùng).
  const projected = new Map((duBaoGiaoVan?.rows ?? []).map((x) => [x.key, x]));
  const rescueRate = Number(assumptions.rescueRatePercent ?? 10);
  const taxPct = Math.max(0, Number(assumptions.taxPercent ?? 0)) / 100;
  const otherPct = Math.max(0, Number(assumptions.otherCostPercentOfAds ?? 0)) / 100;
  const adConds: SQL[] = [eq(ads.excluded, false)];
  if (period.from) adConds.push(gte(ads.spendDate, period.from));
  if (period.to) adConds.push(lte(ads.spendDate, period.to));

  // Chi phí vận hành phải dùng ĐÚNG khoảng của báo cáo: khoản theo kỳ được chia theo số ngày chồng
  // lấn, khoản một lần vẫn ghi trọn vào ngày phát sinh. Xem lib/queries/cost-allocation.ts.
  const PID = sql<string>`coalesce(${pv.productId}, ${i.productId}, '')`;
  const [sales, adRows, perOrder, operating] = await Promise.all([
    /*
      ═══ TẮT JIT CHO CÂU DOANH SỐ THEO MÃ — 24,96 TRÊN 25,2 GIÂY LÀ BIÊN DỊCH ═══

      `perf-probe` trên production 23/09/2026 (kế hoạch thực thi thật của chính câu này, kỳ 30 ngày):

          JIT: Functions: 1003
               Timing: Optimization 14.225 ms · Emission 10.488 ms · Total 24.960 ms
          Execution Time: 25.206 ms   ⇒ biên dịch chiếm 99%
          Seq Scan on order_items … actual time=24826..24829 rows=3378   ← 3 ms quét, 24,8 s đứng chờ

      Cùng dấu vân tay với `productReturnHistory` ngay trên: sáu cột `filter (where ORDER_OUTCOME…)`
      nội tuyến truy vấn con tương quan vào từng cột, đẩy chi phí ƯỚC LƯỢNG lên 2,3 triệu trong khi
      thật chỉ chạm 1.572 dòng. Từ #165 câu này nằm dưới cả bảng bóc tách MKTer của `/ads/daily`,
      nên báo cáo nguội mất 37–61 giây ở CẢ HAI trang. Cùng truy vấn, cùng kết quả — chỉ bỏ biên dịch.
    */
    chayKhongJit(db, (tx) =>
      tx
      .select({
        productId: PID,
        productName: sql<string>`max(coalesce(${p.name}, ${i.productName}))`,
        code: sql<string>`max(coalesce(${p.customId}, ''))`,
        image: sql<string | null>`max(coalesce(${p.image}, ${i.image}))`,
        orders: sql<number>`count(distinct ${o.id}) filter (where ${NOT_CANCELLED})`,
        items: sql<number>`coalesce(sum(${i.quantity}) filter (where ${NOT_CANCELLED}), 0)`,
        grossSales: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${NOT_CANCELLED}), 0)`,
        cogsFull: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${NOT_CANCELLED}), 0)`,
        // Sản phẩm KHÔNG biết giá vốn (không phiếu nhập, không giá Pancake): đang bị tính 0đ — là CHƯA BIẾT.
        cogsUnknownQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${NOT_CANCELLED} and ${LINE_UNIT_COST} = 0), 0)`,
        /*
          GIÁ BÁO MKT (chủ shop chốt 25/09/2026) — hai con số chỉ đường "theo MKT" dùng: phần chênh
          (giá báo − giá vốn thật) × số lượng trên các dòng CÓ giá báo đang hiệu lực, và số sản phẩm có
          giá báo mà chưa biết giá vốn thật (giá dự tính của chúng phải trừ ra, không thì cộng hai lần).
        */
        mktDeltaFull: sql<number>`coalesce(sum(${i.quantity} * (${LINE_MARKETER_PRICE} - ${LINE_UNIT_COST})) filter (where ${NOT_CANCELLED} and ${LINE_MARKETER_PRICE} is not null), 0)`,
        mktPricedUnknownQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${NOT_CANCELLED} and ${LINE_MARKETER_PRICE} is not null and ${LINE_UNIT_COST} = 0), 0)`,
        delivered: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED')`,
        returned: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
        inTransit: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} = 'IN_TRANSIT')`,
        pending: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} = 'NOT_SHIPPED')`,
        failed: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME_FAST} = 'IN_TRANSIT' and ${s.stage} = 'DELIVERY_FAILED')`,
        actualRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME_FAST} = 'DELIVERED'), 0)`,
        firstAt: sql<string | null>`min(${o.insertedAt}) filter (where ${NOT_CANCELLED})`,
        lastAt: sql<string | null>`max(${o.insertedAt}) filter (where ${NOT_CANCELLED})`,
      })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .leftJoin(p, eq(p.id, sql`coalesce(${pv.productId}, ${i.productId})`))
      // chỉ tính đơn đã xác nhận trên Pancake (bỏ đơn mới / chờ xác nhận / huỷ)
      // Bộ lọc GIÁ TRỊ ĐƠN đọc tổng tiền của CẢ ĐƠN: một đơn vào trọn vẹn hoặc ra trọn vẹn.
      .where(and(eq(i.isBonus, false), inArray(o.stage, [...CONFIRMED_STAGES]), ...(locGiaTri ? [sql.raw(locGiaTri)] : []), ...periodCond(period.from, period.to, basis)))
      .groupBy(sql`1`),
    ),
    db
      .select({ productId: ads.productId, spend: sql<number>`coalesce(sum(${ads.spend}), 0)` })
      .from(ads)
      .where(and(...adConds))
      .groupBy(ads.productId),
    // từng (đơn, mã): tiền hàng của mã trong đơn & tổng đơn sau giảm — để chia ĐƠN (1/N mã) và DOANH SỐ SAU GIẢM theo tỷ trọng tiền hàng,
    // sao cho cộng mọi mã = số đơn đã xác nhận (đếm 1 lần) và = tổng tiền sau giảm giá của thẻ "Doanh số đơn đã xác nhận"
    //
    // CỐ Ý KHÔNG lọc giá trị đơn trong câu này: nó phải trả về CẢ KỲ để tính được TỶ TRỌNG của
    // tập đang lọc (`costShare` bên dưới). Không có mẫu số ấy thì quảng cáo và chi phí vận hành
    // của TOÀN KỲ bị trút hết lên lát cắt nhỏ đang xem, và "đơn dưới 300K" trông lỗ nặng vì gánh
    // tiền quảng cáo của những đơn không nằm trong đó. Phép lọc làm ở tầng ứng dụng bằng
    // `orderValueMatches` — CÙNG một luật với mệnh đề SQL, xem lib/constants/order-value.ts.
    db
      .select({ orderId: o.id, productId: PID, lineSales: sql<number>`coalesce(sum(${i.lineTotal}), 0)`, orderTotal: sql<number>`max(coalesce(${o.totalPriceAfterDiscount}, 0))` })
      .from(i)
      .innerJoin(o, eq(o.id, i.orderId))
      // MỖI ĐƠN MỘT DÒNG (xem PRIMARY_ATTEMPT). Bảng vận đơn có mặt vì biểu thức mốc NGÀY GỬI /
      // NGÀY XỬ LÝ đọc `"shipments".*`; thiếu nó thì Postgres báo "missing FROM-clause entry" — và
      // chỉ báo khi người dùng ĐỔI mốc, tức không lần deploy nào bắt được.
      .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
      .leftJoin(pv, eq(pv.id, i.variantId))
      .where(and(eq(i.isBonus, false), inArray(o.stage, [...CONFIRMED_STAGES]), NOT_CANCELLED, ...periodCond(period.from, period.to, basis)))
      .groupBy(o.id, PID),
    // CHI PHÍ VẬN HÀNH đi qua Profit Engine — nơi duy nhất quyết định nguồn nào có thẩm quyền,
    // nguồn chính đã phủ đủ chưa, và khoản gõ tay nào bị loại vì trùng nguồn.
    getOperatingCost(period),
  ]);
  // Số THÔ của cả kỳ. Phần thuộc về tập đang lọc tính sau, khi đã biết tỷ trọng doanh số (`costShare`).
  const operatingExpensesCaKy = operating.amount;
  const operatingCount = operating.count;
  const riskPct = Number(assumptions.inventoryRiskPercent ?? 0);
  // kỳ "Toàn bộ" / thiếu mốc: lấy từ đơn đầu tiên tới đơn cuối (hoặc hôm nay nếu kỳ chưa kết thúc)
  const toDate = (v: string | Date | null | undefined) => (v ? new Date(v) : null);
  const firstAt = sales.map((r) => toDate(r.firstAt)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime())).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
  const lastAt = sales.map((r) => toDate(r.lastAt)).filter((d): d is Date => !!d && !Number.isNaN(d.getTime())).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
  const now = new Date();
  const monthsFrom = period.from ?? firstAt;
  const monthsTo = period.to ? (period.to.getTime() > now.getTime() ? now : period.to) : lastAt && lastAt.getTime() > now.getTime() ? lastAt : now;
  const months = monthsFrom ? Math.round(periodMonths(monthsFrom, monthsTo) * 100) / 100 : 0;
  const fixedCostCaKy = fixedCostForPeriod(Number(assumptions.fixedCostMonthly ?? 0), months);
  // chia từng đơn cho các mã trong đơn: đơn = 1/N mã, doanh số sau giảm = tổng đơn × tiền hàng của mã / tiền hàng cả đơn
  const perOrderByOrder = new Map<string, { productId: string; lineSales: number; orderTotal: number }[]>();
  for (const r of perOrder) {
    const list = perOrderByOrder.get(r.orderId) ?? [];
    list.push({ productId: r.productId, lineSales: Number(r.lineSales), orderTotal: Number(r.orderTotal) });
    perOrderByOrder.set(r.orderId, list);
  }
  const allocByProduct = new Map<string, { ordersWeighted: number; salesAfterDiscount: number }>();
  /** CÙNG phép chia, nhưng trên TOÀN KỲ — chỉ làm mẫu số của tỷ trọng, không bao giờ hiện ra bảng. */
  const allocCaKy = new Map<string, number>();
  let ordersDistinct = 0;
  let doanhSoTrongLoc = 0;
  let doanhSoCaKy = 0;
  let donChuaBietGiaTri = 0;
  for (const list of perOrderByOrder.values()) {
    const n = list.length;
    const lineSum = list.reduce((t, x) => t + Math.max(0, x.lineSales), 0);
    // Mọi dòng của cùng một đơn mang cùng `orderTotal` (nó là `max()` theo đơn) — lấy dòng đầu.
    const tongDon = list[0]?.orderTotal ?? 0;
    const trongLoc = orderValueMatches(value, tongDon);
    if (dangLoc && tongDon <= 0) donChuaBietGiaTri += 1;
    doanhSoCaKy += tongDon;
    if (trongLoc) {
      ordersDistinct += 1;
      doanhSoTrongLoc += tongDon;
    }
    for (const x of list) {
      const phan = lineSum > 0 ? (x.orderTotal * Math.max(0, x.lineSales)) / lineSum : x.orderTotal / n;
      allocCaKy.set(x.productId, (allocCaKy.get(x.productId) ?? 0) + phan);
      if (!trongLoc) continue;
      const e = allocByProduct.get(x.productId) ?? { ordersWeighted: 0, salesAfterDiscount: 0 };
      e.ordersWeighted += 1 / n;
      e.salesAfterDiscount += phan;
      allocByProduct.set(x.productId, e);
    }
  }
  /*
    ═══════════ TỶ TRỌNG CỦA TẬP ĐANG LỌC — MẪU SỐ CỦA MỌI CHI PHÍ CHUNG ═══════════

    Chủ shop chốt 21/09/2026: chi phí vận hành chung (lương, mặt bằng, phần mềm, cố định) phân bổ
    cho tập đang lọc theo TỶ TRỌNG DOANH SỐ của nó — mặt bằng vẫn tốn dù đơn to hay nhỏ. Nhờ vậy
    cộng các bậc giá lại vẫn ra đúng tổng chi phí của kỳ.

    Không lọc gì thì tỷ trọng là ĐÚNG 1 — gán thẳng, KHÔNG chia `x/x`: phép chia dấu phẩy động trên
    một kỳ vài tỷ đồng ra 0,9999999 và mọi con số của mọi báo cáo cũ lệch vài đồng. Không ai đọc
    được nguyên nhân từ một cột lệch 3đ.
  */
  const costShare = !dangLoc ? 1 : doanhSoCaKy > 0 ? doanhSoTrongLoc / doanhSoCaKy : 0;
  const operatingExpenses = dangLoc ? Math.round(operatingExpensesCaKy * costShare) : operatingExpensesCaKy;
  const fixedCost = dangLoc ? Math.round(fixedCostCaKy * costShare) : fixedCostCaKy;
  const adByProduct = new Map<string, number>();
  let unmatchedAdSpend = 0;
  for (const r of adRows) {
    if (r.productId) adByProduct.set(r.productId, Number(r.spend));
    else unmatchedAdSpend += Number(r.spend);
  }
  /*
    ═══════════ QUẢNG CÁO: MỘT CÔNG TẮC, VÀ MỘT PHÉP CHIA TỶ TRỌNG ═══════════

    · `includeAds = false` (công tắc "Tính chi phí quảng cáo" tắt) ⇒ CPQC về 0 ở MỌI dòng; "chi phí
      khác" tính bằng `CPQC × %` nên cũng tự về 0. Đây là câu hỏi "bán thêm một đơn xả — không tiêu
      thêm đồng quảng cáo nào — thì được thêm bao nhiêu tiền".
    · Đang lọc mà VẪN tính CPQC ⇒ mỗi mã chỉ gánh phần quảng cáo TƯƠNG ỨNG với doanh số của mã đó
      nằm trong khoảng đang lọc. Trút trọn CPQC cả kỳ lên một lát cắt nhỏ là tạo ra một khoản lỗ
      không có thật, và nó sẽ trông đủ hợp lý để không ai đi kiểm lại.

    Cả hai nhánh sửa CHÍNH bản đồ `adByProduct`, không đẻ ra bản thứ hai: dòng mã chỉ có phiếu nhập
    ở dưới cũng đọc bản đồ này, và hai bản sao sẽ lệch nhau vào đúng ngày ai đó sửa một bản.
  */
  if (!includeAds) {
    for (const k of adByProduct.keys()) adByProduct.set(k, 0);
    unmatchedAdSpend = 0;
  } else if (dangLoc) {
    for (const [k, chi] of adByProduct) {
      const caKy = allocCaKy.get(k) ?? 0;
      const trongLoc = allocByProduct.get(k)?.salesAfterDiscount ?? 0;
      adByProduct.set(k, caKy > 0 ? Math.round(chi * (trongLoc / caKy)) : 0);
    }
    unmatchedAdSpend = Math.round(unmatchedAdSpend * costShare);
  }

  const rows: NominalRow[] = sales
    .filter((r) => r.productId)
    .map((r) => {
      const alloc = allocByProduct.get(r.productId) ?? { ordersWeighted: 0, salesAfterDiscount: 0 };
      const base = { orders: Number(r.orders), items: Number(r.items), grossSales: Number(r.grossSales), cogsFull: Number(r.cogsFull), cogsUnknownQty: Number(r.cogsUnknownQty ?? 0), adSpend: adByProduct.get(r.productId) ?? 0, ordersWeighted: alloc.ordersWeighted, salesAfterDiscount: Math.round(alloc.salesAfterDiscount) };
      const h = history.get(r.productId);
      /*
        ═══ TỶ LỆ VÀ TIỀN GTC ƯỚC TÍNH LẤY TỪ HỢP ĐỒNG CHUNG, KHÔNG TỰ TRỘN Ở ĐÂY ═══

        Thứ tự nguồn, và vì sao:
          1. GHI ĐÈ TAY thắng tất cả — chủ shop gõ một tỷ lệ là một QUYẾT ĐỊNH, không phải ước lượng.
          2. HỢP ĐỒNG (`projected`) khi mã có đơn trong cohort mô hình: tỷ lệ = `projectedRate`, và
             TIỀN cân theo TỪNG ĐƠN (`projectedDeliveredRevenue`, `projectedCogs`) — không còn
             `grossSales × (1 − r)` ở nhánh này.
          3. Mã có cohort nhưng hợp đồng trả `null` (chưa đủ mẫu / phần ngoài ước tính quá lớn) ⇒
             `unmeasured`: tỷ lệ là `null` và màn hình in "—". KHÔNG lùi về lịch sử / giả định 40%:
             bản trước làm vậy và một con số đoán đứng cạnh con số đo, cùng cỡ chữ, cùng màu.
             Tiền vẫn cân theo từng đơn với phần đã dự báo được; phần còn lại nằm ở `unmodelledRevenue`.
          4. Chỉ khi mã KHÔNG có đơn nào trong cohort mô hình (hoặc hợp đồng lỗi) mới dùng lịch sử /
             giả định — và nhãn nói rõ "ước tính theo tỷ lệ".
      */
      const duBao = projected.get(r.productId);
      /*
        THANG BẬC SỐNG Ở `lib/constants/delivery-rate.ts` — hàm THUẦN, dùng chung với Hiệu quả
        marketing theo ngày. Trước 22/09/2026 nó nằm ngay trong vòng lặp này và là bản DUY NHẤT;
        báo cáo thứ hai cần đúng thang bậc ấy thì chỉ còn đường chép, và hai bản chép có ngày trả
        lời khác nhau về cùng một mã trong khi cả hai màn hình đều nói "tỷ lệ giao thành công".
      */
      const ghiDe = parseDeliveryRateOverride(assumptions.overrides[r.productId]);
      const bac = resolveDeliveryRate({
        override: ghiDe,
        projectedDeliveryRate: duBao?.projectedRate ?? null,
        projectedFinished: duBao ? duBao.deliveredActual + duBao.failedActual : 0,
        measuredDeliveryRate: duBao?.actualRate ?? null,
        projectedBorrowed: duBao?.projectedFromGlobal ?? null,
        projectedOwnWeight: duBao?.projectedFromOwn ?? null,
        historyReturnRate: h?.rate ?? null,
        historyFinished: h?.finished ?? 0,
        minFinishedOrders: assumptions.minFinishedOrders,
        matureMinFinished: assumptions.rateMatureMinFinished,
        defaultReturnRate: assumptions.defaultReturnRate,
      });
      const baseReturnRate = bac.baseReturnRate;
      const returnRateSource: NominalRow["returnRateSource"] = bac.source;
      const returnRate: number | null = bac.returnRate;
      let orderLevel: { revenue: number; cogs: number; qty: number; unknownQty: number } | null = null;
      if (bac.source === "projected" && duBao) {
        /*
          ĐO ĐƯỢC THÌ DÙNG SỐ ĐO — tỷ lệ của hợp đồng, và TIỀN cân theo TỪNG ĐƠN.

          ═══ "ĐO ĐƯỢC" NGHĨA LÀ MÃ NÀY ĐÃ CÓ KẾT CỤC THẬT, KHÔNG PHẢI "MÔ HÌNH RA ĐƯỢC SỐ" ═══

          Bản trước chỉ hỏi `projectedRate !== null`. Nhưng hợp đồng vẫn trả ra một con số khi mã
          có đơn ĐANG CHẠY mà CHƯA đơn nào kết thúc — lúc ấy tử số là `0 + Σ P(trạng thái)`, tức
          **toàn bộ xác suất MƯỢN từ lịch sử các mã khác**, không một chút dữ liệu nào của chính mã.

          Đo production 21/09/2026, Đầm Q005: `giao thật 0 · hoàn 0 · đang giao 62` mà ô tỷ lệ in
          **37,5%**. Chủ shop hỏi đúng câu phải hỏi: mã chưa giao thành công đơn nào thì 37,5% ở
          đâu ra? Nó ở lịch sử của Q002/Q003/Q004 — và ba mã ấy lệch nhau từ 26% tới 49%, nên con
          số mượn KHÔNG nói được gì về mã mới.

          CỔNG "ÍT NHẤT MỘT ĐƠN" ĐÃ KHÔNG ĐỦ — chủ shop đo lại 23/09/2026: Q005 có **6** đơn kết
          thúc (5 giao được) nên lọt cổng, nhưng 99/105 đơn còn đang chạy vẫn cân bằng xác suất
          toàn shop ⇒ ô in **35,9%** trong khi chính mã đang ở 5/6. Nay cổng là `minFinishedOrders`
          đơn đã kết thúc; chưa đủ thì mã đi xuống bậc `blended` — CO NGÓT số đo của chính mã về
          tỷ lệ khai ở Giả định, không bao giờ mượn tỷ lệ nền của shop nữa.

          Đo cùng ngày: Q005 và Q006 có 0 đơn kết thúc trong 90 ngày ⇒ cả hai về 60% khai ở Giả
          định. Q004 (105 đơn kết thúc), Q002 (1.138), Q003 (474) giữ nguyên số đo; Q001 vốn đã ở
          nhánh lịch sử (71 đơn) nên không đổi.
        */
        orderLevel = { revenue: duBao.projectedDeliveredRevenue, cogs: duBao.projectedCogs, qty: duBao.projectedQty, unknownQty: duBao.projectedUnknownQty };
      }
      /*
        ═══════════ CHƯA ĐO ĐƯỢC THÌ RƠI VỀ TỶ LỆ ĐÃ KHAI, KHÔNG PHẢI VỀ MỘT Ô TRỐNG ═══════════

        Bản trước, mã có cohort mà hợp đồng trả `null` bị gắn nhãn `unmeasured`: ô tỷ lệ in "—"
        NHƯNG cột tiền vẫn in một con số — vì tiền đi đường khác, cân từng đơn theo `P(chưa rời
        kho)`. Hệ quả đo trên production 21/09/2026, mã Q005 (183 đơn, chưa gửi đơn nào):

            TL GTC ƯT   →  "—"
            DT GTC ƯT   →  25.687.174 ₫   = 106.287.000 × 24,2%

        Tức cùng một dòng vừa nói "không có tỷ lệ" vừa in một khoản tiền hàm ý tỷ lệ 24,2%. Và
        24,2% ấy là `P(đơn chốt bất kỳ → giao thành công)` học TOÀN SHOP, KỂ CẢ ĐƠN HUỶ — nó trả
        lời một câu hỏi khác hẳn câu chủ shop đang hỏi về một mã đang chạy.

        Chủ shop chốt 21/09/2026: mã nào ĐO ĐƯỢC thì dùng số đo; mã đang sản xuất, đã có đơn xác
        nhận và doanh số POS mà chưa giao đơn nào thì tính theo TỶ LỆ ĐÃ KHAI ở Giả định
        (`defaultReturnRate`, hiện là 40 ⇒ GTC 60%) — để còn nhìn được lợi nhuận và margin ước
        tính mà quyết định action cho mã và cho campaign. Một ô trống không giúp ra quyết định nào.

        Thứ tự lùi giữ nguyên tinh thần cũ, chỉ khác là nó ĐƯỢC CHẠY: lịch sử thật của mã trước
        (đã gán ở trên khi đủ mẫu), hết lịch sử mới tới tỷ lệ khai. Cả hai nhánh mang nhãn "ước
        tính theo tỷ lệ" và KHÔNG được tô màu — xem `OTyLe`: một con số giả định tô xanh là một
        con số giả định trông như đã đo.

        `orderLevel` để `null` là cố ý: tiền khi đó = Doanh số POS × TL GTC, cùng một tỷ lệ với ô
        bên cạnh. Trộn tiền-cân-theo-đơn với tỷ lệ-giả-định là tái lập đúng cái mâu thuẫn trên.
      */
      const cogsUnknownQty = base.cogsUnknownQty;
      // Giá dự tính chỉ có nghĩa khi mã THẬT SỰ có sản phẩm chưa có giá — mã đã đủ phiếu nhập thì
      // con số đặt tay đứng sang một bên, và dòng không mang nhãn "dự tính" nào.
      const duTinh = cogsUnknownQty > 0 ? (giaDuTinh[r.productId] ?? null) : null;
      const calc = applyAssumptions(base, returnRate, assumptions, orderLevel, duTinh?.unitCost ?? null);
      const pur = purchases.get(r.productId);
      const nhap = valuePurchase(pur, giaDuTinh[r.productId] ?? null);
      /*
        GIÁ BÁO MKT Ở MỨC GIAO THÀNH CÔNG ƯỚC TÍNH: phần chênh của các dòng có giá báo, quy về đúng tỷ
        lệ SỐ SẢN PHẨM giao thành công ước tính của mã (`expectedQty / items` — cùng đường với cột giá
        vốn ước tính). Dòng chưa biết giá vốn thật đang mang giá dự tính trong `expectedCogs` ⇒ trừ
        phần dự tính ấy ra, để giá báo THAY nó chứ không cộng chồng.
      */
      const tyLeGiao = base.items > 0 ? calc.expectedQty / base.items : 0;
      const duTinhBiThay = duTinh?.unitCost ? duTinh.unitCost * Number(r.mktPricedUnknownQty ?? 0) : 0;
      const marketerCostDelta = Math.round((Number(r.mktDeltaFull ?? 0) - duTinhBiThay) * tyLeGiao);
      return {
        productId: r.productId,
        productName: r.productName ?? "",
        code: r.code ?? "",
        image: r.image,
        ...base,
        ads: adsRatios({ adSpend: base.adSpend, posSales: base.salesAfterDiscount, deliveredRevenueActual: Number(r.actualRevenue), projectedDeliveredRevenue: calc.expectedRevenue }),
        returnRate,
        deliveryRate: returnRate === null ? null : Math.round((100 - returnRate) * 10) / 10,
        returnRateSource,
        projection: duBao && orderLevel ? { eligibleSent: duBao.eligibleSent, active: duBao.active, unmodelledActive: duBao.unmodelledActive, pending: duBao.pending, pendingUnmodelled: duBao.pendingUnmodelled, awaitingPickup: duBao.awaitingPickup, unmodelledRevenue: duBao.unmodelledRevenue, finished: duBao.deliveredActual + duBao.failedActual } : null,
        revenueBasis: (orderLevel ? "ORDER_LEVEL" : "RATE") as NominalRow["revenueBasis"],
        unmodelledRevenue: orderLevel && duBao ? duBao.unmodelledRevenue : 0,
        cogsKnown: cogsUnknownQty === 0 || duTinh !== null,
        cogsUnknownQty,
        cogsUncoveredQty: duTinh ? 0 : cogsUnknownQty,
        estimatedCost: duTinh,
        marketerCostDelta,
        purchaseCostKnown: nhap.known,
        purchaseUnpricedQty: nhap.unpricedQty,
        purchaseCostEstimated: nhap.estimated,
        profitOnPurchaseKnown: nhap.known,
        baseReturnRate,
        historyFinished: h?.finished ?? 0,
        rateMature: bac.mature,
        rateOwnFinished: bac.ownFinished,
        rateOverride: ghiDe,
        rateMatureAt: assumptions.rateMatureMinFinished,
        measuredDeliveryRate: duBao?.actualRate ?? null,
        borrowedShare: bac.borrowedShare,
        blendReason: bac.blendReason,
        ...calc,
        cpo: base.orders ? base.adSpend / base.orders : null,
        revenuePerOrder: base.orders ? calc.expectedRevenue / base.orders : null,
        delivered: Number(r.delivered),
        returned: Number(r.returned),
        inTransit: Number(r.inTransit),
        failed: Number(r.failed),
        pending: Number(r.pending),
        actualRevenue: Number(r.actualRevenue),
        operatingAlloc: 0,
        rescued: rescuedFromRate(base.orders, rescueRate),
        ...opsCosts({ orders: base.orders, rescued: rescuedFromRate(base.orders, rescueRate) }, assumptions),
        fixedAlloc: 0,
        opexTotal: 0,
        otherCostsTotal: 0,
        opexPerOrder: null,
        opexPerDelivered: null,
        purchaseQty: purchases.get(r.productId)?.qty ?? 0,
        purchaseCost: nhap.cost,
        // Dự phòng đi theo HÀNG BÁN RA, không theo hàng nhập — xem `inventoryRiskOnSold`.
        inventoryRisk: inventoryRiskOnSold(calc.expectedCogs, riskPct),
        inventoryRiskOnPurchase: inventoryRiskOnSold(nhap.cost, riskPct),
        stockValue: (stocks.get(r.productId) ?? TON_CHUA_BIET).value,
        stockQty: (stocks.get(r.productId) ?? TON_CHUA_BIET).qty,
        stockKnown: (stocks.get(r.productId) ?? TON_CHUA_BIET).known,
        outInTransitQty: (stocks.get(r.productId) ?? TON_CHUA_BIET).inTransitQty,
        outAwaitingReturnQty: (stocks.get(r.productId) ?? TON_CHUA_BIET).awaitingReturnQty,
        inventoryRiskPending: inventoryRiskExposure((stocks.get(r.productId) ?? TON_CHUA_BIET).value, riskPct),
        profitOnPurchase: 0,
        marginOnPurchase: null,
        tax: Math.round(calc.expectedRevenue * taxPct),
        otherCost: Math.round(base.adSpend * otherPct),
        netProfit: 0,
        netMargin: null,
      };
    })
    .sort((a, b) => b.expectedProfit - a.expectedProfit);
  // mã có nhập hàng trong kỳ nhưng chưa có đơn → vẫn hiện để tính lợi nhuận theo hàng nhập
  for (const [pid, pur] of purchases) {
    if (rows.some((r) => r.productId === pid)) continue;
    const nhap = valuePurchase(pur, giaDuTinh[pid] ?? null);
    rows.push({
      productId: pid, productName: pur.name || pid, code: pur.code, image: null, orders: 0, ordersWeighted: 0, items: 0, grossSales: 0, salesAfterDiscount: 0, adSpend: adByProduct.get(pid) ?? 0,
      // Mã CHƯA CÓ ĐƠN: không có tỷ lệ nào để in — `null`, không phải 100% (không giao đơn nào thì không "giao thành công 100%").
      ads: adsRatios({ adSpend: adByProduct.get(pid) ?? 0, posSales: 0, deliveredRevenueActual: 0, projectedDeliveredRevenue: 0 }),
      returnRate: null, deliveryRate: null, returnRateSource: "unmeasured" as const, projection: null, revenueBasis: "RATE" as const, unmodelledRevenue: 0, cogsKnown: true, cogsUnknownQty: 0, marketerCostDelta: 0, cogsUncoveredQty: 0, estimatedCost: null, purchaseCostKnown: nhap.known, purchaseUnpricedQty: nhap.unpricedQty, purchaseCostEstimated: nhap.estimated, profitOnPurchaseKnown: nhap.known,
      baseReturnRate: 0, historyFinished: 0, rateMature: false, rateOwnFinished: 0, rateOverride: null, rateMatureAt: assumptions.rateMatureMinFinished, measuredDeliveryRate: null, borrowedShare: null, blendReason: null, expectedRevenue: 0, expectedCogs: 0, expectedCogsEstimated: 0, expectedQty: 0, shipCost: 0, expectedProfit: -(adByProduct.get(pid) ?? 0), margin: null, cpo: null, revenuePerOrder: null,
      delivered: 0, returned: 0, inTransit: 0, failed: 0, pending: 0, actualRevenue: 0, operatingAlloc: 0, rescued: 0, packingCost: 0, opsStaffCost: 0, fixedAlloc: 0, opexTotal: 0, otherCostsTotal: 0, opexPerOrder: null, opexPerDelivered: null,
      // Chưa bán được gì trong kỳ ⇒ chưa giải phóng đồng dự phòng nào vào lãi lỗ; rủi ro của lô
      // nằm nguyên ở phần CÒN TREO trên hàng tồn.
      purchaseQty: pur.qty, purchaseCost: nhap.cost, inventoryRisk: 0, inventoryRiskOnPurchase: inventoryRiskOnSold(nhap.cost, riskPct),
      stockValue: (stocks.get(pid) ?? TON_CHUA_BIET).value, stockQty: (stocks.get(pid) ?? TON_CHUA_BIET).qty, stockKnown: (stocks.get(pid) ?? TON_CHUA_BIET).known,
      outInTransitQty: (stocks.get(pid) ?? TON_CHUA_BIET).inTransitQty, outAwaitingReturnQty: (stocks.get(pid) ?? TON_CHUA_BIET).awaitingReturnQty,
      inventoryRiskPending: inventoryRiskExposure((stocks.get(pid) ?? TON_CHUA_BIET).value, riskPct),
      profitOnPurchase: 0, marginOnPurchase: null, tax: 0, otherCost: Math.round((adByProduct.get(pid) ?? 0) * otherPct), netProfit: 0, netMargin: null,
    });
  }
  /*
    ═══ CƯỚC / PHÍ HOÀN ĐIỀU CHỈNH CÓ LÝ DO — TIỀN THẬT, CỘNG VÀO CỘT CƯỚC CỦA TỪNG MÃ ═══

    Cột cước ở đây là ƯỚC TÍNH theo đơn (số đơn × cước gửi / cước hoàn giả định). Khoản đền bù, phí
    ngoại lệ, cước chuyến gom hàng khai `MANUAL_ADJUSTMENT` kèm lý do không gắn được vận đơn nào nên
    KHÔNG nằm trong ước tính ấy — bản trước bỏ sót nó trong khi Profit Engine tính nó vào thành phần
    Cước, và lợi nhuận danh nghĩa cao hơn đúng bằng khoản ấy. Lấy từ engine (không tự đọc bảng Chi
    phí), chia theo SỐ ĐƠN của mã (cước đi theo đơn) bằng largest remainder để Σ các mã = đúng khoản
    của kỳ; đang lọc bậc giá thì chỉ phần tương ứng tỷ trọng doanh số, như chi phí vận hành chung.
    Không mã nào có đơn thì chia theo doanh số; vẫn không chia được thì phần ấy đứng ở dòng tổng,
    như CPQC chưa quy kết — không biến mất.
  */
  const dieuChinhCuoc = dangLoc ? Math.round(operating.logisticsAdjustment.amount * costShare) : operating.logisticsAdjustment.amount;
  const canCuCuoc = rows.some((r) => r.orders > 0) ? rows.map((r) => r.orders) : rows.map((r) => r.grossSales);
  const phanCuoc = distributeProportionally(dieuChinhCuoc, canCuCuoc);
  rows.forEach((r, idx) => {
    if (!phanCuoc[idx]) return;
    r.shipCost += phanCuoc[idx];
    r.expectedProfit -= phanCuoc[idx];
    r.margin = r.expectedRevenue ? (r.expectedProfit / r.expectedRevenue) * 100 : null;
  });
  const dieuChinhCuocChuaChia = dieuChinhCuoc - phanCuoc.reduce((t, v) => t + v, 0);

  // phân bổ chi phí vận hành đã nhập + chi phí cố định theo tỷ trọng doanh số POS, rồi tính LN ròng từng mã.
  // Chia bằng LARGEST REMAINDER: Σ phần của các mã = ĐÚNG tổng của shop, không lệch vì làm tròn từng dòng.
  const weights = rows.map((r) => r.grossSales);
  const operatingParts = distributeProportionally(operatingExpenses, weights);
  const fixedParts = distributeProportionally(fixedCost, weights);
  rows.forEach((r, idx) => {
    r.operatingAlloc = operatingParts[idx];
    r.fixedAlloc = fixedParts[idx];
  });
  for (const r of rows) {
    r.opexTotal = r.operatingAlloc + r.packingCost + r.opsStaffCost + r.fixedAlloc;
    /*
      ═══ RỦI RO TỒN KHO LÀ CHI PHÍ CỦA KỲ, KHÔNG PHẢI CỦA LÔ ═══

      Bản cũ trừ TRỌN rủi ro cả đời của lô nhập vào đúng kỳ chứa phiếu nhập. Lý lẽ khi đó nghe hợp
      lý: "bảng này trừ trọn giá trị hàng nhập thì cũng trừ trọn rủi ro của lô". Nhưng nó tạo ra hai
      con số sai theo hai hướng ngược nhau:

        · KỲ CÓ PHIẾU NHẬP  — gánh rủi ro của hàng sẽ bán trong nhiều tháng tới. Tuần bán 1/10 lô
          vẫn chịu đủ dự phòng cả lô.
        · KỲ KHÔNG NHẬP GÌ  — rủi ro bằng ĐÚNG 0, và bảng nói hàng đang bán không có rủi ro nào.
          Đây chính là cột 0 mà chủ shop nhìn thấy: không phải % chưa khai (mặc định là 10%), mà là
          `purchaseByProduct(period)` không tìm thấy phiếu nhập nào trong kỳ 7 ngày.

      `AGENTS.md` mục 14 đã chốt luật cho đúng chuyện này: *dự phòng rủi ro tồn kho đi theo GIÁ VỐN
      HÀNG BÁN RA, không theo giá trị hàng nhập trong kỳ*. Bảng chính đã làm đúng từ đầu; bảng này
      là chỗ duy nhất còn sót.

      Nay cả hai bảng dùng CÙNG MỘT con số rủi ro (`inventoryRisk`, phân bổ theo hàng bán trong kỳ).
      Rủi ro cả đời của lô nhập vẫn được tính và vẫn hiện ra — nhưng là GHI CHÚ, không trừ vào lợi
      nhuận kỳ nào. Xem `inventoryRiskOnPurchase`.
    */
    r.profitOnPurchase = r.expectedRevenue - r.adSpend - r.purchaseCost - r.shipCost - r.opexTotal - r.inventoryRisk - r.tax - r.otherCost;
    r.marginOnPurchase = r.expectedRevenue ? (r.profitOnPurchase / r.expectedRevenue) * 100 : null;
    r.otherCostsTotal = r.opexTotal + r.inventoryRisk + r.tax + r.otherCost;
    r.opexPerOrder = r.orders ? Math.round(r.otherCostsTotal / r.orders) : null;
    // Chưa đo được tỷ lệ thì không có "đơn GTC ước tính" để chia — `null`, không chia cho số đơn lên.
    const expectedDelivered = r.returnRate === null ? null : r.orders * (1 - Math.min(Math.max(r.returnRate, 0), 100) / 100);
    r.opexPerDelivered = expectedDelivered !== null && expectedDelivered > 0 ? Math.round(r.otherCostsTotal / expectedDelivered) : null;
    r.netProfit = r.expectedProfit - r.opexTotal - r.inventoryRisk - r.tax - r.otherCost;
    r.netMargin = r.expectedRevenue ? (r.netProfit / r.expectedRevenue) * 100 : null;
  }

  const totals = rows.reduce(
    (t, r) => ({
      orders: t.orders + r.orders,
      ordersWeighted: t.ordersWeighted + r.ordersWeighted,
      salesAfterDiscount: t.salesAfterDiscount + r.salesAfterDiscount,
      items: t.items + r.items,
      grossSales: t.grossSales + r.grossSales,
      adSpend: t.adSpend + r.adSpend,
      expectedRevenue: t.expectedRevenue + r.expectedRevenue,
      expectedCogs: t.expectedCogs + r.expectedCogs,
      expectedQty: t.expectedQty + r.expectedQty,
      shipCost: t.shipCost + r.shipCost,
      expectedProfit: t.expectedProfit + r.expectedProfit,
      delivered: t.delivered + r.delivered,
      returned: t.returned + r.returned,
      inTransit: t.inTransit + r.inTransit,
      actualRevenue: t.actualRevenue + r.actualRevenue,
      weightedReturn: t.weightedReturn + (r.returnRate ?? 0) * r.orders,
      ordersWithRate: t.ordersWithRate + (r.returnRate === null ? 0 : r.orders),
      unmodelledRevenue: t.unmodelledRevenue + r.unmodelledRevenue,
      cogsUnknownQty: t.cogsUnknownQty + r.cogsUnknownQty,
      cogsUncoveredQty: t.cogsUncoveredQty + r.cogsUncoveredQty,
      expectedCogsEstimated: t.expectedCogsEstimated + r.expectedCogsEstimated,
      estimatedCostProducts: t.estimatedCostProducts + (r.expectedCogsEstimated > 0 ? 1 : 0),
      purchaseUnknown: t.purchaseUnknown + (r.purchaseCostKnown ? 0 : 1),
      purchaseCostEstimated: t.purchaseCostEstimated + r.purchaseCostEstimated,
      rescued: t.rescued + r.rescued,
      packingCost: t.packingCost + r.packingCost,
      opsStaffCost: t.opsStaffCost + r.opsStaffCost,
      inventoryRisk: t.inventoryRisk + r.inventoryRisk,
      inventoryRiskOnPurchase: t.inventoryRiskOnPurchase + r.inventoryRiskOnPurchase,
      stockValue: t.stockValue + r.stockValue,
      stockQty: t.stockQty + r.stockQty,
      // Tồn TỔNG chỉ biết được khi MỌI mã đều biết; một mã chưa có phiếu nhập là cả tổng chưa biết.
      stockUnknown: t.stockUnknown + (r.stockKnown ? 0 : 1),
      outInTransitQty: t.outInTransitQty + r.outInTransitQty,
      outAwaitingReturnQty: t.outAwaitingReturnQty + r.outAwaitingReturnQty,
      inventoryRiskPending: t.inventoryRiskPending + r.inventoryRiskPending,
      failed: t.failed + r.failed,
      pending: t.pending + r.pending,
      tax: t.tax + r.tax,
      otherCost: t.otherCost + r.otherCost,
      purchaseQty: t.purchaseQty + r.purchaseQty,
      purchaseCost: t.purchaseCost + r.purchaseCost,
    }),
    { orders: 0, ordersWeighted: 0, salesAfterDiscount: 0, items: 0, grossSales: 0, adSpend: 0, expectedRevenue: 0, expectedCogs: 0, expectedQty: 0, shipCost: 0, expectedProfit: 0, delivered: 0, returned: 0, inTransit: 0, actualRevenue: 0, weightedReturn: 0, ordersWithRate: 0, unmodelledRevenue: 0, cogsUnknownQty: 0, cogsUncoveredQty: 0, expectedCogsEstimated: 0, estimatedCostProducts: 0, purchaseUnknown: 0, purchaseCostEstimated: 0, rescued: 0, packingCost: 0, opsStaffCost: 0, inventoryRisk: 0, inventoryRiskOnPurchase: 0, stockValue: 0, stockQty: 0, stockUnknown: 0, outInTransitQty: 0, outAwaitingReturnQty: 0, inventoryRiskPending: 0, failed: 0, pending: 0, tax: 0, otherCost: 0, purchaseQty: 0, purchaseCost: 0 },
  );
  const adSpendAll = totals.adSpend + unmatchedAdSpend;
  const otherCostAll = totals.otherCost + Math.round(unmatchedAdSpend * otherPct);
  // Phần điều chỉnh cước không chia được cho mã nào (kỳ không có dòng mã nào) đứng ở dòng tổng.
  const shipCostAll = totals.shipCost + dieuChinhCuocChuaChia;
  const expectedProfitAll = totals.expectedProfit - unmatchedAdSpend - dieuChinhCuocChuaChia;
  const opexTotal = operatingExpenses + totals.packingCost + totals.opsStaffCost + fixedCost;
  const otherCostsTotal = opexTotal + totals.inventoryRisk + totals.tax + otherCostAll;
  const netProfit = expectedProfitAll - opexTotal - totals.inventoryRisk - totals.tax - otherCostAll;
  // Cùng lý do như từng dòng: rủi ro tính theo HÀNG BÁN RA trong kỳ, không theo lô nhập.
  const profitOnPurchase = totals.expectedRevenue - adSpendAll - totals.purchaseCost - shipCostAll - opexTotal - totals.inventoryRisk - totals.tax - otherCostAll;
  const expectedDeliveredAll = rows.reduce((t, r) => t + (r.returnRate === null ? 0 : r.orders * (1 - Math.min(Math.max(r.returnRate, 0), 100) / 100)), 0);
  /*
    ═══ THẺ "TL GTC ƯỚC TÍNH" TOÀN SHOP = CON SỐ CỦA HỢP ĐỒNG Ở GRAIN ĐƠN ═══

    Bản trước lấy bình quân theo đơn của tỷ lệ từng dòng — gồm cả ghi đè tay, lịch sử, giả định — nên
    thẻ này và thẻ cùng tên ở trang hiệu quả theo mã ra hai số dù cùng mã, cùng kỳ, cùng mốc. Nay thẻ
    đọc THẲNG `orderLevel.projectedRate`; bình quân các tỷ lệ đang dùng vẫn có, ở `assumedDeliveryRate`.
  */
  const mucDon = duBaoGiaoVan?.orderLevel ?? null;
  const adSpendAttributed = totals.adSpend;
  return {
    assumptions,
    rows,
    valueFilter: value,
    adsIncluded: includeAds,
    costShare,
    unknownValueOrders: donChuaBietGiaTri,
    unmatchedAdSpend,
    operatingExpenses,
    operatingCount,
    periodMonths: months,
    fixedCost,
    totals: {
      orders: totals.orders,
      ordersDistinct,
      ordersWeighted: totals.ordersWeighted,
      salesAfterDiscount: totals.salesAfterDiscount,
      items: totals.items,
      grossSales: totals.grossSales,
      adSpend: adSpendAll,
      expectedRevenue: totals.expectedRevenue,
      expectedCogs: totals.expectedCogs,
      expectedQty: totals.expectedQty,
      shipCost: shipCostAll,
      logisticsAdjustment: { amount: dieuChinhCuoc, count: operating.logisticsAdjustment.count },
      expectedProfit: expectedProfitAll,
      margin: totals.expectedRevenue ? (expectedProfitAll / totals.expectedRevenue) * 100 : null,
      delivered: totals.delivered,
      returned: totals.returned,
      inTransit: totals.inTransit,
      actualRevenue: totals.actualRevenue,
      weightedDeliveryRate: mucDon?.projectedRate ?? null,
      weightedReturnRate: mucDon && mucDon.projectedRate !== null ? Math.round((100 - mucDon.projectedRate) * 10) / 10 : null,
      assumedDeliveryRate: totals.ordersWithRate ? 100 - totals.weightedReturn / totals.ordersWithRate : null,
      projection: duBaoGiaoVan && mucDon
        ? { version: duBaoGiaoVan.version, eligibleSent: mucDon.eligibleSent, active: mucDon.active, unmodelledActive: mucDon.unmodelledActive, pending: mucDon.pending, awaitingPickup: mucDon.awaitingPickup, unmodelledRevenue: mucDon.unmodelledRevenue, backtest: duBaoGiaoVan.backtest, backtestError: duBaoGiaoVan.backtestError }
        : null,
      projectionError,
      adSpendAttributed,
      // Thẻ tổng: TỔNG chi (kể cả chưa quy kết) trên các mẫu số toàn shop. Mẫu số 0 ⇒ `null`, không vô cực.
      ads: adsRatios({ adSpend: adSpendAll, posSales: totals.salesAfterDiscount, deliveredRevenueActual: totals.actualRevenue, projectedDeliveredRevenue: totals.expectedRevenue }),
      // Dòng tổng của bảng: chỉ CPQC ĐÃ QUY KẾT, để Σ các dòng và dòng tổng dùng cùng một tử số; phần chưa quy kết đứng riêng.
      adsAttributed: adsRatios({ adSpend: adSpendAttributed, posSales: totals.salesAfterDiscount, deliveredRevenueActual: totals.actualRevenue, projectedDeliveredRevenue: totals.expectedRevenue }),
      adsOverPosSales: adsRatio(adSpendAll, totals.salesAfterDiscount),
      adsOverDeliveredRevenue: adsRatio(adSpendAll, totals.actualRevenue),
      pendingOrders: mucDon?.pending ?? 0,
      unmodelledRevenue: totals.unmodelledRevenue,
      cogsKnown: totals.cogsUncoveredQty === 0,
      cogsUnknownQty: totals.cogsUnknownQty,
      cogsUncoveredQty: totals.cogsUncoveredQty,
      expectedCogsEstimated: totals.expectedCogsEstimated,
      estimatedCostProducts: totals.estimatedCostProducts,
      purchaseCostKnown: totals.purchaseUnknown === 0,
      purchaseCostEstimated: totals.purchaseCostEstimated,
      purchaseUnknownProducts: totals.purchaseUnknown,
      profitOnPurchaseKnown: totals.purchaseUnknown === 0,
      operatingExpenses,
      rescued: totals.rescued,
      packingCost: totals.packingCost,
      opsStaffCost: totals.opsStaffCost,
      fixedCost,
      opexTotal,
      otherCostsTotal,
      inventoryRisk: totals.inventoryRisk,
      inventoryRiskOnPurchase: totals.inventoryRiskOnPurchase,
      stockValue: totals.stockValue,
      stockQty: totals.stockQty,
      stockKnown: totals.stockUnknown === 0,
      outInTransitQty: totals.outInTransitQty,
      outAwaitingReturnQty: totals.outAwaitingReturnQty,
      inventoryRiskPending: totals.inventoryRiskPending,
      netProfit,
      netMargin: totals.expectedRevenue ? (netProfit / totals.expectedRevenue) * 100 : null,
      failed: totals.failed,
      pending: totals.pending,
      tax: totals.tax,
      otherCost: otherCostAll,
      opexPerOrder: totals.orders ? Math.round(otherCostsTotal / totals.orders) : null,
      opexPerDelivered: expectedDeliveredAll > 0 ? Math.round(otherCostsTotal / expectedDeliveredAll) : null,
      purchaseQty: totals.purchaseQty,
      purchaseCost: totals.purchaseCost,
      profitOnPurchase,
      marginOnPurchase: totals.expectedRevenue ? (profitOnPurchase / totals.expectedRevenue) * 100 : null,
    },
  };
}

/**
 * `basis` ĐI VÀO KHOÁ CACHE. Thiếu nó thì lượt xem mốc này phục vụ lại con số của mốc kia — không
 * lỗi, không cảnh báo, chỉ là số sai (AGENTS.md §2: tham số ảnh hưởng kết quả → phải vào cache key).
 */
export async function getNominalProfitReport(
  period: Period,
  basis: TimeBasis = "ORDERED",
  value: OrderValueFilter = NO_ORDER_VALUE_FILTER,
  includeAds = true,
  /**
   * Lấp sản phẩm chưa có giá vốn bằng giá DỰ TÍNH chủ shop đặt (`lib/constants/estimated-cost.ts`).
   * MẶC ĐỊNH TẮT: chỉ tab Lợi nhuận danh nghĩa bật. Lương, báo cáo marketer, trợ lý AI gọi hàm này
   * không tham số nên không bao giờ nhận một giá vốn đoán.
   */
  withEstimatedCost = false,
  /**
   * ĐỌC TỒN KHO HAY KHÔNG. Mặc định CÓ — mọi đường gọi cũ giữ nguyên.
   *
   * Tồn kho ở đây chỉ nuôi các ô GHI CHÚ (giá trị tồn, rủi ro CÒN TREO, "nhập − giao TC"); không
   * một đồng nào của nó đi vào lợi nhuận — rủi ro tồn kho trừ vào kỳ đi theo GIÁ VỐN HÀNG BÁN RA
   * (mục 14). Nhưng `stockByProduct` quét toàn bộ lịch sử dòng hàng và là câu ĐẮT NHẤT của báo
   * cáo: `perf-probe` production 23/09/2026 đo **5,1–6,5 giây** trên tổng 8,1s nguội của kỳ 30 ngày.
   *
   * Bảng bóc tách MKTer theo ngày (`lib/queries/marketer-daily-nominal.ts`) chỉ dùng các khoản
   * tiền, nên nó tắt cờ này. Tắt thì tồn là CHƯA BIẾT (`stockKnown = false`), không phải 0.
   */
  withStock = true,
): Promise<NominalReport> {
  // Bộ lọc giá trị đơn, công tắc quảng cáo, giá dự tính VÀ việc đọc tồn đều đổi kết quả ⇒ đều phải vào khoá cache (§2).
  return memo(`getNominalProfitReport:${basis}:${periodKey(period)}:${orderValueKey(value)}:${includeAds ? "ads" : "noads"}:${withEstimatedCost ? "gvdt" : "thuc"}:${withStock ? "ton" : "khongton"}`, 120000, () =>
    getNominalProfitReportUncached(period, basis, value, includeAds, withEstimatedCost, withStock),
  );
}

/**
 * Giá vốn dự tính theo `productId`: giá báo MKT hiệu lực vào `at` nếu mã đã khai (luật 5 ở
 * `lib/constants/estimated-cost.ts`), không thì con số đặt tay. Dòng hỏng bị bỏ, không thành 0 ₫.
 */
export async function getEstimatedCosts(at: Date = new Date()): Promise<EstimatedCostMap> {
  const [manual, prices] = await Promise.all([getSettingJson<Record<string, unknown>>(ESTIMATED_COST_KEY, {}), marketerPriceEntriesByProduct()]);
  return estimatedCostsWithMarketerPrice(parseEstimatedCosts(manual), prices, at);
}
