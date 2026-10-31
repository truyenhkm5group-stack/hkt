"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Copy, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { saveMessageTemplatesAction } from "@/lib/actions/wholesale";
import type { MessageTemplate } from "@/lib/wholesale/config";

/**
 * Khung MẪU NỘI DUNG (tab Liên hệ, 30/10/2026): danh sách có ô chọn · Sao chép · Sửa · Xoá · Thêm · Lưu mẫu. Hai mẫu gốc là
 * câu mở Zalo và lời chào đã có trong cấu hình (sửa được, không xoá được — máy soạn lời chào dựa vào chúng); các mẫu thêm là
 * chữ để NHÂN VIÊN sao chép khi nhắn / gửi thư tay. Không có «spin» nội dung, không có gửi hàng loạt — Zalo vẫn là người bấm
 * mở từng khách.
 */

type Row = { id: string; label: string; body: string; channel: MessageTemplate["channel"]; builtin?: "ZALO" | "OPENER" };

const CHANNEL_LABEL: Record<MessageTemplate["channel"], string> = { ZALO: "Zalo", EMAIL: "Email", ANY: "Mọi kênh" };

export function TemplatesPanel({ zaloTemplate, openerTemplate, extraTemplates, canEdit }: { zaloTemplate: string; openerTemplate: string; extraTemplates: MessageTemplate[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rows, setRows] = useState<Row[]>([
    { id: "__zalo", label: "Câu mở Zalo (máy dùng khi soạn tin Zalo)", body: zaloTemplate, channel: "ZALO", builtin: "ZALO" },
    { id: "__opener", label: "Lời chào (soạn tay / AI)", body: openerTemplate, channel: "ANY", builtin: "OPENER" },
    ...extraTemplates.map((t) => ({ ...t })),
  ]);
  const [picked, setPicked] = useState<string[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const patch = (id: string, p: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
    setDirty(true);
  };
  const remove = (ids: string[]) => {
    setRows((rs) => rs.filter((r) => r.builtin || !ids.includes(r.id)));
    setPicked([]);
    setDirty(true);
  };
  const add = () => {
    const id = `t${Date.now().toString(36)}`;
    setRows((rs) => [...rs, { id, label: "Mẫu mới", body: "", channel: "ANY" }]);
    setEditing(id);
    setDirty(true);
  };
  const copy = async (r: Row) => {
    try {
      await navigator.clipboard.writeText(r.body);
      toast.success(`Đã sao chép «${r.label}»`);
    } catch {
      toast.error("Trình duyệt chặn sao chép — bôi đen nội dung rồi Ctrl+C.");
    }
  };
  const save = () =>
    start(async () => {
      const zalo = rows.find((r) => r.builtin === "ZALO")!;
      const opener = rows.find((r) => r.builtin === "OPENER")!;
      const r = await saveMessageTemplatesAction({ zaloTemplate: zalo.body, openerTemplate: opener.body, extraTemplates: rows.filter((x) => !x.builtin).map(({ id, label, body, channel }) => ({ id, label, body, channel })) });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu mẫu nội dung");
        setDirty(false);
        setEditing(null);
        router.refresh();
      }
    });
  const deletable = picked.filter((id) => !rows.find((r) => r.id === id)?.builtin);

  return (
    <div className="space-y-2">
      {canEdit ? (
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={add} disabled={pending}>
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Thêm
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive" onClick={() => remove(deletable)} disabled={pending || !deletable.length}>
            <Trash2 className="mr-1 h-3.5 w-3.5" aria-hidden /> Xoá đã chọn ({deletable.length})
          </Button>
          <Button size="sm" onClick={save} disabled={pending || !dirty}>
            Lưu mẫu
          </Button>
          {dirty ? <span className="self-center text-[11px] text-amber-700 dark:text-amber-300">Có thay đổi chưa lưu</span> : null}
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground">Chỉ người cấu hình sửa được mẫu — bạn vẫn sao chép được.</p>
      )}
      <ul className="divide-y rounded-lg border">
        {rows.map((r) => {
          const isEditing = canEdit && editing === r.id;
          return (
            <li key={r.id} className="space-y-1 p-2">
              <div className="flex items-start gap-2">
                {canEdit ? <input type="checkbox" className="mt-1" aria-label={`Chọn ${r.label}`} checked={picked.includes(r.id)} disabled={Boolean(r.builtin)} onChange={() => setPicked((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]))} /> : null}
                <div className="min-w-0 flex-1">
                  {isEditing && !r.builtin ? (
                    <div className="flex flex-wrap gap-2">
                      <Input className="h-8 max-w-xs" value={r.label} onChange={(e) => patch(r.id, { label: e.target.value })} aria-label="Tên mẫu" />
                      <select className="h-8 rounded-md border bg-background px-2 text-xs" value={r.channel} onChange={(e) => patch(r.id, { channel: e.target.value as Row["channel"] })} aria-label="Kênh">
                        {(Object.keys(CHANNEL_LABEL) as Row["channel"][]).map((c) => (
                          <option key={c} value={c}>
                            {CHANNEL_LABEL[c]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <div className="text-sm font-medium">
                      {r.label} <span className="text-[11px] font-normal text-muted-foreground">· {CHANNEL_LABEL[r.channel]}{r.builtin ? " · mẫu gốc" : ""}</span>
                    </div>
                  )}
                  {isEditing ? <Textarea className="mt-1 text-xs" rows={4} value={r.body} onChange={(e) => patch(r.id, { body: e.target.value })} aria-label="Nội dung mẫu" /> : <p className="line-clamp-2 whitespace-pre-line text-xs text-muted-foreground">{r.body || "—"}</p>}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="icon" variant="ghost" className="h-7 w-7" title="Sao chép" aria-label={`Sao chép ${r.label}`} onClick={() => copy(r)} disabled={!r.body}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  {canEdit ? (
                    <Button size="icon" variant="ghost" className="h-7 w-7" title={isEditing ? "Xong" : "Sửa"} aria-label={`Sửa ${r.label}`} onClick={() => setEditing(isEditing ? null : r.id)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                  {canEdit && !r.builtin ? (
                    <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" title="Xoá" aria-label={`Xoá ${r.label}`} onClick={() => remove([r.id])}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">Biến trong {"{{…}}"} (tên doanh nghiệp, tên nhân viên, khu vực…) được máy điền khi soạn lời chào cho từng lead.</p>
    </div>
  );
}
