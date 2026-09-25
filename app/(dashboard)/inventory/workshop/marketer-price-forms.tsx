"use client";

import { useState } from "react";
import { Loader2, PackageCheck, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { applyReceiptRepricingAction, deleteMarketerPrice, previewReceiptRepricing, setMarketerPrice, type ReceiptRepricingPreview } from "@/lib/actions/marketer-price";
import { MARKETER_PRICE_EFFECTIVE_FROM } from "@/lib/constants/marketer-price";
import { formatNumber, formatVND, todayVN } from "@/lib/format";

/** Đặt giá báo MKT cho một mã, hoặc hạ giá từ một ngày (xả tồn cuối vòng đời). Mỗi lần là một dòng mới. */
export function MarketerPriceDialog({ products, defaultCode = "" }: { products: { code: string; name: string }[]; defaultCode?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useNavTransition();
  const init = () => ({ productCode: defaultCode, price: "", effectiveFrom: defaultCode ? todayVN() : MARKETER_PRICE_EFFECTIVE_FROM, reason: "" });
  const [f, setF] = useState(init);
  const price = f.price === "" ? null : Number(f.price);
  const submit = () =>
    start(async () => {
      const r = await setMarketerPrice({ ...f, price });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu giá báo MKT");
      setOpen(false);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setF(init());
      }}
    >
      <DialogTrigger asChild>
        {defaultCode ? (
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs">
            Đổi giá
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Tag className="size-3.5" /> Đặt / đổi giá báo
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Giá báo MKT</DialogTitle>
          <DialogDescription>
            Một giá cho mỗi mã; muốn hạ giá để xả tồn thì thêm một dòng mới với ngày hiệu lực — đơn lên từ ngày đó dùng giá mới, đơn cũ giữ giá cũ. Áp cho đơn từ{" "}
            {MARKETER_PRICE_EFFECTIVE_FROM.split("-").reverse().join("/")}, ở phần của MKT (lợi nhuận danh nghĩa theo MKT và lương) — và từ 25/09/2026 là giá nhập kho của phiếu nhập hàng mới.
          </DialogDescription>
        </DialogHeader>
        <datalist id="mkt-price-products">
          {products.map((p, i) => (
            <option key={`${p.code}-${i}`} value={p.code}>
              {p.name}
            </option>
          ))}
        </datalist>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs">Mã hàng *</Label>
            <Input list="mkt-price-products" value={f.productCode} disabled={!!defaultCode} onChange={(e) => setF({ ...f, productCode: e.target.value })} placeholder="Q002" />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Giá báo (đ/chiếc) *</Label>
            <Input inputMode="numeric" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value.replace(/[^\d]/g, "") })} autoFocus />
            {price != null ? <p className="text-[11px] text-muted-foreground">{formatVND(price)}</p> : null}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Hiệu lực từ ngày *</Label>
            <Input type="date" value={f.effectiveFrom} onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Lý do</Label>
            <Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Giá chốt đầu vụ · hạ để xả tồn…" />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || !f.productCode.trim() || price == null || !f.effectiveFrom}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteMarketerPriceButton({ id, label }: { id: string; label: string }) {
  const [pending, start] = useNavTransition();
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-6 text-muted-foreground hover:text-destructive"
      title={`Xoá dòng giá ${label}`}
      disabled={pending}
      onClick={() => {
        if (!confirm(`Xoá dòng giá ${label}? Đơn trong khoảng hiệu lực của nó sẽ dùng dòng giá trước đó (hoặc giá vốn thật nếu không còn dòng nào).`)) return;
        start(async () => {
          const r = await deleteMarketerPrice(id);
          if ("error" in r) toast.error(r.error);
          else {
            toast.success("Đã xoá dòng giá");
          }
        });
      }}
    >
      <Trash2 className="size-3" />
    </Button>
  );
}

/**
 * Phiếu nhập CŨ ghi giá 0 → định giá theo giá báo MKT (chủ shop chốt 25/09/2026). Mở ra là XEM TRƯỚC
 * (chỉ đọc); ghi chỉ khi bấm xác nhận, và máy chủ từ chối nếu số dòng đã đổi so với lúc xem.
 * Dòng đã có giá thật không bao giờ bị ghi đè.
 */
export function ReceiptRepricingDialog() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<ReceiptRepricingPreview | null>(null);
  const [pending, start] = useNavTransition();
  const load = async () => {
    setLoading(true);
    setPreview(null);
    const r = await previewReceiptRepricing();
    setLoading(false);
    if ("error" in r) {
      toast.error(r.error);
      setOpen(false);
      return;
    }
    setPreview(r.preview);
  };
  const apply = () =>
    start(async () => {
      if (!preview) return;
      const r = await applyReceiptRepricingAction(preview.priced.lines);
      if ("error" in r) {
        toast.error(r.error);
        void load();
        return;
      }
      toast.success(`Đã định giá ${formatNumber(r.lines)} dòng trên ${formatNumber(r.receipts)} phiếu nhập theo giá báo MKT`);
      setOpen(false);
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) void load();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <PackageCheck className="size-3.5" /> Định giá phiếu nhập
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Định giá phiếu nhập theo giá báo MKT</DialogTitle>
          <DialogDescription>
            Lấp giá cho các dòng phiếu NHẬP HÀNG đang ghi giá 0, bằng giá báo MKT của mã vào ngày nhập. Dòng đã có giá không bị đổi. Giá vốn trong mọi báo cáo (lợi
            nhuận, tồn kho, lương) đọc từ phiếu kho nên sẽ đổi theo; kỳ lương đã khoá giữ nguyên ảnh chụp.
          </DialogDescription>
        </DialogHeader>
        {loading || !preview ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Đang đọc phiếu nhập…
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <p>
              Sẽ định giá <b>{formatNumber(preview.priced.lines)}</b> dòng · <b>{formatNumber(preview.priced.quantity)}</b> sp trên <b>{formatNumber(preview.priced.receipts)}</b> phiếu —
              tổng <b>{formatVND(preview.priced.amount)}</b>.
            </p>
            {preview.byCode.length ? (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-2 py-1.5 text-left">Mã</th>
                      <th className="px-2 py-1.5 text-right">Số sp</th>
                      <th className="px-2 py-1.5 text-right">Giá báo</th>
                      <th className="px-2 py-1.5 text-right">Thành tiền</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.byCode.map((g) => (
                      <tr key={`${g.code}-${g.price ?? "?"}`} className="border-t">
                        <td className="px-2 py-1 font-mono">{g.code}</td>
                        <td className="numeric px-2 py-1 text-right">{formatNumber(g.quantity)}</td>
                        <td className="numeric px-2 py-1 text-right">{g.price != null ? formatVND(g.price) : <span className="text-amber-700 dark:text-amber-400">chưa có giá báo</span>}</td>
                        <td className="numeric px-2 py-1 text-right">{g.price != null ? formatVND(g.amount) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted-foreground">Không có dòng phiếu nhập nào đang thiếu giá.</p>
            )}
            {preview.missing.lines ? (
              <p className="text-[12px] text-amber-700 dark:text-amber-400">
                {formatNumber(preview.missing.lines)} dòng ({formatNumber(preview.missing.quantity)} sp) của {preview.missing.codes.join(", ")} vẫn để trống vì mã chưa có giá báo — đặt giá báo rồi bấm lại.
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Đóng
          </Button>
          <Button onClick={apply} disabled={pending || loading || !preview?.priced.lines}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Định giá {preview?.priced.lines ? `${formatNumber(preview.priced.lines)} dòng` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
