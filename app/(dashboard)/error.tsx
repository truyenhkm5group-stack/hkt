"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 rounded-xl border border-dashed p-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-6" />
      </span>
      <div>
        <h2 className="text-lg font-bold">Có lỗi khi tải trang</h2>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{error.message || "Lỗi không xác định."} Nếu lỗi liên quan cơ sở dữ liệu, kiểm tra DATABASE_URL và xem log server.</p>
        {error.digest ? <p className="mt-1 font-mono text-[11px] text-muted-foreground">Mã lỗi: {error.digest}</p> : null}
      </div>
      <Button onClick={reset} variant="outline">
        <RotateCcw className="size-4" /> Thử lại
      </Button>
    </div>
  );
}
