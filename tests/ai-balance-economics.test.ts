/**
 * SỐ DƯ AI TRONG KINH TẾ ĐƠN VỊ /platform + BẢNG KÊ (docs/saas/AI_BALANCE_V1.md §5 · DoD «/platform hiện doanh thu, chi phí, biên»).
 *
 *  1. THUẦN — `overageNetOfBalance` / `billNetOfBalance`: dòng «khách AI vượt» trừ ĐÚNG số khách đã thu qua sổ cái của kỳ
 *     (không theo cờ — review N2), phần chưa trừ tính theo khối, không đọc được sổ ⇒ CHƯA BIẾT. `revenueWithAiBalance`: MỘT
 *     công thức cho mọi tổ chức (chưa dùng Số dư ⇒ đúng công thức cũ), tiền thật đã dùng − khoản đảo là doanh thu, chiếu cùng
 *     nhịp với chi phí AI; tiền tặng / tiền nạp / điều chỉnh không vào. `aiBalanceTotals` + `platformGrossMargin` (review #648
 *     H1): số CHÍNH XÁC với mọi vế khác 0 và khác nhau — đổi vế nào cũng đỏ.
 *  2. SỔ — `readAiBalancePeriod` / `readAiCustomerChargedUnits`: kỳ `[from, to)` (mốc đầu tính, mốc cuối không), số dư tính mọi
 *     dòng TRƯỚC `to`, đếm khách AI theo dòng nguồn AI_CUSTOMER, khoản đảo (ADJUSTMENT nguồn AI_CUSTOMER) tách khỏi điều chỉnh
 *     tay (nguồn OPERATOR), tổ chức không có dòng sổ thì KHÔNG có mặt (khác «có, bằng 0»). Mốc là mốc tường minh truyền vào hàm —
 *     hàm không đọc đồng hồ (AGENTS mục 50/65).
 *
 * Vòng thật (tổ chức Growth trừ số dư, tắt cờ rồi đọc lại bảng kê · hoá đơn ước tính · khung /platform/saas) nằm cuối
 * `tests/ai-balance-usage.test.ts`.
 */
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";
import { getPlatformDb, schema } from "@/db";
import { postAiLedgerEntry, readAiBalancePeriod, readAiCustomerChargedUnits } from "@/lib/billing/ai-balance";
import { aiBalanceRevenueVnd, EMPTY_AI_BALANCE_PERIOD, type AiBalancePeriod, type AiFundsClass, type AiLedgerEntryType, type AiLedgerSource } from "@/lib/billing/ai-balance-rules";
import { aiBalanceTotals, platformGrossMargin, revenueWithAiBalance, tenantMarginRisk } from "@/lib/pricing/economics";
import { billNetOfBalance, overageNetOfBalance, type BillEstimate, type OverageLine, type OverageResult } from "@/lib/pricing/versions";

const X = "aibe-x";
const Y = "aibe-y";
const Z = "aibe-z";

// ─────────────────────────── 1 · THUẦN ───────────────────────────

/** Gói thử: gồm 3.000 khách AI, khối 100 khách = 49.000đ. */
const BLOCK = 100;
const BLOCK_VND = 49_000;

function line(key: OverageLine["key"], amountVnd: number | null, extra: Partial<OverageLine> = {}): OverageLine {
  return { key, label: key, used: null, included: null, overUnits: null, blocks: null, unitVnd: null, amountVnd, note: null, ...extra };
}

/** Dòng khách AI vượt `over` khách (null = đồng hồ chưa đo trọn kỳ). */
function aiLine(over: number | null, unitVnd: number | null = BLOCK_VND): OverageLine {
  const blocks = over === null ? null : Math.ceil(over / BLOCK);
  return line("aiCustomers", blocks === null ? null : blocks === 0 ? 0 : unitVnd === null ? null : blocks * unitVnd, { used: over === null ? null : 3_000 + over, included: 3_000, overUnits: over, blocks, unitVnd });
}

