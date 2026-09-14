"use client";

import * as React from "react";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatNumber } from "@/lib/format";
import type { Facet } from "@/lib/returns/inspection-filter";
import { cn } from "@/lib/utils";

/**
 * ═══════════ Ô CHỌN MỘT GIÁ TRỊ CÓ THẬT, KÈM SỐ KIỆN ═══════════
 *
 * Vì sao không phải một ô gõ chữ: người kho không thuộc mã hàng. Gõ sai một ký tự thì màn hình ra
 * rỗng, và "rỗng" ở kho được đọc là "không có kiện nào" chứ không phải "gõ sai". Danh sách này chỉ
 * chứa giá trị THẬT SỰ có trong hàng đợi đang tải — chọn xong chắc chắn ra kiện.
 *
 * Vì sao mỗi dòng có số kiện: nó trả lời luôn câu hỏi tiếp theo — *"sọt này bao nhiêu kiện"* — thay
 * vì bắt bấm vào rồi mới biết. Người kho dùng con số đó để quyết định lấy sọt nào ra trước.
 *
 * Quá 8 giá trị thì có ô tìm bên trong: danh mục vài chục mã mà phải cuộn là quay lại đúng vấn đề
 * ban đầu.
 */
export function FacetPicker({
  label,
  facets,
  value,
  onChange,
  unit = "kiện",
  className,
}: {
  label: string;
  facets: Facet[];
  /** Khoá đã chuẩn hoá; rỗng = không lọc. */
  value: string;
  onChange: (next: string) => void;
  unit?: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const dangChon = value ? facets.find((f) => f.key === value) : undefined;

  // Không có giá trị nào để chọn thì KHÔNG hiện ô rỗng: một ô bấm vào không ra gì dạy người dùng
  // bỏ qua cả hàng nút.
  if (!facets.length) return null;

  return (
    <div className={cn("flex items-center", className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={value ? "secondary" : "outline"}
            size="sm"
            className={cn("h-8 justify-between gap-1 px-2 text-[12.5px]", value ? "max-w-[190px] rounded-r-none border-r-0" : "max-w-[170px]")}
            aria-label={`Lọc theo ${label}`}
          >
            <span className="truncate">
              <span className="text-muted-foreground">{label}: </span>
              {dangChon ? dangChon.label : "tất cả"}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command>
            {facets.length > 8 ? <CommandInput placeholder={`Tìm ${label.toLowerCase()}…`} /> : null}
            <CommandList className="max-h-[300px]">
              <CommandEmpty>Không có giá trị nào khớp</CommandEmpty>
              <CommandGroup>
                <CommandItem
                  value="__tat_ca__"
                  onSelect={() => {
                    onChange("");
                    setOpen(false);
                  }}
                >
                  <Check className={cn("size-4", value ? "opacity-0" : "opacity-100")} />
                  <span className="flex-1">Tất cả</span>
                </CommandItem>
                {facets.map((f) => (
                  <CommandItem
                    key={f.key}
                    value={`${f.label} ${f.key}`}
                    onSelect={() => {
                      onChange(f.key === value ? "" : f.key);
                      setOpen(false);
                    }}
                  >
                    <Check className={cn("size-4", value === f.key ? "opacity-100" : "opacity-0")} />
                    <span className="flex-1 truncate">{f.label}</span>
                    <span className="numeric shrink-0 text-[11.5px] text-muted-foreground">
                      {formatNumber(f.parcels)} {unit}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {/* Nút bỏ lọc đứng RIÊNG: bấm nhầm vào nhãn để mở lại danh sách là chuyện thường, bấm nhầm
          vào một nút xoá ẩn trong nhãn thì mất bộ lọc mà không hiểu vì sao. */}
      {value ? (
        <Button variant="secondary" size="sm" className="h-8 rounded-l-none px-1.5" onClick={() => onChange("")} aria-label={`Bỏ lọc ${label}`} title={`Bỏ lọc ${label}`}>
          <X className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}
