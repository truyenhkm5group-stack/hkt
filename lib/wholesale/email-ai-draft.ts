import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { estimateCostUsd, type AiProvider } from "@/lib/ai/provider";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import type { AiBillingSource } from "@/lib/ai-usage/types";
import { audit } from "@/lib/audit";
import { decideScope, rowInScope } from "@/lib/auth/scope-guard";
import { can, type SessionUser } from "@/lib/auth/session";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { currentOrganization } from "@/lib/platform/context";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { extractVndAmounts } from "@/lib/sales-chatbot/claim-guard";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import { emailDomain, emailIdempotencyKey } from "@/lib/wholesale/email-constants";
import { draftLanguageFor, draftViolations, editRatio, type DraftGuardFacts, type DraftLanguage, type DraftViolation } from "@/lib/wholesale/email-ai-draft-guard";
import { getEmailSettings } from "@/lib/wholesale/email-outbox-store";
import { leadView } from "@/lib/wholesale/engine";
import { emailLaneRefusal } from "@/lib/wholesale/contact-plan-store";
import { openerVariables } from "@/lib/wholesale/opener";
import { resolveAi } from "@/lib/wholesale/outreach";
import { parseQuotationPolicy, QUOTATION_SETTING_KEY } from "@/lib/wholesale/quotation-engine";
import { isLeadSegmentKey, LEAD_SEGMENT_LABEL } from "@/lib/wholesale/segments";
import { getLeadHunterConfig } from "@/lib/wholesale/store";

/**
 * ═══════════ AI SOẠN EMAIL CHÀO HÀNG CÁ NHÂN HOÁ — LÕI (CHỈ MÁY CHỦ) — docs/tech/hslc-b2b-sales-agent.md · P2b ═══════════
 *
 * Luồng: nút «AI soạn nháp» (một lead, một lượt — KHÔNG chạy hàng loạt) → dựng DỮ KIỆN THẬT (hồ sơ lead, bảng giá sỉ đang áp,
 * báo giá đã gửi, lời khai của shop) → gọi AI qua ĐÚNG đường AI của tổ chức (`resolveAi` của hàng đợi liên hệ, ghi sổ dùng AI với
 * feature `b2b_email_draft`) → hàng rào bịa đặt (`draftViolations`) → dòng `wholesale_email_ai_drafts`: DRAFT, hoặc BLOCKED kèm lý
 * do. NGƯỜI sửa rồi «Đưa vào hộp thư đi» ⇒ thư DRAFT của E1. Từ đó vẫn qua lượt duyệt E1 (băm nội dung) và cổng chính sách
 * (đồng ý · danh sách chặn · nút dừng · hạn mức).
 *
 *  · Tính năng mặc định TẮT. Người có `wholesale:config` bật, và phải khai trần số nháp / ngày và trần chi phí USD / ngày (không số
 *    mặc định). Chi phí chưa biết (model chưa có giá) thì không chứng minh được còn dưới trần ⇒ dừng, không coi là 0.
 *  · AI không gửi, không ghi vào hộp thư đi: chỉ `promoteAiDraftCore` (người bấm) tạo thư, và bản cuối phải qua lại hàng rào.
 */

export const EMAIL_AI_SETTING_KEY = "wholesale.emailAiDraft";
export type EmailAiSettings = { enabled: boolean; dailyMaxDrafts: number | null; dailyCostCapUsd: number | null };
const DEFAULT_SETTINGS: EmailAiSettings = { enabled: false, dailyMaxDrafts: null, dailyCostCapUsd: null };

const FORBIDDEN_WORK = "Bạn không có quyền chăm lead khách sỉ (wholesale:work).";
export const AI_DRAFT_TABLE_MISSING = "CSDL của tổ chức chưa áp migration 0265 (nháp email AI) — báo người vận hành.";
const MAX_CATALOG_LINES = 15;

export function isMissingAiDraftTable(error: unknown): boolean {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return (e?.code ?? e?.cause?.code) === "42P01";
}

