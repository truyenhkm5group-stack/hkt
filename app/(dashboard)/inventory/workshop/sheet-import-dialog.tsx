"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, FileSpreadsheet, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { applyWorkshopSheetImport, previewWorkshopSheetImport } from "@/lib/actions/workshop-ledger";
import type { SheetImportPreview } from "@/lib/workshop/sheet-import-db";
import { formatNumber, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

const LINK_KEY = "workshop.sheet-import.link";

const STATUS_LABEL = { NEW: "Sẽ nhập", EXISTS: "Đã có — bỏ qua", CONFLICT: "Lệch ERP — không ghi" } as const;
const STATUS_TONE = {
  NEW: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  EXISTS: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300",
  CONFLICT: "bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
} as const;

function Chip({ s }: { s: keyof typeof STATUS_LABEL }) {
  return <span className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-[10.5px] font-medium", STATUS_TONE[s])}>{STATUS_LABEL[s]}</span>;
}

function Warn({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-0.5 space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
      {items.map((w, i) => (
        <li key={i} className="flex gap-1">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" /> {w}
        </li>
      ))}
    </ul>
  );
}

/** Nhập lô / đợt vải / thanh toán từ bảng tính "BÁO CÁO ĐẶT HÀNG" — xem trước rồi mới ghi. */
export function SheetImportDialog() {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState("");
  const [preview, setPreview] = useState<SheetImportPreview | null>(null);
  const [pending, start] = useNavTransition();
  const router = useRouter();

  const xemTruoc = () =>
    start(async () => {
      try {
        localStorage.setItem(LINK_KEY, link);
      } catch {}
      const r = await previewWorkshopSheetImport(link);
      if ("error" in r) {
        toast.error(r.error);
        setPreview(null);
        return;
      }
      setPreview(r);
    });
  const nhap = () =>
    start(async () => {
      const r = await applyWorkshopSheetImport(link);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã nhập ${r.batches} lô · ${r.deliveries} đợt trả hàng · ${r.fabrics} đợt vải · ${r.payments} đợt thanh toán`);
      setOpen(false);
      setPreview(null);
      router.refresh();
    });

  const moiLo = preview?.batches.filter((b) => b.status === "NEW").length ?? 0;
  const moiVai = preview?.fabrics.filter((f) => f.status === "NEW").length ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setPreview(null);
          try {
            setLink(localStorage.getItem(LINK_KEY) ?? "");
          } catch {}
        }
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <FileSpreadsheet className="size-3.5" /> Nhập từ Google Sheet
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Nhập từ bảng tính “BÁO CÁO ĐẶT HÀNG”</DialogTitle>
          <DialogDescription>
            Đọc hai trang “Thành phẩm” và “Vải” (bảng tính phải mở quyền “Bất kỳ ai có đường liên kết đều xem được”). Xem trước trước khi ghi; nhập lại lần hai không nhân đôi dòng nào. Ô bảng tính không có — xưởng may, nhà vải, đơn vị vải,
            vải dùng cho lô nào, ngày trả tiền thật — để trống hoặc ghi tạm có ghi chú để anh/chị điền.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://docs.google.com/spreadsheets/d/…" />
          <Button onClick={xemTruoc} disabled={pending || !link.trim()} variant="outline">
            {pending && !preview ? <Loader2 className="size-4 animate-spin" /> : null} Xem trước
          </Button>
        </div>

        {preview ? (
          <div className="space-y-4">
            {preview.notices.length || preview.skipped.length ? (
              <Warn items={[...preview.notices, ...preview.skipped.map((s) => `${s.tab} dòng ${s.row}: ${s.reason}`)]} />
            ) : null}
            <div>
              <p className="mb-1 text-sm font-semibold">Trang Thành phẩm → {formatNumber(preview.batches.length)} lô</p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5">Dòng</th>
                      <th className="px-2 py-1.5">Lô</th>
                      <th className="px-2 py-1.5 text-right">Đặt / chốt</th>
                      <th className="px-2 py-1.5 text-right">Đơn giá · thưởng/phạt</th>
                      <th className="px-2 py-1.5">Xưởng trả</th>
                      <th className="px-2 py-1.5 text-right">Đã trả tiền</th>
                      <th className="px-2 py-1.5">Nhập?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.batches.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-2 py-4 text-center text-muted-foreground">
                          Không có dòng nào có mã hàng.
                        </td>
                      </tr>
                    ) : (
                      preview.batches.map((b) => (
                        <tr key={b.row} className="border-t align-top">
                          <td className="px-2 py-1.5 text-muted-foreground">{b.row}</td>
                          <td className="px-2 py-1.5">
                            <b className="font-mono">
                              {b.code} · lô {b.batchNo}
                            </b>
                            <div className="text-[11px] text-muted-foreground">
                              đặt {b.orderedAt.split("-").reverse().join("/")}
                              {b.productMatched ? "" : " · mã chưa khớp sản phẩm"}
                            </div>
                            <Warn items={[...b.warnings, ...(b.reason ? [b.reason] : [])]} />
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {formatNumber(b.orderedQty)} / {b.agreedQty == null ? "—" : formatNumber(b.agreedQty)}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">
                            {formatVND(b.laborUnitPrice)}
                            {b.adjustment ? <div className="text-[11px] text-muted-foreground">{formatVND(b.adjustment, { sign: true })}</div> : null}
                          </td>
                          <td className="px-2 py-1.5">
                            {b.deliveries.map((d) => `${d.date.slice(8)}/${d.date.slice(5, 7)}: ${d.quantity}${d.note ? ` ${d.note}` : ""}`).join(" · ") || "—"}
                            {b.done ? <div className="text-[11px] text-emerald-600 dark:text-emerald-400">đã trả xong</div> : null}
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(b.payments.reduce((t, x) => t + x.amount, 0))}</td>
                          <td className="px-2 py-1.5">
                            <Chip s={b.status} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm font-semibold">Trang Vải → {formatNumber(preview.fabrics.length)} đợt vải</p>
              <div className="overflow-x-auto rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="px-2 py-1.5">Dòng</th>
                      <th className="px-2 py-1.5">Mã · dùng cho lô</th>
                      <th className="px-2 py-1.5">Đặt · về</th>
                      <th className="px-2 py-1.5">Mô tả</th>
                      <th className="px-2 py-1.5 text-right">Thành tiền</th>
                      <th className="px-2 py-1.5 text-right">Đã trả</th>
                      <th className="px-2 py-1.5">Nhập?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.fabrics.length === 0 ? (
                      <tr>
                        <td colSpan={7} className="px-2 py-4 text-center text-muted-foreground">
                          Không có dòng vải nào có mã hàng.
                        </td>
                      </tr>
                    ) : (
                      preview.fabrics.map((f) => (
                        <tr key={f.row} className="border-t align-top">
                          <td className="px-2 py-1.5 text-muted-foreground">{f.row}</td>
                          <td className="px-2 py-1.5">
                            <b className="font-mono">{f.code}</b> · {f.batchLinkable ? `lô ${f.batchNoRef}` : <span className="text-amber-600 dark:text-amber-400">để trống</span>}
                            <Warn items={[...f.warnings, ...(f.reason ? [f.reason] : [])]} />
                          </td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {f.orderedAt.split("-").reverse().join("/")}
                            <div className="text-[11px] text-muted-foreground">{f.receivedAt ? `về ${f.receivedAt.split("-").reverse().join("/")}` : "chưa về"}</div>
                          </td>
                          <td className="px-2 py-1.5">{f.description || "—"}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(f.amount)}</td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{formatVND(f.payments.reduce((t, x) => t + x.amount, 0))}</td>
                          <td className="px-2 py-1.5">
                            <Chip s={f.status} />
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button onClick={nhap} disabled={pending || !preview || moiLo + moiVai === 0}>
            {pending && preview ? <Loader2 className="size-4 animate-spin" /> : null} Nhập {formatNumber(moiLo)} lô · {formatNumber(moiVai)} đợt vải
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
