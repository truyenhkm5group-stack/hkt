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
import { and, desc, eq, gte, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { DbOrTx } from "@/lib/db-transaction";
import { audit } from "@/lib/audit";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { assessDuplicate, CONVERSATION_ORDER_GUARD_HOURS, phoneKey, type DuplicateCandidate, type ItemLike } from "@/lib/constants/order-duplicate";
import { ORDER_STAGE_LABEL, PRE_SHIP_STAGES } from "@/lib/constants/pancake";
import type { OrderStage } from "@/db/schema";
import { formatDateTime, formatVND } from "@/lib/format";
import { foldVi } from "@/lib/sales-chatbot/text";

/** `otherConversationOrders` của hội thoại KHÁC (khách C360 đã xác minh) — câu cho bot nói rõ, không giả là đơn của hội thoại này. */
export type ConversationOrder = DuplicateCandidate & { stage: OrderStage; origin: string | null; agentKey: string | null; otherConversation?: boolean };

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
  const head = `${o.otherConversation ? "Khách này (đã xác minh) ĐÃ CÓ đơn" : "Hội thoại này ĐÃ CÓ đơn"} ${code} do ${existingOrderMaker(o)}${o.otherConversation ? " ở hội thoại khác" : ""} lên lúc ${formatDateTime(o.insertedAt)} (${ORDER_STAGE_LABEL[o.stage] ?? o.stage}, tiền hàng ${formatVND(o.total)}). ${step === "CREATE" ? "KHÔNG tạo đơn mới" : "KHÔNG chốt đơn nháp của bot"} — tránh hai đơn cho một lần mua; KHÔNG nói đã lên / đã chốt đơn mới.`;
  const tail = v.sameAsProposal && step === "CREATE"
    ? ` Báo khách ngắn gọn: đơn ${code} đã được lên đúng món này, shop sẽ giao theo đơn đó — không hỏi lại thông tin, không chốt lại.`
    : ` Khách nói khác đơn ${code} (món / số lượng / người nhận) ⇒ máy chủ đã chuyển nhân viên kiểm và sửa ĐÚNG đơn ${code}; nói khách nhân viên sẽ kiểm lại đơn, KHÔNG hứa đã sửa.`;
  return `${head}${tail} Chỉ khi khách nói RÕ muốn đặt THÊM một ĐƠN RIÊNG mới gọi lại create_draft_order.`;
}

type BotOwnState = { draft?: { orderId: string | null } | undefined; confirmed?: { orderId: string | null } | undefined; pastOrders?: readonly { orderId: string | null }[]; roundCheck?: { orderId: string; answer?: "NEW" | "SAME" } };

/**
 * Đơn rào bỏ qua: đơn bot đã ghi trong state (nháp · đã chốt · lượt mua trước), đơn khách đã nói rõ là đơn riêng, và đơn mà khách đã TRẢ
 * LỜI «đặt thêm» cho câu hỏi «đơn cũ hay đơn mới» của máy chủ về ĐÚNG đơn đó (`roundCheck.answer = NEW` — round-check.ts). HÀM THUẦN.
 * CỐ Ý KHÔNG dùng mốc lượt mua (`roundStartAt`) làm mốc dưới: lượt mua mới có thể mở ĐÚNG lúc bot quay lại sau khi người giữ hội thoại
 * (khách im > 7 ngày trong sổ bot ⇒ `roundStartAt` = bây giờ) — đơn người vừa lên trong lúc giữ sẽ nằm trước mốc ⇒ lọt rào.
 */
export function botOwnOrderIds(state: BotOwnState, extra: readonly (string | null | undefined)[] = []): string[] {
  return [state.draft?.orderId, state.confirmed?.orderId, ...(state.pastOrders ?? []).map((p) => p.orderId), state.roundCheck?.answer === "NEW" ? state.roundCheck.orderId : null, ...extra].filter((x): x is string => typeof x === "string" && x.length > 0);
}

/**
 * Phạm vi của rào. `verifiedCustomerId` = hồ sơ khách ĐÃ XÁC MINH là người đang nhắn (mã Facebook — `verifiedCustomerId(state)`):
 * khi có, đơn CÓ NGƯỜI ĐỨNG SAU (`vouchedOrder`) của chính hồ sơ ấy ở hội thoại KHÁC trong cửa sổ cũng chặn (khách C360 — nhắn ở
 * page / kênh khác, nhân viên đã lên đơn ở đó). Hồ sơ gắn qua SĐT GÕ TAY thì KHÔNG: kẻ gian gõ SĐT nạn nhân không được thấy (hay bị
 * chặn bởi) đơn của nạn nhân (review bảo mật #651 / #656 — cùng luật với `vouchedOrder`).
 */
