"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Money } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import type { NominalMarketerRow } from "@/lib/queries/payroll";
import { cn } from "@/lib/utils";

/**
 * Hàng marketer trong bảng LN danh nghĩa + dropdown chi tiết theo mã hàng.
 * Chỉ liệt kê mã có số liệu (QC, đơn, doanh thu hoặc % chủ mã); tổng các dòng con = hàng cha (trừ QC test).
 */
export function MarketerNominalRows({ row, ownerSharePct }: { row: NominalMarketerRow; ownerSharePct: number }) {
  const [open, setOpen] = useState(false);
  const x = row;
  const hasDetail = x.products.length > 0;
  const cross = x.products.filter((p) => p.role === "cross");
  return (
    <Fragment>
      <TableRow className={cn(open && "bg-primary/5")}>
        <TableCell>
          <button
            type="button"
            className={cn("flex items-start gap-1.5 text-left", hasDetail ? "hover:text-primary" : "cursor-default")}
            onClick={() => hasDetail && setOpen((v) => !v)}
            aria-expanded={open}
            title={hasDetail ? `${open ? "Ẩn" : "Xem"} chi tiết ${x.products.length} mã hàng` : "Chưa có mã hàng phát sinh số liệu"}
          >
            <span className="mt-0.5 shrink-0 text-muted-foreground">{hasDetail ? open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" /> : <span className="inline-block size-4" />}</span>
            <span className="min-w-0">
              <span className={cn("block font-semibold", !x.marketerId && "text-amber-700")}>{x.name}</span>
              {x.ownedProducts.length ? <span className="block text-[11px] text-muted-foreground">Phụ trách: {x.ownedProducts.join(", ")}</span> : null}
              {cross.length ? <span className="block text-[11px] text-muted-foreground">Đẩy chéo: {cross.map((p) => `${p.code || p.productName} ${(p.share * 100).toFixed(0)}%`).join(", ")}</span> : null}
              {hasDetail ? <span className="block text-[11px] text-primary">{open ? "Ẩn chi tiết" : `Chi tiết ${x.products.length} mã hàng`}</span> : null}
            </span>
          </button>
        </TableCell>
        <TableCell className="text-right"><Money value={x.adSpend} className="text-rose-600" /></TableCell>
        <TableCell className="text-right"><Money value={x.testSpend} className={x.testSpend ? "text-amber-600" : "text-muted-foreground"} /></TableCell>
        <TableCell className="text-right"><Money value={x.otherCost} className="text-muted-foreground" /></TableCell>
        <TableCell className="numeric text-right">{formatNumber(x.attributedOrders)}</TableCell>
        <TableCell className="text-right"><Money value={x.attributedRevenue} /></TableCell>
        <TableCell className="text-right"><Money value={x.profitBeforeAds} className="text-muted-foreground" /></TableCell>
        <TableCell className="text-right text-xs">
          {x.ownerBonusReceived ? <div className="text-emerald-700">+{formatVND(x.ownerBonusReceived)}</div> : null}
          {x.ownerBonusPaid ? <div className="text-rose-600">−{formatVND(x.ownerBonusPaid)}</div> : null}
          {!x.ownerBonusReceived && !x.ownerBonusPaid ? <span className="text-muted-foreground">—</span> : null}
        </TableCell>
        <TableCell className="text-right"><Money value={x.personalNet} className={cn("font-bold", x.personalNet >= 0 ? "text-success" : "text-destructive")} /></TableCell>
        <TableCell className="text-right"><Money value={x.attributedOrders ? Math.round((x.adSpend + x.testSpend) / x.attributedOrders) : 0} className="text-muted-foreground" /></TableCell>
      </TableRow>
      {open
        ? x.products.map((p) => (
            <TableRow key={`${x.marketerId ?? "none"}-${p.productId}`} className="bg-muted/30 text-[12.5px] hover:bg-muted/40">
              <TableCell className="pl-10">
                <div className="font-medium">
                  {p.code ? `${p.code} · ` : ""}
                  {p.productName}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  {p.role === "owner" ? "Mã mình phụ trách" : "Đẩy chéo"}
                  {p.share > 0 ? ` · ghi nhận ${(p.share * 100).toFixed(0)}% đơn & DT theo tỷ trọng QC` : " · không chạy QC, chỉ nhận % chủ mã"}
                </div>
              </TableCell>
              <TableCell className="text-right"><Money value={p.adSpend} className="text-rose-600" /></TableCell>
              <TableCell className="text-right text-muted-foreground">—</TableCell>
              <TableCell className="text-right"><Money value={p.otherCost} className="text-muted-foreground" /></TableCell>
              <TableCell className="numeric text-right">{formatNumber(p.orders)}</TableCell>
              <TableCell className="text-right"><Money value={p.revenue} /></TableCell>
              <TableCell className="text-right"><Money value={p.profitBeforeAds} className="text-muted-foreground" /></TableCell>
              <TableCell className="text-right text-xs">
                {p.ownerBonus > 0 ? <span className="text-emerald-700">+{formatVND(p.ownerBonus)}</span> : p.ownerBonus < 0 ? <span className="text-rose-600" title={`Trích ${ownerSharePct}% LN dương cho chủ mã`}>−{formatVND(-p.ownerBonus)}</span> : <span className="text-muted-foreground">—</span>}
              </TableCell>
              <TableCell className="text-right"><Money value={p.personalNet} className={cn("font-semibold", p.personalNet >= 0 ? "text-success" : "text-destructive")} /></TableCell>
              <TableCell className="text-right"><Money value={p.orders ? Math.round(p.adSpend / p.orders) : 0} className="text-muted-foreground" /></TableCell>
            </TableRow>
          ))
        : null}
    </Fragment>
  );
}