/** Cấu hình đọc lại an toàn: ô sai kiểu ⇒ `null` / tắt. */
export function parseEmailAiSettings(raw: unknown): EmailAiSettings {
  const o = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 500 ? v : null);
  const usd = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : null);
  const s = { enabled: o.enabled === true, dailyMaxDrafts: int(o.dailyMaxDrafts), dailyCostCapUsd: usd(o.dailyCostCapUsd) };
  return s.enabled && s.dailyMaxDrafts !== null && s.dailyCostCapUsd !== null ? s : { ...s, enabled: false };
}

export async function getEmailAiSettings(): Promise<EmailAiSettings> {
  return parseEmailAiSettings(await getSettingJson<Record<string, unknown>>(EMAIL_AI_SETTING_KEY, { ...DEFAULT_SETTINGS }));
}

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    dailyMaxDrafts: z.number().int().min(1).max(500).nullable().default(null),
    dailyCostCapUsd: z.number().finite().gt(0).max(100).nullable().default(null),
    reason: z.string().trim().min(3, "Ghi lý do (ít nhất 3 ký tự).").max(1000),
  })
  .strict()
  .refine((v) => !v.enabled || (v.dailyMaxDrafts !== null && v.dailyCostCapUsd !== null), { message: "Bật tính năng phải khai trần số nháp / ngày VÀ trần chi phí USD / ngày.", path: ["enabled"] });

/** Bật / tắt + trần / ngày. `wholesale:config`, bắt buộc lý do, `audit`. */
export async function saveEmailAiSettingsCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) bật / tắt được AI soạn email." };
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await getEmailAiSettings();
  const next: EmailAiSettings = { enabled: parsed.data.enabled, dailyMaxDrafts: parsed.data.dailyMaxDrafts, dailyCostCapUsd: parsed.data.dailyCostCapUsd };
  await setSettingJson(EMAIL_AI_SETTING_KEY, next);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_AI_CONFIG", entity: "SETTINGS", entityId: EMAIL_AI_SETTING_KEY, before, after: next, reason: parsed.data.reason });
  return { ok: true };
}

// ─────────────────────────── Dữ kiện thật ───────────────────────────

type Lead = typeof schema.wholesaleLeads.$inferSelect;

async function leadInScope(user: SessionUser, leadId: string): Promise<{ lead: Lead } | { error: string }> {
  if (!can(user, "wholesale:work")) return { error: FORBIDDEN_WORK };
  const decision = await decideScope("WHOLESALE_LEADS", user);
  if (decision.allow === "NONE") return { error: `${decision.reason} ${decision.fix}` };
  if (!(await rowInScope(decision, "wholesale_leads", "id", leadId))) return { error: "Lead này nằm ngoài phạm vi dữ liệu của bạn." };
  const db = await getDb();
  const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, leadId) });
  return lead ? { lead } : { error: "Không tìm thấy lead." };
}

/** `sequenceStep` = 0 thư mở đầu, ≥ 1 lần nhắc thứ N của chuỗi (lib/wholesale/email-sequence.ts). Thiếu (dòng cũ) = 0. */
export type DraftFactsSnapshot = { language: DraftLanguage; factsText: string; allowedAmounts: number[]; deliveryNote: string; catalogLines: number; quotationCode: string | null; sequenceStep?: number };