export type ConversationOrderScope = {
  conversationId: string;
  exclude: readonly string[];
  verifiedCustomerId: string | null;
  now: Date;
  /**
   * Tính CẢ đơn của bot trên hội thoại (khoá `sales-chat:<hội thoại>:`). Bot thì KHÔNG (đơn của chính nó có luật lượt mua riêng);
   * ghi đơn từ hội thoại (`order_sync` — máy ghi hộ lời chốt của nhân viên) thì CÓ: ops `order-dup-scan` 24/10/2026 đo 6 cặp
   * bot → «Fanpage (nhân viên chốt)» cách vài phút, luật «cùng khách 30 phút» của order_sync không bắt được.
   */
  includeBotOrders?: boolean;
  /**
   * Khoá lần mua của CHÍNH người gọi — đơn mang khoá bắt đầu bằng chuỗi này KHÔNG tính. order_sync truyền `order-sync:<hội thoại>:`:
   * đơn nó tự ghi trước đó đã có luật riêng (mốc cắt sau đơn vừa ghi + mã tin chốt trong ghi chú), và khách nói «1kg nữa» ba giờ sau
   * là lần mua MỚI hợp lệ (tests/sales-order-sync.test.ts). Rào ở đây chỉ để thấy đơn order_sync KHÔNG tự thấy: bot · form · Pancake.
   */
  ownKeyPrefix?: string;
};

/** Phần lỗi lõi đơn trả khi rào TRONG giao dịch ghi bắt được đơn vừa chen vào (hai cú tạo cùng giây). */
export const CONVERSATION_ORDER_FIELD = "conversationOrder";

export class ConversationOrderExistsError extends Error {
  constructor(readonly orders: ConversationOrder[]) {
    super(`Hội thoại đã có đơn #${manualOrderShortCode(orders[0]?.orderId ?? "")}`);
  }
}

/**
 * ĐƠN ĐANG MỞ CỦA LƯỢT MUA HIỆN TẠI (hội thoại + khách đã xác minh), KHÔNG phải của bot. Hai luật giữ «khách cũ mua lại» không bị
 * chặn nhầm (golden `khach-cu-van-dia-chi-cu`, CI #1029): (1) chỉ đơn còn trong `PRE_SHIP_STAGES` và chưa có lần gửi nào qua tay ĐVVC —
 * đơn đã gửi / giao / hoàn / huỷ là lượt mua đã KẾT THÚC; (2) khách đã trả lời «đặt thêm» cho đúng đơn đó (`botOwnOrderIds`).
 * Đơn CÒN SỐNG của hội thoại (và của khách đã xác minh) trong cửa sổ, KHÔNG phải của bot. `exec` = giao dịch đang giữ khoá hội thoại
 * (lõi đơn gọi lại TRONG giao dịch ghi) — không truyền thì đọc bằng kết nối thường. Ném khi CSDL lỗi — người gọi quyết phía HẸP.
 */
export async function otherConversationOrders(scope: ConversationOrderScope, exec?: DbOrTx): Promise<ConversationOrder[]> {
  const db = exec ?? (await getDb());
  const o = schema.orders;
  const c = schema.salesChatConversations;
  const [conv] = await db.select({ pageId: c.pageId, threadId: c.threadId }).from(c).where(eq(c.id, scope.conversationId)).limit(1);
  const links: SQL[] = [eq(o.salesConversationId, scope.conversationId)];
  if (conv?.pageId && conv.threadId) links.push(and(eq(o.pageId, conv.pageId), eq(o.conversationId, conv.threadId))!);
  if (scope.verifiedCustomerId) {
    // Nạp động: returning.ts nạp tools.ts, tools.ts nạp tệp này — nạp tĩnh là thành vòng.
    const { vouchedOrder } = await import("@/lib/sales-chatbot/returning");
    links.push(and(eq(o.customerId, scope.verifiedCustomerId), vouchedOrder(o))!);
  }
  const botKey = `sales-chat:${scope.conversationId}:`;
  const since = new Date(scope.now.getTime() - CONVERSATION_ORDER_GUARD_HOURS * 3_600_000);
  const leftWarehouse = sql`exists (select 1 from ${schema.shipments} s where s.order_id = ${o.id} and coalesce(s.direction, 'OUTBOUND') <> 'RETURN' and s.stage::text not in ('PENDING', 'CANCELLED'))`;
  const rows = await db
    .select({ id: o.id, stage: o.stage, insertedAt: o.insertedAt, origin: sql<string | null>`${o.origin}::text`, agentKey: sql<string | null>`${o.raw}->>'agentKey'`, total: o.totalPriceAfterDiscount, phone: o.billPhone, name: o.billFullName, address: o.shipAddress, conv: o.salesConversationId })
    .from(o)
    .where(and(or(...links, ...(scope.includeBotOrders ? [sql`left(coalesce(${o.raw}->>'agentKey', ''), ${botKey.length}) = ${botKey}`] : [])), inArray(o.stage, [...PRE_SHIP_STAGES]), sql`not ${leftWarehouse}`, gte(o.insertedAt, since), scope.exclude.length ? notInArray(o.id, [...scope.exclude]) : undefined, scope.includeBotOrders ? undefined : sql`left(coalesce(${o.raw}->>'agentKey', ''), ${botKey.length}) <> ${botKey}`, scope.ownKeyPrefix ? sql`left(coalesce(${o.raw}->>'agentKey', ''), ${scope.ownKeyPrefix.length}) <> ${scope.ownKeyPrefix}` : undefined))
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
    otherConversation: r.conv !== null && r.conv !== scope.conversationId,
    total: Number(r.total ?? 0) || 0,
    phone: r.phone ?? "",
    receiverName: r.name ?? "",
    address: r.address ?? "",
    items: items.filter((i) => i.orderId === r.id).map((i): ItemLike => ({ variantId: i.variantId, sku: i.sku ?? "", productName: i.productName ?? "", variationDetail: i.variationDetail ?? "", quantity: Number(i.quantity ?? 0) || 0 })),
  }));
}

