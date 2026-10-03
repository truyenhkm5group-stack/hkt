import { buildOrderBudget, type BudgetProposal, type OrderBudget } from "@/lib/constants/order-budget";
import { getCashPosition } from "@/lib/queries/cash-position";
import { getCashflow } from "@/lib/queries/cashflow";
import type { InventoryDecisionReport } from "@/lib/queries/inventory-decision";

/**
 * ───────────── NGÂN SÁCH ĐẶT HÀNG — TẦNG GHÉP ─────────────
 *
 * KHÔNG có công thức mới: số dư = `getCashPosition`, dòng tiền 30 ngày = kỳ 30 ngày của `getCashflow`,
 * đề xuất = dòng nguy cơ hết hàng / nên đặt thêm của báo cáo quyết định tồn kho mà trang ĐÃ đọc (truyền
 * vào, không đọc lại — hai lượt đọc là hai lúc, và hai lúc có thể lệch nhau). Luật ở `buildOrderBudget`.
 *
 * CHỈ ĐỌC. Số dư ngân hàng thuộc vùng TÀI CHÍNH: nơi gọi phải tự gác quyền `reports:cash` + phạm vi
 * FINANCE trước khi gọi hàm này (xem `app/(dashboard)/inventory/decisions/page.tsx`).
 */
export const ORDER_BUDGET_HORIZON_DAYS = 30;

export async function getOrderBudget(report: Pick<InventoryDecisionReport, "rows" | "summary">): Promise<OrderBudget> {
  const [cash, flow] = await Promise.all([getCashPosition(), getCashflow()]);
  const bucket = flow.buckets.find((b) => b.days === ORDER_BUDGET_HORIZON_DAYS);
  if (!bucket) throw new Error(`Dự phóng dòng tiền không có kỳ ${ORDER_BUDGET_HORIZON_DAYS} ngày`);

  const proposals: BudgetProposal[] = [];
  for (const r of report.rows) {
    if (r.decision !== "STOCKOUT_RISK" && r.decision !== "REORDER") continue;
    if (!r.suggestedQty) continue;
    proposals.push({
      variantId: r.variantId,
      productId: r.productId,
      label: `${r.productCode ? `${r.productCode} · ` : ""}${r.productName}${[r.color, r.size].filter(Boolean).length ? ` — ${[r.color, r.size].filter(Boolean).join(" / ")}` : ""}`,
      decision: r.decision,
      qty: r.suggestedQty,
      capital: r.capitalRequired,
      grossImpactEstimate: r.grossImpactEstimate,
    });
  }

  const sm = report.summary;
  const extraCaveats: string[] = [];
  // Dòng tiền 30 ngày cộng tiền xưởng của lệnh ĐÃ gửi theo giá khai; lệnh chưa khai giá xưởng góp 0đ
  // vào đó dù tiền thật vẫn phải trả — nói ra, vì nó làm dư địa trông rộng hơn thực tế.
  if (sm.openPoCapitalUnknownOrders > 0)
    extraCaveats.push(`${sm.openPoCapitalUnknownOrders} lệnh sản xuất đã gửi CHƯA KHAI GIÁ XƯỞNG — tiền phải trả cho chúng chưa nằm trong dòng tiền ${ORDER_BUDGET_HORIZON_DAYS} ngày, dư địa đang CAO hơn thực tế.`);

  return buildOrderBudget({
    cash: { total: cash.total, complete: cash.complete, unknownAccounts: cash.unknownAccounts, stalestAt: cash.stalestAt, chainBreaks: cash.chainBreaks },
    flow: { days: bucket.days, codExpected: bucket.codExpected, adsPlanned: bucket.adsPlanned, opexPlanned: bucket.opexPlanned, productionDue: bucket.productionDue, net: bucket.net },
    proposals,
    extraCaveats,
  });
}
