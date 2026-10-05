"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createCampaignAction, previewCampaignAction, startCampaignAction } from "@/lib/actions/wholesale";
import type { CampaignPreview } from "@/lib/wholesale/campaigns";
import { DISCOVERY_TIER_LABEL, DISCOVERY_TIERS, type DiscoveryTier } from "@/lib/wholesale/config";
import { formatNumber } from "@/lib/format";
import { SCAN_TIER_LABEL, type ScanTier } from "@/lib/wholesale/areas";
import { LEAD_SEGMENT_LABEL, LEAD_SEGMENTS, type LeadSegment } from "@/lib/wholesale/segments";

/** `tier`: hạng quét (1 = tỉnh quét trước · 2 = không có biển · 3 = ven biển) — tỉnh lấy hạng nhỏ nhất của khu vực. */
type ProvinceOpt = { key: string; label: string; tier: 1 | 2 | 3; areas: { code: string; name: string; tier: 1 | 2 | 3 }[] };
type GroupOpt = { key: string; label: string; keywords: string[]; enabled: boolean };

const SELECTABLE_SEGMENTS = LEAD_SEGMENTS.filter((s) => s !== "NOT_FIT" && s !== "UNCLASSIFIED" && s !== "OTHER_FOOD");

function money(micros: number, rate: number) {
  return `${(micros / 1e6).toLocaleString("vi-VN", { maximumFractionDigits: 2 })} US$ (≈ ${formatNumber(Math.round((micros / 1e6) * rate))} ₫)`;
}

