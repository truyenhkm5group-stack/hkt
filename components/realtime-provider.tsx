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
 * Gộp sự kiện, tối thiểu 20 giây giữa hai lần làm mới; chỉ tự làm mới định kỳ (5 phút) khi mất kết nối SSE.
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

    const MIN_GAP = 20_000; // không làm mới trang dày hơn 20 giây/lần dù có nhiều sự kiện
    const scheduleRefresh = () => {
      if (timer.current) return; // đã có lịch làm mới, gộp sự kiện
      const since = Date.now() - lastRefresh.current;
      timer.current = setTimeout(
        () => {
          timer.current = null;
          if (document.visibilityState === "visible") {
            lastRefresh.current = Date.now();
            router.refresh();
          }
        },
        since > MIN_GAP ? 1500 : MIN_GAP - since,
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
          // chỉ làm mới khi dữ liệu thực sự đổi: đơn / vận đơn / tồn / quảng cáo / thông báo, hoặc job đồng bộ kết thúc
          if (event.type === "sync" && event.status !== "SUCCESS" && event.status !== "FAILED") return;
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

    // Dự phòng khi mất kết nối SSE: làm mới mỗi 5 phút (đã kết nối thì chỉ làm mới theo sự kiện)
    const interval = setInterval(() => {
      const disconnected = !source || source.readyState !== EventSource.OPEN;
      if (disconnected && document.visibilityState === "visible" && Date.now() - lastRefresh.current > 300_000) {
        lastRefresh.current = Date.now();
        router.refresh();
      }
    }, 60_000);

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
