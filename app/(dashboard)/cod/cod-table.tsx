"use client";

import { useCallback, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Banknote, CheckCheck, Loader2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { COD_ACTION_LABEL, codColumns, type CodActionType } from "@/app/(dashboard)/cod/columns";
import { DataTable } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { markCodDisputed, markCodPaidToBank, markCodReconciled, revertCodToCollected, type CodActionResult } from "@/lib/actions/cod";
import { formatNumber, todayVN } from "@/lib/format";
import type { CodListRow } from "@/lib/queries/cod";

type PendingAction = { type: CodActionType; rows: CodListRow[]; clear?: () => void };

export function CodTable({ rows, pageCount, total, canWrite }: { rows: CodListRow[]; pageCount: number; total: number; canWrite: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [dialog, setDialog] = useState<PendingAction | null>(null);

  const finish = useCallback(
    (result: CodActionResult, clear?: () => void) => {
      if ("error" in result) {
        toast.error(result.error);
        return false;
      }
      toast.success(result.message ?? `Đã cập nhật ${result.count} vận đơn`);
      clear?.();
      router.refresh();
      return true;
    },
    [router],
  );

  const runSimple = useCallback(
    (type: "RECONCILED" | "COLLECTED", selected: CodListRow[], clear?: () => void) => {
      const ids = selected.map((r) => r.id);
      startTransition(async () => {
        const result = type === "RECONCILED" ? await markCodReconciled({ ids }) : await revertCodToCollected({ ids });
        finish(result, clear);
      });
    },
    [finish],
  );

  const onAction = useCallback(
    (type: CodActionType, selected: CodListRow[], clear?: () => void) => {
      if (type === "PAID" || type === "DISPUTED") setDialog({ type, rows: selected, clear });
      else runSimple(type, selected, clear);
    },
    [runSimple],
  );

  const columns = useMemo(() => codColumns({ canWrite, onAction: (type, row) => onAction(type, [row]) }), [canWrite, onAction]);

  return (
    <>
      <DataTable
        defaultSort="deliveredAt"
        columns={columns}
        data={rows}
        pageCount={pageCount}
        total={total}
        rowHref={(row) => `/shipments/${row.id}`}
        getRowId={(row) => row.id}
        selectable={canWrite}
        bulkActions={
          canWrite
            ? (selected, clear) => (
                <>
                  <Button variant="outline" size="sm" className="h-7 bg-background" disabled={pending} onClick={() => onAction("RECONCILED", selected, clear)}>
                    {pending ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCheck className="size-3.5" />} {COD_ACTION_LABEL.RECONCILED}
                  </Button>
                  <Button variant="default" size="sm" className="h-7" disabled={pending} onClick={() => onAction("PAID", selected, clear)}>
                    <Banknote className="size-3.5" /> {COD_ACTION_LABEL.PAID}
                  </Button>
                  <Button variant="outline" size="sm" className="h-7 bg-background" disabled={pending} onClick={() => onAction("DISPUTED", selected, clear)}>
                    <AlertTriangle className="size-3.5" /> {COD_ACTION_LABEL.DISPUTED}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7" disabled={pending} onClick={() => onAction("COLLECTED", selected, clear)}>
                    <Undo2 className="size-3.5" /> {COD_ACTION_LABEL.COLLECTED}
                  </Button>
                </>
              )
            : undefined
        }
        emptyTitle="Không có vận đơn"
        emptyDescription="Thử đổi tab trạng thái, khoảng thời gian hoặc bộ lọc."
      />
      <PaidToBankDialog action={dialog?.type === "PAID" ? dialog : null} onClose={() => setDialog(null)} onDone={finish} />
      <DisputeDialog action={dialog?.type === "DISPUTED" ? dialog : null} onClose={() => setDialog(null)} onDone={finish} />
    </>
  );
}

function selectionSummary(rows: CodListRow[]) {
  const amount = rows.reduce((sum, r) => sum + (r.codCollected || r.codAmount), 0);
  return { count: rows.length, amount };
}

function PaidToBankDialog({ action, onClose, onDone }: { action: PendingAction | null; onClose: () => void; onDone: (result: CodActionResult, clear?: () => void) => boolean }) {
  const [pending, startTransition] = useTransition();
  const [reference, setReference] = useState("");
  const [receivedAt, setReceivedAt] = useState(todayVN());
  const [note, setNote] = useState("");
  const summary = selectionSummary(action?.rows ?? []);
  const eligible = (action?.rows ?? []).filter((r) => r.codStatus !== "PAID_TO_BANK" && r.codStatus !== "NOT_APPLICABLE");

  const submit = () => {
    if (!action) return;
    startTransition(async () => {
      const result = await markCodPaidToBank({ ids: action.rows.map((r) => r.id), reference, receivedAt, note });
      if (onDone(result, action.clear)) {
        setReference("");
        setNote("");
        onClose();
      }
    });
  };

  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Đánh dấu đã về ngân hàng</DialogTitle>
          <DialogDescription>
            Tạo đợt nhận tiền cho {formatNumber(summary.count)} vận đơn · tổng <Money value={summary.amount} className="font-semibold text-foreground" />
            {eligible.length !== summary.count ? ` · ${summary.count - eligible.length} vận đơn đã về ngân hàng/không thu hộ sẽ được bỏ qua` : ""}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="cod-reference">Mã bảng kê / tham chiếu</Label>
            <Input id="cod-reference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="VD: VTP-BK-2026-09-03" required autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cod-received">Ngày tiền về tài khoản</Label>
            <Input id="cod-received" type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cod-note">Ghi chú</Label>
            <Textarea id="cod-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Số tiền thực nhận, ngân hàng, chênh lệch phí…" rows={3} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Huỷ
            </Button>
            <Button type="submit" disabled={pending || !reference.trim() || !eligible.length}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Banknote className="size-4" />}
              Xác nhận {formatNumber(eligible.length)} vận đơn
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DisputeDialog({ action, onClose, onDone }: { action: PendingAction | null; onClose: () => void; onDone: (result: CodActionResult, clear?: () => void) => boolean }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const count = action?.rows.length ?? 0;
  const submit = () => {
    if (!action) return;
    startTransition(async () => {
      const result = await markCodDisputed({ ids: action.rows.map((r) => r.id), note });
      if (onDone(result, action.clear)) {
        setNote("");
        onClose();
      }
    });
  };
  return (
    <Dialog open={Boolean(action)} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Đánh dấu có chênh lệch</DialogTitle>
          <DialogDescription>{formatNumber(count)} vận đơn sẽ chuyển sang trạng thái “Có chênh lệch” để đối chiếu lại với ĐVVC. Ghi chú được lưu vào nhật ký hệ thống.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="dispute-note">Lý do / ghi chú</Label>
            <Textarea id="dispute-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: ĐVVC báo thu 350.000 nhưng COD là 390.000" rows={3} autoFocus />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Huỷ
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <AlertTriangle className="size-4" />}
              Đánh dấu chênh lệch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
