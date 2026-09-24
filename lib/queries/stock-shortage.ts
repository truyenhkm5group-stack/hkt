import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { chayKhongJit, getDb, schema } from "@/db";
import { loadAlertConfig } from "@/lib/alerts/config";
import { memo } from "@/lib/cache";
import { SHORTAGE_DECISIONS_KEY, allocateStock, applyShortageDecisions, variantLabel, type ReservedLine, type ShortageDecisionBook, type ShortageVariantInput, type StockShortageSnapshot } from "@/lib/constants/stock-shortage";
import { getSettingJson } from "@/lib/settings";
import { openPoQtyByVariant } from "@/lib/queries/inventory-decision";
import { getReplenishmentPlan, type PlanRow } from "@/lib/queries/planning";
import { PRIMARY_ATTEMPT } from "@/lib/queries/return-rate";
import { RESERVED_IN_WAREHOUSE, erpStockExpr, stockKnownExpr, variantReceiptsSubquery, variantSalesSubquery } from "@/lib/queries/stock";

const oi = schema.orderItems;
const o = schema.orders;
const s = schema.shipments;
const pv = schema.productVariants;
const p = schema.products;

/**
 * ═══════════ THIẾU HÀNG GIAO ĐƠN ĐÃ CHỐT — ĐỌC ═══════════
 *
 * Luật phân bổ nằm ở `lib/constants/stock-shortage.ts` (hàm thuần). Tệp này chỉ gom đầu vào, và
 * gom từ ĐÚNG các nguồn mà sổ kho dùng — không có vị ngữ thứ hai:
 *
 *   · Dòng đơn đang giữ hàng = `RESERVED_IN_WAREHOUSE` của `lib/queries/stock.ts`, nối vận đơn theo
 *     `PRIMARY_ATTEMPT` y như `variantSalesSubquery`. Tổng số cái theo mẫu mã ở đây PHẢI bằng cột
 *     `reserved` của sổ kho — bài kiểm khoá điều đó.
 *   · Tồn thực tế = `erpStockExpr` ĐỌC TƯƠI (không qua đệm của Kế hoạch SX): nhân viên vừa lập phiếu
 *     nhập thì đơn phải hết "chờ hàng" ngay, không phải hai phút sau.
 *   · Đề xuất đặt, hàng hoàn sắp về, mẫu thay thế = Kế hoạch SX (đã đệm) — chúng đổi theo ngày.
 *   · Hàng đã đặt xưởng + hạn giao = `openPoQtyByVariant` (cùng phép ghép với trang Quyết định vốn).
 */

async function reservedLines(): Promise<ReservedLine[]> {
  const db = await getDb();
  const rows = await db
    .select({
      orderId: o.id,
      systemId: o.systemId,
      variantId: oi.variantId,
      qty: oi.quantity,
      insertedAt: o.insertedAt,
      promisedAt: o.customerPromisedAt,
      customer: o.billFullName,
      value: o.totalPriceAfterDiscount,
    })
    .from(oi)
    .innerJoin(o, eq(o.id, oi.orderId))
    .leftJoin(s, and(eq(s.orderId, o.id), PRIMARY_ATTEMPT))
    .where(and(RESERVED_IN_WAREHOUSE, isNotNull(oi.variantId)));
  return rows.map((r) => ({
    orderId: r.orderId,
    systemId: r.systemId ?? null,
    variantId: r.variantId as string,
    qty: Number(r.qty ?? 0),
    insertedAt: new Date(r.insertedAt),
    promisedAt: r.promisedAt ? new Date(r.promisedAt) : null,
    customer: r.customer || "Khách",
    value: Number(r.value ?? 0),
  }));
}

