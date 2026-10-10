"use client";

import { startTransition, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { InboxReadConfirmation } from "@/lib/sales-chatbot/inbox-read-shared";
import type { InboxThreadPayload } from "@/lib/sales-chatbot/inbox-thread-payload";
import { cn } from "@/lib/utils";
import { recordInboxRead } from "./read-store";
import { InboxThreadView } from "./thread-view";

/**
 * ═══════════ CHUYỂN HỘI THOẠI KHÔNG DỰNG LẠI CẢ TRANG (10/10/2026) ═══════════
 *
 * Chủ shop HSLC: «chuyển giữa các hội thoại khá lag». Đo (ops inbox-perf-probe): mỗi lần bấm là một lượt dựng LẠI cả trang —
 * `listInbox` (100 hàng, 22 câu SQL) 350–800 ms trong khi nội dung hội thoại chỉ 30–210 ms. Nay bấm một hàng ⇒ đổi `?c=` tại chỗ
 * (`history.pushState` — Next 15 đồng bộ nó vào `useSearchParams` và vào URL mà `router.refresh` dùng, nút Back vẫn đúng) ⇒ CHỈ
 * tải hội thoại qua `/api/ai-sales/inbox-thread`. Danh sách tự làm mới theo nhịp cũ; một lượt làm mới nền chạy sau khi người
 * dừng bấm để đường dẫn của bộ lọc mang đúng hội thoại đang mở.
 *
 * Nguồn của khung chat: bản MỚI NHẤT trong hai — bản trang dựng (mở bằng đường dẫn, lượt tự làm mới, sau khi gửi tin) hoặc bản vừa
 * tải bằng route. Hội thoại đang mở không có bản nào ⇒ chữ «Đang mở…», danh sách vẫn đứng yên.
 *
 * ĐỌC (P0.3, 10/10/2026 tối): khung chat ĐÃ HIỆN một payload có tin khách ⇒ gửi `POST /api/ai-sales/inbox-read` với mã tin KHÁCH cuối
 * cùng của CHÍNH payload đó (`readThrough`) — không phải «giờ bấm». Mỗi (hội thoại, tin) gửi một lần; tin khách mới tới (lượt tự làm
 * mới mang payload có `readThrough` mới) ⇒ gửi tiếp. Xác nhận của máy chủ vào `read-store` ⇒ danh sách + bộ đếm vá NGAY; không còn
 * phụ thuộc lượt làm mới 1,5 giây cho trạng thái đọc (lượt đó vẫn chạy, chỉ còn là đối soát nền).
 */

type Stamped = { at: number; payload: InboxThreadPayload };

export const THREAD_ROUTE = "/api/ai-sales/inbox-thread";
export const READ_ROUTE = "/api/ai-sales/inbox-read";
/** Làm mới nền sau khi người DỪNG bấm chừng này — không chạy lại danh sách cho từng cú bấm khi lướt nhanh qua nhiều khách. */
const SETTLE_REFRESH_MS = 1_500;

/** Hội thoại đang mở theo URL (`?c=`) — đổi ngay khi bấm hàng (pushState), khi Back / Forward, và khi trang điều hướng thật. */
export function useSelectedConversation(): string | null {
  return useSearchParams().get("c") || null;
}

/** Bấm hàng: chuột trái thường ⇒ đổi `?c=` tại chỗ; Ctrl / Cmd / Shift / chuột giữa ⇒ để trình duyệt mở tab như link thường. */
export function openConversationInPlace(e: React.MouseEvent<HTMLAnchorElement>, href: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (href !== `${window.location.pathname}${window.location.search}`) window.history.pushState(null, "", href);
}

/** Cột danh sách / cột hội thoại trên điện thoại: đang mở hội thoại ⇒ giấu danh sách, hiện khung chat (và ngược lại). */
export function InboxColumn({ side, className, children, testId }: { side: "list" | "thread"; className: string; children: ReactNode; testId?: string }) {
  const selected = useSelectedConversation();
  const visible = side === "list" ? (selected ? "hidden lg:flex" : "flex") : selected ? "block" : "hidden lg:block";
  const Tag = side === "list" ? "aside" : "section";
  return (
    <Tag className={cn(className, visible)} data-testid={testId}>
      {children}
    </Tag>
  );
}

export function InboxThreadPane({
  serverSelected,
  serverPayload,
  me,
  users,
  canDecideOrders,
  shell,
  empty,
}: {
  serverSelected: string | null;
  serverPayload: InboxThreadPayload | null;
  me: string;
  users: { id: string; name: string }[];
  canDecideOrders: boolean;
  shell: boolean;
  /** Khung khi chưa chọn hội thoại (trang dựng — có số khách đang chờ). */
  empty: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get("c") || null;
  // Bản trang dựng: đóng dấu thời điểm NHẬN (đối tượng mới mỗi lượt dựng ⇒ lượt tự làm mới / sau khi gửi tin luôn mới hơn).
  const [fromServer, setFromServer] = useState<{ id: string | null; s: Stamped | null }>(() => ({ id: serverSelected, s: serverPayload ? { at: Date.now(), payload: serverPayload } : null }));
  const [lastServer, setLastServer] = useState(serverPayload);
  if (lastServer !== serverPayload) {
    setLastServer(serverPayload);
    setFromServer({ id: serverSelected, s: serverPayload ? { at: Date.now(), payload: serverPayload } : null });
  }
  const [fetched, setFetched] = useState<Map<string, Stamped>>(() => new Map());
  const wanted = useRef<string | null>(null);

  useEffect(() => {
    wanted.current = selected;
    if (!selected) return;
    // Trang vừa dựng đúng hội thoại này (mở bằng đường dẫn / Back về một mục trang đã dựng) ⇒ không tải lại.
    if (fromServer.id === selected && fromServer.s && Date.now() - fromServer.s.at < 2_000) return;
    const ctrl = new AbortController();
    void fetch(`${THREAD_ROUTE}?c=${encodeURIComponent(selected)}`, { cache: "no-store", signal: ctrl.signal })
      .then(async (res) => (await res.json().catch(() => ({ ok: false, error: `Không mở được hội thoại (HTTP ${res.status}).` }))) as InboxThreadPayload)
      .then((payload) => {
        if (wanted.current !== selected) return;
        setFetched((m) => new Map(m).set(selected, { at: Date.now(), payload }));
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || wanted.current !== selected) return;
        setFetched((m) => new Map(m).set(selected, { at: Date.now(), payload: { ok: false, error: `Không mở được hội thoại: ${e instanceof Error ? e.message : String(e)}` } }));
      });
    // Người dừng bấm ⇒ một lượt làm mới nền: số chưa đọc + đường dẫn bộ lọc theo hội thoại đang mở.
    const settle = window.setTimeout(() => startTransition(() => router.refresh()), SETTLE_REFRESH_MS);
    return () => {
      ctrl.abort();
      window.clearTimeout(settle);
    };
    // Chỉ chạy khi ĐỔI hội thoại — bản trang dựng đổi mỗi 5 giây không phải lý do tải lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const a = selected && fromServer.id === selected ? fromServer.s : null;
  const b = selected ? (fetched.get(selected) ?? null) : null;
  const best = a && b ? (a.at >= b.at ? a : b) : (a ?? b);
  const shownThread = best?.payload.ok ? best.payload.thread : null;
  const shownId = shownThread?.id ?? null;
  const throughId = shownThread?.readThrough?.id ?? null;
  // (hội thoại, tin) đã gửi đánh dấu đọc — không gửi lại cho từng lượt tự làm mới mang cùng payload.
  const marked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!shownId || !throughId) return;
    const key = `${shownId}:${throughId}`;
    const send = () => {
      if (marked.current.has(key)) return;
      marked.current.add(key);
      void fetch(READ_ROUTE, { method: "POST", headers: { "content-type": "application/json" }, cache: "no-store", body: JSON.stringify({ c: shownId, through: throughId }) })
        .then(async (res) => (await res.json().catch(() => null)) as { ok: true; read: InboxReadConfirmation } | { ok: false; error: string } | null)
        .then((r) => {
          if (r?.ok) recordInboxRead(r.read);
          else marked.current.delete(key);
        })
        .catch(() => marked.current.delete(key));
    };
    // Tab đang ẨN (lượt tự làm mới 30 giây vẫn nạp khung chat mới) KHÔNG phải là đã đọc — đợi người quay lại tab rồi mới đánh dấu.
    if (document.visibilityState === "visible") {
      send();
      return;
    }
    const onVisible = () => {
      if (document.visibilityState === "visible") send();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [shownId, throughId]);

  if (!selected) return <>{empty}</>;
  if (!best) return <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground" data-testid="inbox-thread-loading">Đang mở hội thoại…</div>;
  if (!best.payload.ok) return <div className="p-6 text-sm text-destructive">{best.payload.error}</div>;
  const back = new URLSearchParams(params.toString());
  back.delete("c");
  const backHref = `${pathname}${back.size ? `?${back.toString()}` : ""}`;
  return (
    <InboxThreadView
      key={best.payload.thread.id}
      thread={best.payload.thread}
      me={me}
      users={users}
      backHref={backHref}
      ordersSummary={best.payload.ordersSummary}
      canDecideOrders={canDecideOrders}
      shell={shell}
    />
  );
}
