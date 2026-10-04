import Link from "next/link";
import { PeriodFilter } from "@/components/data-table/toolbar";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { StatStrip } from "@/components/stat-tile";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { decideScope } from "@/lib/auth/scope-guard";
import { requirePermission } from "@/lib/auth/session";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { COMPARE_DIMENSION_LABEL, COMPARE_DIMENSIONS, wholesaleDashboard, type CompareDimension } from "@/lib/queries/wholesale";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { microsToVnd } from "@/lib/wholesale/config";
import { getLeadHunterConfig } from "@/lib/wholesale/store";
import { WholesaleNav } from "@/app/(dashboard)/wholesale/wholesale-nav";
import { cn } from "@/lib/utils";

export const metadata = { title: "Hiệu quả khách sỉ" };

const FUNNEL: { key: "discovered" | "qualified" | "contacted" | "responded" | "interested" | "negotiating" | "won"; label: string }[] = [
  { key: "discovered", label: "Tìm thấy" },
  { key: "qualified", label: "Đủ điều kiện" },
  { key: "contacted", label: "Đã liên hệ" },
  { key: "responded", label: "Có phản hồi" },
  { key: "interested", label: "Quan tâm" },
  { key: "negotiating", label: "Thương lượng" },
  { key: "won", label: "Chốt được" },
];

