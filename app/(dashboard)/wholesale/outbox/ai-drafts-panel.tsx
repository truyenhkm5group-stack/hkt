"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { discardAiDraftAction, promoteAiDraftAction, saveEmailAiSettingsAction } from "@/lib/actions/wholesale-email-ai";
import { formatDateTime, formatNumber } from "@/lib/format";
import type { AiDraftRow, AiDraftStats } from "@/lib/queries/wholesale-email-ai-drafts";
import type { EmailAiSettings } from "@/lib/wholesale/email-ai-draft";

const LANG: Record<string, string> = { vi: "Tiếng Việt", en: "English" };

/**
 * Khối «Nháp AI» của Hộp thư đi. Nháp CHƯA ở hộp thư đi: người sửa xong bấm «Đưa vào hộp thư đi», máy chủ chạy lại hàng rào bịa đặt
 * trên bản cuối rồi mới tạo thư (vẫn phải duyệt gửi ở bảng bên dưới). Nháp bị máy chặn chỉ bỏ được, không đưa được.
 */
export function AiDraftsPanel({ rows, stats }: { rows: AiDraftRow[]; stats: AiDraftStats }) {
  return (
    <div className="space-y-3" data-ai-drafts>
      <p className="text-xs text-muted-foreground">
        30 ngày: {formatNumber(stats.total)} nháp · {formatNumber(stats.blocked)} bị máy chặn · {formatNumber(stats.promoted)} đã đưa vào hộp thư đi · tỷ lệ sửa trung bình {stats.avgEditRatio === null ? "chưa có" : `${Math.round(stats.avgEditRatio * 100)}%`} · chi phí {stats.costUsd.toFixed(4)} USD{stats.costUnknown ? ` (+${stats.costUnknown} lượt chưa biết giá)` : ""}.
      </p>
      {rows.length ? rows.map((r) => <DraftCard key={r.id} row={r} />) : <p className="text-sm text-muted-foreground">Chưa có nháp AI nào đang mở. Bấm «AI soạn nháp» trên trang một lead có email.</p>}
    </div>
  );
}

function DraftCard({ row }: { row: AiDraftRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [subject, setSubject] = useState(row.subject);
  const [body, setBody] = useState(row.body);
  const [reason, setReason] = useState("");
  const blocked = row.status === "BLOCKED";
  const promote = () =>
    start(async () => {
      const r = await promoteAiDraftAction(row.id, { subject, body });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success(`Đã đưa vào hộp thư đi (sửa ${Math.round(r.editRatio * 100)}%) — còn bước duyệt gửi.`);
        router.refresh();
      }
    });
  const discard = () =>
    start(async () => {
      const r = await discardAiDraftAction(row.id, reason);
      if ("error" in r) toast.error(r.error);
      else router.refresh();
    });
  return (
    <div className={`rounded-md border p-3 text-sm ${blocked ? "border-rose-300" : ""}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Link href={`/wholesale/leads/${row.leadId}`} className="font-semibold text-foreground hover:underline">
          {row.leadName || "Lead"}
        </Link>
        <span>· {row.toEmail ?? "chưa có email"}</span>
        <span>· {LANG[row.language] ?? row.language}</span>
        <span>· {row.model ?? "model ?"}</span>
        <span>· {row.costUsd === null ? "chi phí chưa biết" : `${row.costUsd.toFixed(4)} USD`}</span>
        <span>· {row.requestedBy ?? "—"} · {formatDateTime(row.createdAt)}</span>
      </div>
      {blocked ? (
        <div className="mb-2 rounded bg-rose-50 p-2 text-xs text-rose-900 dark:bg-rose-950 dark:text-rose-200">
          <b>Máy chặn — không vào hộp thư đi:</b>
          <ul className="list-disc pl-5">
            {row.violations.map((v, i) => (
              <li key={i}>{v.detail}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={blocked} aria-label="Tiêu đề" className="mb-2" />
      <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8} disabled={blocked} aria-label="Nội dung thư" />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!blocked ? (
          <Button size="sm" disabled={pending} onClick={promote}>
            Đưa vào hộp thư đi
          </Button>
        ) : null}
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do bỏ nháp" className="h-8 max-w-xs" />
        <Button size="sm" variant="outline" disabled={pending} onClick={discard}>
          Bỏ nháp
        </Button>
      </div>
    </div>
  );
}

/** Bật / tắt AI soạn email + trần / ngày — chỉ người cấu hình. */
export function AiDraftSettings({ settings }: { settings: EmailAiSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [enabled, setEnabled] = useState(settings.enabled);
  const [maxDrafts, setMaxDrafts] = useState(settings.dailyMaxDrafts === null ? "" : String(settings.dailyMaxDrafts));
  const [cap, setCap] = useState(settings.dailyCostCapUsd === null ? "" : String(settings.dailyCostCapUsd));
  const [reason, setReason] = useState("");
  const save = () =>
    start(async () => {
      const r = await saveEmailAiSettingsAction({ enabled, dailyMaxDrafts: maxDrafts.trim() ? Number(maxDrafts) : null, dailyCostCapUsd: cap.trim() ? Number(cap.replace(",", ".")) : null, reason });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu cấu hình AI soạn email.");
        setReason("");
        router.refresh();
      }
    });
  return (
    <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-5" data-ai-draft-settings>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Bật AI soạn email
      </label>
      <Input inputMode="numeric" value={maxDrafts} onChange={(e) => setMaxDrafts(e.target.value)} placeholder="Trần nháp / ngày" aria-label="Trần nháp mỗi ngày" />
      <Input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Trần chi phí USD / ngày" aria-label="Trần chi phí USD mỗi ngày" />
      <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do (bắt buộc)" aria-label="Lý do" />
      <Button size="sm" disabled={pending} onClick={save}>
        Lưu
      </Button>
    </div>
  );
}
