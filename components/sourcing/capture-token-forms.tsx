"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createCaptureTokenAction, revokeCaptureTokenAction } from "@/lib/actions/sourcing-capture";

/** Tạo token cho chính mình. Token hiện MỘT lần ở đây — tải lại trang là mất, ERP chỉ giữ băm. */
export function CreateCaptureTokenForm() {
  const [label, setLabel] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      const r = await createCaptureTokenAction({ label });
      if (!r.ok) {
        toast.error(r.errors[0]?.message ?? "Không tạo được token.");
        return;
      }
      setToken(r.token ?? null);
      setCopied(false);
      setLabel("");
      toast.success(r.message);
    });
  const copy = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      toast.error("Trình duyệt không cho chép — bôi đen ô token rồi Ctrl+C.");
    }
  };
  return (
    <div className="space-y-3 text-sm" data-capture-token-form>
      <div className="grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
        <div className="space-y-1">
          <Label htmlFor="cap-label">Tên máy / trình duyệt *</Label>
          <Input id="cap-label" placeholder="vd Chrome máy văn phòng" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} />
        </div>
        <Button disabled={pending} onClick={create}>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          Tạo token
        </Button>
      </div>
      {token ? (
        <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/40" data-capture-token-once>
          <p className="font-medium">Chép token này vào tiện ích NGAY — ERP chỉ hiện MỘT lần, tải lại trang là mất.</p>
          <div className="flex gap-2">
            <Input readOnly value={token} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-label="Token tiện ích" />
            <Button variant="outline" onClick={copy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Đã chép" : "Chép"}
            </Button>
          </div>
          <p className="text-muted-foreground">Token chỉ dùng được cho việc «Lưu mẫu vào ERP» — không mở được trang nào, không đọc được dữ liệu nào. Lộ token thì thu hồi ở bảng dưới.</p>
        </div>
      ) : null}
    </div>
  );
}

export function RevokeCaptureTokenButton({ tokenId }: { tokenId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await revokeCaptureTokenAction({ tokenId });
          if (r.ok) toast.success(r.message);
          else toast.error(r.errors[0]?.message ?? "Không thu hồi được.");
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      Thu hồi
    </Button>
  );
}
