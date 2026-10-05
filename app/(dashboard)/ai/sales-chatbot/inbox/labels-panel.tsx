"use client";

import { useState } from "react";
import { Loader2, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { archiveLabelAction, createLabelAction, setConversationLabelsAction } from "@/lib/actions/sales-inbox";
import { LABEL_COLOR_CLASS, LABEL_COLORS, LABEL_NAME_MAX, type InboxLabel, type LabelColor } from "@/lib/sales-chatbot/inbox-shared";
import { cn } from "@/lib/utils";

/** Một nhãn (chip màu) — dùng chung cho danh sách hội thoại và đầu hội thoại. */
export function LabelChip({ label, className }: { label: InboxLabel; className?: string }) {
  return <span className={cn("inline-flex items-center rounded px-1.5 text-[11px] font-medium", LABEL_COLOR_CLASS[label.color], className)}>{label.name}</span>;
}

const COLOR_NAME: Record<LabelColor, string> = { gray: "Xám", red: "Đỏ", orange: "Cam", amber: "Vàng", green: "Xanh lá", teal: "Xanh ngọc", blue: "Xanh dương", violet: "Tím", pink: "Hồng" };

/**
 * NHÃN CỦA HỘI THOẠI (0211): bấm để mở bộ chọn — tick nhãn có sẵn, hoặc gõ tên mới + chọn màu để tạo ngay (như Pancake). Lưu
 * MỘT lượt cho cả bộ nhãn. Nhãn chỉ để người phân loại / lọc; không phép tính nào đọc.
 */
export function LabelsPanel({ conversationId, labels, allLabels, canEdit, canManage }: { conversationId: string; labels: InboxLabel[]; allLabels: InboxLabel[]; canEdit: boolean; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(labels.map((l) => l.id)));
  const [extra, setExtra] = useState<InboxLabel[]>([]);
  const [name, setName] = useState("");
  const [color, setColor] = useState<LabelColor>("blue");
  const [pending, setPending] = useState<null | "save" | "create" | "archive">(null);
  const [gone, setGone] = useState<Set<string>>(() => new Set());
  const choices = [...allLabels, ...extra.filter((e) => !allLabels.some((a) => a.id === e.id))].filter((l) => !gone.has(l.id));
  // Nhãn đã lưu trữ đang gắn: vẫn hiện (không chọn lại được) để người bấm không tưởng nó biến mất.
  const archived = labels.filter((l) => !choices.some((c) => c.id === l.id));

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    if (!name.trim()) return;
    setPending("create");
    try {
      const r = await createLabelAction({ name, color });
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setExtra((prev) => [...prev, r.label]);
      setPicked((prev) => new Set(prev).add(r.label.id));
      setName("");
      if (r.existed) toast.message(`Nhãn «${r.label.name}» đã có — đã chọn nhãn đó.`);
    } finally {
      setPending(null);
    }
  };

  /** Gỡ nhãn khỏi BỘ NHÃN (người quản lý chatbot) — hội thoại đã gắn vẫn giữ nhãn để đọc lại lịch sử. */
  const archive = async (l: InboxLabel) => {
    if (!window.confirm(`Gỡ nhãn «${l.name}» khỏi bộ nhãn? Hội thoại đã gắn vẫn giữ nhãn này.`)) return;
    setPending("archive");
    try {
      const r = await archiveLabelAction(l.id);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setGone((prev) => new Set(prev).add(l.id));
      toast.success(`Đã gỡ nhãn «${l.name}» khỏi bộ nhãn`);
    } finally {
      setPending(null);
    }
  };

  const save = async () => {
    setPending("save");
    try {
      const r = await setConversationLabelsAction(conversationId, [...picked]);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      toast.success("Đã lưu nhãn");
      setOpen(false);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1" data-testid="inbox-labels">
      {labels.map((l) => (
        <LabelChip key={l.id} label={l} />
      ))}
      {canEdit ? (
        <button type="button" className="inline-flex items-center gap-0.5 rounded border border-dashed px-1.5 text-[11px] text-muted-foreground hover:bg-muted" onClick={() => setOpen((v) => !v)}>
          <Tag className="size-3" /> {labels.length ? "Sửa nhãn" : "Gắn nhãn"}
        </button>
      ) : null}
      {open ? (
        <div className="mt-1 w-full space-y-2 rounded-md border bg-background p-2">
          <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
            {choices.length === 0 ? <span className="text-[12px] text-muted-foreground">Chưa có nhãn nào — tạo nhãn đầu tiên bên dưới.</span> : null}
            {choices.map((l) => (
              <span key={l.id} className="flex items-center gap-0.5">
                <label className="flex cursor-pointer items-center gap-1 text-[12px]">
                  <input type="checkbox" checked={picked.has(l.id)} onChange={() => toggle(l.id)} />
                  <LabelChip label={l} />
                </label>
                {canManage ? (
                  <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`Gỡ nhãn ${l.name} khỏi bộ nhãn`} title="Gỡ khỏi bộ nhãn (người quản lý)" disabled={!!pending} onClick={() => void archive(l)}>
                    <X className="size-3" />
                  </button>
                ) : null}
              </span>
            ))}
            {archived.map((l) => (
              <span key={l.id} className="flex items-center gap-1 text-[12px] text-muted-foreground" title="Nhãn đã gỡ khỏi bộ nhãn — vẫn giữ trên hội thoại này">
                <LabelChip label={l} className="opacity-60" /> (đã gỡ)
              </span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Input className="h-7 w-40 text-[12px]" value={name} maxLength={LABEL_NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder="Nhãn mới…" aria-label="Tên nhãn mới" />
            <select className="h-7 rounded-md border bg-background px-1 text-[12px]" value={color} onChange={(e) => setColor(e.target.value as LabelColor)} aria-label="Màu nhãn">
              {LABEL_COLORS.map((c) => (
                <option key={c} value={c}>
                  {COLOR_NAME[c]}
                </option>
              ))}
            </select>
            <Button size="sm" variant="outline" className="h-7" disabled={!!pending || !name.trim()} onClick={() => void create()}>
              {pending === "create" ? <Loader2 className="size-3 animate-spin" /> : null} Tạo nhãn
            </Button>
          </div>
          <div className="flex justify-end gap-1">
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setOpen(false)}>
              Đóng
            </Button>
            <Button size="sm" className="h-7" disabled={!!pending} onClick={() => void save()}>
              {pending === "save" ? <Loader2 className="size-3 animate-spin" /> : null} Lưu nhãn
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
