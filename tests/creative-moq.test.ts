import assert from "node:assert/strict";
import { eq, inArray, like, notInArray, or } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { CREATIVE_CONFIG_KEY, DESIGN_MOQ, designCode, designMoqReached, parseDesignMoqSnapshot, type DesignDna, type Genes } from "@/lib/constants/creative-loop";
import { shiftDay, vnDay } from "@/lib/constants/marketing-decision-ledger";
import { cellKey } from "@/lib/constants/production";
import { runCreativeLoopTick } from "@/lib/creative/loop";
import { MOQ_DRAFT_CREATED_BY, buildMoqDraft, moqDraftCode, moqNotice, moqSnapshotOf, runDesignMoq } from "@/lib/creative/moq";
import type { CreativeNotice } from "@/lib/creative/notify";
import type { CreativeWriter } from "@/lib/creative/publish";
import { listDesignConcepts } from "@/lib/queries/creative-design";
import { designMoqCounts, emptyMoqCount, type DesignMoqCount } from "@/lib/queries/creative-moq";

/**
 * ═══════════ VÒNG MẪU — MOQ THIẾT KẾ MỚI ⇒ NHÁP LỆNH SẢN XUẤT (docs/creative-loop.md §5h) ═══════════
 *
 * Khoá:
 *  (1) Ranh giới: 49 đơn ⇒ KHÔNG nháp; 50 ⇒ ĐÚNG MỘT nháp; chạy lại ⇒ không nháp thứ hai; người xoá nháp ⇒
 *      máy KHÔNG dựng lại.
 *  (2) Đếm: đơn đã xác nhận (đơn huỷ / đơn Mới / dòng chỉ-quà không tính); hai đường (mã TK · ad_id) HỢP theo
 *      id đơn — đơn trùng tính một lần; số lượng chỉ từ dòng mã TK, màu/size chưa rõ không chia vào ma trận.
 *  (3) Nháp: `DRAFT`, giá gia công NULL (chưa biết), xưởng trống; thiết kế KHÔNG bị đổi sang `PRODUCTION`.
 *  (4) Lệnh người đã lập sẵn cho đúng mã ⇒ nối vào, không dựng thêm.
 *  (5) Lượt vòng mẫu gửi MỘT tin cho mỗi thiết kế, lượt sau không gửi lại.
 *
 * Mã thiết kế và ngày lô dựng từ đồng hồ thật (AGENTS.md mục 50) — không ngày tuyệt đối nào, không cửa sổ
 * thời gian nào trong phép đếm.
 */

const P = "moq-";
const H = 3_600_000;
const DNA: DesignDna = { category: "DRESS", silhouette: "A_LINE", length: "MIDI", neckline: "V_NECK", sleeve: "SHORT", material: "CHIFFON", pattern: "FLORAL", colorFamily: "PINK", detail: "RUFFLE", style: "CASUAL" };
const G: Genes = { angle: "SOCIAL_PROOF", scene: "STREET", model: "FEMALE_YOUNG", composition: "SINGLE_HERO", textOverlay: "PRICE_BADGE", palette: "WARM" };

function count(over: Partial<DesignMoqCount>): DesignMoqCount {
  return { ...emptyMoqCount({ id: "d", code: "TK-260101-01" }), ...over };
}

// ───────────────────────────── hàm thuần ─────────────────────────────

