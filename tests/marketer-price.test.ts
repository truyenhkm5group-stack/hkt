import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { PAYROLL_CONFIG_KEY, PAYROLL_EMPLOYEES_KEY } from "@/lib/constants/payroll";
import { MARKETER_PRICE_EFFECTIVE_FROM, marketerCostDelta, marketerPriceAt } from "@/lib/constants/marketer-price";
import { MARKETING_UNATTRIBUTED } from "@/lib/constants/marketing-daily";
import { getNominalMarketerBreakdown, getMarketerReport } from "@/lib/queries/payroll";
import { getMarketerDailyNominal } from "@/lib/queries/marketer-daily-nominal";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { getWorkshopLedger } from "@/lib/queries/workshop-ledger";
import { getSettingJson, setSettingJson } from "@/lib/settings";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ GIÁ BÁO MKT ═══════════
 *
 * Chủ shop chốt 25/09/2026: một mã một giá (hạ được để xả tồn) · chỉ phần của MKT · từ 01/09/2026 ·
 * phạt xưởng cộng cho MKT phụ trách mã. Bốn chỗ dễ sai nhất:
 *  1. Giá báo lọt vào lợi nhuận SHOP (phải đứng trên giá vốn thật).
 *  2. Hạ giá xả tồn đổi luôn lợi nhuận các đơn cũ (phải theo ngày lên đơn).
 *  3. Đơn trước 01/09/2026 bị tính lại (tháng 8 đã trả lương).
 *  4. Σ các MKT không còn đối soát được với tổng shop (phần chênh phải thành một dòng riêng).
 */

const d = (iso: string) => new Date(`${iso}T00:00:00+07:00`);
const dEnd = (iso: string) => new Date(`${iso}T23:59:59+07:00`);
const ky = (from: string, to: string, label: string): Period => ({ key: "custom", from: d(from), to: dEnd(to), label, fromKey: from, toKey: to });
const THANG10 = ky("2027-10-01", "2027-10-31", "Tháng 10/2027");
const THANG8_2026 = ky("2026-08-01", "2026-08-31", "Tháng 8/2026");

export function testMarketerPricePure() {
  const bang = [
    { price: 150_000, effectiveFrom: d("2026-07-01") },
    { price: 120_000, effectiveFrom: d("2026-11-15") },
  ];
  assert.equal(MARKETER_PRICE_EFFECTIVE_FROM, "2026-09-01", "chủ shop chốt: áp từ tháng 9/2026");
  assert.equal(marketerPriceAt(bang, d("2026-08-20")), null, "đơn tháng 8/2026 KHÔNG dùng giá báo, dù dòng giá khai từ 01/07 — tháng 8 đã trả lương");
  assert.equal(marketerPriceAt(bang, d("2026-09-01")), 150_000, "đúng ngày bắt đầu áp dụng thì áp");
  assert.equal(marketerPriceAt(bang, d("2026-11-14")), 150_000);
  assert.equal(marketerPriceAt(bang, d("2026-11-15")), 120_000, "hạ giá xả tồn áp từ đúng ngày hiệu lực");
  assert.equal(marketerPriceAt([], d("2026-10-01")), null, "chưa khai giá báo ⇒ không có giá báo (KHÔNG phải 0đ)");
  assert.equal(marketerPriceAt([{ price: 0, effectiveFrom: d("2026-09-01") }], d("2026-10-01")), 0, "giá báo 0đ phải là một dòng người khai, và khi khai thì nó là 0 thật");
  assert.equal(marketerCostDelta(3, 100_000, 150_000), 150_000);
  assert.equal(marketerCostDelta(3, 100_000, 80_000), -60_000, "giá xả tồn thấp hơn giá vốn ⇒ shop bù cho MKT");
  assert.equal(marketerCostDelta(3, 100_000, null), 0);

  // ─── Giá báo KHÔNG được lọt vào lợi nhuận shop ───
  const DUOC_PHEP = new Set([
    "lib/queries/marketer-price.ts",
    "lib/queries/payroll.ts",
    "lib/queries/profit-nominal.ts",
    "lib/queries/marketer-daily-nominal.ts",
    "lib/queries/workshop-ledger.ts",
    "lib/actions/marketer-price.ts",
    "lib/actions/workshop-ledger.ts",
  ]);
  const tep = execSync("git ls-files lib app components && git ls-files --others --exclude-standard lib app components", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f));
  // Bỏ chú thích trước khi quét: nhắc tên bảng trong một đoạn giải thích không phải là đọc bảng.
  const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const lot = tep.filter((f) => !DUOC_PHEP.has(f) && /marketer_prices|marketerPrices|LINE_MARKETER_PRICE|MKT_LINE_UNIT_COST/.test(boChuThich(readFileSync(f, "utf8"))));
  assert.deepEqual(lot, [], "giá báo MKT chỉ được đọc ở đường của MKT (lương + lợi nhuận danh nghĩa theo MKT) — báo cáo lợi nhuận shop đứng trên giá vốn thật");
  const nominalSrc = readFileSync("lib/queries/profit-nominal.ts", "utf8");
  assert.ok(!nominalSrc.includes("MKT_LINE_UNIT_COST"), "báo cáo lợi nhuận danh nghĩa theo MÃ không được thay giá vốn bằng giá báo");
  assert.equal((nominalSrc.match(/\$\{LINE_MARKETER_PRICE\}/g) ?? []).length, 3, "giá báo chỉ đi vào hai cột riêng của đường MKT (`mktDeltaFull`, `mktPricedUnknownQty`)");
  console.log("✓ Giá báo MKT (hàm thuần): một mã một giá theo ngày lên đơn · hạ giá không đổi đơn cũ · trước 01/09/2026 không áp · không lọt vào lợi nhuận shop");
}