/** Dựng dữ kiện thật cho MỘT lead — chỉ đọc. */
export async function buildDraftFacts(lead: Lead): Promise<DraftFactsSnapshot> {
  const db = await getDb();
  const [cfg, sender, rawPolicy, books] = await Promise.all([getLeadHunterConfig(), getEmailSettings(), getSettingJson<Record<string, unknown>>(QUOTATION_SETTING_KEY, {}), priceBooksFor(lead.customerId ?? null, db)]);
  const snap = lead.placeId ? await db.query.wholesalePlaceSnapshots.findFirst({ where: eq(schema.wholesalePlaceSnapshots.placeId, lead.placeId) }) : null;
  const v = leadView(lead, snap);
  const segment = isLeadSegmentKey(lead.segment) ? lead.segment : "UNCLASSIFIED";
  const vars = openerVariables(cfg, { businessName: lead.businessName || v.name || "", segment, areaName: lead.areaName, provinceLabel: lead.provinceLabel });
  const language = draftLanguageFor({ phoneCountryCode: lead.phoneCountryCode, websiteDomain: lead.websiteDomain });
  const allowed = new Set<number>();

  // Bảng giá đang áp: khách đã nối ⇒ bảng riêng → mặc định; lead chưa là khách ⇒ bảng mặc định (D6).
  const tiers = [...(books.customerList?.tiers ?? []), ...(books.defaultList?.tiers ?? [])];
  const ids = [...new Set(tiers.map((t) => t.variantId))];
  const pv = schema.productVariants;
  const p = schema.products;
  const variants = ids.length
    ? await db
        .select({ id: pv.id, sku: pv.sku, detail: pv.detail, size: pv.size, name: p.name })
        .from(pv)
        .innerJoin(p, eq(p.id, pv.productId))
        .where(and(inArray(pv.id, ids), eq(pv.isRemoved, false), eq(pv.isHidden, false), eq(p.isRemoved, false)))
        .orderBy(asc(p.name), asc(pv.sku))
        .limit(MAX_CATALOG_LINES)
    : [];
  const catalog = variants.map((r) => {
    const own = tiers.filter((t) => t.variantId === r.id).sort((a, b) => a.minQuantity - b.minQuantity);
    for (const t of own) allowed.add(t.unitPrice);
    const label = r.detail.trim() || r.size.trim();
    return `- ${r.name}${label ? ` (${label})` : ""}${r.sku ? ` [${r.sku}]` : ""}: ${own.map((t) => `từ ${t.minQuantity}: ${t.unitPrice.toLocaleString("vi-VN")} ₫`).join("; ")}`;
  });

  // Báo giá ĐÃ duyệt / đã gửi / đã chấp nhận của lead (bản nháp chưa phải lời nói với khách).
  const [quote] = await db
    .select()
    .from(schema.wholesaleQuotations)
    .where(and(eq(schema.wholesaleQuotations.leadId, lead.id), inArray(schema.wholesaleQuotations.status, ["APPROVED", "SENT", "ACCEPTED"])))
    .orderBy(desc(schema.wholesaleQuotations.createdAt))
    .limit(1);
  if (quote) for (const n of [quote.subtotal, quote.discount, quote.total, quote.shipping, quote.tax]) if (typeof n === "number" && n > 0) allowed.add(n);
  if (quote) {
    const lines = await db.select({ unitPrice: schema.wholesaleQuotationLines.unitPrice, lineTotal: schema.wholesaleQuotationLines.lineTotal }).from(schema.wholesaleQuotationLines).where(eq(schema.wholesaleQuotationLines.quotationId, quote.id));
    for (const l of lines) for (const n of [l.unitPrice, l.lineTotal]) if (typeof n === "number" && n > 0) allowed.add(n);
  }

  const policy = parseQuotationPolicy(rawPolicy);
  for (const note of [vars.moq, vars.giao_hang, vars.khuyen_mai]) for (const n of extractVndAmounts(note ?? "")) allowed.add(n);
  const seg = LEAD_SEGMENT_LABEL[segment];
  const lines = [
    `Tên doanh nghiệp: ${vars.ten_doanh_nghiep || "(chưa có tên — gọi «Quý doanh nghiệp»)"}`,
    `Loại hình: ${seg}${lead.segmentEvidence ? ` (căn cứ: ${lead.segmentEvidence})` : ""}`,
    vars.khu_vuc ? `Khu vực:${vars.khu_vuc.replace(/^ ở/, "")}` : "",
    lead.website ? `Website của khách: ${lead.website}` : "",
    `Bên bán: ${sender.sender.companyName || vars.ten_shop}`,
    sender.sender.name ? `Người gửi: ${sender.sender.name}` : "",
    sender.sender.email ? `Email người gửi: ${sender.sender.email}` : "",
    `Sản phẩm: ${vars.san_pham}`,
    vars.moq ? `Đơn tối thiểu (shop khai): ${vars.moq}` : "",
    vars.giao_hang ? `Giao hàng (shop khai): ${vars.giao_hang}` : "",
    vars.khuyen_mai ? `Khuyến mãi (shop khai): ${vars.khuyen_mai}` : "",
    vars.catalog ? `Catalog: ${vars.catalog}` : "",
    vars.bang_gia ? `Bảng giá: ${vars.bang_gia}` : "",
    catalog.length ? `Bảng giá sỉ (đơn giá theo bậc số lượng, VND):\n${catalog.join("\n")}` : "Bảng giá sỉ: chưa có bậc nào — KHÔNG nêu giá.",
    quote ? `Báo giá đã gửi cho khách: ${quote.code} — tổng ${quote.total.toLocaleString("vi-VN")} ₫, hiệu lực đến ${quote.validUntil}` : "",
    policy.taxRatePercent !== null ? `Thuế: ${policy.taxRatePercent}% (${policy.taxSource})` : "Thuế: giá chưa gồm thuế.",
  ].filter(Boolean);
  return { language, factsText: lines.join("\n"), allowedAmounts: [...allowed].sort((a, b) => a - b), deliveryNote: vars.giao_hang ?? "", catalogLines: catalog.length, quotationCode: quote?.code ?? null };
}

