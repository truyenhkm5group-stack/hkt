"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { bulkEmailPrepareAction, bulkEmailSubmitAction } from "@/lib/actions/wholesale-bulk";
import type { BulkEmailItem, BulkEmailPrep, BulkEmailResult } from "@/lib/wholesale/bulk-outreach";
import { cn } from "@/lib/utils";

/**
 * Soạn email cá nhân hoá cho 1…N khách (nút «Email» trên dòng và hành động hàng loạt «Soạn email cho N khách»).
 * Ba bước: chọn nguồn nội dung (mẫu thay biến · AI soạn nháp) → DUYỆT từng thư (phải mở xem thư rồi mới tích được; sửa tiêu
 * đề / nội dung; bỏ chọn thư không muốn; lead không đi được email hiện lý do) → đưa vào Hộp thư đi. Kết quả in thư nào xếp gửi,
 * thư nào chỉ vào chờ duyệt, thư nào lỗi, và lý do cổng chính sách SẼ chặn — không thư nào bị bỏ âm thầm.
 */

export type TemplateOption = { id: string; label: string };
type Edit = { subject: string; body: string; viewed: boolean; checked: boolean };

const SUBJECT_DEFAULT = "Bảng giá sỉ {{san_pham}} cho {{ten_doanh_nghiep}} — {{ten_shop}}";

