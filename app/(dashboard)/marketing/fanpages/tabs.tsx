"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * Hai góc nhìn của CÙNG một việc: khai ai phụ trách page nào, và xem việc khai đó ra con số gì.
 *
 * Một mục menu, hai tab — cùng cách `/work` làm. Tách thành hai mục menu sẽ bắt người dùng chọn góc
 * nhìn trước khi kịp nhìn thấy gì.
 */
export function FanpageTabs({ active }: { active: string }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates({ tab: parseAsString, page: parseAsString }, { shallow: false, history: "push", startTransition });
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === "report" ? null : value, page: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        <TabsTrigger value="report" className="flex-none px-3">
          Báo cáo quy kết
        </TabsTrigger>
        <TabsTrigger value="orders" className="flex-none px-3">
          Soi từng đơn
        </TabsTrigger>
        <TabsTrigger value="assign" className="flex-none px-3">
          Gán fanpage → marketer
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
