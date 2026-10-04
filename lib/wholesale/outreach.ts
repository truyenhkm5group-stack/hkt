import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import type { AiProvider } from "@/lib/ai/provider";
import { estimateCostUsd } from "@/lib/ai/provider";
import { getBuilderAi } from "@/lib/ai-builder/provider";
import { ByokGeminiProvider } from "@/lib/ai-builder/providers";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { currentOrganization } from "@/lib/platform/context";
import { canUseFeature } from "@/lib/platform/capabilities";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import type { LeadHunterConfig } from "@/lib/wholesale/config";
import { OUTREACH_CHANNELS, OUTREACH_RESULTS, OUTREACH_RESULT_STATUS, type OutreachChannel, isLeadStatus, type LeadStatus } from "@/lib/wholesale/constants";
import { leadView } from "@/lib/wholesale/engine";
import { suppressLead } from "@/lib/wholesale/leads";
import { channelAction, openerLooksInvented, openerVariables, templateOpener, type OpenerFacts } from "@/lib/wholesale/opener";
import { isLeadSegmentKey } from "@/lib/wholesale/segments";
import { getLeadHunterConfig, recordUsage, suppressionHit } from "@/lib/wholesale/store";

/**
 * ═══════════ HÀNG ĐỢI LIÊN HỆ — LÕI GHI (CHỈ MÁY CHỦ) ═══════════
 *
 * Luồng: lead đủ điều kiện → SOẠN lời chào (mẫu / AI) → NGƯỜI DUYỆT → người bấm gửi qua app thật (gọi, Zalo, SMS…) →
 * «Đã gửi» → ghi KẾT QUẢ. Bản này KHÔNG có kênh tự gửi: mức «Tự gửi» khai sẵn trong cấu hình nhưng bị chặn tới khi có
 * bộ chuyển kênh tự động được kết nối — thêm sau không phải viết lại hàng đợi.
 *
 * Không bao giờ soạn / gửi cho lead KHÔNG LIÊN HỆ hoặc khớp danh sách không liên hệ (kiểm lại ở MỌI bước, vì danh sách
 * có thể đổi giữa lúc soạn và lúc gửi).
 */

const FORBIDDEN = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";

type Item = typeof schema.wholesaleOutreachItems.$inferSelect;
type Lead = typeof schema.wholesaleLeads.$inferSelect;

async function leadInScope(user: SessionUser, leadId: string): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  return lead ? { lead } : { error: "Không tìm thấy lead." };
}

async function itemInScope(user: SessionUser, itemId: string): Promise<{ item: Item; lead: Lead } | { error: string }> {
  const db = await getDb();
  const item = await db.query.wholesaleOutreachItems.findFirst({ where: eq(schema.wholesaleOutreachItems.id, itemId) });
  if (!item) return { error: "Không tìm thấy mục liên hệ." };
  const g = await leadInScope(user, item.leadId);
  return "error" in g ? g : { item, lead: g.lead };
}

async function contactOf(lead: Lead) {
  const db = await getDb();
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const v = leadView(lead, snap);
  return { view: v, contact: { phone: v.phone, email: lead.email, facebookUrl: lead.facebookUrl, zaloUrl: lead.zaloUrl } };
}

async function blockedReason(lead: Lead): Promise<string | null> {
  if (lead.contactStatus === "DO_NOT_CONTACT") return "Lead ở danh sách KHÔNG LIÊN HỆ.";
  const { view } = await contactOf(lead);
  const hit = await suppressionHit({ placeId: lead.placeId, phone: view.phone, domain: lead.websiteDomain });
  return hit ? `Khớp danh sách không liên hệ: ${hit}` : null;
}

function factsOf(lead: Lead, name: string): OpenerFacts {
  return { businessName: name, segment: isLeadSegmentKey(lead.segment) ? lead.segment : "UNCLASSIFIED", areaName: lead.areaName, provinceLabel: lead.provinceLabel };
}

