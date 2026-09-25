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
import { formatNumber, todayVN } from "@/lib/format";
import type { ProductionLinkOption, VariantPickerRow } from "@/lib/queries/stock";
import { STOCK_RECEIPT_KIND_HINT, STOCK_RECEIPT_KIND_LABEL, STOCK_RECEIPT_KINDS, type StockReceiptKind } from "@/lib/validation/stock";
import { STICKY_HEAD } from "@/lib/constants/table-ux";
import { cn } from "@/lib/utils";

type RowInput = { qty: string; counted: string };

function toInt(value: string) {
  const n = Number(String(value).replace(/[^\d-]/g, ""));
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** Dialog lập phiếu kho (nhập mới / tái nhập hàng hoàn / xuất tay / điều chỉnh kiểm kê) cho nhiều mẫu mã cùng lúc */
export function ReceiptDialog({
  variants,
  defaultKind = "RECEIPT",
  pendingReturns = {},
  supplierOptions = [],
  productionLinks = [],
  pricedProductIds,
}: {
  variants: VariantPickerRow[];
  defaultKind?: StockReceiptKind;
  pendingReturns?: Record<string, number>;
  /** Tên xưởng trong danh mục — chỉ là GỢI Ý. */
  supplierOptions?: string[];
  /** Lệnh SX đã gửi + lô xưởng đang mở — để NGƯỜI chọn phiếu nhập này là hàng của lần đặt nào (0133). */
  productionLinks?: ProductionLinkOption[];
  /**
   * Sản phẩm đã có giá báo MKT. Kho KHÔNG nhập giá (chủ shop chốt 25/09/2026): máy chủ lấy giá báo theo
   * ngày nhập. Danh sách này chỉ để báo TRƯỚC mã nào sẽ lưu với giá "chưa biết".
   */
  pricedProductIds?: string[];
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<StockReceiptKind>(defaultKind);
  const [receivedAt, setReceivedAt] = useState(todayVN());
  const [reference, setReference] = useState("");
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [productionOrderId, setProductionOrderId] = useState("");
  const [productionBatchId, setProductionBatchId] = useState("");
  const [search, setSearch] = useState("");
  const [onlySelling, setOnlySelling] = useState(true);
  const [inputs, setInputs] = useState<Record<string, RowInput>>({});
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const coGiaBao = useMemo(() => (pricedProductIds ? new Set(pricedProductIds) : null), [pricedProductIds]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return variants.filter((v) => (!onlySelling || v.selling) && (!term || `${v.productName} ${v.sku} ${v.color} ${v.size}`.toLowerCase().includes(term)));
  }, [variants, search, onlySelling]);

  const setField = (id: string, field: keyof RowInput, value: string) => setInputs((prev) => ({ ...prev, [id]: { ...(prev[id] ?? { qty: "", counted: "" }), [field]: value } }));

  const items = useMemo(() => {
    const list: { variantId: string; productId: string; quantity: number }[] = [];
    for (const v of variants) {
      const input = inputs[v.id];
      if (!input) continue;
      if (kind !== "ADJUSTMENT") {
        const quantity = toInt(input.qty);
        if (quantity > 0) list.push({ variantId: v.id, productId: v.productId, quantity });
      } else if (input.counted !== "") {
        const quantity = toInt(input.counted) - v.currentStock;
        if (quantity !== 0) list.push({ variantId: v.id, productId: v.productId, quantity });
      }
    }
    return list;
  }, [variants, inputs, kind]);
  // Mẫu mã trên phiếu NHẬP mà sản phẩm chưa có giá báo ⇒ sẽ lưu với giá chưa biết.
  const chuaCoGia = kind === "RECEIPT" && coGiaBao ? items.filter((i) => !coGiaBao.has(i.productId)).length : 0;

  // Đã gõ tên xưởng ⇒ chỉ hiện lệnh / lô của ĐÚNG xưởng đó (so tên đã chuẩn hoá); chưa gõ ⇒ tất cả.
  const linkOptions = useMemo(() => {
    const key = supplier.trim().toLowerCase();
    return key ? productionLinks.filter((l) => l.supplier.trim().toLowerCase() === key) : productionLinks;
  }, [productionLinks, supplier]);
  const orderOptions = linkOptions.filter((l) => l.kind === "ORDER");
  const batchOptions = linkOptions.filter((l) => l.kind === "BATCH");
  // Đổi tên xưởng làm lựa chọn cũ rơi khỏi danh sách ⇒ coi như CHƯA KHAI, không gửi ngầm một mã đã khuất.
  const chosenOrderId = orderOptions.some((o) => o.id === productionOrderId) ? productionOrderId : "";
  const chosenBatchId = batchOptions.some((o) => o.id === productionBatchId) ? productionBatchId : "";

  const totalQty = items.reduce((s, i) => s + i.quantity, 0);

  const reset = () => {
    setInputs({});
    setReference("");
    setSupplier("");
    setNote("");
    setProductionOrderId("");
    setProductionBatchId("");
    setSearch("");
    setReceivedAt(todayVN());
  };

  const submit = () => {
    if (!items.length) {
      toast.error(kind === "ADJUSTMENT" ? "Nhập số đếm thực tế khác với tồn hiện tại cho ít nhất một mẫu mã" : "Nhập số lượng cho ít nhất một mẫu mã");
      return;
    }
    startTransition(async () => {
      const link = kind === "RECEIPT" ? { productionOrderId: chosenOrderId || undefined, productionBatchId: chosenBatchId || undefined } : {};
      // Không gửi giá: phiếu nhập lấy giá báo MKT ở máy chủ; các loại phiếu khác không mang giá.
      const result = await createStockReceipt({ kind, receivedAt, reference, supplier, note, ...link, items: items.map(({ variantId, quantity }) => ({ variantId, quantity })) });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      const done =
        kind === "RECEIPT" ? `Đã nhập ${formatNumber(totalQty)} sản phẩm (${items.length} mẫu mã)`
        : kind === "RETURN" ? `Đã tái nhập ${formatNumber(totalQty)} sản phẩm hàng hoàn (${items.length} mẫu mã)`
        : kind === "ISSUE" ? `Đã xuất tay ${formatNumber(totalQty)} sản phẩm (${items.length} mẫu mã)`
        : `Đã điều chỉnh ${items.length} mẫu mã`;
      toast.success(done);
      if (result.missingPrice?.length) toast.warning(`Mã chưa có giá báo MKT: ${result.missingPrice.join(", ")} — phiếu đã lưu, giá nhập để CHƯA BIẾT cho tới khi có giá báo`, { duration: 10_000 });
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
          {defaultKind === "RECEIPT" ? "Nhập hàng" : defaultKind === "RETURN" ? "Tái nhập hàng hoàn" : "Kiểm kê"}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[92vh] flex-col gap-0 p-0 sm:max-w-4xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{STOCK_RECEIPT_KIND_LABEL[kind]}</DialogTitle>
          <DialogDescription>
{STOCK_RECEIPT_KIND_HINT[kind]}
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
<Label>{kind === "RECEIPT" ? "Nhà cung cấp" : kind === "ISSUE" ? "Người nhận" : "Người kiểm"}</Label>
            <Input value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder={kind === "RECEIPT" ? "Xưởng / chợ / NCC" : kind === "ISSUE" ? "Khách / shipper nội thành" : "Tên người kiểm kê"} list={kind === "RECEIPT" ? "ncc-goi-y" : undefined} />
            {kind === "RECEIPT" ? <datalist id="ncc-goi-y">{supplierOptions.map((n) => <option key={n} value={n} />)}</datalist> : null}
          </div>
          <div className="space-y-1">
            <Label>Tham chiếu</Label>
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Số hoá đơn, mã lô…" />
          </div>
          {kind === "RECEIPT" && productionLinks.length ? (
            <>
              <div className="space-y-1 sm:col-span-2">
                <Label>Hàng của lệnh sản xuất (tuỳ chọn)</Label>
                <select value={chosenOrderId} onChange={(e) => setProductionOrderId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  <option value="">— Chưa khai —</option>
                  {orderOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label>Hàng của lô xưởng (tuỳ chọn)</Label>
                <select value={chosenBatchId} onChange={(e) => setProductionBatchId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  <option value="">— Chưa khai —</option>
                  {batchOptions.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {supplier.trim() && !orderOptions.length && !batchOptions.length ? <p className="text-[10.5px] text-muted-foreground">Xưởng này không có lệnh / lô đang mở — xoá tên xưởng để xem tất cả.</p> : null}
              </div>
            </>
          ) : null}
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
            <thead className={cn(STICKY_HEAD, "text-[11px] font-semibold tracking-wide text-muted-foreground uppercase")}>
              <tr>
                <th className="px-5 py-2 text-left">Mẫu mã</th>
                <th className="px-3 py-2 text-right">Tồn hiện tại</th>
                {kind !== "ADJUSTMENT" ? (
                  <>
                    {kind === "RETURN" ? <th className="w-28 px-3 py-2 text-right">Hoàn chờ nhận</th> : null}
                    <th className="w-28 px-3 py-2 text-right">{kind === "RECEIPT" ? "Số lượng nhập" : kind === "RETURN" ? "Thực nhận" : "Số lượng xuất"}</th>
                    <th className="px-3 py-2 text-right">Tồn sau phiếu</th>
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
                const input = inputs[v.id] ?? { qty: "", counted: "" };
                const qty = toInt(input.qty);
                const counted = input.counted === "" ? null : toInt(input.counted);
                const diff = counted === null ? 0 : counted - v.currentStock;
                const waiting = pendingReturns[v.id] ?? 0;
                return (
                  <tr key={v.id} className={cn("border-b last:border-0", (kind !== "ADJUSTMENT" ? qty > 0 : counted !== null && diff !== 0) && "bg-primary/5")}>
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
                            {kind === "RECEIPT" && coGiaBao && !coGiaBao.has(v.productId) ? (
                              <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" title="Mã chưa có giá báo MKT — phiếu vẫn lưu, giá nhập để chưa biết">
                                chưa có giá báo
                              </span>
                            ) : null}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            <span className="font-mono">{v.sku || "—"}</span>
                            {v.color || v.size ? ` · ${[v.color, v.size].filter(Boolean).join(" / ")}` : ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className={cn("numeric px-3 py-1.5 text-right font-semibold", v.currentStock <= 0 ? "text-destructive" : v.currentStock <= 5 ? "text-amber-600" : "")}>{formatNumber(v.currentStock)}</td>
                    {kind !== "ADJUSTMENT" ? (
                      <>
                        {kind === "RETURN" ? (
                          <td className="numeric px-3 py-1.5 text-right text-amber-600 dark:text-amber-400">{waiting ? formatNumber(waiting) : <span className="text-muted-foreground">—</span>}</td>
                        ) : null}
                        <td className="px-3 py-1.5">
                          <Input type="number" inputMode="numeric" min={0} className="numeric h-8 text-right" placeholder={kind === "RETURN" && waiting ? String(waiting) : "0"} value={input.qty} onChange={(e) => setField(v.id, "qty", e.target.value)} />
                        </td>
                        <td className="numeric px-3 py-1.5 text-right text-muted-foreground">
                          {qty > 0 ? <span className="font-semibold text-foreground">{formatNumber(v.currentStock + (kind === "ISSUE" ? -qty : qty))}</span> : "—"}
                        </td>
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
                {kind === "RECEIPT" ? <> · giá nhập theo <b className="text-foreground">giá báo MKT</b></> : null}
                {chuaCoGia ? <span className="text-amber-700 dark:text-amber-400"> · {chuaCoGia} mẫu mã chưa có giá báo</span> : null}
                {kind === "ISSUE" ? <> · <span className="text-rose-600">trừ khỏi tồn</span></> : null}
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
              {kind === "RECEIPT" ? "Lưu phiếu nhập" : kind === "RETURN" ? "Lưu phiếu tái nhập" : kind === "ISSUE" ? "Lưu phiếu xuất" : "Lưu điều chỉnh"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
