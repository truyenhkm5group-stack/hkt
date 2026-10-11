/*
  ops `sales-integrity-audit` — AI BÁN HÀNG CÓ BÁO SAI GIÁ / XÁC NHẬN GIẢ / BỎ RƠI KHÁCH KHÔNG, ĐO TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (P0 11/10/2026, chủ shop HSLC): bot báo «2kg = 540.000 ₫» rồi «2kg = 560.000 ₫» trong cùng hội thoại, đơn nháp
  2 × 280.000; hội thoại «Đã xác nhận» và bot nói «đã lên đơn» khi đơn còn CẦN XÁC THỰC (địa chỉ chưa ghép xã / phường); khách
  nhắn tiếp thì chuyển người mà không ai nhận; đơn ĐÃ XÁC NHẬN (KimThu Le, #71B31FE3) vẫn bị nhắn «xác nhận / tiếp tục chốt đơn».
  Script đo PHẠM VI của từng lỗi trong N ngày và tìm ca chủ shop báo. Phân loại là hàm THUẦN ở
  `lib/sales-chatbot/integrity-audit.ts` (để /platform/saas dùng lại CÙNG định nghĩa); câu «đã chốt» đọc bằng `detectClaims`
  của hàng rào claim-guard.ts.

  Thước đo (mỗi dòng in mức tin cậy MEASURED / ESTIMATED; null = CHƯA ĐO ĐƯỢC, không phải 0):
   a  giá bot ↔ giá đơn — câu bot CÓ báo giá gần nhất trước mốc lên đơn so với tổng đơn / tiền hàng theo dòng;
   a2 «2kg» hai cách biểu diễn (gói 2kg vs 2 × gói 1kg) + cặp «bot báo X ⇒ đơn Y» cho đơn 2kg;
   b  giá tự đổi — cùng khối lượng, bot báo hai tổng khác nhau trong một hội thoại;
   c  xác nhận giả — câu bot khẳng định đã chốt / đã lên đơn mà tại mốc tin: chưa có đơn · đơn nháp · đơn có cờ cần kiểm ·
      đơn thiếu ô; + trạng thái HÔM NAY (đã sửa / còn treo / đã huỷ);
   c2 SĐT có trong lịch sử tin khách mà hồ sơ / hội thoại không có SĐT (phạm vi lỗi tìm kiếm hộp thư);
   d  chuyển người không ai nhận sau 1h / 4h / 24h (bản chặt: dấu vết người trong ERP; bản nới: + tin phía page);
   e  địa chỉ có chữ mà chưa ghép tỉnh / xã, theo lý do (bộ chuẩn hoá địa giới 2025 của lõi ghi đơn);
   f  mất doanh thu sau lỗi (ESTIMATED);
   h  tin nhắc gửi khách SAU khi đơn đã chốt, theo nguồn gửi (job nhắc của ERP · AI chủ động · phía page).

  arg: `<mã tổ chức> [--days=1..60] [--find-name=<chuỗi>[,<chuỗi>]] [--conv=<uuid>]`. Ô arg của ops chỉ nhận chữ không dấu và
  tách theo khoảng trắng ⇒ viết tên bằng `_` hoặc `.` («--find-name=nguyen_thanh_thuy,kimthu_le»); từ rời sau cờ cũng được nối vào.
  Kênh [ops:tom-tat] chỉ số đếm / tiền tổng / tỷ lệ (+ mã hội thoại / mã đơn khi tìm theo tên) — KHÔNG tên, SĐT, địa chỉ, chữ
  tin. Mã hội thoại theo từng lỗi và dòng thời gian `--conv` chỉ ở phần MÃ HOÁ. CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1`).
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("sales-integrity-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, eq, gte, inArray, sql, type SQL } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { orderReviewLogOf, orderReviewOf } from "@/lib/constants/order-review";
import { findOrganization } from "@/lib/platform/organizations";
import { detectClaims } from "@/lib/sales-chatbot/claim-guard";
import { MEDIA_ONLY_NOTE, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import {
  ADDRESS_ISSUE_GAP,
  ADDRESS_ISSUE_LABEL,
  classifyAddress,
  compareQuoteToOrder,
  currentFix,
  extractVndAmounts,
  falseConfirmKind,
  gapsOf,
  handoffBuckets,
  handoffResponseAt,
  isConfirmNudge,
  lineGrams,
  lostSaleOf,
  nameMatches,
  OWNER_CASE_AMOUNTS,
  orderMoneyOf,
  orderReferenceAmounts,
  orderStateAt,
  orderWeightShape,
  postOrderOutbound,
  priceDrifts,
  quotePoints,
  rateText,
  vndText,
  type AddressIssue,
  type BotText,
  type FaultKind,
  type HandoffEvidence,
  type OrderFact,
  type OrderMoney,
  type OutboundMsg,
  type QuoteVsOrder,
  type ReviewSpan,
  type WeightShape,
} from "@/lib/sales-chatbot/integrity-audit";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const INTEGRITY_DEFAULT_DAYS = 30;
export const INTEGRITY_MAX_DAYS = 60;
/** Trần hội thoại đọc ở chế độ cửa sổ — đủ cho một shop, có trần để không quét vô hạn. */
export const INTEGRITY_MAX_CONVERSATIONS = 5000;
/** Số mã hội thoại tối đa in cho mỗi lỗi (phần MÃ HOÁ). */
export const INTEGRITY_LIST_CAP = 300;
const USAGE = `<mã tổ chức> [--days=1..${INTEGRITY_MAX_DAYS}] [--find-name=<chuỗi>[,<chuỗi>]] [--conv=<uuid>]`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type IntegrityArgs = { code: string; days: number; findNames: string[]; conv: string | null };

