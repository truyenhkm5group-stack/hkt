import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { type Db, schema } from "@/db";
import { assessCustomerRisk } from "@/lib/alerts/risk";
import { noCodPaymentState } from "@/lib/constants/no-cod-payment";
import { customerFacets, customerSummary, getCustomerDetail, listCustomers } from "@/lib/queries/customers";
import { parseListParams } from "@/lib/search-params";

/**
 * ═══════════ HỒ SƠ KHÁCH: SỐ GIAO THÀNH CÔNG CHỈ ĐI MỘT ĐƯỜNG ═══════════
 *
 * Khoá bốn điều (AGENTS §0.1–§0.3 · §3.1 · mục 42):
 *  1. Bộ đếm Pancake (`succeed_order_count`) KHÔNG nâng được số giao thành công của ERP — bản trước
 *     lấy `Math.max(Pancake, ORDER_OUTCOME)`. Số Pancake vẫn trả ra, nhưng ở ô `pancake` riêng.
 *  2. Tỷ lệ đặt trên đơn ĐÃ KẾT THÚC: đơn đang giao / chưa gửi không vào mẫu số, đếm riêng.
 *  3. Chưa đơn nào kết thúc ⇒ tỷ lệ `null` (in «—»), không phải 0%; chưa có đơn ⇒ AOV `null`.
 *  4. Đơn không còn COD mà không có chứng từ tiền ⇒ CHƯA XÁC MINH, không phải "đã thanh toán".
 * Cộng thêm: cảnh báo khách rủi ro chấm lịch sử ERP và bộ đếm Pancake RIÊNG, lý do mang nhãn nguồn;
 * DANH SÁCH khách (`listCustomers` · `customerFacets` · `customerSummary`) ra ĐÚNG số của trang chi tiết —
 * nhóm khách, sắp xếp, tỷ lệ hoàn đầu trang đều theo ERP, không `greatest()` với bộ đếm Pancake.
 *
 * Mốc thời gian cố định, không "N giờ trước" (AGENTS mục 50) — truy vấn hồ sơ khách không lọc theo kỳ.
 */

const P = "cot-";
const T0 = new Date("2016-06-10T03:00:00Z");

export function testCustomerOutcomeTruthPure() {
  const cfg = { riskMinReturned: 2, riskReturnRatePct: 40 };

  // Pancake ghi 50 đơn "thành công", ERP (ORDER_OUTCOME) chỉ chứng minh được 1 giao + 3 hoàn.
  const mixed = assessCustomerRisk({ succeed: 50, returned: 0, isBlock: false, erpDelivered: 1, erpReturned: 3 }, cfg);
  assert.equal(mixed.succeed, 1, "giao thành công là số của ERP — bộ đếm Pancake 50 KHÔNG được nâng nó lên");
  assert.equal(mixed.returned, 3);
  assert.equal(mixed.rate, 0.75);
  assert.equal(mixed.pancake.succeed, 50, "số Pancake vẫn đọc được, ở ô riêng");
  assert.ok(mixed.risky && mixed.reasons.some((r) => r.startsWith("lịch sử ERP hoàn 3/4")), "lịch sử ERP hoàn 3/4 ⇒ rủi ro, lý do mang nhãn ERP");
  assert.equal(mixed.severity, "critical", "ERP hoàn 75% ⇒ nghiêm trọng");

  // Chỉ có bộ đếm Pancake: vẫn là tín hiệu cảnh giác, nhưng ERP không có đơn nào kết thúc ⇒ tỷ lệ ERP là CHƯA BIẾT.
  const pancakeOnly = assessCustomerRisk({ succeed: 6, returned: 44, isBlock: false }, cfg);
  assert.equal(pancakeOnly.rate, null, "ERP chưa đơn nào kết thúc ⇒ tỷ lệ null, không phải 0");
  assert.equal(pancakeOnly.succeed, 0);
  assert.ok(pancakeOnly.risky && pancakeOnly.reasons.some((r) => r.startsWith("Pancake ghi nhận hoàn 44/50")), "lý do từ bộ đếm Pancake mang nhãn Pancake");

  // Hai nguồn chấm RIÊNG: ERP 5 giao / 1 hoàn (17%) không thành "rủi ro" chỉ vì Pancake cộng thêm số hoàn của nó.
  const separate = assessCustomerRisk({ succeed: 0, returned: 1, isBlock: false, erpDelivered: 5, erpReturned: 1 }, cfg);
  assert.equal(separate.risky, false, "không trộn tử số của nguồn này với mẫu số của nguồn kia");

  assert.equal(noCodPaymentState({ moneyToCollect: 300_000, prepaid: 0, transferMoney: 0 }), null, "còn COD ⇒ câu hỏi không đặt ra");
  assert.deepEqual(noCodPaymentState({ moneyToCollect: 0, prepaid: 0, transferMoney: 0 }), { kind: "UNVERIFIED" }, "money_to_collect = 0 KHÔNG phải chứng từ tiền");
  assert.deepEqual(noCodPaymentState({ moneyToCollect: 0, prepaid: 200_000, transferMoney: 150_000 }), { kind: "PREPAID", amount: 350_000 }, "trả trước / chuyển khoản là bằng chứng đã khai");
  console.log("✓ Hồ sơ khách (thuần): rủi ro chấm ERP và Pancake riêng, lý do mang nhãn nguồn · không COD mà không chứng từ ⇒ chưa xác minh");
}

