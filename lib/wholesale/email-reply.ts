import { and, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { estimateCostUsd } from "@/lib/ai/provider";
import { checkAiQuota } from "@/lib/ai-usage/quota";
import { recordAiUsage } from "@/lib/ai-usage/ledger";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import { openActiveConnection } from "@/lib/connectors/service";
import { vnDateKey, vnStartOfDay } from "@/lib/format";
import { maskSecret, smtpCredentialsOf } from "@/lib/integrations/gws-smtp/client";
import { imapflowReader, type InboundHeader, type MailboxReaderFactory } from "@/lib/integrations/gws-smtp/imap";
import { currentOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { priceBooksFor } from "@/lib/queries/price-lists";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { SyncTrigger } from "@/lib/sync/runner";
import { runSyncJob } from "@/lib/sync/runner";
import type { CoreResult } from "@/lib/wholesale/campaigns";
import { normalizeEmail } from "@/lib/wholesale/contactability";
import type { AiDeps } from "@/lib/wholesale/email-ai-draft";
import { findInboundTarget, ingestInboundEmail } from "@/lib/wholesale/email-inbound";
import { isMissingEmailTable } from "@/lib/wholesale/email-outbox-store";
import { applyEmailUnsubscribe } from "@/lib/wholesale/email-unsubscribe";
import { resolveAi } from "@/lib/wholesale/outreach";
import { createQuotationDraftByMachine } from "@/lib/wholesale/quotation";

/**
 * ═══════════ E3 — ĐỌC & PHÂN LOẠI THƯ TRẢ LỜI CỦA KHÁCH SỈ (chủ shop duyệt lộ trình bước 3, 31/10/2026) ═══════════
 *
 * Mỗi lượt job `wholesale-leads` (không đổi lịch chung) — nếu người cấu hình đã BẬT «đọc hộp thư» — mở INBOX của hộp thư Google
 * Workspace đã nối ở E2 (CÙNG credential connector `gws-smtp`, chỉ đọc), lấy thư MỚI sau mốc UID đã lưu:
 *  1. Chỉ đọc TIÊU ĐỀ trước. Thư tự động (Auto-Submitted / Precedence / tiêu đề «vắng mặt») ⇒ bỏ. Thư không nối luồng với thư
 *     ERP đã gửi và không khớp ĐÚNG MỘT lead ⇒ bỏ, KHÔNG tải nội dung, KHÔNG lưu gì.
 *  2. Thư khớp ⇒ tải phần chữ (không đính kèm), cắt phần trích thư cũ, che dãy số dài (tài khoản / thẻ), giữ tối đa 2.000 ký tự
 *     (tập D18) ⇒ đường vào DUY NHẤT của E1 `ingestInboundEmail` (sự kiện REPLY · dừng thư chờ + chuỗi nhắc #1103 · việc phòng
 *     Kinh doanh «trả lời khách»).
 *  3. Thư xin ngừng nhận bằng chữ («unsubscribe», «huỷ đăng ký», «stop»…) ⇒ ĐÚNG đường huỷ của E1 (`applyEmailUnsubscribe`).
 *  4. Nếu người cấu hình BẬT phân loại AI (kèm trần lượt + trần USD / ngày): AI xếp thư vào QUAN TÂM · HỎI GIÁ · TỪ CHỐI · HUỶ ĐĂNG
 *     KÝ · KHÁC, BẮT BUỘC kèm câu trích NGUYÊN VĂN — trích không có trong thư ⇒ hạ về KHÁC (không có căn cứ thì không kết luận).
 *     HỎI GIÁ ⇒ máy ghép mẫu mã khách nhắc (chỉ khi ghép ĐƯỢC DUY NHẤT, có trong chính thư) và lập NHÁP báo giá qua bộ tính #1095
 *     — giá từ bảng giá sỉ, không tự gửi. Không ghép được ⇒ không có nháp, việc «trả lời khách» nói rõ.
 *  Lượt hỏng giữa chừng: mốc UID ghi SAU MỖI thư, và đường vào E1 chống trùng theo Message-ID ⇒ chạy lại không nhân dòng.
 */

export const EMAIL_INBOUND_SETTING_KEY = "wholesale.emailInbound";
export const EMAIL_INBOUND_CURSOR_KEY = "wholesale.emailInbound.cursor";
/** Một lượt đọc tối đa bấy nhiêu thư (tiêu đề); còn lại để lượt sau. */
export const INBOUND_BATCH = 50;
/** Trần byte phần chữ tải về của MỘT thư. */
export const INBOUND_BODY_MAX_BYTES = 64 * 1024;
/** Trích giữ lại (khớp D18 của sổ dữ liệu). */
export const INBOUND_SNIPPET_MAX = 2000;
/** Lượt đầu (chưa có mốc): đọc lùi tối đa bấy nhiêu ngày, và không trước thư thật đầu tiên đã gửi. */
export const INBOUND_FIRST_RUN_DAYS = 14;

export const REPLY_CLASSES = ["INTERESTED", "PRICE_REQUEST", "DECLINED", "UNSUBSCRIBE", "OTHER"] as const;
export type ReplyClass = (typeof REPLY_CLASSES)[number];
export const REPLY_CLASS_LABEL: Record<ReplyClass, string> = { INTERESTED: "Quan tâm", PRICE_REQUEST: "Hỏi giá", DECLINED: "Từ chối", UNSUBSCRIBE: "Huỷ đăng ký", OTHER: "Khác" };

export type EmailInboundSettings = { enabled: boolean; aiClassify: boolean; dailyMaxClassify: number | null; dailyCostCapUsd: number | null };
const DEFAULTS: EmailInboundSettings = { enabled: false, aiClassify: false, dailyMaxClassify: null, dailyCostCapUsd: null };

/** Phân loại chỉ bật được khi có ĐỦ hai trần — thiếu một ⇒ coi như tắt (rơi về phía hẹp). HÀM THUẦN. */
export function parseEmailInboundSettings(raw: unknown): EmailInboundSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULTS;
  const o = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 500 ? v : null);
  const usd = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 100 ? v : null);
  const s = { enabled: o.enabled === true, aiClassify: o.aiClassify === true, dailyMaxClassify: int(o.dailyMaxClassify), dailyCostCapUsd: usd(o.dailyCostCapUsd) };
  return s.aiClassify && (s.dailyMaxClassify === null || s.dailyCostCapUsd === null) ? { ...s, aiClassify: false } : s;
}

