import { FlaskConical, Scale, TrendingUp, Wallet } from "lucide-react";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { EmptyState, Money, SectionCard } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { requirePermission } from "@/lib/auth/session";
import { SCENARIO_LEVER_LABEL, SCENARIO_LEVER_NOTE, SCENARIO_LEVER_UNIT, SCENARIO_LIMIT, type ScenarioLeverKey } from "@/lib/constants/scenario";
import { formatNumber } from "@/lib/format";
import { getScenario, type ScenarioLevers } from "@/lib/queries/scenario";
import { resolvePeriod, type SearchParams } from "@/lib/search-params";
import { cn } from "@/lib/utils";

export const metadata = { title: "Mô phỏng kịch bản" };
export const dynamic = "force-dynamic";

const LEVERS: ScenarioLeverKey[] = ["successRatePoints", "pricePercent", "cogsPercent", "shippingPercent", "adSpendPercent", "opexPercent"];

function one(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function ScenarioPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requirePermission("reports:nominal");
  const raw = await searchParams;
  const period = resolvePeriod(raw, "30d");
  const levers: Partial<ScenarioLevers> = Object.fromEntries(LEVERS.map((k) => [k, Number(one(raw[k])) || 0])) as Partial<ScenarioLevers>;
  const r = await getScenario(period, levers);
  const rows: { label: string; base: number; next: number; better: "up" | "down" }[] = [
    { label: "Doanh thu giao thành công", base: r.base.revenue, next: r.next.revenue, better: "up" },
    { label: "Giá vốn", base: r.base.cogs, next: r.next.cogs, better: "down" },
    { label: "Cước vận chuyển", base: r.base.shipping, next: r.next.shipping, better: "down" },
    { label: "Phí hoàn", base: r.base.returnFee, next: r.next.returnFee, better: "down" },
    { label: "Phí sàn", base: r.base.marketplaceFee, next: r.next.marketplaceFee, better: "down" },
    { label: "Chi quảng cáo", base: r.base.adSpend, next: r.next.adSpend, better: "down" },
    { label: "Chi phí vận hành", base: r.base.operating, next: r.next.operating, better: "down" },
  ];
  const daiDien = r.levers;
  const dangMoPhong = LEVERS.some((k) => daiDien[k] !== 0);

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Tài chính"
        title="Mô phỏng kịch bản"
        description="Nếu tỷ lệ giao thành công tăng, giá vốn tăng, cước đổi — lợi nhuận đi về đâu."
        hint="Điểm xuất phát lấy nguyên từ báo cáo lợi nhuận của kỳ đang xem, cùng công thức và cùng ORDER_OUTCOME — không con số nào ở đây được gõ tay. Mô hình tuyến tính quanh điểm hiện tại: dùng để so sánh phương án, không dùng làm dự báo."
      />

      <SectionCard title="Đặt kịch bản" description={`Kỳ đang xem: ${period.label} · để trống là giữ nguyên hiện tại`}>
        <form method="get" className="space-y-4">
          {/* Giữ kỳ đang xem khi bấm tính lại */}
          <input type="hidden" name="period" value={period.key} />
          {period.fromKey ? <input type="hidden" name="from" value={period.fromKey} /> : null}
          {period.toKey ? <input type="hidden" name="to" value={period.toKey} /> : null}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {LEVERS.map((k) => {
              const unit = SCENARIO_LEVER_UNIT[k];
              const limit = unit === "points" ? SCENARIO_LIMIT.successRatePoints : SCENARIO_LIMIT.percent;
              return (
                <label key={k} className="block space-y-1">
                  <span className="text-[13px] font-medium">{SCENARIO_LEVER_LABEL[k]}</span>
                  <span className="flex items-center gap-2">
                    <input
                      type="number"
                      name={k}
                      defaultValue={daiDien[k] || ""}
                      min={-limit}
                      max={limit}
                      step={1}
                      placeholder="0"
                      className="numeric h-9 w-full rounded-md border bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    />
                    <span className="shrink-0 text-xs text-muted-foreground">{unit === "points" ? "điểm" : "%"}</span>
                  </span>
                  <span className="block text-[11px] leading-4 text-muted-foreground">{SCENARIO_LEVER_NOTE[k]}</span>
                </label>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm">
              <FlaskConical className="size-4" /> Tính lại
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="/reports/scenario">Đặt lại</a>
            </Button>
            <span className="text-xs text-muted-foreground">
              Giới hạn ±{SCENARIO_LIMIT.successRatePoints} điểm cho tỷ lệ giao và ±{SCENARIO_LIMIT.percent}% cho các đòn bẩy còn lại — xa hơn thì phép ngoại suy tuyến tính không còn nghĩa.
            </span>
          </div>
        </form>
      </SectionCard>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Lợi nhuận hiện tại"
          value={<Money value={r.base.netProfit} />}
          note={`${formatNumber(r.base.successOrders)}/${formatNumber(r.base.finishedOrders)} đơn kết thúc giao thành công${r.base.successRate === null ? "" : ` · ${r.base.successRate}%`}`}
          icon={Wallet}
          tone={r.base.netProfit >= 0 ? "green" : "rose"}
        />
        <MetricCard
          label="Lợi nhuận kịch bản"
          value={<Money value={r.next.netProfit} />}
          note={dangMoPhong ? `Tỷ lệ giao ${r.next.successRate === null ? "—" : `${r.next.successRate}%`} · biên ${r.next.margin === null ? "—" : `${r.next.margin}%`}` : "Chưa đặt đòn bẩy nào — bằng đúng hiện tại"}
          icon={TrendingUp}
          tone={r.next.netProfit >= r.base.netProfit ? "green" : "rose"}
        />
        <MetricCard
          label="Chênh lệch"
          value={<Money value={r.profitDelta} sign />}
          note="Kịch bản trừ hiện tại · dương là tốt hơn"
          icon={Scale}
          tone={r.profitDelta > 0 ? "green" : r.profitDelta < 0 ? "rose" : "slate"}
        />
        <MetricCard
          label="Hoà vốn ở tỷ lệ giao"
          value={r.breakEvenSuccessRate === null ? "—" : `${r.breakEvenSuccessRate}%`}
          note={
            r.breakEvenSuccessRate === null
              ? "Chưa giải được: không đủ đơn kết thúc, hoặc mỗi đơn giao thêm vẫn không bù nổi chi phí"
              : "Giữ nguyên các đòn bẩy khác của kịch bản, cần đạt mức này để không lỗ"
          }
          icon={Scale}
          tone={r.breakEvenSuccessRate === null ? "slate" : r.base.successRate !== null && r.base.successRate >= r.breakEvenSuccessRate ? "green" : "amber"}
        />
      </section>

      <SectionCard title="Từng dòng lãi lỗ" description="Hiện tại so với kịch bản" padded={false}>
        {r.base.finishedOrders === 0 ? (
          <EmptyState
            title="Chưa có đơn nào kết thúc trong kỳ"
            description="Mô phỏng cần điểm xuất phát là đơn ĐÃ kết thúc (giao thành công hoặc hoàn). Đơn đang giao chưa ngã ngũ nên không đưa vào được — chọn kỳ dài hơn."
          />
        ) : (
        <div className="overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow>
                <TableHead>Khoản</TableHead>
                <TableHead className="text-right">Hiện tại</TableHead>
                <TableHead className="text-right">Kịch bản</TableHead>
                <TableHead className="text-right">Chênh</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const delta = row.next - row.base;
                const tot = row.better === "up" ? delta > 0 : delta < 0;
                return (
                  <TableRow key={row.label}>
                    <TableCell className="font-medium">{row.label}</TableCell>
                    <TableCell className="text-right"><Money value={row.base} /></TableCell>
                    <TableCell className="text-right"><Money value={row.next} /></TableCell>
                    <TableCell className={cn("text-right", delta !== 0 && (tot ? "text-success" : "text-rose-600 dark:text-rose-400"))}>
                      {delta === 0 ? "—" : <Money value={delta} sign />}
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow className="border-t-2">
                <TableCell className="font-bold">Lợi nhuận ròng</TableCell>
                <TableCell className="text-right font-bold"><Money value={r.base.netProfit} /></TableCell>
                <TableCell className="text-right font-bold"><Money value={r.next.netProfit} /></TableCell>
                <TableCell className={cn("text-right font-bold", r.profitDelta > 0 ? "text-success" : r.profitDelta < 0 ? "text-rose-600 dark:text-rose-400" : "")}>
                  {r.profitDelta === 0 ? "—" : <Money value={r.profitDelta} sign />}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
        )}
      </SectionCard>

      <SectionCard title="Đọc trước khi tin con số" description="Giả định của mô hình" padded={false}>
        <div className="px-5 py-3 text-xs leading-5 text-muted-foreground">
          <p className="font-medium text-foreground">
            Độ phủ quy kết quảng cáo: {r.adsAttributionCoverage === null ? "chưa đo được" : `${r.adsAttributionCoverage}%`} — vì sao đòn bẩy chi quảng cáo CHỈ tính phần chi, không cho doanh thu tăng theo.
          </p>
          <ul className="mt-1.5 space-y-0.5">
            {r.assumptions.map((a, i) => (
              <li key={i}>• {a}</li>
            ))}
          </ul>
        </div>
      </SectionCard>
    </div>
  );
}
