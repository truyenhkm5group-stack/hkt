import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { inventoryRiskOnSold } from "@/lib/constants/cost-allocation";
import { adsCeiling, ESTIMATED_COST_KEY, parseEstimatedCosts, parseTargetMargin } from "@/lib/constants/estimated-cost";

/**
 * ═══════════ GIÁ VỐN DỰ TÍNH & TRẦN CPQC ═══════════
 *
 * Khoá bốn điều chủ shop cần tin được khi căn quảng cáo theo bảng này:
 *   1. Trần CPQC là ĐÚNG phép tính ngược của lợi nhuận danh nghĩa — chi đúng bằng trần thì LN = 0.
 *   2. Giá dự tính chỉ lấp sản phẩm CHƯA có giá thật; giá thật luôn thắng.
 *   3. Nó đi đúng đường của số lượng ở cả hai nhánh (cân theo đơn / theo tỷ lệ).
 *   4. Nó KHÔNG lọt ra ngoài tab Lợi nhuận danh nghĩa — lương và báo cáo marketer không thấy.
 */

const gio = (h: number) => new Date(Date.now() - h * 3600_000);
const P = "gvdt-";

function testCeilingMath() {
  // LN 1.000.000 sau khi đã trả 2.000.000 QC + 22.000 CP khác (1,1%) ⇒ LN trước QC 3.022.000.
  const c = adsCeiling({ netProfit: 1_000_000, adSpend: 2_000_000, otherCost: 22_000, expectedRevenue: 10_000_000, posSales: 20_000_000, orders: 50, otherCostPercentOfAds: 1.1, targetMarginPct: 10 });
  assert.equal(c.profitBeforeAds, 3_022_000);
  assert.equal(c.breakEven.spend, Math.round(3_022_000 / 1.011));
  // Chi ĐÚNG bằng trần thì lợi nhuận về 0 (sai số làm tròn một đồng).
  assert.ok(Math.abs(c.profitBeforeAds - c.breakEven.spend * 1.011) <= 1, "chi bằng trần hoà vốn ⇒ LN = 0");
  assert.ok(Math.abs(c.breakEven.overPosSales! - (c.breakEven.spend / 20_000_000) * 100) < 0.01, "trần theo % doanh số POS — cùng mẫu số với cột CPQC “DS”");
  assert.equal(c.breakEven.perOrder, Math.round(c.breakEven.spend / 50));
  // Giữ biên 10% trên DT GTC ƯT 10.000.000 ⇒ phải chừa 1.000.000.
  assert.equal(c.target!.spend, Math.round((3_022_000 - 1_000_000) / 1.011));
  assert.ok(c.headroomPoints! > 0 && Math.abs(c.headroomPoints! - (c.breakEven.overPosSales! - 10)) < 1e-9, "còn chỗ = trần − CPQC hiện tại (10% DS)");

  // Không có biên ⇒ không có trần giữ biên. Không đoán một biên mặc định (mục 38).
  assert.equal(adsCeiling({ netProfit: 0, adSpend: 0, otherCost: 0, expectedRevenue: 0, posSales: 0, orders: 0, otherCostPercentOfAds: 0, targetMarginPct: null }).target, null);
  // Mẫu số 0 ⇒ null, không phải 0% hay vô cực.
  const rong = adsCeiling({ netProfit: 500, adSpend: 0, otherCost: 0, expectedRevenue: 0, posSales: 0, orders: 0, otherCostPercentOfAds: 0, targetMarginPct: null });
  assert.equal(rong.breakEven.overPosSales, null);
  assert.equal(rong.breakEven.perOrder, null);
  assert.equal(rong.headroomPoints, null);
  // Lỗ cả khi không chạy QC ⇒ trần âm, KHÔNG kẹp về 0 ở tầng tính (màn hình nói câu đó ra).
  assert.ok(adsCeiling({ netProfit: -900_000, adSpend: 100_000, otherCost: 0, expectedRevenue: 1, posSales: 1_000_000, orders: 3, otherCostPercentOfAds: 0, targetMarginPct: null }).breakEven.spend < 0);

  // Bản lưu hỏng thì BỎ dòng, không thành 0 ₫ đặt tay.
  const m = parseEstimatedCosts({ a: { unitCost: 150_000, reason: "báo giá" }, b: { unitCost: 0 }, c: { unitCost: "x" }, d: null, e: { unitCost: -5 } });
  assert.deepEqual(Object.keys(m), ["a"]);
  assert.equal(m.a.unitCost, 150_000);
  assert.deepEqual(parseEstimatedCosts("rác"), {});

  assert.equal(parseTargetMargin(""), null);
  assert.equal(parseTargetMargin(undefined), null);
  assert.equal(parseTargetMargin("12,5"), 12.5);
  assert.equal(parseTargetMargin("abc"), null);
  assert.equal(parseTargetMargin("150"), null, "biên ≥ 100% là gõ nhầm, không phải một câu hỏi");
}

