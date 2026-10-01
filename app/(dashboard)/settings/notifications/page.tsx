import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/ui-bits";
import { requirePermission } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { loadNotificationSetup, NOTIFICATIONS_PERMISSION } from "@/lib/messaging/presets";
import { MESSAGING_CONNECTOR_LABEL, ORDER_MESSAGE_VARS } from "@/lib/messaging/types";
import { NotificationPresetForm } from "./preset-form";

export const metadata = { title: "Thông báo nhóm" };

const DELIVERY_STATUS_LABEL: Record<string, string> = { PENDING: "Đang gửi", SENT: "Đã gửi", FAILED: "Lỗi", UNKNOWN: "Không rõ đã tới chưa" };

/**
 * THÔNG BÁO NHÓM (0180) — «khi đơn chốt / sửa / huỷ thì gửi nhóm vận hành». Lưu là tạo LUẬT TỰ ĐỘNG thật (xem
 * `lib/messaging/presets.ts`); tin đi qua bộ máy luật → `MessagingProvider`. Kênh khai + kiểm ở /settings/connections.
 */
export default async function NotificationsPage() {
  const user = await requirePermission(NOTIFICATIONS_PERMISSION);
  const setup = await loadNotificationSetup();
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Hệ thống"
        title="Thông báo nhóm"
        description={user.organization?.name}
        hint={
          <div className="space-y-1.5 text-xs leading-5">
            <p>Chọn kênh nhắn tin, nơi nhận và mẫu tin cho ba lúc: đơn được CHỐT, đơn đã chốt bị SỬA (hàng / địa chỉ / tiền thu), đơn đã chốt bị HUỶ.</p>
            <p>Lưu = bật luật tự động chạy thật (xem ở Luật tự động). Đơn chốt thì hàng TỰ được giữ ở cột khả dụng của kho — tin nhóm chỉ để đội đóng gói biết.</p>
            <p>Mỗi lần đơn đổi gửi đúng MỘT tin: bấm lại, chạy lại không đẻ tin thứ hai. Chưa có Lark / Telegram? Dùng «Hộp thử» — tin nằm trong ERP, không gửi ra ngoài.</p>
          </div>
        }
      />
      <SectionCard title="Kênh nhắn tin" description={<Link href="/settings/connections" className="underline underline-offset-2">Khai / kiểm tra / bật kênh ở Cài đặt → Kết nối</Link>}>
        <ul className="grid gap-2 sm:grid-cols-3">
          {setup.connections.map((c) => (
            <li key={c.key} className="rounded-lg border p-3 text-sm" data-connector={c.key} data-status={c.status}>
              <p className="font-medium">{MESSAGING_CONNECTOR_LABEL[c.key]}</p>
              <p className="mt-1 text-xs">
                <span className={c.status === "CONNECTED" ? "font-semibold text-emerald-600" : c.status === "TEST_MODE" ? "font-semibold text-sky-600" : c.status === "FAILED" ? "font-semibold text-destructive" : "text-muted-foreground"}>
                  {c.status === "CONNECTED" ? "CONNECTED · Đã kết nối" : c.status === "TEST_MODE" ? "TEST MODE · Chế độ thử" : c.status === "FAILED" ? "FAILED · Lỗi" : c.status === "DRAFT" ? "Chưa bật" : "Chưa khai"}
                </span>
                {c.destination ? <span className="text-muted-foreground"> · {c.destination}</span> : null}
              </p>
              {c.message && c.status === "FAILED" ? <p className="mt-1 text-xs text-destructive">{c.message}</p> : null}
            </li>
          ))}
        </ul>
      </SectionCard>
      <NotificationPresetForm connections={setup.connections} events={setup.events} vars={ORDER_MESSAGE_VARS.map((v) => ({ key: v.key, label: v.label }))} />
      <SectionCard title="Tin đã gửi" description="30 tin gần nhất — hộp thử đọc ở đây.">
        {setup.deliveries.length === 0 ? (
          <p className="text-sm text-muted-foreground">Chưa có tin nào.</p>
        ) : (
          <ul className="space-y-2" data-testid="delivery-log">
            {setup.deliveries.map((d) => (
              <li key={d.id} className="rounded-lg border p-3 text-xs" data-status={d.status} data-event={d.event ?? ""}>
                <p className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                  <span className="font-semibold text-foreground">{DELIVERY_STATUS_LABEL[d.status] ?? d.status}</span>
                  <span>{MESSAGING_CONNECTOR_LABEL[d.connectorKey as keyof typeof MESSAGING_CONNECTOR_LABEL] ?? d.connectorKey}</span>
                  {d.destination ? <span>→ {d.destination}</span> : null}
                  {d.event ? <span>· {d.event}</span> : null}
                  {d.isTest ? <span className="rounded bg-muted px-1">tin thử</span> : null}
                  <span>· {formatDateTime(d.sentAt ?? d.createdAt)}</span>
                </p>
                <pre className="mt-1.5 whitespace-pre-wrap font-sans text-[13px] leading-5">{d.title ? `${d.title}\n` : ""}{d.body}</pre>
                {d.error ? <p className="mt-1 text-destructive">{d.error}</p> : null}
                {d.status === "FAILED" && d.nextRetryAt ? <p className="mt-1 font-semibold">ERP sẽ tự gửi lại lúc {formatDateTime(d.nextRetryAt)} (lần thử {d.attempts + 1}).</p> : null}
                {d.status === "SENT" && d.attempts > 1 ? <p className="mt-1 text-muted-foreground">Gửi được ở lần thử thứ {d.attempts} (mạng chập chờn lúc đầu).</p> : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
