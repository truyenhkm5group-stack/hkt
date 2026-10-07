import { Check, Minus } from "lucide-react";
import { InfoHint } from "@/components/info-hint";
import { SectionCard } from "@/components/ui-bits";
import { formatDate, formatDateTime, formatVND } from "@/lib/format";
import { QUOTA_SPEC } from "@/lib/pricing/catalog";
import { FEATURE_SPEC } from "@/lib/pricing/features";
import { QUOTA_LEVEL_LABEL, type QuotaLevel } from "@/lib/pricing/guard";
import type { CustomerBillingMeter, CustomerMeterRow, CustomerPlanView } from "@/lib/pricing/customer";
import { METER_COVERAGE_LABEL, USAGE_ALERT_LABEL, type UsageAlertLevel } from "@/lib/pricing/versions";
import { cn } from "@/lib/utils";

/**
 * Khung «Hạn mức tháng này» của `/settings/plan` — đơn vị dễ hiểu ("3.245 / 5.000 hội thoại AI"), thanh phần trăm, mức. KHÔNG
 * in token, model hay chi phí AI: đó là số của người vận hành. «—» = chưa đo được, không phải 0.
 */

const BAR: Record<QuotaLevel, string> = {
  UNDECLARED: "bg-muted-foreground/30",
  UNLIMITED: "bg-emerald-500/60",
  UNKNOWN: "bg-muted-foreground/30",
  OK: "bg-emerald-500",
  NOTICE: "bg-sky-500",
  WARN: "bg-amber-500",
  LIMIT: "bg-rose-500",
};
const TEXT: Record<QuotaLevel, string> = {
  UNDECLARED: "text-muted-foreground",
  UNLIMITED: "text-muted-foreground",
  UNKNOWN: "text-muted-foreground",
  OK: "text-emerald-700 dark:text-emerald-400",
  NOTICE: "text-sky-700 dark:text-sky-400",
  WARN: "text-amber-700 dark:text-amber-400",
  LIMIT: "text-rose-700 dark:text-rose-400",
};

const ALERT_TEXT: Record<UsageAlertLevel, string> = {
  UNKNOWN: "text-muted-foreground",
  UNDECLARED: "text-muted-foreground",
  UNLIMITED: "text-muted-foreground",
  NOT_INCLUDED: "text-muted-foreground",
  OK: "text-emerald-700 dark:text-emerald-400",
  NOTIFY: "text-amber-700 dark:text-amber-400",
  OVERAGE: "text-rose-700 dark:text-rose-400",
  STRONG: "text-rose-700 dark:text-rose-400",
  REVIEW: "text-rose-700 dark:text-rose-400",
};
const ALERT_BAR: Record<UsageAlertLevel, string> = {
  UNKNOWN: "bg-muted-foreground/30",
  UNDECLARED: "bg-muted-foreground/30",
  UNLIMITED: "bg-emerald-500/60",
  NOT_INCLUDED: "bg-muted-foreground/30",
  OK: "bg-emerald-500",
  NOTIFY: "bg-amber-500",
  OVERAGE: "bg-rose-500",
  STRONG: "bg-rose-500",
  REVIEW: "bg-rose-600",
};

const num = (v: number | null) => (v === null ? "—" : v.toLocaleString("vi-VN"));

