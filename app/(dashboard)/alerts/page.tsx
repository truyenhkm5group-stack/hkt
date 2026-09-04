import Link from "next/link";
import { BellRing } from "lucide-react";
import { AlertConfigForm, MarkAllReadButton, ResolveButton, RunAlertsButton } from "@/app/(dashboard)/alerts/alerts-actions";
import { PageHeader } from "@/components/page-header";
import { MetricCard } from "@/components/metric-card";
import { SectionCard } from "@/components/ui-bits";
import { loadAlertConfig } from "@/lib/alerts/config";
import { can, requirePermission } from "@/lib/auth/session";
import { NOTIFICATION_KIND_LABEL, NOTIFICATION_KIND_ORDER, SEVERITY_TONE } from "@/lib/constants/alerts";
import { formatDateTime, formatNumber, formatTimeAgo } from "@/lib/format";
import { listOpenNotifications, openCountsByKind } from "@/lib/queries/notifications";
import { cn } from "@/lib/utils";

export const metadata = { title: "Cần xử lý" };

export default async function AlertsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("shipments:view");
  const raw = await searchParams;
  const kindFilter = typeof raw.kind === "string" ? raw.kind : "";
  const [items, counts, config] = await Promise.all([listOpenNotifications(300), openCountsByKind(), loadAlertConfig()]);
  const visible = kindFilter ? items.filter((n) => n.kind === kindFilter) : items;
  const canConfig = can(user, "settings:manage");

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Vận hành"
        title="Cần xử lý"
        description="Đơn chờ xử lý quá hạn, vận đơn giao thất bại chờ phát lại, vận đơn treo lâu, đang chuyển hoàn — nhân viên vận đơn theo dõi và xử lý tại đây; có thể nhận qua Telegram."
        actions={
          <>
            <MarkAllReadButton />
            <RunAlertsButton />
          </>
        }
      />
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {NOTIFICATION_KIND_ORDER.filter((k) => k !== "SYSTEM").map((kind) => (
          <Link key={kind} href={kindFilter === kind ? "/alerts" : `/alerts?kind=${kind}`} className={cn("block rounded-xl", kindFilter === kind && "ring-2 ring-primary/40")}>
            <MetricCard label={NOTIFICATION_KIND_LABEL[kind]} value={formatNumber(counts[kind] ?? 0)} note={kindFilter === kind ? "Đang lọc · bấm để bỏ lọc" : "Bấm để lọc"} icon={BellRing} tone={(counts[kind] ?? 0) > 0 ? (kind === "SHIPMENT_RETURNING" ? "blue" : "amber") : "slate"} />
          </Link>
        ))}
      </section>

      <SectionCard title={`Đang mở (${formatNumber(visible.length)})`} description="Mỗi dòng là một đơn / vận đơn cần chăm sóc. Tự đóng khi trạng thái đã thay đổi; hoặc bấm “Đã xử lý”." padded={false}>
        {visible.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">Không có việc cần xử lý.</p>
        ) : (
          <ul className="divide-y">
            {visible.map((n) => {
              const read = n.readBy.includes(user.id);
              return (
                <li key={n.id} className={cn("flex flex-wrap items-start gap-3 px-5 py-3", !read && "bg-primary/5")}>
                  <span className={cn("mt-0.5 rounded px-1.5 py-0.5 text-[10.5px] font-semibold whitespace-nowrap", SEVERITY_TONE[n.severity] ?? SEVERITY_TONE.info)}>{NOTIFICATION_KIND_LABEL[n.kind] ?? n.kind}</span>
                  <div className="min-w-0 flex-1">
                    <Link href={n.href || "#"} className={cn("block text-sm hover:text-primary hover:underline", !read && "font-semibold")}>
                      {n.title}
                    </Link>
                    <div className="text-xs text-muted-foreground">{n.body}</div>
                    <div className="text-[10.5px] text-muted-foreground" title={formatDateTime(n.createdAt)}>
                      {formatTimeAgo(n.createdAt)}
                      {n.notifiedAt ? " · đã gửi Telegram" : ""}
                    </div>
                  </div>
                  <ResolveButton id={n.id} />
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {canConfig ? (
        <SectionCard title="Cấu hình cảnh báo & Telegram" description="Tạo bot qua @BotFather, thêm bot vào nhóm nhân viên vận đơn, dán token và chat ID. Ngưỡng thời gian chỉnh theo quy trình của shop.">
          <AlertConfigForm config={{ ...config, telegramBotToken: "" }} hasToken={Boolean(config.telegramBotToken)} />
        </SectionCard>
      ) : null}
    </div>
  );
}
