import { and, asc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/db";

const s = schema.shipments;

/**
 * Kho XÁC NHẬN đã nhận hàng hoàn về. Chỉ khi có mốc này hàng mới được cộng lại tồn ERP
 * (`erpStockExpr`); trạng thái "đã hoàn" của ĐVVC là chưa đủ.
 *
 * Idempotent: chỉ ghi cho vận đơn còn `return_received_at IS NULL`, nên bấm lại lần hai
 * không cộng trùng tồn và không đè mất người/mốc xác nhận lần đầu.
 * Trả về số vận đơn THỰC SỰ được đánh dấu trong lần gọi này.
 */
export async function markReturnReceived(ids: string[], actor: string, note?: string) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0, ids: [] as string[] };
  const db = await getDb();
  const rows = await db
    .update(s)
    .set({ returnReceivedAt: new Date(), returnReceivedBy: actor, returnReceivedNote: note?.trim() || null, updatedAt: new Date() })
    .where(and(inArray(s.id, unique), isNull(s.returnReceivedAt)))
    .returning({ id: s.id, orderId: s.orderId });
  // Hàng chỉ quay lại tồn khi có PHIẾU KHO. Xác nhận nhanh ở đây nghĩa là "nhận đủ đúng số đã xuất",
  // nên ERP lập luôn phiếu tái nhập tương ứng — nếu không, hàng vừa xác nhận sẽ biến mất khỏi sổ kho.
  const marked = rows.map((r) => r.id);
  if (marked.length) await createReturnReceiptFor(marked, actor, note);
  return { count: rows.length, ids: marked };
}

/**
 * Huỷ xác nhận nhận hoàn (ghi nhầm). Đưa hàng trở lại trạng thái "chưa về kho"
 * và do đó trừ khỏi tồn ERP. Không xoá dữ liệu nào khác.
 */
export async function undoReturnReceived(ids: string[]) {
  const unique = [...new Set(ids.filter((id) => id.trim()))];
  if (!unique.length) return { count: 0 };
  const db = await getDb();
  const rows = await db
    .update(s)
    .set({ returnReceivedAt: null, returnReceivedBy: null, returnReceivedNote: null, updatedAt: new Date() })
    .where(and(inArray(s.id, unique), sql`${s.returnReceivedAt} is not null`))
    .returning({ id: s.id });
  return { count: rows.length };
}

/**
 * Hàng hoàn ĐÃ VỀ TỚI SHOP mà kho chưa xác nhận.
 *
 * Chỉ tính vận đơn ở trạng thái RETURNED — tức Viettel Post đã trả hàng xong cho người gửi
 * (mã 504). Vận đơn RETURNING vẫn đang trên đường về, xác nhận nhận hàng lúc đó là bịa dữ liệu.
 *
 * Đây là phần tồn kho đang bị hụt: hàng có thật trong kho nhưng ERP chưa cộng lại, nên kế hoạch
 * đặt hàng sẽ đặt thừa.
 *
 * Đếm CẢ hàng tặng: chúng cũng nằm trong kiện hàng quay về và cách tính tồn của ERP đã tính,
 * nên số món ở đây phải khớp với mức tồn tăng lên sau khi xác nhận.
 *
 * Chỉ tính vận đơn CÓ GẮN ĐƠN. Viettel Post tạo vận đơn riêng cho chiều hoàn (mã ...1P1) và khi
 * nó phát thành công về shop thì vận đơn đó cũng ở trạng thái RETURNED — nhưng nó không có đơn
 * nào, không có món hàng nào, nên đưa vào hàng chờ kho chỉ tạo ra hàng trăm dòng rỗng. Hàng hoàn
 * của đơn đã nằm ở chính vận đơn gốc.
 */
export async function pendingReturnedForWarehouse() {
  const db = await getDb();
  const [row] = await db
    .select({
      count: sql<number>`count(*)`,
      items: sql<number>`coalesce(sum((select coalesce(sum(oi.quantity), 0) from order_items oi where oi.order_id = ${s.orderId})), 0)`,
      oldestAt: sql<Date | null>`min(${s.returnedAt})`,
    })
    .from(s)
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt), isNotNull(s.orderId)));
  return { count: Number(row?.count ?? 0), items: Number(row?.items ?? 0), oldestAt: row?.oldestAt ?? null };
}

