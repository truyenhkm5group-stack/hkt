"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { SectionCard } from "@/components/ui-bits";
import { saveFollowupSettingsAction } from "@/lib/actions/sales-chatbot";
import { followupStepsLabel, FOLLOWUP_MAX_STEPS, type FollowupSettings } from "@/lib/sales-chatbot/followup-shared";

/**
 * FOLLOW-UP TỰ ĐỘNG (0185): công tắc + lịch (giờ, tính từ lúc khách bắt đầu im lặng) + số hội thoại đang chờ khách. Không
 * `router.refresh()` sau action — action đã `revalidatePath`.
 */
export function FollowupPanel({ settings, waiting, manage }: { settings: FollowupSettings; waiting: number; manage: boolean }) {
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [hours, setHours] = useState<string[]>(Array.from({ length: FOLLOWUP_MAX_STEPS }, (_, i) => (settings.stepsMinutes[i] !== undefined ? String(settings.stepsMinutes[i] / 60) : "")));
  const steps = hours.map((h) => h.trim()).filter(Boolean).map((h) => Math.round(Number(h.replace(",", ".")) * 60));
  const dirty = enabled !== settings.enabled || steps.join(",") !== settings.stepsMinutes.join(",");
  return (
    <SectionCard
      title="Follow-up tự động"
      description={`${settings.enabled ? `Đang bật · ${followupStepsLabel(settings.stepsMinutes)}` : "Đang tắt"} · ${waiting} hội thoại đang chờ khách`}
      hint="Khách im lặng ở bất kỳ bước nào (đang tư vấn, đã cho SĐT chưa chốt, từ chối upsell chưa xác nhận…) ⇒ AI nhắc theo lịch, đúng giọng sổ tay, không nêu giá. Dừng khi khách nhắn lại, chốt đơn, từ chối rõ hoặc cần người xử lý. Facebook chỉ cho nhắn trong 24 giờ kể từ tin cuối của khách — mốc muộn nhất 23 giờ."
    >
      <div className="flex flex-wrap items-end gap-3 text-sm" data-testid="followup-panel">
        <label className="flex items-center gap-2">
          <Switch checked={enabled} disabled={!manage || pending} onCheckedChange={setEnabled} aria-label="Bật follow-up tự động" />
          Bật
        </label>
        {hours.map((h, i) => (
          <label key={i} className="space-y-0.5 text-xs">
            <span className="block text-muted-foreground">Lần {i + 1} (giờ)</span>
            <Input
              value={h}
              onChange={(e) => setHours(hours.map((x, j) => (j === i ? e.target.value : x)))}
              disabled={!manage || pending}
              inputMode="decimal"
              className="h-8 w-20"
              aria-label={`Follow-up lần ${i + 1} sau bao nhiêu giờ`}
            />
          </label>
        ))}
        {manage ? (
          <Button
            size="sm"
            disabled={pending || !dirty}
            onClick={() =>
              start(async () => {
                const r = await saveFollowupSettingsAction({ enabled, stepsMinutes: steps });
                if ("error" in r) toast.error(r.error);
                else toast.success(r.message);
              })
            }
          >
            Lưu
          </Button>
        ) : null}
      </div>
    </SectionCard>
  );
}
