"use client";

import { ImagePlus, Loader2, ShieldAlert, Upload, X } from "lucide-react";
import { useMemo, useRef, useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ProductSearch } from "@/app/(dashboard)/marketing/creatives/product-search";
import { createCreativeSource } from "@/lib/actions/creative-sources";
import { CREATIVE_SOURCE_KIND_LABEL, CREATIVE_SOURCE_KIND_USE, MANUAL_UPLOAD_SOURCE_KINDS, PIXEL_SAFE_SOURCE_KINDS } from "@/lib/constants/creative-loop";
import { thuNhoAnh, type AnhDaThuNho } from "@/lib/ideas/shrink-image";
import type { ProductOption } from "@/lib/queries/creative-sources";
import { creativeSourceInputSchema } from "@/lib/validation/creative";
import { cn } from "@/lib/utils";

/** Loại người được tải tay — `OWN_AD` chỉ vào qua nút nhập từ Facebook (xem `MANUAL_UPLOAD_SOURCE_KINDS`). */
type UploadKind = (typeof MANUAL_UPLOAD_SOURCE_KINDS)[number];

/** Chú thích dưới từng ô: ô ấy dùng làm gì, và MÁY có đọc nó không. */
function FieldHint({ children }: { children: ReactNode }) {
  return <p className="text-[11.5px] leading-snug text-muted-foreground">{children}</p>;
}

