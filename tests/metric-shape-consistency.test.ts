import assert from "node:assert/strict";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { LINE_UNIT_COST } from "@/lib/queries/cogs";
import { IS_RETURNED } from "@/lib/queries/metrics";
import { ORDER_OUTCOME, REPORTABLE_ORDER } from "@/lib/queries/return-rate";
import { getProductIntelligence } from "@/lib/queries/product-intelligence";
import { getProfitReport } from "@/lib/queries/reports";
import { listProducts, productFacets, PRODUCT_SORTABLE } from "@/lib/queries/products";
import { parseListParams, type Period } from "@/lib/search-params";

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/**
 * ───────── TĂNG TỐC KHÔNG ĐƯỢC ĐỔI CON SỐ ─────────
 *
 * Các truy vấn báo cáo nặng đã được viết lại theo hình dạng "tính `ORDER_OUTCOME` một lần cho mỗi
 * dòng" (bảng dẫn xuất + rào `OUTCOME_FENCE`, xem lib/queries/return-rate.ts). Đó là đổi HÌNH DẠNG
 * truy vấn, không đổi công thức — nhưng "không đổi" phải được CHỨNG MINH, không phải được hứa.
 *
 * Bài kiểm thử này tính lại cùng những con số đó bằng cách viết NGUYÊN THUỶ (nội tuyến
 * `ORDER_OUTCOME` vào từng cột gộp, đúng như trước khi tối ưu) rồi so từng con số một. Lệch một
 * đồng là hỏng: nghĩa là lớp tăng tốc đã đổi ý nghĩa nghiệp vụ, và theo AGENTS.md mục 8 thì phải
 * sửa code chứ không phải sửa kỳ vọng.
 */