export function testCreativeMoqPure() {
  assert.equal(DESIGN_MOQ.minOrders, 50, "chủ shop chốt 24/09/2026: MOQ = 50 đơn");
  assert.equal(designMoqReached(49), false, "49 đơn chưa đủ");
  assert.equal(designMoqReached(50), true, "50 đơn là đủ (ranh giới >=)");
  assert.equal(designMoqReached(Number.NaN), false, "không đếm được ⇒ không kết luận đủ");

  const at = new Date();
  const c = count({
    viaAd: 19,
    viaCode: 41,
    both: 10,
    orders: 50,
    adOnly: 9,
    productIds: ["p1"],
    productName: "Đầm thiết kế",
    qtyKnown: 53,
    qtyNoVariant: 3,
    lines: [
      { color: "Hồng", size: "L", qty: 5 },
      { color: "Đen", size: "L", qty: 20 },
      { color: "Đen", size: "M", qty: 25 },
    ],
  });
  const d = buildMoqDraft({ code: "TK-260101-01" }, c, at);
  assert.equal(d.code, "PO-TK-260101-01");
  assert.equal(d.code, moqDraftCode("TK-260101-01"));
  assert.equal(d.productId, "p1");
  assert.equal(d.productCode, "TK-260101-01");
  assert.equal(d.totalQty, 53, "total_qty = tổng số lượng dòng mã TK (kể cả phần chưa rõ màu/size)");
  assert.deepEqual(d.colors, ["Đen", "Hồng"], "màu bán nhiều đứng trước");
  assert.deepEqual(d.sizes, ["M", "L"], "size theo thứ tự size của trang đặt hàng");
  assert.deepEqual(d.cells, { [cellKey("Đen", "M")]: 25, [cellKey("Đen", "L")]: 20, [cellKey("Hồng", "L")]: 5 });
  assert.match(d.note, /3 sp chưa rõ màu hoặc size/, "phần chưa biết được KỂ RA, không chia hộ");
  assert.match(d.note, /9 đơn chỉ nối qua quảng cáo/, "đơn chỉ-qua-quảng-cáo: số lượng CHƯA BIẾT, được kể ra");
  assert.match(d.note, /50\/50 đơn đã xác nhận = 41 qua sản phẩm mã TK \+ 9 chỉ qua quảng cáo/);
  assert.match(d.note, /10 đơn thấy ở cả hai đường, tính một lần/);
  assert.match(d.note, /KHÔNG gửi xưởng/);
  assert.ok(d.note.length <= 1000, "ghi chú vừa giới hạn 1.000 ký tự của trình sửa lệnh");
  assert.deepEqual(buildMoqDraft({ code: "TK-260101-01" }, c, at), d, "TẤT ĐỊNH");

  const noProduct = buildMoqDraft({ code: "TK-260101-02" }, count({ viaAd: 50, orders: 50, adOnly: 50 }), at);
  assert.equal(noProduct.productId, null);
  assert.equal(noProduct.productName, "Thiết kế TK-260101-02");
  assert.equal(noProduct.totalQty, 0);
  assert.deepEqual(noProduct.colors, []);
  assert.match(noProduct.note, /Chưa có sản phẩm Pancake mã TK-260101-02/);

  const snap = moqSnapshotOf(c, at, false);
  assert.deepEqual(parseDesignMoqSnapshot(JSON.parse(JSON.stringify(snap))), snap, "ảnh chụp đọc lại nguyên vẹn");
  assert.equal(parseDesignMoqSnapshot({}), null);
  const n = moqNotice({ code: "TK-260101-01", reachedAt: at, snapshot: snap, orderCode: "PO-TK-260101-01" });
  assert.equal(n.kind, "MOQ");
  assert.equal(n.dedupeKey, `${vnDay(at)}:TK-260101-01`, "chống gửi lặp theo MÃ THIẾT KẾ, khoá bắt đầu bằng ngày để sổ tự dọn");
  assert.match(n.title, /NHÁP lệnh sản xuất PO-TK-260101-01/);
  assert.ok(n.lines.some((l) => /KHÔNG gửi xưởng/.test(l)));
  assert.match(moqNotice({ code: "TK-260101-01", reachedAt: at, snapshot: { ...snap, linkedExisting: true }, orderCode: "PO-X" }).title, /nối lệnh sản xuất có sẵn PO-X/);

  console.log("✓ Vòng mẫu — MOQ (thuần): ranh giới 49/50 · nháp tất định · chưa biết thì kể ra, không đoán · tin khoá theo mã");
}

// ───────────────────────────── PGlite ─────────────────────────────