/**
 * ═══ LỚP TẠM (P0 HSLC 24/10/2026, vụ #8639C563 → #E2867CF0) — HẾT HIỆU LỰC KHI PHA 3 (gộp vào đơn bot đang mở của CÙNG DANH TÍNH)
 * VÀ LIÊN KẾT DANH TÍNH BÌNH LUẬN ↔ HỘP THƯ LÊN ═══
 *
 * Bình luận và Messenger là HAI hội thoại; hôm nay ERP chưa nối được danh tính giữa chúng (0/709 hồ sơ có mã Facebook), nên bot ở hộp
 * thư không thấy đơn bot vừa tự chốt ở bình luận và lên đơn thứ hai. Lớp này KHÔNG chặn, KHÔNG chuyển người (HSLC đang có ~100+ hội
 * thoại chuyển người chưa ai nhận — chuyển thêm là mất đơn thật — Tech Lead 24/10): SĐT GÕ ở hội thoại này trùng SĐT (9 số cuối) của
 * một đơn BOT ĐANG MỞ (PRE_SHIP, chưa qua ĐVVC, ≤ `CONVERSATION_ORDER_GUARD_HOURS`) ở hội thoại KHÁC ⇒ đơn mới vẫn lên nhưng KHÔNG tự
 * chốt, mang cờ `POSSIBLE_SAME_CUSTOMER` (giữ khỏi vận đơn + công tắc tự nâng) để người đối chiếu trên /orders cạnh cờ «Nghi trùng
 * đơn». Khách không nghe gì khác thường, không lộ dữ liệu của SĐT ấy (luật #651 / #656: SĐT gõ tay không đổi nhận diện, không điền gì —
 * nó chỉ làm đơn của CHÍNH người gõ chậm xác nhận). Chỉ đơn của BOT: đơn của người đã có luồng riêng (rào hội thoại, form cảnh báo).
 */
export async function samePhoneOpenBotOrders(conversationId: string, phone: string | null | undefined, now: Date, exec?: DbOrTx): Promise<{ orderId: string; insertedAt: Date }[]> {
  const key = phoneKey(phone);
  if (!key) return [];
  const db = exec ?? (await getDb());
  const o = schema.orders;
  const own = `sales-chat:${conversationId}:`;
  const since = new Date(now.getTime() - CONVERSATION_ORDER_GUARD_HOURS * 3_600_000);
  const leftWarehouse = sql`exists (select 1 from ${schema.shipments} s where s.order_id = ${o.id} and coalesce(s.direction, 'OUTBOUND') <> 'RETURN' and s.stage::text not in ('PENDING', 'CANCELLED'))`;
  const digits = (col: typeof o.billPhone | typeof o.shipPhone) => sql`right(regexp_replace(coalesce(${col}, ''), '[^0-9]', '', 'g'), 9)`;
  const rows = await db
    .select({ orderId: o.id, insertedAt: o.insertedAt })
    .from(o)
    .where(
      and(
        sql`left(coalesce(${o.raw}->>'agentKey', ''), 11) = 'sales-chat:'`,
        sql`left(coalesce(${o.raw}->>'agentKey', ''), ${own.length}) <> ${own}`,
        sql`coalesce(${o.salesConversationId}, '') <> ${conversationId}`,
        inArray(o.stage, [...PRE_SHIP_STAGES]),
        sql`not ${leftWarehouse}`,
        gte(o.insertedAt, since),
        or(sql`${digits(o.billPhone)} = ${key}`, sql`${digits(o.shipPhone)} = ${key}`),
      ),
    )
    .orderBy(desc(o.insertedAt))
    .limit(5);
  return rows;
}

/** Một dòng nhật ký mỗi lần lớp tạm kích hoạt — đếm được bằng `audit_logs.action`. Không ném. */
export async function auditSamePhoneHold(conversationId: string, otherOrderId: string, newOrderId: string): Promise<void> {
  await audit({
    userId: null,
    userEmail: "agent:lib/sales-chatbot/conversation-order-guard.ts",
    actorKind: "AGENT",
    action: "SALES_CHAT_SAME_PHONE_HOLD",
    entity: "ORDER",
    entityId: newOrderId,
    after: { conversationId, otherOrderId },
    reason: `Đơn bot giữ «Mới» + cờ cần kiểm: SĐT trùng đơn bot đang mở #${manualOrderShortCode(otherOrderId)} ở hội thoại khác (lớp tạm trước pha 3)`,
  }).catch(() => undefined);
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
