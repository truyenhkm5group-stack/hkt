import Link from "next/link";
import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { PlatformCostForm } from "@/components/platform/saas-cost-form";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatNumber, formatPercent, formatVND } from "@/lib/format";
import { loadOwnerCockpit, type TenantRow } from "@/lib/platform/saas-cockpit";
import { MRR_MOVEMENT_LABEL, TENANT_LIFECYCLE_LABEL, TENANT_LIFECYCLES, TREND_LABEL, type PeriodMovement } from "@/lib/platform/saas-metrics";
import { platformOperatorDenial } from "@/lib/platform-ui/module-toggle";
import { PricingEconomicsSection } from "@/components/pricing/economics-section";
import { PlatformAiModelControlSection } from "@/components/platform/ai-model-control";
import { loadPlatformAiControl } from "@/lib/ai-usage/platform-ai-admin";
import { loadPlatformModelAb } from "@/lib/ai-usage/platform-ai-ab";
import { loadPricingAdmin, loadPricingEconomics } from "@/lib/pricing/admin";
import { cn } from "@/lib/utils";

export const metadata = { title: "Kinh tế nền tảng" };

const pct = (ratio: number | null | undefined, digits = 1) => formatPercent(ratio === null || ratio === undefined ? null : ratio * 100, digits);
const days = (d: number | null) => (d === null ? "—" : d < 1 ? "< 1 ngày" : `${Math.round(d)} ngày`);

function Tile({ label, value, sub, hint }: { label: string; value: string; sub?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-hairline bg-card px-3 py-2.5" title={hint}>
      <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="numeric mt-0.5 text-xl font-bold">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div> : null}
    </div>
  );
}

