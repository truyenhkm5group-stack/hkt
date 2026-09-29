"use client";

import { Check, Clapperboard, Film, Loader2, Palette } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { useNavTransition } from "@/components/nav-progress";
import { toast } from "sonner";
import { InfoHint } from "@/components/info-hint";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { createVideoRunAction, loadVideoColorsAction, loadVideoPhotosAction } from "@/lib/actions/video-scale";
import { VIDEO_ANGLES, VIDEO_ANGLE_LABEL, VIDEO_SCALE_HARD_LIMITS, type VideoAngle } from "@/lib/constants/video-scale";
import { SHOWCASE, showcaseSeconds } from "@/lib/constants/video-scale-colors";
import type { SourcePhoto } from "@/lib/queries/video-scale";
import type { ColorOption } from "@/lib/video-scale/colors";
import { cn } from "@/lib/utils";
import { IdeaPresets } from "@/app/(dashboard)/marketing/creatives/idea-presets";

type Concept = "SHOWCASE" | "CLIPS";

function Field({ label, hint, right, children }: { label: string; hint?: ReactNode; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 text-[12.5px] font-medium">
          {label}
          {hint ? <InfoHint label={`Giải thích: ${label}`}>{hint}</InfoHint> : null}
        </p>
        {right}
      </div>
      {children}
    </div>
  );
}

/**
 * "Tạo chiến dịch media" (gọn lại 29/09/2026). Hai kiểu video:
 *   · CLIP + BẢNG MÀU (mặc định khi mã có ≥ 2 màu có ảnh): cảnh clip mở đầu → mỗi màu của mã một ảnh thật từ Pancake, chữ
 *     "Màu …" → CTA. Đoạn bảng màu dựng bằng ffmpeg, 0 đồng.
 *   · CHỈ CLIP: như trước.
 * Ảnh mở đầu = ảnh sản phẩm THẬT người chọn (máy chỉ gửi đúng các ảnh này sang máy sinh video). Bấm là xếp việc: màn hình trả
 * lời ngay, video sinh sau.
 */
