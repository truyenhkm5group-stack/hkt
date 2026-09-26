"use client";

import { parseAsString, useQueryStates } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

/**
 * THANH TAB = QUY TRÌNH (chủ shop 26/09/2026: "thiết kế lại flow cho khoa học hơn, dễ quản lý và sử dụng hơn" + bỏ lô
 * hằng ngày). Năm bước đánh số theo đúng thứ tự làm việc, mỗi bước mang SỐ VIỆC ĐANG CHỜ ở đó; bốn tab phụ (thiết kế,
 * máy học, nguồn ảnh, cấu hình) đứng sau vạch ngăn. Tab mặc định do trang quyết (bước sớm nhất đang có việc), nên thanh
 * tab phải biết mặc định là gì — bỏ `tab` khỏi URL chỉ khi chọn ĐÚNG tab mặc định.
 *
 * Khoá tab cũ giữ nghĩa để link cũ vẫn mở đúng: `duyet` = ② Duyệt ảnh (trước là "Duyệt lô / Duyệt mẫu"), `thu-vien` =
 * ⑤ Mẫu thắng, `dang-chay` = ④ Đang chạy.
 */
export const CREATIVE_STEPS = [
  { value: "tao", label: "① Tạo ảnh" },
  { value: "duyet", label: "② Duyệt ảnh" },
  { value: "dang", label: "③ Hàng đợi & Đăng" },
  { value: "dang-chay", label: "④ Đang chạy" },
  { value: "thu-vien", label: "⑤ Mẫu thắng" },
] as const;

export const CREATIVE_SIDE_TABS = [
  { value: "thiet-ke", label: "Thiết kế" },
  { value: "hoc", label: "Máy đã học gì" },
  { value: "nguon", label: "Nguồn ảnh" },
  { value: "cau-hinh", label: "Cấu hình & luật" },
] as const;

/** Mọi tab (bước + phụ) — thứ tự hiển thị. */
export const CREATIVE_TABS = [...CREATIVE_STEPS, ...CREATIVE_SIDE_TABS] as const;

export type StepBadges = Partial<Record<(typeof CREATIVE_STEPS)[number]["value"], { n: number; hint: string }>>;

export function CreativeTabs({ active, defaultTab, badges = {} }: { active: string; defaultTab: string; badges?: StepBadges }) {
  const [dangChuyen, startTransition] = useNavTransition();
  const [, setState] = useQueryStates(
    { tab: parseAsString, page: parseAsString, q: parseAsString, loai: parseAsString, bat: parseAsString, lo: parseAsString, ngay: parseAsString, product: parseAsString },
    { shallow: false, history: "push", startTransition },
  );
  return (
    <Tabs value={active} onValueChange={(value) => void setState({ tab: value === defaultTab ? null : value, page: null, q: null, loai: null, bat: null, lo: null, ngay: null, product: null })}>
      <TabsList className={cn("h-auto flex-wrap justify-start transition-opacity", dangChuyen && "pointer-events-none opacity-60")}>
        {CREATIVE_STEPS.map((t) => {
          const b = badges[t.value];
          return (
            <TabsTrigger key={t.value} value={t.value} className="flex-none px-3 font-semibold" title={b?.hint}>
              {t.label}
              {b && b.n > 0 ? <span className="numeric ml-1.5 rounded-full bg-brand px-1.5 text-[10.5px] font-bold text-white">{b.n}</span> : null}
            </TabsTrigger>
          );
        })}
        <span className="mx-1 h-5 w-px self-center bg-border" aria-hidden />
        {CREATIVE_SIDE_TABS.map((t) => (
          <TabsTrigger key={t.value} value={t.value} className="flex-none px-3 text-muted-foreground">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