function guardFacts(f: DraftFactsSnapshot): DraftGuardFacts {
  return { language: f.language, allowedAmounts: new Set(f.allowedAmounts), factsText: f.factsText, deliveryNote: f.deliveryNote };
}

const SYSTEM: Record<DraftLanguage, string> = {
  vi: [
    "Bạn viết EMAIL CHÀO HÀNG SỈ ngắn (90–180 chữ, tiếng Việt, lịch sự, xưng «chúng tôi» / «bên em», gọi «Quý anh/chị») để nhân viên bán sỉ gửi cho một doanh nghiệp.",
    "CHỈ dùng dữ kiện trong khối DỮ KIỆN. Không thêm thông tin về doanh nghiệp nhận thư ngoài dữ kiện.",
    "Giá: chỉ được nêu ĐÚNG đơn giá có trong bảng giá sỉ / báo giá, ghi bằng VND. Không quy đổi tiền tệ khác.",
    "TUYỆT ĐỐI KHÔNG nói về: chứng nhận / tiêu chuẩn, xuất khẩu, tồn kho / sẵn hàng, thời gian giao (trừ khi dữ kiện có câu giao hàng), chiết khấu %.",
    "Không thêm số điện thoại, link, email nào ngoài dữ kiện. Kết thư mời khách trả lời email để nhận báo giá chi tiết.",
    "Trả về đúng định dạng: dòng đầu «SUBJECT: <tiêu đề>», dòng thứ hai «---», sau đó là thân thư. Không giải thích.",
  ].join("\n"),
  en: [
    "You write a SHORT B2B wholesale introduction email (90–180 words, English, polite) for a Vietnamese seafood supplier's sales staff to send to a business.",
    "Use ONLY the facts in the FACTS block. Do not add anything about the recipient business beyond the facts.",
    "Prices: you may only quote EXACT unit prices from the wholesale price list / quotation, written in VND. Never convert to another currency.",
    "NEVER mention: certifications / standards, export capability or Incoterms, stock / availability, delivery times (unless a delivery note is in the facts), percentage discounts.",
    "Do not add any phone number, link or email not in the facts. Close by inviting the recipient to reply for a detailed quotation.",
    "Return exactly: first line «SUBJECT: <subject>», second line «---», then the body. No explanations.",
  ].join("\n"),
};

