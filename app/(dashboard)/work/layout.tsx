import { WorkTabs } from "@/app/(dashboard)/work/tabs";
import { can, requirePermission } from "@/lib/auth/session";

export default async function WorkLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePermission("work:view");
  const tabs = [
    { href: "/work", label: "Việc của tôi" },
    /*
      "Hôm nay" đứng NGAY SAU "Việc của tôi" và TRƯỚC "Phòng ban" một cách có chủ ý: nó là màn
      hình trưởng phòng mở đầu ca, còn "Phòng ban" là chỗ đào sâu khi cần tìm một việc cụ thể.
      Thứ tự tab là thứ tự mở trong ngày, không phải thứ tự xây xong.
    */
    ...(can(user, "work:department") || can(user, "work:all") ? [{ href: "/work/today", label: "Hôm nay" }, { href: "/work/department", label: "Phòng ban" }] : []),
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
