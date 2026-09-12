import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";
import {
  DECISION_RANK,
  DECISION_RULE,
  decideInventory,
  type InventoryDecisionKind,
  type InventoryDecisionResult,
} from "@/lib/constants/inventory-decision";
import { SLOW_MOVING_RULES } from "@/lib/constants/slow-moving";
import { computePlan } from "@/lib/constants/planning";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import { ORDER_OUTCOME_FAST, PRIMARY_ATTEMPT, SHIPMENT_LEFT_WAREHOUSE } from "@/lib/queries/return-rate";

/**
 * ───────────── QUYẾT ĐỊNH VỐN TỒN KHO — TẦNG GHÉP DỮ LIỆU ─────────────
 *
 * KHÔNG có công thức đo lường mới. Mọi con số lấy nguyên từ các bộ máy đã có:
 *
 *  · tồn / khả dụng / tốc độ / số nên đặt  → `getReplenishmentPlan` (kế hoạch đặt hàng SX);
 *  · lần bán cuối                           → `getSlowMoving` (hàng bán chậm);
 *  · hàng đã đặt xưởng chưa nhận            → `production_orders` trạng thái SENT — thứ mà kế
 *    hoạch SX hiện KHÔNG trừ, nên mẫu đã đặt 500 cái vẫn bị kêu đặt thêm;
 *  · tuổi mẫu mã                            → phiếu NHẬP đầu tiên (mẫu mới không bị kết tội
 *    "hàng chết" trên 5 ngày lịch sử).
 *
 * Tầng này chỉ GHÉP các con số đó rồi đưa qua `decideInventory` (hàm thuần, kiểm thử được).
 * CHỈ ĐỌC và CHỈ ĐỀ XUẤT: không tạo đơn sản xuất, không sửa tồn, không ghi gì cả.
 */

const pv = schema.productVariants;
const ri = schema.stockReceiptItems;
const rc = schema.stockReceipts;
const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const po = schema.productionOrders;

const DAY_MS = 86_400_000;

export type InventoryDecisionRow = InventoryDecisionResult & {
  variantId: string;
  productId: string;
  productName: string;
  productCode: string;
  sku: string;
  color: string;
  size: string;
  image: string | null;
  stock: number;
  available: number;
  committed: number;
  inTransit: number;
  awaitingReturn: number;
  /** Hàng ước quay lại kho (số của kế hoạch SX). */
  incoming: number;
  /** Đã đặt xưởng (SENT) chưa nhận. */
  openPoQty: number;
  velocity: number;
  velocityTrimmed: boolean;
  daysOfCover: number | null;
  stockOutDate: string | null;
  reorderByDate: string | null;
  leadTimeDays: number;
  leadTimeSource: "override" | "default";
  /** `null` = CHƯA BIẾT giá nhập — không phải 0đ. */
  unitCost: number | null;
  /** `null` = chưa khai giá bán. */
  retailPrice: number | null;
  /** % hoàn hiệu lực; `null` khi toàn shop cũng chưa có đơn kết thúc. */
  returnRatePct: number | null;
  returnRateSource: "variant" | "shop" | null;
  daysSinceLastSale: number | null;
  ageDays: number | null;
  sold7: number;
  sold30: number;
  soldInWindow: number;
};

