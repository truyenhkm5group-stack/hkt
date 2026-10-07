"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { CheckCircle2, Copy, Download, Loader2, Wallet } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { aiTopupStatusAction, createAiTopupAction, setLowBalanceAction } from "@/lib/actions/ai-balance";
import type { AiBalanceCustomerView, TopupIntentView } from "@/lib/billing/ai-balance";
import { TOPUP_MAX_VND, TOPUP_MIN_VND } from "@/lib/billing/ai-balance-rules";
import { formatDateTime, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ SỐ DƯ AI — MÀN KHÁCH (docs/saas/AI_BALANCE_V1.md) ═══════════
 *
 * Chủ shop ít rành máy, thường dùng ĐIỆN THOẠI: số dư to, một nút Nạp tiền, bốn mức chọn sẵn. Máy tính: mã QR lớn là lối
 * chính. Điện thoại: không bắt quét mã trên chính chiếc máy đang cầm — hiện sẵn nút sao chép số tài khoản / số tiền / nội
 * dung và lưu ảnh QR để mở trong app ngân hàng. Trang tự hỏi trạng thái mỗi vài giây; tiền về là báo ngay, không ai duyệt.
 * Không token / model / chi phí nhà cung cấp ở bất kỳ chỗ nào.
 */

const POLL_MS = 4_000;
/** Hỏi tiếp tối đa bấy nhiêu sau khi mã hết hạn (khách chuyển sát giờ, ngân hàng báo chậm). */
const POLL_AFTER_EXPIRY_MS = 15 * 60_000;

function copy(text: string, label: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success(`Đã sao chép ${label}`));
}

