import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { normalizeProvince } from "@/lib/constants/vn-regions";
import { createCustomerAsAgent } from "@/lib/records/customer-create";
import { searchProvince } from "@/lib/wholesale/areas";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { ACTIVE_PIPELINE_STATUSES, ANSWERED_CALL_OUTCOMES, CALL_OUTCOMES, callOutcomeEffect, CONTACTED_STATUSES, isLeadStatus, LEAD_STATUSES, LEAD_STATUS_LABEL, RESPONDED_STATUSES, type LeadStatus, canTransitionLead, ZALO_RESULTS, zaloResultEffect, type ZaloStatus } from "@/lib/wholesale/constants";
import { zaloMessage, zaloPhoneLink } from "@/lib/wholesale/opener";
import { nameAddressKey, socialKind, websiteDomain } from "@/lib/wholesale/dedupe";
import { finalizeLead, findMasterLead, leadView, rescoreLead } from "@/lib/wholesale/engine";
import { verifiedCallPatch } from "@/lib/wholesale/field-handoff";
import { formatVnPhone, normalizeVnPhone } from "@/lib/wholesale/phone";
import { manualImportProvider } from "@/lib/wholesale/providers";
import { classifySegment, isLeadSegmentKey } from "@/lib/wholesale/segments";
import { getLeadHunterConfig, segmentOutcomeStats, suppressionHit } from "@/lib/wholesale/store";

/**
 * ═══════════ LEAD KHÁCH SỈ — LÕI GHI (CHỈ MÁY CHỦ) ═══════════
 *
 * Mọi thao tác trên MỘT lead hỏi lại phạm vi dữ liệu của người bấm (`rowInScope`, cùng mệnh đề với danh sách): nhân viên
 * phạm vi «Được giao» gõ id lead của người khác vào nút cũng không ghi được. Người làm là KHOÁ TÀI KHOẢN (luật 34); tên
 * chỉ là ảnh chụp để đọc, đọc từ phiên máy chủ.
 *
 * Dữ liệu CRM do nhân viên sửa (`staff_edited_fields`) không bao giờ bị máy ghi đè.
 */

const FORBIDDEN_WORK = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";

/**
 * Link do NGƯỜI nhập (form, tệp) ⇒ chỉ nhận http / https (thiếu giao thức thì thêm https://). Chặn `javascript:` / `data:`
 * vì ô này được in thành thẻ `<a href>` trên trang lead.
 */
export function safeWebUrl(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (!v) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname.includes(".") ? u.toString() : null;
  } catch {
    return null;
  }
}

type Lead = typeof schema.wholesaleLeads.$inferSelect;

async function gateLead(user: SessionUser, leadId: string, permission: "wholesale:work" | "wholesale:assign" = "wholesale:work"): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, permission)) return { error: permission === "wholesale:work" ? FORBIDDEN_WORK : "Bạn không có quyền giao lead (wholesale:assign)." };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn (không phải lead được giao cho bạn)." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  if (!lead) return { error: "Không tìm thấy lead." };
  return { lead };
}

async function activity(user: SessionUser | null, row: Omit<typeof schema.wholesaleLeadActivities.$inferInsert, "actorId" | "actorName">) {
  const db = await getDb();
  await db.insert(schema.wholesaleLeadActivities).values({ ...row, note: (row.note ?? "").slice(0, 2000), actorId: user?.id ?? null, actorName: user?.name ?? "Máy" });
}

/** Mốc thời gian đi kèm một lượt đổi trạng thái — chỉ ĐIỀN lần đầu, không ghi đè mốc đã có. */
function statusStamps(lead: Lead, to: LeadStatus, now: Date): Partial<typeof schema.wholesaleLeads.$inferInsert> {
  const patch: Partial<typeof schema.wholesaleLeads.$inferInsert> = {};
  if (to === "QUALIFIED" && !lead.qualifiedAt) patch.qualifiedAt = now;
  if (CONTACTED_STATUSES.includes(to) && !lead.firstContactAt) patch.firstContactAt = now;
  if (RESPONDED_STATUSES.includes(to) && !lead.firstResponseAt) patch.firstResponseAt = now;
  if (to === "WON") patch.wonAt = lead.wonAt ?? now;
  if (to === "LOST") patch.lostAt = now;
  return patch;
}

