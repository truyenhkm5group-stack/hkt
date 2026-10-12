import { getTableColumns, getTableName, type Table } from "drizzle-orm";
import { serveCompatAvoidColumns } from "@/lib/constants/migration-serve-compat";

/**
 * Bộ cột để `db.select(compatTableColumns(bảng))` đọc MỘT HÀNG ĐẦY ĐỦ mà vẫn chạy trên lược đồ cũ hơn mã: mọi cột của lược đồ TRỪ cột mà
 * một migration trong sổ tương thích (lib/constants/migration-serve-compat.ts) thêm vào. `select().from(bảng)` đọc mọi cột theo TÊN ⇒
 * CSDL chưa áp migration ấy (tổ chức đang `DEGRADED_MIGRATION`) báo «column does not exist».
 *
 * Kiểu trả về giữ nguyên bản đồ cột của bảng cho tiện gọi, nhưng trường của cột bị tránh VẮNG MẶT ở hàng đọc ra — không đọc chúng từ hàng
 * này (tests/inbox-unread-perf.test.ts đã chặn mọi mã ngoài lược đồ + inbox-unread.ts nhắc tới chúng). Sổ trống cho bảng ⇒ đúng
 * `getTableColumns(bảng)`.
 */
export function compatTableColumns<T extends Table>(table: T): T["_"]["columns"] {
  const avoid = serveCompatAvoidColumns(getTableName(table));
  const cols = getTableColumns(table) as Record<string, { name: string }>;
  if (!avoid.size) return cols as T["_"]["columns"];
  return Object.fromEntries(Object.entries(cols).filter(([, c]) => !avoid.has(c.name))) as T["_"]["columns"];
}