/** Soát đối số. Tên tìm: `_` `.` `+` `-` = khoảng trắng; nhiều tên cách nhau dấu phẩy; từ rời SAU cờ nối vào tên cuối. HÀM THUẦN. */
export function parseIntegrityArgs(argv: readonly string[]): IntegrityArgs | { error: string } {
  const free = argv.filter((a) => !a.startsWith("--"));
  const code = (free[0] ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const conv = val("conv") ?? null;
  if (conv !== null && !UUID_RE.test(conv)) return { error: "--conv phải là mã hội thoại dạng uuid" };
  const rawDays = val("days");
  const days = rawDays === undefined ? INTEGRITY_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > INTEGRITY_MAX_DAYS) return { error: `--days phải là số nguyên 1..${INTEGRITY_MAX_DAYS}` };
  const rawName = val("find-name");
  let findNames: string[] = [];
  if (rawName !== undefined) {
    const joined = [rawName, ...free.slice(1)].join(" ");
    findNames = joined
      .split(",")
      .map((s) => s.replace(/[_.+-]+/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (!findNames.length || findNames.some((n) => n.replace(/\s/g, "").length < 3)) return { error: "--find-name cần ít nhất 3 ký tự mỗi tên" };
    if (findNames.length > 5) return { error: "--find-name tối đa 5 tên" };
  }
  return { code, days, findNames, conv: conv?.toLowerCase() ?? null };
}

type Block = { type?: unknown; text?: unknown; name?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
/** Chữ của một tin (khối text). HÀM THUẦN. */
export const textOf = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
/** Tin user là tin KHÁCH (không phải kết quả công cụ). HÀM THUẦN. */
export const isCustomerContent = (content: unknown) => blocksOf(content)[0]?.type === "text";

/** SĐT theo biểu thức đang chạy (levels.ts / order-sync.ts). HÀM THUẦN. */
export function phonesIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\+?84|0)(?:[\s.-]?\d){8,10}/g)) {
    const n = normalizeVnPhone(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

const bump = (m: Record<string, number>, k: string, by = 1) => {
  m[k] = (m[k] ?? 0) + by;
};
const fmt = (m: Record<string, number>, limit = 8) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ") || "0";
const vnDate = (d: Date) => new Date(d.getTime() + 7 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
/** Mã đơn như hộp thư in («#71B31FE3» cho đơn tạo trong ERP); đơn đồng bộ in 12 ký tự đầu của mã nguồn. */
const orderCode = (id: string) => (id.startsWith("erp-") ? `#${manualOrderShortCode(id)}` : id.slice(0, 12));
const kg = (g: number) => `${String(g / 1000).replace(".", ",")}kg`;

// ─────────────────────────── ĐỌC DỮ LIỆU ───────────────────────────

type ConvRow = typeof schema.salesChatConversations.$inferSelect;
type Msg = { seq: number; role: string; content: unknown; at: Date };
type Ev = { type: string; actor: string; at: Date; orderId: string | null; amount: number | null; reason: string | null; payload: Record<string, unknown> };
type Inb = { at: Date; note: string | null; text: string; name: string | null };
type OrderRow = {
  id: string;
  at: Date;
  stage: string;
  origin: string | null;
  sc: string | null;
  pageId: string | null;
  convId: string | null;
  totalAfter: number;
  shipFee: number;
  phone: string;
  address: string;
  province: string;
  ward: string;
  itemsCount: number;
  billName: string;
  shipName: string;
  raw: unknown;
};
type LineRow = { orderId: string; sku: string; name: string; variation: string; quantity: number; unitPrice: number; discount: number; isBonus: boolean; variantWeight: number | null };

export type ConvBundle = {
  conv: ConvRow;
  msgs: Msg[];
  events: Ev[];
  staffSentAts: Date[];
  inbound: Inb[];
  orders: OrderRow[];
  lines: Map<string, LineRow[]>;
  customerName: string | null;
  customerPhone: string | null;
};

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

const ORDER_COLS = (o: typeof schema.orders) => ({
  id: o.id,
  at: o.insertedAt,
  stage: sql<string>`${o.stage}::text`,
  origin: o.origin,
  sc: o.salesConversationId,
  pageId: o.pageId,
  convId: o.conversationId,
  totalAfter: o.totalPriceAfterDiscount,
  shipFee: o.shippingFee,
  phone: o.shipPhone,
  address: o.shipAddress,
  province: o.shipProvince,
  ward: o.shipCommune,
  itemsCount: o.itemsCount,
  billName: o.billFullName,
  shipName: o.shipFullName,
  raw: o.raw,
});

async function loadLines(db: Db, orderIds: readonly string[]): Promise<Map<string, LineRow[]>> {
  const out = new Map<string, LineRow[]>();
  const it = schema.orderItems;
  const pv = schema.productVariants;
  for (const part of chunk(orderIds, 500)) {
    const rows = await db
      .select({ orderId: it.orderId, sku: it.sku, name: it.productName, variation: it.variationDetail, quantity: it.quantity, unitPrice: it.unitPrice, discount: it.totalDiscount, isBonus: it.isBonus, variantWeight: pv.weight })
      .from(it)
      .leftJoin(pv, eq(pv.id, it.variantId))
      .where(inArray(it.orderId, part));
    for (const r of rows) out.set(r.orderId, [...(out.get(r.orderId) ?? []), { ...r, unitPrice: Number(r.unitPrice ?? 0), discount: Number(r.discount ?? 0), variantWeight: r.variantWeight === null ? null : Number(r.variantWeight) }]);
  }
  return out;
}

/** Đơn nối được với hội thoại: bot ghi khoá · ô đơn của hội thoại · cùng luồng Pancake (page + hội thoại). Không nối theo SĐT. */
function ordersOfConv(c: ConvRow, rows: readonly OrderRow[]): OrderRow[] {
  return rows.filter((r) => r.sc === c.id || r.id === c.orderId || r.id === c.draftOrderId || (c.pageId && c.threadId && r.pageId === c.pageId && r.convId === c.threadId));
}

export async function loadBundles(db: Db, convs: readonly ConvRow[], from: Date): Promise<ConvBundle[]> {
  const ids = convs.map((c) => c.id);
  const msgs = new Map<string, Msg[]>();
  const events = new Map<string, Ev[]>();
  const staff = new Map<string, Date[]>();
  const inbound = new Map<string, Inb[]>();
  const m = schema.salesChatMessages;
  const e = schema.salesConversationEvents;
  const sm = schema.salesChatStaffMessages;
  for (const part of chunk(ids, 200)) {
    for (const r of await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(and(inArray(m.conversationId, part), gte(m.createdAt, from))).orderBy(asc(m.conversationId), asc(m.seq))) {
      msgs.set(r.conv, [...(msgs.get(r.conv) ?? []), { seq: r.seq, role: r.role, content: r.content, at: r.at }]);
    }
    for (const r of await db
      .select({ conv: e.conversationId, type: e.type, actor: e.actorKind, at: e.occurredAt, orderId: e.orderId, amount: e.amountVnd, reason: e.reasonCode, payload: e.payload })
      .from(e)
      .where(and(inArray(e.conversationId, part), gte(e.occurredAt, from), inArray(e.type, ["ai.replied", "order.drafted", "order.confirmed", "handoff.requested", "human.took_over", "human.replied", "ai.resumed", "followup.sent", "conversation.declined"])))
      .orderBy(asc(e.occurredAt))) {
      events.set(r.conv, [...(events.get(r.conv) ?? []), { type: r.type, actor: r.actor, at: r.at, orderId: r.orderId, amount: r.amount === null ? null : Number(r.amount), reason: r.reason, payload: (r.payload ?? {}) as Record<string, unknown> }]);
    }
    for (const r of await db.select({ conv: sm.conversationId, at: sm.sentAt, created: sm.createdAt }).from(sm).where(and(inArray(sm.conversationId, part), eq(sm.status, "SENT"), gte(sm.createdAt, from)))) {
      staff.set(r.conv, [...(staff.get(r.conv) ?? []), r.at ?? r.created]);
    }
  }
  const pairs = convs.filter((c) => c.pageId && c.threadId);
  const byThread = new Map(pairs.map((c) => [`${c.pageId}|${c.threadId}`, c.id]));
  const inb = schema.salesChatInbound;
  for (const part of chunk(pairs, 200)) {
    const rows = await db
      .select({ pageId: inb.pageId, threadId: inb.threadId, at: inb.createdAt, note: inb.note, text: inb.text, name: inb.customerName })
      .from(inb)
      .where(and(sql`(${inb.pageId}, ${inb.threadId}) in (${sql.join(part.map((c) => sql`(${c.pageId}, ${c.threadId})`), sql`, `)})`, gte(inb.createdAt, from)));
    for (const r of rows) {
      const id = byThread.get(`${r.pageId}|${r.threadId}`);
      if (id) inbound.set(id, [...(inbound.get(id) ?? []), { at: r.at, note: r.note, text: r.text, name: r.name }]);
    }
  }
  // Đơn nối được.
  const o = schema.orders;
  const conds: SQL[] = [];
  for (const part of chunk(ids, 500)) conds.push(inArray(o.salesConversationId, part));
  const orderIds = convs.flatMap((c) => [c.orderId, c.draftOrderId]).filter((x): x is string => Boolean(x));
  for (const part of chunk(orderIds, 500)) conds.push(inArray(o.id, part));
  for (const part of chunk(pairs, 300)) conds.push(sql`(${o.pageId}, ${o.conversationId}) in (${sql.join(part.map((c) => sql`(${c.pageId}, ${c.threadId})`), sql`, `)})`);
  const orders: OrderRow[] = [];
  const seen = new Set<string>();
  for (const cond of conds) {
    for (const r of await db.select(ORDER_COLS(o)).from(o).where(cond).limit(20_000)) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      orders.push({ ...r, totalAfter: Number(r.totalAfter ?? 0), shipFee: Number(r.shipFee ?? 0), itemsCount: Number(r.itemsCount ?? 0) });
    }
  }
  const lines = await loadLines(db, orders.map((x) => x.id));
  const custIds = [...new Set(convs.map((c) => c.customerId).filter((x): x is string => Boolean(x)))];
  const cust = new Map<string, { name: string; phone: string | null }>();
  for (const part of chunk(custIds, 500)) for (const r of await db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone }).from(schema.customers).where(inArray(schema.customers.id, part))) cust.set(r.id, r);
  return convs.map((c) => {
    const own = ordersOfConv(c, orders);
    return {
      conv: c,
      msgs: msgs.get(c.id) ?? [],
      events: events.get(c.id) ?? [],
      staffSentAts: staff.get(c.id) ?? [],
      inbound: inbound.get(c.id) ?? [],
      orders: own,
      lines: new Map(own.map((x) => [x.id, lines.get(x.id) ?? []])),
      customerName: c.customerId ? (cust.get(c.customerId)?.name ?? null) : null,
      customerPhone: c.customerId ? (cust.get(c.customerId)?.phone ?? null) : null,
    };
  });
}

