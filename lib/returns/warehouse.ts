import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "@/lib/constants/actor";
import { getDb, schema, type Db } from "@/db";
import { IS_RETURN_AWAITING_WAREHOUSE } from "@/lib/queries/return-rate";
import { markReturnsArrived, undoReturnArrived } from "@/lib/returns/inspection";

const s = schema.shipments;
const ins = schema.returnInspections;
/** Nơi ghi: CSDL thường hoặc giao dịch đang mở — đóng kiện phải nằm CÙNG giao dịch với phiếu kho. */
type DbLike = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Kho GHI NHẬN kiện hàng hoàn đã về tới nơi.
 *
 * ĐÂY KHÔNG PHẢI LÚC HÀNG VÀO TỒN. Trước đây thao tác này lập luôn một phiếu tái nhập bằng đúng số
 * đã xuất — tức là ERP tự khẳng định "kiện về đủ" cho hàng trăm kiện chưa ai mở ra. Kiện thiếu món
 * hay hàng hỏng vẫn được cộng vào tồn như hàng lành, và phần chênh không bao giờ hiện ra.
 *
 * Từ nay: ghi nhận đã về chỉ mở một phiếu CHỜ ĐẾM. Hàng vào tồn ở bước đếm
 * (`recordInspection`), theo số người kiểm đếm được, và chỉ phần còn bán lại được.
 *
 * Idempotent: kiện đã ghi nhận rồi thì bấm lại không tạo thêm phiếu.
 */
export async function markReturnReceived(ids: string[], actor: Actor, note?: string) {
  return markReturnsArrived(ids, actor, note);
}

/**
 * Huỷ ghi nhận đã về (bấm nhầm kiện). Chỉ huỷ được kiện CHƯA ĐẾM — đã đếm thì tồn đã đổi theo phiếu
 * tái nhập, và sửa tồn phải bằng phiếu điều chỉnh có người ký, không bằng cách xoá ngược lịch sử.
 *
 * Vẫn gỡ mốc `return_received_at` cho các kiện được xác nhận từ trước khi có luồng đếm.
 */
export async function undoReturnReceived(ids: string[]) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, blocked: 0 };
  const db = await getDb();
  const { count, blocked } = await undoReturnArrived(unique);
  const rows = await db
    .update(s)
    .set({ returnReceivedAt: null, returnReceivedBy: null, returnReceivedNote: null, updatedAt: new Date() })
    .where(
      and(
        inArray(s.id, unique),
        sql`${s.returnReceivedAt} is not null`,
        // Không gỡ mốc của kiện ĐÃ ĐẾM: mốc đó đi cùng một phiếu tái nhập có thật.
        sql`not exists (select 1 from return_inspections ri where ri.shipment_id = ${s.id} and ri.status = 'INSPECTED')`,
      ),
    )
    .returning({ id: s.id });
  return { count: Math.max(count, rows.length), blocked };
}

/**
 * Hàng hoàn ĐÃ VỀ TỚI SHOP mà kho chưa xác nhận.
 *
 * Vị ngữ dùng chung `IS_RETURN_AWAITING_WAREHOUSE` (`lib/queries/return-rate.ts`) — cùng một điều
 * kiện với bàn nhận hàng và thẻ "Chờ kho nhận", để ba nơi không bao giờ nói ba con số.
 *
 * Đây là phần tồn kho đang bị hụt: hàng có thật trong kho nhưng ERP chưa cộng lại, nên kế hoạch
 * đặt hàng sẽ đặt thừa.
 *
 * Số món đếm CẢ hàng tặng (chúng cũng nằm trong kiện và cách tính tồn đã trừ chúng), nhưng CHỈ cộng
 * cho kiện mang sẵn khoá đơn. Vận đơn chiều về (`order_id` null) vẫn được đếm là KIỆN — nó là hàng
 * thật đã về tới shop — nhưng số món của nó nằm ở `unknownParcels`, KHÔNG được ước lượng thành 0.
 */
