"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SHIPMENT_DIRECTION_LABEL } from "@/lib/constants/viettelpost";
import { Truck } from "lucide-react";
import { RowLink } from "@/components/data-table/data-table";
import { CopyButton } from "@/components/misc";
import { CodStatusBadge, ShipmentStageBadge } from "@/components/status-badge";
import { Money } from "@/components/ui-bits";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import type { ShipmentListRow } from "@/lib/queries/shipments";
import type { ShipmentProductCodes } from "@/lib/queries/product-code";
import { ProductCell } from "@/app/(dashboard)/shipments/product-cell";
import { CareRowActions } from "@/app/(dashboard)/shipments/care-row-actions";

/**
 * Cột dựng bằng HÀM chứ không phải hằng số: cột mã hàng và cột xử lý cần dữ liệu chỉ có ở phía
 * máy chủ (mã hàng của đúng trang đang xem, danh sách nhân sự, quyền thao tác). Truyền qua tham số
 * thay vì nhét vào từng dòng dữ liệu — dòng vận đơn không nên phình ra vì nhu cầu hiển thị.
 */
export function buildShipmentColumns(opts: {
  productCodes: Record<string, ShipmentProductCodes>;
  staff: { id: string; name: string }[];
  canManage: boolean;
}): ColumnDef<ShipmentListRow, unknown>[] {
  return [
    {
      id: "product",
      header: "Mã hàng",
      cell: ({ row }) => <ProductCell data={opts.productCodes[row.original.id]} />,
    },
    {
      id: "care",
      header: "Xử lý",
      cell: ({ row }) => (
        <CareRowActions
          shipmentId={row.original.id}
          tracking={row.original.vtpOrderNumber ?? row.original.trackingCode ?? row.original.id}
          staff={opts.staff}
          canManage={opts.canManage}
          isReturned={row.original.outcome === "RETURNED" || row.original.outcome === "RETURNED_BY_RULE"}
        />
      ),
    },
    ...shipmentColumns,
  ];
}

