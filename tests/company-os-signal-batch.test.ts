import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { getModelSignal, getModelSignalsBatch, type ModelSignalBatch } from "@/lib/queries/model-signal";
import { resolvePeriod, type Period } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT S · TÍN HIỆU MẪU THEO LÔ ═══════════
 *
 * Bài khoá một điều: `getModelSignalsBatch(range)` cho ĐÚNG kết quả `getModelSignal(model, range)` của
 * từng mẫu — cùng tín hiệu, cùng tầng quyết định, cùng lý do từng nguồn (kể cả câu chi tiết mang số đếm),
 * cùng xung đột, cùng nhãn kỳ. Lô chỉ được khác ở CÁCH ĐỌC (mỗi nguồn một lượt cho cả shop), không bao
 * giờ ở phép gộp.
 *
 * Fixture tự gieo phủ các nhánh dễ lệch khi đọc cả shop rồi cắt theo mã:
 *  · mẫu không sản phẩm, không gì cả ⇒ CẦN THÊM DỮ LIỆU;
 *  · thiết kế LOẠI + khai THẮNG ⇒ LOẠI kèm xung đột trạng thái khai;
 *  · creative THẮNG (phán cũ) nhưng phán MỚI NHẤT là LOẠI, cùng một mẩu THẮNG khác, thiết kế LOẠI ⇒ xung
 *    đột tầng thử (bắt đảo thứ tự "mới nhất");
 *  · hai mã có đơn trong kỳ, mỗi mã có một dòng đơn KHÔNG mẫu mã ⇒ đọc cả shop mà gộp theo riêng mẫu mã
 *    thì hai dòng này dính vào nhau (bắt bỏ `splitByProduct`);
 *  · một mã đã ghép chi, một mã chưa ghép (chi chưa ghép ⇒ "chưa đủ", bắt đọc sai tập mã đã ghép);
 *  · topic mở / topic đã đóng (sản xuất chỉ để nơi dùng lọc, đếm 0 thật).
 *
 * Rồi so hai đường trên MỌI mẫu trong CSDL kiểm thử (gồm cả mẫu các bài trước để lại) qua ba kỳ, không
 * xoá đệm giữa các kỳ — khoá đệm thiếu kỳ thì kỳ sau đọc nhầm kết quả kỳ trước và bài đỏ.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): kỳ chính là năm 2004 CỐ ĐỊNH trên dữ liệu gieo ngày CỐ ĐỊNH;
 * hai kỳ "toàn bộ" và "30 ngày" chỉ dùng để so hai đường với nhau (cùng một đối tượng kỳ cho cả hai),
 * không khẳng định con số nào theo ngày hôm nay.
 */

const P = "cos-s-";
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const KY_2004: Period = { key: "custom", from: new Date("2004-01-01T00:00:00Z"), to: new Date("2004-12-31T23:59:59Z"), label: "Năm 2004", fromKey: "2004-01-01", toKey: "2004-12-31" };

async function donDep(db: Db) {
  const models = await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.code, "COSS-%"));
  const ids = models.map((m) => m.id);
  if (ids.length) {
    await db.delete(schema.productionTopics).where(inArray(schema.productionTopics.modelId, ids));
    await db.delete(schema.productModels).where(inArray(schema.productModels.id, ids));
  }
  await db.delete(schema.designConcepts).where(like(schema.designConcepts.id, `${P}%`));
  await db.delete(schema.creativeVerdicts).where(like(schema.creativeVerdicts.variantId, `${P}%`));
  await db.delete(schema.creativeVariants).where(like(schema.creativeVariants.id, `${P}%`));
  await db.delete(schema.creativeBatches).where(like(schema.creativeBatches.id, `${P}%`));
  await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

