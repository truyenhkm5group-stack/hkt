import { and, asc, count, eq, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { resolveEmailProvider } from "@/lib/email-provider";
import { buildOutgoingEmail, emailContentHash } from "@/lib/email-provider/message";
import { EmailSendError, type EmailProvider } from "@/lib/email-provider/types";
import { currentOrganization } from "@/lib/platform/context";
import { organizationBaseUrl } from "@/lib/platform/org-links";
import type { SyncTrigger } from "@/lib/sync/runner";
import { runSyncJob } from "@/lib/sync/runner";
import { setSettingJson } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { leadContactability } from "@/lib/wholesale/consents";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import {
  EMAIL_BATCH_PER_TICK,
  EMAIL_CANCELLABLE,
  EMAIL_HARD_LIMITS,
  EMAIL_HOLD_RETRY_MS,
  EMAIL_MAX_ATTEMPTS,
  EMAIL_MODES,
  EMAIL_STOP_EVENTS,
  emailBackoffMs,
  emailDomain,
  emailIdempotencyKey,
  LIVE_EMAIL_ADAPTERS,
  WHOLESALE_EMAIL_SETTING_KEY,
  type EmailBlockReason,
  type EmailSettings,
} from "@/lib/wholesale/email-constants";
import { evaluateEmailSend, type EmailPolicyDecision, type EmailPolicyInput } from "@/lib/wholesale/email-policy";
import { CONTACT_TRACK_LABEL, EMAIL_TRACKS, recipientCountryOf } from "@/lib/wholesale/contact-plan";
import { contactPlanForLead } from "@/lib/wholesale/contact-plan-store";
import { getEmailSettings, isMissingEmailTable, leadEmailEventKinds, recordEmailEvent } from "@/lib/wholesale/email-outbox-store";
import { issueUnsubscribeToken, unsubscribeUrl } from "@/lib/wholesale/email-unsubscribe";
import { leadView } from "@/lib/wholesale/engine";
import { prepareOutreachCore } from "@/lib/wholesale/outreach";
import { getLeadHunterConfig, suppressionHit } from "@/lib/wholesale/store";

/**
 * ═══════════ HỘP THƯ ĐI BÁN SỈ — LÕI GHI + VÒNG GỬI (CHỈ MÁY CHỦ, E1) ═══════════
 *
 * Luồng: lời chào kênh EMAIL ở hàng đợi liên hệ (mẫu / AI đã chặn câu bịa) → «Đưa vào hộp thư đi» = thư DRAFT → NGƯỜI duyệt
 * (khoá tài khoản + băm nội dung) → xếp gửi (QUEUED) → job `wholesale-leads` gọi `runEmailOutboxTick` → cổng chính sách
 * (`evaluateEmailSend`) NGAY TRƯỚC khi gọi nhà cung cấp → nhà cung cấp (hôm nay chỉ CHẠY THỬ) → SENT / FAILED / BLOCKED.
 *
 *  · AI KHÔNG BAO GIỜ gọi gửi: không hàm nào trong tệp này nhận chữ AI rồi gửi thẳng; mọi thư phải có một lượt duyệt người.
 *  · Không gửi trùng: (1) khoá chống trùng UNIQUE ở CSDL; (2) job đổi QUEUED → SENDING bằng MỘT câu UPDATE có điều kiện trước
 *    khi gọi nhà cung cấp — hai lượt song song chỉ một lượt thắng; (3) tiến trình chết giữa chừng ⇒ thư nằm lại SENDING chờ
 *    người kiểm, KHÔNG tự gửi lại.
 *  · Chạy thử KHÔNG chạm trạng thái liên hệ của lead (không «Đã liên hệ», không đếm lượt liên hệ) — thư chưa từng ra ngoài.
 */

const FORBIDDEN_WORK = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";
const FORBIDDEN_CONFIG = "Chỉ người cấu hình (wholesale:config) làm được việc này.";
const NOT_MIGRATED = "CSDL của tổ chức chưa áp migration 0264 (hộp thư đi email) — báo người vận hành.";

type Row = typeof schema.wholesaleEmailOutbox.$inferSelect;
type Lead = typeof schema.wholesaleLeads.$inferSelect;

async function guard<T>(fn: () => Promise<CoreResult<T & object>>): Promise<CoreResult<T & object>> {
  try {
    return await fn();
  } catch (e) {
    if (isMissingEmailTable(e)) return { error: NOT_MIGRATED };
    throw e;
  }
}

async function leadInScope(user: SessionUser, leadId: string): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN_WORK };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  return lead ? { lead } : { error: "Không tìm thấy lead." };
}

async function emailInScope(user: SessionUser, id: string): Promise<{ row: Row; lead: Lead } | { error: string }> {
  const db = await getDb();
  const row = await db.query.wholesaleEmailOutbox.findFirst({ where: eq(schema.wholesaleEmailOutbox.id, id) });
  if (!row) return { error: "Không tìm thấy thư." };
  const g = await leadInScope(user, row.leadId);
  return "error" in g ? g : { row, lead: g.lead };
}