export async function getEmailInboundSettings(): Promise<EmailInboundSettings> {
  return parseEmailInboundSettings(await getSettingJson<unknown>(EMAIL_INBOUND_SETTING_KEY, null));
}

const settingsSchema = z
  .object({
    enabled: z.boolean(),
    aiClassify: z.boolean(),
    dailyMaxClassify: z.number().int().min(1).max(500).nullable().default(null),
    dailyCostCapUsd: z.number().finite().gt(0).max(100).nullable().default(null),
  })
  .strict()
  .refine((v) => !v.aiClassify || (v.dailyMaxClassify !== null && v.dailyCostCapUsd !== null), { message: "Bật phân loại AI phải khai trần số thư / ngày VÀ trần chi phí USD / ngày.", path: ["aiClassify"] });

/** Bật / tắt đọc hộp thư và phân loại AI — `wholesale:config`, có nhật ký. */
export async function saveEmailInboundSettingsCore(user: SessionUser, raw: unknown): Promise<CoreResult> {
  if (!can(user, "wholesale:config")) return { error: "Chỉ người cấu hình (wholesale:config) bật / tắt đọc hộp thư." };
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Dữ liệu không hợp lệ" };
  const before = await getEmailInboundSettings();
  await setSettingJson(EMAIL_INBOUND_SETTING_KEY, parsed.data);
  await audit({ userId: user.id, userEmail: user.email, action: "WHOLESALE_EMAIL_INBOUND_CONFIG", entity: "SETTINGS", entityId: EMAIL_INBOUND_SETTING_KEY, before, after: parsed.data, reason: "Sửa cấu hình đọc / phân loại thư trả lời" });
  return { ok: true };
}

