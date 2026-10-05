"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { addNoteAction, deleteNoteAction } from "@/lib/actions/sales-inbox";
import { formatDateTime } from "@/lib/format";
import { NOTE_MAX, type InboxNote } from "@/lib/sales-chatbot/inbox-shared";

/**
 * GHI CHÚ NỘI BỘ (0211): nhân viên ghi cho nhau về khách / hội thoại — KHÁCH KHÔNG THẤY, bot không đọc, không con số nào đọc.
 * Mỗi ghi chú mang tên người viết (máy chủ đọc từ tài khoản). Xoá: người viết hoặc người quản lý chatbot.
 */
export function NotesPanel({ conversationId, notes, canWrite }: { conversationId: string; notes: InboxNote[]; canWrite: boolean }) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const add = async () => {
    const body = text.trim();
    if (!body) return;
    setPending("add");
    try {
      const r = await addNoteAction(conversationId, body);
      if ("error" in r) {
        toast.error(r.error);
        return;
      }
      setText("");
    } finally {
      setPending(null);
    }
  };

  const remove = async (id: string) => {
    setPending(id);
    try {
      const r = await deleteNoteAction(id);
      if ("error" in r) toast.error(r.error);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-1.5 rounded-lg border p-3" data-testid="inbox-notes">
      <p className="font-semibold">
        Ghi chú nội bộ <span className="text-[11px] font-normal text-muted-foreground">— khách không thấy</span>
      </p>
      {notes.length === 0 ? <p className="text-muted-foreground">Chưa có ghi chú.</p> : null}
      <ul className="space-y-1.5">
        {notes.map((n) => (
          <li key={n.id} className="rounded-md bg-amber-50 px-2 py-1.5 dark:bg-amber-950/30">
            <div className="flex items-center justify-between gap-2 text-[10.5px] text-muted-foreground">
              <span>
                {n.author} · {formatDateTime(n.at)}
              </span>
              {n.canDelete ? (
                <button type="button" className="hover:text-destructive" aria-label="Xoá ghi chú" disabled={!!pending} onClick={() => void remove(n.id)}>
                  {pending === n.id ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
                </button>
              ) : null}
            </div>
            <div className="whitespace-pre-wrap break-words">{n.text}</div>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="space-y-1">
          <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={NOTE_MAX} rows={2} placeholder="Ghi cho đồng nghiệp: khách hẹn, lưu ý giao hàng…" aria-label="Ghi chú nội bộ" />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" className="h-7" disabled={!!pending || !text.trim()} onClick={() => void add()}>
              {pending === "add" ? <Loader2 className="size-3 animate-spin" /> : null} Lưu ghi chú
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
