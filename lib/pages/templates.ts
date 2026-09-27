/**
 * ═══════════ MẪU TRANG (Phase 4) — THUẦN, CLIENT-SAFE ═══════════
 *
 * Ba mẫu: Tổng quan bán hàng · Tổng quan kho · Bàn làm việc khách hàng. Luật 23 áp nguyên văn:
 *
 *  · MẪU KHÔNG TỰ KÍCH HOẠT. Không trang nào sinh ra lúc cấp tổ chức, lúc deploy hay lúc mở màn hình — chỉ khi
 *    NGƯỜI bấm "Tạo từ mẫu" (`createPageFromTemplate` ở `lib/pages/registry.ts`), và trang sinh ra ở NHÁP
 *    (`published_version = 0`): người dùng chưa thấy gì cho tới khi quản trị xem trước rồi xuất bản.
 *  · MẪU CHỈ DÙNG KHOÁ SỔ CÓ THẬT. Mỗi khối khai các khoá ỨNG VIÊN; khối chỉ vào mẫu khi sổ có khoá đó VÀ module
 *    của nó đang bật. Không có ⇒ khối bị BỎ và tên nó nằm trong `skipped` để màn hình nói ra — không bao giờ
 *    đoán một khoá "gần giống". Bản dựng xong vẫn phải qua `validatePageSchema` như mọi bản nháp.
 *  · Cột custom / kanban chỉ dựng từ field custom ĐANG CÓ của tổ chức (máy chủ truyền vào) — không field nào
 *    được tạo hộ.
 */
import type { ModuleKey } from "@/lib/constants/platform-modules";
import type { PageCatalog } from "@/lib/pages/components";
import type { BlockType, PageBlock, PageSchema, PageSection } from "@/lib/pages/types";

export const PAGE_TEMPLATE_KEYS = ["sales-overview", "inventory-overview", "customer-workspace"] as const;
export type PageTemplateKey = (typeof PAGE_TEMPLATE_KEYS)[number];

export type PageTemplateSpec = {
  key: PageTemplateKey;
  name: string;
  description: string;
  /** Module chủ của trang sinh ra — tắt thì mẫu không dùng được. */
  moduleKey: ModuleKey;
  /** Slug đề xuất; trùng thì người bấm đổi. */
  slug: string;
};

export const PAGE_TEMPLATES: readonly PageTemplateSpec[] = [
  { key: "sales-overview", name: "Tổng quan bán hàng", description: "Đơn hôm nay, doanh thu lên đơn, biểu đồ đơn theo ngày và bảng đơn mới.", moduleKey: "orders", slug: "tong-quan-ban-hang" },
  { key: "inventory-overview", name: "Tổng quan kho", description: "Tồn khả dụng, hàng hoàn trong kỳ và bảng sản phẩm.", moduleKey: "inventory", slug: "tong-quan-kho" },
  { key: "customer-workspace", name: "Bàn làm việc khách hàng", description: "Bảng khách kèm cột custom; kanban theo field trạng thái custom nếu tổ chức đã tạo.", moduleKey: "customers", slug: "ban-lam-viec-khach" },
];

/** Field custom tối thiểu mẫu cần biết (máy chủ đọc từ `meta_custom_fields`). */
export type TemplateCustomField = { objectKey: string; key: string; label: string; type: string; listable: boolean };

export type TemplateContext = {
  catalog: PageCatalog;
  modules: ReadonlySet<ModuleKey>;
  customFields: readonly TemplateCustomField[];
};

export type TemplateBuild = { schema: PageSchema; skipped: { blockId: string; reason: string }[] };

/** Khối ứng viên: `candidates` là khoá sổ theo thứ tự ưu tiên — khoá ĐẦU TIÊN có trong sổ + module bật thắng. */
type Want = {
  id: string;
  type: Extract<BlockType, "kpi" | "chart" | "table">;
  span: PageBlock["span"];
  title: string;
  candidates: readonly string[];
  extra?: Record<string, unknown>;
};

/**
 * Khoá ỨNG VIÊN của sổ nguồn (`lib/pages/catalog.ts`). Nhiều ứng viên vì mẫu phải chạy cả khi sổ đổi tên
 * hiển thị — nhưng mỗi ứng viên là một KHOÁ ĐẦY ĐỦ, không so gần đúng.
 */
const WANTS: Record<Exclude<PageTemplateKey, "customer-workspace">, { section: string; title?: string; blocks: Want[] }[]> = {
  "sales-overview": [
    {
      section: "kpi",
      blocks: [
        { id: "orders_today", type: "kpi", span: 3, title: "Đơn hôm nay", candidates: ["orders_today"], extra: { period: "today" } },
        { id: "revenue", type: "kpi", span: 3, title: "Doanh thu lên đơn", candidates: ["booked_revenue"] },
      ],
    },
    { section: "trend", title: "Xu hướng", blocks: [{ id: "orders_by_day", type: "chart", span: 12, title: "Đơn theo ngày", candidates: ["orders_by_day"], extra: { kind: "bar" } }] },
    { section: "list", title: "Đơn hàng", blocks: [{ id: "orders_table", type: "table", span: 12, title: "Đơn mới", candidates: ["order"], extra: { pageSize: 20, rowLink: true } }] },
  ],
  "inventory-overview": [
    {
      section: "kpi",
      blocks: [
        { id: "stock_available", type: "kpi", span: 3, title: "Tồn khả dụng", candidates: ["available_stock"] },
        { id: "returns_period", type: "kpi", span: 3, title: "Hàng hoàn trong kỳ", candidates: ["returns_in_period"] },
      ],
    },
    { section: "list", title: "Sản phẩm", blocks: [{ id: "products_table", type: "table", span: 12, title: "Sản phẩm", candidates: ["product"], extra: { pageSize: 20, rowLink: true } }] },
  ],
};

