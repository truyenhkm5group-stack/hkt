"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AdSpendDialog } from "@/app/(dashboard)/expenses/ad-spend-dialog";
import { ExpenseDialog } from "@/app/(dashboard)/expenses/expense-dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { deleteAdSpend, deleteExpense, type ActionResult } from "@/lib/actions/expenses";
import { formatDate, formatVND } from "@/lib/format";
import type { AdSpendRow, ExpenseRow } from "@/lib/queries/expenses";

function ActionMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="Thao tác" data-no-row-link>
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onSelect={onEdit}>
          <Pencil className="size-4" /> Sửa
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive">
          <Trash2 className="size-4" /> Xoá
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteConfirm({ open, onOpenChange, title, description, action, successMessage }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: React.ReactNode; action: () => Promise<ActionResult>; successMessage: string }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const confirm = () => {
    startTransition(async () => {
      const result = await action();
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(successMessage);
      onOpenChange(false);
      router.refresh();
    });
  };
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            className="bg-destructive text-white hover:bg-destructive/90"
            onClick={(e) => {
              e.preventDefault();
              confirm();
            }}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Xoá
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ExpenseRowActions({ row }: { row: ExpenseRow }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <ActionMenu onEdit={() => setEditOpen(true)} onDelete={() => setDeleteOpen(true)} />
      <ExpenseDialog expense={row} open={editOpen} onOpenChange={setEditOpen} />
      <DeleteConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Xoá khoản chi phí?"
        description={
          <>
            Sẽ xoá <strong>{row.description}</strong> ({formatVND(row.amount)}, ngày {formatDate(row.occurredAt)}). Hành động này không thể hoàn tác.
          </>
        }
        action={() => deleteExpense(row.id)}
        successMessage="Đã xoá chi phí"
      />
    </>
  );
}

export function AdSpendRowActions({ row }: { row: AdSpendRow }) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <ActionMenu onEdit={() => setEditOpen(true)} onDelete={() => setDeleteOpen(true)} />
      <AdSpendDialog ad={row} open={editOpen} onOpenChange={setEditOpen} />
      <DeleteConfirm
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Xoá dòng chi tiêu quảng cáo?"
        description={
          <>
            Sẽ xoá chi tiêu <strong>{row.platform}</strong>
            {row.campaign ? ` · ${row.campaign}` : ""} ({formatVND(row.spend)}, ngày {formatDate(row.spendDate)}). Hành động này không thể hoàn tác.
          </>
        }
        action={() => deleteAdSpend(row.id)}
        successMessage="Đã xoá chi tiêu quảng cáo"
      />
    </>
  );
}