function overage(lines: OverageLine[]): OverageResult {
  const known = lines.filter((l) => l.amountVnd !== null);
  const knownVnd = known.reduce((s, l) => s + (l.amountVnd ?? 0), 0);
  const unknownLines = lines.length - known.length;
  return { mode: "BILLED", lines, totalVnd: unknownLines ? null : knownVnd, knownVnd, unknownLines, note: null };
}

const bal = (over: Partial<AiBalancePeriod>): AiBalancePeriod => ({ ...EMPTY_AI_BALANCE_PERIOD, ...over });

function testNetting() {
  const ov = overage([aiLine(130), line("fanpages", 0), line("users", 100_000)]);
  assert.equal(ov.totalVnd, 198_000, "dựng đúng: 130 khách vượt ⇒ 2 khối = 98.000đ + 100.000đ người dùng thêm");
  assert.equal(overageNetOfBalance(ov, 0, BLOCK), ov, "chưa thu khách nào qua Số dư ⇒ giữ nguyên đối tượng");
  const ai = (o: OverageResult) => o.lines.find((l) => l.key === "aiCustomers")!;

  const all = overageNetOfBalance(ov, 130, BLOCK);
  assert.deepEqual([ai(all).overUnits, ai(all).blocks, ai(all).amountVnd, all.totalVnd, all.knownVnd, all.unknownLines], [0, 0, 0, 100_000, 100_000, 0], "130/130 khách đã thu qua Số dư ⇒ dòng khách AI 0đ, dòng khác giữ nguyên");
  assert.match(ai(all).note ?? "", /đã thu qua Số dư AI 130 khách/);
  const part = overageNetOfBalance(ov, 30, BLOCK);
  assert.deepEqual([ai(part).overUnits, ai(part).blocks, ai(part).amountVnd, part.totalVnd], [100, 1, BLOCK_VND, 149_000], "30 khách thu qua Số dư (bật cờ giữa tháng) ⇒ 100 khách trước đó tính đúng 1 khối");
  assert.deepEqual([ai(overageNetOfBalance(ov, 129, BLOCK)).overUnits, ai(overageNetOfBalance(ov, 129, BLOCK)).amountVnd], [1, BLOCK_VND], "phần chưa trừ vẫn tính theo KHỐI như bảng giá (1 khách ⇒ 1 khối)");
  assert.equal(ai(overageNetOfBalance(ov, 500, BLOCK)).amountVnd, 0, "đã thu nhiều hơn đồng hồ đếm ⇒ 0, không âm");
  const unread = overageNetOfBalance(ov, null, BLOCK);
  assert.deepEqual([ai(unread).amountVnd, unread.totalVnd, unread.unknownLines], [null, null, 1], "không đọc được sổ ⇒ dòng khách AI CHƯA BIẾT — không chốt bảng kê bằng số đoán");
  assert.match(ai(unread).note ?? "", /chưa đọc được sổ Số dư AI/);
  const partial = overageNetOfBalance(overage([aiLine(null), line("fanpages", 0)]), 5, BLOCK);
  assert.deepEqual([ai(partial).amountVnd, partial.totalVnd], [null, null], "đồng hồ chưa đo trọn kỳ ⇒ vẫn chưa biết, chỉ thêm ghi chú");
  assert.match(ai(partial).note ?? "", /đã thu qua Số dư AI 5 khách/);
  const noPrice = overage([aiLine(130, null), line("users", 0)]);
  assert.deepEqual([ai(overageNetOfBalance(noPrice, 30, BLOCK)).amountVnd, ai(overageNetOfBalance(noPrice, 130, BLOCK)).amountVnd], [null, 0], "phiên bản chưa khai đơn giá khối: còn khách chưa trừ ⇒ chưa biết; trừ hết ⇒ 0");
  const noAi = overage([line("fanpages", 0), line("users", 0)]);
  assert.equal(overageNetOfBalance(noAi, 130, BLOCK), noAi, "gói không có dòng khách AI ⇒ giữ nguyên");
  // LOW-2: sổ đọc hỏng mà CHƯA vượt phần gồm ⇒ 0đ vẫn BIẾT (khách trong phần gồm không thấy hoá đơn «—»); ghi chú gốc giữ lại.
  const within = overage([aiLine(0), line("users", 0)]);
  assert.equal(overageNetOfBalance(within, null, BLOCK), within, "chưa vượt ⇒ không cần sổ");
  const noted = overage([{ ...aiLine(130, null), note: "phiên bản giá chưa khai đơn giá khối" }]);
  assert.match(ai(overageNetOfBalance(noted, 30, BLOCK)).note ?? "", /^phiên bản giá chưa khai đơn giá khối · đã thu qua Số dư AI 30 khách/, "ghi chú gốc không bị đè");

  const bill: BillEstimate = { planVnd: 990_000, overage: ov, totalVnd: 990_000 + 198_000, note: null };
  assert.deepEqual([billNetOfBalance(bill, 130, BLOCK).totalVnd, billNetOfBalance(bill, 30, BLOCK).totalVnd, billNetOfBalance(bill, null, BLOCK).totalVnd], [1_090_000, 1_139_000, null]);
  assert.equal(billNetOfBalance(bill, 0, BLOCK), bill, "chưa thu khách nào ⇒ hoá đơn giữ nguyên");
}

