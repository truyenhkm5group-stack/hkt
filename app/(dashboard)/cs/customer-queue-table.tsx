"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlarmClock, ChevronDown, ChevronRight, ExternalLink, Loader2, MessageCircle, MessageSquarePlus, Truck } from "lucide-react";
import { toast } from "sonner";
import { CopyButton } from "@/components/misc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { addCsCaseNote, csBulkAction, csQuickAction } from "@/lib/actions/cs";
import { CS_KIND_LABEL, CS_STATUS_LABEL, CS_STATUS_TONE, type CsKind, type CsStatus } from "@/lib/constants/cs";
import { CS_QUICK_ACTION, CS_QUICK_ACTIONS_BY_KIND, CS_SNOOZE_PRESETS, type CsQuickActionKey } from "@/lib/constants/cs-actions";
import { CS_SLA_BUCKET_HINT, CS_SLA_BUCKET_LABEL, CS_SLA_BUCKET_TONE, csSlaLabel, type CsNextActionKey, type CsSlaBucket } from "@/lib/constants/cs-next-action";
import { NESTED_ROW, ROW_EXPANDED, ROW_PARENT, ROW_SELECTED, STICKY_ACTIONS, STICKY_ACTIONS_HEAD, STICKY_ACTIONS_SELECTED, STICKY_HEAD, STICKY_TOOLBAR, TABLE_SCROLL } from "@/lib/constants/table-ux";
import { formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CsStaff } from "@/app/(dashboard)/cs/cs-table";
import { StaleHintChip } from "@/app/(dashboard)/cs/stale-hint";
import type { CsStaleHint } from "@/lib/queries/cs";

/**
 * ═══════ MỘT KHÁCH — MỘT DÒNG VIỆC, VÀ LÀM ĐƯỢC VIỆC NGAY TRÊN DÒNG ĐÓ ═══════
 *
 * ─── BẢN TRƯỚC CHỈ ĐỂ XEM ───
 *
 * Dòng gom hiện đúng năm thứ: tên, SĐT, số việc, loại việc, ai nhận. Muốn LÀM gì thì phải đổi
 * sang tab "Theo từng việc", tìm lại đúng case, rồi bấm ở đó. Người trực gọi cho một khách có bốn
 * việc phải chuyển tab bốn lần — nên thực tế họ không dùng tab này.
 *
 * ─── BA ĐIỀU LÀM NÊN MỘT HÀNG ĐỢI DÙNG ĐƯỢC ───
 *
 *  1. **Dòng nói việc nên làm tiếp, không chỉ nói trạng thái.** Cột "Việc nên làm tiếp" là kết quả
 *     của một luật xác định (`lib/constants/cs-next-action.ts`), kèm CÂU CĂN CỨ — không có câu đó
 *     thì không ai tin cái nhãn.
 *  2. **Nút trên dòng cha nói rõ nó chạm vào cái gì.** "Nhận việc" và "Hẹn lại" áp cho TOÀN BỘ case
 *     đang mở của khách (cả hai chỉ nói AI LÀM / LÚC NÀO nên nghĩa không đổi theo loại case).
 *     "Đã xử lý" thì KHÔNG bao giờ ở mức khách khi còn nhiều hơn một việc — đóng một lượt bốn việc
 *     khác loại là khẳng định bốn thứ khác nhau đều xong, và không ai kiểm được câu đó.
 *  3. **Bung ra là thấy đủ từng việc, và làm được ở đó.** Mỗi case giữ nguyên mã, loại, đơn, nguồn,
 *     mốc tạo và nhật ký của nó; đóng một case KHÔNG đóng những case còn lại.
 *
 * ─── TƯƠNG PHẢN LÀ MỘT HỢP ĐỒNG, KHÔNG PHẢI MỘT LỰA CHỌN CỦA TRANG NÀY ───
 *
 * Nền khối bung, dòng con, dòng đang chọn đều lấy từ `lib/constants/table-ux.ts`. Bản trước dùng
 * `bg-muted/30` tại chỗ và ở chế độ tối nó gần như trùng nền thẻ.
 */

