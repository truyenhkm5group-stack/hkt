"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2, PencilLine, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { OrderReviewEntries } from "@/components/orders/order-review-quick";
import { inboxOrderSummaryAction } from "@/lib/actions/inbox-order-panel";
import { confirmOrderReviewAction } from "@/lib/actions/manual-orders";
import { reviewSeenOf } from "@/lib/constants/order-review";
import { formatNumber, formatVND } from "@/lib/format";
import type { InboxOrder } from "@/lib/sales-chatbot/inbox-shared";
import { FIELD_LABEL, orderConfirmButton, orderVerification, VERIFIED_FIELDS, type ConversationOrderSummary, type FieldCheck, type OrderVerificationState } from "@/lib/sales-chatbot/order-verification-shared";
import { cn } from "@/lib/utils";

/**
 * ═══════════ «ĐƠN ĐANG CHỐT» — KHỐI ĐẦU CỘT PHẢI CỦA HỘP THƯ (INBOX-V2-B) ═══════════
 *
 * Trả lời «khách này đang mua gì»: từng dòng hàng (SKU · tên · biến thể · số lượng · đơn giá · giảm giá), phí ship, tổng tiền, người
 * nhận với địa chỉ TÁCH Ô (chi tiết · tỉnh · quận / huyện · phường / xã như lõi đã ghép), rồi trạng thái kiểm TỪNG Ô
 * (`orderVerification` — hàm thuần đọc lại đúng luật của lõi đơn). Tiền theo `formatVND`: chưa biết ⇒ «—», không bao giờ 0 (luật 42).
 *
 * Tải LƯỜI: chỉ hỏi máy chủ khi khối thật sự hiện trên màn hình (`IntersectionObserver`) — dưới 1280 px cột phải là ngăn kéo đóng
 * (`display: none`) nên mở hộp thư trên điện thoại không tốn câu truy vấn nào tới khi bấm «Khách · Đơn». Đọc lại khi danh sách đơn của
 * hội thoại (trang tự làm mới) đổi chữ ký, hoặc sau khi bấm xác nhận.
 *
 * Nút «Xác nhận & tạo đơn» gọi ĐÚNG `confirmOrderReviewAction` (lõi `confirmOrderReviewCore`: quyền `orders:write`, chỗ thiếu, dấu
 * vết lý do đã thấy, hạn mức nợ, sự kiện `order.confirmed`, nhật ký) — không đường xác nhận thứ hai. Ô `THIẾU` ⇒ nút tắt kèm lý do.
 */

const STATE_CLASS: Record<OrderVerificationState, string> = {
  "ĐỦ THÔNG TIN": "bg-emerald-600 text-white",
  "CẦN XÁC THỰC": "bg-amber-500 text-white",
  "ĐÃ XÁC NHẬN": "bg-sky-600 text-white",
  "ĐÃ TẠO ĐƠN": "bg-zinc-700 text-white dark:bg-zinc-300 dark:text-zinc-900",
};
const FIELD_CLASS: Record<FieldCheck["state"], string> = {
  OK: "border-emerald-600/40 text-emerald-800 dark:text-emerald-300",
  "CẦN KIỂM": "border-amber-500 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200",
  THIẾU: "border-red-600 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200",
};

/** Chữ ký danh sách đơn của hội thoại — đổi (bot sửa nháp, người xác nhận, sửa địa chỉ) ⇒ đọc lại panel. */
function ordersKey(orders: readonly InboxOrder[]): string {
  return orders.map((o) => `${o.id}:${o.stage}:${o.total}:${o.review.length}:${o.gaps.join("/")}`).join("|");
}

/** Một ô người nhận. `quiet` = ô trống là BÌNH THƯỜNG (cấp huyện không còn trong địa giới mới) ⇒ chữ xám, không tô cảnh báo. */
function Row({ label, value, check, missing, quiet = false, testId }: { label: string; value: string; check?: FieldCheck; missing?: string | null; quiet?: boolean; testId?: string }) {
  const bad = check && check.state !== "OK";
  return (
    <div className={cn("grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 rounded px-1 py-0.5", bad && (check.state === "THIẾU" ? "bg-red-50 ring-1 ring-red-500/60 dark:bg-red-950/30" : "bg-amber-50 ring-1 ring-amber-500/60 dark:bg-amber-950/30"))} data-field={testId} data-field-state={check?.state}>
      <dt className="text-foreground/60">{label}</dt>
      <dd className="min-w-0 break-words">{value ? value : <span className={quiet ? "text-foreground/50" : "font-medium text-amber-700 dark:text-amber-300"}>{missing ?? "—"}</span>}</dd>
    </div>
  );
}

