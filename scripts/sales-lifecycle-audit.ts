/*
  ops `sales-lifecycle-audit` — AI BÁN HÀNG CÓ ĐANG KHẲNG ĐỊNH ĐIỀU CHƯA XÁC MINH KHÔNG, ĐO TRÊN MỘT TỔ CHỨC (CHỈ ĐỌC).

  Vì sao có (P0 10/10/2026 — kiểm toán lifecycle, PR-L0): bot của tổ chức khách nói «đã nhận được tiền» khi khách gửi ẢNH
  chuyển khoản, và «em chốt đơn … tổng 280k» khi không có đơn ERP nào nối với hội thoại; hộp thư không hiện SĐT khách đã gửi.
  `db-query` không với tới CSDL tổ chức (SILO) — script này mở CSDL của MỘT tổ chức bằng `getDbForInspection` và trả lời bằng
  SỐ ĐẾM / ĐÚNG-SAI:

   `--conv=<uuid>` — MỘT hội thoại:
     · đường trả lời của từng tin bot gần nhất: AI / câu mẫu / hệ thống / nhắn lại (đọc `ai.replied.payload.mode`,
       `followup.sent`), tin đó có câu khẳng định TIỀN / ĐƠN không (CÙNG `detectClaims` với hàng rào claim-guard.ts);
     · công cụ nào được gọi, OK hay lỗi (mã lỗi, không chữ);
     · đơn nối được theo TỪNG phép nối (bot `sales_conversation_id` · `order_id/draft_order_id` · cặp page_id + conversation_id ·
       SĐT khách gõ ±3 ngày), trả trước khai trên POS > 0, chứng từ thu `order_payments` (trạng thái tính lúc đọc);
     · `--phone-tail=NNN`: đuôi SĐT có mặt (đúng/sai) ở từng nguồn — không in số.
   `--days=N` (mặc định 14, trần 60) — đếm mẫu lỗi A–F của kiểm toán trên mọi hội thoại có hoạt động trong N ngày:
     A bot khẳng định đã nhận tiền (tách: có / không chứng từ thu; theo đường trả lời) · B bot khẳng định đã chốt mà không có
     đơn sống nối được trong 30 phút (tách: có / không đơn POS cùng luồng) · C khách gửi ảnh chuyển khoản (bot trả lời / chuyển
     người / im) · D hội thoại có đơn POS cùng luồng mà đơn không mang khoá hội thoại · E `customer_phone` trống mà Pancake đã ghi
     nhận SĐT · F nhắn lại khách SAU khi hội thoại đã có đơn nối được.

  Không in tên, SĐT, địa chỉ hay chữ tin. Vẫn MÃ HOÁ cả lượt (ops-vps `OPS_THAO_TAC_MA_HOA`); dòng [ops:tom-tat] là số đếm.
  CHỈ ĐỌC do Postgres ép (`ERP_READ_ONLY=1` trước lần mở kết nối đầu tiên + hỏi lại phiên).

  arg: `<mã tổ chức> [--conv=<uuid>] [--phone-tail=NNN] [--days=N]`.
*/
const CHAY_THANG = Boolean(process.argv[1] && process.argv[1].endsWith("sales-lifecycle-audit.ts"));
if (CHAY_THANG) process.env.ERP_READ_ONLY = "1";

import "dotenv/config";
import { and, asc, desc, eq, gte, inArray, or, sql, type SQL } from "drizzle-orm";
import { getDbForInspection, schema, type Db } from "@/db";
import { manualOrderAmountDue, manualPaymentStatus, sumConfirmedPayments, type OrderPaymentStatus } from "@/lib/constants/order-payments";
import { findOrganization } from "@/lib/platform/organizations";
import { detectClaims, looksLikePaymentImage } from "@/lib/sales-chatbot/claim-guard";
import { classifyHandoffReason } from "@/lib/sales-chatbot/events-shared";
import { MEDIA_ONLY_NOTE, PAGE_REPLY } from "@/lib/sales-chatbot/fanpage";
import { normalizeVnPhone } from "@/lib/sales-chatbot/returning";
import { rowsOf } from "@/lib/sql-rows";

