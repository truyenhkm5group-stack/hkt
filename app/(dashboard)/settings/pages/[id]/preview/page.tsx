import Link from "next/link";
import { notFound } from "next/navigation";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { PageRenderer } from "@/components/pages/page-renderer";
import { requirePermission } from "@/lib/auth/session";
import type { ModuleKey } from "@/lib/constants/platform-modules";
import { MetadataError } from "@/lib/metadata/errors";
import { validatePageSchema } from "@/lib/pages/components";
import { effectivePageCatalog } from "@/lib/pages/custom-sources";
import { resolvePage } from "@/lib/pages/data-sources";
import { getPageDraft } from "@/lib/pages/registry";
import { startPageRender } from "@/lib/pages/render";
import { pageRenderContext, pageUsesPeriod } from "@/lib/pages/route-context";
import type { SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

/**
 * ═══════════ XEM TRƯỚC BẢN NHÁP (Phase 4) ═══════════
 *
 * Dựng BẢN NHÁP bằng CÙNG renderer + CÙNG trình phân giải với `/p/[slug]` — thứ quản trị thấy ở đây là thứ người
 * dùng sẽ thấy sau khi xuất bản, không có renderer thứ hai. Khác biệt duy nhất, cố ý:
 *  · quyền `metadata:manage` (người cấu hình), không phải quyền xem của trang;
 *  · nút và kanban KHÔNG chạy: `executePageAction` chỉ đọc bản ĐÃ XUẤT BẢN, và một cú bấm thử trên nháp không được
 *    ghi dữ liệu thật;
 *  · đo thời gian dựng dưới tên `preview:<slug>` để không lẫn vào số đo của trang thật;
 *  · mã lỗi chẩn đoán của từng khối luôn hiện, cùng lỗi kiểm schema sẽ chặn xuất bản.
 * Số liệu trong khối vẫn là số THẬT theo quyền của chính người xem trước.
 */
export default async function PagePreview({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SearchParams> }) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const user = await requirePermission("metadata:manage");
  let loaded: Awaited<ReturnType<typeof getPageDraft>>;
  try {
    loaded = await getPageDraft(id);
  } catch (error) {
    if (error instanceof MetadataError) notFound();
    throw error;
  }
  const { page, draft } = loaded;
  const modules = new Set((user.modules ?? []) as ModuleKey[]);
  const check = validatePageSchema(draft, { modules, catalog: await effectivePageCatalog(), moduleIssues: "error" });
  const moduleOff = user.modules !== undefined && !modules.has(page.moduleKey);
  const sections = startPageRender(draft, user, pageRenderContext(sp), `preview:${page.slug}`, resolvePage);

  return (
    <>
      <PageHeader
        eyebrow="Xem trước bản nháp"
        title={page.name}
        description={`/p/${page.slug} · ${page.status === "ARCHIVED" ? "đã lưu trữ" : page.publishedVersion > 0 ? `đang chạy phiên bản ${page.publishedVersion}` : "chưa xuất bản lần nào"} — người dùng chưa thấy bản nháp này.`}
        actions={
          <>
            {pageUsesPeriod(draft) ? <PeriodFilter defaultKey="30d" /> : null}
            <Link href="/settings/pages" className="rounded-full px-3 py-1.5 text-sm font-medium hover:bg-muted">
              ← Trang tuỳ biến
            </Link>
          </>
        }
      />
      {moduleOff || !check.ok ? (
        <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4 text-sm">
          <p className="font-semibold">Bản nháp này CHƯA xuất bản được:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted-foreground">
            {moduleOff ? <li>Module chủ «{page.moduleKey}» của trang đang tắt với tổ chức.</li> : null}
            {check.errors.slice(0, 20).map((e) => (
              <li key={`${e.path}:${e.message}`}>
                <span className="font-mono text-[12px]">{e.path || "trang"}</span> — {e.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <PageRenderer sections={sections} diagnose />
    </>
  );
}