export function CampaignForm({ provinces, keywordGroups, defaults }: { provinces: ProvinceOpt[]; keywordGroups: GroupOpt[]; defaults: { name: string; productFocus: string; excludeKeywords: string; targetSegments: LeadSegment[]; maxLeads: number; discoveryTier: DiscoveryTier } }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(defaults.name);
  const [productFocus, setProductFocus] = useState(defaults.productFocus);
  // Mặc định chỉ chọn đợt ① — chọn cả 34 tỉnh là hàng nghìn truy vấn; ba nút chọn nhanh ở dưới chọn theo đúng thứ tự quét.
  const [selProv, setSelProv] = useState<string[]>(provinces.filter((p) => p.tier === 1).map((p) => p.key));
  const [areas, setAreas] = useState<Record<string, string[]>>({});
  const [customAreas, setCustomAreas] = useState("");
  const [groups, setGroups] = useState<Record<string, boolean>>(Object.fromEntries(keywordGroups.map((g) => [g.key, g.enabled])));
  const [extraKeywords, setExtraKeywords] = useState("");
  const [excludeKeywords, setExcludeKeywords] = useState(defaults.excludeKeywords);
  const [segments, setSegments] = useState<LeadSegment[]>(defaults.targetSegments);
  const [maxLeads, setMaxLeads] = useState(String(defaults.maxLeads));
  const [minRating, setMinRating] = useState("");
  const [minReviews, setMinReviews] = useState("");
  const [requirePhone, setRequirePhone] = useState(true);
  const [requireWebsite, setRequireWebsite] = useState(false);
  const [mode, setMode] = useState<"TEXT" | "NEARBY">("TEXT");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  const [radius, setRadius] = useState("2000");
  const [tier, setTier] = useState<DiscoveryTier>(defaults.discoveryTier);
  const [preview, setPreview] = useState<CampaignPreview | null>(null);

  const input = () => ({
    name,
    productFocus,
    provinces: selProv,
    areas,
    customAreas,
    keywordGroups: keywordGroups.map((g) => ({ key: g.key, enabled: Boolean(groups[g.key]) })),
    extraKeywords,
    excludeKeywords,
    targetSegments: segments,
    maxLeads: Number(maxLeads) || 500,
    minRating: minRating ? Number(minRating) : null,
    minReviews: minReviews ? Number(minReviews) : null,
    requirePhone,
    requireWebsite,
    searchMode: mode,
    nearbyLat: lat ? Number(lat) : null,
    nearbyLng: lng ? Number(lng) : null,
    radiusM: radius ? Number(radius) : null,
    discoveryTier: tier,
  });

  const doPreview = () =>
    start(async () => {
      const r = await previewCampaignAction(input());
      if ("error" in r) toast.error(r.error);
      else setPreview(r.preview);
    });
  const doCreate = (thenStart: boolean) =>
    start(async () => {
      const r = await createCampaignAction(input());
      if ("error" in r) return void toast.error(r.error);
      if (thenStart) {
        const s = await startCampaignAction(r.id);
        if ("error" in s) toast.error(`Đã lưu nháp nhưng chưa bắt đầu: ${s.error}`);
        else toast.success(`Đã bắt đầu quét: ${formatNumber(s.queued)} truy vấn${s.skippedFresh ? ` (bỏ qua ${formatNumber(s.skippedFresh)} vừa quét)` : ""}`);
      } else toast.success("Đã lưu chiến dịch nháp");
      router.refresh();
    });

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  /** Chọn nhanh đúng một hạng: tỉnh có khu vực thuộc hạng đó, và CHỈ các khu vực ấy (tỉnh cả hạng ⇒ để trống = tất cả). */
  const pickTier = (tier: ScanTier | "ALL" | "NONE") => {
    if (tier === "NONE" || tier === "ALL") {
      setSelProv(tier === "ALL" ? provinces.map((p) => p.key) : []);
      setAreas({});
      return;
    }
    const nextAreas: Record<string, string[]> = {};
    const keys: string[] = [];
    for (const p of provinces) {
      const hit = p.areas.filter((a) => a.tier === tier).map((a) => a.code);
      if (!hit.length) continue;
      keys.push(p.key);
      if (hit.length < p.areas.length) nextAreas[p.key] = hit;
    }
    setSelProv(keys);
    setAreas(nextAreas);
  };
  const tiers: ScanTier[] = [1, 2, 3];
  const lbl = "block text-xs font-medium text-muted-foreground";
  const sel = "h-9 w-full rounded-md border bg-background px-2 text-sm";

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className={lbl}>
          Tên chiến dịch
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className={lbl}>
          Sản phẩm cần bán
          <Input value={productFocus} onChange={(e) => setProductFocus(e.target.value)} />
        </label>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <label className={lbl}>
          Kiểu tìm
          <select className={sel} value={mode} onChange={(e) => setMode(e.target.value as "TEXT" | "NEARBY")}>
            <option value="TEXT">Theo từ khoá × khu vực (Text Search)</option>
            <option value="NEARBY">Quanh một điểm (Nearby Search, theo loại hình)</option>
          </select>
        </label>
        <label className={lbl}>
          Mức dữ liệu ở bước tìm
          <select className={sel} value={tier} onChange={(e) => setTier(e.target.value as DiscoveryTier)}>
            {DISCOVERY_TIERS.map((t) => (
              <option key={t} value={t}>
                {DISCOVERY_TIER_LABEL[t]}
              </option>
            ))}
          </select>
        </label>
        <label className={lbl}>
          Số lead tối đa
          <Input inputMode="numeric" value={maxLeads} onChange={(e) => setMaxLeads(e.target.value.replace(/\D/g, ""))} />
        </label>
      </div>

      {mode === "TEXT" ? (
        <fieldset className="space-y-2">
          <legend className={lbl}>Tỉnh / thành và khu vực (quận / huyện)</legend>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted-foreground">Chọn nhanh:</span>
            {tiers.map((t) => (
              <Button key={t} type="button" size="sm" variant="outline" onClick={() => pickTier(t)}>
                {SCAN_TIER_LABEL[t]}
              </Button>
            ))}
            <Button type="button" size="sm" variant="ghost" onClick={() => pickTier("ALL")}>
              Tất cả
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => pickTier("NONE")}>
              Bỏ chọn
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">Chọn nhiều đợt trong một chiến dịch vẫn quét theo thứ tự ① → ② → ③ (khu vực ven biển xét theo tỉnh cũ trước sáp nhập).</p>
          {tiers.map((t) => {
            const group = provinces.filter((p) => p.tier === t);
            if (!group.length) return null;
            return (
              <div key={t} className="space-y-1">
                <div className="text-xs font-semibold">{SCAN_TIER_LABEL[t]}</div>
                <div className="grid gap-2 md:grid-cols-3">
                  {group.map((p) => {
                    const on = selProv.includes(p.key);
                    const picked = areas[p.key] ?? [];
                    return (
                      <div key={p.key} className="rounded-md border p-2">
                        <label className="flex items-center gap-2 text-sm font-medium">
                          <input type="checkbox" checked={on} onChange={() => setSelProv(toggle(selProv, p.key))} />
                          {p.label} <span className="text-xs font-normal text-muted-foreground">({picked.length ? `${picked.length}/` : ""}{p.areas.length} khu vực)</span>
                        </label>
                        {on ? (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-muted-foreground">Chọn khu vực (để trống = tất cả)</summary>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                              {p.areas.map((a) => (
                                <label key={a.code} className="flex items-center gap-1 text-xs">
                                  <input type="checkbox" checked={picked.includes(a.code)} onChange={() => setAreas({ ...areas, [p.key]: toggle(picked, a.code) })} />
                                  {a.name}
                                  {a.tier === 3 && p.tier !== 3 ? <span className="text-muted-foreground">(biển)</span> : null}
                                </label>
                              ))}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <label className={lbl}>
            Khu vực tự khai — mỗi dòng «Tỉnh: khu vực 1, khu vực 2» (vd «Nghệ An: Vinh, Cửa Lò»)
            <Textarea rows={2} value={customAreas} onChange={(e) => setCustomAreas(e.target.value)} />
          </label>
        </fieldset>
      ) : (
        <div className="grid gap-3 md:grid-cols-3">
          <label className={lbl}>
            Vĩ độ tâm
            <Input value={lat} onChange={(e) => setLat(e.target.value)} placeholder="10.7769" />
          </label>
          <label className={lbl}>
            Kinh độ tâm
            <Input value={lng} onChange={(e) => setLng(e.target.value)} placeholder="106.7009" />
          </label>
          <label className={lbl}>
            Bán kính (m, 100–50.000)
            <Input value={radius} onChange={(e) => setRadius(e.target.value.replace(/\D/g, ""))} />
          </label>
        </div>
      )}

      {mode === "TEXT" ? (
        <fieldset className="space-y-2">
          <legend className={lbl}>Nhóm từ khoá (bật / tắt từng nhóm)</legend>
          <div className="flex flex-wrap gap-2">
            {keywordGroups.map((g) => (
              <label key={g.key} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm" title={g.keywords.join(", ")}>
                <input type="checkbox" checked={Boolean(groups[g.key])} onChange={() => setGroups({ ...groups, [g.key]: !groups[g.key] })} />
                {g.label} <span className="text-[11px] text-muted-foreground">({g.keywords.length})</span>
              </label>
            ))}
          </div>
          <label className={lbl}>
            Từ khoá thêm (phân tách bằng dấu phẩy)
            <Input value={extraKeywords} onChange={(e) => setExtraKeywords(e.target.value)} placeholder="nhà hàng tiệc cưới, ốc" />
          </label>
        </fieldset>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <label className={lbl}>
          Từ khoá loại trừ (tên chứa từ này thì bỏ)
          <Input value={excludeKeywords} onChange={(e) => setExcludeKeywords(e.target.value)} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className={lbl}>
            Sao tối thiểu
            <Input inputMode="decimal" value={minRating} onChange={(e) => setMinRating(e.target.value)} placeholder="vd 3.8" />
          </label>
          <label className={lbl}>
            Số đánh giá tối thiểu
            <Input inputMode="numeric" value={minReviews} onChange={(e) => setMinReviews(e.target.value.replace(/\D/g, ""))} placeholder="vd 30" />
          </label>
        </div>
      </div>

      <fieldset className="space-y-1">
        <legend className={lbl}>Nhóm khách hàng mục tiêu</legend>
        <div className="flex flex-wrap gap-2">
          {SELECTABLE_SEGMENTS.map((s) => (
            <label key={s} className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm">
              <input type="checkbox" checked={segments.includes(s)} onChange={() => setSegments(toggle(segments, s))} />
              {LEAD_SEGMENT_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={requirePhone} onChange={(e) => setRequirePhone(e.target.checked)} /> Chỉ lấy lead có SĐT
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={requireWebsite} onChange={(e) => setRequireWebsite(e.target.checked)} /> Chỉ lấy lead có website
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={pending} onClick={doPreview}>
          Xem trước truy vấn
        </Button>
        <Button variant="secondary" disabled={pending} onClick={() => doCreate(false)}>
          Lưu nháp
        </Button>
        <Button disabled={pending} onClick={() => doCreate(true)}>
          Lưu & bắt đầu quét
        </Button>
      </div>

      {preview ? (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
          <div className="font-medium">
            {formatNumber(preview.cells)} truy vấn{preview.truncated ? " (đã cắt ở trần 20.000)" : ""} · {formatNumber(preview.freshCells)} ô vừa quét sẽ bỏ qua · {formatNumber(preview.estimate.cellsToScan)} ô sẽ quét · {preview.keywords.length} từ khoá
          </div>
          <div>
            Chi phí ước tính ({preview.estimate.searchSku}): ít nhất <b>{money(preview.estimate.minMicros, preview.usdToVnd)}</b> · điển hình <b>{money(preview.estimate.typicalMicros, preview.usdToVnd)}</b> · nhiều nhất <b>{money(preview.estimate.maxMicros, preview.usdToVnd)}</b>
          </div>
          <div className="text-xs text-muted-foreground">{preview.estimate.assumptions} Chưa trừ hạn mức miễn phí hằng tháng của Google. Trần chi tiêu ngày / tháng vẫn chặn bất kể ước tính.</div>
          {preview.freeTier.enabled ? (
            <div className={preview.freeTier.needTypical <= preview.freeTier.left ? "text-xs text-emerald-700 dark:text-emerald-400" : "text-xs text-amber-700 dark:text-amber-400"}>
              Chế độ CHỈ DÙNG MIỄN PHÍ: tháng này còn <b>{formatNumber(preview.freeTier.left)}</b> / {formatNumber(preview.freeTier.monthly)} lượt miễn phí ({preview.freeTier.sku}); chiến dịch cần {formatNumber(preview.freeTier.needMin)}–{formatNumber(preview.freeTier.needTypical)} lượt.{" "}
              {preview.freeTier.needTypical <= preview.freeTier.left ? "Đủ — không phát sinh tiền." : "Không đủ trong tháng này — máy quét tới khi hết lượt miễn phí rồi tự dừng, đầu tháng sau tự chạy tiếp (không phát sinh tiền)."}
            </div>
          ) : null}
          {preview.byProvince.length ? <div className="text-xs">{preview.byProvince.map((p) => `${p.label}: ${p.areas} khu vực · ${formatNumber(p.cells)} truy vấn`).join(" · ")}</div> : null}
          {preview.invalidAreas.length ? <div className="text-xs text-destructive">Dòng khu vực không đọc được: {preview.invalidAreas.join(" · ")}</div> : null}
          <details>
            <summary className="cursor-pointer text-xs text-muted-foreground">Truy vấn mẫu ({preview.sample.length})</summary>
            <ul className="mt-1 columns-1 text-xs md:columns-2">
              {preview.sample.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </details>
        </div>
      ) : null}
    </div>
  );
}
