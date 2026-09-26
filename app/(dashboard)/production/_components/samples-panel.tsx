"use client";

import { useState } from "react";
import { Check, Pencil, Plus, Send, Undo2, X } from "lucide-react";
import { toast } from "sonner";
import { SampleStatusBadge } from "@/app/(dashboard)/production/_components/badges";
import { useNavTransition } from "@/components/nav-progress";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createSample, reviewSample, submitSample, updateSample } from "@/lib/actions/production-samples";
import { REVIEW_NOTE_MIN, SAMPLE_OPEN_STATUSES, SAMPLE_REVIEW_DECISION_LABEL, type SampleReviewDecision, type SampleStatus } from "@/lib/constants/production-os";
import { formatDateTime, formatVND } from "@/lib/format";

export type SampleView = {
  id: string;
  version: number;
  status: SampleStatus;
  supplierId: string | null;
  supplierName: string | null;
  costVnd: number | null;
  images: string[];
  notes: string;
  problems: string;
  requestedChanges: string;
  createdBy: string;
  createdAt: Date;
  submittedAt: Date | null;
  topicId: string | null;
  review: { decision: string; note: string; reviewerName: string; reviewedAt: Date } | null;
  design: { id: string; version: number } | null;
};

const lines = (s: string) =>
  s
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Mẫu theo phiên bản. Mỗi phiên bản: xưởng làm → gửi duyệt → MỘT phán quyết (yêu cầu sửa / loại /
 * duyệt). Duyệt sinh bản thiết kế bất biến. Nút Duyệt / Loại chỉ hiện với người có
 * `production:approve` — máy chủ vẫn chặn lại nếu ai gọi thẳng action.
 */
