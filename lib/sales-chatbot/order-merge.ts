/**
 * ═══ PHA 3 TRÙNG ĐƠN — MUA BỔ SUNG GỘP VÀO ĐƠN BOT ĐANG MỞ CỦA CÙNG DANH TÍNH (Tech Lead chốt 24/10/2026) — CHỈ MÁY CHỦ ═══
 *
 * Vụ HSLC Ngọc (#8639C563 → #E2867CF0): bot ở bình luận tự chốt chả cá thu 280.000 ₫; khách sang Messenger (hội thoại KHÁC) nói muốn
 * mua thêm ⇒ bot lên đơn thứ hai 830.000 ₫, LẶP lại chả cá thu (đọc «thử 1k» thành dòng mới). Luật: khách đã XÁC MINH cùng danh tính
 * (`identity-link.ts::sameCustomerConversations` — định nghĩa DUY NHẤT, của code-erp-42) có đơn BOT ĐANG MỞ (PRE_SHIP, chưa qua ĐVVC,
 * ≤ `CONVERSATION_ORDER_GUARD_HOURS` theo mốc tạo đơn đích) ⇒ lời mua thêm (kể cả khác món) THÊM DÒNG vào đơn đó qua đường sửa đơn có
 * sẵn — không tạo đơn mới, không hỏi khách thêm câu nào. Đơn NGƯỜI đang mở, hoặc đơn bot ở hội thoại đang HANDOFF / người giữ ⇒ không
 * tạo, chuyển nhân viên kèm món + số lượng. `SAME_PHONE_ONLY` / `NONE` ⇒ không gộp (lớp tạm: không tự chốt + cờ nội bộ).
 * Chỉ tạo đơn MỚI khi khách nói rõ đơn riêng (`separateOrderIntent`) / người nhận khác / địa chỉ khác.
 *
 * MÓN TRÙNG (`mergeLinesForAddOn`): món khách nhắc lại đã có trong đơn = XÁC NHẬN dòng cũ, KHÔNG cộng — chỉ cộng khi CHÍNH mệnh đề nhắc
 * món có lời tăng tường minh («thêm», «nữa», «thành 2kg»). Không bao giờ bớt dòng nào: bớt / đổi là việc của người (ca «Đỗ Là»).
 */
import { and, eq } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { audit } from "@/lib/audit";
import { manualOrderShortCode } from "@/lib/constants/manual-orders";
import { otherConversationOrders, existingOrderMaker, type ConversationOrder } from "@/lib/sales-chatbot/conversation-order-guard";
import { sameCustomerConversations } from "@/lib/sales-chatbot/identity-link";
import { foldVi } from "@/lib/sales-chatbot/text";

export type MergeLine = { variantId: string; quantity: number };
export type MergeResult = { lines: MergeLine[]; added: MergeLine[]; increased: MergeLine[]; repeated: string[] };

/**
 * Gộp dòng khách vừa mua vào dòng của đơn đang mở. HÀM THUẦN. `increase` = mẫu mã mà CHÍNH tin này nói tăng tường minh. Thứ tự: dòng
 * cũ giữ chỗ, dòng mới nối sau; không bao giờ giảm.
 */
export function mergeLinesForAddOn(current: readonly MergeLine[], requested: readonly MergeLine[], increase: ReadonlySet<string>): MergeResult {
  const lines = current.map((l) => ({ ...l }));
  const added: MergeLine[] = [];
  const increased: MergeLine[] = [];
  const repeated: string[] = [];
  for (const r of requested) {
    if (r.quantity <= 0) continue;
    const cur = lines.find((l) => l.variantId === r.variantId);
    if (!cur) {
      const fresh = added.find((a) => a.variantId === r.variantId);
      if (fresh) fresh.quantity += r.quantity;
      else added.push({ ...r });
      continue;
    }
    if (increase.has(r.variantId)) {
      cur.quantity += r.quantity;
      increased.push({ ...r });
    } else repeated.push(r.variantId);
  }
  return { lines: [...lines, ...added], added, increased, repeated };
}

const INCREASE_CUE = /(?:^| )(?:them|nua|cong them)(?: |$)|(?:^| )thanh \d/;

/**
 * Mẫu mã mà CHÍNH tin này nói tăng tường minh: một mệnh đề (tách theo DẤU CÂU — «lấy thêm A với B» là một lời «thêm» cho cả hai) vừa gọi tên món (tên sản phẩm gốc, bỏ
 * quy cách) vừa có lời tăng. «lấy thêm nước mắm với chả mực, chả cá thu thử 1k» ⇒ chỉ nước mắm + chả mực mang lời «thêm»; chả cá thu
 * KHÔNG (vụ Ngọc). HÀM THUẦN.
 */
export function increasedVariants(text: string, products: readonly { variantId: string; name: string }[]): Set<string> {
  const out = new Set<string>();
  const clauses = text.split(/[\n,.;!?+]+/).map((c) => ` ${foldVi(c).replace(/[^a-z0-9]+/g, " ").trim()} `);
  for (const p of products) {
    const name = foldVi(p.name.split("·")[0] ?? p.name).replace(/[^a-z0-9]+/g, " ").trim();
    if (!name) continue;
    if (clauses.some((c) => c.includes(` ${name} `) && INCREASE_CUE.test(c.trim()))) out.add(p.variantId);
  }
  return out;
}