// ─────────────────────────── DỮ KIỆN DẪN XUẤT ───────────────────────────

const toDate = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Cờ cần kiểm của một đơn, mỗi lượt mang mốc mở / gỡ (`raw.review` đang mở · `raw.reviewLog` đã gỡ). */
export function reviewSpansOf(raw: unknown): ReviewSpan[] {
  const out: ReviewSpan[] = [];
  for (const e of orderReviewOf(raw)?.entries ?? []) {
    const at = toDate(e.at);
    if (at) out.push({ code: e.code, at, resolvedAt: null });
  }
  for (const r of orderReviewLogOf(raw)) {
    if (r.action === "CUSTOMER_RECONFIRMED") continue;
    const resolvedAt = toDate(r.at);
    for (const e of r.entries) {
      const at = toDate(e.at);
      if (at && resolvedAt) out.push({ code: e.code, at, resolvedAt });
    }
  }
  return out;
}

export function orderFactOf(r: OrderRow, lines: readonly LineRow[]): OrderFact {
  const manual = r.id.startsWith("erp-");
  return {
    id: r.id,
    insertedAt: r.at,
    stage: r.stage,
    manual,
    total: orderMoneyOf({ totalAfterDiscount: r.totalAfter, shippingFee: r.shipFee }, []).total ?? goodsOf(lines),
    reviews: manual ? reviewSpansOf(r.raw) : [],
    gapsNow: manual ? gapsOf({ phone: r.phone, address: r.address, province: r.province, ward: r.ward, itemsCount: r.itemsCount }) : [],
  };
}

const lineMoney = (lines: readonly LineRow[]) => lines.map((l) => ({ quantity: l.quantity, unitPrice: l.isBonus ? l.unitPrice : l.unitPrice > 0 ? l.unitPrice : null, discount: l.discount, isBonus: l.isBonus }));
const goodsOf = (lines: readonly LineRow[]) => orderMoneyOf({ totalAfterDiscount: null, shippingFee: null }, lineMoney(lines)).goods;
const moneyOf = (r: OrderRow, lines: readonly LineRow[]): OrderMoney => orderMoneyOf({ totalAfterDiscount: r.totalAfter, shippingFee: r.shipFee }, lineMoney(lines));
const weightOf = (lines: readonly LineRow[]) => orderWeightShape(lines.map((l) => ({ quantity: l.quantity, grams: lineGrams(l.sku, l.name, l.variation, l.variantWeight), isBonus: l.isBonus })));