function testRevenue() {
  const ov = overage([aiLine(130), line("fanpages", 0), line("users", 100_000)]);
  // Chưa dùng Số dư ⇒ y nguyên công thức cũ (MRR · MRR + phần vượt ước tính) — cả khi có chiếu (doanh thu Số dư 0đ).
  const none = revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: null, blockSize: BLOCK });
  assert.deepEqual([none.realizedVnd, none.projectedVnd, none.overage], [1_490_000, 1_688_000, ov]);
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: null, blockSize: BLOCK, projection: { elapsedDays: 10, totalDays: 30 } }).projectedVnd, 1_688_000);
  // LOW-1: chưa dùng Số dư ⇒ ngày 1–2 của tháng vẫn ĐÚNG công thức cũ (0đ chiếu là 0đ, không thành «—»).
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: null, blockSize: BLOCK, projection: { elapsedDays: 2, totalDays: 30 } }).projectedVnd, 1_688_000);
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: EMPTY_AI_BALANCE_PERIOD, blockSize: BLOCK, projection: { elapsedDays: 1, totalDays: 31 } }).projectedVnd, 1_688_000);
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: overage([aiLine(null), line("users", 0)]), balance: null, blockSize: BLOCK }).projectedVnd, null, "cũ: dòng khách AI chưa biết ⇒ chiếu —");

  // Có Số dư: mọi vế khác 0 và khác nhau. 130 khách vượt đều đã thu qua sổ ⇒ dòng khách AI 0đ; doanh thu Số dư = tiền thật đã
  // dùng − khoản đảo (73.500 − 980); tiền tặng / tiền nạp / điều chỉnh tay / số dư KHÔNG vào.
  const b = bal({ usageCashVnd: 73_500, usagePromoVnd: 24_500, reversalCashVnd: 980, adjustCashVnd: 7_000, topupVnd: 1_000_000, aiCustomerUnits: 130, balanceCashVnd: 926_500, balancePromoVnd: 25_500 });
  assert.equal(aiBalanceRevenueVnd(b), 72_520);
  assert.equal(aiBalanceRevenueVnd(null), 0);
  const r = revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: b, blockSize: BLOCK });
  assert.deepEqual([r.realizedVnd, r.projectedVnd, r.overage?.totalVnd], [1_490_000 + 72_520, 1_490_000 + 100_000 + 72_520, 100_000], "không chiếu: MRR + phần vượt chưa thu + doanh thu Số dư tới nay");
  const rp = revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: b, blockSize: BLOCK, projection: { elapsedDays: 10, totalDays: 30 } });
  assert.deepEqual([rp.realizedVnd, rp.projectedVnd], [1_490_000 + 72_520, 1_490_000 + 100_000 + 219_520], "chiếu: phần tiền thật ĐÃ DÙNG theo nhịp 10/30 ngày (73.500 × 3), khoản đảo 980 trừ NGUYÊN (sự kiện một lần)");
  // LOW-3: doanh thu cho «nguy cơ âm biên» = MRR + doanh thu Số dư CHIẾU (cùng chân trời với chi phí AI chiếu), không gồm phần
  // vượt ước tính của bảng kê; chưa đủ ngày để chiếu ⇒ tới nay.
  assert.deepEqual(
    [rp.riskRevenueVnd, r.riskRevenueVnd, revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: b, blockSize: BLOCK, projection: { elapsedDays: 2, totalDays: 30 } }).riskRevenueVnd, none.riskRevenueVnd, revenueWithAiBalance({ mrrVnd: null, overage: ov, balance: b, blockSize: BLOCK }).riskRevenueVnd],
    [1_490_000 + 219_520, 1_490_000 + 72_520, 1_490_000 + 72_520, 1_490_000, null],
  );
  // Review follow-up LOW-2: tháng chỉ có KHOẢN ĐẢO (đảo khoản của tháng trước), chưa dùng gì ⇒ trừ nguyên −30.000, không chiếu thành
  // −90.000 «cả tháng».
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: null, balance: { ...EMPTY_AI_BALANCE_PERIOD, reversalCashVnd: 30_000 }, blockSize: BLOCK, projection: { elapsedDays: 10, totalDays: 30 } }).riskRevenueVnd, 1_460_000);
  // «Nguy cơ âm biên» so chi phí CHIẾU với doanh thu CHIẾU: MRR 100.000đ + Số dư tới nay 50.000đ (ngày 10/30 ⇒ chiếu 150.000đ),
  // chi phí AI chiếu 200.000đ ⇒ OK (250.000đ), không phải NEGATIVE như khi so với doanh thu tới nay (150.000đ).
  const riskRev = revenueWithAiBalance({ mrrVnd: 100_000, overage: null, balance: { ...EMPTY_AI_BALANCE_PERIOD, usageCashVnd: 50_000 }, blockSize: BLOCK, projection: { elapsedDays: 10, totalDays: 30 } });
  assert.deepEqual([riskRev.realizedVnd, riskRev.riskRevenueVnd], [150_000, 250_000]);
  assert.deepEqual(
    [tenantMarginRisk(riskRev, 60_000, 200_000), tenantMarginRisk(riskRev, 60_000, 260_000), tenantMarginRisk(riskRev, 0, 200_000), tenantMarginRisk({ ...riskRev, riskRevenueVnd: null }, 60_000, 200_000)],
    ["OK", "NEGATIVE", "NO_COST", "UNKNOWN"],
  );
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: b, blockSize: BLOCK, projection: { elapsedDays: 2, totalDays: 30 } }).projectedVnd, null, "chưa đủ ngày để chiếu ⇒ —");
  // Bật cờ giữa tháng: 100 khách trước đó chưa trừ ⇒ còn 1 khối trong doanh thu chiếu (bảng kê cũng thu đúng khối ấy).
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: ov, balance: { ...b, aiCustomerUnits: 30 }, blockSize: BLOCK }).projectedVnd, 1_490_000 + 49_000 + 100_000 + 72_520);
  // Cờ bật mà lượt trừ hỏng (0 dòng sổ) ⇒ khách vượt vẫn nằm trong phần vượt (bảng kê thu) — không biến mất.
  assert.equal(revenueWithAiBalance({ mrrVnd: 990_000, overage: ov, balance: EMPTY_AI_BALANCE_PERIOD, blockSize: BLOCK }).projectedVnd, 990_000 + 198_000);
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: overage([aiLine(null), line("users", 0)]), balance: b, blockSize: BLOCK }).projectedVnd, null, "đồng hồ khách AI chưa trọn kỳ ⇒ chiếu — (không đoán); ghi nhận vẫn có");
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: overage([aiLine(null), line("users", 0)]), balance: b, blockSize: BLOCK }).realizedVnd, 1_490_000 + 72_520);
  assert.equal(revenueWithAiBalance({ mrrVnd: 1_490_000, overage: overage([aiLine(130), line("fanpages", null)]), balance: b, blockSize: BLOCK }).projectedVnd, null, "dòng vượt KHÁC còn chưa biết ⇒ —");
  assert.equal(revenueWithAiBalance({ mrrVnd: 990_000, overage: overage([]), balance: b, blockSize: BLOCK }).projectedVnd, 990_000 + 72_520, "gói không có dòng vượt (tổng 0) ⇒ MRR + doanh thu Số dư");
  assert.equal(revenueWithAiBalance({ mrrVnd: 990_000, overage: null, balance: b, blockSize: BLOCK }).projectedVnd, null, "không có giá gói ⇒ —");
  assert.deepEqual([revenueWithAiBalance({ mrrVnd: null, overage: ov, balance: b, blockSize: BLOCK }).realizedVnd, revenueWithAiBalance({ mrrVnd: null, overage: ov, balance: b, blockSize: BLOCK }).projectedVnd], [null, null], "chưa biết MRR ⇒ —, không in riêng tiền AI như thể là doanh thu cả kỳ");
}

