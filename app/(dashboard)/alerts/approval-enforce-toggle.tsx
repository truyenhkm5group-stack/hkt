"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { setApprovalEnforce } from "@/lib/actions/approvals";

/**
 * Một công tắc cho MỘT nhóm. BẬT phải xác nhận bằng chữ — đây là thứ đổi AI được làm việc một mình
 * trong cả shop, không phải một ô tuỳ chọn giao diện. TẮT thì không hỏi: tắt chỉ trả về hành vi cũ.
 */
export function ApprovalEnforceToggle({ group, label, enforced, disabled }: { group: string; label: string; enforced: boolean; disabled?: boolean }) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const doi = (bat: boolean) => {
    if (
      bat &&
      !window.confirm(
        `BẬT cưỡng chế cho nhóm "${label}"?\n\nTừ lượt sau, mọi việc trong nhóm này (vượt ngưỡng) sẽ DỪNG lại chờ một người KHÁC duyệt — kể cả việc của chính anh/chị. Nếu shop chưa có người duyệt thứ hai, việc bị chặn hẳn.\n\nĐây là quyết định của chủ shop.`,
      )
    )
      return;
    startTransition(async () => {
      const r = await setApprovalEnforce(group, bat);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(bat ? `Đã BẬT cưỡng chế: ${label}` : `Đã tắt cưỡng chế: ${label}`);
        router.refresh();
      }
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-2 self-center">
      <span className="text-[11.5px] text-muted-foreground">{enforced ? "Đang bật" : "Tắt"}</span>
      <Switch checked={enforced} disabled={pending || disabled} onCheckedChange={doi} aria-label={`Cưỡng chế duyệt hai bước: ${label}`} />
    </div>
  );
}
