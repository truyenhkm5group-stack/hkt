import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { andScope, decideScope, rowInScope, type ScopeDecision } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import { emailDomain, emailIdempotencyKey } from "@/lib/wholesale/email-constants";
import { aiDraftEmailCore, buildDraftFacts, isMissingAiDraftTable, type AiDeps, type DraftResult } from "@/lib/wholesale/email-ai-draft";
import { draftLanguageForCountry, draftViolations } from "@/lib/wholesale/email-ai-draft-guard";
import { emailLaneRefusal, leadCountryForLead } from "@/lib/wholesale/contact-plan-store";
import { getEmailSettings, isMissingEmailTable } from "@/lib/wholesale/email-outbox-store";
import { EMAIL_SEQUENCE_LIMITS, EMAIL_SEQUENCE_SETTING_KEY, OPEN_OUTBOX_STATUSES, parseEmailSequenceSettings, renderSequenceTemplate, SEQUENCE_STOP_LABEL, sequenceState, type EmailSequenceSettings, type SequenceState } from "@/lib/wholesale/email-sequence";
import { getLeadHunterConfig, suppressionHit } from "@/lib/wholesale/store";

/**
 * ═══════════ CHUỖI THƯ THEO DÕI — ĐỌC + GHI (CHỈ MÁY CHỦ) — docs/tech/hslc-b2b-sales-agent.md · P4a ═══════════
 *
 * «Lần nhắc đến hạn» là PHÉP CHIẾU tính lúc đọc từ thư đã gửi + sự kiện thư + trạng thái lead (luật 19). Không có bảng việc thứ
 * hai, không có job tự soạn. Hiện ở MỘT chỗ: khối «Lần nhắc đến hạn» của Hộp thư đi (không chiếu thêm lên /work).
 *
 * Soạn một lần nhắc = NGƯỜI bấm, và chỉ khi lần nhắc ĐANG ĐẾN HẠN (kiểm lại ở máy chủ, không tin nút):
 *  · «AI soạn lần nhắc» ⇒ đúng đường AI-draft (`aiDraftEmailCore` + hàng rào bịa đặt), nháp vào khối «Nháp AI»;
 *  · «Dùng mẫu» ⇒ mẫu tĩnh shop khai, qua CÙNG hàng rào, rồi thành thư DRAFT (bước FOLLOWUP) ở hộp thư đi chờ duyệt.
 * Không đường nào tự gửi: thư nhắc vẫn qua lượt duyệt E1 và cổng chính sách như mọi thư khác.
 */

export async function getEmailSequenceSettings(): Promise<EmailSequenceSettings> {
  return parseEmailSequenceSettings(await getSettingJson<Record<string, unknown>>(EMAIL_SEQUENCE_SETTING_KEY, {}));
}

const settingsSchema = z
  .object({
    maxFollowups: z.number().int().min(1).max(EMAIL_SEQUENCE_LIMITS.maxFollowups).nullable().default(null),
    gapDays: z.number().int().min(1).max(EMAIL_SEQUENCE_LIMITS.maxGapDays).nullable().default(null),
    templates: z.object({ vi: z.string().max(EMAIL_SEQUENCE_LIMITS.templateMax).default(""), en: z.string().max(EMAIL_SEQUENCE_LIMITS.templateMax).default("") }).default({ vi: "", en: "" }),
    reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự).").max(1000),
  })
  .strict()
  .refine((v) => (v.maxFollowups === null) === (v.gapDays === null), { message: "Khai CẢ số lần nhắc lẫn số ngày chờ (hoặc để trống cả hai = tắt chuỗi).", path: ["gapDays"] });