export function BulkEmailDialog({ leadIds, templates, aiEnabled, open, onOpenChange, onDone }: { leadIds: string[]; templates: TemplateOption[]; aiEnabled: boolean; open: boolean; onOpenChange: (v: boolean) => void; onDone?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [source, setSource] = useState<"TEMPLATE" | "AI">("TEMPLATE");
  const [templateId, setTemplateId] = useState("__opener");
  const [subjectTemplate, setSubjectTemplate] = useState(SUBJECT_DEFAULT);
  const [prep, setPrep] = useState<BulkEmailPrep | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<{ results: BulkEmailResult[]; eta: string; dryRun: boolean } | null>(null);

  const ok = (prep?.items ?? []).filter((i) => !i.refusal);
  const approved = ok.filter((i) => edits[i.leadId]?.checked && edits[i.leadId]?.viewed);
  const names = Object.fromEntries((prep?.items ?? []).map((i) => [i.leadId, i.name]));

  const build = () =>
    start(async () => {
      const r = await bulkEmailPrepareAction({ leadIds, source, templateId, subjectTemplate });
      if ("error" in r) return void toast.error(r.error);
      const first = r.prep.items.find((i) => !i.refusal)?.leadId ?? null;
      setPrep(r.prep);
      // Thư đầu tiên mở sẵn (đã xem); các thư khác phải bấm mở mới tích duyệt được.
      setEdits(Object.fromEntries(r.prep.items.filter((i) => !i.refusal).map((i) => [i.leadId, { subject: i.subject, body: i.body, viewed: i.leadId === first, checked: true }])));
      setOpenId(first);
    });
  const submit = (approve: boolean) =>
    start(async () => {
      const list = approve ? approved : ok.filter((i) => edits[i.leadId]?.checked);
      if (!list.length) return void toast.error(approve ? "Chưa có thư nào đã mở xem và được tích." : "Chưa chọn thư nào.");
      const r = await bulkEmailSubmitAction({ items: list.map((i: BulkEmailItem) => ({ leadId: i.leadId, subject: edits[i.leadId]!.subject, body: edits[i.leadId]!.body, aiDraftId: i.aiDraftId, approve })) });
      if ("error" in r) return void toast.error(r.error);
      setDone(r);
      router.refresh();
      onDone?.();
    });
  const toggleOpen = (id: string) => {
    setOpenId(openId === id ? null : id);
    setEdits((e) => ({ ...e, [id]: { ...e[id]!, viewed: true } }));
  };
  const patch = (id: string, p: Partial<Edit>) => setEdits((e) => ({ ...e, [id]: { ...e[id]!, ...p } }));
  const reset = () => {
    setPrep(null);
    setDone(null);
    setEdits({});
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Soạn email cho {leadIds.length} khách</DialogTitle>
          <DialogDescription>Nội dung cá nhân hoá từng khách → bạn mở xem và duyệt từng thư → vào Hộp thư đi (cổng chính sách · đồng ý · nước đã rà vẫn áp; nhịp gửi theo hạn mức của hộp thư đi).</DialogDescription>
        </DialogHeader>

        {done ? (
          <div className="space-y-2 text-sm">
            <div className="rounded-md border bg-muted/30 p-2">
              <b>{done.results.filter((r) => r.status === "QUEUED").length}</b> thư đã duyệt & xếp gửi · <b>{done.results.filter((r) => r.status === "DRAFT").length}</b> thư chờ duyệt ở Hộp thư đi · <b>{done.results.filter((r) => r.status === "ERROR").length}</b> lỗi.
              <div className="text-xs text-muted-foreground">
                {done.eta}
                {done.dryRun ? " Hộp thư đi đang CHẠY THỬ — thư không rời ERP." : ""}
              </div>
            </div>
            <ul className="divide-y rounded-md border">
              {done.results.map((r) => (
                <li key={r.leadId} className="p-2 text-xs">
                  <span className={cn("mr-2 rounded px-1.5 py-0.5 font-medium", r.status === "QUEUED" ? "bg-emerald-100 text-emerald-800" : r.status === "DRAFT" ? "bg-amber-100 text-amber-800" : "bg-rose-100 text-rose-800")}>{r.status === "QUEUED" ? "Xếp gửi" : r.status === "DRAFT" ? "Chờ duyệt" : "Lỗi"}</span>
                  <b>{names[r.leadId] ?? r.leadId}</b>
                  {r.error ? <div className="mt-0.5 text-rose-700 dark:text-rose-300">{r.error}</div> : null}
                  {r.warnings.length ? <div className="mt-0.5 text-amber-700 dark:text-amber-300">Cổng sẽ chặn: {r.warnings.join(" · ")}</div> : null}
                </li>
              ))}
            </ul>
            <Button size="sm" variant="outline" asChild>
              <Link href="/wholesale/outbox">Mở Hộp thư đi</Link>
            </Button>
          </div>
        ) : !prep ? (
          <div className="space-y-3 text-sm">
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-2">
                <input type="radio" name="src" checked={source === "TEMPLATE"} onChange={() => setSource("TEMPLATE")} /> Mẫu nội dung (thay biến theo từng khách)
              </label>
              <label className={cn("flex items-center gap-2", !aiEnabled && "text-muted-foreground")} title={aiEnabled ? undefined : "AI soạn email đang TẮT — bật ở Hộp thư đi (kèm trần số nháp và chi phí / ngày)"}>
                <input type="radio" name="src" disabled={!aiEnabled} checked={source === "AI"} onChange={() => setSource("AI")} /> AI soạn nháp {aiEnabled ? "(trong trần nháp / ngày)" : "(đang tắt)"}
              </label>
            </div>
            {source === "TEMPLATE" ? (
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-xs font-medium text-muted-foreground">
                  Mẫu thân thư
                  <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-medium text-muted-foreground">
                  Tiêu đề (có biến)
                  <Input value={subjectTemplate} onChange={(e) => setSubjectTemplate(e.target.value)} />
                </label>
                <p className="text-[11px] text-muted-foreground md:col-span-2">Biến: {"{{ten_doanh_nghiep}} {{thanh_pho}} {{loai_hinh}} {{khu_vuc}} {{san_pham}} {{ten_shop}} {{moq}} {{giao_hang}} {{khuyen_mai}}"} — sửa mẫu ở tab Liên hệ → Mẫu nội dung.</p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">AI soạn từ dữ kiện thật của từng khách, đúng ngôn ngữ theo nước; nháp vi phạm hàng rào bị chặn. Chạm trần ngày thì máy DỪNG và báo còn bao nhiêu khách chưa soạn.</p>
            )}
            <Button onClick={build} disabled={pending}>
              {pending ? "Đang soạn…" : `Soạn ${leadIds.length} thư`}
            </Button>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="text-xs text-muted-foreground">
              {ok.length} thư soạn được · {prep.items.length - ok.length} khách không đi được email{prep.outOfScope ? ` · ${prep.outOfScope} khách ngoài phạm vi dữ liệu của bạn (không vào lô)` : ""}. Mở xem từng thư — chỉ thư ĐÃ MỞ XEM mới tích duyệt được.
            </div>
            {prep.aiStop ? <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">AI dừng: {prep.aiStop.message} Còn {prep.aiStop.remaining} khách chưa soạn — soạn tiếp bằng mẫu hoặc ngày mai.</div> : null}
            <ul className="divide-y rounded-md border">
              {prep.items.map((i) => {
                const e = edits[i.leadId];
                const isOpen = openId === i.leadId;
                return (
                  <li key={i.leadId} className="p-2">
                    <div className="flex items-start gap-2">
                      <input type="checkbox" className="mt-1" aria-label={`Duyệt thư cho ${i.name}`} disabled={Boolean(i.refusal) || !e?.viewed} checked={Boolean(e?.checked && e?.viewed)} onChange={() => patch(i.leadId, { checked: !e?.checked })} />
                      <button type="button" className="min-w-0 flex-1 text-left" onClick={() => (i.refusal ? undefined : toggleOpen(i.leadId))} disabled={Boolean(i.refusal)}>
                        <div className="flex items-center gap-1 font-medium">
                          {i.refusal ? null : isOpen ? <ChevronDown className="h-3.5 w-3.5" aria-hidden /> : <ChevronRight className="h-3.5 w-3.5" aria-hidden />}
                          <span className="truncate">{i.name}</span>
                          {e?.viewed && !i.refusal ? <span className="text-[10px] font-normal text-emerald-700">đã xem</span> : null}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {i.email ?? "chưa có email"} · {i.trackLabel}
                          {i.aiDraftId ? " · AI soạn" : ""}
                          {!i.refusal && e ? ` · ${e.subject}` : ""}
                        </div>
                        {i.refusal ? <div className="text-[11px] text-rose-700 dark:text-rose-300">{i.refusal}</div> : null}
                      </button>
                    </div>
                    {isOpen && e ? (
                      <div className="mt-2 space-y-1.5 pl-6">
                        <Input value={e.subject} onChange={(ev) => patch(i.leadId, { subject: ev.target.value })} aria-label="Tiêu đề" />
                        <Textarea rows={8} className="text-xs" value={e.body} onChange={(ev) => patch(i.leadId, { body: ev.target.value })} aria-label="Nội dung thư" />
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => submit(true)} disabled={pending || !approved.length}>
                Đưa {approved.length} thư đã duyệt vào hộp thư đi
              </Button>
              <Button variant="outline" onClick={() => submit(false)} disabled={pending || !ok.some((i) => edits[i.leadId]?.checked)}>
                Chỉ đưa vào hộp thư đi (duyệt sau)
              </Button>
              <Button variant="ghost" onClick={reset} disabled={pending}>
                Soạn lại
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
