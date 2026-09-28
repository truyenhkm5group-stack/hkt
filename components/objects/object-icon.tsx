import { Box, Briefcase, Building2, Calendar, Car, Clipboard, FileText, Folder, HardHat, House, Star, Store, Tag, Truck, Users, Wrench, type LucideIcon } from "lucide-react";
import { isCustomObjectIcon, type CustomObjectIcon } from "@/lib/objects/constants";

/**
 * Hình của tập biểu tượng ĐÓNG (`CUSTOM_OBJECT_ICONS`). `Record<CustomObjectIcon, …>` ⇒ TypeScript đòi phủ đủ mọi khoá:
 * thêm một khoá vào tập mà quên hình là lỗi biên dịch. Khoá lạ (dữ liệu cũ, gõ tay) ⇒ hình hộp — không vỡ giao diện.
 */
const ICONS: Record<CustomObjectIcon, LucideIcon> = {
  box: Box,
  "file-text": FileText,
  clipboard: Clipboard,
  briefcase: Briefcase,
  building: Building2,
  "hard-hat": HardHat,
  car: Car,
  truck: Truck,
  wrench: Wrench,
  store: Store,
  home: House,
  users: Users,
  calendar: Calendar,
  tag: Tag,
  folder: Folder,
  star: Star,
};

export function objectIconOf(icon: string): LucideIcon {
  return isCustomObjectIcon(icon) ? ICONS[icon] : Box;
}

export function ObjectIcon({ icon, className }: { icon: string; className?: string }) {
  const Icon = objectIconOf(icon);
  return <Icon className={className ?? "size-4"} aria-hidden />;
}
