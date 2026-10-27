"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { approveEmailAction, bulkApproveEmailAction, cancelEmailAction, editEmailDraftAction, emailDraftFromOutreachAction, queueEmailAction, reopenEmailAction, runEmailOutboxNowAction } from "@/lib/actions/wholesale-email";
import { formatTimeAgo } from "@/lib/format";
import type { OutboxRow } from "@/lib/queries/wholesale-email";
import { EMAIL_OUTBOX_STATUS_LABEL, EMAIL_TEMPLATE_LABEL, type EmailTemplateKey } from "@/lib/wholesale/email-constants";
import { cn } from "@/lib/utils";

type Result = { error: string } | ({ ok: true } & object);

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<Result>, ok: string | ((r: Result) => string)) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(typeof ok === "string" ? ok : ok(r));
        router.refresh();
      }
    });
  return { pending, run };
}

const TONE: Record<string, string> = {
  DRAFT: "bg-muted text-foreground",
  APPROVED: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  QUEUED: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
  SENDING: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  SENT: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  FAILED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  BLOCKED: "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200",
  CANCELLED: "bg-muted text-muted-foreground",
};

/** Lời chào kênh EMAIL đang mở ở hàng đợi liên hệ — một nút đưa vào hộp thư đi (không phải trang soạn song song). */
export function EmailCandidates({ rows }: { rows: { id: string; leadId: string; leadName: string | null; email: string | null; preparedBy: string; message: string }[] }) {
  const { pending, run } = useRun();
  return (
    <div className="rounded-lg border bg-card p-3 text-sm">
      <div className="mb-2 font-medium">Lời chào kênh Email đang chờ ở hàng đợi liên hệ ({rows.length})</div>
      <ul className="divide-y">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span className="min-w-0 truncate">
              <Link href={`/wholesale/leads/${r.leadId}`} className="font-medium hover:underline">
                {r.leadName ?? "(chưa có tên)"}
              </Link>{" "}
              <span className="text-muted-foreground">· {r.email ?? "chưa có email"} · {r.preparedBy === "AI" ? "AI soạn" : r.preparedBy === "STAFF" ? "nhân viên sửa" : "theo mẫu"}</span>
            </span>
            <Button size="sm" variant="outline" disabled={pending || !r.email} onClick={() => run(() => emailDraftFromOutreachAction(r.id), "Đã đưa vào hộp thư đi — chờ duyệt")}>
              Đưa vào hộp thư đi
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function OutboxBoard({ rows, previews, canBulk, readOnly }: { rows: OutboxRow[]; previews: Record<string, string[]>; canBulk: boolean; readOnly: boolean }) {
  const { pending, run } = useRun();
  const drafts = rows.filter((r) => r.status === "DRAFT").map((r) => r.id);
  return (
    <div className="space-y-3">
      {!readOnly ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => runEmailOutboxNowAction(), (r) => ("detail" in r ? String(r.detail) : "Đã chạy"))}>
            Chạy thử gửi (một lượt hàng đợi)
          </Button>
          {canBulk && drafts.length > 1 ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => bulkApproveEmailAction(drafts, { queue: true }), (r) => ("approved" in r ? `Đã duyệt ${String(r.approved)} thư` : "Đã duyệt"))}>
              Duyệt & xếp gửi cả {drafts.length} thư nháp
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <OutboxCard key={r.id} row={r} warnings={previews[r.id] ?? []} readOnly={readOnly} />
        ))}
      </div>
    </div>
  );
}

