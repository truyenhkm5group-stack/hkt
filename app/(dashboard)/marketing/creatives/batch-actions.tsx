"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCheck, Loader2, XCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { approveBatch, proposeBatchApproval, rejectBatch, rejectVariant, type BatchApprovalProposal } from "@/lib/actions/creative";
import { formatNumber, formatVND, vnShortStamp } from "@/lib/format";

/**
 * Ba nút của tab Duyệt lô. Mọi con số trong hộp xác nhận là con số `proposeBatchApproval()` TRẢ VỀ
 * — màn hình không tự tính lại một con số tiền nào (tính hai nơi là hai con số).
 */

function Dong({ label, children, strong }: { label: string; children: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-hairline py-1.5 text-[13px] last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={strong ? "numeric text-right text-[15px] font-bold" : "numeric text-right font-medium"}>{children}</span>
    </div>
  );
}

/** DUYỆT CẢ LÔ — bước 1 đề nghị (chỉ đọc), bước 2 gửi lại phiếu. */
export function ApproveBatchButton({ batchId, disabledReason }: { batchId: string; disabledReason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<BatchApprovalProposal | null>(null);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();

  const moDeNghi = () =>
    startLoad(async () => {
      const r = await proposeBatchApproval(batchId);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setP(r);
      setOpen(true);
    });

  const duyet = () =>
    startSave(async () => {
      if (!p?.ticket) return;
      const r = await approveBatch({ batchId, ticket: p.ticket });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã duyệt lô — máy sẽ đăng trước giờ chạy.");
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button onClick={moDeNghi} disabled={!!disabledReason || loading} title={disabledReason ?? undefined} className="font-bold">
        {loading ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
        DUYỆT CẢ LÔ
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Duyệt lô chạy ngày {p?.batchDay ?? "—"}</DialogTitle>
            <DialogDescription>Duyệt là cho phép máy cam kết đúng số tiền dưới đây trên Facebook, trong đúng khung giờ này, và tắt mẫu theo đúng các luật này — không hỏi lại.</DialogDescription>
          </DialogHeader>
          {p ? (
            <div className="space-y-3">
              <div className="rounded-lg border px-3 py-1">
                <Dong label="Tổng tiền cam kết nếu duyệt" strong>
                  {formatVND(p.totalVnd)}
                </Dong>
                <Dong label="Số mẫu sẽ chạy">
                  {formatNumber(p.publishCount)} / {formatNumber(p.variantCount)} mẫu có ảnh × {formatVND(p.budgetPerVariantVnd)}
                </Dong>
                <Dong label="Khung chạy">
                  {vnShortStamp(p.startAt)} → {vnShortStamp(p.endAt)}
                </Dong>
                <Dong label="Hạn duyệt">{vnShortStamp(p.approvalDeadline)}</Dong>
                <Dong label="Tài khoản · chiến dịch test">
                  <span className="text-[12px]">
                    act_{p.adAccountId || "—"} · {p.testCampaignId || "—"}
                  </span>
                </Dong>
                <Dong label="Fanpage">{p.pageId || "—"}</Dong>
              </div>

              <div className="rounded-lg border px-3 py-2 text-[12.5px]">
                <p className="font-semibold">Luật tắt đi kèm lô</p>
                {p.killRules.length ? (
                  <>
                    <p className="text-muted-foreground">Duyệt = cho phép máy tắt mẫu theo các luật này, không cần hỏi lại.</p>
                    <ul className="mt-1 list-disc pl-5">
                      {p.killRules.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="text-warning">Lô này không có luật tắt — mỗi mẫu sẽ chạy hết ngân sách.</p>
                )}
              </div>

              {p.blockers.length ? (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
                  <p className="font-semibold">Cổng sẽ chặn — chưa duyệt được:</p>
                  <ul className="mt-1 list-disc pl-5">
                    {p.blockers.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {p.warnings.length ? (
                <ul className="list-disc rounded-lg border border-warning/40 bg-warning/5 py-2 pl-8 pr-3 text-[12.5px]">
                  {p.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Để sau
            </Button>
            <Button onClick={duyet} disabled={!p?.ticket || saving} title={p && !p.ticket ? "Cổng đang chặn — xem lý do ở trên" : undefined}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
              Duyệt {p ? formatVND(p.totalVnd) : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Từ chối cả lô — bắt buộc ghi lý do. */
export function RejectBatchButton({ batchId, disabledReason }: { batchId: string; disabledReason: string | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const gui = () =>
    start(async () => {
      const r = await rejectBatch({ batchId, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã từ chối lô — không đồng nào được chi.");
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)} disabled={!!disabledReason} title={disabledReason ?? undefined}>
        <XCircle className="size-4" />
        Từ chối cả lô
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Từ chối cả lô</DialogTitle>
            <DialogDescription>Lô sẽ không chạy và không đồng nào được chi. Lý do được lưu vào nhật ký để lần sau máy dựng lô người đọc được.</DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Vì sao từ chối? (bắt buộc)" rows={3} maxLength={1000} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button variant="destructive" onClick={gui} disabled={!reason.trim() || pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Từ chối
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Gạt một mẫu khỏi lô đang chờ duyệt — hỏi lý do ngắn (không bắt buộc). Mọi phiếu đã phát cho lô tự vô hiệu. */
export function RejectVariantButton({ variantId, slot }: { variantId: string; slot: number }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const gui = () =>
    start(async () => {
      const r = await rejectVariant({ variantId, reason });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success(`Đã gạt mẫu #${slot} khỏi lô.`);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-[12px] text-muted-foreground hover:text-destructive" onClick={() => setOpen(true)}>
        <X className="size-3.5" />
        Gạt khỏi lô
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Gạt mẫu #{slot} khỏi lô</DialogTitle>
            <DialogDescription>Mẫu bị gạt không đăng, không tốn tiền. Gen và lý do vẫn được giữ để máy biết người không ưng gì.</DialogDescription>
          </DialogHeader>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do ngắn (vd: sai màu, chữ lỗi)" maxLength={200} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Huỷ
            </Button>
            <Button variant="destructive" onClick={gui} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Gạt khỏi lô
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
