"use server";

import { can, requireUser } from "@/lib/auth/session";
import { searchEntities, type SearchResult } from "@/lib/queries/search";

const EMPTY: SearchResult = { query: "", hits: [], counts: { orders: 0, shipments: 0, customers: 0, products: 0 }, ambiguous: null };

/**
 * Tìm kiếm cho ô lệnh (⌘K). Lọc theo quyền: người không được xem đơn thì không nhận kết quả đơn.
 * Trả về rỗng thay vì báo lỗi — ô tìm kiếm không phải chỗ để giải thích phân quyền.
 */
export async function globalSearch(query: string): Promise<SearchResult> {
  const user = await requireUser();
  if (!can(user, "orders:read") && !can(user, "shipments:view")) return EMPTY;
  const result = await searchEntities(query);
  const allowed = result.hits.filter((h) => {
    if (h.kind === "ORDER") return can(user, "orders:read");
    if (h.kind === "SHIPMENT") return can(user, "shipments:view");
    if (h.kind === "CUSTOMER") return can(user, "customers:view");
    return can(user, "products:view");
  });
  return { ...result, hits: allowed };
}
