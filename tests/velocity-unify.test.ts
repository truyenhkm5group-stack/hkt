import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { computePlan, coverDaysOf, paceOfPlanRow, pooledPace, qtyForCoverDays, roundCoverDays, type StockPace } from "@/lib/constants/planning";
import { SLOW_MOVING_RULES, STOCK_RISKS, STOCK_RISK_ACTION, STOCK_RISK_LABEL, STOCK_RISK_TONE, STOCK_RISK_WHY, classifyStockRisk, type SlowMovingRules, type StockRisk } from "@/lib/constants/slow-moving";
import { decideInventory, type DecisionInput } from "@/lib/constants/inventory-decision";
import { normalizeOutreachConfig } from "@/lib/constants/outreach";
import { clearanceProducts } from "@/lib/outreach/build";
import { getInventoryDecisionReport } from "@/lib/queries/inventory-decision";
import { getReplenishmentPlan, getVariantPaceMap } from "@/lib/queries/planning";
import { getProductIntelligence } from "@/lib/queries/product-intelligence";
import { getSlowMoving } from "@/lib/queries/slow-moving";
import type { Period } from "@/lib/search-params";
import { COMPARE_MAX_CHARS, COMPARE_MAX_LINES, RISKS, collectVelocityCompare, velocityCompareLines, xepLop, xepLopCu } from "@/scripts/velocity-compare";

/**
 * ═══════════ COMPANY OS · AGENT V · MỘT TỐC ĐỘ BÁN ═══════════
 *
 * Chủ shop giao Tech Lead chốt 27/09/2026: định nghĩa tốc độ bán / số ngày còn đủ hàng của KẾ HOẠCH SX
 * thắng; bảng Hàng chậm, Quyết định vốn tồn, Hiệu quả mẫu mã, tệp khách xả hàng, vòng phản hồi tồn đọc
 * từ nó. Khoá ở đây:
 *
 *  · Thuần: `computePlan` và `coverDaysOf` là MỘT phép tính (so từng bit trên cả lưới); ngưỡng không
 *    đổi; phép xếp lớp mới trùng hệt phép xếp lớp cũ trên miền của phép cũ; bản sao đo lường trong
 *    script ops trùng hàm của mã nguồn.
 *  · Mã nguồn: không còn nơi nào tự chia cho tốc độ ngoài `lib/constants/planning.ts` (và bài đối chứng
 *    lịch sử đã khai); script ops không import một tên nào của bản gộp (ảnh đang chạy chưa có).
 *  · CSDL (PGlite): cùng một bộ dữ liệu, số ngày phủ của Hàng chậm == Kế hoạch SX == Quyết định vốn tồn
 *    == Hiệu quả mẫu mã cho TỪNG mẫu mã; mẫu mã dựng riêng nhiều hàng hoàn dịch lớp đúng hướng đã khai
 *    (Vốn nằm chết → Bình thường), mẫu mã không có hoàn giữ nguyên lớp.
 *  · Lớp "Hoàn gần hết" (27/09/2026, chủ shop duyệt sau lượt đo production run 36306328239): gửi đi trong cửa
 *    sổ hàng chết mà KHÔNG giao được món nào ⇒ `RETURNED_OUT`, không bao giờ Bình thường; không gửi đi ⇒ vẫn
 *    Hàng chết; đang đi chưa kết luận ⇒ không gắn nhãn. Quyết định vốn tồn / vòng phản hồi tồn / tệp xả hàng
 *    đối xử như hàng chết.
 */

const P = "cos-v-";
const TEN = "Đầm COSV";
const ALL: Period = { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null };

/** Phép xếp lớp CŨ — chép nguyên vòng lặp `slowMovingUncached` tại main f84be840, làm thước so. */
function lopCu(velocity: number, daysOfCover: number | null, daysSinceLastSale: number | null, R: SlowMovingRules): StockRisk {
  if (velocity <= 0 && (daysSinceLastSale === null || daysSinceLastSale >= R.deadDays)) return "DEAD";
  if (daysOfCover !== null && daysOfCover > R.excessCoverDays) return "EXCESS";
  if (daysOfCover !== null && daysOfCover > R.slowCoverDays) return "SLOW";
  return "HEALTHY";
}

/** Tệp .ts/.tsx dưới một thư mục, đường dẫn dạng `/` trên mọi nền (AGENTS.md mục 65). */
function tepMa(dir: string): string[] {
  const out: string[] = [];
  const di = (d: string) => {
    for (const ten of readdirSync(d)) {
      const p = path.join(d, ten);
      if (statSync(p).isDirectory()) {
        if (ten !== "node_modules" && !ten.startsWith(".")) di(p);
      } else if (/\.(ts|tsx)$/.test(ten)) out.push(path.relative(process.cwd(), p).split(path.sep).join("/"));
    }
  };
  di(path.join(process.cwd(), dir));
  return out;
}

const docMa = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\r\n/g, "\n");
const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");

