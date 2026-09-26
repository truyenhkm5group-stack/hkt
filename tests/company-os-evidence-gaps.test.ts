import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { DQ_CHECKS, DQ_CHECK_SPECS, isFixable } from "@/lib/constants/data-quality-issues";
import { TEAM_DEPARTMENT } from "@/lib/constants/departments";
import {
  LIFECYCLE_EVIDENCE,
  LIFECYCLE_REQUIRED_EVIDENCE,
  lifecycleEvidenceGap,
  matchReceiptToOrders,
  prefilledOrderId,
  type LifecycleEvidence,
  type ModelEvidenceFacts,
  type ProductionOrderLinkFacts,
  type ReceiptLinkFacts,
} from "@/lib/constants/evidence-gaps";
import { MODEL_STATES, type ModelState } from "@/lib/constants/model-lifecycle";
import { linkExistingReceiptCore } from "@/lib/inventory/receipt-create";
import { getDataQualityIssues } from "@/lib/queries/data-quality-issues";
import { evidenceFactsOfSummary, listLifecycleEvidenceGaps, listLinkableReceipts, listModelEvidenceFacts } from "@/lib/queries/evidence-gaps";
import { getModelProductionSummary } from "@/lib/queries/model-production";

/**
 * ═══════════ LỜI KHAI ≠ CHỨNG CỨ (Company OS · Agent P2) ═══════════
 *
 * Hai phép chiếu lúc đọc: (1) trạng thái vòng đời KHAI mà ERP không có chứng từ sản xuất tương ứng;
 * (2) phiếu nhập chưa nối mà có lệnh SX đang mở khớp. Cả hai chỉ ĐỀ XUẤT — không gì được sửa hộ.
 *
 * Không phụ thuộc đồng hồ (luật 50 / 65): mọi mốc là ngày CỐ ĐỊNH năm 2001, và không phép so nào ở đây
 * dính tới "bây giờ" — luật khớp chỉ so ngày nhận với ngày gửi xưởng.
 */

const P = "cos-p2-";

const facts = (state: ModelState | null, has: Partial<Record<LifecycleEvidence, boolean>> = {}, productId: string | null = "sp"): ModelEvidenceFacts => ({
  modelId: "m",
  code: "M1",
  state,
  productId,
  hasTopic: !!has.TOPIC,
  hasCostSheet: !!has.COST_SHEET,
  hasSample: !!has.SAMPLE,
  hasDesignVersion: !!has.DESIGN_VERSION,
  hasOpenProductionOrder: !!has.OPEN_PRODUCTION_ORDER,
});

/** Giờ VN cố định: `vn("2001-03-10", 15)` = 15:00 ngày 10/03/2001 giờ Việt Nam. */
const vn = (day: string, hour = 0) => new Date(`${day}T${String(hour).padStart(2, "0")}:00:00+07:00`);

const phieu = (o: Partial<ReceiptLinkFacts> = {}): ReceiptLinkFacts => ({
  receiptId: "r",
  kind: "RECEIPT",
  productionOrderId: null,
  productionBatchId: null,
  receivedAt: vn("2001-03-10"),
  supplierId: null,
  productIds: ["p1"],
  ...o,
});
const lenh = (o: Partial<ProductionOrderLinkFacts> & { id: string }): ProductionOrderLinkFacts => ({
  code: o.id.toUpperCase(),
  status: "SENT",
  productId: "p1",
  supplierId: null,
  sentAt: vn("2001-03-01", 10),
  ...o,
});