async function motDon(db: Db, id: string, variantId: string, productId: string, giao: boolean, unitCost: number, qty: number, luc: Date) {
  await db.insert(schema.orders).values({ id: `${P}o-${id}`, stage: "SHIPPED", status: 2, insertedAt: luc, totalPriceAfterDiscount: 500_000 * qty }).onConflictDoNothing();
  await db.insert(schema.orderItems).values({ id: `${P}i-${id}`, orderId: `${P}o-${id}`, variantId, productId, sku: variantId, productName: "Hàng kiểm giá dự tính", variationDetail: "S", quantity: qty, lineTotal: 500_000 * qty, unitCost, isBonus: false }).onConflictDoNothing();
  await db
    .insert(schema.shipments)
    .values({
      id: `${P}s-${id}`,
      orderId: `${P}o-${id}`,
      carrier: "Viettel Post",
      vtpOrderNumber: `${P}${id}`.toUpperCase(),
      vtpStatus: giao ? 501 : 504,
      vtpStatusName: giao ? "Giao thành công" : "Chuyển hoàn",
      stage: giao ? "DELIVERED" : "RETURNED",
      isFinal: true,
      codAmount: 500_000 * qty,
      codCollected: giao ? 500_000 * qty : 0,
      pickedUpAt: luc,
      deliveredAt: giao ? luc : null,
    })
    .onConflictDoNothing();
  await db.insert(schema.shipmentEvents).values({ shipmentId: `${P}s-${id}`, source: "VTP_WEBHOOK", status: giao ? "501" : "504", statusName: giao ? "Giao thành công" : "Chuyển hoàn", legType: "OUTBOUND", occurredAt: luc }).onConflictDoNothing();
}

/** Mọi lời gọi hai hàm báo cáo mang ĐỐI SỐ THỨ NĂM / THỨ TƯ (công tắc giá dự tính) — đếm theo ngoặc, không theo regex. */
function goiCoCongTac(src: string, ten: string, viTri: number): string[] {
  const out: string[] = [];
  let i = src.indexOf(`${ten}(`);
  while (i >= 0) {
    let sau = 0;
    let j = i + ten.length + 1;
    let batDau = j;
    const doiSo: string[] = [];
    for (; j < src.length; j += 1) {
      const ch = src[j];
      if (ch === "(" || ch === "[" || ch === "{") sau += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (sau === 0) break;
        sau -= 1;
      } else if (ch === "," && sau === 0) {
        doiSo.push(src.slice(batDau, j).trim());
        batDau = j + 1;
      }
    }
    doiSo.push(src.slice(batDau, j).trim());
    // Bỏ qua chính lời KHAI BÁO hàm — đó không phải một lời gọi.
    const laKhaiBao = /function\s+$/.test(src.slice(Math.max(0, i - 20), i));
    if (!laKhaiBao && doiSo.length >= viTri && doiSo[viTri - 1]) out.push(doiSo[viTri - 1]);
    i = src.indexOf(`${ten}(`, j);
  }
  return out;
}

function tepMaNguon(goc: string): string[] {
  const out: string[] = [];
  for (const ten of readdirSync(goc)) {
    const p = path.join(goc, ten);
    if (ten === "node_modules" || ten.startsWith(".")) continue;
    if (statSync(p).isDirectory()) out.push(...tepMaNguon(p));
    else if (/\.(ts|tsx)$/.test(ten)) out.push(p);
  }
  return out;
}