// ─────────────────────────── THUẦN ───────────────────────────

/** Thư tự động? (RFC 3834 Auto-Submitted, Precedence / X-Autoreply, tiêu đề vắng mặt). HÀM THUẦN. */
export function isAutomatedReply(h: Pick<InboundHeader, "autoSubmitted" | "autoHint" | "subject">): boolean {
  const a = (h.autoSubmitted ?? "").trim().toLowerCase();
  if (a && a !== "no") return true;
  if (h.autoHint) return true;
  return /\b(out of (the )?office|auto(matic)?[- ]?reply|autoreply|vacation)\b|vắng mặt|trả lời tự động|tự động trả lời/i.test(h.subject);
}

/** Bỏ phần trích thư cũ (dòng «>», «On … wrote:», «Vào … đã viết:», «-----Original Message-----», khối «From:/Từ:»). HÀM THUẦN. */
export function stripQuotedReply(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (/^(on .{3,200} wrote:|vào .{3,200} đã viết:|-{2,}\s*original message\s*-{2,}|-{2,}\s*thư gốc\s*-{2,})$/i.test(t)) break;
    if (/^(from|từ|người gửi):\s.+@/i.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").trim();
}

/** Che dãy ≥ 12 chữ số (số tài khoản, số thẻ — có thể chen khoảng trắng / gạch). SĐT 10–11 số giữ nguyên. HÀM THUẦN. */
export function redactInboundText(text: string): string {
  return text.replace(/\d(?:[ -]?\d){11,}/g, "[đã che dãy số]");
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Khách xin ngừng nhận bằng chữ? Cụm rõ nghĩa ở bất kỳ đâu trong phần VIẾT MỚI («unsubscribe», «huỷ đăng ký», «ngừng gửi»,
 * «đừng gửi», «không muốn nhận»); từ ngắn mơ hồ («stop», «huỷ», «remove») chỉ khi chúng là CẢ dòng đầu. HÀM THUẦN.
 */
export function textUnsubscribeIntent(newText: string): boolean {
  const f = fold(newText);
  if (/\bunsubscribe\b|\bopt[ -]?out\b|\bremove me\b|huy dang ky|ngung gui|dung gui|khong muon nhan|khong nhan (thu|email|mail) nua|ngung nhan/.test(f)) return true;
  const first = fold(newText.split("\n").find((l) => l.trim()) ?? "").replace(/[.!]+$/, "");
  return /^(stop|huy|remove|unsub)$/.test(first);
}

export type ReplyClassification = { cls: ReplyClass; quote: string | null; evidenceMissing: boolean; items: { product: string; quantity: number | null }[] };

/**
 * Câu trả lời của AI ⇒ phân loại đã kiểm. Câu trích PHẢI có NGUYÊN VĂN trong thư (so sau khi gộp khoảng trắng); không có ⇒ hạ về
 * KHÁC, `evidenceMissing`. Mục hàng chỉ giữ cho HỎI GIÁ. JSON hỏng ⇒ KHÁC. HÀM THUẦN.
 */
export function parseClassification(aiText: string, replyText: string): ReplyClassification {
  const fallback: ReplyClassification = { cls: "OTHER", quote: null, evidenceMissing: true, items: [] };
  const m = /\{[\s\S]*\}/.exec(aiText);
  if (!m) return fallback;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  const cls = (REPLY_CLASSES as readonly string[]).includes(String(o.class)) ? (o.class as ReplyClass) : "OTHER";
  const quote = typeof o.quote === "string" ? o.quote.trim().slice(0, 300) : "";
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!quote || !norm(replyText).includes(norm(quote))) return { ...fallback, quote: quote || null };
  const items =
    cls === "PRICE_REQUEST" && Array.isArray(o.items)
      ? (o.items as unknown[])
          .slice(0, 20)
          .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : {}))
          .filter((x) => typeof x.product === "string" && x.product.trim())
          .map((x) => ({ product: String(x.product).trim().slice(0, 120), quantity: typeof x.quantity === "number" && Number.isInteger(x.quantity) && x.quantity > 0 ? x.quantity : null }))
      : [];
  return { cls, quote, evidenceMissing: false, items };
}