// ─────────────────────────── CẤU HÌNH + NÚT DỪNG ───────────────────────────

const settingsInputSchema = z.object({
  mode: z.enum(EMAIL_MODES),
  sender: z.object({
    name: z.string().trim().max(120).default(""),
    email: z.string().trim().max(254).default(""),
    companyName: z.string().trim().max(200).default(""),
    address: z.string().trim().max(300).default(""),
  }),
  limits: z.object({
    perHour: z.coerce.number().int().min(1).max(EMAIL_HARD_LIMITS.perHour),
    perDay: z.coerce.number().int().min(1).max(EMAIL_HARD_LIMITS.perDay),
    perRecipientDomainPerDay: z.coerce.number().int().min(1).max(EMAIL_HARD_LIMITS.perRecipientDomainPerDay),
  }),
});

/**
 * Lưu chế độ + danh tính người gửi + hạn mức. `wholesale:config`. LIVE: chỉ chủ shop (vai trò quản trị), và bị TỪ CHỐI khi chưa
 * có bộ chuyển nhà cung cấp thật nào (`LIVE_EMAIL_ADAPTERS` rỗng) — không lưu một chế độ mà máy không làm được.
 */
export async function saveEmailSettingsCore(user: SessionUser, raw: unknown, now = new Date(), liveAdapters: readonly string[] = LIVE_EMAIL_ADAPTERS): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: FORBIDDEN_CONFIG };
  const parsed = settingsInputSchema.safeParse(raw);
  if (!parsed.success) {
    const i = parsed.error.issues[0];
    return { error: i ? `${i.path.join(".")}: ${i.message}` : "Cấu hình không hợp lệ" };
  }
  const d = parsed.data;
  const before = await getEmailSettings();
  if (d.mode === "LIVE") {
    if (user.role !== "ADMIN") return { error: "Chỉ chủ shop (quản trị) bật được chế độ GỬI THẬT." };
    if (!liveAdapters.length) return { error: "Chưa có nhà cung cấp email nào được kết nối (SES / Resend / Gmail) — chưa bật được GỬI THẬT. Dùng «Chạy thử» trong lúc chờ chủ shop chọn nhà cung cấp và tên miền." };
  }
  const next: EmailSettings = {
    ...before,
    mode: d.mode,
    sender: d.sender,
    limits: d.limits,
    liveEnabledByUserId: d.mode === "LIVE" ? (before.mode === "LIVE" ? before.liveEnabledByUserId : user.id) : null,
    liveEnabledAt: d.mode === "LIVE" ? (before.mode === "LIVE" ? before.liveEnabledAt : now.toISOString()) : null,
  };
  await setSettingJson(WHOLESALE_EMAIL_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_CONFIG", entity: "SETTINGS", entityId: WHOLESALE_EMAIL_SETTING_KEY, before: { mode: before.mode, limits: before.limits }, after: { mode: next.mode, limits: next.limits }, reason: "Sửa cấu hình email bán sỉ" });
  return { ok: true };
}

const pauseSchema = z.object({
  scope: z.enum(["ORG", "CAMPAIGN", "DOMAIN"]),
  target: z.string().trim().max(253).default(""),
  paused: z.boolean(),
  reason: z.string().trim().max(300).default(""),
});

/**
 * Nút dừng KHẨN (tổ chức · chiến dịch · tên miền nhận). DỪNG dễ, MỞ khó: ai chăm lead (`wholesale:work`) cũng bấm dừng được —
 * thấy sai thì phải chặn được ngay; chỉ người cấu hình (`wholesale:config`) mới mở lại.
 */
export async function setEmailPauseCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  const parsed = pauseSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const d = parsed.data;
  if (d.paused ? !can(user, "wholesale:work") : !can(user, "wholesale:config")) return { error: d.paused ? FORBIDDEN_WORK : "Chỉ người cấu hình (wholesale:config) mở lại được nút dừng." };
  const before = await getEmailSettings();
  const next: EmailSettings = { ...before };
  if (d.scope === "ORG") {
    next.paused = d.paused;
    next.pausedReason = d.paused ? d.reason || "Dừng khẩn cấp" : "";
  } else if (d.scope === "CAMPAIGN") {
    if (!d.target) return { error: "Chọn chiến dịch." };
    const db = await getDb();
    const camp = await db.query.wholesaleCampaigns.findFirst({ where: eq(schema.wholesaleCampaigns.id, d.target) });
    if (!camp) return { error: "Không tìm thấy chiến dịch." };
    next.pausedCampaignIds = d.paused ? [...new Set([...before.pausedCampaignIds, d.target])] : before.pausedCampaignIds.filter((x) => x !== d.target);
  } else {
    const domain = d.target.toLowerCase().replace(/^@/, "");
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return { error: "Tên miền không hợp lệ (vd nhahang.vn)." };
    next.blockedDomains = d.paused ? [...new Set([...before.blockedDomains, domain])] : before.blockedDomains.filter((x) => x !== domain);
  }
  await setSettingJson(WHOLESALE_EMAIL_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: d.paused ? "WHOLESALE_EMAIL_PAUSE" : "WHOLESALE_EMAIL_RESUME", entity: "SETTINGS", entityId: WHOLESALE_EMAIL_SETTING_KEY, after: { scope: d.scope, target: d.target || null }, reason: d.reason || (d.paused ? "Dừng gửi email" : "Mở lại gửi email") });
  return { ok: true };
}

