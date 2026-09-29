import { formatNumber } from "@/lib/format";
import { AI_BILLING_SOURCE_LABEL, AI_USAGE_FEATURE_LABEL, formatUsd, type AiBillingSource, type AiLimits, type AiSourceUsage, type AiUsageFeature } from "@/lib/ai-usage/types";
import type { AiUsageDayRow, AiUsageTotals } from "@/lib/ai-usage/ledger";
import { cn } from "@/lib/utils";

/**
 * Bảng DÙNG AI dùng chung cho `/settings/plan` (tổ chức) và `/platform/org/<mã>` (người vận hành). Chỉ hiển thị —
 * không import mã máy chủ ngoài `import type`. "—" = CHƯA BIẾT (luật 42): tiền của lượt model chưa có giá, không phải 0.
 */

const th = "px-3 py-2";
const thead = "bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground";

function costCell(cost: number | null, unknown: number) {
  return (
    <span title={unknown ? `${unknown} lượt chưa định giá được (model chưa có trong bảng giá / lượt hỏng) — tổng chỉ cộng lượt đã biết giá` : undefined}>
      {formatUsd(cost)}
      {unknown ? <span className="ml-1 text-[11px] text-muted-foreground">+{unknown} chưa rõ</span> : null}
    </span>
  );
}