export type CatalogEntry = { variantId: string; sku: string; productName: string; label: string; productVariantCount: number; moq: number };

/**
 * Ghép mục hàng khách nhắc với mẫu mã — CHỈ khi ghép được DUY NHẤT và mã / tên đó có trong CHÍNH thư (AI không bịa được mẫu mã).
 * Tên sản phẩm có nhiều mẫu mã thì phải có thêm SKU hoặc nhãn quy cách. Số lượng chỉ nhận khi con số đó có trong thư; không có
 * ⇒ MOQ của bảng giá sỉ, và nói ra. HÀM THUẦN.
 */
export function matchQuoteLines(items: readonly { product: string; quantity: number | null }[], replyText: string, catalog: readonly CatalogEntry[]): { lines: { variantId: string; quantity: number; quantityFrom: "EMAIL" | "MOQ" }[]; unmatched: string[] } {
  const reply = fold(replyText);
  const lines: { variantId: string; quantity: number; quantityFrom: "EMAIL" | "MOQ" }[] = [];
  const unmatched: string[] = [];
  for (const it of items) {
    const text = fold(it.product);
    const cands = catalog.filter((c) => {
      const sku = fold(c.sku);
      const name = fold(c.productName);
      const label = fold(c.label);
      const bySku = sku.length >= 3 && text.includes(sku) && reply.includes(sku);
      const byLabel = label.length >= 3 && label !== name && text.includes(label) && reply.includes(label);
      const byName = name.length >= 3 && c.productVariantCount === 1 && text.includes(name) && reply.includes(name);
      return bySku || byLabel || byName;
    });
    const unique = [...new Map(cands.map((c) => [c.variantId, c])).values()];
    if (unique.length !== 1 || lines.some((l) => l.variantId === unique[0]!.variantId)) {
      unmatched.push(it.product);
      continue;
    }
    const q = it.quantity !== null && new RegExp(`(^|\\D)${it.quantity}(\\D|$)`).test(replyText) ? it.quantity : null;
    lines.push({ variantId: unique[0]!.variantId, quantity: q ?? unique[0]!.moq, quantityFrom: q ? "EMAIL" : "MOQ" });
  }
  return { lines, unmatched };
}

// ─────────────────────────── CSDL ───────────────────────────

type Cursor = { uidValidity: string; lastUid: number };

async function readCursor(): Promise<Cursor | null> {
  return parseInboundCursor(await getSettingJson<unknown>(EMAIL_INBOUND_CURSOR_KEY, null));
}

/** Mốc UID đã lưu hợp lệ chưa — MỘT luật cho job đọc thư và ops `wholesale-b2b-probe` (đọc CSDL tổ chức bằng handle chỉ đọc). HÀM THUẦN. */
export function parseInboundCursor(raw: unknown): Cursor | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  return typeof o.uidValidity === "string" && typeof o.lastUid === "number" && Number.isInteger(o.lastUid) && o.lastUid >= 0 ? { uidValidity: o.uidValidity, lastUid: o.lastUid } : null;
}

