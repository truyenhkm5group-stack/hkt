"use client";

import { useEffect, useState, useTransition } from "react";
import QRCode from "qrcode";
import { Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { createRenewalInvoiceAction, previewRenewalAction } from "@/lib/actions/billing";
import { BILLING_MONTH_OPTIONS, RENEWAL_KIND_LABEL, type RenewalQuote } from "@/lib/billing/rules";
import { ENTITLEMENT_SPEC, parseLimits, type EntitlementKind } from "@/lib/entitlements/kinds";
import { formatDate, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

type Offer = { key: string; name: string; description: string | null; priceVnd: number; limits: unknown };

export type OpenInvoiceProps = {
  transferCode: string;
  amountVnd: number;
  listAmountVnd: number;
  creditVnd: number;
  planName: string;
  months: number;
  periodStart: string;
  periodEnd: string;
  qrPayload: string | null;
  qrError: string | null;
};

type Receiver = { bankName: string; accountNumber: string; accountName: string } | null;

const SHOWN_LIMITS: EntitlementKind[] = ["users", "workflows", "records", "storageMb"];

function limitText(limits: unknown, kind: EntitlementKind): string {
  const v = parseLimits(limits).limits[kind];
  if (v === undefined) return "—";
  if (v === null) return "Không giới hạn";
  return `${v.toLocaleString("vi-VN")} ${ENTITLEMENT_SPEC[kind].unit}`;
}

function copy(text: string, label: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success(`Đã sao chép ${label}`));
}

/** Chọn gói + số tháng ⇒ báo giá từ MÁY CHỦ (cùng hàm thuần với lượt tạo mã — hai bước không lệch nhau) ⇒ tạo mã. */
export function RenewalPicker({ offers, currentPlanKey, hasOpenInvoice }: { offers: Offer[]; currentPlanKey: string | null; hasOpenInvoice: boolean }) {
  const initial = offers.find((o) => o.key === currentPlanKey)?.key ?? offers[0]?.key ?? "";
  const [planKey, setPlanKey] = useState(initial);
  const [months, setMonths] = useState<number>(1);
  const [quote, setQuote] = useState<RenewalQuote | { error: string } | null>(null);
  const [loading, startPreview] = useTransition();
  const [pending, start] = useTransition();

  useEffect(() => {
    if (!planKey) return;
    let alive = true;
    startPreview(async () => {
      const q = await previewRenewalAction({ planKey, months });
      if (alive) setQuote(q);
    });
    return () => {
      alive = false;
    };
  }, [planKey, months]);

  if (offers.length === 0) return <p className="text-sm text-muted-foreground">Nền tảng chưa mở bán gói nào — liên hệ người vận hành.</p>;

  const create = () =>
    start(async () => {
      const r = await createRenewalInvoiceAction({ planKey, months });
      if ("error" in r) toast.error(r.error);
      else toast.success(r.message);
    });

  return (
    <div className="space-y-4" data-renewal-picker>
      <div className="grid gap-3 md:grid-cols-3">
        {offers.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => setPlanKey(o.key)}
            data-plan-offer={o.key}
            aria-pressed={planKey === o.key}
            className={cn("rounded-lg border p-3 text-left transition-colors", planKey === o.key ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/40")}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold">{o.name}</span>
              {o.key === currentPlanKey ? <span className="text-[11px] text-muted-foreground">đang dùng</span> : null}
            </div>
            <div className="numeric mt-1 text-lg font-semibold">
              {formatVND(o.priceVnd)}
              <span className="text-xs font-normal text-muted-foreground">/tháng</span>
            </div>
            {o.description ? <p className="mt-1 text-xs text-muted-foreground">{o.description}</p> : null}
            <ul className="mt-2 space-y-0.5 text-xs">
              {SHOWN_LIMITS.map((k) => (
                <li key={k} className="flex justify-between gap-2">
                  <span className="text-muted-foreground">{ENTITLEMENT_SPEC[k].label}</span>
                  <span className="numeric">{limitText(o.limits, k)}</span>
                </li>
              ))}
            </ul>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="billing-months">Số tháng</Label>
          <select id="billing-months" value={months} onChange={(e) => setMonths(Number(e.target.value))} className="h-9 rounded-md border bg-background px-2 text-sm">
            {BILLING_MONTH_OPTIONS.map((m) => (
              <option key={m} value={m}>
                {m} tháng
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[16rem] flex-1 text-sm" data-renewal-quote>
          {loading && !quote ? (
            <span className="text-muted-foreground">Đang tính…</span>
          ) : quote && "error" in quote ? (
            <span className="text-destructive">{quote.error}</span>
          ) : quote ? (
            <div className="space-y-0.5">
              <div>
                <span className="font-medium">{RENEWAL_KIND_LABEL[quote.kind]}</span> · kỳ {formatDate(quote.periodStart)} → {formatDate(quote.periodEnd)}
              </div>
              <div className="numeric">
                {quote.creditVnd > 0 ? (
                  <>
                    {formatVND(quote.listAmountVnd)} − {formatVND(quote.creditVnd)} = <span className="font-semibold">{formatVND(quote.amountVnd)}</span>
                  </>
                ) : (
                  <span className="font-semibold">{formatVND(quote.amountVnd)}</span>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{quote.explain}</p>
            </div>
          ) : null}
        </div>
        <Button type="button" onClick={create} disabled={pending || loading || !quote || "error" in quote} data-create-invoice>
          {pending ? <Loader2 className="size-4 animate-spin" /> : null}
          {hasOpenInvoice ? "Tạo mã mới" : "Tạo mã thanh toán"}
        </Button>
      </div>
      {hasOpenInvoice ? <p className="text-xs text-muted-foreground">Tạo mã mới thì mã đang mở bị huỷ — đừng chuyển tiền theo mã cũ.</p> : null}
    </div>
  );
}

/** Mã QR VietQR của hoá đơn đang mở — vẽ ngay trong trình duyệt, không gọi dịch vụ ngoài. */
export function OpenInvoiceCard({ invoice, receiver }: { invoice: OpenInvoiceProps; receiver: Receiver }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!invoice.qrPayload) return;
    let alive = true;
    QRCode.toDataURL(invoice.qrPayload, { margin: 1, width: 260, errorCorrectionLevel: "M" })
      .then((url) => alive && setSrc(url))
      .catch(() => alive && setSrc(null));
    return () => {
      alive = false;
    };
  }, [invoice.qrPayload]);

  const rows: { label: string; value: string; copy?: string }[] = [
    { label: "Ngân hàng", value: receiver?.bankName ?? "—" },
    { label: "Số tài khoản", value: receiver?.accountNumber ?? "—", copy: receiver?.accountNumber },
    { label: "Chủ tài khoản", value: receiver?.accountName ?? "—" },
    { label: "Số tiền", value: formatVND(invoice.amountVnd), copy: String(invoice.amountVnd) },
    { label: "Nội dung", value: invoice.transferCode, copy: invoice.transferCode },
  ];

  return (
    <div className="grid gap-4 md:grid-cols-[auto_1fr]" data-open-invoice={invoice.transferCode}>
      <div className="flex size-[260px] items-center justify-center rounded-lg border bg-white">
        {/* eslint-disable-next-line @next/next/no-img-element -- ảnh data: dựng tại chỗ, không qua tối ưu ảnh */}
        {src ? <img src={src} alt={`Mã QR thanh toán ${invoice.transferCode}`} width={260} height={260} /> : <span className="px-4 text-center text-xs text-muted-foreground">{invoice.qrError ?? "Đang vẽ mã QR…"}</span>}
      </div>
      <div className="space-y-3 text-sm">
        <p>
          Gói <span className="font-semibold">{invoice.planName}</span> · {invoice.months} tháng · kỳ {formatDate(invoice.periodStart)} → {formatDate(invoice.periodEnd)}
          {invoice.creditVnd > 0 ? <span className="text-muted-foreground"> (đã trừ {formatVND(invoice.creditVnd)} chưa dùng của gói cũ)</span> : null}
        </p>
        <dl className="divide-y rounded-md border">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-3 px-3 py-2">
              <dt className="text-muted-foreground">{r.label}</dt>
              <dd className="flex items-center gap-2 font-medium">
                <span className={r.label === "Nội dung" ? "font-mono" : r.label === "Số tiền" ? "numeric" : undefined}>{r.value}</span>
                {r.copy ? (
                  <button type="button" onClick={() => copy(r.copy!, r.label.toLowerCase())} className="text-muted-foreground hover:text-foreground" aria-label={`Sao chép ${r.label.toLowerCase()}`}>
                    <Copy className="size-3.5" />
                  </button>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">
          Quét mã bằng app ngân hàng, hoặc chuyển khoản tay với ĐÚNG nội dung <span className="font-mono">{invoice.transferCode}</span>. Tiền về tài khoản, hệ thống tự gia hạn trong khoảng một phút — gói mới có hiệu lực ngay. Chuyển thiếu tiền thì chưa gia hạn; người vận hành sẽ liên hệ.
        </p>
      </div>
    </div>
  );
}
