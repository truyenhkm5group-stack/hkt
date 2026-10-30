"use client";

import * as React from "react";
import type { ColumnDef } from "@tanstack/react-table";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ExternalLink, MessageCircle, MoreHorizontal, UserRound } from "lucide-react";
import { DataTable, RowLink } from "@/components/data-table/data-table";
import { Money } from "@/components/ui-bits";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { fbCrmCreateTaskAction, fbCrmUpdateAction } from "@/lib/actions/fb-crm";
import { FB_CONNECTION_STATUS_LABEL, FB_CONNECTION_STATUS_TONE, FB_URL_SET_SOURCES, FB_URL_SOURCE_LABEL, type FbStatusTarget } from "@/lib/constants/fb-crm";
import { formatDate, formatNumber, formatTimeAgo } from "@/lib/format";
import type { FbCrmOpInput, FbCrmResult } from "@/lib/fb-crm/service";
import type { FbCrmRow } from "@/lib/queries/fb-crm";
import { cn } from "@/lib/utils";

type UserOption = { id: string; name: string };
type DialogMode = "url" | "dnc" | "owner" | "care" | "task" | null;

function Avatar({ row }: { row: FbCrmRow }) {
  const [broken, setBroken] = React.useState(false);
  if (row.avatarUrl && !broken) {
    // eslint-disable-next-line @next/next/no-img-element -- ảnh CDN Meta / proxy ERP, không qua bộ tối ưu ảnh
    return <img src={row.avatarUrl} alt="" className="size-8 shrink-0 rounded-full object-cover" onError={() => setBroken(true)} referrerPolicy="no-referrer" />;
  }
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground" aria-hidden>
      {(row.name || "?").trim().charAt(0).toUpperCase()}
    </span>
  );
}

function useRun() {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  const run = React.useCallback(
    (fn: () => Promise<FbCrmResult>, after?: () => void) =>
      start(async () => {
        const r = await fn();
        if (!r.ok) return void toast.error(r.error);
        if (r.changed) toast.success(r.message);
        else toast.info(r.message);
        after?.();
        router.refresh();
      }),
    [router],
  );
  return { pending, run };
}

