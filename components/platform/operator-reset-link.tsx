"use client";

import { useState, useTransition } from "react";
import { Copy, Link2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SectionCard } from "@/components/ui-bits";
import { createResetLinkAsOperatorAction } from "@/lib/actions/password-reset";
import { formatDateTime } from "@/lib/format";
import { PASSWORD_RESET_TTL_HOURS } from "@/lib/users/password-reset-shared";

/**
 * «Đặt lại mật khẩu cho khách» trên `/platform/org/<mã>` — lối ra khi chính quản trị của tổ chức khách quên mật khẩu
 * (quản trị còn đăng nhập được thì tự làm ở trang Người dùng của họ). Bắt buộc lý do; nhật ký nền tảng ghi trước khi
 * liên kết hiện ra. Liên kết hiện MỘT lần — người vận hành gửi tay qua kênh của khách.
 */
export function OperatorResetLinkPanel({ orgCode, orgName }: { orgCode: string; orgName: string }) {
  const [email, setEmail] = useState("");
  const [reason, setReason] = useState("");
  const [link, setLink] = useState<{ url: string; email: string; expiresAt: string } | null>(null);
  const [pending, start] = useTransition();
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    start(async () => {
      const r = await createResetLinkAsOperatorAction({ orgCode, email, reason });
      if ("error" in r) return void toast.error(r.error);
      setLink({ url: r.link, email: r.email, expiresAt: r.expiresAt });
      setReason("");
    });
  };
  return (
    <SectionCard title="Đặt lại mật khẩu cho khách" description={`Tạo liên kết dùng một lần (hết hạn sau ${PASSWORD_RESET_TTL_HOURS} giờ) cho một tài khoản của «${orgName}». Người nhận tự chọn mật khẩu mới; mọi phiên cũ của họ bị đăng xuất.`}>
      <form onSubmit={create} className="grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="op-reset-email">Email tài khoản</Label>
          <Input id="op-reset-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="chu-shop@…" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="op-reset-reason">Lý do (vào nhật ký nền tảng)</Label>
          <Input id="op-reset-reason" required minLength={5} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Chủ shop gọi báo quên mật khẩu, đã xác minh qua SĐT đăng ký" />
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Link2 className="size-4" />}
          Tạo liên kết
        </Button>
      </form>
      {link ? (
        <div className="mt-3 space-y-2 rounded-lg border bg-muted/40 p-3" data-reset-link>
          <p className="text-xs text-muted-foreground">
            Liên kết cho <b className="text-foreground">{link.email}</b> — chỉ hiện MỘT lần, hết hạn lúc {formatDateTime(link.expiresAt)}. Chỉ gửi sau khi đã xác minh đúng người.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={link.url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
            <Button type="button" variant="outline" size="icon" aria-label="Sao chép liên kết" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => toast.success("Đã sao chép liên kết"))}>
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