export type CustomerQueueCase = {
  id: string;
  kind: string;
  status: string;
  source: string;
  orderId: string | null;
  orderSystemId: number | null;
  title: string;
  createdAt: string;
  followUpAt: string | null;
  assignee: string;
  dueAt: string | null;
  slaBucket: CsSlaBucket;
  chatUrl: string | null;
  /** Chứng từ đã đi tiếp mà case vẫn mở — `lib/queries/cs.ts::staleHints`. */
  staleHint: CsStaleHint | null;
};

export type CustomerQueueRow = {
  key: string;
  customerName: string;
  customerPhone: string;
  openCount: number;
  overdueCount: number;
  kinds: string[];
  oldestAt: string;
  dueAt: string | null;
  slaBucket: CsSlaBucket;
  owners: string[];
  anyAssigned: boolean;
  nextAction: { key: CsNextActionKey; label: string; cta: CsQuickActionKey | null; caseId: string | null; reason: string };
  chatUrl: string | null;
  cases: CustomerQueueCase[];
};

const OPEN_STATUSES = ["OPEN", "IN_PROGRESS"];
const isOpen = (s: string) => OPEN_STATUSES.includes(s);

function snoozeTarget(hours: number): Date {
  if (hours >= 0) return new Date(Date.now() + hours * 3_600_000);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(8, 0, 0, 0);
  return d;
}

/** Chip HẠN — chỉ màu chữ, không nền đặc (xem `CS_SLA_BUCKET_TONE`). */
function SlaChip({ bucket, dueAt, className }: { bucket: CsSlaBucket; dueAt: string | null; className?: string }) {
  const now = new Date();
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs font-medium", CS_SLA_BUCKET_TONE[bucket], className)} title={`${CS_SLA_BUCKET_LABEL[bucket]} — ${CS_SLA_BUCKET_HINT[bucket]}${dueAt ? ` · hạn ${formatDateTime(dueAt)}` : ""}`}>
      <AlarmClock className="size-3 shrink-0" />
      {csSlaLabel(dueAt ? new Date(dueAt) : null, now)}
    </span>
  );
}