/** Danh mục ghép báo giá: mẫu mã đang bán CÓ bậc ở bảng giá sỉ mặc định; MOQ = bậc nhỏ nhất. */
async function quoteCatalog(customerId: string | null): Promise<CatalogEntry[]> {
  const books = await priceBooksFor(customerId);
  const tiers = [...(books.customerList?.tiers ?? []), ...(books.defaultList?.tiers ?? [])];
  const moq = new Map<string, number>();
  for (const t of tiers) moq.set(t.variantId, Math.min(moq.get(t.variantId) ?? Number.MAX_SAFE_INTEGER, t.minQuantity));
  if (!moq.size) return [];
  const db = await getDb();
  const v = schema.productVariants;
  const p = schema.products;
  const rows = await db
    .select({ id: v.id, sku: v.sku, detail: v.detail, size: v.size, color: v.color, productId: p.id, productName: p.name, removed: v.isRemoved, hidden: v.isHidden })
    .from(v)
    .innerJoin(p, eq(p.id, v.productId))
    .where(and(eq(v.isRemoved, false), eq(p.isRemoved, false)));
  const perProduct = new Map<string, number>();
  for (const r of rows) perProduct.set(r.productId, (perProduct.get(r.productId) ?? 0) + 1);
  return rows
    .filter((r) => moq.has(r.id))
    .map((r) => ({ variantId: r.id, sku: r.sku, productName: r.productName, label: [r.productName, r.detail || [r.size, r.color].filter(Boolean).join(" ")].filter(Boolean).join(" ").trim(), productVariantCount: perProduct.get(r.productId) ?? 1, moq: Math.max(1, moq.get(r.id) ?? 1) }));
}

async function classifySpendToday(now: Date): Promise<{ count: number; costUsd: number; costUnknown: boolean }> {
  const db = await getDb();
  const a = schema.wholesaleLeadActivities;
  const rows = await db
    .select({ cost: sql<string | null>`${a.meta}->>'classifyCostUsd'` })
    .from(a)
    .where(and(gte(a.createdAt, vnStartOfDay(vnDateKey(now))), sql`${a.meta} ? 'replyClass'`));
  return { count: rows.length, costUsd: rows.reduce((s, r) => s + (r.cost === null ? 0 : Number(r.cost)), 0), costUnknown: rows.some((r) => r.cost === null) };
}

const CLASSIFY_SYSTEM = [
  "Bạn phân loại MỘT thư trả lời của khách sỉ gửi cho một nhà cung cấp hải sản. Chỉ đọc thư, không suy đoán ngoài thư.",
  'Trả về DUY NHẤT một JSON: {"class":"INTERESTED|PRICE_REQUEST|DECLINED|UNSUBSCRIBE|OTHER","quote":"<một câu trích NGUYÊN VĂN từ thư làm căn cứ>","items":[{"product":"<tên / mã hàng khách nhắc, chép từ thư>","quantity":<số hoặc null>}]}',
  "INTERESTED = muốn tìm hiểu / gọi lại; PRICE_REQUEST = hỏi giá / xin báo giá / bảng giá; DECLINED = không có nhu cầu; UNSUBSCRIBE = xin ngừng nhận thư; OTHER = khác.",
  "«items» chỉ điền khi PRICE_REQUEST và khách NHẮC CỤ THỂ mặt hàng; không biết số lượng thì null. Câu trích phải chép đúng từng chữ trong thư.",
].join("\n");

export type InboundTickResult = { skipped?: string; scanned: number; matched: number; ignoredAuto: number; ignoredUnrelated: number; duplicate: number; unsubscribed: number; classified: number; quotes: number; error?: string };