// ─────────────────────────── SOẠN · DUYỆT · HUỶ ───────────────────────────

function defaultSubject(productLine: string, shopName: string): string {
  return `Bảng giá sỉ ${productLine || "hải sản"} — ${shopName || "bên em"}`.slice(0, 200);
}

const fromOutreachSchema = z.object({ subject: z.string().trim().max(200).default("") });

/**
 * Lời chào kênh EMAIL ở hàng đợi liên hệ ⇒ thư DRAFT trong hộp thư đi (dùng lại đúng chữ đã soạn: mẫu, hoặc AI đã qua bộ chặn câu
 * bịa `openerLooksInvented`). Lời chào gốc chuyển «Đã huỷ» kèm lịch sử — một lời chào không đi hai đường (gửi tay + gửi máy).
 */
export async function emailDraftFromOutreachCore(user: SessionUser, outreachId: string, raw: unknown = {}, now = new Date()): Promise<CoreResult<{ id: string }>> {
  return guard(async () => {
    const db = await getDb();
    const item = await db.query.wholesaleOutreachItems.findFirst({ where: eq(schema.wholesaleOutreachItems.id, outreachId) });
    if (!item) return { error: "Không tìm thấy lời chào." };
    const g = await leadInScope(user, item.leadId);
    if ("error" in g) return g;
    if (item.channel !== "EMAIL") return { error: "Chỉ lời chào kênh Email mới đưa được vào hộp thư đi." };
    if (item.status !== "DRAFT" && item.status !== "APPROVED") return { error: "Lời chào này đã gửi tay hoặc đã huỷ." };
    if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
    const to = normalizeEmail(g.lead.email);
    if (!to) return { error: "Lead chưa có email hợp lệ." };
    // Kế hoạch kênh (chủ shop 30/10): khách trong nước còn nhắn Zalo được thì KHÔNG đi email — email là dự phòng khi Zalo hỏng.
    const plan = await contactPlanForLead(g.lead.id);
    if (plan && !EMAIL_TRACKS.includes(plan.track)) return { error: `Lead đang ở làn «${CONTACT_TRACK_LABEL[plan.track]}» — ${plan.notes[0] ?? "chưa đi kênh email"}` };
    const parsed = fromOutreachSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const cfg = await getLeadHunterConfig();
    const subject = parsed.data.subject || defaultSubject(cfg.outreach.productLine, cfg.outreach.shopName);
    const [row] = await db
      .insert(schema.wholesaleEmailOutbox)
      .values({
        leadId: g.lead.id,
        campaignId: g.lead.sourceCampaignId,
        sourceOutreachId: item.id,
        toEmail: to,
        recipientDomain: emailDomain(to),
        subject,
        bodyText: item.message,
        templateKey: "OPENER_D0",
        sequenceStep: 0,
        status: "DRAFT",
        idempotencyKey: emailIdempotencyKey(g.lead.id, "OPENER_D0", 0, to),
        preparedBy: item.preparedBy === "AI" ? "AI" : "USER",
        aiModel: item.preparedBy === "AI" ? item.aiModel : null,
        createdByUserId: user.id,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: schema.wholesaleEmailOutbox.id });
    if (!row) return { error: "Lead đã có thư «Lời chào mở đầu» tới địa chỉ này (đang mở hoặc đã gửi thật) — mở Hộp thư đi." };
    await db
      .update(schema.wholesaleOutreachItems)
      .set({ status: "CANCELLED", resultNote: "Chuyển sang Hộp thư đi (email qua cổng chính sách)", updatedAt: now })
      .where(and(eq(schema.wholesaleOutreachItems.id, item.id), inArray(schema.wholesaleOutreachItems.status, ["DRAFT", "APPROVED"])));
    await db.insert(schema.wholesaleLeadActivities).values({ leadId: g.lead.id, kind: "OUTREACH", channel: "EMAIL", note: `Đưa lời chào vào Hộp thư đi (thư nháp tới ${to}) — chờ người duyệt`, actorId: user.id, actorName: user.name, createdAt: now });
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_DRAFT", entity: "WHOLESALE_LEAD", entityId: g.lead.id, after: { outboxId: row.id, to, preparedBy: item.preparedBy }, reason: "Soạn thư email bán sỉ" });
    return { ok: true, id: row.id };
  });
}