const tomTat = (s: string) => console.log(`[ops:tom-tat] ${s.slice(0, 300)}`);

export const LIFECYCLE_DEFAULT_DAYS = 14;
export const LIFECYCLE_MAX_DAYS = 60;
/** Trần hội thoại đọc ở chế độ `--days` — đủ cho một shop, có trần để không quét vô hạn. */
export const LIFECYCLE_MAX_CONVERSATIONS = 3000;
/** Cửa sổ «bot nói đã chốt» ↔ «có đơn sống nối được». */
export const ORDER_CLAIM_WINDOW_MS = 30 * 60_000;
/** Tên cờ / cách dùng — khai một chỗ (dòng tóm tắt chỉ nội suy hằng này, không mang trường của người). */
const TAIL_FLAG = "--phone-tail";
const USAGE = `<mã tổ chức> [--conv=<uuid>] [${TAIL_FLAG}=NNN] [--days=1..${LIFECYCLE_MAX_DAYS}]`;

// ─────────────────────────── PHẦN THUẦN ───────────────────────────

export type LifecycleArgs = { code: string; conv: string | null; phoneTail: string | null; days: number };

export function parseLifecycleArgs(argv: readonly string[]): LifecycleArgs | { error: string } {
  const code = (argv.find((a) => !a.startsWith("--")) ?? "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(code)) return { error: "thiếu / sai mã tổ chức" };
  const val = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const conv = val("conv") ?? null;
  if (conv !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conv)) return { error: "--conv phải là mã hội thoại dạng uuid" };
  const phoneTail = val("phone-tail") ?? null;
  if (phoneTail !== null && !/^\d{3,4}$/.test(phoneTail)) return { error: "--phone-tail phải là 3–4 chữ số cuối" };
  const rawDays = val("days");
  const days = rawDays === undefined ? LIFECYCLE_DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > LIFECYCLE_MAX_DAYS) return { error: `--days phải là số nguyên 1..${LIFECYCLE_MAX_DAYS}` };
  return { code, conv: conv?.toLowerCase() ?? null, phoneTail, days };
}

type Block = { type?: unknown; text?: unknown; name?: unknown; content?: unknown; isError?: unknown };
const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : []);
/** Chữ của một tin (khối text). HÀM THUẦN. */
export const textOfContent = (content: unknown) =>
  blocksOf(content)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => String(b.text))
    .join("\n")
    .trim();
/** Tin user là tin KHÁCH (không phải kết quả công cụ). HÀM THUẦN. */
export const isCustomerMessage = (content: unknown) => blocksOf(content)[0]?.type === "text";

/** SĐT theo biểu thức đang chạy (levels.ts / order-sync.ts). HÀM THUẦN. */
export function phonesStrict(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:\+?84|0)(?:[\s.-]?\d){8,10}/g)) {
    const n = normalizeVnPhone(m[0]);
    if (n) out.add(n);
  }
  return [...out];
}

/** SĐT theo biểu thức NỚI (phân cách kép, ngoặc, thiếu số 0 đầu) — chỉ để đo biểu thức đang chạy bỏ sót bao nhiêu. HÀM THUẦN. */
export function phonesLoose(text: string): string[] {
  const out = new Set<string>(phonesStrict(text));
  for (const m of text.matchAll(/\(?(?:\+?84|0)?\)?(?:[\s.()-]{0,3}\d){9,10}/g)) {
    let d = m[0].replace(/\D/g, "");
    if (d.startsWith("84") && d.length === 11) d = `0${d.slice(2)}`;
    if (!d.startsWith("0") && d.length === 9) d = `0${d}`;
    const n = normalizeVnPhone(d);
    if (n) out.add(n);
  }
  return [...out];
}

/** Đuôi SĐT có trong danh sách số không (so trên số đã chuẩn hoá). HÀM THUẦN. */
export const hasTail = (phones: readonly (string | null | undefined)[], tail: string) => phones.some((p) => typeof p === "string" && p.replace(/\D/g, "").endsWith(tail));