/** AI của tổ chức: AI Builder (Anthropic / OpenAI của tổ chức, hoặc credit nền tảng) → khoá Gemini của tổ chức. */
async function resolveAi(): Promise<{ ok: true; provider: AiProvider; source: AiBillingSource } | { ok: false; reason: string }> {
  const b = await getBuilderAi();
  if (b.ok) return { ok: true, provider: b.ai.provider, source: b.ai.source === "ORG_CONNECTION" ? "BYOK" : b.ai.source === "PLATFORM" ? "PLATFORM" : "HOME" };
  const g = await openActiveConnection("gemini-byok");
  if (g.ok && g.secrets.apiKey) return { ok: true, provider: new ByokGeminiProvider({ apiKey: g.secrets.apiKey, model: g.settings.model || null }), source: "BYOK" };
  return { ok: false, reason: b.reason };
}

const AI_SYSTEM = [
  "Bạn viết LỜI CHÀO MỞ ĐẦU ngắn (2–4 câu, tiếng Việt, xưng «em», gọi «anh/chị») để nhân viên bán sỉ gửi cho một doanh nghiệp.",
  "CHỈ dùng dữ kiện trong khối DỮ KIỆN. KHÔNG thêm bất kỳ thông tin nào về doanh nghiệp ngoài dữ kiện (không khen món, không nói số chi nhánh, không đoán quy mô).",
  "KHÔNG ghi giá, số điện thoại, link, email, con số nào không có trong dữ kiện. Không hứa giảm giá nếu dữ kiện không có khuyến mãi.",
  "Chỉ trả về đúng nội dung lời chào, không tiêu đề, không giải thích.",
].join("\n");

