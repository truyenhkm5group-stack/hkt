"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveQuotationPolicyAction } from "@/lib/actions/wholesale-quotations";
import { formatNumber, formatVND } from "@/lib/format";
import type { QuotationPolicy } from "@/lib/wholesale/quotation-engine";
import type { PolicyPick, PolicySuggestion } from "@/lib/wholesale/quotation-settings";

const numText = (n: number | null) => (n === null ? "" : String(n));
const parsePct = (s: string): number | null => (s.trim() === "" ? null : Number(s.replace(",", ".")));
const pickText = (p: PolicyPick) => `${p.variantLabel} · bảng «${p.listName}» · bậc từ ${formatNumber(p.minQuantity)}: ${formatVND(p.unitPrice)}`;

/**
 * Khung «Cài đặt báo giá» — chỉ người có `wholesale:config` thấy. Gợi ý chỉ là CHỮ tính từ bảng giá sỉ đang bật; ô nhập không
 * tự điền theo gợi ý. Bấm «Lưu» (bắt buộc lý do) mới ghi và mới vào nhật ký.
 */
export function QuotationPolicyPanel({ policy, declared, suggestion, activeLists }: { policy: QuotationPolicy; declared: boolean | null; suggestion: PolicySuggestion; activeLists: number }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [maxDiscount, setMaxDiscount] = useState(numText(policy.maxDiscountPercent));
  const [minMargin, setMinMargin] = useState(numText(policy.minMarginPercent));
  const [taxRate, setTaxRate] = useState(numText(policy.taxRatePercent));
  const [taxSource, setTaxSource] = useState(policy.taxSource ?? "");
  const [reason, setReason] = useState("");
  const s = suggestion;

  const save = () =>
    start(async () => {
      const r = await saveQuotationPolicyAction({ maxDiscountPercent: parsePct(maxDiscount), minMarginPercent: parsePct(minMargin), taxRatePercent: parsePct(taxRate), taxSource, reason });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu cài đặt báo giá.");
        setReason("");
        router.refresh();
      }
    });

  const current = [
    `Trần chiết khấu: ${policy.maxDiscountPercent === null ? "chưa khai" : `${policy.maxDiscountPercent}%`}`,
    `Biên LN tối thiểu: ${policy.minMarginPercent === null ? "chưa khai" : `${policy.minMarginPercent}%`}`,
    `Thuế: ${policy.taxRatePercent === null ? "chưa khai (giá chưa gồm thuế)" : `${policy.taxRatePercent}% — ${policy.taxSource}`}`,
  ].join(" · ");

  return (
    <div className="rounded-lg border p-3 text-sm" data-quotation-policy>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <span className="font-semibold">Cài đặt báo giá</span> <span className="text-muted-foreground">— {current}</span>
          {declared === false ? <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(chưa khai ⇒ mọi chiết khấu cần duyệt)</span> : null}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(!open)}>
          {open ? "Đóng" : "Sửa"}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          <div className="rounded-md bg-muted p-2 text-xs" data-policy-suggestion>
            <div className="font-semibold">Gợi ý từ bảng giá sỉ đang bật ({formatNumber(activeLists)} bảng · {formatNumber(s.deepestTiers)} mẫu mã có bậc) — chỉ để tham khảo, không tự áp</div>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>
                Trần chiết khấu:{" "}
                {s.maxDiscount ? (
                  <>
                    bảng giá đã giảm sâu nhất <b>{s.maxDiscount.percent}%</b> so với giá lẻ {formatVND(s.maxDiscount.basePrice)} — {pickText(s.maxDiscount)}. Chiết khấu trên báo giá tính THÊM trên giá sỉ.
                  </>
                ) : (
                  "chưa so được (không có bậc giá, hoặc mẫu mã không có giá lẻ)."
                )}
                {s.noRetail ? ` ${formatNumber(s.noRetail)} mẫu mã không có giá lẻ — không so được.` : ""}
              </li>
              <li>
                Biên LN tối thiểu:{" "}
                {s.minMargin ? (
                  <>
                    biên gộp thấp nhất ở bậc sâu nhất là <b>{s.minMargin.percent}%</b> (giá vốn {formatVND(s.minMargin.basePrice)}) — {pickText(s.minMargin)}.
                  </>
                ) : (
                  "chưa biết — chưa mẫu mã nào có giá vốn."
                )}
                {s.unknownCost.count ? ` ${formatNumber(s.unknownCost.count)} mẫu mã chưa biết giá vốn (biên «chưa biết», không phải 0): ${s.unknownCost.examples.join("; ")}${s.unknownCost.count > s.unknownCost.examples.length ? "…" : ""}.` : ""}
              </li>
              <li>Thuế: không gợi ý — thuế suất phụ thuộc tư cách thuế của tổ chức. Để trống ⇒ báo giá ghi «chưa gồm thuế».</li>
            </ul>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">Trần chiết khấu (%) — trống = chưa khai</span>
              <Input inputMode="decimal" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">Biên LN gộp tối thiểu (%)</span>
              <Input inputMode="decimal" value={minMargin} onChange={(e) => setMinMargin(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">Thuế suất (%) — trống = chưa gồm thuế</span>
              <Input inputMode="decimal" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} />
            </label>
            <label className="space-y-1">
              <span className="text-xs font-semibold text-muted-foreground">Căn cứ thuế (bắt buộc khi có thuế suất)</span>
              <Input value={taxSource} onChange={(e) => setTaxSource(e.target.value)} />
            </label>
          </div>
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-muted-foreground">Lý do thay đổi (bắt buộc, ghi vào nhật ký)</span>
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          </label>
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            Lưu cài đặt
          </Button>
        </div>
      ) : null}
    </div>
  );
}
