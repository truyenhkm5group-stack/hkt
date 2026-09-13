"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ShipmentProductCodes } from "@/lib/queries/product-code";

/**
 * ═══════════ MÃ HÀNG TRONG BẢNG: NGẮN Ở NGOÀI, ĐỦ Ở TRONG ═══════════
 *
 * Bảng vận đơn đã chật. Một đơn có thể có ba mã hàng và sáu dòng hàng; in hết ra thì cột này nuốt
 * cả bảng, in một mã thì người đọc tưởng đơn chỉ có một thứ.
 *
 * Nên: mã đầu tiên + "+N" ở ngoài, chi tiết (mẫu mã, số lượng) trong popover. Popover chứ không
 * `title=` vì `title` không hiện trên điện thoại và không chọn/sao chép được.
 */
export function ProductCell({ data }: { data: ShipmentProductCodes | undefined }) {
  if (!data || (!data.codes.length && !data.unmapped)) return <span className="text-xs text-muted-foreground">—</span>;

  const [dau, ...conLai] = data.codes;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded px-1 py-0.5 font-mono text-[12px] hover:bg-muted" onClick={(e) => e.stopPropagation()}>
          {dau ? (
            <>
              <span className="font-semibold">{dau}</span>
              {conLai.length ? <span className="text-muted-foreground">+{conLai.length}</span> : null}
            </>
          ) : (
            <span className="text-amber-600">chưa ghép mã</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2 text-xs" onClick={(e) => e.stopPropagation()}>
        {data.items.length ? (
          <ul className="space-y-1">
            {data.items.map((it, i) => (
              <li key={i} className="flex items-start justify-between gap-2">
                <span>
                  <span className="font-mono font-semibold">{it.code}</span>
                  <span className="ml-1 text-muted-foreground">{it.detail || it.name}</span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">×{it.quantity}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {data.unmapped ? (
          /*
            KHÔNG ĐOÁN MÃ TỪ TÊN HÀNG. Dòng gõ tay như "2 đầm Q004 nâu + đỏ sz xl" đọc ra thì thấy
            ngay là Q004, nhưng đoán hộ nghĩa là một dòng doanh thu chui vào thống kê của một mã mà
            không có gì chứng minh — và cái sai đó không bao giờ lộ ra. Nói thẳng là chưa ghép được.
          */
          <p className="mt-1.5 border-t pt-1.5 text-[11px] text-amber-700 dark:text-amber-400">
            {data.unmapped} dòng hàng chưa ghép được về mã nào (dòng gõ tay, không có mẫu mã) — không tính vào thống kê theo mã hàng.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