/** Giá dự tính chỉ được bật ở tab Lợi nhuận danh nghĩa — mọi chỗ khác (lương, quảng cáo, AI) không truyền công tắc. */
function testOnlyNominalTabEnablesEstimates() {
  const goc = process.cwd();
  /*
    `marketer-daily-nominal.ts` — bảng "Bóc tách theo MKTer" ở /ads/daily. NGOẠI LỆ DUY NHẤT trong
    khu quảng cáo, chủ shop chốt 23/09/2026 sau khi đo trên production: 522 sản phẩm bán ra trong
    30 ngày chưa có giá vốn, và tính với giá dự tính thì LN ròng của shop lệch −150,7% (lãi thành
    lỗ). Bảng dùng để chia ngân sách quảng cáo cho từng người mà trừ 0 ₫ giá vốn là đúng cái bẫy
    luật 2 muốn chặn, chỉ theo chiều ngược lại. Bảng ấy KHÔNG đi vào lương và mang nhãn "dự tính".
    Mọi chỗ khác của khu quảng cáo (bảng quyết định, ROAS, AI) vẫn bị cấm như cũ.
  */
  const choPhep = new Set(["app/(dashboard)/reports/nominal-tab.tsx", "lib/queries/payroll.ts", "lib/queries/marketer-daily-nominal.ts"]);
  for (const p of [...tepMaNguon(path.join(goc, "app")), ...tepMaNguon(path.join(goc, "lib"))]) {
    const rel = path.relative(goc, p).split(path.sep).join("/");
    const src = readFileSync(p, "utf8");
    const bat = [...goiCoCongTac(src, "getNominalProfitReport", 5), ...goiCoCongTac(src, "getNominalMarketerBreakdown", 4)].filter((x) => x !== "false");
    if (!bat.length) continue;
    assert.ok(choPhep.has(rel), `${rel} bật giá vốn DỰ TÍNH cho báo cáo lợi nhuận — chỉ tab Lợi nhuận danh nghĩa được làm vậy (lương / quảng cáo không được thấy một giá đoán)`);
  }
  // payroll.ts chỉ được CHUYỂN TIẾP tham số của chính nó, không tự bật. `false` TƯỜNG MINH vẫn
  // được — nó không bao giờ bật giá đoán; nó xuất hiện khi lời gọi cần tới tham số thứ sáu
  // (`withStock`, tắt đọc tồn kho ở `getMarketerReport`).
  const payroll = readFileSync(path.join(goc, "lib/queries/payroll.ts"), "utf8");
  for (const x of goiCoCongTac(payroll, "getNominalProfitReport", 5)) {
    if (x === "false") continue;
    assert.equal(x, "withEstimatedCost", "payroll.ts chỉ chuyển tiếp công tắc, không tự bật");
  }
}