export async function pendingReturnedForWarehouse() {
  const db = await getDb();
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      items: sql<number>`coalesce(sum((select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${s.orderId})) filter (where ${s.orderId} is not null), 0)`,
      unknownParcels: sql<number>`count(*) filter (where ${s.orderId} is null)`,
      oldestAt: sql<Date | null>`min(${s.returnedAt})`,
      /**
       * VỐN ĐANG NẰM NGOÀI SỔ — tính theo GIÁ NHẬP của chính các món trong kiện.
       *
       * Vì sao cần con số này: "445 kiện chờ đếm" không nói lên mức độ nghiêm trọng. Quy ra tiền
       * thì nó so sánh được với vốn nằm chết và với tiền mặt đang có — và mới trả lời được câu
       * "có đáng bỏ một buổi ra đếm không".
       */
      value: sql<number>`coalesce(sum((
        select coalesce(sum(oi.quantity * coalesce(nullif(pv.last_imported_price, 0), 0)), 0)
        from order_items oi left join product_variants pv on pv.id = oi.variant_id
        where oi.order_id = ${s.orderId}
      )) filter (where ${s.orderId} is not null), 0)`,
      /** Quá 30 ngày: nhóm có nguy cơ không bao giờ được đếm. */
      stale: sql<number>`count(*) filter (where ${s.returnedAt} < now() - interval '30 days')`,
    })
    .from(s)
    .where(IS_RETURN_AWAITING_WAREHOUSE);
  return {
    count: Number(row?.count ?? 0),
    items: Number(row?.items ?? 0),
    /** Kiện chưa mang khoá đơn — số món của chúng CHƯA BIẾT, không nằm trong `items`. */
    unknownParcels: Number(row?.unknownParcels ?? 0),
    oldestAt: row?.oldestAt ?? null,
    value: Number(row?.value ?? 0),
    stale: Number(row?.stale ?? 0),
  };
}

/** Danh sách vận đơn hoàn đã về tới shop, cũ nhất trước — dùng cho thao tác xác nhận hàng loạt. */
export async function listPendingReturnedIds(limit: number) {
  const db = await getDb();
  const rows = await db.select({ id: s.id }).from(s).where(IS_RETURN_AWAITING_WAREHOUSE).orderBy(asc(s.returnedAt)).limit(limit);
  return rows.map((r) => r.id);
}

export type ReturnReceiptLine = { variantId: string; quantity: number; shipmentId: string | null };

export type SettleReturnsResult = { ok: true; settledShipmentIds: string[] } | { error: string };

/**
 * PHIẾU TÁI NHẬP LẬP TAY (ở trang Nhập kho) đóng ĐÚNG những vận đơn mà từng dòng phiếu chỉ tên.
 *
 * Trước đây hàm này đoán: gom số đếm theo mẫu mã rồi gạch các vận đơn hoàn CŨ NHẤT có mẫu mã đó cho
 * tới khi đủ số (FIFO). Kho đếm được 3 áo đỏ thì ERP tự kết luận "ba kiện cũ nhất đã về" — không
 * ai nhìn thấy ba kiện đó, không có biên bản đếm, và người ký là một chuỗi email. Kiện thật sự về
 * có thể là kiện thứ tư; kiện cũ nhất có thể đã mất trên đường. Sổ từ đó nói dối một cách gọn gàng.
 *
 * Từ nay:
 *  · Dòng phiếu KHÔNG nêu vận đơn ⇒ KHÔNG gạch kiện nào. Phiếu vẫn cộng tồn đúng số đã đếm (đó là
 *    một phiếu đếm có người ký), chỉ là chưa nói được kiện nào đã xử lý — và hàng chờ vẫn hiện.
 *  · Dòng nêu vận đơn ⇒ đóng đúng vận đơn ấy, kèm một phiếu kiểm `return_inspections` ở trạng thái
 *    ĐÃ ĐẾM, người nhận = người đếm = `actor` (khoá tài khoản, luật 34), trỏ về phiếu kho.
 *  · Vận đơn đã có phiếu ĐÃ ĐẾM ⇒ từ chối cả phiếu: đếm lần hai là cộng tồn hai lần.
 *
 * Chạy TRONG giao dịch của phiếu kho: đóng kiện mà phiếu không ghi được (hoặc ngược lại) thì cả hai
 * cùng huỷ.
 */