async function donDep(db: Db) {
  await db.delete(schema.marketerPrices).where(sql`${schema.marketerPrices.productId} like 'mpk-%'`);
  await db.delete(schema.productionBatches).where(sql`${schema.productionBatches.productCode} like 'MPK%'`);
  await db.delete(schema.stockReceiptItems).where(sql`${schema.stockReceiptItems.id} like 'mpk-%'`);
  await db.delete(schema.stockReceipts).where(sql`${schema.stockReceipts.id} like 'mpk-%'`);
  await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like 'mpk-%'`);
  await db.delete(schema.shipments).where(sql`${schema.shipments.id} like 'mpk-%'`);
  await db.delete(schema.orders).where(sql`${schema.orders.id} like 'mpk-%'`);
  await db.delete(schema.productVariants).where(sql`${schema.productVariants.id} like 'mpk-%'`);
  await db.delete(schema.products).where(sql`${schema.products.id} like 'mpk-%'`);
  clearMemo();
}

async function donGiao(db: Db, id: string, ngay: string, qty: number, revenue: number, ma = "mpk-prod", mau = "mpk-var") {
  await db.insert(schema.orders).values({ id: `mpk-${id}`, insertedAt: d(ngay), stage: "DELIVERED", status: 3, totalPriceAfterDiscount: revenue, partnerFee: 0, returnFee: 0, cod: revenue });
  await db.insert(schema.orderItems).values({ id: `mpk-${id}-i`, orderId: `mpk-${id}`, variantId: mau, productId: ma, productName: "Đầm giá báo", quantity: qty, lineTotal: revenue, unitCost: 0, isBonus: false });
  await db.insert(schema.shipments).values({ id: `mpk-${id}-s`, orderId: `mpk-${id}`, vtpOrderNumber: `MPK${id.toUpperCase()}0000001`, stage: "DELIVERED", shippingFee: 0, codAmount: revenue, codCollected: revenue, codStatus: "RECONCILED", deliveredAt: d(ngay) });
}

export async function testMarketerPriceQueries(db: Db) {
  const nhanSuTruoc = await getSettingJson<unknown>(PAYROLL_EMPLOYEES_KEY, null);
  const cauHinhTruoc = await getSettingJson<unknown>(PAYROLL_CONFIG_KEY, null);
  await donDep(db);
  try {
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, { list: [{ id: "mpk-mkt", name: "Chị MKT Kiểm", shortName: "MKT Kiểm", department: "Marketing", aliases: [], accountIds: [], fixed: 0, percentTotal: 0, percentPersonal: 0, percentRevenue: 0, active: true, note: "" }] });
    const cfg = (cauHinhTruoc ?? {}) as { productOwners?: Record<string, string> };
    await setSettingJson(PAYROLL_CONFIG_KEY, { ...cfg, productOwners: { ...(cfg.productOwners ?? {}), "mpk-prod": "mpk-mkt" } });

    await db.insert(schema.products).values({ id: "mpk-prod", name: "Đầm giá báo", customId: "MPK1" });
    await db.insert(schema.productVariants).values({ id: "mpk-var", productId: "mpk-prod", sku: "MPK1-M", color: "Đen", size: "M" });
    await db.insert(schema.stockReceipts).values({ id: "mpk-rc", kind: "RECEIPT", receivedAt: d("2026-07-01") });
    await db.insert(schema.stockReceiptItems).values({ id: "mpk-ri", receiptId: "mpk-rc", variantId: "mpk-var", quantity: 500, unitCost: 100_000 });
    await donGiao(db, "o8", "2026-08-20", 1, 300_000);
    await donGiao(db, "o1", "2027-10-05", 2, 500_000);
    await donGiao(db, "o2", "2027-10-20", 1, 250_000);
    // Mã THỨ HAI không có MKT phụ trách, không quảng cáo ⇒ không ai nhận ⇒ shop giữ, đứng trên giá vốn thật.
    await db.insert(schema.products).values({ id: "mpk-prod2", name: "Áo không ai nhận", customId: "MPK2" });
    await db.insert(schema.productVariants).values({ id: "mpk-var2", productId: "mpk-prod2", sku: "MPK2-M", color: "Trắng", size: "M" });
    await db.insert(schema.stockReceiptItems).values({ id: "mpk-ri2", receiptId: "mpk-rc", variantId: "mpk-var2", quantity: 100, unitCost: 80_000 });
    await donGiao(db, "o3", "2027-10-12", 2, 400_000, "mpk-prod2", "mpk-var2");
    clearMemo();

    // ── MỐC: chưa có giá báo, chưa có phạt ──
    const goc = await getMarketerReport(THANG10, "profit1");
    const gocNominal = await getNominalMarketerBreakdown(THANG10);
    const gocShop = await getNominalProfitReport(THANG10, "ORDERED");
    const gocT8 = await getMarketerReport(THANG8_2026, "profit1");
    const gocDaily = await getMarketerDailyNominal(THANG10);
    const mkt = (r: typeof goc) => r.marketers.find((m) => m.marketerId === "mpk-mkt");
    assert.equal(mkt(goc)?.cogsCharged, 300_000, "chưa có giá báo ⇒ MKT chịu đúng giá vốn thật 3 × 100.000");
    assert.equal(goc.totals.marketerPriceMargin, 0);

    // ── Giá báo 150.000 từ 01/07/2026, hạ 120.000 từ 15/10/2027 để xả tồn; phạt xưởng 50.000 ngày 10/10/2027 ──
    await db.insert(schema.marketerPrices).values([
      { productId: "mpk-prod", productCode: "MPK1", price: 150_000, effectiveFrom: d("2026-07-01") },
      { productId: "mpk-prod", productCode: "MPK1", price: 120_000, effectiveFrom: d("2027-10-15") },
      { productId: "mpk-prod2", productCode: "MPK2", price: 200_000, effectiveFrom: d("2027-10-01") },
    ]);
    await db.insert(schema.productionBatches).values({ productId: "mpk-prod", productCode: "MPK1", batchNo: 1, orderedAt: d("2027-09-01"), orderedQty: 10, workshopPenalty: 50_000, penaltyAt: d("2027-10-10"), status: "DONE" });
    clearMemo();

    const sau = await getMarketerReport(THANG10, "profit1");
    const dong = sau.products.find((p) => p.productId === "mpk-prod");
    assert.equal(dong?.cogsDelivered, 300_000, "lợi nhuận CỦA MÃ (shop) vẫn trên giá vốn thật");
    assert.equal(sau.totals.profit, goc.totals.profit, "giá báo và hoàn phạt KHÔNG đổi lợi nhuận shop");
    assert.equal(mkt(sau)?.cogsCharged, 2 * 150_000 + 1 * 120_000, "MKT chịu giá báo theo NGÀY LÊN ĐƠN: đơn 05/10 giá 150.000, đơn 20/10 giá đã hạ 120.000");
    assert.equal(sau.totals.marketerPriceMargin, 420_000 - 300_000, "phần chênh shop giữ đứng thành một dòng đối soát");
    assert.equal(mkt(sau)?.workshopPenaltyCredit, 50_000, "phạt xưởng cộng cho MKT phụ trách mã");
    assert.equal((mkt(sau)?.personalProfit ?? 0) - (mkt(goc)?.personalProfit ?? 0), -120_000 + 50_000, "lợi nhuận cá nhân đổi đúng bằng (giá vốn thật − giá báo) + hoàn phạt");
    assert.equal(sau.totals.workshopPenaltyCredited, 50_000);

    const sauT8 = await getMarketerReport(THANG8_2026, "profit1");
    assert.equal(mkt(sauT8)?.cogsCharged ?? 0, mkt(gocT8)?.cogsCharged ?? 0, "đơn tháng 8/2026 KHÔNG bị tính lại theo giá báo");
    assert.equal(sauT8.totals.marketerPriceMargin, 0);

    // ── Lợi nhuận danh nghĩa: bảng theo MÃ đứng yên, bảng theo MKT đứng trên giá báo ──
    const sauShop = await getNominalProfitReport(THANG10, "ORDERED");
    assert.equal(sauShop.totals.expectedProfit, gocShop.totals.expectedProfit, "lợi nhuận danh nghĩa của SHOP không đổi");
    const dongNominal = sauShop.rows.find((r) => r.productId === "mpk-prod");
    assert.ok(dongNominal, "mã phải có dòng trong lợi nhuận danh nghĩa");
    const tyLe = dongNominal.items > 0 ? dongNominal.expectedQty / dongNominal.items : 0;
    assert.equal(dongNominal.marketerCostDelta, Math.round(120_000 * tyLe), "phần chênh quy về số sản phẩm giao thành công ƯỚC TÍNH của mã");
    const sauNominal = await getNominalMarketerBreakdown(THANG10);
    const r = (x: typeof sauNominal) => x.rows.find((m) => m.marketerId === "mpk-mkt");
    assert.equal(sauNominal.marketerPriceMargin, dongNominal.marketerCostDelta);
    assert.equal((r(sauNominal)?.personalNet ?? 0) - (r(gocNominal)?.personalNet ?? 0), -dongNominal.marketerCostDelta + 50_000, "lợi nhuận danh nghĩa của MKT đổi đúng bằng phần chênh giá báo + hoàn phạt");
    assert.equal(sauNominal.workshopPenaltyCredited, 50_000);

    // ── /ads/daily: cột MKT trên giá báo, hàng tổng trên giá vốn thật ──
    const sauDaily = await getMarketerDailyNominal(THANG10);
    const cot = (x: typeof sauDaily) => x.marketers.find((m) => m.key === "mpk-mkt");
    const chuaQuyKet = (x: typeof sauDaily) => x.marketers.find((m) => m.key === MARKETING_UNATTRIBUTED)?.total.expectedCogs ?? 0;
    assert.equal(chuaQuyKet(sauDaily), chuaQuyKet(gocDaily), "ô 'Chưa quy kết' là phần shop giữ ⇒ giá vốn thật, dù mã có giá báo");
    assert.equal(sauDaily.marketerPriceMargin, dongNominal.marketerCostDelta, "/ads/daily chia đúng phần chênh của mã mà tab Lợi nhuận danh nghĩa dùng");
    assert.equal((cot(sauDaily)?.total.expectedCogs ?? 0) - (cot(gocDaily)?.total.expectedCogs ?? 0), dongNominal.marketerCostDelta, "cột của MKT chịu giá vốn theo giá báo");
    assert.equal(sauDaily.total.expectedCogs, gocDaily.total.expectedCogs, "hàng tổng kỳ vẫn trên giá vốn thật");
    assert.equal(sauDaily.reconcile.expectedProfit.ours, sauDaily.reconcile.expectedProfit.report, "đối chiếu với Báo cáo lợi nhuận vẫn khớp từng đồng");
    assert.ok(sauDaily.warnings.some((w) => w.includes("GIÁ BÁO MKT")), "màn hình phải nói cột MKT đang trên giá báo");

    // ── Sổ đặt xưởng: tên MKT phụ trách + giá báo đang áp đọc đúng nguồn ──
    const so = await getWorkshopLedger(d("2027-10-25"));
    const ma = so.products.find((p) => p.productCode === "MPK1");
    assert.equal(ma?.marketerName, "MKT Kiểm", "tên MKT phụ trách phải đọc được từ cấu hình Lương (sổ nhân sự lưu dạng { list })");
    assert.equal(ma?.marketerPrice, 120_000, "giá báo đang áp là dòng mới nhất đã tới ngày hiệu lực");
    console.log("✓ Giá báo MKT (CSDL): lợi nhuận shop đứng yên · MKT chịu giá báo theo ngày lên đơn · hạ giá không đổi đơn cũ · tháng 8/2026 không tính lại · hoàn phạt cộng cho MKT phụ trách · phần chênh thành dòng đối soát · tên MKT đọc đúng sổ nhân sự");
  } finally {
    await setSettingJson(PAYROLL_EMPLOYEES_KEY, nhanSuTruoc ?? { list: [] });
    await setSettingJson(PAYROLL_CONFIG_KEY, cauHinhTruoc ?? {});
    await donDep(db);
  }
}
