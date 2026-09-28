import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { flattenBlocks, isAggregateChart, isAggregateKpi, type BlockConfigByType, type PageRenderContext, type PageSchema } from "@/lib/pages/types";

/**
 * Ngữ cảnh MỘT lần dựng trang động — máy chủ dựng từ URL, không nhận từ client (`PageRenderContext`).
 * Tham số lặp (`?a=1&a=2`) lấy giá trị ĐẦU: trình phân giải chỉ đọc giá trị đơn (`<blockId>_page`, `id`, `period`).
 */
export function pageRenderContext(sp: SearchParams): PageRenderContext {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v;
  return { searchParams: flat, period: resolvePeriod(sp).key };
}

/**
 * Trang có khối nào đọc KỲ của URL không (chỉ số / biểu đồ không ghim kỳ riêng; KPI tổng hợp có field ngày; biểu
 * đồ tổng hợp theo thời gian) — có thì hiện bộ chọn kỳ ở đầu trang. Trang có THANH LỌC mang bộ chọn kỳ thì bộ chọn
 * nằm ở đó, không hiện hai lần.
 */
export function pageUsesPeriod(schema: PageSchema): boolean {
  const blocks = flattenBlocks(schema).map((f) => f.block);
  if (blocks.some((b) => b.type === "filter" && (b.config as BlockConfigByType["filter"]).period === true)) return false;
  return blocks.some((b) => {
    if (b.type === "kpi") {
      const c = b.config as BlockConfigByType["kpi"];
      return !c.period && (!isAggregateKpi(c) || Boolean(c.dateField));
    }
    if (b.type === "chart") {
      const c = b.config as BlockConfigByType["chart"];
      return !c.period && (!isAggregateChart(c) || "bucket" in c.groupBy);
    }
    return false;
  });
}
