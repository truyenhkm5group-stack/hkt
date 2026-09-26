"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, PenLine, Save, ShieldAlert, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AdPreview } from "@/app/(dashboard)/marketing/creatives/variant-bits";
import { saveVariantCopy, suggestVariantCopy } from "@/lib/actions/creative-copy";
import { cn } from "@/lib/utils";
import { VARIANT_COPY_LIMITS, variantCopyInputSchema } from "@/lib/validation/creative";

/**
 * SOẠN CÂU CHỮ của một mẫu trước khi duyệt lô: sửa tay, hoặc xin AI 2–3 phương án viết THEO ẢNH rồi
 * chọn. Không phương án nào tự được lưu — người bấm Lưu. Khung bên phải là bài quảng cáo xem trước,
 * đổi theo từng chữ đang gõ.
 *
 * Lưu câu chữ làm digest của phiếu duyệt đổi ⇒ phiếu đã phát cho lô mất hiệu lực — màn hình nói ra.
 */
export function EditCopyButton({
  variantId,
  slot,
  headline,
  primaryText,
  pageName,
  imageId,
  imageAvailable,
}: {
  variantId: string;
  slot: number;
  headline: string;
  primaryText: string;
  pageName: string | null;
  imageId: string | null;
  imageAvailable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [h, setH] = useState(headline);
  const [t, setT] = useState(primaryText);
  const [options, setOptions] = useState<{ headline: string; primaryText: string }[]>([]);
  const [seen, setSeen] = useState("");
  const [suggesting, startSuggest] = useTransition();
  const [saving, startSave] = useTransition();

  const mo = () => {
    setH(headline);
    setT(primaryText);
    setOptions([]);
    setSeen("");
    setOpen(true);
  };

  const input = useMemo(() => ({ variantId, headline: h, primaryText: t }), [variantId, h, t]);
  // Báo trước khi bấm bằng ĐÚNG lược đồ máy chủ dùng.
  const loiTruoc = useMemo(() => {
    const r = variantCopyInputSchema.safeParse(input);
    return r.success ? null : (r.error.issues[0]?.message ?? "Câu chữ chưa hợp lệ");
  }, [input]);
  const doi = h.trim() !== headline.trim() || t.trim() !== primaryText.trim();

  const goiY = () =>
    startSuggest(async () => {
      const r = await suggestVariantCopy({ variantId });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setOptions(r.options);
      setSeen(r.seen);
      if (r.priceStripped) toast.warning("AI ghi giá khác giá ERP hai lần — con số giá đã bị bỏ khỏi phương án.");
    });

  const luu = () =>
    startSave(async () => {
      const r = await saveVariantCopy(input);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.changed ? `Đã lưu câu chữ mẫu #${slot} — lô cần được bấm duyệt lại.` : "Câu chữ không đổi.");
      for (const w of r.warnings) toast.warning(w);
      setOpen(false);
    });

  return (
    <>
      <Button variant="outline" size="sm" className="h-7 w-full text-[12px]" onClick={mo}>
        <PenLine className="size-3.5" /> Soạn câu chữ
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Soạn câu chữ mẫu #{slot}</DialogTitle>
            <DialogDescription>Sửa tay, hoặc để AI đọc ảnh và gợi ý. Bên phải là bài quảng cáo đúng như sẽ lên Facebook.</DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 md:grid-cols-[1fr_300px]">
            <div className="space-y-3">
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`cc-h-${variantId}`}>Tiêu đề</Label>
                  <span className={cn("numeric text-[11px] text-muted-foreground", h.trim().length > VARIANT_COPY_LIMITS.headlineMaxChars && "text-destructive")}>
                    {h.trim().length}/{VARIANT_COPY_LIMITS.headlineMaxChars}
                  </span>
                </div>
                <Input id={`cc-h-${variantId}`} value={h} onChange={(e) => setH(e.target.value)} maxLength={VARIANT_COPY_LIMITS.headlineMaxChars} placeholder="Để trống nếu mẩu mẫu là bài ảnh" />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <Label htmlFor={`cc-t-${variantId}`}>Nội dung chính</Label>
                  <span className={cn("numeric text-[11px] text-muted-foreground", t.trim().length > VARIANT_COPY_LIMITS.primaryTextMaxChars && "text-destructive")}>
                    {t.trim().length}/{VARIANT_COPY_LIMITS.primaryTextMaxChars}
                  </span>
                </div>
                <Textarea id={`cc-t-${variantId}`} value={t} onChange={(e) => setT(e.target.value)} rows={7} maxLength={VARIANT_COPY_LIMITS.primaryTextMaxChars} />
              </div>

              <div className="space-y-2 rounded-lg border p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[12.5px] font-semibold">Gợi ý của AI theo ảnh</p>
                  <Button type="button" size="sm" variant="secondary" onClick={goiY} disabled={suggesting}>
                    {suggesting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} AI gợi ý theo ảnh
                  </Button>
                </div>
                {options.length === 0 ? (
                  <p className="text-[11.5px] text-muted-foreground">AI đọc ảnh của mẫu (màu, kiểu, bối cảnh) rồi viết 2–3 phương án, giá chỉ được là giá ERP. Gợi ý KHÔNG tự lưu — chọn một phương án rồi bấm Lưu.</p>
                ) : (
                  <div className="space-y-2">
                    {seen ? <p className="text-[11.5px] text-muted-foreground">AI thấy trong ảnh: {seen}</p> : null}
                    {options.map((o, i) => (
                      <div key={i} className="rounded-md border bg-muted/30 p-2 text-[12px]">
                        <p className="font-semibold">{o.headline || <span className="font-normal italic text-muted-foreground">(không tiêu đề)</span>}</p>
                        <p className="mt-0.5 line-clamp-4 whitespace-pre-line leading-snug">{o.primaryText}</p>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="mt-1 h-6 px-2 text-[11.5px]"
                          onClick={() => {
                            setH(o.headline);
                            setT(o.primaryText);
                          }}
                        >
                          Dùng phương án {i + 1}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-2.5 text-[12px] leading-snug">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
                <p>
                  <b>Sửa câu chữ ⇒ cần bấm duyệt lại.</b> Câu chữ nằm trong phiếu duyệt lô: ai đã mở hộp duyệt trước khi bạn lưu thì phiếu ấy mất hiệu lực, phải mở lại và bấm duyệt
                  lại để thấy đúng câu sẽ đăng.
                </p>
              </div>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">Sẵn sàng đăng — xem trước</p>
              <AdPreview pageName={pageName} primaryText={t.trim()} headline={h.trim()} imageId={imageId} imageAvailable={imageAvailable} alt={h || `Mẫu #${slot}`} />
            </div>
          </div>

          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">{loiTruoc ?? (doi ? "Chưa lưu." : "Chưa có thay đổi.")}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
                Huỷ
              </Button>
              <Button type="button" onClick={luu} disabled={saving || Boolean(loiTruoc) || !doi}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