const botTexts = (b: ConvBundle): BotText[] => b.msgs.filter((x) => x.role === "assistant").map((x) => ({ at: x.at, text: textOf(x.content) })).filter((x) => x.text);
const customerAts = (b: ConvBundle): Date[] => [
  ...b.msgs.filter((x) => x.role === "user" && isCustomerContent(x.content)).map((x) => x.at),
  ...b.inbound.filter((x) => x.note !== PAGE_REPLY && x.note !== "BOT_SENT" && x.note !== "HISTORY").map((x) => x.at),
];
const customerTextAll = (b: ConvBundle) => [...b.msgs.filter((x) => x.role === "user" && isCustomerContent(x.content)).map((x) => textOf(x.content)), ...b.inbound.filter((x) => x.note !== PAGE_REPLY && x.note !== "BOT_SENT" && x.note !== MEDIA_ONLY_NOTE).map((x) => x.text)].join("\n");

/** Mốc đơn ĐÃ CHỐT sớm nhất của hội thoại: sự kiện `order.confirmed` (MEASURED), hoặc mốc tạo của đơn hôm nay không còn «Mới» (ESTIMATED). */
function confirmedAtOf(b: ConvBundle): { at: Date; confidence: "MEASURED" | "ESTIMATED" } | null {
  const ev = b.events.filter((e) => e.type === "order.confirmed" && e.payload.simulated !== true).map((e) => e.at);
  if (ev.length) return { at: new Date(Math.min(...ev.map((d) => d.getTime()))), confidence: "MEASURED" };
  const live = b.orders.filter((o) => o.stage !== "NEW" && o.stage !== "CANCELLED" && o.stage !== "DELETED").map((o) => o.at.getTime());
  return live.length ? { at: new Date(Math.min(...live)), confidence: "ESTIMATED" } : null;
}

function outboundOf(b: ConvBundle): OutboundMsg[] {
  const followAts = b.events.filter((e) => e.type === "followup.sent").map((e) => e.at);
  const bots = botTexts(b);
  const out: OutboundMsg[] = followAts.map((at) => ({ at, source: "ERP_FOLLOWUP", text: bots.find((x) => Math.abs(x.at.getTime() - at.getTime()) <= 120_000)?.text ?? null }));
  for (const x of bots) if (!followAts.some((f) => Math.abs(x.at.getTime() - f.getTime()) <= 120_000)) out.push({ at: x.at, source: "AI_UNPROMPTED", text: x.text });
  for (const x of b.inbound) if (x.note === PAGE_REPLY) out.push({ at: x.at, source: "PAGE_SIDE", text: x.text });
  return out;
}

function handoffEvidenceOf(b: ConvBundle): HandoffEvidence[] {
  const out: HandoffEvidence[] = [];
  for (const e of b.events) {
    if (e.type === "human.replied") out.push({ at: e.at, kind: "HUMAN_REPLIED" });
    else if (e.type === "human.took_over") out.push({ at: e.at, kind: "HUMAN_TOOK_OVER" });
    else if (e.type === "ai.resumed" && e.actor === "HUMAN") out.push({ at: e.at, kind: "AI_RESUMED_BY_HUMAN" });
  }
  for (const at of b.staffSentAts) out.push({ at, kind: "STAFF_SENT" });
  if (b.conv.assigneeUserId && b.conv.assignedAt) out.push({ at: b.conv.assignedAt, kind: "ASSIGNED" });
  for (const x of b.inbound) if (x.note === PAGE_REPLY) out.push({ at: x.at, kind: "PAGE_REPLY" });
  return out;
}

// ─────────────────────────── ĐO CỬA SỔ ───────────────────────────

type FaultLetter = "a" | "b" | "c" | "c2" | "d" | "e" | "f" | "h";
const FAULT_OF: Partial<Record<FaultLetter, FaultKind>> = { a: "PRICE_MISMATCH", b: "PRICE_DRIFT", c: "FALSE_CONFIRM", d: "HANDOFF_UNANSWERED", e: "ADDRESS_FAIL", h: "FOLLOWUP_AFTER_ORDER" };

