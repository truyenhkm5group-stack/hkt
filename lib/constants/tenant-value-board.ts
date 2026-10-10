/**
 * ═══════════ BẢNG «GIÁ TRỊ KHÁCH HÀNG» Ở /platform/saas — HẰNG SỐ DÙNG CHUNG HAI PHÍA (CLIENT-SAFE) ═══════════
 *
 * Mã cột sắp xếp được phải TRÙNG giữa bộ đọc máy chủ (`lib/saas/tenant-value-read.ts`) và client wrapper
 * (`components/platform/tenant-value-table.tsx` qua `DataTable`) — nên danh sách nằm ở đây, không gõ lại ở hai nơi.
 * Mỗi mã ánh xạ tới MỘT cột phẳng của `platform_tenant_value_snapshots` (0240); `NULL` luôn xếp CUỐI (chưa biết không
 * được đứng đầu bảng như một số 0 to nhất hay nhỏ nhất).
 */
import { DEFAULT_TENANT_VALUE_DECISIONS, TENANT_VALUE_WINDOWS, type TenantValueWindow } from "@/lib/constants/tenant-value-metrics";

export const TENANT_VALUE_BOARD_PAGE_SIZE = 25;

/** Mã cột sắp xếp được (id cột của DataTable). */
export const TENANT_VALUE_SORTABLE = ["customerSpend", "variableCogs", "valueMultiple", "platformProfit", "org"] as const;
export type TenantValueSortKey = (typeof TENANT_VALUE_SORTABLE)[number];
export const TENANT_VALUE_DEFAULT_SORT: TenantValueSortKey = "customerSpend";

export function isTenantValueSortKey(v: unknown): v is TenantValueSortKey {
  return typeof v === "string" && (TENANT_VALUE_SORTABLE as readonly string[]).includes(v);
}

/** `?w=7|30|90` — giá trị lạ / thiếu ⇒ cửa sổ mặc định của quyết định D12 (đọc từ sổ, không gõ lại 30). */
export function parseValueWindow(raw: unknown): TenantValueWindow {
  const s = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(s);
  return (TENANT_VALUE_WINDOWS as readonly number[]).includes(n) ? (n as TenantValueWindow) : DEFAULT_TENANT_VALUE_DECISIONS.defaultWindowDays;
}
