"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Save, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveSlowMovingRules } from "@/lib/actions/slow-moving";
import { DEFAULT_SLOW_MOVING_RULES, SLOW_MOVING_RULE_KEYS, SLOW_MOVING_RULE_LABEL, type SlowMovingRuleKey, type SlowMovingRules } from "@/lib/constants/slow-moving";

/**
 * Ô chỉnh NGƯỠNG hàng chậm / vốn nằm chết (`inventory.slowMoving`). Mặc định lấy từ mã, lưu THƯA —
 * chỉ ô khác mặc định. Bộ sai thứ tự bị máy chủ từ chối cả bộ, không sửa hộ.
 */
export function SlowMovingRulesEditor({ rules, overridden, ignored, canWrite }: { rules: SlowMovingRules; overridden: SlowMovingRuleKey[]; ignored: string | null; canWrite: boolean }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Record<SlowMovingRuleKey, string>>(() => Object.fromEntries(SLOW_MOVING_RULE_KEYS.map((k) => [k, String(rules[k])])) as Record<SlowMovingRuleKey, string>);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () =>
    startTransition(async () => {
      const payload = Object.fromEntries(SLOW_MOVING_RULE_KEYS.map((k) => [k, form[k].trim() === "" ? Number.NaN : Number(form[k])]));
      const r = await saveSlowMovingRules(payload);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu ngưỡng hàng chậm");
        setOpen(false);
        router.refresh();
      }
    });

  return (
    <div className="rounded-xl border bg-card p-4 text-[13px] shadow-xs">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
        <span className="font-semibold">Ngưỡng hàng chậm:</span>
        <span>Hàng chết sau <b>{rules.deadDays} ngày</b> không bán</span>
        <span>Vốn nằm chết khi đủ bán quá <b>{rules.excessCoverDays} ngày</b></span>
        <span>Bán chậm khi quá <b>{rules.slowCoverDays} ngày</b></span>
        <span>Mức lành mạnh <b>{rules.healthyCoverDays} ngày</b></span>
        {overridden.length ? <span className="text-muted-foreground">({overridden.length} ô đã chỉnh khác mặc định)</span> : null}
        {canWrite ? (
          <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => setOpen((v) => !v)}>
            <Settings2 className="size-4" /> {open ? "Đóng" : "Sửa ngưỡng"}
          </Button>
        ) : null}
      </div>
      {ignored ? <p className="mt-2 text-xs text-rose-600">Ghi đè đang lưu bị BỎ nguyên bộ ({ignored}) — đang dùng mặc định trong mã.</p> : null}
      {open ? (
        <div className="mt-4 space-y-3 border-t pt-4">
          <div className="grid gap-3 sm:grid-cols-4">
            {SLOW_MOVING_RULE_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <Label>{SLOW_MOVING_RULE_LABEL[k]}</Label>
                <Input type="number" min={1} value={form[k]} placeholder={String(DEFAULT_SLOW_MOVING_RULES[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
                <p className="text-[10.5px] text-muted-foreground">mặc định {DEFAULT_SLOW_MOVING_RULES[k]}</p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">Thứ tự bắt buộc: mức lành mạnh ≤ bán chậm &lt; vốn nằm chết. Chỉ ô khác mặc định được lưu; đổi mặc định trong mã vẫn tới được các ô chưa chỉnh.</p>
            <Button type="button" size="sm" onClick={save} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
