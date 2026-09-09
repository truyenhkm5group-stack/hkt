"use client";

import { ImagePlus, Loader2, Plus, X } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createIdea } from "@/lib/actions/ideas";
import { IDEA_IMAGE_MAX_EDGE, IDEA_IMAGE_QUALITY, IDEA_MAX_IMAGES } from "@/lib/constants/ideas";
import { todayVN } from "@/lib/format";

type AnhDaChon = { base64: string; contentType: string; preview: string; kb: number; ten: string };

/**
 * Thu nhỏ ảnh NGAY TRÊN TRÌNH DUYỆT trước khi gửi lên.
 *
 * Ảnh chụp từ điện thoại thường 3–6 MB; ảnh nằm trong CSDL nên gửi nguyên bản là làm phình cơ sở
 * dữ liệu và mỗi lần mở trang lại tải cả chục MB. Thu về cạnh dài tối đa {IDEA_IMAGE_MAX_EDGE}px
 * là đủ nhìn rõ bố cục, màu sắc và chữ trên ảnh mẫu.
 */
async function thuNhoAnh(file: File): Promise<{ base64: string; contentType: string; preview: string; kb: number }> {
  const bitmap = await createImageBitmap(file);
  const tyLe = Math.min(1, IDEA_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * tyLe));
  const h = Math.max(1, Math.round(bitmap.height * tyLe));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Trình duyệt không xử lý được ảnh này");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const dataUrl = canvas.toDataURL("image/jpeg", IDEA_IMAGE_QUALITY);
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  return { base64, contentType: "image/jpeg", preview: dataUrl, kb: Math.round((base64.length * 3) / 4 / 1024) };
}

export function IdeaForm({ marketers, defaultMarketer }: { marketers: { id: string; name: string }[]; defaultMarketer?: string }) {
  const [open, setOpen] = useState(false);
  const [marketer, setMarketer] = useState(defaultMarketer ?? "");
  const [ngay, setNgay] = useState(todayVN());
  const [noiDung, setNoiDung] = useState("");
  const [anh, setAnh] = useState<AnhDaChon[]>([]);
  const [dangXuLyAnh, setDangXuLyAnh] = useState(false);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const chonAnh = async (list: FileList | null) => {
    const files = list ? Array.from(list) : [];
    if (!files.length) return;
    if (anh.length + files.length > IDEA_MAX_IMAGES) {
      toast.error(`Tối đa ${IDEA_MAX_IMAGES} ảnh mỗi ý tưởng`);
      return;
    }
    setDangXuLyAnh(true);
    try {
      const moi: AnhDaChon[] = [];
      for (const f of files) {
        if (!f.type.startsWith("image/")) {
          toast.error(`${f.name} không phải ảnh`);
          continue;
        }
        const nho = await thuNhoAnh(f);
        moi.push({ ...nho, ten: f.name });
      }
      setAnh((cu) => [...cu, ...moi]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không đọc được ảnh");
    } finally {
      setDangXuLyAnh(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const dong = () => {
    setOpen(false);
    setNoiDung("");
    setAnh([]);
    setNgay(todayVN());
  };

  const gui = () => {
    const chon = marketers.find((m) => m.id === marketer);
    start(async () => {
      const r = await createIdea({
        marketerId: chon && !chon.id.startsWith("ten:") ? chon.id : undefined,
        marketerName: chon?.name ?? marketer,
        ideaDate: ngay,
        content: noiDung,
        images: anh.map((a) => ({ base64: a.base64, contentType: a.contentType })),
      });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã đăng ý tưởng, quản lý sẽ nhận xét");
      dong();
      router.refresh();
    });
  };

  const tongKb = anh.reduce((t, a) => t + a.kb, 0);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Thêm ý tưởng
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Thêm ý tưởng marketing</DialogTitle>
            <DialogDescription>Dòng đầu của nội dung được dùng làm tiêu đề trong danh sách.</DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              gui();
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="idea-mkt">Marketer phụ trách</Label>
                <select
                  id="idea-mkt"
                  className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  value={marketer}
                  onChange={(e) => setMarketer(e.target.value)}
                  required
                >
                  <option value="">— Chọn marketer —</option>
                  {marketers.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
                {marketers.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Chưa khai báo nhân sự phòng Marketing ở trang Lương &amp; hoa hồng.</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="idea-date">Ngày</Label>
                <Input id="idea-date" type="date" value={ngay} onChange={(e) => setNgay(e.target.value)} required />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="idea-content">Nội dung ý tưởng</Label>
              <Textarea
                id="idea-content"
                value={noiDung}
                onChange={(e) => setNoiDung(e.target.value)}
                rows={5}
                placeholder={"Dòng đầu: tên ý tưởng\nCác dòng sau: mô tả chi tiết, thông điệp, nơi định chạy…"}
                required
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Ảnh minh hoạ</Label>
                <span className="text-[11px] text-muted-foreground">
                  {anh.length}/{IDEA_MAX_IMAGES} ảnh{tongKb ? ` · ${tongKb} KB sau khi thu nhỏ` : ""}
                </span>
              </div>
              <input ref={inputRef} type="file" accept="image/*" multiple className="hidden" onChange={(e) => void chonAnh(e.target.files)} />
              <Button type="button" variant="outline" size="sm" disabled={dangXuLyAnh || anh.length >= IDEA_MAX_IMAGES} onClick={() => inputRef.current?.click()}>
                {dangXuLyAnh ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Chọn ảnh
              </Button>
              {anh.length ? (
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {anh.map((a, index) => (
                    <div key={`${a.ten}-${index}`} className="group relative overflow-hidden rounded-md border">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={a.preview} alt={a.ten} className="aspect-square w-full object-cover" />
                      <button
                        type="button"
                        aria-label="Bỏ ảnh"
                        className="absolute right-1 top-1 rounded-full bg-background/90 p-1 opacity-0 transition-opacity group-hover:opacity-100"
                        onClick={() => setAnh((cu) => cu.filter((_, x) => x !== index))}
                      >
                        <X className="size-3.5" />
                      </button>
                      <span className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 text-[10px]">{a.kb} KB</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={dong} disabled={pending}>
                Huỷ
              </Button>
              <Button type="submit" disabled={pending || dangXuLyAnh || !marketer || !noiDung.trim()}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Đăng ý tưởng
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
