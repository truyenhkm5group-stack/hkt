import assert from "node:assert/strict";
import { clearMemo } from "@/lib/cache";
import {
  baseline,
  buildScenarios,
  DEFAULT_TARGET_STEPS,
  NO_LEVERS,
  skuUnit,
  soloOrdersPerDay,
  solveScenario,
  type SkuUnit,
  type TargetAssumptions,
  type TargetSku,
} from "@/lib/constants/profit-target";
import { getNominalProfitReport } from "@/lib/queries/profit-nominal";
import { getProfitTargetData } from "@/lib/queries/profit-target";
import { NO_ORDER_VALUE_FILTER } from "@/lib/constants/order-value";
import { resolvePeriod } from "@/lib/search-params";

const A: TargetAssumptions = { shipFeeDelivered: 30_000, shipFeeReturned: 60_000, taxPercent: 1.5, otherCostPercentOfAds: 5, inventoryRiskPercent: 10 };

/** 100 đơn / 30 ngày, GTC 50%, giá 500K mỗi đơn giao được, giá vốn 200K, CPO 80K. */
const MA: TargetSku = {
  productId: "p1",
  code: "Q1",
  name: "Mã 1",
  orders: 100,
  items: 120,
  expectedRevenue: 25_000_000,
  expectedCogs: 10_000_000,
  adSpend: 8_000_000,
  operatingAlloc: 2_000_000,
  fixedAlloc: 1_000_000,
  netProfit: 3_000_000,
  deliveryRate: 50,
  cogsIncomplete: false,
  stockQty: 500,
};

