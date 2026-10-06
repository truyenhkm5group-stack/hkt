"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmWithReason } from "@/components/platform/pilot-ops";
import { setAiUnitPricesAction, setOrgPriceVersionAction, setOrgPricingAction, setPlanCommercialAction, setPricingGuardAction, setPricingMarginAction } from "@/lib/actions/pricing";
import type { MarginConfig } from "@/lib/pricing/versions";
import { PILOT_REASON_MIN } from "@/lib/constants/pilot";
import { COMMERCIAL_QUOTA_KEYS, LIMIT_MODES, OVERAGE_POLICIES, OVERAGE_POLICY_LABEL, QUOTA_KEYS, QUOTA_SPEC, type LimitMode, type OveragePolicy, type PlanCommercial } from "@/lib/pricing/catalog";
import { FEATURE_KEYS, FEATURE_SPEC, type FeatureKey } from "@/lib/pricing/features";
import { ENFORCEMENT_LABEL, ENFORCEMENTS, type Enforcement, type GuardConfig } from "@/lib/pricing/guard";

/**
 * Nút CẤU HÌNH GIÁ của người vận hành (0222). Mọi nút ghi đi qua hộp xác nhận có lý do — cùng khuôn với thu phí và công tắc
 * khẩn — vì mỗi cái đổi quyền dùng hoặc tiền của khách thật.
 */

const field = "h-9 w-full rounded-md border bg-background px-2 text-sm";
const numStr = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

