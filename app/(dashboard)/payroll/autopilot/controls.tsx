"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { Copy, Link2, Loader2, Play, QrCode, RefreshCw, Send, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import {
  approveAndLockPayroll,
  listPayoutCandidates,
  matchPayoutManually,
  rerunSettlement,
  resendPayslips,
  runPayrollAutopilotNow,
  togglePayrollAutopilot,
} from "@/lib/actions/payroll-autopilot";
import { formatDateTime, formatVND } from "@/lib/format";
import { buildVietQrPayload } from "@/lib/payroll/vietqr";

type Result = { ok: true; message?: string } | { error: string };

function useAction() {
  const [pending, start] = useTransition();
  const router = useRouter();
  const run = (fn: () => Promise<Result>) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message ?? "Xong");
      router.refresh();
    });
  return { pending, run };
}

export function AutopilotToggle({ enabled, canApprove }: { enabled: boolean; canApprove: boolean }) {
  const { pending, run } = useAction();
  return (
    <label className="flex items-center gap-2 text-sm font-medium">
      <Switch checked={enabled} disabled={!canApprove || pending} onCheckedChange={(v) => run(() => togglePayrollAutopilot(v))} />
      {enabled ? "Lương tự động: BẬT" : "Lương tự động: TẮT"}
    </label>
  );
}

export function RunNowButton() {
  const { pending, run } = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(runPayrollAutopilotNow)}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Chạy ngay một lượt
    </Button>
  );
}

export function ApproveLockButton({ periodKey, warn }: { periodKey: string; warn: string | null }) {
  const { pending, run } = useAction();
  return (
    <Button
      disabled={pending}
      onClick={() => {
        if (warn && !window.confirm(`${warn}\n\nVẫn duyệt và khoá? (Phần sai sửa bằng điều chỉnh kỳ sau.)`)) return;
        run(() => approveAndLockPayroll({ periodKey }));
      }}
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />} Duyệt & khoá · lập lệnh chuyển
    </Button>
  );
}

export function ResendButton({ periodKey }: { periodKey: string }) {
  const { pending, run } = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => resendPayslips({ periodKey }))}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Gửi phiếu cho nhân viên
    </Button>
  );
}

