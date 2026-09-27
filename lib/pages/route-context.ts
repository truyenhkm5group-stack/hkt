import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import type { PageRenderContext, PageSchema } from "@/lib/pages/types";

/**
 * Ngữ cảnh MỘT lần dựng trang động — máy chủ dựng từ URL, không nhận từ client (`PageRenderContext`).
 * Tham số lặp (`?a=1&a=2`) lấy giá trị ĐẦU: trình phân giải chỉ đọc giá trị đơn (`<blockId>_page`, `id`, `period`).
 */
export function pageRenderContext(sp: SearchParams): PageRenderContext {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(sp)) flat[k] = Array.isArray(v) ? v[0] : v;
  return { searchParams: flat, period: resolvePeriod(sp).key };
}

/** Trang có khối nào đọc KỲ của URL không (chỉ số / biểu đồ không ghim kỳ riêng) — có thì hiện bộ chọn kỳ. */
export function pageUsesPeriod(schema: PageSchema): boolean {
  return schema.sections.some((s) => s.blocks.some((b) => (b.type === "kpi" || b.type === "chart") && !(b.config as { period?: string }).period));
}
