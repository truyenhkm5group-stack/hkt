"use client";

import { useMemo, useState, useTransition } from "react";
import { Loader2, Save, Tags } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { saveVariantNames } from "@/lib/actions/creative-names";
import { variantNamesInputSchema } from "@/lib/validation/creative";

/**
 * XEM + SỬA TÊN chiến dịch · nhóm · quảng cáo của một bài trước khi duyệt (§5i). Tên nằm trong phiếu duyệt:
 * lưu ⇒ phiếu đã phát mất hiệu lực. Để trống một ô = dùng tên mặc định theo khuôn.
 */
export function EditNamesButton({ variantId, slot, campaignName, adsetName, adName }: { variantId: string; slot: number; campaignName: string; adsetName: string; adName: string }) {
  const [open, setOpen] = useState(false);
  const [c, setC] = useState(campaignName);
  const [a, setA] = useState(adsetName);
  const [d, setD] = useState(adName);
  const [saving, start] = useTransition();
  const input = useMemo(() => ({ variantId, campaignName: c, adsetName: a, adName: d }), [variantId, c, a, d]);
  const loi = useMemo(() => {
    const r = variantNamesInputSchema.safeParse(input);
    return r.success ? null : (r.error.issues[0]?.message ?? "Tên chưa hợp lệ");
  }, [input]);
  const doi = c.trim() !== campaignName || a.trim() !== adsetName || d.trim() !== adName;

  const mo = () => {
    setC(campaignName);
    setA(adsetName);
    setD(adName);
    setOpen(true);
  };
  const luu = () =>
    start(async () => {
      const r = await saveVariantNames(input);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.changed ? `Đã lưu tên bài #${slot} — lô cần được bấm duyệt lại.` : "Tên không đổi.");
      setOpen(false);
    });

  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 w-full text-[12px]" onClick={mo}>
        <Tags className="size-3.5" /> Sửa tên chiến dịch / nhóm / QC
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Tên trên Ads Manager — bài #{slot}</DialogTitle>
            <DialogDescription>Mỗi bài một chiến dịch → 1 nhóm → 1 quảng cáo. Để trống một ô = dùng tên mặc định theo khuôn.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`nm-c-${variantId}`}>Chiến dịch</Label>
            <Input id={`nm-c-${variantId}`} value={c} onChange={(e) => setC(e.target.value)} />
            <Label htmlFor={`nm-a-${variantId}`}>Nhóm quảng cáo</Label>
            <Input id={`nm-a-${variantId}`} value={a} onChange={(e) => setA(e.target.value)} />
            <Label htmlFor={`nm-d-${variantId}`}>Quảng cáo</Label>
            <Input id={`nm-d-${variantId}`} value={d} onChange={(e) => setD(e.target.value)} />
            <p className="rounded-md border border-warning/40 bg-warning/10 p-2 text-[12px]">
              <b>Sửa tên ⇒ cần bấm duyệt lại.</b> Tên nằm trong phiếu duyệt lô như câu chữ.
            </p>
          </div>
          <DialogFooter className="items-center gap-2 sm:justify-between">
            <p className="text-[11.5px] text-muted-foreground">{loi ?? (doi ? "Chưa lưu." : "Chưa có thay đổi.")}</p>
            <Button type="button" onClick={luu} disabled={saving || !!loi || !doi}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
