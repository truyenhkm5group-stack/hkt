/**
 * ═══════════ XEM TRƯỚC MỘT KHỐI (Phase 5 §3) — CHỈ MÁY CHỦ ═══════════
 *
 * Trình kéo-thả gọi khi CẤU HÌNH một khối đổi (chống dội ~400 ms); kéo / đổi chỗ / đổi độ rộng không gọi máy chủ.
 * Theo đúng thứ tự:
 *  1. người soạn có `metadata:manage` + phiên mang tổ chức (`pageAdminDenial`, luật chung của trình soạn);
 *  2. trang tồn tại trong tổ chức HIỆN HÀNH (id của tổ chức khác ⇒ không tìm thấy);
 *  3. khối qua `validatePageSchema` trên một schema MỘT KHỐI (cờ `partial`: đích của bộ lọc trỏ khối khác thì không
 *     kiểm được ở đây — lượt lưu nháp kiểm đủ);
 *  4. `resolveBlock` theo NGƯỜI SOẠN — số liệu là số thật theo quyền của chính họ, cùng trình phân giải với trang
 *     thật (không renderer / trình phân giải thứ hai).
 * Không ghi gì: xem trước không đổi bản nháp, không đổi thứ người dùng thấy.
 */
import type { SessionUser } from "@/lib/auth/session";
import { MetadataError } from "@/lib/metadata/errors";
import { getEnabledModules } from "@/lib/platform/capabilities";
import { normalizePageSchema, validatePageSchema, type PageCatalog } from "@/lib/pages/components";
import { effectivePageCatalog } from "@/lib/pages/custom-sources";
import { resolveBlock } from "@/lib/pages/data-sources";
import { getPageDraft, pageAdminDenial, type PageIssue } from "@/lib/pages/registry";
import type { PageBlock, PageRenderContext, ResolvedBlock } from "@/lib/pages/types";

export type PreviewBlockResult = { ok: true; resolved: ResolvedBlock; warnings: PageIssue[] } | { ok: false; code: "FORBIDDEN" | "NOT_FOUND" | "INVALID"; errors: PageIssue[] };

const BASE = "sections.0.blocks.0";

/** Đường dẫn lỗi tính TỪ KHỐI (`config.metric`, `children.1.config…`) — trình soạn tô đúng ô của khối đang sửa. */
function relative(issues: { path: string; message: string }[]): PageIssue[] {
  return issues.map((i) => ({ path: i.path === BASE ? "" : i.path.startsWith(`${BASE}.`) ? i.path.slice(BASE.length + 1) : i.path, message: i.message }));
}

export async function previewBlock(pageId: string, block: unknown, user: SessionUser, opts: { catalog?: PageCatalog; searchParams?: Record<string, string | undefined> } = {}): Promise<PreviewBlockResult> {
  const denial = pageAdminDenial(user);
  if (denial) return { ok: false, code: "FORBIDDEN", errors: [{ path: "", message: denial }] };
  try {
    await getPageDraft(pageId);
  } catch (error) {
    if (error instanceof MetadataError) return { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: error.message }] };
    throw error;
  }
  const modules = await getEnabledModules();
  const one = { version: 1, sections: [{ key: "preview", blocks: [block] }] };
  // Sổ hiệu lực (sổ tĩnh + đối tượng tuỳ biến của tổ chức) — cùng sổ lượt lưu nháp / xuất bản dùng.
  const catalog = opts.catalog ?? (await effectivePageCatalog());
  const v = validatePageSchema(one, { modules, catalog, moduleIssues: "warning", partial: true });
  if (!v.ok) return { ok: false, code: "INVALID", errors: relative(v.errors) };
  const normalized = normalizePageSchema(one, { modules, catalog, partial: true })!.sections[0].blocks[0] as PageBlock;
  const ctx: PageRenderContext = { searchParams: opts.searchParams ?? {}, period: "30d" };
  const r = await resolveBlock(normalized, user, ctx);
  return { ok: true, resolved: r.ok ? { ok: true, block: normalized, data: r.data } : { ok: false, block: normalized, issue: r.issue }, warnings: relative(v.warnings) };
}
