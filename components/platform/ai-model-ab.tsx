import { AB_DECISION_LABEL, AB_RULES, type AbArm, type AbVerdict, type ModelAbReport, type SyncArm } from "@/lib/ai-usage/platform-ai-ab";
import { formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * BẢNG A/B MODEL (07/10/2026) — cohort canary vs đối chứng của Platform AI Policy. «—» = chưa đủ mẫu / chưa đo, không phải 0.
 * Máy chỉ ĐỀ XUẤT (giữ · lên nấc · hoàn tác); đổi nấc là nút ở khung trên.
 */

const rate = (v: number | null) => formatPercent(v === null ? null : v * 100, 1);
const ms = (v: number | null) => (v === null ? "—" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const DECISION_TONE = { INSUFFICIENT_DATA: "text-muted-foreground", HOLD: "text-amber-700 dark:text-amber-400", PROMOTE: "font-semibold text-emerald-700 dark:text-emerald-400", ROLLBACK: "font-semibold text-rose-700 dark:text-rose-400", DONE: "text-emerald-700 dark:text-emerald-400" } as const;

function Row({ label, a, usdToVnd }: { label: string; a: AbArm; usdToVnd: number }) {
  const vnd = (v: number | null) => (v === null ? "—" : formatVND(Math.round(v * usdToVnd)));
  return (
    <tr className="border-t border-hairline" data-ab-arm={label}>
      <td className="py-1 pr-2">
        <div className="font-mono">{a.model || "—"}</div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </td>
      <td className="numeric py-1 pr-2 text-right">{formatNumber(a.conversations)}</td>
      <td className="numeric py-1 pr-2 text-right">{formatNumber(a.orders)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.closeRate)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.phoneRate)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.addressRate)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.handoffRate)}</td>
      <td className="numeric py-1 pr-2 text-right" title={`${formatNumber(a.requests)} lượt gọi`}>{rate(a.errorRate)}</td>
      <td className="numeric py-1 pr-2 text-right" title={`p50 ${ms(a.p50Ms)}`}>{ms(a.p95Ms)}</td>
      <td className="numeric py-1 pr-2 text-right" title={`vào ${formatNumber(a.inputPerConv === null ? null : Math.round(a.inputPerConv))} · ra ${formatNumber(a.outputPerConv === null ? null : Math.round(a.outputPerConv))}`}>
        {formatNumber(a.tokensPerConv === null ? null : Math.round(a.tokensPerConv))}
      </td>
      <td className="numeric py-1 pr-2 text-right">{vnd(a.costPerConvUsd)}</td>
      <td className="numeric py-1 pr-2 text-right">{vnd(a.costPerOrderUsd)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.toolSuccessRate)}</td>
      <td className="numeric py-1 text-right" title="mời / nhận trên lời mời">
        {rate(a.upsellOfferRate)} · {rate(a.upsellAcceptRate)}
      </td>
    </tr>
  );
}

function SyncRow({ label, a, usdToVnd }: { label: string; a: SyncArm; usdToVnd: number }) {
  const vnd = (v: number | null) => (v === null ? "—" : formatVND(Math.round(v * usdToVnd)));
  return (
    <tr className="border-t border-hairline" data-ab-sync-arm={label}>
      <td className="py-1 pr-2">
        <div className="font-mono">{a.model || "—"}</div>
        <div className="text-[11px] text-muted-foreground">{label}</div>
      </td>
      <td className="numeric py-1 pr-2 text-right">{formatNumber(a.threads)}</td>
      <td className="numeric py-1 pr-2 text-right">{formatNumber(a.orders)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.orderRate)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.leadConversion)}</td>
      <td className="numeric py-1 pr-2 text-right">{rate(a.missedLeadRate)}</td>
      <td className="numeric py-1 pr-2 text-right" title={`${formatNumber(a.requests)} lượt gọi`}>{rate(a.errorRate)}</td>
      <td className="numeric py-1 pr-2 text-right">{formatNumber(a.tokensPerThread === null ? null : Math.round(a.tokensPerThread))}</td>
      <td className="numeric py-1 pr-2 text-right">{vnd(a.costPerThreadUsd)}</td>
      <td className="numeric py-1 text-right">{vnd(a.costPerOrderUsd)}</td>
    </tr>
  );
}

function VerdictLine({ v }: { v: AbVerdict }) {
  return (
    <div className="text-xs">
      <span className={cn(DECISION_TONE[v.decision])}>
        {AB_DECISION_LABEL[v.decision]}
        {v.nextPct ? ` → ${v.nextPct}%` : ""}
      </span>
      {v.reasons.length ? <span className="text-muted-foreground"> · {v.reasons.join(" ")}</span> : null}
    </div>
  );
}