function specOf(catalog: PageCatalog, type: Want["type"], key: string): { module: ModuleKey; periods?: readonly string[]; kinds?: readonly string[] } | undefined {
  if (type === "kpi") return catalog.metrics.find((m) => m.key === key);
  if (type === "chart") return catalog.series.find((s) => s.key === key);
  return catalog.lists.find((l) => l.objectKey === key);
}

function pickBlock(w: Want, ctx: TemplateContext): PageBlock | { skip: string } {
  for (const key of w.candidates) {
    const spec = specOf(ctx.catalog, w.type, key);
    if (!spec) continue;
    if (!ctx.modules.has(spec.module)) return { skip: `nguồn «${key}» thuộc module «${spec.module}» đang tắt` };
    const extra = { ...(w.extra ?? {}) };
    // Kỳ / loại biểu đồ mẫu muốn mà nguồn không hỗ trợ ⇒ bỏ ô đó, để nguồn dùng mặc định của nó (không đoán kỳ khác).
    if (typeof extra.period === "string" && spec.periods && !spec.periods.includes(extra.period)) delete extra.period;
    if (w.type === "chart" && spec.kinds && !spec.kinds.includes(String(extra.kind))) extra.kind = spec.kinds[0];
    const config = w.type === "kpi" ? { metric: key, ...extra } : w.type === "chart" ? { series: key, ...extra } : { source: key, ...extra };
    return { id: w.id, type: w.type, span: w.span, title: w.title, config } as PageBlock;
  }
  return { skip: `sổ chưa có nguồn nào trong ${w.candidates.map((c) => `«${c}»`).join(", ")}` };
}

function customerWorkspace(ctx: TemplateContext): TemplateBuild {
  const skipped: TemplateBuild["skipped"] = [];
  const sections: PageSection[] = [];
  const customerList = ctx.catalog.lists.find((l) => l.objectKey === "customer");
  const fields = ctx.customFields.filter((f) => f.objectKey === "customer");
  if (!customerList) skipped.push({ blockId: "customers_table", reason: "sổ chưa có nguồn danh sách «customer»" });
  else if (!ctx.modules.has(customerList.module)) skipped.push({ blockId: "customers_table", reason: `module «${customerList.module}» đang tắt` });
  else {
    const customCols = fields.filter((f) => f.listable).slice(0, 4).map((f) => `custom:${f.key}` as const);
    const columns = ["system:name", "system:phone", ...customCols] as PageBlock<"table">["config"]["columns"];
    sections.push({ key: "list", title: "Khách hàng", blocks: [{ id: "customers_table", type: "table", span: 12, title: "Khách hàng", config: { source: "customer", columns, pageSize: 20, rowLink: true } } as PageBlock] });
    const status = fields.find((f) => f.type === "status");
    if (!status) skipped.push({ blockId: "customers_kanban", reason: "tổ chức chưa có field custom kiểu trạng thái cho khách hàng" });
    else {
      sections.push({
        key: "board",
        title: status.label,
        blocks: [{ id: "customers_kanban", type: "kanban", span: 12, title: `Khách theo ${status.label}`, config: { objectKey: "customer", statusField: `custom:${status.key}`, cardFields: ["system:phone"], allowMove: true, limit: 100 } } as PageBlock],
      });
    }
  }
  return { schema: { version: 1, sections }, skipped };
}

/** Dựng schema NHÁP của một mẫu từ sổ + module + field custom của tổ chức. Không ghi gì. */
export function buildTemplateSchema(key: PageTemplateKey, ctx: TemplateContext): TemplateBuild {
  if (key === "customer-workspace") return customerWorkspace(ctx);
  const skipped: TemplateBuild["skipped"] = [];
  const sections: PageSection[] = [];
  for (const s of WANTS[key]) {
    const blocks: PageBlock[] = [];
    for (const w of s.blocks) {
      const b = pickBlock(w, ctx);
      if ("skip" in b) skipped.push({ blockId: w.id, reason: b.skip });
      else blocks.push(b);
    }
    if (blocks.length > 0) sections.push({ key: s.section, ...(s.title ? { title: s.title } : {}), blocks });
  }
  return { schema: { version: 1, sections }, skipped };
}

export function templateSpec(key: string): PageTemplateSpec | null {
  return PAGE_TEMPLATES.find((t) => t.key === key) ?? null;
}

/** Danh sách mẫu cho trình soạn (`/settings/pages`): chỉ phần hiển thị — tạo trang vẫn phải qua `createPageFromTemplate`. */
export function templates(): { key: PageTemplateKey; name: string; description: string }[] {
  return PAGE_TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description }));
}
