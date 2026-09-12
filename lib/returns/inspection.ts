import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ReturnCondition } from "@/lib/constants/returns-condition";
import { ITEM_CONDITION_LABEL, ITEM_CONDITION_NEEDS_NOTE, ITEM_CONDITION_RESTOCKS, isItemCondition, itemHasDiscrepancy, type ItemCondition } from "@/lib/constants/return-lifecycle";
import { returnProductContext, type ItemsBasis } from "@/lib/returns/product-context";

/**
 * ───────────── VÒNG ĐỜI KIỂM HÀNG HOÀN ─────────────
 *
 *   ĐVVC báo hoàn  →  ĐÃ VỀ KHO  →  CHỜ ĐẾM  →  ĐÃ KIỂM  →  {bán lại được · không bán được}
 *                                                                 ↓
 *                                                    phiếu tái nhập CHỈ phần đếm được
 *
 * VÌ SAO KHÔNG GỘP "ĐÃ VỀ" VỚI "VÀO TỒN": một kiện hàng quay về có thể thiếu món, rách, bẩn, hoặc
 * khách đã bóc ra dùng. Cộng nguyên số đã xuất trở lại tồn là ghi vào sổ một lượng hàng không có
 * thật — và phần chênh nằm im trong số tồn, không ai tìm ra được, cho tới lúc kiểm kê cuối kỳ.
 * Kế hoạch sản xuất trong suốt thời gian đó đặt thiếu đúng bằng phần chênh ấy.
 *
 * Nên ERP tách hai mốc: ghi nhận kiện ĐÃ VỀ là việc của người nhận hàng (nhanh, hàng loạt);
 * quyết định hàng nào VÀO TỒN là việc của người ĐẾM (từng kiện, có số, có lý do khi thiếu).
 *
 * Đo trên production 09/09/2026: 445 kiện đang chờ, 497 món, chưa kiện nào được đếm.
 */

const ins = schema.returnInspections;
const s = schema.shipments;


/**
 * GHI NHẬN KIỆN ĐÃ VỀ TỚI KHO. Chưa đếm, chưa vào tồn.
 *
 * Idempotent: `shipment_id` là khoá duy nhất nên bấm lại lần hai không tạo thêm phiếu và không đè
 * mốc/người nhận của lần đầu. Trả về đúng số kiện được ghi nhận MỚI trong lần gọi này.
 */
export async function markReturnsArrived(ids: string[], actor: string, note?: string) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, ids: [] as string[] };
  const db = await getDb();
  const shipments = await db.select({ id: s.id, orderId: s.orderId }).from(s).where(inArray(s.id, unique));
  if (!shipments.length) return { count: 0, ids: [] as string[] };

  const now = new Date();
  const rows = await db
    .insert(ins)
    .values(
      shipments.map((sh) => ({
        shipmentId: sh.id,
        orderId: sh.orderId,
        status: "RECEIVED" as const,
        receivedAt: now,
        receivedBy: actor,
        note: note?.trim() ?? "",
      })),
    )
    .onConflictDoNothing({ target: ins.shipmentId })
    .returning({ id: ins.shipmentId });
  return { count: rows.length, ids: rows.map((r) => r.id) };
}

/**
 * Huỷ ghi nhận đã về (bấm nhầm kiện). CHỈ được huỷ khi kiện CHƯA đếm: đã đếm rồi thì đã có phiếu
 * tái nhập và tồn đã đổi — muốn sửa phải lập phiếu điều chỉnh kho, để lại dấu vết, không xoá ngược.
 */
export async function undoReturnArrived(ids: string[]): Promise<{ count: number; blocked: number }> {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, blocked: 0 };
  const db = await getDb();
  const rows = await db.select({ shipmentId: ins.shipmentId, status: ins.status }).from(ins).where(inArray(ins.shipmentId, unique));
  const removable = rows.filter((r) => r.status === "RECEIVED").map((r) => r.shipmentId);
  const blocked = rows.length - removable.length;
  if (removable.length) await db.delete(ins).where(and(inArray(ins.shipmentId, removable), eq(ins.status, "RECEIVED")));
  return { count: removable.length, blocked };
}

export type InspectionInput = {
  shipmentId: string;
  condition: ReturnCondition;
  /** Số món ĐẾM ĐƯỢC và còn bán lại được. Chỉ số này được cộng vào tồn. */
  restockQty: number;
  /** Số món về nhưng không bán lại được (rách, bẩn, thiếu phụ kiện). */
  unsellableQty: number;
  note: string;
  actor: string;
};

export type InspectionResult = { ok: true; restocked: number; receiptId: string | null } | { error: string };

