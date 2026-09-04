"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { markNotificationsRead } from "@/lib/actions/alerts";
import { NOTIFICATION_KIND_LABEL, SEVERITY_TONE } from "@/lib/constants/alerts";
import { formatTimeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

type Item = { id: string; kind: string; severity: string; title: string; body: string; href: string; createdAt: string; read: boolean };

/** Chuông thông báo: đơn chờ xử lý, giao thất bại chờ phát lại, vận đơn treo… Tự làm mới mỗi 30 giây và khi quay lại tab. */
export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [, startTransition] = useTransition();
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { unread: number; items: Item[] };
      setItems(data.items);
      setUnread(data.unread);
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
      await markNotificationsRead([]);
      await load();
    });
  const open = (item: Item) =>
    startTransition(async () => {
      if (!item.read) await markNotificationsRead([item.id]);
      router.push(item.href || "/alerts");
      void load();
    });

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative size-8" aria-label="Thông báo">
          <Bell className="size-4" />
          {unread > 0 ? <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span> : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[380px] p-0">
        <DropdownMenuLabel className="flex items-center justify-between px-3 py-2">
          <span>Cần xử lý {items.length ? `(${items.length})` : ""}</span>
          {unread ? (
            <button type="button" onClick={markAll} className="flex items-center gap-1 text-xs font-normal text-muted-foreground hover:text-foreground">
              <CheckCheck className="size-3.5" /> Đã đọc hết
            </button>
          ) : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0" />
        <div className="max-h-[420px] overflow-y-auto">
          {items.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">Không có việc cần xử lý 🎉</p>
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
