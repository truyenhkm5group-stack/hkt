import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import {
  activePlannedEntry,
  appendPlannedCosts,
  COST_BASIS_LABEL,
  ESTIMATED_COST_KEY,
  estimatedCostsWithMarketerPrice,
  parseCostMode,
  parseEstimatedCosts,
  parsePlannedCostHistory,
  plannedCostImpact,
  previewImpactForItem,
  serializePlannedEntry,
  vnDateKey,
  type PlannedCostEntry,
} from "@/lib/constants/estimated-cost";

/**
 * ═══════════ P0 HỢP NHẤT GIÁ VỐN — TRUNG TÂM GIÁ VỐN + HAI CHẾ ĐỘ BCLN ═══════════
 *
 * Chủ shop báo 13/10/2026: sửa giá vốn giả định trên Báo cáo lợi nhuận mà con số không đổi. Gốc: giá
 * dự tính chỉ lấp sản phẩm CHƯA có giá thật (Q004 có phiếu kho 185.000 ⇒ giá sửa bị bỏ qua), và giá báo
 * MKT (160.000) lại THẮNG con số đặt tay. Bài này khoá tám kịch bản nghiệm thu chủ shop nêu (mục 7 của
 * yêu cầu) trên CSDL thử, cộng luật thuần của lịch sử giá kế hoạch (`docs/cost-center.md`).
 */

const P = "gvtt-";
const gio = (h: number) => new Date(Date.now() - h * 3600_000);

function e(unitCost: number | null, effectiveFrom: string | null, setAt: string): PlannedCostEntry {
  return { unitCost, effectiveFrom, reason: "kiểm", setAt, setBy: "kiem@thu", setByUserId: null };
}