export function RerunSettlementButton() {
  const { pending, run } = useAction();
  return (
    <Button size="sm" variant="outline" disabled={pending} onClick={() => run(rerunSettlement)}>
      {pending ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Tính lại quyết toán
    </Button>
  );
}

type PayoutLine = { id: string; employeeName: string; amount: number; bankBin: string; bankName: string; accountNumber: string; accountName: string; transferNote: string; accountChanged: boolean };

/**
 * MÃ QR CHUYỂN LƯƠNG — vẽ NGAY TRONG TRÌNH DUYỆT từ chuỗi VietQR, không gọi dịch vụ ngoài nào (số lương
 * không rời máy). Tên chủ tài khoản đã khai in to cạnh mã: app ngân hàng sẽ hiện tên thật trước khi
 * cho xác nhận, và người bấm phải so hai tên với nhau.
 */
export function PayoutQrButton({ line }: { line: PayoutLine }) {
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const qr = buildVietQrPayload({ bin: line.bankBin, accountNumber: line.accountNumber, amount: line.amount, note: line.transferNote });
  const payload = qr.ok ? qr.payload : null;
  useEffect(() => {
    if (!open || !payload) return;
    let alive = true;
    QRCode.toDataURL(payload, { margin: 1, width: 300, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [open, payload]);
  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text).then(() => toast.success(`Đã sao chép ${label}`));
  };
  if (!qr.ok) {
    return <span className="text-[11px] text-rose-700 dark:text-rose-400">{line.accountNumber ? qr.error : "Thiếu STK — khai ở hồ sơ nhân sự"}</span>;
  }
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <QrCode className="size-4" /> Chuyển
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chuyển lương cho {line.employeeName}</DialogTitle>
          <DialogDescription>Quét bằng app ngân hàng. So TÊN người nhận app hiện ra với tên dưới đây trước khi xác nhận.</DialogDescription>
        </DialogHeader>
        {line.accountChanged ? (
          <p className="rounded-md bg-rose-50 px-3 py-2 text-[13px] font-medium text-rose-900 dark:bg-rose-950 dark:text-rose-200">
            ⚠ Số tài khoản KHÁC lần trả trước. Gọi hỏi lại chính người nhận trước khi chuyển.
          </p>
        ) : null}
        <div className="flex justify-center">
          {src ? (
            // Ảnh `data:` dựng ngay trong trình duyệt — next/image không có gì để tối ưu, và không được đẩy qua máy chủ ảnh nào.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={src} alt="Mã VietQR chuyển lương" width={300} height={300} className="rounded-lg border bg-white p-2" />
          ) : (
            <Loader2 className="size-6 animate-spin" />
          )}
        </div>
        <dl className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-1.5 text-[13px]">
          <dt className="text-muted-foreground">Người nhận</dt>
          <dd className="font-semibold">{line.accountName}</dd>
          <span />
          <dt className="text-muted-foreground">Ngân hàng</dt>
          <dd>{line.bankName}</dd>
          <span />
          <dt className="text-muted-foreground">Số tài khoản</dt>
          <dd className="tabular-nums">{line.accountNumber}</dd>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Sao chép số tài khoản" onClick={() => copy(line.accountNumber, "số tài khoản")}>
            <Copy className="size-3.5" />
          </Button>
          <dt className="text-muted-foreground">Số tiền</dt>
          <dd className="font-semibold tabular-nums">{formatVND(line.amount)}</dd>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Sao chép số tiền" onClick={() => copy(String(line.amount), "số tiền")}>
            <Copy className="size-3.5" />
          </Button>
          <dt className="text-muted-foreground">Nội dung</dt>
          <dd className="font-mono">{line.transferNote}</dd>
          <Button size="icon" variant="ghost" className="size-7" aria-label="Sao chép nội dung" onClick={() => copy(line.transferNote, "nội dung")}>
            <Copy className="size-3.5" />
          </Button>
        </dl>
        <p className="text-[11px] text-muted-foreground">
          Giữ nguyên nội dung chuyển khoản: ERP nhận ra khoản lương này trong sổ ngân hàng nhờ mã ở cuối. Tiền ra vào sổ (SePay hoặc sao kê tải lên) thì dòng này tự chuyển sang “Đã trả”.
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** Khớp tay: chọn dòng sao kê ĐÚNG số tiền. Không có dòng nào thì không đánh dấu được — đó là chủ ý. */
export function ManualMatchButton({ lineId }: { lineId: string }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<{ id: string; txnAt: string; amount: number; description: string; counterparty: string }[] | null>(null);
  const { pending, run } = useAction();
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void listPayoutCandidates(lineId).then((r) => {
      if (!alive) return;
      if ("error" in r) {
        toast.error(r.error);
        setItems([]);
      } else setItems(r.items);
    });
    return () => {
      alive = false;
    };
  }, [open, lineId]);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost">
          <Link2 className="size-4" /> Khớp tay
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Chọn dòng sao kê đã chuyển</DialogTitle>
          <DialogDescription>Chỉ hiện tiền ra ĐÚNG số tiền của lệnh, chưa dùng cho dòng lương nào. Không thấy dòng nào nghĩa là sổ ngân hàng chưa có giao dịch ấy — tải sao kê ở trang Ngân hàng.</DialogDescription>
        </DialogHeader>
        {items === null ? (
          <Loader2 className="mx-auto size-5 animate-spin" />
        ) : items.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">Chưa có dòng sao kê nào khớp số tiền.</p>
        ) : (
          <ul className="divide-y text-[13px]">
            {items.map((t) => (
              <li key={t.id} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="tabular-nums">
                    {formatDateTime(t.txnAt)} · <b>{formatVND(t.amount)}</b>
                  </div>
                  <div className="line-clamp-2 text-[12px] text-muted-foreground">{t.description || t.counterparty}</div>
                </div>
                <Button size="sm" disabled={pending} onClick={() => run(() => matchPayoutManually({ lineId, txnId: t.id }))}>
                  Chọn
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
