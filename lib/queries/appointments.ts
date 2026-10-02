import { and, asc, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { packageBalance, type AppointmentStatus, type PackageBalance } from "@/lib/constants/appointments";
import { addDays, vnStartOfDay } from "@/lib/format";

/** Lịch hẹn + liệu trình — PHẦN ĐỌC (docs/verticals/appointments.md). Số buổi liệu trình đếm lúc đọc từ lịch thật. */

export type AppointmentRow = {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  serviceName: string;
  variantId: string | null;
  staffUserId: string | null;
  staffName: string | null;
  startsAt: string;
  endsAt: string;
  status: AppointmentStatus;
  packageId: string | null;
  packageName: string | null;
  note: string;
  cancelReason: string | null;
};

function rowsQuery(db: Awaited<ReturnType<typeof getDb>>) {
  const a = schema.appointments;
  return db
    .select({
      id: a.id,
      customerId: a.customerId,
      customerName: schema.customers.name,
      customerPhone: schema.customers.phone,
      serviceName: a.serviceName,
      variantId: a.variantId,
      staffUserId: a.staffUserId,
      staffName: schema.users.name,
      startsAt: a.startsAt,
      endsAt: a.endsAt,
      status: a.status,
      packageId: a.packageId,
      packageName: schema.customerPackages.name,
      note: a.note,
      cancelReason: a.cancelReason,
    })
    .from(a)
    .innerJoin(schema.customers, eq(schema.customers.id, a.customerId))
    .leftJoin(schema.users, eq(schema.users.id, a.staffUserId))
    .leftJoin(schema.customerPackages, eq(schema.customerPackages.id, a.packageId));
}

type RawRow = Awaited<ReturnType<ReturnType<typeof rowsQuery>["execute"]>>[number];
function appointmentRowOf(r: RawRow): AppointmentRow {
  return { ...r, startsAt: r.startsAt.toISOString(), endsAt: r.endsAt.toISOString(), status: r.status as AppointmentStatus };
}

/** Lịch của MỘT ngày (giờ Việt Nam), theo giờ bắt đầu. */
export async function appointmentsOfDay(day: string): Promise<AppointmentRow[]> {
  const db = await getDb();
  const a = schema.appointments;
  const rows = await rowsQuery(db)
    .where(and(gte(a.startsAt, vnStartOfDay(day)), lt(a.startsAt, vnStartOfDay(addDays(day, 1)))))
    .orderBy(asc(a.startsAt), asc(a.id));
  return rows.map(appointmentRowOf);
}

export type PackageView = { id: string; name: string; status: string; expiresOn: string | null; orderId: string | null; note: string; createdAt: string; balance: PackageBalance };

/** Liệu trình của một khách (hoặc mọi khách) kèm số dư đếm từ lịch. */
export async function packagesOf(customerIds?: readonly string[]): Promise<(PackageView & { customerId: string })[]> {
  const db = await getDb();
  if (customerIds && customerIds.length === 0) return [];
  const p = schema.customerPackages;
  const rows = await db
    .select({
      id: p.id,
      customerId: p.customerId,
      name: p.name,
      status: p.status,
      totalSessions: p.totalSessions,
      expiresOn: p.expiresOn,
      orderId: p.orderId,
      note: p.note,
      createdAt: p.createdAt,
      used: sql<number>`(select count(*) from appointments x where x.package_id = "customer_packages"."id" and x.status = 'DONE')`.mapWith(Number),
      reserved: sql<number>`(select count(*) from appointments x where x.package_id = "customer_packages"."id" and x.status in ('BOOKED','CONFIRMED','CHECKED_IN'))`.mapWith(Number),
    })
    .from(p)
    .where(customerIds ? inArray(p.customerId, [...customerIds]) : undefined)
    .orderBy(desc(p.createdAt));
  return rows.map((r) => ({ id: r.id, customerId: r.customerId, name: r.name, status: r.status, expiresOn: r.expiresOn ?? null, orderId: r.orderId, note: r.note, createdAt: r.createdAt.toISOString(), balance: packageBalance(r.totalSessions, r.used, r.reserved) }));
}

/** Lịch sắp tới + 10 lịch gần nhất đã qua của một khách. */
export async function customerAppointments(customerId: string, now: Date = new Date()): Promise<{ upcoming: AppointmentRow[]; past: AppointmentRow[] }> {
  const db = await getDb();
  const a = schema.appointments;
  const [upcoming, past] = await Promise.all([
    rowsQuery(db).where(and(eq(a.customerId, customerId), gte(a.endsAt, now))).orderBy(asc(a.startsAt)).limit(20),
    rowsQuery(db).where(and(eq(a.customerId, customerId), lt(a.endsAt, now))).orderBy(desc(a.startsAt)).limit(10),
  ]);
  return { upcoming: upcoming.map(appointmentRowOf), past: past.map(appointmentRowOf) };
}

export type AppointmentFormOptions = {
  customers: { id: string; name: string; phone: string | null }[];
  services: { id: string; label: string; price: number | null }[];
  staff: { id: string; name: string }[];
  packages: { id: string; customerId: string; name: string; available: number }[];
};

/** Lựa chọn của form đặt lịch: khách, dịch vụ (mẫu mã đang bán), kỹ thuật viên (tài khoản đang hoạt động), liệu trình mở. */
export async function appointmentFormOptions(): Promise<AppointmentFormOptions> {
  const db = await getDb();
  const [customers, services, staff, pkgs] = await Promise.all([
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone }).from(schema.customers).orderBy(asc(schema.customers.name)).limit(2000),
    db
      .select({ id: schema.productVariants.id, name: schema.products.name, detail: schema.productVariants.detail, size: schema.productVariants.size, price: schema.productVariants.retailPrice })
      .from(schema.productVariants)
      .innerJoin(schema.products, eq(schema.products.id, schema.productVariants.productId))
      .where(and(eq(schema.productVariants.isRemoved, false), eq(schema.products.isRemoved, false)))
      .orderBy(asc(schema.products.name))
      .limit(2000),
    db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name)).limit(500),
    packagesOf(),
  ]);
  return {
    customers,
    services: services.map((s) => ({ id: s.id, label: [s.name, s.detail.trim() || s.size.trim()].filter(Boolean).join(" · "), price: s.price > 0 ? s.price : null })),
    staff,
    packages: pkgs.filter((p) => p.status === "ACTIVE" && p.balance.available > 0).map((p) => ({ id: p.id, customerId: p.customerId, name: p.name, available: p.balance.available })),
  };
}