function testPlatformTotals() {
  // A trong khung · S đình chỉ (ngoài khung, còn tiền) · O trong khung, số dư ÂM · H là nhà (bỏ hẳn).
  const balances = new Map<string, AiBalancePeriod>([
    ["A", bal({ topupVnd: 1_000_000, usageCashVnd: 73_500, usagePromoVnd: 24_500, reversalCashVnd: 980, adjustCashVnd: 2_000, aiCustomerUnits: 150, balanceCashVnd: 926_500, balancePromoVnd: 25_500 })],
    ["S", bal({ topupVnd: 2_000_000, usageCashVnd: 300_000, balanceCashVnd: 1_700_000, balancePromoVnd: 3_000 })],
    ["O", bal({ usageCashVnd: 1_470, aiCustomerUnits: 3, balanceCashVnd: -470 })],
    ["H", bal({ topupVnd: 9_000, usageCashVnd: 9_000, balanceCashVnd: 5_000, balancePromoVnd: 7_000 })],
  ]);
  assert.deepEqual(aiBalanceTotals({ balances, tenantCodes: new Set(["A", "O", "NO_LEDGER"]), homeCode: "H" }), {
    topupVnd: 1_000_000,
    usageCashVnd: 74_970,
    usagePromoVnd: 24_500,
    reversalCashVnd: 980,
    adjustCashVnd: 2_000,
    revenueVnd: 72_520 + 1_470,
    orgs: 2,
    heldCashVnd: 926_500 + 1_700_000,
    owedCashVnd: 470,
    heldPromoVnd: 25_500 + 3_000,
    heldOrgs: 3,
  }, "dòng tiền kỳ chỉ của tổ chức trong khung; số dư đang giữ của MỌI tổ chức trừ nhà (kể cả đình chỉ); số dư âm là khách đang nợ, không bù trừ");

  assert.deepEqual(
    platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 100_000, aiBalanceReversalToDateVnd: 0, elapsedDays: 10, totalDays: 30, projectedAiCostVnd: 500_000, infraVnd: 300_000 }),
    { marginRevenueVnd: 2_300_000, grossProfitVnd: 1_500_000, grossMarginPct: (1_500_000 / 2_300_000) * 100 },
    "doanh thu = MRR + doanh thu Số dư CHIẾU (100.000 × 30/10); lãi = − AI chiếu − hạ tầng",
  );
  assert.deepEqual(platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 100_000, aiBalanceReversalToDateVnd: 0, elapsedDays: 10, totalDays: 30, projectedAiCostVnd: 500_000, infraVnd: null }), { marginRevenueVnd: 2_300_000, grossProfitVnd: null, grossMarginPct: null }, "chưa khai hạ tầng ⇒ lãi —");
  assert.deepEqual(platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 0, aiBalanceReversalToDateVnd: 0, elapsedDays: 10, totalDays: 30, projectedAiCostVnd: null, infraVnd: 300_000 }).grossProfitVnd, null, "chưa chiếu được chi phí AI ⇒ —");
  assert.deepEqual(platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 100_000, aiBalanceReversalToDateVnd: 0, elapsedDays: 2, totalDays: 30, projectedAiCostVnd: 500_000, infraVnd: 300_000 }), { marginRevenueVnd: null, grossProfitVnd: null, grossMarginPct: null }, "chưa đủ ngày để chiếu ⇒ —");
  assert.equal(platformGrossMargin({ mrrPayingVnd: 0, aiBalanceRevenueToDateVnd: 0, aiBalanceReversalToDateVnd: 0, elapsedDays: 10, totalDays: 30, projectedAiCostVnd: 500_000, infraVnd: 300_000 }).grossProfitVnd, null, "chưa có doanh thu ⇒ không chia cho 0");
  assert.equal(platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 0, aiBalanceReversalToDateVnd: 0, elapsedDays: 2, totalDays: 30, projectedAiCostVnd: null, infraVnd: 300_000 }).marginRevenueVnd, 2_000_000, "LOW-1: chưa dùng Số dư ⇒ doanh thu biên = MRR ngay từ ngày đầu tháng");
  // Review follow-up LOW-2: doanh thu tới nay 70.000 = dùng 100.000 − đảo 30.000 ⇒ chiếu phần DÙNG (300.000) rồi trừ đảo nguyên.
  assert.equal(platformGrossMargin({ mrrPayingVnd: 2_000_000, aiBalanceRevenueToDateVnd: 70_000, aiBalanceReversalToDateVnd: 30_000, elapsedDays: 10, totalDays: 30, projectedAiCostVnd: 500_000, infraVnd: 300_000 }).marginRevenueVnd, 2_270_000);
}

