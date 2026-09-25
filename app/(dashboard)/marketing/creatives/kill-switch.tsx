"use client";

import { Loader2, OctagonX, PlayCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setAdsWriteKillSwitch } from "@/lib/actions/ads-kill-switch";
import { ADS_KILL_SOURCE_LABEL, type AdsKillSwitchState } from "@/lib/constants/ads-kill-switch";
import { cn } from "@/lib/utils";

/**
 * Nút KÉO / NHẢ công tắc khẩn cấp. Luật: `lib/constants/ads-kill-switch.ts`; quyền: `lib/actions/ads-kill-switch.ts`.
 * Kéo có hiệu lực ở lời gọi Facebook KẾ TIẾP — không cần deploy, không cần khởi động lại.
 */
export function AdsKillSwitchCard({ state, canEngage, canRelease }: { state: AdsKillSwitchState; canEngage: boolean; canRelease: boolean }) {
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const want = !state.killed;
  const allowed = want ? canEngage : canRelease;

  const submit = () =>
    start(async () => {
      const r = await setAdsWriteKillSwitch({ killed: want, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.killed ? "Đã KÉO công tắc — mọi lời gọi tạo/tăng chi bị chặn từ lời gọi kế tiếp." : "Đã nhả công tắc — đường ghi trở lại theo chốt env và phiếu duyệt.");
      setReason("");
    });

  return (
    <div className={cn("rounded-lg border p-3 text-[13px]", state.killed ? "border-destructive/60 bg-destructive/5" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        {state.killed ? <OctagonX className="size-4 text-destructive" aria-hidden /> : <PlayCircle className="size-4 text-muted-foreground" aria-hidden />}
        <p className="font-medium">Công tắc tắt khẩn cấp đường ghi quảng cáo: {ADS_KILL_SOURCE_LABEL[state.source]}</p>
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        {state.killed
          ? "Mọi lời gọi TẠO hoặc TĂNG chi lên Facebook đang bị chặn (tải ảnh · tạo bài / nhóm / mẩu · đổi ngân sách · tiêu thêm). Tạm dừng nhóm vẫn đi để tiền ngừng chảy."
          : "Kéo công tắc khi thấy máy tiêu tiền sai: có hiệu lực ở lời gọi kế tiếp, không cần deploy. Tạm dừng vẫn được đi."}
        {state.reason ? ` Lý do: ${state.reason}` : ""}
        {state.by ? ` · ${state.by}` : ""}
        {state.at ? ` · ${state.at}` : ""}
      </p>
      {allowed ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input
            className="h-8 max-w-sm"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={want ? "Vì sao kéo công tắc (bắt buộc)" : "Vì sao mở lại (bắt buộc)"}
            aria-label="Lý do"
          />
          <Button size="sm" variant={want ? "destructive" : "outline"} disabled={pending || reason.trim().length < 3} onClick={submit}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
            {want ? "Kéo công tắc — dừng mọi lời gọi tạo/tăng chi" : "Nhả công tắc"}
          </Button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-muted-foreground">
          {want ? "Bạn không có quyền kéo công tắc." : "Chỉ người có quyền “Cấu hình hệ thống khác” mới nhả được công tắc."}
        </p>
      )}
    </div>
  );
}