export function SourceForm({ products }: { products: ProductOption[] }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<UploadKind>("PRODUCT_PHOTO");
  const [productId, setProductId] = useState("");
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [anh, setAnh] = useState<(AnhDaThuNho & { ten: string }) | null>(null);
  const [dangXuLyAnh, setDangXuLyAnh] = useState(false);
  const [pending, start] = useTransition();
  const inputRef = useRef<HTMLInputElement>(null);

  const chonAnh = async (list: FileList | null) => {
    const f = list?.[0];
    if (!f) return;
    if (!f.type.startsWith("image/")) {
      toast.error(`${f.name} không phải ảnh`);
      return;
    }
    setDangXuLyAnh(true);
    try {
      const nho = await thuNhoAnh(f);
      setAnh({ ...nho, ten: f.name });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Không đọc được ảnh");
    } finally {
      setDangXuLyAnh(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const dong = () => {
    setOpen(false);
    setKind("PRODUCT_PHOTO");
    setProductId("");
    setTitle("");
    setNote("");
    setSourceUrl("");
    setAnh(null);
  };

  const input = useMemo(() => ({ kind, productId, title, note, sourceUrl, imageBase64: anh?.base64 ?? "" }), [kind, productId, title, note, sourceUrl, anh]);
  // Báo trước khi bấm bằng ĐÚNG lược đồ máy chủ dùng — không phải một bộ luật thứ hai.
  const loiTruoc = useMemo(() => {
    const kiemTra = creativeSourceInputSchema.safeParse(input);
    return kiemTra.success ? null : (kiemTra.error.issues[0]?.message ?? "Dữ liệu chưa đủ");
  }, [input]);

  const gui = () =>
    start(async () => {
      const r = await createCreativeSource(input);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu ảnh nguồn — máy sẽ đọc gen ở lượt chạy kế tiếp");
      dong();
    });

  const pixelSafe = PIXEL_SAFE_SOURCE_KINDS.includes(kind);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Upload className="size-4" /> Thêm ảnh nguồn
      </Button>
      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : dong())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Thêm ảnh nguồn cho vòng mẫu</DialogTitle>
            <DialogDescription>Một ảnh mỗi lần. Ảnh được thu nhỏ ngay trên máy trước khi tải lên.</DialogDescription>
          </DialogHeader>

          {/* Ranh giới 2 + 3 của `lib/constants/creative-loop.ts` — người tải ảnh phải đọc được TRƯỚC khi chọn. */}
          <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-[12.5px] leading-snug">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
            <div className="space-y-1">
              <p>
                <b>Ảnh đối thủ (spy) chỉ được đọc thành mô tả chữ</b> — không bao giờ được gửi sang máy sinh ảnh. Chép ảnh người khác là rủi ro bản quyền và là lý do
                Facebook khoá tài khoản quảng cáo.
              </p>
              <p>
                <b>Mã nào muốn test phải có ẢNH SẢN PHẨM THẬT.</b> Máy chỉ sinh mẫu từ sản phẩm nó nhìn thấy; quảng cáo một chiếc váy không có trong kho thì đơn
                nào cũng thành đơn hoàn.
              </p>
            </div>
          </div>

          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              gui();
            }}
          >
            <div className="space-y-1.5">
              <Label>Loại ảnh</Label>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {MANUAL_UPLOAD_SOURCE_KINDS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={kind === k}
                    onClick={() => setKind(k)}
                    className={cn("rounded-md border px-2 py-1.5 text-[12.5px] transition-colors", kind === k ? "border-primary bg-primary/10 font-semibold" : "hover:bg-accent")}
                  >
                    {CREATIVE_SOURCE_KIND_LABEL[k]}
                  </button>
                ))}
              </div>
              <p className={cn("text-[11.5px]", pixelSafe ? "text-muted-foreground" : "text-warning")}>{CREATIVE_SOURCE_KIND_USE[kind]}</p>
              <FieldHint>Quảng cáo cũ của shop không tải ở đây — dùng nút “Nhập mẫu thắng / mẫu tốt từ Facebook” (máy lấy ảnh theo mã quảng cáo thật của shop).</FieldHint>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cs-product">
                Mã hàng {kind === "PRODUCT_PHOTO" ? <span className="text-destructive">(bắt buộc)</span> : <span className="font-normal text-muted-foreground">(không bắt buộc)</span>}
              </Label>
              <ProductSearch id="cs-product" products={products} value={productId} onChange={setProductId} />
              <FieldHint>
                {kind === "PRODUCT_PHOTO"
                  ? "Máy chỉ sinh mẫu cho mã có ảnh loại này — ảnh phải đúng mã đang bán."
                  : "Gắn mã thì ô thăm dò dùng nguồn này sẽ test đúng mã đó; để trống thì máy chọn mã ít được test nhất."}
              </FieldHint>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="cs-title">
                  Tiêu đề <span className="font-normal text-muted-foreground">(không bắt buộc)</span>
                </Label>
                <Input id="cs-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="VD: Đầm hoa nhí – ảnh mặc thật" maxLength={200} />
                <FieldHint>Tên để người trong đội nhận ra ảnh trên thẻ và khi tìm kiếm. Máy không dùng.</FieldHint>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cs-url">
                  Link nguồn <span className="font-normal text-muted-foreground">(không bắt buộc)</span>
                </Label>
                <Input id="cs-url" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://… (bài đối thủ, thư viện QC)" />
                <FieldHint>Nơi lấy ảnh, để người đọc lần lại được. Máy không mở link này.</FieldHint>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cs-note">
                Ghi chú <span className="font-normal text-muted-foreground">(không bắt buộc)</span>
              </Label>
              <Textarea id="cs-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Vì sao ảnh này đáng học: bố cục, góc bán, câu chữ…" maxLength={2000} />
              <FieldHint>Cho người trong đội đọc. Máy KHÔNG đọc ô này — máy tự xem ảnh và rút ra gen + mô tả ở lượt chạy kế tiếp.</FieldHint>
            </div>

            <div className="space-y-2">
              <Label>
                Ảnh <span className="text-destructive">(bắt buộc)</span>
              </Label>
              <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void chonAnh(e.target.files)} />
              {anh ? (
                <div className="relative w-40 overflow-hidden rounded-md border">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={anh.preview} alt={anh.ten} className="aspect-square w-full object-cover" />
                  <button type="button" aria-label="Bỏ ảnh" className="absolute right-1 top-1 rounded-full bg-background/90 p-1" onClick={() => setAnh(null)}>
                    <X className="size-3.5" />
                  </button>
                  <span className="absolute bottom-0 left-0 right-0 bg-background/80 px-1 text-[10px]">{anh.kb} KB sau khi thu nhỏ</span>
                </div>
              ) : (
                <Button type="button" variant="outline" size="sm" disabled={dangXuLyAnh} onClick={() => inputRef.current?.click()}>
                  {dangXuLyAnh ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Chọn ảnh
                </Button>
              )}
            </div>

            <DialogFooter className="items-center gap-2 sm:justify-between">
              <p className="text-[11.5px] text-muted-foreground">{loiTruoc ?? "Đủ thông tin để lưu."}</p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={dong} disabled={pending}>
                  Huỷ
                </Button>
                <Button type="submit" disabled={pending || dangXuLyAnh || Boolean(loiTruoc)}>
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Lưu ảnh nguồn
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