const FOLLOWUP_NOTE: Record<DraftLanguage, (step: number) => string> = {
  vi: (step) => `ĐÂY LÀ THƯ NHẮC LẦN ${step} (thư thứ ${step + 1}) gửi lại cho khách CHƯA trả lời thư trước: ngắn hơn (50–110 chữ), lịch sự, nhắc lại thư trước, không lặp nguyên văn, không gây áp lực. Tiêu đề bắt đầu bằng «Re: » + tiêu đề thư trước.`,
  en: (step) => `THIS IS FOLLOW-UP #${step} (email ${step + 1}) to a recipient who has NOT replied to the previous email: shorter (50–110 words), polite, refer back to the previous email, do not repeat it verbatim, no pressure. Subject starts with «Re: » + the previous subject.`,
};

/** Tách «SUBJECT: …» / «---» / thân. Thiếu định dạng ⇒ tiêu đề mặc định, cả chữ là thân. HÀM THUẦN. */
export function parseDraftOutput(text: string, fallbackSubject: string): { subject: string; body: string } {
  const t = text.replace(/\r/g, "").trim();
  const m = /^(?:subject|tiêu đề|tieu de)\s*:\s*(.+)\n(?:-{3,}\n)?([\s\S]*)$/i.exec(t);
  if (!m) return { subject: fallbackSubject, body: t };
  return { subject: m[1].trim().slice(0, 200), body: m[2].trim() };
}

// ─────────────────────────── Soạn nháp ───────────────────────────

export type AiDeps = { ai?: { provider: AiProvider; source: AiBillingSource } };
/** Lần nhắc của chuỗi thư: bước + thư ĐÃ GỬI ngay trước (người đã duyệt). Chỉ `lib/wholesale/email-sequence-core.ts` truyền vào, sau khi đã kiểm lần nhắc ĐẾN HẠN. */
export type FollowupContext = { step: number; previousSubject: string; previousBody: string };
export type DraftResult = { id: string; status: "DRAFT" | "BLOCKED"; violations: DraftViolation[]; language: DraftLanguage };

/** Hôm nay (giờ VN) tổ chức đã soạn bao nhiêu nháp và tốn bao nhiêu — `costUnknown` = có lượt chưa biết giá. */
async function todaySpend(now: Date): Promise<{ drafts: number; costUsd: number; costUnknown: boolean }> {
  const db = await getDb();
  const rows = await db.select({ cost: schema.wholesaleEmailAiDrafts.costUsd }).from(schema.wholesaleEmailAiDrafts).where(gte(schema.wholesaleEmailAiDrafts.createdAt, vnStartOfDay(vnDateKey(now))));
  return { drafts: rows.length, costUsd: rows.reduce((s, r) => s + (r.cost ?? 0), 0), costUnknown: rows.some((r) => r.cost === null) };
}