async function classifyAndAct(i: { leadId: string; outboxId: string | null; toEmail: string; messageId: string; text: string; settings: EmailInboundSettings; now: Date; ai: AiDeps; out: InboundTickResult }): Promise<void> {
  const db = await getDb();
  const s = i.settings;
  let note = "";
  const meta: Record<string, unknown> = { messageId: i.messageId };
  let cls: ReplyClassification | null = null;
  if (s.aiClassify) {
    const spend = await classifySpendToday(i.now);
    const capHit = spend.count >= (s.dailyMaxClassify as number) ? `chạm trần ${s.dailyMaxClassify} thư / ngày` : spend.costUnknown ? "hôm nay có lượt chưa biết chi phí" : spend.costUsd >= (s.dailyCostCapUsd as number) ? `chạm trần ${s.dailyCostCapUsd} USD / ngày` : null;
    if (capHit) note = `Chưa phân loại AI: ${capHit}.`;
    else {
      const org = await currentOrganization();
      const resolved = i.ai.ai ? ({ ok: true, ...i.ai.ai } as const) : await resolveAi();
      const quota = resolved.ok ? await checkAiQuota(org.code, resolved.source) : null;
      if (!resolved.ok) note = `Chưa phân loại AI: ${resolved.reason}`;
      else if (quota && !quota.ok) note = `Chưa phân loại AI: ${quota.error}`;
      else {
        try {
          const res = await resolved.provider.complete({ system: CLASSIFY_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `THƯ:\n${i.text}` }] }], tools: [], maxTokens: 400, reasoning: "low" });
          const model = res.model || resolved.provider.model;
          const costUsd = estimateCostUsd(model, res.usage);
          await recordAiUsage({ orgCode: org.code, feature: "b2b_email_reply_classify", workload: "lead_hunter", source: resolved.source, provider: resolved.provider.name, model, requests: 1, inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUsd, status: "OK", actorId: null, ref: "reply_classify" }).catch(() => undefined);
          const text = res.content
            .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
            .map((b) => b.text)
            .join("");
          cls = parseClassification(text, i.text);
          meta.replyClass = cls.cls;
          meta.replyQuote = cls.quote;
          meta.evidenceMissing = cls.evidenceMissing;
          meta.classifyCostUsd = costUsd;
          meta.model = model;
          i.out.classified++;
          note = `AI phân loại: ${REPLY_CLASS_LABEL[cls.cls]}${cls.evidenceMissing ? " (AI không đưa được câu trích có thật trong thư — hạ về «Khác»)" : ` — căn cứ: «${cls.quote}»`}.`;
        } catch (e) {
          await recordAiUsage({ orgCode: org.code, feature: "b2b_email_reply_classify", workload: "lead_hunter", source: resolved.source, provider: resolved.provider.name, model: resolved.provider.model, requests: 1, inputTokens: null, outputTokens: null, costUsd: null, status: "ERROR", actorId: null, ref: "reply_classify" }).catch(() => undefined);
          note = `AI phân loại lỗi (${e instanceof Error ? e.message.slice(0, 120) : "không rõ"}).`;
        }
      }
    }
  }
  if (cls?.cls === "UNSUBSCRIBE") {
    const u = await applyEmailUnsubscribe({ leadId: i.leadId, email: i.toEmail, outboxId: i.outboxId, providerEventId: `unsub-reply:${i.messageId}`, via: "REPLY_TEXT", now: i.now });
    if (u.applied) i.out.unsubscribed++;
  }
  if (cls?.cls === "PRICE_REQUEST") {
    const lead = await db.query.wholesaleLeads.findFirst({ where: eq(schema.wholesaleLeads.id, i.leadId) });
    const catalog = await quoteCatalog(lead?.customerId ?? null);
    const match = matchQuoteLines(cls.items, i.text, catalog);
    meta.quoteUnmatched = match.unmatched;
    if (match.lines.length) {
      const org = await currentOrganization();
      const orgName = (await findOrganization(org.code))?.name ?? org.code;
      const validUntil = vnDateKey(new Date(i.now.getTime() + 7 * 86_400_000));
      const moqNote = match.lines.some((l) => l.quantityFrom === "MOQ") ? " Dòng khách chưa nói số lượng: lấy MOQ của bảng giá sỉ." : "";
      const q = await createQuotationDraftByMachine(
        { leadId: i.leadId, lines: match.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), validUntil, notes: `Nháp máy lập từ thư hỏi giá ${i.messageId}.${moqNote} Người phụ trách kiểm rồi gửi.`.slice(0, 2000), requestKey: `inbound:${i.messageId}`.slice(0, 100) },
        orgName,
        i.now,
      );
      if ("ok" in q) {
        meta.quotationId = q.id;
        i.out.quotes++;
        note += ` Đã lập NHÁP báo giá ${q.code} (${match.lines.length} dòng) — chưa gửi.`;
      } else note += ` Chưa lập được nháp báo giá: ${q.error}`;
    } else note += " Không ghép được mẫu mã nào khách hỏi (hoặc mẫu mã chưa có giá sỉ) — lập báo giá tay.";
    if (match.unmatched.length) note += ` Chưa ghép: ${match.unmatched.slice(0, 5).join(" · ")}.`;
  }
  if (!note) return;
  await db.insert(schema.wholesaleLeadActivities).values({ leadId: i.leadId, kind: "OUTREACH", channel: "EMAIL", outcome: cls ? cls.cls : null, note: note.trim().slice(0, 2000), meta, actorId: null, actorName: "Máy (hộp thư bán sỉ)", createdAt: i.now });
}

