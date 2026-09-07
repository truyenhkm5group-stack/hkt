import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
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
    .returning({ id: s.id });
  return { count: rows.length, ids: rows.map((r) => r.id) };
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
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt)));
  return { count: Number(row?.count ?? 0), items: Number(row?.items ?? 0), oldestAt: row?.oldestAt ?? null };
}

/** Danh sách vận đơn hoàn đã về tới shop, cũ nhất trước — dùng cho thao tác xác nhận hàng loạt. */
export async function listPendingReturnedIds(limit: number) {
  const db = await getDb();
  const rows = await db
    .select({ id: s.id })
    .from(s)
    .where(and(eq(s.stage, "RETURNED"), isNull(s.returnReceivedAt)))
    .orderBy(asc(s.returnedAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
