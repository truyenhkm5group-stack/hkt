import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ScopeDenied } from "@/components/scope-denied";
import { requireResource } from "@/lib/auth/scope-guard";
import { formatNumber } from "@/lib/format";
import { mobileHome } from "@/lib/queries/wholesale-mobile";
import { cn } from "@/lib/utils";

export const metadata = { title: "Gọi khách sỉ" };

/**
 * SALE SỈ TRÊN ĐIỆN THOẠI — màn đầu (chủ shop 05/10/2026). Cố ý ĐƠN GIẢN: sáu con số của HÔM NAY và bốn nút lớn. Không bảng,
 * không biểu đồ — người bán cầm máy một tay, bấm «BẮT ĐẦU GỌI» là vào khách nên gọi trước nhất.
 */
export default async function WholesaleMobileHome() {
  const { user, decision } = await requireResource("WHOLESALE_LEADS", "wholesale:view");
  if (decision.allow === "NONE") return <ScopeDenied title="Gọi khách sỉ" reason={decision.reason} fix={decision.fix} />;
  const h = await mobileHome(decision, user.id);
  const tiles: { label: string; value: number; href: string; tone?: string }[] = [
    { label: "Cần nhắn Zalo", value: h.toZalo, href: "/wholesale/mobile/queue?f=zalo", tone: "text-sky-600 dark:text-sky-400" },
    { label: "Cần gọi", value: h.toCall, href: "/wholesale/mobile/queue?f=call", tone: "text-primary" },
    { label: "Cần gọi lại", value: h.followupDue, href: "/wholesale/mobile/queue?f=today", tone: h.followupDue ? "text-amber-600 dark:text-amber-400" : undefined },
    { label: "Đang quan tâm", value: h.interested, href: "/wholesale/mobile/queue?f=hot", tone: "text-emerald-600 dark:text-emerald-400" },
    { label: "Chờ báo giá", value: h.priceWaiting, href: "/wholesale/mobile/queue?f=price" },
    { label: "Đã chốt", value: h.won, href: "/wholesale/mobile/queue?f=done" },
  ];
  const big = "flex min-h-14 w-full items-center justify-center rounded-xl px-4 text-base font-semibold shadow-sm active:scale-[0.99]";
  return (
    <div className="mx-auto max-w-md space-y-4 pb-10">
      <PageHeader
        eyebrow="Hôm nay"
        title={`Chào ${user.name.split(" ").slice(-1)[0]} 👋`}
        description={
          <>
            Đã nhắn <b className="text-foreground">{formatNumber(h.myZaloToday)}</b> khách qua Zalo · gọi <b className="text-foreground">{formatNumber(h.myCallsToday)}</b> cuộc · <b className="text-foreground">{formatNumber(h.myAnsweredToday)}</b> khách nghe máy
          </>
        }
      />
      <div className="grid grid-cols-3 gap-2">
        {tiles.map((t) => (
          <Link key={t.label} href={t.href} className="rounded-xl border bg-card p-3 active:bg-muted">
            <div className={cn("text-2xl font-bold tabular-nums", t.tone)}>{formatNumber(t.value)}</div>
            <div className="text-xs leading-tight text-muted-foreground">{t.label}</div>
          </Link>
        ))}
      </div>
      <div className="space-y-2.5">
        <Link href="/wholesale/mobile/next?f=zalo" className={cn(big, "bg-sky-600 text-white")}>
          💬 BẮT ĐẦU NHẮN ZALO {h.toZalo ? `(${formatNumber(h.toZalo)})` : ""}
        </Link>
        <Link href="/wholesale/mobile/next?f=call" className={cn(big, "bg-primary text-primary-foreground")}>
          📞 BẮT ĐẦU GỌI {h.toCall ? `(${formatNumber(h.toCall)})` : ""}
        </Link>
        <Link href="/wholesale/mobile/queue?f=today" className={cn(big, "border bg-card")}>
          ⏰ KHÁCH CẦN GỌI LẠI {h.followupDue ? `(${formatNumber(h.followupDue)})` : ""}
        </Link>
        <Link href="/wholesale/mobile/queue?f=hot" className={cn(big, "border bg-card")}>
          🔥 KHÁCH ĐANG QUAN TÂM {h.interested ? `(${formatNumber(h.interested)})` : ""}
        </Link>
        <Link href="/wholesale/mobile/history" className={cn(big, "border bg-card")}>
          🕘 LỊCH SỬ GỌI
        </Link>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        <Link href="/wholesale/mobile/queue?f=call" className="underline">
          Xem danh sách cần gọi
        </Link>{" "}
        ·{" "}
        <Link href="/wholesale/leads" className="underline">
          Giao diện máy tính
        </Link>
      </p>
    </div>
  );
}