/** Soạn bằng AI; câu AI có dấu hiệu bịa ⇒ dùng mẫu (và nói ra). */
async function aiOpener(cfg: LeadHunterConfig, facts: OpenerFacts, actorId: string): Promise<{ text: string; by: "AI" | "TEMPLATE"; model: string | null; note: string | null }> {
  const fallback = templateOpener(cfg, facts);
  const org = await currentOrganization();
  const ai = await resolveAi();
  if (!ai.ok) return { text: fallback, by: "TEMPLATE", model: null, note: `Chưa có AI: ${ai.reason}` };
  const quota = await checkAiQuota(org.code, ai.source);
  if (!quota.ok) return { text: fallback, by: "TEMPLATE", model: null, note: quota.error };
  const vars = openerVariables(cfg, facts);
  const factsText = [
    `Tên doanh nghiệp: ${vars.ten_doanh_nghiep}`,
    `Loại hình: ${vars.loai_hinh}`,
    vars.khu_vuc ? `Khu vực:${vars.khu_vuc.replace(/^ ở/, "")}` : "",
    `Bên bán: ${vars.ten_shop}`,
    `Sản phẩm: ${vars.san_pham}`,
    `Khách mục tiêu: ${vars.nhom_khach}`,
    vars.moq ? `Đơn tối thiểu: ${vars.moq}` : "",
    vars.giao_hang ? `Giao hàng: ${vars.giao_hang}` : "",
    vars.khuyen_mai ? `Khuyến mãi: ${vars.khuyen_mai}` : "",
    vars.catalog ? `Catalog: ${vars.catalog}` : "",
    vars.bang_gia ? `Bảng giá: ${vars.bang_gia}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const res = await ai.provider.complete({ system: AI_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `DỮ KIỆN:\n${factsText}\n\nMẪU THAM KHẢO (giữ ý, được diễn đạt lại):\n${fallback}` }] }], tools: [], maxTokens: 400, reasoning: "low" });
    const model = res.model || ai.provider.model;
    await recordAiUsage({ orgCode: org.code, feature: "lead_hunter", source: ai.source, provider: ai.provider.name, model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd: estimateCostUsd(model, res.usage), status: "OK", actorId, ref: "opener" }).catch(() => undefined);
    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const invented = text ? openerLooksInvented(text, `${factsText}\n${fallback}`) : "AI trả rỗng";
    if (invented) return { text: fallback, by: "TEMPLATE", model, note: `Câu AI bị loại (${invented}) — dùng mẫu.` };
    return { text, by: "AI", model, note: null };
  } catch (e) {
    await recordAiUsage({ orgCode: org.code, feature: "lead_hunter", source: ai.source, provider: ai.provider.name, model: ai.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId, ref: "opener" }).catch(() => undefined);
    return { text: fallback, by: "TEMPLATE", model: null, note: `AI lỗi (${e instanceof Error ? e.message.slice(0, 120) : "không rõ"}) — dùng mẫu.` };
  }
}

function aiFeatureOn(): Promise<boolean> {
  return canUseFeature("wholesale_leads.ai_opener");
}

const prepareSchema = z.object({ channel: z.enum(OUTREACH_CHANNELS), useAi: z.boolean().default(false) });

/** Soạn một lời chào chờ duyệt. Một lead một kênh chỉ có MỘT mục đang mở (chỉ mục duy nhất ở CSDL). */
export async function prepareOutreachCore(user: SessionUser, leadId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ id: string; note: string | null }>> {
  const g = await leadInScope(user, leadId);
  if ("error" in g) return g;
  const parsed = prepareSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const blocked = await blockedReason(g.lead);
  if (blocked) return { error: blocked };
  const { view, contact } = await contactOf(g.lead);
  if (!channelAction(parsed.data.channel, contact, "x")) return { error: "Lead chưa có thông tin liên hệ cho kênh này." };
  const cfg = await getLeadHunterConfig();
  const facts = factsOf(g.lead, view.name ?? g.lead.businessName ?? "anh/chị");
  const wantAi = parsed.data.useAi && cfg.outreach.useAi && (await aiFeatureOn());
  const msg = wantAi ? await aiOpener(cfg, facts, user.id) : { text: templateOpener(cfg, facts), by: "TEMPLATE" as const, model: null, note: null };
  const db = await getDb();
  const [row] = await db
    .insert(schema.wholesaleOutreachItems)
    .values({ leadId, channel: parsed.data.channel, status: "DRAFT", message: msg.text, preparedBy: msg.by, aiModel: msg.model, createdByUserId: user.id, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .returning({ id: schema.wholesaleOutreachItems.id });
  if (!row) return { error: "Lead đã có một lời chào đang chờ ở kênh này — mở hàng đợi để duyệt." };
  if (g.lead.contactStatus === "QUALIFIED" || g.lead.contactStatus === "NEW") {
    await db.update(schema.wholesaleLeads).set({ contactStatus: "READY_TO_CONTACT", qualifiedAt: g.lead.qualifiedAt ?? now, updatedAt: now }).where(eq(schema.wholesaleLeads.id, leadId));
  }
  await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "OUTREACH", channel: parsed.data.channel, note: `Soạn lời chào (${msg.by === "AI" ? "AI" : "mẫu"})${msg.note ? ` — ${msg.note}` : ""}`, actorId: user.id, actorName: user.name });
  if (msg.by === "AI" || msg.note) await recordUsage({ provider: "AI", method: "AI_OPENER", leadId, ok: msg.by === "AI", billable: msg.by === "AI", costMicros: 0, error: msg.note, at: now });
  return { ok: true, id: row.id, note: msg.note };
}

/** «Xếp hàng liên hệ» hàng loạt từ danh sách: soạn bằng MẪU (không gọi AI hàng loạt — tiền AI do người bấm từng lead). */
export async function queueOutreachCore(user: SessionUser, leadIds: string[], channel: OutreachChannel = "PHONE_CALL"): Promise<CoreResult<{ queued: number; skipped: number }>> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN };
  const ids = z.array(z.string().min(1).max(64)).min(1).max(300).safeParse(leadIds);
  if (!ids.success) return { error: "Chọn ít nhất một lead (tối đa 300)." };
  let queued = 0;
  let skipped = 0;
  for (const id of ids.data) {
    const r = await prepareOutreachCore(user, id, { channel, useAi: false });
    if ("error" in r) skipped++;
    else queued++;
  }
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_OUTREACH_QUEUE", entity: "WHOLESALE_LEAD", entityId: ids.data.slice(0, 5).join(","), after: { queued, skipped, channel }, reason: "Xếp hàng liên hệ" });
  return { ok: true, queued, skipped };
}

/**
 * Mức «Tự soạn sẵn» (AUTO_PREPARE): job soạn lời chào MẪU cho lead vừa đủ điều kiện. Vẫn chờ người duyệt — không gửi.
 * Không có người bấm ⇒ không gọi AI (tiền AI chỉ tiêu khi người yêu cầu).
 */
export async function autoPrepareForLead(leadId: string, cfg: LeadHunterConfig, now: Date): Promise<boolean> {
  if (cfg.outreach.automationLevel === "MANUAL") return false;
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  if (!lead || lead.contactStatus !== "QUALIFIED" || (await blockedReason(lead))) return false;
  const { view, contact } = await contactOf(lead);
  if (!channelAction("PHONE_CALL", contact, "x")) return false;
  const text = templateOpener(cfg, factsOf(lead, view.name ?? "anh/chị"));
  const rows = await db.insert(schema.wholesaleOutreachItems).values({ leadId, channel: "PHONE_CALL", status: "DRAFT", message: text, preparedBy: "TEMPLATE", createdAt: now, updatedAt: now }).onConflictDoNothing().returning({ id: schema.wholesaleOutreachItems.id });
  if (!rows.length) return false;
  await db.update(schema.wholesaleLeads).set({ contactStatus: "READY_TO_CONTACT", updatedAt: now }).where(and(eq(schema.wholesaleLeads.id, leadId), eq(schema.wholesaleLeads.contactStatus, "QUALIFIED")));
  await db.insert(schema.wholesaleLeadActivities).values({ leadId, kind: "OUTREACH", channel: "PHONE_CALL", note: "Tự soạn lời chào (mẫu) — chờ người duyệt", actorId: null, actorName: "Máy" });
  return true;
}

const approveSchema = z.object({ message: z.string().trim().min(5, "Lời chào quá ngắn").max(3000) });

export async function approveOutreachCore(user: SessionUser, itemId: string, raw: unknown, now = new Date()): Promise<CoreResult> {
  const g = await itemInScope(user, itemId);
  if ("error" in g) return g;
  if (g.item.status !== "DRAFT") return { error: "Chỉ duyệt được lời chào đang chờ duyệt." };
  const parsed = approveSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const blocked = await blockedReason(g.lead);
  if (blocked) return { error: blocked };
  const db = await getDb();
  const edited = parsed.data.message !== g.item.message;
  await db
    .update(schema.wholesaleOutreachItems)
    .set({ status: "APPROVED", message: parsed.data.message, preparedBy: edited && g.item.preparedBy !== "STAFF" ? "STAFF" : g.item.preparedBy, approvedByUserId: user.id, approvedAt: now, updatedAt: now })
    .where(and(eq(schema.wholesaleOutreachItems.id, itemId), eq(schema.wholesaleOutreachItems.status, "DRAFT")));
  return { ok: true };
}

/** Người đã gửi thật (gọi / nhắn qua app) ⇒ «Đã gửi». Ghi mốc liên hệ của lead. */
export async function markOutreachSentCore(user: SessionUser, itemId: string, now = new Date()): Promise<CoreResult> {
  const g = await itemInScope(user, itemId);
  if ("error" in g) return g;
  if (g.item.status !== "APPROVED" && g.item.status !== "DRAFT") return { error: "Mục này đã gửi hoặc đã huỷ." };
  const blocked = await blockedReason(g.lead);
  if (blocked) return { error: blocked };
  const db = await getDb();
  const moved = await db
    .update(schema.wholesaleOutreachItems)
    .set({ status: "SENT", sentByUserId: user.id, sentAt: now, approvedByUserId: g.item.approvedByUserId ?? user.id, approvedAt: g.item.approvedAt ?? now, updatedAt: now })
    .where(and(eq(schema.wholesaleOutreachItems.id, itemId), inArray(schema.wholesaleOutreachItems.status, ["DRAFT", "APPROVED"])))
    .returning({ id: schema.wholesaleOutreachItems.id });
  if (!moved.length) return { error: "Mục vừa được người khác cập nhật." };
  const early: readonly string[] = ["NEW", "QUALIFIED", "READY_TO_CONTACT"];
  await db
    .update(schema.wholesaleLeads)
    .set({
      contactStatus: early.includes(g.lead.contactStatus) ? "CONTACTED" : g.lead.contactStatus,
      firstContactAt: g.lead.firstContactAt ?? now,
      lastContactAt: now,
      contactAttemptCount: sql`${schema.wholesaleLeads.contactAttemptCount} + 1`,
      updatedAt: now,
    })
    .where(eq(schema.wholesaleLeads.id, g.lead.id));
  await db.insert(schema.wholesaleLeadActivities).values({ leadId: g.lead.id, kind: "OUTREACH", channel: g.item.channel, note: `Đã gửi: ${g.item.message.slice(0, 300)}`, actorId: user.id, actorName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_LEAD_CONTACT", entity: "WHOLESALE_LEAD", entityId: g.lead.id, after: { channel: g.item.channel, itemId }, reason: "Đã gửi lời chào" });
  return { ok: true };
}

const resultSchema = z.object({ result: z.enum(OUTREACH_RESULTS), note: z.string().trim().max(2000).default(""), nextFollowupAt: z.coerce.date().nullable().default(null) });

export async function recordOutreachResultCore(user: SessionUser, itemId: string, raw: unknown, now = new Date()): Promise<CoreResult<{ status: LeadStatus }>> {
  const g = await itemInScope(user, itemId);
  if ("error" in g) return g;
  if (g.item.status !== "SENT") return { error: "Ghi kết quả sau khi đã gửi." };
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const { result, note, nextFollowupAt } = parsed.data;
  const db = await getDb();
  await db.update(schema.wholesaleOutreachItems).set({ status: "DONE", result, resultNote: note || null, resultAt: now, updatedAt: now }).where(eq(schema.wholesaleOutreachItems.id, itemId));
  const from = isLeadStatus(g.lead.contactStatus) ? g.lead.contactStatus : "NEW";
  const target = OUTREACH_RESULT_STATUS[result];
  const early: readonly LeadStatus[] = ["NEW", "QUALIFIED", "READY_TO_CONTACT", "CONTACTED", "NO_ANSWER"];
  const to: LeadStatus = target === "DO_NOT_CONTACT" ? "DO_NOT_CONTACT" : target && early.includes(from) ? target : from;
  const responded = result === "INTERESTED" || result === "REPLIED" || result === "CALLBACK";
  await db
    .update(schema.wholesaleLeads)
    .set({
      contactStatus: to,
      firstResponseAt: responded ? (g.lead.firstResponseAt ?? now) : g.lead.firstResponseAt,
      response: responded && note ? note.slice(0, 500) : g.lead.response,
      nextFollowupAt: to === "DO_NOT_CONTACT" ? null : (nextFollowupAt ?? g.lead.nextFollowupAt),
      updatedAt: now,
    })
    .where(eq(schema.wholesaleLeads.id, g.lead.id));
  if (to === "DO_NOT_CONTACT") await suppressLead(user, g.lead, note || "Khách yêu cầu không liên hệ", now);
  await db.insert(schema.wholesaleLeadActivities).values({ leadId: g.lead.id, kind: "OUTREACH", channel: g.item.channel, outcome: result, fromStatus: from, toStatus: to !== from ? to : null, note, actorId: user.id, actorName: user.name });
  await audit({ userId: user.id, userEmail: user.email, action: to === "DO_NOT_CONTACT" ? "WHOLESALE_LEAD_DNC" : "WHOLESALE_LEAD_CONTACT", entity: "WHOLESALE_LEAD", entityId: g.lead.id, before: { status: from }, after: { status: to, result }, reason: "Kết quả liên hệ" });
  return { ok: true, status: to };
}

export async function cancelOutreachCore(user: SessionUser, itemId: string, now = new Date()): Promise<CoreResult> {
  const g = await itemInScope(user, itemId);
  if ("error" in g) return g;
  if (g.item.status !== "DRAFT" && g.item.status !== "APPROVED") return { error: "Chỉ huỷ được lời chào chưa gửi." };
  const db = await getDb();
  await db.update(schema.wholesaleOutreachItems).set({ status: "CANCELLED", updatedAt: now }).where(eq(schema.wholesaleOutreachItems.id, itemId));
  return { ok: true };
}
