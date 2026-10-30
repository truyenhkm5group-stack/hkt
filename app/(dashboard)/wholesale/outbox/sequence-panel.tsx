"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createFollowupDraftAction, saveEmailSequenceSettingsAction } from "@/lib/actions/wholesale-email-sequence";
import { formatDateTime, formatNumber } from "@/lib/format";
import { SEQUENCE_STOP_LABEL, type EmailSequenceSettings, type SequenceStopReason } from "@/lib/wholesale/email-sequence";
import type { DueFollowup } from "@/lib/wholesale/email-sequence-core";

/**
 * Khối «Lần nhắc đến hạn» — phép chiếu tính lúc đọc. Mỗi nút soạn MỘT nháp cho MỘT lead (AI qua hàng rào, hoặc mẫu shop khai);
 * không nút nào gửi. Máy chủ kiểm lại «đến hạn» + điều kiện dừng trước khi soạn.
 */
export function SequencePanel({ due, waiting, stopped, configured, settings }: { due: DueFollowup[]; waiting: number; stopped: Record<string, number>; configured: boolean; settings: EmailSequenceSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const make = (leadId: string, source: "AI" | "TEMPLATE") =>
    start(async () => {
      const r = await createFollowupDraftAction(leadId, { source });
      if ("error" in r) toast.error(r.error);
      else {
        if (r.kind === "AI_DRAFT" && r.draft.status === "BLOCKED") toast.error(`Máy chặn nháp AI: ${r.draft.violations.map((v) => v.detail).join(" ")}`);
        else toast.success(r.kind === "AI_DRAFT" ? "Đã có nháp AI cho lần nhắc — sửa ở khối «Nháp AI»." : "Đã soạn thư nhắc từ mẫu — chờ duyệt ở bảng thư bên dưới.");
        router.refresh();
      }
    });
  if (!configured) return <p className="text-sm text-muted-foreground">Chưa khai số lần nhắc / số ngày chờ ⇒ không có lần nhắc nào (không có số mặc định). Người cấu hình khai ở mục cấu hình bên dưới.</p>;
  const stops = Object.entries(stopped).filter(([, n]) => n > 0);
  return (
    <div className="space-y-2 text-sm" data-sequence-due>
      <p className="text-xs text-muted-foreground">
        Tối đa {settings.maxFollowups} lần nhắc, mỗi lần sau {settings.gapDays} ngày không phản hồi · {formatNumber(due.length)} đến hạn · {formatNumber(waiting)} đang chờ
        {stops.length ? ` · đã dừng: ${stops.map(([k, n]) => `${SEQUENCE_STOP_LABEL[k as SequenceStopReason] ?? k} ${n}`).join(", ")}` : ""}.
      </p>
      {due.length ? (
        <ul className="divide-y rounded-md border">
          {due.map((d) => (
            <li key={d.leadId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="min-w-0">
                <Link href={`/wholesale/leads/${d.leadId}`} className="font-medium hover:underline">
                  {d.leadName || "Lead"}
                </Link>{" "}
                <span className="text-xs text-muted-foreground">
                  · {d.toEmail} · lần nhắc {d.nextStep} · thư trước «{d.lastSubject}» gửi {formatDateTime(d.lastSentAt)}
                </span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" disabled={pending} onClick={() => make(d.leadId, "AI")}>
                  AI soạn lần nhắc
                </Button>
                <Button size="sm" variant="outline" disabled={pending || !(d.language === "en" ? settings.templates.en : settings.templates.vi)} onClick={() => make(d.leadId, "TEMPLATE")}>
                  Dùng mẫu
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">Không có lần nhắc nào đến hạn.</p>
      )}
    </div>
  );
}

/** N / K / mẫu thư nhắc — chỉ người cấu hình. Để trống N và K = tắt chuỗi. */
export function SequenceSettingsForm({ settings }: { settings: EmailSequenceSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [n, setN] = useState(settings.maxFollowups === null ? "" : String(settings.maxFollowups));
  const [k, setK] = useState(settings.gapDays === null ? "" : String(settings.gapDays));
  const [vi, setVi] = useState(settings.templates.vi);
  const [en, setEn] = useState(settings.templates.en);
  const [reason, setReason] = useState("");
  const save = () =>
    start(async () => {
      const r = await saveEmailSequenceSettingsAction({ maxFollowups: n.trim() ? Number(n) : null, gapDays: k.trim() ? Number(k) : null, templates: { vi, en }, reason });
      if ("error" in r) toast.error(r.error);
      else {
        toast.success("Đã lưu chuỗi thư nhắc.");
        setReason("");
        router.refresh();
      }
    });
  return (
    <div className="space-y-2 text-sm" data-sequence-settings>
      <div className="grid gap-2 sm:grid-cols-3">
        <Input inputMode="numeric" value={n} onChange={(e) => setN(e.target.value)} placeholder="Số lần nhắc tối đa (trống = tắt)" aria-label="Số lần nhắc tối đa" />
        <Input inputMode="numeric" value={k} onChange={(e) => setK(e.target.value)} placeholder="Số ngày chờ không phản hồi" aria-label="Số ngày chờ" />
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Lý do (bắt buộc)" aria-label="Lý do" />
      </div>
      <Textarea rows={3} value={vi} onChange={(e) => setVi(e.target.value)} placeholder="Mẫu thư nhắc tiếng Việt (tuỳ chọn) — biến: {{ten_doanh_nghiep}} {{ten_shop}} {{lan_nhac}}" aria-label="Mẫu tiếng Việt" />
      <Textarea rows={3} value={en} onChange={(e) => setEn(e.target.value)} placeholder="English follow-up template (optional) — {{ten_doanh_nghiep}} {{ten_shop}} {{lan_nhac}}" aria-label="Mẫu tiếng Anh" />
      <Button size="sm" disabled={pending} onClick={save}>
        Lưu chuỗi thư nhắc
      </Button>
    </div>
  );
}