/**
 * KHO ĐẾM XONG MỘT KIỆN. Đây là nơi DUY NHẤT hàng hoàn được cộng lại tồn, và chỉ đúng phần đếm được.
 *
 * Không đếm lại lần hai: đã kiểm rồi mà cho kiểm tiếp thì phiếu tái nhập cộng tồn hai lần. Muốn sửa
 * số thì lập phiếu điều chỉnh kho — có người ký, có lý do, và nhìn thấy được trên sổ.
 */
export async function recordInspection(input: InspectionInput): Promise<InspectionResult> {
  const db = await getDb();
  const [row] = await db.select().from(ins).where(eq(ins.shipmentId, input.shipmentId));
  if (!row) return { error: "Kiện này chưa được ghi nhận đã về kho" };
  if (row.status === "INSPECTED") return { error: "Kiện này đã đếm rồi — muốn sửa số thì lập phiếu điều chỉnh kho" };

  const restock = Math.max(0, Math.trunc(input.restockQty));
  const unsellable = Math.max(0, Math.trunc(input.unsellableQty));
  const note = input.note.trim();
  if (input.condition === "RESTOCKABLE" && restock <= 0) return { error: "Kết luận bán lại được thì phải đếm được ít nhất một món" };
  if (input.condition !== "RESTOCKABLE" && !note) return { error: "Kết luận không bán được thì phải ghi rõ vì sao" };

  // CHỈ phần bán lại được mới sinh phiếu tái nhập — phiếu là nơi duy nhất tồn kho thay đổi.
  const receiptId = restock > 0 ? await createRestockReceipt(row.orderId, input.shipmentId, restock, note, input.actor) : null;

  await db
    .update(ins)
    .set({
      status: "INSPECTED",
      condition: input.condition,
      restockQty: receiptId ? restock : 0,
      unsellableQty: unsellable,
      note,
      inspectedAt: new Date(),
      inspectedBy: input.actor,
      stockReceiptId: receiptId,
      updatedAt: new Date(),
    })
    .where(eq(ins.id, row.id));

  // Đóng kiện trên vận đơn: từ đây nó thôi nằm trong "hàng hoàn chờ xử lý", và phần đếm thiếu so với
  // số đã xuất hiện ra thành HÀNG HỤT trên sổ kho thay vì biến mất.
  await db
    .update(s)
    .set({ returnReceivedAt: new Date(), returnReceivedBy: input.actor, returnReceivedNote: note || null, updatedAt: new Date() })
    .where(and(eq(s.id, input.shipmentId), isNull(s.returnReceivedAt)));

  return { ok: true, restocked: receiptId ? restock : 0, receiptId };
}

/**
 * Phiếu TÁI NHẬP cho đúng số đếm được. Phân bổ theo tỷ lệ món trong kiện; kiện chỉ có một mẫu mã
 * (đại đa số) thì rơi thẳng vào mẫu mã đó.
 *
 * Trả `null` khi không mẫu mã nào của đơn khớp được với danh mục ERP: thà không ghi còn hơn ghi vào
 * một mẫu mã đoán bừa — tồn sai một mẫu mã còn khó phát hiện hơn tồn thiếu.
 */
