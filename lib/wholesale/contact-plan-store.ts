import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { contactabilityLeadOf, isMissingTable } from "@/lib/wholesale/consents";
import { normalizeEmail, type ConsentRecord, type SuppressionRecord } from "@/lib/wholesale/contactability";
import {
  CONTACT_TRACK_LABEL,
  contactPlanOf,
  EMAIL_TRACKS,
  ZALO_MARK_OUTCOME,
  ZALO_MARKER_OUTCOMES,
  ZALO_UNDELIVERABLE_LABEL,
  ZALO_UNDELIVERABLE_REASONS,
  ZALO_UNMARK_OUTCOME,
  zaloMarkerOf,
  type ContactPlan,
  type ZaloMarker,
} from "@/lib/wholesale/contact-plan";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";
import { leadView } from "@/lib/wholesale/engine";
import { COUNTRY_CONFIRM_OUTCOME, COUNTRY_LABEL, countryConfirmationOf, isKnownCountry, leadCountryOf, type LeadCountry, type LeadCountryInput } from "@/lib/wholesale/lead-country";

/**
 * ═══════════ KẾ HOẠCH KÊNH — NẠP DỮ KIỆN + HÀNH ĐỘNG «ZALO KHÔNG GỬI ĐƯỢC» (CHỈ MÁY CHỦ) ═══════════
 *
 * Gom dữ kiện từ CSDL (lead + snapshot, đồng ý, danh sách chặn, dấu Zalo, nước đã rà) rồi giao cho hàm thuần
 * `contactPlanOf`. Dấu «Zalo không gửi được» là dòng `wholesale_lead_activities` kind `ZALO`, outcome `UNDELIVERABLE`;
 * hoàn tác là THÊM một dòng `UNDELIVERABLE_UNDONE` — không dòng nào bị xoá / sửa, không migration (lead duyệt 30/10).
 */

type Lead = typeof schema.wholesaleLeads.$inferSelect;
type Snap = typeof schema.wholesalePlaceSnapshots.$inferSelect;

const FORBIDDEN = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";

/** Kế hoạch kênh cho nhiều lead một lượt (trang Hàng đợi liên hệ) — số câu đọc cố định, không theo số lead. */
export async function contactPlansFor(leadIds: readonly string[]): Promise<Map<string, ContactPlan>> {
  const out = new Map<string, ContactPlan>();
  const ids = [...new Set(leadIds)].slice(0, 1000);
  if (!ids.length) return out;
  const db = await getDb();
  const leads = await db.select().from(schema.wholesaleLeads).where(inArray(schema.wholesaleLeads.id, ids));
  const placeIds = leads.map((l) => l.placeId).filter((x): x is string => Boolean(x));
  const snaps = placeIds.length ? await db.select().from(schema.wholesalePlaceSnapshots).where(inArray(schema.wholesalePlaceSnapshots.placeId, placeIds)) : [];
  const snapBy = new Map(snaps.map((s) => [s.placeId, s]));
  const keys = leads.map((l) => ({ lead: l, snap: l.placeId ? (snapBy.get(l.placeId) ?? null) : null }));
  const values = new Set<string>();
  for (const { lead, snap } of keys) {
    const k = contactabilityLeadOf(lead, snap);
    for (const v of [k.placeId, k.phone, k.websiteDomain, normalizeEmail(k.email)]) if (v) values.add(v);
  }
  const s = schema.wholesaleSuppressions;
  const a = schema.wholesaleLeadActivities;
  const [suppressions, consents, markers, confirms, settings] = await Promise.all([
    values.size ? db.select({ kind: s.kind, value: s.value }).from(s).where(inArray(s.value, [...values])) : Promise.resolve([] as SuppressionRecord[]),
    consentRowsFor(ids),
    db
      .select({ leadId: a.leadId, outcome: a.outcome, meta: a.meta, createdAt: a.createdAt })
      .from(a)
      .where(and(inArray(a.leadId, ids), eq(a.kind, "ZALO"), inArray(a.outcome, [...ZALO_MARKER_OUTCOMES]))),
    db
      .select({ leadId: a.leadId, outcome: a.outcome, meta: a.meta, createdAt: a.createdAt })
      .from(a)
      .where(and(inArray(a.leadId, ids), eq(a.kind, "EDIT"), eq(a.outcome, COUNTRY_CONFIRM_OUTCOME))),
    getEmailSettings(),
  ]);
  const consentsBy = new Map<string, ConsentRecord[]>();
  for (const c of consents) consentsBy.set(c.leadId, [...(consentsBy.get(c.leadId) ?? []), c]);
  const markersBy = new Map<string, typeof markers>();
  for (const m of markers) markersBy.set(m.leadId, [...(markersBy.get(m.leadId) ?? []), m]);
  const confirmsBy = new Map<string, typeof confirms>();
  for (const c of confirms) confirmsBy.set(c.leadId, [...(confirmsBy.get(c.leadId) ?? []), c]);
  for (const { lead, snap } of keys) {
    const country = leadCountryOf(countryInputOf(lead, snap, countryConfirmationOf(confirmsBy.get(lead.id) ?? [])));
    out.set(lead.id, planFrom(lead, snap, country, consentsBy.get(lead.id) ?? [], suppressions, zaloMarkerOf(markersBy.get(lead.id) ?? []), settings.allowedCountries));
  }
  return out;
}