export function InboxOrderPanel({ conversationId, orders, canDecide }: { conversationId: string; orders: readonly InboxOrder[]; canDecide: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [summary, setSummary] = useState<ConversationOrderSummary | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const key = ordersKey(orders);

  // Hiện trên màn hình ⇒ mới tải. Ngăn kéo đóng là `display: none` — không bao giờ giao với khung nhìn.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await inboxOrderSummaryAction(conversationId);
      if ("error" in r) setError(r.error);
      else setSummary(r.summary);
      setLoaded(true);
    } catch {
      setError("Không đọc được đơn — thử lại.");
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  // Lần đầu hiện + mỗi lần danh sách đơn của hội thoại đổi chữ ký (trang tự làm mới) — chỉ khi đang hiện.
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || lastKey.current === key) return;
    lastKey.current = key;
    void load();
  }, [visible, key, load]);

  const v = summary ? orderVerification(summary) : null;
  const button = summary && v ? orderConfirmButton(summary, v, canDecide) : { show: false as const };

  const confirm = async () => {
    if (!summary) return;
    setPending(true);
    try {
      const r = await confirmOrderReviewAction(summary.orderId, reviewSeenOf(summary.review));
      if (!("ok" in r)) {
        toast.error(r.error);
        setError(r.error);
        return;
      }
      toast.success(r.message);
      await load();
    } finally {
      setPending(false);
    }
  };

  const money = (n: number | null) => formatVND(n);
  const r = summary?.recipient;

  return (
    <section ref={box} className="space-y-2 rounded-lg border border-foreground/15 bg-background p-3" data-testid="inbox-order-panel" data-state={v?.state ?? (loaded ? "NONE" : "LOADING")} aria-label="Đơn đang chốt">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[12px] font-semibold uppercase tracking-wide text-foreground/70">Đơn đang chốt</p>
        <div className="flex items-center gap-1">
          {v ? (
            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", STATE_CLASS[v.state])} data-testid="inbox-order-state">
              {v.state}
            </span>
          ) : null}
          <button type="button" className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40" onClick={() => void load()} disabled={loading} aria-label="Đọc lại đơn" title="Đọc lại đơn">
            {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </button>
        </div>
      </div>

      {!loaded && !error ? <p className="text-muted-foreground">Đang đọc đơn…</p> : null}
      {error ? <p className="text-[12px] font-medium text-destructive">{error}</p> : null}
      {loaded && !summary && !error ? <p className="text-muted-foreground" data-testid="inbox-order-none">Chưa có đơn đang chốt — bot / nhân viên chưa lên đơn cho khách này.</p> : null}

      {summary && v && r ? (
        <>
          <Link href={`/orders/${encodeURIComponent(summary.orderId)}`} className="flex items-baseline justify-between gap-2 text-[12.5px] hover:underline">
            <span className="font-semibold">
              #{summary.shortCode}
              {summary.byBot ? <span className="font-normal text-muted-foreground"> · bot lên</span> : null}
            </span>
            <span className="text-muted-foreground">{summary.stageLabel} →</span>
          </Link>
          {summary.otherActive > 0 ? <p className="rounded bg-amber-100 px-2 py-1 text-[12px] text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">Hội thoại còn {summary.otherActive} đơn khác đang mở — xem «Đơn của khách» bên dưới.</p> : null}

          {/* ── Hàng khách mua ── */}
          <ul className={cn("divide-y divide-foreground/10 rounded border", v.fields.sku.state !== "OK" || v.fields.qty.state !== "OK" ? "border-amber-500" : "border-foreground/15")} data-testid="inbox-order-lines">
            {summary.lines.length === 0 ? <li className="px-2 py-1.5 text-muted-foreground">Chưa đọc được dòng hàng nào.</li> : null}
            {summary.lines.map((l, i) => (
              <li key={`${l.variantId ?? "x"}-${i}`} className="space-y-0.5 px-2 py-1.5" data-line={i}>
                <p className="leading-tight">
                  <span className="font-mono text-[11.5px] text-foreground/70">{l.sku || "—"}</span> · <span className="font-medium">{l.productName || "—"}</span>
                  {l.isBonus ? <span className="ml-1 rounded bg-emerald-100 px-1 text-[11px] text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">tặng</span> : null}
                </p>
                {l.variation ? <p className="text-[12px] text-foreground/65">{l.variation}</p> : null}
                <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
                  <span>
                    {formatNumber(l.quantity)} × {money(l.unitPrice)}
                    {l.discount > 0 ? <span className="text-rose-700 dark:text-rose-300"> · giảm {money(l.discount)}</span> : null}
                  </span>
                  <span className="font-semibold">{money(l.lineTotal)}</span>
                </div>
              </li>
            ))}
          </ul>

          {/* ── Tiền ── */}
          <dl className="space-y-0.5 text-[12.5px]" data-testid="inbox-order-money">
            <div className="flex justify-between gap-2">
              <dt className="text-foreground/60">Tiền hàng</dt>
              <dd>{money(summary.money.goods)}</dd>
            </div>
            {summary.money.discount > 0 ? (
              <div className="flex justify-between gap-2">
                <dt className="text-foreground/60">Giảm giá</dt>
                <dd className="text-rose-700 dark:text-rose-300">−{money(summary.money.discount)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-2" data-field="shipping">
              <dt className="text-foreground/60">Phí ship</dt>
              <dd className={cn(summary.money.shippingNote && "font-medium text-amber-700 dark:text-amber-300")}>{summary.money.shippingNote === "UNKNOWN" ? "— (chưa báo)" : summary.money.shippingNote === "FREE_IF_AREA" ? `${money(summary.money.shipping)} (nếu đúng khu vực)` : money(summary.money.shipping)}</dd>
            </div>
            <div className="flex justify-between gap-2 border-t pt-0.5 text-[13.5px] font-bold" data-field="total">
              <dt>Tổng khách trả</dt>
              <dd>{money(summary.money.total)}</dd>
            </div>
          </dl>

          {/* ── Người nhận — địa chỉ tách ô như lõi đã ghép ── */}
          <dl className="space-y-0.5 text-[12.5px]" data-testid="inbox-order-recipient">
            <Row label="Tên" value={r.name} testId="name" />
            <Row label="SĐT" value={r.phone} check={v.fields.phone} missing="Chưa có SĐT" testId="phone" />
            <Row label="Địa chỉ chi tiết" value={r.address} check={v.fields.address} missing="Chưa có địa chỉ" testId="address" />
            {/* Ô tỉnh / xã trống mang ĐÚNG lỗi của ô địa chỉ — tô chính ô người phải sửa. */}
            <Row label="Tỉnh / TP" value={r.province} check={r.province ? undefined : v.fields.address} missing="Chưa ghép được" testId="province" />
            <Row label="Quận / Huyện" value={r.district} missing={summary.manual ? "Không dùng (địa giới mới 2 cấp)" : "—"} quiet testId="district" />
            <Row label="Phường / Xã" value={r.ward} check={r.ward ? undefined : v.fields.address} missing="Chưa ghép được" testId="ward" />
          </dl>

          {/* ── Kiểm từng ô ── */}
          <ul className="flex flex-wrap gap-1" data-testid="inbox-order-checks">
            {VERIFIED_FIELDS.map((k) => (
              <li key={k} className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium", FIELD_CLASS[v.fields[k].state])} title={v.fields[k].reason ?? "Đủ"} data-check={k} data-check-state={v.fields[k].state}>
                {FIELD_LABEL[k]}: {v.fields[k].state}
              </li>
            ))}
          </ul>
          {v.state !== "ĐÃ TẠO ĐƠN" && v.reasons.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-[12px] text-amber-900 dark:text-amber-200" data-testid="inbox-order-reasons">
              {v.reasons.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          ) : null}

          {summary.review.length ? (
            <div className="rounded-md border border-amber-300/70 bg-amber-50/60 p-2 dark:border-amber-900/60 dark:bg-amber-950/20">
              <OrderReviewEntries entries={summary.review} reconfirms={summary.reconfirms} />
            </div>
          ) : null}

          {button.show ? (
            <div className="space-y-1">
              <Button type="button" size="sm" className="h-9 w-full" disabled={!button.enabled || pending} onClick={() => void confirm()} data-testid="inbox-order-confirm" title={button.reason ?? (button.kind === "RESOLVE" ? "Đơn đã «Đã xác nhận» — bấm để xác nhận lại sau khi kiểm (gỡ cờ cần kiểm)" : "Chuyển đơn sang «Đã xác nhận»")}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />} Xác nhận &amp; tạo đơn
              </Button>
              {button.reason ? (
                <p className="text-[11.5px] font-medium text-red-700 dark:text-red-300" data-testid="inbox-order-confirm-reason">
                  {button.reason}{" "}
                  <Link href={`/orders/${encodeURIComponent(summary.orderId)}/edit`} className="inline-flex items-center gap-0.5 underline">
                    <PencilLine className="size-3" /> Sửa đơn
                  </Link>
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
