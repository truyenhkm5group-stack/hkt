"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { ImagePlus, Loader2, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SectionCard } from "@/components/ui-bits";
import {
  addQuickReplyImagesAction,
  autoLearnQuickRepliesNowAction,
  bulkQuickRepliesAction,
  deleteQuickReplyAction,
  removeQuickReplyImageAction,
  saveQuickReplyAction,
  saveQuickReplyAutoLearnAction,
  saveQuickReplySettingsAction,
  setQuickReplyActiveAction,
  setUpsellQuickReplyAction,
  tryQuickReplyAction,
} from "@/lib/actions/sales-quick-replies";
import { formatDateTime } from "@/lib/format";
import { QUICK_REPLY_AUTO_LEARN, QUICK_REPLY_LIMITS, type QuickReplyAutoLearnRun, type QuickReplySettings } from "@/lib/sales-chatbot/quick-replies-shared";

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
type Filter = "ALL" | "ON" | "OFF" | "LEARNED";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "ALL", label: "Tất cả" },
  { key: "ON", label: "Đang bật" },
  { key: "OFF", label: "Đang tắt" },
  { key: "LEARNED", label: "AI soạn" },
];
const RUN_LABEL: Record<QuickReplyAutoLearnRun["status"], string> = { RUNNING: "đang chạy", OK: "xong", SKIPPED: "bỏ qua", ERROR: "lỗi" };
const EMPTY: Draft = { id: null, title: "", triggers: "", answer: "", active: true };

/**
 * Danh sách câu mẫu + form thêm / sửa + ảnh + «Thử một câu» (khớp chữ, 0 token). Không `router.refresh()` sau action —
 * action đã `revalidatePath`.
 */
