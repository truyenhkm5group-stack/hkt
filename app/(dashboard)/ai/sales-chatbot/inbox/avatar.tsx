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

/** Ảnh đại diện chữ cái (màu cố định theo tên) + chấm kênh — nhận ra khách và kênh trong một cái liếc. */
export function ChannelAvatar({ name, channel, size = "md" }: { name: string; channel: string; size?: "md" | "lg" }) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const dot = CHANNEL_DOT[channel];
  return (
    <span className={cn("relative inline-flex shrink-0 items-center justify-center rounded-full font-semibold", size === "lg" ? "size-10 text-sm" : "size-9 text-[12px]", PALETTE[h % PALETTE.length])} aria-hidden>
      {initials(name)}
      {dot ? <span className={cn("absolute -bottom-0.5 -right-0.5 inline-flex size-4 items-center justify-center rounded-full border-2 border-background text-[9px] font-bold", dot.className)}>{dot.label}</span> : null}
    </span>
  );
}