/** Lưu N / K / mẫu — `wholesale:config`, lý do, audit. Để trống N và K = không có lần nhắc nào. */
export async function saveEmailSequenceSettingsCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) sửa được chuỗi thư nhắc." };
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await getEmailSequenceSettings();
  const next: EmailSequenceSettings = { maxFollowups: parsed.data.maxFollowups, gapDays: parsed.data.gapDays, templates: { vi: parsed.data.templates.vi.trim(), en: parsed.data.templates.en.trim() } };
  await setSettingJson(EMAIL_SEQUENCE_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_SEQUENCE_CONFIG", entity: "SETTINGS", entityId: EMAIL_SEQUENCE_SETTING_KEY, before: { maxFollowups: before.maxFollowups, gapDays: before.gapDays }, after: { maxFollowups: next.maxFollowups, gapDays: next.gapDays, templates: { vi: next.templates.vi.length, en: next.templates.en.length } }, reason: parsed.data.reason });
  return { ok: true };
}

type Lead = typeof schema.wholesaleLeads.$inferSelect;
type Mail = typeof schema.wholesaleEmailOutbox.$inferSelect;

/** Chế độ đang chạy quyết định thư «đã gửi» nào được tính: chạy thử chỉ đếm thư chạy thử, gửi thật chỉ đếm thư thật. */
function countedMode(mode: string): "DRY_RUN" | "LIVE" {
  return mode === "LIVE" ? "LIVE" : "DRY_RUN";
}

type LeadChain = { lead: Lead; sent: Mail[]; eventKinds: string[]; hasOpenMail: boolean };

async function chainsOf(leadIds: readonly string[], mode: "DRY_RUN" | "LIVE"): Promise<Map<string, LeadChain>> {
  const out = new Map<string, LeadChain>();
  if (!leadIds.length) return out;
  const db = await getDb();
  const o = schema.wholesaleEmailOutbox;
  const [leads, mails, events, aiOpen] = await Promise.all([
    db.select().from(schema.wholesaleLeads).where(inArray(schema.wholesaleLeads.id, [...leadIds])),
    db.select().from(o).where(inArray(o.leadId, [...leadIds])).orderBy(asc(o.createdAt)),
    db.select({ leadId: schema.wholesaleEmailEvents.leadId, kind: schema.wholesaleEmailEvents.kind }).from(schema.wholesaleEmailEvents).where(inArray(schema.wholesaleEmailEvents.leadId, [...leadIds])),
    // Nháp AI đang mở cũng là «thư đang mở». CSDL chưa áp 0265 ⇒ coi như không có nháp AI nào.
    (async () => {
      try {
        return await db
          .select({ leadId: schema.wholesaleEmailAiDrafts.leadId })
          .from(schema.wholesaleEmailAiDrafts)
          .where(and(inArray(schema.wholesaleEmailAiDrafts.leadId, [...leadIds]), eq(schema.wholesaleEmailAiDrafts.status, "DRAFT")));
      } catch (e) {
        if (isMissingAiDraftTable(e)) return [] as { leadId: string }[];
        throw e;
      }
    })(),
  ]);
  const openAi = new Set(aiOpen.map((r) => r.leadId));
  for (const lead of leads) {
    const own = mails.filter((m) => m.leadId === lead.id);
    out.set(lead.id, {
      lead,
      sent: own.filter((m) => m.status === "SENT" && m.mode === mode && m.sentAt),
      eventKinds: [...new Set(events.filter((e) => e.leadId === lead.id).map((e) => e.kind))],
      hasOpenMail: openAi.has(lead.id) || own.some((m) => (OPEN_OUTBOX_STATUSES as readonly string[]).includes(m.status)),
    });
  }
  return out;
}

async function stateOf(c: LeadChain, settings: EmailSequenceSettings, now: Date): Promise<SequenceState> {
  const suppressed = Boolean(await suppressionHit({ placeId: c.lead.placeId, phone: c.lead.normalizedPhone, domain: c.lead.websiteDomain, email: c.lead.email }));
  return sequenceState({ settings, hasEmail: Boolean(normalizeEmail(c.lead.email)), leadStatus: c.lead.contactStatus, suppressed, sent: c.sent.map((m) => ({ sequenceStep: m.sequenceStep, sentAt: m.sentAt as Date })), eventKinds: c.eventKinds, hasOpenMail: c.hasOpenMail }, now);
}

