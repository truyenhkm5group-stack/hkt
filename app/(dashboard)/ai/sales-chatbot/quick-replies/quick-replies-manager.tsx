"use client";

import { useRef, useState, useTransition } from "react";
import { ImagePlus, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import {
  addQuickReplyImagesAction,
  deleteQuickReplyAction,
  removeQuickReplyImageAction,
  saveQuickReplyAction,
  saveQuickReplySettingsAction,
  setQuickReplyActiveAction,
  tryQuickReplyAction,
} from "@/lib/actions/sales-quick-replies";
import { formatDateTime } from "@/lib/format";
import { QUICK_REPLY_LIMITS, type QuickReplySettings } from "@/lib/sales-chatbot/quick-replies-shared";

export type QuickReplyView = {
  id: string;
  title: string;
  triggers: string[];
  answer: string;
  active: boolean;
  source: "MANUAL" | "LEARNED";
  uses: number;
  lastUsedAt: string | null;
  updatedAt: string;
  images: { id: string; contentType: string; bytes: number }[];
  needsEdit: boolean;
};

type Draft = { id: string | null; title: string; triggers: string; answer: string; active: boolean };
const EMPTY: Draft = { id: null, title: "", triggers: "", answer: "", active: true };

/**
 * Danh sách câu mẫu + form thêm / sửa + ảnh + «Thử một câu» (khớp chữ, 0 token). Không `router.refresh()` sau action —
 * action đã `revalidatePath`.
 */
export function QuickRepliesManager({ manage, settings, rows }: { manage: boolean; settings: QuickReplySettings; rows: QuickReplyView[] }) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [cfg, setCfg] = useState(settings);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);

  const act = (fn: () => Promise<{ ok: true; message: string } | { error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.message);
        after?.();
      }
    });

  const upload = (files: FileList | null) => {
    if (!files?.length || !uploadFor) return;
    const form = new FormData();
    form.set("id", uploadFor);
    for (const f of Array.from(files)) form.append("files", f);
    act(() => addQuickReplyImagesAction(form), () => {
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  return (
    <div className="space-y-5">
      <SectionCard
        title="Cách trả lời"
        hint="Thứ tự mỗi tin khách mà page chưa trả lời: ① khớp chữ với câu mẫu — 0 token; ② không khớp ⇒ AI đọc hiểu, chỉ CHỌN câu mẫu — rẻ; ③ không câu nào hợp, hoặc khách đang chốt đơn ⇒ chatbot AI đầy đủ."
      >
        <div className="flex flex-wrap items-center gap-6 text-sm" data-testid="quick-reply-settings">
          <label className="flex items-center gap-2">
            <Switch checked={cfg.enabled} disabled={!manage || pending} onCheckedChange={(v) => setCfg({ ...cfg, enabled: v })} aria-label="Dùng câu trả lời mẫu" />
            Dùng câu trả lời mẫu
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={cfg.aiMatch} disabled={!manage || pending || !cfg.enabled} onCheckedChange={(v) => setCfg({ ...cfg, aiMatch: v })} aria-label="AI đọc hiểu để chọn câu mẫu" />
            AI đọc hiểu câu khó để chọn câu mẫu
          </label>
          {manage ? (
            <Button size="sm" variant="outline" disabled={pending || (cfg.enabled === settings.enabled && cfg.aiMatch === settings.aiMatch)} onClick={() => act(() => saveQuickReplySettingsAction(cfg))}>
              Lưu
            </Button>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard title="Thử một câu" hint="Chỉ khớp chữ — không gọi AI, không tốn token. Câu trả lời hiện ra đúng như bot sẽ gửi (số đã đọc từ ERP).">
        <div className="flex flex-wrap items-start gap-2 text-sm">
          <Input value={probe} onChange={(e) => setProbe(e.target.value)} placeholder="vd: chả mực bao nhiêu 1kg" className="h-8 max-w-md" aria-label="Câu khách thử" />
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !probe.trim() || !manage}
            onClick={() =>
              start(async () => {
                const r = await tryQuickReplyAction(probe);
                if ("error" in r) toast.error(r.error);
                else setProbeResult(r.result);
              })
            }
          >
            Thử
          </Button>
          {probeResult ? (
            <pre className="w-full whitespace-pre-wrap rounded-md bg-muted px-3 py-2 text-xs" data-testid="quick-reply-probe">
              {probeResult}
            </pre>
          ) : null}
        </div>
      </SectionCard>

      <SectionCard
        title={`Câu mẫu (${rows.length})`}
        hint={`Giá / tồn / phí ship KHÔNG gõ thẳng: dùng {{giá:SKU}} · {{tồn:SKU}} · {{ship}} — bot đọc ERP lúc gửi; thiếu số thì để AI trả lời. Tối đa ${QUICK_REPLY_LIMITS.images} ảnh / câu. Gợi ý «AI học» luôn tạo ở trạng thái tắt.`}
        actions={
          manage ? (
            <Button size="sm" onClick={() => setDraft(EMPTY)} disabled={pending}>
              <Plus className="size-4" /> Thêm câu mẫu
            </Button>
          ) : null
        }
      >
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => upload(e.target.files)} />
        {draft ? (
          <div className="mb-4 space-y-2 rounded-xl border p-3 text-sm" data-testid="quick-reply-form">
            <Input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Tên câu hỏi — vd: Hỏi giá chả mực" aria-label="Tên câu hỏi" className="h-8" />
            <Textarea value={draft.triggers} onChange={(e) => setDraft({ ...draft, triggers: e.target.value })} rows={4} placeholder={"Câu khách hay hỏi — mỗi dòng một câu\nchả mực bao nhiêu\ngiá chả mực"} aria-label="Câu khách hay hỏi" />
            <Textarea value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} rows={5} placeholder={"Dạ chả mực giã tay bên em {{giá:CHA-MUC-GIA-TAY}}/kg ạ…"} aria-label="Câu trả lời" />
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs">
                <Switch checked={draft.active} onCheckedChange={(v) => setDraft({ ...draft, active: v })} aria-label="Bật ngay" /> Bật ngay
              </label>
              <Button size="sm" disabled={pending} onClick={() => act(() => saveQuickReplyAction(draft), () => setDraft(null))}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : null} Lưu
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDraft(null)}>
                Huỷ
              </Button>
            </div>
          </div>
        ) : null}
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có câu mẫu. Thêm tay, hoặc chạy «Học từ hội thoại cũ» ở trang Chatbot bán hàng để AI gợi ý từ lịch sử fanpage.</p>
        ) : (
          <div className="divide-y text-sm" data-testid="quick-reply-list">
            {rows.map((r) => (
              <div key={r.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <b>{r.title}</b>
                    {r.source === "LEARNED" ? <Badge variant="secondary">AI học</Badge> : null}
                    {r.needsEdit ? <Badge variant="destructive">Sửa giá trước khi bật</Badge> : null}
                    <span className="text-xs text-muted-foreground">
                      dùng {r.uses} lần{r.lastUsedAt ? ` · gần nhất ${formatDateTime(r.lastUsedAt)}` : ""}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">Khách hỏi: {r.triggers.join(" · ")}</p>
                  <p className="whitespace-pre-wrap">{r.answer}</p>
                  {r.images.length ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {r.images.map((img) => (
                        <div key={img.id} className="relative">
                          {/* eslint-disable-next-line @next/next/no-img-element -- ảnh trong CSDL, đi qua route có kiểm quyền */}
                          <img src={`/api/ai-sales/quick-reply-images/${img.id}`} alt="" className="size-16 rounded-md border object-cover" />
                          {manage ? (
                            <button type="button" className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 shadow" aria-label="Gỡ ảnh" disabled={pending} onClick={() => act(() => removeQuickReplyImageAction(img.id))}>
                              <X className="size-3" />
                            </button>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                {manage ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch checked={r.active} disabled={pending || (r.needsEdit && !r.active)} onCheckedChange={(v) => act(() => setQuickReplyActiveAction(r.id, v))} aria-label={`Bật câu mẫu ${r.title}`} />
                    <Button size="icon" variant="ghost" className="size-8" title="Thêm ảnh" disabled={pending || r.images.length >= QUICK_REPLY_LIMITS.images} onClick={() => { setUploadFor(r.id); fileRef.current?.click(); }}>
                      <ImagePlus className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" title="Sửa" disabled={pending} onClick={() => setDraft({ id: r.id, title: r.title, triggers: r.triggers.join("\n"), answer: r.answer, active: r.active })}>
                      <Pencil className="size-4" />
                    </Button>
                    <Button size="icon" variant="ghost" className="size-8" title="Xoá" disabled={pending} onClick={() => { if (confirm(`Xoá câu mẫu «${r.title}»?`)) act(() => deleteQuickReplyAction(r.id)); }}>
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