/** Thao tác trên MỘT khách — mỗi nút gọi một Server Action thật; không có nút nào gọi Facebook. */
function RowActions({ row, users, canWrite }: { row: FbCrmRow; users: UserOption[]; canWrite: boolean }) {
  const { pending, run } = useRun();
  const [mode, setMode] = React.useState<DialogMode>(null);
  const [url, setUrl] = React.useState(row.fbProfileUrl ?? "");
  const [source, setSource] = React.useState<(typeof FB_URL_SET_SOURCES)[number]>("STAFF_VERIFIED_FROM_PANCAKE");
  const [reason, setReason] = React.useState("");
  const [owner, setOwner] = React.useState(row.careOwnerUserId ?? "");
  const [careOn, setCareOn] = React.useState(row.nextCareOn ?? "");
  const [title, setTitle] = React.useState("");
  const [note, setNote] = React.useState("");
  const [dueOn, setDueOn] = React.useState("");

  const update = (input: FbCrmOpInput) => run(() => fbCrmUpdateAction(row.customerId, input), () => setMode(null));
  const status = (to: FbStatusTarget) => update({ op: "SET_STATUS", to });

  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {row.fbProfileUrl ? (
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <a href={row.fbProfileUrl} target="_blank" rel="noreferrer noopener" title="Mở trang Facebook của khách (tab mới) — kết bạn / nhắn là việc của NGƯỜI">
            <ExternalLink className="size-3.5" /> Facebook
          </a>
        </Button>
      ) : row.pancakeHref ? (
        <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
          <a href={row.pancakeHref} target="_blank" rel="noreferrer noopener" title="Chưa có link Facebook — mở hội thoại Pancake rồi bấm avatar khách để tìm trang cá nhân">
            <ExternalLink className="size-3.5" /> Pancake để bấm avatar
          </a>
        </Button>
      ) : null}
      {row.chatLink ? (
        <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
          {row.chatLink.internal ? (
            <Link href={row.chatLink.href} title="Mở hội thoại trong hộp thư ERP">
              <MessageCircle className="size-3.5" /> Hội thoại
            </Link>
          ) : (
            <a href={row.chatLink.href} target="_blank" rel="noreferrer noopener" title="Mở hội thoại trên Pancake">
              <MessageCircle className="size-3.5" /> Hội thoại
            </a>
          )}
        </Button>
      ) : null}
      <Button asChild size="sm" variant="ghost" className="h-7 px-2 text-xs">
        <Link href={`/customers/${encodeURIComponent(row.customerId)}`} title="Customer 360">
          <UserRound className="size-3.5" /> 360
        </Link>
      </Button>
      {canWrite ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 px-2" disabled={pending} aria-label={`Thao tác với khách ${row.name}`}>
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => setMode("url")}>{row.fbProfileUrl ? "Sửa link Facebook" : "Lưu link Facebook"}</DropdownMenuItem>
            {row.fbProfileUrl ? <DropdownMenuItem onSelect={() => update({ op: "CLEAR_URL" })}>Xoá link Facebook</DropdownMenuItem> : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={row.doNotContact} onSelect={() => status("CONSENTED")}>Ghi: khách đồng ý kết nối</DropdownMenuItem>
            <DropdownMenuItem disabled={row.doNotContact || row.connectionStatus !== "CONSENTED"} onSelect={() => status("INVITE_SENT")}>Đánh dấu đã gửi lời mời</DropdownMenuItem>
            <DropdownMenuItem disabled={row.doNotContact} onSelect={() => status("FRIENDS")}>Xác nhận đã kết bạn</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => status("DECLINED")}>Khách từ chối</DropdownMenuItem>
            <DropdownMenuSeparator />
            {row.doNotContact ? (
              <DropdownMenuItem onSelect={() => update({ op: "CLEAR_DNC" })}>Gỡ cờ không liên hệ</DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => setMode("dnc")}>Không liên hệ…</DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => setMode("owner")}>Đổi NV phụ trách…</DropdownMenuItem>
            <DropdownMenuItem disabled={row.doNotContact} onSelect={() => setMode("care")}>Đặt ngày chăm sóc tiếp…</DropdownMenuItem>
            <DropdownMenuItem disabled={row.doNotContact} onSelect={() => setMode("task")}>Tạo nhiệm vụ CSKH…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}

      <Dialog open={mode !== null} onOpenChange={(o) => (o ? null : setMode(null))}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{row.name}</DialogTitle>
            <DialogDescription>
              {mode === "url" && "Dán link trang Facebook CÁ NHÂN của khách. ERP không tự tìm, không tự kết bạn — chỉ lưu link người đã xác nhận đúng người."}
              {mode === "dnc" && "Khách sẽ không được đồng ý / mời / hẹn chăm sóc / tạo nhiệm vụ cho tới khi gỡ cờ."}
              {mode === "owner" && "Nhân viên chăm sóc khách này trên nick của shop."}
              {mode === "care" && "Ngày nhắc chăm sóc tiếp (giờ Việt Nam)."}
              {mode === "task" && "Việc tay cho phòng Kinh doanh & CSKH, giao NV phụ trách nếu có. Một khách chỉ một nhiệm vụ mở mỗi ngày."}
            </DialogDescription>
          </DialogHeader>
          {mode === "url" ? (
            <div className="space-y-3">
              <Input aria-label="Link trang Facebook cá nhân" placeholder="https://www.facebook.com/ten.khach" value={url} onChange={(e) => setUrl(e.target.value)} />
              <label className="block text-sm">
                <span className="mb-1 block text-xs text-muted-foreground">Link này từ đâu</span>
                <select className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={source} onChange={(e) => setSource(e.target.value as (typeof FB_URL_SET_SOURCES)[number])}>
                  {FB_URL_SET_SOURCES.map((s) => (
                    <option key={s} value={s}>
                      {FB_URL_SOURCE_LABEL[s]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          {mode === "dnc" ? <Input aria-label="Lý do không liên hệ" placeholder="Vd: khách yêu cầu không nhắn tin" value={reason} onChange={(e) => setReason(e.target.value)} /> : null}
          {mode === "owner" ? (
            <select aria-label="Nhân viên phụ trách" className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">— Chưa ai phụ trách —</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          ) : null}
          {mode === "care" ? <Input type="date" aria-label="Ngày chăm sóc tiếp" value={careOn} onChange={(e) => setCareOn(e.target.value)} /> : null}
          {mode === "task" ? (
            <div className="space-y-2">
              <Input aria-label="Tiêu đề nhiệm vụ" placeholder={`Chăm sóc khách «${row.name}» (Facebook CRM)`} value={title} onChange={(e) => setTitle(e.target.value)} />
              <Input aria-label="Ghi chú nhiệm vụ" placeholder="Ghi chú (không bắt buộc)" value={note} onChange={(e) => setNote(e.target.value)} />
              <Input type="date" aria-label="Hạn nhiệm vụ" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </div>
          ) : null}
          <DialogFooter>
            {mode === "care" && row.nextCareOn ? (
              <Button variant="ghost" disabled={pending} onClick={() => update({ op: "SET_NEXT_CARE", on: null })}>
                Bỏ hẹn
              </Button>
            ) : null}
            <Button
              disabled={pending}
              onClick={() => {
                if (mode === "url") update({ op: "SET_URL", url, source });
                else if (mode === "dnc") update({ op: "SET_DNC", reason });
                else if (mode === "owner") update({ op: "SET_OWNER", userId: owner || null });
                else if (mode === "care") update({ op: "SET_NEXT_CARE", on: careOn || null });
                else if (mode === "task") run(() => fbCrmCreateTaskAction(row.customerId, { title: title || undefined, note: note || undefined, dueOn: dueOn || null }), () => setMode(null));
              }}
            >
              Lưu
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function columnsFor(users: UserOption[], canWrite: boolean): ColumnDef<FbCrmRow, unknown>[] {
  return [
    {
      id: "name",
      header: "Khách · fanpage",
      cell: ({ row: { original: r } }) => (
        <div className="flex min-w-[200px] max-w-[260px] items-center gap-2">
          <Avatar row={r} />
          <div className="min-w-0">
            <RowLink href={`/customers/${encodeURIComponent(r.customerId)}`} className="block truncate">
              {r.name || "—"}
            </RowLink>
            <div className="truncate text-xs text-muted-foreground">
              {r.pageName ?? (r.pageId ? `Page ${r.pageId}` : r.channel ? r.channel : "Chưa nhắn fanpage")}
              {r.phone ? ` · ${r.phone}` : ""}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "lastInteractionAt",
      header: "Tương tác",
      cell: ({ row: { original: r } }) => (
        <div className="min-w-[120px] text-xs">
          <div className="font-medium text-foreground">{r.lastInteractionAt ? formatTimeAgo(r.lastInteractionAt) : "—"}</div>
          <div className="text-muted-foreground">{r.lastConversationAt ? `hội thoại ${formatTimeAgo(r.lastConversationAt)}${r.conversationCount > 1 ? ` · ${r.conversationCount}` : ""}` : "chưa có hội thoại"}</div>
        </div>
      ),
    },
    {
      id: "deliveredCount",
      header: "Đơn · giao TC",
      meta: { align: "right" },
      cell: ({ row: { original: r } }) => (
        <div className="text-right text-xs">
          <div className="numeric text-sm font-semibold">{formatNumber(r.deliveredCount)}</div>
          <div className="text-muted-foreground">/ {formatNumber(r.orderCount)} đơn</div>
        </div>
      ),
    },
    {
      id: "realRevenue",
      header: "Doanh thu thực",
      meta: { align: "right" },
      cell: ({ row: { original: r } }) => (
        <span title={r.realRevenue === null ? "Chưa có chứng từ tiền (COD thực thu / chuyển khoản) cho đơn giao thành công nào" : "Tiền có chứng từ của đơn giao thành công"}>
          <Money value={r.realRevenue} className="text-sm" />
        </span>
      ),
    },
    {
      id: "connectionStatus",
      header: "Kết bạn",
      enableSorting: false,
      cell: ({ row: { original: r } }) => (
        <div className="min-w-[130px] space-y-0.5 text-xs">
          <span className={cn("inline-block rounded px-1.5 py-0.5 font-semibold", FB_CONNECTION_STATUS_TONE[r.connectionStatus])}>{FB_CONNECTION_STATUS_LABEL[r.connectionStatus]}</span>
          {r.doNotContact ? (
            <div className="font-semibold text-rose-700 dark:text-rose-400" title={r.doNotContactReason ?? ""}>
              Không liên hệ
            </div>
          ) : null}
          <div className="text-muted-foreground">{r.fbProfileUrl ? FB_URL_SOURCE_LABEL[r.fbUrlSource] : "chưa có link Facebook"}</div>
        </div>
      ),
    },
    {
      id: "nextCareOn",
      header: "Phụ trách · hẹn",
      cell: ({ row: { original: r } }) => (
        <div className="min-w-[110px] text-xs">
          <div className="truncate font-medium">{r.careOwnerName ?? <span className="text-muted-foreground">Chưa ai</span>}</div>
          <div className="text-muted-foreground">{r.nextCareOn ? `hẹn ${formatDate(r.nextCareOn)}` : "chưa hẹn"}</div>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      enableSorting: false,
      cell: ({ row: { original: r } }) => <RowActions row={r} users={users} canWrite={canWrite} />,
    },
  ];
}

export function FbCrmTable({ rows, pageCount, total, users, canWrite }: { rows: FbCrmRow[]; pageCount: number; total: number; users: UserOption[]; canWrite: boolean }) {
  const columns = React.useMemo(() => columnsFor(users, canWrite), [users, canWrite]);
  return (
    <DataTable
      defaultSort="lastInteractionAt"
      defaultDir="desc"
      columns={columns}
      data={rows}
      pageCount={pageCount}
      total={total}
      getRowId={(row) => row.customerId}
      emptyTitle="Không có khách nào trong nhóm này"
      emptyDescription="Danh sách gồm khách từng nhắn fanpage hoặc có đơn. Đổi bộ lọc / từ khoá."
    />
  );
}
