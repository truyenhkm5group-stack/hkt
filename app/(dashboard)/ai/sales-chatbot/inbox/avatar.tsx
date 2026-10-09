"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const CHANNEL_DOT: Record<string, { label: string; className: string }> = {
  FANPAGE: { label: "f", className: "bg-blue-600 text-white" },
  ZALO: { label: "Z", className: "bg-sky-500 text-white" },
  WEB: { label: "W", className: "bg-zinc-600 text-white" },
};

const PALETTE = ["bg-rose-200 text-rose-900", "bg-amber-200 text-amber-900", "bg-emerald-200 text-emerald-900", "bg-sky-200 text-sky-900", "bg-violet-200 text-violet-900", "bg-teal-200 text-teal-900", "bg-orange-200 text-orange-900"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  const last = parts[parts.length - 1];
  return (parts.length > 1 ? `${parts[0][0]}${last[0]}` : last.slice(0, 2)).toUpperCase();
}

/**
 * Ảnh đại diện khách + chấm kênh — nhận ra khách và kênh trong một cái liếc. Có ảnh thật (Meta `profile_pic` / Pancake, đã lọc ở
 * máy chủ — `safeAvatarUrl`) ⇒ hiện ảnh; ảnh hỏng / hết hạn (URL CDN của Meta có hạn) ⇒ tự lùi về chữ cái (màu cố định theo tên).
 * Thành phần này KHÔNG tự làm link: bấm ảnh đi đâu do nơi dùng quyết qua `avatarHrefOf` (inbox-shared.ts) — hôm nay chỉ mở hồ sơ
 * khách đã nối; không nguồn nào cho link trang cá nhân Facebook thật, và không bao giờ dựng link từ PSID.
 */
export function ChannelAvatar({ name, channel, src = null, size = "md" }: { name: string; channel: string; src?: string | null; size?: "md" | "lg" }) {
  const [broken, setBroken] = useState(false);
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const dot = CHANNEL_DOT[channel];
  const img = src && !broken ? src : null;
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold", size === "lg" ? "size-10 text-sm" : "size-9 text-[12px]", img ? "bg-muted" : PALETTE[h % PALETTE.length])} aria-hidden data-avatar={img ? "img" : "initials"}>
      {img ? (
        // eslint-disable-next-line @next/next/no-img-element -- ảnh đại diện trên CDN của kênh (URL có hạn, không qua tối ưu ảnh của Next)
        <img src={img} alt="" className="size-full rounded-full object-cover" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
      ) : (
        initials(name)
      )}
      {dot ? <span className={cn("absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full border-2 border-background text-[9px] font-bold", dot.className)}>{dot.label}</span> : null}
    </span>
  );
}
