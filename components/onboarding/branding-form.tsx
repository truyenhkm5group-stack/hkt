"use client";

import { useRef, useState, useTransition } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { removeLogoAction, saveBrandingAction, uploadLogoAction } from "@/lib/actions/branding";
import { ACCENT_KEYS, ACCENTS, BRANDING_NAME_MAX, LOGO_MAX_BYTES, type AccentKey } from "@/lib/branding/accents";
import { cn } from "@/lib/utils";

/**
 * Màn thương hiệu (Phase 10 · §4): tên hiển thị, một trong TÁM màu nhấn (không ô mã màu tự do), logo ≤ 512 KB
 * png / jpeg / webp. Máy chủ kiểm lại mọi thứ (kiểu tệp theo chữ ký byte, không theo đuôi); ở đây chỉ chặn sớm cho đỡ
 * một lượt gửi.
 */
export function BrandingForm({ orgName, displayName, accent, logoUrl }: { orgName: string; displayName: string | null; accent: AccentKey | null; logoUrl: string | null }) {
  const [name, setName] = useState(displayName ?? "");
  const [color, setColor] = useState<AccentKey | null>(accent);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () =>
    start(async () => {
      const r = await saveBrandingAction({ displayName: name, accent: color });
      if ("error" in r) toast.error(r.error);
      else toast.success("Đã lưu thương hiệu");
    });

  const upload = (file: File) =>
    start(async () => {
      if (file.size > LOGO_MAX_BYTES) {
        toast.error(`Logo tối đa ${LOGO_MAX_BYTES / 1024} KB.`);
        return;
      }
      const fd = new FormData();
      fd.set("file", file);
      const r = await uploadLogoAction(fd);
      if ("error" in r) toast.error(r.error);
      else toast.success("Đã cập nhật logo");
      if (fileRef.current) fileRef.current.value = "";
    });

  return (
    <div className="space-y-6">
      <div className="max-w-md space-y-2">
        <Label htmlFor="brand-name">Tên hiển thị trên thanh đầu</Label>
        <Input id="brand-name" value={name} maxLength={BRANDING_NAME_MAX} placeholder={orgName} onChange={(e) => setName(e.target.value)} />
        <p className="text-xs text-muted-foreground">Để trống ⇒ dùng tên tổ chức «{orgName}». Mã tổ chức (dùng để đăng nhập) không đổi.</p>
      </div>

      <div className="space-y-2">
        <Label>Màu nhấn</Label>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Màu nhấn">
          <button type="button" role="radio" aria-checked={color === null} onClick={() => setColor(null)} className={cn("rounded-full border px-3 py-1.5 text-xs", color === null ? "border-foreground font-semibold" : "hover:bg-muted")}>
            Mặc định
          </button>
          {ACCENT_KEYS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={color === k} data-accent={k} onClick={() => setColor(k)} className={cn("flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs", color === k ? "border-foreground font-semibold" : "hover:bg-muted")}>
              <span className="size-3.5 rounded-full" style={{ background: ACCENTS[k].swatch }} aria-hidden />
              {ACCENTS[k].label}
            </button>
          ))}
        </div>
      </div>

      <Button type="button" onClick={save} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Lưu tên & màu
      </Button>

      <div className="space-y-2 border-t pt-5">
        <Label>Logo</Label>
        <div className="flex items-center gap-4">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logoUrl} alt="Logo hiện tại" className="size-16 rounded-xl border object-contain" />
          ) : (
            <span className="flex size-16 items-center justify-center rounded-xl border border-dashed text-xs text-muted-foreground">Chưa có</span>
          )}
          <div className="flex flex-wrap gap-2">
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
            <Button type="button" variant="outline" disabled={pending} onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Tải logo
            </Button>
            {logoUrl ? (
              <Button
                type="button"
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    const r = await removeLogoAction();
                    if ("error" in r) toast.error(r.error);
                    else toast.success("Đã gỡ logo");
                  })
                }
              >
                <Trash2 className="size-4" /> Gỡ
              </Button>
            ) : null}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">PNG, JPEG hoặc WebP, tối đa {LOGO_MAX_BYTES / 1024} KB. Logo lưu trong cơ sở dữ liệu của tổ chức và tính vào dung lượng của gói.</p>
      </div>
    </div>
  );
}
