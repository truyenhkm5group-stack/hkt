import Link from "next/link";
import { ChevronRight, SlidersHorizontal } from "lucide-react";
import { foldsHubs, hubTools, iconOf } from "@/components/app-sidebar";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { PERMISSION_LABEL } from "@/lib/auth/permissions";
import { requireUser } from "@/lib/auth/session";
import { hubMembers, type NavHubHref } from "@/lib/constants/department-modules";

export const metadata = { title: "Tuỳ biến nâng cao" };
export const dynamic = "force-dynamic";

const HUB: NavHubHref = "/settings/advanced";

/**
 * ═══════════ TUỲ BIẾN NÂNG CAO — TRANG GOM CỦA MƯỜI CÔNG CỤ DỰNG CẤU HÌNH ═══════════
 *
 * Chủ shop chốt 30/09/2026: ở tổ chức KHÁCH, mười công cụ dựng cấu hình (mô hình dữ liệu, form, danh sách, trạng thái,
 * luật tự động, trang tuỳ biến, mẫu cấu hình, xuất cấu hình, đối tượng tuỳ biến, AI dựng cấu hình) rút thành MỘT mục
 * menu trỏ về đây. Tổ chức nhà vẫn thấy từng mục riêng trên menu Hệ thống.
 *
 * Trang KHÔNG tự tính quyền: danh sách là `hubTools()` — đúng `visible()` mà menu dùng (AGENTS.md mục 28). Mỗi công cụ
 * vẫn mở ở URL cũ và tự gác bằng quyền của nó; trang này chỉ là mục lục. Không đọc CSDL ngoài phiên đăng nhập.
 */
export default async function AdvancedCustomizationPage() {
  const user = await requireUser();
  const tools = hubTools(HUB, user);
  const needed = [...new Set(hubMembers(HUB).flatMap((m) => (m.anyOf ? [...m.anyOf] : m.permission ? [m.permission] : [])))];

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Tuỳ biến nâng cao"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Các công cụ dựng cấu hình cho CẢ tổ chức: field, form, danh sách, trạng thái, luật tự động, trang, đối tượng, mẫu ngành, xuất cấu hình và AI soạn cấu hình. Thay đổi ở đây đổi màn hình của mọi người nên là việc của quản trị.</p>
            <p>Chỉ hiện công cụ tài khoản của bạn được dùng. {foldsHubs(user) ? "Menu gom chúng vào một mục cho gọn." : "Tổ chức nhà vẫn thấy từng công cụ trên menu Hệ thống; trang này là mục lục chung."}</p>
          </div>
        }
      />
      {tools.length === 0 ? (
        <EmptyState
          icon={SlidersHorizontal}
          title="Chưa có công cụ nào bạn được dùng"
          description={`Mỗi công cụ cần một trong các quyền: ${needed.map((p) => `«${PERMISSION_LABEL[p] ?? p}»`).join(", ")}. Hỏi quản trị của tổ chức nếu bạn cần.`}
        />
      ) : (
        <SectionCard title={`${tools.length} công cụ`} padded={false} contentClassName="p-0">
          <ul className="divide-y divide-hairline" data-advanced-tools>
            {tools.map((t) => {
              const Icon = iconOf(t.href);
              return (
                <li key={t.href} data-tool={t.href}>
                  <Link href={t.href} className="group flex items-start gap-3 px-5 py-3.5 hover:bg-muted/50">
                    <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold group-hover:underline">{t.label}</span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">{t.why}</span>
                    </span>
                    <ChevronRight className="mt-2 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  </Link>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