export function AiUsageTotalsTable({ today, month }: { today: AiUsageTotals[]; month: AiUsageTotals[] }) {
  const sources = [...new Set([...month.map((r) => r.source), ...today.map((r) => r.source)])];
  if (sources.length === 0) return <p className="px-5 py-3 text-xs text-muted-foreground">Chưa có lượt AI nào trong tháng này.</p>;
  const pick = (rows: AiUsageTotals[], s: AiBillingSource) => rows.find((r) => r.source === s);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm" data-ai-usage-totals>
        <thead className={thead}>
          <tr>
            <th className={th}>Nguồn trả tiền</th>
            <th className={cn(th, "text-right")}>Hôm nay · lượt</th>
            <th className={cn(th, "text-right")}>Hôm nay · tiền ước tính</th>
            <th className={cn(th, "text-right")}>Tháng · lượt (lời gọi)</th>
            <th className={cn(th, "text-right")}>Tháng · token vào / ra</th>
            <th className={cn(th, "text-right")}>Tháng · tiền ước tính</th>
            <th className={cn(th, "text-right")}>Bị chặn</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const d = pick(today, s);
            const m = pick(month, s);
            return (
              <tr key={s} className="border-t border-hairline" data-source={s}>
                <td className="px-3 py-1.5">{AI_BILLING_SOURCE_LABEL[s]}</td>
                <td className="numeric px-3 py-1.5 text-right">{formatNumber(d?.turns ?? 0)}</td>
                <td className="numeric px-3 py-1.5 text-right">{d ? costCell(d.costUsd, d.unknownCost) : formatUsd(0)}</td>
                <td className="numeric px-3 py-1.5 text-right">
                  {formatNumber(m?.turns ?? 0)} <span className="text-muted-foreground">({formatNumber(m?.requests ?? 0)})</span>
                </td>
                <td className="numeric px-3 py-1.5 text-right">
                  {formatNumber(m?.inputTokens ?? 0)} / {formatNumber(m?.outputTokens ?? 0)}
                </td>
                <td className="numeric px-3 py-1.5 text-right">{m ? costCell(m.costUsd, m.unknownCost) : formatUsd(0)}</td>
                <td className={cn("numeric px-3 py-1.5 text-right", (m?.blocked ?? 0) > 0 && "font-semibold text-destructive")}>{formatNumber(m?.blocked ?? 0)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const lim = (v: number | null, unit: string) => (v === null ? "Không giới hạn" : `${v.toLocaleString("vi-VN")} ${unit}`);

/** Hạn mức đang áp (gói + ghi đè) cạnh mức đang dùng, theo nguồn tính hạn mức. */
export function AiLimitsTable({ limits, usage, undeclared }: { limits: AiLimits; usage: Record<"BYOK" | "PLATFORM", AiSourceUsage>; undeclared: boolean }) {
  const rows: { label: string; byok: string; platform: string; over: boolean }[] = [
    { label: "Lượt / ngày", byok: `${usage.BYOK.requestsToday} / ${lim(limits.requestsPerDay, "lượt")}`, platform: `${usage.PLATFORM.requestsToday} / ${lim(limits.requestsPerDay, "lượt")}`, over: limits.requestsPerDay !== null && usage.BYOK.requestsToday >= limits.requestsPerDay },
    { label: "Lượt / tháng", byok: `${usage.BYOK.requestsMonth} / ${lim(limits.requestsPerMonth, "lượt")}`, platform: `${usage.PLATFORM.requestsMonth} / ${lim(limits.requestsPerMonth, "lượt")}`, over: limits.requestsPerMonth !== null && usage.BYOK.requestsMonth >= limits.requestsPerMonth },
    {
      label: "Tiền / tháng — cảnh báo · trần cứng",
      byok: `${formatUsd(usage.BYOK.costUsdMonth)} / ${limits.costUsdPerMonth.soft === null ? "—" : formatUsd(limits.costUsdPerMonth.soft)} · ${limits.costUsdPerMonth.hard === null ? "không trần" : formatUsd(limits.costUsdPerMonth.hard)}`,
      platform: `${formatUsd(usage.PLATFORM.costUsdMonth)} / credit ${formatUsd(limits.platformCreditUsdPerMonth)}`,
      over: limits.costUsdPerMonth.hard !== null && usage.BYOK.costUsdMonth >= limits.costUsdPerMonth.hard,
    },
  ];
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm" data-ai-limits>
        <thead className={thead}>
          <tr>
            <th className={th}>Hạn mức AI</th>
            <th className={th}>{AI_BILLING_SOURCE_LABEL.BYOK}</th>
            <th className={th}>{AI_BILLING_SOURCE_LABEL.PLATFORM}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-t border-hairline">
              <td className="px-3 py-1.5">{r.label}</td>
              <td className={cn("numeric px-3 py-1.5", r.over && "font-semibold text-destructive")}>{r.byok}</td>
              <td className="numeric px-3 py-1.5">{limits.platformCreditUsdPerMonth > 0 ? r.platform : <span className="text-muted-foreground">Gói không có credit nền tảng</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {undeclared ? <p className="px-3 py-2 text-xs text-muted-foreground">Gói chưa khai hạn mức AI — lượt không giới hạn theo gói (vẫn chịu trần kỹ thuật của AI Builder), không có credit nền tảng.</p> : null}
    </div>
  );
}

export function AiUsageDailyTable({ rows }: { rows: AiUsageDayRow[] }) {
  if (rows.length === 0) return <p className="px-5 py-3 text-xs text-muted-foreground">Chưa có lượt AI nào trong 31 ngày gần nhất.</p>;
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full min-w-[760px] text-sm" data-ai-usage-daily>
        <thead className={thead}>
          <tr>
            <th className={th}>Ngày</th>
            <th className={th}>Tính năng</th>
            <th className={th}>Nguồn</th>
            <th className={th}>Model</th>
            <th className={cn(th, "text-right")}>Lượt (lời gọi)</th>
            <th className={cn(th, "text-right")}>Token vào / ra</th>
            <th className={cn(th, "text-right")}>Tiền ước tính</th>
            <th className={cn(th, "text-right")}>Bị chặn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-hairline">
              <td className="px-3 py-1.5 font-mono text-xs">{r.day}</td>
              <td className="px-3 py-1.5 text-xs">{AI_USAGE_FEATURE_LABEL[r.feature as AiUsageFeature] ?? r.feature}</td>
              <td className="px-3 py-1.5 text-xs">{AI_BILLING_SOURCE_LABEL[r.source]}</td>
              <td className="px-3 py-1.5 font-mono text-xs">{r.model ?? "—"}</td>
              <td className="numeric px-3 py-1.5 text-right">
                {formatNumber(r.turns)} <span className="text-muted-foreground">({formatNumber(r.requests)})</span>
              </td>
              <td className="numeric px-3 py-1.5 text-right">
                {formatNumber(r.inputTokens)} / {formatNumber(r.outputTokens)}
              </td>
              <td className="numeric px-3 py-1.5 text-right">{costCell(r.costUsd, r.unknownCost)}</td>
              <td className={cn("numeric px-3 py-1.5 text-right", r.blocked > 0 && "font-semibold text-destructive")}>{formatNumber(r.blocked)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