/** Dữ kiện có thật của lead cho thang nước — CHỈ chỗ này gom, mọi nơi hỏi nước đều đi qua đây. */
export function countryInputOf(lead: Lead, snap: Snap | null, confirmedCountry: string | null): LeadCountryInput {
  const live = snap && !snap.purgedAt ? snap : null;
  return {
    confirmedCountry,
    provinceKey: lead.provinceKey,
    phoneCountryCode: lead.phoneCountryCode,
    phones: [lead.normalizedPhone, lead.phoneRaw, live?.internationalPhone ?? null],
    websiteDomain: lead.websiteDomain ?? live?.websiteDomain ?? null,
    email: lead.email,
  };
}

/** Nước của MỘT lead (cổng nước của hộp thư đi, ngôn ngữ của AI soạn email) — cùng thang, cùng dữ kiện với kế hoạch kênh. */
export async function leadCountryForLead(lead: Lead, snap?: Snap | null): Promise<LeadCountry> {
  const db = await getDb();
  const s = snap !== undefined ? snap : lead.placeId ? ((await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) })) ?? null) : null;
  const a = schema.wholesaleLeadActivities;
  const rows = await db
    .select({ outcome: a.outcome, meta: a.meta, createdAt: a.createdAt })
    .from(a)
    .where(and(eq(a.leadId, lead.id), eq(a.kind, "EDIT"), eq(a.outcome, COUNTRY_CONFIRM_OUTCOME)))
    .orderBy(desc(a.createdAt))
    .limit(5);
  return leadCountryOf(countryInputOf(lead, s, countryConfirmationOf(rows)));
}

function planFrom(lead: Lead, snap: Snap | null, country: LeadCountry, consents: readonly ConsentRecord[], suppressions: readonly SuppressionRecord[], marker: ZaloMarker | null, allowedCountries: readonly string[]): ContactPlan {
  const v = leadView(lead, snap);
  return contactPlanOf({ lead: { ...contactabilityLeadOf(lead, snap), phoneKind: v.phoneKind, zaloStatus: lead.zaloStatus }, country, consents, suppressions, zaloMarker: marker, allowedCountries });
}

/** Đồng ý của nhiều lead. CSDL chưa áp 0261 ⇒ rỗng (kết luận rơi về phía hẹp: máy không tự gửi). */
async function consentRowsFor(ids: readonly string[]): Promise<(ConsentRecord & { leadId: string })[]> {
  const db = await getDb();
  const c = schema.wholesaleContactConsents;
  try {
    return await db.select({ leadId: c.leadId, channel: c.channel, contactValue: c.contactValue, basis: c.basis, revokedAt: c.revokedAt }).from(c).where(inArray(c.leadId, [...ids]));
  } catch (e) {
    if (isMissingTable(e)) return [];
    throw e;
  }
}

/** Kế hoạch kênh của MỘT lead (lõi soạn email dùng để chặn đường email cho lead trong nước còn nhắn Zalo được). */
export async function contactPlanForLead(leadId: string): Promise<ContactPlan | null> {
  return (await contactPlansFor([leadId])).get(leadId) ?? null;
}

/**
 * MỌI đường tạo thư email (soạn từ lời chào · AI soạn nháp · đưa nháp AI vào hộp thư đi) hỏi câu này: lead có đang ở làn email
 * không. Khách trong nước còn nhắn Zalo được ⇒ câu từ chối; ở làn email ⇒ `null`. Luật nằm ở máy chủ, không chỉ ở nút.
 */
export async function emailLaneRefusal(leadId: string): Promise<string | null> {
  const plan = await contactPlanForLead(leadId);
  if (!plan || EMAIL_TRACKS.includes(plan.track)) return null;
  return `Lead đang ở làn «${CONTACT_TRACK_LABEL[plan.track]}» — ${plan.notes[0] ?? "chưa đi kênh email"}`;
}

async function gateLead(user: SessionUser, leadId: string): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  return lead ? { lead } : { error: "Không tìm thấy lead." };
}

async function currentMarker(leadId: string): Promise<ZaloMarker | null> {
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const rows = await db
    .select({ outcome: a.outcome, meta: a.meta, createdAt: a.createdAt })
    .from(a)
    .where(and(eq(a.leadId, leadId), eq(a.kind, "ZALO"), inArray(a.outcome, [...ZALO_MARKER_OUTCOMES])))
    .orderBy(desc(a.createdAt))
    .limit(5);
  return zaloMarkerOf(rows);
}

