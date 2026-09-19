"use client";

import { useState, useTransition } from "react";
import { LogOut, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { logoutAllDevices } from "@/lib/actions/session-revoke";
import { SESSION_ABSOLUTE_DAYS, SESSION_IDLE_DAYS } from "@/lib/constants/session";

/**
 * Nút này KHÁC nút Đăng xuất ở thanh bên: đăng xuất thường chỉ xoá cookie của máy đang dùng, nút
 * này giết mọi token đã cấp — kể cả token đang cầm. Hộp thoại phải nói trước điều đó, vì hậu quả
 * "bạn cũng phải đăng nhập lại ngay bây giờ" là thứ người dùng cần biết TRƯỚC khi bấm.
 */
export function LogoutAllForm() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const run = () => {
    startTransition(async () => {
      try {
        await logoutAllDevices();
      } catch (e) {
        // `redirect()` của Next ném một lỗi điều khiển luồng — đó là đường THÀNH CÔNG, để nó bay ra.
        if (e && typeof e === "object" && "digest" in e && String((e as { digest?: unknown }).digest).startsWith("NEXT_REDIRECT")) throw e;
        toast.error("Không thu hồi được phiên. Thử lại sau.");
      }
    });
  };

  return (
    <>
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Mọi thiết bị đang đăng nhập bằng tài khoản này sẽ bị đăng xuất, <strong>kể cả máy bạn đang dùng</strong>. Dùng khi bạn để quên đăng nhập ở một máy khác hoặc
          nghi ngờ có người dùng ké tài khoản.
        </p>
        <p className="text-xs text-muted-foreground">
          Không thu hồi thì một phiên cũ còn sống tối đa {SESSION_IDLE_DAYS} ngày kể từ lần dùng gần nhất, và tối đa {SESSION_ABSOLUTE_DAYS} ngày kể từ lần đăng nhập.
        </p>
        <Button variant="outline" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
          <LogOut className="size-4" /> Đăng xuất mọi thiết bị
        </Button>
      </div>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đăng xuất mọi thiết bị?</AlertDialogTitle>
            <AlertDialogDescription>
              Tất cả phiên đăng nhập hiện có sẽ hết hiệu lực ngay lập tức. <strong>Bạn sẽ phải đăng nhập lại trên chính máy này.</strong> Mật khẩu không thay đổi.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                run();
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Đăng xuất mọi thiết bị
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
