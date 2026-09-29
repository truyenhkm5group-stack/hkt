"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Brush, Check, Copy, Download, FileText, ImagePlus, Loader2, Repeat2, Rocket, Save, Send, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdPreview, GeneChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { loadManualGenPromptAction, publishManualGenImageNowAction, republishVariantAction, recaptionManualGenImage, requeueFailedManualGenImageAction, reviewManualGenImageAction, saveManualGenDraftAction, searchGeoAction, startManualEditRun, unqueueManualGenDraftAction } from "@/lib/actions/creative-manual-gen";
import { CAMPAIGN_BIDS, CAMPAIGN_BID_LABEL, bidNeedsAmount, type CampaignBid, CAMPAIGN_GENDERS, CAMPAIGN_GENDER_LABEL, CAMPAIGN_OBJECTIVES, CAMPAIGN_OBJECTIVE_LABEL, CAMPAIGN_SETUP_LIMITS, PERFORMANCE_GOALS, PERFORMANCE_GOAL_LABEL, campaignKindLabel, describeCampaignSetup, pickMarketerOption, rewriteCampaignName, setupBidStrategy, setupOptimizationGoal, type PerformanceGoal, type CampaignNameKnown, type CampaignNameParts, type CampaignSetup, type GeoSearchHit, type ProductWinCode } from "@/lib/constants/campaign-setup";
import {
  CREATIVE_HARD_LIMITS,
  DESIGN_DNA_KEYS,
  IMAGE_EDIT,
  IMAGE_EDIT_COLOR_CHIPS,
  IMAGE_EDIT_LAYOUTS,
  IMAGE_EDIT_LAYOUT_LABEL,
  DESIGN_DNA_VALUE_LABEL,
  MANUAL_GEN_IMAGE_STATUS_LABEL,
  MANUAL_GEN_RUN,
  adNameForMedia,
  adsetNameFor,
  type CreativeMediaKind,
  type ImageEditLayout,
  type ManualGenImageStatus,
} from "@/lib/constants/creative-loop";
import { rankFanpagesForCamp, type CampPageTarget, type FanpageEvidence, type RankedFanpages } from "@/lib/constants/fanpage-rank";
import { formatVND, vnShortStamp } from "@/lib/format";
import { thuNhoAnh, type AnhDaThuNho } from "@/lib/ideas/shrink-image";
import type { CampaignSetupOptions, DesignInspirationOption, FanpageOption, ManualGenImageCard, ManualGenPanel, PublishQueueItem } from "@/lib/queries/creative-manual-gen";
import { cn } from "@/lib/utils";
import { OUTPUT_STYLES, OUTPUT_STYLE_KEYS, studioCellLabel } from "@/lib/constants/creative-studio";
import { CopyAiPanel } from "./copy-ai";
import { VARIANT_COPY_LIMITS, creativeRepublishSchema, manualGenDraftSchema, manualGenInstantSchema } from "@/lib/validation/creative";

/**
 * GEN ẢNH BẰNG TAY (§5i) — phía trình duyệt: form "Gen ảnh" (số ảnh · ảnh tải lên · tiền ước tính), thẻ từng ảnh
 * (Duyệt / Loại · tiền thật), hộp soạn bài dùng cho CẢ "Đưa vào lô" lẫn "Đăng camp" (ngay / hẹn giờ), và bộ tự
 * tải lại khi còn ảnh đang vẽ. Mọi luật ở `lib/creative/manual-gen.ts`; màn hình chỉ nhân giá ước tính máy chủ
 * đưa với số ảnh người chọn để người thấy trước khi bấm — không tự tính tiền thật nào.
 */

type InstantInfo = ManualGenPanel["instant"];
export type Upload = AnhDaThuNho & { ten: string };

/** Tự tải lại mỗi vài giây khi còn ảnh chờ vẽ / đang vẽ — tiến độ hiện ra mà không ai phải bấm F5. */
export function ManualGenAutoRefresh({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 8_000);
    return () => clearInterval(t);
  }, [active, router]);
  return active ? (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" /> đang vẽ — tự cập nhật
    </span>
  ) : null;
}

/** Chi mỗi tin nhắn để HIỂN THỊ — chưa có chi / tin nhắn ⇒ CHƯA BIẾT (`—`), không phải 0 (mục 42). */
export function costPerMessage(o: DesignInspirationOption): string {
  return o.spendVnd !== null && o.messages !== null && o.messages > 0 ? `${formatVND(Math.round(o.spendVnd / o.messages))}/tin` : "chi/tin —";
}

export function describeDna(dna: Record<string, string>): string {
  return DESIGN_DNA_KEYS.filter((k) => dna[k] && !(dna[k] === "NONE" && (k === "neckline" || k === "sleeve")))
    .map((k) => (DESIGN_DNA_VALUE_LABEL[k] as Record<string, string>)[dna[k]] ?? dna[k])
    .join(" · ");
}

/** Tiền ƯỚC TÍNH của lượt = giá ước tính một ảnh × số ảnh. Nhãn "ước tính" luôn đi kèm (mục 8.6). */
function EstimateLine({ count, unitVnd, unitUsd, uploads }: { count: number; unitVnd: number | null; unitUsd: number; uploads: number }) {
  return (
    <p className="text-[11px] text-muted-foreground" title={`${unitUsd} USD / ảnh × ${count} ảnh — tiền thật hiện trên từng ảnh sau khi vẽ`}>
      Ước tính ~<b className="numeric text-foreground">{formatVND(unitVnd === null ? null : unitVnd * count)}</b> cho {count} ảnh ({formatVND(unitVnd)}/ảnh){uploads ? ` · kèm ${uploads} ảnh tải lên` : ""}. Tiền thật hiện trên từng ảnh sau khi vẽ.
    </p>
  );
}

/**
 * Ảnh đầu vào NGƯỜI TẢI LÊN (chủ shop 26/09/2026) — gửi máy vẽ KÈM ảnh sản phẩm thật của mã đã chọn, không thay
 * nó. Thu nhỏ ngay trên máy người dùng (cùng hàm của form ý tưởng) trước khi gửi.
 */
