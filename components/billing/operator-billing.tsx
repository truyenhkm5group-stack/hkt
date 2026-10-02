"use client";

import { useState, useTransition } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { markInvoicePaidAction, reconcileBillingAction, resolveBillingPaymentAction, setBillingReceiverAction, setOrgBillingAction, setPlanPriceAction, voidInvoiceAction } from "@/lib/actions/billing";
import { BILLING_DEFAULT_GRACE_DAYS, BILLING_GRACE_MAX } from "@/lib/billing/rules";
import { VN_BANKS } from "@/lib/constants/vn-banks";
import { PILOT_REASON_MIN } from "@/lib/constants/pilot";
import { formatVND } from "@/lib/format";

/**
 * Nút THU PHÍ của người vận hành (`/platform`, `/platform/org/<mã>`). Mọi nút ghi đi qua hộp xác nhận có lý do — cùng
 * khuôn với công tắc khẩn — vì mỗi cái đổi tiền hoặc quyền dùng của một khách thật.
 */

const field = "h-9 w-full rounded-md border bg-background px-2 text-sm";

export function BillingReceiverForm({ current }: { current: { bin: string; accountNumber: string; accountName: string } | null }) {
  const [bin, setBin] = useState(current?.bin ?? VN_BANKS[0]?.bin ?? "");
  const [accountNumber, setAccountNumber] = useState(current?.accountNumber ?? "");
  const [accountName, setAccountName] = useState(current?.accountName ?? "");
  const same = !!current && current.bin === bin && current.accountNumber === accountNumber.trim() && current.accountName === accountName.trim().toUpperCase();
  return (
    <ConfirmWithReason
      id="billing-receiver"
      label={current ? "Đổi tài khoản nhận…" : "Khai tài khoản nhận…"}
      title="Đổi tài khoản nhận tiền thuê bao?"
      consequence="Mã QR của mọi hoá đơn — kể cả hoá đơn đang mở — trỏ về tài khoản mới từ lượt mở trang kế tiếp. Tiền chỉ tự khớp khi tài khoản này đã nối SePay vào sổ ngân hàng của tổ chức nhà."
      minReason={PILOT_REASON_MIN}
      placeholder="Mở tài khoản riêng cho doanh thu nền tảng"
      disabled={same || !accountNumber.trim() || !accountName.trim()}
      run={(reason) => setBillingReceiverAction({ bin, accountNumber: accountNumber.trim(), accountName, reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="rcv-bin">Ngân hàng</Label>
          <select id="rcv-bin" value={bin} onChange={(e) => setBin(e.target.value)} className={field}>
            {VN_BANKS.map((b) => (
              <option key={b.bin} value={b.bin}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rcv-acc">Số tài khoản</Label>
          <Input id="rcv-acc" value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} maxLength={19} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rcv-name">Chủ tài khoản</Label>
          <Input id="rcv-name" value={accountName} onChange={(e) => setAccountName(e.target.value)} maxLength={80} placeholder="CONG TY …" />
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function PlanPriceForm({ plan }: { plan: { key: string; name: string; priceVnd: number | null } }) {
  const [price, setPrice] = useState(plan.priceVnd === null ? "" : String(plan.priceVnd));
  const parsed = price.trim() === "" ? null : Number(price.replace(/[^\d]/g, ""));
  return (
    <ConfirmWithReason
      id={`price-${plan.key}`}
      label="Đổi giá…"
      title={parsed === null ? `Thôi bán gói «${plan.name}»?` : `Đặt giá «${plan.name}» = ${formatVND(parsed)}/tháng?`}
      consequence="Áp cho hoá đơn TẠO TỪ BÂY GIỜ. Hoá đơn đang mở giữ giá cũ; khách đang dùng gói này không bị đổi gì cho tới lần gia hạn kế tiếp."
      minReason={PILOT_REASON_MIN}
      placeholder="Chốt bảng giá quý IV"
      disabled={parsed === plan.priceVnd}
      run={(reason) => setPlanPriceAction({ planKey: plan.key, priceVnd: parsed, reason })}
    >
      <div className="flex items-center gap-2 text-xs">
        <Label htmlFor={`price-input-${plan.key}`}>Giá tháng (để trống = không bán)</Label>
        <Input id={`price-input-${plan.key}`} value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" className="w-40" />
      </div>
    </ConfirmWithReason>
  );
}

export function ReconcileBillingButton() {
  const [pending, start] = useTransition();
  return (
    <Button
      type="button"
      variant="outline"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await reconcileBillingAction();
          if ("error" in r) toast.error(r.error);
          else toast.success(r.message);
        })
      }
    >
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      Đối chiếu lại tiền thuê bao
    </Button>
  );
}

export function ResolvePaymentForm({ paymentId }: { paymentId: string }) {
  return (
    <ConfirmWithReason
      id={`resolve-${paymentId}`}
      label="Đã xử lý…"
      title="Đánh dấu khoản tiền này đã xử lý?"
      consequence="Khoản tiền rời danh sách «Tiền chưa khớp» nhưng KHÔNG bị xoá — dòng và lý do của bạn còn trong nhật ký. Nếu cần gia hạn cho khách, xác nhận tay hoá đơn của họ ở trang tổ chức trước."
      minReason={PILOT_REASON_MIN}
      placeholder="Đã hoàn tiền cho khách / đã xác nhận tay hoá đơn mới"
      run={(reason) => resolveBillingPaymentAction({ paymentId, reason })}
    />
  );
}

export function OrgBillingForm({ orgCode, orgName, current }: { orgCode: string; orgName: string; current: { billingEnabled: boolean; paidThrough: string | null; graceDays: number } | null }) {
  const [enabled, setEnabled] = useState(current?.billingEnabled ?? false);
  const [paidThrough, setPaidThrough] = useState(current?.paidThrough ?? "");
  const [grace, setGrace] = useState(String(current?.graceDays ?? BILLING_DEFAULT_GRACE_DAYS));
  return (
    <ConfirmWithReason
      id={`billing-${orgCode}`}
      label="Lưu thu phí…"
      title={enabled ? `Bật thu phí cho «${orgName}», trả tới ${paidThrough || "?"}?` : `Tắt thu phí của «${orgName}»?`}
      consequence={
        enabled
          ? `Từ ${paidThrough || "?"} trở đi tổ chức được nhắc gia hạn; quá ${grace} ngày ân hạn thì chuyển sang CHỈ XEM (không xoá dữ liệu, job nền dừng). Đang dùng thử thì «trả tới» chính là hạn dùng thử.`
          : "Tổ chức không bị nhắc, không bị khoá, dù ngày trả tới đã qua. Hoá đơn và lịch sử giữ nguyên."
      }
      minReason={PILOT_REASON_MIN}
      placeholder="Khách ký hợp đồng, dùng thử 14 ngày"
      disabled={enabled && !paidThrough}
      run={(reason) => setOrgBillingAction({ orgCode, enabled, paidThrough, graceDays: grace, reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-3 sm:items-end">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} data-billing-enabled />
          Thu phí tổ chức này
        </label>
        <div className="space-y-1">
          <Label htmlFor={`pt-${orgCode}`}>Đã trả tới ngày</Label>
          <Input id={`pt-${orgCode}`} type="date" value={paidThrough} onChange={(e) => setPaidThrough(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`grace-${orgCode}`}>Ân hạn (0–{BILLING_GRACE_MAX} ngày)</Label>
          <Input id={`grace-${orgCode}`} type="number" min={0} max={BILLING_GRACE_MAX} value={grace} onChange={(e) => setGrace(e.target.value)} />
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function InvoiceOperatorActions({ invoice }: { invoice: { id: string; transferCode: string; amountVnd: number; periodEnd: string; planName: string } }) {
  const [amount, setAmount] = useState(String(invoice.amountVnd));
  const [ref, setRef] = useState("");
  const parsed = Number(amount.replace(/[^\d]/g, ""));
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <ConfirmWithReason
        id={`paid-${invoice.id}`}
        label="Xác nhận đã thu…"
        title={`Xác nhận đã thu ${formatVND(parsed)} cho ${invoice.transferCode}?`}
        consequence={`Tổ chức được gia hạn tới ${invoice.periodEnd} và chuyển sang gói «${invoice.planName}» NGAY. Chỉ dùng khi tiền đã về mà sổ ngân hàng không thấy (ngân hàng khác, tiền mặt).`}
        minReason={PILOT_REASON_MIN}
        placeholder="Khách chuyển nhầm sang tài khoản ACB, đã kiểm sao kê"
        disabled={!Number.isInteger(parsed) || parsed <= 0}
        run={(reason) => markInvoicePaidAction({ invoiceId: invoice.id, amountVnd: parsed, ref, reason })}
      >
        <div className="grid gap-2 text-xs sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`amt-${invoice.id}`}>Số tiền thực nhận</Label>
            <Input id={`amt-${invoice.id}`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`ref-${invoice.id}`}>Mã giao dịch / chứng từ</Label>
            <Input id={`ref-${invoice.id}`} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={120} />
          </div>
        </div>
      </ConfirmWithReason>
      <ConfirmWithReason
        id={`void-${invoice.id}`}
        label="Huỷ hoá đơn…"
        variant="destructive"
        title={`Huỷ ${invoice.transferCode}?`}
        consequence="Mã chuyển khoản này thôi gia hạn được. Tiền khách chuyển tới mã này về sau vẫn được ghi, nằm ở «Tiền chưa khớp»."
        minReason={PILOT_REASON_MIN}
        placeholder="Khách đổi ý, chưa chuyển tiền"
        run={(reason) => voidInvoiceAction({ invoiceId: invoice.id, reason })}
      />
    </div>
  );
}