/** Danh sách KHÔNG LIÊN HỆ: chặn theo Place ID, SĐT, tên miền của lead — cả nguồn Google lẫn dữ liệu của tổ chức. */
export async function suppressLead(user: SessionUser, lead: Lead, reason: string, now: Date): Promise<void> {
  const db = await getDb();
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const v = leadView(lead, snap);
  const keys: { kind: string; value: string }[] = [];
  if (lead.placeId) keys.push({ kind: "PLACE", value: lead.placeId });
  if (v.phone) keys.push({ kind: "PHONE", value: v.phone });
  const domain = lead.websiteDomain ?? websiteDomain(v.website);
  if (domain) keys.push({ kind: "DOMAIN", value: domain });
  for (const k of keys) {
    await db.insert(schema.wholesaleSuppressions).values({ ...k, reason: reason.slice(0, 300), leadId: lead.id, createdByUserId: user.id, createdByName: user.name, createdAt: now }).onConflictDoNothing();
  }
  await db
    .update(schema.wholesaleOutreachItems)
    .set({ status: "CANCELLED", updatedAt: now })
    .where(and(eq(schema.wholesaleOutreachItems.leadId, lead.id), inArray(schema.wholesaleOutreachItems.status, ["DRAFT", "APPROVED"])));
}

const statusSchema = z.object({
  status: z.enum(LEAD_STATUSES),
  note: z.string().trim().max(2000).default(""),
  lostReason: z.string().trim().max(500).default(""),
  nextFollowupAt: z.coerce.date().nullable().default(null),
});

export async function updateLeadStatusCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ status: LeadStatus }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { status: to, note, lostReason, nextFollowupAt } = parsed.data;
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  if (!canTransitionLead(from, to)) return { error: from === "DO_NOT_CONTACT" ? "Lead đã ở danh sách KHÔNG LIÊN HỆ — người cấu hình gỡ khỏi danh sách trước." : "Lead đã ở trạng thái này." };
  if (from === "WON" && g.lead.customerId) return { error: "Lead đã chuyển thành khách hàng — không đổi trạng thái lùi được." };
  if (to === "LOST" && lostReason.length < 3) return { error: "Cần lý do mất lead (ít nhất 3 ký tự)." };
  if (to === "DO_NOT_CONTACT" && note.length < 3) return { error: "Cần ghi lý do khách từ chối liên hệ (ít nhất 3 ký tự)." };
  const db = await getDb();
  const l = schema.wholesaleLeads;
  const moved = await db
    .update(l)
    .set({ contactStatus: to, ...statusStamps(g.lead, to, now), lostReason: to === "LOST" ? lostReason : g.lead.lostReason, nextFollowupAt: to === "DO_NOT_CONTACT" || to === "LOST" ? null : (nextFollowupAt ?? g.lead.nextFollowupAt), updatedAt: now })
    .where(and(eq(l.id, leadId), eq(l.contactStatus, from)))
    .returning({ id: l.id });
  if (!moved.length) return { error: "Trạng thái lead vừa đổi bởi người khác — tải lại trang." };
  if (to === "DO_NOT_CONTACT") await suppressLead(user, g.lead, note, now);
  await activity(user, { leadId, kind: "STATUS", fromStatus: from, toStatus: to, note: to === "LOST" ? `${lostReason}${note ? ` — ${note}` : ""}` : note });
  await audit({ userId: user.id, userEmail: user.email, action: to === "DO_NOT_CONTACT" ? "WHOLESALE_LEAD_DNC" : "WHOLESALE_LEAD_STATUS", entity: "WHOLESALE_LEAD", entityId: leadId, before: { status: from }, after: { status: to }, reason: note || lostReason || `Đổi trạng thái → ${LEAD_STATUS_LABEL[to]}` });
  if (to === "WON" || to === "LOST" || to === "DO_NOT_CONTACT") {
    // Kết cục mới ⇒ thống kê «học từ kết quả» đổi — chấm lại chính lead này (các lead khác chấm lại ở lượt job).
    const cfg = await getLeadHunterConfig();
    await rescoreLead(leadId, { cfg, stats: await segmentOutcomeStats(), now });
  }
  return { ok: true, status: to };
}

const noteSchema = z.object({
  note: z.string().trim().min(1, "Ghi chú trống").max(2000),
  nextFollowupAt: z.coerce.date().nullable().default(null),
  nextAction: z.string().trim().max(300).default(""),
});

export async function addLeadNoteCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = noteSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  await db
    .update(schema.wholesaleLeads)
    .set({ nextFollowupAt: parsed.data.nextFollowupAt ?? g.lead.nextFollowupAt, nextAction: parsed.data.nextAction || g.lead.nextAction, updatedAt: now })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "NOTE", note: parsed.data.note, meta: parsed.data.nextAction ? { nextAction: parsed.data.nextAction } : null });
  return { ok: true };
}

const callSchema = z.object({
  outcome: z.enum(CALL_OUTCOMES),
  note: z.string().trim().max(2000).default(""),
  nextFollowupAt: z.coerce.date().nullable().default(null),
  /** Người gọi tích «khách xác nhận đúng địa chỉ» ⇒ địa chỉ trên bản đồ thành địa chỉ của shop (xem `verifiedCallPatch`). */
  addressConfirmed: z.boolean().default(false),
  /** Kênh của cuộc trao đổi: gọi điện, hoặc khách trả lời qua Zalo — cùng chín kết quả, cùng luật trạng thái. */
  channel: z.enum(["PHONE_CALL", "ZALO"]).default("PHONE_CALL"),
});

