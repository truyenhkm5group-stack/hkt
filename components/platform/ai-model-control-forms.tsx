"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { probePlatformAiModelAction, rollbackPlatformAiPolicyAction, setPlatformAiPolicyAction } from "@/lib/actions/platform-ai-model";
import { PILOT_REASON_MIN } from "@/lib/constants/pilot";

/**
 * Bốn nút của Platform AI Model Control: Kiểm tra khả dụng → Chạy thử (canary) → Áp dụng → Hoàn tác. Nút ghi đi qua hộp xác
 * nhận có lý do (vào nhật ký nền tảng); máy chủ kiểm lại mọi điều kiện — nút mờ ở đây chỉ để đỡ bấm thừa.
 */

const CANARY_STEPS = [5, 10, 25, 50] as const;

export function ProbeModelButton({ model, disabled }: { model: string; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [last, setLast] = useState<string | null>(null);
  return (
    <div className="space-y-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || pending}
        data-probe-model={model}
        onClick={() =>
          start(async () => {
            const r = await probePlatformAiModelAction({ model });
            if ("error" in r) {
              toast.error(r.error);
              setLast(r.error);
            } else {
              toast.success(r.message);
              setLast(r.message);
            }
          })
        }
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        1 · Kiểm tra khả dụng {model}
      </Button>
      {last ? <p className="text-[11px] text-muted-foreground">{last}</p> : null}
    </div>
  );
}

export function CanaryForm({ primaryModel, fallbackModel, disabled, currentPct }: { primaryModel: string; fallbackModel: string; disabled?: boolean; currentPct: number | null }) {
  const [pct, setPct] = useState<number>(currentPct && currentPct < 100 ? currentPct : 10);
  return (
    <ConfirmWithReason
      id="platform-ai-canary"
      label="2 · Chạy thử…"
      title={`Chạy thử ${primaryModel} trên ~${pct}% hội thoại AI dùng chung?`}
      consequence={`~${pct}% hội thoại (băm ổn định theo hội thoại) đi ${primaryModel}; lượt nào ${primaryModel} hỏng thì CÙNG lượt đó đi lại bằng ${fallbackModel} trước khi khách thấy gì. Phần còn lại giữ ${fallbackModel}. Hoàn tác được bất cứ lúc nào.`}
      minReason={PILOT_REASON_MIN}
      placeholder="Canary giảm chi phí AI dùng chung"
      disabled={disabled}
      run={(reason) => setPlatformAiPolicyAction({ primaryModel, fallbackModel, canaryPct: pct, reason })}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Label htmlFor="platform-ai-canary-pct">Tỷ lệ chạy thử</Label>
        <select id="platform-ai-canary-pct" className="h-8 rounded-md border bg-background px-2 text-xs" value={pct} onChange={(e) => setPct(Number(e.target.value))} disabled={disabled}>
          {CANARY_STEPS.map((p) => (
            <option key={p} value={p}>
              {p}%
            </option>
          ))}
        </select>
      </div>
    </ConfirmWithReason>
  );
}

export function ApplyForm({ primaryModel, fallbackModel, disabled }: { primaryModel: string; fallbackModel: string; disabled?: boolean }) {
  return (
    <ConfirmWithReason
      id="platform-ai-apply"
      label="3 · Áp dụng 100%…"
      title={`Áp dụng ${primaryModel} cho TOÀN BỘ AI dùng chung?`}
      consequence={`Mọi hội thoại của tổ chức dùng AI dùng chung đi ${primaryModel}; ${fallbackModel} chỉ còn là dự phòng khi ${primaryModel} hỏng. Biến môi trường PLATFORM_AI_MODEL không đổi — Hoàn tác trả về bản trước ngay, không cần deploy.`}
      minReason={PILOT_REASON_MIN}
      placeholder="Canary ổn: lỗi không tăng, chi phí giảm"
      disabled={disabled}
      run={(reason) => setPlatformAiPolicyAction({ primaryModel, fallbackModel, canaryPct: 100, reason })}
    />
  );
}

export function RollbackForm({ disabled, hint }: { disabled?: boolean; hint: string }) {
  return (
    <ConfirmWithReason
      id="platform-ai-rollback"
      label="4 · Hoàn tác…"
      title="Hoàn tác chính sách model AI dùng chung?"
      consequence={hint}
      minReason={PILOT_REASON_MIN}
      placeholder="Lỗi tăng sau khi đổi model"
      variant="destructive"
      disabled={disabled}
      run={(reason) => rollbackPlatformAiPolicyAction({ reason })}
    />
  );
}
