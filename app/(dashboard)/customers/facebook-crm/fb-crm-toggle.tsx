"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { fbCrmSetEnabledAction } from "@/lib/actions/fb-crm";

/**
 * Công tắc «Bật / Tắt Facebook Friend CRM» của tổ chức. Trang chỉ dựng nó cho người có `settings:manage`; server action vẫn tự kiểm
 * quyền (nút còn sót trên trình duyệt không mở được tính năng). Người không có quyền thấy câu «nhờ quản trị bật» thay cho công tắc.
 */
export function FbCrmToggle({ on, canManage }: { on: boolean; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  if (!canManage) {
    return on ? null : <p className="text-sm text-muted-foreground">Bạn không có quyền bật tính năng này — nhờ quản trị cài đặt của tổ chức bật «Facebook Friend CRM».</p>;
  }
  return (
    <label className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
      <Switch
        checked={on}
        disabled={pending}
        aria-label="Bật / Tắt Facebook Friend CRM"
        onCheckedChange={(next) =>
          start(async () => {
            const r = await fbCrmSetEnabledAction(next);
            if (!r.ok) return void toast.error(r.error);
            if (r.changed) toast.success(r.message);
            else toast.info(r.message);
            router.refresh();
          })
        }
      />
      <span className="font-medium">{on ? "Đang bật Facebook Friend CRM" : "Bật Facebook Friend CRM"}</span>
    </label>
  );
}
