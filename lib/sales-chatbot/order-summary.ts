/**
 * ═══════════ «ĐƠN ĐANG CHỐT» CỦA MỘT HỘI THOẠI — ĐỌC (INBOX-V2-B) — CHỈ MÁY CHỦ ═══════════
 *
 * Nguồn sự thật: đơn bot / nhân viên đã GHI qua lõi đơn (`lib/records/order-create.ts`) — `orders` + `order_items`. Bot không giữ một
 * «đơn nháp» riêng ở chỗ khác: `create_draft_order` ghi thẳng một đơn `erp-` stage «Mới» (`createOrderAsAgent`), `confirm_order` đưa
 * nó lên «Đã xác nhận»; `state.draft` của hội thoại chỉ mang lại mã đơn (bản không có mã chỉ tồn tại ở khung thử — hộp thư không hiện
 * khung thử). Đơn gắn với hội thoại qua `orders.sales_conversation_id` HOẶC `sales_chat_conversations.order_id / draft_order_id`
 * (cùng phép nối với form tạo đơn trong khung chat — `lib/records/chat-order.ts::existingOrders`).
 *
 * «Đơn đang chốt» = đơn CÒN SỐNG (không huỷ / xoá) mới nhất của hội thoại; số đơn sống khác đi kèm để panel nói «chưa chắc đơn nào».
 * Giá là giá ĐƠN ĐÃ GHI (lõi đã đối chiếu danh mục / bảng giá lúc ghi — `agentPriceGate`), KHÔNG tính lại ở đây.
 *
 * MỘT câu SQL cho mỗi hội thoại (dòng hàng + mẫu mã + vận đơn gom bằng câu con tương quan) — không N+1. Tên cột trong câu con viết
 * TƯỜNG MINH `"orders"."id"`: drizzle in cột trần thành `"id"` không kèm bảng (bài học #… «câu con tương quan với id trần»).
 */
import { and, eq, ne, notInArray, or, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { can, type SessionUser } from "@/lib/auth/session";
import { attemptHoldsOrder } from "@/lib/constants/carrier-vtp";
import { displayVariationText } from "@/lib/constants/experience-profile";
import { isManualOrderId, manualOrderShortCode, orderShipNote } from "@/lib/constants/manual-orders";
import { reconfirmsSinceOpen, reviewFromValue } from "@/lib/constants/order-review";
import { ORDER_STAGE_LABEL } from "@/lib/constants/pancake";
import { readDisplayProfile } from "@/lib/experience/profile";
import type { ConversationOrderSummary, OrderSummaryLine } from "@/lib/sales-chatbot/order-verification-shared";

export type OrderSummaryResult = { ok: true; summary: ConversationOrderSummary | null } | { ok: false; error: string };

const DEAD_STAGES = ["CANCELLED", "DELETED"] as const;

/** Dòng hàng gom từ câu con — mọi trường có thể vắng nếu JSON hỏng; đọc phòng thủ. */
type ItemJson = { sku?: unknown; productName?: unknown; variation?: unknown; quantity?: unknown; unitPrice?: unknown; discount?: unknown; lineTotal?: unknown; isBonus?: unknown; variantId?: unknown; variantKnown?: unknown; variantRemoved?: unknown };

const asArray = (v: unknown): unknown[] => {
  const x = typeof v === "string" ? (JSON.parse(v) as unknown) : v;
  return Array.isArray(x) ? x : [];
};
const str = (v: unknown) => (typeof v === "string" ? v : "");
const int = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
};

export function itemFromJson(v: unknown): OrderSummaryLine {
  const r = (v && typeof v === "object" ? v : {}) as ItemJson;
  return {
    sku: str(r.sku),
    productName: str(r.productName),
    variation: str(r.variation),
    quantity: int(r.quantity) ?? 0,
    unitPrice: int(r.unitPrice),
    discount: int(r.discount) ?? 0,
    lineTotal: int(r.lineTotal),
    isBonus: r.isBonus === true,
    variantId: typeof r.variantId === "string" && r.variantId ? r.variantId : null,
    variantKnown: r.variantKnown === true,
    variantRemoved: r.variantRemoved === true,
  };
}

