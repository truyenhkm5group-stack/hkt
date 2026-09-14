"use client";

import { useState } from "react";
import { Check, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * ═══════════ CHỌN-ĐỂ-LÀM: MỘT THỰC ĐƠN, KHÔNG PHẢI MỘT Ô CHỌN ═══════════
 *
 * ─── SỰ CỐ THẬT (12/09/2026, production): KHÔNG GÁN ĐƯỢC AI VÀO PHÒNG BAN ───
 *
 * Bốn chỗ trong bàn làm việc dựng "chọn một người rồi chạy hành động" bằng `<Select value="">`:
 * thêm người vào phòng, chọn phòng cho người, chuyển việc, giao hàng loạt. Cả bốn ĐỀU HỎNG,
 * và hỏng theo cách tệ nhất — **im lặng**.
 *
 * Đo được bằng trình duyệt: ô bấm nằm ở `x=1245, y=1449`, còn bảng chọn mở ra ở
 * **`x=0, y=6787`** trên màn hình cao 1100px. Nó `position: fixed`, nghĩa là nằm cách đáy màn
 * hình gần 5.700px. Danh sách CÓ mở (trình đọc màn hình thấy đủ 7 mục), người dùng thì không thấy
 * gì cả: bấm, không có gì xảy ra, không lỗi, không toast.
 *
 * Vì sao: `components/ui/select.tsx` đặt mặc định `position="item-aligned"` cho `SelectContent`.
 * Ở chế độ đó Radix căn bảng chọn sao cho MỤC ĐANG CHỌN nằm đè lên ô bấm. Bốn chỗ này điều khiển
 * bằng `value=""` — một giá trị KHÔNG khớp mục nào — nên Radix không có mục nào để căn, và phép
 * tính dự phòng ném bảng chọn ra ngoài màn hình.
 *
 * Nhật ký kiểm toán production xác nhận đúng triệu chứng đó: **không một dòng
 * `DEPARTMENT_MEMBER_SET` nào** trong suốt buổi chủ shop thử gán người, chỉ toàn `DEPARTMENT_SAVE`
 * và `DEPARTMENT_MEMBER_REMOVE` — dấu vết của người đang loay hoay tìm cách khác.
 *
 * ─── VÌ SAO KHÔNG VÁ BẰNG `position="popper"` ───
 *
 * Vá một chữ thì bốn chỗ hết hỏng, nhưng CÁI SAI GỐC vẫn còn: **một ô chọn mà giá trị không bao
 * giờ đổi thì không phải ô chọn — nó là một thực đơn.** Giữ nguyên hình dạng đó thì chỗ thứ năm
 * sẽ lại được viết y như vậy. Ở đây đổi luôn hình dạng: một `Popover` + danh sách nút bấm. Không
 * có "giá trị đang chọn", nên không có gì để căn sai.
 *
 * Kèm ô tìm kiếm: shop này đã có 7 người và sẽ còn thêm; một danh sách phải cuộn để tìm tên là
 * một danh sách người ta bỏ qua.
 */

export type PickerOption = {
  value: string;
  label: string;
  /** Dòng phụ nhỏ bên dưới nhãn — ví dụ "còn 3/20 chỗ" hoặc "đang nghỉ tới 20/09". */
  hint?: string;
  disabled?: boolean;
  /** Đánh dấu mục đang áp dụng (dấu tích). */
  checked?: boolean;
};

export function PickerMenu({
  label,
  icon,
  options,
  onPick,
  disabled,
  empty = "Không còn lựa chọn nào",
  align = "end",
  className,
  searchThreshold = 6,
}: {
  label: string;
  icon?: React.ReactNode;
  options: PickerOption[];
  onPick: (value: string) => void;
  disabled?: boolean;
  empty?: string;
  align?: "start" | "center" | "end";
  className?: string;
  /** Từ ngần này mục trở lên mới hiện ô tìm kiếm. */
  searchThreshold?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const loc = q.trim().toLowerCase();
  const hien = loc ? options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(loc)) : options;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setQ("");
      }}
    >
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled} className={cn("h-8 justify-between gap-1 text-xs font-normal", className)}>
          <span className="flex min-w-0 items-center gap-1 truncate">
            {icon}
            {label}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      {/*
        `align` + `sideOffset` của Popover dùng popper THẬT (có `data-radix-popper-content-wrapper`),
        nên nó luôn nằm cạnh ô bấm và tự lật khi chạm mép màn hình. Đó là khác biệt với
        `Select position="item-aligned"` đã ném bảng chọn ra ngoài màn hình.
      */}
      <PopoverContent align={align} sideOffset={4} className="w-64 p-1.5">
        {options.length >= searchThreshold ? (
          <div className="relative mb-1">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm nhanh…" className="h-7 pl-7 text-xs" aria-label={`Tìm trong ${label}`} />
          </div>
        ) : null}
        <div className="max-h-64 overflow-y-auto">
          {hien.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">{loc ? "Không khớp mục nào" : empty}</p>
          ) : (
            hien.map((o) => (
              <button
                key={o.value}
                type="button"
                disabled={o.disabled}
                className={cn(
                  "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors",
                  o.disabled ? "cursor-not-allowed opacity-50" : "hover:bg-accent",
                )}
                onClick={() => {
                  setOpen(false);
                  setQ("");
                  onPick(o.value);
                }}
              >
                <Check className={cn("mt-0.5 size-3.5 shrink-0", o.checked ? "opacity-100" : "opacity-0")} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{o.label}</span>
                  {o.hint ? <span className="block truncate text-[11px] text-muted-foreground">{o.hint}</span> : null}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