async function cleanup(db: Db, codes: string[], batchId: string) {
  const dc = schema.designConcepts;
  const po = schema.productionOrders;
  await db.delete(po).where(or(inArray(po.code, codes.map(moqDraftCode)), like(po.code, `${P}%`)));
  await db.delete(schema.creativeVariants).where(eq(schema.creativeVariants.batchId, batchId));
  await db.delete(dc).where(inArray(dc.code, codes));
  await db.delete(schema.creativeBatches).where(eq(schema.creativeBatches.id, batchId));
  await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
}

export async function testCreativeMoqDb(db: Db) {
  const realNow = new Date();
  // Ngày lô xa trong tương lai (theo đồng hồ thật) để mã TK và ngày lô không đụng khối kiểm khác.
  const batchDay = shiftDay(vnDay(realNow), 700);
  const [c1, c2, c3] = [91, 92, 93].map((n) => designCode(batchDay, n));
  const codes = [c1, c2, c3];
  const batchId = `${P}batch`;
  const [prevCfg] = await db.select().from(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  const prevLearnings = (await db.select({ id: schema.creativeLearnings.id }).from(schema.creativeLearnings)).map((r) => r.id);
  await cleanup(db, codes, batchId);
  try {
    const start = new Date(realNow.getTime() + 700 * 24 * H);
    await db.insert(schema.creativeBatches).values({ id: batchId, batchDay, status: "PLANNED", slotCount: 3, startAt: start, endAt: new Date(start.getTime() + 24 * H), approvalDeadline: new Date(start.getTime() - H), ruleVersion: 1 });
    const [d1, d2, d3] = await db
      .insert(schema.designConcepts)
      .values(codes.map((code) => ({ code, batchId, dna: DNA, dnaVersion: 1, status: "TESTING" })))
      .returning({ id: schema.designConcepts.id, code: schema.designConcepts.code });
    // Mẩu QC mang thiết kế 1 và 3 (thiết kế 2 chỉ bán qua mã TK).
    await db.insert(schema.creativeVariants).values([
      { batchId, slot: 1, mode: "DESIGN", genes: G, genesVersion: 1, designConceptId: d1.id, fbAdId: `${P}ad-1` },
      { batchId, slot: 3, mode: "DESIGN", genes: G, genesVersion: 1, designConceptId: d3.id, fbAdId: `${P}ad-3` },
    ]);
    // Sản phẩm Pancake đúng mã TK (mã gõ thường + dấu cách — so khớp phải chuẩn hoá), và một mã khác.
    await db.insert(schema.products).values([
      { id: `${P}p1`, name: "Đầm TK một", customId: ` ${c1.toLowerCase()} ` },
      { id: `${P}p2`, name: "Áo TK hai", customId: c2 },
      { id: `${P}other`, name: "Mã cũ", customId: `${P}Q001` },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}v-den-m`, productId: `${P}p1`, color: "Đen", size: "M" },
      { id: `${P}v-den-l`, productId: `${P}p1`, color: "Đen", size: "L" },
      { id: `${P}v-hong`, productId: `${P}p1`, color: "Hồng", size: "" },
      { id: `${P}v2`, productId: `${P}p2`, color: "Trắng", size: "S" },
      { id: `${P}v-other`, productId: `${P}other`, color: "Đỏ", size: "M" },
    ]);

    let n = 0;
    type Line = { productId?: string | null; variantId?: string | null; quantity?: number; isBonus?: boolean };
    const orders: (typeof schema.orders.$inferInsert)[] = [];
    const items: (typeof schema.orderItems.$inferInsert)[] = [];
    const order = (o: { stage?: string; adId?: string | null; lines: Line[] }) => {
      n += 1;
      const id = `${P}o-${n}`;
      orders.push({ id, stage: (o.stage ?? "CONFIRMED") as never, cod: 400_000, totalPriceAfterDiscount: 400_000, prepaid: 0, adId: o.adId ?? null, insertedAt: new Date(realNow.getTime() - n * 60_000) });
      o.lines.forEach((l, i) => items.push({ id: `${P}oi-${n}-${i}`, orderId: id, productId: l.productId ?? null, variantId: l.variantId ?? null, quantity: l.quantity ?? 1, isBonus: l.isBonus ?? false }));
      return id;
    };
    const flush = async () => {
      if (orders.length) await db.insert(schema.orders).values(orders.splice(0));
      if (items.length) await db.insert(schema.orderItems).values(items.splice(0));
    };

    // ── Thiết kế 1: 30 chỉ qua mã TK · 10 qua CẢ HAI đường · 9 chỉ qua quảng cáo ⇒ HỢP = 49 ──
    for (let i = 0; i < 30; i += 1) order({ lines: [{ productId: `${P}p1`, variantId: `${P}v-den-m` }] });
    for (let i = 0; i < 10; i += 1) order({ adId: `${P}ad-1`, lines: [{ variantId: `${P}v-den-l`, quantity: 2 }] }); // chỉ variant_id, không product_id
    for (let i = 0; i < 9; i += 1) order({ adId: `${P}ad-1`, lines: [{ productId: `${P}other`, variantId: `${P}v-other` }] });
    // Không tính: đơn huỷ, đơn xoá, đơn Mới chưa chốt, đơn chỉ có dòng QUÀ mã TK.
    for (const stage of ["CANCELLED", "DELETED", "NEW"]) order({ stage, lines: [{ productId: `${P}p1`, variantId: `${P}v-den-m` }] });
    order({ stage: "CANCELLED", adId: `${P}ad-1`, lines: [{ productId: `${P}other` }] });
    order({ lines: [{ productId: `${P}p1`, variantId: `${P}v-den-m`, isBonus: true }] });
    // ── Thiết kế 2: 50 đơn qua mã TK — người đã lập sẵn lệnh cho mã này ──
    for (let i = 0; i < 50; i += 1) order({ lines: [{ productId: `${P}p2`, variantId: `${P}v2`, quantity: 1 }] });
    // ── Thiết kế 3: 50 đơn chỉ qua quảng cáo, chưa có sản phẩm Pancake mã TK ──
    for (let i = 0; i < 50; i += 1) order({ adId: `${P}ad-3`, lines: [{}] }); // dòng gõ tay: không product_id, không variant_id
    await flush();
    await db.insert(schema.productionOrders).values({ code: `${P}PO-nguoi`, productId: `${P}p2`, productCode: c2, productName: "Áo TK hai", status: "DRAFT", totalQty: 60, unitCost: 120_000, createdBy: "tester" });

    // ═══ (2) ĐẾM ═══
    const cnt = await designMoqCounts(db, [d1, d2, d3]);
    const k1 = cnt.get(d1.id) as DesignMoqCount;
    assert.equal(k1.viaCode, 40, "30 chỉ-mã + 10 hai-đường; đơn huỷ / xoá / Mới / chỉ-quà không tính");
    assert.equal(k1.viaAd, 19, "10 hai-đường + 9 chỉ-quảng-cáo; đơn huỷ mang ad_id không tính");
    assert.equal(k1.both, 10);
    assert.equal(k1.orders, 49, "HỢP theo id đơn: 40 + 19 − 10 — đơn trùng hai đường tính MỘT lần");
    assert.equal(k1.adOnly, 9);
    assert.equal(k1.qtyKnown, 50, "30×1 + 10×2 — chỉ dòng mã TK, không tính quà");
    assert.deepEqual(k1.productIds, [`${P}p1`], "mã gõ thường + dấu cách vẫn khớp");
    const k3 = cnt.get(d3.id) as DesignMoqCount;
    assert.equal(k3.orders, 50);
    assert.equal(k3.viaCode, 0);
    assert.equal(k3.qtyKnown, 0, "đơn chỉ qua quảng cáo, dòng gõ tay: số lượng CHƯA BIẾT, không đoán từ tên");

    // ═══ (1) 49 đơn ⇒ KHÔNG nháp (thiết kế 2 + 3 đủ) ═══
    const tick1 = await runDesignMoq(db, realNow);
    assert.deepEqual(tick1.warnings, []);
    assert.deepEqual(tick1.reports.map((r) => r.code).sort(), [c2, c3], "chỉ thiết kế ĐỦ 50 đơn");
    const [row1] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, d1.id));
    assert.equal(row1.productionOrderId, null);
    assert.equal(row1.moqReachedAt, null, "49 đơn: không mốc, không nháp");

    // ═══ (4) Lệnh người lập sẵn ⇒ nối, không dựng thêm ═══
    const r2 = tick1.reports.find((r) => r.code === c2);
    assert.equal(r2?.created, false);
    assert.equal(r2?.productionOrderCode, `${P}PO-nguoi`);
    assert.equal((await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.code, moqDraftCode(c2)))).length, 0);
    const [row2] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, d2.id));
    assert.equal(parseDesignMoqSnapshot(row2.moqSnapshot)?.linkedExisting, true);

    // Thiết kế 3: nháp không có sản phẩm Pancake.
    const [po3] = await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.code, moqDraftCode(c3)));
    assert.equal(po3.productId, null);
    assert.equal(po3.totalQty, 0);
    assert.match(po3.note, /Chưa có sản phẩm Pancake/);

    // ═══ Đơn thứ 50 của thiết kế 1 (dòng chỉ có product_id — màu/size CHƯA BIẾT) ⇒ ĐÚNG MỘT nháp ═══
    order({ lines: [{ productId: `${P}p1`, quantity: 3 }, { productId: `${P}p1`, variantId: `${P}v-hong`, quantity: 1 }] });
    await flush();
    const tick2 = await runDesignMoq(db, realNow);
    assert.deepEqual(tick2.warnings, []);
    assert.deepEqual(
      tick2.reports.map((r) => [r.code, r.orders, r.created]),
      [[c1, 50, true]],
    );
    const drafts = await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.code, moqDraftCode(c1)));
    assert.equal(drafts.length, 1);
    const po1 = drafts[0];
    assert.equal(po1.status, "DRAFT", "nháp — máy KHÔNG gửi xưởng");
    assert.equal(po1.sentAt, null);
    assert.equal(po1.unitCost, null, "giá gia công CHƯA BIẾT là NULL, không phải 0đ");
    assert.equal(po1.supplier, "");
    assert.equal(po1.productId, `${P}p1`);
    assert.equal(po1.createdBy, MOQ_DRAFT_CREATED_BY);
    assert.equal(po1.totalQty, 54, "30 + 20 + 3 + 1");
    assert.deepEqual(po1.colors, ["Đen"]);
    assert.deepEqual(po1.sizes, ["M", "L"]);
    assert.deepEqual(po1.cells, { [cellKey("Đen", "M")]: 30, [cellKey("Đen", "L")]: 20 }, "chỉ ô biết đủ màu + size");
    assert.match(po1.note, /4 sp chưa rõ màu hoặc size/);
    assert.match(po1.note, /9 đơn chỉ nối qua quảng cáo/);
    const [row1b] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, d1.id));
    assert.equal(row1b.productionOrderId, po1.id);
    assert.ok(row1b.moqReachedAt);
    assert.equal(row1b.status, "TESTING", "máy KHÔNG BAO GIỜ đặt PRODUCTION");
    assert.equal(parseDesignMoqSnapshot(row1b.moqSnapshot)?.orders, 50);

    // ═══ Chạy lại ⇒ không nháp thứ hai; thêm đơn cũng không ═══
    order({ lines: [{ productId: `${P}p1`, variantId: `${P}v-den-m` }] });
    await flush();
    const tick3 = await runDesignMoq(db, realNow);
    assert.deepEqual(tick3.reports, []);
    assert.equal((await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.code, moqDraftCode(c1)))).length, 1);

    // ═══ Người xoá nháp ⇒ nối về NULL, máy KHÔNG dựng lại ═══
    await db.delete(schema.productionOrders).where(eq(schema.productionOrders.id, po1.id));
    const tick4 = await runDesignMoq(db, realNow);
    assert.deepEqual(tick4.reports, []);
    assert.equal((await db.select().from(schema.productionOrders).where(eq(schema.productionOrders.code, moqDraftCode(c1)))).length, 0);
    const [row1c] = await db.select().from(schema.designConcepts).where(eq(schema.designConcepts.id, d1.id));
    assert.equal(row1c.productionOrderId, null);
    assert.ok(row1c.moqReachedAt, "mốc giữ nguyên — xoá nháp là một quyết định");

    // ═══ Màn hình: tiến độ x/50 + lệnh đang nối ═══
    const screen = (await listDesignConcepts(db, 500)).filter((r) => codes.includes(r.code));
    const s1 = screen.find((r) => r.code === c1);
    assert.equal(s1?.moq.orders, 51);
    assert.equal(s1?.productionOrder, null);
    assert.ok(s1?.moqReachedAt, "nháp đã xoá: màn hình nói ra");
    assert.equal(screen.find((r) => r.code === c2)?.productionOrder?.code, `${P}PO-nguoi`);
    assert.equal(screen.find((r) => r.code === c3)?.productionOrder?.code, moqDraftCode(c3));

    // ═══ (5) Lượt vòng mẫu: MỘT tin cho mỗi thiết kế chưa báo, lượt sau không gửi lại ═══
    await db
      .insert(schema.settings)
      .values({ key: CREATIVE_CONFIG_KEY, value: JSON.stringify({ enabled: false }) })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: JSON.stringify({ enabled: false }) } });
    const writer = new Proxy({} as CreativeWriter, {
      get: () => async () => {
        throw new Error("MOQ không được gọi Facebook");
      },
    });
    const notices: CreativeNotice[] = [];
    const deps = { notify: async (x: CreativeNotice) => void notices.push(x), write: { writer }, evaluate: { writeNarrative: null } };
    const t1 = await runCreativeLoopTick(db, realNow, deps);
    assert.ok(!t1.warnings.some((w) => /MOQ/.test(w)), `lượt vòng mẫu không lỗi ở bước MOQ: ${t1.warnings.join(" | ")}`);
    const moqNotices = notices.filter((x) => x.kind === "MOQ" && codes.some((c) => x.dedupeKey?.endsWith(c)));
    assert.deepEqual(moqNotices.map((x) => x.dedupeKey?.split(":")[1]).sort(), [c1, c2, c3], "một tin cho MỖI thiết kế đủ MOQ");
    await runCreativeLoopTick(db, realNow, deps);
    assert.equal(notices.filter((x) => x.kind === "MOQ" && codes.some((c) => x.dedupeKey?.endsWith(c))).length, 3, "lượt sau không gửi lại");
    const notified = await db.select({ at: schema.designConcepts.moqNotifiedAt }).from(schema.designConcepts).where(inArray(schema.designConcepts.code, codes));
    assert.ok(notified.every((r) => r.at !== null));
  } finally {
    await cleanup(db, codes, batchId);
    if (prevLearnings.length) await db.delete(schema.creativeLearnings).where(notInArray(schema.creativeLearnings.id, prevLearnings));
    else await db.delete(schema.creativeLearnings).where(inArray(schema.creativeLearnings.learningDay, [vnDay(realNow)]));
    if (prevCfg) await db.update(schema.settings).set({ value: prevCfg.value }).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
    else await db.delete(schema.settings).where(eq(schema.settings.key, CREATIVE_CONFIG_KEY));
  }
  console.log("✓ Vòng mẫu — MOQ (PGlite): 49 ⇒ không nháp · 50 ⇒ đúng một nháp · chạy lại / xoá nháp không dựng lại · đơn huỷ không tính · trùng hai đường tính một lần · nối lệnh có sẵn · một tin mỗi thiết kế");
}
