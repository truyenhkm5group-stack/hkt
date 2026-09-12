import { WorkTabs } from "@/app/(dashboard)/work/tabs";
import { can, requirePermission } from "@/lib/auth/session";

export default async function WorkLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePermission("work:view");
  const tabs = [
    { href: "/work", label: "Việc của tôi" },
    ...(can(user, "work:department") || can(user, "work:all") ? [{ href: "/work/department", label: "Phòng ban" }] : []),
    ...(can(user, "work:all") ? [{ href: "/work/all", label: "Tất cả công việc" }] : []),
    ...(can(user, "okr:view") ? [{ href: "/work/okr", label: "Mục tiêu" }] : []),
    ...(can(user, "performance:view") ? [{ href: "/work/performance", label: "Hiệu suất" }, { href: "/work/review", label: "Kỳ review" }] : []),
    ...(can(user, "work:admin") ? [{ href: "/work/settings", label: "Cấu hình" }] : []),
  ];
  return (
    <div className="space-y-5">
      <WorkTabs tabs={tabs} />
      {children}
    </div>
  );
}