/** `scope` chỉ để bài kiểm giới hạn tập đo trên CSDL dùng chung (ops không truyền): hội thoại theo mã · đơn tay theo tiền tố mã. */
export async function auditWindow(db: Db, days: number, now: Date, scope: { convIds?: readonly string[]; manualOrderPrefix?: string } = {}) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const c = schema.salesChatConversations;
  const convRows = await db
    .select()
    .from(c)
    .where(and(gte(c.updatedAt, from), scope.convIds ? inArray(c.id, scope.convIds.length ? [...scope.convIds] : ["-"]) : undefined))
    .orderBy(asc(c.updatedAt))
    .limit(INTEGRITY_MAX_CONVERSATIONS + 1);
  const capped = convRows.length > INTEGRITY_MAX_CONVERSATIONS;
  const bundles = await loadBundles(db, convRows.slice(-INTEGRITY_MAX_CONVERSATIONS), from);
  const affected: Record<FaultLetter, Set<string>> = { a: new Set(), b: new Set(), c: new Set(), c2: new Set(), d: new Set(), e: new Set(), f: new Set(), h: new Set() };
  const firstFault = new Map<string, Date>();
  const markFault = (letter: FaultLetter, convId: string, at: Date) => {
    affected[letter].add(convId);
    if (!FAULT_OF[letter]) return;
    const cur = firstFault.get(convId);
    if (!cur || at < cur) firstFault.set(convId, at);
  };

  // a + a2
  const A = { orders: 0, verdict: {} as Record<string, number>, byOrigin: {} as Record<string, number>, absDiff: 0, signedDiff: 0, diffs: {} as Record<string, number> };
  const two = { shape: {} as Record<WeightShape, number>, total: {} as Record<string, number>, amounts: {} as Record<string, Record<string, number>>, pairs: {} as Record<string, number> };
  // b
  const B = { convs: 0, byGrams: {} as Record<string, number>, spreads: {} as Record<string, number>, botConvsWithWeightQuote: 0 };
  // c
  const C = { claims: 0, falseClaims: 0, convs: 0, kind: {} as Record<string, number>, conf: {} as Record<string, number>, fix: {} as Record<string, number>, amount: 0, amountUnknown: 0 };
  // c2
  const C2 = { noPhoneConvs: 0, phoneInHistory: 0 };
  // d
  const handoffs: { at: Date; strict: Date | null; loose: Date | null }[] = [];
  const D = { hangingNow: 0, hangingWithCustomerMsg: 0, oldestH: null as number | null };
  // e
  const E = { withAddress: 0, issue: {} as Record<string, number>, gap: {} as Record<string, number>, byOrigin: {} as Record<string, number> };
  const addrSeen = new Set<string>();
  // h
  const H = { convs: 0, msgs: 0, bySource: {} as Record<string, number>, nudges: 0, confidence: {} as Record<string, number>, convsWithOrder: 0 };
  // f
  const F = { convs: 0, outcome: {} as Record<string, number>, orderAmount: 0, quoteAmount: 0, noAmount: 0 };

  for (const b of bundles) {
    const id = b.conv.id;
    const bots = botTexts(b);
    const facts = b.orders.map((o) => orderFactOf(o, b.lines.get(o.id) ?? []));
    const confirmedAts = b.events.filter((e) => e.type === "order.confirmed").map((e) => e.at);
    const custAts = customerAts(b);

    // a — mỗi đơn nối được tạo trong cửa sổ.
    for (const o of b.orders.filter((x) => x.at >= from && x.stage !== "DELETED")) {
      const lines = b.lines.get(o.id) ?? [];
      const money = moneyOf(o, lines);
      const v: QuoteVsOrder = compareQuoteToOrder(bots, o.at, money);
      A.orders += 1;
      bump(A.verdict, v.verdict);
      if (v.verdict === "MISMATCH" && v.diff !== null) {
        bump(A.byOrigin, o.origin ?? "khác");
        A.absDiff += Math.abs(v.diff);
        A.signedDiff += v.diff;
        bump(A.diffs, `${v.diff > 0 ? "+" : ""}${vndText(v.diff)}`);
        markFault("a", id, o.at);
      }
      // a2 — đơn 2kg.
      const w = weightOf(lines);
      if (w.grams === 2000) {
        bump(two.shape, w.shape);
        const amt = money.total ?? money.goods;
        bump(two.total, w.shape, amt ?? 0);
        two.amounts[w.shape] = two.amounts[w.shape] ?? {};
        bump(two.amounts[w.shape], amt === null ? "CHƯA BIẾT" : vndText(amt));
        const quoted2 = bots.filter((x) => x.at < o.at).flatMap((x) => quotePoints(x.text)).filter((p) => p.grams === 2000).map((p) => p.amount);
        const refs = orderReferenceAmounts(money);
        for (const q of new Set(quoted2)) if (!refs.includes(q) && amt !== null) bump(two.pairs, `bot ${vndText(q)} ⇒ đơn ${vndText(amt)}`);
      }
    }

    // b
    const drifts = priceDrifts(bots);
    if (bots.some((x) => quotePoints(x.text).some((p) => p.grams !== null))) B.botConvsWithWeightQuote += 1;
    if (drifts.length) {
      B.convs += 1;
      for (const d of drifts) {
        bump(B.byGrams, kg(d.grams));
        bump(B.spreads, vndText(d.spread));
      }
      markFault("b", id, new Date(Math.min(...drifts.map((d) => d.secondAt.getTime()))));
    }

    // c
    let convFalse = false;
    for (const x of b.msgs.filter((m) => m.role === "assistant")) {
      const text = textOf(x.content);
      if (!text || !detectClaims(text).includes("ORDER_CONFIRMED")) continue;
      C.claims += 1;
      const st = orderStateAt(x.at, facts, confirmedAts);
      const kind = falseConfirmKind(st.state);
      if (!kind) continue;
      C.falseClaims += 1;
      bump(C.kind, kind);
      bump(C.conf, st.confidence);
      if (!convFalse) {
        convFalse = true;
        C.convs += 1;
        bump(C.fix, currentFix(facts));
        const amt = st.order?.total ?? null;
        if (amt === null) C.amountUnknown += 1;
        else C.amount += amt;
        markFault("c", id, x.at);
      }
    }

    // c2 — SĐT trong lịch sử tin mà hồ sơ / hội thoại không có.
    const st = (b.conv.state ?? {}) as { customer?: { phone?: unknown }; returning?: { phones?: unknown } };
    const known = [b.conv.customerPhone, b.customerPhone, typeof st.customer?.phone === "string" ? st.customer.phone : null, ...(Array.isArray(st.returning?.phones) ? (st.returning.phones as unknown[]).filter((p): p is string => typeof p === "string") : [])].filter((p) => typeof p === "string" && p.trim());
    if (!known.length) {
      C2.noPhoneConvs += 1;
      if (phonesIn(customerTextAll(b)).length) {
        C2.phoneInHistory += 1;
        affected.c2.add(id);
      }
    }

    // d
    const ev = handoffEvidenceOf(b);
    const hs = b.events.filter((e) => e.type === "handoff.requested");
    for (const h of hs) {
      const strict = handoffResponseAt(h.at, ev, true);
      handoffs.push({ at: h.at, strict, loose: handoffResponseAt(h.at, ev, false) });
      if ((!strict && now.getTime() - h.at.getTime() >= 4 * 3_600_000) || (strict && strict.getTime() - h.at.getTime() > 4 * 3_600_000)) markFault("d", id, new Date(h.at.getTime() + 4 * 3_600_000));
    }
    if (b.conv.status === "HANDOFF" && !b.conv.assigneeUserId) {
      const last = hs.length ? hs[hs.length - 1].at : null;
      const since = last ?? b.conv.updatedAt;
      if (!handoffResponseAt(since, ev, true)) {
        D.hangingNow += 1;
        if (custAts.some((t) => t > since)) D.hangingWithCustomerMsg += 1;
        const age = (now.getTime() - since.getTime()) / 3_600_000;
        D.oldestH = Math.max(D.oldestH ?? 0, age);
      }
    }

    // e — đơn tay nối được tạo trong cửa sổ + địa chỉ khách bot ghi khi chưa có đơn.
    for (const o of b.orders.filter((x) => x.id.startsWith("erp-") && x.at >= from && x.stage !== "DELETED")) {
      addrSeen.add(o.id);
      if (o.address.trim().length < 5) continue;
      E.withAddress += 1;
      const issue = classifyAddress({ address: o.address, province: o.province, ward: o.ward });
      if (!issue) continue;
      bump(E.issue, ADDRESS_ISSUE_LABEL[issue]);
      bump(E.gap, ADDRESS_ISSUE_GAP[issue]);
      bump(E.byOrigin, o.origin ?? "khác");
      markFault("e", id, o.at);
    }

    // h
    const conf = confirmedAtOf(b);
    if (conf) {
      H.convsWithOrder += 1;
      const late = postOrderOutbound(conf.at, outboundOf(b), custAts);
      if (late.length) {
        H.convs += 1;
        H.msgs += late.length;
        bump(H.confidence, conf.confidence);
        for (const x of late) {
          bump(H.bySource, x.source);
          if (x.text && isConfirmNudge(x.text)) H.nudges += 1;
        }
        markFault("h", id, late[0].at);
      }
    }

    // f
    const ff = firstFault.get(id) ?? null;
    const live = b.orders.filter((o) => o.stage !== "CANCELLED" && o.stage !== "DELETED");
    const cancelled = b.orders.filter((o) => o.stage === "CANCELLED");
    const cancelledTotals = cancelled.map((o) => moneyOf(o, b.lines.get(o.id) ?? [])).map((mny) => mny.total ?? mny.goods);
    const quotes = bots.flatMap((x) => quotePoints(x.text).map((p) => p.amount));
    const lost = lostSaleOf({
      firstFaultAt: ff,
      liveOrders: live.length,
      cancelledCount: cancelled.length,
      cancelledTotal: cancelledTotals.some((t) => t === null) ? null : cancelledTotals.reduce<number>((s, t) => s + (t ?? 0), 0),
      declined: b.events.some((e) => e.type === "conversation.declined"),
      lastCustomerAt: b.conv.lastCustomerAt,
      maxQuoted: quotes.length ? Math.max(...quotes) : null,
      now,
    });
    if (lost) {
      F.convs += 1;
      affected.f.add(id);
      bump(F.outcome, lost.outcome);
      if (lost.amount === null) F.noAmount += 1;
      else if (lost.amountSource === "ORDER") F.orderAmount += lost.amount;
      else F.quoteAmount += lost.amount;
    }
  }

  // e — đơn tay KHÔNG nối hội thoại nào (nhân viên tạo) trong cửa sổ.
  const o = schema.orders;
  const loose = await db.select(ORDER_COLS(o)).from(o).where(and(sql`${o.id} like ${`${scope.manualOrderPrefix ?? "erp-"}%`}`, gte(o.insertedAt, from))).limit(20_000);
  let looseIssues = 0;
  for (const r of loose) {
    if (addrSeen.has(r.id) || r.stage === "DELETED" || r.address.trim().length < 5) continue;
    E.withAddress += 1;
    const issue: AddressIssue | null = classifyAddress({ address: r.address, province: r.province, ward: r.ward });
    if (!issue) continue;
    looseIssues += 1;
    bump(E.issue, ADDRESS_ISSUE_LABEL[issue]);
    bump(E.gap, ADDRESS_ISSUE_GAP[issue]);
    bump(E.byOrigin, r.origin ?? "khác");
  }

  const dBuckets = handoffBuckets(handoffs.map((h) => ({ at: h.at, responseAt: h.strict })), now);
  const dLoose = handoffBuckets(handoffs.map((h) => ({ at: h.at, responseAt: h.loose })), now);
  const eFail = Object.values(E.issue).reduce((s, n) => s + n, 0);

  console.log(`Kỳ ${days} ngày tới ${now.toISOString()} · ${bundles.length} hội thoại${capped ? ` (cắt ở ${INTEGRITY_MAX_CONVERSATIONS}, giữ mới nhất)` : ""}`);
  tomTat(`sales-integrity-audit ${days} ngày: ${bundles.length}${capped ? "+" : ""} hội thoại · ${A.orders} đơn nối được tạo trong kỳ`);
  tomTat(`a GIÁ BOT ≠ GIÁ ĐƠN (ESTIMATED — số trích từ chữ): lệch ${rateText(A.verdict.MISMATCH ?? 0, (A.verdict.MISMATCH ?? 0) + (A.verdict.MATCH ?? 0))} · chưa báo giá trước đơn ${A.verdict.NO_QUOTE ?? 0} · tiền đơn chưa biết ${A.verdict.ORDER_AMOUNT_UNKNOWN ?? 0} · tổng |chênh| ${vndText(A.absDiff)} (đại số ${vndText(A.signedDiff)})`);
  tomTat(`a phân bố chênh (đơn − bot): ${fmt(A.diffs, 6)} · theo nguồn đơn: ${fmt(A.byOrigin)}`);
  tomTat(`a2 đơn 2kg theo cách biểu diễn: ${fmt(two.shape)} · tổng tiền ${Object.entries(two.total).map(([k, v]) => `${k} ${vndText(v)}`).join(" · ") || "0"}`);
  tomTat(`a2 số tiền đơn 2kg: ${Object.entries(two.amounts).map(([k, v]) => `${k}: ${fmt(v, 4)}`).join(" | ") || "0"}`);
  tomTat(`a2 bot báo X mà đơn 2kg Y: ${fmt(two.pairs, 6)}`);
  tomTat(`b GIÁ TỰ ĐỔI (ESTIMATED — cùng cụm khối lượng, hai tổng khác nhau): ${rateText(B.convs, B.botConvsWithWeightQuote)} hội thoại có báo giá theo khối lượng · theo khối lượng ${fmt(B.byGrams)} · độ lệch ${fmt(B.spreads, 5)}`);
  tomTat(`c XÁC NHẬN GIẢ: ${C.falseClaims}/${C.claims} câu «đã chốt / đã lên đơn» · ${C.convs} hội thoại · loại ${fmt(C.kind)} · tin cậy ${fmt(C.conf)}`);
  tomTat(`c hôm nay: ${fmt(C.fix)} · tiền đơn liên quan ${vndText(C.amount)}${C.amountUnknown ? ` + ${C.amountUnknown} hội thoại chưa có đơn / tiền CHƯA ĐO ĐƯỢC` : ""}`);
  tomTat(`c2 SĐT có trong tin khách mà hồ sơ / hội thoại KHÔNG có SĐT: ${rateText(C2.phoneInHistory, C2.noPhoneConvs)} hội thoại thiếu SĐT (MEASURED — biểu thức SĐT đang chạy)`);
  tomTat(`d CHUYỂN NGƯỜI (bản chặt — dấu vết người trong ERP): ${handoffs.length} lượt · ${dBuckets.map((x) => `>${x.thresholdH}h ${rateText(x.late, x.eligible)} (chưa ai ${x.never})`).join(" · ")}`);
  tomTat(`d bản nới (+ tin phía page, gồm cả tin tự động Meta): ${dLoose.map((x) => `>${x.thresholdH}h ${rateText(x.late, x.eligible)}`).join(" · ")}`);
  tomTat(`d đang treo HÔM NAY (HANDOFF, chưa giao ai, chưa ai đáp): ${D.hangingNow} · có tin khách sau lượt chuyển ${D.hangingWithCustomerMsg} · lâu nhất ${D.oldestH === null ? "—" : `${Math.round(D.oldestH)} giờ`}`);
  tomTat(`e ĐỊA CHỈ chưa ghép: ${rateText(eFail, E.withAddress)} đơn tay có dòng địa chỉ (${looseIssues} đơn không nối hội thoại) · lý do ${fmt(E.issue)}`);
  tomTat(`e theo loại chỗ trống: ${fmt(E.gap)} · theo nguồn đơn ${fmt(E.byOrigin)}`);
  tomTat(`h NHẮC SAU KHI ĐƠN ĐÃ CHỐT: ${rateText(H.convs, H.convsWithOrder)} hội thoại có đơn chốt · ${H.msgs} tin · nguồn ${fmt(H.bySource)} · câu nhắc chốt ${H.nudges} · mốc chốt ${fmt(H.confidence)}`);
  tomTat(`f MẤT DOANH THU sau lỗi (ESTIMATED — lỗi xảy ra trước kết cục, không chứng minh nhân quả): ${F.convs} hội thoại · ${fmt(F.outcome)} · tiền đơn huỷ ${vndText(F.orderAmount)} · tiền bot báo (ước) ${vndText(F.quoteAmount)} · không rõ tiền ${F.noAmount}`);
  tomTat(`KHÁCH (hội thoại) BỊ ẢNH HƯỞNG: ${(Object.keys(affected) as FaultLetter[]).map((k) => `${k} ${affected[k].size}`).join(" · ")} · bất kỳ lỗi a–h ${new Set(Object.values(affected).flatMap((s) => [...s])).size} — mã hội thoại ở phần MÃ HOÁ`);
  for (const k of Object.keys(affected) as FaultLetter[]) console.log(`  lỗi ${k} (${affected[k].size} hội thoại, in ≤ ${INTEGRITY_LIST_CAP}): ${[...affected[k]].slice(0, INTEGRITY_LIST_CAP).join(" ") || "—"}`);
  return { affected };
}

