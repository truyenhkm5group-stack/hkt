"use client";

import { Check, Clock, Images, Loader2, Palette, Plus, Search, Sparkles, Wand2, X } from "lucide-react";
import { useMemo, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { UploadPicker, costPerMessage, describeDna, type Upload } from "@/app/(dashboard)/marketing/creatives/manual-gen";
import { startManualDesignRun, startManualGenRun } from "@/lib/actions/creative-manual-gen";
import {
  IMAGE_QUALITIES,
  IMAGE_QUALITY_LABEL,
  IMAGE_SIZES,
  MANUAL_DESIGN,
  MANUAL_GEN,
  MANUAL_GEN_KIND_LABEL,
  MANUAL_GEN_RUN,
  IMAGE_EDIT,
  estimateImageUsd,
  usdToVndRounded,
  type ImageQuality,
  type ImageSize,
  type ManualGenKind,
} from "@/lib/constants/creative-loop";
import { OUTPUT_STYLES, OUTPUT_STYLE_KEYS, STUDIO_COLOR_CHIPS, STUDIO_LIMITS, normalizeColors, studioProblem, studioTotal, type OutputStyle } from "@/lib/constants/creative-studio";
import { formatVND } from "@/lib/format";
import type { DesignInspirationOption, ManualGenRemix, PixelSourceOption } from "@/lib/queries/creative-manual-gen";
import { cn } from "@/lib/utils";
import { IdeaPresets } from "./idea-presets";

/**
 * ═══════════ STUDIO TẠO ẢNH (chủ shop 29/09/2026: "chọn số lượng biến thể màu, chọn kiểu ảnh đầu ra… làm lại UI/UX thông
 * minh hơn, tối ưu hơn") ═══════════
 *
 * Bốn bước trên một màn hình: ① kiểu tạo → ② nguồn (mẫu cảm hứng / ảnh sản phẩm THẬT dạng lưới ảnh) → ③ đầu ra (kiểu ảnh ·
 * biến thể màu · khổ · chất lượng · số mẫu) → ④ ý tưởng (ý tưởng gần đây + gợi ý chọn nhanh). Cột phải luôn nói TRƯỚC khi bấm:
 * "N mẫu × C màu × S kiểu = T ảnh", tiền ước tính theo ĐÚNG khổ + chất lượng đã chọn, thời gian vẽ ước chừng. Mọi luật (trần
 * lưới, câu lệnh, gen) ở `lib/constants/creative-studio.ts` + `lib/creative/manual-gen.ts`; màn hình chỉ gọi lại chúng.
 */

/** Một ảnh vẽ tuần tự mất chừng này (đo 26–28/09: 25–70 giây) — chỉ để người biết nên đợi bao lâu. */
const SECONDS_PER_IMAGE = 45;

const ASPECT: Record<ImageSize, string> = { "1024x1024": "aspect-square", "1024x1536": "aspect-[2/3]", "1088x1360": "aspect-[4/5]" };
const SIZE_SHORT: Record<ImageSize, string> = { "1024x1024": "Vuông 1:1", "1024x1536": "Dọc 2:3", "1088x1360": "Dọc 4:5 (feed)" };

function Step({ n, title, hint, children, right }: { n: number; title: string; hint?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="space-y-2 rounded-lg border bg-card p-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[13px] font-semibold">
          <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">{n}</span>
          {title}
        </h3>
        {right}
      </header>
      {hint ? <p className="text-[11.5px] text-muted-foreground">{hint}</p> : null}
      {children}
    </section>
  );
}

function Chip({ on, onClick, children, title, disabled }: { on: boolean; onClick: () => void; children: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      aria-pressed={on}
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px] transition-colors disabled:opacity-50",
        on ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background text-foreground hover:bg-muted",
      )}
    >
      {on ? <Check className="size-3" /> : null}
      {children}
    </button>
  );
}

