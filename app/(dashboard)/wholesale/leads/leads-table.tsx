"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { DataTable, RowLink } from "@/components/data-table/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { addLeadsToCampaignAction, assignLeadsAction, markQualifiedAction, queueOutreachAction } from "@/lib/actions/wholesale";
import { formatDate, formatNumber, formatTimeAgo } from "@/lib/format";
import type { LeadListRow } from "@/lib/queries/wholesale";
import { CALL_OUTCOME_LABEL, type CallOutcome, FILTER_REASON_LABEL, LEAD_STATUS_TONE, OUTREACH_CHANNEL_LABEL, OUTREACH_CHANNELS, type OutreachChannel } from "@/lib/wholesale/constants";
import { cn } from "@/lib/utils";
import { LeadQuickLog } from "@/app/(dashboard)/wholesale/leads/lead-quick-log";
import type { FieldHandoffOptions } from "@/lib/wholesale/field-handoff";
import { HandoffPanel } from "@/app/(dashboard)/wholesale/leads/handoff-panel";

const GRADE_TONE: Record<string, string> = {
  A: "bg-emerald-600 text-white",
  B: "bg-sky-600 text-white",
  C: "bg-amber-500 text-white",
  D: "bg-slate-400 text-white",
};

const TONE_CLASS: Record<string, string> = {
  slate: "bg-muted text-foreground",
  blue: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
  green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  rose: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
};

export function GradeBadge({ grade, score }: { grade: string | null; score: number | null }) {
  if (!grade || score == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={cn("inline-flex size-6 items-center justify-center rounded-md text-xs font-bold", GRADE_TONE[grade] ?? "bg-muted")}>{grade}</span>
      <span className="tabular-nums text-sm font-semibold">{score}</span>
    </span>
  );
}

export function LeadStatusBadge({ status, label }: { status: LeadListRow["status"]; label: string }) {
  return <Badge className={cn("whitespace-nowrap border-0 font-medium", TONE_CLASS[LEAD_STATUS_TONE[status]])}>{label}</Badge>;
}

const columns: ColumnDef<LeadListRow, unknown>[] = [
  {
    id: "name",
    header: "Doanh nghiệp",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-[220px] max-w-[300px]">
          <RowLink href={`/wholesale/leads/${r.id}`} className="block truncate">
            {r.name ?? <span className="italic text-muted-foreground">Dữ liệu Google đã hết hạn lưu — mở để làm mới</span>}
          </RowLink>
          <div className="truncate text-[11px] text-muted-foreground">
            {r.segmentLabel}
            {r.area || r.province ? ` · ${[r.area, r.province].filter(Boolean).join(", ")}` : ""}
          </div>
          {r.enrichment !== "READY" ? <div className="text-[11px] text-amber-700 dark:text-amber-300">{r.enrichment === "PENDING_DETAILS" ? "Đang lấy SĐT / website…" : (FILTER_REASON_LABEL[r.filterReason ?? ""] ?? r.filterReason ?? r.enrichment)}</div> : null}
        </div>
      );
    },
  },
  {
    id: "contact",
    header: "Liên hệ",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-[130px] text-sm">
          {r.phoneDisplay ? (
            <a href={`tel:${r.phone?.startsWith("+84") ? `0${r.phone.slice(3)}` : r.phone}`} className="font-medium tabular-nums hover:underline" onClick={(e) => e.stopPropagation()}>
              {r.phoneDisplay}
            </a>
          ) : (
            <span className="text-muted-foreground">Chưa có SĐT</span>
          )}
          <div className="text-[11px] text-muted-foreground">{[r.phoneKindLabel, r.website ? "có website" : null].filter(Boolean).join(" · ") || "—"}</div>
        </div>
      );
    },
  },
  {
    id: "rating",
    header: "Đánh giá",
    meta: { align: "right" },
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="whitespace-nowrap text-right text-sm">
          {r.rating != null ? <span className="tabular-nums">{r.rating.toFixed(1)}★</span> : <span className="text-muted-foreground">—</span>}
          <div className="text-[11px] tabular-nums text-muted-foreground">{r.reviews != null ? `${formatNumber(r.reviews)} đánh giá` : "—"}</div>
        </div>
      );
    },
  },
  {
    id: "leadScore",
    header: "Điểm",
    cell: ({ row }) => <GradeBadge grade={row.original.grade} score={row.original.score} />,
  },
  {
    id: "status",
    header: "Trạng thái",
    cell: ({ row }) => (
      <div className="min-w-[120px]">
        <LeadStatusBadge status={row.original.status} label={row.original.statusLabel} />
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.original.assignee ?? "Chưa giao"}</div>
      </div>
    ),
  },
  {
    id: "lastContactAt",
    header: "Liên hệ & ghi chú",
    cell: ({ row }) => {
      const r = row.original;
      return (
        <div className="min-w-[180px] max-w-[300px] text-sm">
          {r.lastContactAt ? formatTimeAgo(r.lastContactAt) : <span className="text-muted-foreground">Chưa liên hệ</span>}
          {r.nextFollowupAt || r.nextAction ? (
            <div className="truncate text-[11px] text-muted-foreground">
              {r.nextFollowupAt ? `Gọi lại ${formatDate(r.nextFollowupAt)}` : ""}
              {r.nextAction ? `${r.nextFollowupAt ? " · " : ""}${r.nextAction}` : ""}
            </div>
          ) : null}
          {r.lastNote ? (
            <div className="line-clamp-2 text-[11px] italic text-foreground/80" title={r.lastNote}>
              {r.lastNoteOutcome ? `${CALL_OUTCOME_LABEL[r.lastNoteOutcome as CallOutcome] ?? r.lastNoteOutcome}: ` : ""}
              {r.lastNote}
            </div>
          ) : null}
        </div>
      );
    },
  },
];