// ─────────────────────────── --find-name ───────────────────────────

export async function findByName(db: Db, names: readonly string[], days: number, now: Date) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const c = schema.salesChatConversations;
  const convRows = await db.select().from(c).where(gte(c.updatedAt, from)).limit(INTEGRITY_MAX_CONVERSATIONS);
  const bundles = await loadBundles(db, convRows, from);
  const o = schema.orders;
  const looseOrders = await db.select(ORDER_COLS(o)).from(o).where(gte(o.insertedAt, from)).limit(20_000);
  const looseLines = await loadLines(db, looseOrders.map((x) => x.id));
  const owner = (amounts: readonly number[]) => OWNER_CASE_AMOUNTS.map((a) => `${a / 1000}k ${amounts.includes(a) ? "CÓ" : "không"}`).join(" · ");
  names.forEach((name, ni) => {
    const hits: string[] = [];
    const convOrderIds = new Set<string>();
    for (const b of bundles) {
      const st = (b.conv.state ?? {}) as { customer?: { name?: unknown } };
      const src: string[] = [];
      if (b.inbound.some((x) => nameMatches(name, x.name))) src.push("tên Pancake");
      if (nameMatches(name, b.customerName)) src.push("hồ sơ khách");
      if (nameMatches(name, typeof st.customer?.name === "string" ? st.customer.name : null)) src.push("bot ghi");
      if (b.orders.some((x) => nameMatches(name, x.billName) || nameMatches(name, x.shipName))) src.push("tên trên đơn");
      if (!src.length) continue;
      const amounts = [...botTexts(b).flatMap((x) => extractVndAmounts(x.text).map((m) => m.value)), ...b.orders.flatMap((x) => orderReferenceAmounts(moneyOf(x, b.lines.get(x.id) ?? [])))];
      b.orders.forEach((x) => convOrderIds.add(x.id));
      hits.push(`hội thoại ${b.conv.id} · ${vnDate(b.conv.createdAt)} VN · khớp ${src.join("+")} · đơn ${b.orders.map((x) => orderCode(x.id)).join(",") || "—"} · ${owner(amounts)}`);
    }
    for (const r of looseOrders) {
      if (convOrderIds.has(r.id) || !(nameMatches(name, r.billName) || nameMatches(name, r.shipName))) continue;
      hits.push(`đơn ${orderCode(r.id)} (không nối hội thoại) · ${vnDate(r.at)} VN · ${r.stage} · ${owner(orderReferenceAmounts(moneyOf(r, looseLines.get(r.id) ?? [])))}`);
    }
    tomTat(`tìm tên #${ni + 1} (${days} ngày): ${hits.length} kết quả${hits.length > 10 ? " — in 10 đầu, đủ ở phần MÃ HOÁ" : ""}`);
    hits.slice(0, 10).forEach((h) => tomTat(`  #${ni + 1} ${h}`));
    hits.forEach((h) => console.log(`  find-name #${ni + 1}: ${h}`));
  });
}

