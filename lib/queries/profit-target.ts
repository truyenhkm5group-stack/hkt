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
 * Số gốc cho bảng kế hoạch: dòng mã của Báo cáo lợi nhuận danh nghĩa (mốc ngày tạo đơn, mọi đơn,
 * có CPQC) — kịch bản "giữ nguyên" ra đúng lợi nhuận báo cáo tính.
 *
 * GIÁ VỐN DỰ TÍNH KHÔNG BẬT (luật 2 ở `lib/constants/estimated-cost.ts`: chỉ tab Lợi nhuận danh
 * nghĩa và bảng MKTer ở /ads/daily được đọc con số đặt tay, ngoại lệ do chủ shop chốt). Nên mã
 * chưa có giá vốn đang trừ 0 ₫ ở đây — lãi góp/đơn của nó CAO hơn thật và màn hình gắn ⚠; mở
 * ngoại lệ cho trang này là quyết định của chủ shop, không phải của mã nguồn.
 */
export async function getProfitTargetData(period: Period): Promise<ProfitTargetData> {
  const report = await getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true);
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
  if (thieuGia.length) warnings.push(`${thieuGia.length} mã còn sản phẩm chưa có giá vốn nào (${thieuGia.map((s) => s.code || s.name).join(", ")}) — lãi góp/đơn của chúng đang CAO hơn thật, nên số đơn cần có đang THẤP hơn thật. Trang này dùng giá vốn THẬT (không dùng giá dự tính đặt tay); lập phiếu nhập có đơn giá thì số tự đúng.`);
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