async function createRestockReceipt(orderId: string | null, shipmentId: string, restock: number, note: string, actor: string): Promise<string | null> {
  if (!orderId) return null;
  const db = await getDb();
  const items = await db
    .select({ variantId: schema.orderItems.variantId, qty: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(schema.orderItems)
    .where(and(eq(schema.orderItems.orderId, orderId), sql`${schema.orderItems.variantId} is not null`))
    .groupBy(schema.orderItems.variantId)
    .orderBy(sql`coalesce(sum(${schema.orderItems.quantity}), 0) desc`);
  const usable = items.filter((i) => i.variantId && Number(i.qty) > 0);
  if (!usable.length) return null;

  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({
      kind: "RETURN",
      receivedAt: new Date(),
      reference: `Đếm hàng hoàn ${shipmentId}`,
      note,
      totalQuantity: restock,
      totalCost: 0,
      createdBy: actor,
    })
    .returning({ id: schema.stockReceipts.id });

  // Tổng các dòng LUÔN bằng đúng số người đếm nói: phần dư dồn vào dòng cuối, không làm tròn vống lên.
  const total = usable.reduce((t, i) => t + Number(i.qty), 0);
  const lines: { variantId: string; quantity: number }[] = [];
  let remaining = restock;
  for (let i = 0; i < usable.length; i += 1) {
    const isLast = i === usable.length - 1;
    const share = isLast ? remaining : Math.min(remaining, Math.round((Number(usable[i].qty) / total) * restock));
    remaining -= share;
    if (share > 0) lines.push({ variantId: usable[i].variantId as string, quantity: share });
  }
  if (!lines.length) return receipt.id;

  await db.insert(schema.stockReceiptItems).values(lines.map((l) => ({ receiptId: receipt.id, variantId: l.variantId, quantity: l.quantity, unitCost: 0, shipmentId })));
  return receipt.id;
}

/** `variantId` là thứ DUY NHẤT nối được dòng hàng với sổ kho — thiếu nó thì món đếm được không
 *  biết cộng vào mẫu mã nào, nên nó phải đi cùng mọi dòng hàng ngay từ truy vấn. */
export type InspectionItem = { variantId: string | null; sku: string; name: string; color: string; size: string; quantity: number };

export type PendingInspection = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  orderCode: string | null;
  customerName: string;
  customerPhone: string;
  receivedAt: Date;
  receivedBy: string;
  /** Số món KỲ VỌNG quay về. `null` = CHƯA BIẾT (không ghép được đơn) — không phải 0. */
  expectedQty: number | null;
  /** Căn cứ của danh sách món: có phiếu trả từng dòng, hay chỉ suy từ cả đơn, hay không có gì. */
  itemsBasis: ItemsBasis;
  ageDays: number;
  /**
   * Từng dòng hàng của đơn: mã, tên, màu, size, số lượng.
   *
   * Lấy sẵn ở đây thay vì để màn hình tự tra: người đếm cầm kiện hàng trên tay cần biết NGAY phải
   * thấy gì trong đó. Bắt họ mở đơn ở tab khác để đọc màu/size là biến việc 10 giây thành việc 40
   * giây — nhân với 453 kiện thì đó là hơn một ngày công.
   */
  items: InspectionItem[];
};

/** Gộp dòng hàng của đơn thành JSON ngay trong SQL — một truy vấn, không N+1. */
const ITEMS_JSON = sql<string>`coalesce((
  select json_agg(json_build_object(
    'variantId', oi.variant_id,
    'sku', coalesce(nullif(oi.sku, ''), ''),
    'name', coalesce(oi.product_name, ''),
    'color', coalesce(pv.color, ''),
    'size', coalesce(pv.size, ''),
    'quantity', oi.quantity
  ) order by oi.product_name)
  from order_items oi
  left join product_variants pv on pv.id = oi.variant_id
  where oi.order_id = ${ins.orderId}
), '[]')`;

function parseItems(raw: unknown): InspectionItem[] {
  if (!raw) return [];
  const list = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (!Array.isArray(list)) return [];
  return list.map((x) => {
    const r = x as Record<string, unknown>;
    return {
      variantId: r.variantId ? String(r.variantId) : null,
      sku: String(r.sku ?? ""),
      name: String(r.name ?? ""),
      color: String(r.color ?? ""),
      size: String(r.size ?? ""),
      quantity: Number(r.quantity ?? 0),
    };
  });
}

/** Kiện ĐÃ VỀ nhưng CHƯA ĐẾM — việc của kho, và là phần hàng có thật mà sổ đang chưa biết. */
export async function listPendingInspections(limit = 100): Promise<PendingInspection[]> {
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: ins.shipmentId,
      code: s.vtpOrderNumber,
      tracking: s.trackingCode,
      orderId: ins.orderId,
      orderCode: sql<string | null>`(select coalesce(nullif(o2.custom_id, ''), o2.system_id::text) from orders o2 where o2.id = ${ins.orderId})`,
      customerName: sql<string>`coalesce((select coalesce(nullif(o2.bill_full_name, ''), nullif(o2.ship_full_name, ''), '') from orders o2 where o2.id = ${ins.orderId}), '')`,
      customerPhone: sql<string>`coalesce((select coalesce(nullif(o2.bill_phone, ''), nullif(o2.ship_phone, ''), '') from orders o2 where o2.id = ${ins.orderId}), '')`,
      receivedAt: ins.receivedAt,
      receivedBy: ins.receivedBy,
      expectedQty: sql<number>`coalesce((select sum(oi.quantity) from order_items oi where oi.order_id = ${ins.orderId}), 0)`,
      items: ITEMS_JSON,
    })
    .from(ins)
    .leftJoin(s, eq(s.id, ins.shipmentId))
    .where(eq(ins.status, "RECEIVED"))
    .orderBy(asc(ins.receivedAt))
    .limit(limit);

  /*
    VÁ CHO VẬN ĐƠN CHIỀU VỀ (mã gốc + 1P1).

    Theo quy ước của kho mã, vận đơn chiều về là một dòng `shipments` RIÊNG với `order_id` NULL —
    nên `return_inspections.order_id` chép lại cũng NULL, và mọi truy vấn con ở trên trả rỗng:
    người đếm nhìn thấy đúng một mã vận đơn trần trụi, không biết trong kiện lẽ ra có gì.

    Ghép lại bằng ĐỊNH DANH qua `product-context` (mã gốc → vận đơn chiều đi → đơn), CHỈ cho những
    dòng đang trống, và gộp một lượt cho cả loạt chứ không mỗi dòng một truy vấn.
  */
  // Ghép bối cảnh cho MỌI dòng (không chỉ dòng thiếu đơn): `product-context` là nơi duy nhất biết
  // món nào THỰC SỰ bị trả (`return_quantity`) và căn cứ của danh sách — đường đếm phải thấy đúng
  // cái mà bàn nhận đã thấy, không được tự suy từ cả đơn rồi mặc định "đủ".
  const boSung = await returnProductContext(rows.map((r) => r.shipmentId));

  const now = Date.now();
  return rows.map((r) => {
    const them = boSung.get(r.shipmentId);
    const goc = parseItems(r.items);
    const items = them && them.items.length ? them.items.map((i) => ({ variantId: i.variantId, sku: i.sku, name: i.name, color: i.color, size: i.size, quantity: i.quantity })) : goc;
    const itemsBasis: ItemsBasis = them && them.itemsBasis !== "NONE" ? them.itemsBasis : goc.length ? "ORDER_ONLY" : "NONE";
    return {
      shipmentId: r.shipmentId,
      code: r.code ?? r.tracking ?? null,
      orderId: r.orderId ?? them?.orderId ?? null,
      orderCode: r.orderCode ?? them?.orderCode ?? null,
      customerName: r.customerName ?? "",
      customerPhone: r.customerPhone ?? "",
      receivedAt: r.receivedAt,
      receivedBy: r.receivedBy,
      // CHƯA BIẾT là null — không ép về 0, và không dùng `||` (nó nuốt luôn một số 0 thật).
      expectedQty: itemsBasis === "NONE" ? null : items.reduce((a, x) => a + x.quantity, 0),
      itemsBasis,
      ageDays: Math.floor((now - new Date(r.receivedAt).getTime()) / 86_400_000),
      items,
    };
  });
}

