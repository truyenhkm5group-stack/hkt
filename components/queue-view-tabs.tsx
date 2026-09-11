import { BellRing, Gauge } from "lucide-react";
import { NavLink } from "@/components/nav-progress";
import { cn } from "@/lib/utils";

/**
 * Cần xử lý và Điều hành theo khâu là HAI GÓC NHÌN của cùng một hàng đợi việc (cùng luật phát hiện,
 * cùng dữ liệu). Trước đây là hai mục menu đứng cách nhau; nay là hai tab đứng cạnh nhau ngay trên
 * trang, còn thanh bên chỉ giữ một lối vào.
 */
export function QueueViewTabs({ active }: { active: "queue" | "stages" }) {
  const tab = (key: "queue" | "stages", href: string, label: string, Icon: typeof BellRing) => (
    <NavLink
      href={href}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
        active === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" /> {label}
    </NavLink>
  );
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
      {tab("queue", "/alerts", "Hàng đợi việc", BellRing)}
      {tab("stages", "/operations", "Theo khâu vận hành", Gauge)}
    </div>
  );
}
