"use client";

import { useState } from "react";
import { Globe2, Store, Users } from "lucide-react";
import { CampaignForm, type CampaignFormDefaults } from "@/app/(dashboard)/wholesale/lead-hunter/campaign-form";
import { cn } from "@/lib/utils";

/**
 * «Bắt đầu quét mới» = ba thẻ mẫu lớn (chủ shop 30/10/2026). Bấm một thẻ ⇒ form ba bước (khu vực · xem trước · lưu) điền sẵn
 * giá trị của mẫu; mọi tuỳ chỉnh khác gập trong «Tuỳ chỉnh nâng cao». Đổi thẻ ⇒ form dựng lại với giá trị của thẻ mới.
 */

export type StartPreset = {
  key: "domestic" | "viet-kieu" | "importers";
  title: string;
  subtitle: string;
  /** «119 truy vấn · 4,17–12,50 US$» — ước tính của phạm vi mặc định (campaignCostEstimate). */
  estimate: string;
  defaults: CampaignFormDefaults;
};

const ICON = { domestic: Store, "viet-kieu": Users, importers: Globe2 } as const;

type FormProps = Omit<React.ComponentProps<typeof CampaignForm>, "defaults">;

export function StartScan({ presets, form }: { presets: StartPreset[]; form: FormProps }) {
  const [picked, setPicked] = useState<StartPreset["key"] | null>(null);
  const cur = presets.find((p) => p.key === picked) ?? null;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-3">
        {presets.map((p) => {
          const Icon = ICON[p.key];
          const on = p.key === picked;
          return (
            <button key={p.key} type="button" onClick={() => setPicked(on ? null : p.key)} aria-pressed={on} className={cn("flex flex-col gap-1.5 rounded-xl border p-4 text-left transition hover:border-primary", on && "border-primary bg-primary/5 ring-1 ring-primary")}>
              <span className="flex items-center gap-2 font-semibold">
                <Icon className="h-5 w-5 text-primary" aria-hidden />
                {p.title}
              </span>
              <span className="text-xs text-muted-foreground">{p.subtitle}</span>
              <span className="mt-auto text-[11px] tabular-nums text-muted-foreground">Phạm vi mẫu: {p.estimate}</span>
            </button>
          );
        })}
      </div>
      {cur ? <CampaignForm key={cur.key} {...form} defaults={cur.defaults} /> : <p className="text-xs text-muted-foreground">Chọn một thẻ để mở form ba bước: chọn khu vực → xem trước số truy vấn và chi phí → lưu nháp hoặc bắt đầu.</p>}
    </div>
  );
}