export function PlanCommercialForm({ plan }: { plan: { key: string; name: string; description: string | null; commercial: PlanCommercial } }) {
  const c = plan.commercial;
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? "");
  const [publicListed, setPublicListed] = useState(c.publicListed);
  const [contactSales, setContactSales] = useState(c.contactSales);
  const [highlight, setHighlight] = useState(c.highlight);
  const [quotas, setQuotas] = useState<Record<string, string>>(Object.fromEntries(COMMERCIAL_QUOTA_KEYS.map((k) => [k, numStr(c.quotas[k])])));
  const [features, setFeatures] = useState<Set<FeatureKey>>(new Set(c.features ?? []));
  const [policy, setPolicy] = useState<OveragePolicy>(c.overage.policy);
  const [unitPrices, setUnitPrices] = useState<Record<string, string>>(Object.fromEntries(COMMERCIAL_QUOTA_KEYS.map((k) => [k, numStr(c.overage.unitPricesVnd[k])])));
  const [grace, setGrace] = useState(String(c.overage.graceAllowancePct));
  const [modes, setModes] = useState<Record<string, LimitMode | "">>(Object.fromEntries(QUOTA_KEYS.map((k) => [k, c.limitModes[k] ?? ""])));
  const toggle = (k: FeatureKey) => setFeatures((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  return (
    <ConfirmWithReason
      id={`commercial-${plan.key}`}
      label="Lưu cấu hình gói…"
      title={`Lưu cấu hình thương mại của gói «${name}»?`}
      consequence="Hạn mức tháng, tính năng và chính sách vượt áp NGAY cho mọi tổ chức đang ở gói này (trừ tổ chức «giữ từ trước» và ô đã ghi đè riêng). Giá tháng / tặng tháng sửa ở ô «Đổi giá…» phía trên."
      minReason={PILOT_REASON_MIN}
      placeholder="Chốt hạn mức quý IV"
      run={(reason) =>
        setPlanCommercialAction({
          planKey: plan.key,
          name,
          description,
          publicListed,
          contactSales,
          highlight,
          quotas,
          features: [...features],
          overagePolicy: policy,
          overageUnitPricesVnd: unitPrices,
          graceAllowancePct: grace,
          limitModes: modes,
          reason,
        })
      }
    >
      <div className="space-y-3 text-xs" data-commercial-form={plan.key}>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`cn-${plan.key}`}>Tên gói</Label>
            <Input id={`cn-${plan.key}`} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`cd-${plan.key}`}>Mô tả ngắn</Label>
            <Input id={`cd-${plan.key}`} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
          </div>
        </div>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={publicListed} onChange={(e) => setPublicListed(e.target.checked)} /> Hiện ở /pricing
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={contactSales} onChange={(e) => setContactSales(e.target.checked)} /> «Liên hệ» (không tự mua)
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={highlight} onChange={(e) => setHighlight(e.target.checked)} /> Nổi bật
          </label>
        </div>
        <div>
          <div className="font-medium">Hạn mức mỗi tháng (để trống = không giới hạn) · người dùng sửa ở hạn mức kỹ thuật của gói</div>
          <div className="mt-1 grid gap-2 sm:grid-cols-4">
            {COMMERCIAL_QUOTA_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`q-${plan.key}-${k}`}>{QUOTA_SPEC[k].label}</Label>
                <Input id={`q-${plan.key}-${k}`} inputMode="numeric" value={quotas[k]} onChange={(e) => setQuotas((s) => ({ ...s, [k]: e.target.value }))} />
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="font-medium">Tính năng</div>
          <div className="mt-1 grid gap-1 sm:grid-cols-3">
            {FEATURE_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={features.has(k)} onChange={() => toggle(k)} /> {FEATURE_SPEC[k].label}
                {FEATURE_SPEC[k].publicClaim ? null : <span className="text-muted-foreground">(chưa in ở /pricing)</span>}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_8rem]">
          <div className="space-y-1">
            <Label htmlFor={`op-${plan.key}`}>Khi vượt hạn mức</Label>
            <select id={`op-${plan.key}`} className={field} value={policy} onChange={(e) => setPolicy(e.target.value as OveragePolicy)}>
              {OVERAGE_POLICIES.map((p) => (
                <option key={p} value={p}>
                  {OVERAGE_POLICY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor={`gr-${plan.key}`}>Cho vượt thêm trước khi chặn (%)</Label>
            <Input id={`gr-${plan.key}`} type="number" min={0} max={50} value={grace} onChange={(e) => setGrace(e.target.value)} />
          </div>
        </div>
        {policy === "BILL_OVERAGE" ? (
          <div className="grid gap-2 sm:grid-cols-4">
            {COMMERCIAL_QUOTA_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`up-${plan.key}-${k}`}>Đơn giá vượt — {QUOTA_SPEC[k].unit} (₫)</Label>
                <Input id={`up-${plan.key}-${k}`} inputMode="numeric" value={unitPrices[k]} onChange={(e) => setUnitPrices((s) => ({ ...s, [k]: e.target.value }))} />
              </div>
            ))}
          </div>
        ) : null}
        <div>
          <div className="font-medium">Mức áp từng ô (Cứng chỉ chặn khi tổ chức ở mức Cứng VÀ công tắc trần cứng của nền tảng bật)</div>
          <div className="mt-1 grid gap-2 sm:grid-cols-5">
            {QUOTA_KEYS.map((k) => (
              <div key={k} className="space-y-1">
                <Label htmlFor={`lm-${plan.key}-${k}`}>{QUOTA_SPEC[k].label}</Label>
                <select id={`lm-${plan.key}-${k}`} className={field} value={modes[k]} onChange={(e) => setModes((s) => ({ ...s, [k]: e.target.value as LimitMode | "" }))}>
                  <option value="">Mềm (mặc định)</option>
                  {LIMIT_MODES.map((m) => (
                    <option key={m} value={m}>
                      {m === "SOFT" ? "Mềm" : "Cứng"}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      </div>
    </ConfirmWithReason>
  );
}

export function OrgPricingForm({ orgCode, orgName, current }: { orgCode: string; orgName: string; current: { grandfathered: boolean; enforcement: Enforcement } }) {
  const [enforcement, setEnforcement] = useState<Enforcement>(current.enforcement);
  const [grandfathered, setGrandfathered] = useState(current.grandfathered);
  return (
    <ConfirmWithReason
      id={`org-pricing-${orgCode}`}
      label="Lưu…"
      title={`Đổi mức áp hạn mức của «${orgName}»?`}
      consequence="«Giữ từ trước» = đủ mọi tính năng bất kể gói. Mức Cứng chỉ chặn khi công tắc trần cứng của nền tảng cũng bật; mức Mềm chỉ nhắc, không bao giờ ngắt AI."
      minReason={PILOT_REASON_MIN}
      placeholder="Khách xin tạm nới hạn mức"
      disabled={enforcement === current.enforcement && grandfathered === current.grandfathered}
      run={(reason) => setOrgPricingAction({ orgCode, enforcement, grandfathered, reason })}
    >
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <select aria-label="Mức áp" className="h-8 rounded-md border bg-background px-2" value={enforcement} onChange={(e) => setEnforcement(e.target.value as Enforcement)}>
          {ENFORCEMENTS.map((x) => (
            <option key={x} value={x}>
              {ENFORCEMENT_LABEL[x]}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={grandfathered} onChange={(e) => setGrandfathered(e.target.checked)} /> Giữ từ trước (đủ tính năng)
        </label>
      </div>
    </ConfirmWithReason>
  );
}

export function GuardConfigForm({ current }: { current: GuardConfig }) {
  const [v, setV] = useState({ ...current });
  const num = (k: keyof GuardConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: Number(e.target.value) }));
  return (
    <ConfirmWithReason
      id="pricing-guard"
      label="Lưu ngưỡng…"
      title="Đổi ngưỡng Margin Guard?"
      consequence="Áp ngay cho mọi tổ chức. Bật trần cứng của nền tảng chỉ có tác dụng ở tổ chức đặt mức Cứng và ô hạn mức khai Cứng — không tổ chức nào bị chặn chỉ vì công tắc này."
      minReason={PILOT_REASON_MIN}
      placeholder="Chốt ngưỡng cảnh báo"
      run={(reason) => setPricingGuardAction({ config: v, reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-4">
        {(
          [
            ["noticePct", "Nhắc (%)"],
            ["warnPct", "Cảnh báo (%)"],
            ["limitPct", "Hết hạn mức (%)"],
            ["spikeMultiplier", "Bất thường: gấp × trung vị"],
            ["spikeMinUsd", "Bất thường: hơn ít nhất (USD)"],
            ["spikeMinDays", "Cần ít nhất (ngày lịch sử)"],
            ["routingMinSavingsPct", "Đề xuất model khi rẻ hơn (%)"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`g-${k}`}>{label}</Label>
            <Input id={`g-${k}`} type="number" step="any" value={String(v[k])} onChange={num(k)} />
          </div>
        ))}
        <label className="flex items-center gap-1.5 self-end pb-2">
          <input type="checkbox" checked={v.hardLimitsEnabled} onChange={(e) => setV((s) => ({ ...s, hardLimitsEnabled: e.target.checked }))} /> Bật trần cứng của nền tảng
        </label>
      </div>
    </ConfirmWithReason>
  );
}

/** Dải biên lãi gộp CHIẾU của nền tảng (0226): đích · cảnh báo · nguy cấp. */
export function MarginConfigForm({ current }: { current: MarginConfig }) {
  const [v, setV] = useState({ ...current });
  const num = (k: keyof MarginConfig) => (e: React.ChangeEvent<HTMLInputElement>) => setV((s) => ({ ...s, [k]: Number(e.target.value) }));
  return (
    <ConfirmWithReason
      id="pricing-margin"
      label="Lưu dải biên…"
      title="Đổi dải biên lãi gộp?"
      consequence="Chỉ đổi cách tô màu / cảnh báo biên ở khung người vận hành — không đổi giá, không đổi hoá đơn của ai."
      minReason={PILOT_REASON_MIN}
      placeholder="Chốt dải biên"
      run={(reason) => setPricingMarginAction({ config: v, reason })}
    >
      <div className="grid gap-2 text-xs sm:grid-cols-4">
        {(
          [
            ["targetLowPct", "Đích từ (%)"],
            ["targetHighPct", "Đích tới (%)"],
            ["warnBelowPct", "Cảnh báo dưới (%)"],
            ["criticalBelowPct", "Nguy cấp dưới (%)"],
          ] as const
        ).map(([k, label]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={`m-${k}`}>{label}</Label>
            <Input id={`m-${k}`} type="number" step="any" value={String(v[k])} onChange={num(k)} />
          </div>
        ))}
      </div>
    </ConfirmWithReason>
  );
}

/** Chuyển MỘT tổ chức sang một phiên bản giá (0226) — giá cũ giữ cho tới khi người vận hành chuyển. */
export function PriceVersionPinForm({ orgCode, orgName, current }: { orgCode: string; orgName: string; current: string | null }) {
  const [key, setKey] = useState(current ?? "");
  return (
    <ConfirmWithReason
      id={`price-pin-${orgCode}`}
      label="Đổi phiên bản giá…"
      title={`Chuyển «${orgName}» sang phiên bản giá khác?`}
      consequence="Hoá đơn gia hạn kế tiếp và phần vượt tính theo phiên bản mới. Hoá đơn đã trả và kỳ đã chốt không đổi."
      minReason={PILOT_REASON_MIN}
      placeholder="Khách đồng ý chuyển sang bảng giá mới"
      run={(reason) => setOrgPriceVersionAction({ orgCode, versionKey: key.trim(), reason })}
    >
      <div className="space-y-1 text-xs">
        <Label htmlFor={`pin-${orgCode}`}>Khoá phiên bản (vd legacy · v1-2026-10)</Label>
        <Input id={`pin-${orgCode}`} value={key} onChange={(e) => setKey(e.target.value)} />
      </div>
    </ConfirmWithReason>
  );
}

/** Ghi đè giá đơn vị AI — mỗi dòng `model vào ra` (USD / 1M token). Dòng trống bị bỏ. */
export function AiUnitPricesForm({ current }: { current: { model: string; input: number; output: number }[] }) {
  const [text, setText] = useState(current.map((r) => `${r.model} ${r.input} ${r.output}`).join("\n"));
  const parsed: Record<string, { input: number; output: number }> = {};
  let bad = false;
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const [model, i, o] = line.split(/\s+/);
    const input = Number(i);
    const output = Number(o);
    if (!model || !Number.isFinite(input) || !Number.isFinite(output)) bad = true;
    else parsed[model.toLowerCase()] = { input, output };
  }
  return (
    <ConfirmWithReason
      id="ai-unit-prices"
      label="Lưu giá ghi đè…"
      title="Lưu bảng giá đơn vị AI ghi đè (ƯỚC TÍNH)?"
      consequence="Chỉ dùng để ước tính lại lượt chưa định giá và đề xuất model. Chi phí đã ghi của các lượt cũ KHÔNG đổi."
      minReason={PILOT_REASON_MIN}
      placeholder="Cập nhật theo trang giá nhà cung cấp ngày …"
      disabled={bad}
      run={(reason) => setAiUnitPricesAction({ prices: parsed, reason })}
    >
      <div className="space-y-1 text-xs">
        <Label htmlFor="ai-unit-prices-text">Mỗi dòng: model · giá vào · giá ra (USD / 1 triệu token){bad ? " — có dòng sai hình" : ""}</Label>
        <textarea id="ai-unit-prices-text" className="min-h-20 w-full rounded-md border bg-background p-2 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder="gemini-3.1-flash-lite 0.25 1.5" />
      </div>
    </ConfirmWithReason>
  );
}
