"use client";

import { useState, useTransition } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  cancelSourcingTrialAction,
  markSourcingTrialOrderedAction,
  markSourcingTrialReceivedAction,
  requestSourcingTrialAction,
  saveOfferToShortlistAction,
  type TrialResult,
} from "@/lib/actions/sourcing-trials";

function useAction() {
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<TrialResult>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast.success(r.message);
      else toast.error(r.errors[0]?.message ?? "Không lưu được.");
    });
  return { pending, run };
}

export function SaveShortlistButton({ offerId }: { offerId: string }) {
  const { pending, run } = useAction();
  return (
    <Button disabled={pending} onClick={() => run(() => saveOfferToShortlistAction({ offerId }))} data-save-shortlist>
      {pending ? <Loader2 className="size-4 animate-spin" /> : null}
      Lưu mẫu (cấp mã TEST-)
    </Button>
  );
}

type Line = { color: string; size: string; qty: string };

export function TrialRequestForm({ offerId, colors, sizes }: { offerId: string; colors: string[]; sizes: string[] }) {
  const [lines, setLines] = useState<Line[]>([{ color: colors[0] ?? "", size: sizes[0] ?? "", qty: "" }]);
  const { pending, run } = useAction();
  const set = (i: number, patch: Partial<Line>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const total = lines.reduce((s, l) => s + (/^\d+$/.test(l.qty.trim()) ? Number(l.qty.trim()) : 0), 0);
  return (
    <div className="space-y-3 text-sm" data-trial-request-form>
      {lines.map((l, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <Input className="w-40" aria-label={`Dòng ${i + 1}: màu`} placeholder="màu" value={l.color} onChange={(e) => set(i, { color: e.target.value })} list="src-trial-colors" />
          <Input className="w-28" aria-label={`Dòng ${i + 1}: cỡ`} placeholder="cỡ" value={l.size} onChange={(e) => set(i, { size: e.target.value })} list="src-trial-sizes" />
          <Input className="w-24" aria-label={`Dòng ${i + 1}: số lượng`} inputMode="numeric" placeholder="số lượng" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
          {lines.length > 1 ? (
            <Button type="button" size="icon" variant="ghost" aria-label={`Xoá dòng ${i + 1}`} onClick={() => setLines(lines.filter((_, j) => j !== i))}>
              <Trash2 className="size-4" />
            </Button>
          ) : null}
        </div>
      ))}
      <datalist id="src-trial-colors">
        {colors.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
      <datalist id="src-trial-sizes">
        {sizes.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setLines([...lines, { color: "", size: "", qty: "" }])}>
          <Plus className="size-4" />
          Thêm dòng
        </Button>
        <span className="text-xs text-muted-foreground">Tổng: {total} cái</span>
      </div>
      <Button
        disabled={pending || total < 1}
        onClick={() => run(() => requestSourcingTrialAction({ offerId, lines: lines.map((l) => ({ color: l.color, size: l.size, qty: /^\d+$/.test(l.qty.trim()) ? Number(l.qty.trim()) : 0 })) }))}
      >
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Xin duyệt mua thử
      </Button>
      <p className="text-xs text-muted-foreground">ERP chụp lại bậc giá, MOQ, cân nặng và giá về Việt Nam ước tính NGAY LÚC XIN — người duyệt thấy đúng con số đó. ERP không đặt hàng, không thanh toán, không liên hệ nhà cung cấp.</p>
    </div>
  );
}

function NoteAction({ label, field, placeholder, onRun, variant = "default" }: { label: string; field: string; placeholder: string; onRun: (v: string) => Promise<TrialResult>; variant?: "default" | "outline" }) {
  const [v, setV] = useState("");
  const { pending, run } = useAction();
  return (
    <div className="grid gap-2 text-sm md:grid-cols-[1fr_auto] md:items-end">
      <div className="space-y-1">
        <Label htmlFor={`src-trial-${field}`}>{placeholder}</Label>
        <Input id={`src-trial-${field}`} value={v} maxLength={1000} onChange={(e) => setV(e.target.value)} />
      </div>
      <Button variant={variant} disabled={pending} onClick={() => run(() => onRun(v))}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        {label}
      </Button>
    </div>
  );
}

export function MarkOrderedForm({ trialId }: { trialId: string }) {
  return <NoteAction label="Đánh dấu đã đặt (ngoài ERP)" field="order" placeholder="Ghi chú đặt hàng (nơi đặt, mã đơn bên nhà cung cấp…)" onRun={(note) => markSourcingTrialOrderedAction({ trialId, note })} />;
}

export function MarkReceivedForm({ trialId }: { trialId: string }) {
  const [receiptId, setReceiptId] = useState("");
  const [note, setNote] = useState("");
  const { pending, run } = useAction();
  return (
    <div className="grid gap-2 text-sm md:grid-cols-3 md:items-end" data-mark-received-form>
      <div className="space-y-1">
        <Label htmlFor="src-trial-receipt">Mã phiếu nhập (nếu đã lập)</Label>
        <Input id="src-trial-receipt" value={receiptId} onChange={(e) => setReceiptId(e.target.value)} placeholder="không bắt buộc" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="src-trial-receive-note">Ghi chú</Label>
        <Input id="src-trial-receive-note" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button disabled={pending} onClick={() => run(() => markSourcingTrialReceivedAction({ trialId, receiptId, note }))}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Đánh dấu hàng đã về
      </Button>
    </div>
  );
}

export function CancelTrialForm({ trialId }: { trialId: string }) {
  return <NoteAction label="Huỷ yêu cầu" field="cancel" placeholder="Lý do huỷ *" variant="outline" onRun={(reason) => cancelSourcingTrialAction({ trialId, reason })} />;
}
