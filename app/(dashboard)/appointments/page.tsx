import Link from "next/link";
import { AppointmentCreateForm, AppointmentReschedule, AppointmentStatusButtons } from "@/components/appointments/appointment-forms";
import { PageHeader } from "@/components/page-header";
import { EmptyState, SectionCard } from "@/components/ui-bits";
import { can, requirePermission } from "@/lib/auth/session";
import { APPOINTMENT_STATUS_LABEL, isActiveAppointment, type AppointmentStatus } from "@/lib/constants/appointments";
import { addDays, formatDate, todayVN, vnClock } from "@/lib/format";
import { appointmentFormOptions, appointmentsOfDay, type AppointmentRow } from "@/lib/queries/appointments";
import { cn } from "@/lib/utils";

export const metadata = { title: "Lịch hẹn" };

const TONE: Record<AppointmentStatus, string> = {
  BOOKED: "border-sky-300 bg-sky-50 dark:border-sky-800 dark:bg-sky-950/40",
  CONFIRMED: "border-indigo-300 bg-indigo-50 dark:border-indigo-800 dark:bg-indigo-950/40",
  CHECKED_IN: "border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40",
  DONE: "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/40",
  NO_SHOW: "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40",
  CANCELLED: "border-muted bg-muted/40 text-muted-foreground line-through",
};

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * LỊCH HẸN (module `appointments`, 0190) — lịch MỘT ngày (giờ Việt Nam), nhóm theo kỹ thuật viên. Đặt lịch, chuyển trạng thái
 * (khách tới · làm xong · không tới · huỷ có lý do) ngay trên thẻ. Trùng giờ của một người bị chặn ở máy chủ.
 */
export default async function AppointmentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requirePermission("appointments:view");
  const sp = await searchParams;
  const today = todayVN();
  const day = typeof sp.day === "string" && DAY_RE.test(sp.day) ? sp.day : today;
  const presetCustomer = typeof sp.customer === "string" ? sp.customer : undefined;
  const canWrite = can(user, "appointments:write");
  const [rows, options] = await Promise.all([appointmentsOfDay(day), canWrite ? appointmentFormOptions() : Promise.resolve(null)]);
  const groups = new Map<string, { name: string; rows: AppointmentRow[] }>();
  for (const r of rows) {
    const key = r.staffUserId ?? "";
    const g = groups.get(key) ?? { name: r.staffName ?? "Chưa xếp kỹ thuật viên", rows: [] };
    g.rows.push(r);
    groups.set(key, g);
  }
  const active = rows.filter((r) => isActiveAppointment(r.status)).length;
  const done = rows.filter((r) => r.status === "DONE").length;
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Lịch hẹn"
        title={`Lịch ${formatDate(day)}${day === today ? " (hôm nay)" : ""}`}
        description={`${rows.length} lịch · ${active} đang chờ / đang làm · ${done} đã xong`}
        hint="Một kỹ thuật viên không có hai lịch đang hiệu lực chồng giờ (máy chủ chặn). Lịch gắn liệu trình giữ chỗ một buổi; làm xong mới trừ buổi. Huỷ lịch cần ghi lý do."
        actions={
          <nav className="flex gap-1 text-sm" aria-label="Chọn ngày">
            <Link href={`/appointments?day=${addDays(day, -1)}`} className="rounded-md border px-2 py-1 hover:bg-muted">
              ← Hôm trước
            </Link>
            <Link href="/appointments" className="rounded-md border px-2 py-1 hover:bg-muted">
              Hôm nay
            </Link>
            <Link href={`/appointments?day=${addDays(day, 1)}`} className="rounded-md border px-2 py-1 hover:bg-muted">
              Hôm sau →
            </Link>
          </nav>
        }
      />
      {canWrite && options ? (
        <SectionCard title="Đặt lịch">
          <AppointmentCreateForm options={options} day={day} presetCustomerId={presetCustomer} />
        </SectionCard>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="Chưa có lịch nào trong ngày" description={canWrite ? "Đặt lịch ở khung phía trên." : undefined} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-3" data-appointment-day={day}>
          {[...groups.entries()].map(([key, g]) => (
            <SectionCard key={key || "none"} title={g.name} description={`${g.rows.length} lịch`}>
              <ul className="space-y-2">
                {g.rows.map((r) => (
                  <li key={r.id} className={cn("rounded-md border px-3 py-2 text-sm", TONE[r.status])} data-appointment={r.status}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-semibold">
                        {vnClock(r.startsAt)}–{vnClock(r.endsAt)} · {r.serviceName}
                      </span>
                      <span className="text-xs">{APPOINTMENT_STATUS_LABEL[r.status]}</span>
                    </div>
                    <div className="text-xs">
                      <Link href={`/customers/${encodeURIComponent(r.customerId)}#appointments`} className="font-medium hover:underline">
                        {r.customerName}
                      </Link>
                      {r.customerPhone ? (
                        <>
                          {" "}
                          ·{" "}
                          <a href={`tel:${r.customerPhone}`} className="hover:underline">
                            {r.customerPhone}
                          </a>
                        </>
                      ) : null}
                      {r.packageName ? ` · liệu trình «${r.packageName}»` : ""}
                      {r.note ? <span className="text-muted-foreground"> · {r.note}</span> : null}
                      {r.cancelReason ? <span className="text-muted-foreground"> · huỷ: {r.cancelReason}</span> : null}
                    </div>
                    {canWrite ? (
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <AppointmentStatusButtons id={r.id} status={r.status} customerId={r.customerId} />
                        {options && isActiveAppointment(r.status) ? <AppointmentReschedule row={r} staff={options.staff} /> : null}
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </SectionCard>
          ))}
        </div>
      )}
    </div>
  );
}
