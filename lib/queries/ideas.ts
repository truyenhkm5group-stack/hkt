import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { IdeaStatus } from "@/db/schema";
import { IDEA_STATUSES } from "@/lib/constants/ideas";
import { DEPARTMENTS, PAYROLL_EMPLOYEES_KEY, type Employee } from "@/lib/constants/payroll";
import { getSettingJson } from "@/lib/settings";
import type { Period } from "@/lib/search-params";

const i = schema.marketingIdeas;
const img = schema.marketingIdeaImages;
const cm = schema.marketingIdeaComments;

export type IdeaListRow = {
  id: string;
  marketerId: string | null;
  marketerName: string;
  ideaDate: string;
  content: string;
  status: IdeaStatus;
  createdByName: string;
  createdAt: Date;
  /** Chỉ id ảnh — dữ liệu ảnh không bao giờ đi kèm truy vấn danh sách. */
  imageIds: string[];
  comments: number;
  lastCommentAt: Date | null;
};

function where(opts: { period?: Period; status?: IdeaStatus | "ALL"; marketer?: string; q?: string }) {
  const conds: SQL[] = [];
  if (opts.period?.from) conds.push(gte(i.createdAt, opts.period.from));
  if (opts.period?.to) conds.push(lte(i.createdAt, opts.period.to));
  if (opts.status && opts.status !== "ALL") conds.push(eq(i.status, opts.status));
  if (opts.marketer) conds.push(eq(i.marketerId, opts.marketer));
  const q = (opts.q ?? "").trim();
  if (q) conds.push(sql`(${i.content} ilike ${`%${q}%`} or ${i.marketerName} ilike ${`%${q}%`})`);
  return conds.length ? and(...conds) : undefined;
}

export async function listIdeas(opts: { period?: Period; status?: IdeaStatus | "ALL"; marketer?: string; q?: string; page?: number; pageSize?: number }) {
  const db = await getDb();
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(6, opts.pageSize ?? 24));
  const cond = where(opts);

  const rows = await db
    .select({
      id: i.id,
      marketerId: i.marketerId,
      marketerName: i.marketerName,
      ideaDate: i.ideaDate,
      content: i.content,
      status: i.status,
      createdByName: i.createdByName,
      createdAt: i.createdAt,
      comments: sql<number>`(select count(*) from marketing_idea_comments c where c.idea_id = ${i.id})`,
      lastCommentAt: sql<Date | null>`(select max(c.created_at) from marketing_idea_comments c where c.idea_id = ${i.id})`,
    })
    .from(i)
    .where(cond)
    .orderBy(desc(i.ideaDate), desc(i.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  // Ảnh lấy bằng MỘT truy vấn riêng theo đúng các ý tưởng của trang: `array_agg` lồng trong câu
  // chính trả về kiểu khác nhau giữa hai trình điều khiển, mà ở đây chỉ cần danh sách id.
  const ids = rows.map((r) => r.id);
  const anh = ids.length
    ? await db
        .select({ ideaId: img.ideaId, id: img.id })
        .from(img)
        .where(inArray(img.ideaId, ids))
        .orderBy(img.ideaId, img.sortOrder, img.createdAt)
    : [];
  const anhTheoY = new Map<string, string[]>();
  for (const a of anh) anhTheoY.set(a.ideaId, [...(anhTheoY.get(a.ideaId) ?? []), a.id]);

  const [total] = await db.select({ n: sql<number>`count(*)` }).from(i).where(cond);
  const n = Number(total?.n ?? 0);
  return {
    rows: rows.map((r): IdeaListRow => ({
      ...r,
      imageIds: anhTheoY.get(r.id) ?? [],
      comments: Number(r.comments ?? 0),
      lastCommentAt: r.lastCommentAt ? new Date(r.lastCommentAt) : null,
    })),
    total: n,
    pageCount: Math.max(1, Math.ceil(n / pageSize)),
  };
}

/** Đếm theo trạng thái để hiện số trên tab; luôn trả đủ 5 trạng thái kể cả khi chưa có ý tưởng nào. */
export async function ideaCounts(opts: { period?: Period; marketer?: string; q?: string }) {
  const db = await getDb();
  const rows = await db
    .select({ status: i.status, n: sql<number>`count(*)` })
    .from(i)
    .where(where({ ...opts, status: "ALL" }))
    .groupBy(i.status);
  const out = { ALL: 0 } as Record<IdeaStatus | "ALL", number>;
  for (const s of IDEA_STATUSES) out[s] = 0;
  for (const r of rows) {
    out[r.status] = Number(r.n ?? 0);
    out.ALL += Number(r.n ?? 0);
  }
  return out;
}

export type IdeaDetail = {
  id: string;
  marketerId: string | null;
  marketerName: string;
  ideaDate: string;
  content: string;
  status: IdeaStatus;
  createdBy: string;
  createdByName: string;
  createdAt: Date;
  reviewedAt: Date | null;
  reviewedBy: string;
  images: { id: string; bytes: number }[];
  comments: { id: string; authorName: string; authorEmail: string; body: string; statusSet: IdeaStatus | null; createdAt: Date }[];
};

export async function getIdea(id: string): Promise<IdeaDetail | null> {
  const db = await getDb();
  const row = await db.query.marketingIdeas.findFirst({ where: eq(i.id, id) });
  if (!row) return null;
  const [images, comments] = await Promise.all([
    db.select({ id: img.id, bytes: img.bytes }).from(img).where(eq(img.ideaId, id)).orderBy(img.sortOrder, img.createdAt),
    db.select({ id: cm.id, authorName: cm.authorName, authorEmail: cm.authorEmail, body: cm.body, statusSet: cm.statusSet, createdAt: cm.createdAt }).from(cm).where(eq(cm.ideaId, id)).orderBy(cm.createdAt),
  ]);
  return { ...row, images, comments };
}

/** Dữ liệu một ảnh — chỉ dùng cho route phục vụ ảnh, không gọi từ trang danh sách. */
export async function getIdeaImage(id: string) {
  const db = await getDb();
  const [row] = await db.select({ data: img.data, contentType: img.contentType }).from(img).where(eq(img.id, id)).limit(1);
  return row ?? null;
}

/**
 * Danh sách marketer để chọn người phụ trách: lấy từ khai báo nhân sự của Lương (phòng Marketing),
 * cộng thêm tên đã từng dùng trong bảng ý tưởng để không mất người đã nhập trước khi khai báo.
 */
export async function listMarketers(): Promise<{ id: string; name: string }[]> {
  const db = await getDb();
  const employees = await getSettingJson<Employee[]>(PAYROLL_EMPLOYEES_KEY, []);
  const marketing = (Array.isArray(employees) ? employees : [])
    .filter((e) => e && e.name && (!e.department || e.department === DEPARTMENTS[0]))
    .map((e) => ({ id: String(e.id), name: String(e.name) }));
  const daDung = await db
    .selectDistinct({ id: i.marketerId, name: i.marketerName })
    .from(i)
    .where(sql`${i.marketerName} <> ''`);
  const byId = new Map(marketing.map((m) => [m.id, m]));
  for (const d of daDung) {
    const key = d.id ?? `ten:${d.name}`;
    if (!byId.has(key)) byId.set(key, { id: key, name: d.name });
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "vi"));
}

/** Ý tưởng đang chờ quản lý — dùng cho chuông / trang Cần xử lý sau này. */
export async function ideasWaitingReview() {
  const db = await getDb();
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(i)
    .where(inArray(i.status, ["NEW", "CHANGES"]));
  return Number(row?.n ?? 0);
}
