"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setCreativeSourceActive } from "@/lib/actions/creative-sources";

/** Bật / tắt một nguồn — vá tại chỗ, không tải lại trang (docs/design-system.md §7). */
export function SourceToggle({ id, active, canWrite }: { id: string; active: boolean; canWrite: boolean }) {
  const [on, setOn] = useState(active);
  const [pending, start] = useTransition();
  return (
    <label className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground" title={canWrite ? undefined : "Cần quyền “Ý tưởng: đăng & sửa”"}>
      <Switch
        size="sm"
        checked={on}
        disabled={!canWrite || pending}
        onCheckedChange={(next) =>
          start(async () => {
            setOn(next);
            const r = await setCreativeSourceActive({ id, active: next });
            if ("error" in r) {
              setOn(!next);
              toast.error(r.error);
            }
          })
        }
        aria-label={on ? "Tắt nguồn này" : "Bật nguồn này"}
      />
      {on ? "Đang dùng" : "Đã tắt"}
    </label>
  );
}