// ─────────────────────────── 2 · SỔ ───────────────────────────

async function cleanup() {
  const pdb = await getPlatformDb();
  await pdb.delete(schema.platformAiLedgerEntries).where(inArray(schema.platformAiLedgerEntries.orgCode, [X, Y, Z]));
}

async function testLedgerPeriod() {
  const pdb = await getPlatformDb();
  const from = new Date("2026-09-30T17:00:00Z"); // 00:00 01/10 giờ VN
  const to = new Date("2026-10-08T05:00:00Z");
  const H = 3_600_000;
  let n = 0;
  const post = (orgCode: string, entryType: AiLedgerEntryType, fundsClass: AiFundsClass, amountVnd: number, occurredAt: Date, sourceType: AiLedgerSource = "SYSTEM") =>
    postAiLedgerEntry(pdb, { orgCode, entryType, fundsClass, amountVnd, idempotencyKey: `aibe-test:${orgCode}:${++n}`, sourceType, occurredAt });

  await post(X, "TOPUP", "CASH", 1_000_000, new Date(from.getTime() - 24 * H)); // trước kỳ: chỉ vào số dư
  await post(X, "AI_USAGE", "CASH", -490, new Date(from.getTime() - H), "AI_CUSTOMER"); // trước kỳ: số dư, không vào doanh thu / số khách kỳ
  await post(X, "AI_USAGE", "CASH", -490, from, "AI_CUSTOMER"); // đúng mốc đầu ⇒ TRONG kỳ · khách 1
  await post(X, "TOPUP", "CASH", 500_000, new Date(from.getTime() + 24 * H));
  await post(X, "PROMO_CREDIT", "PROMO", 50_000, new Date(from.getTime() + 24 * H));
  await post(X, "AI_USAGE", "CASH", -490, new Date(from.getTime() + 48 * H)); // nguồn khác AI_CUSTOMER: tiền, không phải số khách
  await post(X, "AI_USAGE", "PROMO", -490, new Date(from.getTime() + 72 * H), "AI_CUSTOMER"); // khách 2 (tiền tặng — vẫn là khách đã thu)
  await post(X, "REFUND", "CASH", -100_000, new Date(from.getTime() + 96 * H)); // hoàn tiền: giảm số dư, không phải doanh thu âm
  await post(X, "ADJUSTMENT", "CASH", 2_000, new Date(from.getTime() + 96 * H), "OPERATOR"); // điều chỉnh tay: tiền giữ, không phải doanh thu
  await post(X, "ADJUSTMENT", "CASH", 490, new Date(from.getTime() + 100 * H), "AI_CUSTOMER"); // ĐẢO khoản trừ oan
  await post(X, "AI_USAGE", "CASH", -490, to, "AI_CUSTOMER"); // đúng mốc cuối ⇒ NGOÀI kỳ
  await post(X, "TOPUP", "CASH", 200_000, new Date(to.getTime() + 24 * H)); // ghi sau mốc đọc ⇒ không đổi kỳ đang xem
  await post(Y, "ADJUSTMENT", "PROMO", 10_000, new Date(from.getTime() + 24 * H), "OPERATOR");

  const m = await readAiBalancePeriod(from, to);
  assert.deepEqual(m.get(X), {
    topupVnd: 500_000,
    usageCashVnd: 980,
    usagePromoVnd: 490,
    reversalCashVnd: 490,
    adjustCashVnd: 2_000,
    aiCustomerUnits: 2,
    balanceCashVnd: 1_000_000 - 490 - 490 + 500_000 - 490 - 100_000 + 2_000 + 490,
    balancePromoVnd: 50_000 - 490,
  });
  assert.equal(aiBalanceRevenueVnd(m.get(X)!), 490, "doanh thu kỳ = 980 tiền thật đã dùng − 490 đã đảo");
  assert.deepEqual(m.get(Y), { ...EMPTY_AI_BALANCE_PERIOD, balancePromoVnd: 10_000 }, "điều chỉnh tiền tặng: số dư, không phải tiền nạp / điều chỉnh tiền thật / doanh thu");
  assert.equal(m.has(Z), false, "tổ chức chưa có dòng sổ nào không có mặt — khác «có, bằng 0»");
  assert.deepEqual([await readAiCustomerChargedUnits(X, from, to), await readAiCustomerChargedUnits(Y, from, to), await readAiCustomerChargedUnits(Z, from, to)], [2, 0, 0], "số khách AI đã thu qua Số dư của MỘT tổ chức trong kỳ");

  // Đọc lại kỳ cũ sau khi sổ có thêm dòng mới ⇒ cùng số (chỉ đọc, không đổi kỳ đã xem).
  await post(X, "AI_USAGE", "CASH", -490, new Date(to.getTime() + 2 * H), "AI_CUSTOMER");
  assert.deepEqual((await readAiBalancePeriod(from, to)).get(X), m.get(X));
  assert.equal(await readAiCustomerChargedUnits(X, from, to), 2);
}

export async function testAiBalanceEconomics() {
  testNetting();
  testRevenue();
  testPlatformTotals();
  await cleanup();
  try {
    await testLedgerPeriod();
  } finally {
    await cleanup();
  }
  console.log(
    "✓ Số dư AI trong kinh tế đơn vị + bảng kê: dòng khách AI vượt trừ ĐÚNG số khách đã thu qua sổ của kỳ (không theo cờ), phần chưa trừ tính theo khối, sổ không đọc được ⇒ chưa biết · một công thức doanh thu cho mọi tổ chức (chưa dùng Số dư ⇒ đúng công thức cũ), tiền thật đã dùng − khoản đảo, chiếu cùng nhịp chi phí AI · tổng nền tảng: dòng tiền của tổ chức trong khung, số dư đang giữ của MỌI tổ chức trừ nhà, số dư âm tách riêng · lãi gộp số chính xác · sổ đọc theo kỳ [đầu, cuối), đếm khách theo nguồn AI_CUSTOMER, khoản đảo tách điều chỉnh tay",
  );
}
