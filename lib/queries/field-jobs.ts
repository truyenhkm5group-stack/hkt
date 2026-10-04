import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { fieldJobMoney, serviceWarrantyUntil, type FieldJobPayMethod, type FieldJobPhotoPhase, type FieldJobStatus } from "@/lib/constants/field-jobs";
import { vnDateKey } from "@/lib/format";

/**
 * ═══════════ PHIẾU CÔNG VIỆC — ĐỌC (docs/verticals/home-service.md) ═══════════
 *
 * Tổng / đã thu / còn nợ (`fieldJobMoney`) và hạn bảo hành dịch vụ (`serviceWarrantyUntil`) TÍNH Ở ĐÂY lúc đọc — sửa dòng báo
 * giá hay huỷ một phiếu thu là mọi màn hình đọc lại đúng, không cột nào lệch.
 */

export type FieldJobRow = {
  id: string;
  code: string;
  title: string;
  status: FieldJobStatus;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  address: string;
  assigneeName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  total: number | null;
  paid: number;
  due: number | null;
  parentJobId: string | null;
  updatedAt: string;
};

const fj = schema.fieldJobs;

async function moneyFor(jobIds: string[]) {
  const out = new Map<string, { total: number | null; paid: number; due: number | null }>();
  if (!jobIds.length) return out;
  const db = await getDb();
  const [lines, receipts] = await Promise.all([
    db.select({ jobId: schema.fieldJobLines.jobId, quantity: schema.fieldJobLines.quantity, unitPrice: schema.fieldJobLines.unitPrice }).from(schema.fieldJobLines).where(inArray(schema.fieldJobLines.jobId, jobIds)),
    db.select({ jobId: schema.fieldJobReceipts.jobId, amount: schema.fieldJobReceipts.amount, status: schema.fieldJobReceipts.status }).from(schema.fieldJobReceipts).where(inArray(schema.fieldJobReceipts.jobId, jobIds)),
  ]);
  for (const id of jobIds) out.set(id, fieldJobMoney(lines.filter((l) => l.jobId === id), receipts.filter((r) => r.jobId === id)));
  return out;
}

export type FieldJobFilter = { view: "open" | "mine" | "done" | "all"; q: string; userId: string };

/** Danh sách phiếu: đang mở (chưa nghiệm thu / huỷ) · việc của tôi (thợ = tôi, chưa xong) · đã xong · tất cả. Tra theo mã / tên việc / khách / SĐT. */
export async function listFieldJobs(filter: FieldJobFilter): Promise<FieldJobRow[]> {
  const db = await getDb();
  const term = filter.q.trim().slice(0, 80);
  const digits = term.replace(/\D/g, "");
  const open = inArray(fj.status, ["QUOTED", "ACCEPTED", "SCHEDULED", "IN_PROGRESS"]);
  const where = and(
    filter.view === "open" ? open : filter.view === "mine" ? and(open, eq(fj.assigneeUserId, filter.userId)) : filter.view === "done" ? eq(fj.status, "DONE") : undefined,
    term
      ? or(
          ilike(fj.code, `%${term}%`),
          ilike(fj.title, `%${term}%`),
          ilike(schema.customers.name, `%${term}%`),
          digits.length >= 4 ? sql`regexp_replace(coalesce(${schema.customers.phone}, ''), '\\D', '', 'g') like ${`%${digits}%`}` : undefined,
        )
      : undefined,
  );
  const rows = await db
    .select({ job: fj, customerName: schema.customers.name, customerPhone: schema.customers.phone, assigneeName: schema.users.name })
    .from(fj)
    .innerJoin(schema.customers, eq(schema.customers.id, fj.customerId))
    .leftJoin(schema.users, eq(schema.users.id, fj.assigneeUserId))
    .where(where)
    .orderBy(sql`${fj.scheduledStart} asc nulls last`, desc(fj.updatedAt))
    .limit(300);
  const money = await moneyFor(rows.map((r) => r.job.id));
  return rows.map((r) => {
    const m = money.get(r.job.id) ?? { total: null, paid: 0, due: null };
    return {
      id: r.job.id,
      code: r.job.code,
      title: r.job.title,
      status: r.job.status as FieldJobStatus,
      customerId: r.job.customerId,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      address: r.job.address,
      assigneeName: r.assigneeName ?? null,
      scheduledStart: r.job.scheduledStart?.toISOString() ?? null,
      scheduledEnd: r.job.scheduledEnd?.toISOString() ?? null,
      total: m.total,
      paid: m.paid,
      due: m.due,
      parentJobId: r.job.parentJobId,
      updatedAt: r.job.updatedAt.toISOString(),
    };
  });
}

