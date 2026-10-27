import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import {
  CONSENT_BASES,
  CONSENT_BASES_NEED_URL,
  CONSENT_BASIS_LABEL,
  CONSENT_CHANNELS,
  CONSENT_CHANNEL_LABEL,
  contactability,
  normalizeContactValue,
  normalizeEmail,
  type ConsentChannel,
  type Contactability,
  type ContactabilityLead,
  type ContactMode,
} from "@/lib/wholesale/contactability";
import { leadView } from "@/lib/wholesale/engine";

/**
 * ═══════════ NHẬT KÝ ĐỒNG Ý LIÊN HỆ — LÕI GHI / ĐỌC (CHỈ MÁY CHỦ, 0261) ═══════════
 *
 * Ghi: quyền (`wholesale:work`, quyền có sẵn — người chăm lead là người nghe khách đồng ý) → phạm vi dữ liệu của lead → zod →
 * ghi → nhật ký. Không thêm khoá quyền mới. Bảng CHỈ THÊM: thu hồi là điền một lần `revoked_at` (điều kiện `revoked_at IS
 * NULL` nằm ngay trong câu UPDATE, nên hai người bấm cùng lúc chỉ một người thắng) — không có đường xoá hay sửa nội dung.
 *
 * Đọc: `leadContactability()` gom đồng ý + dòng chặn của MỘT lead rồi hỏi hàm thuần `contactability()` — đó là chỗ duy nhất
 * quyết định. Mọi kênh TỰ GỬI về sau (email, Zalo OA, SMS) phải gọi hàm này với `mode = "AUTOMATED"` trước mỗi lượt gửi.
 */

const FORBIDDEN = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";

/** Câu báo khi CSDL tổ chức chưa áp 0261 (phục vụ bằng lược đồ cũ — `lib/constants/migration-serve-compat.ts`). */
export const CONSENT_SCHEMA_MISSING = "CSDL của tổ chức chưa áp migration 0261 (nhật ký đồng ý liên hệ) — chưa ghi được. Máy vẫn KHÔNG tự liên hệ kênh nào.";

function pgCodeOf(error: unknown): { code?: string; constraint?: string } {
  const e = error as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  return { code: e?.code ?? e?.cause?.code, constraint: e?.constraint ?? e?.cause?.constraint };
}

/** Bảng chưa tồn tại (SQLSTATE 42P01) — drizzle bọc lỗi pg trong `cause`. */
export function isMissingTable(error: unknown): boolean {
  return pgCodeOf(error).code === "42P01";
}

/** Vi phạm đúng một ràng buộc CHECK (23514 + tên) — dấu hiệu CSDL còn định nghĩa CHECK trước 0261. */
export function isCheckViolation(error: unknown, constraint: string): boolean {
  const c = pgCodeOf(error);
  return c.code === "23514" && c.constraint === constraint;
}

type Lead = typeof schema.wholesaleLeads.$inferSelect;
type Snap = typeof schema.wholesalePlaceSnapshots.$inferSelect;

async function leadInScope(user: SessionUser, leadId: string): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  return lead ? { lead } : { error: "Không tìm thấy lead." };
}

async function snapOf(lead: Lead): Promise<Snap | null> {
  if (!lead.placeId) return null;
  const db = await getDb();
  return (await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) })) ?? null;
}

/** Bốn khoá của lead mà danh sách chặn / đồng ý đọc — SĐT lấy theo cùng luật hiển thị (`leadView`: tổ chức trước, Google sau). */
export function contactabilityLeadOf(lead: Lead, snap: Snap | null): ContactabilityLead {
  const v = leadView(lead, snap);
  return { contactStatus: lead.contactStatus, placeId: lead.placeId, phone: v.phone, email: lead.email, websiteDomain: lead.websiteDomain ?? snap?.websiteDomain ?? null };
}

const recordSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  /** Bỏ trống ⇒ lấy địa chỉ hiện có của lead cho kênh đó. */
  contactValue: z.string().trim().max(254).default(""),
  basis: z.enum(CONSENT_BASES),
  evidenceText: z.string().trim().min(5, "Mô tả bằng chứng (ít nhất 5 ký tự) — lúc nào, ai, nội dung gì.").max(2000),
  evidenceUrl: z.string().trim().max(500).default(""),
});

function httpUrl(raw: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Ghi MỘT bằng chứng đồng ý cho một lead trên một kênh. */
export async function recordConsentCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ id: string }>> {
  const g = await leadInScope(user, leadId);
  if ("error" in g) return g;
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ — không ghi đồng ý được. Người cấu hình gỡ khỏi danh sách trước nếu khách đổi ý." };
  const key = contactabilityLeadOf(g.lead, await snapOf(g.lead));
  const fallback = d.channel === "EMAIL" ? key.email : key.phone;
  const value = normalizeContactValue(d.channel, d.contactValue || fallback);
  if (!value) return { error: d.channel === "EMAIL" ? "Cần email hợp lệ (lead chưa có email — nhập email khách đồng ý)." : "Cần SĐT hợp lệ (lead chưa có SĐT — nhập số khách đồng ý)." };
  if (d.basis === "EXISTING_CUSTOMER" && !g.lead.customerId) return { error: "Căn cứ «Đã là khách hàng» chỉ dùng khi lead đã chuyển thành khách hàng ERP." };
  const url = httpUrl(d.evidenceUrl);
  if (d.evidenceUrl && !url) return { error: "Link bằng chứng phải là địa chỉ http(s)." };
  if (CONSENT_BASES_NEED_URL.includes(d.basis) && !url) return { error: `Căn cứ «${CONSENT_BASIS_LABEL[d.basis]}» cần link tới chính lời mời chào hàng.` };
  const db = await getDb();
  let row: { id: string } | undefined;
  try {
    [row] = await db
      .insert(schema.wholesaleContactConsents)
      .values({ leadId, channel: d.channel, contactValue: value, basis: d.basis, evidenceText: d.evidenceText, evidenceUrl: url, source: "STAFF", recordedByUserId: user.id, recordedByName: user.name, recordedAt: now })
      .returning({ id: schema.wholesaleContactConsents.id });
  } catch (e) {
    if (isMissingTable(e)) return { error: CONSENT_SCHEMA_MISSING };
    throw e;
  }
  await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "CONSENT", channel: d.channel, note: `Ghi đồng ý liên hệ ${CONSENT_CHANNEL_LABEL[d.channel]} (${value}) — ${CONSENT_BASIS_LABEL[d.basis]}: ${d.evidenceText}`.slice(0, 2000), actorId: user.id, actorName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_CONSENT_RECORD", entity: "WHOLESALE_LEAD", entityId: leadId, after: { consentId: row!.id, channel: d.channel, value, basis: d.basis }, reason: d.evidenceText.slice(0, 300) });
  return { ok: true, id: row!.id };
}

const revokeSchema = z.object({ reason: z.string().trim().min(3, "Cần lý do thu hồi (ít nhất 3 ký tự).").max(500) });