export function testVelocityUnifyPure() {
  // ── 1. Ngưỡng KHÔNG đổi trong bản gộp (luật 22: ghi đè ở settings, mặc định ở hằng số). ──
  assert.deepEqual({ ...SLOW_MOVING_RULES }, { deadDays: 60, excessCoverDays: 120, slowCoverDays: 60, healthyCoverDays: 45 }, "ngưỡng hàng chậm giữ nguyên");

  // ── 2. Xếp lớp: trùng phép cũ trên miền của phép cũ; script ops trùng mã nguồn trên TOÀN lưới. ──
  const boNguong: SlowMovingRules[] = [{ ...SLOW_MOVING_RULES }, { deadDays: 90, excessCoverDays: 200, slowCoverDays: 75, healthyCoverDays: 30 }];
  let o = 0;
  let hoan = 0;
  for (const R of boNguong)
    for (const velocity of [0, 0.3, 2])
      for (const cover of [null, 0, 10, 45, 59.9, 60, 60.1, 75, 120, 120.1, 200, 200.1, 300])
        for (const dsls of [null, 0, 59, 60, 89, 90, 400])
          for (const [shipped, returned] of [[0, 0], [5, 0], [5, 1], [5, 5]]) {
            const khong = dsls === null || dsls >= R.deadDays;
            const moi = classifyStockRisk({ velocity, daysOfCover: cover, daysSinceLastSale: dsls, shippedInDeadWindow: shipped, returnedInDeadWindow: returned }, R).risk;
            const tag = `v=${velocity} phủ=${cover} ngày=${dsls} gửi=${shipped} hoàn=${returned}`;
            assert.equal(xepLop(velocity, cover, dsls, R, shipped, returned), moi, `script ops xếp lớp khác mã nguồn: ${tag}`);
            assert.equal(xepLopCu(velocity, cover, dsls, R), lopCu(velocity, cover, dsls, R), `vế CŨ của script lệch bản f84be840: ${tag}`);
            if (khong && shipped > 0 && returned > 0) {
              // Gửi đi mà không giao được món nào, đã có hoàn ⇒ KHÔNG BAO GIỜ Bình thường, không bao giờ biến mất.
              assert.equal(moi, "RETURNED_OUT", `gửi đi mà không giao được phải là Hoàn gần hết: ${tag}`);
              hoan += 1;
            } else if (velocity > 0 && cover === null) assert.equal(moi, "EXCESS", "gửi đi mà tồn không vơi ⇒ Vốn nằm chết, không phải Bình thường");
            else {
              // Ngoài ca mới, ngưỡng và phép xếp y như cũ — kể cả "không gửi đi" (hoặc chưa có hoàn) vẫn là Hàng chết.
              assert.equal(moi, lopCu(velocity, cover, dsls, R), `ngưỡng/xếp lớp đổi so với bản cũ: ${tag}`);
              o += 1;
            }
          }
  assert.ok(o > 1400 && hoan > 600, `lưới xếp lớp đủ dày (${o} ca giữ nguyên, ${hoan} ca hoàn gần hết)`);
  // Không gửi đi ⇒ vẫn là Hàng chết như hôm nay; gửi đi mà chưa có món nào kết luận hoàn ⇒ CHƯA BIẾT, không gắn nhãn hoàn.
  const R0 = SLOW_MOVING_RULES;
  const f0 = { shippedInDeadWindow: 0, returnedInDeadWindow: 0 };
  assert.equal(classifyStockRisk({ velocity: 0, daysOfCover: null, daysSinceLastSale: null, ...f0 }, R0).risk, "DEAD");
  assert.notEqual(classifyStockRisk({ velocity: 1, daysOfCover: 3, daysSinceLastSale: null, shippedInDeadWindow: 9, returnedInDeadWindow: 0 }, R0).risk, "RETURNED_OUT");
  // Có một lần giao thành công trong cửa sổ ⇒ không phải lớp mới (luật hàng chết cũ quyết định "giao được").
  assert.notEqual(classifyStockRisk({ velocity: 1, daysOfCover: 3, daysSinceLastSale: 5, shippedInDeadWindow: 9, returnedInDeadWindow: 8 }, R0).risk, "RETURNED_OUT");
  const lyDo = classifyStockRisk({ velocity: 1, daysOfCover: 2, daysSinceLastSale: null, shippedInDeadWindow: 14, returnedInDeadWindow: 12 }, R0).reason;
  assert.ok(lyDo.includes("Gửi đi 14 món trong 60 ngày, hoàn 12, chưa giao thành công món nào (2 món chưa kết luận)"), lyDo);
  // Lớp mới có đủ nhãn / màu / việc nên làm / câu ⓘ, và script đếm đủ các lớp theo cùng thứ tự.
  for (const k of STOCK_RISKS) assert.ok(STOCK_RISK_LABEL[k] && STOCK_RISK_TONE[k] && STOCK_RISK_ACTION[k] && STOCK_RISK_WHY[k], `lớp ${k} thiếu nhãn/màu/việc/ⓘ`);
  assert.deepEqual([...RISKS], [...STOCK_RISKS], "script ops đếm đủ và đúng thứ tự các lớp");
  assert.ok(STOCK_RISK_ACTION.RETURNED_OUT.includes("chất lượng"));
  const sec = docMa("app/(dashboard)/inventory/planning/slow-moving-section.tsx");
  assert.ok(sec.includes("STOCK_RISK_WHY[r.risk]") && sec.includes("<InfoHint"), "bảng Hàng chậm in ⓘ vì sao cạnh nhãn");

  // Quyết định vốn tồn: hoàn gần hết (còn hàng) ⇒ Nên xả, KHÔNG đề xuất đặt thêm dù tốc độ gửi đi dương.
  const dauVao: DecisionInput = { stockKnown: true, stock: 20, available: 20, incomingFromReturns: 0, openPoQty: 0, velocity: 3, velocityTrimmed: false, soldInWindow: 42, sold30: 90, daysOfCover: 6, leadTimeDays: 10, leadTimeSource: "override", safetyDays: 3, suggested: 25, unitCost: 100_000, retailPrice: 300_000, returnRate: 0.95, returnRateSource: "variant", daysSinceLastSale: null, ageDays: 100 };
  assert.equal(decideInventory(dauVao).decision, "STOCKOUT_RISK", "đối chứng: không cờ ⇒ theo tốc độ gửi đi");
  const xa = decideInventory({ ...dauVao, returnedOut: true });
  assert.equal(xa.decision, "CLEARANCE_CANDIDATE");
  assert.equal(xa.suggestedQty, 0, "hoàn gần hết ⇒ không đặt thêm");
  assert.equal(xa.excessQty, 20);
  assert.equal(xa.capitalFreeable, 2_000_000);
  assert.ok(xa.reason.includes("hoàn gần hết") && xa.reason.includes("chất lượng"), xa.reason);
  assert.equal(decideInventory({ ...dauVao, available: 0, returnedOut: true }).decision, "STOCKOUT_RISK", "hết hàng thì cờ không đổi gì (không có vốn để giải phóng)");
  // Câu lý do in ĐÚNG số đã xếp, và không bao giờ in vô cực.
  assert.match(classifyStockRisk({ velocity: 1, daysOfCover: 130.5, daysSinceLastSale: 1, ...f0 }, SLOW_MOVING_RULES).reason, /130,5|130\.5/);
  assert.doesNotMatch(classifyStockRisk({ velocity: 1, daysOfCover: null, daysSinceLastSale: 1, ...f0 }, SLOW_MOVING_RULES).reason, /Infinity|∞|NaN/);

  // ── 3. `computePlan` và `coverDaysOf` là MỘT phép tính — so từng bit trên cả lưới. ──
  let n = 0;
  for (const returnRate of [0, 0.4, 1])
    for (const returnLagDays of [null, 0, 5, 30])
      for (const returnRecoveryRate of [0.5, 1])
        for (const soldInWindow of [0, 14, 70])
          for (const stock of [0, 3, 50, 400]) {
            const input = { stock, stockKnown: true, committed: 2, soldInWindow, windowDays: 14, leadTimeDays: 7, coverDays: 14, safetyDays: 3, roundTo: 1, returnRate, returnLagDays, returnRecoveryRate };
            const out = computePlan(input);
            const qua = coverDaysOf(Math.max(0, out.available), paceOfPlanRow({ ...out, input }));
            assert.equal(out.daysOfCover, qua, `computePlan lệch coverDaysOf: ${JSON.stringify(input)}`);
            if (out.daysOfCover !== null) assert.ok(Number.isFinite(out.daysOfCover) && out.daysOfCover >= 0, "số ngày phủ hữu hạn, không âm");
            n += 1;
          }
  assert.equal(n, 288);

  // ── 4. Nghịch đảo và phép gộp dùng CÙNG thước. ──
  const p: StockPace = { velocity: 3, netVelocity: 1.2, returnLagDays: 8 };
  for (const d of [1, 5, 8, 45, 100]) assert.ok(Math.abs((coverDaysOf(qtyForCoverDays(d, p), p) as number) - d) < 1e-9, `nghịch đảo lệch tại ${d} ngày`);
  assert.equal(qtyForCoverDays(45, { velocity: 0, netVelocity: 0, returnLagDays: null }), 0, "không gửi đi ⇒ mức lành mạnh 0 ⇒ toàn bộ là vượt mức");
  assert.equal(coverDaysOf(10, { velocity: 2, netVelocity: 0, returnLagDays: 3 }), null, "hoàn về bằng hàng đi ⇒ null, không vô cực");
  assert.equal(coverDaysOf(10, pooledPace([p, p])), coverDaysOf(5, p), "gộp hai mẫu mã giống nhau = một mẫu mã với nửa số hàng");
  assert.equal(coverDaysOf(10, pooledPace([])), null);
  assert.equal(roundCoverDays(12.345), 12.3);
  assert.equal(roundCoverDays(null), null);

  // ── 5. Mã nguồn: không còn nơi nào tự chia cho tốc độ. ──
  // Mẫu số là MỘT biểu thức liền (tên, lời gọi, chấm) kết thúc bằng tốc độ: `x / v`, `x / r.velocity`, `x / f(y).velocity`.
  const CHIA_TOC_DO = /\/\s*\(?\s*[\w.()[\]]*?\b(?:velocity|netVelocity|rawVelocity)\b/g;
  const CHIA_SO_NGAY = /\b(?:sold\w*|deliveredQty)\s*\/\s*(?:windowDays|days|30)\b/g;
  /** Nơi DUY NHẤT được chia — kèm số lần, để một phép chia thứ hai trong cùng tệp cũng đỏ. */
  const DUOC_CHIA: Record<string, { tocDo: number; soNgay: number; lyDo: string }> = {
    "lib/constants/planning.ts": { tocDo: 2, soNgay: 1, lyDo: "computeVelocity + coverDaysOf — định nghĩa duy nhất" },
    "lib/queries/inventory-decision.ts": { tocDo: 1, soNgay: 1, lyDo: "đối chứng lịch sử (backtest) dựng tồn tại mốc cắt quá khứ — ƯỚC TÍNH đã khai, không có GTC/độ trễ hoàn của thời điểm đó" },
  };
  const tep = [...tepMa("lib"), ...tepMa("app")];
  assert.ok(tep.length > 200, "đọc được mã nguồn");
  for (const rel of tep) {
    const code = boChuThich(docMa(rel));
    const tocDo = (code.match(CHIA_TOC_DO) ?? []).length;
    const soNgay = (code.match(CHIA_SO_NGAY) ?? []).length;
    const cho = DUOC_CHIA[rel] ?? { tocDo: 0, soNgay: 0, lyDo: "" };
    assert.equal(tocDo, cho.tocDo, `${rel}: tự chia cho tốc độ ${tocDo} lần — số ngày phủ phải đi qua coverDaysOf / dòng Kế hoạch SX`);
    assert.equal(soNgay, cho.soNgay, `${rel}: tự chia số bán cho số ngày ${soNgay} lần — tốc độ bán phải là của Kế hoạch SX`);
  }
  const sm = boChuThich(docMa("lib/queries/slow-moving.ts"));
  for (const cam of ["computeVelocity", "isBonus", "soldInWindow", "velocityWindowDays"]) assert.ok(!sm.includes(cam), `lib/queries/slow-moving.ts còn tự tính tốc độ (${cam})`);
  assert.ok(sm.includes("getReplenishmentPlan()") && sm.includes("coverDaysOf("), "Hàng chậm đọc dòng Kế hoạch SX");

  // ── 6. Script ops: chỉ đọc, chỉ tên đã có trên ảnh đang chạy, khai đúng khuôn company-os-summary. ──
  const src = docMa("scripts/velocity-compare.ts");
  const code = boChuThich(src);
  const MOI = ["coverDaysOf", "qtyForCoverDays", "paceOfPlanRow", "pooledPace", "roundCoverDays", "StockPace", "classifyStockRisk", "getVariantPaceMap", "VariantPace", "STOCK_RISKS", "STOCK_RISK_WHY", "DeadWindowFacts", "returnsHref"];
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@\/([^"]+)"/g)) {
    const ten = m[1].split(",").map((x) => x.replace(/\btype\b/, "").trim()).filter(Boolean);
    for (const t of ten) assert.ok(!MOI.includes(t), `script ops import "${t}" — tên của bản gộp, ảnh đang chạy chưa có ⇒ MODULE/export không tồn tại`);
    const tonTai = [".ts", ".tsx", "/index.ts"].some((ext) => {
      try {
        statSync(path.join(process.cwd(), m[2] + ext));
        return true;
      } catch {
        return false;
      }
    });
    assert.ok(tonTai, `script import @/${m[2]} — không có tệp`);
  }
  const sqlText = [...code.matchAll(/sql`([^`]*)`/g)].map((m) => m[1]).join("\n");
  assert.ok(sqlText.length > 100, "đọc được SQL của script");
  assert.doesNotMatch(sqlText, /\b(insert|update|delete|truncate|alter|drop|create|grant|merge|copy|nextval|setval|set_config)\b/i, "script CHỈ ĐỌC");
  assert.doesNotMatch(code, /\.(insert|update|delete)\(/, "script không gọi đường ghi của drizzle");
  assert.doesNotMatch(code, /\b(productName|sku|color|size|billPhone|billFullName|unitCost|stockValue)\b/, "script không đọc tên / mã / tiền");
  const datChiDoc = ["process", "env", "ERP_READ_ONLY"].join(".") + ' = "1"';
  assert.ok(src.includes(datChiDoc) && src.indexOf(datChiDoc) < src.indexOf('from "@/db"'), "ERP_READ_ONLY đặt TRƯỚC khi nạp @/db");
  assert.ok(code.includes("show default_transaction_read_only"), "main hỏi lại chế độ chỉ đọc");
  assert.ok(src.includes("f84be840"), "bản sao đo lường phải khai nguồn chép (main f84be840)");
  const yml = docMa(".github/workflows/ops-vps.yml");
  assert.match(yml, /^\s+- velocity-compare\s+#/m, "có trong options");
  assert.match(yml, /OPS_THAO_TAC_MA_HOA: "[^"]*\bvelocity-compare\b/, "cùng lớp mã hoá với company-os-summary");
  assert.match(yml, /DOC_NANG="[^"]*\bvelocity-compare\b/, "làn đọc nặng như company-os-summary");
  assert.match(yml, /fetch_script velocity-compare\.ts \| docker exec -i erp-app sh -c 'cat > \/app\/scripts\/velocity-compare\.ts'/);
  assert.match(yml, /ma_hoa_ket_qua chay_voi_arg docker exec erp-app npx tsx --tsconfig tsconfig\.json scripts\/velocity-compare\.ts/);
  console.log(`✓ Company OS · V: một tốc độ bán — computePlan ≡ coverDaysOf (${n} ca), xếp lớp cũ ≡ mới trên ${o} ca, ngưỡng giữ nguyên, không nơi nào tự chia cho tốc độ`);
}

async function donDep(db: Db) {
  const orders = (await db.select({ id: schema.orders.id }).from(schema.orders).where(like(schema.orders.id, `${P}%`))).map((r) => r.id);
  if (orders.length) {
    await db.delete(schema.canonicalOrderOutcome).where(inArray(schema.canonicalOrderOutcome.orderId, orders));
    await db.delete(schema.orderItems).where(inArray(schema.orderItems.orderId, orders));
    await db.delete(schema.shipments).where(inArray(schema.shipments.orderId, orders));
    await db.delete(schema.orders).where(inArray(schema.orders.id, orders));
  }
  await db.delete(schema.stockReceiptItems).where(like(schema.stockReceiptItems.id, `${P}%`));
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  clearMemo();
}

export async function testVelocityUnifyDb(db: Db) {
  await donDep(db);
  const H = 3_600_000;
  const now = Date.now();
  /*
    Bốn mẫu mã của một mã hàng. Số hàng khả dụng CỐ Ý nhỏ so với tốc độ gửi đi (≤ 2 ngày bán) để số
    ngày phủ MỚI không phụ thuộc độ trễ hoàn mà CSDL kiểm thử đo được: khả dụng ≤ tốc độ × độ trễ thì
    `coverDaysOf` = khả dụng ÷ tốc độ ở mọi nhánh (độ trễ = đo + kho tái nhập ≥ 2 ngày, kiểm dưới đây).
      v1 NHIỀU HOÀN   — 84 đơn/14 ngày, 83 hoàn, 1 giao; còn 10 ⇒ cũ 10 ÷ (1/14) = 140 ngày (Vốn nằm chết)
                        · mới 10 ÷ 6 = 1,7 ngày (Bình thường).
      v2 CHƯA GIAO ĐƯỢC — 14 đơn đều hoàn; còn 2 ⇒ cũ tốc độ 0 + chưa giao lần nào (Hàng chết)
                        · mới 2 ÷ 1 = 2 ngày (Bình thường): hàng rời kho mỗi ngày không phải hàng chết.
      v3 KHÔNG HOÀN   — 14 đơn đều giao; còn 1 ⇒ cũ = mới = 1 ngày (Bình thường) — đối chứng.
      v4 KHÔNG BÁN    — không đơn nào; còn 50 ⇒ cũ = mới = Hàng chết — đối chứng.
      v5 TỒN LỚN      — 14 đơn, nửa giao nửa hoàn; còn 60 ⇒ khả dụng VƯỢT tốc độ × độ trễ: nhánh "sau độ
                        trễ hoàn hao theo nhịp ròng" CHẠY THẬT (số ngày phủ > khả dụng ÷ tốc độ). Lớp của nó
                        tuỳ GTC của mã trên CSDL dùng chung nên chỉ khẳng định ĐẲNG THỨC giữa các màn hình.
    Kiện hoàn mang mốc lấy hàng + mốc hoàn (cách nhau 50 phút) để Kế hoạch SX ĐO ĐƯỢC độ trễ hoàn (≥ 30
    kiện): không có nó thì độ trễ là `null` và mọi màn hình trùng nhau cả khi một nơi bỏ qua độ trễ.
  */
  // v2 đứng RIÊNG một mã hàng (COSV2) để tệp khách xả hàng — gộp theo mã hàng — nhìn thấy riêng nó.
  // v6 ĐANG ĐI: 3 đơn chưa kết luận, chưa giao lần nào — CHƯA BIẾT, không phải "hoàn gần hết".
  const maCua = (variant: string) => (variant === `${P}v2` ? `${P}p2` : `${P}p1`);
  await db.insert(schema.products).values([
    { id: `${P}p1`, name: TEN, customId: "COSV1" },
    { id: `${P}p2`, name: `${TEN} 2`, customId: "COSV2" },
  ]);
  await db.insert(schema.productVariants).values([1, 2, 3, 4, 5, 6].map((k) => ({ id: `${P}v${k}`, productId: maCua(`${P}v${k}`), sku: `COSV1-${k}`, color: "Đen", size: String(k), retailPrice: 500_000 })));
  await db.insert(schema.stockReceipts).values({ id: `${P}rc1`, kind: "RECEIPT", receivedAt: new Date(now - 100 * 24 * H), reference: `${P}rc1`, totalQuantity: 254, totalCost: 25_400_000, createdBy: "test" });
  await db.insert(schema.stockReceiptItems).values([
    { id: `${P}ri1`, receiptId: `${P}rc1`, variantId: `${P}v1`, quantity: 94, unitCost: 100_000 },
    { id: `${P}ri2`, receiptId: `${P}rc1`, variantId: `${P}v2`, quantity: 16, unitCost: 100_000 },
    { id: `${P}ri3`, receiptId: `${P}rc1`, variantId: `${P}v3`, quantity: 15, unitCost: 100_000 },
    { id: `${P}ri4`, receiptId: `${P}rc1`, variantId: `${P}v4`, quantity: 50, unitCost: 100_000 },
    { id: `${P}ri5`, receiptId: `${P}rc1`, variantId: `${P}v5`, quantity: 74, unitCost: 100_000 },
    { id: `${P}ri6`, receiptId: `${P}rc1`, variantId: `${P}v6`, quantity: 5, unitCost: 100_000 },
  ]);
  type Don = { id: string; variant: string; at: Date; giao: boolean | null };
  const don: Don[] = [];
  for (let d = 0; d < 14; d += 1) {
    for (let j = 0; j < 6; j += 1) don.push({ id: `${P}o1-${d}-${j}`, variant: `${P}v1`, at: new Date(now - d * 24 * H - 2 * H - j * 60_000), giao: d === 0 && j === 0 });
    don.push({ id: `${P}o2-${d}`, variant: `${P}v2`, at: new Date(now - d * 24 * H - 3 * H), giao: false });
    don.push({ id: `${P}o3-${d}`, variant: `${P}v3`, at: new Date(now - d * 24 * H - 4 * H), giao: true });
    don.push({ id: `${P}o5-${d}`, variant: `${P}v5`, at: new Date(now - d * 24 * H - 5 * H), giao: d % 2 === 0 });
  }
  for (let d = 0; d < 3; d += 1) don.push({ id: `${P}o6-${d}`, variant: `${P}v6`, at: new Date(now - d * 24 * H - 6 * H), giao: null });
  await db.insert(schema.orders).values(don.map((x) => ({ id: x.id, stage: "SHIPPED" as const, cod: 500_000, totalPriceAfterDiscount: 500_000, prepaid: 0, insertedAt: x.at })));
  await db.insert(schema.orderItems).values(don.map((x) => ({ id: `${x.id}-i`, orderId: x.id, variantId: x.variant, productId: maCua(x.variant), productName: TEN, quantity: 1, unitPrice: 500_000, lineTotal: 500_000 })));
  await db.insert(schema.shipments).values(
    don.map((x, i) => ({
      orderId: x.id,
      vtpOrderNumber: `COSV${String(i).padStart(4, "0")}`,
      stage: (x.giao === null ? "IN_TRANSIT" : x.giao ? "DELIVERED" : "RETURNED") as never,
      codAmount: 500_000,
      codCollected: x.giao ? 450_000 : 0,
      pickedUpAt: new Date(x.at.getTime() + 10 * 60_000),
      deliveredAt: x.giao ? new Date(x.at.getTime() + H) : null,
      returnedAt: x.giao === false ? new Date(x.at.getTime() + H) : null,
    })),
  );
  /*
    Ba đơn biên của v2 cho hai sự kiện cửa sổ (không đổi tốc độ gửi đi 14 ngày của nó, nhận thêm 2 món phiếu
    nhập cho hai đơn đã rời kho):
      · HUỶ 3 ngày trước — không phải "gửi đi" (cùng căn cứ gộp: bỏ đơn huỷ);
      · hoàn 80 ngày trước — NGOÀI cửa sổ 60 ngày, không đếm;
      · "giao thành công" chỉ thu 70.000 ₫, 20 ngày trước — luật tiền kết luận HOÀN (`RETURNED_BY_RULE`), phải đếm.
  */
  await db.update(schema.stockReceiptItems).set({ quantity: 18 }).where(like(schema.stockReceiptItems.id, `${P}ri2`));
  const bien = [
    { id: `${P}o2-huy`, at: new Date(now - 3 * 24 * H), stage: "CANCELLED" as const, ship: null },
    { id: `${P}o2-cu`, at: new Date(now - 80 * 24 * H), stage: "SHIPPED" as const, ship: { stage: "RETURNED", codCollected: 0 } },
    { id: `${P}o2-luat`, at: new Date(now - 20 * 24 * H), stage: "SHIPPED" as const, ship: { stage: "DELIVERED", codCollected: 70_000 } },
  ];
  await db.insert(schema.orders).values(bien.map((x) => ({ id: x.id, stage: x.stage, cod: 500_000, totalPriceAfterDiscount: 500_000, prepaid: 0, insertedAt: x.at })));
  await db.insert(schema.orderItems).values(bien.map((x) => ({ id: `${x.id}-i`, orderId: x.id, variantId: `${P}v2`, productId: `${P}p2`, productName: TEN, quantity: 1, unitPrice: 500_000, lineTotal: 500_000 })));
  await db.insert(schema.shipments).values(
    bien.flatMap((x, i) =>
      x.ship
        ? [{
            orderId: x.id,
            vtpOrderNumber: `COSVB${i}`,
            stage: x.ship.stage as never,
            codAmount: 500_000,
            codCollected: x.ship.codCollected,
            pickedUpAt: new Date(x.at.getTime() + 10 * 60_000),
            deliveredAt: x.ship.stage === "DELIVERED" ? new Date(x.at.getTime() + H) : null,
            returnedAt: x.ship.stage === "RETURNED" ? new Date(x.at.getTime() + H) : null,
          }]
        : [],
    ),
  );

  try {
    clearMemo();
    const plan = await getReplenishmentPlan();
    const planBy = new Map(plan.rows.map((r) => [r.variantId, r]));
    assert.notEqual(plan.used.vtpReturnLagDays, null, "tiền đề: Kế hoạch SX đo được độ trễ hoàn (≥ 30 kiện dựng sẵn) — nhánh sau độ trễ phải chạy thật");
    const lag = (plan.used.vtpReturnLagDays as number) + Math.max(0, plan.used.restockDays);
    assert.ok(lag >= 2, `tiền đề của bộ dữ liệu: độ trễ hoàn ≥ 2 ngày (đang ${lag}) — nếu không số ngày phủ của v1–v3 phụ thuộc CSDL`);
    assert.ok(plan.used.returnRecoveryRate > 0, "tiền đề: tỷ lệ nhập lại được > 0 — nếu không nhịp ròng = nhịp gửi đi và độ trễ không đổi gì");
    const ky = { v1: { available: 10, velocity: 6 }, v2: { available: 2, velocity: 1 }, v3: { available: 1, velocity: 1 }, v4: { available: 50, velocity: 0 }, v5: { available: 60, velocity: 1 } } as const;
    for (const [k, e] of Object.entries(ky)) {
      const r = planBy.get(`${P}${k}`);
      assert.ok(r, `${k} phải có trong Kế hoạch SX`);
      assert.equal(r.available, e.available, `${k}: khả dụng`);
      assert.ok(Math.abs(r.velocity - e.velocity) < 1e-9, `${k}: tốc độ gửi đi ${r.velocity} ≠ ${e.velocity}`);
    }

    // ── A. Hàng chậm == Kế hoạch SX cho TỪNG mẫu mã, và cùng TẬP DÒNG. ──
    const slow = await getSlowMoving();
    const slowBy = new Map(slow.rows.map((r) => [r.variantId, r]));
    for (const r of slow.rows) {
      const pr = planBy.get(r.variantId);
      assert.ok(pr, `${r.variantId}: dòng Hàng chậm phải có dòng Kế hoạch SX`);
      assert.equal(r.daysOfCover, roundCoverDays(pr.daysOfCover), `${r.sku}: số ngày phủ Hàng chậm ≠ Kế hoạch SX`);
      assert.equal(r.velocity, Math.round(pr.velocity * 100) / 100, `${r.sku}: tốc độ Hàng chậm ≠ Kế hoạch SX`);
      assert.equal(r.risk, classifyStockRisk({ velocity: pr.velocity, daysOfCover: r.daysOfCover, daysSinceLastSale: r.daysSinceLastSale, shippedInDeadWindow: r.shippedInDeadWindow, returnedInDeadWindow: r.returnedInDeadWindow }, slow.rules).risk);
    }
    for (const pr of plan.rows) if (pr.stockKnown && pr.available > 0) assert.ok(slowBy.has(pr.variantId), `${pr.sku}: biết tồn và còn hàng mà vắng khỏi Hàng chậm`);

    // ── B. Quyết định vốn tồn == Kế hoạch SX == Hàng chậm. ──
    const dec = await getInventoryDecisionReport();
    let soDec = 0;
    for (const r of dec.rows) {
      const pr = planBy.get(r.variantId);
      assert.ok(pr);
      assert.equal(r.daysOfCover, roundCoverDays(pr.daysOfCover), `${r.sku}: số ngày phủ Quyết định vốn tồn ≠ Kế hoạch SX`);
      const sr = slowBy.get(r.variantId);
      if (sr) {
        assert.equal(r.daysOfCover, sr.daysOfCover, `${r.sku}: Quyết định vốn tồn ≠ Hàng chậm`);
        soDec += 1;
      }
    }
    assert.ok(soDec > 0, "phải có mẫu mã chung giữa Quyết định vốn tồn và Hàng chậm");

    // ── C. Đường đọc chung + Hiệu quả mẫu mã. ──
    const paces = await getVariantPaceMap();
    for (const r of plan.rows) assert.equal(paces.get(r.variantId)?.daysOfCover, r.daysOfCover);
    const intel = await getProductIntelligence({ period: ALL, q: TEN, limit: 20 });
    const intelV1 = intel.find((r) => r.variantId === `${P}v1`);
    assert.ok(intelV1, "Hiệu quả mẫu mã phải thấy mẫu mã dựng riêng");
    for (const r of intel) if (r.variantId && slowBy.has(r.variantId)) assert.equal(r.daysOfCover, slowBy.get(r.variantId)?.daysOfCover, `${r.sku}: Hiệu quả mẫu mã ≠ Hàng chậm`);

    // ── D. Mẫu mã dựng riêng: lớp MỚI và hướng dịch đã khai. ──
    const lop = (k: string) => slowBy.get(`${P}${k}`);
    assert.equal(lop("v1")?.daysOfCover, 1.7);
    assert.equal(lop("v1")?.risk, "HEALTHY", "nhiều hoàn: tốc độ gửi đi 6/ngày ⇒ 1,7 ngày ⇒ Bình thường");
    assert.equal(lop("v2")?.daysOfCover, 2, "số ngày phủ vẫn là của Kế hoạch SX — chỉ LỚP đổi");
    assert.equal(lop("v2")?.shippedInDeadWindow, 15, "14 hoàn + 1 hoàn theo luật tiền; đơn huỷ và đơn ngoài cửa sổ không đếm");
    assert.equal(lop("v2")?.returnedInDeadWindow, 15, "RETURNED_BY_RULE là hoàn; đơn hoàn 80 ngày trước nằm ngoài cửa sổ");
    assert.equal(lop("v2")?.risk, "RETURNED_OUT", "gửi đi 15 món, hoàn 15, chưa giao món nào ⇒ Hoàn gần hết — KHÔNG BAO GIỜ Bình thường");
    assert.equal(lop("v2")?.excessValue, lop("v2")?.stockValue, "hoàn gần hết ⇒ toàn bộ là vốn nằm chết, như hàng chết");
    assert.equal(slow.byRisk.RETURNED_OUT.count, slow.rows.filter((r) => r.risk === "RETURNED_OUT").length);
    assert.equal(lop("v6")?.shippedInDeadWindow, 3);
    assert.equal(lop("v6")?.returnedInDeadWindow, 0);
    assert.ok(lop("v6") && lop("v6")?.risk !== "RETURNED_OUT" && lop("v6")?.risk !== "DEAD", `v6 đang đi, chưa kết luận ⇒ không phải hoàn gần hết, không phải hàng chết (đang ${lop("v6")?.risk})`);
    // Quyết định vốn tồn đọc ĐÚNG lớp của Hàng chậm: v2 ⇒ Nên xả, không đề xuất đặt; cờ đi tới vòng phản hồi tồn.
    const decV2 = dec.rows.find((r) => r.variantId === `${P}v2`);
    assert.ok(decV2, "v2 phải có dòng Quyết định vốn tồn");
    assert.equal(decV2.decision, "CLEARANCE_CANDIDATE");
    assert.equal(decV2.returnedOut, true);
    assert.equal(decV2.suggestedQty, 0);
    for (const r of dec.rows) assert.equal(r.returnedOut, slowBy.get(r.variantId)?.risk === "RETURNED_OUT", `${r.sku}: cờ hoàn gần hết phải là lớp của Hàng chậm`);
    // Tệp khách xả hàng: v2 góp tồn nhưng không góp nhịp ⇒ tồn "không vơi" ⇒ mã COSV2 vào tệp xả (tỷ lệ hoàn 100%).
    const tepXa = await clearanceProducts(normalizeOutreachConfig({ clearanceProductIds: [], clearanceReturnRatePct: 50, clearanceStockDays: 30 }));
    assert.ok(tepXa.has(`${P}p2`), "mã chỉ có mẫu hoàn gần hết phải vào tệp xả hàng như hàng chết");
    assert.equal(lop("v3")?.daysOfCover, 1);
    assert.equal(lop("v3")?.risk, "HEALTHY");
    assert.equal(lop("v4")?.daysOfCover, null, "không gửi đi ⇒ số ngày phủ CHƯA BIẾT, không 0, không vô cực");
    assert.equal(lop("v4")?.risk, "DEAD");
    assert.equal(lop("v4")?.excessValue, lop("v4")?.stockValue, "hàng chết ⇒ toàn bộ là vượt mức");
    // v5: nhánh sau độ trễ hoàn chạy thật — số ngày phủ DÀI hơn khả dụng ÷ tốc độ gửi đi, và mọi màn hình theo nó.
    const v5 = planBy.get(`${P}v5`);
    assert.ok(v5 && v5.daysOfCover !== null && v5.daysOfCover > 60 + 1e-6, `v5: phải đi nhánh nhịp ròng (đang ${v5?.daysOfCover})`);
    assert.equal(lop("v5")?.daysOfCover, roundCoverDays(v5.daysOfCover));
    // Mức lành mạnh đo bằng CÙNG thước: phần vượt mức = khả dụng − qtyForCoverDays(ngưỡng lành mạnh).
    const v5Slow = lop("v5");
    assert.ok(v5Slow);
    if (v5Slow.risk !== "HEALTHY") assert.equal(v5Slow.excessValue, Math.max(0, 60 - Math.ceil(qtyForCoverDays(slow.rules.healthyCoverDays, paceOfPlanRow(v5)) - 1e-9)) * 100_000, "v5: vốn vượt mức đo bằng nghịch đảo của coverDaysOf");

    // ── E. Script ops: vế MỚI == hàm chung trên TỪNG mẫu mã; vế CŨ đúng định nghĩa cũ; chỉ đổi lớp ở nơi tốc độ đổi. ──
    const c = await collectVelocityCompare(db);
    const cBy = new Map(c.variants.map((v) => [v.variantId, v]));
    assert.equal(c.variants.length, slow.rows.length, "script và Hàng chậm cùng một tập dòng");
    for (const r of slow.rows) {
      const v = cBy.get(r.variantId);
      assert.ok(v, `${r.sku}: vắng trong script`);
      assert.equal(v.newCover, r.daysOfCover, `${r.sku}: vế MỚI của script ≠ Hàng chậm`);
      assert.equal(v.newRisk, r.risk, `${r.sku}: lớp MỚI của script ≠ Hàng chậm`);
      assert.equal(v.shippedInDeadWindow, r.shippedInDeadWindow, `${r.sku}: món gửi đi trong cửa sổ — câu SQL của script ≠ lib`);
      assert.equal(v.returnedInDeadWindow, r.returnedInDeadWindow, `${r.sku}: món hoàn trong cửa sổ — câu SQL của script ≠ lib`);
    }
    const cu = (k: string) => cBy.get(`${P}${k}`);
    assert.ok(Math.abs((cu("v1")?.oldVelocity ?? -1) - 1 / 14) < 1e-9, "cũ: tốc độ RÒNG của v1 = 1 giao / 14 ngày");
    assert.equal(cu("v1")?.oldCover, 140);
    assert.equal(cu("v1")?.oldRisk, "EXCESS");
    assert.equal(cu("v2")?.oldVelocity, 0);
    assert.equal(cu("v2")?.oldRisk, "DEAD");
    assert.equal(cu("v3")?.oldCover, 1);
    assert.equal(cu("v4")?.oldRisk, "DEAD");
    assert.ok(Math.abs((cu("v5")?.oldVelocity ?? -1) - 0.5) < 1e-9, "cũ: v5 tốc độ ròng 7/14");
    assert.equal(cu("v5")?.oldCover, 120);
    const doiLop = ["v1", "v2", "v3", "v4"].filter((k) => cu(k)?.oldRisk !== cu(k)?.newRisk);
    assert.deepEqual(doiLop, ["v1", "v2"], "chỉ mẫu mã có hàng hoàn (tốc độ đổi) mới đổi lớp");
    for (const k of ["v3", "v4"]) assert.ok(Math.abs((cu(k)?.oldVelocity ?? -1) - (cu(k)?.newVelocity ?? -2)) < 1e-9, `${k}: không hoàn ⇒ tốc độ cũ = mới`);
    assert.equal(`${cu("v1")?.oldRisk}→${cu("v1")?.newRisk}`, "EXCESS→HEALTHY", "hướng đã khai: nhiều hoàn ⇒ số ngày phủ NGẮN lại ⇒ về phía Bình thường");
    assert.equal(`${cu("v2")?.oldRisk}→${cu("v2")?.newRisk}`, "DEAD→RETURNED_OUT", "gửi đi mà không giao được: không bao giờ DEAD→HEALTHY");
    assert.ok(!c.variants.some((v) => v.oldRisk === "DEAD" && v.newRisk === "HEALTHY" && v.shippedInDeadWindow > 0 && v.returnedInDeadWindow > 0), "DEAD→HEALTHY không xảy ra được với mẫu có gửi đi và có hoàn");

    const lines = velocityCompareLines(c);
    const all = lines.join("\n");
    assert.ok(lines.length <= COMPARE_MAX_LINES && lines.every((l) => l.length <= COMPARE_MAX_CHARS), "vừa kênh tóm tắt");
    for (const bi of [P, "COSV", TEN]) assert.ok(!all.includes(bi), `dòng tóm tắt lộ "${bi}":\n${all}`);
    assert.match(all, /ĐỔI LỚP: [\d.]+\/[\d.]+ mẫu mã — .*EXCESS→HEALTHY/);
    assert.match(all, /DEAD→RETURNED_OUT/);
    assert.match(all, /HOÀN GẦN HẾT \(mới — gửi đi trong 60 ngày, có món hoàn, 0 món giao thành công\): [1-9][\d.]* mẫu mã — lớp CŨ của chúng: .*DEAD [1-9]/);
    console.log(`✓ Company OS · V: một tốc độ bán trên PGlite — ${slow.rows.length} mẫu mã: Hàng chậm = Kế hoạch SX = Quyết định vốn tồn (${soDec} chung) = Hiệu quả mẫu mã; nhiều hoàn EXCESS→HEALTHY, gửi đi không giao được DEAD→RETURNED_OUT (Nên xả, vào tệp xả), đang đi không gắn nhãn, đối chứng giữ lớp`);
  } finally {
    await donDep(db);
  }
}
