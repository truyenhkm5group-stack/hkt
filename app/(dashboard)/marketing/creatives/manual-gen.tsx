"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Loader2, Send, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdPreview, GeneChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { promoteManualGenImageAction, recaptionManualGenImage, reviewManualGenImageAction, startManualGenRun } from "@/lib/actions/creative-manual-gen";
import { MANUAL_GEN, MANUAL_GEN_IMAGE_STATUS_LABEL, type ManualGenImageStatus } from "@/lib/constants/creative-loop";
import type { ManualGenImageCard, PixelSourceOption } from "@/lib/queries/creative-manual-gen";
import { cn } from "@/lib/utils";
import { VARIANT_COPY_LIMITS, manualGenPromoteSchema } from "@/lib/validation/creative";

/**
 * GEN ẢNH BẰNG TAY (§5i) — phía trình duyệt: form "Gen ảnh", thẻ từng ảnh (Duyệt / Loại), hộp "Đưa vào lô"
 * (câu chữ AI viết theo ảnh + ba tên sửa được), và bộ tự tải lại khi còn ảnh đang vẽ. Mọi luật ở
 * `lib/creative/manual-gen.ts`; màn hình không tự tính con số tiền nào.
 */

const box = "h-8 w-full rounded-md border bg-background px-2 text-[12.5px] disabled:opacity-60";

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

export function ManualGenForm({
  sources,
  allowedNow,
  capReason,
  disabledReason,
  initialPhotoId,
}: {
  sources: PixelSourceOption[];
  allowedNow: number;
  capReason: string | null;
  disabledReason: string | null;
  /** Ảnh chọn sẵn (vd `?product=` từ đề xuất đẩy tồn). Chỉ là giá trị khởi đầu — không kích lượt vẽ nào. */
  initialPhotoId?: string;
}) {
  const router = useRouter();
  const photos = sources.filter((s) => s.kind === "PRODUCT_PHOTO");
  const [photoId, setPhotoId] = useState(initialPhotoId && photos.some((s) => s.id === initialPhotoId) ? initialPhotoId : (photos[0]?.id ?? ""));
  const [ownAdId, setOwnAdId] = useState("");
  const [idea, setIdea] = useState("");
  const [pending, start] = useTransition();
  const productOf = sources.find((s) => s.id === photoId)?.productId ?? "";
  const ownAds = sources.filter((s) => s.kind === "OWN_AD" && s.productId === productOf);

  const gen = () =>
    start(async () => {
      const r = await startManualGenRun({ productPhotoSourceId: photoId, ownAdSourceId: ownAdId, idea });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.allowed === r.requested ? `Đang vẽ ${r.requested} ảnh — ảnh hiện dần ở "Kết quả gen tay".` : `Chỉ vẽ được ${r.allowed}/${r.requested} ảnh. ${r.note ?? ""}`);
      setIdea("");
      router.refresh();
    });

  const khoa = disabledReason ?? (photos.length === 0 ? "Chưa có ảnh sản phẩm thật nào — nhập ở tab Nguồn ảnh trước." : allowedNow === 0 ? (capReason ?? "Hết trần ảnh hôm nay.") : null);

  return (
    <div className="grid gap-2.5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-1.5">
        <Label htmlFor="mg-photo">Ảnh sản phẩm thật làm gốc</Label>
        <select
          id="mg-photo"
          className={box}
          value={photoId}
          disabled={pending}
          onChange={(e) => {
            setPhotoId(e.target.value);
            setOwnAdId("");
          }}
        >
          {photos.length === 0 ? <option value="">— chưa có ảnh sản phẩm thật —</option> : null}
          {photos.map((s) => (
            <option key={s.id} value={s.id}>
              {s.productLabel}
              {s.title ? ` — ${s.title}` : ""}
            </option>
          ))}
        </select>
        <Label htmlFor="mg-own" className="pt-1">
          Quảng cáo cũ của shop cùng mã (tuỳ chọn — tham chiếu bố cục)
        </Label>
        <select id="mg-own" className={box} value={ownAdId} disabled={pending || ownAds.length === 0} onChange={(e) => setOwnAdId(e.target.value)}>
          <option value="">{ownAds.length ? "— không dùng —" : "— mã này chưa có quảng cáo cũ đã nhập —"}</option>
          {ownAds.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title || s.id}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-muted-foreground">Chỉ ảnh sản phẩm thật và quảng cáo cũ của chính shop được gửi sang máy vẽ — ảnh spy / tham khảo tay không bao giờ.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="mg-idea">Ý tưởng / câu lệnh (tuỳ chọn)</Label>
          <span className="numeric text-[11px] text-muted-foreground">
            {idea.trim().length}/{MANUAL_GEN.ideaMaxChars}
          </span>
        </div>
        <Textarea id="mg-idea" rows={4} value={idea} maxLength={MANUAL_GEN.ideaMaxChars} disabled={pending} onChange={(e) => setIdea(e.target.value)} placeholder="Ví dụ: mặc đi biển Đà Nẵng buổi chiều, ánh nắng vàng, dáng đi tự nhiên…" />
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-muted-foreground" title={capReason ?? undefined}>
            Mỗi lần bấm vẽ {MANUAL_GEN.imagesPerRun} ảnh · hôm nay còn vẽ được <b className="numeric text-foreground">{allowedNow}</b> ảnh trong trần chung với lô.
          </p>
          <Button onClick={gen} disabled={pending || !!khoa || !photoId} title={khoa ?? undefined}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Gen {MANUAL_GEN.imagesPerRun} ảnh
          </Button>
        </div>
      </div>
    </div>
  );
}