/** Thu hồi một đồng ý: điền một lần `revoked_at` + lý do + người thu hồi. Đã thu hồi ⇒ báo lỗi, không ghi đè mốc cũ. */
export async function revokeConsentCore(user: SessionUser, consentId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ leadId: string }>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const parsed = revokeSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const c = schema.wholesaleContactConsents;
  let row: ConsentRow | undefined;
  try {
    row = await db.query.wholesaleContactConsents.findFirst({ where: eq(c.id, consentId) });
  } catch (e) {
    if (isMissingTable(e)) return { error: CONSENT_SCHEMA_MISSING };
    throw e;
  }
  if (!row) return { error: "Không tìm thấy dòng đồng ý." };
  const g = await leadInScope(user, row.leadId);
  if ("error" in g) return g;
  if (row.revokedAt) return { error: "Đồng ý này đã thu hồi trước đó." };
  const moved = await db
    .update(c)
    .set({ revokedAt: now, revokeReason: parsed.data.reason, revokedByUserId: user.id, revokedByName: user.name })
    .where(and(eq(c.id, consentId), isNull(c.revokedAt)))
    .returning({ id: c.id });
  if (!moved.length) return { error: "Đồng ý này vừa được người khác thu hồi." };
  await db.insert(schema.wholesaleLeadActivities).values({ leadId: row.leadId, kind: "CONSENT", channel: row.channel, note: `Thu hồi đồng ý liên hệ ${CONSENT_CHANNEL_LABEL[row.channel as ConsentChannel] ?? row.channel} (${row.contactValue}): ${parsed.data.reason}`.slice(0, 2000), actorId: user.id, actorName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_CONSENT_REVOKE", entity: "WHOLESALE_LEAD", entityId: row.leadId, before: { consentId, channel: row.channel, value: row.contactValue, basis: row.basis }, after: { revokedAt: now.toISOString() }, reason: parsed.data.reason });
  return { ok: true, leadId: row.leadId };
}

export type ConsentRow = typeof schema.wholesaleContactConsents.$inferSelect;

/**
 * Mọi dòng đồng ý của một lead, mới nhất trước (cả dòng đã thu hồi — nhật ký không giấu gì). `null` = CSDL chưa áp 0261:
 * không phải "đã biết là không có đồng ý", nhưng kết luận vẫn rơi về phía hẹp (máy không tự liên hệ).
 */
export async function consentsOfLead(leadId: string): Promise<ConsentRow[] | null> {
  const db = await getDb();
  const c = schema.wholesaleContactConsents;
  try {
    return await db.select().from(c).where(eq(c.leadId, leadId)).orderBy(desc(c.recordedAt));
  } catch (e) {
    if (isMissingTable(e)) return null;
    throw e;
  }
}

/** Dòng chặn khớp BẤT KỲ khoá nào của lead (Place ID · SĐT · tên miền · email). */
export async function suppressionsOfLead(key: ContactabilityLead): Promise<{ kind: string; value: string }[]> {
  const s = schema.wholesaleSuppressions;
  const email = normalizeEmail(key.email);
  const conds = [
    key.placeId ? and(eq(s.kind, "PLACE"), eq(s.value, key.placeId)) : undefined,
    key.phone ? and(eq(s.kind, "PHONE"), eq(s.value, key.phone)) : undefined,
    key.websiteDomain ? and(eq(s.kind, "DOMAIN"), eq(s.value, key.websiteDomain)) : undefined,
    email ? and(eq(s.kind, "EMAIL"), eq(s.value, email)) : undefined,
  ].filter((x) => x !== undefined);
  if (!conds.length) return [];
  const db = await getDb();
  return db.select({ kind: s.kind, value: s.value }).from(s).where(or(...conds));
}

/** Liên hệ được không — cho cả ba kênh, ở một chế độ. Đọc CSDL rồi giao cho hàm thuần. */
export async function leadContactability(lead: Lead, snap: Snap | null, mode: ContactMode = "AUTOMATED"): Promise<{ consents: ConsentRow[]; schemaReady: boolean; byChannel: Record<ConsentChannel, Contactability> }> {
  const key = contactabilityLeadOf(lead, snap);
  const [found, suppressions] = await Promise.all([consentsOfLead(lead.id), suppressionsOfLead(key)]);
  const consents = found ?? [];
  const byChannel = Object.fromEntries(CONSENT_CHANNELS.map((ch) => [ch, contactability(key, consents, suppressions, ch, mode)])) as Record<ConsentChannel, Contactability>;
  return { consents, schemaReady: found !== null, byChannel };
}