export async function testEstimatedCost(db: Db) {
  testCeilingMath();
  testOnlyNominalTabEnablesEstimates();

  const luc = gio(72);
  // Mã A: hai mẫu mã — `co` có giá vốn thật trên đơn, `thieu` KHÔNG có giá nào. 12 đơn kết thúc ⇒ chín ⇒ cân theo từng đơn.
  await db.insert(schema.products).values({ id: `${P}pa`, name: "Hàng kiểm giá dự tính A", customId: "GVDT-A" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}va-co`, productId: `${P}pa`, sku: "GVDT-A-CO", retailPrice: 500_000 }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}va-thieu`, productId: `${P}pa`, sku: "GVDT-A-THIEU", retailPrice: 500_000 }).onConflictDoNothing();
  for (let i = 0; i < 12; i += 1) {
    const coGia = i % 4 < 2;
    await motDon(db, `a${i}`, coGia ? `${P}va-co` : `${P}va-thieu`, `${P}pa`, i % 2 === 0, coGia ? 200_000 : 0, 1, luc);
  }
  // Mã B: đủ giá thật — một giá dự tính đặt cho nó phải đứng sang một bên.
  await db.insert(schema.products).values({ id: `${P}pb`, name: "Hàng kiểm giá dự tính B", customId: "GVDT-B" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}vb`, productId: `${P}pb`, sku: "GVDT-B", retailPrice: 500_000 }).onConflictDoNothing();
  await motDon(db, "b0", `${P}vb`, `${P}pb`, true, 200_000, 1, luc);
  // Mã C: một đơn, 2 sản phẩm chưa có giá — CHƯA CHÍN ⇒ nhánh "theo tỷ lệ".
  await db.insert(schema.products).values({ id: `${P}pc`, name: "Hàng kiểm giá dự tính C", customId: "GVDT-C" }).onConflictDoNothing();
  await db.insert(schema.productVariants).values({ id: `${P}vc`, productId: `${P}pc`, sku: "GVDT-C", retailPrice: 500_000 }).onConflictDoNothing();
  await motDon(db, "c0", `${P}vc`, `${P}pc`, true, 0, 2, luc);

  const ky = { from: gio(24 * 30), to: new Date(), key: "30d", label: "30 ngày" } as never;
  const { getNominalProfitReport } = await import("@/lib/queries/profit-nominal");
  const { getNominalDaily } = await import("@/lib/queries/marketer-daily-nominal");

  try {
    clearMemo();
    const truoc = await getNominalProfitReport(ky);
    const aTruoc = truoc.rows.find((r) => r.code === "GVDT-A");
    assert.ok(aTruoc, "bảng lợi nhuận phải thấy mã fixture A");
    assert.equal(aTruoc.cogsUnknownQty, 6, "6 sản phẩm của mẫu mã không có giá");
    assert.equal(aTruoc.cogsKnown, false);
    assert.equal(aTruoc.expectedCogs, 600_000, "chỉ 3 đơn đã giao của mẫu mã có giá mang giá vốn");
    assert.equal(aTruoc.expectedCogsEstimated, 0);
    assert.equal(aTruoc.estimatedCost, null);

    await db
      .insert(schema.settings)
      .values({
        key: ESTIMATED_COST_KEY,
        value: JSON.stringify({
          [`${P}pa`]: { unitCost: 150_000, reason: "báo giá xưởng", setAt: new Date().toISOString(), setBy: "kiem@thu" },
          [`${P}pb`]: { unitCost: 999_000, reason: "không được dùng", setAt: null, setBy: null },
          [`${P}pc`]: { unitCost: 100_000, reason: "lô thử", setAt: null, setBy: null },
        }),
      })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: sql`excluded.value` } });
    clearMemo();

    // ─── Mặc định TẮT: lương / quảng cáo / AI gọi không tham số và KHÔNG thấy giá đoán ───
    const macDinh = await getNominalProfitReport(ky);
    const aMacDinh = macDinh.rows.find((r) => r.code === "GVDT-A")!;
    assert.equal(aMacDinh.expectedCogs, 600_000, "đường gọi mặc định (bảng lương) không được nhận giá dự tính");
    assert.equal(aMacDinh.cogsKnown, false);

    const sau = await getNominalProfitReport(ky, "ORDERED", undefined, true, true);
    const a = sau.rows.find((r) => r.code === "GVDT-A")!;
    assert.equal(a.revenueBasis, "ORDER_LEVEL", "mã A chín ⇒ cân theo từng đơn");
    assert.equal(a.expectedCogsEstimated, 450_000, "giá dự tính × ĐÚNG 3 sản phẩm chưa có giá ĐÃ GIAO — không nhân cả 6 đã GTC ước tính của mã");
    assert.equal(a.expectedCogs, 1_050_000, "giá thật 600.000 + dự tính 450.000");
    assert.equal(a.cogsKnown, true);
    assert.equal(a.cogsUncoveredQty, 0);
    assert.equal(a.cogsUnknownQty, 6, "số sản phẩm KHÔNG có giá thật vẫn giữ nguyên — nó là sự thật, không đổi vì có người đặt giá");
    assert.equal(a.estimatedCost?.unitCost, 150_000);
    assert.equal(a.inventoryRisk, inventoryRiskOnSold(a.expectedCogs, Number(sau.assumptions.inventoryRiskPercent ?? 0)), "dự phòng rủi ro đi theo giá vốn đã gồm phần dự tính");
    assert.equal(a.netProfit, a.expectedProfit - a.opexTotal - a.inventoryRisk - a.tax - a.otherCost);
    assert.ok(a.netProfit <= aMacDinh.netProfit - 450_000, "lợi nhuận phải giảm ít nhất đúng phần giá vốn dự tính");

    const b = sau.rows.find((r) => r.code === "GVDT-B")!;
    assert.equal(b.estimatedCost, null, "mã đủ giá thật ⇒ giá dự tính đứng sang một bên");
    assert.equal(b.expectedCogsEstimated, 0);
    // Mã B chỉ có 1 đơn ⇒ chưa chín ⇒ nhánh theo tỷ lệ: giá thật × TL GTC, không có đồng dự tính nào.
    assert.equal(b.expectedCogs, Math.round(200_000 * (1 - b.returnRate! / 100)));

    const c = sau.rows.find((r) => r.code === "GVDT-C")!;
    assert.equal(c.revenueBasis, "RATE", "mã C chưa chín ⇒ nhánh theo tỷ lệ");
    assert.ok(c.returnRate !== null);
    assert.equal(c.expectedCogsEstimated, Math.round(2 * (1 - c.returnRate! / 100) * 100_000), "nhánh tỷ lệ: SP chưa có giá × TL GTC × giá dự tính");
    const ngay = await getNominalDaily(ky, "ORDERED", { productId: `${P}pc`, marketerKey: null });
    assert.equal(ngay.total.expectedCogs, c.expectedCogs, "bảng theo ngày chia ĐÚNG giá vốn của dòng cha — gồm cả phần giá dự tính");
    assert.ok(ngay.days.length > 0 && ngay.days.every((d) => d.cell.cogsUncoveredQty === 0), "mã đã đặt giá dự tính ⇒ ngày không in “—” ở giá vốn");

    assert.equal(sau.totals.expectedCogsEstimated, sau.rows.reduce((t, r) => t + r.expectedCogsEstimated, 0));
    assert.ok(sau.totals.estimatedCostProducts >= 2);

    // Trần hoà vốn của một dòng thật: chi đúng bằng trần thì LN danh nghĩa về 0.
    const o = Number(sau.assumptions.otherCostPercentOfAds ?? 0);
    const tran = adsCeiling({ netProfit: a.netProfit, adSpend: a.adSpend, otherCost: a.otherCost, expectedRevenue: a.expectedRevenue, posSales: a.salesAfterDiscount, orders: a.orders, otherCostPercentOfAds: o, targetMarginPct: null });
    assert.ok(Math.abs(a.netProfit + a.adSpend + a.otherCost - tran.breakEven.spend * (1 + o / 100)) <= 1, "trần hoà vốn là phép tính ngược đúng của LN danh nghĩa");

    console.log("✓ Giá vốn dự tính: chỉ lấp sản phẩm chưa có giá thật · giá thật thắng · đi đúng đường số lượng ở cả nhánh cân theo đơn lẫn theo tỷ lệ · bảng lương không thấy · trần CPQC là phép tính ngược đúng của LN danh nghĩa");
  } finally {
    const ship = [...Array.from({ length: 12 }, (_, i) => `${P}s-a${i}`), `${P}s-b0`, `${P}s-c0`];
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, ship));
    await db.delete(schema.shipmentCare).where(inArray(schema.shipmentCare.shipmentId, ship));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, ship));
    await db.delete(schema.orderItems).where(sql`${schema.orderItems.id} like ${`${P}i-%`}`);
    await db.delete(schema.orders).where(sql`${schema.orders.id} like ${`${P}o-%`}`);
    await db.delete(schema.productVariants).where(inArray(schema.productVariants.id, [`${P}va-co`, `${P}va-thieu`, `${P}vb`, `${P}vc`]));
    await db.delete(schema.products).where(inArray(schema.products.id, [`${P}pa`, `${P}pb`, `${P}pc`]));
    await db.delete(schema.settings).where(eq(schema.settings.key, ESTIMATED_COST_KEY));
    clearMemo();
  }
}
