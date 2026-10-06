import { SectionCard } from "@/components/ui-bits";
import { AiUnitPricesForm, GuardConfigForm, OrgPricingForm } from "@/components/pricing/operator-pricing";
import { formatNumber, formatPercent, formatVND } from "@/lib/format";
import { QUOTA_SPEC } from "@/lib/pricing/catalog";
import { ENFORCEMENT_LABEL, QUOTA_LEVEL_LABEL, type QuotaLevel } from "@/lib/pricing/guard";
import { MARGIN_RISK_LABEL, type MarginRisk } from "@/lib/pricing/economics";
import type { PricingEconomics } from "@/lib/pricing/admin";
import type { UnitPriceRow } from "@/lib/pricing/unit-prices";
import { cn } from "@/lib/utils";

/**
 * KINH TẾ ĐƠN VỊ + MARGIN GUARD (0222) — phần bổ sung của `/platform/saas`. MRR / ARR / biến động / vòng đời đã có ở khung
 * phía trên (Owner Cockpit); khung này thêm: chi phí AI nền tảng tháng này + chiếu cuối tháng, lãi gộp sau AI + hạ tầng,
 * ARPU, chi phí AI / tổ chức / đơn / hội thoại, dùng thử → trả tiền, tổ chức nguy cơ âm biên, chi phí tăng bất thường, đề
 * xuất model rẻ hơn. «—» = chưa biết, không phải 0. Mọi tiền AI là ƯỚC TÍNH theo bảng giá model.
 */