/** Tồn thực tế ĐỌC TƯƠI cho đúng các mẫu đang có đơn giữ. */
async function freshVariantStock(ids: string[]) {
  if (!ids.length) return [];
  const db = await getDb();
  return chayKhongJit(db, (tx) => {
    const sales = variantSalesSubquery(tx);
    const receipts = variantReceiptsSubquery(tx);
    return tx
      .select({
        variantId: pv.id,
        productId: pv.productId,
        productName: p.name,
        productCode: sql<string>`coalesce(${p.customId}, '')`,
        color: pv.color,
        size: pv.size,
        sku: pv.sku,
        onHand: erpStockExpr(sales, receipts),
        stockKnown: stockKnownExpr(receipts),
        pancakeStock: pv.remainQuantity,
      })
      .from(pv)
      .innerJoin(p, eq(p.id, pv.productId))
      .leftJoin(sales, eq(sales.variantId, pv.id))
      .leftJoin(receipts, eq(receipts.variantId, pv.id))
      .where(inArray(pv.id, ids));
  });
}

/** Mẫu CÙNG mã hàng, CÙNG size, khác màu, đang còn khả dụng — gợi ý đổi cho khách. */
function sameSizeAlternatives(rows: PlanRow[]) {
  const key = (r: PlanRow) => `${r.productId}::${r.size.trim().toLowerCase()}`;
  const groups = new Map<string, PlanRow[]>();
  for (const r of rows) {
    if (!r.size.trim()) continue;
    groups.set(key(r), [...(groups.get(key(r)) ?? []), r]);
  }
  const map = new Map<string, { label: string; available: number }[]>();
  for (const group of groups.values()) {
    for (const r of group) {
      const list = group
        .filter((x) => x.variantId !== r.variantId && x.stockKnown && x.available > 0)
        .sort((a, b) => b.available - a.available)
        .map((x) => ({ label: variantLabel(x), available: x.available }));
      if (list.length) map.set(r.variantId, list);
    }
  }
  return map;
}

async function getStockShortageUncached(urgentAfterHours: number, now: Date): Promise<StockShortageSnapshot> {
  const lines = await reservedLines();
  const ids = [...new Set(lines.map((l) => l.variantId))];
  const [stock, plan, openPo] = await Promise.all([freshVariantStock(ids), getReplenishmentPlan(), openPoQtyByVariant()]);
  const planById = new Map(plan.rows.map((r) => [r.variantId, r]));
  const alternatives = sameSizeAlternatives(plan.rows);
  const variants: ShortageVariantInput[] = stock.map((v) => {
    const pr = planById.get(v.variantId);
    return {
      variantId: v.variantId,
      productId: v.productId,
      productCode: v.productCode ?? "",
      productName: v.productName,
      color: v.color,
      size: v.size,
      sku: v.sku,
      onHand: Number(v.onHand ?? 0),
      stockKnown: Boolean(v.stockKnown),
      pancakeStock: v.pancakeStock === null || v.pancakeStock === undefined ? null : Number(v.pancakeStock),
      planSuggested: pr ? pr.suggested : null,
      incoming: pr ? pr.incoming : 0,
      openPoQty: openPo.qtyByVariant.get(v.variantId) ?? 0,
      openPoDueAt: openPo.earliestDueByVariant.get(v.variantId) ?? null,
      alternatives: alternatives.get(v.variantId) ?? [],
    };
  });
  // Quyết định của người đặt hàng (đã đặt / sẽ đặt / không đặt nữa) — chỉ đổi việc NHẮC, không đổi phân bổ.
  const book = await getSettingJson<ShortageDecisionBook>(SHORTAGE_DECISIONS_KEY, {});
  return applyShortageDecisions(allocateStock(variants, lines, { now, urgentAfterHours }), book);
}

export type StockShortageOptions = { urgentAfterHours?: number; fresh?: boolean; now?: Date };

/**
 * Bảng thiếu hàng hiện tại. Đệm 60 giây (trang, Copilot, hàng đợi fulfillment cùng đọc); `fresh`
 * bỏ đệm — job gửi Lark dùng nó, vì một tin nhắn đã gửi thì không sửa lại được.
 */
export async function getStockShortage(opts: StockShortageOptions = {}): Promise<StockShortageSnapshot> {
  const urgentAfterHours = opts.urgentAfterHours ?? (await loadAlertConfig()).pendingHours;
  const now = opts.now ?? new Date();
  if (opts.fresh || opts.now) return getStockShortageUncached(urgentAfterHours, now);
  return memo(`getStockShortage:${urgentAfterHours}`, 60_000, () => getStockShortageUncached(urgentAfterHours, now));
}