/** Soạn thư cho MỘT lead: đi qua đúng đường soạn lời chào kênh EMAIL (mẫu / AI + chặn câu bịa), rồi đưa vào hộp thư đi. */
export async function emailDraftForLeadCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ id: string; note: string | null }>> {
  const useAi = z.object({ useAi: z.boolean().default(false) }).safeParse(raw ?? {});
  const prep = await prepareOutreachCore(user, leadId, { channel: "EMAIL", useAi: useAi.success ? useAi.data.useAi : false }, now);
  let outreachId: string | null = "error" in prep ? null : prep.id;
  if (!outreachId) {
    // Đã có một lời chào EMAIL đang mở ⇒ dùng lại nó (chỉ mục duy nhất ở CSDL: một lead một kênh một mục mở).
    const db = await getDb();
    const open = await db.query.wholesaleOutreachItems.findFirst({ where: and(eq(schema.wholesaleOutreachItems.leadId, leadId), eq(schema.wholesaleOutreachItems.channel, "EMAIL"), inArray(schema.wholesaleOutreachItems.status, ["DRAFT", "APPROVED"])) });
    if (!open) return { error: "error" in prep ? prep.error : "Không soạn được lời chào." };
    outreachId = open.id;
  }
  const r = await emailDraftFromOutreachCore(user, outreachId, {}, now);
  return "error" in r ? r : { ok: true, id: r.id, note: "error" in prep ? null : prep.note };
}

const editSchema = z.object({ subject: z.string().trim().min(3, "Tiêu đề quá ngắn").max(200), body: z.string().trim().min(5, "Nội dung quá ngắn").max(5000) });

/** Sửa thư chưa xếp gửi. Thư đã duyệt bị sửa ⇒ về «Chờ duyệt» và mất lượt duyệt (duyệt gắn với nội dung). */
export async function editEmailDraftCore(user: SessionUser, id: string, raw: unknown, now = new Date()): Promise<CoreResult> {
  return guard(async () => {
    const g = await emailInScope(user, id);
    if ("error" in g) return g;
    if (g.row.status !== "DRAFT" && g.row.status !== "APPROVED") return { error: "Chỉ sửa được thư chưa xếp gửi." };
    const parsed = editSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const changed = parsed.data.subject !== g.row.subject || parsed.data.body !== g.row.bodyText;
    if (!changed) return { ok: true };
    await db
      .update(o)
      .set({ subject: parsed.data.subject, bodyText: parsed.data.body, preparedBy: "USER", status: "DRAFT", approvedByUserId: null, approvedAt: null, approvedHash: null, updatedAt: now })
      .where(and(eq(o.id, id), inArray(o.status, ["DRAFT", "APPROVED"])));
    return { ok: true };
  });
}

const approveSchema = z.object({ queue: z.boolean().default(true), scheduledAt: z.coerce.date().nullable().default(null) });

/**
 * Duyệt MỘT thư (giai đoạn thí điểm: duyệt từng thư). Ghi khoá tài khoản người duyệt + băm nội dung; `queue = true` ⇒ xếp gửi
 * luôn. Trả `warnings` = lý do cổng chính sách SẼ chặn (đồng ý, chặn, nút dừng…) để người duyệt biết trước — không chặn việc duyệt.
 */
export async function approveEmailCore(user: SessionUser, id: string, raw: unknown = {}, now = new Date()): Promise<CoreResult<{ warnings: string[] }>> {
  return guard(async () => {
    const g = await emailInScope(user, id);
    if ("error" in g) return g;
    if (g.row.status !== "DRAFT") return { error: "Chỉ duyệt được thư đang chờ duyệt." };
    const parsed = approveSchema.safeParse(raw ?? {});
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const hash = emailContentHash(g.row.toEmail, g.row.subject, g.row.bodyText);
    const queued = parsed.data.queue;
    const moved = await db
      .update(o)
      .set({ status: queued ? "QUEUED" : "APPROVED", approvedByUserId: user.id, approvedAt: now, approvedHash: hash, approvalUsedAt: null, scheduledAt: parsed.data.scheduledAt, nextAttemptAt: queued ? (parsed.data.scheduledAt ?? now) : null, updatedAt: now })
      .where(and(eq(o.id, id), eq(o.status, "DRAFT")))
      .returning({ id: o.id });
    if (!moved.length) return { error: "Thư vừa được người khác cập nhật." };
    if (queued) await recordEmailEvent({ leadId: g.row.leadId, outboxId: id, kind: "QUEUED", actorUserId: user.id, at: now });
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_APPROVE", entity: "WHOLESALE_LEAD", entityId: g.row.leadId, after: { outboxId: id, queued, hash: hash.slice(0, 12) }, reason: "Duyệt thư email bán sỉ" });
    const preview = await previewEmailPolicy({ ...g.row, status: "QUEUED", approvedByUserId: user.id, approvedAt: now, approvedHash: hash, approvalUsedAt: null }, now);
    return { ok: true, warnings: preview.details };
  });
}