function MeterTile({ label, unit, row, extra }: { label: string; unit: string; row: CustomerMeterRow; extra?: string | null }) {
  const pct = row.alert.pct;
  return (
    <li className="rounded-lg border border-hairline p-3" data-meter={label} data-level={row.alert.level}>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <span className={cn("text-xs font-medium", ALERT_TEXT[row.alert.level])}>{USAGE_ALERT_LABEL[row.alert.level]}</span>
      </div>
      <div className="numeric mt-1 text-sm">
        {num(row.used)}
        {row.included === undefined ? <span className="text-muted-foreground"> {unit} (gói chưa khai)</span> : row.included === null ? <span className="text-muted-foreground"> {unit} (không giới hạn)</span> : <span className="text-muted-foreground"> / {row.included.toLocaleString("vi-VN")} {unit}</span>}
        {pct !== null ? <span className="text-muted-foreground"> · {Math.round(pct).toLocaleString("vi-VN")}%</span> : null}
      </div>
      {typeof row.included === "number" && row.included > 0 ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
          <div className={cn("h-full rounded-full", ALERT_BAR[row.alert.level])} style={{ width: `${pct === null ? 0 : Math.min(100, Math.max(2, pct))}%` }} />
        </div>
      ) : null}
      {extra ? <p className="mt-1.5 text-[11px] text-muted-foreground">{extra}</p> : null}
    </li>
  );
}

