/**
 * Vận đơn nào ĐÃ CÓ CHỨNG TỪ BÀN GIAO cho ĐVVC (luật 41 — `CARRIER_HANDOFF_KNOWN_SQL`) — để bản TypeScript `vanDonDaiDien`
 * chọn lần gửi chính khớp TỪNG BẬC với `PRIMARY_ATTEMPT` (vtp-reship-outcome, 22/10/2026).
 *
 * Câu MỘT BẢNG `shipments`, đúng biểu thức SQL dùng chung (nó ghi đủ tên bảng `"shipments"`), nên không có bản luật thứ hai
 * và không có bẫy «id trần trong câu con» của truy vấn quan hệ drizzle. `stage` KHÔNG được dùng thay: Pancake cũng ghi cột đó.
 */
import { inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CARRIER_HANDOFF_KNOWN_SQL } from "@/lib/constants/carrier-handoff";

export async function handedOffShipmentIds(db: Pick<Db, "select">, ids: readonly string[]): Promise<Set<string>> {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return new Set();
  const s = schema.shipments;
  const rows = await db
    .select({ id: s.id })
    .from(s)
    .where(sql`${inArray(s.id, uniq)} and ${sql.raw(CARRIER_HANDOFF_KNOWN_SQL)}`);
  return new Set(rows.map((r) => r.id));
}

/** Gắn cờ `handedOff` vào từng lần gửi — dùng ngay trước `vanDonDaiDien`. */
export function withHandoff<T extends { id: string }>(rows: readonly T[], handed: ReadonlySet<string>): (T & { handedOff: boolean })[] {
  return rows.map((r) => ({ ...r, handedOff: handed.has(r.id) }));
}
