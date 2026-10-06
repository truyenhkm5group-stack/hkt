"use client";

import { Loader2 } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { reclassifyTechTaskPolicyAction, setTechBudgetAction } from "@/lib/actions/tech-control-plane";
import type { TechBudgetLimits, TechBudgetScope } from "@/lib/constants/tech-policy";

const O: { key: keyof TechBudgetLimits; label: string; hint: string; step: string }[] = [
  { key: "apiUsdDaily", label: "Trần chi API / ngày (USD)", hint: "Bỏ trống = CHƯA KHAI ⇒ worker API không chạy", step: "0.01" },
  { key: "apiUsdTotal", label: "Trần chi API tổng (USD)", hint: "Bỏ trống = không trần tổng", step: "0.01" },
  { key: "maxRunMinutes", label: "Phút tối đa / lượt", hint: "5–240, mặc định 45", step: "1" },
  { key: "maxAttempts", label: "Lần thử tối đa / việc", hint: "1–10, mặc định 3", step: "1" },
  { key: "maxConcurrentRuns", label: "Lượt chạy đồng thời", hint: "1–16, mặc định 4 (cấp công ty)", step: "1" },
];

/**
 * Ngân sách của MỘT phạm vi. Ô trống = CHƯA KHAI (không phải 0) — tầng rộng hơn (hoặc mặc định) áp dụng. Riêng
 * tiền API: chưa khai ở đâu cả ⇒ không chi.
 */
export function BudgetForm({ scopeKind, scopeId, current, fields }: { scopeKind: TechBudgetScope; scopeId?: string; current: TechBudgetLimits | null; fields?: (keyof TechBudgetLimits)[] }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(O.map((o) => [o.key, current?.[o.key] === null || current?.[o.key] === undefined ? "" : String(current[o.key])])));
  const [pending, start] = useTransition();
  const hien = O.filter((o) => !fields || fields.includes(o.key));
  const so = (s: string) => (s.trim() === "" ? null : Number(s));
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {hien.map((o) => (
          <div key={o.key} className="space-y-1">
            <Label className="text-xs">{o.label}</Label>
            <Input type="number" inputMode="decimal" step={o.step} value={v[o.key]} onChange={(e) => setV((x) => ({ ...x, [o.key]: e.target.value }))} placeholder="chưa khai" />
            <p className="text-[11px] text-muted-foreground">{o.hint}</p>
          </div>
        ))}
      </div>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const body = Object.fromEntries(hien.map((o) => [o.key, so(v[o.key])]));
            const res = await setTechBudgetAction({ scopeKind, scopeId: scopeId ?? null, ...body });
            if ("error" in res) toast.error(res.error);
            else toast.success("Đã lưu ngân sách");
          })
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu ngân sách
      </Button>
    </div>
  );
}

/** Máy xếp lại mức chính sách R0–R4 (việc trước 0227 chưa có mức ⇒ không tự động cho tới khi xếp). */
export function PolicyReclassify({ taskId }: { taskId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reclassifyTechTaskPolicyAction({ taskId });
          if ("error" in res) toast.error(res.error);
          else toast.success(`Chính sách: ${res.level}`);
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null} Xếp lại chính sách
    </Button>
  );
}