/** Mốc 9 giờ sáng (giờ VN) của ngày cách `now` đúng `days` ngày — hẹn gọi lại mặc định. */
export function followupAt(now: Date, days: number): Date {
  const vn = new Date(now.getTime() + 7 * 3_600_000);
  return new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() + days, 2, 0, 0));
}

/**
 * Lượt BẤM «GỌI NGAY» (màn điện thoại): chỉ ghi sự kiện `CALL_INITIATED` — lead · người bấm · số đã mở · mốc. KHÔNG đổi
 * trạng thái, KHÔNG tăng số lần liên hệ: bấm gọi chỉ mở ứng dụng gọi của máy, chưa chứng minh có ai nghe.
 */
export async function logCallInitiatedCore(user: SessionUser, leadId: string, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const db = await getDb();
  const snap = g.lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, g.lead.placeId) }) : null;
  const phone = leadView(g.lead, snap).phone;
  await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "CALL_INITIATED", channel: "PHONE_CALL", note: "", meta: { phone }, actorId: user.id, actorName: user.name, createdAt: now });
  return { ok: true };
}

/**
 * Ghi một cuộc gọi (đã gọi thật — nút «Gọi» chỉ mở ứng dụng điện thoại). Người gọi chọn KẾT QUẢ; trạng thái lead, lý do mất,
 * việc tiếp theo và hẹn gọi lại suy ra bằng `callOutcomeEffect` (một luật cho màn máy tính lẫn màn điện thoại).
 */
export async function logCallCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ status: LeadStatus; nextFollowupAt: string | null }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = callSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { outcome, note, nextFollowupAt, addressConfirmed, channel } = parsed.data;
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  if (from === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ — không ghi cuộc gọi mới." };
  if (outcome === "DO_NOT_CONTACT") {
    const r = await updateLeadStatusCore(user, leadId, { status: "DO_NOT_CONTACT", note: note || "Khách yêu cầu không liên hệ (qua điện thoại)" }, now);
    if ("error" in r) return r;
    await activity(user, { leadId, kind: "CALL", channel, outcome, note });
    return { ok: true, status: r.status, nextFollowupAt: null };
  }
  const effect = callOutcomeEffect(from, outcome);
  // Đã thành khách (WON) ⇒ cuộc gọi chỉ là lịch sử, không đổi trạng thái; đã mất (LOST) mà nay có nhu cầu ⇒ mở lại được.
  const to: LeadStatus = from === "WON" ? from : from === "LOST" && effect.to !== "INTERESTED" ? from : from === "LOST" ? "INTERESTED" : effect.to;
  const answered = ANSWERED_CALL_OUTCOMES.includes(outcome);
  const followup = to === "LOST" ? null : (nextFollowupAt ?? (effect.followupRequired && effect.followupDays != null ? followupAt(now, effect.followupDays) : g.lead.nextFollowupAt));
  const db = await getDb();
  const snap = g.lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, g.lead.placeId) }) : null;
  const verified = verifiedCallPatch(g.lead, snap && !snap.purgedAt ? snap : null, outcome, addressConfirmed);
  const verifiedPhone = verified.normalizedPhone ? normalizeVnPhone(verified.normalizedPhone) : null;
  await db
    .update(schema.wholesaleLeads)
    .set({
      ...(verified.businessName ? { businessName: verified.businessName } : {}),
      ...(verified.address ? { address: verified.address } : {}),
      ...(verified.businessName || verified.address ? { nameKey: nameAddressKey(verified.businessName ?? g.lead.businessName, verified.address ?? g.lead.address) } : {}),
      ...(verifiedPhone?.normalized ? { phoneRaw: formatVnPhone(verifiedPhone.normalized), normalizedPhone: verifiedPhone.normalized, phoneKind: verifiedPhone.kind, phoneCountryCode: verifiedPhone.countryCode, phoneSource: "VERIFIED_CALL" } : {}),
      contactStatus: to,
      ...statusStamps(g.lead, to, now),
      firstContactAt: g.lead.firstContactAt ?? now,
      firstResponseAt: answered ? (g.lead.firstResponseAt ?? now) : g.lead.firstResponseAt,
      lastContactAt: now,
      contactAttemptCount: sql`${schema.wholesaleLeads.contactAttemptCount} + 1`,
      nextFollowupAt: followup,
      nextAction: to === "LOST" ? null : (effect.nextAction ?? g.lead.nextAction),
      lostReason: to === "LOST" && from !== "LOST" ? `${effect.lostReason ?? "Kết thúc qua cuộc gọi"}${note ? ` — ${note.slice(0, 300)}` : ""}` : g.lead.lostReason,
      response: answered && note ? note.slice(0, 500) : g.lead.response,
      updatedAt: now,
    })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "CALL", channel, outcome, fromStatus: from, toStatus: to !== from ? to : null, note, meta: Object.keys(verified).length ? { verified: Object.keys(verified) } : null });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_CONTACT", entity: "WHOLESALE_LEAD", entityId: leadId, before: { status: from }, after: { status: to, outcome, verified: Object.keys(verified) }, reason: "Ghi cuộc gọi" });
  return { ok: true, status: to, nextFollowupAt: followup ? followup.toISOString() : null };
}

