/**
 * TRANG «SẢN PHẨM» CỦA KHÁCH VỎ CHỐT ĐƠN — HÀM THUẦN, dùng chung cho Server Component (`page.tsx`), client wrapper
 * (`shell-product-list.tsx`) và bài kiểm (`tests/products-shell-v2.test.ts`).
 *
 * Người bán nhỏ không cần 15 cột sổ kho (nhập mới · tái nhập · điều chỉnh · đơn GTC…). Họ cần: tên + SKU + mẫu mã, giá bán,
 * tồn khả dụng, và «thiếu gì để AI bán được». Mọi con số ở đây LẤY LẠI từ dòng `listProducts()` đã tính — không có công thức
 * tồn thứ hai (AGENTS.md luật 3.10). Mẫu chưa có phiếu nhập ⇒ tồn là CHƯA BIẾT (`null`), in «Chưa có phiếu nhập», không in 0
 * (luật 42).
 */
import { formatNumber } from "@/lib/format";
import type { ProductListRow } from "@/lib/queries/products";

/** Chữ in khi mẫu mã chưa có phiếu nhập nào — tồn CHƯA BIẾT, không phải 0. Cùng câu với bảng ERP (`columns.tsx`). */
export const STOCK_UNKNOWN_TEXT = "Chưa có phiếu nhập";

/**
 * Dòng phụ dưới tiêu đề trang. «0 kho» đọc như «không có kho / không có hàng» trong khi tồn vẫn tính từ phiếu kho (sổ kho
 * không cần danh sách kho) — nên 0 kho in câu đúng nghĩa thay vì con số.
 */
export function warehouseHeadline(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "Chưa khai kho — tồn tính chung theo phiếu kho";
  return `${formatNumber(count)} kho`;
}

export const SHELL_PRODUCT_GAPS = ["REMOVED", "NO_PRICE", "NO_STOCK_RECORD", "OUT_OF_STOCK"] as const;
export type ShellProductGap = (typeof SHELL_PRODUCT_GAPS)[number];

export const SHELL_PRODUCT_GAP_LABEL: Record<ShellProductGap, string> = {
  REMOVED: "Đã gỡ / ẩn",
  NO_PRICE: "Chưa có giá bán",
  NO_STOCK_RECORD: "Chưa nhập tồn",
  OUT_OF_STOCK: "Hết hàng",
};

/** Dòng gọn gửi xuống client — chỉ đúng các ô trang vỏ in, không kéo cả 40 trường sổ kho qua mạng. */
export type ShellProductRow = {
  id: string;
  productId: string;
  productName: string;
  image: string | null;
  sku: string;
  variantLabel: string;
  /** Giá bán nhỏ nhất / lớn nhất (> 0). 0 = chưa khai giá bán. Mẫu mã lẻ: hai số bằng nhau. */
  priceMin: number;
  priceMax: number;
  /** Tồn khả dụng; `null` = CHƯA BIẾT (chưa mẫu nào có phiếu nhập), KHÔNG phải 0. */
  available: number | null;
  /** Số mẫu mã chưa có phiếu nhập (dòng cha: trong `variantCount` mẫu). */
  unknownVariants: number;
  variantCount: number;
  /** Mỗi lỗ hổng kèm SỐ MẪU mắc phải — dòng cha in «Hết hàng (2/5 mẫu)» thay vì gộp thành một nhãn sai cho cả mã. */
  gaps: { gap: ShellProductGap; count: number }[];
};

export function shellProductGaps(r: Pick<ProductListRow, "selling" | "retailPrice" | "stockKnown" | "available">): ShellProductGap[] {
  const out: ShellProductGap[] = [];
  if (!r.selling) out.push("REMOVED");
  if (!(r.retailPrice > 0)) out.push("NO_PRICE");
  if (!r.stockKnown) out.push("NO_STOCK_RECORD");
  else if (r.available <= 0) out.push("OUT_OF_STOCK");
  return out;
}

export function shellProductRow(r: ProductListRow): ShellProductRow {
  const price = r.retailPrice > 0 ? r.retailPrice : 0;
  return {
    id: r.id,
    productId: r.productId,
    productName: r.productName,
    image: r.images[0] || r.productImage || null,
    sku: r.sku,
    variantLabel: [r.color, r.size].filter(Boolean).join(" / "),
    priceMin: price,
    priceMax: price,
    available: r.stockKnown ? r.available : null,
    unknownVariants: r.stockKnown ? 0 : 1,
    variantCount: 1,
    gaps: shellProductGaps(r).map((gap) => ({ gap, count: 1 })),
  };
}

/** Dòng cha của một mã hàng: cộng tồn của các mẫu ĐÃ BIẾT tồn; không mẫu nào biết ⇒ `null`, không phải 0. */
export function shellProductGroup(rows: readonly ShellProductRow[]): ShellProductRow {
  const first = rows[0];
  const prices = rows.flatMap((r) => [r.priceMin, r.priceMax]).filter((p) => p > 0);
  const known = rows.filter((r) => r.available !== null);
  const counts = new Map<ShellProductGap, number>();
  for (const r of rows) for (const g of r.gaps) counts.set(g.gap, (counts.get(g.gap) ?? 0) + g.count);
  return {
    ...first,
    id: `group:${first.productId}`,
    sku: "",
    variantLabel: "",
    priceMin: prices.length ? Math.min(...prices) : 0,
    priceMax: prices.length ? Math.max(...prices) : 0,
    available: known.length ? known.reduce((t, r) => t + (r.available ?? 0), 0) : null,
    unknownVariants: rows.reduce((t, r) => t + r.unknownVariants, 0),
    variantCount: rows.reduce((t, r) => t + r.variantCount, 0),
    gaps: SHELL_PRODUCT_GAPS.filter((g) => counts.has(g)).map((gap) => ({ gap, count: counts.get(gap) ?? 0 })),
  };
}

/** Ô tồn khả dụng: CHƯA BIẾT ⇒ «Chưa có phiếu nhập», không bao giờ «0». */
export function shellStockText(row: Pick<ShellProductRow, "available">): string {
  return row.available === null ? STOCK_UNKNOWN_TEXT : formatNumber(row.available);
}

/** Nhãn một lỗ hổng: dòng cha mà chỉ một phần mẫu mắc ⇒ kèm «(n/tổng mẫu)». */
export function shellGapText(g: { gap: ShellProductGap; count: number }, variantCount: number): string {
  const label = SHELL_PRODUCT_GAP_LABEL[g.gap];
  return variantCount > 1 && g.count < variantCount ? `${label} (${g.count}/${variantCount} mẫu)` : label;
}
