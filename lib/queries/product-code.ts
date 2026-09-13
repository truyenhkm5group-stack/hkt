/**
 * ═══════════ MÃ HÀNG: ĐI QUA QUAN HỆ THẬT, KHÔNG DÒ CHUỖI ═══════════
 *
 * Chủ shop gọi hàng bằng `Q001`…`Q005`, `X001`. Mã đó sống ở `products.custom_id`.
 *
 * ─── VÌ SAO KHÔNG ĐƯỢC KHỚP BẰNG CHUỖI SKU ───
 *
 * Cám dỗ hiển nhiên là `order_items.sku ilike '%Q002%'`. Đo trên production (13/09/2026) thì cách
 * đó **trả về 0 dòng cho chính mã bán chạy nhất của shop**:
 *
 *   Q002 → SKU của các mẫu là `002 DEN 2XL`   ← KHÔNG có chữ "Q"
 *   Q004 → `Q004DEN2XL`                        ← viết liền, không dấu cách
 *   Q001 → `Q001 2XL DEN`                      ← đảo thứ tự thuộc tính
 *   Q003 → `Q003 DO 2XL`                       ← đúng "kiểu" mong đợi
 *
 * Bốn mã, bốn quy ước đặt tên khác nhau, do người gõ tay vào Pancake ở bốn thời điểm. Một biểu
 * thức chuỗi đủ rộng để bắt hết cả bốn sẽ đồng thời bắt nhầm thứ khác; đủ hẹp để không bắt nhầm
 * thì trượt Q002. **Không có ngưỡng nào đúng, vì bài toán không phải là ngưỡng.**
 *
 * Quan hệ thì không mơ hồ:
 *
 *   shipments.order_id → order_items.variant_id → product_variants.product_id → products.custom_id
 *
 * Bản ghi hiện tại: 6 mã hàng · 90 mẫu mã · 2.382 đơn ghép được mã.
 *
 * ─── 5 DÒNG KHÔNG GHÉP ĐƯỢC, VÀ KHÔNG ĐOÁN ───
 *
 * Có 5 dòng `order_items` không có `variant_id` **và cũng không có `product_id`** — ví dụ dòng gõ
 * tay "2 đầm Q004 nâu + đỏ sz xl". Tên hàng có chữ Q004, nên đoán được. Nhưng đoán ở đây nghĩa là
 * một dòng doanh thu chui vào thống kê của một mã hàng mà không có gì chứng minh, và cái sai đó
 * không bao giờ lộ ra. Chúng nằm ở nhóm CHƯA GHÉP ĐƯỢC, đếm riêng, hiện rõ trên báo cáo.
 */
import { asc, inArray, sql, type SQL } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { memo } from "@/lib/cache";

export type ProductCode = {
  /** `products.custom_id` — mã chủ shop dùng để gọi hàng. */
  code: string;
  /** Tên sản phẩm, để hiện cạnh mã cho người không thuộc mã. */
  name: string;
  productId: string;
  variantIds: string[];
};

/**
 * Danh mục mã hàng. Đệm 5 phút: sản phẩm mới rất hiếm, mà danh sách này được đọc ở mọi lượt mở
 * trang vận đơn và mọi lượt dựng báo cáo.
 *
 * Sản phẩm KHÔNG khai `custom_id` thì không có mã để lọc — bỏ qua, không bịa mã từ tên.
 */
export async function listProductCodes(): Promise<ProductCode[]> {
  return memo("product-codes", 300_000, async () => {
    const db = await getDb();
    const rows = await db
      .select({ code: schema.products.customId, name: schema.products.name, productId: schema.products.id, variantId: schema.productVariants.id })
      .from(schema.products)
      .leftJoin(schema.productVariants, sql`${schema.productVariants.productId} = ${schema.products.id}`)
      .where(sql`coalesce(${schema.products.customId}, '') <> '' and ${schema.products.isRemoved} = false`)
      .orderBy(asc(schema.products.customId));

    const byCode = new Map<string, ProductCode>();
    for (const r of rows) {
      const code = (r.code ?? "").trim();
      if (!code) continue;
      const cur = byCode.get(code) ?? { code, name: r.name, productId: r.productId, variantIds: [] };
      if (r.variantId) cur.variantIds.push(r.variantId);
      byCode.set(code, cur);
    }
    return [...byCode.values()];
  });
}

