"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlarmClock, Ban, CheckCircle2, ExternalLink, Hand, Loader2, MessageSquarePlus, MoreHorizontal, ShieldAlert } from "lucide-react";
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
import { WorkHistoryButton } from "@/components/work/work-history";
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

/** Bao nhiêu nút hiện thẳng trên dòng; phần còn lại vào menu ba chấm. */
const INLINE_ACTIONS = 3;

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

/**
 * ═══════ DẠNG GỌN: SÁU THỨ TRÊN MỘT DÒNG, KHÔNG THỨ BẢY ═══════
 *
 * `compact` là dạng mặc định của màn hình mở đầu ca (`/work`). Một dòng chỉ được mang đúng sáu
 * thứ: **việc cần làm · thực thể · tiền · hạn · người cầm · nút bấm**. Mọi lời giải thích lùi vào
 * tooltip.
 *
 * Vì sao phải cắt: nhân viên quét hàng đợi 40 dòng vào đầu ca. Mỗi dòng cao thêm một dòng chữ là
 * cả danh sách dài thêm một màn hình, và thứ bị đẩy xuống dưới nếp gấp là việc quá hạn ở cuối rổ.
 * Nhãn trạng thái cũng bỏ ở dạng gọn: tên cái rổ đã nói rồi, in lại là chiếm chỗ để nhắc lại.
 *
 * Dạng đầy đủ vẫn dùng ở `/work/all` và hàng đợi phòng — nơi người ta ĐỌC để phân việc chứ không
 * quét để làm.
 */
