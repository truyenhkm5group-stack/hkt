"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setDirectConnectOpenAction } from "@/lib/actions/platform-ops";
import { DIRECT_CONNECT_MODE_LABEL, DIRECT_CONNECT_MODES, directConnectModeOf, parseOrgCodeList, type DirectConnectMode, type DirectConnectOpen } from "@/lib/channels/direct-connect-shared";

const CONSEQUENCE: Record<DirectConnectMode, string> = {
  CLOSED: "Mọi cửa hàng (trừ người vận hành nền tảng) thấy ô «Nối thẳng Facebook — sắp mở» thay cho nút.",
  ORGS: "CHỈ các cửa hàng được liệt kê thấy nút «Kết nối Facebook Page» — dùng cho cửa hàng thử / người duyệt Meta App Review. Khách khác vẫn thấy «sắp mở».",
  ALL: "MỌI cửa hàng thấy nút «Kết nối Facebook Page». Chỉ chọn sau khi Meta đã duyệt quyền Page (Advanced Access) — trước đó khách bấm sẽ gặp lỗi quyền.",
};

/**
 * Công tắc cờ `meta.direct-connect.open` cho người vận hành (đóng MM-FU-712). Máy chủ (`setDirectConnectOpen`) kiểm lại MỌI điều
 * ở đây — người vận hành, lý do, mã cửa hàng có thật — màn hình chỉ báo sớm cho người gõ.
 */
export function DirectConnectControl(props: { open: DirectConnectOpen; stored: boolean; updatedAt: string | null; updatedByEmail: string | null }) {
  const current = directConnectModeOf(props.open);
  const [mode, setMode] = useState<DirectConnectMode>(current);
  const [codes, setCodes] = useState(Array.isArray(props.open) ? props.open.join(", ") : "");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const parsed = parseOrgCodeList(codes);
  const ready = reason.trim().length >= 5 && (mode !== "ORGS" || (parsed.codes.length > 0 && parsed.invalid.length === 0));

  const apply = () =>
    start(async () => {
      setError(null);
      const r = await setDirectConnectOpenAction({ mode, orgCodes: codes, reason });
      setConfirming(false);
      if ("error" in r) {
        setError(r.error);
        return;
      }
      setReason("");
      toast.success(r.changed ? `Đã đặt: ${DIRECT_CONNECT_MODE_LABEL[directConnectModeOf(r.open)]}` : "Không đổi gì — cờ đã là như vậy");
    });

  return (
    <div className="space-y-2" data-testid="platform-direct-connect">
      <p className="text-xs">
        Đang: <span className="font-semibold" data-direct-connect-mode={current}>{DIRECT_CONNECT_MODE_LABEL[current]}</span>
        {Array.isArray(props.open) && props.open.length ? <span> — {props.open.join(", ")}</span> : null}
        <span className="text-muted-foreground">{props.stored ? ` · ${props.updatedAt ?? "—"} · ${props.updatedByEmail ?? "máy"}` : " (chưa từng đặt ⇒ ĐÓNG)"}</span>
      </p>
      <div className="grid gap-2 sm:grid-cols-[200px_1fr]">
        <div className="space-y-1">
          <Label htmlFor="direct-connect-mode">Chế độ mới</Label>
          <select id="direct-connect-mode" value={mode} onChange={(e) => setMode(e.target.value as DirectConnectMode)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
            {DIRECT_CONNECT_MODES.map((m) => (
              <option key={m} value={m}>
                {DIRECT_CONNECT_MODE_LABEL[m]}
              </option>
            ))}
          </select>
        </div>
        {mode === "ORGS" ? (
          <div className="space-y-1">
            <Label htmlFor="direct-connect-orgs">Mã cửa hàng (cách nhau dấu phẩy)</Label>
            <Input id="direct-connect-orgs" value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="meta-review-demo" maxLength={700} />
            {parsed.invalid.length ? <p className="text-xs text-destructive">Mã không hợp lệ: {parsed.invalid.join(", ")}</p> : null}
          </div>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
        <div className="space-y-1">
          <Label htmlFor="direct-connect-reason">Lý do (vào nhật ký nền tảng)</Label>
          <Input id="direct-connect-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Cửa hàng cho người duyệt Meta App Review" maxLength={500} />
        </div>
        <Button type="button" variant="outline" disabled={pending || !ready} onClick={() => setConfirming(true)}>
          Đặt…
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <AlertDialog open={confirming} onOpenChange={(o) => !pending && setConfirming(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Đặt «Nối thẳng Facebook» thành «{DIRECT_CONNECT_MODE_LABEL[mode]}»?</AlertDialogTitle>
            <AlertDialogDescription>
              {CONSEQUENCE[mode]} Có hiệu lực ở lượt mở trang kế tiếp, không cần deploy. Lượt đổi ghi vào nhật ký nền tảng kèm lý do.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              onClick={(e) => {
                e.preventDefault();
                apply();
              }}
            >
              {pending ? "Đang đặt…" : "Xác nhận"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
