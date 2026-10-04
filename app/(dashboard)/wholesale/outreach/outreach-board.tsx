"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { approveOutreachAction, cancelOutreachAction, markOutreachSentAction, recordOutreachResultAction } from "@/lib/actions/wholesale";
import { formatTimeAgo } from "@/lib/format";
import type { OutreachRow } from "@/lib/queries/wholesale";
import { OUTREACH_CHANNEL_LABEL, OUTREACH_RESULT_LABEL, OUTREACH_RESULTS, OUTREACH_STATUS_LABEL, type OutreachChannel, type OutreachResult } from "@/lib/wholesale/constants";
import { channelAction } from "@/lib/wholesale/opener";
import { formatVnPhone } from "@/lib/wholesale/phone";

export function OutreachBoard({ rows, readOnly, callScript }: { rows: OutreachRow[]; readOnly: boolean; callScript: string }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {rows.map((r) => (
        <OutreachCard key={r.id} row={r} readOnly={readOnly} callScript={callScript} />
      ))}
    </div>
  );
}

function OutreachCard({ row, readOnly, callScript }: { row: OutreachRow; readOnly: boolean; callScript: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState(row.message);
  const [result, setResult] = useState<OutreachResult>("NO_ANSWER");
  const [note, setNote] = useState("");
  const [followup, setFollowup] = useState("");
  const action = channelAction(row.channel as OutreachChannel, { phone: row.phone, email: row.email, facebookUrl: row.facebookUrl, zaloUrl: row.zaloUrl }, message);
  const run = (fn: () => Promise<{ error: string } | ({ ok: true } & object)>, ok: string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(ok);
        router.refresh();
      }
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      toast.success("Đã chép lời chào");
    } catch {
      toast.error("Trình duyệt không cho chép — chọn chữ và chép tay.");
    }
  };
  return (
    <div className="space-y-2 rounded-lg border bg-card p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link href={`/wholesale/leads/${row.leadId}`} className="block truncate font-semibold hover:underline">
            {row.leadName ?? "(chưa có tên)"}
          </Link>
          <div className="truncate text-[11px] text-muted-foreground">
            {row.segmentLabel}
            {row.area ? ` · ${row.area}` : ""} · {row.grade ? `hạng ${row.grade} · ${row.score}` : "chưa chấm"} · {row.assignee ?? "chưa giao"}
          </div>
        </div>
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px]">{OUTREACH_CHANNEL_LABEL[row.channel as OutreachChannel] ?? row.channel}</span>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {OUTREACH_STATUS_LABEL[row.status] ?? row.status} · {row.preparedBy === "AI" ? "AI soạn" : row.preparedBy === "STAFF" ? "nhân viên sửa" : "theo mẫu"} · {formatTimeAgo(row.sentAt ?? row.createdAt)}
        {row.result ? ` · ${OUTREACH_RESULT_LABEL[row.result as OutreachResult] ?? row.result}` : ""}
      </div>
      {row.phone ? <div className="font-medium tabular-nums">{formatVnPhone(row.phone)}</div> : null}
      {row.status === "DRAFT" && !readOnly ? <Textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} /> : <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2">{message}</p>}
      {row.channel === "PHONE_CALL" && callScript ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Kịch bản tư vấn</summary>
          <p className="mt-1 whitespace-pre-wrap">{callScript}</p>
        </details>
      ) : null}
      {!readOnly ? (
        <div className="flex flex-wrap gap-1.5">
          {row.status === "DRAFT" ? (
            <Button size="sm" disabled={pending} onClick={() => run(() => approveOutreachAction(row.id, { message }), "Đã duyệt")}>
              Duyệt
            </Button>
          ) : null}
          {(row.status === "DRAFT" || row.status === "APPROVED") && action ? (
            <>
              <Button size="sm" variant="outline" asChild>
                <a href={action.href ?? undefined} target={action.href?.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer" title={action.hint}>
                  Mở {OUTREACH_CHANNEL_LABEL[row.channel as OutreachChannel]}
                </a>
              </Button>
              <Button size="sm" variant="outline" onClick={copy}>
                Chép lời chào
              </Button>
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => markOutreachSentAction(row.id), "Đã ghi «đã gửi»")}>
                Đã gửi
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelOutreachAction(row.id), "Đã huỷ")}>
                Huỷ
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {row.status === "SENT" && !readOnly ? (
        <div className="space-y-1.5 border-t pt-2">
          <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={result} onChange={(e) => setResult(e.target.value as OutreachResult)} aria-label="Kết quả">
            {OUTREACH_RESULTS.map((x) => (
              <option key={x} value={x}>
                {OUTREACH_RESULT_LABEL[x]}
              </option>
            ))}
          </select>
          <Input placeholder={result === "DO_NOT_CONTACT" ? "Khách nói gì (bắt buộc nên ghi)" : "Ghi chú"} value={note} onChange={(e) => setNote(e.target.value)} />
          <Input type="date" aria-label="Hẹn gọi lại" value={followup} onChange={(e) => setFollowup(e.target.value)} />
          <Button size="sm" disabled={pending} onClick={() => run(() => recordOutreachResultAction(row.id, { result, note, nextFollowupAt: followup ? new Date(`${followup}T09:00:00+07:00`).toISOString() : null }), "Đã ghi kết quả")}>
            Ghi kết quả
          </Button>
        </div>
      ) : null}
    </div>
  );
}