export function WorkList({ items, emptyTitle, emptyDescription, showDepartment = false, canAct = true, compact = false }: { items: WorkItem[]; emptyTitle: string; emptyDescription?: string; showDepartment?: boolean; canAct?: boolean; compact?: boolean }) {
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
        // Ba nút đầu của nguồn là ba việc hay làm nhất với loại việc đó (xem `WORK_SOURCE_SPEC`).
        const usable = item.actions.filter((a) => WORK_ACTION[a as WorkActionKey] && (canAct || WORK_ACTION[a as WorkActionKey].mode === "LINK"));
        const visible = usable.slice(0, INLINE_ACTIONS);
        const overflow = usable.slice(INLINE_ACTIONS);

        return (
          <li key={item.key} className={cn("flex flex-col gap-2 p-3 transition-opacity sm:flex-row sm:items-start sm:gap-3", (busy || patch.done) && "opacity-60")}>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* Dạng gọn chỉ in mức ưu tiên khi nó KHÁC bình thường — "Bình thường" không phải tin tức. */}
                {!compact || item.priority !== "NORMAL" ? (
                  <Badge variant="secondary" className={cn("text-[11px]", WORK_PRIORITY_TONE[item.priority])}>{WORK_PRIORITY_LABEL[item.priority]}</Badge>
                ) : null}
                {/* Tên rổ đã nói trạng thái ở dạng gọn; chỉ hai trạng thái "đang mắc" mới đáng in lại. */}
                {!compact || status === "BLOCKED" || status === "WAITING" ? (
                  <Badge variant="secondary" className={cn("text-[11px]", WORK_STATUS_TONE[status])}>{WORK_STATUS_LABEL[status]}</Badge>
                ) : null}
                {showDepartment ? <Badge variant="outline" className="text-[11px]">{DEPARTMENT_LABEL[item.department as DepartmentCode] ?? item.department}</Badge> : null}
                <span className="text-[11px] text-muted-foreground">{spec?.label ?? item.sourceType}</span>
                {/*
                  THỰC THỂ NGHIỆP VỤ — mã đơn / mã vận đơn / mã giao dịch.

                  Không có nó thì người làm phải mở từng dòng ra mới biết việc này dính tới đơn nào,
                  và "gọi khách đơn nào" là câu hỏi đầu tiên của mọi ca. In mã ngay trên dòng cắt
                  đúng một cú bấm khỏi mỗi việc.
                */}
                {item.businessEntityId ? (
                  <span className="max-w-[150px] truncate rounded bg-muted px-1 font-mono text-[10px] text-muted-foreground" title={`${item.businessEntity}: ${item.businessEntityId}`}>
                    {item.businessEntityId}
                  </span>
                ) : null}
              </div>
              <p className="mt-1 truncate text-sm font-medium" title={compact ? `${item.title}\n\n${item.recommendedAction || item.summary}` : item.title}>{item.title}</p>
              {compact ? null : (
                <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground" title={item.recommendedAction || item.summary}>{item.recommendedAction || item.summary}</p>
              )}
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

            <div className="flex shrink-0 flex-wrap items-center gap-1 sm:w-[320px] sm:justify-end">
              {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
              <WorkHistoryButton workKey={item.key} />
              {visible.map((a) => {
                const key = a as WorkActionKey;
                const actSpec = WORK_ACTION[key];
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
              {/*
                TRÀN VÀO MENU, KHÔNG XUỐNG DÒNG.

                Một dòng việc có tới tám hành động. In hết ra hàng ngang thì chúng xuống ba dòng và
                dòng việc cao gấp ba — quét 40 việc thành cuộn ba màn hình, đúng cái bệnh mà bảng
                CSKH đã chữa. Ba nút hay dùng nhất ở ngoài, phần còn lại sau dấu ba chấm.
              */}
              {overflow.length ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" className="h-7 px-1.5 text-xs" title="Thao tác khác" disabled={busy}>
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1.5" align="end">
                    <div className="grid gap-0.5">
                      {overflow.map((a) => {
                        const key = a as WorkActionKey;
                        const actSpec = WORK_ACTION[key];
                        const Icon = ICONS[key];
                        if (actSpec.mode === "LINK") {
                          if (!item.sourceUrl) return null;
                          return (
                            <Button key={key} asChild size="sm" variant="ghost" className="h-8 justify-start text-xs">
                              <Link href={item.sourceUrl}><ExternalLink className="size-3.5" /> {actSpec.label}</Link>
                            </Button>
                          );
                        }
                        if (key === "WORK_SNOOZE" || key === "CS_SNOOZE" || key === "CARE_FOLLOW_UP") {
                          return (
                            <div key={key} className="grid gap-0.5 border-t pt-1 first:border-0 first:pt-0">
                              <p className="px-2 pt-1 text-[11px] font-medium text-muted-foreground">{actSpec.label}</p>
                              {SNOOZE_PRESETS.map((pre) => (
                                <Button key={pre.label} size="sm" variant="ghost" className="h-7 justify-start text-xs" onClick={() => run(item.key, {}, { action: key, at: snoozeTarget(pre.hours).toISOString() }, `Đã hẹn ${pre.label.toLowerCase()}`)}>
                                  {pre.label}
                                </Button>
                              ))}
                            </div>
                          );
                        }
                        if (key === "WORK_NOTE" || key === "CARE_NOTE" || key === "WORK_BLOCK") {
                          return <NoteButton key={key} label={actSpec.label} hint={actSpec.hint} icon={Icon} disabled={busy} required={key === "WORK_BLOCK"} full onSubmit={(note) => run(item.key, key === "WORK_BLOCK" ? { status: "BLOCKED" } : {}, { action: key, note }, key === "WORK_BLOCK" ? "Đã báo bị chặn" : "Đã ghi chú")} />;
                        }
                        return (
                          <Button key={key} size="sm" variant="ghost" className="h-8 justify-start text-xs" disabled={busy} onClick={() => run(item.key, key.endsWith("CLAIM") ? { status: "ASSIGNED" } : {}, { action: key }, `${actSpec.label}: xong`)}>
                            {Icon ? <Icon className="size-3.5" /> : null} {actSpec.label}
                          </Button>
                        );
                      })}
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function NoteButton({ label, hint, icon: Icon, disabled, required, full, onSubmit }: { label: string; hint: string; icon?: typeof Hand; disabled?: boolean; required?: boolean; full?: boolean; onSubmit: (note: string) => void }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className={cn("text-xs", full ? "h-8 justify-start" : "h-7 px-2")} title={hint} disabled={disabled}>
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
