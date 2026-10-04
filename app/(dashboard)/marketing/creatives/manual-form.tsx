"use client";

import { Clapperboard, ImagePlus, Loader2, ShieldAlert, Upload, X } from "lucide-react";
import { useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProductSearch } from "@/app/(dashboard)/marketing/creatives/product-search";
import { addManualCreative } from "@/lib/actions/creative-manual";
import { GENE_KEYS, GENE_LABEL, GENE_VALUE_LABEL, GENE_VOCAB, type GeneKey } from "@/lib/constants/creative-loop";
import { thuNhoAnh, type AnhDaThuNho } from "@/lib/ideas/shrink-image";
import type { ProductOption } from "@/lib/queries/creative-sources";
import { manualCreativeInputSchema } from "@/lib/validation/creative";
import type { CopyFormula } from "@/lib/constants/copy-formulas";
import { AD_MEDIA_ACCEPT, AD_VIDEO_UPLOAD, checkAdVideo } from "@/lib/constants/ad-video";
import { FormulaPicker } from "./copy-ai";
import { FOOD_GENE_EXCLUDE, FOOD_GENE_VALUE_LABEL, type CreativeIndustry } from "@/lib/constants/creative-industry";
import { grabFrame, readVideoMeta, uploadAdVideo, type VideoMeta } from "./video-upload";

type ChosenVideo = { file: File; url: string; meta: VideoMeta };

/**
 * Tải MẪU TỰ LÀM (vẽ trên web ChatGPT / Grok, hoặc chụp tay) vào THẲNG hàng đợi đăng camp (chủ shop 26/09/2026 bỏ lô
 * hằng ngày) — từ đó Soạn bài → Đăng camp như ảnh gen tay. Từ 29/09/2026 nhận cả VIDEO (MP4 / MOV): ảnh bìa là một khung
 * hình người chọn — AI viết content nhìn ảnh ấy; video tải theo khúc lúc bấm "Thêm vào hàng đợi".
 * Mẫu đi qua đúng cổng duyệt · đăng · chấm · học như mẫu máy làm — xem `lib/creative/manual.ts`.
 */
