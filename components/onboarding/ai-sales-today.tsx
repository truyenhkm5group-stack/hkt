import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { SectionCard } from "@/components/ui-bits";
import { can, type SessionUser } from "@/lib/auth/session";
import { formatNumber, formatVND } from "@/lib/format";
import { canUseModule } from "@/lib/platform/capabilities";
import { loadOrderAttribution } from "@/lib/sales-chatbot/attribution";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { SALES_CHATBOT_MANAGE } from "@/lib/sales-chatbot/settings";

function Big({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border bg-muted/30 px-3 py-2.5">
      <div className="text-xl font-bold tabular-nums leading-tight">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

/**
 * «HÔM NAY AI LÀM RA BAO NHIÊU» — khối đầu trang chủ của tổ chức dùng AI bán hàng (docs/product-audit.md P5).
 *
 * Không có công thức riêng: đọc ĐÚNG hai hàm của màn «Hiệu quả» (`loadAiSalesPerformance`, `loadOrderAttribution`), nên số
 * ở đây và số ở màn chi tiết không thể lệch nhau. Hai mốc tách bạch vì chúng nói hai điều khác nhau:
 *  · HÔM NAY — đơn vừa chốt chưa kịp giao, nên chỉ có giá trị ĐẶT (không gọi là doanh thu);
 *  · 30 NGÀY — doanh thu GIAO THÀNH CÔNG theo ORDER_OUTCOME.
 * Không hiện gì khi module tắt, người xem không có quyền, hoặc sổ sự kiện chưa có dòng nào (chưa đo ≠ 0).
 */
export async function AiSalesToday({ user }: { user: SessionUser }) {
  if (!(await canUseModule("ai_sales")) || !can(user, "ai_sales:view")) return null;
  const orgCode = user.organization?.code ?? "";
  const withMoney = can(user, SALES_CHATBOT_MANAGE);
  const [today, month, attrToday, attrMonth] = await Promise.all([
    loadAiSalesPerformance(orgCode, { days: 1, withMoney }),
    loadAiSalesPerformance(orgCode, { days: 30, withMoney: false }),
    loadOrderAttribution({ days: 1 }),
    loadOrderAttribution({ days: 30 }),
  ]);
  if (month.measuredSince === null) return null;
  const t = attrToday.table;
  const m = attrMonth.table;
  return (
    <SectionCard
      title="Hôm nay AI làm ra bao nhiêu"
      description="Đơn chốt hôm nay chưa kịp giao — nên hôm nay là giá trị ĐẶT; doanh thu đã giao đọc theo 30 ngày."
      actions={
        <Link href="/ai/sales-chatbot/performance" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
          Chi tiết <ArrowRight className="size-3.5" />
        </Link>
      }
    >
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="ai-today">
        <Big label="AI tự bán hôm nay" value={formatVND(t.AI_ONLY.valueVnd)} sub={`${formatNumber(t.AI_ONLY.orders)} đơn · giá trị đặt`} />
        <Big label="AI góp công hôm nay" value={formatVND(t.AI_ASSISTED.valueVnd)} sub={`${formatNumber(t.AI_ASSISTED.orders)} đơn · giá trị đặt`} />
        <Big label="hội thoại hôm nay" value={formatNumber(today.cohorts.total.conversations)} sub={`${formatNumber(today.cohorts.aiThenHuman.conversations)} chuyển người`} />
        {today.cost ? (
          <Big label="chi phí AI hôm nay" value={formatVND(today.cost.sellingVnd)} sub={today.cost.perConfirmedOrderVnd === null ? "chưa có đơn bot chốt" : `${formatVND(today.cost.perConfirmedOrderVnd)} / đơn bot chốt`} />
        ) : (
          <Big label="đơn bot chốt hôm nay" value={formatNumber(today.orders.confirmed)} />
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4" data-testid="ai-month">
        <Big label="doanh thu đã giao · AI tự bán · 30 ngày" value={formatVND(m.AI_ONLY.deliveredRevenueVnd)} sub={`${formatNumber(m.AI_ONLY.delivered)}/${formatNumber(m.AI_ONLY.orders)} đơn đã giao`} />
        <Big label="doanh thu đã giao · AI góp công · 30 ngày" value={formatVND(m.AI_ASSISTED.deliveredRevenueVnd)} sub={`${formatNumber(m.AI_ASSISTED.delivered)}/${formatNumber(m.AI_ASSISTED.orders)} đơn đã giao`} />
        <Big label="follow-up thu hồi · đã giao · 30 ngày" value={formatVND(attrMonth.followup.recoveredDeliveredRevenueVnd)} sub={`${formatNumber(attrMonth.followup.recoveredOrders)} đơn thu hồi`} />
        <Big label="hội thoại · 30 ngày" value={formatNumber(month.cohorts.total.conversations)} sub={`${formatNumber(month.orders.confirmed)} đơn bot chốt`} />
      </div>
    </SectionCard>
  );
}
