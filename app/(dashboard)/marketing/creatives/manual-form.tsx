"use client";

import { ImagePlus, Loader2, ShieldAlert, Upload, X } from "lucide-react";
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

/**
 * Tải MẪU TỰ LÀM (vẽ trên web ChatGPT / Grok, hoặc chụp tay) vào THẲNG hàng đợi đăng camp (chủ shop 26/09/2026 bỏ lô
 * hằng ngày) — từ đó Soạn bài → Đăng camp như ảnh gen tay.
 * Mẫu đi qua đúng cổng duyệt · đăng · chấm · học như mẫu máy làm — xem `lib/creative/manual.ts`.
 */
export function ManualForm({ products }: { products: ProductOption[] }) {
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("");
  const [primaryText, setPrimaryText] = useState("");
  const [headline, setHeadline] = useState("");
  const [note, setNote] = useState("");
  const [genes, setGenes] = useState<Partial<Record<GeneKey, string>>>({});
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
  };

  const input = useMemo(() => ({ productId, primaryText, headline, note, genes, imageBase64: anh?.base64 ?? "" }), [productId, primaryText, headline, note, genes, anh]);
  // Báo trước khi bấm bằng ĐÚNG lược đồ máy chủ dùng.
  const loiTruoc = useMemo(() => {
    const kiemTra = manualCreativeInputSchema.safeParse(input);
    return kiemTra.success ? null : (kiemTra.error.issues[0]?.message ?? "Dữ liệu chưa đủ");
  }, [input]);

  const gui = () =>
    start(async () => {
      const r = await addManualCreative(input);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã thêm mẫu tự làm vào hàng đợi đăng camp — mở tab ③ Hàng đợi & Đăng để đăng.");
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
              Ảnh bạn tự làm vào thẳng hàng đợi (coi như đã duyệt). Đăng lên Facebook khi bấm Đăng camp ở tab ③ Hàng đợi & Đăng.
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
                <Label>Ảnh mẫu</Label>
                <input ref={inputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void chonAnh(e.target.files)} />
                {anh ? (
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
                    {dangXuLyAnh ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />} Chọn ảnh
                  </Button>
                )}
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="mm-product">
                    Mã hàng <span className="text-destructive">(bắt buộc)</span>
                  </Label>
                  <ProductSearch id="mm-product" products={products} value={productId} onChange={setProductId} />
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
                      {(GENE_VOCAB[k] as readonly string[]).map((val) => (
                        <option key={val} value={val}>
                          {GENE_VALUE_LABEL[val] ?? val}
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
                  {pending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} Thêm vào hàng đợi
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