/** Bản nháp tin Zalo cho MỘT lead: lời chào đã cá nhân hoá + link mở Zalo theo SĐT (chỉ số di động) + số ảnh kèm. */
export type ZaloDraft = { text: string; link: string | null; phoneDisplay: string | null; reason: string | null; images: number; zaloStatus: ZaloStatus | null };

export async function zaloDraftCore(user: SessionUser, leadId: string): Promise<CoreResult<{ draft: ZaloDraft }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const db = await getDb();
  const snap = g.lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, g.lead.placeId) }) : null;
  const v = leadView(g.lead, snap && !snap.purgedAt ? snap : null);
  const cfg = await getLeadHunterConfig();
  const segment = isLeadSegmentKey(g.lead.segment) ? g.lead.segment : "UNCLASSIFIED";
  const text = zaloMessage(cfg, { businessName: v.name ?? "anh/chị", segment, areaName: g.lead.areaName, provinceLabel: g.lead.provinceLabel }, user.name);
  const link = zaloPhoneLink(v.phone, v.phoneKind);
  const zaloStatus = g.lead.zaloStatus === "FOUND" || g.lead.zaloStatus === "NOT_FOUND" ? g.lead.zaloStatus : null;
  const reason =
    g.lead.contactStatus === "DO_NOT_CONTACT"
      ? "Khách ở danh sách KHÔNG LIÊN HỆ."
      : !v.phone
        ? "Chưa có SĐT."
        : !link
          ? "Số cố định / tổng đài — không có Zalo, gọi điện."
          : zaloStatus === "NOT_FOUND"
            ? "Đã thử: số này không có Zalo — gọi điện."
            : null;
  return { ok: true, draft: { text, link: reason ? null : link, phoneDisplay: v.phone ? formatVnPhone(v.phone) : null, reason, images: cfg.outreach.zaloImages.length, zaloStatus } };
}

/** Lượt BẤM «Nhắn Zalo»: chỉ ghi sự kiện (mở app Zalo chưa chứng minh đã gửi) — như `logCallInitiatedCore`. */
export async function logZaloOpenedCore(user: SessionUser, leadId: string, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const db = await getDb();
  await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "ZALO_OPENED", channel: "ZALO", note: "", actorId: user.id, actorName: user.name, createdAt: now });
  return { ok: true };
}

const zaloResultSchema = z.object({ result: z.enum(ZALO_RESULTS), note: z.string().trim().max(2000).default("") });

/**
 * Kết quả mở Zalo do NHÂN VIÊN chọn (ERP không tự tra được số có Zalo hay không). Trạng thái, hẹn gọi lại và việc tiếp theo
 * suy ra bằng `zaloResultEffect`; «Không có Zalo» được NHỚ (`zalo_status`) để không ai mở lại và lead lên hàng «Cần gọi».
 */
export async function logZaloResultCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ status: LeadStatus }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = zaloResultSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { result, note } = parsed.data;
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  if (from === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const effect = zaloResultEffect(from, result);
  const terminal = from === "WON" || from === "LOST";
  const db = await getDb();
  await db
    .update(schema.wholesaleLeads)
    .set({
      zaloStatus: effect.zaloStatus,
      zaloCheckedAt: now,
      contactStatus: effect.to,
      ...statusStamps(g.lead, effect.to, now),
      ...(effect.counted ? { firstContactAt: g.lead.firstContactAt ?? now, lastContactAt: now, contactAttemptCount: sql`${schema.wholesaleLeads.contactAttemptCount} + 1` } : {}),
      ...(terminal ? {} : { nextFollowupAt: effect.followupDays === 0 ? now : followupAt(now, effect.followupDays), nextAction: effect.nextAction }),
      updatedAt: now,
    })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "ZALO", channel: "ZALO", outcome: result, fromStatus: from, toStatus: effect.to !== from ? effect.to : null, note });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_CONTACT", entity: "WHOLESALE_LEAD", entityId: leadId, before: { status: from, zalo: g.lead.zaloStatus }, after: { status: effect.to, zalo: effect.zaloStatus, result }, reason: "Nhắn Zalo" });
  return { ok: true, status: effect.to };
}

const assignSchema = z.object({ leadIds: z.array(z.string().min(1).max(64)).min(1).max(500), userId: z.string().min(1).max(64).nullable() });