export type InventoryDecisionReport = {
  rows: InventoryDecisionRow[];
  /** Số mẫu mã ở trạng thái GIỮ NGUYÊN — không hiện từng dòng để bảng tập trung vào việc phải làm. */
  holdCount: number;
  byDecision: Record<InventoryDecisionKind, number>;
  summary: {
    variants: number;
    /** Vốn cần bỏ ra cho mọi đề xuất đặt (chỉ dòng BIẾT giá nhập). */
    capitalRequired: number;
    /** Số dòng có đề xuất đặt nhưng KHÔNG tính được tiền vì thiếu giá nhập. */
    capitalRequiredUnknown: number;
    /** Vốn (theo giá nhập) có thể giải phóng nếu xả phần vượt mức / hàng chết. */
    capitalFreeable: number;
    capitalFreeableUnknown: number;
    /** ƯỚC TÍNH lãi gộp đang bị đe doạ bởi các mẫu nguy cơ hết hàng. */
    grossImpactEstimate: number;
    /** Cam kết với xưởng: tổng số món và tiền của đơn sản xuất SENT. */
    openPoUnits: number;
    openPoCapital: number;
    /** Món trong đơn SENT không ghép được về mẫu mã (thiếu product_id / lệch màu-size). */
    openPoUnmappedUnits: number;
  };
  /** Độ phủ dữ liệu — người đọc phải biết con số đứng trên nền chắc tới đâu. */
  coverage: {
    stockKnownPct: number;
    costKnownPct: number;
    returnRateOwnPct: number;
    leadTimeOverridePct: number;
  };
  used: { coverDays: number; leadTimeDays: number; shopReturnRate: number };
};

const norm = (v: string) => v.trim().toLowerCase();

/**
 * Số lượng ĐÃ ĐẶT XƯỞNG chưa nhận, theo mẫu mã. Đơn sản xuất lưu ma trận "màu|size" ở cấp MÃ
 * HÀNG, nên phải ghép về mẫu mã bằng (product, màu, size). Ô không ghép được thì ĐẾM RIÊNG và nói
 * ra — không chia đều, không đoán.
 */
export async function openPoQtyByVariant() {
  const db = await getDb();
  const rows = await db
    .select({ id: po.id, productId: po.productId, cells: po.cells, totalQty: po.totalQty, unitCost: po.unitCost })
    .from(po)
    .where(eq(po.status, "SENT"));

  const productIds = [...new Set(rows.map((x) => x.productId).filter((x): x is string => Boolean(x)))];
  const variants = productIds.length
    ? await db
        .select({ id: pv.id, productId: pv.productId, color: pv.color, size: pv.size })
        .from(pv)
        .where(inArray(pv.productId, productIds))
    : [];
  const byKey = new Map<string, string>();
  for (const v of variants) byKey.set(`${v.productId}::${norm(v.color)}|${norm(v.size)}`, v.id);

  const qtyByVariant = new Map<string, number>();
  let unmappedUnits = 0;
  let units = 0;
  let capital = 0;
  for (const row of rows) {
    units += Number(row.totalQty ?? 0);
    capital += Number(row.totalQty ?? 0) * Number(row.unitCost ?? 0);
    const cells = (row.cells ?? {}) as Record<string, number>;
    for (const [key, rawQty] of Object.entries(cells)) {
      const qty = Math.max(0, Number(rawQty ?? 0));
      if (!qty) continue;
      const sep = key.indexOf("|");
      const color = sep >= 0 ? key.slice(0, sep) : key;
      const size = sep >= 0 ? key.slice(sep + 1) : "";
      const variantId = row.productId ? byKey.get(`${row.productId}::${norm(color)}|${norm(size)}`) : undefined;
      if (variantId) qtyByVariant.set(variantId, (qtyByVariant.get(variantId) ?? 0) + qty);
      else unmappedUnits += qty;
    }
  }
  return { qtyByVariant, unmappedUnits, units, capital };
}

/** Tuổi mẫu mã = hôm nay − phiếu NHẬP đầu tiên. Chưa có phiếu nhập thì tuổi CHƯA BIẾT. */
async function firstReceiptByVariant() {
  const db = await getDb();
  const rows = await db
    .select({ variantId: ri.variantId, firstAt: sql<string | null>`min(${rc.receivedAt})`.as("first_receipt_at") })
    .from(ri)
    .innerJoin(rc, eq(rc.id, ri.receiptId))
    .where(eq(rc.kind, "RECEIPT"))
    .groupBy(ri.variantId);
  const map = new Map<string, Date>();
  for (const r of rows) if (r.firstAt) map.set(r.variantId, new Date(r.firstAt));
  return map;
}