export function CreateRunDialog({
  productId,
  label,
  music,
  perVideoUsd = null,
  costNote = "",
  introSeconds = null,
}: {
  productId: string;
  label: string;
  music: { id: string; title: string; assetId?: string }[];
  perVideoUsd?: number | null;
  costNote?: string;
  /** Độ dài đoạn mở đầu theo cấu hình (số cảnh × giây / cảnh) — chỉ để ước tính độ dài video. */
  introSeconds?: number | null;
}) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<SourcePhoto[] | null>(null);
  const [colors, setColors] = useState<ColorOption[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [concept, setConcept] = useState<Concept>("SHOWCASE");
  const [pickedColors, setPickedColors] = useState<string[]>([]);
  const [variants, setVariants] = useState(3);
  const [angles, setAngles] = useState<VideoAngle[]>([]);
  const [brief, setBrief] = useState("");
  const [musicId, setMusicId] = useState("");
  const [loading, startLoad] = useNavTransition();
  const [pending, start] = useNavTransition();

  const onOpen = (v: boolean) => {
    setOpen(v);
    if (v && photos === null)
      startLoad(async () => {
        const [r, c] = await Promise.all([loadVideoPhotosAction({ id: productId }), loadVideoColorsAction({ id: productId })]);
        if ("error" in r) return void toast.error(r.error);
        setPhotos(r.photos);
        setPicked(r.photos.slice(0, 1).map((p) => p.id));
        const withImg = "error" in c ? [] : c.colors.filter((x) => x.imageUrl || x.imageId);
        setColors("error" in c ? [] : c.colors);
        setPickedColors(withImg.slice(0, SHOWCASE.maxColors).map((x) => x.color));
        // Mã một màu (hoặc chưa có ảnh màu) ⇒ bảng màu vô nghĩa, mặc định chỉ clip.
        setConcept(withImg.length >= 2 ? "SHOWCASE" : "CLIPS");
      });
  };

  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);
  const colorsWithImg = (colors ?? []).filter((x) => x.imageUrl || x.imageId);
  const showColors = concept === "SHOWCASE" ? pickedColors : [];
  const lengthSec = introSeconds === null ? null : Math.round(introSeconds + showcaseSeconds(showColors.length));

  const router = useRouter();
  const submit = () =>
    start(async () => {
      const r = await createVideoRunAction({ productId, sourceIds: picked, variants, angles, brief, musicId, showcaseColors: showColors });
      if ("error" in r) return void toast.error(r.error);
      toast.success(`Đã xếp lượt — máy đang viết kịch bản.${r.showcaseFailed.length ? ` Bỏ ${r.showcaseFailed.length} màu không lấy được ảnh: ${r.showcaseFailed.join("; ")}.` : ""}`);
      setOpen(false);
      router.push("?tab=hang-doi");
    });

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Clapperboard className="size-4" aria-hidden /> Tạo video
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Tạo video — {label}</DialogTitle>
        </DialogHeader>
        {loading || photos === null ? (
          <Loader2 className="size-5 animate-spin" aria-label="Đang tải" />
        ) : (
          <div className="grid gap-4 text-[13px] md:grid-cols-2">
            <div className="space-y-4">
              <Field label="Kiểu video">
                <div className="grid grid-cols-2 gap-2">
                  {(
                    [
                      { k: "SHOWCASE" as const, icon: Palette, t: "Clip + bảng màu", d: "Clip mở đầu, sau đó từng màu của mã (ảnh thật)" },
                      { k: "CLIPS" as const, icon: Film, t: "Chỉ clip", d: "Toàn bộ là cảnh clip" },
                    ] as const
                  ).map((o) => (
                    <button
                      key={o.k}
                      type="button"
                      aria-pressed={concept === o.k}
                      disabled={o.k === "SHOWCASE" && colorsWithImg.length === 0}
                      onClick={() => setConcept(o.k)}
                      className={cn("rounded-md border p-2 text-left disabled:opacity-50", concept === o.k ? "border-primary bg-primary/5 ring-1 ring-primary" : "hover:bg-muted/50")}
                    >
                      <span className="flex items-center gap-1.5 font-medium">
                        <o.icon className="size-4" aria-hidden /> {o.t}
                      </span>
                      <span className="block text-[11.5px] text-muted-foreground">{o.k === "SHOWCASE" && colorsWithImg.length === 0 ? "Mã chưa có ảnh theo màu" : o.d}</span>
                    </button>
                  ))}
                </div>
              </Field>

              <Field
                label={`Ảnh mở đầu (${picked.length}/6)`}
                hint="Ảnh sản phẩm THẬT làm khung đầu cho cảnh clip. Nhiều ảnh ⇒ mỗi cảnh một ảnh khác (không lặp khung). Máy chỉ gửi đúng các ảnh này sang máy sinh video."
                right={
                  photos.length > 1 ? (
                    <button type="button" className="text-[12px] text-primary hover:underline" onClick={() => setPicked(picked.length ? [] : photos.slice(0, 6).map((p) => p.id))}>
                      {picked.length ? "Bỏ chọn" : "Chọn nhanh"}
                    </button>
                  ) : null
                }
              >
                {photos.length === 0 ? (
                  <p className="text-muted-foreground">Mã chưa có ảnh sản phẩm thật đang bật.</p>
                ) : (
                  <div className="grid grid-cols-5 gap-1.5">
                    {photos.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setPicked((x) => toggle(x, p.id).slice(0, 6))}
                        className={cn("relative overflow-hidden rounded border-2", picked.includes(p.id) ? "border-primary" : "border-transparent opacity-60 hover:opacity-100")}
                        aria-pressed={picked.includes(p.id)}
                        title={p.title}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền */}
                        <img src={`/api/creative/images/${p.imageId}`} alt={p.title || "Ảnh sản phẩm"} className="aspect-[4/5] w-full object-cover" loading="lazy" />
                        {picked.includes(p.id) ? <Check className="absolute right-0.5 top-0.5 size-4 rounded-full bg-primary p-0.5 text-primary-foreground" /> : null}
                      </button>
                    ))}
                  </div>
                )}
              </Field>

              {concept === "SHOWCASE" ? (
                <Field
                  label={`Bảng màu (${pickedColors.length}/${Math.min(SHOWCASE.maxColors, colorsWithImg.length)})`}
                  hint={`Mỗi màu một ảnh mẫu mã THẬT trên Pancake, hiện ${SHOWCASE.secondsPerColor} giây kèm chữ "Màu …" (tên màu trong ERP), theo thứ tự bạn chọn. Không gọi máy sinh video — 0 đồng. QC hình ảnh chỉ kiểm đoạn clip mở đầu.`}
                >
                  <div className="flex flex-wrap gap-1.5">
                    {(colors ?? []).map((c) => {
                      const on = pickedColors.includes(c.color);
                      const src = c.imageId ? `/api/creative/images/${c.imageId}` : c.imageUrl;
                      const can = Boolean(src);
                      return (
                        <button
                          key={c.color}
                          type="button"
                          disabled={!can || (!on && pickedColors.length >= SHOWCASE.maxColors)}
                          aria-pressed={on}
                          onClick={() => setPickedColors((x) => toggle(x, c.color))}
                          title={can ? `${c.variants} mẫu mã` : "Màu này chưa có ảnh mẫu mã trên Pancake"}
                          className={cn("flex w-16 flex-col items-center gap-0.5 rounded-md border-2 p-0.5 text-[11px] disabled:opacity-40", on ? "border-primary" : "border-transparent hover:border-muted-foreground/40")}
                        >
                          {src ? (
                            // eslint-disable-next-line @next/next/no-img-element -- ảnh mẫu mã (CSDL hoặc Pancake)
                            <img src={src} alt={c.color} className="aspect-[4/5] w-full rounded object-cover" loading="lazy" />
                          ) : (
                            <span className="flex aspect-[4/5] w-full items-center justify-center rounded bg-muted text-[10px]">không ảnh</span>
                          )}
                          <span className="w-full truncate text-center">{c.color}</span>
                        </button>
                      );
                    })}
                  </div>
                </Field>
              ) : null}
            </div>

            <div className="space-y-4">
              <Field label="Số video" hint="Mỗi video một góc bán khác nhau. Rẻ hơn: tạo ít video rồi dùng “Nhân bản” ở bước Duyệt để ra thêm biến thể từ cùng clip.">
                <div className="flex items-center gap-2">
                  <Button type="button" size="icon" variant="outline" className="size-8" disabled={variants <= 1} onClick={() => setVariants((n) => Math.max(1, n - 1))} aria-label="Bớt một video">
                    −
                  </Button>
                  <input type="number" min={1} max={VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun} value={variants} onChange={(e) => setVariants(Math.max(1, Math.min(VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun, Number(e.target.value) || 1)))} className="h-8 w-14 rounded-md border border-input bg-background px-2 text-center" aria-label="Số video" />
                  <Button type="button" size="icon" variant="outline" className="size-8" disabled={variants >= VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun} onClick={() => setVariants((n) => Math.min(VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun, n + 1))} aria-label="Thêm một video">
                    +
                  </Button>
                </div>
              </Field>
              <Field label="Góc bán" hint="Bỏ trống = máy chọn theo kết quả đã học.">
                <div className="flex flex-wrap gap-1">
                  {VIDEO_ANGLES.map((a) => (
                    <button key={a} type="button" onClick={() => setAngles((x) => toggle(x, a))} className={cn("rounded-full border px-2 py-0.5 text-[12px]", angles.includes(a) ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted")} aria-pressed={angles.includes(a)}>
                      {VIDEO_ANGLE_LABEL[a]}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Ý tưởng" right={<span className="text-[11px] tabular-nums text-muted-foreground">{brief.length}/600</span>}>
                <IdeaPresets idea={brief} onChange={setBrief} maxChars={600} design={false} disabled={pending} />
                <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={600} rows={2} placeholder="Tuỳ chọn — vd: nhấn mạnh dáng che bắp tay, bối cảnh công sở" aria-label="Ý tưởng video" />
              </Field>
              <Field label="Nhạc nền" hint={music.length === 0 ? "Thư viện nhạc có quyền đang trống — thêm ở tab Cấu hình." : undefined}>
                <select value={musicId} onChange={(e) => setMusicId(e.target.value)} className="h-8 w-full rounded-md border border-input bg-background px-2 text-foreground">
                  <option value="">Không nhạc (âm gốc của clip)</option>
                  {music.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.title}
                    </option>
                  ))}
                </select>
                {music.find((m) => m.id === musicId)?.assetId ? <audio key={musicId} controls src={`/api/video-scale/assets/${music.find((m) => m.id === musicId)?.assetId}`} className="h-8 w-full" aria-label="Nghe thử nhạc" /> : null}
              </Field>
            </div>
          </div>
        )}
        <DialogFooter className="items-center gap-2 border-t pt-3 sm:justify-between">
          <p className="text-[12.5px]">
            <b className="tabular-nums">{perVideoUsd === null ? "chưa có giá" : perVideoUsd === 0 ? "0 USD" : `≈ ${(perVideoUsd * variants).toFixed(2)} USD`}</b>
            <span className="text-muted-foreground">
              {" "}
              · {variants} video{lengthSec !== null ? ` · ~${lengthSec} giây/video` : ""}
              {showColors.length ? ` · ${showColors.length} màu` : ""}
            </span>
            {costNote ? <InfoHint label="Chi phí">{`${costNote} Giá là mức GIỮ CHỖ tối đa theo bảng giá công bố; đoạn bảng màu 0 đồng.`}</InfoHint> : null}
          </p>
          <Button onClick={submit} disabled={pending || picked.length === 0 || (concept === "SHOWCASE" && pickedColors.length === 0)}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Clapperboard className="size-4" aria-hidden />} Tạo {variants} video
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
