"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DatabaseZap, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Đồng bộ toàn bộ Pancake theo lịch sử N ngày: gọi /api/sync/pancake-all?backfill=1&days=N (chạy nền).
 */
export function BackfillForm({ defaultDays, disabled, running }: { defaultDays: number; disabled?: boolean; running?: boolean }) {
  const [days, setDays] = useState(String(defaultDays));
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const run = async () => {
    const n = Number(days);
    if (!Number.isInteger(n) || n < 1 || n > 3650) {
      toast.error("Số ngày phải từ 1 đến 3650");
      return;
    }
    setLoading(true);
    try {
      const query = new URLSearchParams({ backfill: "1", days: String(n), wait: "0" });
      const res = await fetch(`/api/sync/pancake-all?${query.toString()}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) toast.error(body.error || body.message || `Không thể chạy đồng bộ (${res.status})`);
      else toast.info(`Đã bắt đầu đồng bộ lịch sử ${n} ngày ở chế độ nền — theo dõi tiến độ ở Lịch sử đồng bộ.`);
      startTransition(() => router.refresh());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="backfill-days" className="text-xs text-muted-foreground">
          Số ngày lịch sử
        </Label>
        <Input id="backfill-days" type="number" min={1} max={3650} value={days} onChange={(e) => setDays(e.target.value)} className="h-9 w-28" />
      </div>
      <Button type="submit" disabled={loading || disabled}>
        {loading || running ? <Loader2 className="size-4 animate-spin" /> : <DatabaseZap className="size-4" />}
        {running ? "Đang đồng bộ lịch sử…" : "Đồng bộ toàn bộ Pancake (lịch sử)"}
      </Button>
    </form>
  );
}
