import { and, inArray, isNull, sql } from "drizzle-orm";
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
