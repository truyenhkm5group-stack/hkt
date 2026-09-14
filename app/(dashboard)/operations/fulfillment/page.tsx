import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { QueueViewTabs } from "@/components/queue-view-tabs";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { InfoHint } from "@/components/info-hint";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime, formatNumber, formatVND } from "@/lib/format";
import { getFulfillmentBottleneckQueue } from "@/lib/queries/fulfillment-bottleneck";
import { cn } from "@/lib/utils";

export const metadata = { title: "Nút thắt trước khi rời kho" };

/**
 * ═══════════ NÚT THẮT FULFILLMENT NỘI BỘ: đã chốt → sẵn sàng gửi → tạo vận đơn → ĐVVC nhận/lấy hàng → rời kho ═══════════
 *
 * MỘT HÀNG ĐỢI, không phải một bảng điều khiển: đơn cần LÀM một việc cụ thể mới đứng ở đây, xếp
 * theo trễ hạn → tiền treo → tuổi. Không có biểu đồ, không có nhiều thẻ số — mở trang là thấy việc
 * đầu tiên phải làm.
 *
 * Đọc TRỰC TIẾP từ `orders`/`shipments`/`shipment_events` (xem lib/queries/fulfillment-bottleneck.ts),
 * không qua hàng đợi cảnh báo chung — nên số ở đây LUÔN đúng ngay lúc mở trang, không phụ thuộc lần
 * chạy job cảnh báo gần nhất.
 */
export default async function FulfillmentBottleneckPage() {
  await requirePermission("dashboard:view");
  const queue = await getFulfillmentBottleneckQueue();

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Nút thắt trước khi rời kho"
        description="Đơn đã chốt nhưng chưa thật sự đi giao: thiếu dữ liệu, chưa có vận đơn, ĐVVC chưa nhận, hoặc chưa lấy hàng."
        hint={
          <>
            <p>
              Phạm vi: <b>đã xác nhận → sẵn sàng gửi → tạo vận đơn → ĐVVC nhận / lấy hàng → rời kho</b>. Đơn chưa xác nhận (việc của
              Sales Funnel/CSKH) và đơn đã huỷ KHÔNG xuất hiện ở đây.
            </p>
            <p className="mt-1.5">
              <b>Tạo vận đơn KHÔNG được tính là đã rời kho.</b> Vận đơn còn <code>PENDING</code> (chưa có mốc lấy hàng) vẫn đứng trong
              hàng đợi này, dù đã có mã tra cứu.
            </p>
          </>
        }
        actions={<QueueViewTabs active="fulfillment" />}
      />

      {!queue.ok ? (
        <div className="flex items-start gap-3 rounded-xl border border-rose-300/70 bg-rose-50/60 px-4 py-3 dark:border-rose-900/60 dark:bg-rose-950/20">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-700 dark:text-rose-300" />
          <p className="text-[13px]">Không đọc được dữ liệu nút thắt fulfillment — có thể CSDL đang thiếu bảng/cột cần thiết. Thử tải lại trang.</p>
        </div>
      ) : (
        <SectionCard
          title={`${formatNumber(queue.total)} đơn đang kẹt`}
          description={`${formatVND(queue.moneyAtRisk)} đang treo · ${formatNumber(queue.breached)} trễ hạn${queue.total ? ` · đo lúc ${formatDateTime(queue.measuredAt)}` : ""}`}
          hint="Xếp theo TRỄ HẠN trước, rồi TIỀN TREO nhiều trước, rồi ĐỂ LÂU NHẤT trước — không phải cảm tính."
          padded={false}
        >
          {queue.byReason.length > 1 ? (
            <div className="flex flex-wrap gap-2 border-b px-5 py-3">
              {queue.byReason.map((r) => (
                <span key={r.reason} className="rounded-lg border bg-muted/30 px-2.5 py-1 text-[11.5px]">
                  {r.label} <b className="numeric">{formatNumber(r.count)}</b>
                  {r.breached ? <span className="ml-1 text-rose-600 dark:text-rose-400">{formatNumber(r.breached)} trễ</span> : null}
                </span>
              ))}
            </div>
          ) : null}

          {queue.cases.length === 0 ? (
            <EmptyState title="Không đơn nào đang kẹt ở khâu này" description="Mọi đơn đã chốt đều đã có vận đơn rời kho đúng hạn." className="m-4" />
          ) : (
            <ul className="divide-y">
              {queue.cases.map((c) => (
                <li key={`${c.orderId}-${c.shipmentId ?? "none"}`} className="flex flex-wrap items-start gap-3 px-5 py-3">
                  <span
                    className={cn(
                      "mt-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap",
                      c.sla.breached
                        ? "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300"
                        : "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
                    )}
                  >
                    {c.reasonLabel}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <Link href={c.href} className="text-sm font-semibold hover:text-primary hover:underline">
                        {c.orderLabel}
                      </Link>
                      {c.chatHref ? (
                        <a href={c.chatHref} target="_blank" rel="noreferrer" className="rounded border px-1.5 py-px text-[10.5px] font-medium text-muted-foreground hover:bg-accent">
                          Mở chat
                        </a>
                      ) : null}
                      <InfoHint label="Nên làm gì">
                        <p>
                          <b>Nên làm:</b> {c.nextAction}
                        </p>
                        <p className="mt-1">
                          <b>Phụ trách:</b> {c.teamLabel}
                        </p>
                      </InfoHint>
                    </div>
                    <p className="text-xs text-muted-foreground">{c.reasonDetail}</p>
                    <p className="text-[10.5px] text-muted-foreground" title={formatDateTime(c.detectedAt)}>
                      {c.teamLabel} · đứng {c.ageLabel} ở trạng thái này
                      {c.moneyAtRisk > 0 ? ` · ${formatVND(c.moneyAtRisk)} đang treo` : ""}
                      <span className={cn("ml-1 font-semibold", c.sla.breached && "text-rose-600 dark:text-rose-400")} title={`Hạn xử lý ${formatDateTime(c.sla.dueAt)}`}>
                        · {c.sla.breached ? `trễ hạn ${formatNumber(Math.round(-c.sla.hoursRemaining))} giờ` : `còn ${formatNumber(Math.round(c.sla.hoursRemaining))} giờ`}
                      </span>
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      )}
    </div>
  );
}