function testPure() {
  // Dáng cũ (một dòng, không ngày) đọc như hiệu lực TỪ ĐẦU — không cần migration, không backfill.
  const cu = parsePlannedCostHistory({ a: { unitCost: 150_000, reason: "x", setAt: "2026-09-01T00:00:00Z", setBy: "chu" } });
  assert.equal(cu.a.length, 1);
  assert.equal(cu.a[0].effectiveFrom, null);
  assert.equal(parseEstimatedCosts({ a: { unitCost: 150_000 } }).a.unitCost, 150_000, "bản lưu cũ vẫn đọc ra đúng giá");

  // Ngày hiệu lực: dòng có ngày SAU thời điểm xem không áp; ngày muộn nhất ≤ thời điểm thắng.
  const h = [e(100_000, null, "2026-09-01T00:00:00Z"), e(120_000, "2026-10-01", "2026-09-20T00:00:00Z"), e(130_000, "2026-11-01", "2026-09-21T00:00:00Z")];
  assert.equal(activePlannedEntry(h, new Date("2026-09-15T12:00:00+07:00"))?.unitCost, 100_000);
  assert.equal(activePlannedEntry(h, new Date("2026-10-13T12:00:00+07:00"))?.unitCost, 120_000);
  assert.equal(activePlannedEntry(h, new Date("2026-11-01T00:00:00+07:00"))?.unitCost, 130_000, "ngày hiệu lực tính theo giờ VN: 00:00 VN ngày 01/11 đã áp");
  assert.equal(vnDateKey(new Date("2026-10-31T17:30:00Z")), "2026-11-01", "17:30Z = 00:30 VN hôm sau");
  // Hoà ngày hiệu lực ⇒ dòng ghi sau thắng: MỖI MÃ ĐÚNG MỘT DÒNG HIỆU LỰC.
  const hoa = [e(140_000, "2026-10-01", "2026-10-02T00:00:00Z"), e(145_000, "2026-10-01", "2026-10-03T00:00:00Z")];
  assert.equal(activePlannedEntry(hoa, new Date("2026-10-13T00:00:00Z"))?.unitCost, 145_000);
  // "Bỏ giá" là một DÒNG, không xoá lịch sử.
  const bo = [...h, e(null, "2026-10-10", "2026-10-10T00:00:00Z")];
  assert.equal(activePlannedEntry(bo, new Date("2026-10-13T00:00:00Z")), null, "đã bỏ giá ⇒ không có giá kế hoạch");
  assert.equal(activePlannedEntry(bo, new Date("2026-10-05T00:00:00Z"))?.unitCost, 120_000, "trước ngày bỏ ⇒ giá cũ vẫn áp cho kỳ cũ");
  // Dòng hỏng KHÔNG thành lệnh bỏ giá và KHÔNG thành 0 ₫.
  assert.deepEqual(parsePlannedCostHistory({ a: { history: [{ unitCost: 0 }, { unitCost: "x" }, { cleared: "yes" }] } }), {});

  // Ghi THÊM, không bao giờ xoá; mã dáng cũ chuyển sang dáng lịch sử với dòng cũ đứng đầu.
  const la = { la: "dòng đời sau, bản này chưa hiểu" };
  const sau = appendPlannedCosts({ a: { unitCost: 150_000, setAt: "2026-09-01T00:00:00Z" }, b: { history: [serializePlannedEntry(e(90_000, null, "2026-09-02T00:00:00Z")), la] } }, { a: e(160_000, "2026-10-13", "2026-10-13T01:00:00Z"), b: e(95_000, null, "2026-10-13T01:00:00Z"), c: e(null, null, "2026-10-13T01:00:00Z") });
  const doc = parsePlannedCostHistory(JSON.parse(JSON.stringify(sau)));
  assert.equal(doc.a.length, 2);
  assert.equal(doc.a[0].unitCost, 150_000, "dòng dáng cũ đứng đầu lịch sử");
  assert.deepEqual((sau.b as { history: unknown[] }).history[1], la, "dòng đọc không hiểu được GIỮ NGUYÊN VĂN khi ghi thêm — không mất dữ liệu");
  assert.equal(doc.b.length, 2);
  assert.equal(doc.c[0].unitCost, null, "dòng bỏ giá đi qua lưu / đọc vẫn là dòng bỏ giá");

  // LUẬT 5': giá kế hoạch THẮNG giá báo MKT; giá báo chỉ là tham chiếu lùi cho mã chưa đặt.
  const ngay = (s: string) => new Date(`${s}T00:00:00+07:00`);
  const m = estimatedCostsWithMarketerPrice({ Q004: { unitCost: 150_000, reason: "test", setAt: null, setBy: null } }, { Q004: [{ price: 160_000, effectiveFrom: ngay("2026-09-01"), reason: "", setBy: "mkt" }], Q002: [{ price: 150_000, effectiveFrom: ngay("2026-09-01"), reason: "", setBy: "mkt" }] }, ngay("2026-10-13"));
  assert.equal(m.Q004.unitCost, 150_000, "giá báo MKT 160.000 KHÔNG đè giá kế hoạch 150.000");
  assert.equal(m.Q004.source, "MANUAL");
  assert.equal(m.Q002.source, "MARKETER_PRICE", "mã chưa đặt kế hoạch ⇒ tham chiếu giá báo, có nhãn nguồn");

  // Xem trước tác động: đúng phép trừ, Δ ròng gồm dự phòng rủi ro tồn kho; đích chưa biết ⇒ null.
  const imp = plannedCostImpact({ productId: "x", expectedQty: 10, currentCogs: 1_600_000, currentKnown: true, actualCogs: 1_850_000, actualKnown: true }, 150_000, { inventoryRiskPercent: 5, applies: true });
  assert.equal(imp.deltaCogs, -100_000);
  assert.equal(imp.deltaNominalProfit, 100_000);
  assert.equal(imp.deltaNetProfit, 105_000);
  assert.equal(plannedCostImpact({ productId: "x", expectedQty: 10, currentCogs: 1_600_000, currentKnown: true, actualCogs: 0, actualKnown: false }, null, { inventoryRiskPercent: 5, applies: true }).deltaCogs, null, "bỏ giá mà mã chưa có giá thật ⇒ CHƯA BIẾT, không phải 0");
  assert.equal(plannedCostImpact({ productId: "x", expectedQty: 10, currentCogs: 1_600_000, currentKnown: true, actualCogs: 0, actualKnown: true }, 150_000, { inventoryRiskPercent: 5, applies: false }).deltaCogs, 0, "hiệu lực sau cuối kỳ ⇒ kỳ đó không đổi");

  // Phép chọn đích của bản xem trước (hàm thuần dùng ở action).
  const at = new Date("2026-10-31T12:00:00+07:00");
  const dangAp = [e(150_000, "2026-10-20", "2026-10-20T00:00:00Z")];
  const kh = { expectedQty: 10, expectedCogs: 1_500_000, cogsKnown: true };
  const som = previewImpactForItem({ productId: "x", before: dangAp, after: [...dangAp, e(120_000, "2026-10-10", "2026-10-21T00:00:00Z")], at, planned: kh, actual: { expectedCogs: 1_850_000, cogsKnown: true, cogsUnknownQty: 0 }, inventoryRiskPercent: 0 });
  assert.equal(som.applies, false, "dòng hiệu lực SỚM hơn dòng đang áp ⇒ BCLN không đổi ⇒ xem trước Δ 0");
  assert.equal(som.deltaCogs, 0);
  const boThieu = previewImpactForItem({ productId: "x", before: dangAp, after: [...dangAp, e(null, null, "2026-10-22T00:00:00Z"), e(null, "2026-10-25", "2026-10-22T00:00:01Z")], at, planned: kh, actual: { expectedCogs: 600_000, cogsKnown: true, cogsUnknownQty: 4 }, inventoryRiskPercent: 0 });
  assert.equal(boThieu.deltaCogs, null, "bỏ giá ở mã còn sản phẩm chưa có giá thật ⇒ Δ CHƯA BIẾT");
  const boDu = previewImpactForItem({ productId: "x", before: dangAp, after: [...dangAp, e(null, "2026-10-25", "2026-10-22T00:00:00Z")], at, planned: kh, actual: { expectedCogs: 1_850_000, cogsKnown: true, cogsUnknownQty: 0 }, inventoryRiskPercent: 0 });
  assert.equal(boDu.deltaCogs, 350_000, "bỏ giá ở mã đủ giá thật ⇒ đích = giá thật");

  assert.equal(parseCostMode("kehoach"), "PLANNED");
  assert.equal(parseCostMode(""), "ACTUAL", "mặc định THỰC TẾ — mở trang không con số nào xê dịch");
  assert.equal(parseCostMode("PLANNED"), "ACTUAL", "chỉ đúng một giá trị URL bật chế độ kế hoạch");
  assert.ok(COST_BASIS_LABEL.PROVISIONAL === "Tạm tính" && COST_BASIS_LABEL.PLANNED === "Kế hoạch" && COST_BASIS_LABEL.ACTUAL === "Thực tế");
}

