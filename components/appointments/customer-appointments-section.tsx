import Link from "next/link";
import { AppointmentStatusButtons, ClosePackageButton, PackageCreateForm } from "@/components/appointments/appointment-forms";
import { SectionCard } from "@/components/ui-bits";
import { can, type SessionUser } from "@/lib/auth/session";
import { APPOINTMENT_STATUS_LABEL } from "@/lib/constants/appointments";
import { formatDate, vnClock, vnDateKey } from "@/lib/format";
import { appointmentFormOptions, customerAppointments, packagesOf } from "@/lib/queries/appointments";

/** Khung LỊCH HẸN & LIỆU TRÌNH trên trang một khách (module `appointments`, 0190). */
export async function CustomerAppointmentsSection({ user, customerId }: { user: SessionUser; customerId: string }) {
  const canWrite = can(user, "appointments:write");
  const [appts, pkgs, options] = await Promise.all([customerAppointments(customerId), packagesOf([customerId]), canWrite ? appointmentFormOptions() : Promise.resolve(null)]);
  const open = pkgs.filter((p) => p.status === "ACTIVE");
  return (
    <SectionCard
      id="appointments"
      title="Lịch hẹn & liệu trình"
      description={`${appts.upcoming.length} lịch sắp tới · ${open.length} liệu trình đang mở`}
      actions={
        canWrite ? (
          <Link href={`/appointments?customer=${encodeURIComponent(customerId)}`} className="text-xs font-medium text-primary hover:underline">
            Đặt lịch cho khách
          </Link>
        ) : null
      }
    >
      <div className="space-y-4 text-sm" data-customer-appointments>
        <div className="space-y-1">
          <h3 className="font-semibold">Liệu trình</h3>
          {pkgs.length === 0 ? (
            <p className="text-xs text-muted-foreground">Chưa có liệu trình nào.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {pkgs.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2" data-package={p.id}>
                  <span className="font-medium">{p.name}</span>
                  <span className="numeric">
                    đã làm {p.balance.used}/{p.balance.total} · đang giữ {p.balance.reserved} · còn đặt được {p.balance.available}
                  </span>
                  {p.expiresOn ? <span>· hết hạn {formatDate(p.expiresOn)}</span> : null}
                  {p.status !== "ACTIVE" ? <span className="text-muted-foreground">· đã đóng</span> : canWrite ? <ClosePackageButton id={p.id} customerId={customerId} /> : null}
                </li>
              ))}
            </ul>
          )}
          {canWrite && options ? <PackageCreateForm customerId={customerId} services={options.services} /> : null}
        </div>
        <div className="space-y-1">
          <h3 className="font-semibold">Sắp tới</h3>
          {appts.upcoming.length === 0 ? (
            <p className="text-xs text-muted-foreground">Không có lịch sắp tới.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {appts.upcoming.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <Link href={`/appointments?day=${vnDateKey(a.startsAt)}`} className="font-medium hover:underline">
                    {formatDate(a.startsAt)} {vnClock(a.startsAt)}
                  </Link>
                  <span>
                    {a.serviceName}
                    {a.staffName ? ` · ${a.staffName}` : ""} · {APPOINTMENT_STATUS_LABEL[a.status]}
                  </span>
                  {canWrite ? <AppointmentStatusButtons id={a.id} status={a.status} customerId={customerId} /> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        {appts.past.length ? (
          <div className="space-y-1">
            <h3 className="font-semibold">Gần đây</h3>
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {appts.past.map((a) => (
                <li key={a.id}>
                  {formatDate(a.startsAt)} {vnClock(a.startsAt)} · {a.serviceName}
                  {a.staffName ? ` · ${a.staffName}` : ""} · {APPOINTMENT_STATUS_LABEL[a.status]}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
