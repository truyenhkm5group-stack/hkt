"use client";

import { Factory, Loader2 } from "lucide-react";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setDesignProduction } from "@/lib/actions/creative-design";

/** "Đưa vào sản xuất" — trạng thái chỉ NGƯỜI đặt; máy không bao giờ tự đặt (docs/creative-loop.md §5f). */
export function DesignProductionButton({ id, code, production, canEdit }: { id: string; code: string; production: boolean; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!canEdit) return null;
  return (
    <Button
      type="button"
      size="sm"
      variant={production ? "outline" : "secondary"}
      className="h-7 px-2 text-[11.5px]"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await setDesignProduction({ id, on: !production });
          if ("error" in r) toast.error(r.error);
          else {
            toast.success(production ? `${code}: đã bỏ đánh dấu sản xuất` : `${code}: đã đánh dấu đưa vào sản xuất`);
            router.refresh();
          }
        })
      }
    >
      {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Factory className="size-3.5" />}
      {production ? "Bỏ sản xuất" : "Đưa vào sản xuất"}
    </Button>
  );
}