const LEVEL_TONE: Record<QuotaLevel, string> = {
  UNDECLARED: "text-muted-foreground",
  UNLIMITED: "text-muted-foreground",
  UNKNOWN: "text-muted-foreground",
  OK: "text-emerald-700 dark:text-emerald-400",
  NOTICE: "text-sky-700 dark:text-sky-400",
  WARN: "text-amber-700 dark:text-amber-400",
  LIMIT: "font-semibold text-rose-700 dark:text-rose-400",
};
const RISK_TONE: Record<MarginRisk, string> = {
  NEGATIVE: "font-semibold text-rose-700 dark:text-rose-400",
  TRIAL_COST: "text-amber-700 dark:text-amber-400",
  UNKNOWN: "text-muted-foreground",
  OK: "text-emerald-700 dark:text-emerald-400",
  NO_COST: "text-muted-foreground",
};

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-hairline p-3">
      <div className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric mt-1 text-lg font-semibold">{value}</div>
      {sub ? <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

export function PricingEconomicsSection({ data, unitPrices }: { data: PricingEconomics; unitPrices: { rows: UnitPriceRow[]; updatedAt: string | null; updatedByEmail: string | null } }) {
  const t = data.totals;
  const est = t.aiCostComplete ? "ước tính" : "ước tính · cận dưới (có lượt chưa định giá)";
  return (
    <SectionCard
      id="unit-economics"
      title="Kinh tế đơn vị & Margin Guard"
      description={`Kỳ ${data.periodLabel} · ngày ${data.elapsedDays}/${data.totalDays} · tỷ giá ${formatNumber(data.usdToVnd)} ₫/USD · ngưỡng ${data.guard.noticePct}% / ${data.guard.warnPct}% / ${data.guard.limitPct}% · trần cứng nền tảng ${data.guard.hardLimitsEnabled ? "BẬT" : "tắt"}`}
      hint="Chi phí AI nền tảng = lượt chạy bằng credit của nền tảng (BYOK là tiền của khách, chỉ in để tham khảo). Chiếu cuối tháng = nhịp hiện tại × số ngày của tháng (cần ≥ 3 ngày). Lãi gộp = MRR − chi phí AI chiếu − hạ tầng đã khai; hỗ trợ khách chưa phân bổ về từng tổ chức. Nguy cơ âm biên = chi phí AI chiếu vượt MRR của chính tổ chức đó. Không có ngưỡng biên nào được bịa."
    >
      <div className="space-y-5 text-sm" data-unit-economics>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile label="Chi phí AI nền tảng — tới nay" value={formatVND(t.platformAiCostVnd)} sub={`${est} · chiếu cuối tháng ${formatVND(t.projectedPlatformAiCostVnd)}`} />
          <Tile label="Lãi gộp (sau AI + hạ tầng)" value={formatVND(t.grossProfitVnd)} sub={t.grossMarginPct === null ? (t.infraVnd === null ? "chưa khai hạ tầng / tháng" : "chưa đủ dữ liệu") : `biên ${formatPercent(t.grossMarginPct)}`} />
          <Tile label="ARPU (tổ chức trả tiền)" value={formatVND(t.arpuVnd)} sub={`${t.payingTenants} trả tiền · ${t.trialTenants} dùng thử`} />
          <Tile label="Dùng thử → trả tiền" value={data.trial.rate === null ? "—" : formatPercent(data.trial.rate * 100)} sub={`${data.trial.converted}/${data.trial.trialOrgs} tổ chức${data.trial.note ? ` · ${data.trial.note}` : ""}`} />
          <Tile label="AI / tổ chức có dùng" value={formatVND(t.aiCostPerTenantVnd)} />
          <Tile label="AI / đơn AI tạo" value={formatVND(t.aiCostPerOrderVnd === null ? null : Math.round(t.aiCostPerOrderVnd))} sub={`${formatNumber(t.aiOrders)} đơn AI tháng này`} />
          <Tile label="AI / hội thoại AI" value={formatVND(t.aiCostPerConversationVnd === null ? null : Math.round(t.aiCostPerConversationVnd))} sub={`${formatNumber(t.aiConversations)} hội thoại AI`} />
          <Tile label="Cần để ý" value={`${t.negativeRisk} âm biên · ${t.spikes} bất thường`} sub="AI / đơn giao thành công: CHƯA ĐO (cần nối ORDER_OUTCOME từng tổ chức)" />
        </div>

        {data.tenants.length === 0 ? (
          <p className="text-xs text-muted-foreground">Chưa có tổ chức khách nào đang chạy.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[60rem] text-xs" data-guard-tenants>
              <thead className="text-left text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3">Tổ chức · gói</th>
                  <th className="py-1.5 pr-3 text-right">MRR · biên</th>
                  <th className="py-1.5 pr-3 text-right">AI nền tảng (tới nay · chiếu)</th>
                  <th className="py-1.5 pr-3">Hạn mức tháng</th>
                  <th className="py-1.5 pr-3">Bất thường · đề xuất model</th>
                  <th className="py-1.5">Mức áp</th>
                </tr>
              </thead>
              <tbody>
                {data.tenants.map((r) => (
                  <tr key={r.code} className="border-t border-hairline align-top" data-tenant={r.code} data-risk={r.risk}>
                    <td className="py-2 pr-3">
                      <div className="font-medium">{r.name}</div>
                      <div className="text-muted-foreground">
                        {r.code} · {r.planName}
                        {r.grandfathered ? " · giữ từ trước" : ""}
                      </div>
                      <div className={cn("mt-0.5", RISK_TONE[r.risk])}>{MARGIN_RISK_LABEL[r.risk]}</div>
                    </td>
                    <td className="numeric py-2 pr-3 text-right">
                      <div>{formatVND(r.mrrVnd)}</div>
                      <div className="text-muted-foreground">{r.economics.grossMarginPct === null ? "—" : formatPercent(r.economics.grossMarginPct)}</div>
                      <div className="text-muted-foreground">AI/đơn {formatVND(r.economics.aiCostPerOrderVnd === null ? null : Math.round(r.economics.aiCostPerOrderVnd))}</div>
                    </td>
                    <td className="numeric py-2 pr-3 text-right">
                      <div>
                        {formatVND(r.platformAiCostVnd)} · {formatVND(r.projectedPlatformAiCostVnd)}
                      </div>
                      <div className={cn(LEVEL_TONE[r.aiCredit.level])}>credit {r.aiCredit.pct === null ? QUOTA_LEVEL_LABEL[r.aiCredit.level].toLowerCase() : formatPercent(r.aiCredit.pct, 0)}</div>
                      <div className="text-muted-foreground">BYOK {r.byokAiCostUsd.toFixed(2)} USD</div>
                      {r.unpricedCalls > 0 ? <div className="text-amber-700 dark:text-amber-400">{formatNumber(r.unpricedCalls)} lời gọi chưa định giá{r.reestimatedUnpricedUsd !== null ? ` ≈ ${r.reestimatedUnpricedUsd.toFixed(2)} USD (ước tính lại)` : ""}</div> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <ul className="space-y-0.5">
                        {r.quotas.map((q) => (
                          <li key={q.key} className={cn(LEVEL_TONE[q.level])}>
                            {QUOTA_SPEC[q.key].label}: {q.used === null ? "—" : formatNumber(q.used)}
                            {q.included === undefined ? " (chưa khai)" : q.included === null ? " (không giới hạn)" : ` / ${formatNumber(q.included)}`}
                            {q.action === "BILL_OVERAGE" && q.overageVnd !== null ? ` · vượt ${formatVND(q.overageVnd)}` : ""}
                          </li>
                        ))}
                      </ul>
                      {r.errors.length ? <div className="mt-0.5 text-rose-700 dark:text-rose-400">{r.errors.join(" · ")}</div> : null}
                    </td>
                    <td className="py-2 pr-3">
                      <div className={cn(r.spike.state === "SPIKE" ? "font-semibold text-rose-700 dark:text-rose-400" : "text-muted-foreground")}>{r.spike.state === "SPIKE" ? r.spike.message : r.spike.state === "UNKNOWN" ? "Chưa đủ lịch sử để so" : "Chi phí hôm nay bình thường"}</div>
                      {r.routing ? (
                        <div className="mt-0.5">
                          {r.routing.from} → {r.routing.to}: rẻ hơn ~{Math.round(r.routing.savingsPct)}%{" "}
                          {r.routing.scope === "PLATFORM" ? (
                            <a href="#platform-ai-model" className="font-medium underline underline-offset-2" data-routing-scope="PLATFORM">
                              → Platform AI Model Control
                            </a>
                          ) : (
                            <span className="text-muted-foreground" data-routing-scope="BYOK">(khoá AI riêng của tổ chức — chủ shop tự đổi ô Model)</span>
                          )}
                        </div>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <div className="mb-1 text-muted-foreground">{ENFORCEMENT_LABEL[r.enforcement].split(" — ")[0]}</div>
                      <OrgPricingForm orgCode={r.code} orgName={r.name} current={{ grandfathered: r.grandfathered, enforcement: r.enforcement }} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <h3 className="font-semibold">Ngưỡng Margin Guard</h3>
            <GuardConfigForm current={data.guard} />
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold">Giá đơn vị AI theo model — ƯỚC TÍNH</h3>
            <table className="w-full text-xs" data-unit-prices>
              <thead className="text-left text-[11px] uppercase text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2">Model</th>
                  <th className="py-1 pr-2 text-right">Vào / 1M</th>
                  <th className="py-1 pr-2 text-right">Ra / 1M</th>
                  <th className="py-1">Nguồn</th>
                </tr>
              </thead>
              <tbody>
                {unitPrices.rows.map((u) => (
                  <tr key={u.model} className="border-t border-hairline">
                    <td className="py-1 pr-2 font-mono">{u.model}</td>
                    <td className="numeric py-1 pr-2 text-right">{u.input} USD</td>
                    <td className="numeric py-1 pr-2 text-right">{u.output} USD</td>
                    <td className="py-1">{u.source === "CODE_TABLE" ? "bảng trong mã" : "người vận hành ghi đè"} · ESTIMATED</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AiUnitPricesForm current={unitPrices.rows.filter((u) => u.source === "OPERATOR_OVERRIDE")} />
          </div>
        </div>
      </div>
    </SectionCard>
  );
}
