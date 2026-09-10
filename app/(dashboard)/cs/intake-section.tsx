import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { formatNumber, formatVND } from "@/lib/format";
import { getOrderIntakeMetrics } from "@/lib/queries/order-intake";
import { cn } from "@/lib/utils";

/**
 * ───────────── KHÂU CHỐT ĐƠN: ĐỦ THÔNG TIN → CÓ ĐƠN ─────────────
 *
 * Đây là KPI thật của khâu chốt, và trước đây không đo được vì định nghĩa sai: luật cũ gọi "đã
 * chốt" là bất kỳ hội thoại nào có shop nói chữ "chốt đơn" — kể cả trong câu MỜI chốt.
 *
 * Thời gian đo từ lúc KHÁCH đưa đủ SĐT + địa chỉ, KHÔNG phải từ lúc job quét thấy: lấy mốc quét là
 * đo tốc độ của máy, không đo tốc độ của người.
 */
export async function OrderIntakeSection() {
  const m = await getOrderIntakeMetrics(30);
  if (!m.infoComplete) return null;

  const gio = (h: number | null) => (h === null ? "chưa đo được" : h < 1 ? "<1 giờ" : h < 24 ? `${Math.round(h)} giờ` : `${(h / 24).toFixed(1)} ngày`);

  return (
    <SectionCard
      title="Khâu chốt đơn · đủ thông tin → có đơn"
      description={`${m.windowDays} ngày qua. "Đủ thông tin" = khách đã cho cả SĐT và địa chỉ — tương đương trạng thái đơn mới trên Pancake.`}
      hint="Thời gian tính từ lúc KHÁCH đưa đủ thông tin, không phải từ lúc job quét thấy. Lấy mốc quét là đo tốc độ của máy chứ không đo tốc độ của CSKH."
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Khách đủ thông tin</div>
          <div className="numeric text-lg font-bold">{formatNumber(m.infoComplete)}</div>
          <div className="text-[11.5px] text-muted-foreground">Đã cho cả SĐT và địa chỉ</div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Đã lên đơn</div>
          <div className="numeric text-lg font-bold text-emerald-700 dark:text-emerald-300">
            {formatNumber(m.orderCreatedAfterInfo)}
            {m.conversion !== null ? <span className="ml-1 text-[12px] font-medium text-muted-foreground">· {Math.round(m.conversion * 100)}%</span> : null}
          </div>
          <div className="text-[11.5px] text-muted-foreground">
            giữa {gio(m.medianHoursToOrder)} · p90 {gio(m.p90HoursToOrder)}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Chưa lên đơn</div>
          <div className={cn("numeric text-lg font-bold", m.orderNotCreated ? "text-rose-600 dark:text-rose-400" : "")}>{formatNumber(m.orderNotCreated)}</div>
          <div className="text-[11.5px] text-muted-foreground">
            {m.slaBreach ? `${formatNumber(m.slaBreach)} quá hạn ${m.slaHours} giờ · ` : ""}
            {formatNumber(m.unassigned)} chưa ai nhận · {m.ownerLabel}
          </div>
        </div>
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Giá trị đã chuyển thành đơn</div>
          <div className="numeric text-lg font-bold">{formatVND(m.convertedOrderValue)}</div>
          <div className="text-[11.5px] text-muted-foreground">Số THẬT, đo từ đơn đã tạo</div>
        </div>
      </div>

      {/*
        KHÔNG BỊA "TIỀN ĐANG TREO" CHO NHÓM CHƯA CÓ ĐƠN.

        Nhân số khách chờ với giá trị đơn trung bình sẽ ra một con số nghe rất cụ thể mà không có gì
        đứng sau: khách chưa chốt mẫu mã thì chưa có giá trị nào để nói.
      */}
      <p className="mt-3 border-t pt-3 text-[12px] leading-snug text-muted-foreground">{m.atRiskNote}</p>

      {m.orderNotCreated > 0 ? (
        <Link
          href="/cs?kind=ORDER_NOT_CREATED&status=OPEN"
          className="mt-2 inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[12px] font-medium hover:bg-accent"
        >
          Xem {formatNumber(m.orderNotCreated)} khách chờ lên đơn <ArrowRight className="size-3.5" />
        </Link>
      ) : null}
    </SectionCard>
  );
}
