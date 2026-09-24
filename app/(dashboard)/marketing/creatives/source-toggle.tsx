"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setDailyMockup } from "@/lib/actions/creative-design";
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

/**
 * "Chạy mockup hằng ngày" (chủ shop 24/09/2026): mẫu thắng được bật ⇒ mỗi lô có thêm 1 ô mockup của nó
 * (giữ sản phẩm, đổi một gen), chấm bằng luật riêng suy từ lịch sử 60 ngày của chính mã.
 */
export function MockupToggle({ kind, id, on: initial, canWrite }: { kind: "SOURCE" | "PRODUCT"; id: string; on: boolean; canWrite: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, start] = useTransition();
  return (
    <label
      className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground"
      title={canWrite ? "Mỗi lô thêm 1 ảnh mockup của mẫu này, chấm bằng luật riêng theo lịch sử của mã" : "Cần quyền “Ý tưởng: đăng & sửa”"}
    >
      <Switch
        size="sm"
        checked={on}
        disabled={!canWrite || pending}
        onCheckedChange={(next) =>
          start(async () => {
            setOn(next);
            const r = await setDailyMockup({ kind, id, on: next });
            if ("error" in r) {
              setOn(!next);
              toast.error(r.error);
            }
          })
        }
        aria-label={on ? "Tắt mockup hằng ngày" : "Chạy mockup hằng ngày"}
      />
      {on ? "Mockup hằng ngày" : "Chạy mockup hằng ngày"}
    </label>
  );
}