export function ManualForm({ products, industry = "FASHION" }: { products: ProductOption[]; industry?: CreativeIndustry }) {
  // Thực phẩm: chỉ các giá trị gen mang nghĩa món ăn, nhãn theo nghĩa món ăn (lib/constants/creative-industry.ts).
  const food = industry === "FOOD";
  const geneValues = (k: GeneKey) => (GENE_VOCAB[k] as readonly string[]).filter((v) => !food || !(FOOD_GENE_EXCLUDE[k] ?? []).includes(v));
  const geneLabel = (v: string) => (food ? (FOOD_GENE_VALUE_LABEL[v] ?? GENE_VALUE_LABEL[v]) : GENE_VALUE_LABEL[v]) ?? v;
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [note, setNote] = useState("");
  const [aiWrite, setAiWrite] = useState(true);
  const [aiFormulas, setAiFormulas] = useState<CopyFormula[]>(["HOOK_QUESTION"]);
  const [genes, setGenes] = useState<Partial<Record<GeneKey, string>>>({});
  const [anh, setAnh] = useState<(AnhDaThuNho & { ten: string }) | null>(null);
  const [dangXuLyAnh, setDangXuLyAnh] = useState(false);
  const [video, setVideo] = useState<ChosenVideo | null>(null);
  const [khungGiay, setKhungGiay] = useState(1);
  const [tien, setTien] = useState<{ done: number; total: number } | null>(null);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const boVideo = () => {
    setVideo((v) => {
      if (v) URL.revokeObjectURL(v.url);
      return null;
    });
  };

  const layAnhBia = async (url: string, giay: number) => {
    setDangXuLyAnh(true);
    try {
      setAnh({ ...(await thuNhoAnh(await grabFrame(url, giay))), ten: `ảnh bìa ${giay.toFixed(1)}s` });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không lấy được ảnh bìa");
    } finally {
      setDangXuLyAnh(false);
    }
  };

  const chonAnh = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    if (f.type.startsWith("video/")) {
      const kiem = checkAdVideo({ contentType: f.type, bytes: f.size });
      if (!kiem.ok) {
        toast.error(kiem.error);
        if (inputRef.current) inputRef.current.value = "";
        return;
      }
      boVideo();
      const url = URL.createObjectURL(f);
      setDangXuLyAnh(true);
      try {
        const meta = await readVideoMeta(url);
        const giay = meta.durationMs ? Math.min(1, meta.durationMs / 10_000) : 0;
        setVideo({ file: f, url, meta });
        setKhungGiay(giay);
        setAnh({ ...(await thuNhoAnh(await grabFrame(url, giay))), ten: f.name });
      } catch (e) {
        URL.revokeObjectURL(url);
        setVideo(null);
        toast.error(e instanceof Error ? e.message : "Không đọc được video");
      } finally {
        setDangXuLyAnh(false);
        if (inputRef.current) inputRef.current.value = "";
      }
      return;
    }
    if (!f.type.startsWith("image/")) {
      toast.error(`${f.name} không phải ảnh hay video`);
      return;
    }
    boVideo();
    setDangXuLyAnh(true);
    try {
      setAnh({ ...(await thuNhoAnh(f)), ten: f.name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không đọc được ảnh");
    } finally {
      setDangXuLyAnh(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const dong = () => {
    setOpen(false);
    setProductId("");
    setPrimaryText("");
    setHeadline("");
    setNote("");
    setGenes({});
    setAnh(null);
    boVideo();
    setTien(null);
  };

  const input = useMemo(() => ({ productId, primaryText, headline, note, genes, imageBase64: anh?.base64 ?? "", aiWrite, aiFormulas }), [productId, primaryText, headline, note, genes, anh, aiWrite, aiFormulas]);
  // Báo trước khi bấm bằng ĐÚNG lược đồ máy chủ dùng.
  const loiTruoc = useMemo(() => {
    const kiemTra = manualCreativeInputSchema.safeParse(input);
    return kiemTra.success ? null : (kiemTra.error.issues[0]?.message ?? "Dữ liệu chưa đủ");
  }, [input]);

  const gui = () =>
    start(async () => {
      // Mẫu VIDEO: tải video theo khúc TRƯỚC, rồi mới tạo mẫu (ảnh bìa + id video) — hỏng giữa chừng thì chưa có mẫu nào.
      let videoAssetId: string | null = null;
      if (video) {
        const up = await uploadAdVideo(video.file, video.meta, (done, total) => setTien({ done, total }));
        if (!up.ok) {
          setTien(null);
          toast.error(up.error);
          return;
        }
        videoAssetId = up.assetId;
      }
      const r = await addManualCreative({ ...input, videoAssetId });
      setTien(null);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(aiWrite && !r.aiError ? "Đã thêm mẫu tự làm — AI đã viết tiêu đề + content (không ghi giá). Mở tab ③ Hàng đợi & Đăng để xem, sửa, chọn công thức khác và đăng camp." : "Đã thêm mẫu tự làm vào hàng đợi đăng camp — mở tab ③ Hàng đợi & Đăng để đăng.");
      if (r.aiError) toast.warning(`AI chưa viết được content (${r.aiError}) — gõ tay hoặc bấm “AI viết theo công thức” trong hộp soạn bài.`);
      for (const w of r.warnings) toast.warning(w);
      dong();
    });

  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <Upload className="size-4" /> Thêm mẫu tự làm
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Thêm mẫu tự làm vào hàng đợi đăng camp</DialogTitle>
            <DialogDescription>
              Ảnh / video bạn tự làm vào thẳng hàng đợi (coi như đã duyệt). Đăng lên Facebook khi bấm Đăng camp ở tab ③ Hàng đợi & Đăng.
            </DialogDescription>
          </DialogHeader>

          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-[12.5px] leading-snug">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <p>
              <b>Chỉ tải mẫu shop tự làm, đúng sản phẩm có trong kho.</b> Ảnh chép của đối thủ là rủi ro bản quyền và là lý do Facebook khoá tài khoản; mẫu tự làm mà thắng
              sẽ được máy dùng làm gốc cho các biến thể sau.
            </p>
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              gui();
            }}
          >
            <div className="grid gap-4 sm:grid-cols-[176px_1fr]">
              <div className="space-y-2">
                <Label>Ảnh / video mẫu</Label>
                <input ref={inputRef} type="file" accept={AD_MEDIA_ACCEPT} className="hidden" onChange={(e) => void chonAnh(e.target.files)} />
                {video ? (
                  <div className="w-44 space-y-1.5">
                    <div className="relative overflow-hidden rounded-md border bg-black">
                      <video src={video.url} controls muted playsInline className="aspect-square w-full object-contain" />
                      <button type="button" aria-label="Bỏ video" className="absolute right-1 top-1 rounded-full bg-background/90 p-1" onClick={() => { boVideo(); setAnh(null); }}>
                        <X className="size-3.5" />
                      </button>
                    </div>
                    <p className="text-[10.5px] text-muted-foreground">
                      {(video.file.size / 1048576).toFixed(1)} MB{video.meta.durationMs ? ` · ${(video.meta.durationMs / 1000).toFixed(1)} giây` : ""}
                      {video.meta.width && video.meta.height ? ` · ${video.meta.width}×${video.meta.height}` : ""}
                    </p>
                    <label className="block space-y-0.5 text-[11px]">
                      <span className="text-muted-foreground">Ảnh bìa ở giây {khungGiay.toFixed(1)}</span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(0, (video.meta.durationMs ?? 0) / 1000 - 0.1)}
                        step={0.1}
                        value={khungGiay}
                        disabled={dangXuLyAnh || pending}
                        onChange={(e) => setKhungGiay(Number(e.target.value))}
                        onPointerUp={() => void layAnhBia(video.url, khungGiay)}
                        onKeyUp={() => void layAnhBia(video.url, khungGiay)}
                        className="w-full"
                      />
                    </label>
                    {anh ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={anh.preview} alt="Ảnh bìa" className="aspect-square w-full rounded border object-cover" />
                    ) : null}
                    {tien ? (
                      <p className="text-[11px] font-medium text-primary">
                        Đang tải video {tien.done}/{tien.total} khúc…
                      </p>
                    ) : null}
                  </div>
                ) : anh ? (
                  <div className="relative w-44 overflow-hidden rounded-md border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={anh.preview} alt={anh.ten} className="aspect-square w-full object-cover" />
                    <button type="button" aria-label="Bỏ ảnh" className="absolute right-1 top-1 rounded-full bg-background/90 p-1" onClick={() => setAnh(null)}>
                      <X className="size-3.5" />
                    </button>
                    <span className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 text-[10px]">{anh.kb} KB sau khi thu nhỏ</span>
                  </div>
                ) : (
                  <Button type="button" variant="outline" size="sm" disabled={dangXuLyAnh} onClick={() => inputRef.current?.click()}>
                    {dangXuLyAnh ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Chọn ảnh / video
                  </Button>
                )}
                {!anh && !video ? (
                  <p className="flex items-start gap-1 text-[10.5px] leading-snug text-muted-foreground">
                    <Clapperboard className="mt-0.5 size-3 shrink-0" /> Video MP4 / MOV ≤ {AD_VIDEO_UPLOAD.maxBytes / 1048576} MB — chọn khung hình làm ảnh bìa.
                  </p>
                ) : null}
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="mm-product">
                    Mã hàng <span className="text-destructive">(bắt buộc)</span>
                  </Label>
                  <ProductSearch id="mm-product" products={products} value={productId} onChange={setProductId} />
                </div>
                <div className="space-y-1.5 rounded-md border border-primary/30 bg-primary/5 p-2">
                  <label className="flex items-center gap-2 text-[12.5px] font-medium">
                    <input type="checkbox" checked={aiWrite} onChange={(e) => setAiWrite(e.target.checked)} /> AI viết tiêu đề + content theo {video ? "ảnh bìa video" : "ảnh"} (không ghi giá)
                  </label>
                  {aiWrite ? (
                    <>
                      <FormulaPicker value={aiFormulas} onChange={(v) => setAiFormulas(v.slice(-1))} max={1} industry={industry} />
                      <p className="text-[11px] text-muted-foreground">Chọn một công thức cho bản đầu — trong hộp soạn bài bấm “AI viết theo công thức” để ra thêm phương án khác. Để trống hai ô dưới để AI viết.</p>
                    </>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mm-headline">Tiêu đề (≤ 40 ký tự)</Label>
                  <Input id="mm-headline" value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={40} placeholder="VD: Đầm linen mặc mát cả ngày" />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mm-text">Nội dung chính (≤ 500 ký tự)</Label>
                  <Textarea id="mm-text" value={primaryText} onChange={(e) => setPrimaryText(e.target.value)} rows={4} maxLength={500} />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Đặc điểm của mẫu — để máy học được mẫu này thắng hay thua vì đâu</Label>
              <div className="grid gap-2 sm:grid-cols-3">
                {GENE_KEYS.map((k) => (
                  <label key={k} className="space-y-1 text-[12px]">
                    <span className="text-muted-foreground">{GENE_LABEL[k]}</span>
                    <select className="h-8 w-full rounded-md border bg-background px-2 text-[12.5px]" value={genes[k] ?? ""} onChange={(e) => setGenes((g) => ({ ...g, [k]: e.target.value || undefined }))}>
                      <option value="">— chọn —</option>
                      {geneValues(k).map((val) => (
                        <option key={val} value={val}>
                          {geneLabel(val)}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="mm-note">Ghi chú (tuỳ chọn)</Label>
              <Input id="mm-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="VD: vẽ trên ChatGPT, thử góc giá sốc" />
            </div>

            <DialogFooter className="items-center gap-2 sm:justify-between">
              <p className="text-[11.5px] text-muted-foreground">{loiTruoc ?? "Đủ thông tin để thêm vào hàng đợi."}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={dong} disabled={pending}>
                  Huỷ
                </Button>
                <Button type="submit" disabled={pending || dangXuLyAnh || Boolean(loiTruoc)}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} {tien ? `Đang tải ${Math.round((tien.done / Math.max(1, tien.total)) * 100)}%` : "Thêm vào hàng đợi"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
