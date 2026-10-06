"use client";

import { useState } from "react";
import { Bot, Check, MessageCircle, Minus } from "lucide-react";
import { formatVND } from "@/lib/format";
import { FEATURE_KEYS, FEATURE_SPEC, type FeatureKey } from "@/lib/pricing/features";
import type { Included } from "@/lib/pricing/versions";
import type { PublicPricingPlan } from "@/lib/queries/public-pricing";

/**
 * BẢNG GIÁ CÔNG KHAI — mobile-first: thẻ xếp dọc trên điện thoại, lưới trên màn rộng; công tắc Tháng / Năm. Mọi số đọc từ
 * BẢNG GIÁ ĐANG NIÊM YẾT (phiên bản giá, 0225) qua `getPublicPricing()` — thành phần này không gõ số nào. Ô chưa khai không in.
 * Đồng hồ thu chính là KHÁCH AI; hội thoại / trả lời AI là fair-use (không tính thêm); đơn không giới hạn, không tính phí.
 */

type Cycle = "MONTH" | "YEAR";

const n = (v: number) => v.toLocaleString("vi-VN");

/** Dòng hạn mức theo thứ tự đọc: khách AI → fanpage → người dùng → fair-use → đơn. Ô chưa khai (`undefined`) không in. */
function includedLines(inc: Included, hasAiSales: boolean): string[] {
  const out: string[] = [];
  if (hasAiSales && inc.aiCustomers !== undefined) out.push(inc.aiCustomers === null ? "Khách AI theo hợp đồng" : `${n(inc.aiCustomers)} khách AI / tháng`);
  if (inc.fanpages !== undefined) out.push(inc.fanpages === null ? "Fanpage tuỳ chỉnh" : `${n(inc.fanpages)} fanpage`);
  if (inc.users !== undefined) out.push(inc.users === null ? "Người dùng tuỳ chỉnh" : `${n(inc.users)} người dùng`);
  if (hasAiSales && inc.aiConversations !== undefined && inc.aiConversations !== null && inc.aiReplies !== undefined && inc.aiReplies !== null)
    out.push(`Fair-use: ${n(inc.aiConversations)} hội thoại AI · ${n(inc.aiReplies)} câu trả lời AI`);
  if (inc.orders === null) out.push("Đơn không giới hạn — không tính phí theo đơn");
  return out;
}

