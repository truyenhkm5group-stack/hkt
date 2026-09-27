import { notFound, redirect } from "next/navigation";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { PageHeader } from "@/components/page-header";
import { PageRenderer } from "@/components/pages/page-renderer";
import { runPageAction } from "@/lib/actions/page-actions";
import type { Permission } from "@/lib/auth/permissions";
import { can, requireUser } from "@/lib/auth/session";
import { MODULE_DISABLED_PATH } from "@/lib/constants/session-revocation";
import { resolvePage } from "@/lib/pages/data-sources";
import { getPageBySlug } from "@/lib/pages/registry";
import { startPageRender } from "@/lib/pages/render";
import { pageRenderContext, pageUsesPeriod } from "@/lib/pages/route-context";
import type { SearchParams } from "@/lib/search-params";

export const dynamic = "force-dynamic";

/**
 * ═══════════ TRANG TUỲ BIẾN `/p/<slug>` (Phase 4 · G11) ═══════════
 *
 * Cổng theo đúng thứ tự, mỗi lượt tải:
 *  1. Phiên (`requireUser`) — tổ chức đi theo phiên, không có mã tổ chức trong URL.
 *  2. BẢN ĐÃ XUẤT BẢN theo slug trong CSDL của tổ chức (`getPageBySlug`): không có / chưa xuất bản / đã lưu trữ ⇒
 *     404 — slug của tổ chức khác đơn giản là không tồn tại ở đây.
 *  3. Module chủ của trang bật (tiền tố `/p` thuộc lõi; module THẬT kiểm ở đây) ⇒ tắt thì về trang "module chưa bật".
 *  4. Quyền xem của trang ⇒ thiếu thì về trang chủ với thông báo (`/?forbidden=1`, khuôn `requirePermission`).
 *  5. Mọi khối phân giải SONG SONG ở máy chủ theo NGƯỜI XEM (`resolvePage`) — cấu hình trang không phải ranh giới
 *     an ninh; renderer chỉ vẽ.
 */
export default async function DynamicPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SearchParams> }) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);
  const user = await requireUser();
  const found = await getPageBySlug(slug);
  if (!found) notFound();
  const { page, schema } = found;
  if (user.modules && !user.modules.includes(page.moduleKey)) redirect(`${MODULE_DISABLED_PATH}?m=${encodeURIComponent(page.moduleKey)}`);
  if (page.requiredPermission && !can(user, page.requiredPermission as Permission)) redirect("/?forbidden=1");

  const sections = startPageRender(schema, user, pageRenderContext(sp), page.slug, resolvePage);
  return (
    <>
      <PageHeader title={page.name} actions={pageUsesPeriod(schema) ? <PeriodFilter defaultKey="30d" /> : undefined} />
      <PageRenderer sections={sections} diagnose={can(user, "metadata:manage")} run={runPageAction.bind(null, page.slug)} />
    </>
  );
}