const CUSTOMERS = ["mix", "fresh", "empty"].map((x) => `${P}${x}`);
const ORDERS = ["mix-del", "mix-transit", "mix-new", "mix-cancel", "fresh-transit"].map((x) => `${P}${x}`);

async function cleanup(db: Db) {
  await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, ORDERS));
  await db.delete(schema.orders).where(inArray(schema.orders.id, ORDERS));
  await db.delete(schema.customers).where(inArray(schema.customers.id, CUSTOMERS));
}

export async function testCustomerOutcomeTruthDb(db: Db) {
  await cleanup(db);
  const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);
  await db.insert(schema.customers).values([
    // Pancake nói 40 thành công / 50 đơn / 99 triệu — ERP chỉ có 4 đơn và chứng minh được ĐÚNG MỘT lần giao.
    { id: `${P}mix`, name: "Khách kiểm hồ sơ", phone: "0987600001", orderCount: 50, succeedOrderCount: 40, returnedOrderCount: 0, purchasedAmount: 99_000_000 },
    { id: `${P}fresh`, name: "Khách mới đặt", phone: "0987600002", orderCount: 3, succeedOrderCount: 3, returnedOrderCount: 5 },
    { id: `${P}empty`, name: "Khách chưa đơn", phone: "0987600003", orderCount: 7, succeedOrderCount: 7, purchasedAmount: 5_000_000 },
  ]);
  const order = (id: string, customerId: string, stage: string, extra: Partial<typeof schema.orders.$inferInsert> = {}) => ({
    id: `${P}${id}`,
    customerId: `${P}${customerId}`,
    stage: stage as never,
    insertedAt: at(ORDERS.indexOf(`${P}${id}`)),
    totalPriceAfterDiscount: 400_000,
    moneyToCollect: 400_000,
    cod: 400_000,
    source: "Facebook",
    ...extra,
  });
  await db.insert(schema.orders).values([
    order("mix-del", "mix", "DELIVERED"),
    order("mix-transit", "mix", "SHIPPED"),
    // Pancake để 0 phải thu, không có trả trước / chuyển khoản ⇒ không có chứng từ tiền nào.
    order("mix-new", "mix", "CONFIRMED", { moneyToCollect: 0, cod: 0 }),
    order("mix-cancel", "mix", "CANCELLED"),
    order("fresh-transit", "fresh", "SHIPPED"),
  ]);
  await db.insert(schema.shipments).values([
    { orderId: `${P}mix-del`, vtpOrderNumber: "COT-DEL", stage: "DELIVERED" as never, pickedUpAt: at(1), codAmount: 400_000, codCollected: 400_000 },
    { orderId: `${P}mix-transit`, vtpOrderNumber: "COT-TRANSIT", stage: "IN_TRANSIT" as never, pickedUpAt: at(2), codAmount: 400_000 },
    { orderId: `${P}fresh-transit`, vtpOrderNumber: "COT-FRESH", stage: "IN_TRANSIT" as never, pickedUpAt: at(3), codAmount: 400_000 },
  ]);

  try {
    const mix = await getCustomerDetail(`${P}mix`);
    assert.ok(mix);
    assert.equal(mix.stats.succeed, 1, "giao thành công = ORDER_OUTCOME (1), KHÔNG phải bộ đếm Pancake (40)");
    assert.equal(mix.stats.returned, 0);
    assert.equal(mix.stats.finished, 1);
    assert.equal(mix.stats.inTransit, 1, "đơn đang giao đếm riêng");
    assert.equal(mix.stats.open, 2, "đang giao + chưa gửi = chưa kết thúc");
    assert.equal(mix.stats.successRate, 100, "mẫu số là đơn ĐÃ KẾT THÚC — đơn đang giao / chưa gửi không kéo tỷ lệ xuống");
    assert.equal(mix.stats.returnRate, 0, "có đơn kết thúc mà không hoàn ⇒ 0% THẬT");
    assert.equal(mix.stats.orders, 3, "số đơn của ERP (không huỷ), không lấy max với Pancake (50)");
    assert.equal(mix.stats.amount, 1_200_000, "tổng mua của ERP, không lấy max với Pancake (99 triệu)");
    assert.equal(mix.stats.aov, 400_000);
    assert.deepEqual(mix.stats.pancake, { orders: 50, succeed: 40, returned: 0, amount: 99_000_000 }, "bộ đếm Pancake vẫn đọc được, ở ô tham khảo riêng");
    const noCod = mix.orders.find((x) => x.id === `${P}mix-new`);
    assert.deepEqual(noCod?.noCodPayment, { kind: "UNVERIFIED" }, "0 phải thu mà không chứng từ ⇒ chưa xác minh, không phải đã thanh toán");
    assert.equal(mix.orders.find((x) => x.id === `${P}mix-del`)?.noCodPayment, null, "đơn còn COD ⇒ không hỏi");

    const fresh = await getCustomerDetail(`${P}fresh`);
    assert.ok(fresh);
    assert.equal(fresh.stats.succeed, 0, "Pancake ghi 3 thành công, ERP chưa có đơn nào kết thúc");
    assert.equal(fresh.stats.successRate, null, "chưa đơn nào kết thúc ⇒ tỷ lệ CHƯA BIẾT (null), không phải 0%");
    assert.equal(fresh.stats.returnRate, null);
    assert.equal(fresh.stats.inTransit, 1);

    const empty = await getCustomerDetail(`${P}empty`);
    assert.ok(empty);
    assert.equal(empty.stats.orders, 0);
    assert.equal(empty.stats.aov, null, "chưa có đơn ⇒ trung bình mỗi đơn là CHƯA BIẾT, không phải 0 ₫");
    assert.equal(empty.stats.succeed, 0, "Pancake ghi 7 thành công nhưng ERP không có đơn nào ⇒ 0 đơn ERP");

    // ── DANH SÁCH: cùng khách, cùng số với trang chi tiết; lọc / sắp xếp / tổng đầu trang theo ERP ──
    const q = "098760000"; // chung tiền tố SĐT của đúng ba khách kiểm
    const list = await listCustomers(parseListParams({ q, sort: "orderCount", dir: "desc" }, { defaultPeriod: "all", sortable: ["orderCount", "purchasedAmount", "lastOrderAt", "name", "insertedAt"], filterKeys: ["province", "tier"] }));
    assert.deepEqual(list.rows.map((r) => r.id), [`${P}mix`, `${P}fresh`, `${P}empty`], "sắp xếp theo số đơn ERP (3 · 1 · 0), không theo Pancake (50 · 3 · 7)");
    const row = list.rows[0];
    assert.equal(row.succeedOrderCount, mix.stats.succeed, "danh sách = trang chi tiết: thành công");
    assert.equal(row.succeedOrderCount, 1, "Pancake 40 ⇒ danh sách in ERP 1");
    assert.equal(row.returnedOrderCount, mix.stats.returned);
    assert.equal(row.orderCount, mix.stats.orders, "danh sách = trang chi tiết: số đơn");
    assert.equal(row.purchasedAmount, mix.stats.amount, "danh sách = trang chi tiết: tổng mua");
    assert.equal(list.rows[1].returnedOrderCount, 0, "Pancake ghi 5 hoàn cho khách mới — ERP chưa có đơn hoàn nào");

    const facetParams = parseListParams({ q }, { defaultPeriod: "all", filterKeys: ["province", "tier"] });
    const facets = await customerFacets(facetParams);
    const tier = (k: string) => facets.tiers.find((t) => t.value === k)?.count;
    assert.equal(tier("repeat"), 1, "nhóm «Mua ≥3 lần» theo đơn ERP — Pancake (50 · 3 · 7) sẽ ra 3");
    assert.equal(tier("once"), 1);
    assert.equal(tier("none"), 1, "khách Pancake ghi 7 đơn mà ERP không có đơn nào ⇒ «Chưa có đơn»");
    assert.equal(tier("returned"), 0, "nhóm «Có đơn hoàn» theo ORDER_OUTCOME — bộ đếm hoàn Pancake không đẩy khách vào nhóm");
    const onlyNone = await listCustomers(parseListParams({ q, tier: "none" }, { defaultPeriod: "all", filterKeys: ["province", "tier"] }));
    assert.deepEqual(onlyNone.rows.map((r) => r.id), [`${P}empty`], "lọc nhóm dùng cùng biểu thức với ô đếm");

    const summary = await customerSummary(facetParams);
    assert.equal(summary.total, 3);
    assert.equal(summary.orders, 4, "đơn ERP không huỷ: 3 + 1 + 0");
    assert.equal(summary.finished, 1, "mẫu số tỷ lệ hoàn đầu trang = đơn đã kết thúc");
    assert.equal(summary.returned, 0);
    assert.equal(summary.amount, 1_600_000, "tổng mua ERP, không lấy max với Pancake (99 triệu)");
    assert.equal(summary.withOrders, 2);
  } finally {
    await cleanup(db);
  }
  console.log("✓ Hồ sơ khách (CSDL): giao thành công chỉ theo ORDER_OUTCOME (Pancake 40 ⇒ ERP 1) · tỷ lệ trên đơn đã kết thúc · đang giao đếm riêng · chưa kết thúc ⇒ tỷ lệ «—» · không chứng từ ⇒ chưa xác minh · danh sách / nhóm khách / tổng đầu trang ra đúng số trang chi tiết");
}
