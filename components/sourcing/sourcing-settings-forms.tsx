"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveLandedCostAction, saveScoreWeightsAction, saveSourcingLimitsAction, type SourcingSettingsResult } from "@/lib/actions/sourcing-settings";
import {
  LANDED_COST_FIELDS,
  SUPPLIER_SCORE_COMPONENTS,
  SUPPLIER_SCORE_LABEL,
  type LandedCostConfig,
  type LandedCostNumberKey,
  type SourcingLimits,
  type SourcingScoreWeights,
  type SupplierScoreComponent,
} from "@/lib/constants/sourcing";

/** Ô số: trống ⇒ `null` (CHƯA KHAI), không bao giờ 0. */
function numOrNull(raw: string): number | null {
  const v = raw.trim().replace(/\s/g, "").replace(",", ".");
  return v === "" || !/^\d+(\.\d+)?$/.test(v) ? null : Number(v);
}

function useRun() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<SourcingSettingsResult>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.errors[0]?.message ?? "Không lưu được.");
    });
  return { pending, run };
}

export function SourcingLimitsForm({ initial }: { initial: SourcingLimits }) {
  const [calls, setCalls] = useState(String(initial.aiCallsPerDay));
  const [reason, setReason] = useState("");
  const { pending, run } = useRun();
  return (
    <div className="grid gap-3 text-sm md:grid-cols-3 md:items-end" data-sourcing-limits-form>
      <div className="space-y-1">
        <Label htmlFor="src-calls">Lượt AI tối đa / ngày</Label>
        <Input id="src-calls" inputMode="numeric" value={calls} onChange={(e) => setCalls(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="src-calls-reason">Lý do *</Label>
        <Input id="src-calls-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </div>
      <Button disabled={pending} onClick={() => run(() => saveSourcingLimitsAction({ aiCallsPerDay: Number(calls), reason }))}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu trần
      </Button>
    </div>
  );
}

export function LandedCostForm({ initial }: { initial: LandedCostConfig }) {
  const [values, setValues] = useState<Record<LandedCostNumberKey, string>>(() => {
    const out = {} as Record<LandedCostNumberKey, string>;
    for (const f of LANDED_COST_FIELDS) if (f.key !== "fxAsOf") out[f.key] = initial[f.key] === null ? "" : String(initial[f.key]);
    return out;
  });
  const [fxAsOf, setFxAsOf] = useState(initial.fxAsOf ?? "");
  const [fxSource, setFxSource] = useState(initial.fxSource);
  const [reason, setReason] = useState("");
  const { pending, run } = useRun();
  const save = () =>
    run(() =>
      saveLandedCostAction({
        cnyToVnd: numOrNull(values.cnyToVnd),
        fxAsOf: fxAsOf.trim() === "" ? null : fxAsOf.trim(),
        fxSource,
        cnDomesticShipCny: numOrNull(values.cnDomesticShipCny),
        intlFreightVndPerKg: numOrNull(values.intlFreightVndPerKg),
        agentFeePercent: numOrNull(values.agentFeePercent),
        dutyVatPercent: numOrNull(values.dutyVatPercent),
        otherVndPerUnit: numOrNull(values.otherVndPerUnit),
        reason,
      }),
    );
  return (
    <div className="space-y-3 text-sm" data-landed-cost-form>
      <div className="grid gap-3 md:grid-cols-3">
        {LANDED_COST_FIELDS.map((f) =>
          f.key === "fxAsOf" ? (
            <div key={f.key} className="space-y-1">
              <Label htmlFor="src-fx-asof">
                {f.label} ({f.unit})
              </Label>
              <Input id="src-fx-asof" type="date" value={fxAsOf} onChange={(e) => setFxAsOf(e.target.value)} />
            </div>
          ) : (
            <div key={f.key} className="space-y-1">
              <Label htmlFor={`src-${f.key}`}>
                {f.label} ({f.unit})
              </Label>
              <Input
                id={`src-${f.key}`}
                inputMode="decimal"
                placeholder="chưa khai"
                value={values[f.key as LandedCostNumberKey]}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
              />
            </div>
          ),
        )}
        <div className="space-y-1">
          <Label htmlFor="src-fx-source">Nguồn tỷ giá</Label>
          <Input id="src-fx-source" value={fxSource} onChange={(e) => setFxSource(e.target.value)} maxLength={200} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3 md:items-end">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="src-landed-reason">Lý do *</Label>
          <Input id="src-landed-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
        <Button disabled={pending} onClick={save}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Lưu tham số
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Ô để trống là CHƯA KHAI — khác 0. Thiếu ô nào thì giá về Việt Nam in «chưa đủ tham số», không tính bừa.</p>
    </div>
  );
}

export function ScoreWeightsForm({ initial }: { initial: SourcingScoreWeights }) {
  const [w, setW] = useState<Record<SupplierScoreComponent, string>>(() => {
    const out = {} as Record<SupplierScoreComponent, string>;
    for (const k of SUPPLIER_SCORE_COMPONENTS) out[k] = initial.supplier[k] === null ? "" : String(initial.supplier[k]);
    return out;
  });
  const [cap, setCap] = useState(initial.yearsCap === null ? "" : String(initial.yearsCap));
  const [reason, setReason] = useState("");
  const { pending, run } = useRun();
  const save = () =>
    run(() =>
      saveScoreWeightsAction({
        supplier: { rating: numOrNull(w.rating), responseRate: numOrNull(w.responseRate), verified: numOrNull(w.verified), years: numOrNull(w.years) },
        yearsCap: cap.trim() === "" || !/^\d+$/.test(cap.trim()) ? null : Number(cap.trim()),
        reason,
      }),
    );
  return (
    <div className="space-y-3 text-sm" data-score-weights-form>
      <div className="grid gap-3 md:grid-cols-5">
        {SUPPLIER_SCORE_COMPONENTS.map((k) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`src-w-${k}`}>Trọng số: {SUPPLIER_SCORE_LABEL[k]}</Label>
            <Input id={`src-w-${k}`} inputMode="decimal" placeholder="không tính" value={w[k]} onChange={(e) => setW((x) => ({ ...x, [k]: e.target.value }))} />
          </div>
        ))}
        <div className="space-y-1">
          <Label htmlFor="src-w-cap">Trần số năm (coi là «đủ»)</Label>
          <Input id="src-w-cap" inputMode="numeric" placeholder="chưa khai" value={cap} onChange={(e) => setCap(e.target.value)} />
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-3 md:items-end">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="src-w-reason">Lý do *</Label>
          <Input id="src-w-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </div>
        <Button disabled={pending} onClick={save}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Lưu trọng số
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">Để trống hết là KHÔNG tính điểm tổng — màn hình chỉ hiện từng thành phần. Không có bộ trọng số mặc định.</p>
    </div>
  );
}
