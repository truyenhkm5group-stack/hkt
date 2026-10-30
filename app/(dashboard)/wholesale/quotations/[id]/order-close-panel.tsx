"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { linkBankTransaction } from "@/lib/actions/bank";
import { createOrderFromQuotationAction } from "@/lib/actions/wholesale-order-close";
import { formatDateTime, formatVND } from "@/lib/format";
import type { OrderBankView } from "@/lib/wholesale/order-close";

/**
 * Chốt đơn sỉ trên trang báo giá: «Tạo đơn sỉ» (lõi đơn tạo tay, giá = ảnh chụp báo giá) và ĐỀ NGHỊ đối chiếu chuyển khoản. Máy KHÔNG
 * ghi tiền: «Nối» là hành động nối của sổ ngân hàng (loại ORDER, quyền bank:write) — đối chiếu, không tạo phiếu thu.
 */
export function OrderClosePanel({ quotationId, accepted, canOrder, order, bank, canLink }: { quotationId: string; accepted: boolean; canOrder: boolean; order: { id: string; stage: string; due: number } | null; bank: OrderBankView | null; canLink: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const create = () =>
    start(async () => {
      const r = await createOrderFromQuotationAction(quotationId);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.replayed ? "Đơn đã có từ trước." : "Đã tạo đơn sỉ (trạng thái Mới) — kiểm rồi chốt ở trang đơn.");
        router.refresh();
      }
    });
  const link = (txnId: string) =>
    start(async () => {
      const r = await linkBankTransaction({ id: txnId, type: "ORDER", targetId: bank?.orderId ?? "", note: "Đối chiếu từ báo giá sỉ" });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã nối ${formatVND(r.amount)} với đơn — chỉ là đối chiếu; phiếu thu vẫn ghi ở trang đơn.`);
        router.refresh();
      }
    });
  if (!order) {
    if (!accepted) return null;
    return (
      <div className="rounded-md border p-3 text-sm" data-order-close>
        <div className="mb-2">Khách đã chấp nhận báo giá. Tạo đơn sỉ bằng lõi đơn tạo tay — dòng hàng và giá lấy đúng từ báo giá.</div>
        {canOrder ? (
          <Button size="sm" disabled={pending} onClick={create}>
            Tạo đơn sỉ
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">Cần quyền tạo đơn (orders:write).</p>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-order-close>
      <div>
        Đơn sỉ: <Link href={`/orders/${order.id}`} className="font-semibold underline">{order.id}</Link> · phải trả {formatVND(order.due)}
      </div>
      {bank ? (
        <div className="space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">Đối chiếu chuyển khoản (đề nghị — số tiền đúng bằng {formatVND(bank.due)} và nội dung có mã {bank.codes.join(" / ")})</div>
          {bank.linked.map((x) => (
            <div key={x.txnId} className="text-xs text-emerald-700 dark:text-emerald-400">
              Đã nối: {formatVND(x.amount)} · {formatDateTime(x.txnAt)} · {x.description}
            </div>
          ))}
          {bank.suggestions.length ? (
            bank.suggestions.map((s) => (
              <div key={s.txnId} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1 text-xs">
                <span>
                  {formatDateTime(s.txnAt)} · {formatVND(s.amount)} · {s.counterparty || "—"} · «{s.description}»
                </span>
                {canLink ? (
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => link(s.txnId)}>
                    Nối
                  </Button>
                ) : null}
              </div>
            ))
          ) : (
            <p className="text-xs text-muted-foreground">Chưa thấy giao dịch nào khớp cả số tiền lẫn mã. Không nối theo số tiền gần đúng.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
