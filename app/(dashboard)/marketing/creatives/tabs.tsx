"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Một mục menu, nhiều tab — cùng cách `/marketing/fanpages` và `/work` làm. Chỉ khai những tab ĐÃ
 * CÓ màn hình, không đặt chỗ trước bằng một tab rỗng.
 *
 * "Duyệt lô" đứng đầu: đó là việc DUY NHẤT của vòng mẫu có hạn chót, và quá hạn là cả ngày test mất.
 * Tab mặc định do trang quyết (có lô chờ duyệt ⇒ Duyệt lô, không có ⇒ Nguồn ảnh), nên thanh tab phải
 * biết mặc định là gì — bỏ `tab` khỏi URL chỉ khi chọn ĐÚNG tab mặc định, nếu không bấm "Nguồn ảnh"
 * lúc có lô chờ sẽ quay về "Duyệt lô".
 */
export const CREATIVE_TABS = [
  { value: "duyet", label: "Duyệt lô" },
  { value: "thiet-ke", label: "Thiết kế mới" },
  { value: "dang-chay", label: "Đang chạy" },
  { value: "thu-vien", label: "Thư viện mẫu thắng" },
  { value: "hoc", label: "Máy đã học gì" },
  { value: "nguon", label: "Nguồn ảnh" },
  { value: "cau-hinh", label: "Cấu hình & luật" },
] as const;

export function CreativeTabs({ active, defaultTab = "nguon", pendingApproval = false }: { active: string; defaultTab?: string; pendingApproval?: boolean }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates(
    { tab: parseAsString, page: parseAsString, q: parseAsString, loai: parseAsString, bat: parseAsString, lo: parseAsString },
    { shallow: false, history: "push", startTransition },
  );
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === defaultTab ? null : value, page: null, q: null, loai: null, bat: null, lo: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {CREATIVE_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className="flex-none px-3">
            {t.label}
            {t.value === "duyet" && pendingApproval ? <span className="ml-1.5 inline-block size-1.5 rounded-full bg-brand" aria-label="có lô chờ duyệt" /> : null}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
