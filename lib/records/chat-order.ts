import { and, eq, inArray, isNull, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { can, type SessionUser } from "@/lib/auth/session";
import type { ManualOrderVariantOption } from "@/lib/constants/manual-orders";
import { fail, type MetaFailure } from "@/lib/metadata/errors";
import { findOrCreateCustomerForUser } from "@/lib/records/customer-create";
import { createManualOrderCore, manualOrderFormOptions, manualOrderGate } from "@/lib/records/order-create";
import { CHAT_CHANNEL_LABEL, type ChatChannel } from "@/lib/sales-chatbot/config";
import { recordConversationEvent } from "@/lib/sales-chatbot/events";

/**
 * ═══════════ NHÂN VIÊN TẠO ĐƠN NGAY TRONG KHUNG CHAT (POS tự chủ · P5 · docs/verticals/pos-tu-chu.md) ═══════════
 *
 * Người bán đang nói chuyện với khách thì tạo đơn tại chỗ, không chép tay sang trang Đơn hàng. Lõi KHÔNG viết đường tạo đơn
 * thứ hai: đi ĐÚNG `createManualOrderCore` (cổng tổ chức + `orders:write` + zod + khách / mẫu mã có thật + một giao dịch + nhật
 * ký) rồi gắn đơn về hội thoại. Bốn luật:
 *  1. MỘT LƯỢT BẤM, MỘT ĐƠN. Form sinh `requestKey` mỗi lần mở; khoá `chat:<hội thoại>:<requestKey>` đi vào khoá lần mua của
 *     lõi ⇒ bấm hai lần / gửi lại trả ĐÚNG đơn đã tạo. Sự kiện hội thoại mang khoá tất định `human-order:<đơn>`.
 *  2. ĐƠN CỦA NGƯỜI LÀ ĐƠN CỦA NGƯỜI. `origin = ERP_FORM` (không phải AI_AGENT), sự kiện `actorKind = HUMAN` kèm khoá tài
 *     khoản (luật 34) — màn «Hiệu quả» so AI với người đọc đúng hai cột này; gán nhầm là cộng công cho bot.
 *  3. KHÔNG ĐÈ. Đơn đã mang khoá hội thoại khác thì không đổi (`sales_conversation_id is null`); khách đã có cùng SĐT thì dùng
 *     lại, KHÔNG sửa tên / địa chỉ đang lưu (mục 3.12) — địa chỉ của lần mua này vào NGƯỜI NHẬN của đơn.
 *  4. CẢNH BÁO, KHÔNG CHẶN. Hội thoại đã có đơn còn sống (bot chốt hay người tạo) ⇒ form hiện cảnh báo trùng; người quyết.
 * Hội thoại khung thử (`TEST`) không tạo đơn thật.
 */

export type ChatOrderExisting = { id: string; stage: string; byBot: boolean };

export type ChatOrderContext = {
  canCreate: boolean;
  reason: string | null;
  channel: string;
  customer: { id: string; name: string; phone: string; address: string; province: string } | null;
  variants: ManualOrderVariantOption[];
  /** Đơn CÒN SỐNG đã gắn với hội thoại — để form cảnh báo trùng. */
  existing: ChatOrderExisting[];
};

const DEAD_STAGES = ["CANCELLED", "DELETED"] as const;

async function loadConversation(conversationId: unknown): Promise<{ ok: true; id: string; channel: string; customerId: string | null; orderId: string | null; draftOrderId: string | null } | MetaFailure> {
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 200) return fail("NOT_FOUND", "Không có hội thoại này.");
  const db = await getDb();
  const c = schema.salesChatConversations;
  const [row] = await db.select({ id: c.id, channel: c.channel, customerId: c.customerId, orderId: c.orderId, draftOrderId: c.draftOrderId }).from(c).where(eq(c.id, conversationId)).limit(1);
  if (!row) return fail("NOT_FOUND", "Không có hội thoại này.");
  if (row.channel === "TEST") return fail("NOT_SUPPORTED", "Hội thoại ở khung thử — không tạo đơn thật.");
  return { ok: true, ...row };
}

async function existingOrders(conv: { id: string; orderId: string | null; draftOrderId: string | null }): Promise<ChatOrderExisting[]> {
  const db = await getDb();
  const o = schema.orders;
  const linked = [conv.orderId, conv.draftOrderId].filter((x): x is string => Boolean(x));
  const rows = await db
    .select({ id: o.id, stage: o.stage, origin: o.origin })
    .from(o)
    .where(and(linked.length ? or(eq(o.salesConversationId, conv.id), inArray(o.id, linked)) : eq(o.salesConversationId, conv.id), notInArray(o.stage, [...DEAD_STAGES])))
    .limit(20);
  return rows.map((r) => ({ id: r.id, stage: r.stage, byBot: r.origin === "AI_AGENT" || r.origin === "AI_ORDER_SYNC" || linked.includes(r.id) }));
}

