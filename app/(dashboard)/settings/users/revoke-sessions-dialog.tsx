"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { revokeSessionsOfUser } from "@/lib/actions/session-revoke";

/**
 * LÝ DO LÀ BẮT BUỘC, và ô này không có đường vòng.
 *
 * Quản trị đá một người ra khỏi hệ thống là việc có hậu quả với người khác. Không ghi vì sao thì
 * ba tháng sau không ai giải thích được — kể cả chính người đã bấm. Máy chủ cũng chặn (lược đồ zod
 * + `applySessionRevocation`), nên nút mờ ở đây chỉ là lớp lịch sự, không phải lớp bảo vệ.
 */
export function RevokeSessionsDialog({
  user,
  open,
  onOpenChange,
}: {
  user: { id: string; name: string; email: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const hopLe = reason.trim().length >= 5;

  const submit = () => {
    startTransition(async () => {
      const result = await revokeSessionsOfUser({ id: user.id, reason });
      if ("error" in result) {
        toast.error(result.error);
        return;
      }
      toast.success(`Đã thu hồi mọi phiên của ${user.email}`);
      setReason("");
      onOpenChange(false);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) setReason("");
        onOpenChange(v);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Thu hồi phiên đăng nhập</DialogTitle>
          <DialogDescription>
            Mọi thiết bị đang đăng nhập bằng <strong>{user.email}</strong> sẽ bị đăng xuất ngay. Tài khoản <strong>KHÔNG</strong> bị khoá và mật khẩu{" "}
            <strong>KHÔNG</strong> đổi — họ đăng nhập lại được bằng mật khẩu hiện có.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="revoke-reason">Lý do thu hồi</Label>
          <Textarea
            id="revoke-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ví dụ: nhân viên báo mất điện thoại đang đăng nhập ERP"
            rows={3}
            maxLength={500}
          />
          <p className="text-xs text-muted-foreground">Bắt buộc, tối thiểu 5 ký tự. Lý do được ghi vào nhật ký truy vết cùng người bấm và mốc thời gian.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Huỷ
          </Button>
          <Button className="bg-destructive text-white hover:bg-destructive/90" onClick={submit} disabled={pending || !hopLe}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Thu hồi phiên
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
