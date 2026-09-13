"use client";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * ═══════════ Ô CHỌN TRẠNG THÁI: MÀU PHẢI ĐỌC ĐƯỢC CẢ KHI MENU ĐANG MỞ ═══════════
 *
 * ─── LỖI ───
 *
 * Bàn care dùng `<select>` gốc của trình duyệt và tô nền theo trạng thái ĐANG CHỌN. Trình duyệt
 * cho `<option>` KẾ THỪA nền của `<select>`, nên khi mở menu ra thì **mọi lựa chọn đều mang đúng
 * một màu** — màu của trạng thái hiện tại. Mười một lựa chọn trông y hệt nhau, và người dùng phải
 * đọc chữ từng dòng để phân biệt. Màu mà không phân biệt được thì nó chỉ còn là trang trí.
 *
 * Sửa ở đây, không sửa ở từng trang: đây là một khiếm khuyết của Ô CHỌN, và cả CSKH lẫn care đều
 * dùng nó.
 *
 * ─── VÌ SAO KHÔNG PHẢI `<select>` GỐC ───
 *
 * Không có cách nào tô màu từng `<option>` mà đúng trên mọi hệ điều hành: macOS bỏ qua hoàn toàn
 * `background-color` của option, Windows và Linux thì mỗi bản một kiểu. Ô chọn của Radix vẽ menu
 * bằng chính DOM của trang (portal ở `z-50`) nên màu là màu thật, giống nhau ở mọi máy.
 *
 * ─── BA THỨ PHÂN BIỆT MỘT LỰA CHỌN, KHÔNG PHẢI MỘT ───
 *
 *   1. CHẤM MÀU ở đầu dòng — bắt được bằng mắt trước khi đọc chữ, và vẫn phân biệt được với người
 *      mù màu vì nó đi kèm hai thứ dưới;
 *   2. MÀU CHỮ theo ngữ nghĩa;
 *   3. NHÃN tiếng Việt đầy đủ.
 *
 * Nền đặc CHỈ ở nút bấm (trạng thái hiện tại của dòng), KHÔNG ở từng lựa chọn trong menu: mười một
 * mảng nền đặc xếp dọc là một cầu vồng không ai đọc nổi, và nó nuốt mất trạng thái "đang trỏ tới"
 * của chính menu.
 */

export type StatusOption<T extends string> = {
  value: T;
  label: string;
  /** Lớp Tailwind dạng `bg-… text-… dark:bg-… dark:text-…` — cùng bộ với nhãn trên dòng. */
  tone: string;
  hint?: string;
};

/**
 * Rút MÀU CHỮ ra khỏi bộ lớp nền+chữ để dùng cho một lựa chọn trong menu.
 *
 * Bộ lớp gốc (`CARE_STATUS_TONE`, `CS_STATUS_TONE`) khai cả nền lẫn chữ vì nó vẽ một nhãn đặc trên
 * dòng. Trong menu ta chỉ muốn phần chữ — bỏ nền bằng cách LỌC lớp, không bằng cách khai một bảng
 * màu thứ hai. Hai bảng màu là hai chỗ phải nhớ sửa, và lần sửa nào cũng quên một chỗ.
 */
export function textToneOnly(tone: string): string {
  return tone
    .split(/\s+/)
    .filter((c) => c.includes("text-"))
    .join(" ");
}

/** Rút phần NỀN để vẽ chấm màu. `bg-muted` (token của hệ) vẫn dùng được nguyên. */
export function dotToneOnly(tone: string): string {
  const bg = tone.split(/\s+/).filter((c) => c.includes("bg-"));
  return bg.length ? bg.join(" ") : "bg-muted";
}

export function StatusSelect<T extends string>({
  value,
  options,
  onChange,
  disabled,
  className,
  ariaLabel,
  title,
}: {
  value: T;
  options: readonly StatusOption<T>[];
  onChange: (v: T) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel: string;
  title?: string;
}) {
  const hienTai = options.find((o) => o.value === value);
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)} disabled={disabled}>
      <SelectTrigger className={cn("h-8 w-full font-semibold", hienTai?.tone, className)} aria-label={ariaLabel} title={title ?? hienTai?.hint}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} title={o.hint}>
            <span className="flex items-center gap-2">
              {/* Chấm màu: `shrink-0` để nhãn dài không bóp méo nó thành hình bầu dục. */}
              <span className={cn("size-2 shrink-0 rounded-full", dotToneOnly(o.tone))} aria-hidden />
              <span className={cn("font-medium", textToneOnly(o.tone))}>{o.label}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