/** Hàng V1: khách AI · fanpage · người dùng · fair-use + hoá đơn ước tính. Không token, không chi phí nhà cung cấp. */
function BillingMeter({ meter }: { meter: CustomerBillingMeter }) {
  const est = meter.estimate;
  const fair = meter.fairUse;
  const fairLevel = fair.review ? "Cần rà soát" : fair.flagged ? "Vượt mức hợp lý" : "Khoẻ";
  return (
    <div className="space-y-2" data-billing-meter>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {meter.aiSales ? <MeterTile label="Khách AI tháng này" unit="khách AI" row={meter.aiCustomers} extra={meter.aiCustomers.coverage !== "MEASURED" ? (meter.aiCustomers.note ?? METER_COVERAGE_LABEL[meter.aiCustomers.coverage]) : null} /> : null}
        <MeterTile label="Fanpage" unit="fanpage" row={meter.fanpages} />
        <MeterTile label="Người dùng" unit="người dùng" row={meter.users} />
        {meter.aiSales ? (
          <li className="rounded-lg border border-hairline p-3" data-fair-use={fair.review ? "REVIEW" : fair.flagged ? "FLAGGED" : "OK"}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="flex items-center gap-1 font-medium">
                Mức dùng hợp lý
                <InfoHint>Hội thoại AI và số câu trả lời AI chỉ là mức dùng hợp lý (fair-use) — KHÔNG tính thêm tiền. Vượt nhiều thì nền tảng liên hệ đề xuất gói phù hợp.</InfoHint>
              </span>
              <span className={cn("text-xs font-medium", fair.flagged ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400")}>{fairLevel}</span>
            </div>
            <div className="numeric mt-1 text-xs text-muted-foreground">
              Hội thoại {fair.conversations.pct === null ? "—" : `${Math.round(fair.conversations.pct)}%`} · Trả lời {fair.replies.pct === null ? "—" : `${Math.round(fair.replies.pct)}%`}
            </div>
          </li>
        ) : null}
      </ul>
      <p className="text-sm" data-bill-estimate>
        <span className="font-medium">Hoá đơn ước tính kỳ này: </span>
        <span className="numeric">{est?.totalVnd === null || est === null ? "—" : formatVND(est.totalVnd)}</span>
        {est && est.overage.knownVnd > 0 ? <span className="text-muted-foreground"> (gồm phần vượt {formatVND(est.overage.knownVnd)})</span> : null}
        {est?.note ? <span className="text-muted-foreground"> · {est.note}</span> : null}
        {meter.aiBalance ? <span className="text-muted-foreground" data-bill-ai-balance> · khách AI vượt phần gói gồm trừ vào Số dư AI, không cộng vào hoá đơn</span> : null}
        {meter.aiCustomers.alert.suggestUpgrade ? <span className="text-amber-700 dark:text-amber-400"> · Dùng vượt nhiều — nâng gói có thể rẻ hơn trả phần vượt.</span> : null}
      </p>
      <p className="text-[11px] text-muted-foreground">
        {meter.versionLabel ? `Bảng giá: ${meter.versionLabel}${meter.pinned ? " (giữ giá đã chốt)" : ""}. ` : ""}
        {meter.taxNote ?? ""}{" "}
        {meter.aiBalance
          ? "Khách AI vượt phần gói gồm trừ vào Số dư AI; hết số dư thì khách MỚI chuyển nhân viên, khách đã tính trong tháng vẫn được AI trả lời."
          : "Dùng quá hạn mức AI vẫn chạy — không bao giờ tự tắt."}
      </p>
    </div>
  );
}

export function CustomerUsageSection({ view }: { view: CustomerPlanView }) {
  const granted = view.features.filter((f) => f.granted);
  return (
    <SectionCard
      title="Hạn mức tháng này"
      description={`Gói «${view.planName}»${view.priceVnd !== null ? ` · ${formatVND(view.priceVnd)}/tháng` : ""}${view.yearlyPriceVnd !== null ? ` · trả năm ${formatVND(view.yearlyPriceVnd)} (≈ ${formatVND(view.monthlyOnYearlyVnd)}/tháng)` : ""} · kỳ ${view.periodLabel}, đếm lại từ ${formatDate(view.resetsOn)}${view.paidThrough ? ` · gia hạn trước ${formatDate(view.paidThrough)}` : ""}`}
      hint="Số đếm từ dữ liệu thật của cửa hàng: hội thoại có AI trả lời, tin AI đã gửi, đơn AI tạo, fanpage đang nối. Dùng quá hạn mức thì AI KHÔNG bị ngắt — bạn được mời nâng gói (hoặc tính phần vượt nếu gói có khai). «—» = chưa đo được."
    >
      <div className="space-y-4" data-customer-usage>
        {view.meter ? <BillingMeter meter={view.meter} /> : null}
        <ul className="grid gap-3 sm:grid-cols-2">
          {view.quotas.filter((q) => !view.meter || (q.key !== "fanpages" && q.key !== "users")).map((q) => {
            const width = q.pct === null ? (q.level === "LIMIT" ? 100 : 0) : Math.min(100, Math.max(2, q.pct));
            return (
              <li key={q.key} className="rounded-lg border border-hairline p-3" data-quota={q.key} data-level={q.level}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium">{QUOTA_SPEC[q.key].label}</span>
                  <span className={cn("text-xs font-medium", TEXT[q.level])}>{QUOTA_LEVEL_LABEL[q.level]}</span>
                </div>
                <div className="numeric mt-1 text-sm">
                  {q.line}
                  {q.pct !== null ? <span className="text-muted-foreground"> · {Math.round(q.pct).toLocaleString("vi-VN")}%</span> : null}
                </div>
                {q.included !== null && q.included !== undefined ? (
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <div className={cn("h-full rounded-full", BAR[q.level])} style={{ width: `${width}%` }} />
                  </div>
                ) : null}
                {q.message && q.level !== "OK" ? <p className={cn("mt-1.5 text-xs", TEXT[q.level])}>{q.message}</p> : null}
              </li>
            );
          })}
        </ul>
        <div>
          <h3 className="text-sm font-semibold">Tính năng của gói</h3>
          <ul className="mt-2 grid gap-1.5 text-sm sm:grid-cols-2">
            {view.features.map((f) => (
              <li key={f.key} className={cn("flex items-start gap-2", !f.granted && "text-muted-foreground")} data-feature={f.key} data-granted={f.granted}>
                {f.granted ? <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" aria-hidden /> : <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />}
                <span>{FEATURE_SPEC[f.key].label}</span>
              </li>
            ))}
          </ul>
          {granted.length === view.features.length ? null : <p className="mt-2 text-xs text-muted-foreground">Tính năng có dấu «–» thuộc gói cao hơn — chọn gói ở khung Thanh toán.</p>}
        </div>
        <p className="text-[11px] text-muted-foreground">
          Đếm lúc {formatDateTime(view.measuredAt)}.{view.errors.length ? ` Một phần số chưa đọc được (${view.errors.length} nguồn) — hiện «—».` : ""}
        </p>
      </div>
    </SectionCard>
  );
}
