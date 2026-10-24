/**
 * ═══ HỘI THOẠI ĐÃ CÓ ĐƠN CỦA NGƯỜI ⇒ BOT KHÔNG TẠO / KHÔNG CHỐT ĐƠN THỨ HAI (P0 HSLC 24/10/2026) — CHỈ MÁY CHỦ ═══
 *
 * Hai cặp thật cùng một ngày, cùng một chuỗi: nhân viên lên đơn bằng form hộp thư (#D2A8DE9B 02:47:56Z · #1BFC04D7 03:12:13Z), bấm
 * «Trả lại cho AI», khách nhắn tiếp (hoặc đường resume chạy lại lượt bị nhường) ⇒ bot tạo + TỰ CHỐT đơn thứ hai cùng SĐT · cùng món
 * (#A5CC67E2 · #6CBDB6B5), cả bốn đơn «Đã xác nhận». Gốc: `create_draft_order` chỉ hỏi state CỦA BOT (`state.draft` /
 * `state.confirmed`), còn đơn của người chỉ nằm ở `orders.sales_conversation_id` — bot không bao giờ thấy nó.
 *
 * Luật (hai đường của bot: tạo đơn mới + chốt, gồm cả máy tự chốt): trước khi tạo / chốt, đọc đơn ĐANG MỞ của LƯỢT MUA HIỆN TẠI —
 * chưa rời kho (`PRE_SHIP_STAGES`, không lần gửi nào đã qua tay ĐVVC), tạo trong `CONVERSATION_ORDER_GUARD_HOURS` — của
 * CHÍNH hội thoại (khoá `sales_conversation_id`, hoặc đơn Pancake cùng page + cùng thread) tạo trong `CONVERSATION_ORDER_GUARD_HOURS`
 * mà KHÔNG phải đơn của bot — đơn bot ghi trong state (nháp / đã chốt / lượt mua trước) hoặc mang khoá lần mua của bot cho đúng hội
 * thoại này (`sales-chat:<hội thoại>:`) đã có luật lượt mua riêng. Có ⇒ KHÔNG tạo / KHÔNG chốt, trả bot đúng câu «đã có đơn #…»;
 * khách nói khác đơn đã có (`assessDuplicate` không phải DUPLICATE_SUSPECTED) ⇒ chuyển người sửa ĐÚNG đơn đó. Ngoại lệ DUY NHẤT:
 * khách nói RÕ muốn thêm một ĐƠN RIÊNG (`separateOrderIntent`, mã lý do `CUSTOMER_EXPLICIT_SEPARATE_ORDER`) ⇒ cho tạo, nhưng KHÔNG
 * tự chốt — khách đồng ý tóm tắt ở tin sau mới chốt.
 *
 * Không huỷ / sửa đơn nào. Mỗi lần chặn để lại một dòng nhật ký (`SALES_CHAT_DUPLICATE_ORDER_BLOCKED`) để đếm.
 * Chưa phủ (pha 2): khoá giao dịch theo hội thoại cho ba đường tạo đơn (bot · form · ghi đơn từ hội thoại) — hôm nay kiểm ở đây chạy
 * NGOÀI giao dịch ghi, nên hai cú tạo trong cùng một giây vẫn lọt; khách C360 ở hội thoại khác; cờ «Nghi trùng đơn» trên /orders.
 */
