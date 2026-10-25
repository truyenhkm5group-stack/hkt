/**
 * ═══ MÃ THAM CHIẾU ĐƠN TRÊN VẬN ĐƠN VIETTEL POST → ĐƠN ERP (vtp-direct-sync (4), 25/10/2026) ═══
 *
 * Shop tạo vận đơn TRỰC TIẾP trên app / web Viettel Post. Ô «Mã đơn hàng» (ORDER_REFERENCE ở webhook, cột «Mã đơn hàng» ở tệp
 * Danh sách vận đơn) là thứ DUY NHẤT nối kiện về đơn — webhook không mang SĐT, và không bao giờ ghép theo tên. Hai dạng được nhận:
 *  · mã vận đơn cũ của chính đơn (PKE…) — đường `reshipParentOf` (reship.ts), không đổi;
 *  · mã ĐƠN ERP: đúng `orders.id`, đúng `orders.custom_id`, hoặc SỐ ĐƠN POS (`orders.system_id`) viết ĐÚNG dạng `6277` / `#6277`.
 *
 * Bản cũ của webhook gom MỌI chữ số trong ô (`ref.replace(/\D/g, "")`) rồi so với system_id — «HD-0961-2026» thành 9612026 và khớp
 * bừa một đơn nếu số ấy tồn tại. Đo production 25/10/2026 (db-query 40216319921): 0 vận đơn đang gắn đơn nhờ nhánh system_id ở bất
 * kỳ dạng nào, nên siết lại KHÔNG gỡ liên kết cũ nào — và nó chỉ áp cho lượt ghép mới.
 * Khớp từ hai đơn trở lên ⇒ KHÔNG ghép (nhập nhằng), không đoán.
 */
import { eq, or, sql, type SQL } from "drizzle-orm";
import { schema, type Db } from "@/db";

/** Số đơn POS: 1–7 chữ số, cho phép một dấu `#` đứng trước. Không khoảng trắng, không chữ, không gom chữ số. */
export const POS_ORDER_NUMBER_RE = /^#?(\d{1,7})$/;

/** Số đơn POS của một mã tham chiếu, hoặc `null`. HÀM THUẦN. */
export function posOrderNumberOf(ref: string | null | undefined): number | null {
  const m = POS_ORDER_NUMBER_RE.exec(String(ref ?? "").trim());
  return m ? Number(m[1]) : null;
}

export type OrderRefMatch = { orderId: string; phone: string | null };

const up = (v: string | null | undefined) => String(v ?? "").trim().toUpperCase();

/** Điều kiện SQL của MỘT mã tham chiếu trên bảng `orders`. `null` = mã rỗng. */
function refCond(ref: string): SQL | null {
  const r = ref.trim();
  if (!r) return null;
  const parts: SQL[] = [eq(schema.orders.id, r), sql`upper(${schema.orders.customId}) = ${up(r)}`];
  const so = posOrderNumberOf(r);
  if (so !== null) parts.push(eq(schema.orders.systemId, so));
  return or(...parts) ?? null;
}

/**
 * Đơn ERP cho từng mã tham chiếu (khoá = mã VIẾT HOA). Chỉ ghi vào kết quả khi khớp ĐÚNG MỘT đơn; nhập nhằng ⇒ không có trong
 * bản đồ, kèm trong `ambiguous`. Không ghi gì.
 */
export async function ordersForReferences(db: Pick<Db, "select">, refs: readonly string[]): Promise<{ byRef: Map<string, OrderRefMatch>; ambiguous: Set<string> }> {
  const keys = [...new Set(refs.map((r) => r.trim()).filter(Boolean))];
  const byRef = new Map<string, OrderRefMatch>();
  const ambiguous = new Set<string>();
  if (!keys.length) return { byRef, ambiguous };
  const conds = keys.map(refCond).filter((c): c is SQL => c !== null);
  const o = schema.orders;
  const rows = await db
    .select({ id: o.id, customId: o.customId, systemId: o.systemId, phone: sql<string | null>`coalesce(nullif(${o.shipPhone}, ''), nullif(${o.billPhone}, ''))` })
    .from(o)
    .where(or(...conds));
  for (const k of keys) {
    const so = posOrderNumberOf(k);
    const hit = rows.filter((r) => r.id === k || up(r.customId) === up(k) || (so !== null && r.systemId === so));
    const ids = new Set(hit.map((h) => h.id));
    if (ids.size === 1) byRef.set(up(k), { orderId: hit[0].id, phone: hit[0].phone });
    else if (ids.size > 1) ambiguous.add(up(k));
  }
  return { byRef, ambiguous };
}

/** Một mã tham chiếu ⇒ đơn (kèm các lần gửi), hoặc `null` (không khớp / nhập nhằng). */
export async function orderForReference(db: Db, ref: string | null | undefined) {
  const r = String(ref ?? "").trim();
  if (!r) return null;
  const { byRef } = await ordersForReferences(db, [r]);
  const hit = byRef.get(up(r));
  if (!hit) return null;
  return db.query.orders.findFirst({ where: eq(schema.orders.id, hit.orderId), with: { attempts: true } });
}