export type DueFollowup = { leadId: string; leadName: string; toEmail: string; nextStep: number; dueAt: string; lastSentAt: string; lastSubject: string; language: string };
export type SequenceBoard = { configured: boolean; settings: EmailSequenceSettings; due: DueFollowup[]; waiting: number; stopped: Record<string, number>; mode: "DRY_RUN" | "LIVE" };

/** Lần nhắc ĐẾN HẠN trong phạm vi người xem — tính lúc đọc. CSDL chưa áp 0264 ⇒ `{ unavailable: true }`. */
export async function loadSequenceBoard(decision: ScopeDecision, now = new Date()): Promise<SequenceBoard | { unavailable: true }> {
  try {
    const [settings, emailSettings] = await Promise.all([getEmailSequenceSettings(), getEmailSettings()]);
    const mode = countedMode(emailSettings.mode);
    const empty: SequenceBoard = { configured: false, settings, due: [], waiting: 0, stopped: {}, mode };
    if (settings.maxFollowups === null || settings.gapDays === null) return empty;
    const db = await getDb();
    const o = schema.wholesaleEmailOutbox;
    const ids = await db
      .selectDistinct({ leadId: o.leadId })
      .from(o)
      .innerJoin(schema.wholesaleLeads, eq(schema.wholesaleLeads.id, o.leadId))
      .where(andScope(and(eq(o.status, "SENT"), eq(o.mode, mode)), decision))
      .limit(300);
    const chains = await chainsOf(ids.map((r) => r.leadId), mode);
    const due: DueFollowup[] = [];
    const stopped: Record<string, number> = {};
    let waiting = 0;
    for (const c of chains.values()) {
      const st = await stateOf(c, settings, now);
      if (st.state === "DUE") {
        const last = c.sent.reduce((a, b) => ((a.sentAt as Date) > (b.sentAt as Date) ? a : b));
        due.push({ leadId: c.lead.id, leadName: c.lead.businessName ?? "", toEmail: last.toEmail, nextStep: st.nextStep, dueAt: st.dueAt.toISOString(), lastSentAt: st.lastSentAt.toISOString(), lastSubject: last.subject, language: last.language });
      } else if (st.state === "WAITING" || st.state === "PENDING_MAIL") waiting += 1;
      else stopped[st.reason] = (stopped[st.reason] ?? 0) + 1;
    }
    due.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    return { configured: true, settings, due, waiting, stopped, mode };
  } catch (e) {
    if (isMissingEmailTable(e)) return { unavailable: true };
    throw e;
  }
}

const createSchema = z.object({ source: z.enum(["AI", "TEMPLATE"]) }).strict();
export type FollowupResult = { kind: "AI_DRAFT"; draft: DraftResult } | { kind: "OUTBOX"; outboxId: string };

