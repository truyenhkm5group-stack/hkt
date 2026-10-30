import { and, asc, desc, eq, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { decideScope } from "@/lib/auth/scope-guard";
import type { SessionUser } from "@/lib/auth/session";
import { vnDateKey } from "@/lib/format";
import type { ListParams } from "@/lib/search-params";
import { isMissingQuotationTable, type QuotationSnapshot } from "@/lib/wholesale/quotation";
import { effectiveQuotationStatus, isQuotationStatus, type QuotationStatus } from "@/lib/wholesale/quotation-engine";

/**
 * ═══════════ BÁO GIÁ SỈ — ĐỌC (docs/tech/hslc-b2b-sales-agent.md · P1b) ═══════════
 *
 * Mọi số đọc từ CỘT / ẢNH CHỤP đã ghi lúc lập phiên bản — không truy vấn nào ở đây tính lại tiền. Trạng thái «Hết hạn» tính lúc
 * đọc từ `valid_until` (ngày VN), cùng luật với lõi ghi (`effectiveQuotationStatus`). Phạm vi dữ liệu: cùng mệnh đề với danh
 * sách lead (`WHOLESALE_LEADS`); báo giá chỉ gắn khách thì người phạm vi hẹp chỉ thấy bản mình lập. CSDL chưa áp 0263 ⇒
 * `{ unavailable: true }` (MIGRATION_SERVE_COMPAT).
 */

export type QuotationSchemaUnavailable = { unavailable: true };
const QUOTATION_SCHEMA_UNAVAILABLE: QuotationSchemaUnavailable = { unavailable: true };

async function guard<T>(fn: () => Promise<T>): Promise<T | QuotationSchemaUnavailable> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingQuotationTable(e)) return QUOTATION_SCHEMA_UNAVAILABLE;
    throw e;
  }
}

export const QUOTATION_FILTERS = ["status"];
export const QUOTATION_SORTABLE = ["createdAt", "total", "validUntil", "code"] as const;

const q = schema.wholesaleQuotations;

/** Trạng thái HIỆU LỰC bằng SQL — đúng `effectiveQuotationStatus` (bài kiểm so hai bản trên cùng dữ liệu). */
function effectiveStatusSql(today: string): SQL<string> {
  return sql<string>`case when ${q.status} in ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT') and ${q.validUntil} < ${today}::date then 'EXPIRED' else ${q.status} end`;
}

/** Mệnh đề phạm vi cho bảng báo giá. `null` = không thấy gì. */
async function scopeWhere(user: SessionUser): Promise<SQL | undefined | null> {
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return null;
  if (decision.allow === "ALL") return undefined;
  return sql`((${q.leadId} is not null and ${q.leadId} in (select "wholesale_leads"."id" from "wholesale_leads" where ${decision.where})) or (${q.leadId} is null and ${q.createdByUserId} = ${user.id}))`;
}

export type QuotationListRow = {
  id: string;
  code: string;
  version: number;
  status: QuotationStatus;
  partyName: string;
  leadId: string | null;
  customerId: string | null;
  total: number;
  shippingKnown: boolean;
  taxKnown: boolean;
  validUntil: string;
  requiresApproval: boolean;
  blockerCount: number;
  createdByName: string;
  createdAt: Date;
};

/** Danh sách — mặc định ẩn bản «Đã có bản mới» (mỗi mã một dòng: bản mới nhất); lọc trạng thái SUPERSEDED để xem chúng. */
export async function listQuotations(user: SessionUser, params: ListParams, now = new Date()): Promise<{ rows: QuotationListRow[]; total: number; pageCount: number; counts: Partial<Record<QuotationStatus, number>> } | QuotationSchemaUnavailable> {
  return guard(async () => {
    const scope = await scopeWhere(user);
    if (scope === null) return { rows: [], total: 0, pageCount: 0, counts: {} };
    const db = await getDb();
    const today = vnDateKey(now);
    const eff = effectiveStatusSql(today);
    const wanted = (params.filters.status ?? []).filter(isQuotationStatus);
    const conds: SQL[] = [];
    if (scope) conds.push(scope);
    if (wanted.length) conds.push(sql`${eff} in (${sql.join(wanted.map((s) => sql`${s}`), sql`, `)})`);
    else conds.push(sql`${q.status} <> 'SUPERSEDED'`);
    if (params.q.trim()) {
      const like = `%${params.q.trim().toLowerCase()}%`;
      conds.push(sql`(lower(${q.code}) like ${like} or lower(coalesce(${q.snapshot}->'party'->>'name', '')) like ${like})`);
    }
    const where = conds.length ? and(...conds) : undefined;
    const sortCol = params.sort === "total" ? q.total : params.sort === "validUntil" ? q.validUntil : params.sort === "code" ? q.code : q.createdAt;
    const [rows, [{ n }], countRows] = await Promise.all([
      db
        .select({
          id: q.id,
          code: q.code,
          version: q.version,
          status: q.status,
          partyName: sql<string>`coalesce(${q.snapshot}->'party'->>'name', '')`,
          leadId: q.leadId,
          customerId: q.customerId,
          total: q.total,
          shipping: q.shipping,
          tax: q.tax,
          validUntil: q.validUntil,
          requiresApproval: q.requiresApproval,
          blockerCount: q.blockerCount,
          createdByName: q.createdByName,
          createdAt: q.createdAt,
        })
        .from(q)
        .where(where)
        .orderBy(params.dir === "asc" ? asc(sortCol) : desc(sortCol), desc(q.id))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(q).where(where),
      db
        .select({ status: eff, n: sql<number>`count(*)`.mapWith(Number) })
        .from(q)
        .where(scope ?? undefined)
        // Nhóm theo VỊ TRÍ cột: hai lần nhắc `eff` là hai tham số $n khác nhau ⇒ Postgres coi là hai biểu thức (42803).
        .groupBy(sql`1`),
    ]);
    const counts: Partial<Record<QuotationStatus, number>> = {};
    for (const c of countRows) if (isQuotationStatus(c.status)) counts[c.status] = c.n;
    return {
      rows: rows.map((r) => ({
        id: r.id,
        code: r.code,
        version: r.version,
        status: effectiveQuotationStatus(r.status, r.validUntil, today),
        partyName: r.partyName,
        leadId: r.leadId,
        customerId: r.customerId,
        total: r.total,
        shippingKnown: r.shipping !== null,
        taxKnown: r.tax !== null,
        validUntil: r.validUntil,
        requiresApproval: r.requiresApproval,
        blockerCount: r.blockerCount,
        createdByName: r.createdByName,
        createdAt: r.createdAt,
      })),
      total: n,
      pageCount: Math.max(1, Math.ceil(n / params.pageSize)),
      counts,
    };
  });
}

