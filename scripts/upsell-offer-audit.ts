/*
  ops `upsell-offer-audit` — ĐO LỜI MỜI MUA THÊM CỦA BOT BÁN HÀNG MỘT TỔ CHỨC (CHỈ ĐỌC) — P0 #868, chủ shop 16/10/2026.

  Vì sao có: chủ shop GIỮ upsell / cross-sell nhưng đòi nó thông minh — không chặn / làm chậm đơn hợp lệ, không mời lặp, không mời lại
  sau khi khách từ chối, không hỏi lại «1kg hay 2kg» khi khách đã chọn. Bản sửa (`lib/sales-chatbot/next-best-action.ts`) có đúng không
  chỉ trả lời được bằng số TRƯỚC / SAU — script này in cả hai nhóm số cho một kỳ (`--days` hoặc `--since=<mốc deploy>`):

   1. PHỄU + TIỀN (dùng lại `loadAiSalesPerformance` — performance.ts, sổ `sales_conversation_events`, MỘT công thức với màn «Hiệu
      quả»): hội thoại · đơn nháp · đơn chốt · tỷ lệ chốt (nháp → chốt) · AOV đơn bot chốt · upsell.offered / accepted / attach rate.
      Trước bản sửa `upsell.offered` chỉ đếm câu mẫu UPSELL; từ bản sửa đếm cả lời mời trong chữ bot mà máy chủ nhận ra.
   2. LỜI MỜI ĐỌC TỪ CHỮ ĐÃ GỬI (`sales_chat_messages`, cùng bộ phân loại câu của máy chủ — `classifySentence`): số lời mời · hội thoại
      bị mời ≥ 2 lần · lời mời SAU khi khách từ chối · mời gói lớn hơn SAU khi khách đã chọn khối lượng · hỏi lại «1kg hay 2kg» sau khi
      đã chọn · hội thoại có lời mời rồi kết thúc huỷ / từ chối. Phần này là ƯỚC LƯỢNG (bộ phân loại theo chữ — ESTIMATED), và chạy được
      trên dữ liệu TRƯỚC bản sửa, nên so được.
   3. LỜI MỜI MÁY CHỦ ĐÃ BỎ (`state.offerDrops`, chỉ có từ bản sửa) theo lý do.

  KHÔNG in tên, SĐT, địa chỉ, chữ tin, mã hội thoại ở phần tóm tắt. [ops:tom-tat] chỉ là số. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`
  trước lần mở kết nối đầu tiên + hỏi lại phiên); hàm lib đọc qua `getDb()` chạy trên handle CHỈ ĐỌC gắn cho tổ chức rồi
  `withOrganization` (cùng cách scripts/conv-money-trace.ts).

  arg: `<mã tổ chức> [--days=1..90 | --since=<ISO UTC>]` (mặc định 7 ngày).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("upsell-offer-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, gte, inArray, ne, sql } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { withOrganization } from "@/lib/platform/context";
import { findOrganization } from "@/lib/platform/organizations";
import { amountsIn, classifyCartMessage } from "@/lib/sales-chatbot/cart-commitment";
import { classifySentence, OFFER_BLOCK_LABEL, OFFER_BLOCKS, offerDeclinedBy, splitSentences, type OfferBlock } from "@/lib/sales-chatbot/next-best-action";
import { loadAiSalesPerformance } from "@/lib/sales-chatbot/performance";
import type { ChatState } from "@/lib/sales-chatbot/tools";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);
const vnd = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("vi-VN")} ₫` : "—");
const pct = (n: number | null | undefined) => (typeof n === "number" && Number.isFinite(n) ? `${(n * 100).toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%` : "—");

export const AUDIT_DEFAULT_DAYS = 7;
export const AUDIT_MAX_DAYS = 90;
export const AUDIT_MAX_CONVERSATIONS = 5000;
/** Tiền tố tin page / nhân viên trong lịch sử bot (engine.ts SHOP_SAID) — không phải chữ bot, không đếm. */
const SHOP_SAID = "[Shop đã nhắn]";
const USAGE = `<mã tổ chức> [--days=1..${AUDIT_MAX_DAYS} | --since=<ISO UTC>]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type AuditArgs = { code: string; days: number; since?: Date };

export function parseAuditArgs(argv: readonly string[]): AuditArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const rawDays = val("days");
  const days = rawDays === undefined ? AUDIT_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > AUDIT_MAX_DAYS) return { error: `--days phải là số nguyên 1..${AUDIT_MAX_DAYS}` };
  const rawSince = val("since");
  if (rawSince === undefined) return { code, days };
  const since = new Date(rawSince);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(rawSince) || Number.isNaN(since.getTime())) return { error: "--since phải là mốc UTC dạng 2026-10-16T08:10Z" };
  return { code, days, since };
}

type Block = { type?: unknown; text?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
const deliveredOf = (content: unknown): string[] =>
  blocksOf(content).flatMap((b) => {
    if (b.type !== "tool_result" || typeof b.content !== "string") return [];
    try {
      const d = (JSON.parse(b.content) as { __deliver?: unknown }).__deliver;
      return typeof d === "string" && d.trim() ? [d] : [];
    } catch {
      return [];
    }
  });

/** `crossSells` = số lời mời có câu mời MÓN KHÁC (CROSS_SELL) — phần còn lại chỉ là mời gói lớn hơn của cùng món (UPSELL). */
/**
 * `priceAnswers` = lời mời nằm trong tin bot trả lời NGAY sau một tin khách HỎI GIÁ (`askedPrice` = `customerAskedPrice` — cùng phép đọc của
 * guardReply, vốn GIỮ câu giá khi khách hỏi giá): không tính là «lặp» / «gói lớn sau khi đã chọn», nhưng đếm RIÊNG (`upsellAfterSizePrice`),
 * không biến mất (production 20/10/2026: khách hỏi lại «xin giá chả cá thu» 40′ sau khi chốt, câu mẫu bảng giá bị đếm thành lời mời thứ hai).
 */
export type ConvOffers = { offers: number; crossSells: number; afterDecline: number; upsellAfterSize: number; reaskAfterSize: number; endedCancelled: boolean; priceAnswers: number; upsellAfterSizePrice: number };

/**
 * Lời mời của MỘT hội thoại đọc từ chữ ĐÃ GỬI (theo seq). Một tin bot có nhiều câu mời vẫn là MỘT lời mời (khách nhận một lần). Từ chối =
 * tin khách NGAY SAU một lời mời mà `offerDeclinedBy`. «Đã chọn khối lượng» = tin khách đặt / sửa số lượng tường minh (`classifyCartMessage`
 * ORDER · SET · ADD có lượng). HÀM THUẦN.
 */
export function offersOfConversation(
  msgs: readonly { role: string; content: unknown }[],
  state: Pick<ChatState, "declined" | "cancelRequest" | "cancelledOrders">,
  opts: { askedPrice?: (text: string) => boolean } = {},
): ConvOffers {
  const out: ConvOffers = { offers: 0, crossSells: 0, afterDecline: 0, upsellAfterSize: 0, reaskAfterSize: 0, endedCancelled: false, priceAnswers: 0, upsellAfterSizePrice: 0 };
  let declined = false;
  // Tin khách gần nhất HỎI GIÁ ⇒ mọi tin bot tới tin khách kế tiếp là câu TRẢ LỜI giá.
  let priceAsk = false;
  let sizeChosen = false;
  let awaiting = false;
  const botSaid = (t: string) => {
    if (!t || t.startsWith(SHOP_SAID)) return;
    const kinds = splitSentences(t).map(classifySentence);
    if (sizeChosen && kinds.includes("SIZE_REASK")) out.reaskAfterSize += 1;
    if (!kinds.some((k) => k === "UPSELL" || k === "CROSS_SELL")) return;
    out.offers += 1;
    // Chỉ tin TOÀN là mời gói lớn hơn cùng món (UPSELL) mới là trả lời câu hỏi giá — guardReply chỉ miễn UPSELL khi khách hỏi giá. Tin
    // có câu MỜI MÓN KHÁC (CROSS_SELL) là lời mời THẬT dù khách vừa hỏi giá (nghiệm thu 20/10/2026: «Dạ chả cá thu 1kg 280k ạ. Bên em
    // còn nem hải sản ăn kèm…» từng bị đếm thành trả lời giá ⇒ che mất lời mời thật khỏi «lặp»).
    const priceAnswer = priceAsk && !kinds.includes("CROSS_SELL");
    if (priceAnswer) out.priceAnswers += 1;
    if (kinds.includes("CROSS_SELL")) out.crossSells += 1;
    if (declined) out.afterDecline += 1;
    if (sizeChosen && kinds.includes("UPSELL")) {
      if (priceAnswer) out.upsellAfterSizePrice += 1;
      else out.upsellAfterSize += 1;
    }
    awaiting = true;
  };
  for (const m of msgs) {
    if (m.role === "assistant") {
      botSaid(textOf(m.content));
      continue;
    }
    for (const d of deliveredOf(m.content)) botSaid(d);
    const t = blocksOf(m.content).some((b) => b.type === "tool_result") ? "" : textOf(m.content);
    if (!t) continue;
    priceAsk = opts.askedPrice ? opts.askedPrice(t) : false;
    if (awaiting && offerDeclinedBy(t)) declined = true;
    awaiting = false;
    const intent = classifyCartMessage(t);
    if (["ORDER", "SET", "ADD"].includes(intent.kind) && amountsIn(t).length > 0) sizeChosen = true;
  }
  out.endedCancelled = out.offers > 0 && Boolean(state.declined || state.cancelRequest || state.cancelledOrders?.length);
  return out;
}

export type OfferTotals = { conversations: number; withOffer: number; offers: number; repeated: number; repeatedPriceOnly: number; upsellAfterSizePrice: number; repeatedWithPost: number; repeatedCrossSell: number; afterDecline: number; upsellAfterSize: number; reaskAfterSize: number; cancelledAfterOffer: number; drops: Record<OfferBlock, number> };

export function emptyTotals(): OfferTotals {
  return { conversations: 0, withOffer: 0, offers: 0, repeated: 0, repeatedPriceOnly: 0, upsellAfterSizePrice: 0, repeatedWithPost: 0, repeatedCrossSell: 0, afterDecline: 0, upsellAfterSize: 0, reaskAfterSize: 0, cancelledAfterOffer: 0, drops: Object.fromEntries(OFFER_BLOCKS.map((k) => [k, 0])) as Record<OfferBlock, number> };
}

/**
 * Cộng một hội thoại vào tổng. `drops` = `state.offerDrops` trong kỳ. `postSent` = lời mời SAU CHỐT đã tới khách trong kỳ — tách «mời ≥ 2
 * lần» ra phần có lời mời sau chốt (production 19/10/2026: con số lặp có đổi vì nguồn lời mời MỚI hay không) và phần ≥ 2 lời mời MÓN KHÁC
 * (cùng món, gói lớn hơn — vd câu mẫu báo giá «2kg giảm còn 540k» — không phải mời thêm món). HÀM THUẦN.
 */
export function addConversation(t: OfferTotals, c: ConvOffers, drops: readonly { reason: string }[], postSent = false): OfferTotals {
  t.conversations += 1;
  if (c.offers > 0) t.withOffer += 1;
  // Lời mời của CHÍNH bot (không tính câu trả lời câu hỏi giá); hội thoại chỉ «lặp» nhờ câu trả lời giá ⇒ đếm riêng.
  const own = c.offers - c.priceAnswers;
  if (own >= 2) t.repeated += 1;
  if (c.offers >= 2 && own < 2) t.repeatedPriceOnly += 1;
  if (own >= 2 && postSent) t.repeatedWithPost += 1;
  t.upsellAfterSizePrice += c.upsellAfterSizePrice;
  if (c.crossSells >= 2) t.repeatedCrossSell += 1;
  t.offers += c.offers;
  t.afterDecline += c.afterDecline;
  t.upsellAfterSize += c.upsellAfterSize;
  t.reaskAfterSize += c.reaskAfterSize;
  if (c.endedCancelled) t.cancelledAfterOffer += 1;
  for (const d of drops) if ((OFFER_BLOCKS as readonly string[]).includes(d.reason)) t.drops[d.reason as OfferBlock] += 1;
  return t;
}

/**
 * 4. LỜI MỜI SAU CHỐT (P0 19/10/2026 — `state.postConfirmOffer`, chỉ có từ bản sửa): lượt chốt có quyết định · mời đã gửi · không mời theo
 * lý do · nhận (đơn đã chốt được sửa thêm đúng món được mời) · tiền thêm · khách xin huỷ / huỷ đơn SAU lời mời. HÀM THUẦN.
 */
/**
 * `bySource` (P0 20/10/2026): lời mời ĐÃ GỬI theo nguồn — `SHOP_TEMPLATE` (câu upsell shop cài) · `AUTO_GENERATED` (bot tự soạn, shop bật)
 * · `LEGACY` (ghi trước bản điều phối, chưa có trường nguồn). `withImages` = lời mời câu mẫu có ảnh giao cho kênh gửi.
 * Lời mời đã quyết mà không gửi được ⇒ khoá `NOT_SENT:<lý do>` trong `notOffered`.
 */
export type PostConfirmTotals = { decided: number; offered: number; notOffered: Record<string, number>; accepted: number; acceptedAmount: number; cancelAfterOffer: number; bySource: Record<"SHOP_TEMPLATE" | "AUTO_GENERATED" | "LEGACY", number>; withImages: number };
export function emptyPostConfirm(): PostConfirmTotals {
  return { decided: 0, offered: 0, notOffered: {}, accepted: 0, acceptedAmount: 0, cancelAfterOffer: 0, bySource: { SHOP_TEMPLATE: 0, AUTO_GENERATED: 0, LEGACY: 0 }, withImages: 0 };
}
export function addPostConfirm(t: PostConfirmTotals, st: Pick<ChatState, "postConfirmOffer" | "cancelRequest" | "cancelledOrders">, from: Date): PostConfirmTotals {
  const p = st.postConfirmOffer;
  if (!p || !(Date.parse(p.at) >= from.getTime())) return t;
  t.decided += 1;
  if (p.outcome === "OFFERED" && p.sent) {
    t.offered += 1;
    t.bySource[p.source ?? "LEGACY"] += 1;
    if (p.imageStatus === "QUEUED") t.withImages += 1;
    if (p.accepted) {
      t.accepted += 1;
      t.acceptedAmount += p.accepted.amount;
    }
    const after = (at: string | undefined) => Boolean(at && Date.parse(at) > Date.parse(p.at));
    const cr = st.cancelRequest as { at?: string } | undefined;
    if (after(cr?.at) || (st.cancelledOrders ?? []).some((c) => after(c.at))) t.cancelAfterOffer += 1;
  } else {
    const k = p.outcome === "OFFERED" || p.outcome === "NOT_SENT" ? `NOT_SENT${p.notSentReason ? `:${p.notSentReason}` : ""}` : p.outcome;
    t.notOffered[k] = (t.notOffered[k] ?? 0) + 1;
  }
  return t;
}

// ─────────────────────────── ĐỌC ───────────────────────────

type DbHolder = { __erpDb?: { orgs?: Map<string, { db?: Db }> } };
/** Handle CHỈ ĐỌC cho tổ chức (cùng cách scripts/conv-money-trace.ts) — hàm lib dùng `getDb()` đọc qua handle này. */
async function bindReadOnlyOrgHandle(org: { code: string; isHome: boolean }, db: Db): Promise<void> {
  if (org.isHome) return;
  const holder = (globalThis as unknown as DbHolder).__erpDb;
  if (!holder || typeof holder !== "object") throw new Error("Không thấy sổ handle CSDL của db/index.ts — dừng.");
  const orgs = (holder.orgs ??= new Map());
  if (!(orgs instanceof Map)) throw new Error("Sổ handle CSDL tổ chức đổi cấu trúc — dừng.");
  if (!orgs.get(org.code)?.db) orgs.set(org.code, { db });
}

/** Lời mời của mọi hội thoại có tin trong kỳ (trừ khung thử). */
/** Mẫu MÃ hội thoại (≤ AUDIT_SAMPLE_MAX mỗi nhóm) để lần vết bằng `conv-money-trace --conv` — CHỈ in ở phần MÃ HOÁ, không vào kênh tóm tắt công khai. */
export const AUDIT_SAMPLE_MAX = 20;
export type AuditSamples = { repeated: string[]; afterDecline: string[]; upsellAfterSize: string[]; reaskAfterSize: string[] };
/** Thêm mã hội thoại vào nhóm sai lúc / lặp của nó. HÀM THUẦN. */
export function addSamples(s: AuditSamples, id: string, c: ConvOffers): AuditSamples {
  const put = (k: keyof AuditSamples, yes: boolean) => {
    if (yes && s[k].length < AUDIT_SAMPLE_MAX) s[k].push(id);
  };
  put("repeated", c.offers - c.priceAnswers >= 2);
  put("afterDecline", c.afterDecline > 0);
  put("upsellAfterSize", c.upsellAfterSize > 0);
  put("reaskAfterSize", c.reaskAfterSize > 0);
  return s;
}

export async function auditOffers(db: Db, from: Date): Promise<OfferTotals & { post: PostConfirmTotals; samples: AuditSamples; priceRule: boolean }> {
  // Phép đọc «khách hỏi giá» của guardReply — ops lấy script từ MAIN nhưng lib từ ẢNH ĐANG CHẠY ⇒ import động; ảnh chưa có ⇒ không loại gì
  // và in «CHƯA ĐO ĐƯỢC» (không giả vờ đã tách).
  const nba = (await import("@/lib/sales-chatbot/next-best-action")) as Record<string, unknown>;
  const askedPrice = typeof nba.customerAskedPrice === "function" ? (nba.customerAskedPrice as (text: string) => boolean) : undefined;
  const c = schema.salesChatConversations;
  const m = schema.salesChatMessages;
  const convs = await db.select({ id: c.id, state: c.state }).from(c).where(and(ne(c.channel, "TEST"), gte(c.updatedAt, from))).limit(AUDIT_MAX_CONVERSATIONS);
  const totals = emptyTotals();
  const post = emptyPostConfirm();
  const samples: AuditSamples = { repeated: [], afterDecline: [], upsellAfterSize: [], reaskAfterSize: [] };
  for (const conv of convs) addPostConfirm(post, (conv.state ?? {}) as ChatState, from);
  for (let i = 0; i < convs.length; i += 200) {
    const batch = convs.slice(i, i + 200);
    const rows = await db.select({ conv: m.conversationId, role: m.role, content: m.content }).from(m).where(and(inArray(m.conversationId, batch.map((x) => x.id)), gte(m.createdAt, from))).orderBy(asc(m.conversationId), asc(m.seq));
    const byConv = new Map<string, { role: string; content: unknown }[]>();
    for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), { role: r.role, content: r.content }]);
    for (const conv of batch) {
      const msgs = byConv.get(conv.id);
      if (!msgs?.some((x) => x.role === "user" && textOf(x.content))) continue;
      const st = (conv.state ?? {}) as ChatState;
      // `offerDrops` mang lượt, không mang mốc giờ — hội thoại có hoạt động trong kỳ thì tính cả lượt mua hiện tại của nó.
      const pco = st.postConfirmOffer;
      const postSent = Boolean(pco?.sent && pco.outcome === "OFFERED" && Date.parse(pco.at) >= from.getTime());
      const offers = offersOfConversation(msgs, st, { askedPrice });
      addConversation(totals, offers, st.offerDrops ?? [], postSent);
      addSamples(samples, conv.id, offers);
    }
  }
  return { ...totals, post, samples, priceRule: Boolean(askedPrice) };
}

async function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`upsell-offer-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`upsell-offer-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.stdout.write("", () => process.exit(1));
    return;
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("upsell-offer-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.stdout.write("", () => process.exit(70));
    return;
  }
  await bindReadOnlyOrgHandle({ code: org.code, isHome: org.isHome }, db);
  const now = new Date();
  const from = args.since ?? new Date(now.getTime() - args.days * 86_400_000);
  const perfDays = args.since ? Math.max(1, Math.ceil((now.getTime() - args.since.getTime()) / 86_400_000)) : args.days;
  await withOrganization(org.code, async () => {
    const perf = await loadAiSalesPerformance(org.code, { days: perfDays, now, withMoney: false });
    const f = perf.cohorts.total;
    const span = args.since ? `từ ${args.since.toISOString()}` : `${args.days} ngày`;
    tomTat(`upsell-offer-audit ${span} · phễu ${perfDays} ngày VN (sổ sự kiện, đo từ ${perf.measuredSince?.toISOString().slice(0, 10) ?? "—"})`);
    tomTat(`PHỄU: ${f.conversations} hội thoại · nháp ${f.drafted} · chốt ${f.confirmed} · nháp→chốt ${pct(f.drafted ? f.confirmed / f.drafted : null)} · đơn bot chốt ${perf.orders.confirmed} · AOV ${vnd(perf.economics.aovVnd)}`);
    tomTat(`UPSELL (sổ sự kiện): mời ${perf.upsell.offered} · nhận ${perf.upsell.accepted} · không nhận ${perf.upsell.declined} · attach ${pct(perf.upsell.attachRate)} · tiền mua thêm ${vnd(perf.upsell.revenueVnd)}`);
    const t = await auditOffers(db, from);
    tomTat(`LỜI MỜI ĐÃ GỬI (ESTIMATED, đọc chữ): ${t.conversations} hội thoại · có mời ${t.withOffer} · tổng lời mời ${t.offers} · hội thoại bị mời ≥ 2 lần ${t.repeated}`);
    tomTat(`LẶP (ESTIMATED): mời ≥ 2 lần ${t.repeated} hội thoại · trong đó có lời mời sau chốt ${t.repeatedWithPost} · ≥ 2 lời mời MÓN KHÁC ${t.repeatedCrossSell} (phần còn lại chỉ là mời gói lớn hơn cùng món)`);
    tomTat(t.priceRule ? `TRẢ LỜI CÂU HỎI GIÁ (KHÔNG tính vào hai dòng trên / dưới): hội thoại chỉ «lặp» nhờ câu trả lời giá ${t.repeatedPriceOnly} · «gói lớn sau khi đã chọn» là trả lời câu hỏi giá ${t.upsellAfterSizePrice}` : "TRẢ LỜI CÂU HỎI GIÁ: CHƯA ĐO ĐƯỢC — ảnh đang chạy chưa có customerAskedPrice; «lặp» / «gói lớn» vẫn đếm cả câu trả lời giá");
    tomTat(`SAI LÚC: mời sau khi khách từ chối ${t.afterDecline} · mời gói lớn sau khi đã chọn khối lượng ${t.upsellAfterSize} · hỏi lại «1kg hay 2kg» sau khi đã chọn ${t.reaskAfterSize} · có mời rồi huỷ / từ chối ${t.cancelledAfterOffer} hội thoại`);
    const drops = OFFER_BLOCKS.filter((k) => t.drops[k] > 0).map((k) => `${k} ${t.drops[k]}`);
    tomTat(`MÁY CHỦ ĐÃ BỎ (state.offerDrops, từ bản #868): ${drops.join(" · ") || "0"}`);
    for (const k of OFFER_BLOCKS) if (t.drops[k] > 0) console.log(`  ${k}: ${OFFER_BLOCK_LABEL[k]} — ${t.drops[k]}`);
    // Mẫu mã hội thoại để lần vết (`conv-money-trace --conv=<mã>`) — phần MÃ HOÁ, không phải tóm tắt công khai.
    const mau = (k: keyof AuditSamples) => t.samples[k].join(" ") || "—";
    console.log(`  mẫu mời ≥ 2 lần (≤ ${AUDIT_SAMPLE_MAX}): ${mau("repeated")}`);
    console.log(`  mẫu mời sau khi khách từ chối: ${mau("afterDecline")}`);
    console.log(`  mẫu mời gói lớn sau khi đã chọn khối lượng: ${mau("upsellAfterSize")}`);
    console.log(`  mẫu hỏi lại «1kg hay 2kg» sau khi đã chọn: ${mau("reaskAfterSize")}`);
    // 4. Lời mời SAU CHỐT (P0 19/10/2026). AOV tăng thêm = tiền thêm / lượt chốt có quyết định. Lãi gộp thêm: CHƯA ĐO — sổ không giữ giá
    // vốn theo dòng của món thêm sau chốt (giá vốn sống đọc ở báo cáo lợi nhuận); in «—», không đoán.
    const p = t.post;
    const lyDo = Object.entries(p.notOffered).map(([k, n]) => `${k} ${n}`).join(" · ") || "0";
    tomTat(`SAU CHỐT: lượt chốt có quyết định ${p.decided} · mời đã gửi ${p.offered} (${pct(p.decided ? p.offered / p.decided : null)}) · không mời: ${lyDo}`);
    tomTat(`SAU CHỐT nguồn lời mời đã gửi: câu upsell shop ${p.bySource.SHOP_TEMPLATE} (kèm ảnh ${p.withImages}) · bot tự soạn ${p.bySource.AUTO_GENERATED} · trước bản điều phối ${p.bySource.LEGACY}`);
    tomTat(`SAU CHỐT kết quả: nhận ${p.accepted} · attach ${pct(p.offered ? p.accepted / p.offered : null)} · tiền thêm ${vnd(p.acceptedAmount)} · AOV tăng thêm ${vnd(p.decided ? p.acceptedAmount / p.decided : null)} · xin huỷ / huỷ sau lời mời ${p.cancelAfterOffer} · lãi gộp thêm —`);
  });
  process.stdout.write("", () => process.exit(0));
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("upsell-offer-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("upsell-offer-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.stdout.write("", () => process.exit(1));
  });
}