/** Lịch thợ trong một ngày (giờ VN): phiếu đã hẹn / đang làm có giờ hẹn rơi vào ngày đó, theo thợ rồi theo giờ. */
export async function fieldJobDaySchedule(day: string): Promise<{ assigneeName: string; jobs: { id: string; code: string; title: string; start: string; end: string; status: FieldJobStatus; address: string }[] }[]> {
  const db = await getDb();
  const from = new Date(`${day}T00:00:00+07:00`);
  const to = new Date(from.getTime() + 86_400_000);
  const rows = await db
    .select({ id: fj.id, code: fj.code, title: fj.title, start: fj.scheduledStart, end: fj.scheduledEnd, status: fj.status, address: fj.address, assigneeName: schema.users.name })
    .from(fj)
    .innerJoin(schema.users, eq(schema.users.id, fj.assigneeUserId))
    .where(and(inArray(fj.status, ["SCHEDULED", "IN_PROGRESS", "DONE"]), gte(fj.scheduledStart, from), lt(fj.scheduledStart, to)))
    .orderBy(asc(schema.users.name), asc(fj.scheduledStart));
  const groups = new Map<string, { id: string; code: string; title: string; start: string; end: string; status: FieldJobStatus; address: string }[]>();
  for (const r of rows) {
    if (!r.start || !r.end) continue;
    groups.set(r.assigneeName, [...(groups.get(r.assigneeName) ?? []), { id: r.id, code: r.code, title: r.title, start: r.start.toISOString(), end: r.end.toISOString(), status: r.status as FieldJobStatus, address: r.address }]);
  }
  return [...groups.entries()].map(([assigneeName, jobs]) => ({ assigneeName, jobs }));
}

export type FieldJobDetail = FieldJobRow & {
  description: string;
  acceptedAt: string | null;
  acceptedNote: string;
  assigneeUserId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  signedByName: string | null;
  completionNote: string;
  warrantyMonths: number | null;
  warrantyUntil: string | null;
  inWarranty: boolean | null;
  cancelReason: string | null;
  lines: { id: string; description: string; quantity: number; unitPrice: number }[];
  receipts: { id: string; amount: number; method: FieldJobPayMethod; paidAt: string; note: string; status: string; voidReason: string | null; createdByName: string }[];
  photos: { id: string; phase: FieldJobPhotoPhase; uploadedByName: string; createdAt: string }[];
  parent: { id: string; code: string } | null;
  revisits: { id: string; code: string; status: FieldJobStatus }[];
};

