"use server";

import { can, requireUser } from "@/lib/auth/session";
import { searchEntities, type SearchResult } from "@/lib/queries/search";

const EMPTY: SearchResult = { query: "", hits: [], counts: { orders: 0, shipments: 0, customers: 0, products: 0, work: 0, employees: 0 }, ambiguous: null };

/**
 * Tìm kiếm cho ô lệnh (⌘K). Lọc theo quyền: người không được xem đơn thì không nhận kết quả đơn.
 * Trả về rỗng thay vì báo lỗi — ô tìm kiếm không phải chỗ để giải thích phân quyền.
 */
export async function globalSearch(query: string): Promise<SearchResult> {
  const user = await requireUser();
  // `work:view` có ở mọi vai trò — người chỉ làm việc theo hàng đợi vẫn phải tìm được việc của mình.
  if (!can(user, "orders:read") && !can(user, "shipments:view") && !can(user, "work:view")) return EMPTY;
  const result = await searchEntities(query);
  const allowed = result.hits.filter((h) => {
    if (h.kind === "ORDER") return can(user, "orders:read");
    if (h.kind === "SHIPMENT") return can(user, "shipments:view");
    if (h.kind === "CUSTOMER") return can(user, "customers:view");
    if (h.kind === "WORK") return can(user, "work:view");
    // Danh sách nhân sự dẫn thẳng vào hàng đợi của người đó — chỉ người xem chéo phòng mới thấy.
    if (h.kind === "EMPLOYEE") return can(user, "work:all");
    return can(user, "products:view");
  });
  return { ...result, hits: allowed };
}