/** Dòng ảnh chuyển khoản trong chữ tin khách. HÀM THUẦN. */
export function hasPaymentImage(text: string): boolean {
  for (const m of text.matchAll(/\[Khách gửi (?:\d+ )?ảnh: ([^\]]*)\]/g)) if (looksLikePaymentImage(m[1] ?? "")) return true;
  return false;
}

export type ReplyRoute = "AI" | "QUICK_REPLY" | "SYSTEM" | "FOLLOWUP" | "UNKNOWN";
export type RouteEvent = { at: Date; route: ReplyRoute };

/** Đường của một tin bot: sự kiện `ai.replied` / `followup.sent` gần nhất trong [−5 giây, +120 giây] quanh mốc tin. HÀM THUẦN. */
export function routeOf(msgAt: Date, events: readonly RouteEvent[]): ReplyRoute {
  let best: RouteEvent | null = null;
  for (const e of events) {
    const d = e.at.getTime() - msgAt.getTime();
    if (d < -5_000 || d > 120_000) continue;
    if (!best || Math.abs(d) < Math.abs(best.at.getTime() - msgAt.getTime())) best = e;
  }
  return best?.route ?? "UNKNOWN";
}

/** Phép nối đơn ↔ hội thoại: bot ghi khoá · ô đơn của hội thoại · cùng luồng Pancake (page + hội thoại) · SĐT khách gõ ±3 ngày. */
export type LinkKind = "BOT" | "CONV_ORDER" | "THREAD" | "PHONE";
export type LinkedOrder = { id: string; at: Date; stage: string; by: Set<LinkKind>; prepaidDeclared: boolean; payment: OrderPaymentStatus | "N/A" };

/** Đơn còn sống (không huỷ / xoá). HÀM THUẦN. */
export const liveOrder = (o: Pick<LinkedOrder, "stage">) => o.stage !== "CANCELLED" && o.stage !== "DELETED";

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const fmt = (m: Record<string, number>) =>
  Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(" · ") || "0";

// ─────────────────────────── ĐỌC DỮ LIỆU ───────────────────────────

type ConvRow = typeof schema.salesChatConversations.$inferSelect;

