"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Banknote, Loader2, Pencil, Plus, Scissors, Trash2, Truck } from "lucide-react";
import { toast } from "sonner";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  addProductionDelivery,
  addSupplierPayment,
  deleteFabricOrder,
  deleteProductionBatch,
  deleteProductionDelivery,
  deleteSupplierPayment,
  listVariantsForProductCode,
  saveFabricOrder,
  saveProductionBatch,
  setProductionBatchStatus,
} from "@/lib/actions/workshop-ledger";
import {
  FABRIC_SOURCE_LABEL,
  FABRIC_SOURCES,
  FABRIC_UNITS,
  laborCost,
  normalizeProductCode,
  PAYMENT_KIND_LABEL,
  PAYMENT_KINDS,
  PAYMENT_METHOD_LABEL,
  PAYMENT_METHODS,
  type FabricSource,
  type PaymentKind,
  type PaymentMethod,
} from "@/lib/constants/workshop-ledger";
import { sizeRank } from "@/lib/constants/production";
import { formatVND, todayVN, vnDateKey } from "@/lib/format";
import type { WorkshopFormOptions } from "@/lib/queries/workshop-ledger";

type Result = { ok: true } | { error: string };

/** Ô số: bỏ dấu chấm/phẩy phân cách nghìn. Trống ⇒ "" (CHƯA BIẾT), không ép về 0. */
function digits(v: string) {
  return v.replace(/[^\d-]/g, "");
}
function intOrNull(v: string): number | null {
  const s = digits(v);
  if (s === "" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function dateOf(d: Date | string | null | undefined) {
  return d ? vnDateKey(d) : "";
}

function useRun() {
  const [pending, start] = useNavTransition();
  const router = useRouter();
  const run = (fn: () => Promise<Result>, okText: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(okText);
      after?.();
      router.refresh();
    });
  return { pending, run };
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function MoneyHint({ value }: { value: string }) {
  const n = intOrNull(value);
  return n == null ? null : <>{formatVND(n)}</>;
}

// ─────────────────────────── BẢNG CHIA MÀU × SIZE ───────────────────────────

type VariantOpt = { id: string; color: string; size: string };

function cellsToPayload(values: Record<string, string>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([k, v]) => [k, intOrNull(v) ?? 0] as const)
      .filter(([, n]) => n !== 0),
  );
}

function cellsToForm(cells: Record<string, number> | null | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(cells ?? {}).map(([k, n]) => [k, String(n)]));
}