async function gieo(db: Db) {
  // Sản phẩm: P3 (creative), P4 + P5 (có đơn 2004), P7 (topic mở).
  await db.insert(schema.products).values(["p3", "p4", "p5", "p7"].map((x) => ({ id: `${P}${x}`, name: `SP ${x}`, customId: `COSS-${x.toUpperCase()}` })));
  await db.insert(schema.productVariants).values([
    { id: `${P}v4a`, productId: `${P}p4`, sku: "COSS-P4-M", color: "Đen", size: "M" },
    { id: `${P}v4b`, productId: `${P}p4`, sku: "COSS-P4-L", color: "Đen", size: "L" },
    { id: `${P}v5a`, productId: `${P}p5`, sku: "COSS-P5-M", color: "Trắng", size: "M" },
  ]);
  const [dLose, dLose2] = await db
    .insert(schema.designConcepts)
    .values([
      { id: `${P}d2`, code: "TK-040101-91", dna: {}, dnaVersion: 1, status: "LOSE" },
      { id: `${P}d3`, code: "TK-040101-92", dna: {}, dnaVersion: 1, status: "LOSE" },
    ])
    .returning({ id: schema.designConcepts.id });
  await db.insert(schema.productModels).values([
    { id: `${P}m1`, code: "COSS-1", name: "Trống", registeredBy: "USER" },
    { id: `${P}m2`, code: "COSS-2", name: "Thiết kế loại, khai thắng", designConceptId: dLose.id, lifecycleState: "WINNER", registeredBy: "USER" },
    { id: `${P}m3`, code: "COSS-3", name: "Creative vs thiết kế", productId: `${P}p3`, designConceptId: dLose2.id, lifecycleState: "LOSER", registeredBy: "USER" },
    { id: `${P}m4`, code: "COSS-4", name: "Có đơn, đã ghép chi", productId: `${P}p4`, lifecycleState: "ADS_TESTING", registeredBy: "USER" },
    { id: `${P}m5`, code: "COSS-5", name: "Có đơn, chưa ghép chi", productId: `${P}p5`, registeredBy: "USER" },
    { id: `${P}m7`, code: "COSS-7", name: "Có topic mở", productId: `${P}p7`, lifecycleState: "WINNER", registeredBy: "USER" },
  ]);

  // Creative của P3: mẩu 1 phán THẮNG ngày 1 rồi LOẠI ngày 2 (mới nhất = LOẠI); mẩu 2 THẮNG; mẩu 3 chưa phán.
  await db.insert(schema.creativeBatches).values({
    id: `${P}b1`,
    batchDay: "2004-02-01",
    status: "PUBLISHED",
    slotCount: 3,
    startAt: at("2004-02-01"),
    endAt: at("2004-02-03"),
    approvalDeadline: at("2004-01-31"),
    configSnapshot: {},
    ruleVersion: 1,
    approvedAt: at("2004-01-30"),
    approvalDigest: `${P}digest`,
  });
  await db.insert(schema.creativeVariants).values(
    [1, 2, 3].map((slot) => ({ id: `${P}cv${slot}`, batchId: `${P}b1`, slot, mode: "EXPLORE", productId: `${P}p3`, genes: {}, genesVersion: 1, headline: `Mẩu ${slot}` })),
  );
  await db.insert(schema.creativeVerdicts).values([
    { verdictDay: "2004-02-02", variantId: `${P}cv1`, verdict: "WIN", ruleVersion: 1 },
    { verdictDay: "2004-02-03", variantId: `${P}cv1`, verdict: "LOSE", ruleVersion: 1 },
    { verdictDay: "2004-02-02", variantId: `${P}cv2`, verdict: "WIN", ruleVersion: 1 },
  ]);

  // Đơn 2004 cho P4 và P5 — mỗi mã thêm MỘT dòng không mẫu mã.
  await db.insert(schema.orders).values(
    ["o1", "o2", "o3", "o4"].map((o, i) => ({ id: `${P}${o}`, stage: "CONFIRMED" as const, status: 1, insertedAt: at(`2004-03-0${i + 1}`), updatedAt: at(`2004-03-0${i + 1}`), cod: 400_000, totalPrice: 400_000 })),
  );
  const dong = (id: string, order: string, variantId: string | null, productId: string, qty = 1) => ({ id: `${P}${id}`, orderId: `${P}${order}`, variantId, productId, productName: `SP ${productId}`, sku: variantId ?? "", quantity: qty, unitPrice: 400_000, lineTotal: 400_000 * qty });
  await db.insert(schema.orderItems).values([
    dong("i1", "o1", `${P}v4a`, `${P}p4`),
    dong("i2", "o2", `${P}v4b`, `${P}p4`, 2),
    dong("i3", "o2", null, `${P}p4`),
    dong("i4", "o3", `${P}v5a`, `${P}p5`),
    dong("i5", "o4", null, `${P}p5`),
  ]);
  await db.insert(schema.adSpends).values({ id: `${P}ad4`, platform: "facebook", spend: 300_000, spendDate: at("2004-03-01"), productId: `${P}p4` });

  // Topic: mẫu 7 có một topic MỞ; mẫu 4 chỉ có topic ĐÃ ĐÓNG (đếm 0 thật).
  await db.insert(schema.productionTopics).values([
    { modelId: `${P}m7`, title: "Hỏi giá COSS-7", status: "DISCUSSING", requirements: {}, evidenceSnapshot: { kind: "SNAPSHOT" } },
    { modelId: `${P}m4`, title: "Topic cũ COSS-4", status: "CLOSED", requirements: {}, evidenceSnapshot: { kind: "SNAPSHOT" } },
  ]);
}

