/**
 * Lý do một đơn landing chưa gửi POS được, ghi vào cột `landing_orders.push_block`.
 *
 * Vì sao phải ghi ra cột thay vì tính lúc đọc: bộ lọc "Đủ thông tin / Chưa đủ thông tin" chạy bằng
 * SQL để phân trang, mà riêng lỗi "địa chỉ thiếu tỉnh/thành" cần đối chiếu danh sách tỉnh không dấu
 * — SQL không tự làm được. Không có cột này thì đơn thiếu tỉnh nằm lẫn ở nhóm "đủ thông tin", nhân
 * viên không thấy để hỏi lại khách, bấm gửi mới báo lỗi.
 */
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { pushBlockOf, type PushBlock } from "@/lib/constants/landing";

/** Ghi lý do vướng; chỉ đụng vào dòng có thay đổi, dòng đã đủ thông tin thì xoá lý do cũ. */
export async function persistPushBlocks(rows: { id: string; block: PushBlock | null; stored: string | null }[]) {
  const changed = rows.filter((r) => (r.block ?? null) !== (r.stored ?? null));
  if (!changed.length) return 0;
  const db = await getDb();
  const groups = new Map<PushBlock | null, string[]>();
  for (const r of changed) {
    const list = groups.get(r.block);
    if (list) list.push(r.id);
    else groups.set(r.block, [r.id]);
  }
  for (const [block, ids] of groups) {
    for (let i = 0; i < ids.length; i += 200) {
      await db
        .update(schema.landingOrders)
        .set({ pushBlock: block, updatedAt: new Date() })
        .where(inArray(schema.landingOrders.id, ids.slice(i, i + 200)));
    }
  }
  return changed.length;
}

/**
 * Rà lại toàn bộ đơn chưa lên POS. Gọi sau mỗi lần đồng bộ sheet landing để cột luôn khớp với dữ
 * liệu hiện tại — địa chỉ khách sửa xong là đơn tự rời nhóm "chưa đủ thông tin".
 */
export async function refreshPushBlocks() {
  const db = await getDb();
  const rows = await db.query.landingOrders.findMany({
    where: and(isNull(schema.landingOrders.orderId), isNull(schema.landingOrders.pancakeOrderId), ne(schema.landingOrders.status, "CANCELLED")),
    columns: { id: true, variantId: true, phone: true, address: true, province: true, pushBlock: true },
  });
  return persistPushBlocks(rows.map((r) => ({ id: r.id, block: pushBlockOf(r), stored: r.pushBlock })));
}

/** Rà lại một đơn; trả về lý do vướng (null là gửi được). */
export async function refreshPushBlock(id: string) {
  const db = await getDb();
  const row = await db.query.landingOrders.findFirst({
    where: eq(schema.landingOrders.id, id),
    columns: { id: true, variantId: true, phone: true, address: true, province: true, pushBlock: true },
  });
  if (!row) return null;
  const block = pushBlockOf(row);
  await persistPushBlocks([{ id: row.id, block, stored: row.pushBlock }]);
  return block;
}
