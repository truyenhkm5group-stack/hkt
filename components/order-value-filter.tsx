"use client";

import * as React from "react";
import { parseAsString, useQueryState } from "nuqs";
import { Coins, Megaphone, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { useNavTransition } from "@/components/nav-progress";
import { ORDER_VALUE_PRESETS, orderValueLabel, type OrderValueFilter } from "@/lib/constants/order-value";
import { cn } from "@/lib/utils";

/**
 * ═══════════ BỘ LỌC GIÁ TRỊ ĐƠN — MỘT Ô ĐIỀU KHIỂN, DÙNG CHUNG HAI TRANG ═══════════
 *
 * Trang Lợi nhuận và trang Tỷ lệ giao thành công phải hiểu CÙNG một bộ tham số URL (`vmin`,
 * `vmax`, `ads`), nếu không người đọc đổi trang là mất bộ lọc mà không hiểu vì sao. Nên ô điều
 * khiển chỉ có MỘT bản, và danh sách mức tắt đọc từ `ORDER_VALUE_PRESETS` — không gõ lại.
 *
 * Số hiện trong ô nhập là số NGƯỜI GÕ, không định dạng lại khi đang gõ: tự chèn dấu chấm vào giữa
 * lúc người ta đang bấm phím làm con trỏ nhảy. `parseOrderValue` ở máy chủ nhận cả "300.000" lẫn
 * "300000".
 */

const opts = { shallow: false as const, history: "push" as const };

export function OrderValueFilterControl({ value, showAds = false, adsIncluded = true }: { value: OrderValueFilter; showAds?: boolean; adsIncluded?: boolean }) {
  // Một transition dùng chung cho cả bốn tham số: mỗi lượt áp bộ lọc chỉ là MỘT lượt đi máy chủ,
  // nên thanh tiến trình chung cũng chỉ nên thấy một việc.
  const [, startTransition] = useNavTransition();
  const qs = { ...opts, startTransition };
  const [, setMin] = useQueryState("vmin", parseAsString.withOptions(qs));
  const [, setMax] = useQueryState("vmax", parseAsString.withOptions(qs));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(qs));
  const [, setAds] = useQueryState("ads", parseAsString.withOptions(qs));
  const [open, setOpen] = React.useState(false);
  const [tuMin, setTuMin] = React.useState(value.min === null ? "" : String(value.min));
  const [tuMax, setTuMax] = React.useState(value.max === null ? "" : String(value.max));
  React.useEffect(() => {
    setTuMin(value.min === null ? "" : String(value.min));
    setTuMax(value.max === null ? "" : String(value.max));
  }, [value.min, value.max]);

  const dangLoc = value.min !== null || value.max !== null;
  const apDung = (min: number | null, max: number | null) => {
    void setMin(min === null ? null : String(min));
    void setMax(max === null ? null : String(max));
    void setPage(null);
    setOpen(false);
  };
  const trung = (min: number | null, max: number | null) => value.min === min && value.max === max;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn("h-8 border-dashed", dangLoc && "border-solid border-primary/50")}>
            <Coins className="size-4" /> Giá trị đơn
            {dangLoc ? (
              <>
                <Separator orientation="vertical" className="mx-1 h-4" />
                <Badge variant="secondary" className="rounded-sm px-1 font-normal">
                  {orderValueLabel(value)}
                </Badge>
              </>
            ) : null}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <p className="text-xs font-medium">Lọc theo tiền hàng khách phải trả</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">Sau giảm giá, chưa gồm cước. Lấy giá trị của CẢ ĐƠN — đơn nhiều mã vào hoặc ra trọn vẹn.</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ORDER_VALUE_PRESETS.map((m) => (
              <button
                key={m.key}
                type="button"
                onClick={() => apDung(m.min, m.max)}
                className={cn(
                  "rounded-md border px-2 py-1 text-[11px] hover:bg-muted",
                  trung(m.min, m.max) ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <Separator className="my-2.5" />
          <p className="text-[11px] font-medium">Tự điền khoảng (đồng)</p>
          <div className="mt-1.5 flex items-center gap-1.5">
            <Input value={tuMin} onChange={(e) => setTuMin(e.target.value)} placeholder="Từ" inputMode="numeric" className="h-8 text-xs" />
            <span className="text-xs text-muted-foreground">–</span>
            <Input value={tuMax} onChange={(e) => setTuMax(e.target.value)} placeholder="Đến" inputMode="numeric" className="h-8 text-xs" />
          </div>
          <p className="mt-1 text-[10.5px] text-muted-foreground">Lấy đơn từ “Từ” trở lên và NHỎ HƠN “Đến”. Bỏ trống một đầu để không chặn đầu đó.</p>
          <div className="mt-2 flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 flex-1 text-xs"
              onClick={() => {
                const so = (v: string) => {
                  const d = v.replace(/[^\d]/g, "");
                  return d ? Number(d) : null;
                };
                apDung(so(tuMin), so(tuMax));
              }}
            >
              Áp dụng
            </Button>
            {dangLoc ? (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => apDung(null, null)}>
                <X className="size-3.5" /> Bỏ lọc
              </Button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {showAds ? (
        /*
          CÔNG TẮC QUẢNG CÁO ĐỨNG CẠNH BỘ LỌC vì nó là vế thứ hai của cùng một câu hỏi (xem
          `lib/constants/order-value.ts`). Tắt rồi thì nút PHẢI trông khác hẳn — con số lợi nhuận
          đẹp lên mà người đọc không thấy vì sao là đúng thứ cần chặn.
        */
        <Button
          variant="outline"
          size="sm"
          className={cn("h-8 border-dashed", !adsIncluded && "border-solid border-amber-500 bg-amber-50 text-amber-800 hover:bg-amber-100 dark:bg-amber-950/60 dark:text-amber-200")}
          onClick={() => {
            void setAds(adsIncluded ? "0" : null);
            void setPage(null);
          }}
          title={adsIncluded ? "Đang trừ chi phí quảng cáo vào lợi nhuận. Bấm để xem lợi nhuận của đơn xả — không tính CPQC." : "Đang KHÔNG tính chi phí quảng cáo: CPQC hiện 0 và không trừ vào lợi nhuận. Bấm để tính lại."}
        >
          <Megaphone className="size-4" />
          {adsIncluded ? "Có tính CPQC" : "KHÔNG tính CPQC"}
        </Button>
      ) : null}
    </div>
  );
}
