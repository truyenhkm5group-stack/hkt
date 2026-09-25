"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Factory, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createSupplierPaymentFromBank, linkBankToSupplierPayment, supplierLinkOptions } from "@/lib/actions/workshop-ledger";
import { formatDate, formatVND } from "@/lib/format";
import type { SupplierLinkCandidates } from "@/lib/queries/workshop-ledger";
import { cn } from "@/lib/utils";

/**
 * GHÉP MỘT DÒNG TIỀN RA VỚI THANH TOÁN XƯỞNG MAY / NHÀ VẢI (Sổ đặt xưởng).
 *
 * Hai lối, theo thứ tự nên thử: (1) ghép vào một đợt thanh toán ĐÃ GHI (vd đợt nhập từ bảng tính mang
 * ngày tạm — ghép trọn thì ngày thật của sao kê thay vào); (2) chưa có đợt nào ⇒ tạo đợt mới cho một lô
 * / đợt vải còn nợ, bằng đúng phần chưa nối của dòng tiền. Cả hai là ĐỐI CHIẾU, không tạo chi phí.
 */
export function SupplierLinkDialog({ txnId }: { txnId: string }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SupplierLinkCandidates | null>(null);
  const [target, setTarget] = useState("");
  const [kind, setKind] = useState<"PAYMENT" | "DEPOSIT">("PAYMENT");
  const [pending, start] = useNavTransition();
  const router = useRouter();

  const load = () =>
    start(async () => {
      const r = await supplierLinkOptions(txnId);
      if ("error" in r) {
        toast.error(r.error);
        setOpen(false);
        return;
      }
      setData(r);
      setTarget("");
    });
  const done = (msg: string) => {
    toast.success(msg);
    setOpen(false);
    router.refresh();
  };
  const ghep = (paymentId: string) =>
    start(async () => {
      const r = await linkBankToSupplierPayment({ txnId, paymentId });
      if ("error" in r) toast.error(r.error);
      else done(`Đã ghép ${formatVND(r.amount)} vào đợt thanh toán`);
    });
  const taoMoi = () =>
    start(async () => {
      const [loai, id] = target.split(":");
      const r = await createSupplierPaymentFromBank({ txnId, batchId: loai === "BATCH" ? id : null, fabricOrderId: loai === "FABRIC" ? id : null, kind });
      if ("error" in r) toast.error(r.error);
      else done(`Đã tạo đợt thanh toán ${formatVND(r.amount)} và ghép với sao kê`);
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) load();
        else setData(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10.5px]" title="Ghép với thanh toán xưởng may / nhà vải ở Sổ đặt xưởng">
          <Factory className="size-3" /> Ghép xưởng/vải
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ghép với thanh toán xưởng may / nhà vải</DialogTitle>
          <DialogDescription>Đối chiếu “đồng tiền này trả cho đợt nào” ở Sổ đặt xưởng — không tạo khoản chi phí nào. Giá vốn vẫn đi theo phiếu nhập kho.</DialogDescription>
        </DialogHeader>
        {!data ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang tải…
          </div>
        ) : (
          <div className="space-y-5 text-sm">
            <div className="rounded-lg border bg-muted/40 px-3 py-2">
              <b className="tabular-nums">{formatVND(data.txn.amount)}</b> ra ngày {formatDate(data.txn.txnAt)} · <span className="font-mono text-xs">{data.txn.bankRef}</span>
              {data.txn.remaining !== data.txn.amount ? <span className="text-muted-foreground"> · còn {formatVND(data.txn.remaining)} chưa nối</span> : null}
              <div className="truncate text-xs text-muted-foreground" title={data.txn.description}>
                {data.txn.description}
              </div>
            </div>

            <div>
              <p className="mb-1.5 font-semibold">1 · Ghép vào đợt thanh toán đã ghi</p>
              {data.payments.length === 0 ? (
                <p className="text-xs text-muted-foreground">Không có đợt thanh toán nào đang chờ đối chiếu sao kê.</p>
              ) : (
                <div className="overflow-x-auto rounded-lg border">
                  <table className="w-full text-xs">
                    <tbody>
                      {data.payments.map((p) => (
                        <tr key={p.id} className={cn("border-t first:border-t-0", p.exact && "bg-emerald-50/60 dark:bg-emerald-950/20")}>
                          <td className="px-2 py-1.5">
                            {p.label}
                            <div className="text-[11px] text-muted-foreground">
                              ghi ngày {formatDate(p.paidAt)}
                              {p.exact ? " · khớp đúng số tiền" : ""}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">
                            {formatVND(p.open)}
                            {p.open !== p.amount ? <div className="text-[11px] text-muted-foreground">/ {formatVND(p.amount)}</div> : null}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <Button size="sm" variant={p.exact ? "default" : "outline"} disabled={pending || data.txn.remaining <= 0} onClick={() => ghep(p.id)}>
                              Ghép
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <p className="mb-1.5 font-semibold">2 · Hoặc tạo đợt thanh toán mới ({formatVND(data.txn.remaining)}) cho</p>
              {data.targets.length === 0 ? (
                <p className="text-xs text-muted-foreground">Không có lô / đợt vải nào còn nợ.</p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <Select value={target} onValueChange={setTarget}>
                    <SelectTrigger className="min-w-[320px] flex-1">
                      <SelectValue placeholder="Chọn lô / đợt vải còn nợ" />
                    </SelectTrigger>
                    <SelectContent>
                      {data.targets.map((t) => (
                        <SelectItem key={`${t.kind}:${t.id}`} value={`${t.kind}:${t.id}`}>
                          {t.label} · còn {t.remaining == null ? "chưa biết" : formatVND(t.remaining)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select value={kind} onValueChange={(v) => setKind(v as "PAYMENT" | "DEPOSIT")}>
                    <SelectTrigger className="w-[140px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PAYMENT">Thanh toán</SelectItem>
                      <SelectItem value="DEPOSIT">Đặt cọc</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button disabled={pending || !target || data.txn.remaining <= 0} onClick={taoMoi}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : null} Tạo & ghép
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