/** Dữ liệu cho form (KHÔNG đọc tin nhắn của hội thoại): quyền, khách của hội thoại, mẫu mã chọn được, đơn đã có. */
export async function chatOrderContext(user: SessionUser, conversationId: unknown): Promise<{ ok: true; value: ChatOrderContext } | MetaFailure> {
  const conv = await loadConversation(conversationId);
  if (!conv.ok) return conv;
  const gate = await manualOrderGate(user);
  const db = await getDb();
  const [customer] = conv.customerId
    ? await db.select({ id: schema.customers.id, name: schema.customers.name, phone: schema.customers.phone, address: schema.customers.address, province: schema.customers.province }).from(schema.customers).where(eq(schema.customers.id, conv.customerId)).limit(1)
    : [];
  const [variants, existing] = gate.allowed ? await Promise.all([manualOrderFormOptions().then((x) => x.variants), existingOrders(conv)]) : [[], [] as ChatOrderExisting[]];
  return {
    ok: true,
    value: {
      canCreate: gate.allowed,
      reason: gate.allowed ? null : gate.reason,
      channel: CHAT_CHANNEL_LABEL[conv.channel as ChatChannel] ?? conv.channel,
      customer: customer ? { id: customer.id, name: customer.name, phone: customer.phone ?? "", address: customer.address ?? "", province: customer.province ?? "" } : null,
      variants,
      existing,
    },
  };
}

const lineZ = z.object({ variantId: z.string().min(1).max(200), quantity: z.number(), unitPrice: z.number(), discount: z.number().default(0) }).strict();
const inputZ = z
  .object({
    /** Một khoá cho MỘT lần mở form — chống bấm hai lần. */
    requestKey: z.string().trim().regex(/^[A-Za-z0-9-]{8,64}$/, "Khoá lượt bấm không hợp lệ — mở lại form."),
    customerId: z.string().trim().max(200).nullable().default(null),
    name: z.string().trim().max(200).default(""),
    phone: z.string().trim().max(30).default(""),
    address: z.string().trim().max(300).default(""),
    province: z.string().trim().max(120).default(""),
    stage: z.enum(["NEW", "CONFIRMED"]).default("CONFIRMED"),
    lines: z.array(lineZ).min(1, "Đơn cần ít nhất một dòng hàng").max(50),
    shippingFee: z.number().default(0),
    orderDiscount: z.number().default(0),
    note: z.string().max(500).default(""),
  })
  .strict();

export type ChatOrderResult = { ok: true; orderId: string; reused: boolean; customerExisting: boolean | null } | MetaFailure;

export async function createOrderFromChatCore(user: SessionUser, conversationId: unknown, rawInput: unknown): Promise<ChatOrderResult> {
  if (!can(user, "orders:write")) return fail("FORBIDDEN", "Bạn không có quyền tạo đơn hàng (orders:write).");
  const conv = await loadConversation(conversationId);
  if (!conv.ok) return conv;
  const parsed = inputZ.safeParse(rawInput);
  if (!parsed.success) return fail("INVALID", parsed.error.issues.map((i) => ({ field: i.path.map(String).join(".") || "_", message: i.message })));
  const v = parsed.data;
  const db = await getDb();

  // ── Khách: chọn sẵn ⇒ phải có thật; không chọn ⇒ tìm / tạo theo SĐT (không đè hồ sơ đang lưu) ──
  let customerId: string;
  let customerExisting: boolean | null = null;
  if (v.customerId) {
    const [c] = await db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.id, v.customerId)).limit(1);
    if (!c) return fail("INVALID", [{ field: "customerId", message: "Khách đã chọn không còn — chọn lại." }]);
    customerId = c.id;
  } else {
    const found = await findOrCreateCustomerForUser(user, { name: v.name, phone: v.phone, address: v.address, province: v.province });
    if (!found.ok) return found;
    customerId = found.id;
    customerExisting = found.existing;
  }

  const created = await createManualOrderCore(
    user,
    {
      customerId,
      stage: v.stage,
      lines: v.lines,
      shippingFee: v.shippingFee,
      orderDiscount: v.orderDiscount,
      note: v.note,
      channel: CHAT_CHANNEL_LABEL[conv.channel as ChatChannel] ?? conv.channel,
      // Người nhận của LẦN MUA này — ô trống lấy của hồ sơ khách (lõi quyết).
      recipient: { name: v.name, phone: v.phone, address: v.address, province: v.province },
    },
    { idempotencyKey: `chat:${conv.id}:${v.requestKey}` },
  );
  if (!created.ok) return created;
  const orderId = created.id;

  // ── Gắn đơn về hội thoại: chỉ khi đơn chưa mang khoá hội thoại nào; nguồn = người (ERP_FORM) ──
  const o = schema.orders;
  const linked = await db
    .update(o)
    .set({ salesConversationId: conv.id, origin: sql`coalesce(${o.origin}, 'ERP_FORM')` })
    .where(and(eq(o.id, orderId), isNull(o.salesConversationId)))
    .returning({ id: o.id, total: o.totalPriceAfterDiscount, stage: o.stage });
  const [row] = linked.length ? linked : await db.select({ id: o.id, total: o.totalPriceAfterDiscount, stage: o.stage }).from(o).where(eq(o.id, orderId)).limit(1);
  await recordConversationEvent(conv.id, {
    type: row?.stage === "CONFIRMED" ? "order.confirmed" : "order.drafted",
    actorKind: "HUMAN",
    actorUserId: user.id,
    occurredAt: new Date(),
    orderId,
    amountVnd: row ? Number(row.total) : null,
    key: `human-order:${orderId}`,
  });
  if (!created.reused) {
    await audit({ userId: user.id, userEmail: user.email, action: "SALES_CHAT_ORDER_CREATE", entity: "ORDER", entityId: orderId, before: null, after: { conversationId: conv.id, channel: conv.channel, customerId, customerExisting, stage: row?.stage ?? v.stage }, reason: "Tạo đơn trong khung chat" });
  }
  return { ok: true, orderId, reused: Boolean(created.reused), customerExisting };
}
