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
import type { PageBlock, PageRenderContext, PageSchema, ResolvedBlock } from "@/lib/pages/types";

/** Hình kết quả của `resolvePage` (tiêm được — bài kiểm dùng trình phân giải giả). */
export type ResolvedPageLike = { sections: { key: string; title?: string; blocks: ResolvedBlock[] }[] };
export type PageResolver = (schema: PageSchema, user: SessionUser, ctx: PageRenderContext, slug?: string) => Promise<ResolvedPageLike>;

export type RenderBlock = { block: PageBlock; result: Promise<ResolvedBlock> };
export type RenderSection = { key: string; title?: string; blocks: RenderBlock[] };

/** Khối có HIỆN với người xem không — chỉ là UX, không phải ranh giới an ninh. */
export function blockVisibleTo(block: PageBlock, user: SessionUser): boolean {
  const v = block.visibility;
  if (!v) return true;
  if (v.module && user.modules && !user.modules.includes(v.module)) return false;
  if (v.permission && !can(user, v.permission as Permission)) return false;
  return true;
}

/** Schema chỉ còn khối HIỆN với người xem; section rỗng sau khi lọc bị bỏ. */
export function visibleSchema(schema: PageSchema, user: SessionUser): PageSchema {
  return {
    version: 1,
    sections: schema.sections.map((s) => ({ ...s, blocks: s.blocks.filter((b) => blockVisibleTo(b, user)) })).filter((s) => s.blocks.length > 0),
  };
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
      return new Map(page.sections.flatMap((s) => s.blocks).map((r) => [r.block.id, r] as const));
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
  return shown.sections.map((s) => ({ key: s.key, ...(s.title ? { title: s.title } : {}), blocks: s.blocks.map((block) => ({ block, result: partOf(block) })) }));
}