export type QuotationLineRow = typeof schema.wholesaleQuotationLines.$inferSelect;

export type QuotationDetail = {
  row: typeof schema.wholesaleQuotations.$inferSelect;
  status: QuotationStatus;
  snapshot: QuotationSnapshot;
  lines: QuotationLineRow[];
  versions: { id: string; version: number; status: QuotationStatus; total: number; createdAt: Date; createdByName: string }[];
  /** Tên người duyệt / gửi / ghi kết quả — đọc từ `users` theo khoá (luật 34). */
  people: Record<string, string>;
};

/** Một phiên bản + dòng + lịch sử các phiên bản cùng mã. `null` = không có / ngoài phạm vi. */
export async function getQuotation(user: SessionUser, id: string, now = new Date()): Promise<QuotationDetail | null | QuotationSchemaUnavailable> {
  return guard(async () => {
    const scope = await scopeWhere(user);
    if (scope === null) return null;
    const db = await getDb();
    const [row] = await db
      .select()
      .from(q)
      .where(scope ? and(eq(q.id, id), scope) : eq(q.id, id))
      .limit(1);
    if (!row) return null;
    const today = vnDateKey(now);
    const [lines, versions] = await Promise.all([
      db.select().from(schema.wholesaleQuotationLines).where(eq(schema.wholesaleQuotationLines.quotationId, id)).orderBy(asc(schema.wholesaleQuotationLines.lineNo)),
      db.select({ id: q.id, version: q.version, status: q.status, validUntil: q.validUntil, total: q.total, createdAt: q.createdAt, createdByName: q.createdByName }).from(q).where(eq(q.code, row.code)).orderBy(desc(q.version)),
    ]);
    const ids = [row.approvedByUserId, row.sentByUserId, row.decidedByUserId].filter((x): x is string => Boolean(x));
    const users = ids.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(sql`${schema.users.id} in (${sql.join(ids.map((x) => sql`${x}`), sql`, `)})`) : [];
    return {
      row,
      status: effectiveQuotationStatus(row.status, row.validUntil, today),
      snapshot: row.snapshot as QuotationSnapshot,
      lines,
      versions: versions.map((v) => ({ id: v.id, version: v.version, status: effectiveQuotationStatus(v.status, v.validUntil, today), total: v.total, createdAt: v.createdAt, createdByName: v.createdByName })),
      people: Object.fromEntries(users.map((u) => [u.id, u.name])),
    };
  });
}

export type VariantOption = { id: string; label: string };

/** Mẫu mã ĐANG BÁN cho ô chọn của form báo giá — cùng điều kiện với danh mục bán sỉ (chưa gỡ, không ẩn). */
export async function quotationVariantOptions(limit = 3000): Promise<VariantOption[]> {
  const db = await getDb();
  const pv = schema.productVariants;
  const p = schema.products;
  const rows = await db
    .select({ id: pv.id, sku: pv.sku, detail: pv.detail, color: pv.color, size: pv.size, name: p.name })
    .from(pv)
    .innerJoin(p, eq(p.id, pv.productId))
    .where(and(eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false)))
    .orderBy(asc(p.name), asc(pv.sku), asc(pv.id))
    .limit(limit);
  return rows.map((r) => {
    const label = r.detail.trim() || [r.color, r.size].filter((x) => x.trim()).join(" · ");
    return { id: r.id, label: `${r.sku ? `${r.sku} — ` : ""}${r.name}${label ? ` (${label})` : ""}` };
  });
}

/** Tên bên nhận cho đầu form (lead / khách) — chỉ để hiển thị; lõi ghi tự đọc lại và kiểm phạm vi. */
export async function quotationPartyLabel(leadId: string | null, customerId: string | null): Promise<string> {
  const db = await getDb();
  if (leadId) {
    const [l] = await db.select({ name: schema.wholesaleLeads.businessName }).from(schema.wholesaleLeads).where(eq(schema.wholesaleLeads.id, leadId)).limit(1);
    if (l) return l.name || "Lead chưa có tên do nhân viên nhập";
  }
  if (customerId) {
    const [c] = await db.select({ name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.id, customerId)).limit(1);
    if (c) return c.name;
  }
  return "";
}
