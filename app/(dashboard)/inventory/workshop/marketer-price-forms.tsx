"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Tag, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deleteMarketerPrice, setMarketerPrice } from "@/lib/actions/marketer-price";
import { MARKETER_PRICE_EFFECTIVE_FROM } from "@/lib/constants/marketer-price";
import { formatVND, todayVN } from "@/lib/format";

/** Đặt giá báo MKT cho một mã, hoặc hạ giá từ một ngày (xả tồn cuối vòng đời). Mỗi lần là một dòng mới. */
export function MarketerPriceDialog({ products, defaultCode = "" }: { products: { code: string; name: string }[]; defaultCode?: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useNavTransition();
  const router = useRouter();
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
      router.refresh();
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
            {MARKETER_PRICE_EFFECTIVE_FROM.split("-").reverse().join("/")}, chỉ ở phần của MKT (lợi nhuận danh nghĩa theo MKT và lương).
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
  const router = useRouter();
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
            router.refresh();
          }
        });
      }}
    >
      <Trash2 className="size-3" />
    </Button>
  );
}