import { and, eq, gte, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { assessDuplicate, CONVERSATION_ORDER_GUARD_HOURS, type DuplicateCandidate, type ItemLike } from "@/lib/constants/order-duplicate";
import { ORDER_STAGE_LABEL, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import type { OrderStage } from "@/db/schema";
import { formatDateTime, formatVND } from "@/lib/format";
import { foldVi } from "@/lib/sales-chatbot/text";

export type ConversationOrder = DuplicateCandidate & { stage: OrderStage; origin: string | null; agentKey: string | null };

export const SEPARATE_ORDER_REASON = "CUSTOMER_EXPLICIT_SEPARATE_ORDER";

/** Ai lên đơn đã có — cho câu nói với bot và nhật ký. HÀM THUẦN. */
export function existingOrderMaker(o: Pick<ConversationOrder, "orderId" | "origin" | "agentKey">): string {
  if (o.origin === "ERP_FORM" || o.agentKey?.startsWith("chat:")) return "nhân viên (form hộp thư ERP)";
  if (o.origin === "AI_ORDER_SYNC" || o.agentKey?.startsWith("order-sync:")) return "nhân viên chốt trên fanpage (máy ghi hộ)";
  if (!o.orderId.startsWith("erp-")) return "nhân viên (đơn Pancake)";
  if (o.agentKey?.startsWith("sales-chat:")) return "bot (lượt khác)";
  return "nhân viên";
}

/**
 * Khách nói RÕ muốn một ĐƠN RIÊNG / THÊM MỘT ĐƠN (không phải «thêm món» vào đơn đang có). HÀM THUẦN, cố ý hẹp: phải có chữ «đơn» đi
 * cùng một chữ tách / thêm / riêng / nữa / thứ hai; câu phủ định («không cần tách đơn», «khỏi lên thêm đơn») không tính.
 */
export function separateOrderIntent(texts: readonly string[]): boolean {
  return texts.some((t) => {
    const f = ` ${foldVi(t).replace(/[^a-z0-9]+/g, " ").trim()} `;
    const hit = /( don rieng | tach (ra )?(lam |thanh )?(2|hai) don | tach don | (them|1|mot) don (nua|rieng|khac|moi nua) | (dat|len|tao|lam|gui) (them )?(1 |mot )?don (nua|rieng|khac|thu (2|hai)) | (dat|len|tao|lam) them (1 |mot )?don | don thu (2|hai) | them (1 |mot )?don nua )/.test(f);
    const neg = /( (khong|ko|k|hong|khoi|chua) (can |phai )?(tach|them|len them|dat them|lam them|don rieng) )/.test(f);
    return hit && !neg;
  });
}

export type ConversationOrderVerdict =
  | { kind: "PROCEED" }
  | { kind: "SEPARATE_ALLOWED"; reasonCode: typeof SEPARATE_ORDER_REASON; existingIds: string[] }
  | { kind: "BLOCK"; order: ConversationOrder; sameAsProposal: boolean };

/**
 * Quyết định từ danh sách đơn đã có (đã lọc: còn sống, trong cửa sổ, không phải của bot) + đề nghị của bot. HÀM THUẦN. Đơn chặn =
 * đơn MỚI NHẤT. `sameAsProposal` = cùng SĐT + cùng mẫu mã × số lượng (`assessDuplicate` DUPLICATE_SUSPECTED) — bot chỉ cần báo khách
 * đơn đã lên; khác ⇒ khách đang sửa ⇒ việc của người.
 */
export function decideConversationOrder(existing: readonly ConversationOrder[], proposal: DuplicateCandidate | null, customerTexts: readonly string[]): ConversationOrderVerdict {
  if (!existing.length) return { kind: "PROCEED" };
  if (separateOrderIntent(customerTexts)) return { kind: "SEPARATE_ALLOWED", reasonCode: SEPARATE_ORDER_REASON, existingIds: existing.map((o) => o.orderId) };
  const order = [...existing].sort((a, b) => b.insertedAt.getTime() - a.insertedAt.getTime() || b.orderId.localeCompare(a.orderId))[0];
  return { kind: "BLOCK", order, sameAsProposal: proposal ? assessDuplicate(order, proposal).verdict === "DUPLICATE_SUSPECTED" : false };
}

/** Câu trả về cho bot khi chặn (tạo / chốt). HÀM THUẦN. */
export function blockInstruction(v: Extract<ConversationOrderVerdict, { kind: "BLOCK" }>, step: "CREATE" | "CONFIRM"): string {
  const o = v.order;
  const code = `#${manualOrderShortCode(o.orderId)}`;
  const head = `Hội thoại này ĐÃ CÓ đơn ${code} do ${existingOrderMaker(o)} lên lúc ${formatDateTime(o.insertedAt)} (${ORDER_STAGE_LABEL[o.stage] ?? o.stage}, tiền hàng ${formatVND(o.total)}). ${step === "CREATE" ? "KHÔNG tạo đơn mới" : "KHÔNG chốt đơn nháp của bot"} — tránh hai đơn cho một lần mua; KHÔNG nói đã lên / đã chốt đơn mới.`;
  const tail = v.sameAsProposal && step === "CREATE"
    ? ` Báo khách ngắn gọn: đơn ${code} đã được lên đúng món này, shop sẽ giao theo đơn đó — không hỏi lại thông tin, không chốt lại.`
    : ` Khách nói khác đơn ${code} (món / số lượng / người nhận) ⇒ máy chủ đã chuyển nhân viên kiểm và sửa ĐÚNG đơn ${code}; nói khách nhân viên sẽ kiểm lại đơn, KHÔNG hứa đã sửa.`;
  return `${head}${tail} Chỉ khi khách nói RÕ muốn đặt THÊM một ĐƠN RIÊNG mới gọi lại create_draft_order.`;
}

type BotOwnState = { draft?: { orderId: string | null } | undefined; confirmed?: { orderId: string | null } | undefined; pastOrders?: readonly { orderId: string | null }[]; roundCheck?: { orderId: string; answer?: "NEW" | "SAME" } };

/**
 * ĐƠN ĐANG MỞ CỦA LƯỢT MUA HIỆN TẠI, KHÔNG phải của bot. Hai luật giữ «khách cũ mua lại» không bị chặn nhầm (golden
 * `khach-cu-van-dia-chi-cu`: đơn Pancake cũ ĐÃ GỬI cùng thread, khách quay lại mua tiếp): (1) đơn đã rời kho / đã giao / hoàn / huỷ là
 * lượt mua đã KẾT THÚC — chỉ đơn còn trong `PRE_SHIP_STAGES` và chưa có lần gửi nào qua tay ĐVVC mới chặn; (2) khách đã TRẢ LỜI «đặt
 * thêm» cho câu hỏi «đơn cũ hay đơn mới» của máy chủ về ĐÚNG đơn đó (`roundCheck.answer = NEW` — round-check.ts) ⇒ đơn ấy là của lượt
 * mua trước theo lời khách, không chặn.
 * CỐ Ý KHÔNG dùng mốc lượt mua (`roundStartAt`) làm mốc dưới: lượt mua mới có thể mở ĐÚNG lúc bot quay lại sau khi người giữ hội thoại
 * (khách im > 7 ngày trong sổ bot ⇒ `roundStartAt` = giờ hiện tại), và đơn người vừa lên trong lúc giữ sẽ nằm trước mốc ⇒ lọt rào.
 * Đơn CÒN SỐNG của hội thoại trong cửa sổ, KHÔNG phải của bot. `exclude` = thêm id bỏ qua (đơn khách đã nói rõ là đơn riêng). Ném khi
 * CSDL lỗi — người gọi quyết phía HẸP (không tạo).
 */
export async function otherConversationOrders(conversationId: string, state: BotOwnState, now: Date, exclude: readonly string[] = []): Promise<ConversationOrder[]> {
  const db = await getDb();
  const o = schema.orders;
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ pageId: c.pageId, threadId: c.threadId }).from(c).where(eq(c.id, conversationId)).limit(1);
  const answeredNew = state.roundCheck?.answer === "NEW" ? state.roundCheck.orderId : null;
  const own = [state.draft?.orderId, state.confirmed?.orderId, ...(state.pastOrders ?? []).map((p) => p.orderId), answeredNew, ...exclude].filter((x): x is string => typeof x === "string" && x.length > 0);
  const links: SQL[] = [eq(o.salesConversationId, conversationId)];
  if (conv?.pageId && conv.threadId) links.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  const botKey = `sales-chat:${conversationId}:`;
  const since = new Date(now.getTime() - CONVERSATION_ORDER_GUARD_HOURS * 3_600_000);
  const leftWarehouse = sql`exists (select 1 from ${schema.shipments} s where s.order_id = ${o.id} and coalesce(s.direction, 'OUTBOUND') <> 'RETURN' and s.stage::text not in ('PENDING', 'CANCELLED'))`;
  const rows = await db
    .select({ id: o.id, stage: o.stage, insertedAt: o.insertedAt, origin: sql<string | null>`${o.origin}::text`, agentKey: sql<string | null>`${o.raw}->>'agentKey'`, total: o.totalPriceAfterDiscount, phone: o.billPhone, name: o.billFullName, address: o.shipAddress })
    .from(o)
    .where(and(or(...links), inArray(o.stage, [...PRE_SHIP_STAGES]), sql`not ${leftWarehouse}`, gte(o.insertedAt, since), own.length ? notInArray(o.id, own) : undefined, sql`left(coalesce(${o.raw}->>'agentKey', ''), ${botKey.length}) <> ${botKey}`))
    .limit(10);
  if (!rows.length) return [];
  const items = await db
    .select({ orderId: schema.orderItems.orderId, variantId: schema.orderItems.variantId, sku: schema.orderItems.sku, productName: schema.orderItems.productName, variationDetail: schema.orderItems.variationDetail, quantity: schema.orderItems.quantity })
    .from(schema.orderItems)
    .where(and(inArray(schema.orderItems.orderId, rows.map((r) => r.id)), eq(schema.orderItems.isBonus, false)));
  return rows.map((r) => ({
    orderId: r.id,
    insertedAt: r.insertedAt,
    stage: r.stage,
    origin: r.origin,
    agentKey: r.agentKey,
    total: Number(r.total ?? 0) || 0,
    phone: r.phone ?? "",
    receiverName: r.name ?? "",
    address: r.address ?? "",
    items: items.filter((i) => i.orderId === r.id).map((i): ItemLike => ({ variantId: i.variantId, sku: i.sku ?? "", productName: i.productName ?? "", variationDetail: i.variationDetail ?? "", quantity: Number(i.quantity ?? 0) || 0 })),
  }));
}

