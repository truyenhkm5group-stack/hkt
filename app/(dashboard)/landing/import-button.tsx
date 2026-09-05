"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { runLandingImport } from "@/lib/actions/landing";

export function ImportButton({ configured }: { configured: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  return (
    <Button
      size="sm"
      disabled={pending || !configured}
      title={configured ? "Đọc lại Google Sheet ngay" : "Cấu hình link sheet trước"}
      onClick={() =>
        start(async () => {
          const r = await runLandingImport();
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(`Đã đọc sheet: ${r.summary}`);
            router.refresh();
          }
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Đọc sheet ngay
    </Button>
  );
}
