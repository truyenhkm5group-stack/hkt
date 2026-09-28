"use client";

import { Clapperboard, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useNavTransition } from "@/components/nav-progress";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { createVideoRunAction, loadVideoPhotosAction } from "@/lib/actions/video-scale";
import { VIDEO_ANGLES, VIDEO_ANGLE_LABEL, VIDEO_SCALE_HARD_LIMITS, type VideoAngle } from "@/lib/constants/video-scale";
import type { SourcePhoto } from "@/lib/queries/video-scale";
import { cn } from "@/lib/utils";

/**
 * "Tạo chiến dịch media" — chọn ẢNH GỐC (ảnh sản phẩm thật của mã; người chọn = người duyệt ảnh), số biến thể, góc bán
 * (bỏ trống = máy chọn theo sổ học), ý tưởng, nhạc có quyền. Bấm là xếp việc: màn hình trả lời ngay, video sinh sau.
 */
export function CreateRunDialog({ productId, label, music, perVideoUsd = null, costNote = "" }: { productId: string; label: string; music: { id: string; title: string }[]; perVideoUsd?: number | null; costNote?: string }) {
  const [open, setOpen] = useState(false);
  const [photos, setPhotos] = useState<SourcePhoto[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
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
        const r = await loadVideoPhotosAction({ id: productId });
        if ("error" in r) return void toast.error(r.error);
        setPhotos(r.photos);
        setPicked(r.photos.slice(0, 1).map((p) => p.id));
      });
  };

  const toggle = <T,>(list: T[], x: T) => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  const router = useRouter();
  const submit = () =>
    start(async () => {
      const r = await createVideoRunAction({ productId, sourceIds: picked, variants, angles, brief, musicId });
      if ("error" in r) return void toast.error(r.error);
      toast.success("Đã xếp lượt — máy đang viết kịch bản. Chuyển sang màn hình tiến trình.");
      setOpen(false);
      router.push("?tab=hang-doi");
    });

  return (
    <Dialog open={open} onOpenChange={onOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Clapperboard className="size-4" aria-hidden /> Tạo chiến dịch media
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tạo chiến dịch media — {label}</DialogTitle>
          <DialogDescription>Chọn ảnh sản phẩm THẬT làm khung đầu cho clip. Máy chỉ gửi đúng các ảnh này sang máy sinh video.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-[13px]">
          <div>
            <p className="mb-1.5 font-medium">Ảnh gốc ({picked.length} đã chọn)</p>
            {loading || photos === null ? (
              <Loader2 className="size-4 animate-spin" aria-label="Đang tải ảnh" />
            ) : photos.length === 0 ? (
              <p className="text-muted-foreground">Mã chưa có ảnh sản phẩm thật đang bật.</p>
            ) : (
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {photos.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPicked((x) => toggle(x, p.id).slice(0, 6))}
                    className={cn("relative overflow-hidden rounded border-2", picked.includes(p.id) ? "border-primary" : "border-transparent opacity-70")}
                    aria-pressed={picked.includes(p.id)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL qua route có kiểm quyền */}
                    <img src={`/api/creative/images/${p.imageId}`} alt={p.title || "Ảnh sản phẩm"} className="aspect-[4/5] w-full object-cover" loading="lazy" />
                  </button>
                ))}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2">
            <span className="font-medium">Số biến thể</span>
            <input type="number" min={1} max={VIDEO_SCALE_HARD_LIMITS.maxVariantsPerRun} value={variants} onChange={(e) => setVariants(Number(e.target.value) || 1)} className="h-8 w-20 rounded border px-2" />
          </label>
          <div>
            <p className="mb-1.5 font-medium">Góc bán (bỏ trống = máy chọn theo kết quả đã học)</p>
            <div className="flex flex-wrap gap-1.5">
              {VIDEO_ANGLES.map((a) => (
                <button key={a} type="button" onClick={() => setAngles((x) => toggle(x, a))} className={cn("rounded-full border px-2.5 py-1 text-[12px]", angles.includes(a) ? "border-primary bg-primary/10" : "")} aria-pressed={angles.includes(a)}>
                  {VIDEO_ANGLE_LABEL[a]}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <span className="font-medium">Ý tưởng (tuỳ chọn)</span>
            <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} maxLength={600} rows={2} placeholder="vd: nhấn mạnh dáng che bắp tay, bối cảnh công sở" />
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium">Nhạc nền</span>
            <select value={musicId} onChange={(e) => setMusicId(e.target.value)} className="h-8 rounded border px-2">
              <option value="">Không nhạc (âm gốc của clip)</option>
              {music.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                </option>
              ))}
            </select>
            {music.length === 0 ? <span className="text-[12px] text-muted-foreground">Thư viện nhạc có quyền đang trống (tab Cấu hình).</span> : null}
          </label>
        </div>
        <p className="rounded-md border bg-muted/40 p-2 text-[12.5px]">
          Ước tính tiền sinh video:{" "}
          <b>{perVideoUsd === null ? "chưa có giá cho model đang chọn" : perVideoUsd === 0 ? "0 USD (toàn ảnh động)" : `≈ ${(perVideoUsd * variants).toFixed(2)} USD cho ${variants} video (${perVideoUsd.toFixed(2)} USD / video, giữ chỗ tối đa)`}</b>
          {costNote ? <span className="block text-muted-foreground">{costNote}</span> : null}
          <span className="block text-muted-foreground">Rẻ hơn: tạo ít video AI rồi dùng &ldquo;Nhân bản&rdquo; ở tab Duyệt video để ra thêm biến thể từ cùng clip (gần như 0 USD).</span>
        </p>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || picked.length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Tạo {variants} biến thể
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