export async function testMetricShapeConsistency(db: Db) {
  clearMemo();

  const o = schema.orders;
  const s = schema.shipments;
  const i = schema.orderItems;
  const pv = schema.productVariants;

  // ───────── 1. Hiệu quả mẫu mã: bảng dẫn xuất vs nội tuyến ─────────
  //
  // Đây là truy vấn tốn kém nhất đo được (13 cột gộp × 13 truy vấn con = hơn 100 SubPlan).
  const canonical = await db
    .select({
      variantId: i.variantId,
      orderedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      deliveredQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      returnedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${IS_RETURNED}), 0)`,
      confirmedQty: sql<number>`coalesce(sum(${i.quantity}) filter (where ${o.stage} not in ('NEW','WAITING') and ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      bookedRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} <> 'CANCELLED'), 0)`,
      deliveredRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      lostRevenue: sql<number>`coalesce(sum(${i.lineTotal}) filter (where ${IS_RETURNED}), 0)`,
      deliveredOrders: sql<number>`count(distinct ${o.id}) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      returnedOrders: sql<number>`count(distinct ${o.id}) filter (where ${IS_RETURNED})`,
      deliveredCost: sql<number>`coalesce(sum(${i.quantity} * ${LINE_UNIT_COST}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      missingCostLines: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED' and ${LINE_UNIT_COST} = 0)`,
    })
    .from(i)
    .innerJoin(o, eq(o.id, i.orderId))
    .leftJoin(s, eq(s.orderId, o.id))
    .leftJoin(pv, eq(pv.id, i.variantId))
    .where(sql`${REPORTABLE_ORDER} and ${i.isBonus} = false`)
    .groupBy(i.variantId)
    .orderBy(desc(sql`coalesce(sum(${i.lineTotal}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`))
    .limit(200);

  const accelerated = await getProductIntelligence({ period: ALL, limit: 200 });
  const byVariant = new Map(accelerated.map((r) => [r.variantId, r]));

  assert.ok(canonical.length > 0, "bộ dữ liệu kiểm thử phải có ít nhất một mẫu mã để so sánh");
  assert.equal(accelerated.length, canonical.length, "hai cách tính phải ra CÙNG SỐ MẪU MÃ");

  let compared = 0;
  for (const row of canonical) {
    const fast = byVariant.get(row.variantId);
    assert.ok(fast, `mẫu mã ${row.variantId} có trong cách tính nguyên thuỷ nhưng thiếu trong bảng dẫn xuất`);
    const at = (field: string) => `mẫu mã ${row.variantId} · ${field}`;
    assert.equal(fast.orderedQty, Number(row.orderedQty), at("số lượng lên đơn"));
    assert.equal(fast.deliveredQty, Number(row.deliveredQty), at("số lượng giao thành công"));
    assert.equal(fast.returnedQty, Number(row.returnedQty), at("số lượng hoàn"));
    assert.equal(fast.confirmedQty, Number(row.confirmedQty), at("số lượng đã xác nhận"));
    assert.equal(fast.bookedRevenue, Number(row.bookedRevenue), at("doanh thu lên đơn"));
    assert.equal(fast.deliveredRevenue, Number(row.deliveredRevenue), at("doanh thu giao thành công"));
    assert.equal(fast.lostRevenue, Number(row.lostRevenue), at("doanh thu mất vì hoàn"));

    // Lợi nhuận góp là CHƯA BIẾT khi có dòng không tra được giá vốn — quy tắc đó cũng phải giữ nguyên.
    const missing = Number(row.missingCostLines);
    const expectedContribution = missing > 0 ? null : Number(row.deliveredRevenue) - Number(row.deliveredCost);
    assert.equal(fast.contribution, expectedContribution, at("lợi nhuận góp"));

    const delivered = Number(row.deliveredOrders);
    const returned = Number(row.returnedOrders);
    const finished = delivered + returned;
    const expectedRate = finished ? Math.round((delivered / finished) * 1000) / 10 : null;
    assert.equal(fast.successRate, expectedRate, at("tỷ lệ giao thành công"));
    compared += 1;
  }

  // ───────── 2. Báo cáo lợi nhuận: tổng của bảng dẫn xuất vs nội tuyến ─────────
  const [pnlCanonical] = await db
    .select({
      orders: sql<number>`count(*) filter (where ${o.stage} not in ('CANCELLED','DELETED'))`,
      successOrders: sql<number>`count(*) filter (where ${ORDER_OUTCOME} = 'DELIVERED')`,
      revenue: sql<number>`coalesce(sum(${o.totalPriceAfterDiscount}) filter (where ${ORDER_OUTCOME} = 'DELIVERED'), 0)`,
      returned: sql<number>`count(*) filter (where ${IS_RETURNED})`,
      cancelled: sql<number>`count(*) filter (where ${o.stage} in ('CANCELLED','DELETED'))`,
    })
    .from(o)
    .leftJoin(s, eq(s.orderId, o.id));

  clearMemo();
  const report = await getProfitReport(ALL, "created");
  assert.equal(report.current.orders, Number(pnlCanonical.orders), "số đơn của Báo cáo lợi nhuận phải khớp cách tính nguyên thuỷ");
  assert.equal(report.current.successOrders, Number(pnlCanonical.successOrders), "số đơn giao thành công phải khớp cách tính nguyên thuỷ");
  assert.equal(report.current.revenue, Number(pnlCanonical.revenue), "doanh thu giao thành công phải khớp cách tính nguyên thuỷ");
  assert.equal(report.current.returned, Number(pnlCanonical.returned), "số đơn hoàn phải khớp cách tính nguyên thuỷ");
  assert.equal(report.current.cancelled, Number(pnlCanonical.cancelled), "số đơn huỷ phải khớp cách tính nguyên thuỷ");

  // ───────── 3. Đệm KHÔNG được đổi kết quả ─────────
  //
  // `getProfitReport` nay có đệm 60 giây. Gọi lại ngay phải ra ĐÚNG cùng con số; xoá đệm rồi gọi
  // lại cũng phải ra đúng con số đó. Đệm chỉ được phép nhanh hơn, không được phép khác.
  const cached = await getProfitReport(ALL, "created");
  assert.equal(cached.current.revenue, report.current.revenue, "lần gọi thứ hai (trúng đệm) phải ra cùng doanh thu");
  assert.equal(cached.current.successOrders, report.current.successOrders, "lần gọi thứ hai (trúng đệm) phải ra cùng số đơn giao thành công");
  clearMemo();
  const recomputed = await getProfitReport(ALL, "created");
  assert.equal(recomputed.current.revenue, report.current.revenue, "xoá đệm rồi tính lại phải ra cùng doanh thu");
  assert.equal(recomputed.current.netProfit, report.current.netProfit, "xoá đệm rồi tính lại phải ra cùng lợi nhuận ròng");

  // ───────── 4. Bộ đếm bộ lọc tồn kho phải khớp CHÍNH cột tồn của bảng ─────────
  //
  // Trang Sản phẩm & tồn kho có HAI đường tính tồn: cột trong bảng dùng `erpStockExpr`
  // (tổng phiếu kho − đã xuất qua ĐVVC), còn bộ lọc và bộ đếm facet dùng một biểu thức vô hướng
  // riêng. Chúng TỪNG khác nhau: biểu thức của bộ lọc trừ theo `ORDER_OUTCOME` — định nghĩa theo
  // TIỀN, thứ AGENTS.md mục 3.10 cấm dùng cho sổ kho — nên bấm "Hết hàng" ra những dòng mà chính
  // cột tồn của chúng ghi số dương. Bài kiểm thử này khoá hai đường về cùng một con số.
  const params = parseListParams({}, { defaultSort: "erpStock", defaultDir: "asc", filterKeys: ["stock", "category", "warehouse", "status"], sortable: PRODUCT_SORTABLE, defaultPeriod: "all" });
  const [all, facets] = await Promise.all([listProducts({ ...params, pageSize: 500, page: 1 }), productFacets(params)]);
  const expected = {
    low: all.rows.filter((r) => r.erpStock >= 1 && r.erpStock <= 5).length,
    out: all.rows.filter((r) => r.erpStock <= 0).length,
    in: all.rows.filter((r) => r.erpStock > 0).length,
  };
  for (const key of ["low", "out", "in"] as const) {
    const facet = facets.stock.find((f) => f.value === key);
    assert.ok(facet, `thiếu bộ đếm bộ lọc tồn "${key}"`);
    assert.equal(
      facet.count,
      expected[key],
      `bộ đếm bộ lọc "${facet.label}" (${facet.count}) phải bằng số dòng có cột tồn tương ứng trong chính bảng (${expected[key]}) — hai đường tính tồn đang khác nhau`,
    );
  }

  console.log(
    `✓ Lớp tăng tốc không đổi số liệu: ${compared} mẫu mã khớp từng cột với cách tính nguyên thuỷ · Báo cáo lợi nhuận khớp · đệm không đổi kết quả · bộ đếm tồn kho khớp cột tồn (${expected.out} hết hàng · ${expected.low} sắp hết)`,
  );
}
