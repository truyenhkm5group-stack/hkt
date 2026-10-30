"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { approveOutreachAction, cancelOutreachAction, markOutreachSentAction, recordOutreachResultAction } from "@/lib/actions/wholesale";
import { emailDraftFromOutreachAction } from "@/lib/actions/wholesale-email";
import { confirmLeadCountryAction, emailDraftForLeadAction, markZaloUndeliverableAction, undoZaloUndeliverableAction } from "@/lib/actions/wholesale-routing";
import { COUNTRY_LABEL } from "@/lib/wholesale/lead-country";
import { CONTACT_TRACK_LABEL, CONTACT_TRACKS, EMAIL_TRACKS, ZALO_UNDELIVERABLE_LABEL, ZALO_UNDELIVERABLE_REASONS, type ContactPlan, type ContactTrack, type ZaloUndeliverableReason } from "@/lib/wholesale/contact-plan";
import { formatTimeAgo } from "@/lib/format";
import type { OutreachRow } from "@/lib/queries/wholesale";
import { OUTREACH_CHANNEL_LABEL, OUTREACH_RESULT_LABEL, OUTREACH_RESULTS, OUTREACH_STATUS_LABEL, type OutreachChannel, type OutreachResult } from "@/lib/wholesale/constants";
import { channelAction } from "@/lib/wholesale/opener";
import { formatVnPhone } from "@/lib/wholesale/phone";

const LANE_HINT: Record<ContactTrack, string> = {
  INTL_EMAIL: "Khách nước ngoài — đưa lời chào vào Hộp thư đi (cổng chính sách · chạy thử).",
  DOMESTIC_ZALO: "Khách trong nước — nhắn Zalo trước. Khách im lặng KHÔNG chuyển kênh; chỉ bấm «Zalo không gửi được» khi Zalo thật sự không đi.",
  DOMESTIC_EMAIL_FALLBACK: "Zalo không gửi được và lead có email — gửi email qua Hộp thư đi (chạy thử).",
  COUNTRY_UNKNOWN: "Không có chứng cứ nước (ô quét · SĐT · tên miền) — người xác nhận nước thì lead mới vào làn Zalo hoặc Email. Máy không mặc định «trong nước».",
  NO_CHANNEL: "Không có kênh dùng được — thường là thiếu email.",
  STOPPED: "Không liên hệ / khớp danh sách chặn — không gửi trên kênh nào.",
};

/**
 * Hai luồng tách riêng (chủ shop 30/10): «Nước ngoài — Email» và «Trong nước — Zalo», thêm làn «Trong nước — chuyển sang email»
 * khi Zalo không gửi được. Làn do `contactPlanOf` quyết (máy chủ tính, truyền vào `plans`), không phải do kênh của lời chào.
 */
export function OutreachBoard({ rows, plans, readOnly, callScript }: { rows: OutreachRow[]; plans: Record<string, ContactPlan>; readOnly: boolean; callScript: string }) {
  const laneOf = (r: OutreachRow): ContactTrack => plans[r.leadId]?.track ?? "NO_CHANNEL";
  return (
    <div className="space-y-5">
      {CONTACT_TRACKS.map((track) => {
        const lane = rows.filter((r) => laneOf(r) === track);
        if (!lane.length) return null;
        return (
          <section key={track} className="space-y-2">
            <div>
              <h2 className="text-sm font-semibold">
                {CONTACT_TRACK_LABEL[track]} <span className="font-normal text-muted-foreground">({lane.length})</span>
              </h2>
              <p className="text-[11px] text-muted-foreground">{LANE_HINT[track]}</p>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {lane.map((r) => (
                <OutreachCard key={r.id} row={r} plan={plans[r.leadId] ?? null} readOnly={readOnly} callScript={callScript} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function OutreachCard({ row, plan, readOnly, callScript }: { row: OutreachRow; plan: ContactPlan | null; readOnly: boolean; callScript: string }) {
  const [zaloReason, setZaloReason] = useState<ZaloUndeliverableReason | "">("");
  const [countryPick, setCountryPick] = useState("");
  const emailLane = plan ? EMAIL_TRACKS.includes(plan.track) : false;
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
      {plan?.notes.length ? <div className="text-[11px] text-amber-800 dark:text-amber-300">{plan.notes.join(" ")}</div> : null}
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
              {emailLane && row.channel === "EMAIL" ? (
                <Button size="sm" variant="secondary" disabled={pending} title="Máy gửi qua cổng chính sách (đồng ý · danh sách chặn · hạn mức · nước đã rà luật) sau khi người duyệt — mở ở «Hộp thư đi»" onClick={() => run(() => emailDraftFromOutreachAction(row.id), "Đã đưa vào Hộp thư đi — duyệt ở đó")}>
                  Đưa vào hộp thư đi
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => cancelOutreachAction(row.id), "Đã huỷ")}>
                Huỷ
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {!readOnly && plan?.track === "DOMESTIC_EMAIL_FALLBACK" && row.channel !== "EMAIL" && (row.status === "DRAFT" || row.status === "APPROVED") ? (
        <Button size="sm" variant="secondary" disabled={pending} title="Soạn thư email theo mẫu rồi đưa vào Hộp thư đi (chạy thử) — Zalo của khách này không gửi được" onClick={() => run(() => emailDraftForLeadAction(row.leadId), "Đã soạn email dự phòng — duyệt ở Hộp thư đi")}>
          Soạn email dự phòng
        </Button>
      ) : null}
      {!readOnly && plan?.track === "COUNTRY_UNKNOWN" ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          <select className="h-8 rounded-md border bg-background px-2 text-xs" value={countryPick} onChange={(e) => setCountryPick(e.target.value)} aria-label="Nước của khách">
            <option value="">Khách ở nước…</option>
            {Object.entries(COUNTRY_LABEL).map(([code, label]) => (
              <option key={code} value={code}>
                {label} ({code})
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={pending || !countryPick} title="Ghi lượt xác nhận (dòng lịch sử mới) — đè mọi suy luận từ SĐT / tên miền" onClick={() => run(() => confirmLeadCountryAction(row.leadId, { country: countryPick }), "Đã xác nhận nước")}>
            Xác nhận nước
          </Button>
        </div>
      ) : null}
      {!readOnly && plan?.track === "DOMESTIC_ZALO" ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2">
          <select className="h-8 rounded-md border bg-background px-2 text-xs" value={zaloReason} onChange={(e) => setZaloReason(e.target.value as ZaloUndeliverableReason | "")} aria-label="Lý do Zalo không gửi được">
            <option value="">Zalo không gửi được vì…</option>
            {ZALO_UNDELIVERABLE_REASONS.map((x) => (
              <option key={x} value={x}>
                {ZALO_UNDELIVERABLE_LABEL[x]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={pending || !zaloReason} title="Chỉ khi Zalo thật sự không đi — khách chưa trả lời KHÔNG phải lý do" onClick={() => run(() => markZaloUndeliverableAction(row.leadId, { reason: zaloReason }), "Đã ghi «Zalo không gửi được»")}>
            Zalo không gửi được
          </Button>
        </div>
      ) : null}
      {!readOnly && plan?.zaloBlock?.source === "MARKER" ? (
        <Button size="sm" variant="ghost" disabled={pending} title="Ghi thêm một dòng hoàn tác — dòng đánh dấu cũ vẫn giữ trong lịch sử" onClick={() => run(() => undoZaloUndeliverableAction(row.leadId), "Đã hoàn tác — lead quay lại luồng Zalo")}>
          Hoàn tác «Zalo không gửi được»
        </Button>
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