/** Duyệt HÀNG LOẠT — chỉ `wholesale:config` (thí điểm: duyệt từng thư là mặc định của người chăm lead). */
export async function bulkApproveEmailCore(user: SessionUser, ids: string[], raw: unknown = {}, now = new Date()): Promise<CoreResult<{ approved: number; skipped: number }>> {
  if (!can(user, "wholesale:config")) return { error: FORBIDDEN_CONFIG };
  const list = z.array(z.string().min(1).max(64)).min(1).max(100).safeParse(ids);
  if (!list.success) return { error: "Chọn từ 1 tới 100 thư." };
  let approved = 0;
  let skipped = 0;
  for (const id of list.data) {
    const r = await approveEmailCore(user, id, raw, now);
    if ("error" in r) skipped++;
    else approved++;
  }
  return { ok: true, approved, skipped };
}

/** Xếp gửi một thư đã duyệt. */
export async function queueEmailCore(user: SessionUser, id: string, now = new Date()): Promise<CoreResult> {
  return guard(async () => {
    const g = await emailInScope(user, id);
    if ("error" in g) return g;
    if (g.row.status !== "APPROVED") return { error: "Chỉ xếp gửi được thư đã duyệt." };
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const moved = await db
      .update(o)
      .set({ status: "QUEUED", nextAttemptAt: g.row.scheduledAt ?? now, updatedAt: now })
      .where(and(eq(o.id, id), eq(o.status, "APPROVED")))
      .returning({ id: o.id });
    if (!moved.length) return { error: "Thư vừa được người khác cập nhật." };
    await recordEmailEvent({ leadId: g.row.leadId, outboxId: id, kind: "QUEUED", actorUserId: user.id, at: now });
    return { ok: true };
  });
}

export async function cancelEmailCore(user: SessionUser, id: string, now = new Date()): Promise<CoreResult> {
  return guard(async () => {
    const g = await emailInScope(user, id);
    if ("error" in g) return g;
    if (!EMAIL_CANCELLABLE.includes(g.row.status as (typeof EMAIL_CANCELLABLE)[number])) return { error: "Chỉ huỷ được thư chưa gửi." };
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const moved = await db
      .update(o)
      .set({ status: "CANCELLED", cancelledByUserId: user.id, cancelledAt: now, updatedAt: now })
      .where(and(eq(o.id, id), inArray(o.status, [...EMAIL_CANCELLABLE])))
      .returning({ id: o.id });
    if (!moved.length) return { error: "Thư vừa được người khác cập nhật (có thể đã vào lượt gửi)." };
    return { ok: true };
  });
}

/** Mở lại thư bị CHẶN / LỖI ⇒ về «Chờ duyệt», MẤT lượt duyệt cũ (một lượt duyệt chỉ cho một lần gửi). */
export async function reopenEmailCore(user: SessionUser, id: string, now = new Date()): Promise<CoreResult> {
  return guard(async () => {
    const g = await emailInScope(user, id);
    if ("error" in g) return g;
    if (g.row.status !== "BLOCKED" && g.row.status !== "FAILED") return { error: "Chỉ mở lại được thư bị chặn hoặc gửi lỗi." };
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    try {
      await db
        .update(o)
        .set({ status: "DRAFT", blockedReason: null, lastError: null, attempts: 0, nextAttemptAt: null, approvedByUserId: null, approvedAt: null, approvedHash: null, approvalUsedAt: null, mode: null, updatedAt: now })
        .where(and(eq(o.id, id), inArray(o.status, ["BLOCKED", "FAILED"])));
    } catch (e) {
      if ((e as { code?: string; cause?: { code?: string } })?.code === "23505" || (e as { cause?: { code?: string } })?.cause?.code === "23505") return { error: "Đã có thư khác cùng khoá (lead · mẫu · bước · email) đang mở hoặc đã gửi — không mở lại được." };
      throw e;
    }
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_REOPEN", entity: "WHOLESALE_LEAD", entityId: g.row.leadId, before: { status: g.row.status, blockedReason: g.row.blockedReason }, after: { outboxId: id, status: "DRAFT" }, reason: "Mở lại thư email bán sỉ" });
    return { ok: true };
  });
}

// ─────────────────────────── CỔNG: GOM DỮ KIỆN ───────────────────────────

function prospectiveMode(s: EmailSettings): "DRY_RUN" | "LIVE" {
  return s.mode === "LIVE" ? "LIVE" : "DRY_RUN";
}