/** «AI soạn nháp» cho MỘT lead (luồng email). Không gửi, không vào hộp thư đi. */
export async function aiDraftEmailCore(user: SessionUser, leadId: string, now = new Date(), deps: AiDeps = {}, followup: FollowupContext | null = null): Promise<CoreResult<DraftResult>> {
  try {
    const g = await leadInScope(user, leadId);
    if ("error" in g) return g;
    const settings = await getEmailAiSettings();
    if (!settings.enabled) return { error: "AI soạn email đang TẮT — người cấu hình bật ở Hộp thư đi (kèm trần số nháp và chi phí / ngày)." };
    if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
    if (!normalizeEmail(g.lead.email)) return { error: "Lead chưa có email hợp lệ — AI soạn email chỉ dành cho luồng email." };
    // Kế hoạch kênh (chủ shop 30/10): khách trong nước còn nhắn Zalo được thì không soạn email — kiểm TRƯỚC khi tốn lượt AI.
    const refusal = await emailLaneRefusal(g.lead.id);
    if (refusal) return { error: refusal };
    // Kiểm bảng + trần TRƯỚC khi gọi AI: chưa áp 0265 hoặc chạm trần ⇒ không tốn một lượt gọi nào.
    const spend = await todaySpend(now);
    if (spend.drafts >= (settings.dailyMaxDrafts as number)) return { error: `Đã chạm trần ${settings.dailyMaxDrafts} nháp AI hôm nay.` };
    if (spend.costUnknown) return { error: "Hôm nay có lượt AI chưa biết chi phí (model chưa có giá niêm yết) — không chứng minh được còn dưới trần chi phí, tạm dừng tới mai." };
    if (spend.costUsd >= (settings.dailyCostCapUsd as number)) return { error: `Đã chạm trần chi phí ${settings.dailyCostCapUsd} USD / ngày.` };

    const base = await buildDraftFacts(g.lead);
    // Thư nhắc: thư trước (đã gửi, người đã duyệt) thành một phần dữ kiện — AI được nhắc lại nó, hàng rào chấp nhận đúng những gì nó đã nói.
    const facts: DraftFactsSnapshot = followup
      ? { ...base, sequenceStep: followup.step, factsText: `${base.factsText}\n${base.language === "vi" ? "THƯ ĐÃ GỬI TRƯỚC ĐÓ" : "PREVIOUS EMAIL SENT"} (${followup.previousSubject}):\n${followup.previousBody}` }
      : { ...base, sequenceStep: 0 };
    const org = await currentOrganization();
    const resolved = deps.ai ? ({ ok: true, ...deps.ai } as const) : await resolveAi();
    if (!resolved.ok) return { error: `Chưa có AI của tổ chức: ${resolved.reason}` };
    const quota = await checkAiQuota(org.code, resolved.source);
    if (!quota.ok) return { error: quota.error };
    const provider = resolved.provider;
    const cfg = await getLeadHunterConfig();
    const fallbackSubject = facts.language === "vi" ? `Bảng giá sỉ ${cfg.outreach.productLine || "hải sản"} — ${cfg.outreach.shopName || "bên em"}` : `Wholesale price list — ${cfg.outreach.shopName || "Vietnamese seafood supplier"}`;
    let res;
    try {
      const system = followup ? `${SYSTEM[facts.language]}\n${FOLLOWUP_NOTE[facts.language](followup.step)}` : SYSTEM[facts.language];
      res = await provider.complete({ system, messages: [{ role: "user", content: [{ type: "text", text: `${facts.language === "vi" ? "DỮ KIỆN" : "FACTS"}:\n${facts.factsText}` }] }], tools: [], maxTokens: 900, reasoning: "low" });
    } catch (e) {
      await recordAiUsage({ orgCode: org.code, feature: "b2b_email_draft", workload: "lead_hunter", source: resolved.source, provider: provider.name, model: provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: user.id, ref: "email_draft" }).catch(() => undefined);
      return { error: `AI lỗi (${e instanceof Error ? e.message.slice(0, 160) : "không rõ"}) — chưa có nháp nào được lưu.` };
    }
    const model = res.model || provider.model;
    const costUsd = estimateCostUsd(model, res.usage);
    await recordAiUsage({ orgCode: org.code, feature: "b2b_email_draft", workload: "lead_hunter", source: resolved.source, provider: provider.name, model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd, status: "OK", actorId: user.id, ref: "email_draft" }).catch(() => undefined);
    const text = res.content
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    const draft = parseDraftOutput(text, fallbackSubject);
    const violations = draftViolations(draft.subject, draft.body, guardFacts(facts));
    const status = violations.length ? "BLOCKED" : "DRAFT";
    const db = await getDb();
    const [row] = await db
      .insert(schema.wholesaleEmailAiDrafts)
      .values({ leadId, language: facts.language, subject: draft.subject || fallbackSubject, body: draft.body || "(trống)", status, violations, facts, model, provider: provider.name, billingSource: resolved.source, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd, requestedByUserId: user.id, createdAt: now, updatedAt: now })
      .returning({ id: schema.wholesaleEmailAiDrafts.id });
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_AI_DRAFT", entity: "WHOLESALE_LEAD", entityId: leadId, after: { draftId: row.id, status, model, costUsd, language: facts.language, violations: violations.map((v) => v.code) }, reason: status === "BLOCKED" ? "AI soạn nháp email — máy CHẶN (hàng rào bịa đặt)" : "AI soạn nháp email — chờ người duyệt" });
    return { ok: true, id: row.id, status, violations, language: facts.language };
  } catch (e) {
    if (isMissingAiDraftTable(e)) return { error: AI_DRAFT_TABLE_MISSING };
    throw e;
  }
}

