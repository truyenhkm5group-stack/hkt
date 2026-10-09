import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { isSalesAgentUser, SALES_AGENT_CHANNELS_HREF, SALES_AGENT_INBOX_HREF } from "@/lib/constants/saas-nav";
import { FirstValueChecklist } from "@/components/onboarding/first-value-checklist";
import { loadFirstValue } from "@/lib/onboarding/go-live";
import { formatDate, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { METER_COVERAGE_LABEL } from "@/lib/pricing/versions";
import { readAiCustomerUsage, type AiCustomerReading } from "@/lib/pricing/ai-customer";
import { usagePeriodOf } from "@/lib/pricing/meter";
import { loadBasketStats } from "@/lib/sales-chatbot/basket";
import { listInbox } from "@/lib/sales-chatbot/inbox";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import { rateOrNull } from "@/lib/sales-chatbot/performance-shared";
import { cn } from "@/lib/utils";

export const metadata = { title: "Tổng quan" };

const PERIODS = [7, 30, 90] as const;
const pctOf = (v: number | null) => (v === null ? null : v * 100);
const duration = (ms: number | null) => (ms === null ? "—" : ms < 60_000 ? `${Math.round(ms / 1000)} giây` : `${(ms / 60_000).toFixed(1)} phút`);

function Tile({ label, value, sub, href, testId }: { label: string; value: string; sub?: string; href?: string; testId: string }) {
  const body = (
    <>
      <div className="text-[22px] font-bold leading-7 tabular-nums">{value}</div>
      <div className="mt-0.5 text-[13px] font-medium text-foreground/80">{label}</div>
      {sub ? <div className="mt-1 text-xs leading-4 text-muted-foreground">{sub}</div> : null}
    </>
  );
  const cls = "block min-h-[96px] min-w-0 rounded-2xl bg-card p-4 shadow-[var(--shadow-card)]";
  return href ? (
    <Link href={href} className={cn(cls, "transition-colors hover:bg-muted/60")} data-testid={testId}>
      {body}
    </Link>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

/**
 * TỔNG QUAN CỦA KHÁCH CHỐT ĐƠN TỰ ĐỘNG (vỏ app — lib/constants/saas-nav.ts). Gọn, đọc trên điện thoại: tám ô trả lời «AI đang
 * bán cho tôi thế nào». Không tính lại gì — mọi số đọc từ đúng các hàm của trang Hiệu quả AI bán hàng (sổ sự kiện của bot, kết
 * cục đơn ORDER_OUTCOME) và đồng hồ «khách AI» của gói. KHÔNG chi phí, token hay model: đó là số của nhà cung cấp, không phải của
 * shop. Số chưa đo in «—», không bao giờ 0 (AGENTS mục 42).
 */
export default async function SalesAgentOverviewPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const user = await requirePermission("ai_sales:view");
  const sp = await searchParams;
  const days = PERIODS.find((d) => String(d) === sp.days) ?? 30;
  const orgCode = user.organization?.code ?? "";
  const now = new Date();
  const period = usagePeriodOf(now);
  // Vỏ Chốt Đơn: MỘT danh sách thiết lập chín bước đứng đầu trang (lib/onboarding/go-live-shared.ts). Đọc hỏng ⇒ không vẽ danh
  // sách (trang vẫn mở được), không bao giờ vẽ một danh sách «xong» khi chưa đọc được gì.
  const [r, basket, inbox, usage, firstValue] = await Promise.all([
    loadAiSalesPerformance(orgCode, { days, withMoney: false, now }),
    loadBasketStats({ days, now }),
    listInbox(user, { limit: 50 }, now),
    orgCode ? readAiCustomerUsage([orgCode], period, now) : Promise.resolve(new Map<string, AiCustomerReading>()),
    isSalesAgentUser(user)
      ? loadFirstValue(user, now).catch((error: unknown) => {
          console.warn(`[tong-quan] không đọc được danh sách thiết lập: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        })
      : Promise.resolve(null),
  ]);
  const setupOpen = Boolean(firstValue?.show && !firstValue.allDone);
  const t = r.cohorts.total;
  const closeRate = rateOrNull(t.confirmed, t.conversations);
  const needsHuman = inbox.ok ? inbox.counts.NEEDS_HUMAN : null;
  const ai = usage.get(orgCode) ?? null;
  const canPlan = can(user, "settings:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        title="Tổng quan"
        description={`${days} ngày gần nhất${r.measuredSince ? ` · đo từ ${formatDate(r.measuredSince)}` : ""}`}
        refresh={false}
        actions={
          <div className="flex items-center gap-1" role="group" aria-label="Kỳ xem">
            {PERIODS.map((d) => (
              <Link key={d} href={`/ai/overview?days=${d}`} aria-current={d === days ? "true" : undefined} className={cn("inline-flex h-11 min-w-[64px] items-center justify-center rounded-full border px-3 text-sm", d === days ? "bg-ink font-semibold text-ink-foreground" : "bg-card hover:bg-muted")}>
                {d} ngày
              </Link>
            ))}
          </div>
        }
      />

      {firstValue ? <FirstValueChecklist view={firstValue} /> : null}

      {/* Lời nhắc «kết nối Facebook» cũ là một thẻ rải rác thứ hai — danh sách thiết lập đang mở thì nó đã nói việc đó. */}
      {r.measuredSince === null && !setupOpen ? (
        <p className="rounded-2xl bg-card p-4 text-sm text-muted-foreground shadow-[var(--shadow-card)]" data-testid="overview-empty">
          AI chưa trả lời khách nào kể từ khi bật đo lường — số sẽ hiện sau tin khách đầu tiên.{" "}
          <Link href={SALES_AGENT_CHANNELS_HREF} className="font-medium text-primary hover:underline">
            Kết nối Facebook ở mục Kênh kết nối →
          </Link>
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="overview-tiles">
        <Tile testId="ov-customers" label="Khách AI đã xử lý" value={formatNumber(t.conversations)} sub={`${formatNumber(r.cohorts.aiOnly.conversations)} AI tự xử lý trọn`} href={SALES_AGENT_INBOX_HREF} />
        <Tile testId="ov-orders" label="Đơn AI chốt" value={formatNumber(r.orders.confirmed)} sub={formatVND(r.orders.confirmedValueVnd)} />
        <Tile testId="ov-close-rate" label="Tỷ lệ chốt" value={formatPercent(pctOf(closeRate), 1)} sub={closeRate === null ? "chưa đủ mẫu" : `${formatNumber(t.confirmed)}/${formatNumber(t.conversations)} hội thoại`} />
        <Tile testId="ov-revenue" label="Doanh thu AI tạo ra" value={formatVND(r.orders.deliveredRevenueVnd)} sub={`${formatNumber(r.orders.delivered)} đơn giao thành công · ${formatNumber(r.orders.pending)} đang giao`} />
        <Tile testId="ov-response" label="Thời gian phản hồi" value={duration(r.response.medianMs)} sub={r.response.medianMs === null ? "chưa đủ mẫu" : `trung vị · ${formatNumber(r.response.samples)} lượt`} />
        <Tile testId="ov-upsell" label="Mua thêm · bán chéo" value={formatVND(r.upsell.offered ? r.upsell.revenueVnd : null)} sub={`nhận lời mời ${formatPercent(pctOf(r.upsell.attachRate), 0)} · đơn ≥ 2 sản phẩm ${formatPercent(pctOf(basket.booked.multiProductRate), 0)}`} />
        <Tile testId="ov-needs-human" label="Hội thoại cần người" value={formatNumber(needsHuman)} sub="AI đã chuyển cho nhân viên" href={`${SALES_AGENT_INBOX_HREF}?f=NEEDS_HUMAN`} />
        <Tile
          testId="ov-usage"
          label={`Khách AI tháng ${period.label}`}
          value={formatNumber(ai?.value ?? null)}
          sub={ai ? (ai.coverage === "MEASURED" ? `tính lại từ ${formatDate(period.resetsOn)}` : METER_COVERAGE_LABEL[ai.coverage]) : "chưa đo"}
          href={canPlan ? "/settings/plan" : undefined}
        />
      </div>

      <SectionCard title="Đơn AI chốt — đã giao tới đâu">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4" data-testid="overview-outcome">
          {(
            [
              ["Giao thành công", r.orders.delivered],
              ["Đang giao / chưa rõ", r.orders.pending],
              ["Hoàn", r.orders.returned],
              ["Huỷ", r.orders.cancelled],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="min-w-0">
              <dt className="text-xs text-muted-foreground">{k}</dt>
              <dd className="font-semibold tabular-nums">{formatNumber(v)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 text-xs text-muted-foreground">Doanh thu chỉ tính đơn đã giao thành công theo kết cục đơn chung của hệ thống — đơn còn đang giao chưa được cộng.</p>
        <Link href="/ai/sales-chatbot/performance" className="mt-3 inline-flex h-11 items-center text-sm font-medium text-primary hover:underline">
          Xem chi tiết hiệu quả AI →
        </Link>
      </SectionCard>
    </div>
  );
}