/**
 * QUÉT MÃ VẬN ĐƠN → RA ĐÚNG MỘT KIỆN.
 *
 * Người đếm cầm kiện hàng, bắn mã, và phải thấy ngay kiện đó — không phải cuộn tìm trong 453 dòng.
 *
 * Dò theo BỐN mã cùng lúc vì mã in trên kiện không phải lúc nào cũng là mã ERP dùng làm khoá: mã
 * vận đơn Viettel Post, mã tra cứu, mã tham chiếu (vận đơn chiều hoàn mang mã gốc), và mã đơn của
 * shop. So khớp KHÔNG phân biệt hoa thường và bỏ khoảng trắng thừa — máy quét hay thêm cả hai.
 */
export async function findPendingByCode(code: string): Promise<PendingInspection | null> {
  const q = code.trim();
  if (!q) return null;
  const list = await listPendingInspections(1000);
  const norm = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const target = norm(q);
  return (
    list.find((r) => norm(r.code) === target || norm(r.orderCode) === target || norm(r.shipmentId) === target) ??
    // Bắn thiếu vài ký tự đầu (máy quét đọc hụt) vẫn tìm được, miễn là ĐỦ DÀI để không mơ hồ.
    (target.length >= 6 ? (list.find((r) => norm(r.code).endsWith(target) || norm(r.orderCode).endsWith(target)) ?? null) : null)
  );
}

export type InspectionSummary = {
  /** Kiện đã về, chờ đếm. */
  pending: number;
  /** Số món dự kiến của các kiện chờ đếm — phần hàng chưa ai xác nhận có thật hay không. */
  pendingItems: number;
  /** Kiện chờ đếm quá 3 ngày: hàng nằm trong kho mà sổ vẫn chưa biết. */
  stale: number;
  inspected: number;
  restockedQty: number;
  unsellableQty: number;
};