/** Mẫu mã của một tập mã hàng. Rỗng ⇒ mã không tồn tại (khác với "mã tồn tại nhưng chưa bán được gì"). */
export async function variantIdsOfCodes(codes: readonly string[]): Promise<{ variantIds: string[]; known: string[]; unknown: string[] }> {
  const muon = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!muon.length) return { variantIds: [], known: [], unknown: [] };
  const danhMuc = await listProductCodes();
  const theoMa = new Map(danhMuc.map((p) => [p.code.toUpperCase(), p]));
  const variantIds: string[] = [];
  const known: string[] = [];
  const unknown: string[] = [];
  for (const m of muon) {
    const p = theoMa.get(m);
    if (!p) {
      unknown.push(m);
      continue;
    }
    known.push(p.code);
    variantIds.push(...p.variantIds);
  }
  return { variantIds: [...new Set(variantIds)], known, unknown };
}

/**
 * Mệnh đề "đơn này có chứa ít nhất một mã hàng trong danh sách".
 *
 * `EXISTS` chứ không `JOIN`: một đơn có ba dòng Q002 vẫn là MỘT đơn, và một vận đơn khớp nhiều
 * dòng hàng vẫn là MỘT vận đơn. `JOIN` ở đây sẽ nhân dòng lên đúng bằng số dòng hàng khớp — bảng
 * hiện ba lần cùng một vận đơn, và mọi phép đếm phía sau đều sai theo.
 *
 * Hàng tặng (`is_bonus`) bị loại: khuyến mại kèm theo không phải là "đơn của mã hàng đó".
 *
 * `orderIdColumn` truyền vào để dùng được cho cả `shipments.order_id` lẫn `orders.id`.
 */
export function orderHasProductCode(orderIdColumn: SQL, variantIds: readonly string[]): SQL {
  if (!variantIds.length) return sql`false`;
  return sql`exists (
    select 1 from ${schema.orderItems} oi
    where oi.order_id = ${orderIdColumn}
      and oi.is_bonus = false
      and oi.variant_id in ${variantIds}
  )`;
}

export type ShipmentProductCodes = { codes: string[]; items: { code: string; name: string; detail: string; quantity: number }[]; unmapped: number };

/**
 * Mã hàng của từng vận đơn — chỉ cho các dòng ĐANG HIỆN trên trang.
 *
 * Một truy vấn cho cả trang, không phải một truy vấn mỗi dòng: 25 dòng × một lượt tra là 25 lượt
 * đi về CSDL, và trang vận đơn vốn đã nặng.
 */
export async function productCodesOfShipments(shipmentIds: readonly string[]): Promise<Map<string, ShipmentProductCodes>> {
  const out = new Map<string, ShipmentProductCodes>();
  if (!shipmentIds.length) return out;
  const db = await getDb();
  const rows = await db
    .select({
      shipmentId: schema.shipments.id,
      code: schema.products.customId,
      productName: schema.products.name,
      detail: schema.orderItems.variationDetail,
      itemName: schema.orderItems.productName,
      quantity: schema.orderItems.quantity,
      variantId: schema.orderItems.variantId,
    })
    .from(schema.shipments)
    .innerJoin(schema.orderItems, sql`${schema.orderItems.orderId} = ${schema.shipments.orderId} and ${schema.orderItems.isBonus} = false`)
    .leftJoin(schema.productVariants, sql`${schema.productVariants.id} = ${schema.orderItems.variantId}`)
    .leftJoin(schema.products, sql`${schema.products.id} = ${schema.productVariants.productId}`)
    .where(inArray(schema.shipments.id, [...shipmentIds]));

  for (const r of rows) {
    const cur = out.get(r.shipmentId) ?? { codes: [], items: [], unmapped: 0 };
    const code = (r.code ?? "").trim();
    if (!code) {
      // Dòng hàng không lần được về mã nào. Đếm riêng — KHÔNG suy mã từ tên hàng.
      cur.unmapped += 1;
    } else {
      if (!cur.codes.includes(code)) cur.codes.push(code);
      cur.items.push({ code, name: r.productName ?? r.itemName, detail: r.detail, quantity: r.quantity });
    }
    out.set(r.shipmentId, cur);
  }
  for (const v of out.values()) v.codes.sort();
  return out;
}
