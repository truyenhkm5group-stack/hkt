"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Một mục menu, nhiều tab — cùng cách `/marketing/fanpages` và `/work` làm. Chỉ khai những tab ĐÃ
 * CÓ màn hình; tab của gói sau (duyệt lô · đang chạy · thư viện · học) được thêm khi nó tồn tại,
 * không đặt chỗ trước bằng một tab rỗng.
 */
export const CREATIVE_TABS = [
  { value: "nguon", label: "Nguồn ảnh" },
  { value: "cau-hinh", label: "Cấu hình & luật" },
] as const;

export function CreativeTabs({ active }: { active: string }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates(
    { tab: parseAsString, page: parseAsString, q: parseAsString, loai: parseAsString, bat: parseAsString },
    { shallow: false, history: "push", startTransition },
  );
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === "nguon" ? null : value, page: null, q: null, loai: null, bat: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {CREATIVE_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className="flex-none px-3">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