export type MergeTargetOrder = {
  orderId: string;
  ownerConversationId: string;
  stage: string;
  insertedAt: Date;
  confirmed: boolean;
  lines: MergeLine[];
  recipient: { name: string; phone: string; address: string; province: string; ward: string };
  note: string;
  total: number;
};
export type MergeTarget = { kind: "MERGE"; order: MergeTargetOrder } | { kind: "HUMAN"; order: ConversationOrder; ownerConversationId: string; maker: string } | null;

type Lookup = typeof sameCustomerConversations;
let lookup: Lookup = sameCustomerConversations;
/** Chỗ tiêm cho bài kiểm — phần nạp danh tính thật do bài kiểm của identity-link.ts khoá. `null` ⇒ trả về hàm thật. */
export function setSameCustomerLookupForTests(f: Lookup | null): void {
  lookup = f ?? sameCustomerConversations;
}

const CONFIRMED_LIKE = new Set(["CONFIRMED", "PACKING", "READY_TO_SHIP"]);

/** Dòng hàng + người nhận + tiền của đơn đích (đơn tay ERP). `null` = không có / không phải đơn ERP. */
export async function loadMergeTargetOrder(orderId: string, ownerConversationId: string): Promise<MergeTargetOrder | null> {
  const db = await getDb();
  const o = schema.orders;
  const [row] = await db
    .select({ id: o.id, stage: o.stage, insertedAt: o.insertedAt, name: o.shipFullName, phone: o.shipPhone, address: o.shipAddress, province: o.shipProvince, ward: o.shipCommune, note: o.note, total: o.totalPriceAfterDiscount, ship: o.shippingFee })
    .from(o)
    .where(eq(o.id, orderId))
    .limit(1);
  if (!row || !row.id.startsWith("erp-")) return null;
  const it = schema.orderItems;
  const items = await db.select({ variantId: it.variantId, quantity: it.quantity }).from(it).where(and(eq(it.orderId, orderId), eq(it.isBonus, false)));
  const lines: MergeLine[] = [];
  for (const i of items) {
    if (!i.variantId) continue;
    const cur = lines.find((l) => l.variantId === i.variantId);
    if (cur) cur.quantity += Number(i.quantity ?? 0);
    else lines.push({ variantId: i.variantId, quantity: Number(i.quantity ?? 0) });
  }
  return {
    orderId: row.id,
    ownerConversationId,
    stage: String(row.stage),
    insertedAt: row.insertedAt,
    confirmed: CONFIRMED_LIKE.has(String(row.stage)),
    lines,
    recipient: { name: row.name ?? "", phone: row.phone ?? "", address: row.address ?? "", province: row.province ?? "", ward: row.ward ?? "" },
    note: row.note ?? "",
    total: Number(row.total ?? 0) + Number(row.ship ?? 0),
  };
}

/**
 * Đơn ĐANG MỞ của các hội thoại CÙNG DANH TÍNH ĐÃ XÁC MINH (không gồm hội thoại này — đơn của chính nó đã ở state / rào hội thoại).
 * Mới nhất thắng. Đơn bot ở hội thoại không ai giữ ⇒ MERGE; đơn người, hoặc hội thoại đang HANDOFF / người giữ ⇒ HUMAN. Không có ⇒
 * `null`. Ném khi CSDL lỗi — người gọi quyết phía HẸP (tạo đơn như cũ, lớp tạm vẫn chạy).
 */
export async function findMergeTarget(conversationId: string, now: Date): Promise<MergeTarget> {
  const same = (await lookup(conversationId, { sinceDays: 1, minLevel: "VERIFIED" })).filter((x) => x.verdict.level === "VERIFIED" && x.conversationId !== conversationId);
  let best: { order: ConversationOrder; conv: (typeof same)[number] } | null = null;
  for (const c of same) {
    const orders = await otherConversationOrders({ conversationId: c.conversationId, exclude: [], verifiedCustomerId: null, now, includeBotOrders: true });
    // Phạm vi của hội thoại kia nay gồm các hàng cùng luồng — tức có thể gồm CHÍNH hội thoại này: đơn của nó thuộc state / rào riêng.
    const own = `sales-chat:${conversationId}:`;
    for (const order of orders) {
      if (order.agentKey?.startsWith(own)) continue;
      if (!best || order.insertedAt.getTime() > best.order.insertedAt.getTime()) best = { order, conv: c };
    }
  }
  if (!best) return null;
  const isBot = Boolean(best.order.agentKey?.startsWith("sales-chat:"));
  const held = best.conv.heldByHuman || best.conv.status === "HANDOFF";
  if (!isBot || held) return { kind: "HUMAN", order: best.order, ownerConversationId: best.conv.conversationId, maker: held && isBot ? "bot (hội thoại đang do nhân viên giữ)" : existingOrderMaker(best.order) };
  const order = await loadMergeTargetOrder(best.order.orderId, best.conv.conversationId);
  return order ? { kind: "MERGE", order } : null;
}

/** Một dòng nhật ký mỗi lần gộp — đếm được bằng `audit_logs.action`. Không ném. */
export async function auditOrderMerge(conversationId: string, target: MergeTargetOrder, result: MergeResult): Promise<void> {
  await audit({
    userId: null,
    userEmail: "agent:lib/sales-chatbot/order-merge.ts",
    actorKind: "AGENT",
    action: "SALES_CHAT_ORDER_MERGED",
    entity: "ORDER",
    entityId: target.orderId,
    after: { conversationId, ownerConversationId: target.ownerConversationId, added: result.added, increased: result.increased, repeated: result.repeated },
    reason: `Bot gộp lời mua thêm vào đơn #${manualOrderShortCode(target.orderId)} (cùng danh tính, đơn đang mở) — không tạo đơn mới`,
  }).catch(() => undefined);
}