/** Danh sách vận đơn hoàn đã về tới shop, cũ nhất trước — dùng cho thao tác xác nhận hàng loạt. */
export async function listPendingReturnedIds(limit: number) {
  const db = await getDb();
  const rows = await db
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt), isNotNull(s.orderId)))
    .orderBy(asc(s.returnedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Khi kho lập PHIẾU TÁI NHẬP, đóng các vận đơn hoàn đang chờ tương ứng — cũ nhất trước — cho tới khi
 * đủ số lượng vừa đếm được của từng mẫu mã.
 *
 * Vì sao cần: "hoàn chờ nhận" là hàng ERP biết phải quay về nhưng chưa có trong tồn. Không đóng thì
 * con số này phình mãi và kho không biết lô nào đã xử lý. Đóng theo số ĐẾM THỰC TẾ (không phải theo
 * số suy ra từ vận đơn) nên phần đếm thiếu hiện ra thành hàng hụt thay vì bị giấu.
 *
 * Một vận đơn có nhiều mẫu mã: đóng vận đơn đó thì mọi mẫu mã trong kiện được tính là đã xử lý —
 * đúng thực tế vì cả kiện hàng quay về cùng lúc.
 */
export async function settleReturnsForVariants(counts: { variantId: string; quantity: number }[], actor: string, note?: string) {
  const wanted = new Map<string, number>();
  for (const c of counts) if (c.quantity > 0) wanted.set(c.variantId, (wanted.get(c.variantId) ?? 0) + c.quantity);
  if (!wanted.size) return { shipmentIds: [] as string[], firstByVariant: new Map<string, string>() };
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: s.id,
      variantId: schema.orderItems.variantId,
      quantity: schema.orderItems.quantity,
      returnedAt: s.returnedAt,
    })
    .from(s)
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, s.orderId))
    .where(
      and(
        isNull(s.returnReceivedAt),
        inArray(schema.orderItems.variantId, [...wanted.keys()]),
        // Chỉ đóng kiện ĐÃ VỀ TỚI SHOP. Vận đơn còn RETURNING vẫn đang trên đường về; đóng lúc đó
        // là bịa dữ liệu. Số kho đếm được vẫn vào tồn qua phiếu, chỉ là chưa gạch được kiện nào.
        sql`(${s.stage} in ('RETURNED','CANCELLED') or exists (select 1 from orders o2 where o2.id = ${s.orderId} and o2.stage in ('CANCELLED','DELETED')))`,
      ),
    )
    .orderBy(asc(s.returnedAt));

  const closed = new Set<string>();
  const firstByVariant = new Map<string, string>();
  for (const [variantId, want] of wanted) {
    let remaining = want;
    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.variantId !== variantId) continue;
      if (!firstByVariant.has(variantId)) firstByVariant.set(variantId, row.shipmentId);
      if (!closed.has(row.shipmentId)) closed.add(row.shipmentId);
      remaining -= Number(row.quantity ?? 0);
    }
  }
  if (closed.size) {
    await db
      .update(s)
      .set({ returnReceivedAt: new Date(), returnReceivedBy: actor, returnReceivedNote: note?.trim() || null, updatedAt: new Date() })
      .where(and(inArray(s.id, [...closed]), isNull(s.returnReceivedAt)));
  }
  return { shipmentIds: [...closed], firstByVariant };
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

/**
 * Lập phiếu TÁI NHẬP "nhận đủ" cho các vận đơn hoàn vừa được xác nhận nhanh: số lượng lấy đúng
 * theo dòng hàng của đơn. Kho đếm được số khác thì dùng phiếu tái nhập ở màn Nhập hàng & kiểm kê.
 */
export async function createReturnReceiptFor(shipmentIds: string[], actor: string, note?: string) {
  if (!shipmentIds.length) return null;
  const db = await getDb();
  const lines = await db
    .select({ shipmentId: s.id, variantId: schema.orderItems.variantId, quantity: sql<number>`coalesce(sum(${schema.orderItems.quantity}), 0)` })
    .from(s)
    .innerJoin(schema.orderItems, eq(schema.orderItems.orderId, s.orderId))
    .where(and(inArray(s.id, shipmentIds), isNotNull(schema.orderItems.variantId)))
    .groupBy(s.id, schema.orderItems.variantId);
  const items = lines.filter((l) => l.variantId && Number(l.quantity) > 0);
  if (!items.length) return null;
  const totalQuantity = items.reduce((t, i) => t + Number(i.quantity), 0);
  const [receipt] = await db
    .insert(schema.stockReceipts)
    .values({
      kind: "RETURN",
      receivedAt: new Date(),
      reference: `Xác nhận nhanh ${shipmentIds.length} vận đơn hoàn`,
      supplier: "",
      note: note?.trim() || "",
      totalQuantity,
      totalCost: 0,
      createdBy: actor,
    })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values(
    items.map((i) => ({ receiptId: receipt.id, variantId: i.variantId as string, quantity: Number(i.quantity), unitCost: 0, shipmentId: i.shipmentId })),
  );
  return receipt.id;
}
