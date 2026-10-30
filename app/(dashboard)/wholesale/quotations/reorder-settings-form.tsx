"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveWholesaleReorderSettingsAction } from "@/lib/actions/wholesale-order-close";

/** «Nhắc mua lại khách sỉ sau X ngày» — chỉ người cấu hình. Không số mặc định: trống = không nhắc. Việc hiện ở /work (phòng Kinh doanh). */
export function ReorderSettingsForm({ afterDays }: { afterDays: number | null }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [days, setDays] = useState(afterDays === null ? "" : String(afterDays));
  const [reason, setReason] = useState("");
  const save = () =>
    start(async () => {
      const r = await saveWholesaleReorderSettingsAction({ afterDays: days.trim() ? Number(days) : null, reason });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu nhắc mua lại khách sỉ.");
        setReason("");
        router.refresh();
      }
    });
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm" data-wholesale-reorder-settings>
      <span className="font-semibold">Nhắc mua lại khách sỉ</span>
      <span className="text-muted-foreground">{afterDays === null ? "— chưa khai (không có việc nhắc nào)" : `— sau ${afterDays} ngày kể từ đơn gần nhất (việc ở /work, phòng Kinh doanh)`}</span>
      <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Số ngày (trống = tắt)" className="h-8 w-40" aria-label="Số ngày nhắc mua lại" />
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do (bắt buộc)" className="h-8 w-56" aria-label="Lý do" />
      <Button size="sm" variant="outline" disabled={pending} onClick={save}>
        Lưu
      </Button>
    </div>
  );
}
