import type { Metadata } from "next";
import { Blocks } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { can, getCurrentUser, requireUser } from "@/lib/auth/session";
import { orgTabMetadata } from "@/lib/branding/copy";
import { getOrgBrand } from "@/lib/branding/service";
import { isSalesAgentUser, salesAgentHomeFor, shellAllows } from "@/lib/constants/saas-nav";
import { moduleDef } from "@/lib/constants/platform-modules";
import { listActiveAdmins } from "@/lib/queries/platform-modules";
import { cn } from "@/lib/utils";

const TITLE = "Module chưa bật";

/**
 * Tab theo tổ chức của phiên. Trang này đứng NGOÀI bố cục `(dashboard)` (xem dưới), nên không thừa hưởng tiêu đề / biểu tượng
 * tab mà bố cục ấy đặt cho tổ chức không phải nhà — lấy lại bằng CHÍNH hai hàm bố cục dùng (`getOrgBrand` + `orgTabMetadata`):
 * tổ chức khách không thấy «VNXcommerce ERP» trên tab (Phase 10 · §4).
 */
export async function generateMetadata(): Promise<Metadata> {
  const user = await getCurrentUser();
  if (!user?.organization || user.organization.isHome) return { title: TITLE };
  const brand = await getOrgBrand(user);
  const name = brand?.name ?? user.organization.name;
  return { ...orgTabMetadata({ name, logoUrl: brand?.logoUrl ?? null }), title: { absolute: `${TITLE} · ${name}` } };
}

/**
 * ĐÍCH ĐẾN KHI MỞ TRANG CỦA MỘT MODULE ĐANG TẮT (`?m=<khoá>` — cổng máy chủ chuyển tới đây).
 *
 * Nói bốn điều: module nào, cho tổ chức nào, AI bật được (và lối tới đó nếu chính người xem bật
 * được), và module ấy cần những gì bật trước. Khoá lạ / thiếu ⇒ một câu chung, không lỗi: tham số
 * nằm trên URL, ai cũng gõ tay được, và trang này không được là chỗ in ra một trang lỗi.
 *
 * ─── VÌ SAO TRANG NÀY KHÔNG NẰM TRONG `app/(dashboard)` ───
 *
 * Chính LAYOUT `(dashboard)` chuyển hướng tới đây (`requireUser()` → `MODULE_DISABLED`). Khi layout ấy được dựng trong một lượt
 * RSC — server action `redirect(X)` (máy chủ dựng X từ gốc: đăng nhập với `next` là trang của module tắt), `router.refresh()`
 * sau khi module vừa tắt, điều hướng client từ trang ngoài nhóm — client giữ nút layout mang lỗi chuyển hướng. Đích nằm DƯỚI
 * cùng layout thì client chỉ xin phần dưới layout, nút hỏng được giữ nguyên, dựng lại lại ném ⇒ `router.replace` hàng nghìn lần:
 * TRANG TRẮNG, ở mọi tổ chức kể cả ERP nhà (cơ chế ở lib/saas/shell-landing.ts; đo 08/10/2026: 6.673–7.492 lần điều hướng trong
 * 15 giây). Đứng ngoài nhóm thì đích rẽ nhánh ngay dưới bố cục gốc ⇒ máy chủ dựng cả nhánh mới, nút hỏng bị thay.
 *
 * Cũng vì thế mọi lối RA khỏi trang là `<a>` TẢI CẢ TRANG, không `<Link>`: điều hướng client từ trang ngoài nhóm vào `(dashboard)`
 * dựng layout trong một lượt RSC — với người vỏ Chốt Đơn, `/` bị chính layout chặn, đúng mẫu vòng trắng. Người vỏ về trang nhà
 * của vỏ (`salesAgentHomeFor`), không về `/`. `tests/shell-gate-redirects.test.ts` khoá cả hai.
 */
export default async function ModuleDisabledPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const raw = (await searchParams).m;
  const key = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : undefined;
  const def = key ? moduleDef(key) : null;
  const orgName = user.organization?.name ?? "tổ chức của bạn";
  const enabled = new Set(user.modules ?? []);
  const canManage = can(user, "modules:manage");
  const admins = await listActiveAdmins();
  const home = isSalesAgentUser(user) ? salesAgentHomeFor(user) : "/";

  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 px-3 py-6 sm:px-5 sm:py-10">
      <PageHeader eyebrow="Module" title={def ? `«${def.label}» chưa được bật` : "Màn hình này thuộc một module chưa được bật"} description={`Cho ${orgName}.`} refresh={false} />

      <SectionCard>
        <div className="flex gap-4">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Blocks className="size-5" />
          </span>
          <div className="min-w-0 space-y-3 text-sm">
            {def ? (
              <p>
                <span className="font-semibold">{def.label}</span> — {def.description}
              </p>
            ) : (
              <p>Tổ chức của bạn chưa dùng mảng này của ERP, nên màn hình của nó không mở được.</p>
            )}
            {def?.requiresHomeCredentials && !user.organization?.isHome ? (
              <p className="text-muted-foreground">Module này dùng thông tin kết nối của tổ chức nhà — ở giai đoạn hiện tại tổ chức khác chưa bật được.</p>
            ) : null}

            {def && def.dependsOn.length ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cần bật trước</p>
                <ul className="mt-1 flex flex-wrap gap-1.5">
                  {def.dependsOn.map((d) => {
                    const dep = moduleDef(d);
                    const on = enabled.has(d);
                    return (
                      <li key={d} className={cn("rounded-full px-2 py-0.5 text-xs", on ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200" : "bg-muted text-muted-foreground")}>
                        {dep?.label ?? d} · {on ? "đang bật" : "đang tắt"}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ai bật được</p>
              <p className="mt-1">
                Người có quyền «Bật / tắt module của tổ chức»
                {admins.length ? (
                  <>
                    {" "}— quản trị viên: <span className="font-medium">{admins.map((a) => a.name || a.email).join(", ")}</span>, và người được cấp riêng quyền này.
                  </>
                ) : (
                  <> (quản trị viên, hoặc người được cấp riêng quyền này).</>
                )}
              </p>
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              {canManage && shellAllows(user, "/settings/modules") ? (
                <Button asChild size="sm">
                  <a href="/settings/modules">Mở «Module của tổ chức»</a>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="outline">
                <a href={home}>{home === "/" ? "Về Tổng quan" : "Về trang chính"}</a>
              </Button>
            </div>
          </div>
        </div>
      </SectionCard>
    </main>
  );
}