/**
 * MỘT lượt đọc hộp thư. `reader` / `ai` chỉ để bài kiểm tiêm IMAP giả + AI giả. Không bật / chưa có kết nối ⇒ bỏ qua, không mở
 * kết nối nào.
 */
export async function runEmailInboundTick(opts: { now?: Date; reader?: MailboxReaderFactory; ai?: AiDeps } = {}): Promise<InboundTickResult> {
  const now = opts.now ?? new Date();
  const out: InboundTickResult = { scanned: 0, matched: 0, ignoredAuto: 0, ignoredUnrelated: 0, duplicate: 0, unsubscribed: 0, classified: 0, quotes: 0 };
  const settings = await getEmailInboundSettings();
  if (!settings.enabled) return { ...out, skipped: "DISABLED" };
  const conn = await openActiveConnection("gws-smtp");
  if (!conn.ok) return { ...out, skipped: `Kết nối Google Workspace chưa sẵn sàng: ${conn.reason}` };
  const creds = smtpCredentialsOf(conn.secrets, conn.settings);
  if ("error" in creds) return { ...out, skipped: creds.error };
  const reader = (opts.reader ?? imapflowReader)(creds);
  try {
    const box = await reader.open();
    let cursor = await readCursor();
    if (!cursor || cursor.uidValidity !== box.uidValidity) {
      const db = await getDb();
      const o = schema.wholesaleEmailOutbox;
      const [first] = await db.select({ at: sql<Date | null>`min(${o.sentAt})` }).from(o).where(and(eq(o.status, "SENT"), eq(o.mode, "LIVE")));
      const floor = new Date(now.getTime() - INBOUND_FIRST_RUN_DAYS * 86_400_000);
      const firstSent = first?.at ? new Date(first.at) : null;
      const since = firstSent ? (firstSent > floor ? firstSent : floor) : null;
      const startUid = since ? await reader.firstUidSince(since) : null;
      cursor = { uidValidity: box.uidValidity, lastUid: startUid ? startUid - 1 : Math.max(0, box.uidNext - 1) };
      await setSettingJson(EMAIL_INBOUND_CURSOR_KEY, cursor);
    }
    const headers = await reader.headersAfter(cursor.lastUid, INBOUND_BATCH);
    for (const h of headers) {
      out.scanned++;
      if (isAutomatedReply(h)) out.ignoredAuto++;
      else if (!h.messageId) out.ignoredUnrelated++;
      else {
        const found = await findInboundTarget({ inReplyTo: h.inReplyTo, references: h.references, from: h.from });
        if ("reason" in found) out.ignoredUnrelated++;
        else {
          const body = await reader.body(h.uid, INBOUND_BODY_MAX_BYTES);
          const text = redactInboundText(stripQuotedReply(body.text)).slice(0, INBOUND_SNIPPET_MAX);
          const r = await ingestInboundEmail({ messageId: h.messageId, inReplyTo: h.inReplyTo, references: h.references, from: h.from ?? "", subject: h.subject, text: body.attachments ? `${text}\n\n[${body.attachments} tệp đính kèm — ERP không tải]` : text, autoSubmitted: h.autoSubmitted, receivedAt: h.date ?? now }, now);
          if (r.status === "DUPLICATE") out.duplicate++;
          else if (r.status === "MATCHED") {
            out.matched++;
            const messageId = h.messageId;
            if (textUnsubscribeIntent(text)) {
              const u = await applyEmailUnsubscribe({ leadId: r.leadId, email: normalizeEmail(found.target.toEmail) ?? found.target.toEmail, outboxId: r.outboxId, providerEventId: `unsub-reply:${messageId}`, via: "REPLY_TEXT", now });
              if (u.applied) out.unsubscribed++;
            } else await classifyAndAct({ leadId: r.leadId, outboxId: r.outboxId, toEmail: found.target.toEmail, messageId, text, settings, now, ai: opts.ai ?? {}, out });
          } else out.ignoredUnrelated++;
        }
      }
      cursor = { uidValidity: box.uidValidity, lastUid: Math.max(cursor.lastUid, h.uid) };
      await setSettingJson(EMAIL_INBOUND_CURSOR_KEY, cursor);
    }
    return out;
  } catch (e) {
    if (isMissingEmailTable(e)) return { ...out, skipped: "CSDL chưa áp 0264" };
    return { ...out, error: maskSecret(e instanceof Error ? e.message : String(e), creds.pass).slice(0, 300) };
  } finally {
    await reader.close();
  }
}

