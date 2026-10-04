"use client";

import { useState } from "react";
import { Calculator } from "lucide-react";
import { formatNumber, formatVND } from "@/lib/format";
import { estimateMissedOrders, MISSED_ORDERS_DEFAULTS, MISSED_ORDERS_LIMITS, type MissedOrdersInput } from "@/lib/site/missed-orders";

/**
 * Máy tính «Shop bạn đang để lọt bao nhiêu đơn?» — trang giới thiệu Chốt Đơn Tự Động. Số ra từ số KHÁCH NHẬP (lib/site/
 * missed-orders.ts), không từ dữ liệu khách hàng nào của nền tảng; nhãn "ước tính" luôn hiện cạnh kết quả.
 */
export function MissedOrdersCalculator({ planPriceVnd, signupUrl, signupLabel }: { planPriceVnd: number | null; signupUrl: string; signupLabel: string }) {
  const [input, setInput] = useState<MissedOrdersInput>(MISSED_ORDERS_DEFAULTS);
  const r = estimateMissedOrders(input, planPriceVnd);
  const set = (k: keyof MissedOrdersInput) => (e: React.ChangeEvent<HTMLInputElement>) => setInput((s) => ({ ...s, [k]: Number(e.target.value) }));

  const sliders: { key: keyof MissedOrdersInput; label: string; value: string; hint: string }[] = [
    { key: "chatsPerDay", label: "Khách nhắn tin mỗi ngày", value: formatNumber(input.chatsPerDay), hint: "Số hội thoại mới trên fanpage mỗi ngày" },
    { key: "unattendedPct", label: "Nhắn lúc không ai trả lời kịp", value: `${input.unattendedPct}%`, hint: "Tối, đêm, ngày lễ, giờ cao điểm" },
    { key: "closeRatePct", label: "Tỷ lệ chốt khi được trả lời kịp", value: `${input.closeRatePct}%`, hint: "Trong 100 khách được tư vấn, bao nhiêu người mua" },
    { key: "avgOrderVnd", label: "Giá trị đơn trung bình", value: formatVND(input.avgOrderVnd), hint: "Tiền hàng một đơn" },
  ];

  return (
    <div className="grid overflow-hidden rounded-[2rem] border border-border/70 bg-card shadow-[var(--shadow-raised)] lg:grid-cols-[1.1fr_1fr]">
      <div className="p-6 sm:p-8">
        <p className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Calculator className="size-4 text-brand" aria-hidden /> Nhập số của shop bạn
        </p>
        <div className="mt-6 space-y-6">
          {sliders.map((s) => {
            const lim = MISSED_ORDERS_LIMITS[s.key];
            return (
              <label key={s.key} className="block">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-sm font-semibold">{s.label}</span>
                  <span className="text-base font-extrabold tabular-nums text-brand">{s.value}</span>
                </span>
                <input
                  type="range"
                  min={lim.min}
                  max={lim.max}
                  step={lim.step}
                  value={input[s.key]}
                  onChange={set(s.key)}
                  className="mt-2 w-full accent-[var(--brand)]"
                  aria-label={s.label}
                />
                <span className="text-xs text-muted-foreground">{s.hint}</span>
              </label>
            );
          })}
        </div>
      </div>
      <div className="flex flex-col justify-between gap-6 bg-sidebar p-6 text-sidebar-foreground sm:p-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-bright">Mỗi tháng, shop có thể đang để lọt</p>
          <dl className="mt-6 space-y-5">
            <div>
              <dt className="text-sm text-sidebar-foreground/70">Khách nhắn mà không ai trả lời kịp</dt>
              <dd className="mt-1 text-3xl font-extrabold tabular-nums">{formatNumber(r.unattendedChatsPerMonth)} khách</dd>
            </div>
            <div>
              <dt className="text-sm text-sidebar-foreground/70">Đơn hàng có thể giữ lại</dt>
              <dd className="mt-1 text-3xl font-extrabold tabular-nums">{formatNumber(r.ordersPerMonth)} đơn</dd>
            </div>
            <div>
              <dt className="text-sm text-sidebar-foreground/70">Doanh thu có thể giữ lại</dt>
              <dd className="mt-1 text-4xl font-extrabold tabular-nums text-brand-bright sm:text-5xl">{formatVND(r.revenuePerMonthVnd)}</dd>
            </div>
          </dl>
          {r.timesPlanPrice !== null && planPriceVnd ? (
            <p className="mt-6 rounded-2xl bg-sidebar-accent/70 px-4 py-3 text-sm leading-6">
              Bằng <strong className="text-brand-bright">{formatNumber(r.timesPlanPrice)} lần</strong> phí tháng của gói thấp nhất ({formatVND(planPriceVnd)}).
            </p>
          ) : null}
        </div>
        <div>
          <a href={signupUrl} className="inline-flex w-full items-center justify-center rounded-full bg-brand px-6 py-3 text-base font-semibold text-white hover:brightness-110">
            {signupLabel}
          </a>
          <p className="mt-3 text-center text-[11px] leading-5 text-sidebar-foreground/55">
            Ước tính theo số bạn nhập, tính 30 ngày mỗi tháng — không phải cam kết doanh thu. Kết quả thật phụ thuộc sản phẩm, giá và cách shop vận hành.
          </p>
        </div>
      </div>
    </div>
  );
}