/** Giao / bỏ giao. Người nhận phải là tài khoản đang hoạt động của tổ chức. */
export async function assignLeadsCore(user: SessionUser, raw: unknown, now = new Date()): Promise<CoreResult<{ changed: number }>> {
  if (!can(user, "wholesale:assign")) return { error: "Bạn không có quyền giao lead (wholesale:assign)." };
  const parsed = assignSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  let assignee: { id: string; name: string } | null = null;
  if (parsed.data.userId) {
    const u = await db.query.users.findFirst({ where: eq(schema.users.id, parsed.data.userId), columns: { id: true, name: true, active: true } });
    if (!u || !u.active) return { error: "Người nhận không tồn tại hoặc đã bị khoá." };
    assignee = { id: u.id, name: u.name };
  }
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  let changed = 0;
  for (const leadId of parsed.data.leadIds) {
    if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) continue;
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId), columns: { id: true, assignedToUserId: true, assignedToName: true } });
    if (!lead || lead.assignedToUserId === (assignee?.id ?? null)) continue;
    await db
      .update(schema.wholesaleLeads)
      .set({ assignedToUserId: assignee?.id ?? null, assignedToName: assignee?.name ?? null, assignedAt: assignee ? now : null, updatedAt: now })
      .where(eq(schema.wholesaleLeads.id, leadId));
    await activity(user, { leadId, kind: "ASSIGN", note: assignee ? `Giao cho ${assignee.name}` : "Bỏ giao", meta: { from: lead.assignedToUserId, to: assignee?.id ?? null } });
    changed++;
  }
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_ASSIGN", entity: "WHOLESALE_LEAD", entityId: parsed.data.leadIds.slice(0, 5).join(","), after: { to: assignee?.id ?? null, count: changed }, reason: assignee ? `Giao ${changed} lead cho ${assignee.name}` : `Bỏ giao ${changed} lead` });
  return { ok: true, changed };
}

const addCampaignSchema = z.object({ leadIds: z.array(z.string().min(1).max(64)).min(1).max(500), campaignId: z.string().min(1).max(64) });

/** Thêm lead vào một chiến dịch (để lọc / theo dõi). Lead KHÔNG LIÊN HỆ không bao giờ được thêm vào chiến dịch khác. */
export async function addLeadsToCampaignCore(user: SessionUser, raw: unknown): Promise<CoreResult<{ added: number; blocked: number }>> {
  if (!can(user, "wholesale:assign")) return { error: "Bạn không có quyền (wholesale:assign)." };
  const parsed = addCampaignSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const camp = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, parsed.data.campaignId), columns: { id: true, isTemplate: true } });
  if (!camp || camp.isTemplate) return { error: "Không tìm thấy chiến dịch." };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  let added = 0;
  let blocked = 0;
  for (const leadId of parsed.data.leadIds) {
    if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) continue;
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId), columns: { id: true, contactStatus: true } });
    if (!lead) continue;
    if (lead.contactStatus === "DO_NOT_CONTACT") {
      blocked++;
      continue;
    }
    const r = await db.insert(schema.wholesaleLeadCampaigns).values({ leadId, campaignId: camp.id, addedByUserId: user.id }).onConflictDoNothing().returning({ leadId: schema.wholesaleLeadCampaigns.leadId });
    if (r.length) {
      added++;
      await activity(user, { leadId, kind: "CAMPAIGN", note: "Thêm vào chiến dịch", meta: { campaignId: camp.id } });
    }
  }
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_CAMPAIGN", entity: "WHOLESALE_CAMPAIGN", entityId: camp.id, after: { added, blocked }, reason: "Thêm lead vào chiến dịch" });
  return { ok: true, added, blocked };
}

/** «Đủ điều kiện» hàng loạt — chỉ đổi lead đang «Mới». */
export async function markQualifiedCore(user: SessionUser, leadIds: string[], now = new Date()): Promise<CoreResult<{ changed: number }>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN_WORK };
  const ids = z.array(z.string().min(1).max(64)).min(1).max(500).safeParse(leadIds);
  if (!ids.success) return { error: "Chọn ít nhất một lead." };
  let changed = 0;
  for (const id of ids.data) {
    const g = await gateLead(user, id);
    if ("error" in g || g.lead.contactStatus !== "NEW") continue;
    const r = await updateLeadStatusCore(user, id, { status: "QUALIFIED", note: "Đánh dấu đủ điều kiện (hàng loạt)" }, now);
    if (!("error" in r)) changed++;
  }
  return { ok: true, changed };
}

const opportunitySchema = z.object({
  value: z.coerce.number().int().min(0).max(100_000_000_000).nullable().default(null),
  note: z.string().trim().min(3, "Ghi rõ khách quan tâm gì (ít nhất 3 ký tự)").max(2000),
});