/** Đơn đang chốt của hội thoại cho panel hộp thư. Cần `ai_sales:view`; hội thoại khung thử / không có ⇒ lỗi đọc được. */
export async function loadConversationOrderSummary(user: SessionUser, conversationId: unknown): Promise<OrderSummaryResult> {
  if (!can(user, "ai_sales:view")) return { ok: false, error: "Bạn không có quyền xem hội thoại (ai_sales:view)." };
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 100) return { ok: false, error: "Không có hội thoại này." };
  const db = await getDb();
  const o = schema.orders;
  const c = schema.salesChatConversations;
  const items = sql<unknown>`(select coalesce(json_agg(json_build_object(
      'sku', i."sku", 'productName', i."product_name", 'variation', i."variation_detail", 'quantity', i."quantity",
      'unitPrice', i."unit_price", 'discount', i."total_discount", 'lineTotal', i."line_total", 'isBonus', i."is_bonus",
      'variantId', i."variant_id", 'variantKnown', pv."id" is not null, 'variantRemoved', coalesce(pv."is_removed", false)
    ) order by i."id"), '[]'::json)
    from "order_items" i left join "product_variants" pv on pv."id" = i."variant_id"
    where i."order_id" = "orders"."id")`;
  // Lần gửi của đơn: chỉ chặng + phần `carrierCancel` của lời khai gốc — đủ cho `attemptHoldsOrder`, không kéo cả `raw` của vận đơn.
  const attempts = sql<unknown>`(select coalesce(json_agg(json_build_object('stage', s."stage", 'raw', json_build_object('carrierCancel', s."raw"->'carrierCancel'))), '[]'::json)
    from "shipments" s where s."order_id" = "orders"."id")`;
  // Hồ sơ ngành chỉ để ĐỔI NHÃN chữ biến thể khi in (shop thực phẩm: «Size: 1kg» ⇒ «Quy cách: 1kg» — xem `displayVariationText`).
  // Chạy song song với câu SQL; đọc hồ sơ lỗi ⇒ in nguyên chữ đã lưu, không bao giờ làm hỏng khung đơn.
  const profileRead = readDisplayProfile();
  // Hội thoại LEFT JOIN đơn sống: một dòng dù chưa có đơn (đơn = null) ⇒ «không có hội thoại» và «chưa có đơn» cùng một câu.
  const rows = await db
    .select({
      id: o.id,
      stage: o.stage,
      statusName: o.statusName,
      origin: o.origin,
      insertedAt: o.insertedAt,
      shipName: o.shipFullName,
      billName: o.billFullName,
      phone: o.shipPhone,
      billPhone: o.billPhone,
      address: o.shipAddress,
      province: o.shipProvince,
      district: o.shipDistrict,
      ward: o.shipCommune,
      totalPrice: o.totalPrice,
      totalDiscount: o.totalDiscount,
      afterDiscount: o.totalPriceAfterDiscount,
      shippingFee: o.shippingFee,
      note: o.note,
      itemsCount: o.itemsCount,
      review: sql<unknown>`${o.raw}->'review'`,
      reviewLog: sql<unknown>`${o.raw}->'reviewLog'`,
      items,
      attempts,
      active: sql<number>`(count(*) over ())::int`,
    })
    .from(c)
    .leftJoin(o, and(or(eq(o.salesConversationId, c.id), eq(o.id, c.orderId), eq(o.id, c.draftOrderId)), notInArray(o.stage, [...DEAD_STAGES])))
    .where(and(eq(c.id, conversationId), ne(c.channel, "TEST")))
    .orderBy(sql`${o.insertedAt} desc nulls last`, sql`${o.id} desc nulls last`)
    .limit(1);
  const profile = await profileRead;
  const r = rows[0];
  if (!r) return { ok: false, error: "Không có hội thoại này." };
  if (!r.id || !r.stage || !r.insertedAt) return { ok: true, summary: null };
  const manual = isManualOrderId(r.id);
  const lines = asArray(r.items)
    .map(itemFromJson)
    .map((l) => ({ ...l, variation: displayVariationText(l.variation, profile) }));
  const shippingNote = orderShipNote(r.note);
  const shipping = shippingNote === "UNKNOWN" ? null : (r.shippingFee ?? 0);
  const review = manual ? (reviewFromValue(r.review)?.entries ?? []) : [];
  return {
    ok: true,
    summary: {
      orderId: r.id,
      shortCode: manualOrderShortCode(r.id),
      stage: r.stage,
      stageLabel: ORDER_STAGE_LABEL[r.stage] ?? (r.statusName || r.stage),
      manual,
      byBot: r.origin === "AI_AGENT" || r.origin === "AI_ORDER_SYNC",
      insertedAt: r.insertedAt.toISOString(),
      hasShipment: asArray(r.attempts).some((a) => {
        const x = (a && typeof a === "object" ? a : {}) as { stage?: unknown; raw?: unknown };
        return attemptHoldsOrder({ stage: str(x.stage), raw: x.raw });
      }),
      recipient: { name: r.shipName || r.billName || "", phone: r.phone || (manual ? "" : (r.billPhone ?? "")), address: r.address ?? "", province: r.province ?? "", district: r.district ?? "", ward: r.ward ?? "" },
      lines,
      itemsCount: r.itemsCount ?? 0,
      money: { goods: r.totalPrice ?? 0, discount: r.totalDiscount ?? 0, shipping, shippingNote, total: shipping === null ? null : (r.afterDiscount ?? 0) + shipping },
      review,
      reconfirms: manual ? reconfirmsSinceOpen({ review: r.review, reviewLog: r.reviewLog }) : [],
      otherActive: Math.max(0, Number(r.active) - 1),
    },
  };
}
