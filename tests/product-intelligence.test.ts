import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getProductIntelligence, getProductMatrix } from "@/lib/queries/product-intelligence";
import { getDashboardData } from "@/lib/queries/dashboard";
import { ORDER_OUTCOME } from "@/lib/queries/return-rate";
import type { Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * HIỆU QUẢ THEO MẪU MÃ.
 *
 * Điều phải khoá: xếp hạng "bán chạy" đi theo KẾT QUẢ THẬT chứ không theo số lên đơn, và mọi con
 * số vẫn đi qua `ORDER_OUTCOME` — không có công thức riêng cho trang sản phẩm.
 */
export async function testProductIntelligence(db: Db) {
  clearMemo();
  const rows = await getProductIntelligence({ period: ALL, limit: 50 });
  assert.ok(rows.length > 0, "fixture phải có mẫu mã bán được để kiểm tra");

  // ───────── 1. Số liệu phải khớp ORDER_OUTCOME, không tính lại theo cách khác ─────────
  const withVariant = rows.find((r) => r.variantId);
  assert.ok(withVariant, "phải có mẫu mã ghép được với sản phẩm ERP");
  const [truth] = await db
    .select({
      deliveredQty: sql<number>`coalesce(sum(${schema.orderItems.quantity}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      returnedQty: sql<number>`coalesce(sum(${schema.orderItems.quantity}) filter (where ${ORDER_OUTCOME} in ('RETURNED','RETURNED_BY_RULE')), 0)`,
      deliveredRevenue: sql<number>`coalesce(sum(${schema.orderItems.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
    })
    .from(schema.orderItems)
    .innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId))
    .leftJoin(schema.shipments, eq(schema.shipments.orderId, schema.orders.id))
    .where(sql`${schema.orderItems.variantId} = ${withVariant.variantId} and ${schema.orderItems.isBonus} = false and ${schema.orders.stage} <> 'NEW'`);
  assert.equal(withVariant.deliveredQty, Number(truth.deliveredQty), "số lượng giao thành công phải khớp ORDER_OUTCOME");
  assert.equal(withVariant.returnedQty, Number(truth.returnedQty), "số lượng hoàn phải khớp ORDER_OUTCOME");
  assert.equal(withVariant.deliveredRevenue, Number(truth.deliveredRevenue), "doanh thu giao thành công phải khớp ORDER_OUTCOME");

  // ───────── 2. Ba chiều đầy đủ: BÁN · CHẤT · CÒN ─────────
  for (const r of rows) {
    assert.ok(r.orderedQty >= r.deliveredQty, `${r.sku}: số lên đơn phải ≥ số giao thành công`);
    if (r.successRate !== null) {
      assert.ok(r.successRate >= 0 && r.successRate <= 100, `${r.sku}: GTC phải trong 0–100`);
      assert.equal(r.returnRate, Math.round((100 - r.successRate) * 10) / 10, `${r.sku}: tỷ lệ hoàn = 100 − GTC`);
    } else {
      assert.equal(r.returnRate, null, `${r.sku}: chưa có đơn kết thúc thì cả hai tỷ lệ đều CHƯA BIẾT`);
    }
  }

  // ───────── 3. THIẾU DỮ LIỆU LÀ CHƯA BIẾT, KHÔNG PHẢI 0 ─────────
  const noStock = rows.find((r) => r.available === null);
  if (noStock) {
    assert.equal(noStock.daysOfCover, null, "chưa biết tồn thì không được bịa ra số ngày còn hàng");
  }
  const noCost = rows.find((r) => r.contribution === null);
  if (noCost) {
    assert.ok(noCost.contributionBlockedBy, "không tra được giá vốn thì phải nói rõ vì sao, không trả 0");
  }
  for (const r of rows) {
    if (r.contribution !== null) {
      assert.equal(r.contributionBlockedBy, null);
      assert.ok(r.contribution <= r.deliveredRevenue, `${r.sku}: lợi nhuận góp không được vượt doanh thu`);
    }
  }

  // ───────── 4. XẾP HẠNG THEO KẾT QUẢ THẬT, KHÔNG THEO SỐ LÊN ĐƠN ─────────
  for (let n = 1; n < rows.length; n += 1) {
    assert.ok(rows[n - 1].deliveredRevenue >= rows[n].deliveredRevenue, "bảng phải xếp theo doanh thu GIAO THÀNH CÔNG giảm dần");
  }
  clearMemo();
  const dash = await getDashboardData(ALL);
  assert.ok(dash.topProducts.length > 0);
  assert.equal(dash.topProducts[0].deliveredRevenue, rows[0].deliveredRevenue, "Tổng quan phải dùng CHÍNH bảng hiệu quả này, không tự xếp hạng riêng");
  for (const t of dash.topProducts) {
    assert.ok("successRate" in t && "daysOfCover" in t, "top mẫu mã trên Tổng quan phải kèm chất lượng và tồn còn lại");
  }

  // ───────── 5. Lọc theo kênh bán không được tạo ra số lớn hơn tổng ─────────
  const facebook = await getProductIntelligence({ period: ALL, channel: "FACEBOOK", limit: 50 });
  const totalDelivered = rows.reduce((t, r) => t + r.deliveredQty, 0);
  const fbDelivered = facebook.reduce((t, r) => t + r.deliveredQty, 0);
  assert.ok(fbDelivered <= totalDelivered, "lọc theo kênh phải cho tập con, không được nhiều hơn tổng");

  // ───────── 6. Ma trận Màu × Size chỉ dựng khi thật sự có nhiều màu/size ─────────
  const productId = rows.find((r) => r.productId)?.productId;
  if (productId) {
    const matrix = await getProductMatrix(productId, ALL);
    if (matrix) {
      assert.ok(matrix.colors.length >= 2 || matrix.sizes.length >= 2, "ma trận chỉ có nghĩa khi mã hàng có nhiều màu hoặc nhiều size");
      const cells = Object.values(matrix.cells).flatMap((row) => Object.values(row));
      assert.ok(cells.length > 0, "ma trận phải có ít nhất một ô có dữ liệu");
      for (const cell of cells) assert.ok(cell.deliveredQty >= 0);
    }
  }

  console.log(
    `✓ Hiệu quả mẫu mã: ${rows.length} mẫu mã · dẫn đầu ${rows[0].sku || rows[0].productName} (${rows[0].deliveredQty} sp giao TC, GTC ${rows[0].successRate ?? "—"}%) · xếp theo kết quả thật, không theo số lên đơn`,
  );
}
