import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import type { ReturnCondition } from "@/lib/constants/returns-condition";

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

export type PendingInspection = {
  shipmentId: string;
  code: string | null;
  orderId: string | null;
  receivedAt: Date;
  receivedBy: string;
  /** Số món ERP đã xuất theo đơn — mốc đối chiếu để người đếm thấy ngay phần thiếu. */
  expectedQty: number;
  ageDays: number;
};

/** Kiện ĐÃ VỀ nhưng CHƯA ĐẾM — việc của kho, và là phần hàng có thật mà sổ đang chưa biết. */
export async function listPendingInspections(limit = 100): Promise<PendingInspection[]> {
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: ins.shipmentId,
      code: s.vtpOrderNumber,
      orderId: ins.orderId,
      receivedAt: ins.receivedAt,
      receivedBy: ins.receivedBy,
      expectedQty: sql<number>`coalesce((select sum(oi.quantity) from order_items oi where oi.order_id = ${ins.orderId}), 0)`,
    })
    .from(ins)
    .leftJoin(s, eq(s.id, ins.shipmentId))
    .where(eq(ins.status, "RECEIVED"))
    .orderBy(asc(ins.receivedAt))
    .limit(limit);

  const now = Date.now();
  return rows.map((r) => ({
    ...r,
    expectedQty: Number(r.expectedQty ?? 0),
    ageDays: Math.floor((now - new Date(r.receivedAt).getTime()) / 86_400_000),
  }));
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
