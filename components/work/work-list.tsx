"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlarmClock, Ban, CheckCircle2, ExternalLink, Hand, Loader2, MessageSquarePlus, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/ui-bits";
import { DEPARTMENT_LABEL, type DepartmentCode } from "@/lib/constants/departments";
import { MONEY_CONFIDENCE_LABEL, WORK_PRIORITY_LABEL, WORK_PRIORITY_TONE, WORK_STATUS_LABEL, WORK_STATUS_TONE, slaStateOf, type WorkItem } from "@/lib/constants/work";
import { WORK_ACTION, type WorkActionKey } from "@/lib/constants/work-actions";
import { WORK_SOURCE_SPEC, type WorkSource } from "@/lib/constants/work-sources";
import { runWorkAction } from "@/lib/actions/work-quick";
import { formatDateTime, formatVND } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * ═══════════ MỘT DÒNG VIỆC LÀ CHỖ LÀM VIỆC ═══════════
 *
 * Ba luật, cùng ba luật của bảng CSKH (`app/(dashboard)/cs/cs-table.tsx`) vì chúng đã được chứng
 * minh trên người dùng thật:
 *
 *  1. **Phản hồi tại chỗ.** Bấm xong dòng đổi ngay, `router.refresh()` chỉ chạy SAU khi máy chủ
 *     xác nhận. Hỏng thì hoàn tác đúng dòng và báo lỗi tại đó — không nhảy trang, không mất chỗ cuộn.
 *  2. **Chữ dài không chiếm chỗ của nút.** Dòng giữ một câu; bằng chứng và giải thích nằm sau ⓘ.
 *  3. **Nút phụ thuộc NGUỒN.** `WORK_SOURCE_SPEC[...].actions` khai việc làm được với từng loại;
 *     ở đây chỉ dịch sang nút. Nút `LINK` không có đích thật thì ẩn — một nút bấm vào không đi đâu
 *     làm người dùng mất tin vào cả hàng nút.
 */

type Patch = { status?: string; assigneeName?: string; done?: boolean };

/** Nút có biểu tượng riêng; còn lại dùng nhãn chữ. */
const ICONS: Partial<Record<WorkActionKey, typeof Hand>> = {
  WORK_CLAIM: Hand,
  CS_CLAIM: Hand,
  WORK_NOTE: MessageSquarePlus,
  CARE_NOTE: MessageSquarePlus,
  WORK_SNOOZE: AlarmClock,
  CS_SNOOZE: AlarmClock,
  CARE_FOLLOW_UP: AlarmClock,
  WORK_BLOCK: Ban,
  CS_DONE: CheckCircle2,
  CARE_RESOLVE: CheckCircle2,
  RETURN_RECEIVE: CheckCircle2,
};

/** Bốn kiểu hẹn bấm một phát — cùng khung giờ với CSKH (khách nhắn ban ngày). */
const SNOOZE_PRESETS: { label: string; hours: number }[] = [
  { label: "+2 giờ", hours: 2 },
  { label: "+4 giờ", hours: 4 },
  { label: "Sáng mai", hours: -1 },
  { label: "+2 ngày", hours: 48 },
];

