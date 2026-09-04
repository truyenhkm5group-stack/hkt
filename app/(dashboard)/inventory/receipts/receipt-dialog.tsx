"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ClipboardCheck, Loader2, PackagePlus, Search } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createStockReceipt } from "@/lib/actions/stock";
import { formatNumber, formatVND, todayVN } from "@/lib/format";
import type { VariantPickerRow } from "@/lib/queries/stock";
import { STOCK_RECEIPT_KIND_LABEL, STOCK_RECEIPT_KINDS, type StockReceiptKind } from "@/lib/validation/stock";
import { cn } from "@/lib/utils";

type RowInput = { qty: string; cost: string; counted: string };

function toInt(value: string) {
  const n = Number(String(value).replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Dialog lập phiếu nhập hàng hoặc điều chỉnh kiểm kê cho nhiều mẫu mã cùng lúc */
export function ReceiptDialog({ variants, defaultKind = "RECEIPT" }: { variants: VariantPickerRow[]; defaultKind?: StockReceiptKind }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StockReceiptKind>(defaultKind);
  const [receivedAt, setReceivedAt] = useState(todayVN());
  const [reference, setReference] = useState("");
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [search, setSearch] = useState("");
  const [onlySelling, setOnlySelling] = useState(true);
  const [inputs, setInputs] = useState<Record<string, RowInput>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return variants.filter((v) => (!onlySelling || v.selling) && (!term || `${v.productName} ${v.sku} ${v.color} ${v.size}`.toLowerCase().includes(term)));
  }, [variants, search, onlySelling]);

  const setField = (id: string, field: keyof RowInput, value: string) => setInputs((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { qty: "", cost: "", counted: "" }), [field]: value } }));

  const items = useMemo(() => {
    const list: { variantId: string; quantity: number; unitCost: number; name: string }[] = [];
    for (const v of variants) {
      const input = inputs[v.id];
      if (!input) continue;
      const unitCost = input.cost === "" ? v.lastCost : toInt(input.cost);
      if (kind === "RECEIPT") {
        const quantity = toInt(input.qty);
        if (quantity > 0) list.push({ variantId: v.id, quantity, unitCost, name: `${v.sku || v.productName}` });
      } else if (input.counted !== "") {
        const quantity = toInt(input.counted) - v.currentStock;
        if (quantity !== 0) list.push({ variantId: v.id, quantity, unitCost: 0, name: `${v.sku || v.productName}` });
      }
    }
    return list;
  }, [variants, inputs, kind]);

  const totalQty = items.reduce((s, i) => s + i.quantity, 0);
  const totalCost = items.reduce((s, i) => s + Math.max(i.quantity, 0) * i.unitCost, 0);

  const reset = () => {
    setInputs({});
    setReference("");
    setSupplier("");
    setNote("");
    setSearch("");
    setReceivedAt(todayVN());
  };

  const submit = () => {
    if (!items.length) {
      toast.error(kind === "RECEIPT" ? "Nhập số lượng cho ít nhất một mẫu mã" : "Nhập số đếm thực tế khác với tồn hiện tại cho ít nhất một mẫu mã");
      return;
    }
    startTransition(async () => {
      const result = await createStockReceipt({ kind, receivedAt, reference, supplier, note, items: items.map(({ variantId, quantity, unitCost }) => ({ variantId, quantity, unitCost })) });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(kind === "RECEIPT" ? `Đã nhập ${formatNumber(totalQty)} sản phẩm (${items.length} mẫu mã)` : `Đã điều chỉnh ${items.length} mẫu mã`);
      setOpen(false);
      reset();
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setKind(defaultKind);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant={defaultKind === "RECEIPT" ? "default" : "outline"}>
          {defaultKind === "RECEIPT" ? <PackagePlus className="size-4" /> : <ClipboardCheck className="size-4" />}
          {defaultKind === "RECEIPT" ? "Nhập hàng" : "Kiểm kê"}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{STOCK_RECEIPT_KIND_LABEL[kind]}</DialogTitle>
          <DialogDescription>
            {kind === "RECEIPT" ? "Nhập số lượng hàng về kho cho từng mẫu mã. Giá nhập > 0 sẽ được dùng làm giá vốn gần nhất." : "Nhập số đếm thực tế trong kho; ERP tự tạo phiếu điều chỉnh (+/−) để tồn khả dụng bằng số đếm."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 border-b px-5 py-3 sm:grid-cols-4">
          <div className="space-y-1">
            <Label>Loại phiếu</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as StockReceiptKind)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STOCK_RECEIPT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {STOCK_RECEIPT_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label>Ngày</Label>
            <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>{kind === "RECEIPT" ? "Nhà cung cấp" : "Người kiểm"}</Label>
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={kind === "RECEIPT" ? "Xưởng / chợ / NCC" : "Tên người kiểm kê"} />
          </div>
          <div className="space-y-1">
            <Label>Tham chiếu</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Số hoá đơn, mã lô…" />
          </div>
          <div className="space-y-1 sm:col-span-4">
            <Textarea rows={1} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (tuỳ chọn)" />
          </div>
        </div>

        <div className="flex items-center gap-2 border-b px-5 py-2">
          <div className="relative flex-1">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Lọc theo tên, SKU, màu, size…" className="pl-8" />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlySelling} onChange={(e) => setOnlySelling(e.target.checked)} /> Chỉ mẫu mã đang bán
          </label>
          <span className="text-xs text-muted-foreground">{visible.length} mẫu mã</span>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/80 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase backdrop-blur">
              <tr>
                <th className="px-5 py-2 text-left">Mẫu mã</th>
                <th className="px-3 py-2 text-right">Tồn hiện tại</th>
                {kind === "RECEIPT" ? (
                  <>
                    <th className="w-28 px-3 py-2 text-right">Số lượng nhập</th>
                    <th className="w-36 px-3 py-2 text-right">Giá nhập (₫)</th>
                    <th className="px-3 py-2 text-right">Tồn sau nhập</th>
                  </>
                ) : (
                  <>
                    <th className="w-32 px-3 py-2 text-right">Đếm thực tế</th>
                    <th className="px-3 py-2 text-right">Chênh lệch</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => {
                const input = inputs[v.id] ?? { qty: "", cost: "", counted: "" };
                const qty = toInt(input.qty);
                const counted = input.counted === "" ? null : toInt(input.counted);
                const diff = counted === null ? 0 : counted - v.currentStock;
                return (
                  <tr key={v.id} className={cn("border-b last:border-0", (kind === "RECEIPT" ? qty > 0 : counted !== null && diff !== 0) && "bg-primary/5")}>
                    <td className="px-5 py-1.5">
                      <div className="flex items-center gap-2.5">
                        {v.image ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.image} alt="" className="size-8 shrink-0 rounded border object-cover" loading="lazy" />
                        ) : (
                          <div className="size-8 shrink-0 rounded border bg-muted" />
                        )}
                        <div className="min-w-0">
                          <div className="truncate font-medium">
                            {v.productName}
                            {!v.selling ? <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">ẩn</span> : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            <span className="font-mono">{v.sku || "—"}</span>
                            {v.color || v.size ? ` · ${[v.color, v.size].filter(Boolean).join(" / ")}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={cn("numeric px-3 py-1.5 text-right font-semibold", v.currentStock <= 0 ? "text-destructive" : v.currentStock <= 5 ? "text-amber-600" : "")}>{formatNumber(v.currentStock)}</td>
                    {kind === "RECEIPT" ? (
                      <>
                        <td className="px-3 py-1.5">
                          <Input type="number" inputMode="numeric" min={0} className="numeric h-8 text-right" placeholder="0" value={input.qty} onChange={(e) => setField(v.id, "qty", e.target.value)} />
                        </td>
                        <td className="px-3 py-1.5">
                          <Input type="number" inputMode="numeric" min={0} step={1000} className="numeric h-8 text-right" placeholder={String(v.lastCost || 0)} value={input.cost} onChange={(e) => setField(v.id, "cost", e.target.value)} />
                        </td>
                        <td className="numeric px-3 py-1.5 text-right text-muted-foreground">{qty > 0 ? <span className="font-semibold text-foreground">{formatNumber(v.currentStock + qty)}</span> : "—"}</td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-1.5">
                          <Input type="number" inputMode="numeric" min={0} className="numeric h-8 text-right" placeholder={String(Math.max(v.currentStock, 0))} value={input.counted} onChange={(e) => setField(v.id, "counted", e.target.value)} />
                        </td>
                        <td className={cn("numeric px-3 py-1.5 text-right font-semibold", diff > 0 ? "text-emerald-600" : diff < 0 ? "text-rose-600" : "text-muted-foreground")}>{counted === null ? "—" : `${diff > 0 ? "+" : ""}${formatNumber(diff)}`}</td>
                      </>
                    )}
                  </tr>
                );
              })}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-sm text-muted-foreground">
                    Không có mẫu mã phù hợp. Nếu danh sách trống, hãy đồng bộ sản phẩm từ Pancake trước.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <DialogFooter className="items-center gap-3 border-t px-5 py-3 sm:justify-between">
          <div className="text-sm text-muted-foreground">
            {items.length ? (
              <>
                <b className="text-foreground">{items.length}</b> mẫu mã · <b className={cn("numeric", totalQty < 0 ? "text-rose-600" : "text-foreground")}>{totalQty > 0 ? "+" : ""}{formatNumber(totalQty)}</b> sản phẩm
                {kind === "RECEIPT" && totalCost ? <> · giá trị <b className="text-foreground">{formatVND(totalCost)}</b></> : null}
              </>
            ) : (
              "Chưa nhập số lượng"
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button type="button" onClick={submit} disabled={pending || !items.length}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              {kind === "RECEIPT" ? "Lưu phiếu nhập" : "Lưu điều chỉnh"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