function isSize(x: string | null | undefined): x is ImageSize {
  return (IMAGE_SIZES as readonly string[]).includes(x ?? "");
}
function isQuality(x: string | null | undefined): x is ImageQuality {
  return (IMAGE_QUALITIES as readonly string[]).includes(x ?? "");
}
function isStyle(x: string): x is OutputStyle {
  return (OUTPUT_STYLE_KEYS as readonly string[]).includes(x);
}

export function StudioGenForm({
  initialKind,
  inspirations,
  sources,
  pricing,
  recentIdeas,
  remix,
  initialPhotoId,
}: {
  initialKind: ManualGenKind;
  inspirations: DesignInspirationOption[];
  sources: PixelSourceOption[];
  pricing: { model: string; quality: string; size: string; usdToVnd: number };
  recentIdeas: string[];
  /** "Tạo lại tương tự" — thiết lập của một lượt cũ điền sẵn. Chỉ là giá trị khởi đầu, không kích lượt vẽ nào. */
  remix: ManualGenRemix | null;
  /** Ảnh chọn sẵn (`?product=` từ đề xuất đẩy tồn, hoặc ảnh gốc của lượt "Tạo lại tương tự"). Chỉ là giá trị khởi đầu. */
  initialPhotoId?: string;
}) {
  const photos = sources.filter((s) => s.kind === "PRODUCT_PHOTO");
  const [kind, setKind] = useState<ManualGenKind>(remix?.kind ?? initialKind);
  const [picked, setPicked] = useState<string[]>(() =>
    remix?.kind === "DESIGN" && remix.inspirationProductIds.length
      ? remix.inspirationProductIds.filter((id) => inspirations.some((o) => o.productId === id))
      : inspirations
          .filter((o) => o.imageId)
          .slice(0, MANUAL_DESIGN.preselect)
          .map((o) => o.productId),
  );
  const [photoId, setPhotoId] = useState(initialPhotoId && photos.some((s) => s.id === initialPhotoId) ? initialPhotoId : (photos[0]?.id ?? ""));
  const [ownAdId, setOwnAdId] = useState(remix?.ownAdSourceId ?? "");
  const [query, setQuery] = useState("");
  const [idea, setIdea] = useState(remix?.idea ?? "");
  const [units, setUnits] = useState<number>(Math.max(1, Math.min(MANUAL_GEN_RUN.maxImagesPerRun, remix?.units ?? MANUAL_GEN.pickerDefault)));
  const [styles, setStyles] = useState<OutputStyle[]>((remix?.styles ?? []).filter(isStyle));
  const [colors, setColors] = useState<string[]>(normalizeColors(remix?.colors ?? []));
  const [colorDraft, setColorDraft] = useState("");
  const [size, setSize] = useState<ImageSize>(isSize(remix?.size) ? remix.size : isSize(pricing.size) ? pricing.size : IMAGE_SIZES[0]);
  const [quality, setQuality] = useState<ImageQuality>(isQuality(remix?.quality) ? remix.quality : isQuality(pricing.quality) ? pricing.quality : "medium");
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [pending, start] = useTransition();

  const design = kind === "DESIGN";
  const usableStyles = OUTPUT_STYLE_KEYS.filter((k) => k !== "AUTO" && (!design || OUTPUT_STYLES[k].designOk));
  const activeStyles = styles.filter((s) => !design || OUTPUT_STYLES[s].designOk);
  const total = studioTotal(units, { styles: activeStyles, colors });
  const problem = studioProblem(units, { styles: activeStyles, colors });
  const unitUsd = estimateImageUsd(pricing.model, quality, size);
  const unitVnd = usdToVndRounded(unitUsd, pricing.usdToVnd);
  const totalVnd = unitVnd === null ? null : unitVnd * total;
  const minutes = Math.max(1, Math.round((total * SECONDS_PER_IMAGE) / 60));

  const productOf = sources.find((s) => s.id === photoId)?.productId ?? "";
  const ownAds = sources.filter((s) => s.kind === "OWN_AD" && s.productId === productOf);
  const shownPhotos = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? photos.filter((p) => `${p.productLabel} ${p.title}`.toLowerCase().includes(q)) : photos;
  }, [photos, query]);
  const shownInspirations = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? inspirations.filter((o) => o.label.toLowerCase().includes(q)) : inspirations;
  }, [inspirations, query]);

  const toggleStyle = (s: OutputStyle) => setStyles((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : cur.length >= STUDIO_LIMITS.maxStyles ? cur : [...cur, s]));
  const toggleColor = (c: string) => setColors((cur) => (cur.some((x) => x.toLowerCase() === c.toLowerCase()) ? cur.filter((x) => x.toLowerCase() !== c.toLowerCase()) : normalizeColors([...cur, c])));
  const addDraftColor = () => {
    if (!colorDraft.trim()) return;
    setColors((cur) => normalizeColors([...cur, colorDraft]));
    setColorDraft("");
  };
  const togglePick = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MANUAL_DESIGN.maxInspirations ? cur : [...cur, id]));

  const sourceBlock = design
    ? inspirations.length === 0
      ? "Chưa có mẫu nào đủ điều kiện làm cảm hứng — dùng kiểu “Ảnh mới cho mẫu đang có”."
      : picked.length === 0
        ? "Chọn ít nhất một mẫu cảm hứng."
        : !inspirations.some((o) => picked.includes(o.productId) && o.imageId)
          ? "Cần ít nhất một mẫu cảm hứng có ảnh sản phẩm thật."
          : null
    : photos.length === 0
      ? "Chưa có ảnh sản phẩm thật nào — nhập ở tab Nguồn ảnh trước."
      : !photoId
        ? "Chọn một ảnh sản phẩm thật."
        : null;
  const blocker = sourceBlock ?? problem;

  const gen = () =>
    start(async () => {
      const studio = { styles: activeStyles, colors, size, quality };
      const uploadsB64 = uploads.map((u) => u.base64);
      const r = design
        ? await startManualDesignRun({ inspirationProductIds: picked, idea, count: units, uploads: uploadsB64, studio })
        : await startManualGenRun({ productPhotoSourceId: photoId, ownAdSourceId: ownAdId, idea, count: units, uploads: uploadsB64, studio });
      if ("error" in r) return void toast.error(r.error);
      toast.success(`Đang vẽ ${r.allowed} ảnh — ảnh hiện dần ở "Kết quả mới nhất" ngay bên dưới.${r.note ? ` ${r.note}` : ""}`);
      setIdea("");
      setUploads([]);
    });

  return (
    <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-3">
        {remix ? (
          <p className="rounded-md border border-primary/40 bg-primary/5 px-2.5 py-1.5 text-[12px]">
            Đã điền sẵn thiết lập của một lượt cũ (&ldquo;Tạo lại tương tự&rdquo;). Sửa tuỳ ý rồi bấm Gen — chưa có gì được vẽ.
          </p>
        ) : null}

        <Step n={1} title="Kiểu tạo">
          <div className="grid gap-2 sm:grid-cols-2">
            {(["DESIGN", "MOCKUP"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn("rounded-md border p-2.5 text-left transition-colors", kind === k ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
              >
                <p className="flex items-center gap-1.5 text-[13px] font-semibold">
                  {k === "DESIGN" ? <Sparkles className="size-4" /> : <Wand2 className="size-4" />} {MANUAL_GEN_KIND_LABEL[k]}
                </p>
                <p className="mt-0.5 text-[11.5px] text-muted-foreground">
                  {k === "DESIGN" ? "Mẫu MỚI hoàn toàn, lai từ các mẫu đã bán tốt — để tìm mẫu thắng tiếp theo." : "Ảnh quảng cáo mới cho ĐÚNG sản phẩm đang bán (giữ nguyên món hàng) — để đổi gió / xả tồn."}
                </p>
              </button>
            ))}
          </div>
        </Step>

        <Step
          n={2}
          title={design ? "Mẫu cảm hứng" : "Ảnh sản phẩm thật làm gốc"}
          hint={design ? `Máy lai DNA của các mẫu đã chọn (tối đa ${MANUAL_DESIGN.maxInspirations}) + đột biến; thiết kế bắt buộc khác mọi mẫu đang có.` : "Máy luôn giữ đúng món hàng trong ảnh thật — chỉ đổi bối cảnh, người mẫu, cách trình bày (và màu nếu bạn chọn ở bước 3)."}
          right={
            <span className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Tìm mã / tên…" className="h-7 w-44 pl-7 text-[12px]" aria-label="Tìm mẫu" />
            </span>
          }
        >
          {design ? (
            <>
              <p className="numeric text-[11px] text-muted-foreground">
                đã chọn {picked.length}/{MANUAL_DESIGN.maxInspirations}
              </p>
              {inspirations.length === 0 ? (
                <p className="rounded-md border border-dashed px-2.5 py-2 text-[12px] text-muted-foreground">
                  Chưa có mẫu nào đủ điều kiện: cần mã bán tốt trong 90 ngày VÀ đã đọc được DNA thiết kế. Tạm thời dùng kiểu “{MANUAL_GEN_KIND_LABEL.MOCKUP}”.
                </p>
              ) : (
                <div className="grid max-h-[320px] grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2 xl:grid-cols-3">
                  {shownInspirations.map((o) => {
                    const on = picked.includes(o.productId);
                    return (
                      <button
                        key={o.productId}
                        type="button"
                        disabled={pending}
                        onClick={() => togglePick(o.productId)}
                        aria-pressed={on}
                        className={cn("flex items-center gap-2 rounded-md border p-1.5 text-left transition-colors", on ? "border-primary bg-primary/5" : "hover:bg-muted/50")}
                      >
                        <VariantImage imageId={o.imageId} available={o.imageId !== null} alt={o.label} className="size-12 shrink-0 rounded" iconClassName="size-4" />
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="flex items-center gap-1">
                            <span className={cn("flex size-3.5 shrink-0 items-center justify-center rounded-sm border", on && "border-primary bg-primary text-primary-foreground")}>{on ? <Check className="size-3" /> : null}</span>
                            <span className="truncate text-[12px] font-semibold">{o.label}</span>
                          </span>
                          <span className="block truncate text-[11px] text-muted-foreground">
                            <span className="numeric">{o.delivered}</span> giao · <span className="numeric">{o.returned}</span> hoàn · {costPerMessage(o)}
                          </span>
                          <span className="block truncate text-[10.5px] text-muted-foreground" title={describeDna(o.dna)}>
                            {o.imageId ? describeDna(o.dna) : "Chưa có ảnh thật — chỉ góp DNA"}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          ) : photos.length === 0 ? (
            <p className="rounded-md border border-dashed px-2.5 py-2 text-[12px] text-muted-foreground">Chưa có ảnh sản phẩm thật nào — nhập ở tab Nguồn ảnh trước.</p>
          ) : (
            <>
              <div className="grid max-h-[300px] grid-cols-3 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-5 xl:grid-cols-7">
                {shownPhotos.map((s) => {
                  const on = s.id === photoId;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={pending}
                      title={`${s.productLabel}${s.title ? ` — ${s.title}` : ""}`}
                      onClick={() => {
                        setPhotoId(s.id);
                        setOwnAdId("");
                      }}
                      aria-pressed={on}
                      className={cn("overflow-hidden rounded-md border-2 text-left", on ? "border-primary" : "border-transparent hover:border-muted-foreground/40")}
                    >
                      <VariantImage imageId={s.imageId} available={s.imageId !== null} alt={s.productLabel} className="aspect-[4/5] w-full" iconClassName="size-4" />
                      <span className="block truncate px-1 py-0.5 text-[10.5px]">{s.productLabel}</span>
                    </button>
                  );
                })}
              </div>
              {shownPhotos.length === 0 ? <p className="text-[12px] text-muted-foreground">Không có ảnh khớp &ldquo;{query}&rdquo;.</p> : null}
              <div className="grid gap-1 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-2">
                <Label htmlFor="st-own" className="text-[12px]">
                  Quảng cáo cũ cùng mã (tham chiếu bố cục)
                </Label>
                <select id="st-own" className="h-8 rounded-md border border-input bg-background px-2 text-[12.5px] text-foreground" value={ownAdId} disabled={pending || ownAds.length === 0} onChange={(e) => setOwnAdId(e.target.value)}>
                  <option value="">{ownAds.length ? "— không dùng —" : "— mã này chưa có quảng cáo cũ đã nhập —"}</option>
                  {ownAds.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || s.id}
                    </option>
                  ))}
                </select>
              </div>
            </>
          )}
          <div className="border-t pt-2">
            <p className="mb-1 text-[12px] font-medium">Ảnh đầu vào thêm (tuỳ chọn)</p>
            <UploadPicker value={uploads} onChange={setUploads} disabled={pending} />
          </div>
        </Step>

        <Step n={3} title="Đầu ra" hint="Mỗi mẫu được vẽ ở MỌI màu × kiểu đã chọn — các biến thể của cùng một mẫu đứng cạnh nhau để so.">
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                <Images className="size-3.5" /> Kiểu ảnh <span className="font-normal text-muted-foreground">(chọn tối đa {STUDIO_LIMITS.maxStyles}; không chọn = Tự động)</span>
              </p>
              <div className="flex flex-wrap gap-1.5">
                <Chip on={activeStyles.length === 0} onClick={() => setStyles([])} title={OUTPUT_STYLES.AUTO.hint}>
                  {OUTPUT_STYLES.AUTO.label}
                </Chip>
                {usableStyles.map((k) => (
                  <Chip key={k} on={activeStyles.includes(k)} onClick={() => toggleStyle(k)} title={OUTPUT_STYLES[k].hint} disabled={pending}>
                    {OUTPUT_STYLES[k].label}
                  </Chip>
                ))}
              </div>
              {activeStyles.length ? <p className="text-[11px] text-muted-foreground">{activeStyles.map((k) => `${OUTPUT_STYLES[k].label}: ${OUTPUT_STYLES[k].hint}`).join(" · ")}</p> : null}
            </div>

            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-[12px] font-medium">
                <Palette className="size-3.5" /> Biến thể màu <span className="font-normal text-muted-foreground">(tối đa {STUDIO_LIMITS.maxColors}; không chọn = {design ? "màu theo DNA thiết kế" : "giữ màu gốc của sản phẩm"})</span>
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip on={colors.length === 0} onClick={() => setColors([])}>
                  {design ? "Màu theo thiết kế" : "Giữ màu gốc"}
                </Chip>
                {STUDIO_COLOR_CHIPS.map((c) => {
                  const on = colors.some((x) => x.toLowerCase() === c.label.toLowerCase());
                  return (
                    <button
                      key={c.label}
                      type="button"
                      aria-pressed={on}
                      disabled={pending || (!on && colors.length >= STUDIO_LIMITS.maxColors)}
                      onClick={() => toggleColor(c.label)}
                      className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[12px] disabled:opacity-50", on ? "border-primary bg-primary/10 ring-1 ring-primary" : "border-input bg-background hover:bg-muted")}
                    >
                      <span className="size-3.5 rounded-full border border-black/25 dark:border-white/50" style={{ background: c.css }} aria-hidden />
                      {c.label}
                    </button>
                  );
                })}
                <span className="inline-flex items-center gap-1">
                  <Input
                    value={colorDraft}
                    maxLength={IMAGE_EDIT.colorMaxChars}
                    onChange={(e) => setColorDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDraftColor();
                      }
                    }}
                    placeholder="Màu khác, vd: xanh cổ vịt"
                    className="h-7 w-44 text-[12px]"
                    aria-label="Thêm màu khác"
                  />
                  <Button type="button" size="icon" variant="outline" className="size-7" onClick={addDraftColor} disabled={!colorDraft.trim() || colors.length >= STUDIO_LIMITS.maxColors} aria-label="Thêm màu">
                    <Plus className="size-3.5" />
                  </Button>
                </span>
              </div>
              {colors.filter((c) => !STUDIO_COLOR_CHIPS.some((x) => x.label.toLowerCase() === c.toLowerCase())).length ? (
                <div className="flex flex-wrap gap-1">
                  {colors
                    .filter((c) => !STUDIO_COLOR_CHIPS.some((x) => x.label.toLowerCase() === c.toLowerCase()))
                    .map((c) => (
                      <span key={c} className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11.5px]">
                        {c}
                        <button type="button" onClick={() => toggleColor(c)} aria-label={`Bỏ màu ${c}`}>
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                </div>
              ) : null}
              {!design && colors.length ? <p className="text-[11px] text-warning">Ảnh đổi màu là màu shop CÓ THỂ chưa có hàng — kiểm tồn trước khi chạy quảng cáo ảnh ấy.</p> : null}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-1.5">
                <p className="text-[12px] font-medium">Khổ ảnh</p>
                <div className="flex gap-1.5">
                  {IMAGE_SIZES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      aria-pressed={size === s}
                      onClick={() => setSize(s)}
                      className={cn("flex flex-1 flex-col items-center gap-1 rounded-md border p-1.5 text-[11px]", size === s ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
                    >
                      <span className={cn("w-6 rounded-sm border-2 border-current opacity-70", ASPECT[s])} aria-hidden />
                      {SIZE_SHORT[s]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-[12px] font-medium">Chất lượng</p>
                <div className="flex gap-1.5">
                  {IMAGE_QUALITIES.map((q) => {
                    const v = usdToVndRounded(estimateImageUsd(pricing.model, q, size), pricing.usdToVnd);
                    return (
                      <button
                        key={q}
                        type="button"
                        aria-pressed={quality === q}
                        onClick={() => setQuality(q)}
                        className={cn("flex flex-1 flex-col items-center rounded-md border p-1.5 text-[11px]", quality === q ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
                      >
                        <b className="text-[12px]">{IMAGE_QUALITY_LABEL[q]}</b>
                        <span className="numeric text-muted-foreground">~{formatVND(v)}/ảnh</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="st-units" className="text-[12px] font-medium">
                {design ? "Số thiết kế" : "Số bố cục"}
              </Label>
              <Button type="button" size="icon" variant="outline" className="size-7" disabled={pending || units <= 1} onClick={() => setUnits((n) => Math.max(1, n - 1))} aria-label="Bớt">
                −
              </Button>
              <Input id="st-units" type="number" min={1} max={MANUAL_GEN_RUN.maxImagesPerRun} value={units} onChange={(e) => setUnits(Math.max(1, Math.min(MANUAL_GEN_RUN.maxImagesPerRun, Math.round(Number(e.target.value) || 1))))} className="h-7 w-14 text-center text-[12.5px]" />
              <Button type="button" size="icon" variant="outline" className="size-7" disabled={pending || units >= MANUAL_GEN_RUN.maxImagesPerRun} onClick={() => setUnits((n) => n + 1)} aria-label="Thêm">
                +
              </Button>
              <span className="text-[11px] text-muted-foreground">{design ? "mỗi thiết kế là một chiếc áo / váy mới khác nhau" : "mỗi bố cục là một cách chụp khác (bối cảnh, dáng, góc máy)"}</span>
            </div>
          </div>
        </Step>

        <Step
          n={4}
          title="Ý tưởng / câu lệnh (tuỳ chọn)"
          hint="Ý tưởng là chỉ thị ƯU TIÊN CAO NHẤT (bối cảnh, người mẫu, ánh sáng, cách phối…). Bấm gợi ý để ghép nhanh."
          right={
            <span className="numeric text-[11px] text-muted-foreground">
              {idea.trim().length}/{MANUAL_GEN.ideaMaxChars}
            </span>
          }
        >
          {recentIdeas.length ? (
            <div className="flex flex-wrap items-center gap-1">
              <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="size-3" /> Dùng lại:
              </span>
              {recentIdeas.map((x) => (
                <button key={x} type="button" title={x} onClick={() => setIdea(x.slice(0, MANUAL_GEN.ideaMaxChars))} className="max-w-[220px] truncate rounded-full border border-dashed px-2 py-0.5 text-[11.5px] hover:bg-muted">
                  {x}
                </button>
              ))}
            </div>
          ) : null}
          <IdeaPresets idea={idea} onChange={setIdea} maxChars={MANUAL_GEN.ideaMaxChars} design={design} disabled={pending} />
          <Textarea rows={3} value={idea} maxLength={MANUAL_GEN.ideaMaxChars} disabled={pending} onChange={(e) => setIdea(e.target.value)} placeholder={design ? "Ví dụ: chất thun rayon, đi biển mùa thu, nắng chiều, dáng đi tự nhiên…" : "Ví dụ: mặc đi biển Đà Nẵng buổi chiều, ánh nắng vàng, dáng đi tự nhiên…"} />
        </Step>
      </div>

      <aside className="lg:sticky lg:top-3 lg:self-start">
        <div className="space-y-2.5 rounded-lg border bg-card p-3 text-[12.5px] shadow-sm">
          <p className="text-[13px] font-semibold">Sẽ tạo</p>
          <p className="numeric text-[12px] text-muted-foreground">
            {units} {design ? "thiết kế" : "bố cục"} × {Math.max(1, colors.length)} màu × {Math.max(1, activeStyles.length)} kiểu
          </p>
          <p className="numeric text-2xl font-bold">
            {total} <span className="text-[13px] font-medium text-muted-foreground">ảnh</span>
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11.5px]">
            <dt className="text-muted-foreground">Kiểu</dt>
            <dd>{activeStyles.length ? activeStyles.map((k) => OUTPUT_STYLES[k].label).join(", ") : "Tự động"}</dd>
            <dt className="text-muted-foreground">Màu</dt>
            <dd>{colors.length ? colors.join(", ") : design ? "Theo thiết kế" : "Giữ màu gốc"}</dd>
            <dt className="text-muted-foreground">Khổ</dt>
            <dd>{SIZE_SHORT[size]}</dd>
            <dt className="text-muted-foreground">Chất lượng</dt>
            <dd>{IMAGE_QUALITY_LABEL[quality]}</dd>
          </dl>
          <div className="rounded-md bg-muted/60 p-2">
            <p>
              Ước tính ~<b className="numeric">{formatVND(totalVnd)}</b>
            </p>
            <p className="text-[11px] text-muted-foreground">
              {formatVND(unitVnd)}/ảnh · vẽ lần lượt, khoảng {minutes} phút. Tiền thật hiện trên từng ảnh sau khi vẽ.
            </p>
          </div>
          {blocker ? <p className="text-[12px] text-destructive">{blocker}</p> : null}
          {!blocker && total >= 8 && quality !== "low" ? <p className="text-[11px] text-muted-foreground">Mẹo: thử ý tưởng ở chất lượng Thấp trước, rồi &ldquo;Tạo lại tương tự&rdquo; ở chất lượng cao cho hướng ưng ý.</p> : null}
          <Button className="w-full" onClick={gen} disabled={pending || !!blocker}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Gen {total} ảnh
          </Button>
        </div>
      </aside>
    </div>
  );
}
