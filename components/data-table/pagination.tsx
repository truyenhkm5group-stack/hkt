"use client";

import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatNumber } from "@/lib/format";

export function DataTablePagination({ page, pageSize, pageCount, total, onPageChange, onPageSizeChange }: { page: number; pageSize: number; pageCount: number; total: number; onPageChange: (page: number) => void; onPageSizeChange: (size: number) => void }) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex flex-col gap-3 border-t px-3 py-2.5 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <div>
        Hiển thị <span className="font-semibold text-foreground">{formatNumber(from)}–{formatNumber(to)}</span> trên <span className="font-semibold text-foreground">{formatNumber(total)}</span> dòng
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span>Mỗi trang</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSizeChange(Number(v))}>
            <SelectTrigger size="sm" className="h-7 w-[72px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 25, 50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <span className="mr-2">
            Trang <span className="font-semibold text-foreground">{page}</span> / {Math.max(1, pageCount)}
          </span>
          <Button variant="outline" size="icon" className="size-7" disabled={page <= 1} onClick={() => onPageChange(1)} aria-label="Trang đầu">
            <ChevronsLeft className="size-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="size-7" disabled={page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Trang trước">
            <ChevronLeft className="size-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="size-7" disabled={page >= pageCount} onClick={() => onPageChange(page + 1)} aria-label="Trang sau">
            <ChevronRight className="size-3.5" />
          </Button>
          <Button variant="outline" size="icon" className="size-7" disabled={page >= pageCount} onClick={() => onPageChange(pageCount)} aria-label="Trang cuối">
            <ChevronsRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