/** Cột thao tác: ghi kết quả cuộc gọi / ghi chú ngay trên dòng (chỉ người có wholesale:work). */
const actionColumn: ColumnDef<LeadListRow, unknown> = {
  id: "actions",
  header: "",
  cell: ({ row }) => {
    const r = row.original;
    return <LeadQuickLog lead={{ id: r.id, name: r.name, status: r.status, phone: r.phone, phoneDisplay: r.phoneDisplay }} />;
  },
};

const SORTABLE = ["leadScore", "status", "lastContactAt", "rating"];
const columnsWithActions = [...columns, actionColumn];

export function LeadsTable(props: { rows: LeadListRow[]; pageCount: number; total: number; users: { id: string; name: string }[]; campaigns: { value: string; label: string }[]; canAssign: boolean; canWork: boolean; handoff: FieldHandoffOptions }) {
  return (
    <DataTable
      columns={props.canWork ? columnsWithActions : columns}
      data={props.rows}
      pageCount={props.pageCount}
      total={props.total}
      getRowId={(r) => r.id}
      rowHref={(r) => `/wholesale/leads/${r.id}`}
      selectable={props.canAssign || props.canWork}
      bulkActions={(selected, clear) => <BulkBar ids={selected.map((r) => r.id)} clear={clear} {...props} />}
      defaultSort="leadScore"
      sortable={SORTABLE}
      defaultPageSize={50}
      dense
      emptyTitle="Chưa có lead nào khớp bộ lọc"
      emptyDescription="Chạy một chiến dịch ở tab «Săn khách (quét)» hoặc nhập tệp CSV để có lead đầu tiên."
    />
  );
}

function BulkBar({ ids, clear, users, campaigns, canAssign, canWork, handoff }: { ids: string[]; clear: () => void; users: { id: string; name: string }[]; campaigns: { value: string; label: string }[]; canAssign: boolean; canWork: boolean; handoff: FieldHandoffOptions }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [showHandoff, setShowHandoff] = useState(false);
  const [assignee, setAssignee] = useState("");
  const [campaign, setCampaign] = useState("");
  const [channel, setChannel] = useState<OutreachChannel>("PHONE_CALL");
  const run = <T extends object>(fn: () => Promise<{ error: string } | ({ ok: true } & T)>, done: (r: T) => string) =>
    start(async () => {
      const r = await fn();
      if ("error" in r && typeof r.error === "string") toast.error(r.error);
      else {
        toast.success(done(r as T));
        clear();
        router.refresh();
      }
    });
  const sel = "h-8 rounded-md border bg-background px-2 text-sm";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canAssign ? (
        <>
          <select className={sel} value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Giao cho">
            <option value="">Giao cho…</option>
            <option value="__none">— Bỏ giao —</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={pending || !assignee} onClick={() => run(() => assignLeadsAction({ leadIds: ids, userId: assignee === "__none" ? null : assignee }), (r) => `Đã đổi người phụ trách ${r.changed} lead`)}>
            Giao việc
          </Button>
          <select className={sel} value={campaign} onChange={(e) => setCampaign(e.target.value)} aria-label="Thêm vào chiến dịch">
            <option value="">Chiến dịch…</option>
            {campaigns.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={pending || !campaign} onClick={() => run(() => addLeadsToCampaignAction({ leadIds: ids, campaignId: campaign }), (r) => `Đã thêm ${r.added} lead${Number(r.blocked) ? ` · ${r.blocked} lead KHÔNG LIÊN HỆ bị bỏ qua` : ""}`)}>
            Thêm vào chiến dịch
          </Button>
          <Button size="sm" variant="outline" asChild>
            <a href={`/api/wholesale/export?ids=${ids.join(",")}`}>Xuất CSV</a>
          </Button>
        </>
      ) : null}
      {canWork ? (
        <>
          <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => markQualifiedAction(ids), (r) => `Đã chuyển ${r.changed} lead «Mới» sang «Đủ điều kiện»`)}>
            Đủ điều kiện
          </Button>
          <select className={sel} value={channel} onChange={(e) => setChannel(e.target.value as OutreachChannel)} aria-label="Kênh liên hệ">
            {OUTREACH_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {OUTREACH_CHANNEL_LABEL[c]}
              </option>
            ))}
          </select>
          <Button size="sm" disabled={pending} onClick={() => run(() => queueOutreachAction(ids, channel), (r) => `Đã soạn ${r.queued} lời chào chờ duyệt${Number(r.skipped) ? ` · bỏ qua ${r.skipped} (không liên hệ / thiếu kênh / đã có lời chào chờ)` : ""}`)}>
            Xếp hàng liên hệ
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowHandoff((v) => !v)}>
            Gửi NV thị trường
          </Button>
          {showHandoff ? (
            <div className="w-full max-w-md rounded-md border bg-background p-2">
              <HandoffPanel
                leadIds={ids}
                options={handoff}
                onDone={() => {
                  setShowHandoff(false);
                  clear();
                }}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
