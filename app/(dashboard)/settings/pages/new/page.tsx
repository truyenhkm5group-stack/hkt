import { PageHeader } from "@/components/page-header";
import { requirePermission } from "@/lib/auth/session";
import { loadPageEditor } from "@/lib/platform-ui/page-admin";
import { BACK_TO_LIST, PAGE_EYEBROW, PageEditorBody, pageEditorHeader } from "../page-view";

export const metadata = { title: "Trang tuỳ biến mới" };

/** Tạo trang tuỳ biến — vào từ nút «Trang mới» ở đầu /settings/pages. Trang sinh ở NHÁP. */
export default async function NewCustomPagePage() {
  const user = await requirePermission("metadata:manage");
  const loaded = await loadPageEditor(user, null);
  return (
    <div className="space-y-5">
      <PageHeader eyebrow={PAGE_EYEBROW} actions={BACK_TO_LIST} {...pageEditorHeader(loaded, user)} />
      <PageEditorBody loaded={loaded} />
    </div>
  );
}
