"use client";

import { Check, Loader2, Sparkles } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { writeCopyOptionsAction } from "@/lib/actions/creative-manual-gen";
import { COPY_DEFAULT_FORMULAS, COPY_FORMULAS, COPY_FORMULA_KEYS, COPY_MAX_FORMULAS, type CopyFormula } from "@/lib/constants/copy-formulas";
import { cn } from "@/lib/utils";

type Option = { headline: string; primaryText: string; formula?: string };

/** Chọn công thức content (tối đa `COPY_MAX_FORMULAS`) — dùng chung cho hộp soạn bài và form mẫu tự làm. */
export function FormulaPicker({ value, onChange, max = COPY_MAX_FORMULAS, disabled }: { value: CopyFormula[]; onChange: (v: CopyFormula[]) => void; max?: number; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {COPY_FORMULA_KEYS.map((k) => {
        const on = value.includes(k);
        return (
          <button
            key={k}
            type="button"
            title={COPY_FORMULAS[k].hint}
            aria-pressed={on}
            disabled={disabled || (!on && value.length >= max)}
            onClick={() => onChange(on ? value.filter((x) => x !== k) : [...value, k])}
            className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] disabled:opacity-40", on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background hover:bg-muted")}
          >
            {on ? <Check className="size-3" /> : null}
            {COPY_FORMULAS[k].label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * "AI VIẾT THEO CÔNG THỨC" trong hộp soạn bài (chủ shop 29/09/2026) — mỗi phương án một công thức (AIDA, PAS, câu hỏi mở đầu…),
 * mặc định KHÔNG ghi giá. Bấm "Dùng" để điền vào tiêu đề + nội dung (người vẫn sửa được); chưa lưu gì cho tới khi Lưu / Đăng.
 */
export function CopyAiPanel({ imageId, onUse }: { imageId: string; onUse: (o: { headline: string; primaryText: string }) => void }) {
  const [formulas, setFormulas] = useState<CopyFormula[]>([...COPY_DEFAULT_FORMULAS]);
  const [noPrice, setNoPrice] = useState(true);
  const [options, setOptions] = useState<Option[]>([]);
  const [pending, start] = useTransition();
  const viet = () =>
    start(async () => {
      const r = await writeCopyOptionsAction({ imageId, formulas, noPrice });
      if ("error" in r) return void toast.error(r.error);
      setOptions(r.options);
      if (r.priceStripped) toast.warning("Máy đã bỏ con số giá AI lỡ viết — kiểm lại câu chữ.");
    });
  return (
    <div className="space-y-1.5 rounded-lg border border-primary/30 bg-primary/5 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] font-semibold">AI viết theo công thức</p>
        <label className="flex items-center gap-1 text-[11.5px]">
          <input type="checkbox" checked={noPrice} onChange={(e) => setNoPrice(e.target.checked)} /> Không ghi giá
        </label>
      </div>
      <FormulaPicker value={formulas} onChange={setFormulas} disabled={pending} />
      <Button type="button" size="sm" variant="secondary" onClick={viet} disabled={pending || formulas.length === 0}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Viết {formulas.length} phương án
      </Button>
      {options.length ? (
        <div className="space-y-1.5">
          {options.map((o, i) => (
            <div key={i} className="space-y-1 rounded-md border bg-background p-2 text-[12px]">
              <div className="flex items-center justify-between gap-2">
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium">{o.formula && o.formula in COPY_FORMULAS ? COPY_FORMULAS[o.formula as CopyFormula].label : `Phương án ${i + 1}`}</span>
                <Button type="button" size="sm" className="h-6 px-2 text-[11.5px]" onClick={() => onUse({ headline: o.headline, primaryText: o.primaryText })}>
                  Dùng
                </Button>
              </div>
              <p className="font-semibold">{o.headline}</p>
              <p className="line-clamp-5 whitespace-pre-line text-muted-foreground">{o.primaryText}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
