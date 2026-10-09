"use client";

import { useState, useTransition } from "react";
import { Check, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { setExperiencePresetAction } from "@/lib/actions/experience-profile";
import { EXPERIENCE_PRESETS, EXPERIENCE_PROFILES, type ExperiencePreset } from "@/lib/constants/experience-profile";
import { cn } from "@/lib/utils";

/** Một dòng mô tả cho mỗi ngành — người chọn thấy NGAY khác biệt, không phải đọc tài liệu. */
function summary(preset: ExperiencePreset) {
  const p = EXPERIENCE_PROFILES[preset];
  return `${p.variantTerm}: ${p.variantFields.map((f) => f.label).join(" · ")} · đơn vị mặc định «${p.defaultUnit}»`;
}

/** Chọn ngành của tổ chức — ba thẻ bấm thẳng, chọn là có hiệu lực (ghi vào `settings` của chính tổ chức, có nhật ký). */
export function ExperiencePresetPicker({ current, overridden }: { current: ExperiencePreset; overridden: boolean }) {
  const [pending, start] = useTransition();
  const [value, setValue] = useState(current);
  const choose = (preset: ExperiencePreset | null) =>
    start(async () => {
      const r = await setExperiencePresetAction({ preset });
      if ("error" in r) return void toast.error(r.error);
      if (preset) setValue(preset);
      toast.success(preset ? `Đã chuyển giao diện sang «${EXPERIENCE_PROFILES[preset].label}».` : "Đã quay về theo mẫu ngành của tổ chức.");
    });
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {EXPERIENCE_PRESETS.map((preset) => {
          const active = preset === value;
          return (
            <button
              key={preset}
              type="button"
              disabled={pending}
              aria-pressed={active}
              onClick={() => !active && choose(preset)}
              className={cn("rounded-xl border p-3 text-left transition-colors", active ? "border-primary bg-primary/5" : "hover:bg-muted")}
            >
              <span className="flex items-center gap-1.5 text-sm font-semibold">
                {active ? <Check className="size-4 text-primary" /> : null}
                {EXPERIENCE_PROFILES[preset].label}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">{summary(preset)}</span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        {pending ? <Loader2 className="size-3.5 animate-spin" /> : null}
        {overridden ? (
          <button type="button" className="font-medium underline underline-offset-2 hover:text-foreground" disabled={pending} onClick={() => choose(null)}>
            Bỏ chọn tay — theo mẫu ngành của tổ chức
          </button>
        ) : (
          <span>Đang theo mẫu ngành của tổ chức.</span>
        )}
      </div>
    </div>
  );
}