/** Soạn MỘT lần nhắc cho MỘT lead — chỉ khi đang ĐẾN HẠN (kiểm lại ở đây). Không gửi. */
export async function createFollowupDraftCore(user: SessionUser, leadId: string, raw: unknown, now = new Date(), deps: AiDeps = {}): Promise<CoreResult<FollowupResult>> {
  try {
    if (!can(user, "wholesale:work")) return { error: "Bạn không có quyền chăm lead khách sỉ (wholesale:work)." };
    const decision = await decideScope("WHOLESALE_LEADS", user);
    if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
    if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) return { error: "Chọn nguồn soạn: AI hoặc mẫu." };
    const [settings, emailSettings] = await Promise.all([getEmailSequenceSettings(), getEmailSettings()]);
    const chain = (await chainsOf([leadId], countedMode(emailSettings.mode))).get(leadId);
    if (!chain) return { error: "Không tìm thấy lead." };
    const st = await stateOf(chain, settings, now);
    if (st.state !== "DUE") {
      if (st.state === "STOPPED") return { error: `Chuỗi thư đã dừng: ${SEQUENCE_STOP_LABEL[st.reason]}.` };
      return { error: st.state === "WAITING" ? `Chưa tới hạn nhắc (hạn ${st.dueAt.toISOString().slice(0, 10)}).` : "Lead đang có thư / nháp nhắc chưa xử lý — xử lý nó trước." };
    }
    const prev = chain.sent.reduce((a, b) => ((a.sentAt as Date) > (b.sentAt as Date) ? a : b));
    if (parsed.data.source === "AI") {
      const r = await aiDraftEmailCore(user, leadId, now, deps, { step: st.nextStep, previousSubject: prev.subject, previousBody: prev.bodyText });
      return "error" in r ? r : { ok: true, kind: "AI_DRAFT", draft: r };
    }
    // Mẫu tĩnh shop khai: cùng dữ kiện + cùng hàng rào với AI. Vi phạm ⇒ không tạo thư.
    // Cùng làn kênh và cùng thang nước với mọi đường tạo thư khác (AI đã tự hỏi trong aiDraftEmailCore).
    const refusal = await emailLaneRefusal(leadId);
    if (refusal) return { error: refusal };
    const country = await leadCountryForLead(chain.lead);
    if (!country.country) return { error: `Chưa biết khách ở nước nào (${country.detail}) — xác nhận nước ở Hàng đợi liên hệ rồi soạn thư nhắc.` };
    const facts = await buildDraftFacts(chain.lead, draftLanguageForCountry(country.country));
    const template = facts.language === "vi" ? settings.templates.vi : settings.templates.en;
    if (!template) return { error: `Shop chưa khai mẫu thư nhắc ${facts.language === "vi" ? "tiếng Việt" : "tiếng Anh"} — khai ở Hộp thư đi, hoặc dùng AI.` };
    const cfg = await getLeadHunterConfig();
    const body = renderSequenceTemplate(template, { businessName: chain.lead.businessName || (facts.language === "vi" ? "Quý anh/chị" : "Sir/Madam"), shopName: cfg.outreach.shopName || "", step: st.nextStep });
    const subject = `Re: ${prev.subject.replace(/^(re:\s*)+/i, "")}`.slice(0, 200);
    const violations = draftViolations(subject, body, { language: facts.language, allowedAmounts: new Set(facts.allowedAmounts), factsText: `${facts.factsText}\n${prev.bodyText}`, deliveryNote: facts.deliveryNote });
    if (violations.length) return { error: `Mẫu thư nhắc vi phạm hàng rào: ${violations.map((v) => v.detail).join(" ")}` };
    const to = prev.toEmail;
    const db = await getDb();
    const [mail] = await db
      .insert(schema.wholesaleEmailOutbox)
      .values({ leadId, campaignId: chain.lead.sourceCampaignId, toEmail: to, recipientDomain: emailDomain(to), subject, bodyText: body, language: facts.language, templateKey: "FOLLOWUP", sequenceStep: st.nextStep, status: "DRAFT", idempotencyKey: emailIdempotencyKey(leadId, "FOLLOWUP", st.nextStep, to), preparedBy: "USER", threadId: prev.threadId, inReplyTo: prev.messageIdHeader, createdByUserId: user.id, createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning({ id: schema.wholesaleEmailOutbox.id });
    if (!mail) return { error: `Lead đã có thư nhắc lần ${st.nextStep} tới địa chỉ này — mở Hộp thư đi.` };
    await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "OUTREACH", channel: "EMAIL", note: `Soạn thư nhắc lần ${st.nextStep} từ mẫu (chờ duyệt ở Hộp thư đi)`, actorId: user.id, actorName: user.name, createdAt: now });
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_FOLLOWUP_DRAFT", entity: "WHOLESALE_LEAD", entityId: leadId, after: { outboxId: mail.id, step: st.nextStep, source: "TEMPLATE" }, reason: "Soạn thư nhắc của chuỗi theo dõi (mẫu shop khai) — chờ duyệt" });
    return { ok: true, kind: "OUTBOX", outboxId: mail.id };
  } catch (e) {
    if (isMissingEmailTable(e)) return { error: "CSDL của tổ chức chưa áp migration 0264 (hộp thư đi email)." };
    throw e;
  }
}