export default async function WholesaleDashboardPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const user = await requirePermission("wholesale:view");
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return <ScopeDenied title="Hiệu quả khách sỉ" reason={decision.reason} fix={decision.fix} />;
  const raw = await searchParams;
  const period = resolvePeriod(raw, "all");
  const dim: CompareDimension = (COMPARE_DIMENSIONS as readonly string[]).includes(String(raw.by)) ? (raw.by as CompareDimension) : "keyword";
  const [d, cfg] = await Promise.all([wholesaleDashboard({ from: period.from, to: period.to, dimension: dim, decision }), getLeadHunterConfig()]);
  const k = d.kpi;
  const vnd = (micros: number | null) => (micros == null ? null : microsToVnd(micros, cfg.usdToVnd));
  const max = Math.max(1, d.funnel.discovered);
  const qs = (by: string) => {
    const p = new URLSearchParams();
    for (const [key, v] of Object.entries(raw)) if (typeof v === "string" && key !== "by") p.set(key, v);
    p.set("by", by);
    return `?${p.toString()}`;
  };
  return (
    <div className="space-y-4">
      <PageHeader
        eyebrow="Săn khách sỉ"
        title="Hiệu quả khách sỉ"
        description={`Lead tìm thấy trong kỳ «${period.label}» đã đi tới đâu, ra bao nhiêu khách và doanh thu.`}
        hint="Kỳ lọc theo NGÀY TÌM THẤY lead. Doanh thu = đơn ĐÃ GIAO của khách chuyển từ lead (cùng công thức với trang Khách hàng). Tỷ lệ và doanh thu / 100 lead chỉ hiện khi nhóm có từ 20 lead trở lên — ít hơn thì con số không nói gì. Chi phí API là ước tính theo đơn giá đã khai."
        actions={<PeriodFilter defaultKey="all" />}
      />
      <WholesaleNav user={user} active="dashboard" />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Tổng lead" value={formatNumber(k.total)} note={`+${formatNumber(k.newToday)} hôm nay · ${formatNumber(k.gradeA)} hạng A`} emphasis />
        <MetricCard label="Chốt được" value={formatNumber(k.won)} note={`Tỷ lệ chuyển đổi ${formatPercent(k.conversionRate == null ? null : k.conversionRate * 100)}`} tone="green" />
        <MetricCard label="Doanh thu từ lead sỉ" value={formatVND(k.revenue)} note={`${k.revenuePer100 == null ? "—" : formatVND(k.revenuePer100)} / 100 lead`} tone="blue" />
        <MetricCard label="Chi phí API (ước tính)" value={formatVND(vnd(k.costMicros))} note={`${k.costPerQualifiedMicros == null ? "—" : formatVND(vnd(k.costPerQualifiedMicros))} / lead đủ điều kiện`} tone="slate" />
      </div>
      <StatStrip
        columns={5}
        items={[
          { label: "Có SĐT", value: formatNumber(k.withPhone) },
          { label: "Đã liên hệ", value: formatNumber(k.contacted), note: `phản hồi ${formatPercent(k.responseRate == null ? null : k.responseRate * 100)}` },
          { label: "Quan tâm", value: formatNumber(d.funnel.interested), note: `${formatPercent(k.interestedRate == null ? null : k.interestedRate * 100)} số đã liên hệ` },
          { label: "Đã gửi catalog / giá", value: formatNumber(k.catalogSent), note: `${formatNumber(k.negotiating)} đang thương lượng` },
          { label: "Chi phí / khách sỉ chốt", value: k.costPerWonMicros == null ? "—" : formatVND(vnd(k.costPerWonMicros)) },
        ]}
      />

      <SectionCard title="Phễu">
        {d.funnel.discovered ? (
          <div className="space-y-1.5">
            {FUNNEL.map((s, i) => {
              const v = d.funnel[s.key];
              const prev = i ? d.funnel[FUNNEL[i - 1]!.key] : null;
              return (
                <div key={s.key} className="flex items-center gap-3 text-sm">
                  <span className="w-28 shrink-0">{s.label}</span>
                  <span className="relative h-5 flex-1 overflow-hidden rounded bg-muted">
                    <span className="absolute inset-y-0 left-0 bg-primary/80" style={{ width: `${(v / max) * 100}%` }} />
                  </span>
                  <span className="w-16 text-right font-semibold tabular-nums">{formatNumber(v)}</span>
                  <span className="w-20 text-right text-xs text-muted-foreground">{prev ? formatPercent((v / prev) * 100) : ""}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState title="Chưa có lead nào trong kỳ" action={<Link className="text-primary hover:underline" href="/wholesale/lead-hunter">Chạy chiến dịch đầu tiên</Link>} />
        )}
      </SectionCard>

      <SectionCard title="So sánh" description="Nhóm nào ra khách sỉ và doanh thu tốt nhất trên mỗi 100 lead — nơi nên quét tiếp.">
        <div className="mb-3 flex flex-wrap gap-1.5 text-sm">
          {COMPARE_DIMENSIONS.map((x) => (
            <Link key={x} href={qs(x)} className={cn("rounded-md border px-2 py-1", x === dim ? "border-primary bg-primary/10 font-medium" : "text-muted-foreground hover:text-foreground")}>
              {COMPARE_DIMENSION_LABEL[x]}
            </Link>
          ))}
        </div>
        {d.rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="py-1.5 pr-3 text-left font-medium">{COMPARE_DIMENSION_LABEL[dim]}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Lead</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Đủ ĐK</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Đã LH</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Phản hồi</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Quan tâm</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Chốt</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Tỷ lệ chốt</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Doanh thu</th>
                  <th className="py-1.5 pr-3 text-right font-medium">DT / 100 lead</th>
                  {dim === "campaign" ? <th className="py-1.5 text-right font-medium">Chi phí API</th> : null}
                </tr>
              </thead>
              <tbody>
                {d.rows.map((r) => (
                  <tr key={r.key} className="border-b last:border-0">
                    <td className="max-w-[260px] truncate py-1.5 pr-3">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(r.discovered)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(r.qualified)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(r.contacted)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(r.responded)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatNumber(r.interested)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{formatNumber(r.won)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatPercent(r.winRate == null ? null : r.winRate * 100)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{formatVND(r.revenue, { compact: true })}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{r.revenuePer100 == null ? "—" : formatVND(r.revenuePer100, { compact: true })}</td>
                    {dim === "campaign" ? <td className="py-1.5 text-right tabular-nums">{r.costMicros == null ? "—" : formatVND(vnd(r.costMicros), { compact: true })}</td> : null}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-muted-foreground">«—» = nhóm dưới {d.minSample} lead: chưa đủ mẫu để so sánh, không phải 0.</p>
          </div>
        ) : (
          <EmptyState title="Chưa có dữ liệu để so sánh" />
        )}
      </SectionCard>
    </div>
  );
}
