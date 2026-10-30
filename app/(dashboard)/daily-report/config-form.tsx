"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setDailyReportConfigAction } from "@/lib/actions/daily-report";
import type { DailyReportConfig } from "@/lib/constants/daily-report";

/** Bật / tắt + giờ chạy + trần chi phí AI / ngày. Ô trống ban đầu khi chưa khai — KHÔNG điền sẵn giờ hay trần nào. */
export function DailyReportConfigForm({ current }: { current: DailyReportConfig }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const [on, setOn] = React.useState(current.on);
  const [hour, setHour] = React.useState(current.hourVn === null ? "" : String(current.hourVn));
  const [cap, setCap] = React.useState(current.maxCostUsdPerDay === null ? "" : String(current.maxCostUsdPerDay));
  const save = () =>
    start(async () => {
      const r = await setDailyReportConfigAction({ on, hourVn: hour.trim() === "" ? null : Number(hour), maxCostUsdPerDay: cap.trim() === "" ? null : Number(cap.replace(",", ".")) });
      if (!r.ok) return void toast.error(r.error);
      if (r.changed) toast.success(r.message);
      else toast.info(r.message);
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-end gap-3 text-sm">
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label="Bật báo cáo ngày" />
        <span>Bật báo cáo ngày</span>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Giờ chạy (giờ VN, 0–23)</span>
        <Input className="h-8 w-24" inputMode="numeric" aria-label="Giờ chạy" value={hour} onChange={(e) => setHour(e.target.value)} />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-muted-foreground">Trần chi phí AI / ngày (USD — trống = không gọi AI)</span>
        <Input className="h-8 w-28" inputMode="decimal" aria-label="Trần chi phí AI mỗi ngày" value={cap} onChange={(e) => setCap(e.target.value)} />
      </label>
      <Button size="sm" disabled={pending} onClick={save}>
        Lưu
      </Button>
    </div>
  );
}
