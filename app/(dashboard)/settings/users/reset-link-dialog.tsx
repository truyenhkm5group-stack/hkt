"use client";

import { useState, useTransition } from "react";
import { Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { createResetLinkAction } from "@/lib/actions/password-reset";
import { formatDateTime } from "@/lib/format";

/**
 * LIÊN KẾT ĐẶT LẠI MẬT KHẨU (0191) — người quên mật khẩu tự đặt mật khẩu mới, quản trị không biết nó. Liên kết hiện
 * ĐÚNG MỘT lần ở đây (CSDL chỉ giữ bản băm); gửi qua Zalo / Messenger. Tạo liên kết mới ⇒ liên kết cũ chưa dùng hết hiệu lực.
 */
export function ResetLinkDialog({ user, open, onOpenChange }: { user: { id: string; name: string; email: string }; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      const r = await createResetLinkAction(user.id);
      if ("error" in r) return void toast.error(r.error);
      setLink({ url: r.link, expiresAt: r.expiresAt });
    });
  const close = (o: boolean) => {
    if (!o) setLink(null);
    onOpenChange(o);
  };
  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Liên kết đặt lại mật khẩu</DialogTitle>
          <DialogDescription>
            Cho <strong>{user.name}</strong> ({user.email}). Người này mở liên kết và TỰ đặt mật khẩu mới — bạn không biết mật khẩu đó. Dùng một lần, hết hạn sau 24 giờ; đặt xong mọi phiên cũ của họ bị đăng xuất.
          </DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-2" data-reset-link>
            <div className="flex gap-2">
              <Input readOnly value={link.url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" size="icon" aria-label="Sao chép liên kết" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast.success("Đã sao chép liên kết"))}>
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Liên kết chỉ hiện MỘT lần — sao chép và gửi ngay (Zalo, Messenger). Hết hạn lúc {formatDateTime(link.expiresAt)}.</p>
          </div>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => close(false)}>
            Đóng
          </Button>
          {link ? null : (
            <Button type="button" onClick={create} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
              Tạo liên kết
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