export function UploadPicker({ value, onChange, disabled }: { value: Upload[]; onChange: (v: Upload[]) => void; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const room = MANUAL_GEN_RUN.maxUploads - value.length;
  const pick = async (list: FileList | null) => {
    const files = Array.from(list ?? []).slice(0, Math.max(0, room));
    if (!files.length) return;
    setBusy(true);
    const out: Upload[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) {
        toast.error(`${f.name} không phải ảnh`);
        continue;
      }
      try {
        out.push({ ...(await thuNhoAnh(f)), ten: f.name });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : `Không đọc được ${f.name}`);
      }
    }
    onChange([...value, ...out]);
    setBusy(false);
    if (ref.current) ref.current.value = "";
  };
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {value.map((u, i) => (
          <span key={`${u.ten}-${i}`} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- ảnh xem trước dạng data URL, chưa lên máy chủ */}
            <img src={u.preview} alt={u.ten} className="size-12 rounded border object-cover" />
            <button type="button" disabled={disabled} onClick={() => onChange(value.filter((_, j) => j !== i))} className="absolute -right-1 -top-1 rounded-full bg-background p-0.5 shadow" aria-label={`Bỏ ảnh ${u.ten}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        {room > 0 ? (
          <Button type="button" size="sm" variant="outline" className="h-12 text-[11.5px]" disabled={disabled || busy} onClick={() => ref.current?.click()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Tải ảnh lên
          </Button>
        ) : null}
        <input ref={ref} type="file" accept="image/*" multiple hidden onChange={(e) => void pick(e.target.files)} />
      </div>
      <p className="text-[11px] text-muted-foreground">
        Tối đa {MANUAL_GEN_RUN.maxUploads} ảnh{" "}
        <InfoHint label="Ảnh tải lên">Dáng, bối cảnh, người mẫu, cách phối muốn máy bám theo — ghi trong ô ý tưởng cách dùng. Chỉ tải ảnh của shop / ảnh bạn có quyền dùng; máy vẽ luôn kèm ảnh sản phẩm thật của mã đã chọn.</InfoHint>
      </p>
    </div>
  );
}

const TONE: Partial<Record<ManualGenImageStatus, string>> = {
  APPROVED: "bg-success/15 text-success",
  PROMOTED: "bg-brand/10 text-brand",
  GEN_FAILED: "bg-destructive/10 text-destructive",
  REJECTED: "bg-muted text-muted-foreground",
};

type Defaults = { campaign: string; adset: string; ad: string; problems: string[] };

/** Bộ đồ nghề chung của hộp soạn bài (máy chủ dựng một lần ở `manual-gen-panel.tsx`). */
export type ComposeCtx = {
  canPublish: boolean;
  /** Giá ước tính MỘT ảnh theo cấu hình đang chạy — cho dòng "ước tính" của hộp Sửa ảnh. */
  pricing: { unitVnd: number | null; unitUsd: number };
  instant: InstantInfo;
  pageName: string | null;
  defaults: Defaults;
  campDefaults: Defaults;
  setup: CampaignSetupOptions;
  /** Bằng chứng xếp fanpage theo camp của từng ảnh (đơn của mã · mẫu tương tự đã chạy). */
  fanpageEvidence: FanpageEvidence;
};

/** Camp của một ảnh để xếp fanpage: camp mã win khi đang chọn WIN và ảnh có mã win; còn lại là camp TEST. */
function campTargetOf(img: ManualGenImageCard, kind: CampaignSetup["campaignKind"]): CampPageTarget {
  return { kind: kind === "WIN" && img.winCode ? "WIN" : "TEST", productId: img.productId, dna: img.design?.dna ?? null };
}

export function ManualGenImageTile({ img, canEdit, ctx }: { img: ManualGenImageCard; canEdit: boolean; ctx: ComposeCtx }) {
  const [pending, start] = useTransition();
  const review = (decision: "APPROVE" | "REJECT") =>
    start(async () => {
      const r = await reviewManualGenImageAction({ imageId: img.id, decision, reason: "" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (r.status === "APPROVED") toast.success(r.captionError ? `Đã duyệt — AI chưa viết được câu chữ (${r.captionError}). Gõ tay trong hộp soạn bài.` : "Đã duyệt — AI đã viết câu chữ theo ảnh. Bấm Soạn bài để lưu vào hàng đợi / đăng camp.");
      else toast.success("Đã loại ảnh.");
    });
  const loai = img.status === "REJECTED" || img.status === "GEN_FAILED";
  const daVe = img.imageId !== null;
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border bg-card", loai && "opacity-60")}>
      <div className="relative">
        {img.status === "PLANNED" || img.status === "DRAWING" ? (
          <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-1 bg-muted text-[11px] text-muted-foreground">
            <Loader2 className={cn("size-5", img.status === "DRAWING" && "animate-spin")} />
            {MANUAL_GEN_IMAGE_STATUS_LABEL[img.status]}
          </div>
        ) : (
          <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={`Ảnh gen tay #${img.seq}`} className="aspect-[4/5] w-full" zoomable />
        )}
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-bold">#{img.seq}</span>
        <span className={cn("pointer-events-none absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold", TONE[img.status] ?? "bg-background/90")}>{img.queuedAt ? "Trong hàng đợi" : MANUAL_GEN_IMAGE_STATUS_LABEL[img.status]}</span>
        {daVe && img.costUsd ? (
          <span className="numeric pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-semibold" title={`${Number(img.costUsd).toFixed(4)} USD — tiền thật máy vẽ báo về`}>
            {formatVND(img.costVnd)}
          </span>
        ) : null}
        {/* Câu lệnh · Tải — nút biểu tượng đè góc ảnh (gọn, 29/09/2026). */}
        <span className="absolute bottom-1.5 left-1.5 flex gap-1">
          <PromptButton img={img} canEdit={canEdit} />
          {img.imageAvailable && img.imageId ? (
            <a href={`/api/creative/images/${img.imageId}`} download={`anh-gen-${img.seq}.png`} title="Tải ảnh về máy" aria-label="Tải ảnh về máy" className="flex size-7 items-center justify-center rounded bg-background/90 shadow hover:bg-background">
              <Download className="size-3.5" />
            </a>
          ) : null}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        {img.design ? (
          <div className="space-y-1 rounded-md border border-brand/30 bg-brand/5 p-1.5" title={img.design.why}>
            <p className="flex flex-wrap items-baseline justify-between gap-1 text-[11px]">
              <span className="font-semibold">Thiết kế mới</span>
              <span className="numeric text-muted-foreground">{img.design.priceVnd === null ? "giá: chưa suy được" : `giá đề nghị ${formatVND(img.design.priceVnd)}`}</span>
            </p>
            <p className="line-clamp-3 text-[11px] leading-snug" title={describeDna(img.design.dna)}>
              {describeDna(img.design.dna)}
            </p>
            {img.design.parentLabels.length ? <p className="line-clamp-1 text-[10.5px] text-muted-foreground">Lai từ: {img.design.parentLabels.join(" × ")}</p> : null}
          </div>
        ) : null}
        {studioCellLabel(img.outputStyle, img.color) ? (
          <p className="flex flex-wrap gap-1 text-[10.5px]">
            {(OUTPUT_STYLE_KEYS as readonly string[]).includes(img.outputStyle) && img.outputStyle !== "AUTO" ? <span className="rounded bg-muted px-1.5 py-0.5">{OUTPUT_STYLES[img.outputStyle as keyof typeof OUTPUT_STYLES].label}</span> : null}
            {img.color ? <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">Màu: {img.color}</span> : null}
          </p>
        ) : null}
        <details className="text-[10.5px] text-muted-foreground">
          <summary className="cursor-pointer select-none">Gen máy học</summary>
          <GeneChips genes={img.genes} className="mt-1 gap-0.5" />
        </details>
        {img.error ? (
          <p className="line-clamp-3 text-[11px] text-destructive" title={img.error}>
            {img.error}
          </p>
        ) : null}
        {img.status === "APPROVED" && img.captionError ? (
          <p className="line-clamp-2 text-[11px] text-warning" title={img.captionError}>
            AI chưa viết được câu chữ: {img.captionError}
          </p>
        ) : null}
        {img.queuedAt ? <p className="text-[11px] font-medium text-brand">Trong hàng đợi đăng camp · lưu {vnShortStamp(img.queuedAt)}</p> : null}
        {img.status === "PROMOTED" && !img.publishFailure ? <p className="text-[11px] text-muted-foreground">Đã đăng camp — xem ở tab ④ Đang chạy.</p> : null}
        {img.publishFailure ? (
          <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-1.5 text-[11px]">
            <p className="font-medium text-destructive">Đăng camp KHÔNG thành.</p>
            <a href={`/marketing/creatives?tab=dang&lo=${encodeURIComponent(img.publishFailure.batchId)}#chi-tiet-lo`} className="underline underline-offset-2">
              Xem lý do trong sổ ghi Facebook
            </a>
            {canEdit && img.publishFailure.canRequeue ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-full text-[12px]"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await requeueFailedManualGenImageAction({ imageId: img.id });
                    if ("error" in r) toast.error(r.error);
                    else toast.success("Đã trả ảnh về hàng đợi — sửa xong bấm Đăng camp lại ở ③ Hàng đợi & Đăng.");
                  })
                }
              >
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Rocket className="size-3.5" />} Trả về hàng đợi để đăng lại
              </Button>
            ) : null}
            {canEdit && img.publishFailure.canRequeue && img.publishFailure.emptyCampaignId ? (
              <p className="text-muted-foreground">Chiến dịch rỗng {img.publishFailure.emptyCampaignId} (TẮT, chưa có nhóm) còn trên Facebook — không tiêu tiền, xoá tay nếu muốn.</p>
            ) : null}
            {!img.publishFailure.canRequeue ? (
              <p className="text-muted-foreground">Trên Facebook đã có nhóm / mẩu quảng cáo của bài (đang TẮT) — xoá tay trên Ads Manager.</p>
            ) : null}
          </div>
        ) : null}
        {canEdit ? (
          <div className="mt-auto flex flex-wrap gap-1 border-t pt-1.5">
            {img.status === "GENERATED" || img.status === "REJECTED" ? (
              <Button size="sm" variant="outline" className="h-7 flex-1 text-[12px]" disabled={pending || !img.imageAvailable} onClick={() => review("APPROVE")}>
                {pending ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Duyệt
              </Button>
            ) : null}
            {img.status === "GENERATED" || img.status === "APPROVED" ? (
              <Button size="sm" variant="ghost" className="h-7 flex-1 text-[12px]" disabled={pending} onClick={() => review("REJECT")}>
                <X className="size-3.5" /> Loại
              </Button>
            ) : null}
            {img.status === "APPROVED" ? <ComposeButton img={img} ctx={ctx} /> : null}
            {img.imageAvailable && (img.status === "GENERATED" || img.status === "APPROVED" || img.status === "REJECTED" || img.status === "PROMOTED") ? <EditImageButton img={img} ctx={ctx} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * CÂU LỆNH CỦA ẢNH (chủ shop 29/09/2026: "hiển thị câu lệnh ở kết quả ảnh đầu ra") — đọc khi mở (không chở theo mọi thẻ): ý
 * tưởng người gõ, kiểu + màu, khổ / chất lượng / model, và câu lệnh ĐẦY ĐỦ đã gửi máy vẽ (tiếng Anh) kèm nút chép. "Tạo lại
 * tương tự" mở ① Tạo ảnh với đúng thiết lập của lượt này điền sẵn — không vẽ gì cho tới khi người bấm Gen.
 */
function PromptButton({ img, canEdit }: { img: ManualGenImageCard; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ prompt: string; idea: string; size: string; quality: string; model: string } | null>(null);
  const [pending, start] = useTransition();
  const mo = () => {
    setOpen(true);
    if (data) return;
    start(async () => {
      const r = await loadManualGenPromptAction({ imageId: img.id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setData(r);
    });
  };
  const chep = async () => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.prompt);
      toast.success("Đã chép câu lệnh.");
    } catch {
      toast.error("Trình duyệt không cho chép — bôi đen rồi Ctrl+C.");
    }
  };
  const nhan = studioCellLabel(img.outputStyle, img.color);
  return (
    <>
      <button type="button" onClick={mo} title="Xem câu lệnh đã gửi máy vẽ" aria-label="Xem câu lệnh" className="flex size-7 items-center justify-center rounded bg-background/90 shadow hover:bg-background">
        <FileText className="size-3.5" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Câu lệnh ảnh #{img.seq}</DialogTitle>
            <DialogDescription>Đúng câu lệnh đã gửi máy vẽ (tiếng Anh). Ý tưởng của bạn đứng đầu và được nhắc lại ở cuối.</DialogDescription>
          </DialogHeader>
          {pending || !data ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <div className="space-y-2 text-[12.5px]">
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Ý tưởng</dt>
                <dd>{data.idea || "— (không gõ, máy tự chọn)"}</dd>
                {nhan ? (
                  <>
                    <dt className="text-muted-foreground">Kiểu · màu</dt>
                    <dd>{nhan}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Khổ · chất lượng</dt>
                <dd>
                  {data.size} · {data.quality} · {data.model}
                </dd>
              </dl>
              <pre className="max-h-[45vh] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[11.5px] leading-relaxed">{data.prompt}</pre>
            </div>
          )}
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="outline" size="sm" onClick={() => void chep()} disabled={!data}>
              <Copy className="size-4" /> Chép câu lệnh
            </Button>
            {canEdit ? (
              <Button asChild size="sm">
                <Link href={`/marketing/creatives?tab=tao&remix=${encodeURIComponent(img.genId)}`} onClick={() => setOpen(false)}>
                  <Repeat2 className="size-4" /> Tạo lại tương tự
                </Link>
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * HỘP SỬA ẢNH (chủ shop 27/09/2026): từ một ảnh đã tạo — đổi màu, đổi kiểu trình bày mockup, sửa chi tiết — máy vẽ 1–4
 * ảnh MỚI giữ nguyên kiểu dáng. Ảnh mới vào một lượt "Sửa ảnh" chờ duyệt như mọi ảnh gen tay; ảnh gốc không đổi.
 */
function EditImageButton({ img, ctx }: { img: ManualGenImageCard; ctx: ComposeCtx }) {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState("");
  const [layout, setLayout] = useState<ImageEditLayout | null>(null);
  const [detail, setDetail] = useState("");
  const [count, setCount] = useState<number>(IMAGE_EDIT.defaultImages);
  const [pending, start] = useTransition();
  const coGi = color.trim() !== "" || layout !== null || detail.trim() !== "";
  const mo = () => {
    setColor("");
    setLayout(null);
    setDetail("");
    setCount(IMAGE_EDIT.defaultImages);
    setOpen(true);
  };
  const tao = () =>
    start(async () => {
      const r = await startManualEditRun({ sourceImageId: img.id, color, layout, detail, count });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đang vẽ ${r.requested} ảnh sửa — ảnh mới hiện ở lượt "Sửa ảnh" trên cùng của ngày hôm nay, chờ duyệt như ảnh gen tay.`);
      setOpen(false);
    });
  return (
    <>
      <Button size="sm" variant="ghost" className="h-7 flex-1 text-[12px]" onClick={mo} title="Tạo ảnh mới từ ảnh này: đổi màu · đổi kiểu trình bày · sửa chi tiết">
        <Brush className="size-3.5" /> Sửa ảnh
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>Sửa ảnh #{img.seq}</DialogTitle>
            <DialogDescription>Máy vẽ ảnh MỚI từ đúng ảnh này, giữ nguyên kiểu dáng — chỉ đổi những gì bạn chọn dưới đây. Ảnh gốc giữ nguyên; ảnh mới chờ duyệt như ảnh gen tay.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 sm:grid-cols-[200px_minmax(0,1fr)]">
            <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={`Ảnh gốc #${img.seq}`} className="aspect-[4/5] w-full rounded-md" zoomable />
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor={`sua-mau-${img.id}`}>Đổi màu</Label>
                <Input id={`sua-mau-${img.id}`} value={color} maxLength={IMAGE_EDIT.colorMaxChars} onChange={(e) => setColor(e.target.value)} placeholder="Để trống = giữ màu. Gõ màu, vd: xanh navy, đỏ đô…" />
                <div className="flex flex-wrap gap-1">
                  {IMAGE_EDIT_COLOR_CHIPS.map((c) => (
                    <button key={c} type="button" className={cn("rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted", color === c && "border-brand bg-brand/10 text-brand")} onClick={() => setColor(color === c ? "" : c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <label className="block space-y-1 text-[13px]">
                <span className="font-medium">Kiểu trình bày mockup</span>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-[13px]" value={layout ?? ""} onChange={(e) => setLayout(e.target.value ? (e.target.value as ImageEditLayout) : null)}>
                  <option value="">Giữ như ảnh gốc</option>
                  {IMAGE_EDIT_LAYOUTS.map((l) => (
                    <option key={l} value={l}>
                      {IMAGE_EDIT_LAYOUT_LABEL[l]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`sua-ct-${img.id}`}>Sửa chi tiết</Label>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {detail.trim().length}/{IMAGE_EDIT.detailMaxChars}
                  </span>
                </div>
                <Textarea id={`sua-ct-${img.id}`} rows={3} value={detail} maxLength={IMAGE_EDIT.detailMaxChars} onChange={(e) => setDetail(e.target.value)} placeholder="Vd: đổi tay bồng thành tay lỡ, thêm thắt lưng mảnh, người mẫu cười, nền sáng hơn…" />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="font-medium">Số ảnh</span>
                {Array.from({ length: IMAGE_EDIT.maxImages - IMAGE_EDIT.minImages + 1 }, (_, k) => IMAGE_EDIT.minImages + k).map((n) => (
                  <button key={n} type="button" className={cn("numeric h-7 w-8 rounded border text-[12px]", count === n ? "border-brand bg-brand/10 font-semibold text-brand" : "hover:bg-muted")} onClick={() => setCount(n)}>
                    {n}
                  </button>
                ))}
              </div>
              <EstimateLine count={count} unitVnd={ctx.pricing.unitVnd} unitUsd={ctx.pricing.unitUsd} uploads={0} />
              {!img.design && color.trim() ? <p className="text-[11px] text-warning">Đây là ảnh của mã hàng ĐANG CÓ — chỉ đổi sang màu shop thật sự có, nếu không quảng cáo sẽ bán một màu không giao được.</p> : null}
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">{coGi ? "" : "Chọn ít nhất một thay đổi: màu, kiểu trình bày hoặc chi tiết."}</p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Đóng
              </Button>
              <Button type="button" onClick={tao} disabled={pending || !coGi}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Brush className="size-4" />} Tạo {count} ảnh sửa
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "YYYY-MM-DDTHH:mm" theo GIỜ VIỆT NAM của một mốc — giá trị cho ô `datetime-local` (luôn đọc là giờ VN). */
function vnLocalInput(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour") === "24" ? "00" : g("hour")}:${g("minute")}`;
}

/** Ô `datetime-local` (giờ VN) ⇒ ISO có múi giờ. Rỗng / hỏng ⇒ `null`. */
function vnInputToIso(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return null;
  const d = new Date(`${v}:00+07:00`);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

type Names3 = { campaign: string; adset: string; ad: string };

/**
 * Ba tên THEO KHUÔN để hiện trong ô (người không sửa): khuôn của "Đăng camp" (ngày chạy hôm nay) do máy chủ dựng với TKQC +
 * fanpage của CẤU HÌNH — người chọn TKQC / fanpage khác thì thay đúng hai phần tên ấy để ô nói đúng tên sẽ đăng. Máy chủ
 * vẫn tự đặt lại khi ô còn nguyên (gửi rỗng), nên đây chỉ là bản xem trước.
 */
function autoNamesFor(ctx: ComposeCtx, setup: CampaignSetup, win: ProductWinCode | null, media: CreativeMediaKind): Names3 {
  const d = ctx.canPublish ? ctx.campDefaults : ctx.defaults;
  const to = namePartsOf(ctx, setup, win);
  const known = nameKnownOf(ctx, win);
  // Bài video: nhãn media của tên quảng cáo là "video" — cùng khuôn máy chủ đặt (`defaultNames(…, "VIDEO")`).
  return { campaign: rewriteCampaignName(d.campaign, to, known), adset: adsetNameFor(d.adset, setupOptimizationGoal(setup), setupBidStrategy(setup)), ad: adNameForMedia(rewriteCampaignName(d.ad, { ...to, marketerCode: null }, { ...known, marketerCodes: [] }), media) };
}

/** Phần tên mà setup quyết định: tên TKQC · mã MKTer · TEST / mã win · tên fanpage — cùng khuôn máy chủ ghép lúc đăng. */
function namePartsOf(ctx: ComposeCtx, setup: CampaignSetup, win: ProductWinCode | null): CampaignNameParts {
  return {
    account: ctx.setup.accounts.find((a) => a.id === setup.adAccountId)?.name ?? null,
    marketerCode: pickMarketerOption(ctx.setup.marketers, setup.marketerId, setup.marketerCode)?.code ?? null,
    kindLabel: campaignKindLabel(setup.campaignKind, win),
    page: ctx.setup.pages.find((p) => p.id === setup.pageId)?.name ?? null,
  };
}

/** Mọi giá trị một phần tên có thể đang mang — để nhận ra phần CŨ trong tên (kể cả tên đã lưu / sửa tay). */
function nameKnownOf(ctx: ComposeCtx, win: ProductWinCode | null): CampaignNameKnown {
  return {
    accounts: ctx.setup.accounts.map((a) => a.name),
    pages: ctx.setup.pages.map((p) => p.name),
    marketerCodes: [...new Set(ctx.setup.marketers.map((m) => m.code))],
    kinds: win ? ["TEST", win.code] : ["TEST"],
  };
}

/**
 * HỘP SOẠN BÀI của một ảnh đã duyệt (chủ shop 26/09/2026): câu chữ + ba tên + SETUP CAMP, hai lối ra —
 *  · "Lưu vào hàng đợi" ghi bản nháp (câu chữ · tên · setup) lên ảnh + đặt vào hàng đợi. Hộp VẪN MỞ — bấm đăng ngay được.
 *  · "Đăng camp" lên Facebook NGAY — chạy ngay hoặc hẹn giờ, theo đúng setup đang chọn. Người bấm là lượt duyệt chi.
 * (Lô hằng ngày đã bỏ nên không còn "Đưa vào lô".) Ô tên còn nguyên chữ theo khuôn ⇒ gửi rỗng ⇒ máy chủ đặt đúng số thật.
 */
function ComposeButton({ img, ctx, triggerLabel, triggerClassName }: { img: ManualGenImageCard; ctx: ComposeCtx; triggerLabel?: string; triggerClassName?: string }) {
  // Chưa lưu setup ⇒ mặc định dùng nhiều; loại camp mặc định "Mã win" khi mã đã được KHAI Thắng test trở đi; fanpage mặc định
  // = page đứng đầu theo camp của ảnh (đã ra đơn mã này / chưa ra đơn mà đã chạy mẫu tương tự), không có thì page dùng nhiều.
  const initSetup = (): CampaignSetup => {
    if (img.campaignSetup) return img.campaignSetup;
    const campaignKind = img.winCode?.declaredWin ? "WIN" : "TEST";
    const r = rankFanpagesForCamp(ctx.setup.pages, ctx.fanpageEvidence, campTargetOf(img, campaignKind));
    return { ...ctx.setup.defaults, campaignKind, pageId: r.prioritized > 0 ? r.pages[0].id : ctx.setup.defaults.pageId };
  };
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(img.headline);
  const [t, setT] = useState(img.primaryText);
  const [setup, setSetup] = useState<CampaignSetup>(initSetup);
  const [names, setNames] = useState<Names3>({ campaign: img.campaignName, adset: img.adsetName, ad: img.adName });
  const [hen, setHen] = useState(false);
  const [henLuc, setHenLuc] = useState("");
  const [daLuu, setDaLuu] = useState<string | null>(null);
  const [writing, startWrite] = useTransition();
  const [saving, startSave] = useTransition();
  const { canPublish, instant } = ctx;

  const mo = () => {
    const s0 = initSetup();
    // Giờ bắt đầu đã lưu cùng bản nháp: còn ở tương lai (đủ xa để hẹn) thì mở lại đúng giờ ấy; đã qua thì về "Chạy ngay".
    const luuHen = s0.startAt ? new Date(s0.startAt) : null;
    const conHen = !!luuHen && luuHen.getTime() > Date.now() + instant.minScheduleLeadMinutes * 60_000;
    setH(img.headline);
    setT(img.primaryText);
    setSetup(s0);
    // Tên đã lưu đi cùng setup đã lưu: ghép lại một lượt để tên nói đúng MKTer / TKQC / fanpage / loại camp đang chọn.
    const to0 = namePartsOf(ctx, s0, img.winCode);
    const known0 = nameKnownOf(ctx, img.winCode);
    setNames({ campaign: img.campaignName ? rewriteCampaignName(img.campaignName, to0, known0) : "", adset: img.adsetName ? adsetNameFor(img.adsetName, setupOptimizationGoal(s0), setupBidStrategy(s0)) : "", ad: img.adName ? rewriteCampaignName(img.adName, { ...to0, marketerCode: null }, { ...known0, marketerCodes: [] }) : "" });
    setHen(conHen);
    setHenLuc(vnLocalInput(conHen && luuHen ? luuHen : new Date(Date.now() + 60 * 60_000)));
    setDaLuu(null);
    setOpen(true);
  };
  // Ô tên RỖNG trong state = "theo khuôn" (hiện bản xem trước); người gõ ⇒ đúng chữ người gõ.
  const auto = autoNamesFor(ctx, setup, img.winCode, img.videoAssetId ? "VIDEO" : "IMAGE");
  // Đổi setup ⇒ tên đổi NGAY, kể cả tên đã lưu / sửa tay: chèn / thay mã MKTer, thay TKQC · fanpage · TEST ↔ mã win.
  const doiSetup = (next: CampaignSetup) => {
    setSetup(next);
    const to = namePartsOf(ctx, next, img.winCode);
    const known = nameKnownOf(ctx, img.winCode);
    setNames((cur) => ({
      campaign: cur.campaign ? rewriteCampaignName(cur.campaign, to, known) : "",
      adset: cur.adset ? adsetNameFor(cur.adset, setupOptimizationGoal(next), setupBidStrategy(next)) : "",
      ad: cur.ad ? rewriteCampaignName(cur.ad, { ...to, marketerCode: null }, { ...known, marketerCodes: [] }) : "",
    }));
  };
  const shown: Names3 = { campaign: names.campaign || auto.campaign, adset: names.adset || auto.adset, ad: names.ad || auto.ad };
  const setName = (k: keyof Names3, v: string) => setNames((cur) => ({ ...cur, [k]: v.trim() === auto[k].trim() ? "" : v }));
  const noiDung = useMemo(() => ({ imageId: img.id, headline: h, primaryText: t, campaignName: names.campaign, adsetName: names.adset, adName: names.ad }), [img.id, h, t, names]);
  const scheduleAt = hen ? vnInputToIso(henLuc) : null;
  // Giờ bắt đầu đi CÙNG setup (lưu vào bản nháp hàng đợi); lúc đăng, giờ hẹn vẫn gửi riêng ở `scheduleAt`.
  const setupOut = useMemo<CampaignSetup>(() => ({ ...setup, startAt: scheduleAt }), [setup, scheduleAt]);
  const chuKy = JSON.stringify({ noiDung, setupOut });
  const loiLuu = useMemo(() => {
    const r = manualGenDraftSchema.safeParse({ ...noiDung, setup: canPublish ? setupOut : null });
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [noiDung, setupOut, canPublish]);
  const loiDang = useMemo(() => {
    if (hen && !scheduleAt) return "Chọn giờ hẹn.";
    if (setup.budgetVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) return `Ngân sách tối đa ${formatVND(CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd)} một camp.`;
    const r = manualGenInstantSchema.safeParse({ ...noiDung, predictedSeq: null, scheduleAt, setup: setupOut });
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [noiDung, hen, scheduleAt, setup, setupOut]);
  const chan = instant.blockers.length > 0;

  const vietLai = () =>
    startWrite(async () => {
      const r = await recaptionManualGenImage({ imageId: img.id });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setH(r.headline);
      setT(r.primaryText);
    });

  const luu = () =>
    startSave(async () => {
      const r = await saveManualGenDraftAction({ ...noiDung, setup: canPublish ? setupOut : null });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setDaLuu(chuKy);
      toast.success(canPublish ? "Đã lưu vào hàng đợi — bấm Đăng camp ngay bây giờ hoặc lúc khác ở tab ③ Hàng đợi & Đăng." : "Đã lưu vào hàng đợi đăng camp.");
    });

  const dang = () =>
    startSave(async () => {
      const r = await publishManualGenImageNowAction({ ...noiDung, predictedSeq: null, scheduleAt, setup: setupOut });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      // Mã TK chỉ nhắc khi bài THẬT SỰ lên (hoặc đang lên) Facebook — đăng hỏng thì mã ấy không nhận đơn nào.
      const msg = `${r.names.campaign || "Camp"}: ${r.detail}${r.designCode && r.outcome !== "FAILED" ? ` Mã thiết kế ${r.designCode} — tạo sản phẩm Pancake đúng mã này để nhận đơn.` : ""}`;
      if (r.outcome === "LIVE" || r.outcome === "SCHEDULED") toast.success(msg);
      else if (r.outcome === "PENDING") toast.warning(msg);
      else toast.error(msg);
      for (const w of r.warnings) toast.warning(w);
      if (r.outcome !== "FAILED" || !/vẫn ở "Đã duyệt"/.test(r.detail)) setOpen(false);
    });

  const startPreview = hen ? (scheduleAt ? new Date(scheduleAt) : null) : new Date(Date.now() + instant.leadSeconds * 1000);
  const luuMoiNhat = daLuu === chuKy;

  return (
    <>
      <Button size="sm" className={cn("h-7 w-full text-[12px]", triggerClassName)} onClick={mo}>
        {canPublish ? <Rocket className="size-3.5" /> : <Send className="size-3.5" />} {triggerLabel ?? (canPublish ? "Soạn bài · Đăng camp" : "Soạn bài")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              Soạn bài {img.design ? "thiết kế mới" : "ảnh"} #{img.seq}
              {img.queuedAt ? <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-brand">Đang ở hàng đợi</span> : null}
            </DialogTitle>
            <DialogDescription>
              {img.design ? "Máy cấp mã thiết kế TK-… lúc đăng (xem ở tab Thiết kế; đơn, chấm, MOQ đi theo mã ấy). " : ""}
              Sửa câu chữ, chọn setup camp rồi <b>Lưu vào hàng đợi</b> để đăng sau, hoặc <b>Đăng camp</b> ngay. Tên và setup đã điền sẵn theo lựa chọn dùng nhiều — sửa nếu cần.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_280px]">
            <div className="space-y-2.5">
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`pg-h-${img.id}`}>Tiêu đề</Label>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {h.trim().length}/{VARIANT_COPY_LIMITS.headlineMaxChars}
                  </span>
                </div>
                <Input id={`pg-h-${img.id}`} value={h} maxLength={VARIANT_COPY_LIMITS.headlineMaxChars} onChange={(e) => setH(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`pg-t-${img.id}`}>Nội dung chính</Label>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {t.trim().length}/{VARIANT_COPY_LIMITS.primaryTextMaxChars}
                  </span>
                </div>
                <Textarea id={`pg-t-${img.id}`} rows={7} value={t} maxLength={VARIANT_COPY_LIMITS.primaryTextMaxChars} onChange={(e) => setT(e.target.value)} />
                <Button type="button" size="sm" variant="ghost" onClick={vietLai} disabled={writing} title="Viết lại một phương án theo ảnh (luật giá như cũ)">
                  {writing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} AI viết lại nhanh
                </Button>
                <CopyAiPanel
                  imageId={img.id}
                  onUse={(o) => {
                    setH(o.headline);
                    setT(o.primaryText);
                  }}
                />
              </div>
              <div className="space-y-1.5 rounded-lg border p-2.5">
                <p className="text-[12.5px] font-semibold">Tên trên Ads Manager (1 chiến dịch → 1 nhóm → 1 quảng cáo)</p>
                <Label htmlFor={`pg-c-${img.id}`} className="text-[11.5px]">
                  Chiến dịch
                </Label>
                <Input id={`pg-c-${img.id}`} value={shown.campaign} onChange={(e) => setName("campaign", e.target.value)} />
                <Label htmlFor={`pg-a-${img.id}`} className="text-[11.5px]">
                  Nhóm quảng cáo
                </Label>
                <Input id={`pg-a-${img.id}`} value={shown.adset} onChange={(e) => setName("adset", e.target.value)} placeholder="(chưa đọc được nhóm mẫu — để trống = tên mặc định)" />
                <Label htmlFor={`pg-d-${img.id}`} className="text-[11.5px]">
                  Quảng cáo
                </Label>
                <Input id={`pg-d-${img.id}`} value={shown.ad} onChange={(e) => setName("ad", e.target.value)} />
                <p className="text-[11px] text-muted-foreground">Tên điền sẵn theo khuôn — giữ nguyên thì máy cấp đúng số thứ tự lúc đăng; sửa thì dùng đúng chữ bạn gõ.</p>
              </div>
            </div>
            <div className="space-y-2.5">
              {canPublish ? (
                <SetupFields value={setup} onChange={doiSetup} options={ctx.setup} winCode={img.winCode} ranked={rankFanpagesForCamp(ctx.setup.pages, ctx.fanpageEvidence, campTargetOf(img, setup.campaignKind))}>
                  <div className="space-y-1.5 rounded-md border border-brand/40 bg-brand/5 p-2">
                    <p className="text-[11.5px] font-semibold">Thời gian bắt đầu</p>
                    <div className="flex flex-wrap gap-3 text-[12.5px]">
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name={`hen-${img.id}`} checked={!hen} onChange={() => setHen(false)} /> Chạy ngay
                      </label>
                      <label className="flex items-center gap-1.5">
                        <input type="radio" name={`hen-${img.id}`} checked={hen} onChange={() => setHen(true)} /> Hẹn giờ (giờ VN)
                      </label>
                      {hen ? <Input type="datetime-local" value={henLuc} onChange={(e) => setHenLuc(e.target.value)} className="h-8 w-auto text-[12.5px]" /> : null}
                    </div>
                    <p className="text-[11.5px] text-muted-foreground">
                      Chạy LIÊN TỤC
                      {startPreview ? (
                        <>
                          {" "}
                          từ <b className="text-foreground">{vnShortStamp(startPreview)}</b>
                        </>
                      ) : null}{" "}
                      · {formatVND(setup.budgetVnd)}/ngày, không có giờ kết thúc — luật tắt QC tắt khi không hiệu quả, hoặc bạn tắt tay. {hen ? `Hẹn giờ vẫn đăng lên Facebook NGAY lúc bấm (camp lên lịch), sau ít nhất ${instant.minScheduleLeadMinutes} phút, tối đa ${instant.maxScheduleDays} ngày.` : `"Chạy ngay" = bắt đầu sau khoảng ${Math.round(instant.leadSeconds / 60)} phút.`}
                    </p>
                  </div>
                </SetupFields>
              ) : (
                <p className="rounded-lg border border-dashed p-2.5 text-[12px] text-muted-foreground">Setup camp và Đăng camp cần quyền duyệt chi quảng cáo (expenses:write). Bạn vẫn lưu bài vào hàng đợi được.</p>
              )}
              {canPublish && chan ? (
                <ul className="list-disc rounded-lg border border-destructive/40 p-2.5 pl-6 text-[11.5px] text-destructive">
                  {instant.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Xem trước</p>
              <AdPreview pageName={ctx.setup.pages.find((p) => p.id === setup.pageId)?.name ?? ctx.pageName} primaryText={t.trim()} headline={h.trim()} imageId={img.imageId} imageAvailable={img.imageAvailable} videoAssetId={img.videoAssetId} alt={h || `Ảnh #${img.seq}`} />
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">
              {luuMoiNhat ? <span className="text-success">✓ Đã lưu vào hàng đợi.</span> : null} {canPublish ? (loiDang ?? (chan ? "Cổng ghi đang chặn Đăng camp — xem lý do ở trên." : `Đăng camp = ${formatVND(setup.budgetVnd)}/ngày, chạy tới khi tắt.`)) : ""}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Đóng
              </Button>
              <Button type="button" variant="secondary" onClick={luu} disabled={saving || !!loiLuu || luuMoiNhat} title={loiLuu ?? "Lưu câu chữ + tên + setup vào hàng đợi — chưa đăng, chưa tốn đồng nào"}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {luuMoiNhat ? "Đã lưu" : "Lưu vào hàng đợi"}
              </Button>
              {canPublish ? (
                <Button type="button" onClick={dang} disabled={saving || !!loiDang || chan} title={chan ? instant.blockers.join(" ") : undefined}>
                  {saving ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} {hen ? "Hẹn giờ đăng" : "Đăng camp ngay"}
                </Button>
              ) : null}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const sel = "h-8 w-full rounded-md border bg-background px-2 text-[12.5px]";

/**
 * KHỐI SETUP CAMP — như màn tạo chiến dịch của Facebook, rút gọn còn thứ shop hay đổi. Mặc định = lựa chọn DÙNG NHIỀU
 * (TKQC chi nhiều nhất · page ra nhiều đơn nhất · mục tiêu / vị trí / tuổi / giới tính như quảng cáo mẫu). "Như mẫu" nói
 * rõ mẫu đang nhắm gì.
 */
/** Nhãn mặc định của một fanpage trong ô chọn (thứ tự dùng nhiều). */
function pageLabel(p: FanpageOption): string {
  return `${p.name} · ${p.orders30d ? `${p.orders30d} đơn/30 ngày` : p.viaToken ? "chưa ra đơn Pancake" : "0 đơn/30 ngày"}`;
}

function SetupFields({ value, onChange, options, winCode, ranked, children }: { value: CampaignSetup; onChange: (s: CampaignSetup) => void; options: CampaignSetupOptions; winCode: ProductWinCode | null; ranked: RankedFanpages<FanpageOption>; children?: React.ReactNode }) {
  const set = (patch: Partial<CampaignSetup>) => onChange({ ...value, ...patch });
  const tpl = options.template;
  // "Chọn tỉnh / thành" là cờ RIÊNG: khi chưa chọn tỉnh nào, `geo = []` vẫn nghĩa là toàn quốc (và ô nói ra như vậy).
  const [pickMode, setPickMode] = useState(value.geo !== null && value.geo.length > 0);
  const geoMode = value.geo === null ? "TEMPLATE" : pickMode ? "PICK" : "VN";
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<GeoSearchHit[]>([]);
  const [dangTim, startTim] = useTransition();
  useEffect(() => {
    if (geoMode !== "PICK" || q.trim().length < 2) {
      setHits([]);
      return;
    }
    const tm = setTimeout(
      () =>
        startTim(async () => {
          const r = await searchGeoAction({ q });
          if ("error" in r) {
            toast.error(r.error);
            return;
          }
          setHits(r.hits);
        }),
      350,
    );
    return () => clearTimeout(tm);
  }, [q, geoMode]);
  const picked = value.geo ?? [];
  const cap = CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd;
  const chon = pickMarketerOption(options.marketers, value.marketerId, value.marketerCode);
  return (
    <div className="space-y-2 rounded-lg border p-2.5">
      <p className="text-[12.5px] font-semibold">Setup camp</p>
      <label className="block space-y-0.5 text-[11.5px]">
        MKTer (mã vào tên chiến dịch để quy tiền ads)
        <select
          className={sel}
          value={chon ? `${chon.id}|${chon.code}` : ""}
          onChange={(e) => {
            const [id, ...code] = e.target.value.split("|");
            set(id ? { marketerId: id, marketerCode: code.join("|") || null } : { marketerId: null, marketerCode: null });
          }}
        >
          <option value="">— Chưa chọn —</option>
          {options.marketers.map((m) => (
            <option key={`${m.id}|${m.code}`} value={`${m.id}|${m.code}`}>
              {m.name} · {m.code}
            </option>
          ))}
        </select>
        {value.marketerId && !chon ? <span className="block text-destructive">MKTer / mã đã lưu không còn trong danh sách — chọn lại.</span> : null}
        {!value.marketerId ? <span className="block text-warning">Chưa chọn MKTer — tiền ads của camp này không quy về ai.</span> : null}
        {options.marketers.length === 0 ? <span className="block text-muted-foreground">Chưa có MKTer nào khai bí danh ở trang Lương — mã MKTer lấy từ bí danh ấy.</span> : null}
      </label>
      <label className="block space-y-0.5 text-[11.5px]">
        Loại camp (phần giữa tên chiến dịch)
        <select className={sel} value={value.campaignKind} onChange={(e) => set({ campaignKind: e.target.value === "WIN" ? "WIN" : "TEST" })}>
          <option value="TEST">TEST — tiền ads tính là chi phí test</option>
          <option value="WIN" disabled={!winCode}>
            {winCode ? `Mã win ${winCode.code} — tiền ads quy về mã (vòng đời: ${winCode.stateLabel})` : "Mã win — ảnh này không thuộc mã hàng có mã đọc được"}
          </option>
        </select>
        {value.campaignKind === "WIN" && !winCode ? <span className="block text-destructive">Ảnh này không có mã win — chọn TEST.</span> : null}
      </label>
      {children}
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="space-y-0.5 text-[11.5px]">
          Tài khoản quảng cáo
          <select className={sel} value={value.adAccountId} onChange={(e) => set({ adAccountId: e.target.value })}>
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.spend30dVnd ? `${formatVND(a.spend30dVnd, { compact: true })}/30 ngày` : "chưa chi 30 ngày"}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-[11.5px]">
          Fanpage
          <select className={sel} value={value.pageId} onChange={(e) => set({ pageId: e.target.value })}>
            {ranked.prioritized > 0 ? (
              <>
                <optgroup label={value.campaignKind === "WIN" && winCode ? `Đã ra đơn mã ${winCode.code}` : "Chưa ra đơn · đã chạy mẫu tương tự"}>
                  {ranked.pages.slice(0, ranked.prioritized).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.hint}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Fanpage khác">
                  {ranked.pages.slice(ranked.prioritized).map((p) => (
                    <option key={p.id} value={p.id}>
                      {pageLabel(p)}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              ranked.pages.map((p) => (
                <option key={p.id} value={p.id}>
                  {pageLabel(p)}
                </option>
              ))
            )}
          </select>
          {ranked.pages.find((p) => p.id === value.pageId)?.hint ? <span className="block text-muted-foreground">{ranked.pages.find((p) => p.id === value.pageId)?.hint}</span> : null}
          {ranked.note ? <span className="block text-muted-foreground">{ranked.note}</span> : null}
          {options.tokenPagesError ? <span className="block text-warning">Không đọc được danh sách page của token ERP ({options.tokenPagesError}) — chỉ còn page từng ra đơn trên Pancake.</span> : null}
        </label>
        <label className="space-y-0.5 text-[11.5px]">
          Mục tiêu chiến dịch
          <select
            className={sel}
            value={value.objective}
            onChange={(e) => {
              const objective = e.target.value as CampaignSetup["objective"];
              // Tiếp cận không có mục tiêu tin nhắn ⇒ bỏ mục tiêu hiệu quả đang chọn.
              set(objective === "REACH" ? { objective, performanceGoal: null } : { objective });
            }}
          >
            {CAMPAIGN_OBJECTIVES.map((o) => (
              <option key={o} value={o}>
                {CAMPAIGN_OBJECTIVE_LABEL[o]}
                {o === "TEMPLATE" && tpl?.optimizationGoal ? ` (tối ưu ${tpl.optimizationGoal})` : ""}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-[11.5px]">
          Mục tiêu hiệu quả
          <select
            className={sel}
            value={value.performanceGoal ?? ""}
            disabled={value.objective === "REACH"}
            onChange={(e) => set({ performanceGoal: (PERFORMANCE_GOALS as readonly string[]).includes(e.target.value) ? (e.target.value as CampaignSetup["performanceGoal"]) : null })}
          >
            <option value="">
              {value.objective === "TEMPLATE" ? `Như mẫu${tpl?.optimizationGoal ? ` (${PERFORMANCE_GOAL_LABEL[tpl.optimizationGoal as PerformanceGoal] ?? tpl.optimizationGoal})` : ""}` : value.objective === "MESSAGES" ? "Theo mục tiêu (trò chuyện)" : "Theo mục tiêu (tiếp cận)"}
            </option>
            {PERFORMANCE_GOALS.map((g) => (
              <option key={g} value={g}>
                {PERFORMANCE_GOAL_LABEL[g]}
              </option>
            ))}
          </select>
          {value.performanceGoal === "MESSAGING_PURCHASE_CONVERSION" || value.performanceGoal === "VALUE" ? (
            <span className="block text-muted-foreground">Facebook chỉ nhận khi page đã gửi đủ sự kiện mua qua tin nhắn (≥ 5 / 30 ngày) — không đủ thì bước tạo nhóm báo lỗi, camp chưa chạy.</span>
          ) : null}
        </label>
        <div className="space-y-0.5 text-[11.5px]">
          <label htmlFor={`bid-${value.adAccountId}-${value.pageId}`}>Giá thầu</label>
          <div className="flex gap-1.5">
            <select
              id={`bid-${value.adAccountId}-${value.pageId}`}
              className={sel}
              value={value.bid ?? ""}
              onChange={(e) => {
                const bid = (CAMPAIGN_BIDS as readonly string[]).includes(e.target.value) ? (e.target.value as CampaignBid) : null;
                set({ bid, bidAmountVnd: bidNeedsAmount(bid) ? (value.bidAmountVnd ?? null) : null });
              }}
            >
              <option value="">Như mẫu{tpl?.bid ? ` (${tpl.bid})` : ""}</option>
              {CAMPAIGN_BIDS.map((k) => (
                <option key={k} value={k}>
                  {CAMPAIGN_BID_LABEL[k]}
                </option>
              ))}
            </select>
            {bidNeedsAmount(value.bid) ? (
              <Input
                type="number"
                min={CAMPAIGN_SETUP_LIMITS.minBidVnd}
                max={value.budgetVnd}
                step={1_000}
                value={value.bidAmountVnd ?? ""}
                placeholder="VND / kết quả"
                aria-label="Con số giới hạn giá thầu (VND / kết quả)"
                onChange={(e) => set({ bidAmountVnd: e.target.value === "" ? null : Math.round(Number(e.target.value) || 0) })}
                className="h-8 w-32 text-[12.5px]"
              />
            ) : null}
          </div>
          {value.bid === "BID_CAP" ? <span className="block text-muted-foreground">Trần giá mỗi lượt đấu thầu — đặt thấp thì Facebook phân phối ít, có ngày không tiêu hết ngân sách.</span> : null}
          {value.bid === "COST_CAP" ? <span className="block text-muted-foreground">Facebook giữ chi phí TRUNG BÌNH mỗi kết quả quanh con số này (vd giá mỗi tin nhắn).</span> : null}
        </div>
        <label className="space-y-0.5 text-[11.5px]">
          Ngân sách ngày (tối đa {formatVND(cap)}/ngày)
          <Input type="number" min={CAMPAIGN_SETUP_LIMITS.minBudgetVnd} max={cap} step={10_000} value={value.budgetVnd} onChange={(e) => set({ budgetVnd: Math.round(Number(e.target.value) || 0) })} className="h-8 text-[12.5px]" />
        </label>
      </div>
      <div className="space-y-1">
        <p className="text-[11.5px]">Vị trí</p>
        <div className="flex flex-wrap gap-3 text-[12px]">
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={geoMode === "TEMPLATE"}
              onChange={() => {
                setPickMode(false);
                set({ geo: null });
              }}
            />{" "}
            Như mẫu{tpl ? ` (${tpl.geo})` : ""}
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={geoMode === "VN"}
              onChange={() => {
                setPickMode(false);
                set({ geo: [] });
              }}
            />{" "}
            Toàn quốc
          </label>
          <label className="flex items-center gap-1">
            <input
              type="radio"
              checked={geoMode === "PICK"}
              onChange={() => {
                setPickMode(true);
                set({ geo: picked });
              }}
            />{" "}
            Chọn tỉnh / thành
          </label>
        </div>
        {geoMode === "PICK" ? (
          <div className="space-y-1">
            {picked.length === 0 ? <p className="text-[11px] text-warning">Chưa chọn tỉnh / thành nào — đang là toàn quốc.</p> : null}
            <div className="flex flex-wrap gap-1">
              {picked.map((g) => (
                <span key={g.key} className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[11px]">
                  {g.name}
                  <button type="button" onClick={() => set({ geo: picked.filter((x) => x.key !== g.key) })} aria-label={`Bỏ ${g.name}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Gõ tên tỉnh / thành (vd Hà Nội, Đà Nẵng)…" className="h-8 text-[12.5px]" />
            {dangTim ? <p className="text-[11px] text-muted-foreground">Đang tìm…</p> : null}
            {hits.length ? (
              <div className="flex flex-wrap gap-1">
                {hits
                  .filter((hh) => !picked.some((x) => x.key === hh.key))
                  .map((hh) => (
                    <button key={hh.key} type="button" className="rounded border px-1.5 py-0.5 text-[11px] hover:bg-muted" onClick={() => set({ geo: [...picked, { key: hh.key, name: hh.region && hh.type === "city" ? `${hh.name} (${hh.region})` : hh.name, type: hh.type }].slice(0, CAMPAIGN_SETUP_LIMITS.maxGeo) })}>
                      + {hh.name}
                      {hh.type === "city" && hh.region ? <span className="text-muted-foreground"> · {hh.region}</span> : null}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-0.5 text-[11.5px]">
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={value.ageMin === null && value.ageMax === null} onChange={(e) => set(e.target.checked ? { ageMin: null, ageMax: null } : { ageMin: 18, ageMax: 65 })} /> Tuổi như mẫu{tpl ? ` (${tpl.age})` : ""}
          </label>
          {value.ageMin !== null || value.ageMax !== null ? (
            <div className="flex items-center gap-1">
              <Input type="number" min={CAMPAIGN_SETUP_LIMITS.minAge} max={CAMPAIGN_SETUP_LIMITS.maxAge} value={value.ageMin ?? ""} onChange={(e) => set({ ageMin: e.target.value ? Math.round(Number(e.target.value)) : null })} className="h-8 w-16 text-[12.5px]" />
              <span>–</span>
              <Input type="number" min={CAMPAIGN_SETUP_LIMITS.minAge} max={CAMPAIGN_SETUP_LIMITS.maxAge} value={value.ageMax ?? ""} onChange={(e) => set({ ageMax: e.target.value ? Math.round(Number(e.target.value)) : null })} className="h-8 w-16 text-[12.5px]" />
              <span className="text-muted-foreground">(65 = 65+)</span>
            </div>
          ) : null}
        </div>
        <label className="space-y-0.5 text-[11.5px]">
          Giới tính
          <select className={sel} value={value.gender ?? "TEMPLATE"} onChange={(e) => set({ gender: e.target.value === "TEMPLATE" ? null : (e.target.value as CampaignSetup["gender"]) })}>
            <option value="TEMPLATE">Như mẫu{tpl ? ` (${tpl.gender})` : ""}</option>
            {CAMPAIGN_GENDERS.map((g) => (
              <option key={g} value={g}>
                {CAMPAIGN_GENDER_LABEL[g]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="text-[11px] text-muted-foreground">Phần không chọn giữ đúng như quảng cáo mẫu (vị trí đặt quảng cáo, giá thầu, lời chào tin nhắn…). Đổi TKQC khác tài khoản của mẫu thì tệp đối tượng tuỳ chỉnh của mẫu không đi theo.</p>
    </div>
  );
}

/**
 * HÀNG ĐỢI ĐĂNG CAMP — các bài đã soạn và bấm "Lưu", mới lưu trước. Mỗi dòng mở lại ĐÚNG hộp soạn bài (sửa tiếp · setup ·
 * đăng camp); đăng xong bài tự rời hàng đợi.
 */
export function PublishQueue({ items, canEdit, ctx }: { items: PublishQueueItem[]; canEdit: boolean; ctx: ComposeCtx }) {
  const [pending, start] = useTransition();
  const bo = (imageId: string) =>
    start(async () => {
      const r = await unqueueManualGenDraftAction({ imageId });
      if ("error" in r) toast.error(r.error);
      else toast.success("Đã bỏ khỏi hàng đợi — bản nháp câu chữ vẫn giữ trên ảnh.");
    });
  if (items.length === 0) return null;
  return (
    <div className="divide-y rounded-md border bg-card">
      {items.map(({ img, runLabel }) => {
        const s = img.campaignSetup;
        const acc = s ? (ctx.setup.accounts.find((a) => a.id === s.adAccountId)?.name ?? s.adAccountId) : null;
        const page = s ? (ctx.setup.pages.find((p) => p.id === s.pageId)?.name ?? s.pageId) : null;
        const mkt = s ? pickMarketerOption(ctx.setup.marketers, s.marketerId, s.marketerCode) : null;
        const kind = s?.campaignKind === "WIN" && img.winCode ? ` · mã ${img.winCode.code}` : "";
        return (
          <div key={img.id} className="flex flex-wrap items-center gap-2.5 p-2">
            <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={img.headline || `Ảnh #${img.seq}`} className="size-16 shrink-0 rounded" iconClassName="size-4" zoomable />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate text-[12.5px] font-semibold">{img.headline || <span className="italic text-muted-foreground">(chưa có tiêu đề)</span>}</p>
              <p className="line-clamp-1 text-[11.5px] text-muted-foreground">{img.primaryText || "(chưa có nội dung chính)"}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">
                {runLabel} #{img.seq} · chiến dịch: {img.campaignName || "theo khuôn lúc đăng"} · lưu bởi {img.queuedByName || "—"} {img.queuedAt ? vnShortStamp(img.queuedAt) : ""}
              </p>
              <p className="truncate text-[10.5px] text-muted-foreground">{s ? `${describeCampaignSetup(s, { account: acc ?? undefined, page: page ?? undefined, marketer: mkt ? `${mkt.name} (${mkt.code})` : undefined })}${kind}` : "Setup: mặc định dùng nhiều (chưa chọn)"}</p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <ComposeButton img={img} ctx={ctx} triggerLabel={ctx.canPublish ? "Mở · Đăng camp" : "Mở bài"} triggerClassName="w-auto" />
                <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={pending} onClick={() => bo(img.id)} title="Bỏ khỏi hàng đợi">
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}


/** Mẫu đã lên Facebook cần cho hộp "Đăng lại camp" — đủ để xem trước, xếp fanpage và dựng tên. */
export type RepublishSource = {
  id: string;
  slot: number;
  headline: string;
  primaryText: string;
  imageId: string | null;
  imageAvailable: boolean;
  /** Bài VIDEO — đăng lại tải video sang thư viện của TKQC mới. `null` = bài ảnh. */
  videoAssetId: string | null;
  productId: string | null;
  productName: string | null;
  /** DNA của thiết kế (mẫu thiết kế mới) — xếp fanpage theo mẫu tương tự. */
  designDna: Record<string, string> | null;
  campaignName: string;
};

/**
 * "ĐĂNG LẠI CAMP" (chủ shop 29/09/2026: "scale mẫu trên các TKQC khác, fanpages khác") — CÙNG khối Setup camp, tên theo khuôn,
 * giờ hẹn và xem trước của hộp "Đăng camp". Mỗi lần bấm là MỘT camp mới (chiến dịch → nhóm → quảng cáo) từ ảnh + câu chữ của
 * mẫu này; camp gốc không bị đụng. Người bấm là lượt duyệt chi — cần quyền duyệt chi quảng cáo.
 */
export function RepublishButton({ v, ctx, winCode }: { v: RepublishSource; ctx: ComposeCtx; winCode: ProductWinCode | null }) {
  const target = (kind: CampaignSetup["campaignKind"]): CampPageTarget => ({ kind: kind === "WIN" && winCode ? "WIN" : "TEST", productId: v.designDna ? null : v.productId, dna: v.designDna });
  const initSetup = (): CampaignSetup => {
    const campaignKind = winCode?.declaredWin && !v.designDna ? "WIN" : "TEST";
    const r = rankFanpagesForCamp(ctx.setup.pages, ctx.fanpageEvidence, target(campaignKind));
    return { ...ctx.setup.defaults, campaignKind, pageId: r.prioritized > 0 ? r.pages[0].id : ctx.setup.defaults.pageId };
  };
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(v.headline);
  const [t, setT] = useState(v.primaryText);
  const [setup, setSetup] = useState<CampaignSetup>(initSetup);
  const [names, setNames] = useState<Names3>({ campaign: "", adset: "", ad: "" });
  const [hen, setHen] = useState(false);
  const [henLuc, setHenLuc] = useState("");
  const [pending, start] = useTransition();
  const { instant } = ctx;
  const wc = v.designDna ? null : winCode;

  const mo = () => {
    setH(v.headline);
    setT(v.primaryText);
    setSetup(initSetup());
    setNames({ campaign: "", adset: "", ad: "" });
    setHen(false);
    setHenLuc(vnLocalInput(new Date(Date.now() + 60 * 60_000)));
    setOpen(true);
  };
  const auto = autoNamesFor(ctx, setup, wc, v.videoAssetId ? "VIDEO" : "IMAGE");
  const doiSetup = (next: CampaignSetup) => {
    setSetup(next);
    const to = namePartsOf(ctx, next, wc);
    const known = nameKnownOf(ctx, wc);
    setNames((cur) => ({
      campaign: cur.campaign ? rewriteCampaignName(cur.campaign, to, known) : "",
      adset: cur.adset ? adsetNameFor(cur.adset, setupOptimizationGoal(next), setupBidStrategy(next)) : "",
      ad: cur.ad ? rewriteCampaignName(cur.ad, { ...to, marketerCode: null }, { ...known, marketerCodes: [] }) : "",
    }));
  };
  const shown: Names3 = { campaign: names.campaign || auto.campaign, adset: names.adset || auto.adset, ad: names.ad || auto.ad };
  const setName = (k: keyof Names3, val: string) => setNames((cur) => ({ ...cur, [k]: val.trim() === auto[k].trim() ? "" : val }));
  const scheduleAt = hen ? vnInputToIso(henLuc) : null;
  const setupOut = useMemo<CampaignSetup>(() => ({ ...setup, startAt: scheduleAt }), [setup, scheduleAt]);
  const payload = { variantId: v.id, headline: h, primaryText: t, campaignName: names.campaign, adsetName: names.adset, adName: names.ad, predictedSeq: null, scheduleAt, setup: setupOut };
  const loi = (() => {
    if (hen && !scheduleAt) return "Chọn giờ hẹn.";
    if (setup.budgetVnd > CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd) return `Ngân sách tối đa ${formatVND(CREATIVE_HARD_LIMITS.maxBudgetPerVariantVnd)} một camp.`;
    const r = creativeRepublishSchema.safeParse(payload);
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  })();
  const chan = instant.blockers.length > 0;
  const dang = () =>
    start(async () => {
      const r = await republishVariantAction(payload);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      const msg = `${r.names.campaign || "Camp mới"}: ${r.detail}`;
      if (r.outcome === "LIVE" || r.outcome === "SCHEDULED") toast.success(msg);
      else if (r.outcome === "PENDING") toast.warning(msg);
      else toast.error(msg);
      if (r.outcome !== "FAILED") setOpen(false);
    });
  const startPreview = hen ? (scheduleAt ? new Date(scheduleAt) : null) : new Date(Date.now() + instant.leadSeconds * 1000);

  return (
    <>
      <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={mo} title="Đăng mẫu này thành một camp MỚI trên TKQC / fanpage khác — camp gốc giữ nguyên">
        <Repeat2 className="size-3.5" /> Đăng lại camp
      </Button>
      <Dialog open={open} onOpenChange={(o) => !pending && setOpen(o)}>
        <DialogContent className="max-h-[94vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              Đăng lại camp — mẫu #{v.slot}
              {v.productName ? <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">{v.productName}</span> : null}
            </DialogTitle>
            <DialogDescription>
              Tạo một camp MỚI từ ảnh + câu chữ của mẫu này trên TKQC / fanpage bạn chọn. Camp gốc{v.campaignName ? ` (${v.campaignName})` : ""} vẫn chạy như cũ; camp mới có số đo và luật tắt riêng.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_280px]">
            <div className="space-y-2.5">
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`rp-h-${v.id}`}>Tiêu đề</Label>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {h.trim().length}/{VARIANT_COPY_LIMITS.headlineMaxChars}
                  </span>
                </div>
                <Input id={`rp-h-${v.id}`} value={h} maxLength={VARIANT_COPY_LIMITS.headlineMaxChars} onChange={(e) => setH(e.target.value)} />
              </div>
              <div className="space-y-1">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`rp-t-${v.id}`}>Nội dung chính</Label>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {t.trim().length}/{VARIANT_COPY_LIMITS.primaryTextMaxChars}
                  </span>
                </div>
                <Textarea id={`rp-t-${v.id}`} rows={7} value={t} maxLength={VARIANT_COPY_LIMITS.primaryTextMaxChars} onChange={(e) => setT(e.target.value)} />
              </div>
              <div className="space-y-1.5 rounded-lg border p-2.5">
                <p className="text-[12.5px] font-semibold">Tên trên Ads Manager</p>
                <Label htmlFor={`rp-c-${v.id}`} className="text-[11.5px]">
                  Chiến dịch
                </Label>
                <Input id={`rp-c-${v.id}`} value={shown.campaign} onChange={(e) => setName("campaign", e.target.value)} />
                <Label htmlFor={`rp-a-${v.id}`} className="text-[11.5px]">
                  Nhóm quảng cáo
                </Label>
                <Input id={`rp-a-${v.id}`} value={shown.adset} onChange={(e) => setName("adset", e.target.value)} placeholder="(để trống = tên mặc định)" />
                <Label htmlFor={`rp-d-${v.id}`} className="text-[11.5px]">
                  Quảng cáo
                </Label>
                <Input id={`rp-d-${v.id}`} value={shown.ad} onChange={(e) => setName("ad", e.target.value)} />
              </div>
            </div>
            <div className="space-y-2.5">
              <SetupFields value={setup} onChange={doiSetup} options={ctx.setup} winCode={wc} ranked={rankFanpagesForCamp(ctx.setup.pages, ctx.fanpageEvidence, target(setup.campaignKind))}>
                <div className="space-y-1.5 rounded-md border border-brand/40 bg-brand/5 p-2">
                  <p className="text-[11.5px] font-semibold">Thời gian bắt đầu</p>
                  <div className="flex flex-wrap gap-3 text-[12.5px]">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`rp-hen-${v.id}`} checked={!hen} onChange={() => setHen(false)} /> Chạy ngay
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`rp-hen-${v.id}`} checked={hen} onChange={() => setHen(true)} /> Hẹn giờ (giờ VN)
                    </label>
                    {hen ? <Input type="datetime-local" value={henLuc} onChange={(e) => setHenLuc(e.target.value)} className="h-8 w-auto text-[12.5px]" /> : null}
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">
                    Chạy LIÊN TỤC{startPreview ? ` từ ${vnShortStamp(startPreview)}` : ""} · {formatVND(setup.budgetVnd)}/ngày, không có giờ kết thúc — luật tắt QC tắt khi không hiệu quả, hoặc bạn tắt tay.
                  </p>
                </div>
              </SetupFields>
              {chan ? (
                <ul className="list-disc rounded-lg border border-destructive/40 p-2.5 pl-6 text-[11.5px] text-destructive">
                  {instant.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Xem trước</p>
              <AdPreview pageName={ctx.setup.pages.find((p) => p.id === setup.pageId)?.name ?? ctx.pageName} primaryText={t.trim()} headline={h.trim()} imageId={v.imageId} imageAvailable={v.imageAvailable} videoAssetId={v.videoAssetId} alt={h || `Mẫu #${v.slot}`} />
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">{loi ?? (chan ? "Cổng ghi đang chặn — xem lý do ở trên." : `Camp mới = ${formatVND(setup.budgetVnd)}/ngày, chạy tới khi tắt.`)}</p>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
                Đóng
              </Button>
              <Button type="button" onClick={dang} disabled={pending || !!loi || chan} title={chan ? instant.blockers.join(" ") : undefined}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Rocket className="size-4" />} {hen ? "Hẹn giờ đăng lại" : "Đăng lại camp ngay"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