function OutboxCard({ row, warnings, readOnly }: { row: OutboxRow; warnings: string[]; readOnly: boolean }) {
  const { pending, run } = useRun();
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.bodyText);
  const editable = !readOnly && (row.status === "DRAFT" || row.status === "APPROVED");
  const dirty = subject !== row.subject || body !== row.bodyText;
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/wholesale/leads/${row.leadId}`} className="block truncate font-semibold hover:underline">
            {row.leadName ?? "(chưa có tên)"}
          </Link>
          <div className="truncate text-[11px] text-muted-foreground">
            {row.toEmail} · {EMAIL_TEMPLATE_LABEL[row.templateKey as EmailTemplateKey] ?? row.templateKey}
            {row.sequenceStep ? ` · bước ${row.sequenceStep}` : ""} · {row.preparedBy === "AI" ? `AI soạn${row.aiModel ? ` (${row.aiModel})` : ""}` : "người soạn"} · {row.assignee ?? "chưa giao"}
          </div>
        </div>
        <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[11px]", TONE[row.status])}>{EMAIL_OUTBOX_STATUS_LABEL[row.status]}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        Tạo {formatTimeAgo(row.createdAt)}
        {row.approvedBy ? ` · duyệt bởi ${row.approvedBy}${row.approvedAt ? ` ${formatTimeAgo(row.approvedAt)}` : ""}` : ""}
        {row.sentAt ? ` · gửi ${formatTimeAgo(row.sentAt)}${row.mode === "DRY_RUN" ? " (CHẠY THỬ)" : ""}` : ""}
        {row.providerMessageId ? ` · mã ${row.providerMessageId}` : ""}
        {row.attempts ? ` · ${row.attempts} lần thử` : ""}
        {row.status === "QUEUED" && row.nextAttemptAt ? ` · lượt tới ${formatTimeAgo(row.nextAttemptAt)}` : ""}
      </div>
      {editable ? (
        <>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Tiêu đề thư" />
          <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Nội dung thư" />
          <p className="text-[11px] text-muted-foreground">Máy tự thêm nhãn [QC] vào tiêu đề và chân thư (tên doanh nghiệp · địa chỉ · link huỷ đăng ký) lúc gửi.</p>
        </>
      ) : (
        <details className="rounded-md bg-muted/50 p-2">
          <summary className="cursor-pointer font-medium">{row.subject}</summary>
          <p className="mt-1 whitespace-pre-wrap">{row.bodyText}</p>
        </details>
      )}
      {row.blockedReason ? <p className="rounded-md bg-rose-50 p-2 text-xs text-rose-900 dark:bg-rose-950 dark:text-rose-200">Bị chặn: {row.blockedReason}</p> : null}
      {row.lastError && row.status !== "BLOCKED" ? <p className="text-xs text-amber-800 dark:text-amber-300">{row.lastError}</p> : null}
      {row.status === "SENDING" ? <p className="text-xs text-amber-800 dark:text-amber-300">Lượt gửi chưa báo kết quả. Máy KHÔNG tự gửi lại (tránh gửi trùng) — kiểm ở nhà cung cấp rồi xử lý tay.</p> : null}
      {warnings.length ? (
        <ul className="list-disc space-y-0.5 rounded-md bg-amber-50 p-2 pl-5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-1.5">
          {editable && dirty ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => editEmailDraftAction(row.id, { subject, body }), "Đã lưu — thư về «Chờ duyệt»")}>
              Lưu sửa
            </Button>
          ) : null}
          {row.status === "DRAFT" && !dirty ? (
            <>
              <Button size="sm" disabled={pending} onClick={() => run(() => approveEmailAction(row.id, { queue: true }), (r) => ("warnings" in r && Array.isArray(r.warnings) && r.warnings.length ? `Đã duyệt & xếp gửi — lưu ý: ${String(r.warnings[0])}` : "Đã duyệt & xếp gửi"))}>
                Duyệt & xếp gửi
              </Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => approveEmailAction(row.id, { queue: false }), "Đã duyệt (chưa xếp gửi)")}>
                Chỉ duyệt
              </Button>
            </>
          ) : null}
          {row.status === "APPROVED" && !dirty ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => queueEmailAction(row.id), "Đã xếp gửi")}>
              Xếp gửi
            </Button>
          ) : null}
          {row.status === "DRAFT" || row.status === "APPROVED" || row.status === "QUEUED" ? (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelEmailAction(row.id), "Đã huỷ thư")}>
              Huỷ
            </Button>
          ) : null}
          {row.status === "BLOCKED" || row.status === "FAILED" ? (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => reopenEmailAction(row.id), "Đã mở lại — duyệt lại để gửi")}>
              Mở lại (duyệt lại)
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