export function SamplesPanel({
  modelId,
  topicId,
  samples,
  suppliers,
  canWrite,
  canApprove,
}: {
  modelId: string;
  topicId: string | null;
  samples: SampleView[];
  suppliers: { id: string; name: string }[];
  canWrite: boolean;
  canApprove: boolean;
}) {
  const [creating, setCreating] = useState(false);
  // `null` = đang ghi phiên bản MỚI; có id = đang sửa phiên bản xưởng còn đang làm.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [supplierId, setSupplierId] = useState("");
  const [cost, setCost] = useState("");
  const [images, setImages] = useState("");
  const [notes, setNotes] = useState("");
  const [problems, setProblems] = useState("");
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({});
  const [pending, start] = useNavTransition();
  const coMauDangMo = samples.some((s) => SAMPLE_OPEN_STATUSES.includes(s.status));
  const truoc = samples[0];

  const moSua = (s: SampleView) => {
    setSupplierId(s.supplierId ?? "");
    setCost(s.costVnd === null ? "" : String(s.costVnd));
    setImages(s.images.join("\n"));
    setNotes(s.notes);
    setProblems(s.problems);
    setEditingId(s.id);
    setCreating(true);
  };

  const tao = () =>
    start(async () => {
      const fields = { supplierId: supplierId || null, costVnd: cost.trim() ? Math.round(Number(cost)) : null, images: lines(images), notes, problems };
      if (editingId) {
        const r = await updateSample({ sampleId: editingId, fields });
        if ("error" in r) {
          toast.error(r.error);
          return;
        }
        toast.success("Đã lưu thông tin mẫu");
      } else {
        const r = await createSample({ modelId, topicId, fields });
        if ("error" in r) {
          toast.error(r.error);
          return;
        }
        toast.success(`Đã ghi mẫu V${r.version}${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      }
      setCreating(false);
      setEditingId(null);
      setImages("");
      setNotes("");
      setProblems("");
      setCost("");
    });

  const gui = (id: string) =>
    start(async () => {
      const r = await submitSample(id);
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(r.noop ? "Mẫu đã ở trạng thái chờ duyệt" : `Đã gửi duyệt${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      }
    });

  const duyet = (id: string, decision: SampleReviewDecision) =>
    start(async () => {
      const r = await reviewSample({ sampleId: id, decision, note: reviewNote[id] ?? null });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`${SAMPLE_REVIEW_DECISION_LABEL[decision]}${r.designVersion ? ` · bản thiết kế V${r.designVersion}` : ""}${r.lifecycle ? ` · ${r.lifecycle}` : ""}`);
      }
    });

  return (
    <div className="space-y-3">
      {samples.length ? (
        <ul className="space-y-3">
          {samples.map((s) => (
            <li key={s.id} className="rounded-xl border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono font-semibold">V{s.version}</span>
                <SampleStatusBadge status={s.status} />
                {topicId && s.topicId === topicId ? <span className="text-[10.5px] text-muted-foreground">topic này</span> : null}
                <span className="text-xs text-muted-foreground">
                  Xưởng: {s.supplierName ?? "—"} · tiền mẫu {formatVND(s.costVnd)} · ghi bởi {s.createdBy || "—"} {formatDateTime(s.createdAt)}
                  {s.submittedAt ? ` · gửi duyệt ${formatDateTime(s.submittedAt)}` : ""}
                </span>
              </div>
              {s.images.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {s.images.map((u) => (
                    <a key={u} href={u} target="_blank" rel="noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={u} alt="" className="size-20 rounded-md border object-cover" />
                    </a>
                  ))}
                </div>
              ) : null}
              <div className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                <div>
                  <span className="text-xs text-muted-foreground">Ghi chú: </span>
                  {s.notes || "—"}
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">Lỗi thấy trên mẫu: </span>
                  {s.problems || "—"}
                </div>
                {s.requestedChanges ? (
                  <div className="sm:col-span-2">
                    <span className="text-xs text-muted-foreground">Yêu cầu sửa: </span>
                    {s.requestedChanges}
                  </div>
                ) : null}
              </div>
              {s.review ? (
                <p className="mt-2 text-xs">
                  <b>{SAMPLE_REVIEW_DECISION_LABEL[s.review.decision as SampleReviewDecision] ?? s.review.decision}</b> bởi {s.review.reviewerName || "—"} · {formatDateTime(s.review.reviewedAt)}
                  {s.review.note ? ` — ${s.review.note}` : ""}
                  {s.design ? <span className="ml-1 font-semibold text-emerald-700 dark:text-emerald-300">⇒ bản thiết kế V{s.design.version}</span> : null}
                </p>
              ) : null}

              {canWrite && s.status === "IN_PROGRESS" ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={pending} onClick={() => gui(s.id)}>
                    <Send className="size-3.5" /> Mẫu đã về — gửi duyệt
                  </Button>
                  <Button size="sm" variant="ghost" disabled={pending || creating} onClick={() => moSua(s)}>
                    <Pencil className="size-3.5" /> Sửa thông tin
                  </Button>
                </div>
              ) : null}

              {s.status === "SUBMITTED" && (canWrite || canApprove) ? (
                <div className="mt-2 space-y-2 rounded-lg bg-muted/40 p-2">
                  <Textarea
                    rows={2}
                    value={reviewNote[s.id] ?? ""}
                    onChange={(e) => setReviewNote({ ...reviewNote, [s.id]: e.target.value })}
                    placeholder={`Nhận xét — BẮT BUỘC khi yêu cầu sửa hoặc loại (ít nhất ${REVIEW_NOTE_MIN} ký tự)`}
                  />
                  <div className="flex flex-wrap gap-2">
                    {canApprove ? (
                      <Button size="sm" disabled={pending} onClick={() => duyet(s.id, "APPROVE")}>
                        <Check className="size-3.5" /> Duyệt mẫu
                      </Button>
                    ) : null}
                    {canWrite ? (
                      <Button size="sm" variant="outline" disabled={pending} onClick={() => duyet(s.id, "REQUEST_CHANGES")}>
                        <Undo2 className="size-3.5" /> Yêu cầu sửa
                      </Button>
                    ) : null}
                    {canApprove ? (
                      <Button size="sm" variant="ghost" className="text-destructive" disabled={pending} onClick={() => duyet(s.id, "REJECT")}>
                        <X className="size-3.5" /> Loại mẫu
                      </Button>
                    ) : null}
                    {!canApprove ? <span className="self-center text-xs text-muted-foreground">Duyệt / loại cần quyền “Sản xuất: duyệt mẫu &amp; chốt giá thành”.</span> : null}
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Chưa có phiên bản mẫu nào.</p>
      )}

      {canWrite && !creating ? (
        <Button
          size="sm"
          variant="outline"
          disabled={coMauDangMo}
          title={coMauDangMo ? "Còn một phiên bản mẫu chưa có phán quyết" : undefined}
          onClick={() => {
            setEditingId(null);
            setCreating(true);
          }}
        >
          <Plus className="size-4" /> Ghi mẫu V{(truoc?.version ?? 0) + 1}
        </Button>
      ) : null}

      {creating ? (
        <div className="grid gap-2 rounded-xl border bg-muted/30 p-3 sm:grid-cols-2">
          {editingId ? <p className="text-xs font-semibold sm:col-span-2">Sửa thông tin mẫu xưởng đang làm</p> : null}
          {!editingId && truoc?.requestedChanges ? (
            <p className="text-xs sm:col-span-2">
              <b>Yêu cầu sửa từ V{truoc.version}:</b> {truoc.requestedChanges}
            </p>
          ) : null}
          <div className="space-y-1">
            <Label>Xưởng làm mẫu</Label>
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">— Chưa chọn —</option>
              {suppliers.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label>Tiền làm mẫu (đ) — bỏ trống nếu chưa biết</Label>
            <Input inputMode="numeric" value={cost} onChange={(e) => setCost(e.target.value.replace(/[^\d]/g, ""))} />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label>Link ảnh mẫu (mỗi link một dòng)</Label>
            <Textarea rows={2} value={images} onChange={(e) => setImages(e.target.value)} placeholder="https://…" />
          </div>
          <div className="space-y-1">
            <Label>Ghi chú</Label>
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label>Lỗi thấy trên mẫu</Label>
            <Textarea rows={2} value={problems} onChange={(e) => setProblems(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2 sm:col-span-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setCreating(false);
                setEditingId(null);
              }}
              disabled={pending}
            >
              Huỷ
            </Button>
            <Button size="sm" onClick={tao} disabled={pending}>
              {editingId ? "Lưu" : "Ghi mẫu"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
