import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import {
  BULK_DECLARE_DEFAULT_REASON,
  BULK_DECLARE_MAX,
  BULK_DECLARE_NO_SUGGESTION_LABEL,
  BULK_DECLARE_SOURCE,
  buildDeclarePreview,
  modelSuggestSource,
  type DeclareRowResult,
} from "@/lib/constants/model-bulk-declare";
import { MODEL_REASON_MIN_LENGTH, observeModelStage, type ModelEvidence, type ModelState } from "@/lib/constants/model-lifecycle";
import { declareModelsFromSuggestionCore } from "@/lib/models/bulk-declare";
import { transitionModelCore } from "@/lib/models/service";
import { getModel, getModelEvidence, getModelsEvidenceBatch, listModels, MODEL_STATE_NONE } from "@/lib/queries/models";
import type { ListParams } from "@/lib/search-params";

/**
 * ═══════════ COMPANY OS · AGENT Q · KHAI THEO GỢI Ý ═══════════
 *
 * Máy GỢI Ý giai đoạn (ước tính), NGƯỜI bấm. Bài khoá:
 *  1. Chứng cứ theo lô (`getModelsEvidenceBatch`) = `getModelEvidence` từng mẫu, trên MỌI mẫu của CSDL
 *     kiểm thử, ở hai mốc cố định — kể cả ô CHƯA BIẾT (`null`) phải là `null`, không phải 0.
 *  2. Bảng xem trước chỉ có mẫu CHƯA KHAI; không gợi ý ⇒ không chọn được, không tick sẵn.
 *  3. Lõi ghi: người có khoá tài khoản (USER + users.id), lịch sử + sự kiện mang gợi ý và "chấp nhận hay
 *     chọn khác"; mẫu đã có người khai trong lúc màn hình mở ⇒ BỎ QUA, không đè; dòng hỏng không kéo dòng
 *     khác; bấm lại / bấm đồng thời ⇒ không có dòng thứ hai; không gợi ý ⇒ máy chủ từ chối dù client gửi.
 *  4. Mã nguồn: chỉ server action gọi lõi; không job / đồng bộ nào ghi với nguồn này.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): dữ liệu gieo năm 2003–2004, mốc `now` truyền CỐ ĐỊNH.
 */

const P = "cos-q-";
const at = (d: string) => new Date(`${d}T03:00:00Z`);
const NOW = new Date("2004-07-01T00:00:00Z");
const NOW_2 = new Date("2004-06-10T00:00:00Z");
const U = `${P}u1`;
const U2 = `${P}u2`;
const NGUOI = { id: U, label: "Người khai Q" };
const NGUOI_KHAC = { id: U2, label: "Người khác Q" };
const M = (x: string) => `${P}m${x}`;

