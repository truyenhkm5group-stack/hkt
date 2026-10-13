"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff } from "lucide-react";
import { patchUnreadCount } from "@/lib/sales-chatbot/inbox-read-shared";
import { nextRefreshDelayMs, refreshDue } from "@/lib/sales-chatbot/inbox-switch-shared";
import { useInboxReads } from "./read-store";

const SOUND_KEY = "inbox.sound";

function readSound(): boolean {
  try {
    return window.localStorage.getItem(SOUND_KEY) !== "off";
  } catch {
    return true;
  }
}

/** Một tiếng «ting» ngắn bằng WebAudio — không tải tệp âm thanh nào. Trình duyệt chặn khi chưa có cú bấm nào ⇒ im lặng, không lỗi. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.4);
    osc.onended = () => void ctx.close();
  } catch {
    /* không phát được thì thôi — số trên tiêu đề tab vẫn báo */
  }
}

/**
 * KHÔNG ĐỂ SÓT TIN: hộp thư tự làm mới mỗi 5 giây khi tab đang mở (30 giây khi tab ẩn); tiêu đề tab mang số khách đang CHỜ TRẢ
 * LỜI (thấy cả khi đang ở tab khác); số «chưa đọc» tăng ⇒ một tiếng «ting» (tắt / bật bằng nút chuông, nhớ theo trình duyệt).
 */
export function InboxAutoRefresh({ waiting, unread: serverUnread, unreadStamp = null, everyMs = 5_000, compact = false }: { waiting: number; unread: number; unreadStamp?: string | null; everyMs?: number; compact?: boolean }) {
  const router = useRouter();
  // Âm báo theo số ĐÃ VÁ (cùng số trên thẻ) — đọc xong một hội thoại không được kêu «ting» khi bản đếm cũ về tới.
  const reads = useInboxReads();
  const unread = patchUnreadCount(serverUnread, unreadStamp, reads.values());
  const [sound, setSound] = useState(true);
  const prevUnread = useRef<number | null>(null);

  useEffect(() => {
    setSound(readSound());
  }, []);

  /*
    Tab đang mở: mỗi `everyMs`. Tab ẩn: vẫn hỏi, thưa hơn (gấp 6) — để tiêu đề tab và âm báo còn đúng khi nhân viên đang ở màn khác.
    KHÔNG CHỒNG LƯỢT (P0 13/10/2026): trước đây cờ «bận» tự nhả sau 4 giây dù lượt làm mới chưa xong — máy chủ mất 13 giây (HSLC) là
    ba lượt dựng trang chồng nhau trên bể 2 kết nối CSDL, và lượt nạp hội thoại phải xếp hàng sau chúng («Đang mở hội thoại…» kẹt).
    Nay «đang chạy» = `isPending` của transition bọc `router.refresh()` (React giữ nó tới khi bản dựng mới về), và lượt kế tiếp hẹn từ
    lúc lượt trước XONG, giãn theo thời gian nó thật sự mất (`nextRefreshDelayMs` — máy chủ chậm thì hỏi thưa lại, trần 60 giây).
  */
  const [pending, startRefresh] = useTransition();
  const clock = useRef({ startedAt: 0, doneAt: 0, notBefore: 0, pending: false });
  clock.current.pending = pending;
  useEffect(() => {
    const c = clock.current;
    if (pending || !c.startedAt) return;
    const now = Date.now();
    c.notBefore = now + nextRefreshDelayMs(everyMs, now - c.startedAt);
    c.doneAt = now;
    c.startedAt = 0;
  }, [pending, everyMs]);
  useEffect(() => {
    const c = clock.current;
    c.notBefore = Date.now() + everyMs;
    c.doneAt = Date.now();
    const id = window.setInterval(() => {
      const now = Date.now();
      // Lưới an toàn: transition đã xong mà hiệu ứng `pending` không bắt được lần đổi (React gộp) ⇒ coi như xong sau 2 giây.
      if (c.startedAt && !c.pending && now - c.startedAt > 2_000) {
        c.notBefore = now + nextRefreshDelayMs(everyMs, now - c.startedAt);
        c.doneAt = now;
        c.startedAt = 0;
      }
      if (c.startedAt || !refreshDue({ pending: c.pending, now, notBefore: c.notBefore, visible: document.visibilityState === "visible", lastDoneAt: c.doneAt, everyMs })) return;
      c.startedAt = now;
      startRefresh(() => {
        router.refresh();
      });
    }, 1_000);
    return () => window.clearInterval(id);
  }, [router, everyMs]);

  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) Hộp thư khách` : "Hộp thư khách";
    if (prevUnread.current !== null && unread > prevUnread.current && sound) chime();
    prevUnread.current = unread;
  }, [waiting, unread, sound]);

  return (
    <button
      type="button"
      className={compact ? "inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-foreground/15 bg-background text-muted-foreground hover:bg-muted" : "inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted"}
      title={sound ? "Đang bật âm báo tin mới — bấm để tắt" : "Đang tắt âm báo — bấm để bật"}
      aria-label={sound ? "Âm báo tin mới đang bật — bấm để tắt" : "Âm báo tin mới đang tắt — bấm để bật"}
      aria-pressed={sound}
      onClick={() => {
        const next = !sound;
        setSound(next);
        try {
          window.localStorage.setItem(SOUND_KEY, next ? "on" : "off");
        } catch {
          /* không lưu được thì chỉ áp cho lần mở này */
        }
        if (next) chime();
      }}
    >
      {sound ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />}
      {compact ? null : sound ? " Âm báo bật" : " Âm báo tắt"}
    </button>
  );
}
