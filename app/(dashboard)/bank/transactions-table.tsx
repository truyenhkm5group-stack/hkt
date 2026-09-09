"use client";

import { useMemo, useTransition } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { toast } from "sonner";
import { BankGroupSelect } from "@/app/(dashboard)/bank/group-select";
import { BankNoteInput } from "@/app/(dashboard)/bank/note-input";
import { RuleFromTxnButton } from "@/app/(dashboard)/bank/rule-from-txn";
import { DataTable } from "@/components/data-table/data-table";
import { Button } from "@/components/ui/button";
import { classifyBankTransactions, deleteBankTransaction, postBankToExpenses } from "@/lib/actions/bank";
import { BANK_GROUP_SECTIONS, BANK_GROUP_SPEC, canPostToExpenses, type BankGroup } from "@/lib/constants/bank";
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
            {row.original.posted ? <span className="rounded bg-emerald-100 px-1 text-[10px] text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">đã vào Chi phí</span> : null}
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
 * Thao tác hàng loạt.
 *
 * "Đẩy sang Chi phí" chỉ nhận những dòng mà bảng Chi phí có thẩm quyền. Các dòng còn lại KHÔNG bị
 * bỏ qua im lặng — server trả về lý do và giao diện hiện thẳng, vì "đã bấm mà không thấy gì đổi" là
 * cách nhanh nhất làm người dùng mất tin vào con số.
 */
function BulkActions({ rows, clear }: { rows: BankTxnRow[]; clear: () => void }) {
  const [pending, startTransition] = useTransition();
  const ids = rows.map((r) => r.id);
  const postable = rows.filter((r) => r.amount < 0 && canPostToExpenses(r.accountingGroup as BankGroup) && !r.posted);

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
      <Button
        size="sm"
        variant="outline"
        disabled={pending || !postable.length}
        title={postable.length ? `Tạo ${postable.length} khoản chi ở bảng Chi phí` : "Không dòng nào đủ điều kiện: phải là tiền ra thuộc nhóm chi phí mà bảng Chi phí có thẩm quyền, và chưa đẩy lần nào"}
        onClick={() =>
          startTransition(async () => {
            const res = await postBankToExpenses(ids);
            if ("error" in res) {
              toast.error(res.error);
              return;
            }
            if (res.posted) toast.success(`Đã đưa ${res.posted} khoản vào bảng Chi phí`);
            if (res.blocked.length) toast.warning(res.blocked.join(" "), { duration: 8000 });
            else if (!res.posted) toast.info("Các dòng đã chọn đều đã được đẩy trước đó");
            clear();
          })
        }
      >
        Đẩy {postable.length ? postable.length : ""} khoản sang Chi phí
      </Button>
    </>
  );
}
