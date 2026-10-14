import { inArray } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { activePlannedEntry, type PlannedCostEntry } from "@/lib/constants/estimated-cost";
import { marketerPriceAt } from "@/lib/constants/marketer-price";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import type { ActualCost } from "@/lib/constants/workshop-ledger";
import { marketerPriceEntriesByProduct } from "@/lib/queries/marketer-price";
import { getNominalProfitReport, getPlannedCostHistory } from "@/lib/queries/profit-nominal";
import { getWorkshopLedger, latestReceiptCost } from "@/lib/queries/workshop-ledger";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ TRUNG TÂM GIÁ VỐN — MỘT MÀN HÌNH, ĐỌC CHUNG MỘT BỘ MÁY ═══════════
 *
 * Chỉ ĐỌC. Không tính giá vốn theo công thức riêng nào: mọi con số ở đây là lời khai của ĐÚNG nguồn
 * đang dùng ở chỗ khác (`docs/cost-center.md`):
 *
 *   giá kế hoạch     — `profit.estimatedCosts` (luật 6, có lịch sử + ngày hiệu lực) — ô DUY NHẤT sửa được
 *   giá phiếu kho    — giá nhập bình quân phiếu NHẬP gần nhất (`latestReceiptCost`, như tab Giá SX thực tế)
 *   giá SX xưởng     — (vải + công) ÷ hàng xưởng trả (`getWorkshopLedger`), kèm cờ TẠM TÍNH
 *   giá báo MKT      — tham chiếu (cơ sở hoa hồng MKT), KHÔNG phải giá vốn (luật 5')
 *   đang áp dụng     — giá vốn bình quân / sp mà CHÍNH `getNominalProfitReport` in ở hai chế độ trong
 *                      kỳ đang xem — nên trang này và BCLN không bao giờ nói hai con số khác nhau.
 */
export type CostCenterRow = {
  productId: string;
  code: string;
  name: string;
  planned: PlannedCostEntry | null;
  history: PlannedCostEntry[];
  receipt: { unitCost: number; at: Date } | null;
  workshop: ActualCost | null;
  marketerPrice: number | null;
  /** Giá vốn / sp mà BCLN chế độ THỰC TẾ đang dùng trong kỳ. `null` = không bán / chưa biết. */
  appliedActual: { unit: number | null; basis: string; qty: number } | null;
  /** Giá vốn / sp mà BCLN chế độ KẾ HOẠCH đang dùng trong kỳ. */
  appliedPlanned: { unit: number | null; basis: string; qty: number } | null;
  /** Kế hoạch − giá phiếu kho (dương = kế hoạch CAO hơn chứng từ). `null` khi thiếu một vế. */
  planVsReceipt: number | null;
};

function donGia(cogs: number, qty: number, known: boolean): number | null {
  return known && qty > 0 ? Math.round(cogs / qty) : null;
}

export async function getCostCenter(period: Period, now: Date = new Date()): Promise<CostCenterRow[]> {
  const [history, prices, ledger, actual, planned] = await Promise.all([
    getPlannedCostHistory(),
    marketerPriceEntriesByProduct(),
    getWorkshopLedger(now),
    getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false, "ACTUAL"),
    getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true, false, "PLANNED"),
  ]);
  const ids = new Set<string>([...Object.keys(history), ...Object.keys(prices), ...actual.rows.map((r) => r.productId)]);
  for (const p of ledger.products) if (p.productId) ids.add(p.productId);
  const list = [...ids];
  const db = await getDb();
  const [products, receipts] = await Promise.all([
    list.length ? db.select({ id: schema.products.id, name: schema.products.name, code: schema.products.customId }).from(schema.products).where(inArray(schema.products.id, list)) : Promise.resolve([]),
    latestReceiptCost(list),
  ]);
  const ten = new Map(products.map((p) => [p.id, p]));
  const xuong = new Map(ledger.products.filter((p) => p.productId).map((p) => [p.productId as string, p]));
  const tt = new Map(actual.rows.map((r) => [r.productId, r]));
  const kh = new Map(planned.rows.map((r) => [r.productId, r]));

  const rows: CostCenterRow[] = list.map((pid) => {
    const h = history[pid] ?? [];
    const plan = activePlannedEntry(h, now);
    const a = tt.get(pid);
    const b = kh.get(pid);
    const rc = receipts.get(pid) ?? null;
    const p = ten.get(pid);
    const w = xuong.get(pid);
    return {
      productId: pid,
      code: p?.code ?? a?.code ?? w?.productCode ?? "",
      name: p?.name ?? a?.productName ?? w?.productName ?? pid,
      planned: plan,
      history: [...h].sort((x, y) => (y.setAt ?? "").localeCompare(x.setAt ?? "")),
      receipt: rc,
      workshop: w?.cost ?? null,
      marketerPrice: prices[pid] ? marketerPriceAt(prices[pid], now) : null,
      appliedActual: a ? { unit: donGia(a.expectedCogs, a.expectedQty, a.cogsKnown), basis: a.costBasis, qty: a.expectedQty } : null,
      appliedPlanned: b ? { unit: donGia(b.expectedCogs, b.expectedQty, b.cogsKnown), basis: b.costBasis, qty: b.expectedQty } : null,
      planVsReceipt: plan?.unitCost && rc ? plan.unitCost - rc.unitCost : null,
    };
  });
  // Mã đang bán trước (theo SL giao TC ước tính), rồi theo mã hàng.
  return rows.sort((x, y) => (y.appliedActual?.qty ?? 0) - (x.appliedActual?.qty ?? 0) || x.code.localeCompare(y.code));
}