/** Tạo / cập nhật cơ hội bán sỉ: giá trị ước tính mỗi tháng (VND, số nguyên) + khách quan tâm gì. */
export async function saveOpportunityCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = opportunitySchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const db = await getDb();
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  const early: readonly LeadStatus[] = ["NEW", "QUALIFIED", "READY_TO_CONTACT", "CONTACTED", "NO_ANSWER"];
  const to: LeadStatus = early.includes(from) ? "INTERESTED" : from;
  await db
    .update(schema.wholesaleLeads)
    .set({ opportunityValue: parsed.data.value, opportunityNote: parsed.data.note, opportunityAt: g.lead.opportunityAt ?? now, contactStatus: to, ...statusStamps(g.lead, to, now), updatedAt: now })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "OPPORTUNITY", fromStatus: from, toStatus: to !== from ? to : null, note: parsed.data.note, meta: { value: parsed.data.value } });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_OPPORTUNITY", entity: "WHOLESALE_LEAD", entityId: leadId, before: { value: g.lead.opportunityValue }, after: { value: parsed.data.value, status: to }, reason: "Cơ hội bán sỉ" });
  return { ok: true };
}

const convertSchema = z.object({
  name: z.string().trim().max(200).default(""),
  phone: z.string().trim().max(30).default(""),
  address: z.string().trim().max(500).default(""),
});

/**
 * Chuyển lead thành KHÁCH HÀNG của ERP mà không nhập lại: tên / SĐT / địa chỉ lấy từ lead (sửa được trước khi bấm). Đi
 * qua ĐÚNG lõi tạo khách có sẵn (`createCustomerAsAgent`): khách cùng SĐT đã có ⇒ nối vào khách đó, không tạo bản thứ hai,
 * không ghi đè hồ sơ đang có. Đơn và doanh thu sau đó đọc theo `customer_id` của lead.
 */
export async function convertLeadCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ customerId: string; existing: boolean }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  if (g.lead.customerId) return { ok: true, customerId: g.lead.customerId, existing: true };
  if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
  const parsed = convertSchema.safeParse(raw ?? {});
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const db = await getDb();
  const snap = g.lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, g.lead.placeId) }) : null;
  const v = leadView(g.lead, snap);
  const name = parsed.data.name || v.name || "";
  const phoneIn = normalizeVnPhone(parsed.data.phone || v.phone);
  if (!phoneIn?.national) return { error: "Lead chưa có SĐT hợp lệ — nhập SĐT khách xác nhận rồi chuyển." };
  const address = parsed.data.address || v.address || "";
  // Khách đã có cùng SĐT (khác cách viết 0… / +84…) ⇒ nối vào khách đó.
  const last9 = phoneIn.national.slice(-9);
  const [existing] = await db
    .select({ id: schema.customers.id })
    .from(schema.customers)
    .where(sql`right(regexp_replace(coalesce(${schema.customers.phone}, ''), '[^0-9]', '', 'g'), 9) = ${last9}`)
    .limit(1);
  let customerId: string;
  let wasExisting = false;
  if (existing) {
    customerId = existing.id;
    wasExisting = true;
  } else {
    const r = await createCustomerAsAgent({ name: user.name, source: "wholesale-lead" }, { name, phone: phoneIn.national, address, province: g.lead.provinceLabel ?? "" }, { addressOptional: address.length === 0 });
    if (!r.ok) return { error: r.errors.map((e) => e.message).join(" ") || "Không tạo được khách hàng." };
    customerId = r.id;
    wasExisting = r.existing;
  }
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  await db
    .update(schema.wholesaleLeads)
    .set({
      customerId,
      convertedAt: now,
      contactStatus: "WON",
      wonAt: g.lead.wonAt ?? now,
      firstContactAt: g.lead.firstContactAt ?? now,
      firstResponseAt: g.lead.firstResponseAt ?? now,
      // Khách đã xác nhận SĐT khi thành khách ⇒ SĐT thành dữ liệu của tổ chức (không còn phụ thuộc hạn lưu của Google).
      phoneRaw: g.lead.phoneRaw ?? phoneIn.raw,
      normalizedPhone: phoneIn.normalized,
      phoneKind: phoneIn.kind,
      phoneCountryCode: phoneIn.countryCode,
      phoneSource: g.lead.phoneSource ?? "VERIFIED_CALL",
      businessName: g.lead.businessName ?? name,
      updatedAt: now,
    })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "CONVERT", fromStatus: from, toStatus: "WON", note: wasExisting ? "Nối vào khách hàng đã có cùng SĐT" : "Tạo khách hàng mới từ lead", meta: { customerId } });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_CONVERT", entity: "WHOLESALE_LEAD", entityId: leadId, before: { status: from }, after: { status: "WON", customerId, existing: wasExisting }, reason: "Chuyển lead thành khách hàng" });
  return { ok: true, customerId, existing: wasExisting };
}

