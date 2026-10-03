/**
 * ═══════════ XUẤT DỮ LIỆU CỦA TỔ CHỨC — CHỈ MÁY CHỦ (docs/platform/data-export.md) ═══════════
 *
 * Đọc CSDL của tổ chức ngữ cảnh (phiên), không nhận mã tổ chức nào từ client. Mỗi loại một bộ cột ổn định, nhãn tiếng Việt;
 * tiền là số nguyên VND; thời gian giờ Việt Nam. Ô chưa biết để TRỐNG, không in 0 (luật 42).
 */
import { asc, eq, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { APPOINTMENT_STATUS_LABEL, packageBalance, type AppointmentStatus } from "@/lib/constants/appointments";
import { csvDocument, type DataExportKind } from "@/lib/constants/data-export";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { PAYMENT_KIND_LABEL, PAYMENT_METHOD_LABEL, type PaymentKind, type PaymentMethod } from "@/lib/constants/order-payments";
import { formatDateTime } from "@/lib/format";

/** Trần kỹ thuật một tệp — vượt thì tệp nói rõ là đã cắt, không cắt im lặng. */
export const DATA_EXPORT_MAX_ROWS = 100_000;

export type TenantExport = { csv: string; rows: number; truncated: boolean };

const when = (d: Date | null) => (d ? formatDateTime(d) : "");

function done(header: string[], rows: unknown[][]): TenantExport {
  const truncated = rows.length > DATA_EXPORT_MAX_ROWS;
  const body = truncated ? rows.slice(0, DATA_EXPORT_MAX_ROWS) : rows;
  const out = truncated ? [...body, [`ĐÃ CẮT ở ${DATA_EXPORT_MAX_ROWS} dòng — liên hệ bên cung cấp để lấy bản đầy đủ.`]] : body;
  return { csv: csvDocument(header, out), rows: body.length, truncated };
}

async function customersCsv(): Promise<TenantExport> {
  const db = await getDb();
  const c = schema.customers;
  const rows = await db.select().from(c).orderBy(asc(c.name)).limit(DATA_EXPORT_MAX_ROWS + 1);
  return done(
    ["Tên", "SĐT", "SĐT khác", "Email", "Địa chỉ", "Tỉnh/TP", "Thẻ", "Số đơn", "Đã mua (đ)", "Đơn gần nhất", "Ngày tạo", "Nguồn", "Mã khách"],
    rows.map((r) => [
      r.name,
      r.phone ?? "",
      r.phones.filter((p) => p !== r.phone).join(" | "),
      r.emails.join(" | "),
      r.address,
      r.province,
      r.tags.join(" | "),
      r.orderCount,
      r.purchasedAmount ?? "",
      when(r.lastOrderAt),
      when(r.insertedAt ?? r.createdAt),
      r.pancakeId ? "Pancake" : "ERP",
      r.id,
    ]),
  );
}

async function appointmentsCsv(): Promise<TenantExport> {
  const db = await getDb();
  const a = schema.appointments;
  const rows = await db
    .select({ a, customer: schema.customers.name, phone: schema.customers.phone, staff: schema.users.name, pkg: schema.customerPackages.name })
    .from(a)
    .innerJoin(schema.customers, eq(schema.customers.id, a.customerId))
    .leftJoin(schema.users, eq(schema.users.id, a.staffUserId))
    .leftJoin(schema.customerPackages, eq(schema.customerPackages.id, a.packageId))
    .orderBy(asc(a.startsAt))
    .limit(DATA_EXPORT_MAX_ROWS + 1);
  return done(
    ["Bắt đầu", "Kết thúc", "Khách", "SĐT", "Dịch vụ", "Kỹ thuật viên", "Trạng thái", "Liệu trình", "Ghi chú", "Lý do huỷ", "Người đặt", "Mã lịch"],
    rows.map((r) => [
      when(r.a.startsAt),
      when(r.a.endsAt),
      r.customer,
      r.phone ?? "",
      r.a.serviceName,
      r.staff ?? "",
      APPOINTMENT_STATUS_LABEL[r.a.status as AppointmentStatus] ?? r.a.status,
      r.pkg ?? "",
      r.a.note,
      r.a.cancelReason ?? "",
      r.a.createdByName,
      r.a.id,
    ]),
  );
}

async function packagesCsv(): Promise<TenantExport> {
  const db = await getDb();
  const p = schema.customerPackages;
  const rows = await db
    .select({
      p,
      customer: schema.customers.name,
      phone: schema.customers.phone,
      // Câu con tương quan viết bằng tên bảng TƯỜNG MINH: không phụ thuộc cách Drizzle in cột (trong exists() nó in "id" trần).
      used: sql<number>`(select count(*) from "appointments" ap where ap."package_id" = "customer_packages"."id" and ap."status" = 'DONE')`.mapWith(Number),
      reserved: sql<number>`(select count(*) from "appointments" ap where ap."package_id" = "customer_packages"."id" and ap."status" in ('BOOKED','CONFIRMED','CHECKED_IN'))`.mapWith(Number),
    })
    .from(p)
    .innerJoin(schema.customers, eq(schema.customers.id, p.customerId))
    .orderBy(asc(schema.customers.name))
    .limit(DATA_EXPORT_MAX_ROWS + 1);
  return done(
    ["Khách", "SĐT", "Liệu trình", "Tổng buổi", "Đã làm", "Đang giữ chỗ", "Còn đặt được", "Hết hạn", "Trạng thái", "Ghi chú", "Mã liệu trình"],
    rows.map((r) => {
      const b = packageBalance(r.p.totalSessions, r.used, r.reserved);
      return [r.customer, r.phone ?? "", r.p.name, b.total, b.used, b.reserved, b.available, r.p.expiresOn ?? "", r.p.status === "ACTIVE" ? "Đang dùng" : "Đã đóng", r.p.note, r.p.id];
    }),
  );
}

async function paymentsCsv(): Promise<TenantExport> {
  const db = await getDb();
  const pay = schema.orderPayments;
  const rows = await db
    .select({ pay, customer: schema.customers.name, phone: schema.customers.phone })
    .from(pay)
    .innerJoin(schema.orders, eq(schema.orders.id, pay.orderId))
    .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
    .orderBy(asc(pay.paidAt))
    .limit(DATA_EXPORT_MAX_ROWS + 1);
  return done(
    ["Ngày", "Đơn", "Khách", "SĐT", "Loại", "Hình thức", "Số tiền (đ)", "Trạng thái", "Tham chiếu", "Ghi chú", "Người ghi", "Huỷ lúc", "Lý do huỷ", "Mã phiếu"],
    rows.map((r) => [
      when(r.pay.paidAt),
      r.pay.orderId ? `#${manualOrderShortCode(r.pay.orderId)}` : "",
      r.customer ?? "",
      r.phone ?? "",
      PAYMENT_KIND_LABEL[r.pay.kind as PaymentKind] ?? r.pay.kind,
      PAYMENT_METHOD_LABEL[r.pay.method as PaymentMethod] ?? r.pay.method,
      r.pay.amount,
      r.pay.status === "VOIDED" ? "Đã huỷ" : "Hiệu lực",
      r.pay.reference,
      r.pay.note,
      r.pay.createdByName,
      when(r.pay.voidedAt),
      r.pay.voidReason ?? "",
      r.pay.id,
    ]),
  );
}

export async function buildTenantExport(kind: DataExportKind): Promise<TenantExport> {
  switch (kind) {
    case "customers":
      return customersCsv();
    case "appointments":
      return appointmentsCsv();
    case "packages":
      return packagesCsv();
    case "payments":
      return paymentsCsv();
  }
}
