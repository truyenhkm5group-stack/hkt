/**
 * ═══════════ DỰNG MỘT LƯỢT TRANG ĐỘNG (Phase 4 · G8, G9, G10) — CHỈ MÁY CHỦ ═══════════
 *
 * Nối schema (đã xuất bản — hoặc bản nháp khi xem trước) với trình phân giải (`resolvePage` của
 * `lib/pages/data-sources.ts` — MỘT đường phân giải, song song, trần 20 khối, đo `page:<slug>`), để
 * `components/pages/page-renderer.tsx` chỉ còn việc VẼ.
 *
 *  · KHUNG TRƯỚC, SỐ SAU: renderer dựng lưới section → khối ngay từ SCHEMA, mỗi khối một Suspense chờ phần của nó
 *    trong lượt phân giải chung. Người xem thấy bố cục + khung xương từng khối ngay, không phải một màn trắng.
 *  · CÔ LẬP LỖI (G9): Promise của khối KHÔNG BAO GIỜ reject. `resolvePage` tự bắt lỗi từng khối; nếu chính nó ném
 *    (mất kết nối trước khi vào khối nào) thì MỌI khối thành `DATA_ERROR` với câu chung — trang vẫn đứng, chi tiết
 *    lỗi chỉ vào nhật ký máy chủ.
 *  · `visibility` CHỈ LÀ UX (G8): khối ẩn bị bỏ khỏi schema TRƯỚC khi phân giải (không tốn truy vấn); khối hiện thì
 *    trình phân giải vẫn tự kiểm module + quyền + phạm vi theo người xem.
 */
import type { Permission } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import type { ColumnData, PageBlock, PageRenderContext, PageSchema, ResolvedBlock, SectionVariant } from "@/lib/pages/types";

/** Hình kết quả của `resolvePage` (tiêm được — bài kiểm dùng trình phân giải giả). */
export type ResolvedPageLike = { sections: { key: string; title?: string; blocks: ResolvedBlock[] }[] };
export type PageResolver = (schema: PageSchema, user: SessionUser, ctx: PageRenderContext, slug?: string) => Promise<ResolvedPageLike>;

/**
 * Một khối để VẼ: kết quả là Promise (trang máy chủ — mỗi khối một Suspense) HOẶC giá trị sẵn (trình kéo-thả vẽ lại
 * kết quả xem trước). `children`: khối con của cột, mỗi con một kết quả riêng.
 */
export type RenderBlock = { block: PageBlock; result: Promise<ResolvedBlock> | ResolvedBlock; children?: RenderBlock[] };
export type RenderSection = { key: string; title?: string; variant?: SectionVariant; blocks: RenderBlock[] };

/** Khối có HIỆN với người xem không — chỉ là UX, không phải ranh giới an ninh. */
export function blockVisibleTo(block: PageBlock, user: SessionUser): boolean {
  const v = block.visibility;
  if (!v) return true;
  if (v.module && user.modules && !user.modules.includes(v.module)) return false;
  if (v.permission && !can(user, v.permission as Permission)) return false;
  return true;
}

/** Schema chỉ còn khối HIỆN với người xem (kể cả khối con của cột); section rỗng sau khi lọc bị bỏ. */
export function visibleSchema(schema: PageSchema, user: SessionUser): PageSchema {
  const keep = (b: PageBlock): PageBlock => (b.type === "column" && Array.isArray(b.children) ? { ...b, children: b.children.filter((c) => blockVisibleTo(c, user)) } : b);
  return {
    version: 1,
    sections: schema.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => blockVisibleTo(b, user)).map(keep) })).filter((s) => s.blocks.length > 0),
  };
}

/** Mọi kết quả của một lượt phân giải theo id khối — kể cả khối con nằm trong dữ liệu của cột. */
function resultsById(page: ResolvedPageLike): Map<string, ResolvedBlock> {
  const map = new Map<string, ResolvedBlock>();
  for (const r of page.sections.flatMap((s) => s.blocks)) {
    map.set(r.block.id, r);
    if (r.ok && r.block.type === "column") for (const c of (r.data as ColumnData).children ?? []) map.set(c.block.id, c);
  }
  return map;
}

const PAGE_FAILED = "Không dựng được trang lúc này — thử tải lại.";

/**
 * Bắt đầu MỘT lượt phân giải cho cả trang (song song bên trong `resolvePage`) và trả cấu trúc section → khối,
 * mỗi khối mang Promise phần của nó. `slug` chỉ để đo: xem trước truyền `preview:<slug>` để thời gian dựng bản
 * nháp không lẫn vào số đo của trang thật.
 */
export function startPageRender(schema: PageSchema, user: SessionUser, ctx: PageRenderContext, slug: string, resolve: PageResolver): RenderSection[] {
  const shown = visibleSchema(schema, user);
  const whole: Promise<Map<string, ResolvedBlock> | null> = (async () => {
    try {
      const page = await resolve(shown, user, ctx, slug);
      return resultsById(page);
    } catch (error) {
      console.error(`[page] ${slug} lỗi khi phân giải trang:`, error instanceof Error ? error.message : String(error));
      return null;
    }
  })();
  const partOf = async (block: PageBlock): Promise<ResolvedBlock> => {
    const map = await whole;
    const hit = map?.get(block.id);
    if (hit) return hit;
    return { ok: false, block, issue: { blockId: block.id, code: "DATA_ERROR", message: map ? "Trình phân giải không trả kết quả cho khối này." : PAGE_FAILED } };
  };
  const item = (block: PageBlock): RenderBlock => ({
    block,
    result: partOf(block),
    ...(block.type === "column" ? { children: (block.children ?? []).map((c) => ({ block: c, result: partOf(c) })) } : {}),
  });
  return shown.sections.map((s) => ({ key: s.key, ...(s.title ? { title: s.title } : {}), ...(s.variant ? { variant: s.variant } : {}), blocks: s.blocks.map(item) }));
}
