"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Radio, RadioTower } from "lucide-react";
import { toast } from "sonner";
import { formatTimeAgo } from "@/lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type RealtimeState = { connected: boolean; lastEventAt: number | null; events: number };
const RealtimeContext = createContext<RealtimeState>({ connected: false, lastEventAt: null, events: 0 });

/**
 * TRANG BÁO CÁO NẶNG — làm mới thưa hơn hẳn.
 *
 * `router.behavior`: mỗi `router.refresh()` XOÁ TOÀN BỘ bộ nhớ đệm điều hướng phía client, nên lần
 * bấm sang tab kế tiếp phải dựng lại trang trên máy chủ từ đầu. Với nhịp cũ (20 giây/lần cho mọi
 * trang) thì bộ đệm 30 giây khai báo trong `next.config.ts` gần như không bao giờ còn sống — đo
 * được là một trong các lý do "chuyển tab báo cáo chậm".
 *
 * Trang vận hành (đơn mới, vận đơn, cảnh báo, chat) vẫn cần nhịp nhanh: người dùng đang nhìn dòng
 * việc chạy. Trang báo cáo tổng hợp thì không — số liệu kỳ tháng không đổi theo từng giây, và bản
 * thân các báo cáo đã có đệm 60–120 giây ở máy chủ nên làm mới dày hơn cũng chỉ trả về đúng số cũ.
 */
// `/cod` có thao tác ghi (đánh dấu đã về ngân hàng) và nhận bảng kê từ Gmail bất kỳ lúc nào — phải là trang sống.
const LIVE_ROUTES = ["/orders", "/shipments", "/alerts", "/cs", "/landing", "/outreach", "/returns", "/integrations", "/cod", "/ai/sales-chatbot/inbox"];
const CARE_ROUTES = ["/shipments", "/work", "/cs"];
/** Hộp thư khách: sự kiện `chat` chỉ làm mới trang này (trang khác không đọc tin nhắn). */
const CHAT_ROUTES = ["/ai/sales-chatbot/inbox", "/ai/sales-chatbot"];
const LIVE_GAP = 20_000;
/**
 * ĐƠN ERP MỚI / TIN KHÁCH MỚI — làm mới gần như ngay (chủ shop 05/10/2026: «realtime, không delay, không miss»). Nhịp 20 giây
 * của trang sống là để đỡ CƠN MƯA sự kiện của đồng bộ Pancake ở tổ chức nhà; đơn tạo trong ERP và tin khách tới từng cái một nên
 * không cần gộp lâu.
 */
const URGENT_GAP = 2_000;
const REPORT_GAP = 90_000;

/**
 * Kết nối SSE tới /api/events và làm mới dữ liệu trang (router.refresh) khi có thay đổi.
 * Gộp sự kiện; nhịp tối thiểu tuỳ theo trang đang mở (xem trên); chỉ tự làm mới định kỳ (5 phút) khi mất kết nối SSE.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<RealtimeState>({ connected: false, lastEventAt: null, events: 0 });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRefresh = useRef(0);
  // Đọc trong callback của SSE nên phải qua ref: closure của effect không thấy pathname mới.
  const gap = useRef(LIVE_GAP);
  gap.current = pathname === "/" || LIVE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`)) ? LIVE_GAP : REPORT_GAP;
  // Lượt ghi của đội care chỉ đổi hàng đợi care / hàng đợi việc — trang khác không cần dựng lại vì nó.
  const careRoute = useRef(false);
  careRoute.current = CARE_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  const chatRoute = useRef(false);
  chatRoute.current = CHAT_ROUTES.some((r) => pathname === r || pathname.startsWith(`${r}/`));
  const liveRoute = useRef(false);
  liveRoute.current = gap.current === LIVE_GAP;

  useEffect(() => {
    let source: EventSource | null = null;
    let closed = false;
    let retry = 1000;

    // Lượt làm mới tới lúc tab đang ẨN ⇒ GIỮ LẠI, làm ngay khi người dùng quay lại tab. Trước đây lượt đó rơi mất và trang
    // đứng yên tới sự kiện kế tiếp — đúng kiểu «miss đơn» khi nhân viên để tab Đơn hàng ở nền.
    let pendingWhileHidden = false;
    const doRefresh = () => {
      if (document.visibilityState === "visible") {
        pendingWhileHidden = false;
        lastRefresh.current = Date.now();
        router.refresh();
      } else pendingWhileHidden = true;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && pendingWhileHidden) doRefresh();
    };
    document.addEventListener("visibilitychange", onVisible);

    const scheduleRefresh = (urgent = false) => {
      const minGap = urgent && liveRoute.current ? URGENT_GAP : gap.current;
      const since = Date.now() - lastRefresh.current;
      const wait = since > minGap ? (urgent ? 300 : 1500) : minGap - since;
      if (timer.current) {
        // Đã có lịch thưa hơn mà sự kiện gấp tới ⇒ kéo lịch về sớm.
        if (!urgent) return;
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        doRefresh();
      }, wait);
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
          const event = JSON.parse(message.data) as { type: string; status?: string; job?: string; action?: string; source?: string };
          if (event.type === "ping" || event.type === "hello") return;
          setState((s) => ({ ...s, lastEventAt: Date.now(), events: s.events + 1 }));
          if (event.type === "sync" && event.status === "FAILED") toast.error(`Đồng bộ ${event.job} thất bại`);
          if (event.type === "order" && event.action === "created") toast.success(event.source === "ERP" ? "Có đơn hàng mới" : "Có đơn hàng mới từ Pancake", { id: "new-order", duration: 4000 });
          // chỉ làm mới khi dữ liệu thực sự đổi: đơn / vận đơn / tồn / quảng cáo / thông báo, hoặc job đồng bộ kết thúc
          if (event.type === "sync" && event.status !== "SUCCESS" && event.status !== "FAILED") return;
          if (event.type === "care" && !careRoute.current) return;
          if (event.type === "chat") {
            if (chatRoute.current) scheduleRefresh(true);
            return;
          }
          // Đơn tạo / sửa trong ERP tới từng cái một ⇒ làm mới gần như ngay; đồng bộ Pancake vẫn gộp theo nhịp của trang.
          scheduleRefresh(event.type === "order" && event.source === "ERP");
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
      document.removeEventListener("visibilitychange", onVisible);
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
          <span className="hidden 2xl:inline">{connected ? "Realtime" : "Đang kết nối…"}</span>
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