function snoozeTarget(hours: number): Date {
  if (hours >= 0) return new Date(Date.now() + hours * 3_600_000);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

function MoneyCell({ item }: { item: WorkItem }) {
  const { atRisk, confidence, basis } = item.money;
  /*
    `null` LÀ CHƯA BIẾT, KHÔNG PHẢI 0đ (AGENTS.md mục 0.3).
    In "0đ" ở đây làm người đọc tin rằng việc này không giữ đồng nào — trong khi sự thật là ERP
    chưa tra được. Hai kết luận đó dẫn tới hai quyết định khác nhau.
  */
  if (atRisk === null) return <span className="text-xs text-muted-foreground" title="ERP chưa tra được số tiền gắn với việc này">chưa tra được</span>;
  return (
    <span className="whitespace-nowrap text-xs font-medium tabular-nums" title={basis}>
      {formatVND(atRisk, { compact: true })}
      {confidence === "ESTIMATED" ? <span className="ml-1 font-normal text-muted-foreground">(ước tính)</span> : null}
    </span>
  );
}

/**
 * Khoảng cách tới hạn, đọc được cả hai chiều.
 *
 * KHÔNG dùng `formatTimeAgo`: hàm đó viết cho MỐC QUÁ KHỨ và trả "vừa xong" với mọi mốc tương lai
 * (hiệu số âm rơi vào nhánh `< 1 phút`). Một việc còn hạn ba ngày sẽ hiện "vừa xong" — sai theo
 * đúng hướng nguy hiểm nhất: nó làm việc gấp trông như việc đã xong.
 */
function untilLabel(due: Date, now: number): string {
  const mins = Math.round(Math.abs(due.getTime() - now) / 60_000);
  if (mins < 60) return `${mins} phút`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} giờ`;
  return `${Math.round(hours / 24)} ngày`;
}

function SlaCell({ item, now }: { item: WorkItem; now: number }) {
  const due = item.slaAt ?? item.dueAt;
  const state = slaStateOf(due, new Date(now));
  if (state === "NONE" || !due) return <span className="text-xs text-muted-foreground" title="Loại việc này cố ý không đặt hạn">không đặt hạn</span>;
  const tone = state === "BREACHED" ? "font-semibold text-destructive" : state === "DUE_SOON" ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground";
  return (
    <span className={cn("whitespace-nowrap text-xs tabular-nums", tone)} title={formatDateTime(due)}>
      {state === "BREACHED" ? `quá hạn ${untilLabel(due, now)}` : `còn ${untilLabel(due, now)}`}
    </span>
  );
}

export function WorkList({ items, emptyTitle, emptyDescription, showDepartment = false, canAct = true }: { items: WorkItem[]; emptyTitle: string; emptyDescription?: string; showDepartment?: boolean; canAct?: boolean }) {
  const [patches, setPatches] = useState<Record<string, Patch>>({});
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const now = Date.now();

  // Dữ liệu mới từ máy chủ đã về ⇒ bỏ lớp vẽ tạm, không để hai nguồn sự thật chồng nhau.
  useEffect(() => setPatches({}), [items]);

  const run = async (key: string, optimistic: Patch, payload: { action: WorkActionKey; note?: string; at?: string; value?: string }, okMessage: string) => {
    const rollback = patches[key];
    setPatches((p) => ({ ...p, [key]: { ...p[key], ...optimistic } }));
    setPendingKey(key);
    const res = await runWorkAction({ key, ...payload });
    setPendingKey(null);
    if ("error" in res) {
      setPatches((p) => ({ ...p, [key]: rollback ?? {} }));
      toast.error(res.error);
      return;
    }
    toast.success(okMessage);
    startTransition(() => router.refresh());
  };

  if (!items.length) return <EmptyState title={emptyTitle} description={emptyDescription} icon={CheckCircle2} />;

  return (
    <ul className="divide-y rounded-lg border">
      {items.map((item) => {
        const patch = patches[item.key] ?? {};
        const status = (patch.status ?? item.status) as WorkItem["status"];
        const assigneeName = patch.assigneeName ?? item.assignee?.name ?? "";
        const busy = pendingKey === item.key;
        const spec = WORK_SOURCE_SPEC[item.sourceType as WorkSource];

        return (
          <li key={item.key} className={cn("flex flex-col gap-2 p-3 transition-opacity sm:flex-row sm:items-start sm:gap-3", (busy || patch.done) && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="secondary" className={cn("text-[11px]", WORK_PRIORITY_TONE[item.priority])}>{WORK_PRIORITY_LABEL[item.priority]}</Badge>
                <Badge variant="secondary" className={cn("text-[11px]", WORK_STATUS_TONE[status])}>{WORK_STATUS_LABEL[status]}</Badge>
                {showDepartment ? <Badge variant="outline" className="text-[11px]">{DEPARTMENT_LABEL[item.department as DepartmentCode] ?? item.department}</Badge> : null}
                <span className="text-[11px] text-muted-foreground">{spec?.label ?? item.sourceType}</span>
              </div>
              <p className="mt-1 truncate text-sm font-medium" title={item.title}>{item.title}</p>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={item.recommendedAction || item.summary}>{item.recommendedAction || item.summary}</p>
              {item.blockedReason ? (
                <p className="mt-1 flex items-center gap-1 text-xs font-medium text-destructive"><ShieldAlert className="size-3.5 shrink-0" />{item.blockedReason}</p>
              ) : null}
            </div>

            <div className="flex shrink-0 flex-col items-start gap-0.5 sm:w-[140px] sm:items-end">
              <SlaCell item={item} now={now} />
              <MoneyCell item={item} />
              <span className="truncate text-xs text-muted-foreground" title={item.money.confidence !== "UNKNOWN" ? MONEY_CONFIDENCE_LABEL[item.money.confidence] : ""}>
                {assigneeName || "chưa ai nhận"}
              </span>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-1 sm:w-[290px] sm:justify-end">
              {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
              {item.actions.map((a) => {
                const key = a as WorkActionKey;
                const actSpec = WORK_ACTION[key];
                if (!actSpec) return null;
                if (!canAct && actSpec.mode !== "LINK") return null;
                const Icon = ICONS[key];

                if (actSpec.mode === "LINK") {
                  // Không có đích thật thì không vẽ nút — xem luật 3 ở đầu tệp.
                  if (!item.sourceUrl) return null;
                  return (
                    <Button key={key} asChild size="sm" variant="ghost" className="h-7 px-2 text-xs" title={actSpec.hint}>
                      <Link href={item.sourceUrl} target={item.sourceUrl.startsWith("http") ? "_blank" : undefined}>
                        <ExternalLink className="size-3.5" /> {actSpec.label}
                      </Link>
                    </Button>
                  );
                }

                if (key === "WORK_SNOOZE" || key === "CS_SNOOZE" || key === "CARE_FOLLOW_UP") {
                  return (
                    <Popover key={key}>
                      <PopoverTrigger asChild>
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title={actSpec.hint} disabled={busy}>
                          {Icon ? <Icon className="size-3.5" /> : null} {actSpec.label}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-44 p-1.5" align="end">
                        <div className="grid gap-1">
                          {SNOOZE_PRESETS.map((p) => (
                            <Button key={p.label} size="sm" variant="ghost" className="h-7 justify-start text-xs" onClick={() => run(item.key, {}, { action: key, at: snoozeTarget(p.hours).toISOString() }, `Đã hẹn ${p.label.toLowerCase()}`)}>
                              {p.label}
                            </Button>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  );
                }

                if (key === "WORK_NOTE" || key === "CARE_NOTE" || key === "WORK_BLOCK") {
                  return <NoteButton key={key} label={actSpec.label} hint={actSpec.hint} icon={Icon} disabled={busy} required={key === "WORK_BLOCK"} onSubmit={(note) => run(item.key, key === "WORK_BLOCK" ? { status: "BLOCKED" } : {}, { action: key, note }, key === "WORK_BLOCK" ? "Đã báo bị chặn" : "Đã ghi chú")} />;
                }

                const closes = key === "CS_DONE" || key === "CARE_RESOLVE" || key === "RETURN_RECEIVE";
                return (
                  <Button
                    key={key}
                    size="sm"
                    variant={closes ? "outline" : "ghost"}
                    className="h-7 px-2 text-xs"
                    title={actSpec.hint}
                    disabled={busy}
                    onClick={() => run(item.key, closes ? { status: "DONE", done: true } : key.endsWith("CLAIM") ? { status: "ASSIGNED" } : {}, { action: key }, `${actSpec.label}: xong`)}
                  >
                    {Icon ? <Icon className="size-3.5" /> : null} {actSpec.label}
                  </Button>
                );
              })}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function NoteButton({ label, hint, icon: Icon, disabled, required, onSubmit }: { label: string; hint: string; icon?: typeof Hand; disabled?: boolean; required?: boolean; onSubmit: (note: string) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" title={hint} disabled={disabled}>
          {Icon ? <Icon className="size-3.5" /> : null} {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 space-y-2 p-2.5" align="end">
        <p className="text-xs text-muted-foreground">{hint}</p>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={required ? "Đang vướng cái gì? (bắt buộc)" : "Nội dung ghi chú"} className="text-sm" />
        <Button
          size="sm"
          className="w-full"
          disabled={required && !text.trim()}
          onClick={() => {
            onSubmit(text.trim());
            setText("");
            setOpen(false);
          }}
        >
          Lưu
        </Button>
      </PopoverContent>
    </Popover>
  );
}