const editSchema = z.object({
  businessName: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(500).optional(),
  website: z.string().trim().max(300).optional(),
  email: z.string().trim().max(200).optional(),
  facebookUrl: z.string().trim().max(300).optional(),
  zaloUrl: z.string().trim().max(300).optional(),
});

/** Nhân viên sửa thông tin — trường đã sửa vào `staff_edited_fields`, máy không ghi đè lại. Chuỗi rỗng = xoá giá trị tự khai. */
export async function editLeadCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ changed: string[] }>> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  const parsed = editSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  const patch: Partial<typeof schema.wholesaleLeads.$inferInsert> = {};
  const changed: string[] = [];
  const set = <K extends keyof typeof patch>(k: K, v: (typeof patch)[K], label: string) => {
    patch[k] = v;
    changed.push(label);
  };
  if (d.businessName !== undefined) set("businessName", d.businessName || null, "businessName");
  if (d.address !== undefined) set("address", d.address || null, "address");
  if (d.email !== undefined) {
    if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) return { error: "Email không hợp lệ." };
    set("email", d.email.toLowerCase() || null, "email");
  }
  if (d.website !== undefined) {
    const site = d.website ? safeWebUrl(d.website) : null;
    if (d.website && !site) return { error: "Website phải là địa chỉ http(s) hợp lệ, vd https://nhahang.vn" };
    set("website", site, "website");
    patch.websiteDomain = websiteDomain(site);
  }
  if (d.facebookUrl !== undefined) {
    if (d.facebookUrl && socialKind(d.facebookUrl) !== "FACEBOOK") return { error: "Link Facebook phải là facebook.com/…" };
    set("facebookUrl", d.facebookUrl || null, "facebookUrl");
  }
  if (d.zaloUrl !== undefined) {
    if (d.zaloUrl && socialKind(d.zaloUrl) !== "ZALO") return { error: "Link Zalo phải là zalo.me/…" };
    set("zaloUrl", d.zaloUrl || null, "zaloUrl");
  }
  if (d.phone !== undefined) {
    if (d.phone) {
      const p = normalizeVnPhone(d.phone);
      if (!p?.normalized) return { error: "SĐT không nhận ra được — nhập đủ số (vd 0912 345 678 hoặc 028 3823 4567)." };
      Object.assign(patch, { phoneRaw: d.phone, normalizedPhone: p.normalized, phoneKind: p.kind, phoneCountryCode: p.countryCode, phoneSource: "STAFF" });
    } else Object.assign(patch, { phoneRaw: null, normalizedPhone: null, phoneKind: null, phoneCountryCode: null, phoneSource: null });
    changed.push("phone");
  }
  if (!changed.length) return { ok: true, changed };
  if (patch.businessName !== undefined || patch.address !== undefined) patch.nameKey = nameAddressKey(patch.businessName ?? g.lead.businessName, patch.address ?? g.lead.address);
  const db = await getDb();
  const edited = [...new Set([...g.lead.staffEditedFields, ...changed])];
  await db
    .update(schema.wholesaleLeads)
    .set({ ...patch, staffEditedFields: edited, updatedAt: now })
    .where(eq(schema.wholesaleLeads.id, leadId));
  await activity(user, { leadId, kind: "EDIT", note: `Sửa: ${changed.join(", ")}` });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_EDIT", entity: "WHOLESALE_LEAD", entityId: leadId, after: { changed }, reason: "Sửa thông tin lead" });
  const cfg = await getLeadHunterConfig();
  await rescoreLead(leadId, { cfg, stats: await segmentOutcomeStats(), now });
  return { ok: true, changed };
}

/** Gỡ một mục khỏi danh sách không liên hệ — chỉ người cấu hình, có lý do. */
export async function removeSuppressionCore(user: SessionUser, id: string, reason: string): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) gỡ được danh sách không liên hệ." };
  if ((reason ?? "").trim().length < 5) return { error: "Cần lý do gỡ (ít nhất 5 ký tự) — vd «khách gọi lại xin báo giá»." };
  const db = await getDb();
  const [row] = await db.delete(schema.wholesaleSuppressions).where(eq(schema.wholesaleSuppressions.id, id)).returning();
  if (!row) return { error: "Không tìm thấy mục." };
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_SUPPRESSION_REMOVE", entity: "WHOLESALE_LEAD", entityId: row.leadId ?? row.id, before: { kind: row.kind, value: row.value, reason: row.reason }, reason: reason.trim() });
  return { ok: true };
}

export type ImportReport = { created: number; duplicates: number; suppressed: number; invalid: number; errors: string[] };