export async function fieldJobDetail(id: string, today: string = vnDateKey(new Date())): Promise<FieldJobDetail | null> {
  const db = await getDb();
  const [r] = await db
    .select({ job: fj, customerName: schema.customers.name, customerPhone: schema.customers.phone, assigneeName: schema.users.name })
    .from(fj)
    .innerJoin(schema.customers, eq(schema.customers.id, fj.customerId))
    .leftJoin(schema.users, eq(schema.users.id, fj.assigneeUserId))
    .where(eq(fj.id, id))
    .limit(1);
  if (!r) return null;
  const j = r.job;
  const [lines, receipts, photos, parent, revisits] = await Promise.all([
    db.select({ id: schema.fieldJobLines.id, description: schema.fieldJobLines.description, quantity: schema.fieldJobLines.quantity, unitPrice: schema.fieldJobLines.unitPrice }).from(schema.fieldJobLines).where(eq(schema.fieldJobLines.jobId, id)).orderBy(asc(schema.fieldJobLines.position)),
    db.select().from(schema.fieldJobReceipts).where(eq(schema.fieldJobReceipts.jobId, id)).orderBy(asc(schema.fieldJobReceipts.paidAt)),
    db.select({ id: schema.fieldJobPhotos.id, phase: schema.fieldJobPhotos.phase, uploadedByName: schema.fieldJobPhotos.uploadedByName, createdAt: schema.fieldJobPhotos.createdAt }).from(schema.fieldJobPhotos).where(eq(schema.fieldJobPhotos.jobId, id)).orderBy(asc(schema.fieldJobPhotos.createdAt)),
    j.parentJobId ? db.select({ id: fj.id, code: fj.code }).from(fj).where(eq(fj.id, j.parentJobId)).limit(1) : Promise.resolve([]),
    db.select({ id: fj.id, code: fj.code, status: fj.status }).from(fj).where(eq(fj.parentJobId, id)).orderBy(asc(fj.createdAt)),
  ]);
  const money = fieldJobMoney(lines, receipts);
  const warrantyUntil = j.completedAt ? serviceWarrantyUntil(vnDateKey(j.completedAt), j.warrantyMonths) : null;
  return {
    id: j.id,
    code: j.code,
    title: j.title,
    status: j.status as FieldJobStatus,
    customerId: j.customerId,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
    address: j.address,
    assigneeName: r.assigneeName ?? null,
    scheduledStart: j.scheduledStart?.toISOString() ?? null,
    scheduledEnd: j.scheduledEnd?.toISOString() ?? null,
    total: money.total,
    paid: money.paid,
    due: money.due,
    parentJobId: j.parentJobId,
    updatedAt: j.updatedAt.toISOString(),
    description: j.description,
    acceptedAt: j.acceptedAt?.toISOString() ?? null,
    acceptedNote: j.acceptedNote,
    assigneeUserId: j.assigneeUserId,
    startedAt: j.startedAt?.toISOString() ?? null,
    completedAt: j.completedAt?.toISOString() ?? null,
    signedByName: j.signedByName,
    completionNote: j.completionNote,
    warrantyMonths: j.warrantyMonths,
    warrantyUntil,
    inWarranty: warrantyUntil ? today <= warrantyUntil : null,
    cancelReason: j.cancelReason,
    lines,
    receipts: receipts.map((x) => ({ id: x.id, amount: x.amount, method: x.method as FieldJobPayMethod, paidAt: x.paidAt.toISOString(), note: x.note, status: x.status, voidReason: x.voidReason, createdByName: x.createdByName })),
    photos: photos.map((p) => ({ id: p.id, phase: p.phase as FieldJobPhotoPhase, uploadedByName: p.uploadedByName, createdAt: p.createdAt.toISOString() })),
    parent: parent[0] ?? null,
    revisits: revisits.map((x) => ({ ...x, status: x.status as FieldJobStatus })),
  };
}

/** Ảnh của phiếu cho route tải ảnh. */
export async function readFieldJobPhoto(id: string): Promise<{ contentType: string; data: Buffer } | null> {
  const db = await getDb();
  const [row] = await db.select({ contentType: schema.fieldJobPhotos.contentType, data: schema.fieldJobPhotos.data }).from(schema.fieldJobPhotos).where(eq(schema.fieldJobPhotos.id, id)).limit(1);
  return row ?? null;
}

/** Khách + thợ cho form lập phiếu / hẹn. */
export async function fieldJobFormOptions(): Promise<{ customers: { id: string; name: string; phone: string | null; address: string }[]; techs: { id: string; name: string }[] }> {
  const db = await getDb();
  const [customers, techs] = await Promise.all([
    db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone, address: schema.customers.address }).from(schema.customers).orderBy(asc(schema.customers.name)).limit(2000),
    db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.active, true)).orderBy(asc(schema.users.name)).limit(500),
  ]);
  return { customers: customers.map((c) => ({ ...c, address: c.address ?? "" })), techs };
}