/** Gom dữ kiện từ CSDL cho cổng chính sách — mọi thứ hàm thuần cần, đọc NGAY lúc hỏi. */
export async function emailPolicyInputFor(row: Row, settings: EmailSettings, now: Date): Promise<EmailPolicyInput> {
  const db = await getDb();
  const o = schema.wholesaleEmailOutbox;
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, row.leadId) });
  if (!lead) throw new Error(`Thư ${row.id} trỏ tới lead không còn.`);
  const snap = lead.placeId ? ((await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) })) ?? null) : null;
  const view = leadView(lead, snap);
  const mode = prospectiveMode(settings);
  const dayStart = vnStartOfDay(vnDateKey(now));
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const [ct, hit, kinds, [dup], [counts]] = await Promise.all([
    leadContactability(lead, snap, "AUTOMATED"),
    suppressionHit({ placeId: lead.placeId, phone: view.phone, domain: lead.websiteDomain ?? snap?.websiteDomain ?? null, email: lead.email }),
    leadEmailEventKinds(lead.id),
    db
      .select({ n: count() })
      .from(o)
      .where(and(eq(o.idempotencyKey, row.idempotencyKey), ne(o.id, row.id), or(and(eq(o.status, "SENT"), eq(o.mode, mode)), eq(o.status, "SENDING")))),
    db
      .select({
        hour: sql<string>`count(*) filter (where ${o.sentAt} >= ${hourAgo})`,
        today: sql<string>`count(*) filter (where ${o.sentAt} >= ${dayStart})`,
        domain: sql<string>`count(*) filter (where ${o.sentAt} >= ${dayStart} and ${o.recipientDomain} = ${row.recipientDomain ?? ""})`,
      })
      .from(o)
      .where(and(eq(o.status, "SENT"), eq(o.mode, mode), gte(o.sentAt, dayStart < hourAgo ? dayStart : hourAgo))),
  ]);
  return {
    settings,
    message: {
      status: row.status,
      toEmail: row.toEmail,
      recipientDomain: row.recipientDomain,
      campaignId: row.campaignId,
      approvedByUserId: row.approvedByUserId,
      approvedAt: row.approvedAt,
      approvedHash: row.approvedHash,
      contentHash: emailContentHash(row.toEmail, row.subject, row.bodyText),
      approvalUsedAt: row.approvalUsedAt,
    },
    leadEmail: normalizeEmail(lead.email),
    leadContactStatus: lead.contactStatus,
    contactability: ct.byChannel.EMAIL,
    suppressionHit: hit,
    leadEventKinds: kinds,
    recipientCountry: recipientCountryOf(lead.provinceKey),
    duplicateSent: Number(dup?.n ?? 0) > 0,
    counts: { lastHour: Number(counts?.hour ?? 0), today: Number(counts?.today ?? 0), domainToday: Number(counts?.domain ?? 0) },
  };
}

const PREVIEW_IGNORED: readonly EmailBlockReason[] = ["BAD_STATUS", "NOT_APPROVED", "APPROVAL_STALE"];

/**
 * Xem trước cổng cho màn hình: «nếu xếp gửi lúc này thì bị chặn vì đâu». Bỏ qua lý do thuộc về chính bước duyệt (chưa duyệt /
 * đang chờ duyệt lại) — đó là việc người xem đang làm, không phải chỗ vướng.
 */
export async function previewEmailPolicy(row: Row, now = new Date(), settings?: EmailSettings): Promise<EmailPolicyDecision> {
  const s = settings ?? (await getEmailSettings());
  const d = evaluateEmailSend(await emailPolicyInputFor({ ...row, status: "QUEUED" }, s, now));
  const reasons = d.reasons.filter((r) => !PREVIEW_IGNORED.includes(r));
  const details = d.details.filter((_, i) => !PREVIEW_IGNORED.includes(d.reasons[i]!));
  return { ...d, reasons, details, allowed: reasons.length === 0 };
}

/** Xem trước cổng cho nhiều thư đang mở (trang Hộp thư đi). Trần 40 thư một lượt — mỗi thư vài câu đọc. */
export async function previewEmailPolicies(ids: readonly string[], now = new Date()): Promise<Record<string, string[]>> {
  if (!ids.length) return {};
  const db = await getDb();
  const o = schema.wholesaleEmailOutbox;
  const rows = await db.select().from(o).where(inArray(o.id, ids.slice(0, 40)));
  const settings = await getEmailSettings();
  const out: Record<string, string[]> = {};
  for (const r of rows) {
    const d = await previewEmailPolicy(r, now, settings);
    out[r.id] = [...d.details, ...d.warnings];
  }
  return out;
}

// ─────────────────────────── VÒNG GỬI ───────────────────────────

export type EmailTickResult = { mode: string; considered: number; sent: number; held: number; blocked: number; failed: number; retried: number; skipped?: string };

/** Có thư nào tới hạn không — câu hỏi rẻ, trước khi mở khoá / ghi sổ. Bảng chưa có (chưa áp 0264) ⇒ `false`, không làm hỏng job. */
export async function emailOutboxHasWork(now = new Date()): Promise<boolean> {
  try {
    const s = await getEmailSettings();
    if (s.mode === "OFF") return false;
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const [r] = await db
      .select({ n: count() })
      .from(o)
      .where(and(eq(o.status, "QUEUED"), or(isNull(o.nextAttemptAt), lte(o.nextAttemptAt, now))));
    return Number(r?.n ?? 0) > 0;
  } catch (e) {
    if (isMissingEmailTable(e)) return false;
    throw e;
  }
}

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 500);
}