const markSchema = z.object({
  reason: z.enum(ZALO_UNDELIVERABLE_REASONS, { message: "Chọn lý do Zalo không gửi được." }),
  note: z.string().trim().max(500).default(""),
});

/**
 * «Zalo không gửi được» — nhân viên đã thử và Zalo KHÔNG ĐI (không có tài khoản · chặn tin người lạ · số sai). Khách chưa trả
 * lời KHÔNG phải lý do: danh sách lý do đóng, không có giá trị nào cho «im lặng». Lý do «không có tài khoản» đặt luôn
 * `zalo_status = NOT_FOUND` (cùng một sự thật với nút «Không có Zalo» sẵn có).
 */
export async function markZaloUndeliverableCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = markSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const { reason, note } = parsed.data;
  const before = await currentMarker(leadId);
  if (before?.reason === reason) return { ok: true };
  const db = await getDb();
  if (reason === "NO_ACCOUNT" && g.lead.zaloStatus !== "NOT_FOUND") await db.update(schema.wholesaleLeads).set({ zaloStatus: "NOT_FOUND", zaloCheckedAt: now, updatedAt: now }).where(eq(schema.wholesaleLeads.id, leadId));
  await db.insert(schema.wholesaleLeadActivities).values({
    leadId,
    kind: "ZALO",
    channel: "ZALO",
    outcome: ZALO_MARK_OUTCOME,
    note: `Zalo không gửi được: ${ZALO_UNDELIVERABLE_LABEL[reason]}${note ? ` — ${note}` : ""}`.slice(0, 2000),
    meta: { reason },
    actorId: user.id,
    actorName: user.name,
    createdAt: now,
  });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_ZALO_UNDELIVERABLE", entity: "WHOLESALE_LEAD", entityId: leadId, before: { marker: before?.reason ?? null, zaloStatus: g.lead.zaloStatus }, after: { marker: reason }, reason: note || ZALO_UNDELIVERABLE_LABEL[reason] });
  return { ok: true };
}

const undoSchema = z.object({ note: z.string().trim().max(500).default("") });

/** Hoàn tác: THÊM một dòng, không xoá dòng đánh dấu. Không trả `zalo_status` về — «không có tài khoản» sửa bằng nút Zalo sẵn có. */
export async function undoZaloUndeliverableCore(user: SessionUser, leadId: string, raw: unknown = {}, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = undoSchema.safeParse(raw ?? {});
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await currentMarker(leadId);
  if (!before) return { error: "Lead không có dấu «Zalo không gửi được» nào đang hiệu lực." };
  const db = await getDb();
  await db.insert(schema.wholesaleLeadActivities).values({
    leadId,
    kind: "ZALO",
    channel: "ZALO",
    outcome: ZALO_UNMARK_OUTCOME,
    note: `Hoàn tác «Zalo không gửi được» (${ZALO_UNDELIVERABLE_LABEL[before.reason]})${parsed.data.note ? ` — ${parsed.data.note}` : ""}`.slice(0, 2000),
    meta: { undoes: before.reason },
    actorId: user.id,
    actorName: user.name,
    createdAt: now,
  });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_ZALO_UNDELIVERABLE_UNDO", entity: "WHOLESALE_LEAD", entityId: leadId, before: { marker: before.reason }, after: { marker: null }, reason: parsed.data.note || "Hoàn tác «Zalo không gửi được»" });
  return { ok: true };
}

const confirmSchema = z.object({
  country: z.string().trim().toUpperCase().refine(isKnownCountry, "Chọn nước trong danh sách."),
  note: z.string().trim().max(500).default(""),
});

/**
 * NGƯỜI xác nhận nước của lead — chứng cứ mạnh nhất của thang (`leadCountryOf`). Ghi THÊM một dòng `EDIT` / `COUNTRY_CONFIRMED`
 * (dòng mới nhất thắng; xác nhận lại là một dòng mới, không sửa / xoá dòng cũ). `wholesale:work` + phạm vi dữ liệu + audit.
 */
export async function confirmLeadCountryCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ country: string }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = confirmSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { country, note } = parsed.data;
  const before = await leadCountryForLead(g.lead);
  if (before.source === "CONFIRMED" && before.country === country) return { ok: true, country };
  const db = await getDb();
  await db.insert(schema.wholesaleLeadActivities).values({
    leadId,
    kind: "EDIT",
    outcome: COUNTRY_CONFIRM_OUTCOME,
    note: `Xác nhận nước: ${COUNTRY_LABEL[country]} (${country})${note ? ` — ${note}` : ""}`.slice(0, 2000),
    meta: { country, before: before.country, beforeSource: before.source },
    actorId: user.id,
    actorName: user.name,
    createdAt: now,
  });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_COUNTRY", entity: "WHOLESALE_LEAD", entityId: leadId, before: { country: before.country, source: before.source }, after: { country, source: "CONFIRMED" }, reason: note || "Xác nhận nước của lead" });
  return { ok: true, country };
}
