"use client";

import { Loader2, Megaphone } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { setOrgAdsWriteAction } from "@/lib/actions/meta-ads-org-write";
import { cn } from "@/lib/utils";

/**
 * Công tắc đăng quảng cáo bằng token System User CỦA TỔ CHỨC (chỉ tổ chức khách). Bật ⇒ «Đăng camp» ở Thư viện Media tạo
 * chiến dịch / nhóm / mẩu trên tài khoản quảng cáo tổ chức đã khai và BẬT chạy ngay. Tắt có hiệu lực ở lời gọi kế tiếp.
 */
export function OrgAdsWriteCard({ enabled, blocker, canManage, caps }: { enabled: boolean; blocker: string | null; canManage: boolean; caps: { perCampVnd: number; dailyVnd: number } }) {
  const [pending, start] = useTransition();
  const toggle = () =>
    start(async () => {
      const r = await setOrgAdsWriteAction({ enabled: !enabled });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.enabled ? "Đã bật — Đăng camp lên Facebook bằng token của tổ chức." : "Đã tắt — ERP không tạo quảng cáo nào nữa.");
    });
  return (
    <div className={cn("rounded-lg border p-3 text-[13px]", enabled && !blocker ? "border-success/50 bg-success/5" : "border-border")}>
      <div className="flex flex-wrap items-center gap-2">
        <Megaphone className="size-4 text-muted-foreground" aria-hidden />
        <p className="font-medium">Đăng quảng cáo bằng token của tổ chức: {enabled ? "ĐANG BẬT" : "đang tắt"}</p>
        {canManage ? (
          <Button size="sm" variant={enabled ? "outline" : "default"} className="ml-auto h-7 px-2.5 text-[12px]" disabled={pending} onClick={toggle}>
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : null}
            {enabled ? "Tắt" : "Bật đăng quảng cáo"}
          </Button>
        ) : null}
      </div>
      <p className="mt-1 text-[12.5px] text-muted-foreground">
        Bật ⇒ «Đăng camp» ở Thư viện Media tạo chiến dịch, nhóm, quảng cáo trên tài khoản đã khai ở Kết nối «Quảng cáo Facebook (Meta) của tổ chức» và cho chạy ngay. Token cần quyền ads_management,
        pages_read_engagement, pages_show_list; fanpage giao cho người dùng hệ thống quyền Tạo quảng cáo. Trần một camp {caps.perCampVnd.toLocaleString("vi-VN")}đ/ngày, cam kết tối đa {caps.dailyVnd.toLocaleString("vi-VN")}đ cho camp đăng trong một ngày; công tắc khẩn cấp phía trên dừng mọi lượt tạo.
        Không bắt buộc luật tắt — camp chạy tới khi tắt trên Trình quản lý quảng cáo.
      </p>
      {enabled && blocker ? <p className="mt-1 text-[12.5px] text-destructive">{blocker}</p> : null}
    </div>
  );
}