/**
 * MỘT lượt xử lý hàng đợi: lấy thư QUEUED tới hạn ⇒ cổng ⇒ nhà cung cấp ⇒ cập nhật. Tuần tự (hạn mức đếm lại sau mỗi thư).
 * `provider` chỉ để bài kiểm tiêm nhà cung cấp giả có lỗi; mặc định chọn theo chế độ (LIVE chưa có ⇒ `null`).
 */
export async function runEmailOutboxTick(opts: { now?: Date; provider?: EmailProvider | null; limit?: number } = {}): Promise<EmailTickResult> {
  const now = opts.now ?? new Date();
  const settings = await getEmailSettings();
  const out: EmailTickResult = { mode: settings.mode, considered: 0, sent: 0, held: 0, blocked: 0, failed: 0, retried: 0 };
  if (settings.mode === "OFF") return { ...out, skipped: "MODE_OFF" };
  const provider = opts.provider === undefined ? resolveEmailProvider(settings.mode) : opts.provider;
  if (provider && provider.mode !== prospectiveMode(settings)) throw new Error(`Nhà cung cấp ${provider.name} (${provider.mode}) không khớp chế độ ${settings.mode}.`);
  const db = await getDb();
  const o = schema.wholesaleEmailOutbox;
  const due = await db
    .select()
    .from(o)
    .where(and(eq(o.status, "QUEUED"), or(isNull(o.nextAttemptAt), lte(o.nextAttemptAt, now))))
    .orderBy(asc(sql`coalesce(${o.nextAttemptAt}, ${o.createdAt})`), asc(o.createdAt))
    .limit(Math.max(1, Math.min(opts.limit ?? EMAIL_BATCH_PER_TICK, 200)));
  if (!due.length) return out;
  const org = await currentOrganization();
  const baseUrl = await organizationBaseUrl(org.code).catch(() => env.appUrl);

  for (const row of due) {
    out.considered++;
    const input = await emailPolicyInputFor(row, settings, now);
    const decision = evaluateEmailSend(input);
    if (!decision.allowed || !provider) {
      if (decision.allowed || decision.hold) {
        await db
          .update(o)
          .set({ nextAttemptAt: new Date(now.getTime() + EMAIL_HOLD_RETRY_MS), lastError: (decision.details.join(" · ") || "Chưa có nhà cung cấp cho chế độ này").slice(0, 500), updatedAt: now })
          .where(and(eq(o.id, row.id), eq(o.status, "QUEUED")));
        out.held++;
        continue;
      }
      const reason = decision.details.join(" · ").slice(0, 1000);
      const moved = await db
        .update(o)
        .set({ status: "BLOCKED", blockedReason: reason, approvalUsedAt: now, updatedAt: now })
        .where(and(eq(o.id, row.id), eq(o.status, "QUEUED")))
        .returning({ id: o.id });
      if (moved.length) {
        await recordEmailEvent({ leadId: row.leadId, outboxId: row.id, kind: "BLOCKED", meta: { reasons: decision.reasons }, at: now });
        await db.insert(schema.wholesaleLeadActivities).values({ leadId: row.leadId, kind: "OUTREACH", channel: "EMAIL", note: `Thư email bị cổng chính sách chặn: ${reason}`.slice(0, 2000), actorId: null, actorName: "Máy (hộp thư đi)", createdAt: now });
        out.blocked++;
      }
      continue;
    }

    // ── Giữ chỗ: QUEUED → SENDING bằng MỘT câu có điều kiện. Thua ⇒ lượt khác đã nhận thư này. ──
    const [claimed] = await db
      .update(o)
      .set({ status: "SENDING", provider: provider.name, attempts: sql`${o.attempts} + 1`, updatedAt: now })
      .where(and(eq(o.id, row.id), eq(o.status, "QUEUED")))
      .returning({ attempts: o.attempts });
    if (!claimed) continue;

    const threadId = row.threadId ?? row.id;
    const prior = row.sequenceStep > 0 ? await db.select({ mid: o.messageIdHeader }).from(o).where(and(eq(o.leadId, row.leadId), eq(o.threadId, threadId), eq(o.status, "SENT"), ne(o.id, row.id))).orderBy(asc(o.sentAt)) : [];
    const priorIds = prior.map((p) => p.mid).filter((x): x is string => !!x);
    try {
      const token = await issueUnsubscribeToken(org.code, { leadId: row.leadId, email: row.toEmail, outboxId: row.id }, now);
      const msg = buildOutgoingEmail({ outboxId: row.id, sender: settings.sender, to: row.toEmail, subject: row.subject, body: row.bodyText, unsubscribeUrl: unsubscribeUrl(baseUrl, token), idempotencyKey: row.idempotencyKey, threadMessageIds: priorIds });
      const res = await provider.send(msg);
      await db
        .update(o)
        .set({ status: "SENT", mode: provider.mode, sentAt: now, approvalUsedAt: now, providerMessageId: res.providerMessageId, messageIdHeader: res.messageIdHeader || msg.headers["Message-ID"], threadId, inReplyTo: msg.headers["In-Reply-To"] ?? null, lastError: null, nextAttemptAt: null, updatedAt: now })
        .where(and(eq(o.id, row.id), eq(o.status, "SENDING")));
      await recordEmailEvent({ leadId: row.leadId, outboxId: row.id, kind: "SENT", meta: { mode: provider.mode, provider: provider.name, providerMessageId: res.providerMessageId, ...(decision.warnings.length ? { warnings: decision.warnings } : {}) }, at: now });
      await afterSent(row, provider.mode, now);
      out.sent++;
    } catch (e) {
      const transient = !(e instanceof EmailSendError) || e.transient;
      const attempts = Number(claimed.attempts);
      if (transient && attempts < EMAIL_MAX_ATTEMPTS) {
        await db
          .update(o)
          .set({ status: "QUEUED", nextAttemptAt: new Date(now.getTime() + emailBackoffMs(attempts)), lastError: `Lần ${attempts}: ${errText(e)}`, updatedAt: now })
          .where(and(eq(o.id, row.id), eq(o.status, "SENDING")));
        out.retried++;
      } else {
        await db
          .update(o)
          .set({ status: "FAILED", approvalUsedAt: now, lastError: `${transient ? `Hết ${EMAIL_MAX_ATTEMPTS} lần thử` : "Nhà cung cấp từ chối"}: ${errText(e)}`, updatedAt: now })
          .where(and(eq(o.id, row.id), eq(o.status, "SENDING")));
        await recordEmailEvent({ leadId: row.leadId, outboxId: row.id, kind: "FAILED", meta: { error: errText(e), transient, attempts }, at: now });
        out.failed++;
      }
    }
  }
  return out;
}

