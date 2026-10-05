"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff } from "lucide-react";

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
export function InboxAutoRefresh({ waiting, unread, everyMs = 5_000 }: { waiting: number; unread: number; everyMs?: number }) {
  const router = useRouter();
  const [sound, setSound] = useState(true);
  const prevUnread = useRef<number | null>(null);

  useEffect(() => {
    setSound(readSound());
  }, []);

  useEffect(() => {
    // Tab đang mở: mỗi `everyMs`. Tab ẩn: vẫn hỏi, thưa hơn (gấp 6) — để tiêu đề tab và âm báo còn đúng khi nhân viên đang ở màn khác.
    let ticks = 0;
    const id = window.setInterval(() => {
      ticks += 1;
      if (document.visibilityState === "visible" || ticks % 6 === 0) router.refresh();
    }, everyMs);
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
      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[12px] text-muted-foreground hover:bg-muted"
      title={sound ? "Đang bật âm báo tin mới — bấm để tắt" : "Đang tắt âm báo — bấm để bật"}
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
      {sound ? <Bell className="size-3.5" /> : <BellOff className="size-3.5" />} {sound ? "Âm báo bật" : "Âm báo tắt"}
    </button>
  );
}