async function decisionReportUncached(): Promise<InventoryDecisionReport> {
  const [plan, slow, openPo, firstReceipt] = await Promise.all([
    getReplenishmentPlan(),
    getSlowMoving(),
    openPoQtyByVariant(),
    firstReceiptByVariant(),
  ]);
  const a = plan.assumptions;
  const shopReturnRate = plan.used.shopReturnRate;
  const lastSale = new Map(slow.rows.map((r) => [r.variantId, r.daysSinceLastSale]));
  // Toàn shop đã có đơn kết thúc chưa — chưa có thì tỷ lệ hoàn là CHƯA BIẾT, không phải 0%.
  const shopFinished = plan.rows.reduce((t, r) => t + r.delivered + r.returned, 0);
  const now = Date.now();

  const rows: InventoryDecisionRow[] = [];
  let holdCount = 0;
  const byDecision: Record<InventoryDecisionKind, number> = {
    STOCKOUT_RISK: 0,
    REORDER: 0,
    OVERSTOCK: 0,
    CLEARANCE_CANDIDATE: 0,
    HOLD: 0,
    DATA_INSUFFICIENT: 0,
  };
  let capitalRequired = 0;
  let capitalRequiredUnknown = 0;
  let capitalFreeable = 0;
  let capitalFreeableUnknown = 0;
  let grossImpactEstimate = 0;
  let stockKnownCount = 0;
  let costKnownCount = 0;
  let returnOwnCount = 0;
  let leadOverrideCount = 0;

  for (const r of plan.rows) {
    const unitCost = r.unitCost > 0 ? r.unitCost : null;
    const retailPrice = r.retailPrice > 0 ? r.retailPrice : null;
    const finished = r.delivered + r.returned;
    const ownSample = finished >= DECISION_RULE.minReturnSample;
    const returnRate = ownSample ? r.returned / finished : shopFinished > 0 ? shopReturnRate : null;
    const returnRateSource: "variant" | "shop" | null = ownSample ? "variant" : returnRate === null ? null : "shop";
    const leadTimeSource: "override" | "default" = a.leadTimeOverrides[r.productId] != null ? "override" : "default";
    const firstAt = firstReceipt.get(r.variantId);
    const ageDays = firstAt ? Math.floor((now - firstAt.getTime()) / DAY_MS) : null;
    const daysSinceLastSale = lastSale.get(r.variantId) ?? null;

    if (r.stockKnown) stockKnownCount += 1;
    if (unitCost !== null) costKnownCount += 1;
    if (ownSample) returnOwnCount += 1;
    if (leadTimeSource === "override") leadOverrideCount += 1;

    const decision = decideInventory({
      stockKnown: r.stockKnown,
      stock: r.stock,
      available: r.available,
      incomingFromReturns: r.incoming,
      openPoQty: openPo.qtyByVariant.get(r.variantId) ?? 0,
      velocity: r.velocity,
      velocityTrimmed: r.velocityTrimmed,
      soldInWindow: r.soldInWindow,
      sold30: r.sold30,
      daysOfCover: r.daysOfCover,
      leadTimeDays: r.leadTimeDays,
      leadTimeSource,
      safetyDays: a.safetyDays,
      suggested: r.suggested,
      unitCost,
      retailPrice,
      returnRate,
      returnRateSource,
      daysSinceLastSale,
      ageDays,
    });

    byDecision[decision.decision] += 1;
    if (decision.decision === "STOCKOUT_RISK" || decision.decision === "REORDER") {
      if (decision.capitalRequired !== null) capitalRequired += decision.capitalRequired;
      else if ((decision.suggestedQty ?? 0) > 0) capitalRequiredUnknown += 1;
    }
    if (decision.excessQty > 0) {
      if (decision.capitalFreeable !== null) capitalFreeable += decision.capitalFreeable;
      else capitalFreeableUnknown += 1;
    }
    if (decision.grossImpactEstimate !== null) grossImpactEstimate += decision.grossImpactEstimate;

    if (decision.decision === "HOLD") {
      holdCount += 1;
      continue; // bảng chỉ hiện việc PHẢI làm; mẫu ổn định đếm vào thẻ tổng, không chiếm chỗ.
    }

    rows.push({
      ...decision,
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName,
      productCode: r.productCode,
      sku: r.sku,
      color: r.color,
      size: r.size,
      image: r.image,
      stock: r.stock,
      available: r.available,
      committed: r.committed,
      inTransit: r.inTransit,
      awaitingReturn: r.awaitingReturn,
      incoming: r.incoming,
      openPoQty: openPo.qtyByVariant.get(r.variantId) ?? 0,
      velocity: Math.round(r.velocity * 100) / 100,
      velocityTrimmed: r.velocityTrimmed,
      daysOfCover: r.daysOfCover === null ? null : Math.round(r.daysOfCover * 10) / 10,
      stockOutDate: r.stockOutDate,
      reorderByDate: r.reorderByDate,
      leadTimeDays: r.leadTimeDays,
      leadTimeSource,
      unitCost,
      retailPrice,
      returnRatePct: returnRate === null ? null : Math.round(returnRate * 1000) / 10,
      returnRateSource,
      daysSinceLastSale,
      ageDays,
      sold7: r.sold7,
      sold30: r.sold30,
      soldInWindow: r.soldInWindow,
    });
  }

  // Việc mất tiền ngay đứng trước; trong cùng nhóm, khoản tiền lớn nhất đứng trước.
  rows.sort((x, y) => {
    const rank = DECISION_RANK[x.decision] - DECISION_RANK[y.decision];
    if (rank !== 0) return rank;
    const money = (r: InventoryDecisionRow) => Math.max(r.capitalRequired ?? 0, r.capitalFreeable ?? 0, r.grossImpactEstimate ?? 0);
    return money(y) - money(x);
  });

  const total = plan.rows.length;
  const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
  return {
    rows,
    holdCount,
    byDecision,
    summary: {
      variants: total,
      capitalRequired: Math.round(capitalRequired),
      capitalRequiredUnknown,
      capitalFreeable: Math.round(capitalFreeable),
      capitalFreeableUnknown,
      grossImpactEstimate: Math.round(grossImpactEstimate),
      openPoUnits: openPo.units,
      openPoCapital: Math.round(openPo.capital),
      openPoUnmappedUnits: openPo.unmappedUnits,
    },
    coverage: {
      stockKnownPct: pct(stockKnownCount),
      costKnownPct: pct(costKnownCount),
      returnRateOwnPct: pct(returnOwnCount),
      leadTimeOverridePct: pct(leadOverrideCount),
    },
    used: { coverDays: plan.used.coverDays, leadTimeDays: a.leadTimeDays, shopReturnRate },
  };
}