export function PublicPricing({ plans, signupUrl, signupLabel, upgradeUrl, contactHref }: { plans: PublicPricingPlan[]; signupUrl: string; signupLabel: string; upgradeUrl: string; contactHref: string }) {
  const [cycle, setCycle] = useState<Cycle>("MONTH");
  const anyYearly = plans.some((p) => p.yearlyPriceVnd !== null);
  const shownFeatures = FEATURE_KEYS.filter((k) => FEATURE_SPEC[k].publicClaim && plans.some((p) => p.features.includes(k)));
  return (
    <div>
      {anyYearly ? (
        <div className="flex justify-center">
          <div role="radiogroup" aria-label="Chu kỳ thanh toán" className="inline-flex rounded-full border border-border bg-card p-1 text-sm font-semibold">
            {(["MONTH", "YEAR"] as const).map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cycle === c}
                onClick={() => setCycle(c)}
                className={`min-h-10 rounded-full px-5 transition-colors ${cycle === c ? "bg-brand text-white" : "text-muted-foreground hover:text-foreground"}`}
              >
                {c === "MONTH" ? "Theo tháng" : "Theo năm"}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-pricing-cycle={cycle}>
        {plans.map((p) => (
          <PlanCard key={p.key} plan={p} cycle={cycle} signupUrl={signupUrl} signupLabel={signupLabel} upgradeUrl={upgradeUrl} contactHref={contactHref} />
        ))}
      </div>

      {shownFeatures.length > 0 ? (
        <section className="mt-14" aria-labelledby="so-sanh">
          <h2 id="so-sanh" className="text-center text-xl font-bold sm:text-2xl">
            So sánh tính năng
          </h2>
          <div className="mt-6 overflow-x-auto rounded-2xl border border-border bg-card">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="sticky left-0 bg-card px-4 py-3 font-semibold">Tính năng</th>
                  {plans.map((p) => (
                    <th key={p.key} className="px-3 py-3 text-center font-semibold">
                      {p.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownFeatures.map((k) => (
                  <tr key={k} className="border-b border-border/60 last:border-0">
                    <td className="sticky left-0 bg-card px-4 py-2.5">
                      <div className="font-medium">{FEATURE_SPEC[k].label}</div>
                      <div className="text-xs text-muted-foreground">{FEATURE_SPEC[k].value}</div>
                    </td>
                    {plans.map((p) => (
                      <td key={p.key} className="px-3 py-2.5 text-center">
                        {p.features.includes(k) ? <Check className="mx-auto size-4 text-brand" aria-label="Có" /> : <Minus className="mx-auto size-4 text-muted-foreground/60" aria-label="Không" />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function PlanCard({ plan: p, cycle, signupUrl, signupLabel, upgradeUrl, contactHref }: { plan: PublicPricingPlan; cycle: Cycle; signupUrl: string; signupLabel: string; upgradeUrl: string; contactHref: string }) {
  const yearly = cycle === "YEAR" && p.yearlyPriceVnd !== null;
  const featured = p.highlight;
  return (
    <article className={`relative flex flex-col rounded-3xl p-6 ${featured ? "bg-sidebar text-sidebar-foreground ring-2 ring-brand" : "border border-border/70 bg-card"}`} data-plan={p.key}>
      {featured ? <span className="absolute -top-3 left-6 rounded-full bg-brand px-3 py-1 text-[11px] font-bold text-white">Phổ biến nhất</span> : null}
      <h3 className="text-lg font-bold">{p.name}</h3>
      <div className="mt-3 min-h-16">
        {p.contactSales ? (
          <>
            {p.priceFromVnd !== null ? (
              <p className="flex flex-wrap items-baseline gap-x-1.5">
                <span className={`text-sm ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>Từ</span>
                <span className="text-3xl font-extrabold tracking-tight tabular-nums">{formatVND(p.priceFromVnd)}</span>
                <span className={`text-sm ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>/ tháng</span>
              </p>
            ) : null}
            <p className={p.priceFromVnd !== null ? "mt-1 text-sm font-semibold" : "text-3xl font-extrabold tracking-tight"}>Liên hệ · hợp đồng riêng</p>
          </>
        ) : p.priceVnd === null ? (
          <>
            <p className="text-3xl font-extrabold tracking-tight">Miễn phí</p>
            {p.trialDays ? <p className={`mt-1 text-xs ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{p.trialDays} ngày đầu khi tự đăng ký</p> : null}
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-baseline gap-x-1.5">
              <span className="text-3xl font-extrabold tracking-tight tabular-nums">{formatVND(yearly ? p.monthlyOnYearlyVnd : p.priceVnd)}</span>
              <span className={`text-sm ${featured ? "text-sidebar-foreground/60" : "text-muted-foreground"}`}>/ tháng</span>
            </p>
            {yearly ? (
              <p className={`mt-1 text-xs ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>
                Trả {formatVND(p.yearlyPriceVnd)} một lần cho 12 tháng{p.yearlyFreeMonths > 0 ? ` — tặng ${p.yearlyFreeMonths} tháng` : ""}
              </p>
            ) : p.yearlyFreeMonths > 0 ? (
              <p className={`mt-2 inline-flex w-fit rounded-full px-2.5 py-0.5 text-xs font-semibold ${featured ? "bg-brand/25 text-brand-bright" : "bg-success/12 text-success"}`}>Trả năm tặng {p.yearlyFreeMonths} tháng</p>
            ) : null}
          </>
        )}
      </div>
      {p.description ? <p className={`mt-3 text-sm leading-6 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>{p.description}</p> : null}

      <ul className="mt-5 flex-1 space-y-2.5 text-sm">
        {p.hasAiSales && p.aiIncluded ? (
          <li className="flex items-start gap-2 font-semibold">
            <Bot className={`mt-0.5 size-4 shrink-0 ${featured ? "text-brand-bright" : "text-brand"}`} aria-hidden />
            <span>Có sẵn AI chốt đơn — không cần khoá AI riêng</span>
          </li>
        ) : null}
        {!p.hasAiSales ? (
          <li className={`flex items-start gap-2 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>
            <Minus className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>Chưa gồm AI bán hàng — nhân viên trả lời trong hộp thư</span>
          </li>
        ) : null}
        {includedLines(p.included, p.hasAiSales).map((line) => (
          <li key={line} className="flex items-start gap-2">
            <Check className={`mt-0.5 size-4 shrink-0 ${featured ? "text-brand-bright" : "text-brand"}`} aria-hidden />
            <span>{line}</span>
          </li>
        ))}
        {p.features.map((k: FeatureKey) => (
          <li key={k} className="flex items-start gap-2">
            <Check className={`mt-0.5 size-4 shrink-0 ${featured ? "text-brand-bright" : "text-brand"}`} aria-hidden />
            <span>{FEATURE_SPEC[k].label}</span>
          </li>
        ))}
      </ul>
      {p.overage.mode === "BILLED" ? (
        <p className={`mt-4 text-xs leading-5 ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`} data-overage>
          {p.overage.aiCustomerBlockVnd !== null && p.overage.aiCustomerBlockSize !== null ? `Vượt: ${formatVND(p.overage.aiCustomerBlockVnd)} / ${n(p.overage.aiCustomerBlockSize)} khách AI. ` : ""}
          {p.overage.extraFanpageVnd !== null ? `Fanpage thêm ${formatVND(p.overage.extraFanpageVnd)}/tháng. ` : ""}
          {p.overage.extraUserVnd !== null ? `Người dùng thêm ${formatVND(p.overage.extraUserVnd)}/tháng.` : ""}
        </p>
      ) : null}

      {p.contactSales ? (
        <a href={contactHref} target="_blank" rel="noopener noreferrer" className="mt-6 inline-flex min-h-11 items-center justify-center gap-2 rounded-full border border-border bg-card px-4 text-sm font-semibold text-foreground hover:bg-muted">
          <MessageCircle className="size-4" aria-hidden /> Liên hệ tư vấn
        </a>
      ) : (
        <>
          <a href={signupUrl} className={`mt-6 inline-flex min-h-11 items-center justify-center rounded-full px-4 text-sm font-semibold ${featured || p.priceVnd === null ? "bg-brand text-white hover:brightness-110" : "border border-border bg-card text-foreground hover:bg-muted"}`}>
            {signupLabel}
          </a>
          {p.priceVnd !== null ? (
            <a href={upgradeUrl} className={`mt-2 text-center text-xs font-medium underline-offset-2 hover:underline ${featured ? "text-sidebar-foreground/70" : "text-muted-foreground"}`}>
              Đã có tài khoản? Nâng cấp
            </a>
          ) : null}
        </>
      )}
    </article>
  );
}