export function testCompanyOsEvidenceGapsPure() {
  // ── 1. Mỗi trạng thái → đúng MỘT chứng từ, cả bảng ──
  assert.deepEqual(LIFECYCLE_REQUIRED_EVIDENCE, {
    PRODUCTION_DISCUSSION: "TOPIC",
    COSTING: "COST_SHEET",
    SAMPLING: "SAMPLE",
    SAMPLE_REVIEW: "SAMPLE",
    APPROVED: "DESIGN_VERSION",
    PRODUCTION_PLANNING: "OPEN_PRODUCTION_ORDER",
    IN_PRODUCTION: "OPEN_PRODUCTION_ORDER",
  });
  for (const s of MODEL_STATES) {
    const can: LifecycleEvidence | undefined = LIFECYCLE_REQUIRED_EVIDENCE[s];
    // Không chứng từ nào: chỉ trạng thái sản xuất mới bị hỏi.
    const trong = lifecycleEvidenceGap(facts(s));
    if (can) assert.equal(trong?.missing, can, `${s} không có ${can} ⇒ phải chỉ ra`);
    else assert.equal(trong, null, `${s} không đòi chứng từ sản xuất nào ⇒ không bao giờ bị hỏi`);
    // Có ĐỦ mọi chứng từ ⇒ không bao giờ bị hỏi.
    assert.equal(lifecycleEvidenceGap(facts(s, Object.fromEntries(LIFECYCLE_EVIDENCE.map((e) => [e, true])))), null, `${s} có đủ chứng từ ⇒ không hỏi`);
    // Chỉ chứng từ CỦA CHÍNH trạng thái quyết định — có nó là đủ, thiếu mọi cái khác vẫn không hỏi.
    if (can) {
      assert.equal(lifecycleEvidenceGap(facts(s, { [can]: true })), null, `${s} có ${can} ⇒ đủ, không đòi cả chuỗi phía trước`);
      for (const khac of LIFECYCLE_EVIDENCE.filter((e) => e !== can)) {
        assert.equal(lifecycleEvidenceGap(facts(s, { [khac]: true }))?.missing, can, `${s}: có ${khac} không thay được ${can}`);
      }
    }
  }
  // Mẫu đang bán / xả tồn / ngừng hợp lệ khi KHÔNG có topic — 6/7 mẫu thật của shop đang ở đây.
  for (const s of ["SELLING", "CLEARANCE", "DISCONTINUED"] as const) {
    assert.ok(!(s in LIFECYCLE_REQUIRED_EVIDENCE), `${s} không được đòi chứng từ`);
    assert.equal(lifecycleEvidenceGap(facts(s, {}, null)), null, `${s} không chứng từ, không sản phẩm ⇒ vẫn không hỏi`);
  }
  for (const s of ["IDEA", "CREATIVE", "ADS_TESTING", "WINNER", "LOSER"] as const) assert.equal(lifecycleEvidenceGap(facts(s)), null, `${s} trước Bàn sản xuất ⇒ không hỏi`);
  assert.equal(lifecycleEvidenceGap(facts(null)), null, "chưa khai không phải chỗ hở ở đây (ô Chưa khai là việc riêng)");

  // ── 2. Câu chữ + đường dẫn ──
  const lamMau = lifecycleEvidenceGap({ ...facts("SAMPLING"), modelId: "m 1" })!;
  assert.equal(lamMau.text, "Trạng thái khai “Làm mẫu” nhưng ERP chưa có mẫu xưởng nào — ghi mẫu xưởng hoặc sửa trạng thái");
  assert.equal(lamMau.actionHref, "/production/models/m%201");
  assert.equal(lamMau.fixStateHref, "/models/m%201");
  assert.equal(lifecycleEvidenceGap(facts("PRODUCTION_DISCUSSION"))!.actionHref, "/production/topics/new?model=m");
  assert.equal(lifecycleEvidenceGap(facts("IN_PRODUCTION", {}, "sp9"))!.actionHref, "/inventory/planning/orders/new?product=sp9");
  const khongSp = lifecycleEvidenceGap(facts("PRODUCTION_PLANNING", {}, null))!;
  assert.equal(khongSp.actionHref, "/inventory/planning/orders", "mẫu chưa có sản phẩm ⇒ không dựng link đặt hàng cho sản phẩm không tồn tại");
  assert.ok(khongSp.text.includes("chưa có sản phẩm Pancake"), "phải nói VÌ SAO chưa có lệnh");

  // ── 3. Khớp phiếu ↔ lệnh ──
  const A = lenh({ id: "a" });
  assert.deepEqual(matchReceiptToOrders(phieu(), [A]).map((o) => o.id), ["a"], "cùng sản phẩm, lệnh đã gửi trước ngày nhận ⇒ ứng viên");
  assert.deepEqual(matchReceiptToOrders(phieu({ productIds: ["p2"] }), [A]), [], "khác sản phẩm ⇒ không");
  for (const st of ["DRAFT", "RECEIVED", "CANCELLED"]) assert.deepEqual(matchReceiptToOrders(phieu(), [lenh({ id: "x", status: st })]), [], `lệnh ${st} không phải lệnh đang mở ⇒ không`);
  assert.deepEqual(matchReceiptToOrders(phieu(), [lenh({ id: "x", sentAt: vn("2001-03-11", 9) })]), [], "gửi xưởng SAU ngày nhận ⇒ không thể là hàng của lệnh");
  assert.deepEqual(matchReceiptToOrders(phieu({ receivedAt: vn("2001-03-10") }), [lenh({ id: "x", sentAt: vn("2001-03-10", 15) })]).length, 1, "cùng ngày (giờ VN) ⇒ có — ngày nhận là đầu ngày, không phải giờ đếm");
  assert.deepEqual(matchReceiptToOrders(phieu({ receivedAt: vn("2001-03-10") }), [lenh({ id: "x", sentAt: new Date("2001-03-10T17:30:00Z") })]), [], "17:30Z = 00:30 ngày 11 giờ VN ⇒ muộn hơn ngày nhận");
  assert.deepEqual(matchReceiptToOrders(phieu(), [lenh({ id: "x", sentAt: null })]), [], "lệnh không có mốc gửi ⇒ không chứng minh được thứ tự ⇒ không đề xuất");
  assert.deepEqual(matchReceiptToOrders(phieu({ supplierId: "s1" }), [lenh({ id: "x", supplierId: "s2" })]), [], "cả hai biết xưởng mà khác ⇒ không");
  assert.equal(matchReceiptToOrders(phieu({ supplierId: "s1" }), [lenh({ id: "x", supplierId: "s1" })]).length, 1, "cùng xưởng ⇒ có");
  assert.equal(matchReceiptToOrders(phieu({ supplierId: null }), [lenh({ id: "x", supplierId: "s1" })]).length, 1, "phiếu chưa biết xưởng ⇒ không loại");
  assert.equal(matchReceiptToOrders(phieu({ supplierId: "s1" }), [lenh({ id: "x", supplierId: null })]).length, 1, "lệnh chưa biết xưởng ⇒ không loại");
  assert.deepEqual(matchReceiptToOrders(phieu({ productionOrderId: "a" }), [A]), [], "phiếu đã nối lệnh ⇒ không bao giờ đề xuất lại");
  assert.deepEqual(matchReceiptToOrders(phieu({ productionBatchId: "lo" }), [A]), [], "phiếu đã nối lô ⇒ không đề xuất");
  for (const k of ["RETURN", "ISSUE", "ADJUSTMENT"]) assert.deepEqual(matchReceiptToOrders(phieu({ kind: k }), [A]), [], `phiếu ${k} không phải hàng của xưởng`);
  // Nhiều lệnh ⇒ liệt kê HẾT, gửi gần nhất trước; ổn định với thứ tự đầu vào.
  const B = lenh({ id: "b", sentAt: vn("2001-03-05") });
  const C = lenh({ id: "c", sentAt: vn("2001-03-05") });
  const nhieu = matchReceiptToOrders(phieu(), [A, C, B]);
  assert.deepEqual(nhieu.map((o) => o.id), ["b", "c", "a"]);
  assert.deepEqual(matchReceiptToOrders(phieu(), [B, A, C]).map((o) => o.id), ["b", "c", "a"], "đảo đầu vào không đổi kết quả");
  // Điền sẵn: chỉ khi một ứng viên, hoặc khi người đã chỉ đúng một ứng viên.
  assert.equal(prefilledOrderId([A], null), "a");
  assert.equal(prefilledOrderId(nhieu, null), "", "nhiều ứng viên ⇒ để trống, người chọn");
  assert.equal(prefilledOrderId(nhieu, "c"), "c");
  assert.equal(prefilledOrderId(nhieu, "zzz"), "", "mã lạ trong URL không được điền");
  assert.equal(prefilledOrderId([], "a"), "");

  // ── 4. Sổ lỗ hổng: khai đúng luật 45 ──
  for (const k of ["lifecycle-without-evidence", "receipt-linkable-to-po"] as const) assert.ok((DQ_CHECKS as readonly string[]).includes(k), `${k} phải có trong sổ`);
  const lc = DQ_CHECK_SPECS["lifecycle-without-evidence"];
  const rc = DQ_CHECK_SPECS["receipt-linkable-to-po"];
  assert.equal(lc.kind, "AMBIGUOUS", "lời khai vs chứng cứ: NGƯỜI quyết bên nào đúng");
  assert.equal(rc.kind, "RESOLVABLE", "phiếu và lệnh đều đã có trong kho, chỉ chưa nối");
  assert.equal(isFixable(lc.kind), false);
  assert.equal(isFixable(rc.kind), true);
  assert.ok(!("fixable" in lc) && !("fixable" in rc), "fixable SUY RA từ loại, không khai tay");
  assert.equal(lc.owner, TEAM_DEPARTMENT.PRODUCTION, "phòng theo route luật 69 (TEAM_DEPARTMENT), không gõ thẳng");
  assert.equal(rc.owner, "WAREHOUSE");
  for (const t of ["production_topics", "cost_sheets", "samples", "design_versions", "production_orders"]) assert.ok(lc.source.includes(t), `nguồn phải nêu bảng thật ${t}`);
  for (const t of ["stock_receipts", "stock_receipt_items", "production_orders"]) assert.ok(rc.source.includes(t), `nguồn phải nêu bảng thật ${t}`);
  assert.ok(lc.action.includes("sửa trạng thái") && rc.action.includes("KHÔNG nối hộ"));

  // ── 5. Mã nguồn: thuần, không tự nối, không chiếu hai lần ──
  const thuan = readFileSync("lib/constants/evidence-gaps.ts", "utf8");
  assert.ok(!/Date\.now|new Date\(/.test(thuan), "luật thuần không đọc đồng hồ");
  assert.ok(!/from "@\/db"/.test(thuan), "luật thuần không đọc CSDL");
  const tep: string[] = [];
  const quet = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) quet(p);
      else if (/\.(ts|tsx)$/.test(f)) tep.push(p.split(path.sep).join("/"));
    }
  };
  for (const d of ["lib", "app", "scripts", "components"]) quet(d);
  const goiNoi = tep.filter((f) => readFileSync(f, "utf8").includes("linkExistingReceiptCore("));
  assert.deepEqual(goiNoi.sort(), ["lib/actions/stock.ts", "lib/inventory/receipt-create.ts"], "chỉ server action (người bấm) gọi được lõi nối — không job, không trang đọc, không đề xuất nào nối hộ");
  const action = readFileSync("lib/actions/stock.ts", "utf8");
  const than = action.slice(action.indexOf("export async function linkStockReceiptToProductionOrder"));
  assert.ok(/can\(user, "inventory:write"\)/.test(than.slice(0, 400)), "nối phiếu cần inventory:write");
  const loi = readFileSync("lib/inventory/receipt-create.ts", "utf8");
  const thanLoi = loi.slice(loi.indexOf("export async function linkExistingReceiptCore"));
  assert.ok(thanLoi.includes("validateProductionLink(db"), "nối phiếu đi CÙNG cổng validateProductionLink với lúc tạo phiếu");
  assert.ok(thanLoi.indexOf("validateProductionLink(") < thanLoi.indexOf("db.transaction"), "kiểm TRƯỚC khi ghi");
  // Luật 19: hàng đợi /work KHÔNG chiếu sổ lỗ hổng dữ liệu — hai mục mới không thể bị đếm hai lần ở đó.
  for (const f of ["lib/queries/work-adapters.ts", "lib/constants/work-sources.ts"]) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/data-quality-issues|evidence-gaps/.test(src), `${f} chiếu sổ lỗ hổng vào /work thì phải khai nguồn + chống đếm hai lần (luật 19)`);
  }
  // Không bảng lưu nào cho hai phép chiếu (luật 19 / 26).
  assert.ok(!/evidence_gap|lifecycle_without_evidence|receipt_linkable/i.test(readFileSync("db/schema.ts", "utf8")), "phép chiếu không có bảng lưu");

  console.log("✓ Company OS · P2 (thuần): 7 trạng thái sản xuất → đúng một chứng từ, đang bán / xả / ngừng / trước bàn SX không bao giờ bị hỏi · khớp phiếu ↔ lệnh: cùng sản phẩm, chỉ SENT, gửi không muộn hơn ngày nhận (giờ VN), cùng xưởng khi cả hai biết, nhiều ứng viên liệt kê hết · sổ lỗ hổng khai đủ, fixable suy ra · chỉ người bấm mới nối");
}