export const shipmentColumns: ColumnDef<ShipmentListRow, unknown>[] = [
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Mã vận đơn",
    cell: ({ row }) => {
      const s = row.original;
      const number = s.vtpOrderNumber ?? s.trackingCode;
      return (
        <div className="min-w-[130px]">
          {/*
            NÚT SAO CHÉP NGAY CẠNH MÃ. Người trực đơn phải dán mã vận đơn sang Viettel Post / chat
            hàng chục lần mỗi ngày; bôi đen một chuỗi 13 ký tự trong ô hẹp là thao tác dễ trượt và
            dễ thiếu ký tự. `CopyButton` đã có `stopPropagation` nên bấm nó KHÔNG mở dòng.
          */}
          <div className="flex items-center gap-0.5">
            <RowLink href={`/shipments/${s.id}`} className="font-mono text-[13px]">
              {number ?? "—"}
            </RowLink>
            {number ? <CopyButton value={number} what="mã vận đơn" className="size-5 shrink-0 [&_svg]:size-3" /> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
            <Truck className="size-3.5 shrink-0" />
            <span className="truncate">{s.carrier || "ĐVVC"}</span>
            {/* Từ 10/09/2026 một đơn có thể có nhiều lần gửi. Chỉ hiện khi KHÁC lần đầu — gắn nhãn
                "lần 1" cho mọi dòng chỉ làm loãng bảng mà không thêm thông tin nào. */}
            {s.attemptNo && s.attemptNo > 1 ? (
              <span className="rounded bg-primary/10 px-1 font-semibold text-primary" title="Đơn này đã được gửi lại">
                lần {s.attemptNo}
              </span>
            ) : null}
            {s.direction && s.direction !== "OUTBOUND" ? (
              <span className="rounded border px-1">{SHIPMENT_DIRECTION_LABEL[s.direction] ?? s.direction}</span>
            ) : null}
          </div>
        </div>
      );
    },
    size: 160,
  },
  {
    id: "order",
    header: "Đơn hàng",
    enableSorting: false,
    cell: ({ row }) => {
      const o = row.original.order;
      if (!o) {
        return (
          <div className="min-w-[96px]">
            <span className="inline-flex items-center rounded-md bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700 dark:bg-amber-950/60 dark:text-amber-300">Ngoài Pancake</span>
            {row.original.orderReference ? <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">{row.original.orderReference}</div> : null}
          </div>
        );
      }
      return (
        <div className="min-w-[96px]">
          <RowLink href={`/orders/${o.id}`}>#{o.systemId ?? o.id}</RowLink>
          <div className="text-xs text-muted-foreground">
            {o.source}
            {o.totalPriceAfterDiscount ? (
              <>
                {" · "}
                <Money value={o.totalPriceAfterDiscount} compact />
              </>
            ) : null}
          </div>
        </div>
      );
    },
  },
  {
    id: "receiver",
    header: "Người nhận",
    enableSorting: false,
    cell: ({ row }) => {
      const s = row.original;
      const name = s.receiverName || s.order?.billFullName || "—";
      const phone = s.receiverPhone || s.order?.billPhone || "";
      return (
        <div className="min-w-[150px] max-w-[220px]">
          <div className="truncate font-medium">{name}</div>
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            {/* Giá trị sao chép là SỐ THẬT đang hiển thị — không phải bản che. Người đang xem đã
                được phép thấy nó, nên sao chép ra một chuỗi khác là bẫy người dùng. */}
            <span className="truncate" title={s.receiverAddress || undefined}>
              {phone || "—"}
              {s.receiverAddress ? ` · ${s.receiverAddress}` : ""}
            </span>
            {phone ? <CopyButton value={phone} what="SĐT" className="size-5 shrink-0 [&_svg]:size-3" /> : null}
          </div>
        </div>
      );
    },
  },
  {
    id: "vtpStatusDate",
    accessorKey: "vtpStatusDate",
    header: "Trạng thái",
    cell: ({ row }) => {
      const s = row.original;
      const label = s.vtpStatusName ?? undefined;
      const short = label && label.length > 34 ? `${label.slice(0, 32).trimEnd()}…` : label;
      // Viettel Post ghi "Giao thành công" cho cả vận đơn chiều về lẫn đơn khách trả hàng. Kết quả
      // thật lấy từ ORDER_OUTCOME — cùng một biểu thức mọi báo cáo dùng, không tính lại ở đây.
      const fake = s.stage === "DELIVERED" && s.outcome && s.outcome !== "DELIVERED";
      return (
        <div className="min-w-[140px] space-y-1" title={label}>
          <ShipmentStageBadge stage={s.stage} label={short} />
          {fake ? (
            <div className="text-[10.5px] font-medium text-rose-600 dark:text-rose-400">
              {s.outcome === "RETURNED" ? "Thực tế: hoàn (hàng đã quay về shop)" : "Thực tế: không thành công"}
            </div>
          ) : null}
          <div className="text-[10.5px] text-muted-foreground" suppressHydrationWarning>
            {s.vtpStatusDate ? formatTimeAgo(s.vtpStatusDate) : "—"}
            {s.vtpLocation ? ` · ${s.vtpLocation}` : ""}
          </div>
        </div>
      );
    },
  },
  {
    id: "codAmount",
    accessorKey: "codAmount",
    header: "COD",
    meta: { align: "right" },
    cell: ({ row }) => (
      <div className="text-right">
        <Money value={row.original.codAmount} className="font-bold" />
        <div className="mt-0.5 flex justify-end">
          <CodStatusBadge status={row.original.codStatus} className="px-1.5 text-[10px]" />
        </div>
      </div>
    ),
  },
  {
    id: "shippingFee",
    header: "Phí ship",
    enableSorting: false,
    meta: { align: "right" },
    cell: ({ row }) => <Money value={row.original.shippingFee} className="text-muted-foreground" />,
  },
  {
    id: "deliveredAt",
    accessorKey: "deliveredAt",
    header: "Thời gian",
    cell: ({ row }) => {
      const s = row.original;
      return (
        <div className="min-w-[150px] text-xs text-muted-foreground">
          <div>Lấy: {formatDateTime(s.pickedUpAt)}</div>
          {s.stage === "RETURNED" && s.returnedAt ? <div className="text-rose-600">Hoàn: {formatDateTime(s.returnedAt)}</div> : <div className={s.deliveredAt ? "text-emerald-700 dark:text-emerald-300" : undefined}>Giao: {formatDateTime(s.deliveredAt)}</div>}
        </div>
      );
    },
  },
  {
    id: "lastVtpSyncAt",
    header: "Cập nhật VTP",
    enableSorting: false,
    cell: ({ row }) => (
      <div className="text-xs text-muted-foreground">
        <div suppressHydrationWarning>{row.original.lastVtpSyncAt ? formatTimeAgo(row.original.lastVtpSyncAt) : "Chưa tra cứu"}</div>
        {row.original.isFinal ? <div className="text-[10.5px]">Đã kết thúc</div> : null}
      </div>
    ),
  },
];