/** Sau khi gửi: lịch sử lead (mọi chế độ). Chỉ GỬI THẬT mới đổi trạng thái liên hệ — thư chạy thử chưa từng ra ngoài. */
async function afterSent(row: Row, mode: "DRY_RUN" | "LIVE", now: Date): Promise<void> {
  const db = await getDb();
  const l = schema.wholesaleLeads;
  await db.insert(schema.wholesaleLeadActivities).values({
    leadId: row.leadId,
    kind: "OUTREACH",
    channel: "EMAIL",
    note: mode === "LIVE" ? `Đã gửi email tới ${row.toEmail}: ${row.subject}` : `CHẠY THỬ — thư «${row.subject}» tới ${row.toEmail} đi hết đường ống, KHÔNG ra ngoài`,
    actorId: null,
    actorName: "Máy (hộp thư đi)",
    createdAt: now,
  });
  if (mode !== "LIVE") return;
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(l.id, row.leadId) });
  if (!lead) return;
  const early: readonly string[] = ["NEW", "QUALIFIED", "READY_TO_CONTACT"];
  await db
    .update(l)
    .set({ contactStatus: early.includes(lead.contactStatus) ? "CONTACTED" : lead.contactStatus, firstContactAt: lead.firstContactAt ?? now, lastContactAt: now, contactAttemptCount: sql`${l.contactAttemptCount} + 1`, updatedAt: now })
    .where(eq(l.id, row.leadId));
}

export type EmailJobOutcome = { skipped: "IDLE" | "RUNNING"; detail: string } | (EmailTickResult & { detail: string });

/** Vỏ job: khoá theo tổ chức + `wholesale-email` (lượt lịch và nút «Chạy thử gửi» không chồng nhau), ghi `sync_runs`. */
export async function runEmailOutboxJob(o: { trigger: SyncTrigger; actor: string }, opts: { now?: Date; provider?: EmailProvider | null } = {}): Promise<EmailJobOutcome> {
  if (!(await emailOutboxHasWork(opts.now))) return { skipped: "IDLE", detail: "Không có thư nào tới hạn gửi (hoặc email đang TẮT)." };
  const r = await runSyncJob({ source: "ERP", job: "wholesale-email", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const tick = await runEmailOutboxTick(opts);
    const detail = `Email (${tick.mode}): ${tick.sent} đã gửi · ${tick.held} giữ lại · ${tick.blocked} bị chặn · ${tick.retried} hẹn thử lại · ${tick.failed} lỗi`;
    ctx.summary.imported = tick.sent;
    ctx.summary.skipped = tick.held + tick.blocked;
    ctx.summary.failed = tick.failed;
    ctx.summary.detail = detail;
    return { ...tick, detail };
  });
  if (r.skippedBecauseRunning) return { skipped: "RUNNING", detail: "Lượt gửi trước của tổ chức này còn đang chạy." };
  return r.result ?? { skipped: "IDLE", detail: "Lượt không trả kết quả." };
}

/** Lý do một lead đã dừng nhận thư tự động (để màn hình nói ra), rỗng = chưa dừng. */
export function stopKindsOf(kinds: readonly string[]): string[] {
  return EMAIL_STOP_EVENTS.filter((k) => kinds.includes(k));
}
