"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { setGraduationAction } from "@/lib/actions/mission-control";
import type { AgentZone } from "@/lib/constants/department-ai";
import type { GraduationRule } from "@/lib/constants/mission-control";

/**
 * Khai / sửa / xoá điều kiện «tốt nghiệp» của MỘT agent. Ô trống ban đầu khi chưa khai — KHÔNG điền sẵn con số nào (luật 38/43).
 * Lưu điều kiện không đổi nấc tự chủ.
 */
export function GraduationForm({ zone, label, rule }: { zone: AgentZone; label: string; rule: GraduationRule | null }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, start] = React.useTransition();
  const [pct, setPct] = React.useState(rule ? String(rule.minAccuracyPct) : "");
  const [samples, setSamples] = React.useState(rule ? String(rule.minSamples) : "");
  const [days, setDays] = React.useState(rule ? String(rule.windowDays) : "");

  const save = (next: GraduationRule | null) =>
    start(async () => {
      const r = await setGraduationAction(zone, next);
      if (!r.ok) return void toast.error(r.error);
      if (r.changed) toast.success(r.message);
      else toast.info(r.message);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="ghost" className="h-6 px-1.5 text-xs" onClick={() => setOpen(true)}>
        {rule ? "Sửa điều kiện" : "Khai điều kiện"}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Điều kiện tốt nghiệp · {label}</DialogTitle>
            <DialogDescription>Đích là quyết định của chủ shop — không có số mặc định. Đủ điều kiện chỉ là thông tin: đổi nấc tự chủ vẫn do người quyết và cần cập nhật phần mềm.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 text-sm">
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Tỷ lệ đúng tối thiểu (%)</span>
              <Input inputMode="decimal" aria-label="Tỷ lệ đúng tối thiểu" value={pct} onChange={(e) => setPct(e.target.value)} />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Số mẫu tối thiểu</span>
              <Input inputMode="numeric" aria-label="Số mẫu tối thiểu" value={samples} onChange={(e) => setSamples(e.target.value)} />
            </label>
            <label className="grid gap-1">
              <span className="text-xs text-muted-foreground">Cửa sổ (ngày gần nhất)</span>
              <Input inputMode="numeric" aria-label="Cửa sổ ngày" value={days} onChange={(e) => setDays(e.target.value)} />
            </label>
          </div>
          <DialogFooter>
            {rule ? (
              <Button variant="ghost" disabled={pending} onClick={() => save(null)}>
                Xoá điều kiện
              </Button>
            ) : null}
            <Button disabled={pending} onClick={() => save({ minAccuracyPct: Number(pct), minSamples: Number(samples), windowDays: Number(days) })}>
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