/** Đề nghị của bot dạng so được với `assessDuplicate`. HÀM THUẦN. */
export function proposalCandidate(lines: readonly { variantId: string; quantity: number }[], recipient: { name: string; phone: string; address: string }, now: Date): DuplicateCandidate {
  return { orderId: "(đề nghị của bot)", insertedAt: now, phone: recipient.phone, receiverName: recipient.name, address: recipient.address, total: 0, items: lines.map((l) => ({ variantId: l.variantId, sku: "", productName: "", variationDetail: "", quantity: l.quantity })) };
}

/** Một dòng nhật ký mỗi lần chặn — đếm được bằng `audit_logs.action`. Không ném. */
export async function auditConversationOrderBlock(conversationId: string, v: Extract<ConversationOrderVerdict, { kind: "BLOCK" }>, step: "CREATE" | "CONFIRM", draftOrderId: string | null): Promise<void> {
  await audit({
    userId: null,
    userEmail: "agent:lib/sales-chatbot/conversation-order-guard.ts",
    actorKind: "AGENT",
    action: "SALES_CHAT_DUPLICATE_ORDER_BLOCKED",
    entity: "ORDER",
    entityId: v.order.orderId,
    after: { conversationId, step, sameAsProposal: v.sameAsProposal, existingStage: v.order.stage, existingOrigin: v.order.origin, draftOrderId },
    reason: `Bot không ${step === "CREATE" ? "tạo" : "chốt"} đơn: hội thoại đã có đơn #${manualOrderShortCode(v.order.orderId)} của ${existingOrderMaker(v.order)}`,
  }).catch(() => undefined);
}