export async function settleReturnsForReceipt(
  tx: DbLike,
  input: { receiptId: string; lines: ReturnReceiptLine[]; actor: Actor; note?: string },
): Promise<SettleReturnsResult> {
  const qtyByShipment = new Map<string, number>();
  for (const line of input.lines) {
    const id = line.shipmentId?.trim();
    if (!id || line.quantity <= 0) continue;
    qtyByShipment.set(id, (qtyByShipment.get(id) ?? 0) + line.quantity);
  }
  if (!qtyByShipment.size) return { ok: true, settledShipmentIds: [] };

  const ids = [...qtyByShipment.keys()];
  const found = await tx.select({ id: s.id, orderId: s.orderId, code: s.vtpOrderNumber }).from(s).where(inArray(s.id, ids));
  const missing = ids.filter((id) => !found.some((f) => f.id === id));
  if (missing.length) return { error: `Vận đơn không có trong ERP: ${missing.join(", ")}` };

  const existing = await tx.select({ id: ins.id, shipmentId: ins.shipmentId, status: ins.status }).from(ins).where(inArray(ins.shipmentId, ids));
  const daDem = existing.filter((e) => e.status === "INSPECTED");
  if (daDem.length) {
    const codes = daDem.map((e) => found.find((f) => f.id === e.shipmentId)?.code ?? e.shipmentId);
    return { error: `Kiện đã được đếm rồi, không tái nhập lần hai: ${codes.join(", ")} — muốn sửa số thì lập phiếu điều chỉnh kho` };
  }

  const now = new Date();
  const note = input.note?.trim() ?? "";
  const label = input.actor.label.trim();
  if (!label) return { error: "Thiếu người kiểm" };

  for (const sh of found) {
    const restock = qtyByShipment.get(sh.id) ?? 0;
    const daNhan = existing.find((e) => e.shipmentId === sh.id);
    const inspected = {
      status: "INSPECTED" as const,
      condition: "RESTOCKABLE",
      restockQty: restock,
      unsellableQty: 0,
      note,
      inspectedAt: now,
      inspectedBy: label,
      inspectedByUserId: input.actor.id,
      stockReceiptId: input.receiptId,
      updatedAt: now,
    };
    if (daNhan) {
      // Đã bấm "đã nhận" trước đó: giữ nguyên người nhận, chỉ lật sang ĐÃ ĐẾM. Lật CÓ ĐIỀU KIỆN —
      // một lượt khác vừa đếm xong thì không đè.
      const flipped = await tx
        .update(ins)
        .set(inspected)
        .where(and(eq(ins.id, daNhan.id), eq(ins.status, "RECEIVED")))
        .returning({ id: ins.id });
      if (!flipped.length) return { error: `Kiện ${sh.code ?? sh.id} vừa được người khác đếm — không ghi lại lần hai` };
    } else {
      await tx.insert(ins).values({
        shipmentId: sh.id,
        orderId: sh.orderId,
        receivedAt: now,
        receivedBy: label,
        receivedByUserId: input.actor.id,
        ...inspected,
      });
    }
  }

  await tx
    .update(s)
    .set({ returnReceivedAt: now, returnReceivedBy: label, returnReceivedNote: note || null, updatedAt: now })
    .where(and(inArray(s.id, ids), isNull(s.returnReceivedAt)));

  return { ok: true, settledShipmentIds: ids };
}

/** Hàng hoàn đang chờ kho nhận, gộp theo mẫu mã — để phiếu tái nhập biết dự kiến bao nhiêu món. */
export async function pendingReturnsByVariant() {
  const db = await getDb();
  const rows = await db
    .select({ variantId: schema.orderItems.variantId, quantity: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(s)
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, s.orderId))
    .where(
      and(
        isNull(s.returnReceivedAt),
        sql`(${s.stage} in ('RETURNING','RETURNED','CANCELLED') or exists (select 1 from orders o2 where o2.id = ${s.orderId} and o2.stage in ('CANCELLED','DELETED')))`,
      ),
    )
    .groupBy(schema.orderItems.variantId);
  return new Map(rows.filter((r) => r.variantId).map((r) => [r.variantId as string, Number(r.quantity ?? 0)]));
}
