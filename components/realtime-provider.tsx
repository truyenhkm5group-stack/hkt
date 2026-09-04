"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Radio, RadioTower } from "lucide-react";
import { toast } from "sonner";
import { formatTimeAgo } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type RealtimeState = { connected: boolean; lastEventAt: number | null; events: number };
const RealtimeContext = createContext<RealtimeState>({ connected: false, lastEventAt: null, events: 0 });

/**
 * Kết nối SSE tới /api/events và làm mới dữ liệu trang (router.refresh) khi có thay đổi.
 * Có debounce để tránh refresh dồn dập; fallback tự làm mới mỗi 60 giây khi tab đang mở.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<RealtimeState>({ connected: false, lastEventAt: null, events: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefresh = useRef(0);

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let retry = 1000;

    const scheduleRefresh = () => {
      if (timer.current) clearTimeout(timer.current);
      const since = Date.now() - lastRefresh.current;
      timer.current = setTimeout(
        () => {
          if (document.visibilityState === "visible") {
            lastRefresh.current = Date.now();
            router.refresh();
          }
        },
        since > 5000 ? 800 : 4000,
      );
    };

    const connect = () => {
      if (closed) return;
      source = new EventSource("/api/events");
      source.onopen = () => {
        retry = 1000;
        setState((s) => ({ ...s, connected: true }));
      };
      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as { type: string; status?: string; job?: string; action?: string };
          if (event.type === "ping" || event.type === "hello") return;
          setState((s) => ({ ...s, lastEventAt: Date.now(), events: s.events + 1 }));
          if (event.type === "sync" && event.status === "FAILED") toast.error(`Đồng bộ ${event.job} thất bại`);
          if (event.type === "order" && event.action === "created") toast.success("Có đơn hàng mới từ Pancake", { id: "new-order", duration: 4000 });
          scheduleRefresh();
        } catch {
          // bỏ qua
        }
      };
      source.onerror = () => {
        setState((s) => ({ ...s, connected: false }));
        source?.close();
        if (!closed) {
          setTimeout(connect, retry);
          retry = Math.min(retry * 2, 30_000);
        }
      };
    };
    connect();

    const interval = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastRefresh.current > 60_000) {
        lastRefresh.current = Date.now();
        router.refresh();
      }
    }, 30_000);

    return () => {
      closed = true;
      source?.close();
      clearInterval(interval);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [router]);

  const value = useMemo(() => state, [state]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  return useContext(RealtimeContext);
}

export function RealtimeIndicator() {
  const { connected, lastEventAt, events } = useRealtime();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${connected ? "border-success/30 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
          {connected ? <RadioTower className="size-3.5" /> : <Radio className="size-3.5" />}
          <span className="hidden sm:inline">{connected ? "Realtime" : "Đang kết nối…"}</span>
          {connected ? <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" /><span className="relative inline-flex size-1.5 rounded-full bg-success" /></span> : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {connected ? "Nhận cập nhật tức thì từ webhook & đồng bộ" : "Mất kết nối realtime, sẽ tự thử lại"}
        {lastEventAt ? ` · sự kiện gần nhất ${formatTimeAgo(new Date(lastEventAt))} (${events})` : ""}
      </TooltipContent>
    </Tooltip>
  );
}