function useCountdown(expiresAt: string | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return null;
  const left = Math.max(0, Date.parse(expiresAt) - now);
  const m = Math.floor(left / 60_000);
  const s = Math.floor((left % 60_000) / 1_000);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function AiBalancePanel({ view }: { view: AiBalanceCustomerView }) {
  const router = useRouter();
  const [intent, setIntent] = useState<TopupIntentView | null>(view.pending);
  const [paid, setPaid] = useState<{ amountVnd: number; balanceVnd: number } | null>(null);
  const [custom, setCustom] = useState("");
  const [pending, start] = useTransition();

  const create = (amountVnd: number | string) =>
    start(async () => {
      const r = await createAiTopupAction({ amountVnd });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setPaid(null);
      setIntent(r.intent);
    });

  // Hỏi trạng thái khi đang hiện mã QR — dừng khi đã nhận tiền / rời trang.
  useEffect(() => {
    if (!intent || paid) return;
    let alive = true;
    const stopAt = Date.parse(intent.expiresAt) + POLL_AFTER_EXPIRY_MS;
    const tick = async () => {
      // Mã đã hết hạn lâu: thôi hỏi mỗi vài giây (mỗi lần là một lượt quét sổ ngân hàng) — tiền về muộn vẫn được lượt đối chiếu cộng.
      if (Date.now() > stopAt) {
        clearInterval(t);
        return;
      }
      const r = await aiTopupStatusAction({ intentId: intent.id });
      if (!alive || "error" in r) return;
      if (r.status === "PAID") {
        setPaid({ amountVnd: r.paidAmountVnd ?? intent.amountVnd, balanceVnd: r.balanceVnd });
        toast.success(`Đã nhận ${formatVND(r.paidAmountVnd ?? intent.amountVnd)} — AI tiếp tục làm việc.`);
        router.refresh();
      }
    };
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [intent, paid, router]);

  return (
    <div className="space-y-5" data-ai-balance>
      <section className={cn("rounded-xl border p-4 sm:p-5", view.isLow ? "border-amber-400 bg-amber-50 dark:bg-amber-950/30" : "bg-card")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Số dư AI</p>
            <p className="numeric text-3xl font-semibold sm:text-4xl" data-balance={view.balanceVnd}>
              {formatVND(paid?.balanceVnd ?? view.balanceVnd)}
            </p>
          </div>
          <Wallet className="size-8 text-muted-foreground" aria-hidden />
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">Đã dùng tháng này</dt>
            <dd className="numeric font-medium">{formatVND(view.usedThisMonthVnd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Chi trung bình / ngày</dt>
            <dd className="numeric font-medium">{view.forecast.avgDailyVnd === null ? "—" : formatVND(view.forecast.avgDailyVnd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Dự kiến còn</dt>
            <dd className="font-medium">{view.forecast.daysRemaining === null ? "—" : `${view.forecast.daysRemaining.toLocaleString("vi-VN")} ngày`}</dd>
          </div>
        </dl>
        {view.isLow ? <p className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-300">Số dư dưới ngưỡng cảnh báo {formatVND(view.lowBalanceVnd)} — nạp thêm để AI không dừng nhận khách mới.</p> : null}
        {view.forecast.recommendTopupVnd ? (
          <p className="mt-2 text-sm">
            Để AI chạy tới cuối tháng, nên nạp thêm <span className="font-semibold">{formatVND(view.forecast.recommendTopupVnd)}</span>.
          </p>
        ) : null}
      </section>

      {!view.receiverReady ? (
        <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">Chưa mở nạp tiền: nền tảng chưa khai tài khoản nhận tiền. Vui lòng liên hệ đội hỗ trợ.</p>
      ) : paid ? (
        <section className="flex items-start gap-3 rounded-xl border border-green-500 bg-green-50 p-4 dark:bg-green-950/30" data-topup-paid>
          <CheckCircle2 className="mt-0.5 size-6 shrink-0 text-green-600" aria-hidden />
          <div className="space-y-1 text-sm">
            <p className="font-semibold">Đã nhận {formatVND(paid.amountVnd)}</p>
            <p>Số dư mới: {formatVND(paid.balanceVnd)}. AI tiếp tục trả lời khách.</p>
            <Button type="button" variant="outline" size="sm" onClick={() => { setIntent(null); setPaid(null); }}>
              Nạp thêm
            </Button>
          </div>
        </section>
      ) : intent ? (
        <TopupQr intent={intent} onNew={() => setIntent(null)} />
      ) : (
        <section className="space-y-3 rounded-xl border p-4 sm:p-5" data-topup-picker>
          <p className="font-medium">Nạp tiền</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {view.presets.map((p) => (
              <Button key={p} type="button" variant={p === view.forecast.recommendTopupVnd ? "default" : "outline"} className="h-12 text-base" disabled={pending} onClick={() => create(p)} data-topup-preset={p}>
                {formatVND(p)}
              </Button>
            ))}
          </div>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              create(custom);
            }}
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor="topup-custom">Số khác (đ)</Label>
              <Input id="topup-custom" inputMode="numeric" placeholder={`${TOPUP_MIN_VND.toLocaleString("vi-VN")} – ${TOPUP_MAX_VND.toLocaleString("vi-VN")}`} value={custom} onChange={(e) => setCustom(e.target.value)} />
            </div>
            <Button type="submit" className="h-10" disabled={pending || !custom.trim()}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Tạo mã nạp
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">Số dư chỉ dùng cho dịch vụ Chốt Đơn — không rút, không chuyển cho shop khác.</p>
        </section>
      )}

      <LowBalanceForm current={view.lowBalanceVnd} />
      <History items={view.history} />
    </div>
  );
}

function TopupQr({ intent, onNew }: { intent: TopupIntentView; onNew: () => void }) {
  const [src, setSrc] = useState<string | null>(null);
  const left = useCountdown(intent.expiresAt);
  const expired = left === "00:00";
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(intent.qrPayload, { margin: 1, width: 320, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [intent.qrPayload]);
  const rows = useMemo(
    () => [
      { label: "Số tiền", value: formatVND(intent.amountVnd), copy: String(intent.amountVnd), copyLabel: "số tiền" },
      { label: "Ngân hàng", value: intent.receiver.bankName, copy: null, copyLabel: "" },
      { label: "Số tài khoản", value: intent.receiver.accountNumber, copy: intent.receiver.accountNumber, copyLabel: "số tài khoản" },
      { label: "Chủ tài khoản", value: intent.receiver.accountName, copy: null, copyLabel: "" },
      { label: "Nội dung", value: intent.referenceCode, copy: intent.referenceCode, copyLabel: "nội dung chuyển khoản" },
    ],
    [intent],
  );
  return (
    <section className="space-y-4 rounded-xl border p-4 sm:p-5" data-topup-intent={intent.referenceCode}>
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium">Chuyển khoản {formatVND(intent.amountVnd)}</p>
        <p className={cn("numeric text-sm", expired ? "text-amber-700" : "text-muted-foreground")}>{expired ? "Mã đã quá hạn" : `Còn ${left}`}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-[auto_1fr]">
        {/* Máy tính: QR lớn là lối chính. Điện thoại: QR nhỏ hơn, nút sao chép + lưu ảnh đứng trước. */}
        <div className="order-2 flex flex-col items-center gap-2 md:order-1">
          <div className="flex size-[220px] items-center justify-center rounded-lg border bg-white md:size-[320px]">
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh data: dựng tại chỗ, không qua tối ưu ảnh */}
            {src ? <img src={src} alt={`Mã QR nạp ${intent.referenceCode}`} width={320} height={320} className="size-full" /> : <span className="px-4 text-center text-xs text-muted-foreground">Đang vẽ mã QR…</span>}
          </div>
          {src ? (
            <a href={src} download={`nap-so-du-ai-${intent.referenceCode}.png`} className="inline-flex items-center gap-1 text-sm underline underline-offset-2">
              <Download className="size-4" aria-hidden /> Lưu ảnh QR
            </a>
          ) : null}
        </div>
        <div className="order-1 space-y-3 text-sm md:order-2">
          <dl className="divide-y rounded-md border">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="flex items-center gap-2 text-right font-medium">
                  <span className={r.label === "Nội dung" ? "font-mono" : undefined}>{r.value}</span>
                  {r.copy ? (
                    <Button type="button" variant="outline" size="sm" className="h-8 px-2" onClick={() => copy(r.copy!, r.copyLabel)} aria-label={`Sao chép ${r.copyLabel}`}>
                      <Copy className="size-3.5" />
                    </Button>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-muted-foreground">
            Quét mã bằng app ngân hàng — số tiền và nội dung đã điền sẵn. Chuyển tay thì ghi ĐÚNG nội dung <span className="font-mono">{intent.referenceCode}</span>. Tiền về là số dư tăng
            ngay trên trang này, không cần gửi ảnh hay chờ duyệt.
          </p>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden /> Đang chờ tiền về…
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={onNew}>
            Chọn số tiền khác
          </Button>
        </div>
      </div>
    </section>
  );
}

function LowBalanceForm({ current }: { current: number }) {
  const [value, setValue] = useState(String(current));
  const [pending, start] = useTransition();
  const first = useRef(String(current));
  return (
    <form
      className="flex flex-col gap-2 rounded-xl border p-4 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await setLowBalanceAction({ amountVnd: value });
          if ("error" in r) toast.error(r.error);
          else {
            first.current = value;
            toast.success(r.message);
          }
        });
      }}
    >
      <div className="flex-1 space-y-1">
        <Label htmlFor="low-balance">Báo khi số dư dưới (đ)</Label>
        <Input id="low-balance" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <Button type="submit" variant="outline" disabled={pending || value === first.current}>
        Lưu ngưỡng
      </Button>
    </form>
  );
}

function History({ items }: { items: AiBalanceCustomerView["history"] }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">Chưa có lần nạp hay sử dụng nào.</p>;
  return (
    <section className="space-y-2">
      <p className="font-medium">Lịch sử</p>
      <ul className="divide-y rounded-xl border text-sm">
        {items.map((h, i) => (
          <li key={`${h.at}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="font-medium">{h.label}</p>
              <p className="truncate text-xs text-muted-foreground">
                {formatDateTime(h.at)}
                {h.detail ? ` · ${h.detail}` : ""}
              </p>
            </div>
            <span className={cn("numeric shrink-0 font-medium", h.amountVnd > 0 ? "text-green-700 dark:text-green-400" : "text-foreground")}>
              {h.amountVnd > 0 ? "+" : ""}
              {formatVND(h.amountVnd)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