export async function getInventoryDecisionReport(): Promise<InventoryDecisionReport> {
  return memo("inventoryDecisionReport", 120_000, decisionReportUncached);
}

/**
 * ───────────── ĐỐI CHỨNG LỊCH SỬ (BACKTEST) — TOÀN BỘ LÀ ƯỚC TÍNH ─────────────
 *
 * Câu hỏi: nếu bộ máy này chạy `daysBack` ngày trước, kết luận của nó có khớp với những gì THẬT SỰ
 * xảy ra sau đó không?
 *
 * Giới hạn nói trước (proxy, không phải sổ sách thời điểm):
 *  · tồn tại mốc quá khứ dựng lại từ phiếu kho và mốc rời kho (`picked_up_at`, thiếu thì ngày lên
 *    đơn) — KHÔNG có phần "đã chốt chưa gửi" của thời điểm đó;
 *  · tốc độ bán KHÔNG cắt ngày đột biến (thiếu dữ liệu ngày-theo-ngày tại mốc cũ thì thà thô mà
 *    nói rõ còn hơn tinh mà bịa);
 *  · "hết hàng thật" = tồn dựng lại ≤ 0 tại cuối chân trời — hàng thiếu mà khách vẫn muốn mua thì
 *    không nguồn dữ liệu nào ghi lại được.
 */
