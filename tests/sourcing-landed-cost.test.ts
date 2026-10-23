/**
 * ═══ SRC-4 · GIÁ VỀ VIỆT NAM ƯỚC TÍNH + ĐIỂM THÀNH PHẦN (docs/tech/ai-sourcing.md §3.3–3.4, Tech Lead duyệt 23/10/2026) ═══
 *
 * Khoá: (1) ca vàng tính tay — căn cứ phí mua hộ = GIÁ MUA, căn cứ thuế = trị giá CIF, tổng = cộng các khoản đã làm tròn; (2) KHÔNG
 * số mặc định — cấu hình rỗng ⇒ không ô nào ra số; thiếu một khoản cước của CIF ⇒ thuế thiếu, không lùi về giá mua; (3) dưới MOQ /
 * dưới bậc thấp nhất ⇒ không tính; tỷ giá cũ vẫn tính + cờ; (4) điểm nhà cung cấp KHÔNG có trọng số mặc định — chưa khai ⇒ không
 * tổng, thiếu thành phần có trọng số ⇒ không tổng; (5) khớp yêu cầu ✓ / ✗ tất định; (6) SERVE-COMPAT 0257.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { getDb, schema } from "@/db";
import { EMPTY_LANDED_COST, EMPTY_SCORE_WEIGHTS, parseScoreWeights, scoreWeightsDeclared, type LandedCostConfig, type SourcingScoreWeights } from "@/lib/constants/sourcing";
import { getSourcingCompare, latestOfferWeights } from "@/lib/queries/sourcing";
import { landedConfigEmpty, landedCostAtQty, type LandedCost } from "@/lib/sourcing/landed-cost";
import { addSourcingWeight, createSourcingOffer, type SourcingActor } from "@/lib/sourcing/offer-service";
import { requestMatch, supplierScore } from "@/lib/sourcing/score";

const P = "src4-";
const NOW = new Date("2026-10-23T05:00:00Z");
const CFG: LandedCostConfig = {
  ...EMPTY_LANDED_COST,
  cnyToVnd: 3550,
  fxAsOf: "2026-10-20",
  fxSource: "VCB",
  cnDomesticShipCny: 20,
  intlFreightVndPerKg: 30000,
  agentFeePercent: 3,
  dutyVatPercent: 10,
  otherVndPerUnit: 2000,
};
const TIERS = [
  { fromQty: 2, priceFen: 1230 },
  { fromQty: 50, priceFen: 1180 },
];
const at = (over: Partial<Parameters<typeof landedCostAtQty>[0]> = {}) => landedCostAtQty({ tiers: TIERS, moq: 2, weightG: 350, qty: 10, cfg: CFG, now: NOW, ...over });
const est = (r: LandedCost) => {
  assert.equal(r.kind, "ESTIMATE", JSON.stringify(r));
  return r as Extract<LandedCost, { kind: "ESTIMATE" }>;
};

function testFormula() {
  // Ca vàng tính tay — mua 10 cái, bậc ≥2 = ¥12.30, 350 g / cái.
  const r = est(at());
  assert.deepEqual(
    Object.fromEntries(Object.entries(r.parts).map(([k, v]) => [k, v.vnd])),
    { purchase: 43665, domestic: 7100, agentFee: 1310, freight: 10500, duty: 6127, other: 2000 },
    "12,30 × 3550 = 43.665 · 20 ¥ ÷ 10 × 3550 = 7.100 · 3% giá mua = 1.310 · 30.000 ₫/kg × 0,35 = 10.500 · 10% × CIF 61.265 = 6.127",
  );
  assert.deepEqual(r.bases, { purchaseVnd: 43665, cifVnd: 61265 }, "hai căn cứ in ra: giá mua (phí mua hộ) và CIF (thuế)");
  assert.equal(r.totalVnd, 70702, "tổng = cộng các khoản đã làm tròn");
  assert.deepEqual([r.missing, r.fxStale, r.dutyDeclaredZero], [[], false, false]);
  assert.equal(est(at({ qty: 50 })).totalVnd, 41890 + 1420 + 1257 + 10500 + 5381 + 2000, "mua 50 ⇒ bậc ≥50, cước nội địa chia 50");
  for (const k of Object.keys(r.parts) as (keyof typeof r.parts)[]) assert.ok(Number.isInteger(r.parts[k].vnd!), `${k} là số đồng nguyên`);

  // Không có số mặc định.
  const empty = est(at({ cfg: EMPTY_LANDED_COST }));
  assert.equal(empty.totalVnd, null);
  assert.ok(Object.values(empty.parts).every((p) => p.vnd === null), "cấu hình rỗng ⇒ không khoản nào ra số");
  assert.ok(landedConfigEmpty(EMPTY_LANDED_COST) && !landedConfigEmpty(CFG));
  assert.ok(empty.missing.some((m) => m.includes("Tỷ giá")) && empty.missing.some((m) => m.includes("Ngày áp tỷ giá")));

  // Thiếu cân nặng ⇒ thiếu cước TQ → VN ⇒ thuế KHÔNG lùi về giá mua.
  const noW = est(at({ weightG: null }));
  assert.deepEqual([noW.parts.freight.vnd, noW.parts.duty.vnd, noW.totalVnd, noW.bases.cifVnd], [null, null, null, null]);
  assert.equal(noW.parts.purchase.vnd, 43665, "khoản tính được vẫn hiện");
  assert.match(noW.parts.duty.missing!, /thiếu cước Trung Quốc → Việt Nam nên chưa tính được căn cứ thuế/);
  assert.ok(noW.missing.includes("chưa khai cân nặng một cái"));
  const noDom = est(at({ cfg: { ...CFG, cnDomesticShipCny: null } }));
  assert.match(noDom.parts.duty.missing!, /thiếu cước nội địa/);
  const noDuty = est(at({ cfg: { ...CFG, dutyVatPercent: null } }));
  assert.deepEqual([noDuty.parts.duty.vnd, noDuty.bases.cifVnd, noDuty.totalVnd], [null, 61265, null], "thiếu thuế ⇒ CIF vẫn in, tổng chưa có");
  const noFee = est(at({ cfg: { ...CFG, agentFeePercent: null } }));
  assert.deepEqual([noFee.parts.agentFee.vnd, noFee.parts.duty.vnd], [null, 6127], "thiếu phí mua hộ không đụng căn cứ thuế (CIF không gồm phí)");

  // Thuế 0 là KHAI (bao thuế theo kg), không phải thiếu.
  const zero = est(at({ cfg: { ...CFG, dutyVatPercent: 0 } }));
  assert.deepEqual([zero.parts.duty.vnd, zero.dutyDeclaredZero, zero.totalVnd], [0, true, 70702 - 6127]);
  const zeroOther = est(at({ cfg: { ...CFG, otherVndPerUnit: 0 } }));
  assert.equal(zeroOther.totalVnd, 70702 - 2000, "0 là «không có khoản này», không phải thiếu");

  // Không tính được.
  assert.deepEqual(at({ moq: 20 }), { kind: "BELOW_MOQ", qty: 10, moq: 20 }, "dưới MOQ ⇒ không tính (§3.3)");
  assert.deepEqual(at({ qty: 1 }), { kind: "NO_PRICE", reason: "nguồn bán từ 2 cái" });
  assert.equal(at({ tiers: null }).kind, "NO_PRICE");

  // Tỷ giá cũ ⇒ vẫn tính, kèm cờ; thiếu ngày ⇒ chưa có tổng.
  const old = est(at({ cfg: { ...CFG, fxAsOf: "2026-10-01" } }));
  assert.deepEqual([old.fxStale, old.totalVnd], [true, 70702]);
  const noDate = est(at({ cfg: { ...CFG, fxAsOf: null } }));
  assert.deepEqual([noDate.fxStale, noDate.totalVnd], [null, null]);
  assert.ok(noDate.missing.includes("chưa khai «Ngày áp tỷ giá»"));
}

function testScores() {
  assert.ok(Object.values(EMPTY_SCORE_WEIGHTS.supplier).every((v) => v === null) && EMPTY_SCORE_WEIGHTS.yearsCap === null, "KHÔNG có trọng số mặc định");
  assert.equal(scoreWeightsDeclared(EMPTY_SCORE_WEIGHTS), false);
  assert.deepEqual(parseScoreWeights({ supplier: { rating: -1, responseRate: "2", verified: 101 }, yearsCap: 0 }), { ...EMPTY_SCORE_WEIGHTS }, "số hỏng ⇒ null, không đoán");
  const facts = { ratingX100: 480, responseRateBp: 9550, verified: true, yearsOnPlatform: 6 };

  const none = supplierScore(facts, EMPTY_SCORE_WEIGHTS);
  assert.deepEqual([none.total, none.coverage], [null, { have: 4, of: 4 }]);
  assert.match(none.totalNote, /chưa khai trọng số/);
  assert.deepEqual(none.components.map((c) => c.normalized), [0.96, 0.955, 1, null], "chưa có trần ⇒ số năm chưa quy đổi được (nhưng vẫn đếm là có số)");

  const w: SourcingScoreWeights = { ...EMPTY_SCORE_WEIGHTS, supplier: { rating: 2, responseRate: 1, verified: 1, years: null } };
  assert.equal(supplierScore(facts, w).total, 97, "(2×0,96 + 0,955 + 1) ÷ 4 = 96,875 ⇒ 97");
  const lack = supplierScore({ ...facts, ratingX100: null }, w);
  assert.equal(lack.total, null, "thiếu thành phần có trọng số ⇒ không tính trên phần còn lại");
  assert.match(lack.totalNote, /thiếu: Điểm đánh giá/);
  assert.equal(supplierScore({ ...facts, yearsOnPlatform: null }, w).total, 97, "thành phần không có trọng số thiếu thì không sao");
  const yrs = supplierScore(facts, { ...w, supplier: { ...w.supplier, years: 1 } });
  assert.equal(yrs.total, null);
  assert.match(yrs.totalNote, /trần số năm/);
  assert.equal(supplierScore(facts, { ...w, supplier: { ...w.supplier, years: 1 }, yearsCap: 5 }).total, Math.round(((2 * 0.96 + 0.955 + 1 + 1) / 5) * 100), "số năm vượt trần ⇒ 1");
  assert.deepEqual(supplierScore(null, w).coverage, { have: 0, of: 4 });

  const m = requestMatch("đầm suông che bụng cho mẹ", "2024夏季新款妈妈装宽松连衣裙中老年女装");
  assert.deepEqual(m, {
    kind: "MATCH",
    terms: [
      { label: "Đầm", zh: "连衣裙", hit: true },
      { label: "Dáng suông", zh: "宽松", hit: true },
      { label: "Che bụng", zh: "遮肚显瘦", hit: false },
      { label: "Cho mẹ", zh: "妈妈装", hit: true },
    ],
    unmatched: [],
  });
  assert.deepEqual(requestMatch("đầm cho mẹ", "  中老年女装 连衣裙 "), { kind: "MATCH", terms: [{ label: "Đầm", zh: "连衣裙", hit: true }, { label: "Cho mẹ", zh: "中老年女装", hit: true }], unmatched: [] }, "từ đồng nghĩa của ý cũng tính là khớp");
  assert.deepEqual([requestMatch("", "x").kind, requestMatch("đầm", " ").kind], ["NO_REQUEST", "NO_TITLE"]);
}

async function testDb() {
  const db = await getDb();
  await db.insert(schema.users).values({ id: `${P}u1`, email: "src4@test", name: "Người tìm hàng", passwordHash: "x", role: "MANAGER" }).onConflictDoNothing();
  const actor: SourcingActor = { id: `${P}u1`, email: "src4@test" };
  const offer = await createSourcingOffer(actor, { url: "https://detail.1688.com/offer/644444444444.html", titleVi: "Đầm cân nặng", titleZh: "", imageUrl: "", supplierShopUrl: "", supplierName: "", tiers: [{ fromQty: 2, price: "12.30" }], moq: 2, colors: "", sizes: "" });
  assert.ok(offer.ok, JSON.stringify(offer));
  const id = offer.id;
  assert.deepEqual((await latestOfferWeights([id])).byOffer.get(id), undefined, "chưa khai ⇒ không có dòng (không phải 0 g)");
  assert.ok((await addSourcingWeight(actor, { offerId: id, grams: 350 })).ok);
  assert.ok((await addSourcingWeight(actor, { offerId: id, grams: 400 })).ok);
  const bad = await addSourcingWeight(actor, { offerId: id, grams: 0 });
  assert.ok(!bad.ok && /ít nhất 1 g/.test(bad.errors[0].message));
  const hist = await latestOfferWeights([id], 10);
  assert.deepEqual(hist.byOffer.get(id)?.map((w) => w.grams), [400, 350], "chỉ thêm dòng, lần mới nhất đứng đầu");
  assert.equal((await latestOfferWeights([id])).byOffer.get(id)?.[0].grams, 400);

  // SERVE-COMPAT 0257: bảng chưa có ⇒ đọc «chưa có cân nặng», ghi trả câu lỗi, kho mẫu vẫn chạy.
  await db.execute(sql.raw(`ALTER TABLE sourcing_offer_weights RENAME TO sourcing_offer_weights_tam`));
  try {
    const r = await latestOfferWeights([id]);
    assert.deepEqual([r.unavailable, r.byOffer.size], [true, 0]);
    const w = await addSourcingWeight(actor, { offerId: id, grams: 500 });
    assert.ok(!w.ok && /chưa áp migration 0257/.test(w.errors[0].message));
    const cmp = await getSourcingCompare([id]);
    assert.ok(!cmp.unavailable && cmp.items.length === 1, "kho mẫu không phụ thuộc bảng cân nặng");
  } finally {
    await db.execute(sql.raw(`ALTER TABLE sourcing_offer_weights_tam RENAME TO sourcing_offer_weights`));
  }
  await db.delete(schema.sourcingOfferWeights);
  await db.delete(schema.sourcingOfferSnapshots);
  await db.delete(schema.sourcingOffers);
  await db.delete(schema.sourcingSuppliers);
}

function testSourceFences() {
  const lc = readFileSync("lib/sourcing/landed-cost.ts", "utf8");
  assert.ok(!/\?\?\s*\d/.test(lc) && !/\b3550\b|\b30000\b/.test(lc), "công thức không có số mặc định nào");
  assert.ok(lc.includes("fenToVnd(") && !/priceFen\s*[*/]/.test(lc), "quy đổi CNY → VND chỉ qua lib/sourcing/price.ts");
  const files = execFileSync("git", ["ls-files", "lib", "app", "components", "scripts"], { encoding: "utf8" }).split("\n").filter((f) => /\.tsx?$/.test(f));
  const users = files.filter((f) => readFileSync(f, "utf8").includes("landedCostAtQty("));
  assert.deepEqual(users.filter((f) => !f.startsWith("app/(dashboard)/sourcing/") && f !== "lib/sourcing/landed-cost.ts"), [], "giá về VN chỉ để HIỂN THỊ — không action / job / truy vấn nào dùng nó");
  for (const f of users) assert.ok(!/setEstimatedCost|unitCost|insert\(/.test(readFileSync(f, "utf8")), `${f}: không ghi giá về VN vào giá dự tính / giá vốn`);
  const svc = readFileSync("lib/sourcing/offer-service.ts", "utf8");
  assert.ok(!/update\(schema\.sourcingOfferWeights\)|delete\(schema\.sourcingOfferWeights\)/.test(svc), "cân nặng chỉ thêm dòng");
}

export async function testSourcingLandedCost() {
  testFormula();
  testScores();
  await testDb();
  testSourceFences();
  console.log("  ✓ SRC-4 giá về VN ước tính: ca vàng tính tay 70.702 ₫ (phí mua hộ trên giá mua · thuế trên CIF) · không số mặc định · thiếu cước ⇒ thuế thiếu, không lùi về giá mua · dưới MOQ không tính · tỷ giá cũ vẫn tính + cờ · điểm NCC không trọng số mặc định · khớp ✓/✗ · chưa áp 0257 không sập");
}
