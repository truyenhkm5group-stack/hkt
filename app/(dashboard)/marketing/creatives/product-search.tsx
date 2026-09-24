"use client";

import { Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import type { ProductOption } from "@/lib/queries/creative-sources";
import { cn } from "@/lib/utils";

/** Nhãn một mã hàng: mã (nếu có) · tên. */
export function productLabel(p: ProductOption | undefined | null): string {
  if (!p) return "";
  return p.code ? `${p.code} · ${p.name}` : p.name;
}

function khongDau(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Ô TÌM MÃ HÀNG — gõ mã hoặc tên (không cần dấu), chọn một dòng.
 *
 * Danh sách mã được máy chủ đưa xuống một lần và lọc tại chỗ (cùng cách phiếu nhập kho làm): số mã
 * của shop vài trăm, lọc trên trình duyệt nhanh hơn một vòng hỏi máy chủ cho mỗi phím gõ.
 */
export function ProductSearch({
  products,
  value,
  onChange,
  placeholder = "Gõ mã hoặc tên sản phẩm…",
  exclude,
  id,
}: {
  products: ProductOption[];
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
  /** Mã đã chọn ở nơi khác (danh sách mã ưu tiên) — không gợi ý lại. */
  exclude?: string[];
  id?: string;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const chon = products.find((p) => p.id === value);
  const goiY = useMemo(() => {
    const t = khongDau(q.trim());
    const bo = new Set(exclude ?? []);
    const list = products.filter((p) => !bo.has(p.id) && (!t || khongDau(`${p.code} ${p.name}`).includes(t)));
    return list.slice(0, 30);
  }, [q, products, exclude]);

  if (chon) {
    return (
      <div className="flex h-9 items-center justify-between gap-2 rounded-md border bg-background px-3 text-sm">
        <span className="truncate">{productLabel(chon)}</span>
        <button type="button" aria-label="Bỏ chọn mã hàng" className="text-muted-foreground hover:text-foreground" onClick={() => onChange("")}>
          <X className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        id={id}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={placeholder}
        autoComplete="off"
        className="pl-8"
      />
      {open ? (
        <div className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
          {goiY.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{products.length ? "Không có mã nào khớp." : "Chưa đồng bộ sản phẩm nào từ Pancake."}</p>
          ) : (
            goiY.map((p) => (
              <button
                key={p.id}
                type="button"
                className={cn("flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(p.id);
                  setQ("");
                  setOpen(false);
                }}
              >
                {p.code ? <span className="shrink-0 font-medium">{p.code}</span> : null}
                <span className="truncate text-muted-foreground">{p.name}</span>
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
