"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Shirt } from "lucide-react";
import { isProvisionalModel } from "@/lib/constants/provisional-model";
import { ModelStateBadge } from "@/app/(dashboard)/models/state-badge";
import { RowLink } from "@/components/data-table/data-table";
import { formatDate } from "@/lib/format";
import { MODEL_SIGNAL_HINT, MODEL_SIGNAL_LABEL, MODEL_SIGNAL_TONE, type ModelSignal } from "@/lib/constants/model-signal";
import type { ModelListRow } from "@/lib/queries/models";
import { cn } from "@/lib/utils";

/** Ô tín hiệu của một mẫu trên /models (Agent S) — chỉ NHÃN, cùng mức trang 360 cho hiện khi che câu chi tiết. */
export type ModelSignalCell = { signal: ModelSignal; summary: string; conflicts: number };

export const modelColumns: ColumnDef<ModelListRow, unknown>[] = [
  {
    id: "code",
    accessorKey: "code",
    header: "Mẫu",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="flex min-w-[220px] items-center gap-3">
          {r.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.image} alt="" className="size-10 shrink-0 rounded-md border object-cover" />
          ) : (
            <span className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted text-muted-foreground">
              <Shirt className="size-4" />
            </span>
          )}
          <div className="min-w-0">
            <RowLink href={`/models/${r.id}`} className="font-mono font-semibold">
              {r.code}
            </RowLink>
            {isProvisionalModel(r) ? (
              <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10.5px] font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-300" title="Mẫu mới test chưa lên mã — máy cấp mã tạm. Mẫu thắng thì chốt mã chính thức ở trang mẫu.">
                Mã tạm
              </span>
            ) : null}
            <div className="truncate text-xs text-muted-foreground">{r.name || r.productName || "—"}</div>
          </div>
        </div>
      );
    },
  },
  {
    id: "state",
    header: "Trạng thái khai",
    cell: ({ row }) => (
      <div className="space-y-0.5">
        <ModelStateBadge state={row.original.state} />
        {row.original.stateChangedAt ? <div className="text-[10.5px] text-muted-foreground">từ {formatDate(row.original.stateChangedAt)}</div> : null}
      </div>
    ),
  },
  {
    id: "links",
    header: "Nối với",
    enableSorting: false,
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="space-y-0.5 text-xs">
          {r.productId ? (
            <div>
              Sản phẩm: <RowLink href={`/products/${r.productId}`}>{r.productName || r.productId}</RowLink>
              {r.productRemoved ? <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">đã xoá</span> : null}
            </div>
          ) : (
            <div className="text-muted-foreground">Chưa có sản phẩm Pancake</div>
          )}
          {r.designCode ? <div>Thiết kế: <span className="font-mono">{r.designCode}</span></div> : null}
        </div>
      );
    },
  },
  {
    id: "owner",
    header: "Phụ trách",
    enableSorting: false,
    cell: ({ row }) => <span className={row.original.ownerName ? "text-sm" : "text-sm text-muted-foreground"}>{row.original.ownerName ?? "—"}</span>,
  },
  {
    id: "createdAt",
    accessorKey: "createdAt",
    header: "Vào sổ",
    cell: ({ row }) => (
      <div className="text-xs">
        {formatDate(row.original.createdAt)}
        <div className="text-[10.5px] text-muted-foreground">{row.original.registeredBy === "USER" ? "người gõ mã" : "máy đồng bộ"}</div>
      </div>
    ),
  },
];

/**
 * Cột "Tín hiệu" — chỉ thêm khi người xem bật (`?tinhieu=1`): tín hiệu đọc theo LÔ (`getModelSignalsBatch`)
 * cho mọi mẫu. `null` ⇒ "—" (không đọc được), không bao giờ là một nhãn giả.
 */
export function signalColumn(signals: Readonly<Record<string, ModelSignalCell | null>>, periodLabel: string): ColumnDef<ModelListRow, unknown> {
  return {
    id: "signal",
    header: `Tín hiệu · ${periodLabel.toLowerCase()}`,
    enableSorting: false,
    cell: ({ row }) => {
      const c = signals[row.original.id] ?? null;
      if (!c) return <span className="text-sm text-muted-foreground">—</span>;
      return (
        <div className="max-w-[240px] space-y-0.5" title={MODEL_SIGNAL_HINT[c.signal]}>
          <span className={cn("inline-flex items-center rounded-md px-2 py-0.5 text-xs font-semibold", MODEL_SIGNAL_TONE[c.signal])}>
            {MODEL_SIGNAL_LABEL[c.signal]}
            {c.conflicts ? <span className="ml-1 font-normal">⚡ {c.conflicts}</span> : null}
          </span>
          {c.summary ? <div className="truncate text-[10.5px] text-muted-foreground">{c.summary}</div> : null}
        </div>
      );
    },
  };
}
