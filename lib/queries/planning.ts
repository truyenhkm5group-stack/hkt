import { and, asc, eq, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import { computePlan, DEFAULT_PLANNING, PLANNING_KEY, type PlanInput, type PlanningAssumptions, type PlanOutput, type PlanStatus } from "@/lib/constants/planning";
import { LAST_RECEIPT_COST, erpStockExpr, stockKnownExpr, stockShrinkageExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { productDeliveryRates, type ProductDeliveryRates } from "@/lib/queries/delivery-rate";
import type { DeliveryRateSource } from "@/lib/constants/delivery-rate";
import { resolvePeriod } from "@/lib/search-params";
import { getSettingJson } from "@/lib/settings";

const pv = schema.productVariants;
const p = schema.products;
const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;

export async function loadPlanningAssumptions(): Promise<PlanningAssumptions> {
  const cfg = await getSettingJson<PlanningAssumptions>(PLANNING_KEY, DEFAULT_PLANNING);
  return { ...DEFAULT_PLANNING, ...cfg, leadTimeOverrides: cfg.leadTimeOverrides ?? {}, minOrderQtyOverrides: cfg.minOrderQtyOverrides ?? {} };
}

export type PlanRow = PlanOutput & {
  variantId: string;
  /** false = chưa có phiếu nhập nào ⇒ tồn không tính được, không đề xuất đặt hàng */
  stockKnown: boolean;
  productId: string;
  productName: string;
  productCode: string;
  image: string | null;
  sku: string;
  color: string;
  size: string;
  stock: number;
  pancakeStock: number;
  committed: number;
  inTransit: number;
  awaitingReturn: number;
  /**
   * CÁC VẾ CỦA SỔ KHO — cùng phép gộp với cột `stock`, để màn hình in được "vì sao ra số tồn này"
   * mà không phải hỏi một truy vấn thứ hai (hai truy vấn là hai lúc đọc, và hai lúc đọc có thể lệch).
   *   stock = received − shipped;  received = receiptIn + returnIn + adjust − manualOut
   */
  received: number;
  /** Nhập hàng mới (phiếu RECEIPT). */
  receiptIn: number;
  /** Tái nhập hàng hoàn — số kho ĐẾM THỰC TẾ (phiếu RETURN). */
  returnIn: number;
  /** Điều chỉnh sau kiểm kê, có dấu (phiếu ADJUSTMENT). */
  adjust: number;
  /** Xuất tay không qua ĐVVC, số dương (phiếu ISSUE). */
  manualOut: number;
  /** ĐÃ XUẤT qua ĐVVC — `SHIPMENT_LEFT_WAREHOUSE`, không theo tiền, không theo Pancake. */
  shipped: number;
  /** Hàng hoàn đã lập phiếu nhưng đếm thiếu so với số đã xuất (hụt / hỏng). */
  shrinkage: number;
  /** Số phiếu NHẬP HÀNG đã có — 0 ⇒ `stockKnown = false`. */
  receiptDocs: number;
  sold7: number;
  sold30: number;
  soldInWindow: number;
  /** Giao thành công theo ORDER_OUTCOME (toàn lịch sử) — để tính tỷ lệ hoàn của riêng mẫu mã. */
  delivered: number;
  /** Đơn hoàn theo ORDER_OUTCOME (toàn lịch sử). */
  returned: number;
  /** Số lượng bán của ngày mạnh nhất trong cửa sổ — căn cứ nhận ra đột biến. */
  peakDayQty: number;
  leadTimeDays: number;
  unitCost: number;
  retailPrice: number;
  orderCost: number;
  /**
   * ĐÚNG bộ đầu vào đã đưa vào `computePlan` cho dòng này. Lời diễn giải và các kịch bản
   * (`explainPlan`) tính lại từ chính nó — không dựng lại đầu vào ở nơi khác, nếu không lời giải
   * thích sẽ nói về một phép tính khác với con số đang in.
   */
  input: PlanInput;
  /** Tỷ lệ giao thành công (%) của MÃ HÀNG theo thang bậc chung — `input.returnRate` = 1 − số này. */
  deliveryRate: number;
  /** Căn cứ của tỷ lệ trên (số đo / lịch sử / co ngót / đặt tay / giả định) — in cạnh con số. */
  deliverySource: DeliveryRateSource;
  /** Số ngày ĐVVC trả hàng hoàn về tới shop — ĐO (trung vị). `null` = chưa đủ mẫu. */
  vtpReturnLagDays: number | null;
};

export type PlanOptions = {
  /** Số ngày muốn đủ hàng bán sau khi lô mới về — người dùng chọn ngay trên trang. */
  coverDays?: number;
  /** Có trừ hàng đang ở ngoài / chờ hoàn về khỏi lượng cần đặt không. */
  countIncoming?: boolean;
};

export type PlanReport = {
  assumptions: PlanningAssumptions;
  /** Tham số thực sự đã dùng để tính bảng này. */
  used: { coverDays: number; countIncoming: boolean; returnRecoveryRate: number; shopReturnRate: number; vtpReturnLagDays: number | null; restockDays: number };
  rows: PlanRow[];
  products: { productId: string; productName: string; productCode: string; image: string | null; rows: PlanRow[]; suggested: number; orderCost: number; worst: PlanStatus }[];
  summary: { variants: number; out: number; critical: number; low: number; unknown: number; suggestedUnits: number; orderCost: number; incomingUnits: number; byStatus: Record<PlanStatus, number> };
};

/**
 * Kỳ lấy tỷ lệ GTC theo mã: 90 ngày — cùng cửa sổ mặc định của ma trận Màu × Size trên trang sản
 * phẩm. GTC là THUỘC TÍNH CỦA MÃ, không đổi theo kỳ người xem chọn trên trang Kế hoạch.
 */
const PLAN_DELIVERY_PERIOD = "90d";

const STATUS_RANK: Record<PlanStatus, number> = { OUT: 0, UNKNOWN: 1, CRITICAL: 2, LOW: 3, OK: 4, IDLE: 5 };

/**
 * Số cái theo mẫu mã trong N ngày theo ngày lên đơn.
 *   · RÒNG (mặc định, để HIỂN THỊ "bán 7/30 ngày"): không huỷ, không hoàn, không tặng.
 *   · GỘP (`gross`, để TÍNH TỐC ĐỘ GỬI ĐI): chỉ bỏ đơn huỷ — gồm cả đơn đang giao, đơn đã hoàn và
 *     hàng tặng, vì tất cả đều rời kho. Phần quay về được trừ tường minh trong `computePlan`.
 */
function demandSubquery(db: Awaited<ReturnType<typeof getDb>>, days: number, alias: string, gross = false) {
  return db
    .select({
      variantId: oi.variantId,
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as(`qty_${alias}`),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(
      gross
        ? sql`${o.insertedAt} >= now() - (${days} || ' days')::interval and ${ORDER_OUTCOME_FAST} <> 'CANCELLED'`
        : sql`${o.insertedAt} >= now() - (${days} || ' days')::interval and ${ORDER_OUTCOME_FAST} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE') and ${oi.isBonus} = false`,
    )
    .groupBy(oi.variantId)
    .as(`demand_${alias}`);
}

/**
 * NGÀY BÁN MẠNH NHẤT của từng mẫu mã trong cửa sổ tính tốc độ.
 *
 * Dùng để nhận ra đột biến: một buổi livestream bán 60 cái trong 14 ngày đẩy tốc độ lên 4,3
 * cái/ngày, và kế hoạch sẽ đặt sản xuất theo nhịp đó cho cả tháng sau. Xem `computeVelocity`.
 *
 * Ngày tính theo GIỜ VIỆT NAM: một buổi live tối muộn không được tách làm hai ngày.
 */
function peakDaySubquery(db: Awaited<ReturnType<typeof getDb>>, days: number) {
  const daily = db
    .select({
      variantId: oi.variantId,
      day: sql<string>`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`.as("sale_day"),
      qty: sql<number>`coalesce(sum(${oi.quantity}), 0)`.as("day_qty"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    // Cùng tập GỘP với tốc độ gửi đi — so ngày mạnh nhất với tổng của một tập khác là vô nghĩa.
    .where(sql`${o.insertedAt} >= now() - (${days} || ' days')::interval and ${ORDER_OUTCOME_FAST} <> 'CANCELLED'`)
    .groupBy(oi.variantId, sql`((${o.insertedAt} at time zone 'Asia/Ho_Chi_Minh')::date)`)
    .as("daily_sales");

  return db
    .select({ variantId: daily.variantId, peak: sql<number>`coalesce(max(${daily.qty}), 0)`.as("peak_day_qty") })
    .from(daily)
    .groupBy(daily.variantId)
    .as("peak_day");
}

/**
 * ═══════ CÂU LỆNH DÒNG KẾ HOẠCH — TÁCH RA ĐỂ ĐO ĐƯỢC ═══════
 *
 * Trước đây câu này dựng ngay trong `getReplenishmentPlanUncached`, nên công cụ chẩn đoán muốn
 * `EXPLAIN` nó thì phải CHÉP TAY lại SQL — và chép tay nghĩa là đo một câu khác với câu đang chạy
 * thật. Tách ra ở đây, không đổi một dấu nào của truy vấn.
 *
 * `scripts/explain-stock.ts` gọi đúng hàm này.
 */
export function buildPlanRowsQuery(db: Awaited<ReturnType<typeof getDb>>, a: PlanningAssumptions, productId?: string) {
  const sales = variantSalesSubquery(db);
  const receipts = variantReceiptsSubquery(db);
  const d7 = demandSubquery(db, 7, "d7");
  const d30 = demandSubquery(db, 30, "d30");
  const dw = demandSubquery(db, Math.max(1, a.velocityWindowDays), "dw", true);
  const peak = peakDaySubquery(db, Math.max(1, a.velocityWindowDays));
  return db
    .select({
      variantId: pv.id,
      productId: pv.productId,
      productName: p.name,
      productCode: sql<string>`coalesce(${p.customId}, '')`,
      image: sql<string | null>`coalesce(${pv.images}[1], ${p.image})`,
      sku: pv.sku,
      color: pv.color,
      size: pv.size,
      stock: erpStockExpr(sales, receipts),
      stockKnown: stockKnownExpr(receipts),
      pancakeStock: pv.remainQuantity,
      committed: sql<number>`coalesce(${sales.reserved}, 0)`,
      inTransit: sql<number>`coalesce(${sales.inTransit}, 0)`,
      awaitingReturn: sql<number>`coalesce(${sales.awaitingReturn}, 0)`,
      returnHandled: sql<number>`coalesce(${sales.returnHandled}, 0)`,
      returnRestocked: sql<number>`coalesce(${receipts.returnIn}, 0)`,
      received: sql<number>`coalesce(${receipts.received}, 0)`,
      receiptIn: sql<number>`coalesce(${receipts.receiptIn}, 0)`,
      adjust: sql<number>`coalesce(${receipts.adjust}, 0)`,
      manualOut: sql<number>`coalesce(${receipts.manualOut}, 0)`,
      shipped: sql<number>`coalesce(${sales.shipped}, 0)`,
      shrinkage: stockShrinkageExpr(sales, receipts),
      receiptDocs: sql<number>`coalesce(${receipts.receiptDocs}, 0)`,
      delivered: sql<number>`coalesce(${sales.delivered}, 0)`,
      returned: sql<number>`coalesce(${sales.returned}, 0)`,
      sold7: sql<number>`coalesce(${d7.qty}, 0)`,
      sold30: sql<number>`coalesce(${d30.qty}, 0)`,
      soldInWindow: sql<number>`coalesce(${dw.qty}, 0)`,
      peakDayQty: sql<number>`coalesce(${peak.peak}, 0)`,
      unitCost: sql<number>`coalesce(${LAST_RECEIPT_COST}, ${pv.lastImportedPrice}, 0)`,
      retailPrice: pv.retailPrice,
    })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .leftJoin(sales, eq(sales.variantId, pv.id))
    .leftJoin(receipts, eq(receipts.variantId, pv.id))
    .leftJoin(d7, eq(d7.variantId, pv.id))
    .leftJoin(d30, eq(d30.variantId, pv.id))
    .leftJoin(dw, eq(dw.variantId, pv.id))
    .leftJoin(peak, eq(peak.variantId, pv.id))
    // Một mã hàng (trang chi tiết sản phẩm) thì lấy CẢ mẫu mã đã xoá: hàng của mẫu mã đã xoá vẫn
    // nằm trong kho cho tới khi có phiếu xuất, và trang chi tiết là nơi duy nhất người ta nhìn thấy nó.
    .where(productId ? eq(pv.productId, productId) : sql`${pv.isRemoved} = false and ${p.isRemoved} = false`)
    .orderBy(asc(p.name), asc(pv.sku));
}

/**
 * Mẫu mã CÓ VIỆC: có bán, có tồn, có đơn chờ xuất, có đề xuất đặt, hoặc chưa biết tồn.
 * Mẫu mã tồn 0 không bán thì `computePlan` vẫn trả `OUT` (khả dụng ≤ 0) — nhưng đó là mẫu mã đã
 * ngừng, không phải mẫu mã đứt hàng; cảnh báo nó là dạy nhân viên bỏ qua cảnh báo.
 */
export function isPlanRowActive(r: Pick<PlanRow, "sold30" | "stock" | "committed" | "suggested" | "status">) {
  return r.sold30 > 0 || r.stock !== 0 || r.committed > 0 || r.suggested > 0 || r.status === "UNKNOWN";
}

type PlanQueryRow = Awaited<ReturnType<typeof buildPlanRowsQuery>>[number];

/** Các số TOÀN SHOP / THEO MÃ HÀNG mà từng dòng kế hoạch cần — mẫu từng mẫu mã quá nhỏ để tự đứng. */
type ShopRates = {
  returnRecoveryRate: number;
  /** Chỉ còn để `inventory-decision.ts` đọc; kế hoạch đặt hàng KHÔNG dùng nó nữa (xem `toPlanRow`). */
  shopReturnRate: number;
  /** Thang bậc GTC theo mã hàng (AGENTS.md mục 68). */
  deliveryRates: ProductDeliveryRates;
  /** Số ngày ĐVVC trả hàng hoàn về shop — ĐO. `null` = chưa đủ mẫu. */
  vtpReturnLagDays: number | null;
  /** Giả định: kho tái nhập trong bao nhiêu ngày sau khi hàng về. */
  restockDays: number;
};

/** Dưới ngần này kiện hoàn thì trung vị độ trễ không đáng tin ⇒ `null` ⇒ không trừ hàng hoàn tương lai. */
const MIN_RETURN_LAG_SAMPLE = 30;
/** Cửa sổ đo độ trễ ĐVVC trả hàng về — theo ngày LẤY HÀNG. */
const RETURN_LAG_WINDOW_DAYS = 90;

/**
 * ĐỘ TRỄ ĐVVC TRẢ HÀNG HOÀN VỀ SHOP (ngày) — trung vị `returned_at − picked_up_at` của kiện lấy
 * hàng trong 90 ngày. Đo production 23/09/2026: 685 kiện, trung vị 7,7 · p25 5,9 · p75 9,6.
 *
 * CỐ Ý không đo tới mốc KHO TÁI NHẬP (`return_received_at`): 606/606 kiện tái nhập trong 60 ngày
 * được làm trong ĐÚNG MỘT NGÀY — một lần nhập bù, không phải một quy trình. Phần đó là Giả định
 * `restockDays`, do chủ shop đặt như một mục tiêu vận hành.
 */
async function measureVtpReturnLag(db: Awaited<ReturnType<typeof getDb>>): Promise<number | null> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)`,
      median: sql<number | null>`percentile_cont(0.5) within group (order by extract(epoch from (${s.returnedAt} - ${s.pickedUpAt})) / 86400)`,
    })
    .from(s)
    .where(sql`${s.returnedAt} is not null and ${s.pickedUpAt} is not null and ${s.returnedAt} > ${s.pickedUpAt} and ${s.pickedUpAt} >= now() - (${RETURN_LAG_WINDOW_DAYS} || ' days')::interval`);
  const n = Number(row?.n ?? 0);
  const median = row?.median === null || row?.median === undefined ? null : Number(row.median);
  return n >= MIN_RETURN_LAG_SAMPLE && median !== null && Number.isFinite(median) ? Math.round(median * 10) / 10 : null;
}

function shopRatesFrom(rows: PlanQueryRow[]): Pick<ShopRates, "returnRecoveryRate" | "shopReturnRate"> {
  // Tỷ lệ nhập lại được kho: hàng hoàn đã lập phiếu tái nhập ÷ hàng hoàn đã xử lý, tính trên toàn
  // shop (mẫu từng mẫu mã quá nhỏ). Chưa có dữ liệu thì coi như về đủ — đó là mặc định vật lý.
  const tongHoanDaXuLy = rows.reduce((t, r) => t + Number(r.returnHandled ?? 0), 0);
  const tongHoanDaNhapLai = rows.reduce((t, r) => t + Number(r.returnRestocked ?? 0), 0);
  const returnRecoveryRate = tongHoanDaXuLy > 0 ? Math.min(1, tongHoanDaNhapLai / tongHoanDaXuLy) : 1;
  // Tỷ lệ hoàn để ước phần hàng đang ở ngoài sẽ quay về: dùng số của chính mẫu mã khi đủ mẫu,
  // không đủ thì dùng số toàn shop.
  const tongGiao = rows.reduce((t, r) => t + Number(r.delivered ?? 0), 0);
  const tongHoan = rows.reduce((t, r) => t + Number(r.returned ?? 0), 0);
  const shopReturnRate = tongGiao + tongHoan > 0 ? tongHoan / (tongGiao + tongHoan) : 0;
  return { returnRecoveryRate, shopReturnRate };
}

/**
 * MỘT dòng câu lệnh → MỘT dòng kế hoạch. Trang Kế hoạch SX và trang chi tiết sản phẩm đều đi qua
 * đây, nên một mẫu mã không thể "sắp thiếu" ở trang này mà "đủ hàng" ở trang kia.
 */
function toPlanRow(r: PlanQueryRow, a: PlanningAssumptions, rates: ShopRates, countIncoming: boolean): PlanRow {
  const leadTimeDays = a.leadTimeOverrides[r.productId] ?? a.leadTimeDays;
  /*
    TỶ LỆ HOÀN = 1 − GTC của MÃ HÀNG theo thang bậc chung (ghi đè tay → số đo → lịch sử → co ngót →
    giả định). Trước 23/09/2026 chỗ này tự tính: tỷ lệ của mẫu mã khi đủ 20 đơn, không thì TỶ LỆ NỀN
    TOÀN SHOP — đúng con số bị Đầm Q002 chi phối mà chủ shop đã bác bỏ (xem delivery-rate.ts).
  */
  const gtc = rates.deliveryRates.byProduct.get(r.productId) ?? rates.deliveryRates.fallback;
  const returnRate = gtc.returnRate / 100;
  const returnLagDays = rates.vtpReturnLagDays === null ? null : rates.vtpReturnLagDays + Math.max(0, rates.restockDays);
  const input: PlanInput = { stock: Number(r.stock ?? 0), stockKnown: Boolean(r.stockKnown), committed: Number(r.committed ?? 0), soldInWindow: Number(r.soldInWindow ?? 0), windowDays: Math.max(1, a.velocityWindowDays), leadTimeDays, coverDays: a.coverDays, safetyDays: a.safetyDays, roundTo: Math.max(1, a.roundTo), peakDayQty: Number(r.peakDayQty ?? 0), minOrderQty: a.minOrderQtyOverrides?.[r.productId] ?? a.minOrderQty, inTransit: Number(r.inTransit ?? 0), awaitingReturn: Number(r.awaitingReturn ?? 0), returnRate, returnLagDays, returnRecoveryRate: rates.returnRecoveryRate, countIncoming };
  const plan = computePlan(input);
  const unitCost = Number(r.unitCost ?? 0);
  return {
    ...plan,
    input,
    deliveryRate: gtc.deliveryRate,
    deliverySource: gtc.source,
    vtpReturnLagDays: rates.vtpReturnLagDays,
    variantId: r.variantId,
    productId: r.productId,
    productName: r.productName,
    productCode: r.productCode ?? "",
    image: r.image,
    sku: r.sku,
    color: r.color,
    size: r.size,
    stock: Number(r.stock ?? 0),
    stockKnown: Boolean(r.stockKnown),
    pancakeStock: Number(r.pancakeStock ?? 0),
    committed: Number(r.committed ?? 0),
    inTransit: Number(r.inTransit ?? 0),
    awaitingReturn: Number(r.awaitingReturn ?? 0),
    received: Number(r.received ?? 0),
    receiptIn: Number(r.receiptIn ?? 0),
    returnIn: Number(r.returnRestocked ?? 0),
    adjust: Number(r.adjust ?? 0),
    manualOut: Number(r.manualOut ?? 0),
    shipped: Number(r.shipped ?? 0),
    shrinkage: Number(r.shrinkage ?? 0),
    receiptDocs: Number(r.receiptDocs ?? 0),
    sold7: Number(r.sold7 ?? 0),
    sold30: Number(r.sold30 ?? 0),
    soldInWindow: Number(r.soldInWindow ?? 0),
    delivered: Number(r.delivered ?? 0),
    returned: Number(r.returned ?? 0),
    peakDayQty: Number(r.peakDayQty ?? 0),
    leadTimeDays,
    unitCost,
    retailPrice: Number(r.retailPrice ?? 0),
    orderCost: plan.suggested * unitCost,
  };
}

async function getReplenishmentPlanUncached(opt: PlanOptions): Promise<PlanReport> {
  const db = await getDb();
  const saved = await loadPlanningAssumptions();
  const coverDays = Number.isFinite(opt.coverDays) ? Math.min(365, Math.max(0, Math.round(opt.coverDays as number))) : saved.coverDays;
  const countIncoming = opt.countIncoming !== false;
  const a: PlanningAssumptions = { ...saved, coverDays };
  // JIT tắt trong đúng giao dịch này: đo được 8.578ms → 26ms cho một truy vấn cùng loại, toàn bộ
  // chênh lệch là thời gian biên dịch. Xem `chayKhongJit`.
  const rows = await chayKhongJit(db, (tx) => buildPlanRowsQuery(tx, a));

  const [deliveryRates, vtpReturnLagDays] = await Promise.all([productDeliveryRates(resolvePeriod({}, PLAN_DELIVERY_PERIOD)), measureVtpReturnLag(db)]);
  const rates: ShopRates = { ...shopRatesFrom(rows), deliveryRates, vtpReturnLagDays, restockDays: a.restockDays };
  const { returnRecoveryRate, shopReturnRate } = rates;
  const planRows: PlanRow[] = rows.map((r) => toPlanRow(r, a, rates, countIncoming));
  const active = planRows.filter(isPlanRowActive);
  const byProduct = new Map<string, PlanReport["products"][number]>();
  for (const r of active) {
    const g = byProduct.get(r.productId) ?? { productId: r.productId, productName: r.productName, productCode: r.productCode, image: r.image, rows: [], suggested: 0, orderCost: 0, worst: "IDLE" as PlanStatus };
    g.rows.push(r);
    g.suggested += r.suggested;
    g.orderCost += r.orderCost;
    if (STATUS_RANK[r.status] < STATUS_RANK[g.worst]) g.worst = r.status;
    byProduct.set(r.productId, g);
  }
  const products = [...byProduct.values()].sort((x, y) => STATUS_RANK[x.worst] - STATUS_RANK[y.worst] || y.suggested - x.suggested);
  for (const g of products) g.rows.sort((x, y) => STATUS_RANK[x.status] - STATUS_RANK[y.status] || y.suggested - x.suggested);
  const byStatus: Record<PlanStatus, number> = { OUT: 0, UNKNOWN: 0, CRITICAL: 0, LOW: 0, OK: 0, IDLE: 0 };
  for (const r of active) byStatus[r.status] += 1;
  return {
    assumptions: a,
    used: { coverDays: a.coverDays, countIncoming, returnRecoveryRate, shopReturnRate, vtpReturnLagDays, restockDays: a.restockDays },
    rows: active,
    products,
    summary: { variants: active.length, out: byStatus.OUT, critical: byStatus.CRITICAL, low: byStatus.LOW, unknown: byStatus.UNKNOWN, suggestedUnits: active.reduce((t, r) => t + r.suggested, 0), orderCost: active.reduce((t, r) => t + r.orderCost, 0), incomingUnits: active.reduce((t, r) => t + r.incoming, 0), byStatus },
  };
}

export async function getReplenishmentPlan(opt: PlanOptions = {}) {
  const khoa = `${opt.coverDays ?? "mac-dinh"}:${opt.countIncoming === false ? "khong-tinh-hoan" : "tinh-hoan"}`;
  return memo(`getReplenishmentPlan:${khoa}`, 120000, () => getReplenishmentPlanUncached(opt));
}

/**
 * TỒN KHO + CẢNH BÁO ĐẶT HÀNG CỦA MỘT MÃ HÀNG — cho trang chi tiết sản phẩm.
 *
 * Số tồn đọc TƯƠI (không đệm): nhân viên vừa lập phiếu nhập rồi mở trang sản phẩm thì phải thấy
 * ngay. Chỉ bộ giả định và hai tỷ lệ toàn shop (hoàn, nhập lại được) lấy từ bản kế hoạch đã đệm —
 * chúng đổi theo tuần chứ không theo phút, và tính lại chúng là quét cả shop cho một mã hàng.
 *
 * Trả về MỌI mẫu mã của mã hàng, kể cả mẫu mã đứng yên mà bản kế hoạch toàn shop lọc bỏ — trang
 * chi tiết phải in đủ từng dòng; dòng không có việc gì thì in "không bán", không biến mất.
 */
export async function getProductStockPlan(productId: string) {
  const [shop, db] = await Promise.all([getReplenishmentPlan(), getDb()]);
  const a = shop.assumptions;
  const rows = await chayKhongJit(db, (tx) => buildPlanRowsQuery(tx, a, productId));
  const deliveryRates = await productDeliveryRates(resolvePeriod({}, PLAN_DELIVERY_PERIOD));
  const rates: ShopRates = { returnRecoveryRate: shop.used.returnRecoveryRate, shopReturnRate: shop.used.shopReturnRate, deliveryRates, vtpReturnLagDays: shop.used.vtpReturnLagDays, restockDays: shop.used.restockDays };
  return { assumptions: a, used: shop.used, rows: rows.map((r) => toPlanRow(r, a, rates, shop.used.countIncoming)) };
}

export type ProductStockPlan = Awaited<ReturnType<typeof getProductStockPlan>>;