// ─────────────────────────── --conv ───────────────────────────

export async function conversationTimeline(db: Db, conv: ConvRow) {
  const [b] = await loadBundles(db, [conv], new Date(0));
  const facts = b.orders.map((o) => orderFactOf(o, b.lines.get(o.id) ?? []));
  const confirmedAts = b.events.filter((e) => e.type === "order.confirmed").map((e) => e.at);
  type Row = { at: Date; line: string };
  const rows: Row[] = [];
  let claims = 0;
  let falseClaims = 0;
  let tools = { ok: 0, err: 0 };
  for (const x of b.msgs) {
    if (x.role === "assistant") {
      const names = blocksOf(x.content).filter((y) => y.type === "tool_use" && typeof y.name === "string").map((y) => String(y.name));
      const text = textOf(x.content);
      const st = orderStateAt(x.at, facts, confirmedAts);
      const claim = text ? detectClaims(text).includes("ORDER_CONFIRMED") : false;
      if (claim) claims += 1;
      if (claim && falseConfirmKind(st.state)) falseClaims += 1;
      const pts = text ? quotePoints(text).map((p) => `${p.grams === null ? "?" : kg(p.grams)}→${vndText(p.amount)}`) : [];
      rows.push({ at: x.at, line: `BOT #${x.seq}${names.length ? ` gọi ${names.join(",")}` : ""}${text ? ` · ${text.length} ký tự · tiền [${extractVndAmounts(text).map((m) => vndText(m.value)).join(", ")}] · cặp [${pts.join(", ")}]${claim ? " · KHẲNG ĐỊNH ĐÃ CHỐT" : ""}` : ""} · đơn lúc đó: ${st.state} (${st.confidence})` });
    } else if (isCustomerContent(x.content)) {
      const text = textOf(x.content);
      rows.push({ at: x.at, line: `KHÁCH #${x.seq} · ${text.length} ký tự · tiền [${extractVndAmounts(text).map((m) => vndText(m.value)).join(", ")}] · có SĐT ${phonesIn(text).length ? "có" : "không"}` });
    } else {
      for (const y of blocksOf(x.content).filter((z) => z.type === "tool_result")) {
        let reason = "";
        try {
          const p = JSON.parse(String(y.content)) as { reason?: unknown };
          if (typeof p.reason === "string" && /^[A-Z_]{2,40}$/.test(p.reason)) reason = ` (${p.reason})`;
        } catch {
          /* không phải JSON */
        }
        if (y.isError) tools = { ...tools, err: tools.err + 1 };
        else tools = { ...tools, ok: tools.ok + 1 };
        rows.push({ at: x.at, line: `CÔNG CỤ #${x.seq} ${y.isError ? `LỖI${reason}` : "OK"}` });
      }
    }
  }
  for (const e of b.events) if (e.type !== "ai.replied") rows.push({ at: e.at, line: `SỰ KIỆN ${e.type} · ${e.actor}${e.amount !== null ? ` · ${vndText(e.amount)}` : ""}${e.reason ? ` · ${e.reason}` : ""}${e.orderId ? ` · đơn ${orderCode(e.orderId)}` : ""}` });
  for (const at of b.staffSentAts) rows.push({ at, line: "NHÂN VIÊN gửi từ hộp thư ERP" });
  for (const x of b.inbound) if (x.note === PAGE_REPLY) rows.push({ at: x.at, line: `PHÍA PAGE (Pancake / Meta) · ${x.text.length} ký tự · tiền [${extractVndAmounts(x.text).map((m) => vndText(m.value)).join(", ")}]` });
  for (const o of b.orders) {
    const lines = b.lines.get(o.id) ?? [];
    const money = moneyOf(o, lines);
    const w = weightOf(lines);
    const f = facts.find((x) => x.id === o.id)!;
    rows.push({ at: o.at, line: `ĐƠN TẠO ${orderCode(o.id)} · nguồn ${o.origin ?? "—"} · hôm nay ${o.stage} · tổng ${vndText(money.total)} · tiền hàng theo dòng ${vndText(money.goods)} · ship ${vndText(money.shipping)} · ${w.grams === null ? "khối lượng ?" : kg(w.grams)} ${w.shape} · dòng ${lines.map((l) => `${l.sku || "?"}×${l.quantity}@${vndText(l.unitPrice)}`).join(",")} · ô thiếu ${f.gapsNow.join(",") || "—"} · địa chỉ ${classifyAddress({ address: o.address, province: o.province, ward: o.ward }) ?? "OK/không có"}` });
    for (const r of f.reviews) rows.push({ at: r.at, line: `CỜ KIỂM ${r.code} mở trên đơn ${orderCode(o.id)}${r.resolvedAt ? ` · gỡ ${r.resolvedAt.toISOString()}` : " · CÒN MỞ"}` });
  }
  rows.sort((x, y) => x.at.getTime() - y.at.getTime());
  console.log(`Hội thoại ${conv.id} · kênh ${conv.channel} · trạng thái ${conv.status} · giao cho ${conv.assigneeUserId ? "có người" : "chưa ai"}`);
  for (const r of rows) console.log(`  ${r.at.toISOString()} ${r.line}`);
  const bots = botTexts(b);
  const drifts = priceDrifts(bots);
  const conf = confirmedAtOf(b);
  const late = conf ? postOrderOutbound(conf.at, outboundOf(b), customerAts(b)) : [];
  const hs = b.events.filter((e) => e.type === "handoff.requested");
  const ev = handoffEvidenceOf(b);
  tomTat(`sales-integrity-audit hội thoại: ${conv.channel} · ${conv.status} · tin bot ${bots.length} · đơn nối ${b.orders.length} · công cụ OK ${tools.ok} / lỗi ${tools.err}`);
  tomTat(`giá tự đổi ${drifts.length} cụm (${drifts.map((d) => `${kg(d.grams)}: ${d.amounts.map((a) => vndText(a)).join(" / ")}`).join(" · ") || "—"}) · đơn: ${b.orders.map((o) => compareQuoteToOrder(bots, o.at, moneyOf(o, b.lines.get(o.id) ?? [])).verdict).join(",") || "—"}`);
  tomTat(`câu «đã chốt» ${claims} · không căn cứ ${falseClaims} · chuyển người ${hs.length} (chưa ai đáp — bản chặt ${hs.filter((h) => !handoffResponseAt(h.at, ev, true)).length}) · tin chủ động sau đơn chốt ${late.length} (${late.map((x) => x.source).join(",") || "—"})`);
}

async function main() {
  const args = parseIntegrityArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`sales-integrity-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`sales-integrity-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("sales-integrity-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  const now = new Date();
  if (args.conv) {
    const [conv] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, args.conv)).limit(1);
    if (!conv) {
      tomTat("sales-integrity-audit: DỪNG · không có hội thoại này trong tổ chức đã chọn");
      process.exit(1);
    }
    await conversationTimeline(db, conv);
  }
  if (args.findNames.length) await findByName(db, args.findNames, args.days, now);
  if (!args.conv && !args.findNames.length) await auditWindow(db, args.days, now);
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("sales-integrity-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("sales-integrity-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}

