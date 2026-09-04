"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Nút gọi API đồng bộ /api/sync/<job>. Chạy nền (wait=0) hoặc chờ kết quả.
 */
export function SyncButton({
  job,
  label = "Đồng bộ",
  params,
  wait = false,
  variant = "outline",
  size = "sm",
  className,
  icon = true,
  onDone,
}: {
  job: string;
  label?: string;
  params?: Record<string, string>;
  wait?: boolean;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
  className?: string;
  icon?: boolean;
  onDone?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const run = async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ ...(params ?? {}), wait: wait ? "1" : "0" });
      const res = await fetch(`/api/sync/${job}?${query.toString()}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.ok === false) {
        toast.error(body.error || body.message || `Không thể chạy đồng bộ (${res.status})`);
      } else if (body.started) {
        toast.info("Đã bắt đầu đồng bộ nền — kết quả sẽ hiện ở Lịch sử đồng bộ.");
      } else {
        const s = body.result?.summary;
        toast.success(s ? `Xong: mới ${s.imported} · cập nhật ${s.updated} · bỏ qua ${s.skipped} · lỗi ${s.failed}` : "Đồng bộ hoàn tất");
      }
      startTransition(() => router.refresh());
      onDone?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Lỗi mạng");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button variant={variant} size={size} className={cn(className)} onClick={run} disabled={loading}>
      {icon ? loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" /> : null}
      {label}
    </Button>
  );
}