async function donDep(db: Db) {
  const models = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`))).map((m) => m.id);
  if (models.length) {
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, models));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, models));
    await db.delete(schema.productModels).where(inArray(schema.productModels.id, models));
  }
  const receipts = (await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, `${P}%`))).map((r) => r.id);
  if (receipts.length) {
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receipts));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  }
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  await db.delete(schema.orderItems).where(like(schema.orderItems.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.adSpends).where(like(schema.adSpends.id, `${P}%`));
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.designConcepts).where(like(schema.designConcepts.id, `${P}%`));
  await db.execute(sql.raw(`drop trigger if exists cos_q_fail on product_model_state_history`));
  await db.execute(sql.raw(`drop function if exists cos_q_fail_fn()`));
}

async function gieo(db: Db) {
  await db.insert(schema.users).values([
    { id: U, email: "cos-q-1@test.local", name: "Người khai Q", passwordHash: "x", role: "LEADER" },
    { id: U2, email: "cos-q-2@test.local", name: "Người khác Q", passwordHash: "x", role: "LEADER" },
  ]).onConflictDoNothing();
  await db.insert(schema.designConcepts).values([
    { id: `${P}d1`, code: "TK-040101-81", dna: {}, dnaVersion: 1, status: "TESTING" },
    { id: `${P}d7`, code: "TK-040101-87", dna: {}, dnaVersion: 1, status: "DRAFT" },
    { id: `${P}d8`, code: "TK-040101-88", dna: {}, dnaVersion: 1, status: "LOSE" },
  ]);
  await db.insert(schema.products).values(["p2", "p3", "p4", "p4x", "p5", "p6"].map((x) => ({ id: `${P}${x}`, name: `SP Q ${x}`, customId: `COSQ-${x.toUpperCase()}` })));
  await db.insert(schema.productVariants).values([
    { id: `${P}v2`, productId: `${P}p2`, sku: "COSQ-P2-M", color: "Đen", size: "M" },
    { id: `${P}v3`, productId: `${P}p3`, sku: "COSQ-P3-M", color: "Đen", size: "M" },
    { id: `${P}v6`, productId: `${P}p6`, sku: "COSQ-P6-M", color: "Đen", size: "M" },
  ]);
  await db.insert(schema.productModels).values([
    { id: M("1"), code: "COSQ-1", name: "Thiết kế đang test", designConceptId: `${P}d1`, registeredBy: "SYNC" },
    { id: M("2"), code: "COSQ-2", name: "Có đơn trong 30 ngày", productId: `${P}p2`, registeredBy: "SYNC" },
    { id: M("3"), code: "COSQ-3", name: "Có sản phẩm, chưa gì cả", productId: `${P}p3`, registeredBy: "SYNC" },
    { id: M("4"), code: "COSQ-4", name: "Có chi QC đã ghép", productId: `${P}p4`, registeredBy: "SYNC" },
    { id: M("4x"), code: "COSQ-4X", name: "Chi QC bị loại — chưa ghép", productId: `${P}p4x`, registeredBy: "SYNC" },
    { id: M("5"), code: "COSQ-5", name: "Có lệnh SX đã gửi", productId: `${P}p5`, registeredBy: "SYNC" },
    { id: M("6"), code: "COSQ-6", name: "Có tồn, đơn cũ", productId: `${P}p6`, registeredBy: "SYNC" },
    { id: M("7"), code: "COSQ-7", name: "Đã khai", designConceptId: `${P}d7`, lifecycleState: "IDEA", registeredBy: "SYNC" },
    { id: M("8"), code: "COSQ-8", name: "Thiết kế loại", designConceptId: `${P}d8`, registeredBy: "SYNC" },
    { id: M("9"), code: "COSQ-9", name: "Trống", registeredBy: "USER" },
  ]);
  await db.insert(schema.orders).values([
    { id: `${P}o2`, stage: "CONFIRMED", status: 1, insertedAt: at("2004-06-20"), updatedAt: at("2004-06-20") },
    { id: `${P}o2b`, stage: "CANCELLED", status: 6, insertedAt: at("2004-06-21"), updatedAt: at("2004-06-21") },
    { id: `${P}o6`, stage: "CONFIRMED", status: 1, insertedAt: at("2003-12-01"), updatedAt: at("2003-12-01") },
  ]);
  const dong = (id: string, order: string, variantId: string, productId: string) => ({ id: `${P}${id}`, orderId: `${P}${order}`, variantId, productId, productName: `SP ${productId}`, sku: variantId, quantity: 1, unitPrice: 400_000, lineTotal: 400_000 });
  await db.insert(schema.orderItems).values([dong("i2", "o2", `${P}v2`, `${P}p2`), dong("i2b", "o2b", `${P}v2`, `${P}p2`), dong("i6", "o6", `${P}v6`, `${P}p6`)]);
  await db.insert(schema.adSpends).values([
    { id: `${P}ad4`, platform: "facebook", spend: 500_000, spendDate: at("2004-06-15"), productId: `${P}p4` },
    { id: `${P}ad4e`, platform: "facebook", spend: 200_000, spendDate: at("2004-06-16"), productId: `${P}p4`, excluded: true },
    { id: `${P}ad4o`, platform: "facebook", spend: 900_000, spendDate: at("2004-05-01"), productId: `${P}p4` },
    { id: `${P}ad4x`, platform: "facebook", spend: 700_000, spendDate: at("2004-06-15"), productId: `${P}p4x`, excluded: true },
  ]);
  await db.insert(schema.productionOrders).values({ id: `${P}po5`, code: `${P}PO-5`, productId: `${P}p5`, productCode: "COSQ-P5", productName: "SP Q p5", status: "SENT", totalQty: 50, unitCost: 0, supplier: "Xưởng Q", sentAt: at("2004-06-01") });
  const [phieu] = await db
    .insert(schema.stockReceipts)
    .values({ kind: "RECEIPT", receivedAt: at("2004-01-01"), reference: `${P}r6`, totalQuantity: 10, totalCost: 1_000_000, createdBy: "test" })
    .returning({ id: schema.stockReceipts.id });
  await db.insert(schema.stockReceiptItems).values({ receiptId: phieu.id, variantId: `${P}v6`, quantity: 10, unitCost: 100_000 });
}

const LIST: ListParams = {
  page: 1,
  pageSize: BULK_DECLARE_MAX,
  sort: "code",
  dir: "asc",
  q: "COSQ-",
  filters: { state: [MODEL_STATE_NONE] },
  period: { key: "all", from: null, to: null, label: "Toàn bộ", fromKey: null, toKey: null },
};

// ─────────────────────────── THUẦN ───────────────────────────

export function testCompanyOsBulkDeclarePure() {
  const trong: ModelEvidence = { designStatus: null, productRemoved: false, adSpend30d: null, orders30d: 0, ordersTotal: 0, draftProductionOrders: 0, sentProductionOrders: 0, stockKnown: false, stockOnHand: null };
  const ev = new Map<string, ModelEvidence>([
    ["a", { ...trong, designStatus: "TESTING" }],
    ["b", trong],
    ["c", { ...trong, orders30d: 3, ordersTotal: 3 }],
    ["d", { ...trong, designStatus: "WIN" }],
  ]);
  const rows = buildDeclarePreview(
    [
      { id: "a", code: "A", name: "", productName: "Tên SP", image: null, state: null },
      { id: "b", code: "B", name: "B", image: null, state: null },
      { id: "c", code: "C", name: "C", image: null, state: null },
      { id: "d", code: "D", name: "D", image: null, state: "IDEA" },
      { id: "e", code: "E", name: "E", image: null, state: null },
    ],
    ev,
  );
  assert.deepEqual(rows.map((r) => r.modelId), ["a", "b", "c", "e"], "mẫu ĐÃ KHAI không bao giờ vào bảng gợi ý");
  const theo = (id: string) => rows.find((r) => r.modelId === id)!;
  assert.equal(theo("a").suggested, "ADS_TESTING");
  assert.equal(theo("a").name, "Tên SP", "mẫu không tên lấy tên sản phẩm");
  assert.ok(theo("a").selectable && theo("a").defaultChecked, "có gợi ý ⇒ chọn được, tick sẵn");
  assert.equal(theo("b").suggested, null, "chi QC CHƯA BIẾT + 0 đơn ⇒ máy không đoán");
  assert.ok(!theo("b").selectable && !theo("b").defaultChecked, "không gợi ý ⇒ KHÔNG chọn được, không tick sẵn");
  assert.ok(theo("b").unknowns.some((x) => /Chi quảng cáo CHƯA BIẾT/.test(x)), "ô chi QC chưa biết phải được NÓI RA");
  assert.equal(theo("c").suggested, "SELLING");
  assert.ok(!theo("e").selectable && theo("e").unknowns.length === 1, "mẫu không đọc được chứng cứ ⇒ không chọn được, và nói rõ vì sao");
  // Luật 42: chi QC chưa biết không phải "có chạy" — không bao giờ sinh gợi ý Test quảng cáo.
  assert.equal(observeModelStage({ ...trong, adSpend30d: null }).stage, null);
  assert.equal(observeModelStage({ ...trong, adSpend30d: 1 }).stage, "ADS_TESTING");
  assert.ok(BULK_DECLARE_DEFAULT_REASON.trim().length >= MODEL_REASON_MIN_LENGTH, "lý do điền sẵn phải qua được chính cổng lý do");
  assert.equal(BULK_DECLARE_NO_SUGGESTION_LABEL, "Chưa đủ dữ liệu để gợi ý");
  assert.equal(modelSuggestSource("x"), "ui:/models/x:suggest");
  console.log("✓ Company OS · Q (thuần): bảng gợi ý chỉ có mẫu chưa khai · không gợi ý ⇒ không chọn được · chi QC chưa biết không thành chứng cứ · lý do điền sẵn đủ dài");
}

// ─────────────────────────── MÃ NGUỒN ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(f)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

export function testCompanyOsBulkDeclareSource() {
  const doc = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
  const tep = ["lib", "app", "scripts", "components"].flatMap((d) => walk(d));

  const goiLoi = tep.filter((f) => f !== "lib/models/bulk-declare.ts" && /declareModelsFromSuggestionCore\(/.test(doc(f)));
  assert.deepEqual(goiLoi, ["lib/actions/models.ts"], "lõi khai theo gợi ý chỉ được gọi từ server action (sau một cú bấm)");
  const nguon = tep.filter((f) => doc(f).includes('"ui:/models:bulk-suggest"'));
  assert.deepEqual(nguon, ["lib/constants/model-bulk-declare.ts"], "chuỗi nguồn khai ở ĐÚNG một chỗ");
  const tuDong = tep.filter((f) => /^(lib\/sync\/|lib\/jobs|lib\/integrations\/|scripts\/|app\/api\/)/.test(f));
  for (const f of tuDong) {
    const s = doc(f);
    assert.ok(!/model-bulk-declare|models\/bulk-declare|BULK_DECLARE_SOURCE|modelSuggestSource/.test(s), `${f}: job / đồng bộ không được chạm luồng khai theo gợi ý — máy không tự khai`);
    if (f.startsWith("lib/sync/")) assert.ok(!/transitionModelCore\(/.test(s), `${f}: đồng bộ không được đổi trạng thái vòng đời`);
  }

  const loi = doc("lib/models/bulk-declare.ts");
  assert.ok(!/^"use server"/m.test(loi), "lõi không phải server action");
  assert.match(loi, /actorKind: "USER"/, "luồng này chỉ dành cho người");
  assert.ok(!/actorKind: "(SYSTEM|AGENT|WEBHOOK)"/.test(loi));
  assert.match(loi, /\.for\("update"\)/, "khoá dòng mẫu trước khi kiểm hàng rào");
  assert.ok(loi.indexOf("m.state !== item.expectedState") > 0 && loi.indexOf("m.state !== item.expectedState") < loi.indexOf("await transitionModelCore(tx"), "hàng rào 'vẫn chưa khai' đứng TRƯỚC lượt chuyển, trong cùng giao dịch");

  const act = doc("lib/actions/models.ts");
  const than = act.slice(act.indexOf("export async function declareModelsFromSuggestion"));
  assert.match(than, /can\(user, "models:write"\)/, "cần quyền khai");
  assert.match(than, /actor: \{ id: user\.id, label: user\.name \|\| user\.email \}/, "tên người do MÁY CHỦ đọc từ phiên (mục 34)");
  assert.match(than, /revalidatePath\("\/models", "layout"\)/, "làm mới /models và trang từng mẫu — client không router.refresh()");
  assert.match(than, /action: "MODEL_BULK_DECLARE"/);

  const page = doc("app/(dashboard)/models/page.tsx");
  assert.match(page, /const moKhai = canWrite && raw\.khai === "goi-y";/, "chứng cứ theo lô chỉ đọc khi người MỞ bảng gợi ý và có quyền khai");
  assert.match(page, /getModelsEvidenceBatch\(/);
  const panel = doc("app/(dashboard)/models/bulk-declare-panel.tsx");
  assert.ok(!/router\.refresh\s*\(/.test(panel.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), "bảng gợi ý không router.refresh() — action đã revalidate");
  assert.match(panel, /disabled=\{!r\.selectable \|\| pending\}/, "mẫu không gợi ý: ô tick bị khoá");
  const ctl = doc("app/(dashboard)/models/[id]/model-controls.tsx");
  assert.match(ctl, /declareModelsFromSuggestion\(\{ items: \[\{ modelId, state: to, expectedState: null \}\], reason, from: "detail" \}\)/, "trang một mẫu đi CÙNG luồng khai theo gợi ý");
  assert.match(ctl, /const theoGoiY = state === null && suggested !== null;/, "chỉ mẫu CHƯA KHAI mà máy có gợi ý mới đi luồng gợi ý");
  assert.match(ctl, /useState<ModelState \| "">\(theoGoiY \? suggested : /, "trang một mẫu chọn sẵn gợi ý");
  assert.match(ctl, /useState\(theoGoiY \? BULK_DECLARE_DEFAULT_REASON : ""\)/, "trang một mẫu điền sẵn cùng lý do");
  assert.match(doc("app/(dashboard)/models/[id]/page.tsx"), /suggested=\{model\.state === null \? observed\.stage : null\}/, "trang 360 truyền gợi ý của máy xuống ô khai");
  console.log("✓ Company OS · Q (mã nguồn): chỉ server action gọi lõi · không job / đồng bộ chạm luồng này · hàng rào chưa-khai trước lượt chuyển · bảng không refresh thừa");
}

// ─────────────────────────── CSDL ───────────────────────────

export async function testCompanyOsBulkDeclareDb(db: Db) {
  await donDep(db);
  try {
    await gieo(db);

    // ── 1. Lô = từng mẫu, trên MỌI mẫu của CSDL kiểm thử, hai mốc cố định ──
    const tatCa = (await db.select({ id: schema.productModels.id }).from(schema.productModels)).map((m) => m.id);
    for (const now of [NOW, NOW_2]) {
      const lo = await getModelsEvidenceBatch(tatCa, { now });
      assert.equal(lo.size, tatCa.length, "lô trả chứng cứ cho mọi mẫu tồn tại");
      for (const id of tatCa) {
        const mot = await getModelEvidence((await getModel(id))!, { now });
        assert.deepEqual(lo.get(id), mot, `mẫu ${id} @${now.toISOString()}: chứng cứ theo lô phải bằng ĐÚNG getModelEvidence`);
      }
    }
    assert.equal((await getModelsEvidenceBatch([`${P}khong-co`])).size, 0, "mẫu không tồn tại ⇒ không có trong kết quả");
    assert.equal((await getModelsEvidenceBatch([])).size, 0);

    const lo = await getModelsEvidenceBatch(tatCa, { now: NOW });
    const e = (x: string) => lo.get(M(x))!;
    assert.equal(e("3").adSpend30d, null, "chưa từng ghép chiến dịch ⇒ chi QC CHƯA BIẾT, không phải 0 (luật 42)");
    assert.equal(e("4x").adSpend30d, null, "dòng chi bị loại không tính là đã ghép");
    assert.equal(e("4").adSpend30d, 500_000, "chỉ chi TRONG 30 ngày, không kể dòng bị loại");
    assert.equal(e("9").orders30d, null, "mẫu không sản phẩm ⇒ đơn CHƯA BIẾT, không phải 0");
    assert.equal(e("2").orders30d, 1, "đơn huỷ không đếm");
    assert.deepEqual([e("6").stockKnown, e("6").stockOnHand, e("6").orders30d, e("6").ordersTotal], [true, 10, 0, 1]);
    assert.deepEqual([e("3").stockKnown, e("3").stockOnHand], [false, null], "chưa phiếu nhập ⇒ tồn CHƯA BIẾT");
    assert.equal(e("5").sentProductionOrders, 1);

    // ── 2. Bảng xem trước ──
    const chuaKhai = await listModels(LIST);
    const preview = buildDeclarePreview(chuaKhai.rows, await getModelsEvidenceBatch(chuaKhai.rows.map((r) => r.id), { now: NOW }));
    const pv = new Map(preview.map((r) => [r.code, r]));
    assert.ok(!pv.has("COSQ-7"), "mẫu đã khai không vào bảng");
    assert.deepEqual(
      ["1", "2", "3", "4", "4X", "5", "6", "8", "9"].map((x) => [x, pv.get(`COSQ-${x}`)?.suggested ?? null, pv.get(`COSQ-${x}`)?.selectable]),
      [
        ["1", "ADS_TESTING", true],
        ["2", "SELLING", true],
        ["3", null, false],
        ["4", "ADS_TESTING", true],
        ["4X", null, false],
        ["5", "IN_PRODUCTION", true],
        ["6", "SELLING", true],
        ["8", "LOSER", true],
        ["9", null, false],
      ],
    );

    const hist = async (id: string) => db.select().from(schema.productModelStateHistory).where(eq(schema.productModelStateHistory.modelId, id));
    const trangThai = async (id: string) => (await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, id)))[0]?.s ?? null;

    // ── 3. Cổng đầu vào ──
    const khai = (items: { modelId: string; state: ModelState }[], extra: Partial<Parameters<typeof declareModelsFromSuggestionCore>[1]> = {}) =>
      declareModelsFromSuggestionCore(db, { items: items.map((i) => ({ ...i, expectedState: null })), reason: BULK_DECLARE_DEFAULT_REASON, actor: NGUOI, source: BULK_DECLARE_SOURCE, now: NOW, ...extra });
    assert.ok("error" in (await khai([{ modelId: M("1"), state: "ADS_TESTING" }], { actor: { id: null, label: "job:máy" } })), "không có khoá tài khoản ⇒ từ chối — máy không tự khai");
    assert.ok("error" in (await khai([{ modelId: M("1"), state: "ADS_TESTING" }], { reason: "ok" })), "lý do ngắn ⇒ từ chối");
    assert.ok("error" in (await khai([])), "lượt rỗng ⇒ từ chối");
    assert.ok("error" in (await khai(Array.from({ length: BULK_DECLARE_MAX + 1 }, (_, i) => ({ modelId: `${P}x${i}`, state: "IDEA" as const })))), "vượt trần kỹ thuật ⇒ từ chối");
    assert.equal(await trangThai(M("1")), null, "lượt bị từ chối không ghi gì");
    assert.equal((await hist(M("1"))).length, 0);

    // ── 4. Màn hình cũ: người khác khai M4 trong lúc bảng còn mở ──
    const khac = await transitionModelCore(db, { modelId: M("4"), to: "CREATIVE", reason: "Người khác khai trước", actor: NGUOI_KHAC, actorKind: "USER", source: "test" });
    assert.ok("ok" in khac);

    // ── 5. Dòng hỏng thật (CSDL ném) cho M5 ──
    await db.execute(
      sql.raw(`create or replace function cos_q_fail_fn() returns trigger language plpgsql as $$ begin if new.model_id = '${M("5")}' then raise exception 'cos-q: lỗi CSDL giả'; end if; return new; end $$`),
    );
    await db.execute(sql.raw(`create trigger cos_q_fail before insert on product_model_state_history for each row execute function cos_q_fail_fn()`));

    const r = await khai([
      { modelId: M("1"), state: "ADS_TESTING" }, // chấp nhận gợi ý
      { modelId: M("2"), state: "CLEARANCE" }, // chọn KHÁC gợi ý (SELLING)
      { modelId: M("3"), state: "IDEA" }, // không gợi ý — client cố gửi
      { modelId: M("4"), state: "ADS_TESTING" }, // đã có người khai
      { modelId: M("5"), state: "IN_PRODUCTION" }, // CSDL ném
      { modelId: M("5x"), state: "IDEA" }, // không tồn tại
      { modelId: M("6"), state: "SELLING" },
      { modelId: M("7"), state: "CREATIVE" }, // đã khai từ trước
    ]);
    await db.execute(sql.raw(`drop trigger if exists cos_q_fail on product_model_state_history`));
    assert.ok("ok" in r, JSON.stringify(r));
    if (!("ok" in r)) return;
    const theo = (id: string): DeclareRowResult => r.results.find((x) => x.modelId === id)!;
    assert.equal(r.results.length, 8, "mỗi dòng gửi lên có đúng một kết cục — không dòng nào biến mất");
    assert.equal(r.declared, 3);
    assert.deepEqual([theo(M("1")).outcome, theo(M("1")).accepted, theo(M("1")).suggested], ["DECLARED", true, "ADS_TESTING"]);
    assert.deepEqual([theo(M("2")).outcome, theo(M("2")).accepted, theo(M("2")).suggested], ["DECLARED", false, "SELLING"], "người chọn khác ⇒ accepted = false, gợi ý vẫn ghi");
    assert.equal(theo(M("3")).outcome, "SKIPPED_NO_SUGGESTION", "máy chủ từ chối mẫu không gợi ý dù client gửi");
    assert.deepEqual([theo(M("4")).outcome, theo(M("4")).current], ["SKIPPED_ALREADY_DECLARED", "CREATIVE"], "màn hình cũ ⇒ BỎ QUA, báo trạng thái hiện tại");
    assert.equal(theo(M("5")).outcome, "FAILED");
    assert.match(theo(M("5")).error ?? "", /cos-q: lỗi CSDL giả/);
    assert.equal(theo(M("5x")).outcome, "NOT_FOUND");
    assert.equal(theo(M("6")).outcome, "DECLARED");
    assert.deepEqual([theo(M("7")).outcome, theo(M("7")).current], ["SKIPPED_ALREADY_DECLARED", "IDEA"]);

    assert.equal(await trangThai(M("1")), "ADS_TESTING");
    assert.equal(await trangThai(M("2")), "CLEARANCE", "lựa chọn của NGƯỜI được ghi, không phải gợi ý");
    assert.equal(await trangThai(M("3")), null);
    assert.equal(await trangThai(M("4")), "CREATIVE", "lời khai của người khác KHÔNG bị đè");
    assert.equal(await trangThai(M("5")), null, "dòng hỏng lùi riêng giao dịch của nó");
    assert.equal(await trangThai(M("6")), "SELLING", "dòng SAU dòng hỏng vẫn được khai");
    assert.equal(await trangThai(M("7")), "IDEA");
    assert.equal((await hist(M("4"))).length, 1, "M4 chỉ có dòng của người khác");
    assert.equal((await hist(M("5"))).length, 0);

    const [h2] = await hist(M("2"));
    assert.deepEqual(
      [h2.fromState, h2.toState, h2.actorKind, h2.actorId, h2.actorName, h2.reason, h2.source],
      [null, "CLEARANCE", "USER", U, "Người khai Q", BULK_DECLARE_DEFAULT_REASON, BULK_DECLARE_SOURCE],
      "lịch sử mang người bấm (USER + users.id), lý do và nguồn",
    );
    const meta2 = h2.metadata as Record<string, unknown>;
    assert.deepEqual([meta2.suggested, meta2.accepted, meta2.basis], ["SELLING", false, "ESTIMATED"]);
    const meta1 = (await hist(M("1")))[0].metadata as Record<string, unknown>;
    assert.deepEqual([meta1.suggested, meta1.accepted, meta1.basis], ["ADS_TESTING", true, "ESTIMATED"]);
    const su = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.modelId, M("2")));
    assert.equal(su.length, 1, "một sự kiện model.state_changed");
    assert.deepEqual([su[0].name, su[0].actorKind, su[0].actorId, su[0].source], ["model.state_changed", "USER", U, BULK_DECLARE_SOURCE]);
    assert.equal((su[0].payload as Record<string, unknown>).historyId, h2.id);

    // ── 6. Bấm lại cùng lượt ⇒ không có gì mới ──
    const demHist = async () => (await db.select({ n: sql<number>`count(*)` }).from(schema.productModelStateHistory).where(like(schema.productModelStateHistory.modelId, `${P}%`)))[0].n;
    const truoc = Number(await demHist());
    const lai = await khai([
      { modelId: M("1"), state: "ADS_TESTING" },
      { modelId: M("2"), state: "CLEARANCE" },
      { modelId: M("6"), state: "SELLING" },
    ]);
    assert.ok("ok" in lai && lai.declared === 0 && lai.results.every((x) => x.outcome === "SKIPPED_ALREADY_DECLARED"), "bấm lại ⇒ mọi dòng bỏ qua");
    assert.equal(Number(await demHist()), truoc, "bấm lại không ghi thêm dòng lịch sử nào");

    // ── 7. Hai lượt ĐỒNG THỜI trên cùng mẫu ⇒ đúng một lời khai ──
    const [a, b] = await Promise.all([khai([{ modelId: M("8"), state: "LOSER" }]), khai([{ modelId: M("8"), state: "LOSER" }], { actor: NGUOI_KHAC })]);
    const kq = [a, b].flatMap((x) => ("ok" in x ? x.results.map((y) => y.outcome) : ["ERROR"])).sort();
    assert.deepEqual(kq, ["DECLARED", "SKIPPED_ALREADY_DECLARED"], "hai lượt đồng thời ⇒ một người khai, người kia bỏ qua");
    assert.equal((await hist(M("8"))).length, 1);

    // ── 8. Sau khi khai: bảng gợi ý co lại đúng những mẫu đã khai ──
    const sau = await listModels(LIST);
    assert.deepEqual(
      sau.rows.map((x) => x.code),
      ["COSQ-3", "COSQ-4X", "COSQ-5", "COSQ-9"],
      "chỉ còn mẫu chưa khai (kể cả mẫu có dòng hỏng — nó chưa được khai)",
    );
    console.log(
      "✓ Company OS · Q (CSDL): chứng cứ theo lô = getModelEvidence trên mọi mẫu × 2 mốc (chưa biết vẫn là null) · khai theo gợi ý: USER + users.id, lịch sử + sự kiện mang gợi ý và chấp nhận/chọn khác · màn hình cũ bỏ qua không đè · dòng hỏng lùi riêng · không gợi ý ⇒ máy chủ từ chối · bấm lại / bấm đồng thời không ghi thêm",
    );
  } finally {
    await donDep(db);
  }
}
