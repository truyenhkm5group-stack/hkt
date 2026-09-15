"use client";

import * as React from "react";
import { Tag, X } from "lucide-react";
import { parseAsString, useQueryState } from "nuqs";
import { useNavTransition } from "@/components/nav-progress";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * Lọc theo MÃ HÀNG / BIẾN THỂ.
 *
 * Là ô gõ tự do chứ không phải danh sách chọn: shop có hàng trăm biến thể (mã × size × màu), và
 * một danh sách dài chừng ấy thì cuộn còn lâu hơn gõ. Khớp cả mã, biến thể và tên hàng nên gõ
 * "Q001", "đỏ" hay "váy" đều ra.
 *
 * Trì hoãn 400ms rồi mới ghi URL — cùng nhịp với ô tìm kiếm chung, để mỗi phím gõ không thành một
 * lượt tải lại trang.
 */
export function SkuFilter() {
  const [, startTransition] = useNavTransition();
  const options = { shallow: false, startTransition } as const;
  const [sku, setSku] = useQueryState("sku", parseAsString.withDefault("").withOptions(options));
  const [, setPage] = useQueryState("page", parseAsString.withOptions(options));
  const [value, setValue] = React.useState(sku);
  React.useEffect(() => setValue(sku), [sku]);
  React.useEffect(() => {
    if (value === sku) return;
    const t = setTimeout(() => {
      void setSku(value || null);
      void setPage(null);
    }, 400);
    return () => clearTimeout(t);
  }, [value, sku, setSku, setPage]);
  return (
    <div className={cn("relative")}>
      <Tag className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Mã hàng / biến thể…" className="h-8 w-full pl-8 sm:w-52" />
      {value ? (
        <button type="button" className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setValue("")} aria-label="Xoá lọc mã hàng">
          <X className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}