/** Bảng nhập số theo màu (dòng) × size (cột). Ô trống = 0. `hint` in dòng nhỏ dưới ô (vd "còn 20"). */
function CellsMatrix({ variants, values, onChange, hint, allowNegative }: { variants: VariantOpt[]; values: Record<string, string>; onChange: (next: Record<string, string>) => void; hint?: (id: string) => string | null; allowNegative?: boolean }) {
  const colors = [...new Set(variants.map((v) => v.color || "—"))];
  const sizes = [...new Set(variants.map((v) => v.size || "—"))].sort((a, b) => sizeRank(a) - sizeRank(b));
  const byKey = new Map(variants.map((v) => [`${v.color || "—"}|${v.size || "—"}`, v] as const));
  const n = (id: string) => intOrNull(values[id] ?? "") ?? 0;
  const total = variants.reduce((t, v) => t + n(v.id), 0);
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/50">
            <th className="px-2 py-1.5 text-left font-medium">Màu \ Size</th>
            {sizes.map((s) => (
              <th key={s} className="px-1 py-1.5 text-center font-medium">
                {s}
              </th>
            ))}
            <th className="px-2 py-1.5 text-right font-medium">Cộng</th>
          </tr>
        </thead>
        <tbody>
          {colors.map((c) => {
            const rowTotal = sizes.reduce((t, s) => {
              const v = byKey.get(`${c}|${s}`);
              return t + (v ? n(v.id) : 0);
            }, 0);
            return (
              <tr key={c} className="border-t">
                <td className="whitespace-nowrap px-2 py-1 font-medium">{c}</td>
                {sizes.map((s) => {
                  const v = byKey.get(`${c}|${s}`);
                  if (!v)
                    return (
                      <td key={s} className="px-1 py-1 text-center text-muted-foreground">
                        ·
                      </td>
                    );
                  const h = hint?.(v.id);
                  return (
                    <td key={s} className="px-1 py-1">
                      <Input
                        inputMode="numeric"
                        aria-label={`${c} ${s}`}
                        className="mx-auto h-7 w-16 px-1.5 text-center tabular-nums"
                        value={values[v.id] ?? ""}
                        onChange={(e) => onChange({ ...values, [v.id]: allowNegative ? digits(e.target.value) : e.target.value.replace(/[^\d]/g, "") })}
                      />
                      {h ? <div className="mt-0.5 text-center text-[10px] text-muted-foreground">{h}</div> : null}
                    </td>
                  );
                })}
                <td className="px-2 py-1 text-right font-semibold tabular-nums">{rowTotal || ""}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t bg-muted/30">
            <td className="px-2 py-1.5 font-medium" colSpan={sizes.length + 1}>
              Tổng
            </td>
            <td className="px-2 py-1.5 text-right font-bold tabular-nums">{total}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ─────────────────────────── LÔ SẢN XUẤT ───────────────────────────

export type BatchFormValue = {
  id: string;
  productCode: string;
  productName: string;
  batchNo: number;
  supplier: string;
  productionOrderId: string | null;
  orderedAt: Date | string;
  orderedQty: number;
  agreedQty: number | null;
  dueDate: Date | string | null;
  laborUnitPrice: number | null;
  adjustment: number;
  adjustmentNote: string;
  workshopPenalty: number;
  penaltyNote: string;
  penaltyAt: Date | string | null;
  fabricSource: string;
  cells: Record<string, number>;
  note: string;
  delivered: number;
};

export function BatchDialog({ options, suppliers, batch }: { options: WorkshopFormOptions; suppliers: string[]; batch?: BatchFormValue }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRun();
  const init = () => ({
    productCode: batch?.productCode ?? "",
    productName: batch?.productName ?? "",
    batchNo: batch ? String(batch.batchNo) : "",
    supplier: batch?.supplier ?? "",
    productionOrderId: batch?.productionOrderId ?? "none",
    orderedAt: batch ? dateOf(batch.orderedAt) : todayVN(),
    orderedQty: batch ? String(batch.orderedQty) : "",
    agreedQty: batch?.agreedQty != null ? String(batch.agreedQty) : "",
    dueDate: dateOf(batch?.dueDate),
    laborUnitPrice: batch?.laborUnitPrice != null ? String(batch.laborUnitPrice) : "",
    adjustment: batch?.adjustment ? String(batch.adjustment) : "",
    adjustmentNote: batch?.adjustmentNote ?? "",
    workshopPenalty: batch?.workshopPenalty ? String(batch.workshopPenalty) : "",
    penaltyNote: batch?.penaltyNote ?? "",
    penaltyAt: dateOf(batch?.penaltyAt),
    fabricSource: (batch?.fabricSource ?? "SHOP") as FabricSource,
    note: batch?.note ?? "",
  });
  const [f, setF] = useState(init);
  const set = (patch: Partial<typeof f>) => setF((cur) => ({ ...cur, ...patch }));
  /** `null` = lô ghi TỔNG; mảng = lô chia theo màu/size (danh sách mẫu của mã hàng). */
  const [variants, setVariants] = useState<VariantOpt[] | null>(null);
  const [cellValues, setCellValues] = useState<Record<string, string>>({});
  const [loadingVariants, setLoadingVariants] = useState(false);

  const code = normalizeProductCode(f.productCode);
  const nextNo = useMemo(() => Math.max(0, ...options.batches.filter((b) => b.productCode === code).map((b) => b.batchNo)) + 1, [options.batches, code]);
  const knownName = options.products.find((p) => normalizeProductCode(p.code) === code)?.name;
  const split = variants !== null;
  const splitTotal = split ? variants.reduce((t, v) => t + (intOrNull(cellValues[v.id] ?? "") ?? 0), 0) : 0;
  const labor = laborCost(
    { agreedQty: intOrNull(f.agreedQty), laborUnitPrice: intOrNull(f.laborUnitPrice), adjustment: intOrNull(f.adjustment) ?? 0, penalty: intOrNull(f.workshopPenalty) ?? 0 },
    batch?.delivered ?? 0,
  );

  const loadVariants = async (forCode: string, keep: Record<string, string>) => {
    setLoadingVariants(true);
    try {
      const r = await listVariantsForProductCode(forCode);
      if (!r.productId || !r.variants.length) {
        toast.error(`Mã ${normalizeProductCode(forCode) || "?"} chưa khớp đúng một sản phẩm có màu/size — lô sẽ ghi dạng tổng`);
        setVariants(null);
        return;
      }
      setVariants(r.variants);
      setCellValues(keep);
    } finally {
      setLoadingVariants(false);
    }
  };

  const submit = () =>
    run(
      () =>
        saveProductionBatch(
          {
            ...f,
            batchNo: f.batchNo || String(nextNo),
            productionOrderId: f.productionOrderId === "none" ? null : f.productionOrderId,
            orderedQty: split ? splitTotal : (intOrNull(f.orderedQty) ?? 0),
            cells: split ? cellsToPayload(cellValues) : {},
            agreedQty: f.agreedQty,
            laborUnitPrice: f.laborUnitPrice,
            penaltyAt: intOrNull(f.workshopPenalty) ? f.penaltyAt || todayVN() : "",
            adjustment: intOrNull(f.adjustment) ?? 0,
            workshopPenalty: intOrNull(f.workshopPenalty) ?? 0,
          },
          batch?.id,
        ),
      batch ? "Đã lưu lô" : "Đã thêm lô sản xuất",
      () => setOpen(false),
    );

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) return;
        setF(init());
        setVariants(null);
        setCellValues({});
        if (batch && Object.keys(batch.cells ?? {}).length) void loadVariants(batch.productCode, cellsToForm(batch.cells));
      }}
    >
      <DialogTrigger asChild>
        {batch ? (
          <Button size="sm" variant="outline">
            <Pencil className="size-3.5" /> Sửa lô
          </Button>
        ) : (
          <Button size="sm">
            <Plus className="size-4" /> Thêm lô đặt xưởng
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{batch ? `Sửa ${batch.productCode} · lô ${batch.batchNo}` : "Thêm lô đặt xưởng"}</DialogTitle>
          <DialogDescription>Một dòng của trang Thành phẩm. Ô số để trống là CHƯA BIẾT — ERP không coi là 0. Chia theo màu/size thì hàng đặt được trừ vào số thiếu của đúng mẫu.</DialogDescription>
        </DialogHeader>
        <datalist id="ws-products">
          {options.products.map((p, i) => (
            <option key={`${p.code}-${i}`} value={p.code}>
              {p.name}
            </option>
          ))}
        </datalist>
        <datalist id="ws-suppliers">
          {suppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Mã hàng *" hint={knownName ? knownName : code ? "Chưa khớp sản phẩm nào — vẫn lưu được theo mã" : undefined}>
            <Input
              list="ws-products"
              value={f.productCode}
              onChange={(e) => {
                set({ productCode: e.target.value });
                if (split) {
                  setVariants(null);
                  setCellValues({});
                }
              }}
              placeholder="Q002"
            />
          </Field>
          <Field label="Lô số" hint={!batch && !f.batchNo && code ? `Để trống = lô ${nextNo}` : undefined}>
            <Input inputMode="numeric" value={f.batchNo} onChange={(e) => set({ batchNo: digits(e.target.value) })} placeholder={code ? String(nextNo) : ""} />
          </Field>
          <Field label="Xưởng may">
            <Input list="ws-suppliers" value={f.supplier} onChange={(e) => set({ supplier: e.target.value })} />
          </Field>
          <Field label="Tên hàng">
            <Input value={f.productName} onChange={(e) => set({ productName: e.target.value })} placeholder={knownName ?? ""} />
          </Field>
          <Field label="Ngày đặt hàng *">
            <Input type="date" value={f.orderedAt} onChange={(e) => set({ orderedAt: e.target.value })} />
          </Field>
          <Field label="Ngày xưởng phải trả">
            <Input type="date" value={f.dueDate} onChange={(e) => set({ dueDate: e.target.value })} />
          </Field>
          <div className="sm:col-span-3">
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
              <Label className="text-xs">Số lượng đặt {split ? "theo màu / size" : ""}</Label>
              {split ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setVariants(null);
                    setCellValues({});
                  }}
                >
                  Ghi dạng tổng
                </Button>
              ) : (
                <Button type="button" size="sm" variant="outline" disabled={!code || loadingVariants} onClick={() => void loadVariants(code, {})}>
                  {loadingVariants ? <Loader2 className="size-3.5 animate-spin" /> : null} Chia theo màu / size
                </Button>
              )}
            </div>
            {split ? (
              <CellsMatrix variants={variants} values={cellValues} onChange={setCellValues} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-3">
                <Input inputMode="numeric" value={f.orderedQty} onChange={(e) => set({ orderedQty: digits(e.target.value) })} placeholder="SL đặt hàng *" />
                <p className="text-[11px] text-muted-foreground sm:col-span-2">Ghi dạng tổng thì trang Thiếu hàng KHÔNG trừ được lô này vào mẫu nào — chia theo màu/size để ERP tự thôi nhắc khi đã đặt đủ.</p>
              </div>
            )}
          </div>
          <Field label="SL chốt TT với xưởng" hint="Trống = chưa chốt, tiền công tạm tính theo số đã trả">
            <Input inputMode="numeric" value={f.agreedQty} onChange={(e) => set({ agreedQty: digits(e.target.value) })} />
          </Field>
          <Field label="Đơn giá công (đ/chiếc)" hint={<MoneyHint value={f.laborUnitPrice} />}>
            <Input inputMode="numeric" value={f.laborUnitPrice} onChange={(e) => set({ laborUnitPrice: digits(e.target.value) })} />
          </Field>
          <div />
          <Field label="Thưởng (+) / Phạt khác (−)" hint={<MoneyHint value={f.adjustment} />}>
            <Input inputMode="numeric" value={f.adjustment} onChange={(e) => set({ adjustment: digits(e.target.value) })} placeholder="0" />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Lý do thưởng / phạt khác">
              <Input value={f.adjustmentNote} onChange={(e) => set({ adjustmentNote: e.target.value })} />
            </Field>
          </div>
          <Field label="Phạt xưởng · hoàn MKT (đ)" hint={<MoneyHint value={f.workshopPenalty} />}>
            <Input inputMode="numeric" value={f.workshopPenalty} onChange={(e) => set({ workshopPenalty: e.target.value.replace(/[^\d]/g, "") })} placeholder="0" />
          </Field>
          <Field label="Ngày ghi phạt" hint="Tiền phạt cộng cho MKT phụ trách mã ở kỳ lương chứa ngày này">
            <Input type="date" value={f.penaltyAt} disabled={!intOrNull(f.workshopPenalty)} onChange={(e) => set({ penaltyAt: e.target.value })} placeholder={todayVN()} />
          </Field>
          <div className="sm:col-span-3">
            <Field label="Lý do phạt xưởng (sai sót / trả chậm)">
              <Input value={f.penaltyNote} onChange={(e) => set({ penaltyNote: e.target.value })} />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Ai lo vải">
              <Select value={f.fabricSource} onValueChange={(v) => set({ fabricSource: v as FabricSource })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FABRIC_SOURCES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {FABRIC_SOURCE_LABEL[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Bảng đặt màu × size cũ">
            <Select value={f.productionOrderId} onValueChange={(v) => set({ productionOrderId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Không nối</SelectItem>
                {options.productionOrders
                  .filter((o) => !code || !o.productCode || normalizeProductCode(o.productCode) === code || o.id === f.productionOrderId)
                  .map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="sm:col-span-3">
            <Field label="Ghi chú">
              <Textarea rows={2} value={f.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
          </div>
        </div>
        <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          Tiền công: <b className="tabular-nums">{labor.amount == null ? "—" : formatVND(labor.amount)}</b>
          <span className="ml-2 text-xs text-muted-foreground">{labor.reason}</span>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || loadingVariants || !f.productCode.trim() || !f.orderedAt || (split ? splitTotal <= 0 : f.orderedQty === "")}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── ĐỢT XƯỞNG TRẢ HÀNG ───────────────────────────

export type DeliveryVariantLine = { variantId: string; color: string; size: string; ordered: number; delivered: number; remaining: number };

export function DeliveryDialog({ batchId, label, compact, variantLines = [] }: { batchId: string; label: string; compact?: boolean; variantLines?: DeliveryVariantLine[] }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRun();
  const [f, setF] = useState({ deliveredAt: todayVN(), quantity: "", note: "" });
  const [cellValues, setCellValues] = useState<Record<string, string>>({});
  const split = variantLines.length > 0;
  const byId = new Map(variantLines.map((l) => [l.variantId, l] as const));
  const splitTotal = variantLines.reduce((t, l) => t + (intOrNull(cellValues[l.variantId] ?? "") ?? 0), 0);
  const qty = split ? splitTotal : intOrNull(f.quantity);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) {
          setF({ deliveredAt: todayVN(), quantity: "", note: "" });
          setCellValues({});
        }
      }}
    >
      <DialogTrigger asChild>
        {compact ? (
          <Button size="icon" variant="ghost" className="size-7" title="Ghi hàng xưởng trả">
            <Truck className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Truck className="size-3.5" /> Ghi hàng về
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className={split ? "sm:max-w-3xl" : "sm:max-w-md"}>
        <DialogHeader>
          <DialogTitle>Xưởng trả hàng · {label}</DialogTitle>
          <DialogDescription>Mỗi lần xưởng giao là một dòng. Số âm = shop trả lại xưởng hàng lỗi.{split ? " Lô đặt theo màu/size nên ghi số trả theo từng mẫu." : ""}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ngày nhận *">
            <Input type="date" value={f.deliveredAt} onChange={(e) => setF({ ...f, deliveredAt: e.target.value })} />
          </Field>
          {split ? null : (
            <Field label="Số lượng *">
              <Input inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: digits(e.target.value) })} autoFocus />
            </Field>
          )}
          {split ? (
            <div className="sm:col-span-2">
              <CellsMatrix
                variants={variantLines.map((l) => ({ id: l.variantId, color: l.color, size: l.size }))}
                values={cellValues}
                onChange={setCellValues}
                allowNegative
                hint={(id) => {
                  const l = byId.get(id);
                  return l ? `còn ${l.remaining}/${l.ordered}` : null;
                }}
              />
            </div>
          ) : null}
          <div className="sm:col-span-2">
            <Field label="Ghi chú">
              <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder={split ? "" : "115c đỏ"} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || !qty}
            onClick={() =>
              run(
                () => addProductionDelivery({ batchId, deliveredAt: f.deliveredAt, quantity: qty, cells: split ? cellsToPayload(cellValues) : {}, note: f.note }),
                "Đã ghi hàng về",
                () => setOpen(false),
              )
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── ĐỢT VẢI ───────────────────────────

export type FabricFormValue = {
  id: string;
  productCode: string;
  batchId: string | null;
  supplier: string;
  description: string;
  orderedAt: Date | string;
  receivedAt: Date | string | null;
  quantity: number | null;
  unit: string;
  unitPrice: number | null;
  amount: number;
  note: string;
};

export function FabricDialog({ options, suppliers, fabric, defaultBatchId }: { options: WorkshopFormOptions; suppliers: string[]; fabric?: FabricFormValue; defaultBatchId?: string }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRun();
  const init = () => ({
    productCode: fabric?.productCode ?? "",
    batchId: fabric?.batchId ?? defaultBatchId ?? "none",
    supplier: fabric?.supplier ?? "",
    description: fabric?.description ?? "",
    orderedAt: fabric ? dateOf(fabric.orderedAt) : todayVN(),
    receivedAt: dateOf(fabric?.receivedAt),
    quantity: fabric?.quantity != null ? String(fabric.quantity) : "",
    unit: fabric?.unit ?? "m",
    unitPrice: fabric?.unitPrice != null ? String(fabric.unitPrice) : "",
    amount: fabric ? String(fabric.amount) : "",
    amountTouched: !!fabric,
    note: fabric?.note ?? "",
  });
  const [f, setF] = useState(init);
  const qty = f.quantity === "" ? null : Number(f.quantity.replace(",", "."));
  const price = intOrNull(f.unitPrice);
  const computed = qty != null && Number.isFinite(qty) && price != null ? Math.round(qty * price) : null;
  const set = (patch: Partial<typeof f>) =>
    setF((cur) => {
      const next = { ...cur, ...patch };
      if (!next.amountTouched) {
        const q = next.quantity === "" ? null : Number(next.quantity.replace(",", "."));
        const p = intOrNull(next.unitPrice);
        next.amount = q != null && Number.isFinite(q) && p != null ? String(Math.round(q * p)) : "";
      }
      return next;
    });
  const batch = options.batches.find((b) => b.id === f.batchId);

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setF(init());
      }}
    >
      <DialogTrigger asChild>
        {fabric ? (
          <Button size="icon" variant="ghost" className="size-7" title="Sửa đợt vải">
            <Pencil className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" variant={defaultBatchId ? "outline" : "default"}>
            <Scissors className="size-3.5" /> Thêm đợt vải
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{fabric ? "Sửa đợt vải" : "Thêm đợt đặt / nhập vải"}</DialogTitle>
          <DialogDescription>Gán vào lô sản xuất thì tiền vải vào giá thành của lô đó; chưa gán thì chỉ vào giá thành cấp mã.</DialogDescription>
        </DialogHeader>
        <datalist id="ws-fabric-products">
          {options.products.map((p, i) => (
            <option key={`${p.code}-${i}`} value={p.code}>
              {p.name}
            </option>
          ))}
        </datalist>
        <datalist id="ws-fabric-suppliers">
          {suppliers.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <datalist id="ws-fabric-units">
          {FABRIC_UNITS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <Field label="Dùng cho lô sản xuất">
              <Select value={f.batchId} onValueChange={(v) => set({ batchId: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Chưa gán lô</SelectItem>
                  {options.batches
                    .filter((b) => b.status !== "CANCELLED" || b.id === f.batchId)
                    .map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Mã hàng" hint={batch ? "Theo lô đã chọn" : undefined}>
            <Input list="ws-fabric-products" value={batch ? batch.productCode : f.productCode} disabled={!!batch} onChange={(e) => set({ productCode: e.target.value })} placeholder="Q002" />
          </Field>
          <Field label="Nhà cung cấp vải">
            <Input list="ws-fabric-suppliers" value={f.supplier} onChange={(e) => set({ supplier: e.target.value })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Loại vải / mô tả">
              <Input value={f.description} onChange={(e) => set({ description: e.target.value })} placeholder="Vải chính đỏ · lót…" />
            </Field>
          </div>
          <Field label="Ngày đặt *">
            <Input type="date" value={f.orderedAt} onChange={(e) => set({ orderedAt: e.target.value })} />
          </Field>
          <Field label="Ngày vải về" hint="Trống = chưa về">
            <Input type="date" value={f.receivedAt} onChange={(e) => set({ receivedAt: e.target.value })} />
          </Field>
          <div />
          <Field label="Số lượng">
            <Input inputMode="decimal" value={f.quantity} onChange={(e) => set({ quantity: e.target.value.replace(/[^\d.,]/g, "") })} />
          </Field>
          <Field label="Đơn vị">
            <Input list="ws-fabric-units" value={f.unit} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
          <Field label="Đơn giá" hint={<MoneyHint value={f.unitPrice} />}>
            <Input inputMode="numeric" value={f.unitPrice} onChange={(e) => set({ unitPrice: digits(e.target.value) })} />
          </Field>
          <Field label="Thành tiền theo hoá đơn *" hint={computed != null && intOrNull(f.amount) !== computed ? `SL × đơn giá = ${formatVND(computed)}` : <MoneyHint value={f.amount} />}>
            <Input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: digits(e.target.value), amountTouched: true })} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Ghi chú">
              <Input value={f.note} onChange={(e) => set({ note: e.target.value })} />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending || f.amount === "" || (!batch && !f.productCode.trim())}
            onClick={() =>
              run(
                () =>
                  saveFabricOrder(
                    {
                      productCode: batch ? batch.productCode : f.productCode,
                      batchId: f.batchId === "none" ? null : f.batchId,
                      supplier: f.supplier,
                      description: f.description,
                      orderedAt: f.orderedAt,
                      receivedAt: f.receivedAt,
                      quantity: f.quantity,
                      unit: f.unit,
                      unitPrice: f.unitPrice,
                      amount: intOrNull(f.amount),
                      note: f.note,
                    },
                    fabric?.id,
                  ),
                fabric ? "Đã lưu đợt vải" : "Đã thêm đợt vải",
                () => setOpen(false),
              )
            }
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── ĐỢT THANH TOÁN ───────────────────────────

export function PaymentDialog({ target, label, remaining, compact }: { target: { batchId: string } | { fabricOrderId: string }; label: string; remaining: number | null; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { pending, run } = useRun();
  const init = () => ({ kind: "PAYMENT" as PaymentKind, amount: remaining != null && remaining > 0 ? String(remaining) : "", paidAt: todayVN(), method: "BANK" as PaymentMethod, reference: "", note: "" });
  const [f, setF] = useState(init);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setF(init());
      }}
    >
      <DialogTrigger asChild>
        {compact ? (
          <Button size="icon" variant="ghost" className="size-7" title="Ghi thanh toán">
            <Banknote className="size-3.5" />
          </Button>
        ) : (
          <Button size="sm" variant="outline">
            <Banknote className="size-3.5" /> Ghi thanh toán
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thanh toán · {label}</DialogTitle>
          <DialogDescription>
            Còn phải trả: <b>{remaining == null ? "chưa biết (thiếu đơn giá / số lượng chốt)" : formatVND(remaining)}</b>. Sổ này là công nợ — không tạo khoản chi phí nào.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Loại">
            <Select value={f.kind} onValueChange={(v) => setF({ ...f, kind: v as PaymentKind })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {PAYMENT_KIND_LABEL[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Số tiền *" hint={<MoneyHint value={f.amount} />}>
            <Input inputMode="numeric" value={f.amount} onChange={(e) => setF({ ...f, amount: digits(e.target.value) })} autoFocus />
          </Field>
          <Field label="Ngày trả *">
            <Input type="date" value={f.paidAt} onChange={(e) => setF({ ...f, paidAt: e.target.value })} />
          </Field>
          <Field label="Hình thức">
            <Select value={f.method} onValueChange={(v) => setF({ ...f, method: v as PaymentMethod })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {PAYMENT_METHOD_LABEL[m]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Mã giao dịch / chứng từ">
            <Input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} />
          </Field>
          <Field label="Ghi chú">
            <Input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
        </div>
        <DialogFooter>
          <Button disabled={pending || !intOrNull(f.amount)} onClick={() => run(() => addSupplierPayment({ ...target, ...f, amount: intOrNull(f.amount) }), "Đã ghi thanh toán", () => setOpen(false))}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────────────────── NÚT TRẠNG THÁI / XOÁ ───────────────────────────

export function BatchStatusButtons({ id, status }: { id: string; status: string }) {
  const { pending, run } = useRun();
  const go = (to: string, text: string) => run(() => setProductionBatchStatus(id, to), text);
  return (
    <div className="flex flex-wrap gap-2">
      {status === "OPEN" ? (
        <Button size="sm" disabled={pending} onClick={() => go("DONE", "Đã đánh dấu xưởng trả xong")}>
          Xưởng đã trả xong
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={pending} onClick={() => go("OPEN", "Đã mở lại lô")}>
          Mở lại lô
        </Button>
      )}
      {status !== "CANCELLED" ? (
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => confirm("Huỷ lô này? Các đợt trả hàng / thanh toán vẫn được giữ.") && go("CANCELLED", "Đã huỷ lô")}>
          Huỷ lô
        </Button>
      ) : null}
    </div>
  );
}

const DELETE_ACTION = {
  batch: deleteProductionBatch,
  delivery: deleteProductionDelivery,
  fabric: deleteFabricOrder,
  payment: deleteSupplierPayment,
} as const;

export function DeleteButton({ kind, id, what, redirectTo }: { kind: keyof typeof DELETE_ACTION; id: string; what: string; redirectTo?: string }) {
  const { pending, run } = useRun();
  const router = useRouter();
  return (
    <Button
      size="icon"
      variant="ghost"
      className="size-7 text-muted-foreground hover:text-destructive"
      title={`Xoá ${what}`}
      disabled={pending}
      onClick={() => {
        if (!confirm(`Xoá ${what}? Nhật ký vẫn giữ lại dòng đã xoá.`)) return;
        run(() => DELETE_ACTION[kind](id), `Đã xoá ${what}`, redirectTo ? () => router.push(redirectTo) : undefined);
      }}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