export async function testCompanyOsEvidenceGapsDb(db: Db) {
  const don = async () => {
    await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
    await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
    await db.delete(schema.designVersions).where(like(schema.designVersions.id, `${P}%`));
    await db.delete(schema.sampleReviews).where(like(schema.sampleReviews.id, `${P}%`));
    await db.delete(schema.samples).where(like(schema.samples.id, `${P}%`));
    await db.delete(schema.costSheets).where(like(schema.costSheets.id, `${P}%`));
    await db.delete(schema.productionTopics).where(like(schema.productionTopics.id, `${P}%`));
    await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
    await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
    await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
    await db.delete(schema.suppliers).where(like(schema.suppliers.id, `${P}%`));
  };
  await don();
  const U = `${P}kho`;
  await db.insert(schema.users).values({ id: U, email: "cos-p2-kho@test.local", name: "Kho P2", passwordHash: "x", role: "LEADER" }).onConflictDoNothing();
  const nguoi = { id: U, label: "Kho P2" };

  // ───────────── 1. Trạng thái khai ↔ chứng từ ─────────────
  await db.insert(schema.products).values([
    { id: `${P}p1`, name: "Đầm P2-1", customId: "P2-1" },
    { id: `${P}p2`, name: "Áo P2-2", customId: "P2-2" },
    { id: `${P}p3`, name: "Quần P2-3", customId: "P2-3" },
    { id: `${P}pplan`, name: "Váy P2 kế hoạch", customId: "P2-PL" },
    { id: `${P}pin`, name: "Váy P2 đang may", customId: "P2-IN" },
  ]);
  await db.insert(schema.productVariants).values([
    { id: `${P}v1`, productId: `${P}p1`, sku: "P2-1-M", color: "Đen", size: "M" },
    { id: `${P}v2`, productId: `${P}p2`, sku: "P2-2-M", color: "Trắng", size: "M" },
    { id: `${P}v3`, productId: `${P}p3`, sku: "P2-3-M", color: "Xám", size: "M" },
  ]);
  const mau = (id: string, state: ModelState, productId: string | null = null) => ({ id: `${P}${id}`, code: `P2${id.toUpperCase()}`, name: id, productId, lifecycleState: state, registeredBy: "USER" as const });
  await db.insert(schema.productModels).values([
    mau("pd0", "PRODUCTION_DISCUSSION"),
    mau("pd1", "PRODUCTION_DISCUSSION"),
    mau("co0", "COSTING"),
    mau("co1", "COSTING"),
    mau("sa0", "SAMPLING"),
    mau("sa1", "SAMPLING"),
    mau("sr0", "SAMPLE_REVIEW"),
    mau("sr1", "SAMPLE_REVIEW"),
    mau("ap0", "APPROVED"),
    mau("ap1", "APPROVED"),
    mau("pl0", "PRODUCTION_PLANNING"),
    mau("pl1", "PRODUCTION_PLANNING", `${P}pplan`),
    mau("in0", "IN_PRODUCTION", `${P}pin`),
    mau("se0", "SELLING", `${P}p1`),
    mau("cl0", "CLEARANCE", `${P}p2`),
    mau("id0", "IDEA"),
  ]);
  // Chứng từ cho các mẫu "…1": topic ĐÃ ĐÓNG vẫn là chứng cứ đã bàn; giá thành NHÁP vẫn là đã lập.
  await db.insert(schema.productionTopics).values({ id: `${P}tp`, modelId: `${P}pd1`, title: "Bàn giá P2", status: "CLOSED", evidenceSnapshot: {} });
  await db.insert(schema.costSheets).values({ id: `${P}cs`, modelId: `${P}co1`, version: 1 });
  await db.insert(schema.samples).values([
    { id: `${P}sm-sa1`, modelId: `${P}sa1`, version: 1 },
    { id: `${P}sm-sr1`, modelId: `${P}sr1`, version: 1 },
    { id: `${P}sm-ap1`, modelId: `${P}ap1`, version: 1, status: "APPROVED", submittedAt: vn("2001-02-01"), decidedAt: vn("2001-02-02") },
  ]);
  await db.insert(schema.sampleReviews).values({ id: `${P}rv`, sampleId: `${P}sm-ap1`, decision: "APPROVE", reviewerUserId: U });
  await db.insert(schema.designVersions).values({ id: `${P}dv`, modelId: `${P}ap1`, sampleId: `${P}sm-ap1`, reviewId: `${P}rv`, version: 1, spec: {}, approvedByUserId: U });
  // Lệnh: pplan có NHÁP (đang mở); pin chỉ có lệnh ĐÃ NHẬN + ĐÃ HUỶ ⇒ không lệnh mở ⇒ chỗ hở.
  await db.insert(schema.productionOrders).values([
    { id: `${P}po-plan`, code: `${P}PO-PLAN`, productId: `${P}pplan`, status: "DRAFT" },
    { id: `${P}po-in-rc`, code: `${P}PO-IN-RC`, productId: `${P}pin`, status: "RECEIVED", sentAt: vn("2001-01-01") },
    { id: `${P}po-in-cx`, code: `${P}PO-IN-CX`, productId: `${P}pin`, status: "CANCELLED" },
  ]);

  const tatCaMau = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`))).map((r) => r.id);
  const gaps = await listLifecycleEvidenceGaps({ modelIds: tatCaMau });
  const theoMau = Object.fromEntries(gaps.map((g) => [g.modelId.slice(P.length), g.missing]));
  assert.deepEqual(theoMau, {
    pd0: "TOPIC",
    co0: "COST_SHEET",
    sa0: "SAMPLE",
    sr0: "SAMPLE",
    ap0: "DESIGN_VERSION",
    pl0: "OPEN_PRODUCTION_ORDER",
    in0: "OPEN_PRODUCTION_ORDER",
  }, "đúng bảy mẫu thiếu chứng từ; mẫu có chứng từ, mẫu đang bán / xả tồn / ý tưởng không bị hỏi");
  assert.ok(gaps.find((g) => g.modelId === `${P}sa0`)!.text.includes("chưa có mẫu xưởng nào"));

  // Hai đường đọc (cả shop ↔ trang 360) ra CÙNG dữ kiện trên cùng dữ liệu.
  const listed = await listModelEvidenceFacts({ modelIds: tatCaMau });
  assert.equal(listed.length, 13, "chỉ mẫu đang khai trạng thái SẢN XUẤT được đọc (không SELLING / CLEARANCE / IDEA)");
  for (const f of listed) {
    const sum = await getModelProductionSummary(f.modelId);
    assert.ok(sum);
    assert.deepEqual(evidenceFactsOfSummary({ id: f.modelId, code: f.code, state: f.state }, sum!), f, `${f.code}: trang 360 và trang Chất lượng dữ liệu phải thấy cùng chứng cứ`);
  }

  // ───────────── 2. Phiếu nhập chưa nối ↔ lệnh SX đang mở ─────────────
  await db.insert(schema.suppliers).values([
    { id: `${P}s1`, name: `${P}Xưởng Một` },
    { id: `${P}s2`, name: `${P}Xưởng Hai` },
  ]);
  const T0 = vn("2001-03-01", 10);
  await db.insert(schema.productionOrders).values([
    { id: `${P}poA`, code: `${P}PO-A`, productId: `${P}p1`, status: "SENT", supplierId: `${P}s1`, sentAt: T0 },
    { id: `${P}poB`, code: `${P}PO-B`, productId: `${P}p1`, status: "SENT", supplierId: null, sentAt: vn("2001-03-02", 9) },
    { id: `${P}poC`, code: `${P}PO-C`, productId: `${P}p2`, status: "SENT", sentAt: T0 },
    { id: `${P}poD`, code: `${P}PO-D`, productId: `${P}p1`, status: "DRAFT" },
    { id: `${P}poE`, code: `${P}PO-E`, productId: `${P}p1`, status: "RECEIVED", sentAt: T0 },
    { id: `${P}poF`, code: `${P}PO-F`, productId: `${P}p1`, status: "CANCELLED", sentAt: T0 },
    { id: `${P}poG`, code: `${P}PO-G`, productId: `${P}p1`, status: "SENT", sentAt: vn("2001-04-01") },
  ]);
  const NHAN = vn("2001-03-06");
  const lap = async (id: string, o: { kind?: string; variantId: string; receivedAt?: Date; supplierId?: string | null; productionOrderId?: string | null }) => {
    await db.insert(schema.stockReceipts).values({ id: `${P}${id}`, kind: o.kind ?? "RECEIPT", receivedAt: o.receivedAt ?? NHAN, reference: `${P}${id}`, supplierId: o.supplierId ?? null, productionOrderId: o.productionOrderId ?? null, totalQuantity: 10, totalCost: 0, createdBy: "Kho P2" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}${id}-i`, receiptId: `${P}${id}`, variantId: o.variantId, quantity: 10, unitCost: 0 });
  };
  await lap("r1", { variantId: `${P}v1`, supplierId: `${P}s1` }); // p1, xưởng 1 ⇒ A + B (B chưa biết xưởng)
  await lap("r2", { variantId: `${P}v1`, supplierId: `${P}s2` }); // p1, xưởng 2 ⇒ chỉ B
  await lap("r3", { variantId: `${P}v2` }); // p2 ⇒ C
  await lap("r4", { variantId: `${P}v1`, receivedAt: vn("2001-02-27") }); // về TRƯỚC mọi lệnh ⇒ không
  await lap("r5", { variantId: `${P}v1`, productionOrderId: `${P}poA` }); // đã nối ⇒ không
  await lap("r6", { kind: "RETURN", variantId: `${P}v1` }); // tái nhập hoàn ⇒ không
  await lap("r7", { variantId: `${P}v3` }); // sản phẩm không có lệnh ⇒ không
  const cacPhieu = ["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((x) => `${P}${x}`);
  const deXuat = async () => Object.fromEntries((await listLinkableReceipts({ receiptIds: cacPhieu })).map((r) => [r.receiptId.slice(P.length), r.candidates.map((c) => c.id.slice(P.length))]));
  assert.deepEqual(await deXuat(), { r1: ["poB", "poA"], r2: ["poB"], r3: ["poC"] }, "chỉ phiếu chưa nối có lệnh SENT cùng sản phẩm, gửi trước ngày nhận, cùng xưởng khi biết; nhiều lệnh ⇒ liệt kê hết");

  // Trang Chất lượng dữ liệu: đếm + link mở thẳng phiếu (một lệnh ⇒ mang sẵn lệnh).
  clearMemo();
  const dq = await getDataQualityIssues();
  const dqPhieu = dq.find((i) => i.key === "receipt-linkable-to-po")!;
  const dqKhai = dq.find((i) => i.key === "lifecycle-without-evidence")!;
  assert.ok(dqPhieu.count !== null && dqPhieu.count >= 3 && dqPhieu.fixable === true);
  assert.ok(dqKhai.count !== null && dqKhai.count >= 7 && dqKhai.fixable === false);
  const tatCaPhieu = await listLinkableReceipts();
  assert.equal(dqPhieu.count, tatCaPhieu.length, "số trên trang = số phép chiếu");
  const r2Link = `/inventory/receipts?receipt=${P}r2&po=${P}poB#chi-tiet`;
  if (tatCaPhieu.slice(0, 5).some((r) => r.receiptId === `${P}r2`)) assert.ok(dqPhieu.links.some((l) => l.href === r2Link), "một lệnh khớp ⇒ link mang sẵn lệnh");
  if (tatCaPhieu.slice(0, 5).some((r) => r.receiptId === `${P}r1`)) assert.ok(dqPhieu.links.some((l) => l.href === `/inventory/receipts?receipt=${P}r1#chi-tiet`), "nhiều lệnh ⇒ link KHÔNG chọn hộ");

  // Không gì được nối hộ: đọc trang xong, phiếu vẫn trống, trạng thái khai giữ nguyên, không sự kiện nào.
  const suKien = async () => (await db.select({ id: schema.domainEvents.id }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "stock_receipt.linked_production"), inArray(schema.domainEvents.subjectId, cacPhieu)))).length;
  assert.equal(await suKien(), 0);
  const trong = await db.select({ id: schema.stockReceipts.id, po: schema.stockReceipts.productionOrderId }).from(schema.stockReceipts).where(inArray(schema.stockReceipts.id, [`${P}r1`, `${P}r2`, `${P}r3`]));
  assert.ok(trong.every((r) => r.po === null), "trang đọc KHÔNG nối phiếu nào");
  const [sa0] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, `${P}sa0`));
  assert.equal(sa0.s, "SAMPLING", "trang đọc KHÔNG đổi trạng thái khai");

  // ───────────── 3. Nối một phiếu đã có: qua cổng + nhật ký ─────────────
  const noi = (receiptId: string, productionOrderId: string) => linkExistingReceiptCore(db, { receiptId: `${P}${receiptId}`, productionOrderId: `${P}${productionOrderId}`, actor: nguoi, actorEmail: "cos-p2-kho@test.local" });
  assert.deepEqual(await noi("r6", "poA"), { error: "Chỉ phiếu Nhập hàng mới gắn được lệnh sản xuất / lô xưởng" }, "cổng validateProductionLink: phiếu tái nhập hoàn không nối được");
  assert.deepEqual(await noi("r1", "poF"), { error: "Lệnh sản xuất đã chọn đã bị huỷ" }, "cổng validateProductionLink: lệnh huỷ");
  assert.deepEqual(await noi("r1", "khong-co"), { error: "Lệnh sản xuất đã chọn không tồn tại" });
  assert.ok("error" in (await noi("r1", "poC")), "lệnh của sản phẩm khác (không có trên phiếu) ⇒ từ chối");
  assert.ok("error" in (await noi("r5", "poB")), "phiếu đã nối ⇒ không ghi đè");
  assert.equal(await suKien(), 0, "lượt bị từ chối không phát gì");

  assert.deepEqual(await noi("r2", "poB"), { ok: true });
  const [r2] = await db.select({ po: schema.stockReceipts.productionOrderId, lo: schema.stockReceipts.productionBatchId }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, `${P}r2`));
  assert.deepEqual(r2, { po: `${P}poB`, lo: null });
  const [ev] = await db.select().from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "stock_receipt.linked_production"), eq(schema.domainEvents.subjectId, `${P}r2`)));
  assert.ok(ev, "nối xong ⇒ phát stock_receipt.linked_production");
  assert.deepEqual([ev.actorKind, ev.actorId, ev.dedupeKey], ["USER", U, `stock_receipt.linked_production:${P}r2`]);
  const nhatKy = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "STOCK_RECEIPT_LINK_PRODUCTION"), eq(schema.auditLogs.entityId, `${P}r2`)));
  assert.equal(nhatKy.length, 1, "một lượt nối, một dòng nhật ký");
  assert.equal(nhatKy[0].userId, U);
  const ct = nhatKy[0].detail as { before?: { productionOrderId: unknown }; after?: { productionOrderId: unknown } };
  assert.deepEqual([ct.before?.productionOrderId, ct.after?.productionOrderId], [null, `${P}poB`], "nhật ký có TRƯỚC / SAU");
  assert.deepEqual(await noi("r2", "poA"), { error: "Phiếu đã nối với một lệnh / lô — đổi liên kết đã có không làm ở đây" }, "bấm lại / đổi lệnh ⇒ từ chối, không ghi thêm");
  assert.equal((await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "STOCK_RECEIPT_LINK_PRODUCTION"), eq(schema.auditLogs.entityId, `${P}r2`)))).length, 1);
  assert.deepEqual(await deXuat(), { r1: ["poB", "poA"], r3: ["poC"] }, "phiếu đã nối rời phép chiếu ngay — không dòng nào phải 'đánh dấu xong'");

  // Hai người bấm cùng lúc ⇒ đúng một người thắng.
  const [x, y] = await Promise.all([noi("r3", "poC"), noi("r3", "poC")]);
  assert.equal([x, y].filter((k) => "ok" in k).length, 1, "đua nối cùng phiếu ⇒ đúng một lượt thắng");
  assert.equal(Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "STOCK_RECEIPT_LINK_PRODUCTION"), eq(schema.auditLogs.entityId, `${P}r3`))))[0].n), 1);

  // Trạng thái khai giữ nguyên dù chứng cứ vẫn thiếu — máy không bao giờ sửa lời khai.
  const [sa0Sau] = await db.select({ s: schema.productModels.lifecycleState }).from(schema.productModels).where(eq(schema.productModels.id, `${P}sa0`));
  assert.equal(sa0Sau.s, "SAMPLING");

  await don();
  console.log("✓ Company OS · P2 (CSDL): 7 mẫu thiếu chứng từ đúng loại (topic đóng / giá thành nháp vẫn là chứng cứ; chỉ lệnh nháp / đã gửi là lệnh mở) · trang 360 và trang Chất lượng dữ liệu cùng dữ kiện · 3 phiếu có lệnh khớp (nhiều ứng viên liệt kê hết) · đọc trang không nối gì · nối phiếu đã có qua validateProductionLink + sản phẩm của lệnh + sự kiện + nhật ký trước/sau, bấm lại bị từ chối, đua ⇒ một người thắng");
}