// ─────────────────────────── Người duyệt ───────────────────────────

type DraftRow = typeof schema.wholesaleEmailAiDrafts.$inferSelect;

async function draftInScope(user: SessionUser, id: string): Promise<{ row: DraftRow; lead: Lead } | { error: string }> {
  const db = await getDb();
  const row = await db.query.wholesaleEmailAiDrafts.findFirst({ where: eq(schema.wholesaleEmailAiDrafts.id, id) });
  if (!row) return { error: "Không tìm thấy nháp." };
  const g = await leadInScope(user, row.leadId);
  return "error" in g ? g : { row, lead: g.lead };
}

const promoteSchema = z.object({ subject: z.string().trim().min(3, "Tiêu đề quá ngắn").max(200), body: z.string().trim().min(20, "Nội dung quá ngắn").max(5000) }).strict();

/**
 * NGƯỜI sửa xong ⇒ «Đưa vào hộp thư đi»: bản cuối qua LẠI hàng rào, cùng dữ kiện đã chụp lúc soạn. Còn vi phạm ⇒ từ chối, không tạo
 * thư. Qua ⇒ tạo thư DRAFT của E1 (chờ duyệt gửi), ghi người duyệt + tỷ lệ sửa. Nháp BLOCKED / đã xử lý thì không đưa được.
 */