/**
 * Nhập lead từ tệp CSV (danh bạ tự có, hội chợ, đối tác giới thiệu). Dữ liệu tệp là của TỔ CHỨC ⇒ ghi thẳng vào lead.
 * Khử trùng SĐT / tên miền / tên + địa chỉ với lead đã có; trùng thì bỏ qua và đếm, không ghi đè lead đang chăm.
 */
export async function importLeadsCore(user: SessionUser, text: string, now = new Date()): Promise<CoreResult<{ report: ImportReport }>> {
  if (!can(user, "wholesale:scan")) return { error: "Bạn không có quyền nhập lead (wholesale:scan)." };
  if (typeof text !== "string" || !text.trim()) return { error: "Tệp trống." };
  if (text.length > 3_000_000) return { error: "Tệp quá lớn (tối đa ~3 MB)." };
  const parsed = manualImportProvider().parse(text);
  const report: ImportReport = { created: 0, duplicates: 0, suppressed: 0, invalid: 0, errors: [...parsed.errors] };
  if (!parsed.rows.length) return parsed.errors.length ? { error: parsed.errors[0]! } : { error: "Không có dòng nào để nhập." };
  const cfg = await getLeadHunterConfig();
  const stats = await segmentOutcomeStats();
  const db = await getDb();
  for (const row of parsed.rows) {
    const phone = row.phone ? normalizeVnPhone(row.phone) : null;
    if (row.phone && !phone?.normalized) report.errors.push(`Dòng ${row.line}: SĐT «${row.phone.slice(0, 20)}» không nhận ra được — nhập lead KHÔNG có SĐT.`);
    const domain = websiteDomain(row.website);
    const nameKey = nameAddressKey(row.name, row.address);
    if (await suppressionHit({ phone: phone?.normalized, domain })) {
      report.suppressed++;
      continue;
    }
    if (await findMasterLead(null, { phone: phone?.normalized ?? null, domain, nameKey })) {
      report.duplicates++;
      continue;
    }
    const seg = classifySegment({ name: `${row.name} ${row.category ?? ""}` });
    const provKey = row.province ? normalizeProvince(row.province) : null;
    const social = socialKind(row.website);
    const [lead] = await db
      .insert(schema.wholesaleLeads)
      .values({
        source: "MANUAL_IMPORT",
        businessName: row.name,
        address: row.address,
        phoneRaw: row.phone,
        normalizedPhone: phone?.normalized ?? null,
        phoneKind: phone?.normalized ? phone.kind : null,
        phoneCountryCode: phone?.countryCode ?? null,
        phoneSource: phone?.normalized ? "IMPORT" : null,
        website: social ? null : safeWebUrl(row.website),
        websiteDomain: domain,
        facebookUrl: social === "FACEBOOK" ? row.website : null,
        zaloUrl: social === "ZALO" ? row.website : null,
        email: row.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(row.email) ? row.email.toLowerCase() : null,
        nameKey,
        provinceKey: provKey,
        provinceLabel: provKey ? (searchProvince(provKey)?.label ?? row.province) : null,
        areaName: row.area,
        segment: seg.segment,
        segmentEvidence: seg.evidence,
        sourceQuery: "Nhập tệp",
        enrichmentStatus: "READY",
        firstSeenAt: now,
      })
      .returning({ id: schema.wholesaleLeads.id });
    await activity(user, { leadId: lead!.id, kind: "IMPORTED", note: row.note ? `Nhập từ tệp (dòng ${row.line}): ${row.note}` : `Nhập từ tệp (dòng ${row.line})` });
    await finalizeLead({ cfg, stats, now: () => now }, lead!.id, null);
    report.created++;
  }
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_IMPORT", entity: "WHOLESALE_LEAD", entityId: "import", after: { ...report, errors: report.errors.length }, reason: "Nhập lead từ tệp" });
  return { ok: true, report };
}

/** Đặt lại lead để lấy chi tiết Google ngay ở lượt job kế tiếp (nút «Làm mới dữ liệu Google»). */
export async function requestRefreshCore(user: SessionUser, leadId: string, now = new Date()): Promise<CoreResult> {
  const g = await gateLead(user, leadId);
  if ("error" in g) return g;
  if (!g.lead.placeId) return { error: "Lead không đến từ Google — không có gì để làm mới." };
  if (!(ACTIVE_PIPELINE_STATUSES as readonly string[]).includes(g.lead.contactStatus)) {
    return { error: "Chỉ lead đang chăm (từ «Đủ điều kiện» tới «Đang thương lượng») được làm mới — đổi trạng thái trước." };
  }
  const db = await getDb();
  // Đẩy hạn lưu về hiện tại: bước «làm mới lead đang chăm» của lượt job kế tiếp lấy lại chi tiết (tính tiền, chịu trần ngân sách).
  await db.update(schema.wholesalePlaceSnapshots).set({ expiresAt: now, updatedAt: now }).where(eq(schema.wholesalePlaceSnapshots.placeId, g.lead.placeId));
  return { ok: true };
}
