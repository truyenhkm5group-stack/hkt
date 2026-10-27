"use client";

import { Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createQuotationAction, previewQuotationAction, reviseQuotationAction } from "@/lib/actions/wholesale-quotations";
import { formatNumber, formatVND } from "@/lib/format";
import { INCOTERMS, type QuotationResult } from "@/lib/wholesale/quotation-engine";

type VariantOption = { id: string; label: string };
type LineState = { text: string; quantity: string; lineDiscount: string };

export type QuotationFormInitial = {
  lines: { variantId: string; quantity: number; lineDiscount: number }[];
  quoteDiscount: number;
  shippingAmount: number | null;
  shippingSource: string;
  validUntil: string;
  incoterm: string | null;
  notes: string;
};

const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const intOf = (s: string) => (s.trim() === "" ? Number.NaN : Number(s.replace(/[.\s,]/g, "")));

/**
 * Form lập / sửa báo giá sỉ. KHÔNG tính tiền ở trình duyệt: «Xem trước» gọi máy chủ (cùng bộ tính, cùng ngữ cảnh với lượt lưu).
 * `requestKey` cấp MỘT lần khi mở form ⇒ bấm «Lưu» hai lần chỉ ra một phiên bản.
 */
export function QuotationForm({ mode, quotationId, party, variants, initial, today }: { mode: "create" | "revise"; quotationId?: string; party: { leadId: string | null; customerId: string | null; label: string }; variants: VariantOption[]; initial: QuotationFormInitial | null; today: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const labelOf = useMemo(() => new Map(variants.map((v) => [v.id, v.label])), [variants]);
  const idOf = useMemo(() => new Map(variants.map((v) => [v.label, v.id])), [variants]);
  const [requestKey] = useState(() => crypto.randomUUID());
  const [lines, setLines] = useState<LineState[]>(() => (initial?.lines.length ? initial.lines.map((l) => ({ text: labelOf.get(l.variantId) ?? l.variantId, quantity: String(l.quantity), lineDiscount: l.lineDiscount ? String(l.lineDiscount) : "" })) : [{ text: "", quantity: "", lineDiscount: "" }]));
  const [quoteDiscount, setQuoteDiscount] = useState(initial?.quoteDiscount ? String(initial.quoteDiscount) : "");
  const [shippingAmount, setShippingAmount] = useState(initial?.shippingAmount !== null && initial?.shippingAmount !== undefined ? String(initial.shippingAmount) : "");
  const [shippingSource, setShippingSource] = useState(initial?.shippingSource ?? "");
  const [validUntil, setValidUntil] = useState(initial && initial.validUntil >= today ? initial.validUntil : "");
  const [incoterm, setIncoterm] = useState(initial?.incoterm ?? "");
  const [notes, setNotes] = useState(initial?.notes ?? "");
  const [preview, setPreview] = useState<QuotationResult | null>(null);

  const payload = () => ({
    leadId: party.leadId,
    customerId: party.customerId,
    lines: lines.filter((l) => l.text.trim()).map((l) => ({ variantId: idOf.get(l.text.trim()) ?? l.text.trim(), quantity: intOf(l.quantity), lineDiscount: l.lineDiscount.trim() ? intOf(l.lineDiscount) : 0 })),
    quoteDiscount: quoteDiscount.trim() ? intOf(quoteDiscount) : 0,
    shippingAmount: shippingAmount.trim() ? intOf(shippingAmount) : null,
    shippingSource,
    validUntil,
    incoterm: incoterm || null,
    notes,
    requestKey,
  });

  const setLine = (i: number, patch: Partial<LineState>) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setPreview(null);
  };

  const doPreview = () =>
    start(async () => {
      const r = await previewQuotationAction(payload());
      if ("error" in r) toast.error(r.error);
      else setPreview(r.result);
    });

  const doSave = () =>
    start(async () => {
      const r = mode === "revise" && quotationId ? await reviseQuotationAction(quotationId, payload()) : await createQuotationAction(payload());
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`${r.replayed ? "Đã lưu từ trước" : "Đã lưu"} ${r.code} · bản ${r.version}${r.blockers ? ` — còn ${r.blockers} chặn` : r.requiresApproval ? " — cần duyệt" : ""}`);
      router.push(`/wholesale/quotations/${r.id}`);
    });

  return (
    <div className="space-y-4">
      <div className="rounded-lg border p-4">
        <div className="mb-3 text-sm">
          Bên nhận: <span className="font-semibold">{party.label || "—"}</span> <span className="text-muted-foreground">({party.leadId ? "lead khách sỉ" : "khách hàng"})</span>
        </div>
        <datalist id="quotation-variants">
          {variants.map((v) => (
            <option key={v.id} value={v.label} />
          ))}
        </datalist>
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_110px_150px_36px] gap-2 text-xs font-semibold text-muted-foreground">
            <span>Mẫu mã</span>
            <span>Số lượng</span>
            <span>Chiết khấu dòng (₫)</span>
            <span />
          </div>
          {lines.map((l, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px_150px_36px] gap-2">
              <Input list="quotation-variants" value={l.text} onChange={(e) => setLine(i, { text: e.target.value })} placeholder="Gõ SKU hoặc tên để chọn" aria-label={`Mẫu mã dòng ${i + 1}`} />
              <Input inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} placeholder="SL" aria-label={`Số lượng dòng ${i + 1}`} />
              <Input inputMode="numeric" value={l.lineDiscount} onChange={(e) => setLine(i, { lineDiscount: e.target.value })} placeholder="0" aria-label={`Chiết khấu dòng ${i + 1}`} />
              <Button type="button" variant="ghost" size="icon" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((_, j) => j !== i) : ls))} aria-label={`Xoá dòng ${i + 1}`}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}
          <Button type="button" variant="outline" size="sm" onClick={() => setLines((ls) => [...ls, { text: "", quantity: "", lineDiscount: "" }])}>
            <Plus className="size-4" /> Thêm dòng
          </Button>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Chiết khấu cả báo giá (₫)</span>
            <Input inputMode="numeric" value={quoteDiscount} onChange={(e) => {
              setQuoteDiscount(e.target.value);
              setPreview(null);
            }} placeholder="0" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Phí vận chuyển (₫) — để trống nếu chưa có</span>
            <Input inputMode="numeric" value={shippingAmount} onChange={(e) => {
              setShippingAmount(e.target.value);
              setPreview(null);
            }} placeholder="chưa có" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Căn cứ phí vận chuyển</span>
            <Input value={shippingSource} onChange={(e) => {
              setShippingSource(e.target.value);
              setPreview(null);
            }} placeholder="vd báo giá cước GHN 27/10" />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Hiệu lực đến hết ngày</span>
            <Input type="date" min={today} value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-xs font-semibold text-muted-foreground">Điều kiện giao hàng (Incoterms) — chỉ khi đã thoả thuận</span>
            <select className={sel} value={incoterm} onChange={(e) => setIncoterm(e.target.value)}>
              <option value="">Không ghi</option>
              {INCOTERMS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm sm:col-span-2 lg:col-span-3">
            <span className="text-xs font-semibold text-muted-foreground">Ghi chú in trên báo giá</span>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
          </label>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={pending} onClick={doPreview}>
            Xem trước (máy chủ tính)
          </Button>
          <Button type="button" disabled={pending} onClick={doSave}>
            {mode === "revise" ? "Lưu phiên bản mới" : "Lưu nháp"}
          </Button>
        </div>
      </div>

      {preview ? <QuotationPreview result={preview} /> : null}
    </div>
  );
}