async function soHaiDuong(batch: ModelSignalBatch, range: Period, nhan: string) {
  assert.ok(batch.rows.length > 0, `${nhan}: lô phải có mẫu`);
  assert.equal(batch.periodLabel, range.label, `${nhan}: nhãn kỳ của lô là của ĐÚNG kỳ hỏi (khoá đệm chứa kỳ)`);
  for (const r of batch.rows) {
    const mot = await getModelSignal(r.model.id, range);
    assert.ok(mot, `${nhan}: mẫu ${r.model.code} phải có tín hiệu ở đường một mẫu`);
    assert.deepEqual(r.signal, mot, `${nhan}: mẫu ${r.model.code} — lô phải cho ĐÚNG kết quả getModelSignal`);
  }
}

export function testCompanyOsSignalBatchSource() {
  const doc = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8").replace(/\r\n/g, "\n");
  const sig = doc("lib/queries/model-signal.ts");
  assert.equal(sig.match(/deriveModelSignal\(/g)?.length, 2, "đúng hai lời gọi phép gộp: một cho đường một mẫu, một cho đường theo lô — không phép gộp thứ hai");
  assert.equal(sig.match(/classifyProduct\(/g)?.length, 1, "đầu vào classifyProduct dựng ở ĐÚNG một chỗ (productVerdictsOf) cho cả hai đường");
  const lo = sig.slice(sig.indexOf("async function modelSignalsBatchUncached"));
  for (const f of ["adsSignalInput(", "productSourceInput(", "inventoryKindsOf(", "pickModelInventoryRows(", "summarizeModelAds(", "finishReport("]) {
    assert.ok(lo.includes(f), `đường theo lô phải đi qua ${f.slice(0, -1)} — cùng hàm với đường một mẫu`);
  }
  assert.ok(!/getModelSignal\(|getModelAdsSummary\(|getModelCreativeSummary\(|getModelInventoryDecisions\(/.test(lo), "đường theo lô KHÔNG gọi hàm một mẫu trong vòng lặp");
  assert.match(sig, /memo\(`modelSignalsBatch:\$\{periodKey\(range\)\}`/, "đệm theo lô có khoá chứa kỳ");
  const od = doc("lib/queries/owner-decisions.ts");
  const loader = od.slice(od.indexOf("async function loadModelScale"), od.indexOf("async function loadInventory"));
  assert.ok(loader.includes("getModelSignalsBatch(") && loader.includes("modelWinnerCandidates("), "cockpit đọc tín hiệu theo lô và lọc bằng hàm thuần đã kiểm");
  assert.ok(!/getAdsDecision\(|getModelSignal\(/.test(loader), "cockpit không còn đọc riêng lá phiếu quảng cáo, không gọi tín hiệu từng mẫu");
  console.log("✓ Company OS · S (mã nguồn): hai đường một phép gộp, đệm theo kỳ, cockpit đọc tín hiệu theo lô");
}

export async function testCompanyOsSignalBatchDb(db: Db) {
  await donDep(db);
  try {
    await gieo(db);
    clearMemo();

    // ── Kỳ 2004: dữ liệu gieo CỐ ĐỊNH — so hai đường và khẳng định fixture phủ đủ nhánh ──
    const lo = await getModelSignalsBatch(KY_2004);
    await soHaiDuong(lo, KY_2004, "2004");
    const cua = (code: string) => {
      const r = lo.rows.find((x) => x.model.code === code);
      assert.ok(r, `lô phải có mẫu ${code}`);
      return r;
    };
    assert.equal(cua("COSS-1").signal.signal, "NEEDS_MORE_DATA", "mẫu trống ⇒ cần thêm dữ liệu");
    assert.equal(cua("COSS-2").signal.signal, "LOSER");
    assert.ok(cua("COSS-2").signal.conflicts.some((c) => c.includes("Trạng thái khai")), "khai THẮNG mà tín hiệu LOẠI ⇒ xung đột");
    const m3 = cua("COSS-3").signal;
    assert.equal(m3.decidedBy, "TESTING");
    assert.ok(m3.conflicts.length > 0, "creative THẮNG vs thiết kế LOẠI ⇒ xung đột tầng thử");
    assert.match(m3.reasons.find((x) => x.source === "CREATIVE")!.detail, /3 creative: 1 thắng · 1 loại · 1 chưa phán/, "phán quyết MỚI NHẤT của mỗi mẩu (mẩu 1: LOẠI đè THẮNG)");
    assert.equal(m3.reasons.find((x) => x.source === "ADS")!.vote, "INSUFFICIENT", "mã không đơn trong kỳ ⇒ không có dòng quảng cáo");
    const m4 = cua("COSS-4").signal;
    const m5 = cua("COSS-5").signal;
    assert.match(m4.reasons.find((x) => x.source === "PRODUCT")!.detail, /^3 mẫu mã:/, "P4: hai mẫu mã + MỘT dòng không mẫu mã của riêng P4");
    assert.match(m5.reasons.find((x) => x.source === "PRODUCT")!.detail, /^2 mẫu mã:/, "P5: một mẫu mã + MỘT dòng không mẫu mã của riêng P5");
    assert.notEqual(m4.reasons.find((x) => x.source === "ADS")!.verdict, "Không có dòng", "P4 có đơn ⇒ có dòng quảng cáo");
    assert.match(m5.reasons.find((x) => x.source === "ADS")!.verdict, /chưa ghép chi/, "P5 có đơn mà chưa từng ghép chiến dịch ⇒ chưa đủ, không dùng hành động");
    assert.ok(!/chưa ghép chi/.test(m4.reasons.find((x) => x.source === "ADS")!.verdict), "P4 đã ghép chi ⇒ không mang cờ chưa ghép");
    assert.equal(cua("COSS-7").productionTrackTopics, 1, "topic đang mở được đếm");
    assert.equal(cua("COSS-4").productionTrackTopics, 0, "topic đã đóng không đếm — 0 thật");
    assert.equal(cua("COSS-1").productionTrackTopics, 0);
    assert.equal(lo.topicsError, null);

    // ── Hai kỳ nữa, KHÔNG xoá đệm: khoá thiếu kỳ ⇒ đọc nhầm kết quả kỳ trước ⇒ đỏ ──
    const all = resolvePeriod({ period: "all" }, "all");
    await soHaiDuong(await getModelSignalsBatch(all), all, "toàn bộ");
    const d30 = resolvePeriod({}, "30d");
    await soHaiDuong(await getModelSignalsBatch(d30), d30, "30 ngày");
    assert.equal((await getModelSignalsBatch(KY_2004)).periodLabel, KY_2004.label, "gọi lại kỳ 2004 sau hai kỳ khác ⇒ vẫn đúng kỳ 2004");

    const tong = lo.rows.length;
    const tinHieu = [...new Set(lo.rows.map((r) => r.signal.signal))].sort().join(", ");
    console.log(`✓ Company OS · S (CSDL): tín hiệu theo lô = getModelSignal trên ${tong} mẫu × 3 kỳ (tín hiệu gặp: ${tinHieu}; có xung đột, có cần thêm dữ liệu, có chi chưa ghép, có dòng không mẫu mã), topic mở đếm đúng`);
  } finally {
    await donDep(db);
    clearMemo();
  }
}
