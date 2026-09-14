"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveShadowLabel } from "@/lib/actions/ai-review";
import { Button } from "@/components/ui/button";

/** Ba trạng thái, KHÔNG phải hai: chưa chấm · đúng · sai. Bỏ trạng thái "chưa chấm" là ép người
 *  soát phải nói dối ở những ô không áp dụng cho lượt đó. */
type Verdict = boolean | null;

const FIELDS: { key: string; label: string }[] = [
  { key: "productOk", label: "Sản phẩm" },
  { key: "colorOk", label: "Màu" },
  { key: "sizeOk", label: "Size" },
  { key: "phoneOk", label: "SĐT" },
  { key: "addressOk", label: "Địa chỉ" },
  { key: "intentOk", label: "Ý định" },
  { key: "purchaseIntentOk", label: "Ý muốn mua" },
  { key: "confirmationOk", label: "Xác nhận chốt" },
  { key: "replyUsable", label: "Câu dùng được" },
];

function Tri({ value, onChange, label }: { value: Verdict; onChange: (v: Verdict) => void; label: string }) {
  const cell = "rounded px-1.5 py-0.5 text-[11px] font-semibold border";
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex gap-1">
        <button type="button" onClick={() => onChange(value === true ? null : true)} className={`${cell} ${value === true ? "border-emerald-500 bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" : "border-border text-muted-foreground"}`}>
          đúng
        </button>
        <button type="button" onClick={() => onChange(value === false ? null : false)} className={`${cell} ${value === false ? "border-rose-500 bg-rose-50 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300" : "border-border text-muted-foreground"}`}>
          sai
        </button>
      </div>
    </div>
  );
}

export function LabelForm({ suggestionId, initial }: { suggestionId: string; initial: Record<string, unknown> }) {
  const [values, setValues] = useState<Record<string, Verdict>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, (initial[f.key] as Verdict) ?? null])),
  );
  const [quality, setQuality] = useState<string | null>((initial.nextActionQuality as string) ?? null);
  const [hallucination, setHallucination] = useState<Verdict>((initial.hallucination as Verdict) ?? null);
  const [note, setNote] = useState(String(initial.note ?? ""));
  const [pending, start] = useTransition();

  const submit = () => {
    start(async () => {
      const result = await saveShadowLabel({ suggestionId, ...values, nextActionQuality: quality, hallucination, note });
      if ("error" in result) toast.error(result.error);
      else toast.success("Đã lưu kết quả chấm");
    });
  };

  return (
    <div className="space-y-2 rounded-lg border border-border/60 p-3">
      <p className="text-xs font-semibold">Chấm tay (để trống = chưa chấm)</p>
      <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
        {FIELDS.map((f) => (
          <Tri key={f.key} label={f.label} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-xs text-muted-foreground">Hành động kế tiếp:</span>
        {(["GOOD", "ACCEPTABLE", "WRONG"] as const).map((q) => (
          <button key={q} type="button" onClick={() => setQuality(quality === q ? null : q)} className={`rounded px-2 py-0.5 text-[11px] font-semibold border ${quality === q ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}>
            {q === "GOOD" ? "tốt" : q === "ACCEPTABLE" ? "tạm được" : "sai"}
          </button>
        ))}
        <Tri label="Bịa / phá luật" value={hallucination} onChange={setHallucination} />
      </div>
      <textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded-md border border-border bg-background p-2 text-xs" rows={2} />
      <Button size="sm" onClick={submit} disabled={pending}>
        {pending ? "Đang lưu…" : "Lưu kết quả chấm"}
      </Button>
    </div>
  );
}
