import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { clearMemo } from "@/lib/cache";
import { BREAK_EVEN_CPO_LABEL, breakEvenSpend, cpoHeadroom, maxAdCostPerOrder, spendPerOrder } from "@/lib/constants/break-even-cpo";
import { adsCeiling } from "@/lib/constants/estimated-cost";
import type { ProductCostView } from "@/lib/queries/workshop-ledger";
import { buildDecisionRow, getAdsDecision, type AdsDecisionAgg } from "@/lib/queries/ads-decision";
import { ledgerRowValues, upsertLedgerValues } from "@/lib/marketing/decision-ledger";
import { buildModelEconomics, getModelEconomics, type EconomicsLineKey, type ModelEconomics } from "@/lib/queries/model-economics";
import { getNominalProfitReport, type NominalRow } from "@/lib/queries/profit-nominal";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { buildProductionVariance, getProductionVariance, receiptVariance, VARIANCE_SOURCES } from "@/lib/queries/production-variance";
import type { Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT F — KINH TẾ THEO MẪU ═══════════
 *
 * Bốn điều được khoá ở đây, và mỗi điều là một chỗ một con số có thể lặng lẽ nói hai điều:
 *
 *  1. CPO HOÀ VỐN CÓ MỘT CÔNG THỨC. Bảng quyết định `/ads` và trần CPQC/đơn của lợi nhuận danh
 *     nghĩa gọi CÙNG `maxAdCostPerOrder`; cùng đầu vào ⇒ cùng số, và hai tử số khác nhau mang hai
 *     nhãn khác nhau.
 *  2. SỔ QUYẾT ĐỊNH CHỤP LỢI NHUẬN DỰ PHÓNG cho dòng mới và KHÔNG chạm dòng cũ.
 *  3. `getModelEconomics` KHÔNG tính lại: ô Ước tính bằng đúng dòng báo cáo danh nghĩa, ô Thực đạt
 *     bằng đúng dòng bảng quyết định cấp mã.
 *  4. Báo cáo chênh lệch giá SX: null là "—", chiều chênh = phiếu kho − nguồn, và không lọt vào lợi
 *     nhuận.
 *
 * Không bài nào đọc đồng hồ thật: mốc thời gian đều là hằng số truyền vào hàm thuần (mục 50, 65).
 */

const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

function agg(over: Partial<AdsDecisionAgg> = {}): AdsDecisionAgg {
  return {
    key: "cosf-p",
    name: "Mã F",
    bookedOrders: 10,
    deliveredOrders: 8,
    returnedOrders: 2,
    openOrders: 0,
    notShippedOrders: 0,
    notShippedRevenue: 0,
    inTransitOrders: 0,
    inTransitRevenue: 0,
    bookedRevenue: 10_000_000,
    deliveredRevenue: 8_000_000,
    cash: 7_000_000,
    cogs: 4_000_000,
    shipping: 500_000,
    openProjectedRevenue: 0,
    openProjectedCogs: 0,
    openProjectedShipping: 0,
    openProjectedOrders: 0,
    ...over,
  };
}

export function testCompanyOsEconomicsPure() {
  // ═══════════ PHẦN A — MỘT CÔNG THỨC CPO HOÀ VỐN ═══════════

  // A1. Hàm chung khớp `adsCeiling` trên CÙNG đầu vào, kể cả khi có %CP khác.
  const cases = [
    { netProfit: 1_000_000, adSpend: 2_000_000, otherCost: 22_000, orders: 50, other: 1.1 },
    { netProfit: -300_000, adSpend: 900_000, otherCost: 0, orders: 7, other: 0 },
    { netProfit: 0, adSpend: 0, otherCost: 0, orders: 3, other: 2.5 },
    { netProfit: 5_555_555, adSpend: 1_234_567, otherCost: 12_345, orders: 33, other: 1 },
  ];
  for (const c of cases) {
    const ceil = adsCeiling({ netProfit: c.netProfit, adSpend: c.adSpend, otherCost: c.otherCost, expectedRevenue: 1, posSales: 1_000_000, orders: c.orders, otherCostPercentOfAds: c.other, targetMarginPct: null });
    const mot = maxAdCostPerOrder({ profitBeforeAds: c.netProfit + c.adSpend + c.otherCost, orders: c.orders, otherCostPercentOfAds: c.other });
    assert.equal(mot, ceil.breakEven.perOrder, `CPO hoà vốn phải là MỘT công thức với adsCeiling (${JSON.stringify(c)})`);
    assert.equal(ceil.breakEven.spend, Math.round(breakEvenSpend(c.netProfit + c.adSpend + c.otherCost, c.other)), "trần chi cả kỳ đi qua cùng hàm");
  }

  // A2. Bảng quyết định trên cùng tử số/mẫu số ra ĐÚNG con số của adsCeiling (%CP khác = 0).
  const row = buildDecisionRow(agg(), "product", 1_000_000, true);
  assert.equal(row.contributionBeforeAds, 3_500_000);
  const tuNominal = adsCeiling({ netProfit: 3_500_000 - 1_000_000, adSpend: 1_000_000, otherCost: 0, expectedRevenue: 1, posSales: 1, orders: 10, otherCostPercentOfAds: 0, targetMarginPct: null });
  assert.equal(row.breakEvenCpo, 350_000, "LN góp 3.500.000 ÷ 10 đơn chốt");
  assert.equal(row.breakEvenCpo, tuNominal.breakEven.perOrder, "hai đường (bảng quyết định, trần danh nghĩa) phải ra cùng số trên cùng đầu vào");
  assert.equal(row.costPerOrder, 100_000);
  assert.equal(row.cpoHeadroom, 250_000, "dư địa = hoà vốn − CPO thực");
  assert.equal(row.breakEvenCpoBasis, "CONTRIBUTION_ACTUAL");

  // A3. Bất biến: CPO thực ≤ hoà vốn ⟺ lợi nhuận sau QC ≥ 0 — trên nhiều mức chi.
  for (const spend of [0, 1, 1_000_000, 3_499_999, 3_500_000, 3_500_001, 9_000_000]) {
    const r = buildDecisionRow(agg(), "product", spend, true);
    if (r.cpoHeadroom === null) continue;
    // Làm tròn tới đồng có thể lệch 1 ₫ quanh đúng điểm hoà vốn — so bằng dấu của lợi nhuận/đơn.
    const loiNhuanMoiDon = r.profitAfterAds / r.bookedOrders;
    assert.ok(Math.abs(r.cpoHeadroom - loiNhuanMoiDon) <= 1, `dư địa/đơn phải bằng LN sau QC/đơn (±1₫) ở mức chi ${spend}`);
  }

  // A4. CHƯA BIẾT là null, không phải 0 (mục 42).
  assert.equal(maxAdCostPerOrder({ profitBeforeAds: 1_000_000, orders: 0 }), null, "0 đơn ⇒ null");
  assert.equal(maxAdCostPerOrder({ profitBeforeAds: null, orders: 5 }), null, "tử số chưa biết ⇒ null");
  assert.equal(maxAdCostPerOrder({ profitBeforeAds: Number.NaN, orders: 5 }), null, "NaN ⇒ null, không phải NaN");
  assert.equal(spendPerOrder(100, 0), null);
  assert.equal(cpoHeadroom(null, 5), null);
  assert.equal(cpoHeadroom(5, null), null);
  const khongDon = buildDecisionRow(agg({ bookedOrders: 0, deliveredOrders: 0, returnedOrders: 0, bookedRevenue: 0, deliveredRevenue: 0, cogs: 0, shipping: 0, cash: 0 }), "product", 500_000, true);
  assert.equal(khongDon.breakEvenCpo, null, "chưa có đơn chốt ⇒ CPO hoà vốn CHƯA BIẾT");
  assert.equal(khongDon.cpoHeadroom, null);
  const khongChi = buildDecisionRow(agg(), "adset", 0, false);
  assert.equal(khongChi.costPerOrder, null, "không biết số chi ⇒ CPO thực null");
  assert.equal(khongChi.breakEvenCpo, 350_000, "CPO hoà vốn không phụ thuộc số chi");
  assert.equal(khongChi.cpoHeadroom, null, "thiếu một vế ⇒ dư địa null, không phải hoà vốn − 0");
  // ≤ 0 là câu trả lời thật, không bị ép về null hay 0.
  const lo = buildDecisionRow(agg({ cogs: 9_000_000 }), "product", 100_000, true);
  assert.ok(lo.breakEvenCpo !== null && lo.breakEvenCpo < 0, "lỗ cả khi không QC ⇒ CPO hoà vốn ÂM, không phải null/0");

  // A5. Căn cứ TẠM TÍNH: dòng đọc CPO hoà vốn tạm tính, và dư địa đi theo nó.
  const treo = buildDecisionRow(
    agg({ deliveredOrders: 2, returnedOrders: 0, openOrders: 8, inTransitOrders: 8, inTransitRevenue: 8_000_000, deliveredRevenue: 2_000_000, cogs: 1_000_000, shipping: 60_000, openProjectedRevenue: 6_000_000, openProjectedCogs: 3_000_000, openProjectedShipping: 240_000, openProjectedOrders: 6 }),
    "product",
    500_000,
    true,
  );
  assert.equal(treo.basis, "PROJECTED");
  assert.equal(treo.breakEvenCpoBasis, "CONTRIBUTION_PROJECTED");
  assert.equal(treo.projectedBreakEvenCpo, maxAdCostPerOrder({ profitBeforeAds: treo.projectedProfitAfterAds + treo.spend, orders: treo.bookedOrders }), "tạm tính đi cùng hàm, tử số = LN góp tạm tính");
  assert.equal(treo.cpoHeadroom, cpoHeadroom(treo.projectedBreakEvenCpo, treo.costPerOrder), "dư địa phải theo căn cứ của khuyến nghị");
  assert.notEqual(treo.projectedBreakEvenCpo, treo.breakEvenCpo, "hai căn cứ phải là hai con số khi còn đơn treo");

  // A6. Không bao giờ hai nhãn trơn "CPO hoà vốn": ba nhãn đều khác nhau và đều nói tử số.
  const nhan = Object.values(BREAK_EVEN_CPO_LABEL);
  assert.equal(new Set(nhan).size, nhan.length, "ba căn cứ CPO hoà vốn phải có ba nhãn khác nhau");
  for (const x of nhan) assert.ok(/LN góp|LN ròng/.test(x), `nhãn "${x}" phải nói nó đứng trên lợi nhuận nào`);

  // A7. Quét mã nguồn: hai đường gọi CÙNG hàm, và adsCeiling không còn phép chia riêng.
  const ceilingSrc = readFileSync("lib/constants/estimated-cost.ts", "utf8");
  assert.ok(/from "@\/lib\/constants\/break-even-cpo"/.test(ceilingSrc) && /breakEvenSpend\(/.test(ceilingSrc) && /spendPerOrder\(/.test(ceilingSrc), "adsCeiling phải đi qua hàm chung");
  assert.ok(!/\/\s*heSo/.test(ceilingSrc) && !/spend \/ input\.orders/.test(ceilingSrc), "adsCeiling không được giữ lại phép chia thứ hai");
  const decisionSrc = readFileSync("lib/queries/ads-decision.ts", "utf8");
  assert.ok(/maxAdCostPerOrder\(\{ profitBeforeAds: contributionBeforeAds/.test(decisionSrc), "bảng quyết định phải gọi maxAdCostPerOrder cho CPO hoà vốn");

  // ═══════════ PHẦN B — SỔ QUYẾT ĐỊNH CHỤP DỰ PHÓNG (phần thuần) ═══════════
  const vals = ledgerRowValues(treo, "2026-09-20", "2026-08-22", "2026-09-04");
  assert.equal(vals.projectedProfitAfterAds, Math.round(treo.projectedProfitAfterAds), "sổ chép ĐÚNG lợi nhuận tạm tính của dòng");
  assert.equal(vals.projectedHeadroom, treo.projectedHeadroom);
  assert.equal(vals.appliedDeliveryRate, treo.appliedDeliveryRate);
  assert.equal(vals.basis, "PROJECTED", "căn cứ đi cùng con số dự phóng");
  const valsNoSpend = ledgerRowValues(khongChi, "2026-09-20", "2026-08-22", "2026-09-04");
  assert.equal(valsNoSpend.projectedProfitAfterAds, null, "không biết số chi ⇒ lợi nhuận sau QC dự phóng là CHƯA BIẾT, không phải số trước QC");
  assert.equal(valsNoSpend.projectedHeadroom, null);
  const valsNoOpen = ledgerRowValues(row, "2026-09-20", "2026-08-22", "2026-09-04");
  assert.equal(valsNoOpen.appliedDeliveryRate, null, "không có gì treo ⇒ tỷ lệ đã áp là null, không phải 0%");
  const ledgerSrc = readFileSync("lib/marketing/decision-ledger.ts", "utf8");
  assert.ok(!/projected\w*:\s*[^,\n]*\?\?\s*0/.test(ledgerSrc), "không được `?? 0` trên cột dự phóng (mục 42)");

  // ═══════════ PHẦN C — getModelEconomics (phần thuần, nhánh null) ═══════════
  const rong = buildModelEconomics({ productId: "khong-co", period: ALL, nominal: null, otherCostPercentOfAds: 1, decision: null, withEstimatedCost: false });
  assert.equal(rong.estimatedFound, false);
  assert.equal(rong.realizedFound, false);
  for (const l of rong.lines) {
    assert.equal(l.estimated.value, null, `${l.key}: không có dòng danh nghĩa ⇒ Ước tính null, không phải 0`);
    assert.equal(l.realized.value, null, `${l.key}: không có dòng quyết định ⇒ Thực đạt null`);
    assert.equal(l.estimated.label, "Ước tính");
    assert.equal(l.realized.label, "Thực đạt");
    if (l.projected) assert.equal(l.projected.label, "Tạm tính");
    assert.ok(l.estimated.note, `${l.key}: ô trống phải nói vì sao`);
  }
  assert.equal(rong.cogsBasis.usesFrozenRecognizedCogs, false);
  assert.ok(rong.cogsBasis.note.includes("recognized_cogs"), "khác biệt giá vốn sống/đóng băng phải nằm trong một trường, không giấu");
  const chiMu = buildModelEconomics({ productId: "cosf-p", period: ALL, nominal: null, otherCostPercentOfAds: 0, decision: khongChi, withEstimatedCost: false });
  const line = (m: ModelEconomics, k: EconomicsLineKey) => m.lines.find((x) => x.key === k)!;
  assert.equal(line(chiMu, "adSpend").realized.value, null, "không biết số chi ⇒ chi QC Thực đạt null");
  assert.equal(line(chiMu, "contributionAfterAds").realized.value, null, "không biết số chi ⇒ LN sau QC Thực đạt null");
  assert.equal(line(chiMu, "breakEvenCpoContribution").realized.value, 350_000, "CPO hoà vốn vẫn biết khi chưa biết số chi");
  assert.equal(line(chiMu, "netProfit").realized.value, null, "LN ròng thực đạt theo mã: ERP chưa đo — null kèm lý do");
  assert.ok(line(chiMu, "netProfit").realized.note);

  // C2. Dòng danh nghĩa GIẢ (chỉ những trường hàm đọc) — mọi ô Ước tính phải là ĐÚNG trường nguồn.
  const nGia = {
    productId: "cosf-p", code: "F", orders: 20, adSpend: 2_000_000, expectedRevenue: 12_000_000, expectedProfit: 3_000_000, netProfit: 1_000_000,
    otherCost: 22_000, salesAfterDiscount: 20_000_000, cpo: 100_000, deliveryRate: 60, returnRateSource: "projected",
    cogsUncoveredQty: 0, cogsUnknownQty: 0, expectedCogsEstimated: 0,
  } as unknown as NominalRow;
  const coSo = buildModelEconomics({ productId: "cosf-p", period: ALL, nominal: nGia, otherCostPercentOfAds: 1.1, decision: row, withEstimatedCost: false });
  assert.equal(line(coSo, "netProfit").estimated.value, 1_000_000, "LN ròng Ước tính = netProfit");
  assert.equal(line(coSo, "contributionAfterAds").estimated.value, 3_000_000, "LN góp sau QC Ước tính = expectedProfit");
  assert.equal(line(coSo, "deliveredRevenue").estimated.value, 12_000_000);
  assert.equal(line(coSo, "orders").estimated.value, 20);
  assert.equal(line(coSo, "netProfitPerOrder").estimated.value, 50_000);
  assert.equal(line(coSo, "contributionPerOrder").estimated.value, 150_000);
  assert.equal(line(coSo, "breakEvenCpoContribution").estimated.value, 250_000, "(3.000.000 + 2.000.000) ÷ 20 — cùng hàm với bảng quyết định");
  assert.equal(
    line(coSo, "maxAdCostPerOrderNet").estimated.value,
    adsCeiling({ netProfit: 1_000_000, adSpend: 2_000_000, otherCost: 22_000, expectedRevenue: 12_000_000, posSales: 20_000_000, orders: 20, otherCostPercentOfAds: 1.1, targetMarginPct: null }).breakEven.perOrder,
    "Trần CPQC/đơn danh nghĩa = adsCeiling của đúng dòng",
  );
  assert.ok((line(coSo, "maxAdCostPerOrderNet").estimated.value ?? 0) < (line(coSo, "breakEvenCpoContribution").estimated.value ?? 0), "trần theo LN ròng phải CHẶT hơn CPO hoà vốn theo LN góp khi có chi phí vận hành");
  assert.equal(line(coSo, "contributionMarginPct").estimated.value, (5_000_000 / 12_000_000) * 100);
  assert.equal(line(coSo, "breakEvenCpoContribution").realized.value, row.breakEvenCpo);
  assert.equal(line(coSo, "contributionMarginPct").realized.value, (row.marginRate ?? 0) * 100);
  // Giá vốn còn trống ⇒ số vẫn in (như tab danh nghĩa) nhưng ô nói rõ là CAO HƠN THẬT.
  const thieuGia = buildModelEconomics({ productId: "cosf-p", period: ALL, nominal: { ...nGia, cogsUncoveredQty: 3, cogsUnknownQty: 3 } as NominalRow, otherCostPercentOfAds: 0, decision: row, withEstimatedCost: false });
  assert.ok(line(thieuGia, "netProfit").estimated.note?.includes("CAO HƠN THẬT"), "thiếu giá vốn phải được nói ra ở ô tiền");
  assert.ok(line(thieuGia, "contributionAfterAds").realized.note?.includes("chưa có giá vốn thật") ?? false, "Thực đạt cũng phải nói phần giá vốn 0 ₫");

  // ═══════════ PHẦN D — CHÊNH LỆCH GIÁ SX (thuần) ═══════════
  assert.equal(receiptVariance(120_000, 100_000), 20_000, "chênh = phiếu kho − nguồn (dương = phiếu kho cao hơn)");
  assert.equal(receiptVariance(null, 100_000), null);
  assert.equal(receiptVariance(120_000, null), null);
  const NOW = new Date("2026-09-20T00:00:00+07:00");
  const cost = (unitCost: number | null, reason: string) => ({ fabricCost: null, laborCost: null, total: null, delivered: 10, unitCost, provisional: false, reason });
  const ledgerProducts: ProductCostView[] = [
    { productCode: "F1", productName: "Áo F1", productId: "pF1", batches: 1, fabricOrderCount: 1, unassignedFabric: 0, cost: cost(100_000, "Đã chốt"), marketerName: "A", marketerPrice: 150_000, receiptUnitCost: 120_000, receiptAt: NOW },
    { productCode: "F2", productName: "Áo F2", productId: "pF2", batches: 1, fabricOrderCount: 0, unassignedFabric: 0, cost: cost(null, "Xưởng chưa trả chiếc nào"), marketerName: null, marketerPrice: null, receiptUnitCost: null, receiptAt: null },
  ];
  const bang = buildProductionVariance({
    ledgerProducts,
    poCosts: new Map([
      ["pF1", { productId: "pF1", productCode: "F1", productName: "Áo F1", unitCost: 110_000, code: "PO-1", at: NOW }],
      ["pF3", { productId: "pF3", productCode: "F3", productName: "Áo F3", unitCost: 70_000, code: "PO-3", at: NOW }],
    ]),
    poOnlyReceipts: new Map([["pF3", { unitCost: 80_000, at: NOW }]]),
    estimated: { pF1: { unitCost: 90_000, reason: "báo giá xưởng", setAt: null, setBy: null } },
    marketerPrices: new Map([["pF3", [{ price: 99_000, effectiveFrom: new Date("2026-09-10T00:00:00+07:00") }, { price: 1, effectiveFrom: new Date("2026-10-01T00:00:00+07:00") }]]]),
    now: NOW,
  });
  assert.deepEqual(bang.map((r) => r.productCode), ["F1", "F2", "F3"], "mã chỉ có lệnh SX vẫn có dòng");
  const f1 = bang[0];
  assert.deepEqual(f1.variance, { WORKSHOP_ACTUAL: 20_000, PO_UNIT_COST: 10_000, ESTIMATED_COST: 30_000, MARKETER_PRICE: -30_000 }, "chênh đúng chiều phiếu kho − nguồn, đủ bốn nguồn");
  const f2 = bang[1];
  for (const k of VARIANCE_SOURCES) assert.equal(f2.variance[k], null, `F2 · ${k}: thiếu phiếu kho ⇒ chênh CHƯA BIẾT, không phải 0`);
  assert.equal(f2.sources.WORKSHOP_ACTUAL.value, null);
  assert.equal(f2.sources.WORKSHOP_ACTUAL.note, "Xưởng chưa trả chiếc nào", "ô trống mang lý do của sổ");
  assert.equal(f2.sources.ESTIMATED_COST.value, null);
  assert.equal(f2.baseline.value, null);
  const f3 = bang[2];
  assert.equal(f3.workshop, null);
  assert.equal(f3.sources.MARKETER_PRICE.value, 99_000, "giá báo đang hiệu lực tại `now` — dòng có hiệu lực SAU `now` không được áp");
  assert.equal(f3.variance.PO_UNIT_COST, 10_000);
  assert.equal(f3.variance.WORKSHOP_ACTUAL, null);

  // D2. Không lọt vào lợi nhuận: không tệp nào ngoài trang Giá SX được import báo cáo này, và nó
  // không tự đọc bốn bảng của sổ đặt xưởng.
  const tep = execSync("git ls-files lib app components && git ls-files --others --exclude-standard lib app components", { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter((f) => /\.(ts|tsx)$/.test(f));
  const DUOC_IMPORT = new Set(["lib/queries/production-variance.ts", "app/(dashboard)/inventory/workshop/page.tsx"]);
  const lot = tep.filter((f) => !DUOC_IMPORT.has(f) && /queries\/production-variance/.test(readFileSync(f, "utf8")));
  assert.deepEqual(lot, [], "báo cáo chênh lệch giá SX chỉ để đọc ở trang Giá SX — không truy vấn lợi nhuận/lương/chi phí nào được import nó");
  const varianceSrc = readFileSync("lib/queries/production-variance.ts", "utf8");
  assert.ok(!/productionBatches|productionDeliveries|fabricOrders|supplierPayments|production_batches|production_deliveries|fabric_orders|supplier_payments/.test(varianceSrc), "báo cáo chênh lệch không tự đọc bốn bảng sổ đặt xưởng");
  // Hàm kinh tế theo mẫu cũng không phải nguồn của báo cáo tiền nào.
  const lot2 = tep.filter((f) => f !== "lib/queries/model-economics.ts" && /(profit|payroll|cost|cashflow|financial)/.test(f) && /queries\/model-economics/.test(readFileSync(f, "utf8")));
  assert.deepEqual(lot2, [], "không báo cáo tiền nào được đọc getModelEconomics");

  console.log("✓ Company OS · F (thuần): CPO hoà vốn MỘT hàm với trần danh nghĩa · ba nhãn, ba tử số · null không thành 0 · sổ chụp dự phóng · kinh tế theo mẫu có nhãn Ước tính/Thực đạt · chênh giá SX = phiếu kho − nguồn, không lọt vào lợi nhuận");
}

export async function testCompanyOsEconomicsDb(db: Db) {
  // ═══════════ PHẦN B' — SỔ: DÒNG MỚI MANG DỰ PHÓNG, DÒNG CŨ ĐỨNG NGUYÊN ═══════════
  const L = schema.adsDecisionLedger;
  const KEY = "cosf-ledger-p1";
  await db.delete(L).where(eq(L.entityKey, KEY));
  try {
    const base = ledgerRowValues(buildDecisionRow(agg({ key: KEY }), "product", 1_000_000, true), "2020-01-01", "2019-12-01", "2019-12-14");
    // Dòng "cũ": ghi như trước 0134 — không có ba cột dự phóng.
    await db.insert(L).values({ ...base, projectedProfitAfterAds: null, projectedHeadroom: null, appliedDeliveryRate: null });
    const cuTruoc = (await db.select().from(L).where(and(eq(L.entityKey, KEY), eq(L.decisionDay, "2020-01-01"))))[0];

    const moi = buildDecisionRow(
      agg({ key: KEY, openOrders: 4, inTransitOrders: 4, inTransitRevenue: 4_000_000, openProjectedRevenue: 2_400_000, openProjectedCogs: 1_200_000, openProjectedShipping: 120_000, openProjectedOrders: 2.4 }),
      "product",
      1_000_000,
      true,
    );
    await upsertLedgerValues([ledgerRowValues(moi, "2020-01-02", "2019-12-02", "2019-12-15")]);
    const hang = await db.select().from(L).where(eq(L.entityKey, KEY));
    const cuSau = hang.find((r) => r.decisionDay === "2020-01-01")!;
    const moiSau = hang.find((r) => r.decisionDay === "2020-01-02")!;
    assert.equal(hang.length, 2);
    assert.equal(moiSau.projectedProfitAfterAds, moi.projectedProfitAfterAds, "dòng mới phải mang lợi nhuận dự phóng của đúng dòng quyết định");
    assert.equal(moiSau.appliedDeliveryRate, moi.appliedDeliveryRate);
    assert.equal(moiSau.projectedHeadroom, moi.projectedHeadroom);
    assert.deepEqual(cuSau, cuTruoc, "ghi ngày mới KHÔNG được chạm dòng của ngày cũ (sổ là ảnh chụp)");
    assert.equal(cuSau.projectedProfitAfterAds, null, "dòng cũ giữ NULL — không backfill");

    // Chạy lại trong CÙNG ngày: cập nhật đúng dòng ấy, cả cột dự phóng.
    const moi2 = buildDecisionRow(agg({ key: KEY, openOrders: 4, inTransitOrders: 4, inTransitRevenue: 4_000_000, openProjectedRevenue: 3_000_000, openProjectedCogs: 1_500_000, openProjectedShipping: 120_000, openProjectedOrders: 3 }), "product", 1_000_000, true);
    await upsertLedgerValues([ledgerRowValues(moi2, "2020-01-02", "2019-12-02", "2019-12-15")]);
    const lan2 = await db.select().from(L).where(eq(L.entityKey, KEY));
    assert.equal(lan2.length, 2, "chạy lại trong ngày không đẻ dòng thứ hai");
    assert.equal(lan2.find((r) => r.decisionDay === "2020-01-02")!.projectedProfitAfterAds, moi2.projectedProfitAfterAds, "chạy lại trong ngày cập nhật cả cột dự phóng");
    assert.deepEqual(lan2.find((r) => r.decisionDay === "2020-01-01"), cuTruoc, "dòng cũ vẫn đứng nguyên sau lượt chạy lại");
  } finally {
    await db.delete(L).where(eq(L.entityKey, KEY));
  }

  // ═══════════ PHẦN C' — getModelEconomics KHÔNG TÍNH LẠI: bằng đúng hai bộ máy ═══════════
  clearMemo();
  const [nominal, decision] = await Promise.all([getNominalProfitReport(ALL, "ORDERED", NO_ORDER_VALUE_FILTER, true, false, false), getAdsDecision(ALL, "product")]);
  const chung = nominal.rows.find((r) => decision.rows.some((d) => d.key === r.productId)) ?? nominal.rows[0] ?? null;
  if (chung) {
    const m = await getModelEconomics(chung.productId, ALL);
    const d = decision.rows.find((x) => x.key === chung.productId) ?? null;
    const line = (k: EconomicsLineKey) => m.lines.find((x) => x.key === k)!;
    const n: NominalRow = chung;
    assert.equal(m.estimatedFound, true);
    assert.equal(line("orders").estimated.value, n.orders, "Ước tính · đơn = dòng danh nghĩa");
    assert.equal(line("deliveredRevenue").estimated.value, n.expectedRevenue, "Ước tính · DT giao = dòng danh nghĩa");
    assert.equal(line("adSpend").estimated.value, n.adSpend);
    assert.equal(line("contributionAfterAds").estimated.value, n.expectedProfit, "Ước tính · LN góp sau QC = expectedProfit của dòng danh nghĩa");
    assert.equal(line("netProfit").estimated.value, n.netProfit, "Ước tính · LN ròng = netProfit của dòng danh nghĩa");
    assert.equal(line("deliveryRate").estimated.value, n.deliveryRate);
    const ceil = adsCeiling({ netProfit: n.netProfit, adSpend: n.adSpend, otherCost: n.otherCost, expectedRevenue: n.expectedRevenue, posSales: n.salesAfterDiscount, orders: n.orders, otherCostPercentOfAds: nominal.assumptions.otherCostPercentOfAds ?? 0, targetMarginPct: null });
    assert.equal(line("maxAdCostPerOrderNet").estimated.value, ceil.breakEven.perOrder, "Trần CPQC/đơn danh nghĩa = đúng con số tab Lợi nhuận danh nghĩa in");
    if (d) {
      assert.equal(m.realizedFound, true);
      assert.equal(m.decisionBasis, d.basis);
      assert.equal(line("orders").realized.value, d.bookedOrders, "Thực đạt · đơn = dòng quyết định cấp mã");
      assert.equal(line("deliveredRevenue").realized.value, d.deliveredRevenue);
      assert.equal(line("breakEvenCpoContribution").realized.value, d.breakEvenCpo, "Thực đạt · CPO hoà vốn = dòng quyết định");
      assert.equal(line("breakEvenCpoContribution").projected?.value ?? null, d.projectedBreakEvenCpo);
      assert.equal(line("contributionAfterAds").realized.value, d.spendKnown ? d.profitAfterAds : null);
      assert.equal(line("contributionAfterAds").projected?.value ?? null, d.spendKnown ? d.projectedProfitAfterAds : null);
    }
    console.log(`✓ Company OS · F (CSDL): kinh tế mẫu ${chung.code || chung.productId} — Ước tính khớp báo cáo danh nghĩa${d ? ", Thực đạt khớp bảng quyết định cấp mã" : " (mã không có dòng quyết định)"}`);
  } else {
    console.log("✓ Company OS · F (CSDL): fixture không có dòng danh nghĩa nào — chỉ kiểm được nhánh rỗng");
  }
  const khongCo = await getModelEconomics("cosf-khong-ton-tai", ALL);
  assert.equal(khongCo.estimatedFound, false);
  assert.ok(khongCo.lines.every((l) => l.estimated.value === null && l.realized.value === null), "mã không có trong kỳ ⇒ mọi ô null, không phải 0");

  // ═══════════ PHẦN D' — LỆNH SX: chọn đúng lệnh gần nhất CÓ GIÁ, bỏ lệnh huỷ và lệnh 0 ₫ ═══════════
  const P = schema.productionOrders;
  // Sản phẩm RIÊNG của bài này — không phụ thuộc fixture có sẵn, và không lệnh SX nào khác trỏ vào nó.
  const sp = { id: "cosf-po-product" };
  {
    await db.delete(P).where(like(P.code, "COSF-%"));
    await db.insert(schema.products).values({ id: sp.id, name: "Mẫu F (kiểm thử chênh giá SX)" }).onConflictDoNothing();
    try {
      const t0 = new Date("2026-01-01T00:00:00Z");
      await db.insert(P).values([
        { code: "COSF-OLD", productId: sp.id, productCode: "COSF", unitCost: 50_000, status: "SENT", createdAt: t0 },
        { code: "COSF-ZERO", productId: sp.id, productCode: "COSF", unitCost: 0, status: "DRAFT", createdAt: new Date(t0.getTime() + 86_400_000) },
        { code: "COSF-NULL", productId: sp.id, productCode: "COSF", unitCost: null, status: "DRAFT", createdAt: new Date(t0.getTime() + 2 * 86_400_000) },
        { code: "COSF-CANCEL", productId: sp.id, productCode: "COSF", unitCost: 999_999, status: "CANCELLED", createdAt: new Date(t0.getTime() + 3 * 86_400_000) },
      ]);
      const bang2 = await getProductionVariance([], new Date("2026-09-20T00:00:00+07:00"));
      const dong = bang2.find((r) => r.productId === sp.id);
      assert.ok(dong, "mã chỉ có lệnh SX phải có dòng");
      assert.equal(dong.sources.PO_UNIT_COST.value, 50_000, "lệnh 0 ₫ / NULL là CHƯA NHẬP GIÁ, lệnh huỷ không tính — phải lấy lệnh 50.000 ₫");
      assert.equal(dong.baseline.value, null, "mã chưa có phiếu nhập ⇒ mốc so CHƯA BIẾT");
      assert.equal(dong.variance.PO_UNIT_COST, null, "không có mốc so ⇒ chênh CHƯA BIẾT, không phải −50.000");
    } finally {
      await db.delete(P).where(like(P.code, "COSF-%"));
      await db.delete(schema.products).where(eq(schema.products.id, sp.id));
    }
  }
}
