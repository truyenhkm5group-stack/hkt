import { DEFAULT_PROFIT_ASSUMPTIONS } from "@/lib/constants/profit";
import type { TargetAssumptions, TargetSku } from "@/lib/constants/profit-target";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import type { Period } from "@/lib/search-params";

export type ProfitTargetData = {
  /** Số ngày của kỳ gốc (tính cả hai đầu). `null` = kỳ không có ngày bắt đầu ("Toàn bộ") — không quy đổi được về tháng. */
  periodDays: number | null;
  /** Mọi mã có đơn trong kỳ, doanh số giảm dần. */
  skus: TargetSku[];
  /**
   * Mã chọn sẵn khi người xem chưa chọn: đang LÃI (LN ròng > 0) và đã đo được TL GTC. Đây là gợi ý,
   * không phải phán quyết "win" — người xem bỏ / thêm mã ở ô chọn.
   */
  defaultSelected: string[];
  shopNetProfit: number;
  /** Vận hành đã nhập + chi phí cố định trong kỳ gốc. */
  fixedInPeriod: number;
  assumptions: TargetAssumptions;
  /** Nhắc lại những chỗ số gốc chưa đủ — in cạnh bảng. */
  warnings: string[];
};

function soNgay(period: Period): number | null {
  if (!period.fromKey) return null;
  const to = period.toKey ?? period.fromKey;
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${period.fromKey}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * Số gốc cho bảng kế hoạch: dòng mã của Báo cáo lợi nhuận danh nghĩa với ĐÚNG bộ cờ tab ấy dùng
 * (mốc ngày tạo đơn, mọi đơn, có CPQC, BẬT giá vốn dự tính) — kịch bản "giữ nguyên" ra đúng lợi
 * nhuận tab đang in, và đi chung bộ đệm với nó.
 *
 * GIÁ VỐN DỰ TÍNH BẬT — ngoại lệ thứ hai của luật 2 (`lib/constants/estimated-cost.ts`), chủ shop
 * chốt 26/09/2026 cùng lúc với luật 5 "giá dự tính = giá báo MKT". Mã vẫn chưa có giá nào (không
 * giá thật, không giá báo, không giá đặt tay) thì trừ 0 ₫ và màn hình gắn ⚠.
 */
export async function getProfitTargetData(period: Period): Promise<ProfitTargetData> {
  const report = await getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true, true);
  const a = report.assumptions;
  const skus: TargetSku[] = report.rows
    .filter((r) => r.orders > 0)
    .sort((x, y) => y.grossSales - x.grossSales)
    .map((r) => ({
      productId: r.productId,
      code: r.code,
      name: r.productName,
      orders: r.orders,
      items: r.items,
      expectedRevenue: r.expectedRevenue,
      expectedCogs: r.expectedCogs,
      adSpend: r.adSpend,
      operatingAlloc: r.operatingAlloc,
      fixedAlloc: r.fixedAlloc,
      netProfit: r.netProfit,
      deliveryRate: r.deliveryRate,
      cogsIncomplete: r.cogsUncoveredQty > 0,
      stockQty: r.stockKnown ? r.stockQty : null,
    }));
  const warnings: string[] = [];
  const chuaDo = skus.filter((s) => s.deliveryRate === null);
  if (chuaDo.length) warnings.push(`${chuaDo.length} mã chưa đo được TL GTC (${chuaDo.map((s) => s.code || s.name).join(", ")}) — không đưa vào kế hoạch được; phần lãi/lỗ hiện tại của chúng nằm ở "phần còn lại".`);
  const thieuGia = skus.filter((s) => s.cogsIncomplete);
  if (thieuGia.length) warnings.push(`${thieuGia.length} mã còn sản phẩm chưa có giá vốn nào (${thieuGia.map((s) => s.code || s.name).join(", ")}) — lãi góp/đơn của chúng đang CAO hơn thật, nên số đơn cần có đang THẤP hơn thật. Khai giá báo MKT cho mã (Xưởng › Giá báo MKT) thì giá dự tính tự lấp.`);
  if (report.totals.projectionError) warnings.push(`Mô hình dự báo giao thành công lỗi (${report.totals.projectionError}); TL GTC đang theo tỷ lệ.`);
  return {
    periodDays: soNgay(period),
    skus,
    defaultSelected: skus.filter((s) => s.netProfit > 0 && s.deliveryRate !== null).map((s) => s.productId),
    shopNetProfit: report.totals.netProfit,
    fixedInPeriod: report.operatingExpenses + report.fixedCost,
    assumptions: {
      shipFeeDelivered: a.shipFeeDeliveredUsed,
      shipFeeReturned: a.shipFeeReturnedUsed,
      taxPercent: Number(a.taxPercent ?? 0),
      otherCostPercentOfAds: Number(a.otherCostPercentOfAds ?? 0),
      inventoryRiskPercent: Number(a.inventoryRiskPercent ?? DEFAULT_PROFIT_ASSUMPTIONS.inventoryRiskPercent),
    },
    warnings,
  };
}
