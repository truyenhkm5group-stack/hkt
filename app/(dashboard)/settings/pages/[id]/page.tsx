import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { loadPageEditor } from "@/lib/platform-ui/page-admin";
import { BACK_TO_LIST, PAGE_EYEBROW, PageEditorBody, pageEditorHeader } from "../page-view";

export const metadata = { title: "Trang tuỳ biến" };

/** Một trang tuỳ biến — vào từ bảng /settings/pages (không có mục menu riêng). */
export default async function CustomPageEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("metadata:manage");
  const { id } = await params;
  const loaded = await loadPageEditor(user, decodeURIComponent(id));
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={PAGE_EYEBROW} actions={BACK_TO_LIST} {...pageEditorHeader(loaded, user)} />
      <PageEditorBody loaded={loaded} />
    </div>
  );
}