export async function inspectionSummary(): Promise<InspectionSummary> {
  const db = await getDb();
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED')`,
      pendingItems: sql<number>`coalesce(sum((select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${ins.orderId})) filter (where ${ins.status} = 'RECEIVED'), 0)`,
      stale: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - interval '3 days')`,
      inspected: sql<number>`count(*) filter (where ${ins.status} = 'INSPECTED')`,
      restockedQty: sql<number>`coalesce(sum(${ins.restockQty}), 0)`,
      unsellableQty: sql<number>`coalesce(sum(${ins.unsellableQty}), 0)`,
    })
    .from(ins);
  return {
    pending: Number(row?.pending ?? 0),
    pendingItems: Number(row?.pendingItems ?? 0),
    stale: Number(row?.stale ?? 0),
    inspected: Number(row?.inspected ?? 0),
    restockedQty: Number(row?.restockedQty ?? 0),
    unsellableQty: Number(row?.unsellableQty ?? 0),
  };
}

export type InspectionDashboard = {
  /** ĐVVC báo hoàn nhưng kho CHƯA bấm nhận — hàng đang trên đường về hoặc đã tới mà chưa ai ghi. */
  awaitingArrival: number;
  /** Đã nhận, CHƯA đếm. Đây là phần hàng có thật mà sổ đang chưa biết. */
  pendingInspection: number;
  pendingItems: number;
  /** Đã đếm và đã vào lại tồn. */
  restocked: number;
  restockedQty: number;
  damaged: number;
  missing: number;
  wrongItem: number;
  unsellable: number;
  /** Tuổi của các kiện CHỜ ĐẾM — hàng nằm càng lâu thì sổ càng sai lâu. */
  aging: { duoi1Ngay: number; tu1Den3Ngay: number; tu3Den7Ngay: number; tren7Ngay: number; cuNhatNgay: number };
};

/**
 * BẢNG ĐIỀU KHIỂN KIỂM HÀNG HOÀN.
 *
 * Sáu con số + tuổi tồn đọng, trả về trong MỘT lượt. Tách "chờ nhận" khỏi "chờ đếm" là cố ý: hai
 * việc đó thuộc hai người khác nhau và tắc ở hai chỗ khác nhau — gộp lại thì không biết phải đi
 * giục ai.
 */
export async function inspectionDashboard(): Promise<InspectionDashboard> {
  const db = await getDb();
  const [row] = await db
    .select({
      awaitingArrival: sql<number>`(select count(*) from shipments sh where sh.stage = 'RETURNED' and sh.return_received_at is null and sh.order_id is not null)`,
      pendingInspection: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED')`,
      pendingItems: sql<number>`coalesce(sum((select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${ins.orderId})) filter (where ${ins.status} = 'RECEIVED'), 0)`,
      restocked: sql<number>`count(*) filter (where ${ins.condition} = 'RESTOCKABLE')`,
      restockedQty: sql<number>`coalesce(sum(${ins.restockQty}), 0)`,
      damaged: sql<number>`count(*) filter (where ${ins.condition} = 'DAMAGED')`,
      missing: sql<number>`count(*) filter (where ${ins.condition} = 'MISSING')`,
      wrongItem: sql<number>`count(*) filter (where ${ins.condition} = 'WRONG_ITEM')`,
      unsellable: sql<number>`count(*) filter (where ${ins.condition} = 'UNSELLABLE')`,
      d1: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} >= now() - interval '1 day')`,
      d13: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - interval '1 day' and ${ins.receivedAt} >= now() - interval '3 days')`,
      d37: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - interval '3 days' and ${ins.receivedAt} >= now() - interval '7 days')`,
      d7: sql<number>`count(*) filter (where ${ins.status} = 'RECEIVED' and ${ins.receivedAt} < now() - interval '7 days')`,
      oldest: sql<number>`coalesce(extract(day from now() - min(${ins.receivedAt}) filter (where ${ins.status} = 'RECEIVED')), 0)`,
    })
    .from(ins);
  return {
    awaitingArrival: Number(row?.awaitingArrival ?? 0),
    pendingInspection: Number(row?.pendingInspection ?? 0),
    pendingItems: Number(row?.pendingItems ?? 0),
    restocked: Number(row?.restocked ?? 0),
    restockedQty: Number(row?.restockedQty ?? 0),
    damaged: Number(row?.damaged ?? 0),
    missing: Number(row?.missing ?? 0),
    wrongItem: Number(row?.wrongItem ?? 0),
    unsellable: Number(row?.unsellable ?? 0),
    aging: {
      duoi1Ngay: Number(row?.d1 ?? 0),
      tu1Den3Ngay: Number(row?.d13 ?? 0),
      tu3Den7Ngay: Number(row?.d37 ?? 0),
      tren7Ngay: Number(row?.d7 ?? 0),
      cuNhatNgay: Math.floor(Number(row?.oldest ?? 0)),
    },
  };
}

export type BulkInspectionResult = { done: number; failed: { shipmentId: string; error: string }[] };

/**
 * ĐẾM HÀNG LOẠT — dùng khi nhiều kiện có CÙNG kết luận.
 *
 * Ca thật ở kho: mở một xe hàng hoàn, mười kiện còn nguyên seal, cùng "nhận đủ". Bắt bấm mười lần
 * qua mười màn hình là lý do người ta bỏ luôn việc ghi nhận.
 *
 * BA RÀNG BUỘC KHÔNG ĐƯỢC NỚI, kể cả khi làm hàng loạt:
 *  1. "Nhận đủ" nghĩa là ĐÚNG BẰNG số ERP đã xuất — không có ô nhập số nào ở đường hàng loạt, nên
 *     không ai vô tình khai một con số mình chưa đếm.
 *  2. Kết luận không bán được VẪN phải có lý do; thiếu lý do thì kiện đó bị bỏ qua, không im lặng.
 *  3. Từng kiện chạy qua ĐÚNG hàm `recordInspection` — không có đường ghi tắt nào bỏ qua luật
 *     "đã đếm rồi thì không đếm lại".
 */
export async function recordInspectionBulk(
  shipmentIds: string[],
  condition: ReturnCondition,
  note: string,
  actor: string,
): Promise<BulkInspectionResult> {
  const ids = [...new Set(shipmentIds.filter((x) => x.trim()))];
  if (!ids.length) return { done: 0, failed: [] };

  const pending = await listPendingInspections(1000);
  const expected = new Map(pending.map((p) => [p.shipmentId, p.expectedQty]));

  const failed: { shipmentId: string; error: string }[] = [];
  let done = 0;
  for (const id of ids) {
    const qty = expected.get(id) ?? 0;
    const r = await recordInspection({
      shipmentId: id,
      condition,
      // "Nhận đủ" = đúng bằng số đã xuất. Mọi kết luận khác KHÔNG cộng tồn.
      restockQty: condition === "RESTOCKABLE" ? qty : 0,
      unsellableQty: condition === "RESTOCKABLE" ? 0 : qty,
      note,
      actor,
    });
    if ("error" in r) failed.push({ shipmentId: id, error: r.error });
    else done += 1;
  }
  return { done, failed };
}

// ───────────────────────── ĐẾM THEO TỪNG MÓN ─────────────────────────

export type InspectedItemInput = {
  /** Ảnh chụp hàng kỳ vọng — màn hình gửi lên từ bối cảnh đã ghép, để lưu đúng thứ người kho thấy lúc đếm. */
  expectedVariantId: string | null;
  expectedSku: string;
  expectedName: string;
  expectedColor: string;
  expectedSize: string;
  expectedQty: number;
  /** Mẫu mã THỰC NHẬN — khác kỳ vọng khi khách trả nhầm hàng. Bỏ trống thì hiểu là đúng mẫu kỳ vọng. */
  actualVariantId: string | null;
  actualSku: string;
  actualQty: number;
  condition: ItemCondition;
  note: string;
};

export type ItemInspectionResult =
  | { ok: true; restocked: number; receiptId: string | null; hasDiscrepancy: boolean }
  | { error: string };

/**
 * ═══════════ KHO ĐẾM XONG MỘT KIỆN, GHI KẾT LUẬN THEO TỪNG MÓN ═══════════
 *
 * Khác `recordInspection` (một kết luận cho CẢ KIỆN, giữ nguyên cho đường đếm nhanh): ở đây mỗi
 * món có kết luận riêng, nên một kiện vừa đủ một món vừa thiếu một món vừa hỏng một món ghi lại
 * được đúng như thế.
 *
 * BA ĐIỀU KHÔNG ĐƯỢC PHÁ:
 *
 *  1. CHỈ MÓN `OK` MỚI VÀO TỒN, và vào đúng SỐ THỰC NHẬN của chính nó. Sáu kết luận còn lại là
 *     hàng có thật trên bàn nhưng chưa bán lại được — chúng phải hiện thành thất thoát có tên.
 *  2. TỒN CHỈ ĐỔI QUA PHIẾU KHO. Hàm này không tự cộng vào tồn; nó lập phiếu tái nhập và để đúng
 *     cơ chế sổ kho đang có làm phần còn lại.
 *  3. ĐẾM MỘT LẦN. Kiện đã kiểm rồi thì chặn — nếu không, phiếu tái nhập cộng tồn hai lần.
 *
 * Và một khác biệt quan trọng nữa so với đường đếm nhanh: phiếu tái nhập ghi ĐÚNG MẪU MÃ người kho
 * đếm được, không phân bổ theo tỷ lệ dòng hàng của đơn. Phân bổ theo tỷ lệ là phép đoán chấp nhận
 * được khi chỉ biết tổng số; khi đã biết từng món mà vẫn đoán thì là làm hỏng dữ liệu tốt hơn.
 */
export async function recordItemInspection(input: { shipmentId: string; items: InspectedItemInput[]; actor: string; orderOnlyConfirmed?: boolean }): Promise<ItemInspectionResult> {
  const db = await getDb();
  const [row] = await db.select().from(ins).where(eq(ins.shipmentId, input.shipmentId));
  if (!row) return { error: "Kiện này chưa được ghi nhận đã về kho" };
  if (row.status === "INSPECTED") return { error: "Kiện này đã đếm rồi — muốn sửa số thì lập phiếu điều chỉnh kho" };
  if (!input.items.length) return { error: "Phải đếm ít nhất một món" };

  // CĂN CỨ DANH SÁCH MÓN. "Chỉ suy từ cả đơn" (không có phiếu trả từng dòng) không được mặc định
  // là đủ: người kho phải nói rõ đã đối chiếu thực tế, nếu không một kiện hoàn một phần sẽ cộng
  // tồn cả đơn.
  const ctx = (await returnProductContext([input.shipmentId])).get(input.shipmentId);
  if (ctx?.itemsBasis === "ORDER_ONLY" && !input.orderOnlyConfirmed) {
    return { error: "Đơn này không có phiếu trả từng món — danh sách kỳ vọng chỉ suy từ cả đơn. Xác nhận đã đối chiếu thực tế rồi mới lưu." };
  }

  const actor = input.actor.trim();
  if (!actor) return { error: "Thiếu người kiểm" };

  // Làm sạch + kiểm TOÀN BỘ trước khi ghi bất cứ thứ gì: một món sai thì cả kiện không ghi, chứ
  // không ghi được nửa rồi bỏ dở.
  const items = input.items.map((it) => ({
    ...it,
    expectedQty: Math.max(0, Math.trunc(it.expectedQty)),
    actualQty: Math.max(0, Math.trunc(it.actualQty)),
    note: it.note.trim(),
    actualSku: it.actualSku.trim() || it.expectedSku.trim(),
    actualVariantId: it.actualVariantId ?? it.expectedVariantId,
  }));
  for (const it of items) {
    if (!isItemCondition(it.condition)) return { error: `Kết luận không hợp lệ: ${String(it.condition)}` };
    if (ITEM_CONDITION_NEEDS_NOTE[it.condition] && !it.note) {
      return { error: `${ITEM_CONDITION_LABEL[it.condition]} thì phải ghi rõ vì sao (${it.expectedSku || it.expectedName})` };
    }
    if (it.condition === "OK" && it.actualQty <= 0) {
      return { error: `Kết luận "đủ" thì phải đếm được ít nhất một món (${it.expectedSku || it.expectedName})` };
    }
  }

  const now = new Date();
  const restockTotal = items.filter((it) => ITEM_CONDITION_RESTOCKS[it.condition] && it.actualVariantId).reduce((t, it) => t + it.actualQty, 0);
  const unsellableTotal = items.filter((it) => !ITEM_CONDITION_RESTOCKS[it.condition]).reduce((t, it) => t + it.actualQty, 0);
  const hasDiscrepancy = items.some((it) => itemHasDiscrepancy(it));

  // Gộp theo mẫu mã: cùng một mẫu mã ở hai dòng phải thành MỘT dòng phiếu, nếu không sổ kho có hai
  // bút toán cho cùng một thứ trong cùng một phiếu.
  const byVariant = new Map<string, number>();
  for (const it of items) {
    if (!ITEM_CONDITION_RESTOCKS[it.condition] || it.actualQty <= 0 || !it.actualVariantId) continue;
    byVariant.set(it.actualVariantId, (byVariant.get(it.actualVariantId) ?? 0) + it.actualQty);
  }

  // MỘT GIAO DỊCH: phiếu kho · từng món · lật trạng thái kiện. Hỏng giữa chừng thì không có phiếu
  // kho mồ côi làm tồn tăng mà không có biên bản đếm.
  let receiptId: string | null = null;
  try {
    await db.transaction(async (tx) => {
      // Khoá dòng kiện cho tới hết giao dịch: lượt bấm trùng phải chờ, rồi thấy INSPECTED và dừng.
      const [locked] = await tx.select({ status: ins.status }).from(ins).where(eq(ins.id, row.id)).for("update");
      if (!locked || locked.status === "INSPECTED") throw new Error("DA_DEM_ROI");
    if (byVariant.size) {
      const [receipt] = await tx
        .insert(schema.stockReceipts)
        .values({
          kind: "RETURN",
          receivedAt: now,
          reference: `Đếm hàng hoàn ${input.shipmentId}`,
          note: `Đếm theo từng món · ${byVariant.size} mẫu mã`,
          totalQuantity: restockTotal,
          totalCost: 0,
          createdBy: actor,
        })
        .returning({ id: schema.stockReceipts.id });
      receiptId = receipt?.id ?? null;
      if (receiptId) {
        const rid = receiptId;
        await tx.insert(schema.stockReceiptItems).values([...byVariant.entries()].map(([variantId, quantity]) => ({ receiptId: rid, variantId, quantity, shipmentId: input.shipmentId })));
      }
    }

    await tx.insert(schema.returnInspectionItems).values(
      items.map((it) => ({
        inspectionId: row.id,
        shipmentId: input.shipmentId,
        expectedVariantId: it.expectedVariantId,
        expectedSku: it.expectedSku,
        expectedName: it.expectedName,
        expectedColor: it.expectedColor,
        expectedSize: it.expectedSize,
        expectedQty: it.expectedQty,
        actualVariantId: it.actualVariantId,
        actualSku: it.actualSku,
        actualQty: it.actualQty,
        condition: it.condition,
        note: it.note,
        inspectedBy: actor,
        inspectedAt: now,
      })),
    );

    /*
      KẾT LUẬN CẢ KIỆN SUY RA TỪ CÁC MÓN, không bắt người dùng nhập lại lần nữa.

      Cột `condition` của `return_inspections` vẫn được điền để mọi báo cáo và bảng đếm đang có chạy
      y nguyên — nhưng từ nay nó là số DẪN XUẤT; sự thật chi tiết nằm ở bảng từng món.
      Thứ tự ưu tiên theo mức nghiêm trọng: thiếu > sai hàng > hỏng > không bán được.
    */
    const parcelCondition: ReturnCondition = items.every((it) => it.condition === "OK")
      ? "RESTOCKABLE"
      : items.some((it) => it.condition === "SHORT")
        ? "MISSING"
        : items.some((it) => it.condition === "WRONG_ITEM")
          ? "WRONG_ITEM"
          : items.some((it) => it.condition === "DAMAGED")
            ? "DAMAGED"
            : "UNSELLABLE";
    // Ràng buộc CSDL: kết luận khác "bán lại được" thì BẮT BUỘC có lý do. Gộp lý do của từng món để
    // người đọc phiếu kiện thấy ngay vì sao, không phải mở bảng chi tiết.
    const summary = items
      .filter((it) => it.condition !== "OK")
      .map((it) => `${it.expectedSku || it.expectedName}: ${ITEM_CONDITION_LABEL[it.condition]}${it.note ? ` — ${it.note}` : ""}`)
      .join(" · ");

    const flipped = await tx
      .update(ins)
      .set({
        status: "INSPECTED",
        condition: parcelCondition,
        restockQty: restockTotal,
        unsellableQty: unsellableTotal,
        note: summary,
        inspectedAt: now,
        inspectedBy: actor,
        stockReceiptId: receiptId,
        updatedAt: now,
      })
      // Lật trạng thái CÓ ĐIỀU KIỆN: chỉ khi vẫn đang RECEIVED. Hai người bấm cùng lúc thì người sau
      // không lật được ⇒ toàn bộ giao dịch (kể cả phiếu kho vừa lập) bị huỷ, tồn không cộng hai lần.
      .where(and(eq(ins.id, row.id), eq(ins.status, "RECEIVED")))
      .returning({ id: ins.id });
    if (!flipped.length) throw new Error("DA_DEM_ROI");

    await tx
      .update(s)
      .set({ returnReceivedAt: now, returnReceivedBy: actor, returnReceivedNote: summary || null, updatedAt: now })
      .where(and(eq(s.id, input.shipmentId), isNull(s.returnReceivedAt)));

    });
  } catch (e) {
    if (e instanceof Error && e.message === "DA_DEM_ROI") return { error: "Kiện này vừa được người khác đếm — không ghi lại lần hai" };
    throw e;
  }
  return { ok: true, restocked: restockTotal, receiptId, hasDiscrepancy };
}

/** Kết quả đếm theo món của một kiện — để ngăn kéo hiện lại việc đã làm. */
export async function listInspectedItems(shipmentId: string) {
  const db = await getDb();
  return db
    .select()
    .from(schema.returnInspectionItems)
    .where(eq(schema.returnInspectionItems.shipmentId, shipmentId))
    .orderBy(asc(schema.returnInspectionItems.createdAt));
}
