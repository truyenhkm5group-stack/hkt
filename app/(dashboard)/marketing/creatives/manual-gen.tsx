"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ImagePlus, Loader2, Rocket, Save, Send, Sparkles, Wand2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdPreview, GeneChips, VariantImage } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { promoteManualGenImageAction, publishManualGenImageNowAction, recaptionManualGenImage, reviewManualGenImageAction, saveManualGenDraftAction, startManualDesignRun, startManualGenRun, unqueueManualGenDraftAction } from "@/lib/actions/creative-manual-gen";
import {
  DESIGN_DNA_KEYS,
  DESIGN_DNA_VALUE_LABEL,
  MANUAL_DESIGN,
  MANUAL_GEN,
  MANUAL_GEN_IMAGE_STATUS_LABEL,
  MANUAL_GEN_KINDS,
  MANUAL_GEN_KIND_LABEL,
  MANUAL_GEN_RUN,
  type ManualGenImageStatus,
  type ManualGenKind,
} from "@/lib/constants/creative-loop";
import { formatVND, vnShortStamp } from "@/lib/format";
import { thuNhoAnh, type AnhDaThuNho } from "@/lib/ideas/shrink-image";
import type { DesignInspirationOption, ManualGenImageCard, ManualGenPanel, PixelSourceOption, PublishQueueItem } from "@/lib/queries/creative-manual-gen";
import { cn } from "@/lib/utils";
import { VARIANT_COPY_LIMITS, manualGenDraftSchema, manualGenInstantSchema, manualGenPromoteSchema } from "@/lib/validation/creative";

/**
 * GEN ẢNH BẰNG TAY (§5i) — phía trình duyệt: form "Gen ảnh" (số ảnh · ảnh tải lên · tiền ước tính), thẻ từng ảnh
 * (Duyệt / Loại · tiền thật), hộp soạn bài dùng cho CẢ "Đưa vào lô" lẫn "Đăng camp" (ngay / hẹn giờ), và bộ tự
 * tải lại khi còn ảnh đang vẽ. Mọi luật ở `lib/creative/manual-gen.ts`; màn hình chỉ nhân giá ước tính máy chủ
 * đưa với số ảnh người chọn để người thấy trước khi bấm — không tự tính tiền thật nào.
 */

const box = "h-8 w-full rounded-md border bg-background px-2 text-[12.5px] disabled:opacity-60";

type InstantInfo = ManualGenPanel["instant"];
type Upload = AnhDaThuNho & { ten: string };

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

/**
 * Khối "Gen ảnh bằng tay": hai kiểu, mặc định THIẾT KẾ MỚI (chủ shop 25/09/2026 — "mẫu mới hoàn toàn từ các
 * mẫu đã win / chỉ số tốt, không phải mockup mẫu cũ"). Kiểu "ảnh mới cho mẫu đang có" còn cho đề xuất đẩy tồn
 * (`?product=` mở thẳng kiểu ấy — xả hàng đang có cần ảnh của chính mẫu ấy).
 */