/** Câu hỏi rẻ trước khi mở khoá / ghi sổ: đã bật đọc hộp thư chưa. */
export async function emailInboundEnabled(): Promise<boolean> {
  return (await getEmailInboundSettings()).enabled;
}

export type InboundJobOutcome = { skipped: string; detail: string } | (InboundTickResult & { detail: string });

/** Vỏ job: chạy KÈ lượt `wholesale-leads` (không đổi lịch chung), khoá riêng `wholesale-email-inbound`, ghi `sync_runs`. */
export async function runEmailInboundJob(o: { trigger: SyncTrigger; actor: string }, opts: { now?: Date; reader?: MailboxReaderFactory; ai?: AiDeps } = {}): Promise<InboundJobOutcome> {
  if (!(await emailInboundEnabled())) return { skipped: "DISABLED", detail: "Đọc hộp thư đang TẮT." };
  const r = await runSyncJob({ source: "ERP", job: "wholesale-email-inbound", trigger: o.trigger, actor: o.actor, observeOnly: true }, async (ctx) => {
    const t = await runEmailInboundTick(opts);
    const detail = t.skipped ?? `Hộp thư: ${t.scanned} thư mới · ${t.matched} thư trả lời · ${t.unsubscribed} xin huỷ · ${t.classified} AI phân loại · ${t.quotes} nháp báo giá · bỏ ${t.ignoredAuto} thư tự động + ${t.ignoredUnrelated} thư không liên quan${t.error ? ` · LỖI: ${t.error}` : ""}`;
    ctx.summary.imported = t.matched;
    ctx.summary.skipped = t.ignoredAuto + t.ignoredUnrelated + t.duplicate;
    ctx.summary.failed = t.error ? 1 : 0;
    ctx.summary.detail = detail;
    if (t.error) ctx.summary.warning = t.error;
    return { ...t, detail };
  });
  if (r.skippedBecauseRunning) return { skipped: "RUNNING", detail: "Lượt đọc trước còn đang chạy." };
  return r.result ?? { skipped: "IDLE", detail: "Lượt không trả kết quả." };
}
