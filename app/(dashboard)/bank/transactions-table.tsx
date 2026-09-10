"use client";

import { useMemo, useTransition } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { BankGroupSelect } from "@/app/(dashboard)/bank/group-select";
import { BankNoteInput } from "@/app/(dashboard)/bank/note-input";
import { RuleFromTxnButton } from "@/app/(dashboard)/bank/rule-from-txn";
import { DataTable } from "@/components/data-table/data-table";
import { Button } from "@/components/ui/button";
import { classifyBankTransactions, deleteBankTransaction } from "@/lib/actions/bank";
import { UnlinkButton } from "@/app/(dashboard)/bank/unlink-button";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, BANK_LINK_TYPE_LABEL, BANK_NOT_A_COST_NOTE, type BankGroup, type BankLinkType } from "@/lib/constants/bank";
import { formatDate, formatVND } from "@/lib/format";
import type { BankTxnRow } from "@/lib/queries/bank";
import { cn } from "@/lib/utils";

function buildColumns({ canWrite }: { canWrite: boolean }): ColumnDef<BankTxnRow, unknown>[] {
  return [
    {
      id: "txnAt",
      accessorKey: "txnAt",
      header: "Ngày",
      size: 110,
      cell: ({ row }) => (
        <div className="whitespace-nowrap text-sm">
          <div className="font-medium">{formatDate(row.original.txnAt)}</div>
          <div className="text-[10.5px] text-muted-foreground">
            {new Date(row.original.txnAt).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ho_Chi_Minh" })}
          </div>
        </div>
      ),
    },
    {
      id: "description",
      header: "Nội dung",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-[220px] max-w-[360px]">
          <div className="truncate text-[13px]" title={row.original.description}>{row.original.description || "—"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1">
            <span className="rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground">{row.original.bankRef}</span>
            {row.original.source === "MANUAL" ? <span className="rounded bg-sky-100 px-1 text-[10px] text-sky-700 dark:bg-sky-950/60 dark:text-sky-300">nhập tay</span> : null}
            {row.original.classifiedBy === "rule" ? <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground">quy tắc</span> : null}
            {row.original.linked ? (
              <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" title={`Đã nối với ${BANK_LINK_TYPE_LABEL[row.original.linkedType as BankLinkType] ?? row.original.linkedType} · ${row.original.linkedId}`}>
                đã đối chiếu
              </span>
            ) : null}
            {/* Nối nhầm là chuyện có thật; không có đường gỡ thì cách sửa duy nhất là xoá một giao dịch tiền THẬT. */}
            {row.original.linked ? <UnlinkButton id={row.original.id} /> : null}
          </div>
        </div>
      ),
    },
    {
      id: "counterparty",
      accessorKey: "counterparty",
      header: "Đối tác",
      cell: ({ row }) => <div className="min-w-[140px] max-w-[220px] truncate text-[13px]">{row.original.counterparty || "—"}</div>,
    },
    {
      id: "amount",
      accessorKey: "amount",
      header: "Tiền vào / ra",
      meta: { align: "right" },
      size: 130,
      cell: ({ row }) => {
        const value = row.original.amount;
        return (
          <span className={cn("numeric whitespace-nowrap font-semibold", value > 0 ? "text-emerald-600" : "text-rose-600")}>
            {formatVND(Math.abs(value))}
          </span>
        );
      },
    },
    {
      id: "accountingGroup",
      accessorKey: "accountingGroup",
      header: "Nhóm kế toán",
      size: 240,
      cell: ({ row }) => (
        <div className="flex items-center gap-1.5">
          <BankGroupSelect id={row.original.id} value={row.original.accountingGroup} canWrite={canWrite} />
          {canWrite ? <RuleFromTxnButton txn={row.original} /> : null}
        </div>
      ),
    },
    {
      id: "note",
      header: "Ghi chú",
      enableSorting: false,
      size: 160,
      cell: ({ row }) => <BankNoteInput id={row.original.id} value={row.original.note} group={row.original.accountingGroup} canWrite={canWrite} />,
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      size: 40,
      cell: ({ row }) => (canWrite && row.original.source === "MANUAL" ? <DeleteManualButton id={row.original.id} /> : null),
    },
  ];
}

function DeleteManualButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={pending}
      title="Xoá giao dịch nhập tay"
      onClick={() =>
        startTransition(async () => {
          const res = await deleteBankTransaction(id);
          if ("error" in res) toast.error(res.error);
          else toast.success("Đã xoá giao dịch");
        })
      }
    >
      ✕
    </Button>
  );
}

export function BankTransactionsTable({ rows, pageCount, total, canWrite }: { rows: BankTxnRow[]; pageCount: number; total: number; canWrite: boolean }) {
  const columns = useMemo(() => buildColumns({ canWrite }), [canWrite]);
  return (
    <DataTable
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      defaultSort="txnAt"
      sortable={["txnAt", "amount", "counterparty", "accountingGroup"]}
      getRowId={(row) => row.id}
      selectable={canWrite}
      bulkActions={(selected, clear) => <BulkActions rows={selected} clear={clear} />}
      emptyTitle="Chưa có giao dịch nào trong kỳ"
      emptyDescription="Vào tab “Nhập sao kê” để tải file CSV/JSON từ ứng dụng ngân hàng, hoặc đổi khoảng thời gian."
    />
  );
}

/**
 * Thao tác hàng loạt: CHỈ gán nhóm.
 *
 * Ở đây từng có nút "đẩy sang bảng Chi phí" tạo khoản chi mới từ dòng tiền. Đã bỏ: nó biến "tiền đã
 * đi ra" thành "chi phí của kỳ chứa ngày trả tiền", trong khi chi phí phải thuộc kỳ hưởng lợi ích —
 * lương tháng 9 trả ngày 05/10 là chi phí tháng 9, không phải tháng 10. Muốn nối tiền với chứng từ
 * thì dùng đối chiếu, không tạo chứng từ mới.
 */
function BulkActions({ rows, clear }: { rows: BankTxnRow[]; clear: () => void }) {
  const [pending, startTransition] = useTransition();
  const ids = rows.map((r) => r.id);

  return (
    <>
      <select
        defaultValue=""
        disabled={pending}
        className="h-8 rounded-md border bg-background px-2 text-xs"
        onChange={(e) => {
          const group = e.target.value;
          if (!group) return;
          e.target.value = "";
          startTransition(async () => {
            const res = await classifyBankTransactions({ ids, group });
            if ("error" in res) toast.error(res.error);
            else {
              toast.success(`Đã gán ${res.updated} giao dịch vào “${BANK_GROUP_SPEC[group as BankGroup].label}”`);
              clear();
            }
          });
        }}
      >
        <option value="">Gán nhóm cho {ids.length} dòng…</option>
        {BANK_GROUP_SECTIONS.map((section) => (
          <optgroup key={section.title} label={section.title}>
            {section.groups.map((g) => (
              <option key={g} value={g}>
                {BANK_GROUP_SPEC[g].label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <span className="text-[11px] text-muted-foreground" title={BANK_NOT_A_COST_NOTE}>
        Gán nhóm không tạo khoản chi nào
      </span>
    </>
  );
}
