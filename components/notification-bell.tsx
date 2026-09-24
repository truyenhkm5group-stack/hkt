"use client";

import { useNavTransition } from "@/components/nav-progress";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { markNotificationsRead } from "@/lib/actions/alerts";
import { listMyInbox, markMyInboxRead } from "@/lib/actions/inbox";
import { NOTIFICATION_KIND_LABEL, SEVERITY_TONE } from "@/lib/constants/alerts";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = { id: string; kind: string; severity: string; title: string; body: string; href: string; createdAt: string; read: boolean };
/** Tin trong HỘP THƯ CÁ NHÂN (phiếu lương, lời nhắc duyệt lương) — của riêng người đang đăng nhập. */
type Personal = { id: string; kind: string; title: string; body: string; href: string; createdAt: string; read: boolean };

/** Chuông thông báo: đơn chờ xử lý, giao thất bại chờ phát lại, vận đơn treo… Tự làm mới mỗi 30 giây và khi quay lại tab. */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [personal, setPersonal] = useState<Personal[]>([]);
  const [personalUnread, setPersonalUnread] = useState(0);
  const [, startTransition] = useNavTransition();
  const router = useRouter();

  const load = useCallback(async () => {
    /*
      HAI NGUỒN, HAI CỔNG: hàng đợi chung của shop đòi quyền xem cảnh báo (nhân viên Kho/CSKH có thể
      không có), còn hộp thư cá nhân chỉ đòi đã đăng nhập. Một nguồn hỏng không được làm mất nguồn kia.
    */
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { unread: number; items: Item[] };
        setItems(data.items);
        setUnread(data.unread);
      }
    } catch {
      // bỏ qua
    }
    try {
      const data = await listMyInbox();
      setPersonal(data.items);
      setPersonalUnread(data.unread);
    } catch {
      // bỏ qua
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [load]);

  const markAll = () =>
    startTransition(async () => {
      // Hộp thư cá nhân trước: người không có quyền cảnh báo vẫn phải đánh dấu được tin của mình.
      if (personalUnread) await markMyInboxRead("all");
      if (unread) await markNotificationsRead([]).catch(() => undefined);
      await load();
    });
  const openPersonal = (item: Personal) =>
    startTransition(async () => {
      if (!item.read) await markMyInboxRead([item.id]);
      router.push(item.href || "/my-payslip");
      void load();
    });
  const badge = unread + personalUnread;
  const open = (item: Item) =>
    startTransition(async () => {
      if (!item.read) await markNotificationsRead([item.id]);
      router.push(item.href || "/alerts");
      void load();
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-10 rounded-full" aria-label="Thông báo">
          <Bell className="size-4" />
          {badge > 0 ? <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">{badge > 99 ? "99+" : badge}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[min(380px,calc(100vw-1rem))] p-0">
        <DropdownMenuLabel className="flex items-center justify-between px-3 py-2">
          <span>Cần xử lý {items.length ? `(${items.length})` : ""}</span>
          {badge ? (
            <button type="button" onClick={markAll} className="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground">
              <CheckCheck className="size-3.5" /> Đã đọc hết
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-[420px] overflow-y-auto">
          {personal.length ? (
            <>
              <div className="bg-muted/50 px-3 py-1 text-[11px] font-medium text-muted-foreground">Gửi riêng bạn</div>
              {personal.map((item) => (
                <DropdownMenuItem key={item.id} onSelect={() => openPersonal(item)} className={cn("flex cursor-pointer flex-col items-start gap-0.5 rounded-none border-b px-3 py-2", !item.read && "bg-primary/5")}>
                  <div className="flex w-full items-center gap-2">
                    <span className="rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-900 dark:bg-violet-950 dark:text-violet-200">Hộp thư</span>
                    <span className="ml-auto text-[10.5px] text-muted-foreground">{formatTimeAgo(new Date(item.createdAt))}</span>
                  </div>
                  <div className={cn("line-clamp-1 text-[13px]", !item.read && "font-semibold")}>{item.title}</div>
                  <div className="line-clamp-2 text-xs text-muted-foreground">{item.body}</div>
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
          {items.length === 0 ? (
            personal.length ? null : <p className="px-3 py-6 text-center text-sm text-muted-foreground">Không có việc cần xử lý 🎉</p>
          ) : (
            items.map((item) => (
              <DropdownMenuItem key={item.id} onSelect={() => open(item)} className={cn("flex cursor-pointer flex-col items-start gap-0.5 rounded-none border-b px-3 py-2 last:border-b-0", !item.read && "bg-primary/5")}>
                <div className="flex w-full items-center gap-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-semibold", SEVERITY_TONE[item.severity] ?? SEVERITY_TONE.info)}>{NOTIFICATION_KIND_LABEL[item.kind] ?? item.kind}</span>
                  <span className="ml-auto text-[10.5px] text-muted-foreground">{formatTimeAgo(new Date(item.createdAt))}</span>
                </div>
                <div className={cn("line-clamp-1 text-[13px]", !item.read && "font-semibold")}>{item.title}</div>
                <div className="line-clamp-2 text-xs text-muted-foreground">{item.body}</div>
              </DropdownMenuItem>
            ))
          )}
        </div>
        <DropdownMenuSeparator className="my-0" />
        <DropdownMenuItem asChild className="justify-center rounded-none py-2 text-sm">
          <Link href="/alerts">Xem tất cả & cấu hình cảnh báo</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