const TONE: Partial<Record<ManualGenImageStatus, string>> = {
  APPROVED: "bg-success/15 text-success",
  PROMOTED: "bg-brand/10 text-brand",
  GEN_FAILED: "bg-destructive/10 text-destructive",
  REJECTED: "bg-muted text-muted-foreground",
};

export function ManualGenImageTile({
  img,
  canEdit,
  pageName,
  defaults,
  predictedSeq,
  targetDay,
}: {
  img: ManualGenImageCard;
  canEdit: boolean;
  pageName: string | null;
  defaults: { campaign: string; adset: string; ad: string; problems: string[] };
  predictedSeq: number;
  targetDay: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const review = (decision: "APPROVE" | "REJECT") =>
    start(async () => {
      const r = await reviewManualGenImageAction({ imageId: img.id, decision, reason: "" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (r.status === "APPROVED") toast.success(r.captionError ? `Đã duyệt — AI chưa viết được câu chữ (${r.captionError}). Gõ tay trong hộp "Đưa vào lô".` : "Đã duyệt — AI đã viết câu chữ theo ảnh.");
      else toast.success("Đã loại ảnh.");
      router.refresh();
    });
  const loai = img.status === "REJECTED" || img.status === "GEN_FAILED";
  return (
    <div className={cn("flex flex-col overflow-hidden rounded-lg border bg-card", loai && "opacity-60")}>
      <div className="relative">
        {img.status === "PLANNED" || img.status === "DRAWING" ? (
          <div className="flex aspect-[4/5] w-full flex-col items-center justify-center gap-1 bg-muted text-[11px] text-muted-foreground">
            <Loader2 className={cn("size-5", img.status === "DRAWING" && "animate-spin")} />
            {MANUAL_GEN_IMAGE_STATUS_LABEL[img.status]}
          </div>
        ) : (
          <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={`Ảnh gen tay #${img.seq}`} className="aspect-[4/5] w-full" />
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-bold">#{img.seq}</span>
        <span className={cn("absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold", TONE[img.status] ?? "bg-background/90")}>{MANUAL_GEN_IMAGE_STATUS_LABEL[img.status]}</span>
      </div>
      <div className="flex flex-1 flex-col gap-1.5 p-2">
        <GeneChips genes={img.genes} className="gap-0.5" />
        {img.error ? <p className="line-clamp-3 text-[11px] text-destructive" title={img.error}>{img.error}</p> : null}
        {img.status === "APPROVED" && img.captionError ? <p className="line-clamp-2 text-[11px] text-warning" title={img.captionError}>AI chưa viết được câu chữ: {img.captionError}</p> : null}
        {img.status === "PROMOTED" ? <p className="text-[11px] text-muted-foreground">Đã vào lô — sửa tiếp ở khối lô chờ duyệt.</p> : null}
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
            {img.status === "APPROVED" ? <PromoteButton img={img} pageName={pageName} defaults={defaults} predictedSeq={predictedSeq} targetDay={targetDay} /> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PromoteButton({ img, pageName, defaults, predictedSeq, targetDay }: { img: ManualGenImageCard; pageName: string | null; defaults: { campaign: string; adset: string; ad: string; problems: string[] }; predictedSeq: number; targetDay: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(img.headline);
  const [t, setT] = useState(img.primaryText);
  const [camp, setCamp] = useState(defaults.campaign);
  const [adset, setAdset] = useState(defaults.adset);
  const [ad, setAd] = useState(defaults.ad);
  const [writing, startWrite] = useTransition();
  const [saving, startSave] = useTransition();

  const mo = () => {
    setH(img.headline);
    setT(img.primaryText);
    setCamp(defaults.campaign);
    setAdset(defaults.adset);
    setAd(defaults.ad);
    setOpen(true);
  };
  const input = useMemo(() => ({ imageId: img.id, headline: h, primaryText: t, campaignName: camp, adsetName: adset, adName: ad, predictedSeq }), [img.id, h, t, camp, adset, ad, predictedSeq]);
  const loiTruoc = useMemo(() => {
    const r = manualGenPromoteSchema.safeParse(input);
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [input]);

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
  const dua = () =>
    startSave(async () => {
      const r = await promoteManualGenImageAction(input);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã đưa vào lô ${r.batchDay} (ô #${r.slot}) — lô cần được bấm duyệt (lại).`);
      for (const w of r.warnings) toast.warning(w);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" className="h-7 w-full text-[12px]" onClick={mo}>
        <Send className="size-3.5" /> Soạn bài & đưa vào lô
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Đưa ảnh #{img.seq} vào lô chạy ngày {targetDay}</DialogTitle>
            <DialogDescription>Câu chữ do AI viết theo ảnh — sửa tùy ý. Ba tên theo khuôn mặc định, sửa được; để trống một tên = dùng tên mặc định. Bài vẫn phải qua lượt DUYỆT CẢ LÔ mới được đăng.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 md:grid-cols-[1fr_300px]">
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
                <Textarea id={`pg-t-${img.id}`} rows={6} value={t} maxLength={VARIANT_COPY_LIMITS.primaryTextMaxChars} onChange={(e) => setT(e.target.value)} />
                <Button type="button" size="sm" variant="secondary" onClick={vietLai} disabled={writing}>
                  {writing ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} AI viết lại theo ảnh
                </Button>
              </div>
              <div className="space-y-1.5 rounded-lg border p-2.5">
                <p className="text-[12.5px] font-semibold">Tên trên Ads Manager (mỗi bài một chiến dịch → 1 nhóm → 1 quảng cáo)</p>
                <Label htmlFor={`pg-c-${img.id}`} className="text-[11.5px]">
                  Chiến dịch
                </Label>
                <Input id={`pg-c-${img.id}`} value={camp} onChange={(e) => setCamp(e.target.value)} />
                <Label htmlFor={`pg-a-${img.id}`} className="text-[11.5px]">
                  Nhóm quảng cáo
                </Label>
                <Input id={`pg-a-${img.id}`} value={adset} onChange={(e) => setAdset(e.target.value)} placeholder="(chưa đọc được nhóm mẫu — để trống = tên mặc định)" />
                <Label htmlFor={`pg-d-${img.id}`} className="text-[11.5px]">
                  Quảng cáo
                </Label>
                <Input id={`pg-d-${img.id}`} value={ad} onChange={(e) => setAd(e.target.value)} />
                {defaults.problems.length ? (
                  <ul className="list-disc pl-4 text-[11px] text-warning">
                    {defaults.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
            <div className="space-y-1.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Xem trước</p>
              <AdPreview pageName={pageName} primaryText={t.trim()} headline={h.trim()} imageId={img.imageId} imageAvailable={img.imageAvailable} alt={h || `Ảnh #${img.seq}`} />
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">{loiTruoc ?? "Đưa vào lô ⇒ phiếu duyệt đã phát (nếu có) mất hiệu lực."}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                Huỷ
              </Button>
              <Button type="button" onClick={dua} disabled={saving || !!loiTruoc}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />} Đưa vào lô
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