/** `shell`: vỏ Chốt Đơn — chỉ đổi CHỮ (không «token» / «ERP»), câu của ERP giữ nguyên. */
export function QuickRepliesManager({ manage, settings, rows, autoLearnRun, shell = false }: { manage: boolean; settings: QuickReplySettings; rows: QuickReplyView[]; autoLearnRun: QuickReplyAutoLearnRun | null; shell?: boolean }) {
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [probe, setProbe] = useState("");
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [cfg, setCfg] = useState(settings);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [learn, setLearn] = useState({ autoLearn: settings.autoLearn, autoActivate: settings.autoActivate });
  const [filter, setFilter] = useState<Filter>("ALL");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());

  const counts = useMemo(
    () => ({ ALL: rows.length, ON: rows.filter((r) => r.active).length, OFF: rows.filter((r) => !r.active).length, LEARNED: rows.filter((r) => r.source === "LEARNED").length }),
    [rows],
  );
  const shown = useMemo(() => rows.filter((r) => (filter === "ON" ? r.active : filter === "OFF" ? !r.active : filter === "LEARNED" ? r.source === "LEARNED" : true)), [rows, filter]);
  // Câu đã chọn mà đã bị xoá / lọc mất thì không còn tính — thao tác chỉ áp lên câu đang thấy.
  const selected = shown.filter((r) => picked.has(r.id));
  const allShown = shown.length > 0 && selected.length === shown.length;
  const toggleOne = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const bulk = (op: "ACTIVATE" | "DEACTIVATE" | "DELETE") => {
    const ids = selected.map((r) => r.id);
    if (!ids.length) return;
    if (op === "DELETE" && !confirm(`Xoá ${ids.length} câu mẫu đã chọn? Không khôi phục được.`)) return;
    act(() => bulkQuickRepliesAction(ids, op), () => setPicked(new Set()));
  };

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
        hint={`Thứ tự mỗi tin khách mà page chưa trả lời: ① khớp chữ với câu mẫu — ${shell ? "không tốn lượt AI" : "0 token"}; ② không khớp ⇒ AI đọc hiểu, chỉ CHỌN câu mẫu — rẻ; ③ không câu nào hợp, hoặc khách đang chốt đơn ⇒ chatbot AI đầy đủ.`}
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

      <SectionCard
        title="Tự nạp câu mẫu"
        hint={`Mỗi ${QUICK_REPLY_AUTO_LEARN.everyMs / 3_600_000} giờ, AI đọc câu khách hỏi ${QUICK_REPLY_AUTO_LEARN.lookbackDays} ngày qua mà chưa câu mẫu nào khớp: thêm cách hỏi vào câu mẫu đã có và soạn câu mẫu mới (kết bằng câu chốt đơn / mời lấy thêm). Mỗi lượt là một lời gọi AI.`}
      >
        <div className="flex flex-wrap items-center gap-6 text-sm" data-testid="quick-reply-auto-learn">
          <label className="flex items-center gap-2">
            <Switch checked={learn.autoLearn} disabled={!manage || pending} onCheckedChange={(v) => setLearn({ ...learn, autoLearn: v })} aria-label="Tự nạp câu mẫu mỗi ngày" />
            Tự nạp mỗi ngày
          </label>
          <label className="flex items-center gap-2">
            <Switch checked={learn.autoActivate} disabled={!manage || pending || !learn.autoLearn} onCheckedChange={(v) => setLearn({ ...learn, autoActivate: v })} aria-label="Bật ngay câu mẫu AI soạn" />
            Bật ngay câu mẫu mới (tắt = chờ duyệt)
          </label>
          {manage ? (
            <>
              <Button size="sm" variant="outline" disabled={pending || (learn.autoLearn === settings.autoLearn && learn.autoActivate === settings.autoActivate)} onClick={() => act(() => saveQuickReplyAutoLearnAction(learn))}>
                Lưu
              </Button>
              <Button size="sm" variant="outline" disabled={pending || autoLearnRun?.status === "RUNNING"} onClick={() => act(() => autoLearnQuickRepliesNowAction())}>
                Nạp ngay
              </Button>
            </>
          ) : null}
        </div>
        {autoLearnRun ? (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="quick-reply-auto-learn-run">
            Lượt gần nhất {formatDateTime(autoLearnRun.at)} · {RUN_LABEL[autoLearnRun.status]}: {autoLearnRun.note}
          </p>
        ) : null}
      </SectionCard>

      <SectionCard title="Thử một câu" hint={shell ? "Chỉ khớp chữ — không gọi AI, không tốn lượt AI. Câu trả lời hiện ra đúng như bot sẽ gửi (số đã đọc từ sổ sản phẩm của shop)." : "Chỉ khớp chữ — không gọi AI, không tốn token. Câu trả lời hiện ra đúng như bot sẽ gửi (số đã đọc từ ERP)."}>
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
        title={`Câu mẫu (${rows.length}/${QUICK_REPLY_LIMITS.entries})`}
        hint={`Giá / tồn / phí ship KHÔNG gõ thẳng: dùng {{giá:SKU}} · {{tồn:SKU}} · {{ship}} — bot đọc ${shell ? "sổ sản phẩm" : "ERP"} lúc gửi; thiếu số thì để AI trả lời. Tối đa ${QUICK_REPLY_LIMITS.images} ảnh / câu. Gợi ý «AI học» luôn tạo ở trạng thái tắt.`}
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
          <>
            <div className="mb-2 flex flex-wrap items-center gap-2 text-sm" data-testid="quick-reply-bulk">
              {FILTERS.map((f) => (
                <Button key={f.key} size="sm" variant={filter === f.key ? "secondary" : "ghost"} className="h-7 text-xs" onClick={() => setFilter(f.key)}>
                  {f.label} ({counts[f.key]})
                </Button>
              ))}
              {manage ? (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={allShown || (selected.length > 0 && "indeterminate")}
                      disabled={pending || shown.length === 0}
                      onCheckedChange={(v) => setPicked(v === true ? new Set(shown.map((r) => r.id)) : new Set())}
                      aria-label="Chọn tất cả câu mẫu đang thấy"
                      data-testid="quick-reply-select-all"
                    />
                    Chọn tất cả ({shown.length})
                  </label>
                  <span className="text-xs text-muted-foreground">đã chọn {selected.length}</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending || !selected.length} onClick={() => bulk("ACTIVATE")}>
                    Bật
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={pending || !selected.length} onClick={() => bulk("DEACTIVATE")}>
                    Tắt
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 text-xs text-destructive" disabled={pending || !selected.length} onClick={() => bulk("DELETE")}>
                    Xoá
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="divide-y text-sm" data-testid="quick-reply-list">
              {shown.map((r) => (
                <div key={r.id} className="flex flex-col gap-2 py-3 lg:flex-row lg:items-start">
                  {manage ? (
                    <Checkbox checked={picked.has(r.id)} disabled={pending} onCheckedChange={(v) => toggleOne(r.id, v === true)} aria-label={`Chọn câu mẫu ${r.title}`} className="mt-1" />
                  ) : null}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <b>{r.title}</b>
                      {r.source === "LEARNED" ? <Badge variant="secondary">AI học</Badge> : null}
                      {r.needsEdit ? <Badge variant="destructive">Sửa giá trước khi bật</Badge> : null}
                      {settings.upsellReplyId === r.id ? <Badge data-testid="upsell-badge">Câu upsell</Badge> : null}
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
                      {/*
                        HAI CÔNG TẮC, MỖI CÁI MỘT NHÃN (chủ shop HSLC 09/10/2026): trước đây chữ bấm «Dùng làm câu upsell» đứng sát
                        công tắc bật / tắt câu mẫu nên trông như nhãn của nó — gạt công tắc tưởng là chọn upsell, thực ra là bật câu.
                      */}
                      <label className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs" title="Bot gửi câu này (kèm ảnh menu) ở bước upsell / cross-sell — đúng một lần mỗi hội thoại. Chỉ một câu được chọn.">
                        <Switch
                          checked={settings.upsellReplyId === r.id}
                          disabled={pending || (!r.active && settings.upsellReplyId !== r.id)}
                          onCheckedChange={(v) => act(() => setUpsellQuickReplyAction(v ? r.id : null))}
                          aria-label={`Câu upsell: ${r.title}`}
                          data-testid="upsell-switch"
                        />
                        Câu upsell
                      </label>
                      <label className="flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs" title="Bật thì bot được dùng câu này để trả lời khách">
                        <Switch checked={r.active} disabled={pending || (r.needsEdit && !r.active)} onCheckedChange={(v) => act(() => setQuickReplyActiveAction(r.id, v))} aria-label={`Bật câu mẫu ${r.title}`} />
                        {r.active ? "Đang bật" : "Đang tắt"}
                      </label>
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
          </>
        )}
      </SectionCard>
    </div>
  );
}
