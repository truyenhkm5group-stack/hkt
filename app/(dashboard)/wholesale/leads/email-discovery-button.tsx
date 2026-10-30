"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { queueEmailDiscoveryAction } from "@/lib/actions/wholesale";
import { EMAIL_CONSENT_NOTICE, EMAIL_QUEUE_DEFAULT, EMAIL_RESCAN_DAYS } from "@/lib/constants/wholesale-email";

/** Nút «Thu thập email» (wholesale:scan): xếp lead có website mà chưa có email vào hàng đợi đọc website. Không gửi thư. */
export function EmailDiscoveryButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-2 text-xs text-muted-foreground">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await queueEmailDiscoveryAction({ limit: EMAIL_QUEUE_DEFAULT });
            if ("error" in r) toast.error(r.error);
            else {
              const { queued, eligible } = r.report;
              toast.success(queued ? `Đã xếp ${queued} lead vào hàng đợi thu thập email${eligible > queued ? ` (còn ${eligible - queued} lead chờ lần bấm sau)` : ""} — job nền đọc dần vài lead mỗi lượt.` : "Không có lead nào cần thu thập: lead có website đều đã có email, đang chờ, hoặc vừa quét chưa đủ hạn.");
              router.refresh();
            }
          })
        }
      >
        ✉ Thu thập email
      </Button>
      <span>
        Lead có website mà chưa có email (tối đa {EMAIL_QUEUE_DEFAULT} lead / lần; đã quét thì {EMAIL_RESCAN_DAYS} ngày sau mới quét lại). {EMAIL_CONSENT_NOTICE}
      </span>
    </div>
  );
}