/** Đơn nối được của các hội thoại, theo TỪNG phép nối (SĐT chỉ khi truyền `phonesByConv`). */
async function linkedOrders(db: Db, convs: readonly ConvRow[], phonesByConv: ReadonlyMap<string, { phones: string[]; from: Date; to: Date }> = new Map()): Promise<Map<string, LinkedOrder[]>> {
  const o = schema.orders;
  const out = new Map<string, LinkedOrder[]>(convs.map((c) => [c.id, []]));
  const conds: SQL[] = [];
  const ids = convs.map((c) => c.id);
  if (ids.length) conds.push(inArray(o.salesConversationId, ids));
  const orderIds = convs.flatMap((c) => [c.orderId, c.draftOrderId]).filter((x): x is string => Boolean(x));
  if (orderIds.length) conds.push(inArray(o.id, orderIds));
  const pairs = convs.filter((c) => c.pageId && c.threadId);
  if (pairs.length) conds.push(sql`(${o.pageId}, ${o.conversationId}) in (${sql.join(pairs.map((c) => sql`(${c.pageId}, ${c.threadId})`), sql`, `)})`);
  const allPhones = [...new Set([...phonesByConv.values()].flatMap((v) => v.phones))];
  if (allPhones.length) conds.push(or(inArray(o.billPhone, allPhones), inArray(o.shipPhone, allPhones))!);
  if (!conds.length) return out;
  const rows = await db
    .select({ id: o.id, at: o.insertedAt, stage: sql<string>`${o.stage}::text`, sc: o.salesConversationId, pageId: o.pageId, convId: o.conversationId, bill: o.billPhone, ship: o.shipPhone, prepaid: o.prepaid, transfer: o.transferMoney, total: o.totalPriceAfterDiscount, fee: o.shippingFee })
    .from(o)
    .where(or(...conds))
    .limit(20_000);
  const manual = rows.filter((r) => r.id.startsWith("erp-")).map((r) => r.id);
  const pay = new Map<string, { kind: string; amount: number; status: string }[]>();
  for (let i = 0; i < manual.length; i += 500) {
    const p = schema.orderPayments;
    for (const r of await db.select({ orderId: p.orderId, kind: p.kind, amount: p.amount, status: p.status }).from(p).where(inArray(p.orderId, manual.slice(i, i + 500)))) {
      const list = pay.get(r.orderId) ?? [];
      list.push({ kind: r.kind, amount: Number(r.amount), status: r.status });
      pay.set(r.orderId, list);
    }
  }
  for (const c of convs) {
    const ph = phonesByConv.get(c.id);
    for (const r of rows) {
      const by = new Set<LinkKind>();
      if (r.sc === c.id) by.add("BOT");
      if (r.id === c.orderId || r.id === c.draftOrderId) by.add("CONV_ORDER");
      if (c.pageId && c.threadId && r.pageId === c.pageId && r.convId === c.threadId) by.add("THREAD");
      const at = r.at ?? new Date(0);
      if (ph && ph.phones.some((p) => p === r.bill || p === r.ship) && at >= ph.from && at <= ph.to) by.add("PHONE");
      if (!by.size) continue;
      const payment = r.id.startsWith("erp-") ? manualPaymentStatus(sumConfirmedPayments(pay.get(r.id) ?? []), manualOrderAmountDue({ totalPriceAfterDiscount: Number(r.total ?? 0), shippingFee: Number(r.fee ?? 0) })).status : "N/A";
      out.get(c.id)!.push({ id: r.id, at, stage: r.stage, by, prepaidDeclared: Number(r.prepaid ?? 0) > 0 || Number(r.transfer ?? 0) > 0, payment });
    }
  }
  return out;
}

async function routeEvents(db: Db, convIds: readonly string[], from: Date): Promise<Map<string, RouteEvent[]>> {
  const e = schema.salesConversationEvents;
  const out = new Map<string, RouteEvent[]>();
  for (let i = 0; i < convIds.length; i += 500) {
    const rows = await db
      .select({ conv: e.conversationId, type: e.type, at: e.occurredAt, payload: e.payload })
      .from(e)
      .where(and(inArray(e.conversationId, convIds.slice(i, i + 500)), inArray(e.type, ["ai.replied", "followup.sent"]), gte(e.occurredAt, from)));
    for (const r of rows) {
      const mode = (r.payload as { mode?: unknown } | null)?.mode;
      const route: ReplyRoute = r.type === "followup.sent" ? "FOLLOWUP" : mode === "AI" || mode === "QUICK_REPLY" || mode === "SYSTEM" ? mode : "UNKNOWN";
      const list = out.get(r.conv) ?? [];
      list.push({ at: r.at, route });
      out.set(r.conv, list);
    }
  }
  return out;
}