function QuotationPreview({ result }: { result: QuotationResult }) {
  const t = result.totals;
  return (
    <div className="space-y-3 rounded-lg border p-4 text-sm" data-quotation-preview>
      <IssueList result={result} />
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1">Mẫu mã</th>
            <th className="py-1 text-right">SL</th>
            <th className="py-1 text-right">Đơn giá</th>
            <th className="py-1 text-right">Bậc · MOQ</th>
            <th className="py-1 text-right">Tồn khả dụng</th>
            <th className="py-1 text-right">Thành tiền</th>
          </tr>
        </thead>
        <tbody>
          {result.lines.map((l) => (
            <tr key={l.lineNo} className="border-t">
              <td className="py-1">{l.name || l.variantId}</td>
              <td className="py-1 text-right tabular-nums">{formatNumber(l.quantity)}</td>
              <td className="py-1 text-right tabular-nums">{formatVND(l.unitPrice)}</td>
              <td className="py-1 text-right text-xs tabular-nums">
                {l.tierMinQty === null ? "—" : `từ ${formatNumber(l.tierMinQty)}`} · {l.moq === null ? "—" : formatNumber(l.moq)}
              </td>
              <td className="py-1 text-right tabular-nums">{l.stockAvailable === null ? <span className="text-amber-700 dark:text-amber-400">chưa xác minh</span> : formatNumber(l.stockAvailable)}</td>
              <td className="py-1 text-right tabular-nums">{formatVND(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <TotalsBlock totals={t} discountPercent={result.discountPercent} marginPercent={result.marginPercent} taxRatePercent={result.taxRatePercent} />
    </div>
  );
}

export function IssueList({ result }: { result: Pick<QuotationResult, "blockers" | "warnings" | "reasons"> }) {
  return (
    <div className="space-y-2">
      {result.blockers.length ? (
        <div className="rounded-md bg-rose-50 p-2 text-rose-900 dark:bg-rose-950 dark:text-rose-200" data-quotation-blockers>
          <div className="font-semibold">Chặn — chưa gửi / duyệt được ({result.blockers.length})</div>
          <ul className="list-disc pl-5 text-xs">
            {result.blockers.map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.reasons.length ? (
        <div className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <div className="font-semibold">Cần người duyệt</div>
          <ul className="list-disc pl-5 text-xs">
            {result.reasons.map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {result.warnings.length ? (
        <div className="rounded-md bg-muted p-2">
          <div className="font-semibold">Cảnh báo (không chặn)</div>
          <ul className="list-disc pl-5 text-xs">
            {result.warnings.map((b, i) => (
              <li key={i}>{b.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function TotalsBlock({ totals: t, discountPercent, marginPercent, taxRatePercent }: { totals: QuotationResult["totals"]; discountPercent: number | null; marginPercent?: number | null; taxRatePercent: number | null }) {
  return (
    <dl className="ml-auto grid max-w-sm grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
      <dt className="text-muted-foreground">Tiền hàng</dt>
      <dd className="text-right">{formatVND(t.subtotal)}</dd>
      <dt className="text-muted-foreground">Chiết khấu{discountPercent !== null && t.discount > 0 ? ` (${discountPercent.toLocaleString("vi-VN")}%)` : ""}</dt>
      <dd className="text-right">{t.discount ? `−${formatVND(t.discount)}` : formatVND(0)}</dd>
      <dt className="text-muted-foreground">Vận chuyển</dt>
      <dd className="text-right">{t.shipping === null ? <span className="text-amber-700 dark:text-amber-400">chưa có</span> : formatVND(t.shipping)}</dd>
      <dt className="text-muted-foreground">Thuế{taxRatePercent !== null ? ` (${taxRatePercent.toLocaleString("vi-VN")}%)` : ""}</dt>
      <dd className="text-right">{t.tax === null ? <span className="text-amber-700 dark:text-amber-400">chưa có</span> : formatVND(t.tax)}</dd>
      <dt className="font-semibold">Tổng{t.shipping === null || t.tax === null ? " (chưa gồm phần «chưa có»)" : ""}</dt>
      <dd className="text-right font-semibold">{formatVND(t.total)}</dd>
      {marginPercent !== undefined ? (
        <>
          <dt className="text-xs text-muted-foreground">Biên lợi nhuận gộp (nội bộ)</dt>
          <dd className="text-right text-xs">{marginPercent === null ? "chưa biết" : `${marginPercent.toLocaleString("vi-VN")}%`}</dd>
        </>
      ) : null}
    </dl>
  );
}