/** Phạm vi ghi: giá kế hoạch chỉ có MỘT đường ghi, và phiếu nhập / giá báo MKT không ghi vào nó. */
function testSourceScan() {
  const doc = (p: string) => readFileSync(p, "utf8");
  assert.ok(!/ESTIMATED_COST_KEY|profit\.estimatedCosts/.test(doc("lib/actions/stock.ts")), "phiếu nhập kho KHÔNG ghi giá kế hoạch (test 4)");
  assert.ok(!/ESTIMATED_COST_KEY|profit\.estimatedCosts/.test(doc("lib/actions/marketer-price.ts")), "giá báo MKT KHÔNG ghi giá kế hoạch (test 5)");
  const action = doc("lib/actions/estimated-cost.ts");
  assert.ok(action.includes("clearMemo()"), "lưu giá kế hoạch phải xoá bộ đệm báo cáo — người vừa lưu thấy NGAY con số mới");
  for (const p of ["/reports", "/inventory/cost-center"]) assert.ok(action.includes(`"${p}"`), `lưu giá kế hoạch phải làm mới ${p}`);
  assert.ok(/\.for\("update"\)/.test(action), "đọc–sửa–ghi giá kế hoạch phải khoá dòng settings — hai người lưu cùng lúc không xoá lịch sử của nhau");
  assert.ok(/can\(user, "reports:nominal"\)/.test(action) && /requireResource\("REPORTS"/.test(action), "xem trước tác động trả số lợi nhuận ⇒ đòi quyền XEM + phạm vi như màn hình");
  assert.ok(doc("app/(dashboard)/reports/estimated-cost-control.tsx").includes("setEstimatedCost"), "nút bút BCLN đi qua đúng action");
  const report = doc("lib/queries/profit-nominal.ts");
  assert.ok(/\$\{mode\}`, 120000/.test(report), "chế độ giá vốn phải nằm trong khoá cache (AGENTS.md §2)");
  assert.ok(/:\$\{costMode\}`, 120_000/.test(doc("lib/queries/marketer-daily-nominal.ts")), "bảng theo ngày: chế độ giá vốn trong khoá cache");
}

async function motDon(db: Db, id: string, variantId: string, productId: string, giao: boolean, luc: Date) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 499_000 }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}i-${id}`, orderId: `${P}o-${id}`, variantId, productId, sku: variantId, productName: "Hàng kiểm trung tâm giá vốn", variationDetail: "M", quantity: 1, lineTotal: 499_000, unitCost: 0, isBonus: false }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({ id: `${P}s-${id}`, orderId: `${P}o-${id}`, carrier: "Viettel Post", vtpOrderNumber: `${P}${id}`.toUpperCase(), vtpStatus: giao ? 501 : 504, vtpStatusName: giao ? "Giao thành công" : "Chuyển hoàn", stage: giao ? "DELIVERED" : "RETURNED", isFinal: true, codAmount: 499_000, codCollected: giao ? 499_000 : 0, pickedUpAt: luc, deliveredAt: giao ? luc : null })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s-${id}`, source: "VTP_WEBHOOK", status: giao ? "501" : "504", statusName: giao ? "Giao thành công" : "Chuyển hoàn", legType: "OUTBOUND", occurredAt: luc }).onConflictDoNothing();
}