export async function auditConversation(db: Db, conv: ConvRow, phoneTail: string | null) {
  const m = schema.salesChatMessages;
  const msgs = (await db.select({ seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(eq(m.conversationId, conv.id)).orderBy(desc(m.seq)).limit(80)).reverse();
  const events = (await routeEvents(db, [conv.id], new Date(0))).get(conv.id) ?? [];
  const st = (conv.state ?? {}) as Record<string, unknown>;
  const control = (st.control as { mode?: unknown } | undefined)?.mode;
  const sync = st.orderSync as { lastOutcome?: unknown; lastResult?: unknown; customer?: { phone?: unknown } } | undefined;

  console.log(`Hội thoại ${conv.id} · kênh ${conv.channel} · trạng thái ${conv.status} · điều khiển ${typeof control === "string" ? control : "AUTO"} · lý do chuyển người ${conv.handoffReason ? classifyHandoffReason(conv.handoffReason) : "—"} · ghi đơn từ hội thoại ${typeof sync?.lastOutcome === "string" ? sync.lastOutcome : "—"} · có lỗi lượt ${conv.lastError ? "có" : "không"}`);

  // Tin bot gần nhất: đường trả lời + câu khẳng định.
  const botRoutes: Record<string, number> = {};
  let payClaims = 0;
  let orderClaims = 0;
  const toolCalls: Record<string, number> = {};
  for (const x of msgs) {
    if (x.role === "assistant") {
      for (const b of blocksOf(x.content)) if (b.type === "tool_use" && typeof b.name === "string") bump(toolCalls, `${b.name} gọi`);
      const text = textOfContent(x.content);
      if (!text) continue;
      const route = routeOf(x.at, events);
      const claims = detectClaims(text);
      bump(botRoutes, route);
      if (claims.includes("PAYMENT_RECEIVED")) payClaims += 1;
      if (claims.includes("ORDER_CONFIRMED")) orderClaims += 1;
      console.log(`  tin bot #${x.seq} ${x.at.toISOString()} · đường ${route} · khẳng định TIỀN ${claims.includes("PAYMENT_RECEIVED") ? "CÓ" : "không"} · khẳng định ĐƠN ${claims.includes("ORDER_CONFIRMED") ? "CÓ" : "không"} · ${text.length} ký tự`);
    } else {
      for (const b of blocksOf(x.content)) {
        if (b.type !== "tool_result") continue;
        let reason = "";
        try {
          const p = JSON.parse(String(b.content)) as { reason?: unknown };
          if (typeof p.reason === "string" && /^[A-Z_]{2,40}$/.test(p.reason)) reason = ` (${p.reason})`;
        } catch {
          /* kết quả không phải JSON — chỉ đếm */
        }
        bump(toolCalls, b.isError ? `kết quả LỖI${reason}` : "kết quả OK");
      }
    }
  }
  const sm = schema.salesChatStaffMessages;
  const staff = await db.select({ n: sql<number>`count(*)::int` }).from(sm).where(eq(sm.conversationId, conv.id));

  // Đơn theo từng phép nối; SĐT khách gõ ±3 ngày quanh tin.
  const customerTexts = msgs.filter((x) => x.role === "user" && isCustomerMessage(x.content)).map((x) => ({ text: textOfContent(x.content), at: x.at }));
  const typedPhones = [...new Set(customerTexts.flatMap((t) => phonesStrict(t.text)))];
  const ats = customerTexts.map((t) => t.at.getTime());
  const win = ats.length ? { from: new Date(Math.min(...ats) - 3 * 86_400_000), to: new Date(Math.max(...ats) + 3 * 86_400_000) } : { from: new Date(0), to: new Date(0) };
  const orders = (await linkedOrders(db, [conv], new Map([[conv.id, { phones: typedPhones, ...win }]]))).get(conv.id) ?? [];
  const byLink: Record<string, number> = {};
  for (const o of orders) for (const k of o.by) bump(byLink, k);
  for (const o of orders) console.log(`  đơn ${o.id.slice(0, 12)}… ${o.at.toISOString()} · ${o.stage} · nối bằng ${[...o.by].join("+")} · POS khai trả trước ${o.prepaidDeclared ? "có" : "không"} · chứng từ thu ${o.payment}`);

  tomTat(`sales-lifecycle-audit hội thoại: ${conv.channel} · ${conv.status} · tin bot ${Object.values(botRoutes).reduce((a, b) => a + b, 0)} (${fmt(botRoutes)}) · khẳng định TIỀN ${payClaims} · khẳng định ĐƠN ${orderClaims} · tin nhân viên gửi từ ERP ${Number(staff[0]?.n ?? 0)}`);
  tomTat(`Công cụ: ${fmt(toolCalls)} · ghi đơn từ hội thoại ${typeof sync?.lastOutcome === "string" ? sync.lastOutcome : "—"}`);
  tomTat(`Đơn nối được ${orders.length} (sống ${orders.filter(liveOrder).length}) · theo phép nối ${fmt(byLink)} · POS khai trả trước ${orders.filter((o) => o.prepaidDeclared).length} · chứng từ thu đủ ${orders.filter((o) => o.payment === "PAID").length}`);

  if (phoneTail) {
    const inb = schema.salesChatInbound;
    const inbound = conv.pageId && conv.threadId ? await db.select({ text: inb.text, note: inb.note }).from(inb).where(and(eq(inb.pageId, conv.pageId), eq(inb.threadId, conv.threadId))).orderBy(asc(inb.createdAt)).limit(2000) : [];
    const custInbound = inbound.filter((r) => r.note !== PAGE_REPLY && r.note !== MEDIA_ONLY_NOTE).map((r) => r.text);
    const allCustText = [...customerTexts.map((t) => t.text), ...custInbound].join("\n");
    const imageText = [...allCustText.matchAll(/\[Khách gửi (?:\d+ )?ảnh: ([^\]]*)\]/g)].map((x) => x[1]).join("\n");
    const cust = conv.customerId ? (await db.select({ phone: schema.customers.phone }).from(schema.customers).where(eq(schema.customers.id, conv.customerId)).limit(1))[0] : undefined;
    const ret = (st.returning as { phones?: unknown } | undefined)?.phones;
    const orderPhones = orders.length ? await db.select({ bill: schema.orders.billPhone, ship: schema.orders.shipPhone }).from(schema.orders).where(inArray(schema.orders.id, orders.map((o) => o.id))) : [];
    const src: [string, boolean][] = [
      ["state.customer.phone", hasTail([(st.customer as { phone?: string } | undefined)?.phone], phoneTail)],
      ["conv.customer_phone", hasTail([conv.customerPhone], phoneTail)],
      ["customers.phone (hồ sơ nối)", hasTail([cust?.phone], phoneTail)],
      ["state.returning.phones (Pancake ghi nhận)", hasTail(Array.isArray(ret) ? (ret as string[]) : [], phoneTail)],
      ["state.pancakePhones (nhập lịch sử)", hasTail(Array.isArray(st.pancakePhones) ? (st.pancakePhones as string[]) : [], phoneTail)],
      ["state.orderSync.customer", hasTail([typeof sync?.customer?.phone === "string" ? sync.customer.phone : null], phoneTail)],
      ["chữ khách — biểu thức đang chạy", hasTail(phonesStrict(allCustText), phoneTail)],
      ["chữ khách — biểu thức nới", hasTail(phonesLoose(allCustText), phoneTail)],
      ["tin phía page (PAGE_REPLY)", hasTail(phonesLoose(inbound.filter((r) => r.note === PAGE_REPLY).map((r) => r.text).join("\n")), phoneTail)],
      ["dòng mô tả ảnh", hasTail(phonesLoose(imageText), phoneTail)],
      ["SĐT đơn nối được", hasTail(orderPhones.flatMap((r) => [r.bill, r.ship]), phoneTail)],
    ];
    const media = inbound.filter((r) => r.note === MEDIA_ONLY_NOTE).length;
    // Mỗi dòng tóm tắt ≤ 300 ký tự ⇒ chia hai nửa, không cắt mất nguồn nào.
    const half = Math.ceil(src.length / 2);
    tomTat(`Đuôi SĐT đã cho (1/2) — ${src.slice(0, half).map(([k, v]) => `${k}: ${v ? "CÓ" : "không"}`).join(" · ")}`);
    tomTat(`Đuôi SĐT đã cho (2/2) — ${src.slice(half).map(([k, v]) => `${k}: ${v ? "CÓ" : "không"}`).join(" · ")} · tin ghi âm / video / tệp (bot không đọc) ${media}`);
    for (const [k, v] of src) console.log(`  đuôi SĐT ở ${k}: ${v ? "CÓ" : "không"}`);
    console.log(`  tin ghi âm / video / tệp: ${media}`);
  }
}

export async function auditPatterns(db: Db, days: number, now: Date) {
  const from = new Date(now.getTime() - days * 86_400_000);
  const c = schema.salesChatConversations;
  const convs = await db.select().from(c).where(gte(c.updatedAt, from)).orderBy(desc(c.updatedAt)).limit(LIFECYCLE_MAX_CONVERSATIONS + 1);
  const capped = convs.length > LIFECYCLE_MAX_CONVERSATIONS;
  const list = convs.slice(0, LIFECYCLE_MAX_CONVERSATIONS);
  const ids = list.map((x) => x.id);
  const events = await routeEvents(db, ids, from);
  const orders = await linkedOrders(db, list);
  const m = schema.salesChatMessages;
  const A = { convs: 0, withReceipt: 0, withoutReceipt: 0, route: {} as Record<string, number> };
  const B = { convs: 0, withPosThread: 0, withoutPosThread: 0, route: {} as Record<string, number> };
  const C = { convs: 0, replied: 0, handedOff: 0, silent: 0 };
  const F = { sends: 0, afterOrder: 0 };
  const sample: Record<"A" | "B" | "C" | "D" | "F", string[]> = { A: [], B: [], C: [], D: [], F: [] };
  for (let i = 0; i < ids.length; i += 200) {
    const part = ids.slice(i, i + 200);
    const rows = await db.select({ conv: m.conversationId, seq: m.seq, role: m.role, content: m.content, at: m.createdAt }).from(m).where(and(inArray(m.conversationId, part), gte(m.createdAt, from))).orderBy(asc(m.conversationId), asc(m.seq));
    const byConv = new Map<string, typeof rows>();
    for (const r of rows) byConv.set(r.conv, [...(byConv.get(r.conv) ?? []), r]);
    for (const cv of list.filter((x) => part.includes(x.id))) {
      const msgs = byConv.get(cv.id) ?? [];
      const ord = orders.get(cv.id) ?? [];
      const ev = events.get(cv.id) ?? [];
      let a = false;
      let b = false;
      let cImg = false;
      for (let k = 0; k < msgs.length; k++) {
        const x = msgs[k];
        if (x.role === "assistant") {
          const text = textOfContent(x.content);
          if (!text) continue;
          const claims = detectClaims(text);
          if (claims.includes("PAYMENT_RECEIVED") && !a) {
            a = true;
            bump(A.route, routeOf(x.at, ev));
            if (ord.some((o) => o.payment === "PAID")) A.withReceipt += 1;
            else A.withoutReceipt += 1;
          }
          if (claims.includes("ORDER_CONFIRMED") && !b) {
            const ok = ord.some((o) => liveOrder(o) && o.at.getTime() <= x.at.getTime() + ORDER_CLAIM_WINDOW_MS && (o.by.has("BOT") || o.by.has("CONV_ORDER") || o.by.has("THREAD")) && o.stage !== "NEW");
            if (!ok) {
              b = true;
              bump(B.route, routeOf(x.at, ev));
              if (ord.some((o) => o.by.has("THREAD"))) B.withPosThread += 1;
              else B.withoutPosThread += 1;
            }
          }
        } else if (isCustomerMessage(x.content) && !cImg && hasPaymentImage(textOfContent(x.content))) {
          cImg = true;
          const next = msgs.slice(k + 1).find((y) => y.role === "assistant" ? Boolean(textOfContent(y.content)) : isCustomerMessage(y.content));
          if (next?.role === "assistant") C.replied += 1;
          else if (cv.status === "HANDOFF") C.handedOff += 1;
          else C.silent += 1;
        }
      }
      if (a) {
        A.convs += 1;
        if (sample.A.length < 20) sample.A.push(cv.id);
      }
      if (b) {
        B.convs += 1;
        if (sample.B.length < 20) sample.B.push(cv.id);
      }
      if (cImg) {
        C.convs += 1;
        if (sample.C.length < 20) sample.C.push(cv.id);
      }
      for (const e of ev.filter((y) => y.route === "FOLLOWUP")) {
        F.sends += 1;
        if (ord.some((o) => liveOrder(o) && o.at.getTime() < e.at.getTime())) {
          F.afterOrder += 1;
          if (sample.F.length < 20 && !sample.F.includes(cv.id)) sample.F.push(cv.id);
        }
      }
    }
  }
  let D = 0;
  let E = 0;
  for (const cv of list) {
    const ord = orders.get(cv.id) ?? [];
    if (ord.some((o) => o.by.has("THREAD") && !o.by.has("BOT"))) {
      D += 1;
      if (sample.D.length < 20) sample.D.push(cv.id);
    }
    const ret = ((cv.state ?? {}) as { returning?: { phones?: unknown } }).returning?.phones;
    if (!cv.customerPhone && Array.isArray(ret) && ret.length > 0) E += 1;
  }
  console.log(`Kỳ ${days} ngày tới ${now.toISOString()} · ${list.length} hội thoại${capped ? ` (cắt ở ${LIFECYCLE_MAX_CONVERSATIONS})` : ""}`);
  for (const [k, v] of Object.entries(sample)) console.log(`  mẫu ${k} (≤ 20 mã hội thoại): ${v.join(" ") || "—"}`);
  tomTat(`sales-lifecycle-audit ${days} ngày: ${list.length}${capped ? "+" : ""} hội thoại`);
  tomTat(`A bot nói đã nhận tiền: ${A.convs} hội thoại (có chứng từ thu ${A.withReceipt} · KHÔNG ${A.withoutReceipt}) · đường ${fmt(A.route)}`);
  tomTat(`B bot nói đã chốt mà không có đơn sống trong 30 phút: ${B.convs} (có đơn POS cùng luồng ${B.withPosThread} · không ${B.withoutPosThread}) · đường ${fmt(B.route)}`);
  tomTat(`C khách gửi ảnh chuyển khoản: ${C.convs} (bot trả lời ${C.replied} · chuyển người ${C.handedOff} · im ${C.silent})`);
  tomTat(`D đơn POS cùng luồng mà không mang khoá hội thoại: ${D} hội thoại · E customer_phone trống mà Pancake đã ghi nhận SĐT: ${E}`);
  tomTat(`F nhắn lại khách: ${F.sends} lần · trong đó SAU khi đã có đơn nối được ${F.afterOrder}`);
}

async function main() {
  const args = parseLifecycleArgs(process.argv.slice(2));
  if ("error" in args) {
    tomTat(`sales-lifecycle-audit: DỪNG · cách dùng sai — ${args.error} (arg: ${USAGE})`);
    process.exit(1);
  }
  const org = await findOrganization(args.code);
  if (!org) {
    tomTat(`sales-lifecycle-audit: DỪNG · không có tổ chức «${args.code}»`);
    process.exit(1);
  }
  const db: Db = await getDbForInspection({ code: org.code, isHome: org.isHome });
  const [ro] = rowsOf<Record<string, unknown>>(await db.execute(sql`show default_transaction_read_only`));
  if (String(ro?.default_transaction_read_only ?? "") !== "on") {
    tomTat("sales-lifecycle-audit: DỪNG · phiên CSDL KHÔNG ở chế độ chỉ đọc — không đọc gì");
    process.exit(1);
  }
  if (args.conv) {
    const [conv] = await db.select().from(schema.salesChatConversations).where(eq(schema.salesChatConversations.id, args.conv)).limit(1);
    if (!conv) {
      tomTat("sales-lifecycle-audit: DỪNG · không có hội thoại này trong tổ chức đã chọn");
      process.exit(1);
    }
    await auditConversation(db, conv, args.phoneTail);
  } else {
    if (args.phoneTail) tomTat(`sales-lifecycle-audit: ${TAIL_FLAG} chỉ dùng cùng --conv — bỏ qua`);
    await auditPatterns(db, args.days, new Date());
  }
  process.exit(0);
}

// Chỉ chạy khi được gọi THẲNG từ dòng lệnh — `import` từ bài kiểm không được kéo theo `process.exit`.
if (CHAY_THANG) {
  main().catch((e) => {
    console.error("sales-lifecycle-audit lỗi:", e instanceof Error ? e.message : e);
    tomTat("sales-lifecycle-audit: LỖI ngoài phép đo — chi tiết trong phần mã hoá");
    process.exit(1);
  });
}