export async function promoteAiDraftCore(user: SessionUser, id: string, raw: unknown, now = new Date()): Promise<CoreResult<{ outboxId: string; editRatio: number }>> {
  try {
    const g = await draftInScope(user, id);
    if ("error" in g) return g;
    if (g.row.status === "PROMOTED") return g.row.outboxId ? { ok: true, outboxId: g.row.outboxId, editRatio: g.row.editRatio ?? 0 } : { error: "Nháp đã đưa vào hộp thư đi." };
    if (g.row.status !== "DRAFT") return { error: g.row.status === "BLOCKED" ? "Nháp bị máy chặn — soạn lại, không đưa vào hộp thư đi." : "Nháp đã bị bỏ." };
    const parsed = promoteSchema.safeParse(raw);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
    if (g.lead.contactStatus === "DO_NOT_CONTACT") return { error: "Lead ở danh sách KHÔNG LIÊN HỆ." };
    const to = normalizeEmail(g.lead.email);
    if (!to) return { error: "Lead chưa có email hợp lệ." };
    const refusal = await emailLaneRefusal(g.lead.id);
    if (refusal) return { error: refusal };
    const snap = g.row.facts as DraftFactsSnapshot;
    const step = typeof snap.sequenceStep === "number" && snap.sequenceStep > 0 ? snap.sequenceStep : 0;
    const templateKey = step > 0 ? "FOLLOWUP" : "OPENER_D0";
    const violations = draftViolations(parsed.data.subject, parsed.data.body, guardFacts(snap));
    if (violations.length) return { error: `Bản cuối vẫn vi phạm hàng rào: ${violations.map((v) => v.detail).join(" ")}` };
    const ratio = editRatio(`${g.row.subject}\n${g.row.body}`, `${parsed.data.subject}\n${parsed.data.body}`);
    const db = await getDb();
    const out = await db.transaction(async (tx) => {
      const [mail] = await tx
        .insert(schema.wholesaleEmailOutbox)
        .values({ leadId: g.lead.id, campaignId: g.lead.sourceCampaignId, toEmail: to, recipientDomain: emailDomain(to), subject: parsed.data.subject, bodyText: parsed.data.body, language: g.row.language, templateKey, sequenceStep: step, status: "DRAFT", idempotencyKey: emailIdempotencyKey(g.lead.id, templateKey, step, to), preparedBy: "AI", aiModel: g.row.model, createdByUserId: user.id, createdAt: now, updatedAt: now })
        .onConflictDoNothing()
        .returning({ id: schema.wholesaleEmailOutbox.id });
      if (!mail) return null;
      const moved = await tx
        .update(schema.wholesaleEmailAiDrafts)
        .set({ status: "PROMOTED", reviewedSubject: parsed.data.subject, reviewedBody: parsed.data.body, editRatio: ratio, reviewedByUserId: user.id, reviewedAt: now, outboxId: mail.id, updatedAt: now })
        .where(and(eq(schema.wholesaleEmailAiDrafts.id, id), eq(schema.wholesaleEmailAiDrafts.status, "DRAFT")))
        .returning({ id: schema.wholesaleEmailAiDrafts.id });
      if (!moved.length) throw new Error("RACE");
      return mail.id;
    });
    if (!out) return { error: step > 0 ? `Lead đã có thư nhắc lần ${step} tới địa chỉ này — mở Hộp thư đi.` : "Lead đã có thư «Lời chào mở đầu» tới địa chỉ này (đang mở hoặc đã gửi thật) — mở Hộp thư đi." };
    await db.insert(schema.wholesaleLeadActivities).values({ leadId: g.lead.id, kind: "OUTREACH", channel: "EMAIL", note: `Đưa nháp AI vào Hộp thư đi (thư nháp tới ${to}, sửa ${Math.round(ratio * 100)}%) — chờ duyệt gửi`, actorId: user.id, actorName: user.name, createdAt: now });
    await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_AI_PROMOTE", entity: "WHOLESALE_LEAD", entityId: g.lead.id, after: { draftId: id, outboxId: out, model: g.row.model, costUsd: g.row.costUsd, editRatio: ratio, requestedBy: g.row.requestedByUserId, reviewedBy: user.id }, reason: "Duyệt nháp email AI ⇒ hộp thư đi (vẫn chờ duyệt gửi E1)" });
    return { ok: true, outboxId: out, editRatio: ratio };
  } catch (e) {
    if (isMissingAiDraftTable(e)) return { error: AI_DRAFT_TABLE_MISSING };
    if (e instanceof Error && e.message === "RACE") return { error: "Nháp vừa được người khác xử lý — tải lại trang." };
    throw e;
  }
}

/** Bỏ nháp (DRAFT / BLOCKED), có lý do. */
export async function discardAiDraftCore(user: SessionUser, id: string, reason: unknown, now = new Date()): Promise<CoreResult> {
  try {
    const g = await draftInScope(user, id);
    if ("error" in g) return g;
    const why = z.string().trim().min(3, "Ghi lý do bỏ (ít nhất 3 ký tự).").max(500).safeParse(reason);
    if (!why.success) return { error: why.error.issues[0]?.message ?? "Ghi lý do." };
    if (g.row.status !== "DRAFT" && g.row.status !== "BLOCKED") return { error: "Nháp đã được xử lý." };
    const db = await getDb();
    await db.update(schema.wholesaleEmailAiDrafts).set({ status: "DISCARDED", discardedByUserId: user.id, discardedAt: now, discardReason: why.data, updatedAt: now }).where(and(eq(schema.wholesaleEmailAiDrafts.id, id), inArray(schema.wholesaleEmailAiDrafts.status, ["DRAFT", "BLOCKED"])));
    return { ok: true };
  } catch (e) {
    if (isMissingAiDraftTable(e)) return { error: AI_DRAFT_TABLE_MISSING };
    throw e;
  }
}