function MovementBlock({ label, m }: { label: string; m: PeriodMovement }) {
  const rows: [string, number | null, string][] = [
    ["MRR đầu kỳ", m.startMrrVnd, ""],
    ["+ Mới", m.newMrrVnd, "text-emerald-700 dark:text-emerald-400"],
    ["+ Mở rộng", m.expansionMrrVnd, "text-emerald-700 dark:text-emerald-400"],
    ["+ Quay lại", m.reactivationMrrVnd, "text-emerald-700 dark:text-emerald-400"],
    ["− Thu hẹp", m.contractionMrrVnd, "text-rose-700 dark:text-rose-400"],
    ["− Rời bỏ", m.churnedMrrVnd, "text-rose-700 dark:text-rose-400"],
    ["= Net New MRR", m.netNewMrrVnd, "font-semibold"],
    ["MRR cuối kỳ", m.endMrrVnd, "font-semibold"],
  ];
  return (
    <div className="space-y-2 text-sm" data-movement={label}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold">{label}</h3>
        <span className="text-xs text-muted-foreground">{m.startDay ? `${formatDate(m.startDay)} → ${formatDate(m.endDay)}` : "chưa có ảnh chụp"}</span>
      </div>
      <table className="w-full">
        <tbody>
          {rows.map(([k, v, tone]) => (
            <tr key={k} className="border-t border-hairline">
              <td className="py-1">{k}</td>
              <td className={cn("numeric py-1 text-right", tone)}>{formatVND(v)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div title="Gross revenue retention: (MRR đầu kỳ − thu hẹp − rời bỏ) / MRR đầu kỳ, trên nhóm trả tiền đầu kỳ.">
          GRR <b className="numeric">{pct(m.grr)}</b>
        </div>
        <div title="Net revenue retention: (MRR đầu kỳ + mở rộng − thu hẹp − rời bỏ) / MRR đầu kỳ. Khách mới KHÔNG vào.">
          NRR <b className="numeric">{pct(m.nrr)}</b>
        </div>
        <div title="Số khách trả tiền đầu kỳ đã rời / số khách trả tiền đầu kỳ.">
          Logo churn <b className="numeric">{pct(m.logoChurn)}</b>
        </div>
      </div>
      {m.note ? <p className="text-xs text-amber-700 dark:text-amber-400">{m.note}</p> : null}
    </div>
  );
}

function TenantTable({ rows }: { rows: TenantRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1180px] text-sm">
        <thead className="bg-muted/40 text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
          <tr>
            <th className="px-3 py-2">Tổ chức</th>
            <th className="px-3 py-2">Gói · vòng đời</th>
            <th className="px-3 py-2 text-right">MRR</th>
            <th className="px-3 py-2 text-right" title="Chi phí AI do NỀN TẢNG trả trong 30 ngày (BYOK là tiền của khách, không phải giá vốn của nền tảng).">AI nền tảng trả</th>
            <th className="px-3 py-2 text-right" title="MRR + doanh thu Số dư AI 30 ngày (tiền thật đã dùng − khoản đảo) − chi phí AI nền tảng trả 30 ngày. Hạ tầng / hỗ trợ chưa phân bổ về từng tổ chức (chưa có căn cứ).">Đóng góp</th>
            <th className="px-3 py-2 text-right" title="Sổ dùng 30 ngày: hội thoại khách mới · hội thoại bot có trả lời · đơn do AI chốt (kênh thử không tính). «—» = chưa có ngày nào trong sổ.">Hội thoại · bot · đơn AI</th>
            <th className="px-3 py-2 text-right">Lượt AI 30 ngày</th>
            <th className="px-3 py-2" title="7 ngày gần nhất so với 7 ngày trước đó; dưới 10 lượt thì không gọi là xu hướng.">Xu hướng</th>
            <th className="px-3 py-2 text-right">Lỗi AI</th>
            <th className="px-3 py-2" title="Mốc kích hoạt đã tới / số mốc đo được; «đã kích hoạt» = AI đã trả lời một khách thật.">Kích hoạt</th>
            <th className="px-3 py-2">Đăng nhập cuối</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.code} className="border-t border-hairline align-top" data-tenant={t.code}>
              <td className="px-3 py-2">
                <Link href={`/platform/org/${t.code}`} className="font-semibold hover:underline">
                  {t.name}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {t.code}
                  {t.templateKey ? ` · ${t.templateKey}` : ""}
                  {t.status !== "ACTIVE" ? ` · ${t.status}` : ""}
                </div>
              </td>
              <td className="px-3 py-2">
                <div>{t.planName}</div>
                <div className="text-xs text-muted-foreground">
                  {TENANT_LIFECYCLE_LABEL[t.lifecycle]}
                  {t.isHome ? "" : ` · ${t.standingLabel}`}
                </div>
              </td>
              <td className="numeric px-3 py-2 text-right">{t.isHome ? "—" : formatVND(t.economics.mrrVnd)}</td>
              <td className="numeric px-3 py-2 text-right" title={t.economics.aiCostComplete ? undefined : "Có lượt AI chưa định giá — số thật lớn hơn."}>
                {formatVND(t.economics.platformAiCostVnd)}
                {t.economics.aiCostComplete ? "" : "+"}
              </td>
              <td className={cn("numeric px-3 py-2 text-right", (t.economics.contributionVnd ?? 0) < 0 && "font-semibold text-destructive")}>
                {t.isHome ? "—" : formatVND(t.economics.contributionVnd)}
                {t.economics.contributionMargin !== null ? <div className="text-xs text-muted-foreground">{pct(t.economics.contributionMargin, 0)}</div> : null}
              </td>
              <td className="numeric px-3 py-2 text-right" title={t.usage30d ? `${t.usage30d.days} ngày trong sổ · ${formatNumber(t.usage30d.customerMessages)} tin khách · ${formatNumber(t.usage30d.botMessages)} tin bot` : "Chưa có ngày nào trong sổ dùng"}>
                {t.usage30d ? `${formatNumber(t.usage30d.conversationsStarted)} · ${formatNumber(t.usage30d.aiActiveConversations)} · ${formatNumber(t.usage30d.aiOrders)}` : "—"}
                <div className="text-xs text-muted-foreground" title={t.usageWeeks.map((w) => `${w.from} → ${w.to}: ${w.conversations ?? "—"} hội thoại, ${w.aiOrders ?? "—"} đơn AI (${w.days} ngày trong sổ)`).join(" · ")}>
                  4 tuần: {t.usageWeeks.map((w) => (w.conversations === null ? "—" : formatNumber(w.conversations))).join(" → ")} · {TREND_LABEL[t.usageTrend]}
                </div>
              </td>
              <td className="numeric px-3 py-2 text-right">{formatNumber(t.aiRequests30d)}</td>
              <td className="px-3 py-2">{TREND_LABEL[t.aiTrend]}</td>
              <td className={cn("numeric px-3 py-2 text-right", (t.aiErrorRate ?? 0) > 0.1 && "text-destructive")}>{pct(t.aiErrorRate, 0)}</td>
              <td className="px-3 py-2 text-xs">
                {t.isHome ? (
                  <span className="text-muted-foreground">Nội bộ</span>
                ) : (
                  <>
                    <div className={t.activated ? "font-semibold text-emerald-700 dark:text-emerald-400" : undefined}>{t.activated ? `Đã kích hoạt · ${days(t.daysToActivation)}` : `${t.milestonesReached} mốc`}</div>
                    {t.daysToFirstAiOrder !== null ? <div className="text-muted-foreground">Đơn AI đầu: {days(t.daysToFirstAiOrder)}</div> : null}
                  </>
                )}
              </td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{t.lastLoginAt ? formatDateTime(t.lastLoginAt) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * OWNER COCKPIT — kinh tế của CHÍNH nền tảng (không phải của một cửa hàng): MRR, biến động, giữ chân, biên lợi nhuận,
 * chi phí AI, kích hoạt. Chỉ người của tổ chức nhà có `platform:operate`; lõi `loadOwnerCockpit` hỏi lại.
 */
export default async function OwnerCockpitPage() {
  const user = await requirePermission("platform:operate");
  if (platformOperatorDenial(user)) redirect("/?forbidden=1");
  const r = await loadOwnerCockpit(user);
  if (!r.ok) redirect("/?forbidden=1");
  const c = r.value;
  // Kinh tế đơn vị + Margin Guard (0222) — đọc SAU cockpit (cockpit đã chụp ảnh MRR hôm nay). Lỗi ⇒ khung nói lỗi, trang vẫn dựng.
  const now = new Date();
  const [econ, admin, aiModel, aiAb] = await Promise.all([loadPricingEconomics(user), loadPricingAdmin(user), loadPlatformAiControl(user, now), loadPlatformModelAb(user, now).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))]);
  const h = c.headline;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Kinh tế nền tảng"
        description={`${h.tenants} tổ chức khách · sổ MRR từ ${c.ledgerSince ? formatDate(c.ledgerSince) : "—"} · đo lúc ${formatDateTime(c.generatedAt)}`}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>MRR cùng công thức với bảng thu phí ở «Vận hành nền tảng»: giá tháng của gói + phần mua thêm, ở tổ chức đang chạy, đang thu phí, chưa bị khoá. Gói dùng thử không có giá nên không vào MRR.</p>
            <p>Biến động (Mới · Mở rộng · Thu hẹp · Rời bỏ · Quay lại) so ẢNH CHỤP hằng ngày — gói và hạn trả là trạng thái đổi được, nên không suy ngược được tháng trước. Sổ bắt đầu từ ngày deploy; kỳ trước đó in «—».</p>
            <p>Tiền AI quy đổi theo tỷ giá nền tảng {formatNumber(c.usdToVnd)} ₫/USD. Chỉ AI do NỀN TẢNG trả là giá vốn; AI tự mang khoá (BYOK) là tiền của khách.</p>
            <p>Không có điểm «sức khoẻ» tổng: chưa có dữ liệu để kiểm chứng trọng số. Phiên bản công thức {c.version}.</p>
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/platform/ai-balance" className="text-sm font-medium text-primary hover:underline" data-link-ai-balance>
              Số dư AI →
            </Link>
            <Link href="/platform" className="text-sm font-medium text-primary hover:underline">
              ← Vận hành nền tảng
            </Link>
          </div>
        }
      />

      {c.captureErrors.length ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/5 px-4 py-2.5 text-xs">
          {c.captureErrors.map((e) => (
            <p key={e}>{e}</p>
          ))}
        </div>
      ) : null}

      {c.testWorkspaces.codes.length ? (
        <p className="text-xs text-muted-foreground" data-cockpit="test-workspaces">
          Không tính workspace kiểm thử (ops nghiệm thu): {c.testWorkspaces.codes.join(", ")} — không phải khách nên không vào số khách, vòng đời, phễu kích hoạt, MRR hay AI của khách. Chi phí AI nền tảng của lượt nghiệm thu {c.margin.windowDays} ngày: {formatVND(c.testWorkspaces.platformAiCostVnd)} ({formatNumber(c.testWorkspaces.aiRequests)} lượt gọi).
        </p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8" data-cockpit="headline">
        <Tile label="MRR" value={formatVND(h.mrrVnd)} sub={`ARR ${formatVND(h.arrVnd, { compact: true })}`} />
        <Tile label="Khách trả tiền" value={formatNumber(h.payingTenants)} sub={`/ ${h.tenants} tổ chức · ARPA ${formatVND(h.arpaVnd, { compact: true })}`} />
        <Tile label="Net New MRR tháng" value={formatVND(c.thisMonth.movement.netNewMrrVnd, { sign: true })} sub={`Mới ${formatVND(c.thisMonth.movement.newMrrVnd, { compact: true })}`} />
        <Tile label="Rời bỏ tháng" value={formatVND(c.thisMonth.movement.churnedMrrVnd)} sub={`${c.thisMonth.movement.churnedLogos ?? "—"} khách`} />
        <Tile label="NRR tháng" value={pct(c.thisMonth.movement.nrr)} sub={`GRR ${pct(c.thisMonth.movement.grr)}`} />
        <Tile
          label="Biên gộp"
          value={pct(c.margin.grossMargin)}
          sub={c.margin.grossMargin === null ? `Chỉ trừ AI: ${pct(c.margin.aiOnlyMargin)}` : `Đóng góp ${pct(c.margin.contributionMargin)}`}
          hint={c.margin.missing.length ? `Chưa khai: ${c.margin.missing.join(", ")}` : undefined}
        />
        <Tile label={`Chi phí AI ${c.margin.windowDays} ngày`} value={formatVND(c.ai.platformCostVnd)} sub={`nền tảng trả · ${formatNumber(c.ai.requests)} lượt`} />
        <Tile
          label="Hội thoại · đơn AI 30 ngày"
          value={c.ai.conversations === null ? "—" : `${formatNumber(c.ai.conversations)} · ${formatNumber(c.ai.aiOrders)}`}
          sub={c.ai.conversations === null ? "sổ dùng chưa có ngày nào" : `bot trả lời ${formatNumber(c.ai.aiActiveConversations)} hội thoại · ${c.ai.usageDays} ngày trong sổ`}
          hint="Tổ chức khách, kênh thật (không tính khung thử / phát lại / copilot). Đơn AI = đơn gắn với hội thoại bot đã chốt."
        />
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground" data-cockpit="lifecycle">
        {TENANT_LIFECYCLES.filter((k) => c.headline.byLifecycle[k] > 0).map((k) => (
          <span key={k}>
            {TENANT_LIFECYCLE_LABEL[k]} <b className="numeric text-foreground">{c.headline.byLifecycle[k]}</b>
          </span>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SectionCard title="Biến động MRR" hint="Mới = khách chưa từng trả tiền trước đầu kỳ. Quay lại = từng trả, đã ngưng, nay trả lại. Tổ chức có MRR chưa biết ở một đầu kỳ không vào dòng nào và được nói ra bên dưới.">
          <div className="grid gap-6 md:grid-cols-2">
            <MovementBlock label={`Tháng ${c.thisMonth.label} (tới hôm nay)`} m={c.thisMonth.movement} />
            <MovementBlock label={`Tháng ${c.lastMonth.label}`} m={c.lastMonth.movement} />
          </div>
          {c.thisMonth.movement.byOrg.some((o) => o.movement !== "NONE") ? (
            <p className="mt-3 text-xs text-muted-foreground">
              {c.thisMonth.movement.byOrg
                .filter((o) => o.movement !== "NONE")
                .map((o) => `${o.orgCode}: ${MRR_MOVEMENT_LABEL[o.movement]}`)
                .join(" · ")}
            </p>
          ) : null}
        </SectionCard>

        <SectionCard
          title="Biên lợi nhuận nền tảng"
          description={c.margin.missing.length ? `Chưa khai: ${c.margin.missing.join(", ")}` : `Khai bởi ${c.costs.updatedByEmail ?? "—"} · ${c.costs.updatedAt ? formatDateTime(c.costs.updatedAt) : "—"}`}
          hint="Doanh thu = MRR hiện tại + doanh thu Số dư AI 30 ngày (tiền thật khách đã dùng AI − khoản đảo; tiền nạp chưa dùng / tiền tặng không tính). Giá vốn = AI do nền tảng trả (30 ngày) + hạ tầng khai tay. Biên đóng góp trừ thêm chi phí hỗ trợ khách. Khoản chưa khai in «—», không coi là 0 — một biên 100% vì quên khai hạ tầng là sai."
        >
          <table className="w-full text-sm">
            <tbody>
              {(
                [
                  ["Doanh thu (MRR)", c.margin.revenueVnd],
                  [`AI nền tảng trả (${c.margin.windowDays} ngày)${c.margin.aiComplete ? "" : " — có lượt chưa định giá"}`, c.margin.aiCostVnd],
                  ["Hạ tầng / tháng", c.margin.infraVnd],
                  ["Hỗ trợ khách / tháng", c.margin.supportVnd],
                ] as [string, number | null][]
              ).map(([k, v]) => (
                <tr key={k} className="border-t border-hairline">
                  <td className="py-1">{k}</td>
                  <td className="numeric py-1 text-right">{formatVND(v)}</td>
                </tr>
              ))}
              <tr className="border-t border-hairline font-semibold">
                <td className="py-1">Biên gộp · biên đóng góp</td>
                <td className="numeric py-1 text-right">
                  {pct(c.margin.grossMargin)} · {pct(c.margin.contributionMargin)}
                </td>
              </tr>
            </tbody>
          </table>
          <p className="mt-2 text-xs text-muted-foreground">
            AI khách tự trả (BYOK) {c.ai.byokCostUsd.toFixed(2)} USD · AI của tổ chức nhà (nội bộ) {formatVND(c.ai.homeCostVnd)} · lỗi AI {pct(c.ai.errorRate)}
            {c.ai.unpricedRequests ? ` · ${formatNumber(c.ai.unpricedRequests)} lượt chưa định giá` : ""}
          </p>
          <div className="mt-3">
            <PlatformCostForm current={{ infraMonthlyVnd: c.costs.infraMonthlyVnd, supportMonthlyVnd: c.costs.supportMonthlyVnd }} />
          </div>
        </SectionCard>
      </div>

      <SectionCard
        title="Kích hoạt · Time-to-Value"
        description={`${c.activationOrgs} tổ chức khách`}
        hint="Mỗi mốc là thời điểm của chứng từ CÓ THẬT trong CSDL của khách (sản phẩm đầu, hội thoại đầu, đơn AI đầu…), ghi một lần. Trung vị dưới 3 tổ chức in «—». Mốc chưa đo được ghi rõ thiếu gì."
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm" data-cockpit="activation">
            <thead className="text-left text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="py-1.5">Mốc</th>
                <th className="py-1.5 text-right">Đã tới</th>
                <th className="py-1.5 text-right">Trung vị từ lúc tạo</th>
              </tr>
            </thead>
            <tbody>
              {c.activation.map((s) => (
                <tr key={s.milestone} className="border-t border-hairline">
                  <td className="py-1.5">{s.label}</td>
                  <td className="numeric py-1.5 text-right" title={s.missingWhat ?? undefined}>
                    {s.reached === null ? "Chưa đo được" : `${s.reached}/${s.of}`}
                  </td>
                  <td className="numeric py-1.5 text-right" title={s.sample ? `${s.sample} tổ chức` : undefined}>
                    {s.milestone === "SIGNED_UP" ? "" : days(s.medianDaysFromSignup)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard title="Từng tổ chức" description="Bấm tên để mở chẩn đoán, thu phí và sổ AI của tổ chức đó" padded={false}>
        {c.tenants.length === 0 ? <EmptyState title="Chưa có tổ chức nào" className="m-4" /> : <TenantTable rows={c.tenants} />}
      </SectionCard>

      {aiModel.ok ? <PlatformAiModelControlSection data={aiModel.value} usdToVnd={c.usdToVnd} now={now} ab={aiAb.ok ? aiAb.value : null} /> : <EmptyState title="Chưa đọc được Platform AI Model Control" description={aiModel.error} />}

      {econ.ok && admin.ok ? (
        <PricingEconomicsSection data={econ.value} unitPrices={admin.value.unitPrices} />
      ) : (
        <EmptyState title="Chưa đọc được kinh tế đơn vị" description={!econ.ok ? econ.error : !admin.ok ? admin.error : undefined} />
      )}
    </div>
  );
}