export function CustomerQueueTable({ rows, staff, canWrite, currentUser }: { rows: CustomerQueueRow[]; staff: CsStaff[]; canWrite: boolean; currentUser: string }) {
  const [mo, setMo] = useState<Set<string>>(new Set());
  const [chon, setChon] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const router = useRouter();

  // Dữ liệu mới từ máy chủ về ⇒ bỏ lựa chọn cũ: giữ lại là để người dùng bấm hàng loạt lên một tập
  // dòng không còn đúng nữa.
  useEffect(() => setChon(new Set()), [rows]);

  const bung = (k: string) =>
    setMo((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const doiChon = (k: string) =>
    setChon((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  /** Case đang mở của các khách đang chọn — đây là tập mà nút hàng loạt thật sự chạm vào. */
  const caseDangChon = useMemo(() => rows.filter((r) => chon.has(r.key)).flatMap((r) => r.cases.filter((c) => isOpen(c.status)).map((c) => c.id)), [rows, chon]);

  const chay = async (key: string, call: () => Promise<{ ok: true } | { error: string }>, okMessage?: string) => {
    setBusyKey(key);
    const res = await call();
    setBusyKey(null);
    if ("error" in res) {
      toast.error(res.error);
      return false;
    }
    if (okMessage) toast.success(okMessage);
    startTransition(() => router.refresh());
    return true;
  };

  const hangLoat = async (input: Parameters<typeof csBulkAction>[0]) => {
    setBusyKey("__bulk__");
    const res = await csBulkAction(input);
    setBusyKey(null);
    if ("error" in res) {
      toast.error(res.error);
      return false;
    }
    toast.success(res.message);
    setChon(new Set());
    startTransition(() => router.refresh());
    return true;
  };

  if (!rows.length) return <p className="py-10 text-center text-sm text-muted-foreground">Không có việc nào đang mở.</p>;

  return (
    <div>
      {canWrite && chon.size > 0 ? (
        <BulkBar
          customers={chon.size}
          cases={caseDangChon.length}
          staff={staff}
          busy={busyKey === "__bulk__"}
          onClear={() => setChon(new Set())}
          onRun={(input) => hangLoat({ ...input, ids: caseDangChon })}
        />
      ) : null}
      <div className={cn(TABLE_SCROLL)}>
        <Table className="min-w-[1000px]">
          <TableHeader className={STICKY_HEAD}>
            <TableRow>
              {canWrite ? <TableHead className="w-9" /> : null}
              <TableHead className="w-8" />
              <TableHead className="min-w-[170px]">Khách</TableHead>
              <TableHead className="w-[76px] text-right">Việc</TableHead>
              <TableHead className="w-[132px]">Loại việc</TableHead>
              <TableHead className="w-[125px]">Hạn</TableHead>
              {/* KHÔNG có cột "Phụ trách" riêng: nó nằm ngay dưới tên khách. Một cột nữa ở đây đẩy
                  cột Hành động ra khỏi màn hình 1440px — và cột đó là lý do tồn tại của bảng này. */}
              <TableHead className="min-w-[176px]">Việc nên làm tiếp</TableHead>
              {/* Cột hành động KHÔNG được co lại: nó là lý do tồn tại của bảng này. */}
              <TableHead className={cn("w-[268px]", STICKY_ACTIONS_HEAD)}>Hành động</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => {
              const dangMo = mo.has(r.key);
              const daChon = chon.has(r.key);
              const busy = busyKey === r.key;
              const openCases = r.cases.filter((c) => isOpen(c.status));
              const openIds = openCases.map((c) => c.id);
              const caseChinh = r.cases.find((c) => c.id === r.nextAction.caseId) ?? openCases[0] ?? null;
              return (
                <>
                  <TableRow key={r.key} className={cn("group", ROW_PARENT, daChon && ROW_SELECTED, busy && "opacity-70")} onClick={() => bung(r.key)}>
                    {canWrite ? (
                      <TableCell className="px-2" onClick={(e) => e.stopPropagation()}>
                        <Checkbox checked={daChon} onCheckedChange={() => doiChon(r.key)} aria-label={`Chọn ${r.customerName || r.customerPhone}`} />
                      </TableCell>
                    ) : null}
                    <TableCell className="px-2">{dangMo ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.customerName || "—"}</div>
                      {r.customerPhone ? (
                        <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <span className="font-mono text-xs text-muted-foreground">{r.customerPhone}</span>
                          <CopyButton value={r.customerPhone} what="SĐT" className="size-5 shrink-0 [&_svg]:size-3" />
                        </div>
                      ) : (
                        // KHÔNG bịa số: dòng không có định danh khách phải nói thẳng là chưa nối được.
                        <div className="text-xs text-muted-foreground">chưa nối được khách</div>
                      )}
                      {/* Người phụ trách đứng ngay dưới tên: cùng một câu hỏi ("ai lo khách này"),
                          nên cùng một chỗ nhìn. Bot nhắn KHÔNG phải đã có người (AGENTS.md mục 36). */}
                      {r.owners.length ? (
                        <div className="truncate text-[11px] text-foreground/70" title={`Đang cầm: ${r.owners.join(", ")}`}>
                          {r.owners.join(", ")}
                        </div>
                      ) : (
                        <div className="text-[11px] font-medium text-warning">chưa ai nhận</div>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="numeric font-semibold" title={`${r.openCount} việc đang mở`}>{formatNumber(r.openCount)}</span>
                      {r.overdueCount > 0 ? (
                        <div className="text-[11px] font-medium text-rose-700 dark:text-rose-300" title={`${r.overdueCount} việc đã quá hạn`}>
                          {formatNumber(r.overdueCount)} trễ
                        </div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      {/*
                        TỐI ĐA HAI NHÃN RỒI "+N". Một khách bốn loại việc làm ô này xuống ba dòng và
                        đẩy chiều cao dòng lên gấp đôi — hàng đợi chỉ còn hiện được hai khách một màn
                        hình. Bung dòng ra là thấy đủ từng loại, nên không mất thông tin nào.
                      */}
                      <div className="flex flex-wrap gap-1">
                        {r.kinds.slice(0, 2).map((k) => (
                          /*
                            `truncate` PHẢI nằm ở thẻ con, không nằm trên chính Badge.

                            Badge là `inline-flex … justify-center overflow-hidden`; đặt `truncate`
                            lên nó thì `text-overflow` không có tác dụng lên một nút văn bản trần,
                            và chữ bị cắt ở CẢ HAI đầu do canh giữa — "ĐT mới · xác nhận số" hiện
                            thành "T mới · xác nhận s", không có dấu ba chấm nào báo là đã cắt.
                          */
                          <Badge key={k} variant="secondary" className="max-w-[140px] justify-start text-[10px]" title={CS_KIND_LABEL[k as CsKind] ?? k}>
                            <span className="truncate">{CS_KIND_LABEL[k as CsKind] ?? k}</span>
                          </Badge>
                        ))}
                        {r.kinds.length > 2 ? (
                          <Badge variant="outline" className="text-[10px]" title={r.kinds.map((k) => CS_KIND_LABEL[k as CsKind] ?? k).join(" · ")}>
                            +{r.kinds.length - 2}
                          </Badge>
                        ) : null}
                        {(() => {
                          const het = openCases.filter((c) => c.staleHint);
                          if (!het.length) return null;
                          return (
                            <span
                              className="inline-flex shrink-0 items-center rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-900 dark:bg-amber-950/60 dark:text-amber-200"
                              title={het.map((c) => `${CS_KIND_LABEL[c.kind as CsKind] ?? c.kind}: ${c.staleHint?.reason ?? ""}`).join(" · ")}
                            >
                              {het.length}/{openCases.length} hết việc?
                            </span>
                          );
                        })()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <SlaChip bucket={r.slaBucket} dueAt={r.dueAt} />
                      <div className="text-[11px] text-muted-foreground" title={formatDate(r.oldestAt, true)}>
                        mở từ {formatDate(r.oldestAt)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium">{r.nextAction.label}</div>
                      <div className="text-[11px] text-muted-foreground">{r.nextAction.reason}</div>
                    </TableCell>
                    <TableCell className={cn(STICKY_ACTIONS, daChon && STICKY_ACTIONS_SELECTED)} onClick={(e) => e.stopPropagation()}>
                      {/* MỘT HÀNG, KHÔNG XUỐNG DÒNG: nút xuống dòng làm dòng cao gấp ba và hàng đợi
                          chỉ còn hiện được hai khách. Nút phụ đi bằng biểu tượng + tooltip. */}
                      <div className="flex flex-nowrap items-center gap-1">
                        {canWrite ? (
                          <>
                            {/* CTA của việc nên làm tiếp — nút đầu tiên, vì nó là câu trả lời của cả dòng. */}
                            {caseChinh && r.nextAction.cta ? (
                              <CaseActionButton
                                actionKey={r.nextAction.cta}
                                caseRow={caseChinh}
                                busy={busy}
                                emphasis
                                currentUser={currentUser}
                                onRun={(call, msg) => chay(r.key, call, msg)}
                              />
                            ) : null}
                            {!r.anyAssigned && openIds.length ? (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="h-7 shrink-0 whitespace-nowrap px-2"
                                disabled={busy}
                                title={`Nhận ${openIds.length} việc đang mở của khách này về mình`}
                                onClick={() => chay(r.key, () => csBulkAction({ ids: openIds, action: "CLAIM" }).then((x) => ("error" in x ? x : { ok: true as const })), `Đã nhận ${openIds.length} việc`)}
                              >
                                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Nhận việc
                              </Button>
                            ) : null}
                            {r.chatUrl ? (
                              <Button asChild size="sm" variant="outline" className="h-7 w-7 shrink-0 px-0" title={CS_QUICK_ACTION.CHAT.hint} aria-label="Chat Pancake">
                                <a href={r.chatUrl} target="_blank" rel="noreferrer">
                                  <MessageCircle className="size-3.5" />
                                </a>
                              </Button>
                            ) : null}
                            {openIds.length ? <SnoozeButton busy={busy} iconOnly label={`Hẹn lại ${openIds.length} việc`} onPick={(at) => chay(r.key, () => csBulkAction({ ids: openIds, action: "SNOOZE", followUpAt: at.toISOString() }).then((x) => ("error" in x ? x : { ok: true as const })), `Đã hẹn lại ${formatDateTime(at)}`)} /> : null}
                            {caseChinh ? <NoteButton caseId={caseChinh.id} busy={busy} /> : null}
                            {/*
                              "Đã xử lý" CHỈ khi khách còn đúng MỘT việc đang mở. Nhiều hơn một thì nút
                              nằm ở từng dòng con — đóng bốn việc khác loại bằng một cú bấm là khẳng
                              định bốn thứ khác nhau đều xong.
                            */}
                            {openCases.length === 1 ? (
                              <Button
                                size="sm"
                                className="h-7 shrink-0 whitespace-nowrap px-2"
                                disabled={busy}
                                title={`Đóng: ${CS_KIND_LABEL[openCases[0].kind as CsKind] ?? openCases[0].kind}`}
                                onClick={() => chay(r.key, () => csQuickAction({ id: openCases[0].id, action: "DONE" }), "Đã đóng case")}
                              >
                                Đã xử lý
                              </Button>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                  {dangMo ? (
                    <TableRow key={`${r.key}-chi-tiet`}>
                      <TableCell colSpan={canWrite ? 8 : 7} className={cn("p-0", ROW_EXPANDED)}>
                        <div className="pl-6 pr-3 py-1">
                          {r.cases.map((c) => (
                            <CaseLine key={c.id} c={c} canWrite={canWrite} busy={busy} currentUser={currentUser} onRun={(call, msg) => chay(r.key, call, msg)} />
                          ))}
                        </div>
                      </TableCell>
                    </TableRow>
                  ) : null}
                </>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

type RunFn = (call: () => Promise<{ ok: true } | { error: string }>, okMessage?: string) => Promise<boolean>;

/** Một việc bên trong khối bung: đủ bối cảnh để quyết, đủ nút để làm, không phải mở trang khác. */
function CaseLine({ c, canWrite, busy, currentUser, onRun }: { c: CustomerQueueCase; canWrite: boolean; busy: boolean; currentUser: string; onRun: RunFn }) {
  const keys = CS_QUICK_ACTIONS_BY_KIND[c.kind as CsKind] ?? [];
  const dong = isOpen(c.status);
  return (
    <div className={cn("flex flex-wrap items-center gap-2 py-1.5", NESTED_ROW, !dong && "opacity-60")}>
      <Badge variant="secondary" className="text-[10px]">
        {CS_KIND_LABEL[c.kind as CsKind] ?? c.kind}
      </Badge>
      <span className="min-w-0 flex-1 truncate text-xs font-medium" title={c.title}>
        {c.title}
      </span>
      <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CS_STATUS_TONE[c.status as CsStatus])}>{CS_STATUS_LABEL[c.status as CsStatus] ?? c.status}</span>
      {dong ? <StaleHintChip hint={c.staleHint} /> : null}
      {dong ? <SlaChip bucket={c.slaBucket} dueAt={c.dueAt} className="text-[11px]" /> : null}
      <span className="text-[11px] text-muted-foreground">{c.assignee || "chưa ai nhận"}</span>
      {c.orderId ? (
        <Link href={`/orders/${c.orderId}`} className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
          <ExternalLink className="size-3" /> đơn {c.orderSystemId ? `#${c.orderSystemId}` : ""}
        </Link>
      ) : null}
      {canWrite && dong ? (
        <span className="flex flex-wrap items-center gap-1">
          {keys.map((k) => (
            <CaseActionButton key={k} actionKey={k} caseRow={c} busy={busy} currentUser={currentUser} onRun={onRun} />
          ))}
          <NoteButton caseId={c.id} busy={busy} />
        </span>
      ) : null}
    </div>
  );
}

/** Một nút hành động của MỘT case. `LINK` chỉ mở đúng chỗ; `MUTATE` ghi rồi làm mới dòng. */
function CaseActionButton({
  actionKey,
  caseRow,
  busy,
  emphasis,
  currentUser,
  onRun,
}: {
  actionKey: CsQuickActionKey;
  caseRow: CustomerQueueCase;
  busy: boolean;
  emphasis?: boolean;
  currentUser: string;
  onRun: RunFn;
}) {
  const spec = CS_QUICK_ACTION[actionKey];
  void currentUser;
  if (spec.mode === "LINK") {
    const href = actionKey === "OPEN_ORDER" ? (caseRow.orderId ? `/orders/${caseRow.orderId}` : null) : actionKey === "OPEN_CARE" ? (caseRow.orderId ? `/shipments` : null) : caseRow.chatUrl;
    // Không vẽ nút dẫn tới hư không: đơn landing/sheet không có hội thoại Pancake.
    if (!href) return null;
    const external = href.startsWith("http");
    return (
      <Button asChild size="sm" variant={emphasis ? "default" : "outline"} className="h-7 shrink-0 whitespace-nowrap px-2" title={spec.hint}>
        {external ? (
          <a href={href} target="_blank" rel="noreferrer">
            {actionKey === "OPEN_CARE" ? <Truck className="size-3.5" /> : <MessageCircle className="size-3.5" />} {spec.label}
          </a>
        ) : (
          <Link href={href}>{spec.label}</Link>
        )}
      </Button>
    );
  }
  if (actionKey === "SNOOZE") {
    return <SnoozeButton busy={busy} iconOnly label={spec.label} onPick={(at) => onRun(() => csQuickAction({ id: caseRow.id, action: "SNOOZE", followUpAt: at.toISOString() }), `Đã hẹn lại ${formatDateTime(at)}`)} />;
  }
  const message = actionKey === "CONTACTED" ? "Đã ghi nhận liên hệ" : actionKey === "CLAIM" ? "Đã nhận việc" : "Đã đóng case";
  return (
    <Button
      size="sm"
      variant={emphasis ? "default" : actionKey === "DONE" || actionKey === "INFO_FIXED" ? "default" : "outline"}
      className="h-7 shrink-0 whitespace-nowrap px-2"
      disabled={busy}
      title={spec.hint}
      onClick={() => onRun(() => csQuickAction({ id: caseRow.id, action: actionKey }), message)}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} {spec.label}
    </Button>
  );
}

function SnoozeButton({ busy, label, iconOnly, onPick }: { busy: boolean; label: string; iconOnly?: boolean; onPick: (at: Date) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const luu = async (at: Date) => {
    if (await onPick(at)) setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className={cn("h-7 shrink-0", iconOnly ? "w-7 px-0" : "px-2")} disabled={busy} title={`${label} — ${CS_QUICK_ACTION.SNOOZE.hint}`} aria-label={label}>
          <AlarmClock className="size-3.5" />
          {iconOnly ? null : label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 space-y-2">
        <div className="text-xs font-semibold">Hẹn quay lại</div>
        <div className="flex flex-wrap gap-1">
          {CS_SNOOZE_PRESETS.map((p) => (
            <Button key={p.key} size="sm" variant="secondary" className="h-7 text-xs" onClick={() => luu(snoozeTarget(p.hours))}>
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Input type="datetime-local" className="h-8 text-xs" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label="Giờ hẹn lại" />
          <Button
            size="sm"
            className="h-8"
            disabled={!custom}
            onClick={() => {
              const at = new Date(custom);
              if (Number.isNaN(at.getTime())) {
                toast.error("Thời điểm không hợp lệ");
                return;
              }
              void luu(at);
            }}
          >
            Lưu
          </Button>
        </div>
        <p className="text-[11px] leading-snug text-muted-foreground">Tới hạn thì việc nổi lên đầu hàng đợi. Chưa hẹn KHÁC hẹn ngay bây giờ.</p>
      </PopoverContent>
    </Popover>
  );
}

function NoteButton({ caseId, busy }: { caseId: string; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const save = async () => {
    if (!text.trim()) return;
    setSaving(true);
    const res = await addCsCaseNote({ id: caseId, note: text.trim() });
    setSaving(false);
    if ("error" in res) {
      toast.error(res.error);
      return;
    }
    setText("");
    setOpen(false);
    toast.success("Đã lưu ghi chú");
    router.refresh();
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline" className="h-7 w-7 shrink-0 px-0" disabled={busy} aria-label="Ghi chú nhanh" title="Ghi chú nhanh — không mở trang khác">
          <MessageSquarePlus className="size-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-2">
        <div className="text-xs font-semibold">Ghi chú nhanh</div>
        <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Khách nói gì, đã làm gì…" className="text-xs" />
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setOpen(false)}>
            Đóng
          </Button>
          <Button size="sm" className="h-7 text-xs" disabled={saving || !text.trim()} onClick={save}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null} Lưu
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * ═══ THANH HÀNH ĐỘNG HÀNG LOẠT — NÓI RÕ NÓ SẮP CHẠM VÀO BAO NHIÊU VIỆC ═══
 *
 * "3 khách" là con số người dùng vừa bấm; "11 việc" là con số máy sắp ghi. Chỉ hiện cái thứ nhất
 * là để họ bấm một thao tác lớn hơn thứ họ nghĩ.
 *
 * Chỉ ba việc, và không có "Đã xử lý" — xem `CS_BULK_ACTIONS` ở `lib/constants/cs-next-action.ts`.
 */
function BulkBar({
  customers,
  cases,
  staff,
  busy,
  onClear,
  onRun,
}: {
  customers: number;
  cases: number;
  staff: CsStaff[];
  busy: boolean;
  onClear: () => void;
  onRun: (input: { action: "CLAIM" | "SNOOZE" | "ASSIGN"; followUpAt?: string; assigneeUserId?: string }) => Promise<boolean>;
}) {
  return (
    <div className={cn(STICKY_TOOLBAR, "flex flex-wrap items-center gap-2 border-b bg-row-selected px-3 py-2 text-sm")}>
      <span className="font-medium">
        {formatNumber(customers)} khách · {formatNumber(cases)} việc đang mở
      </span>
      <Button size="sm" variant="secondary" className="h-8" disabled={busy || !cases} onClick={() => onRun({ action: "CLAIM" })}>
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Nhận việc
      </Button>
      <Select disabled={busy || !cases} onValueChange={(v) => onRun({ action: "ASSIGN", assigneeUserId: v })}>
        <SelectTrigger className="h-8 w-[170px]" aria-label="Giao cho">
          <SelectValue placeholder="Giao cho…" />
        </SelectTrigger>
        <SelectContent>
          {staff.map((s) => (
            <SelectItem key={s.id} value={s.id}>
              {s.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <SnoozeButton busy={busy || !cases} label="Hẹn lại" onPick={(at) => onRun({ action: "SNOOZE", followUpAt: at.toISOString() })} />
      <Button size="sm" variant="ghost" className="h-8" onClick={onClear}>
        Bỏ chọn
      </Button>
      <span className="text-[11px] text-muted-foreground">Chỉ ba việc này bấm hàng loạt được — “Đã xử lý” phải bấm ở từng việc, vì đóng nhiều loại việc một lúc là khẳng định nhiều thứ khác nhau cùng xong.</span>
    </div>
  );
}