const gan = (a: number, b: number, msg: string, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

/**
 * ═══ KỊCH BẢN "GIỮ NGUYÊN" PHẢI RA ĐÚNG CON SỐ CỦA BÁO CÁO ═══
 *
 * Lãi góp/đơn ở đòn bẩy 0 lấy thẳng từ dòng mã; đòn bẩy chỉ cộng phần chênh. Nếu phép "chênh" lệch
 * đi (vd quên trừ thuế trên doanh thu tăng thêm) thì kịch bản 0 vẫn đúng nhưng mọi kịch bản khác
 * sai — nên kiểm cả hai phía.
 */
function testDonVi() {
  const u = skuUnit(MA, A, NO_LEVERS, 30)!;
  gan(u.contributionPerOrder * MA.orders, MA.netProfit + MA.operatingAlloc + MA.fixedAlloc, "đòn bẩy 0: lãi góp × đơn = LN ròng + phần cố định đã phân bổ");
  gan(u.ordersPerDay, 100 / 30, "đơn/ngày của kỳ gốc");

  // +10 điểm GTC: mỗi đơn thêm 0,1 đơn giao được ⇒ +50K doanh thu, +20K giá vốn, cước −(60K−30K)×0,1.
  const g = skuUnit(MA, A, { ...NO_LEVERS, gtcPoints: 10 }, 30)!;
  const rev = 50_000;
  const cogs = 20_000;
  const ship = -3_000;
  const ky = rev - cogs - ship - 0.1 * cogs - 0.015 * rev;
  gan(g.contributionPerOrder - u.contributionPerOrder, ky, "GTC +10 điểm: phần chênh đúng từng khoản (doanh thu, giá vốn, cước, rủi ro, thuế)");

  // CPO −10%: tiết kiệm 8K QC + 5% CP khác trên QC.
  const c = skuUnit(MA, A, { ...NO_LEVERS, cpoPercent: -10 }, 30)!;
  gan(c.contributionPerOrder - u.contributionPerOrder, 8_000 * 1.05, "CPO −10%: tiết kiệm QC + CP khác theo QC");
  gan(c.cpo, 72_000, "CPO mới");

  // Chưa đo được TL GTC ⇒ không tính, không coi là 0%.
  assert.equal(skuUnit({ ...MA, deliveryRate: null }, A, NO_LEVERS, 30), null);
  assert.equal(skuUnit({ ...MA, orders: 0 }, A, NO_LEVERS, 30), null);
}

function testGiai() {
  const u = skuUnit(MA, A, NO_LEVERS, 30)!;
  // Shop = mã này + phần khác lãi 1 tr − cố định 3 tr của mã (phân bổ) − cố định khác 2 tr.
  const shopNet = MA.netProfit + 1_000_000 - 2_000_000;
  const base = baseline([MA], shopNet, 5_000_000, 30);
  gan(base.shopMonthly, shopNet, "kỳ 30 ngày: một tháng = đúng kỳ");
  gan(base.selectedContributionMonthly - base.fixedMonthly + base.restMonthly, base.shopMonthly, "lãi góp + phần còn lại − cố định = LN shop");

  // Đích = LN hiện tại ⇒ gấp đúng 1 lần.
  const giu = solveScenario([u], base, base.shopMonthly, NO_LEVERS);
  gan(giu.multiplier!, 1, "đích = hiện tại ⇒ ×1");
  gan(giu.profitAtCurrentVolume, base.shopMonthly, "giữ số đơn ⇒ đúng LN hiện tại");
  gan(giu.ordersPerDay!, 100 / 30, "đơn/ngày cần = hiện tại");

  // Đích cao hơn đúng một lần lãi góp ⇒ ×2.
  const gap = solveScenario([u], base, base.shopMonthly + base.selectedContributionMonthly, NO_LEVERS);
  gan(gap.multiplier!, 2, "thêm đúng một lần lãi góp ⇒ ×2");
  gan(gap.adPerDay!, (200 / 30) * 80_000, "QC/ngày cần = đơn/ngày cần × CPO", 1e-3);
  gan(gap.perSku[0].itemsMonthlyNeeded!, 200 * 1.2, "SP cần/tháng = đơn × sp/đơn", 1e-6);

  // Một mình gánh: phần thiếu chia cho lãi góp/đơn của chính mã.
  gan(soloOrdersPerDay(u, [u], base, base.shopMonthly + base.selectedContributionMonthly)!, 200 / 30, "một mình gánh = cùng kết quả khi chỉ có một mã", 1e-9);

  // Mỗi đơn lỗ ⇒ KHÔNG ĐẠT, không phải một hệ số âm hay vô cùng.
  const lo = skuUnit({ ...MA, netProfit: -20_000_000 }, A, NO_LEVERS, 30)!;
  assert.ok(lo.contributionPerOrder < 0);
  const khongDat = solveScenario([lo], base, 100_000_000, NO_LEVERS);
  assert.equal(khongDat.multiplier, null, "lãi góp ≤ 0 ⇒ không đạt bằng cách tăng đơn");
  assert.equal(khongDat.ordersPerDay, null);
  assert.equal(soloOrdersPerDay(lo, [lo], base, 100_000_000), null, "mã lỗ/đơn không gánh được");

  // Kỳ 15 ngày ⇒ quy về tháng nhân 2.
  gan(baseline([MA], shopNet, 5_000_000, 15).shopMonthly, shopNet * 2, "kỳ 15 ngày ⇒ ×2 ra tháng");
}

function testKichBan() {
  const ds = buildScenarios(DEFAULT_TARGET_STEPS, null);
  assert.deepEqual(ds.map((s) => s.key), ["giu", "gtc", "cpo", "gia", "ca3", "xau"], "đủ kịch bản mẫu, có một kịch bản XẤU");
  assert.equal(ds.find((s) => s.key === "xau")!.levers.cpoPercent, DEFAULT_TARGET_STEPS.cpoPercent, "kịch bản xấu: CPO TĂNG");
  assert.equal(ds.find((s) => s.key === "cpo")!.levers.cpoPercent, -DEFAULT_TARGET_STEPS.cpoPercent, "kịch bản tốt: CPO GIẢM");
  const rieng = buildScenarios(DEFAULT_TARGET_STEPS, { gtcPoints: 8, cpoPercent: -15, pricePercent: 0 });
  assert.equal(rieng.at(-1)!.key, "rieng");
  assert.equal(buildScenarios(DEFAULT_TARGET_STEPS, { gtcPoints: 0, cpoPercent: 0, pricePercent: 0 }).at(-1)!.key, "xau", "kịch bản riêng toàn 0 ⇒ không thêm dòng");
  // Ô gõ nhầm bị kẹp, không ra kịch bản vô lý.
  assert.equal(buildScenarios({ gtcPoints: 500, cpoPercent: 10, pricePercent: 5 }, null).find((s) => s.key === "gtc")!.levers.gtcPoints, 50);
}

/** Trên fixture: kịch bản giữ nguyên với MỌI mã đo được ⇒ ×1 và đúng LN ròng của Báo cáo lợi nhuận. */
async function testKhopBaoCao() {
  clearMemo();
  const period = resolvePeriod({ period: "90d" });
  const [data, report] = await Promise.all([getProfitTargetData(period), getNominalProfitReport(period, "ORDERED", NO_ORDER_VALUE_FILTER, true)]);
  assert.equal(data.periodDays, 90);
  assert.equal(data.shopNetProfit, report.totals.netProfit, "LN shop lấy đúng báo cáo");
  assert.ok(data.defaultSelected.every((id) => (data.skus.find((s) => s.productId === id)?.netProfit ?? 0) > 0), "chọn sẵn chỉ gồm mã đang lãi");
  const chosen = data.skus.filter((s) => s.deliveryRate !== null);
  const base = baseline(chosen, data.shopNetProfit, data.fixedInPeriod, 90);
  const units = chosen.map((s) => skuUnit(s, data.assumptions, NO_LEVERS, 90)).filter((u): u is SkuUnit => u !== null);
  const r = solveScenario(units, base, base.shopMonthly, NO_LEVERS);
  gan(r.profitAtCurrentVolume, (report.totals.netProfit * 30) / 90, "giữ nguyên ⇒ đúng LN ròng báo cáo quy về tháng", 1e-3);
  if (units.some((u) => u.contributionPerOrder > 0) && r.multiplier !== null) gan(r.multiplier, 1, "đích = hiện tại ⇒ ×1", 1e-9);
  assert.equal(await getProfitTargetData(resolvePeriod({ period: "all" })).then((d) => d.periodDays), null, "kỳ Toàn bộ không quy được về tháng — không đoán");
}

export async function testProfitTarget() {
  testDonVi();
  testGiai();
  testKichBan();
  await testKhopBaoCao();
  console.log("✓ Kế hoạch mục tiêu LN: giữ nguyên ⇒ ×1 và đúng LN báo cáo · đòn bẩy cộng đúng phần chênh · mã lỗ/đơn ⇒ không đạt · kỳ Toàn bộ không quy đổi");
}
