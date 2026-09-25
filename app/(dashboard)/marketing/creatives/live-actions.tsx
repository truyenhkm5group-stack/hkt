"use client";

import { useState, useTransition } from "react";
import { Loader2, PauseCircle, TrendingUp } from "lucide-react";
import { toast } from "sonner";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { pauseVariantNow } from "@/lib/actions/creative";
import { applyExtension, proposeExtension, type ExtensionProposal } from "@/lib/actions/creative-extend";
import { formatVND, vnShortStamp } from "@/lib/format";

/** TẮT NGAY — người bấm là căn cứ, nhưng lời gọi vẫn đi qua đủ cổng (chốt cứng env, nấc COPILOT, nhóm của vòng). */
export function PauseNowButton({ variantId, slot }: { variantId: string; slot: number }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const tat = () =>
    start(async () => {
      const r = await pauseVariantNow({ variantId });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.detail);
      setOpen(false);
    });
  return (
    <>
      <Button variant="outline" size="sm" className="h-7 px-2 text-[12px]" onClick={() => setOpen(true)}>
        <PauseCircle className="size-3.5" />
        Tắt ngay
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tắt mẫu #{slot} ngay?</AlertDialogTitle>
            <AlertDialogDescription>Máy tắt nhóm quảng cáo của mẫu này trên Facebook. Tắt chỉ làm GIẢM tiền; lượt tắt ghi tên bạn vào sổ ghi Facebook của lô.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Huỷ</AlertDialogCancel>
            <AlertDialogAction
              disabled={pending}
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault();
                tat();
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Tắt ngay
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function Dong({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 text-[13px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "numeric text-right text-[15px] font-bold" : "numeric text-right font-medium"}>{children}</span>
    </div>
  );
}

/**
 * CHO TIÊU THÊM — hai bước. Hộp xác nhận in ĐÚNG các con số `proposeExtension()` trả về; nút xác
 * nhận gửi lại chính các con số đó kèm phiếu, và máy chủ tính lại tất cả trước khi gọi Facebook.
 */
export function ExtendButton({ variantId, slot }: { variantId: string; slot: number }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<ExtensionProposal | null>(null);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();

  const moDeNghi = () =>
    startLoad(async () => {
      const r = await proposeExtension({ variantId });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setP(r);
      setOpen(true);
    });

  const ap = () =>
    startSave(async () => {
      if (!p?.ticket || p.addVnd === null || p.newLifetimeVnd === null || !p.newEndAt) return;
      const r = await applyExtension({ variantId, addVnd: p.addVnd, newLifetimeVnd: p.newLifetimeVnd, newEndAt: p.newEndAt, ticket: p.ticket });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(r.detail);
      setOpen(false);
    });

  return (
    <>
      <Button size="sm" className="h-7 px-2 text-[12px]" onClick={moDeNghi} disabled={loading}>
        {loading ? <Loader2 className="size-3.5 animate-spin" /> : <TrendingUp className="size-3.5" />}
        Cho tiêu thêm
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cho mẫu #{slot} tiêu thêm</DialogTitle>
            <DialogDescription>Máy nâng ngân sách TRỌN ĐỜI và kéo giờ kết thúc của nhóm quảng cáo trên Facebook. Tiêu thêm làm TĂNG tiền nên luôn là một lần bấm riêng.</DialogDescription>
          </DialogHeader>
          {p ? (
            <div className="space-y-3">
              <div className="rounded-lg border px-3 py-1">
                <Dong label="Tiền thêm lượt này" strong>
                  {formatVND(p.addVnd)}
                </Dong>
                <Dong label="Ngân sách trọn đời">
                  {formatVND(p.currentLifetimeVnd)} → {formatVND(p.newLifetimeVnd)}
                </Dong>
                <Dong label="Chạy tới">
                  {vnShortStamp(p.currentEndAt)} → {vnShortStamp(p.newEndAt)}
                </Dong>
                <Dong label="Đã cho thêm hôm nay (toàn shop)">
                  {formatVND(p.extendedTodayVnd)} / {formatVND(p.dailyCapVnd)}
                </Dong>
                <Dong label="Phán quyết hiện tại">{p.verdictLabel}</Dong>
              </div>
              {p.clamped ? <p className="text-[12px] text-muted-foreground">Số tiền đã được kẹp về trần một lượt bấm {formatVND(p.perClickCapVnd)}.</p> : null}
              {p.blocked ? <p className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">Không cho tiêu thêm được: {p.blocked}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Để sau
            </Button>
            <Button onClick={ap} disabled={!p?.ticket || saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <TrendingUp className="size-4" />}
              Cho thêm {p ? formatVND(p.addVnd) : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