export function ManualGenForm({
  initialKind,
  inspirations,
  ...rest
}: {
  initialKind: ManualGenKind;
  inspirations: DesignInspirationOption[];
  sources: PixelSourceOption[];
  unitVnd: number | null;
  unitUsd: number;
  initialPhotoId?: string;
}) {
  const [kind, setKind] = useState<ManualGenKind>(initialKind);
  return (
    <div className="space-y-2.5">
      <div className="inline-flex rounded-md border p-0.5" role="tablist" aria-label="Kiểu gen">
        {MANUAL_GEN_KINDS.map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={kind === k}
            onClick={() => setKind(k)}
            className={cn("rounded px-2.5 py-1 text-[12px] font-medium", kind === k ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
          >
            {MANUAL_GEN_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {kind === "DESIGN" ? <DesignGenForm inspirations={inspirations} unitVnd={rest.unitVnd} unitUsd={rest.unitUsd} /> : <MockupGenForm {...rest} />}
    </div>
  );
}

/** Chi mỗi tin nhắn để HIỂN THỊ — chưa có chi / tin nhắn ⇒ CHƯA BIẾT (`—`), không phải 0 (mục 42). */
function costPerMessage(o: DesignInspirationOption): string {
  return o.spendVnd !== null && o.messages !== null && o.messages > 0 ? `${formatVND(Math.round(o.spendVnd / o.messages))}/tin` : "chi/tin —";
}

function describeDna(dna: Record<string, string>): string {
  return DESIGN_DNA_KEYS.filter((k) => dna[k] && !(dna[k] === "NONE" && (k === "neckline" || k === "sleeve")))
    .map((k) => (DESIGN_DNA_VALUE_LABEL[k] as Record<string, string>)[dna[k]] ?? dna[k])
    .join(" · ");
}

/** Số ảnh một lần bấm: thanh kéo + ô số, kẹp trong khoảng min…max (máy chủ kẹp lại lần nữa). */
function CountPicker({ id, value, onChange, disabled }: { id: string; value: number; onChange: (n: number) => void; disabled?: boolean }) {
  const { minImagesPerRun: min, maxImagesPerRun: max } = MANUAL_GEN_RUN;
  const set = (n: number) => onChange(Math.max(min, Math.min(max, Number.isFinite(n) ? Math.round(n) : MANUAL_GEN.imagesPerRun)));
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="shrink-0 text-[12px]">
        Số ảnh
      </Label>
      <input type="range" min={min} max={max} step={1} value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} className="min-w-0 flex-1 accent-primary" aria-label="Số ảnh (kéo)" />
      <Input id={id} type="number" min={min} max={max} step={1} value={value} disabled={disabled} onChange={(e) => set(Number(e.target.value))} className="h-8 w-16 text-center text-[12.5px]" />
      <span className="shrink-0 text-[11px] text-muted-foreground">
        ({min}–{max})
      </span>
    </div>
  );
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
function UploadPicker({ value, onChange, disabled }: { value: Upload[]; onChange: (v: Upload[]) => void; disabled?: boolean }) {
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
        Tuỳ chọn, tối đa {MANUAL_GEN_RUN.maxUploads} ảnh: dáng, bối cảnh, người mẫu, cách phối muốn máy bám theo — ghi trong ô ý tưởng cách dùng. Chỉ tải ảnh của shop / ảnh bạn có quyền dùng; máy vẽ luôn kèm ảnh sản phẩm thật của mã đã chọn.
      </p>
    </div>
  );
}

function DesignGenForm({ inspirations, unitVnd, unitUsd }: { inspirations: DesignInspirationOption[]; unitVnd: number | null; unitUsd: number }) {
  // Tích sẵn các mẫu điểm cao nhất CÓ ảnh sản phẩm thật — chỉ là giá trị khởi đầu, không kích lượt vẽ nào.
  const [picked, setPicked] = useState<string[]>(() =>
    inspirations
      .filter((o) => o.imageId)
      .slice(0, MANUAL_DESIGN.preselect)
      .map((o) => o.productId),
  );
  const [idea, setIdea] = useState("");
  const [count, setCount] = useState<number>(MANUAL_GEN.imagesPerRun);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [pending, start] = useTransition();
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MANUAL_DESIGN.maxInspirations ? cur : [...cur, id]));
  const coAnh = inspirations.some((o) => picked.includes(o.productId) && o.imageId);

  const gen = () =>
    start(async () => {
      const r = await startManualDesignRun({ inspirationProductIds: picked, idea, count, uploads: uploads.map((u) => u.base64) });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.note ? `Đang vẽ ${r.allowed} thiết kế mới. ${r.note}` : `Đang vẽ ${r.allowed} thiết kế mới — ảnh hiện dần ở "Kết quả gen tay".`);
      setIdea("");
      setUploads([]);
    });

  const khoa =
    inspirations.length === 0 ? "Chưa có mẫu nào đủ điều kiện làm cảm hứng." : picked.length === 0 ? "Chọn ít nhất một mẫu cảm hứng." : !coAnh ? "Cần ít nhất một mẫu có ảnh sản phẩm thật — máy vẽ chỉ nhận ảnh thật của shop làm tham chiếu." : null;

  return (
    <div className="grid gap-2.5 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label>Mẫu cảm hứng — đã bán tốt / chỉ số quảng cáo tốt</Label>
          <span className="numeric text-[11px] text-muted-foreground">
            đã chọn {picked.length}/{MANUAL_DESIGN.maxInspirations}
          </span>
        </div>
        {inspirations.length === 0 ? (
          <p className="rounded-md border border-dashed px-2.5 py-2 text-[12px] text-muted-foreground">
            Chưa có mẫu nào đủ điều kiện: cần mã bán tốt trong 90 ngày (đơn giao thành công hoặc chi mỗi tin nhắn tốt) VÀ đã đọc được DNA thiết kế — máy đọc DNA dần mỗi lượt dựng lô. Tạm thời dùng kiểu “{MANUAL_GEN_KIND_LABEL.MOCKUP}”.
          </p>
        ) : (
          <div className="grid max-h-[300px] grid-cols-1 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-2">
            {inspirations.map((o) => {
              const on = picked.includes(o.productId);
              return (
                <button
                  key={o.productId}
                  type="button"
                  disabled={pending}
                  onClick={() => toggle(o.productId)}
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
        <p className="text-[11px] text-muted-foreground">Mỗi ảnh là một THIẾT KẾ MỚI lai DNA của hai mẫu đã chọn + đột biến, bắt buộc khác mọi mẫu đang có. Máy vẽ nhận ảnh sản phẩm THẬT của mẫu cha (+ ảnh bạn tải lên) làm tham chiếu.</p>
        <UploadPicker value={uploads} onChange={setUploads} disabled={pending} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="md-idea">Ý tưởng / câu lệnh (tuỳ chọn)</Label>
          <span className="numeric text-[11px] text-muted-foreground">
            {idea.trim().length}/{MANUAL_GEN.ideaMaxChars}
          </span>
        </div>
        <Textarea id="md-idea" rows={4} value={idea} maxLength={MANUAL_GEN.ideaMaxChars} disabled={pending} onChange={(e) => setIdea(e.target.value)} placeholder="Ví dụ: chất thun rayon, đi biển mùa thu, nắng chiều, dáng đi tự nhiên…" />
        <p className="text-[11px] text-muted-foreground">Ý tưởng là chỉ thị ƯU TIÊN CAO NHẤT: đè bối cảnh / không khí / cách phối và cả thuộc tính thiết kế bạn nói ra (chất liệu, màu, độ dài…); phần không nhắc tới đi theo DNA máy lập.</p>
        <div className="mt-auto space-y-1.5">
          <CountPicker id="md-count" value={count} onChange={setCount} disabled={pending} />
          <EstimateLine count={count} unitVnd={unitVnd} unitUsd={unitUsd} uploads={uploads.length} />
          <div className="flex justify-end">
            <Button onClick={gen} disabled={pending || !!khoa} title={khoa ?? undefined}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} Gen {count} thiết kế mới
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function MockupGenForm({
  sources,
  unitVnd,
  unitUsd,
  initialPhotoId,
}: {
  sources: PixelSourceOption[];
  unitVnd: number | null;
  unitUsd: number;
  /** Ảnh chọn sẵn (vd `?product=` từ đề xuất đẩy tồn). Chỉ là giá trị khởi đầu — không kích lượt vẽ nào. */
  initialPhotoId?: string;
}) {
  const photos = sources.filter((s) => s.kind === "PRODUCT_PHOTO");
  const [photoId, setPhotoId] = useState(initialPhotoId && photos.some((s) => s.id === initialPhotoId) ? initialPhotoId : (photos[0]?.id ?? ""));
  const [ownAdId, setOwnAdId] = useState("");
  const [idea, setIdea] = useState("");
  const [count, setCount] = useState<number>(MANUAL_GEN.imagesPerRun);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [pending, start] = useTransition();
  const productOf = sources.find((s) => s.id === photoId)?.productId ?? "";
  const ownAds = sources.filter((s) => s.kind === "OWN_AD" && s.productId === productOf);

  const gen = () =>
    start(async () => {
      const r = await startManualGenRun({ productPhotoSourceId: photoId, ownAdSourceId: ownAdId, idea, count, uploads: uploads.map((u) => u.base64) });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đang vẽ ${r.requested} ảnh — ảnh hiện dần ở "Kết quả gen tay".`);
      setIdea("");
      setUploads([]);
    });

  const khoa = photos.length === 0 ? "Chưa có ảnh sản phẩm thật nào — nhập ở tab Nguồn ảnh trước." : null;

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
        <Label className="pt-1">Ảnh đầu vào thêm (tải lên)</Label>
        <UploadPicker value={uploads} onChange={setUploads} disabled={pending} />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label htmlFor="mg-idea">Ý tưởng / câu lệnh (tuỳ chọn)</Label>
          <span className="numeric text-[11px] text-muted-foreground">
            {idea.trim().length}/{MANUAL_GEN.ideaMaxChars}
          </span>
        </div>
        <Textarea id="mg-idea" rows={4} value={idea} maxLength={MANUAL_GEN.ideaMaxChars} disabled={pending} onChange={(e) => setIdea(e.target.value)} placeholder="Ví dụ: mặc đi biển Đà Nẵng buổi chiều, ánh nắng vàng, dáng đi tự nhiên…" />
        <p className="text-[11px] text-muted-foreground">Ý tưởng là chỉ thị ƯU TIÊN CAO NHẤT (bối cảnh, dáng, người mẫu, ánh sáng, cách phối) — chỉ trừ chính sản phẩm: máy luôn giữ đúng món hàng trong ảnh thật.</p>
        <div className="mt-auto space-y-1.5">
          <CountPicker id="mg-count" value={count} onChange={setCount} disabled={pending} />
          <EstimateLine count={count} unitVnd={unitVnd} unitUsd={unitUsd} uploads={uploads.length} />
          <div className="flex justify-end">
            <Button onClick={gen} disabled={pending || !!khoa || !photoId} title={khoa ?? undefined}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />} Gen {count} ảnh
            </Button>
          </div>
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

type Defaults = { campaign: string; adset: string; ad: string; problems: string[] };

export function ManualGenImageTile({
  img,
  canEdit,
  canPublish,
  instant,
  pageName,
  defaults,
  campDefaults,
  predictedSeq,
  targetDay,
}: {
  img: ManualGenImageCard;
  canEdit: boolean;
  canPublish: boolean;
  instant: InstantInfo;
  pageName: string | null;
  defaults: Defaults;
  campDefaults: Defaults;
  predictedSeq: number;
  targetDay: string;
}) {
  const [pending, start] = useTransition();
  const review = (decision: "APPROVE" | "REJECT") =>
    start(async () => {
      const r = await reviewManualGenImageAction({ imageId: img.id, decision, reason: "" });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      if (r.status === "APPROVED") toast.success(r.captionError ? `Đã duyệt — AI chưa viết được câu chữ (${r.captionError}). Gõ tay trong hộp soạn bài.` : "Đã duyệt — AI đã viết câu chữ theo ảnh.");
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
          <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={`Ảnh gen tay #${img.seq}`} className="aspect-[4/5] w-full" />
        )}
        <span className="absolute left-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-bold">#{img.seq}</span>
        <span className={cn("absolute right-1.5 top-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold", TONE[img.status] ?? "bg-background/90")}>{MANUAL_GEN_IMAGE_STATUS_LABEL[img.status]}</span>
        {daVe ? (
          <span className="numeric absolute bottom-1.5 right-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10.5px] font-semibold" title={img.costUsd ? `${Number(img.costUsd).toFixed(4)} USD — tiền thật máy vẽ báo về` : "Máy vẽ không trả giá cho ảnh này — CHƯA BIẾT"}>
            {formatVND(img.costVnd)}
          </span>
        ) : null}
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
        <GeneChips genes={img.genes} className="gap-0.5" />
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
        {img.status === "PROMOTED" ? <p className="text-[11px] text-muted-foreground">Đã vào lô / đã đăng camp — xem ở khối lô chờ duyệt hoặc Lịch sử lô.</p> : null}
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
            {img.status === "APPROVED" ? <ComposeButton img={img} canPublish={canPublish} pageName={pageName} defaults={defaults} campDefaults={campDefaults} predictedSeq={predictedSeq} targetDay={targetDay} instant={instant} /> : null}
          </div>
        ) : null}
      </div>
    </div>
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

type ComposeProps = { img: ManualGenImageCard; canPublish: boolean; pageName: string | null; defaults: Defaults; campDefaults: Defaults; predictedSeq: number; targetDay: string; instant: InstantInfo; triggerLabel?: string; triggerClassName?: string };

/**
 * Ba tên ĐIỀN SẴN của hộp soạn bài (chủ shop 26/09/2026: "điền sẵn để sẵn sàng đăng ngay, tôi có thể sửa"): tên đã lưu
 * nếu có; không thì tên theo khuôn của "Đăng camp" (ngày chạy hôm nay) — hoặc của lô, với người không được đăng camp.
 */
function prefillNames(img: ManualGenImageCard, canPublish: boolean, defaults: Defaults, campDefaults: Defaults): { campaign: string; adset: string; ad: string } {
  const d = canPublish ? campDefaults : defaults;
  return { campaign: img.campaignName || d.campaign, adset: img.adsetName || d.adset, ad: img.adName || d.ad };
}

/**
 * Ô tên người KHÔNG sửa (còn đúng chữ điền sẵn theo khuôn) ⇒ gửi rỗng ⇒ đường ghi tự đặt theo khuôn với số thứ tự THẬT
 * của đúng nơi đến (ngày chạy của camp, hay lô) lúc bấm. Gửi nguyên chữ điền sẵn thì hai bài bấm gần nhau mang cùng số,
 * và bấm "Đưa vào lô" sẽ mang ngày của camp. Ô người đã sửa ⇒ đúng chữ người gõ. Tên ĐÃ LƯU thì luôn gửi nguyên.
 */
function namesToSend(cur: { campaign: string; adset: string; ad: string }, img: ManualGenImageCard, auto: { campaign: string; adset: string; ad: string }) {
  const one = (k: "campaign" | "adset" | "ad", saved: string) => (saved === "" && cur[k].trim() === auto[k].trim() ? "" : cur[k]);
  return { campaignName: one("campaign", img.campaignName), adsetName: one("adset", img.adsetName), adName: one("ad", img.adName) };
}

/**
 * HỘP SOẠN BÀI của một ảnh đã duyệt — MỘT hộp, BA lối ra dùng chung câu chữ + ba tên (chủ shop 26/09/2026: "duyệt ảnh
 * mẫu → sửa content và lưu vào hàng đợi đăng camp, có thể ấn lưu sau đó ấn đăng camp luôn"):
 *  · "Lưu vào hàng đợi"  ghi bản nháp lên ảnh + đặt vào HÀNG ĐỢI ĐĂNG CAMP. Hộp VẪN MỞ — bấm Đăng camp ngay sau đó được.
 *  · "Đưa vào lô"        vào lô hằng ngày chờ duyệt cả lô.
 *  · "Đăng camp"         lên Facebook NGAY lúc bấm — chạy ngay, hoặc hẹn giờ (Facebook tự giữ lịch). Người bấm là lượt
 *                        duyệt chi, nên hộp in đủ tiền sẽ cam kết, khung chạy và mọi lý do cổng sẽ chặn TRƯỚC khi bấm.
 * Ba ô tên để trống = tên theo khuôn lúc đăng / vào lô (số thứ tự lấy đúng ngày đích), nên hộp không điền sẵn một cái
 * tên mang ngày của lô khác.
 */
function ComposeButton({ img, canPublish, pageName, defaults, campDefaults, predictedSeq, targetDay, instant, triggerLabel, triggerClassName }: ComposeProps) {
  const auto = prefillNames(img, canPublish, defaults, campDefaults);
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(img.headline);
  const [t, setT] = useState(img.primaryText);
  const [campName, setCampName] = useState(auto.campaign);
  const [adset, setAdset] = useState(auto.adset);
  const [ad, setAd] = useState(auto.ad);
  const [hen, setHen] = useState(false);
  const [henLuc, setHenLuc] = useState("");
  const [daLuu, setDaLuu] = useState<string | null>(null);
  const [writing, startWrite] = useTransition();
  const [saving, startSave] = useTransition();

  const mo = () => {
    setH(img.headline);
    setT(img.primaryText);
    setCampName(auto.campaign);
    setAdset(auto.adset);
    setAd(auto.ad);
    setHen(false);
    setHenLuc(vnLocalInput(new Date(Date.now() + 60 * 60_000)));
    setDaLuu(null);
    setOpen(true);
  };
  const autoKey = `${auto.campaign}|${auto.adset}|${auto.ad}`;
  const noiDung = useMemo(
    () => ({ imageId: img.id, headline: h, primaryText: t, ...namesToSend({ campaign: campName, adset, ad }, img, { campaign: autoKey.split("|")[0], adset: autoKey.split("|")[1], ad: autoKey.split("|")[2] }) }),
    [img, h, t, campName, adset, ad, autoKey],
  );
  const chuKy = JSON.stringify(noiDung);
  const scheduleAt = hen ? vnInputToIso(henLuc) : null;
  const loiLuu = useMemo(() => {
    const r = manualGenDraftSchema.safeParse(noiDung);
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [noiDung]);
  const loiLo = useMemo(() => {
    const r = manualGenPromoteSchema.safeParse({ ...noiDung, predictedSeq });
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [noiDung, predictedSeq]);
  const loiDang = useMemo(() => {
    if (hen && !scheduleAt) return "Chọn giờ hẹn.";
    const r = manualGenInstantSchema.safeParse({ ...noiDung, predictedSeq: null, scheduleAt });
    return r.success ? null : (r.error.issues[0]?.message ?? "Chưa hợp lệ");
  }, [noiDung, hen, scheduleAt]);
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
      const r = await saveManualGenDraftAction(noiDung);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setDaLuu(chuKy);
      toast.success(canPublish ? "Đã lưu vào hàng đợi đăng camp — bấm Đăng camp ngay bây giờ hoặc lúc khác ở khối Hàng đợi." : "Đã lưu vào hàng đợi đăng camp.");
    });

  const dang = () =>
    startSave(async () => {
      const r = await publishManualGenImageNowAction({ ...noiDung, predictedSeq: null, scheduleAt });
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

  const dua = () =>
    startSave(async () => {
      const r = await promoteManualGenImageAction({ ...noiDung, predictedSeq });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(
        r.designCode
          ? `Đã đưa vào lô ${r.batchDay} (ô #${r.slot}) với mã thiết kế ${r.designCode} — tạo sản phẩm Pancake đúng mã này để nhận đơn; lô cần được bấm duyệt (lại).`
          : `Đã đưa vào lô ${r.batchDay} (ô #${r.slot}) — lô cần được bấm duyệt (lại).`,
      );
      for (const w of r.warnings) toast.warning(w);
      setOpen(false);
    });

  const startPreview = hen ? (scheduleAt ? new Date(scheduleAt) : null) : new Date(Date.now() + instant.leadSeconds * 1000);
  const endPreview = startPreview ? new Date(startPreview.getTime() + instant.testDays * 86_400_000) : null;
  const luuMoiNhat = daLuu === chuKy;

  return (
    <>
      <Button size="sm" className={cn("h-7 w-full text-[12px]", triggerClassName)} onClick={mo}>
        {canPublish ? <Rocket className="size-3.5" /> : <Send className="size-3.5" />} {triggerLabel ?? (canPublish ? "Soạn bài · Đăng camp" : "Soạn bài")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>
              Soạn bài {img.design ? "thiết kế mới" : "ảnh"} #{img.seq}
              {img.queuedAt ? <span className="ml-2 rounded bg-brand/10 px-1.5 py-0.5 align-middle text-[11px] font-medium text-brand">Đang ở hàng đợi</span> : null}
            </DialogTitle>
            <DialogDescription>
              {img.design ? "Máy cấp mã thiết kế TK-… lúc đăng / vào lô (xem ở tab Thiết kế mới; đơn, chấm, MOQ đi theo mã ấy). " : ""}
              Sửa câu chữ rồi <b>Lưu vào hàng đợi</b> để đăng sau, hoặc <b>Đăng camp</b> ngay. Ba tên đã điền sẵn theo khuôn — sửa nếu cần.
            </DialogDescription>
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
                <Input id={`pg-c-${img.id}`} value={campName} onChange={(e) => setCampName(e.target.value)} placeholder="để trống = theo khuôn" />
                <Label htmlFor={`pg-a-${img.id}`} className="text-[11.5px]">
                  Nhóm quảng cáo
                </Label>
                <Input id={`pg-a-${img.id}`} value={adset} onChange={(e) => setAdset(e.target.value)} placeholder={defaults.adset ? "để trống = theo khuôn" : "(chưa đọc được nhóm mẫu — để trống = tên mặc định)"} />
                <Label htmlFor={`pg-d-${img.id}`} className="text-[11.5px]">
                  Quảng cáo
                </Label>
                <Input id={`pg-d-${img.id}`} value={ad} onChange={(e) => setAd(e.target.value)} placeholder="để trống = theo khuôn" />
                <p className="text-[11px] text-muted-foreground">Tên điền sẵn theo khuôn{canPublish ? " cho camp chạy hôm nay" : ""} — giữ nguyên thì máy cấp đúng số thứ tự lúc bấm; sửa thì dùng đúng chữ bạn gõ.</p>
                {defaults.problems.length ? (
                  <ul className="list-disc pl-4 text-[11px] text-warning">
                    {defaults.problems.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              {canPublish ? (
                <div className="space-y-1.5 rounded-lg border border-brand/40 bg-brand/5 p-2.5">
                  <p className="text-[12.5px] font-semibold">Đăng camp — thời điểm chạy</p>
                  <div className="flex flex-wrap gap-3 text-[12.5px]">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`hen-${img.id}`} checked={!hen} onChange={() => setHen(false)} /> Chạy ngay
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`hen-${img.id}`} checked={hen} onChange={() => setHen(true)} /> Hẹn giờ (giờ Việt Nam)
                    </label>
                    {hen ? <Input type="datetime-local" value={henLuc} onChange={(e) => setHenLuc(e.target.value)} className="h-8 w-auto text-[12.5px]" /> : null}
                  </div>
                  <p className="text-[11.5px] text-muted-foreground">
                    Ngân sách trọn đời <b className="numeric text-foreground">{formatVND(instant.budgetVnd)}</b> · chạy {instant.testDays} ngày
                    {startPreview && endPreview ? (
                      <>
                        {" "}
                        · từ <b className="text-foreground">{vnShortStamp(startPreview)}</b> tới {vnShortStamp(endPreview)} — Facebook tự dừng ở giờ kết thúc
                      </>
                    ) : null}
                    .{" "}
                    {hen
                      ? `Hẹn giờ vẫn đăng lên Facebook NGAY lúc bấm (camp ở trạng thái lên lịch), tối thiểu sau ${instant.minScheduleLeadMinutes} phút, tối đa ${instant.maxScheduleDays} ngày.`
                      : `"Chạy ngay" = bắt đầu sau khoảng ${Math.round(instant.leadSeconds / 60)} phút (đủ để máy tạo xong chiến dịch).`}
                  </p>
                  {chan ? (
                    <ul className="list-disc pl-4 text-[11.5px] text-destructive">
                      {instant.blockers.map((b) => (
                        <li key={b}>{b}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
            <div className="space-y-1.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Xem trước</p>
              <AdPreview pageName={pageName} primaryText={t.trim()} headline={h.trim()} imageId={img.imageId} imageAvailable={img.imageAvailable} alt={h || `Ảnh #${img.seq}`} />
            </div>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">
              {luuMoiNhat ? <span className="text-success">✓ Đã lưu vào hàng đợi.</span> : null} {loiDang ?? (canPublish ? (chan ? "Cổng ghi đang chặn Đăng camp — xem lý do ở trên." : `Đăng camp = cam kết tối đa ${formatVND(instant.budgetVnd)}.`) : "")}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Đóng
              </Button>
              <Button type="button" variant="secondary" onClick={luu} disabled={saving || !!loiLuu || luuMoiNhat} title={loiLuu ?? "Lưu câu chữ + tên vào hàng đợi đăng camp — chưa đăng, chưa tốn đồng nào"}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {luuMoiNhat ? "Đã lưu" : "Lưu vào hàng đợi"}
              </Button>
              <Button type="button" variant="outline" onClick={dua} disabled={saving || !!loiLo} title={loiLo ?? `Vào lô hằng ngày gần nhất còn nhận mẫu (dự kiến ${targetDay}), chờ duyệt cả lô`}>
                <Send className="size-4" /> Đưa vào lô
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

/**
 * HÀNG ĐỢI ĐĂNG CAMP — các bài đã soạn và bấm "Lưu", mới lưu trước. Không lọc theo ngày đang xem: đây là việc phải
 * làm. Mỗi dòng mở lại ĐÚNG hộp soạn bài (sửa tiếp · đăng camp · đưa vào lô); đăng xong bài tự rời hàng đợi.
 */
export function PublishQueue({ items, canEdit, canPublish, instant, pageName, defaults, campDefaults, predictedSeq, targetDay }: { items: PublishQueueItem[]; canEdit: boolean; canPublish: boolean; instant: InstantInfo; pageName: string | null; defaults: Defaults; campDefaults: Defaults; predictedSeq: number; targetDay: string }) {
  const [pending, start] = useTransition();
  const bo = (imageId: string) =>
    start(async () => {
      const r = await unqueueManualGenDraftAction({ imageId });
      if ("error" in r) toast.error(r.error);
      else toast.success("Đã bỏ khỏi hàng đợi — bản nháp câu chữ vẫn giữ trên ảnh.");
    });
  if (items.length === 0) return null;
  return (
    <div className="space-y-1.5 rounded-lg border border-brand/40 bg-brand/5 p-2.5">
      <p className="text-[12.5px] font-semibold">
        Hàng đợi đăng camp <span className="numeric font-normal text-muted-foreground">({items.length} bài, mới lưu trước)</span>
      </p>
      <div className="divide-y rounded-md border bg-card">
        {items.map(({ img, runLabel }) => (
          <div key={img.id} className="flex flex-wrap items-center gap-2.5 p-2">
            <VariantImage imageId={img.imageId} available={img.imageAvailable} alt={img.headline || `Ảnh #${img.seq}`} className="size-14 shrink-0 rounded" iconClassName="size-4" />
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="truncate text-[12.5px] font-semibold">{img.headline || <span className="italic text-muted-foreground">(chưa có tiêu đề)</span>}</p>
              <p className="line-clamp-1 text-[11.5px] text-muted-foreground">{img.primaryText || "(chưa có nội dung chính)"}</p>
              <p className="truncate text-[10.5px] text-muted-foreground">
                {runLabel} #{img.seq} · chiến dịch: {img.campaignName || "theo khuôn lúc đăng"} · lưu bởi {img.queuedByName || "—"} {img.queuedAt ? vnShortStamp(img.queuedAt) : ""}
              </p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center gap-1">
                <ComposeButton img={img} canPublish={canPublish} pageName={pageName} defaults={defaults} campDefaults={campDefaults} predictedSeq={predictedSeq} targetDay={targetDay} instant={instant} triggerLabel={canPublish ? "Mở · Đăng camp" : "Mở bài"} triggerClassName="w-auto" />
                <Button size="sm" variant="ghost" className="h-7 text-[12px]" disabled={pending} onClick={() => bo(img.id)} title="Bỏ khỏi hàng đợi">
                  <X className="size-3.5" />
                </Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