async function datKeHoach(db: Db, history: Record<string, PlannedCostEntry[]>) {
  const value = Object.fromEntries(Object.entries(history).map(([k, v]) => [k, { history: v.map(serializePlannedEntry) }]));
  await db.insert(schema.settings).values({ key: ESTIMATED_COST_KEY, value: JSON.stringify(value) }).onConflictDoUpdate({ target: schema.settings.key, set: { value: sql`excluded.value` } });
  clearMemo(); // đúng việc `setPlannedCosts` làm sau khi ghi
}

export async function testCostCenter(db: Db) {
  testPure();
  testSourceScan();

  const PID = `${P}q004`;
  const VID = `${P}q004-m`;
  const luc = gio(72);
  await db.insert(schema.products).values({ id: PID, name: "Đầm kiểm Q004", customId: "GVTT-Q004" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: VID, productId: PID, sku: "GVTT-Q004-M", retailPrice: 499_000 }).onConflictDoNothing();
  const [phieu1] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: gio(24 * 20), reference: `${P}lo1`, totalQuantity: 50, totalCost: 50 * 185_000, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieu1.id, variantId: VID, quantity: 50, unitCost: 185_000 });
  // Giá báo MKT 160.000 — đúng dáng Q004 chủ shop báo.
  await db.insert(schema.marketerPrices).values({ productId: PID, productCode: "GVTT-Q004", price: 160_000, effectiveFrom: gio(24 * 60), reason: "kiểm", setBy: "mkt@kiem" });
  for (let i = 0; i < 12; i += 1) await motDon(db, `d${i}`, VID, PID, i % 3 !== 2, luc);

  const ky = { key: "30d", from: gio(24 * 30), to: new Date(), label: "30 ngày", fromKey: null, toKey: null } as never;
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const { getNominalDaily } = await import("@/lib/queries/marketer-daily-nominal");
  const { getCostCenter } = await import("@/lib/queries/cost-center");
  const lay = async (mode: "ACTUAL" | "PLANNED") => (await getNominalProfitReport(ky, "ORDERED", undefined, true, true, false, mode)).rows.find((r) => r.productId === PID)!;

  try {
    clearMemo();
    // Trước khi đặt kế hoạch: chế độ kế hoạch đứng trên giá THẬT và nói ra là chưa đặt.
    const tt0 = await lay("ACTUAL");
    assert.ok(tt0 && tt0.expectedQty > 0, "fixture Q004 phải có SL giao TC ước tính");
    // Chủ shop chốt 13/10/2026: giá vốn THỰC TẾ = giá báo MKT đang hiệu lực hôm nay (160.000), không phải phiếu 185.000.
    assert.equal(tt0.expectedCogs, Math.round(tt0.expectedQty * 160_000), "chế độ thực tế = giá báo MKT hiện tại 160.000 (luật 13 mới)");
    assert.equal(tt0.costBasis, "ACTUAL");
    const kh0 = await lay("PLANNED");
    assert.equal(kh0.costBasis, "ACTUAL_NO_PLAN", "chưa đặt giá kế hoạch ⇒ nhãn nói ra, không lặng lẽ dùng giá báo");
    assert.equal(kh0.expectedCogs, tt0.expectedCogs);

    // TEST 1 — sửa giá kế hoạch Q004 160.000 → 150.000: BCLN chế độ kế hoạch tính lại CHÍNH XÁC.
    await datKeHoach(db, { [PID]: [e(160_000, null, new Date(Date.now() - 60_000).toISOString())] });
    const kh1 = await lay("PLANNED");
    assert.equal(kh1.costBasis, "PLANNED");
    assert.equal(kh1.expectedCogs, Math.round(kh1.expectedQty * 160_000));
    await datKeHoach(db, { [PID]: [e(160_000, null, new Date(Date.now() - 60_000).toISOString()), e(150_000, null, new Date().toISOString())] });
    const kh2 = await lay("PLANNED");
    assert.equal(kh2.expectedCogs, Math.round(kh2.expectedQty * 150_000), "giá kế hoạch MỚI áp ngay — đây là lỗi P0 (bản cũ giữ nguyên 185.000)");
    assert.equal(kh2.expectedProfit - kh1.expectedProfit, kh1.expectedCogs - kh2.expectedCogs, "chênh lợi nhuận = đúng chênh giá vốn");
    assert.equal(kh2.estimatedCost?.source, "MANUAL", "test 5: giá báo MKT 160.000 không đè giá kế hoạch 150.000");
    assert.equal(kh2.cogsKnown, true);
    assert.equal(kh2.expectedCogsEstimated, kh2.expectedCogs, "toàn bộ giá vốn là số kế hoạch ⇒ không bao giờ gọi là giá thật");

    // TEST 2 — chế độ thực tế KHÔNG bị giá kế hoạch ghi đè (mã có phiếu kho).
    const tt2 = await lay("ACTUAL");
    assert.equal(tt2.expectedCogs, Math.round(tt2.expectedQty * 160_000), "thực tế = giá báo hiện tại, không bị giá kế hoạch 150.000 ghi đè");
    assert.equal(tt2.costBasis, "ACTUAL");
    assert.equal(tt2.plannedCost?.unitCost, 150_000, "ô bút ở chế độ thực tế vẫn mở đúng giá kế hoạch đang lưu");

    // TEST 3 + 6 — Trung tâm giá vốn hiện CÙNG con số; đổi chế độ / gọi lại không lẫn bộ đệm.
    const cc = (await getCostCenter(ky)).find((r) => r.productId === PID)!;
    assert.equal(cc.planned?.unitCost, 150_000);
    assert.equal(cc.history.length, 2, "lịch sử giữ cả hai lần sửa");
    assert.equal(cc.appliedPlanned?.unit, 150_000, "giá đang áp dụng (kế hoạch) = đúng con số BCLN dùng");
    assert.equal(cc.appliedActual?.unit, 160_000, "đang áp dụng (thực tế) = giá báo MKT hiện tại");
    assert.equal(cc.receipt?.unitCost, 185_000);
    assert.equal(cc.marketerPrice, 160_000, "giá báo MKT hiện tại");
    assert.equal(cc.planVsReceipt, -35_000);
    assert.equal((await lay("ACTUAL")).expectedCogs, tt2.expectedCogs, "bộ đệm không phục vụ số kế hoạch cho chế độ thực tế");

    // Bảng theo ngày (chia số của bảng theo mã) đứng trên CÙNG chế độ.
    const ngay = await getNominalDaily(ky, "ORDERED", { productId: PID, marketerKey: null }, false, "PLANNED");
    assert.equal(ngay.total.expectedCogs, kh2.expectedCogs, "test 7: theo ngày cộng lại = theo mã (chế độ kế hoạch)");

    // TEST 8 — đường gọi mặc định (lương, AI) không thấy giá kế hoạch, kể cả khi xin chế độ kế hoạch.
    const luong = (await getNominalProfitReport(ky, "ORDERED", undefined, true, false, false, "PLANNED")).rows.find((r) => r.productId === PID)!;
    assert.equal(luong.expectedCogs, tt2.expectedCogs, "không bật giá kế hoạch ⇒ chế độ bị ép về thực tế");

    // Ngày hiệu lực SAU cuối kỳ ⇒ không áp cho kỳ đó.
    await datKeHoach(db, { [PID]: [e(150_000, null, new Date(Date.now() - 60_000).toISOString()), e(100_000, vnDateKey(new Date(Date.now() + 5 * 86_400_000)), new Date().toISOString())] });
    assert.equal((await lay("PLANNED")).expectedCogs, kh2.expectedCogs, "giá có hiệu lực tương lai không đổi kỳ hiện tại");

    // TEST 4 — nhập một lô MỚI 190.000: giá thực tế đi theo phiếu mới, giá kế hoạch giữ nguyên.
    const [phieu2] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: gio(1), reference: `${P}lo2`, totalQuantity: 20, totalCost: 20 * 190_000, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values({ receiptId: phieu2.id, variantId: VID, quantity: 20, unitCost: 190_000 });
    clearMemo();
    const tt4 = await lay("ACTUAL");
    assert.equal(tt4.expectedCogs, Math.round(tt4.expectedQty * 160_000), "mã có giá báo: lô nhập mới KHÔNG đổi giá vốn thực tế (giá báo hiện tại đứng đầu)");
    assert.equal((await lay("PLANNED")).expectedCogs, kh2.expectedCogs, "phiếu nhập KHÔNG ghi đè giá kế hoạch");
    // ─── LUẬT 13 MỚI (13/10/2026): giá báo HIỆN TẠI là giá vốn, không đóng băng ───
    const { rematerializeProductOrders: dungLai } = await import("@/lib/queries/canonical-outcome");
    const ghiNhan = async () =>
      (await db.select({ basis: schema.canonicalOrderOutcome.cogsBasis, cogs: schema.canonicalOrderOutcome.recognizedCogs }).from(schema.canonicalOrderOutcome).where(eq(schema.canonicalOrderOutcome.orderId, `${P}o-d0`)))[0];
    await dungLai(PID);
    clearMemo();
    assert.deepEqual(await ghiNhan(), { basis: "MARKETER_PRICE", cogs: 160_000 }, "đơn đã giao, mọi dòng có giá báo ⇒ căn cứ MARKETER_PRICE, giá vốn ghi nhận = giá báo hiện tại");
    /*
      CHỨNG MINH cho sổ `MIGRATION_SERVE_COMPAT` mục 0246: trên LƯỢC ĐỒ CŨ (CHECK chưa nhận MARKETER_PRICE — đúng trạng thái
      NGAY TRƯỚC 0246) lượt dựng lại KHÔNG nổ, căn cứ lùi về bậc thang chứng từ kho; trả ràng buộc về bản 0246 thì luật mới áp lại.
    */
    const CHECK_CU = `check ("cogs_basis" is null or "cogs_basis" in ('RECEIPT_BEFORE', 'RECEIPT_AFTER', 'PROVISIONAL', 'NONE')) not valid`;
    const CHECK_MOI = `check ("cogs_basis" is null or "cogs_basis" in ('MARKETER_PRICE', 'RECEIPT_BEFORE', 'RECEIPT_AFTER', 'PROVISIONAL', 'NONE')) not valid`;
    const datCheck = async (dinhNghia: string) => {
      await db.execute(sql.raw(`alter table "canonical_order_outcome" drop constraint if exists "canonical_cogs_basis_check"`));
      await db.execute(sql.raw(`alter table "canonical_order_outcome" add constraint "canonical_cogs_basis_check" ${dinhNghia}`));
    };
    await db.update(schema.canonicalOrderOutcome).set({ cogsBasis: null, recognizedCogs: null }).where(eq(schema.canonicalOrderOutcome.orderId, `${P}o-d0`));
    await datCheck(CHECK_CU);
    try {
      await dungLai(PID);
      assert.equal((await ghiNhan())?.basis, "RECEIPT_BEFORE", "lược đồ cũ ⇒ không ghi MARKETER_PRICE, lùi về chứng từ kho — KHÔNG nổ CHECK");
    } finally {
      await datCheck(CHECK_MOI);
    }
    await dungLai(PID);
    assert.equal((await ghiNhan())?.basis, "MARKETER_PRICE", "có 0246 ⇒ luật giá báo áp lại ở lượt dựng kế tiếp");
    // Đường ghi hàng hoàn huỷ bỏ hỏi CÙNG hàm trước khi ghi căn cứ MARKETER_PRICE (lib/returns/disposition.ts).
    const { constraintAllowsMarketerPrice } = await import("@/lib/queries/current-marketer-cost");
    const RD_CU = `check (("disposition" = 'WRITE_OFF' or ("unit_cost_estimate" is null and "value_estimate" is null and "cost_basis" is null)) and ("value_estimate" is null or "value_estimate" >= 0) and ("cost_basis" is null or "cost_basis" in ('RECEIPT', 'ORDER_SNAPSHOT', 'VARIANT_DEFAULT', 'UNKNOWN'))) not valid`;
    const RD_MOI = RD_CU.replace("('RECEIPT',", "('MARKETER_PRICE', 'RECEIPT',");
    const datRd = async (dn: string) => {
      await db.execute(sql.raw(`alter table "return_dispositions" drop constraint if exists "return_dispositions_value_check"`));
      await db.execute(sql.raw(`alter table "return_dispositions" add constraint "return_dispositions_value_check" ${dn}`));
    };
    assert.equal(await constraintAllowsMarketerPrice(db, "return_dispositions_value_check"), true, "có 0246 ⇒ hàng hoàn được ghi căn cứ giá báo");
    await datRd(RD_CU);
    try {
      assert.equal(await constraintAllowsMarketerPrice(db, "return_dispositions_value_check"), false, "lược đồ cũ ⇒ đường ghi hàng hoàn lùi về bậc cũ");
    } finally {
      await datRd(RD_MOI);
    }

    // MKT hạ giá báo từ nửa giờ trước ⇒ giá vốn MỌI đơn của mã (kể cả đơn đã giao) đi theo — KHÔNG đóng băng.
    await db.insert(schema.marketerPrices).values({ productId: PID, productCode: "GVTT-Q004", price: 170_000, effectiveFrom: gio(0.5), reason: "đổi giá", setBy: "mkt@kiem" });
    // Dòng giá có hiệu lực NGÀY MAI chưa phải giá hiện tại.
    await db.insert(schema.marketerPrices).values({ productId: PID, productCode: "GVTT-Q004", price: 999_000, effectiveFrom: new Date(Date.now() + 86_400_000), reason: "tương lai", setBy: "mkt@kiem" });
    await dungLai(PID);
    clearMemo();
    assert.deepEqual(await ghiNhan(), { basis: "MARKETER_PRICE", cogs: 170_000 }, "giá báo đổi ⇒ giá vốn ghi nhận đổi theo; dòng hiệu lực tương lai chưa áp");
    // ĐƠN HỖN HỢP: một dòng có giá báo + một dòng chỉ có phiếu nhập ⇒ cả đơn vẫn đi theo giá báo (không đóng băng).
    await db.insert(schema.products).values({ id: `${P}mix`, name: "Phụ kiện kiểm", customId: "GVTT-MIX" }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}mix-v`, productId: `${P}mix`, sku: "GVTT-MIX-1", retailPrice: 99_000 }).onConflictDoNothing();
    const [phieuMix] = await db.insert(schema.stockReceipts).values({ kind: "RECEIPT", receivedAt: gio(24 * 20), reference: `${P}mix`, totalQuantity: 10, totalCost: 500_000, createdBy: "test" }).returning({ id: schema.stockReceipts.id });
    await db.insert(schema.stockReceiptItems).values({ receiptId: phieuMix.id, variantId: `${P}mix-v`, quantity: 10, unitCost: 50_000 });
    await db.insert(schema.orderItems).values({ id: `${P}i-d0-mix`, orderId: `${P}o-d0`, variantId: `${P}mix-v`, productId: `${P}mix`, sku: `${P}mix-v`, productName: "Phụ kiện kiểm", variationDetail: "-", quantity: 1, lineTotal: 99_000, unitCost: 0, isBonus: false });
    await dungLai(PID);
    assert.deepEqual(await ghiNhan(), { basis: "MARKETER_PRICE", cogs: 170_000 + 50_000 }, "đơn hỗn hợp: giá báo + phiếu nhập trong cùng con số, căn cứ MARKETER_PRICE");
    await db.update(schema.marketerPrices).set({ price: 165_000 }).where(and(eq(schema.marketerPrices.productId, PID), eq(schema.marketerPrices.price, 170_000)));
    await dungLai(PID);
    assert.deepEqual(await ghiNhan(), { basis: "MARKETER_PRICE", cogs: 165_000 + 50_000 }, "đơn hỗn hợp KHÔNG đóng băng: giá báo đổi ⇒ giá vốn ghi nhận đổi");
    // Dòng thứ hai KHÔNG có nguồn giá nào (không phiếu, không giá Pancake, không giá nhập mẫu) ⇒ cả đơn CHƯA BIẾT,
    // không bao giờ ghi tổng thiếu dòng dưới nhãn giá báo "đo được" (AGENTS.md mục 42).
    await db.insert(schema.products).values({ id: `${P}nogia`, name: "Hàng chưa có giá", customId: "GVTT-NOGIA" }).onConflictDoNothing();
    await db.insert(schema.productVariants).values({ id: `${P}nogia-v`, productId: `${P}nogia`, sku: "GVTT-NOGIA-1", retailPrice: 99_000 }).onConflictDoNothing();
    await db.insert(schema.orderItems).values({ id: `${P}i-d0-nogia`, orderId: `${P}o-d0`, variantId: `${P}nogia-v`, productId: `${P}nogia`, sku: `${P}nogia-v`, productName: "Hàng chưa có giá", variationDetail: "-", quantity: 1, lineTotal: 99_000, unitCost: 0, isBonus: false });
    await dungLai(PID);
    const chuaBiet = await ghiNhan();
    assert.equal(chuaBiet?.cogs, null, "còn dòng không nguồn giá ⇒ giá vốn ghi nhận CHƯA BIẾT (NULL), không phải tổng thiếu");
    assert.equal(chuaBiet?.basis, "NONE", "không mang nhãn giá báo khi con số chưa đủ — căn cứ NONE (chưa biết)");
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.id, [`${P}i-d0-mix`, `${P}i-d0-nogia`]));
    await db.update(schema.marketerPrices).set({ price: 170_000 }).where(and(eq(schema.marketerPrices.productId, PID), eq(schema.marketerPrices.price, 165_000)));
    await dungLai(PID);
    assert.equal((await lay("ACTUAL")).expectedCogs, Math.round(tt4.expectedQty * 170_000));
    // Dòng giá báo đang hiệu lực là 0 ₫ = "chưa định giá" ⇒ lùi về phiếu nhập gần nhất, KHÔNG thành giá vốn 0.
    await db.insert(schema.marketerPrices).values({ productId: PID, productCode: "GVTT-Q004", price: 0, effectiveFrom: gio(0.25), reason: "chưa định giá", setBy: "mkt@kiem" });
    await dungLai(PID);
    clearMemo();
    assert.equal((await lay("ACTUAL")).expectedCogs, Math.round(tt4.expectedQty * 190_000), "giá báo 0 ₫ ⇒ phiếu nhập gần nhất");
    assert.equal((await ghiNhan())?.basis, "RECEIPT_BEFORE", "mất giá báo ⇒ trở về bậc thang chứng từ kho");

    // Mã thôi có giá báo ⇒ giá thực tế lùi về phiếu nhập GẦN NHẤT (190.000) — đúng bậc thang luật 13.
    await db.delete(schema.marketerPrices).where(eq(schema.marketerPrices.productId, PID));
    const { rematerializeProductOrders } = await import("@/lib/queries/canonical-outcome");
    await rematerializeProductOrders(PID);
    clearMemo();
    const tt5 = await lay("ACTUAL");
    assert.equal(tt5.expectedCogs, Math.round(tt5.expectedQty * 190_000), "không có giá báo ⇒ giá thực tế = phiếu nhập gần nhất");
    assert.equal((await getCostCenter(ky)).find((r) => r.productId === PID)?.planned?.unitCost, 150_000);

    console.log("✓ Trung tâm giá vốn: giá kế hoạch sửa ở BCLN áp ngay (chế độ kế hoạch) · thực tế không bị đè · giá báo MKT không đè kế hoạch · phiếu nhập không đổi kế hoạch · lịch sử + ngày hiệu lực · Trung tâm giá vốn = BCLN · theo ngày = theo mã · lương không thấy giá kế hoạch");
  } finally {
    const ship = Array.from({ length: 12 }, (_, i) => `${P}s-d${i}`);
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ship));
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ship));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ship));
    await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like ${`${P}i-%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
    await db.delete(schema.marketerPrices).where(eq(schema.marketerPrices.productId, PID));
    const phieu = await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(sql`${schema.stockReceipts.reference} like ${`${P}%`}`);
    if (phieu.length) {
      await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, phieu.map((x) => x.id)));
      await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, phieu.map((x) => x.id)));
    }
    await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, [VID, `${P}mix-v`, `${P}nogia-v`]));
    await db.delete(schema.products).where(inArray(schema.products.id, [PID, `${P}mix`, `${P}nogia`]));
    await db.delete(schema.settings).where(eq(schema.settings.key, ESTIMATED_COST_KEY));
    clearMemo();
  }
}