export type DecisionBacktest = {
  daysBack: number;
  horizonDays: number;
  windowDays: number;
  evaluated: number;
  stockout: { predicted: number; confirmed: number };
  overstock: { predicted: number; stillExcess: number };
  clearance: { predicted: number; noSales: number };
  notes: string[];
};

async function backtestUncached(daysBack: number): Promise<DecisionBacktest> {
  const db = await getDb();
  const plan = await getReplenishmentPlan();
  const a = plan.assumptions;
  const windowDays = Math.max(1, a.velocityWindowDays);
  const horizonDays = Math.min(Math.max(1, a.leadTimeDays), daysBack);
  const cutoff = new Date(Date.now() - daysBack * DAY_MS);
  const beforeStart = new Date(cutoff.getTime() - windowDays * DAY_MS);
  const horizonEnd = new Date(cutoff.getTime() + horizonDays * DAY_MS);

  // Nhu cầu ròng quanh mốc cắt + lần bán cuối trước mốc — một lượt quét.
  const demand = await db
    .select({
      variantId: oi.variantId,
      soldBefore: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${o.insertedAt} >= ${beforeStart} and ${o.insertedAt} < ${cutoff}), 0)`.as("bt_sold_before"),
      soldAfter: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${o.insertedAt} >= ${cutoff} and ${o.insertedAt} < ${horizonEnd}), 0)`.as("bt_sold_after"),
      lastSoldBefore: sql<string | null>`max(${o.insertedAt}) filter (where ${o.insertedAt} < ${cutoff} and ${ORDER_OUTCOME_FAST} = 'DELIVERED')`.as("bt_last_before"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(sql`${o.insertedAt} < ${horizonEnd} and ${oi.isBonus} = false and ${ORDER_OUTCOME_FAST} not in ('CANCELLED','RETURNED','RETURNED_BY_RULE')`)
    .groupBy(oi.variantId);

  // Vế "vào kho" tại hai mốc + phiếu nhập đầu tiên (tồn có BIẾT tại mốc cắt không).
  const received = await db
    .select({
      variantId: ri.variantId,
      recvBefore: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${rc.receivedAt} < ${cutoff}), 0)`.as("bt_recv_before"),
      recvEnd: sql<number>`coalesce(sum(${ri.quantity}) filter (where ${rc.receivedAt} < ${horizonEnd}), 0)`.as("bt_recv_end"),
      docsBefore: sql<number>`count(distinct ${ri.receiptId}) filter (where ${rc.kind} = 'RECEIPT' and ${rc.receivedAt} < ${cutoff})`.as("bt_docs_before"),
      firstAt: sql<string | null>`min(${rc.receivedAt}) filter (where ${rc.kind} = 'RECEIPT')`.as("bt_first_at"),
    })
    .from(ri)
    .innerJoin(rc, eq(rc.id, ri.receiptId))
    .groupBy(ri.variantId);

  // Vế "đã rời kho" tại hai mốc — mốc rời kho là picked_up_at, thiếu thì ngày lên đơn (proxy).
  const shipped = await db
    .select({
      variantId: oi.variantId,
      shipBefore: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${SHIPMENT_LEFT_WAREHOUSE} and coalesce(${s.pickedUpAt}, ${o.insertedAt}) < ${cutoff}), 0)`.as("bt_ship_before"),
      shipEnd: sql<number>`coalesce(sum(${oi.quantity}) filter (where ${SHIPMENT_LEFT_WAREHOUSE} and coalesce(${s.pickedUpAt}, ${o.insertedAt}) < ${horizonEnd}), 0)`.as("bt_ship_end"),
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .groupBy(oi.variantId);

  const demandBy = new Map(demand.map((r) => [r.variantId, r]));
  const shippedBy = new Map(shipped.map((r) => [r.variantId, r]));

  const result: DecisionBacktest = {
    daysBack,
    horizonDays,
    windowDays,
    evaluated: 0,
    stockout: { predicted: 0, confirmed: 0 },
    overstock: { predicted: 0, stillExcess: 0 },
    clearance: { predicted: 0, noSales: 0 },
    notes: [
      "Toàn bộ là ƯỚC TÍNH trên dữ liệu dựng lại: tồn quá khứ không gồm phần đã chốt chưa gửi, tốc độ bán không cắt ngày đột biến.",
      "'Hết hàng thật' = tồn dựng lại ≤ 0 tại cuối chân trời — nhu cầu bị mất vì trống hàng không nguồn nào ghi lại được.",
    ],
  };

  for (const r of received) {
    const docsBefore = Number(r.docsBefore ?? 0);
    if (docsBefore <= 0) continue; // tại mốc cắt tồn CHƯA BIẾT ⇒ ngày đó bộ máy cũng không phán.
    const d = demandBy.get(r.variantId);
    const sh = shippedBy.get(r.variantId);
    const stockAtCutoff = Number(r.recvBefore ?? 0) - Number(sh?.shipBefore ?? 0);
    const soldBefore = Number(d?.soldBefore ?? 0);
    const soldAfter = Number(d?.soldAfter ?? 0);
    const velocity = soldBefore / windowDays;
    const lastBefore = d?.lastSoldBefore ? new Date(d.lastSoldBefore) : null;
    const daysSinceLastSale = lastBefore ? Math.floor((cutoff.getTime() - lastBefore.getTime()) / DAY_MS) : null;
    const firstAt = r.firstAt ? new Date(r.firstAt) : null;
    const ageDays = firstAt ? Math.floor((cutoff.getTime() - firstAt.getTime()) / DAY_MS) : null;
    if (ageDays !== null && ageDays < 0) continue; // mẫu chưa tồn tại tại mốc cắt.

    // Cùng công thức đặt hàng với kế hoạch SX, chạy trên số liệu tại mốc cắt.
    const p = computePlan({
      stock: stockAtCutoff,
      stockKnown: true,
      committed: 0,
      soldInWindow: soldBefore,
      windowDays,
      leadTimeDays: horizonDays,
      coverDays: a.coverDays,
      safetyDays: a.safetyDays,
      roundTo: Math.max(1, a.roundTo),
    });
    const decision = decideInventory({
      stockKnown: true,
      stock: stockAtCutoff,
      available: stockAtCutoff,
      incomingFromReturns: 0,
      openPoQty: 0,
      velocity: p.velocity,
      velocityTrimmed: false,
      soldInWindow: soldBefore,
      sold30: soldBefore,
      daysOfCover: p.daysOfCover,
      leadTimeDays: horizonDays,
      leadTimeSource: "default",
      safetyDays: a.safetyDays,
      suggested: p.suggested,
      unitCost: null,
      retailPrice: null,
      returnRate: null,
      returnRateSource: null,
      daysSinceLastSale,
      ageDays,
    });

    result.evaluated += 1;
    const stockAtEnd = Number(r.recvEnd ?? 0) - Number(sh?.shipEnd ?? 0);
    if (decision.decision === "STOCKOUT_RISK") {
      result.stockout.predicted += 1;
      if (stockAtEnd <= 0) result.stockout.confirmed += 1;
    } else if (decision.decision === "OVERSTOCK") {
      result.overstock.predicted += 1;
      if (velocity <= 0 || stockAtEnd / velocity > SLOW_MOVING_RULES.excessCoverDays) result.overstock.stillExcess += 1;
    } else if (decision.decision === "CLEARANCE_CANDIDATE") {
      result.clearance.predicted += 1;
      if (soldAfter === 0) result.clearance.noSales += 1;
    }
  }

  return result;
}

/** Đối chứng lịch sử. `daysBack` ảnh hưởng kết quả nên nằm trong khoá cache. */
export async function backtestInventoryDecisions(daysBack = 30): Promise<DecisionBacktest> {
  const days = Math.min(180, Math.max(7, Math.round(daysBack)));
  return memo(`inventoryDecisionBacktest:${days}`, 600_000, () => backtestUncached(days));
}