function Checks({ v }: { v: AbVerdict }) {
  return (
    <ul className="grid gap-x-4 text-[11px] sm:grid-cols-2">
      {v.checks.map((c) => (
        <li key={c.key} className={c.ok === false ? "text-rose-700 dark:text-rose-400" : c.ok ? "text-emerald-700 dark:text-emerald-400" : "text-muted-foreground"}>
          {c.ok === null ? "○" : c.ok ? "✓" : "✗"} {c.label}: {c.detail}
        </li>
      ))}
    </ul>
  );
}

export function PlatformModelAbTable({ report, usdToVnd }: { report: ModelAbReport; usdToVnd: number }) {
  const v = report.verdict;
  return (
    <div className="space-y-2" data-platform-ai-ab data-decision={v.decision}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">A/B model · cohort từ {formatDateTime(report.since)} · AI Sales chat với khách</h3>
        <span className="text-xs text-muted-foreground">
          canary {report.policy.enabled ? `${report.policy.canaryPct}%` : "TẮT"} · đủ mẫu khi canary ≥ {AB_RULES.minCanaryConversations} hội thoại hoặc ≥ {AB_RULES.minCanaryOrders} đơn chốt · {report.orgs} tổ chức
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[64rem] text-xs">
          <thead className="text-left text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">Model</th>
              <th className="py-1 pr-2 text-right">Hội thoại</th>
              <th className="py-1 pr-2 text-right">Đơn</th>
              <th className="py-1 pr-2 text-right">Chốt</th>
              <th className="py-1 pr-2 text-right">SĐT</th>
              <th className="py-1 pr-2 text-right">Địa chỉ</th>
              <th className="py-1 pr-2 text-right">Handoff</th>
              <th className="py-1 pr-2 text-right">Lỗi AI</th>
              <th className="py-1 pr-2 text-right">p95 phản hồi</th>
              <th className="py-1 pr-2 text-right">Token / HT</th>
              <th className="py-1 pr-2 text-right">Chi phí / HT</th>
              <th className="py-1 pr-2 text-right">Chi phí / đơn</th>
              <th className="py-1 pr-2 text-right">Công cụ đúng</th>
              <th className="py-1 text-right">Upsell</th>
            </tr>
          </thead>
          <tbody>
            <Row label="canary" a={report.canary} usdToVnd={usdToVnd} />
            <Row label="đối chứng" a={report.control} usdToVnd={usdToVnd} />
          </tbody>
        </table>
      </div>
      <Checks v={report.chatVerdict} />
      <h4 className="pt-1 text-xs font-semibold">Ghi đơn từ hội thoại nhân viên (order-sync)</h4>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-xs" data-platform-ai-ab-sync>
          <thead className="text-left text-[11px] uppercase text-muted-foreground">
            <tr>
              <th className="py-1 pr-2">Model</th>
              <th className="py-1 pr-2 text-right">Hội thoại</th>
              <th className="py-1 pr-2 text-right">Đơn ghi</th>
              <th className="py-1 pr-2 text-right">Ra đơn</th>
              <th className="py-1 pr-2 text-right" title="hội thoại có đơn / hội thoại khách đã để SĐT">Lead → đơn</th>
              <th className="py-1 pr-2 text-right" title="khách để SĐT mà máy không lên đơn (đã báo nhân viên)">Lead bị lỡ</th>
              <th className="py-1 pr-2 text-right">Lỗi AI</th>
              <th className="py-1 pr-2 text-right">Token / HT</th>
              <th className="py-1 pr-2 text-right">Chi phí / HT</th>
              <th className="py-1 text-right">Chi phí / đơn</th>
            </tr>
          </thead>
          <tbody>
            <SyncRow label="canary" a={report.sync.canary} usdToVnd={usdToVnd} />
            <SyncRow label="đối chứng" a={report.sync.control} usdToVnd={usdToVnd} />
          </tbody>
        </table>
      </div>
      <Checks v={report.sync.verdict} />
      <div className="rounded-md border border-hairline p-2">
        <div className="text-[11px] font-semibold uppercase text-muted-foreground">Kết luận chung (chỉ workload có lưu lượng)</div>
        <VerdictLine v={v} />
      </div>
      {report.errors.length ? <p className="text-[11px] text-amber-700 dark:text-amber-400">Không đọc được (nằm ngoài phép so): {report.errors.join(" · ")}</p> : null}
    </div>
  );
}
