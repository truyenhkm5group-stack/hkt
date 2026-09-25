import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { APPROVAL_GROUP_REASON, isEnforced, overThreshold, type ApprovalDecision } from "@/lib/constants/approval";
import { DAMAGED_ITEM_CONDITIONS, DERIVED_STOCK_STATE_LABEL, DERIVED_STOCK_STATES_ARE_LEDGER_MOVEMENTS, STOCK_STATE_LABEL } from "@/lib/constants/inventory";
import { ITEM_CONDITION_RESTOCKS } from "@/lib/constants/return-lifecycle";
import { DEFAULT_SLOW_MOVING_RULES, SLOW_MOVING_KEY, SLOW_MOVING_RULES, resolveSlowMovingRules, slowMovingRulesProblem, sparseSlowMovingOverride } from "@/lib/constants/slow-moving";
import { validateProductionLink } from "@/lib/inventory/production-link";
import { RECEIPT_DELETE_GROUP, deleteStockReceiptCore, type ReceiptDeleteGate, type ReceiptDeleteGateInput } from "@/lib/inventory/receipt-delete";
import { getModelStockStates } from "@/lib/queries/model-stock";
import { getReplenishmentPlan } from "@/lib/queries/planning";
import { getSlowMoving, loadSlowMovingRules } from "@/lib/queries/slow-moving";
import { splitSignedStock, stockRiskSummary } from "@/lib/queries/stock";
import { setSettingJson } from "@/lib/settings";
import { STOCK_RECEIPT_KINDS } from "@/lib/validation/stock";
import { openBatchQtyByVariant, openQtyAfterReceived, type OpenBatchInput } from "@/lib/constants/workshop-ledger";
import { openPoQtyByVariant } from "@/lib/queries/inventory-decision";

/**
 * ═══════════ COMPANY OS · AGENT D — SỔ KHO AN TOÀN · TRẠNG THÁI TỒN ═══════════
 *
 * Khoá năm điều:
 *  1. Phiếu tái nhập đang là chứng từ của phiếu kiểm hoàn KHÔNG xoá được (kể cả khi phiếu kiểm gắn
 *     vào giữa lúc kiểm và lúc xoá); xoá phiếu khác đi qua CÙNG cổng duyệt với điều chỉnh / xuất tay,
 *     bắt buộc lý do, và nhật ký giữ ảnh chụp đầy đủ.
 *  2. Tổng tồn trang chủ chỉ cộng dòng DƯƠNG; dòng âm đếm riêng; mẫu chưa biết tồn không vào vế nào.
 *  3. Hai cột nối phiếu nhập ↔ lệnh SX / lô xưởng nhận NULL, CSDL chặn mã bịa, action kiểm loại phiếu.
 *  4. `getModelStockStates`: CHƯA BIẾT (`null`) tách khỏi 0 thật.
 *  5. Ngưỡng hàng chậm: mặc định = hằng số đang chạy, ghi đè thưa, bộ sai bị bỏ NGUYÊN BỘ.
 *
 * Không phụ thuộc đồng hồ: mọi mốc là ngày cố định, không truy vấn nào ở đây lọc theo "N ngày trước".
 */

const P = "cosd-";
const DAY0 = new Date("2026-03-01T03:00:00Z");

function viPhamRangBuoc(ten: string) {
  return (e: unknown) => {
    const chuoi: string[] = [];
    let cur: unknown = e;
    for (let i = 0; i < 5 && cur; i++) {
      chuoi.push(String((cur as { message?: string })?.message ?? cur));
      cur = (cur as { cause?: unknown })?.cause;
    }
    return chuoi.join(" | ").includes(ten);
  };
}

function nguon(rel: string) {
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

/** Thân một hàm trong mã nguồn — cắt từ chữ ký tới hàm kế tiếp (đủ cho phép quét "có gọi X không"). */
function thanHam(src: string, chuKy: string) {
  const i = src.indexOf(chuKy);
  assert.ok(i >= 0, `không thấy ${chuKy}`);
  const j = src.indexOf("\nexport ", i + chuKy.length);
  return src.slice(i, j < 0 ? undefined : j);
}

/**
 * Cổng duyệt GIẢ LẬP ĐÚNG LUẬT của `guardSecondApproval` (lib/actions/approvals.ts): cưỡng chế theo
 * nhóm (`isEnforced`) VÀ vượt ngưỡng (`overThreshold`) thì phải chờ duyệt, không thì làm luôn. Hai hàm
 * quyết định là hàm THẬT của cổng — chỉ phần phiên đăng nhập / ghi yêu cầu là giả.
 */
function congGia(config: unknown, onCall?: (input: ReceiptDeleteGateInput) => Promise<void>) {
  const calls: ReceiptDeleteGateInput[] = [];
  const gate: ReceiptDeleteGate = async (input) => {
    calls.push(input);
    if (onCall) await onCall(input);
    if (isEnforced(config, input.group) && overThreshold(input.group, input.amount)) {
      return { mode: "NEEDS_APPROVAL", group: input.group, reason: APPROVAL_GROUP_REASON[input.group] } satisfies ApprovalDecision;
    }
    return { mode: "PROCEED", recorded: true, group: input.group } satisfies ApprovalDecision;
  };
  return { gate, calls };
}

const ACTOR = { id: null, label: "kiem-thu-cosd" };

async function donDep(db: Db) {
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.productionBatches).where(like(schema.productionBatches.id, `${P}%`));
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.settings).where(eq(schema.settings.key, SLOW_MOVING_KEY));
}

async function coPhieu(db: Db, id: string) {
  return Boolean(await db.query.stockReceipts.findFirst({ where: eq(schema.stockReceipts.id, id) }));
}

async function phieu(db: Db, id: string, kind: string, lines: { variantId: string; quantity: number; unitCost?: number }[], totalCost = 0) {
  await db.insert(schema.stockReceipts).values({ id, kind, receivedAt: DAY0, reference: id, totalQuantity: lines.reduce((t, l) => t + l.quantity, 0), totalCost, createdBy: "test" });
  await db.insert(schema.stockReceiptItems).values(lines.map((l, i) => ({ id: `${id}-i${i}`, receiptId: id, variantId: l.variantId, quantity: l.quantity, unitCost: l.unitCost ?? 0 })));
}

export function testCompanyOsInventoryPure() {
  // ───────── 2. Tách tồn có dấu ─────────
  const t = splitSignedStock([
    { stockKnown: true, stock: 10, available: 8 },
    { stockKnown: true, stock: -4, available: -6 },
    { stockKnown: false, stock: -100, available: -100 },
    { stockKnown: true, stock: 0, available: -2 },
  ]);
  assert.equal(t.onHandPositive, 10, "tổng tồn chỉ cộng dòng DƯƠNG — dòng −4 không được xoá 4 món có thật của mẫu khác");
  assert.equal(t.availablePositive, 8);
  assert.equal(t.negativeRows, 1, "đúng một mẫu âm sổ (mẫu CHƯA BIẾT không tính là âm)");
  assert.equal(t.negativeQty, 4);
  assert.equal(t.oversoldRows, 2, "khả dụng âm đếm riêng: −6 và −2");
  assert.equal(t.oversoldQty, 8);
  assert.ok(t.availablePositive <= t.onHandPositive, "khả dụng không lớn hơn tồn thực tế sau khi tách");

  // Tổng trang chủ PHẢI đi qua hàm tách — không cộng lại tồn có dấu ở chỗ khác.
  const risk = thanHam(nguon("lib/queries/stock.ts"), "export async function stockRiskSummary(");
  assert.ok(risk.includes("splitSignedStock("), "stockRiskSummary phải tách dòng âm bằng splitSignedStock");
  assert.ok(!/r\.stockKnown \? r\.stock : 0/.test(risk), "không được cộng tồn có dấu vào ON_HAND");

  // ───────── 5. Ngưỡng hàng chậm ─────────
  assert.deepEqual(DEFAULT_SLOW_MOVING_RULES, { ...SLOW_MOVING_RULES }, "mặc định = hằng số đang chạy");
  assert.ok(/DEFAULT_SLOW_MOVING_RULES: SlowMovingRules = \{ \.\.\.SLOW_MOVING_RULES \}/.test(nguon("lib/constants/slow-moving.ts")), "mặc định phải LẤY LẠI từ hằng số, không gõ lại con số (luật 22)");
  assert.deepEqual(resolveSlowMovingRules(null), { rules: { ...SLOW_MOVING_RULES }, overridden: [], ignored: null });
  const doi = resolveSlowMovingRules({ deadDays: 90 });
  assert.equal(doi.rules.deadDays, 90, "ghi đè thưa áp đúng ô đã chỉnh");
  assert.equal(doi.rules.excessCoverDays, SLOW_MOVING_RULES.excessCoverDays, "ô không chỉnh vẫn lấy từ mã");
  assert.deepEqual(doi.overridden, ["deadDays"]);
  const saiThuTu = resolveSlowMovingRules({ deadDays: 90, slowCoverDays: 200 });
  assert.deepEqual(saiThuTu.rules, { ...SLOW_MOVING_RULES }, "bộ sai thứ tự bị BỎ NGUYÊN BỘ — kể cả ô deadDays hợp lệ đi cùng");
  assert.ok(saiThuTu.ignored, "bộ bị bỏ phải nói lý do");
  assert.ok(resolveSlowMovingRules({ healthyCoverDays: 70 }).ignored, "lành mạnh > bán chậm là sai thứ tự");
  assert.ok(resolveSlowMovingRules({ deadDays: 0 }).ignored, "0 ngày không phải ngưỡng");
  assert.ok(resolveSlowMovingRules({ deadDays: "90" }).ignored, "chuỗi không phải số — không ép kiểu hộ");
  assert.ok(resolveSlowMovingRules({ deadDays: 1.5 }).ignored, "ngày phải nguyên");
  assert.ok(resolveSlowMovingRules([1, 2]).ignored);
  assert.deepEqual(resolveSlowMovingRules({ khoaLa: 5 }), { rules: { ...SLOW_MOVING_RULES }, overridden: [], ignored: null }, "khoá lạ bị lờ, không làm hỏng bộ");
  assert.equal(slowMovingRulesProblem({ ...SLOW_MOVING_RULES }), null, "bộ mặc định phải hợp lệ theo chính luật của nó");
  assert.deepEqual(sparseSlowMovingOverride({ ...SLOW_MOVING_RULES }), {}, "lưu mặc định = lưu rỗng (THƯA)");
  assert.deepEqual(sparseSlowMovingOverride({ ...SLOW_MOVING_RULES, deadDays: 75 }), { deadDays: 75 });
  // Trang Quyết định vốn tồn đọc CÙNG bộ ngưỡng với trang Hàng chậm.
  const dq = nguon("lib/queries/inventory-decision.ts");
  assert.ok(dq.includes("slowRules: slow.rules"), "báo cáo quyết định phải truyền ngưỡng đang hiệu lực");
  assert.ok(!dq.includes("SLOW_MOVING_RULES"), "truy vấn quyết định không được đọc thẳng hằng số nữa");
  assert.ok(!nguon("lib/queries/slow-moving.ts").includes("SLOW_MOVING_RULES."), "truy vấn hàng chậm không được đọc thẳng hằng số nữa");

  // ───────── 1. Nhóm duyệt khi xoá ─────────
  for (const k of STOCK_RECEIPT_KINDS) assert.ok(RECEIPT_DELETE_GROUP[k], `${k}: thiếu nhóm duyệt khi xoá`);
  assert.equal(RECEIPT_DELETE_GROUP.RECEIPT, "INVENTORY_WRITE_OFF", "xoá phiếu nhập = ghi giảm hàng");
  assert.equal(RECEIPT_DELETE_GROUP.RETURN, "INVENTORY_WRITE_OFF");
  assert.equal(RECEIPT_DELETE_GROUP.ISSUE, "INVENTORY_ADJUSTMENT", "xoá phiếu xuất tay = tạo lại hàng không chứng từ");
  assert.equal(RECEIPT_DELETE_GROUP.ADJUSTMENT, "INVENTORY_ADJUSTMENT");
  // Action phải đi qua lõi với cổng THẬT, không tự xoá.
  const act = thanHam(nguon("lib/actions/stock.ts"), "export async function deleteStockReceipt(");
  assert.ok(act.includes("deleteStockReceiptCore(") && act.includes("gate: guardSecondApproval"), "server action xoá phải gọi lõi với cổng duyệt thật");
  assert.ok(!act.includes("db.delete("), "server action không được tự xoá cứng ngoài lõi");

  // ───────── 4. Trạng thái dẫn xuất ─────────
  assert.equal(DERIVED_STOCK_STATES_ARE_LEDGER_MOVEMENTS, false);
  for (const k of Object.keys(DERIVED_STOCK_STATE_LABEL)) assert.ok(!(k in STOCK_STATE_LABEL), `${k} không được trùng khoá trạng thái sổ kho`);
  for (const c of DAMAGED_ITEM_CONDITIONS) assert.equal(ITEM_CONDITION_RESTOCKS[c], false, `${c} tính là hỏng thì không được cộng tồn`);

  // ───────── B1 (QA). "Đang sản xuất" trừ hàng đã nhập qua phiếu nối lệnh / lô — MỘT phép trừ ─────────
  assert.equal(openQtyAfterReceived(30, 0, 0), 30, "không phiếu nối ⇒ cả lệnh còn mở");
  assert.equal(openQtyAfterReceived(30, 0, 20), 10);
  assert.equal(openQtyAfterReceived(30, 25, 20), 5, "đã trả và đã nhập có thể là CÙNG món ⇒ lấy số lớn hơn, không cộng");
  assert.equal(openQtyAfterReceived(30, 10, 25), 5);
  assert.equal(openQtyAfterReceived(30, 0, 40), 0, "nhập vượt số đặt ⇒ 0, không âm");
  assert.equal(openQtyAfterReceived(30, -10, 0), 40, "không phiếu nối ⇒ ĐÚNG phép tính cũ, kể cả đợt trả âm (trả lại xưởng)");
  const loB1: OpenBatchInput[] = [
    { id: "b1", status: "OPEN", cells: { den: 100, do: 50 }, orderedQty: 150, agreedQty: null, dueDate: null, productionOrderId: null },
    { id: "b2", status: "OPEN", cells: {}, orderedQty: 40, agreedQty: null, dueDate: null, productionOrderId: null },
  ];
  const traB1 = [{ batchId: "b1", quantity: 60, cells: { den: 70, do: -10 } }];
  assert.deepEqual(openBatchQtyByVariant(loB1, traB1, new Map()), openBatchQtyByVariant(loB1, traB1), "không phiếu nối ⇒ kết quả lô y như trước");
  const coPhieuB1 = openBatchQtyByVariant(loB1, traB1, new Map([["b1", new Map([["den", 90], ["do", 5]])], ["b2", new Map([["x", 15]])]]));
  assert.equal(coPhieuB1.qtyByVariant.get("den"), 10, "đen: đặt 100, xưởng trả 70, kho nhập 90 ⇒ còn 10 (không phải 100 − 160)");
  assert.equal(coPhieuB1.qtyByVariant.get("do"), 45, "đỏ: đặt 50, trả −10, nhập 5 ⇒ max(−10, 5) = 5 ⇒ còn 45");
  assert.equal(coPhieuB1.unsplit.find((u) => u.batchId === "b2")?.remaining, 25, "lô chưa chia mẫu: 40 − 15 đã nhập");
  // Mọi nơi đọc "đang sản xuất" đi qua ĐÚNG hàm này.
  const dqB1 = nguon("lib/queries/inventory-decision.ts");
  assert.ok(dqB1.includes("linkedReceiptQty(\"order\")") && dqB1.includes("openQtyAfterReceived("), "openPoQtyByVariant phải trừ phiếu nối lệnh qua openQtyAfterReceived");

  console.log("✓ Company OS · D (thuần): tách tồn âm · ngưỡng hàng chậm thưa/bỏ nguyên bộ · nhóm duyệt khi xoá · trạng thái dẫn xuất");
}

export async function testCompanyOsInventoryDb(db: Db) {
  await donDep(db);
  try {
    // ── Dữ liệu gốc ──
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Đầm kiểm Company OS D", customId: "COSD1" });
    await db.insert(schema.productVariants).values([
      { id: `${P}v1`, productId: `${P}prod`, sku: "COSD1-S", color: "Đen", size: "S", retailPrice: 400_000 },
      { id: `${P}v2`, productId: `${P}prod`, sku: "COSD1-M", color: "Đen", size: "M", retailPrice: 400_000 },
      { id: `${P}v3`, productId: `${P}prod`, sku: "COSD1-L", color: "Đen", size: "L", retailPrice: 400_000 },
      { id: `${P}v4`, productId: `${P}prod`, sku: "COSD1-XL", color: "Đen", size: "XL", retailPrice: 400_000 },
    ]);
    await db.insert(schema.products).values({ id: `${P}empty`, name: "Mẫu không mẫu mã", customId: "COSD0" });

    // ═══ 1a. Phiếu tái nhập đang là chứng từ kiểm hoàn: KHÔNG xoá được ═══
    // Vận đơn chiều về là dòng RIÊNG, `order_id` NULL (AGENTS.md mục 3.7) — phiếu kiểm mang khoá đơn.
    // Đơn đã huỷ để không lọt vào "đã chốt chưa xuất" của bài khác.
    await db.insert(schema.orders).values({ id: `${P}o1`, stage: "CANCELLED", status: 6, insertedAt: DAY0 });
    await db.insert(schema.orderItems).values({ id: `${P}oi1`, orderId: `${P}o1`, variantId: `${P}v1`, productId: `${P}prod`, productName: "Đầm", sku: "COSD1-S", quantity: 3, unitPrice: 400_000, lineTotal: 1_200_000 });
    await db.insert(schema.shipments).values({ id: `${P}s1`, orderId: null, vtpOrderNumber: "COSD001", stage: "RETURNED", returnedAt: DAY0 });
    await phieu(db, `${P}ret`, "RETURN", [{ variantId: `${P}v1`, quantity: 1 }]);
    await db.insert(schema.returnInspections).values({ id: `${P}ins1`, shipmentId: `${P}s1`, orderId: `${P}o1`, status: "INSPECTED", receivedAt: DAY0, receivedBy: "kho", condition: "RESTOCKABLE", restockQty: 1, inspectedAt: DAY0, inspectedBy: "kho", stockReceiptId: `${P}ret` });
    const c0 = congGia({});
    const chan = await deleteStockReceiptCore(db, { id: `${P}ret`, reason: "lập nhầm phiếu", actor: ACTOR, actorEmail: "t@cosd", gate: c0.gate });
    assert.ok("error" in chan && chan.blocker?.inspections.length === 1, "phiếu RETURN đang gắn phiếu kiểm phải bị CHẶN");
    assert.ok("error" in chan && chan.error.includes("COSD001"), "thông điệp phải nêu vận đơn đang dựa vào phiếu");
    assert.ok("error" in chan && chan.error.includes("Điều chỉnh kiểm kê"), "thông điệp phải chỉ đường sửa có thật");
    assert.equal(c0.calls.length, 0, "bị chặn thì không cả hỏi cổng duyệt");
    assert.ok(await coPhieu(db, `${P}ret`), "phiếu vẫn còn");
    assert.equal((await db.query.returnInspections.findFirst({ where: eq(schema.returnInspections.id, `${P}ins1`) }))?.stockReceiptId, `${P}ret`, "phiếu kiểm không bị mồ côi");

    // ═══ 1b. Phiếu kiểm gắn vào GIỮA lúc kiểm và lúc xoá: lượt xoá có điều kiện phải dừng ═══
    await phieu(db, `${P}ret2`, "RETURN", [{ variantId: `${P}v1`, quantity: 1 }], 0);
    await db.insert(schema.shipments).values({ id: `${P}s2`, orderId: null, vtpOrderNumber: "COSD002", stage: "RETURNED", returnedAt: DAY0 });
    const chen = congGia({}, async () => {
      await db.insert(schema.returnInspections).values({ id: `${P}ins2`, shipmentId: `${P}s2`, orderId: `${P}o1`, status: "INSPECTED", receivedAt: DAY0, receivedBy: "kho", condition: "RESTOCKABLE", restockQty: 1, inspectedAt: DAY0, inspectedBy: "kho", stockReceiptId: `${P}ret2` });
    });
    const dua = await deleteStockReceiptCore(db, { id: `${P}ret2`, reason: "lập nhầm phiếu", actor: ACTOR, actorEmail: "t@cosd", gate: chen.gate });
    assert.ok("error" in dua, "phiếu kiểm vừa gắn vào ⇒ không xoá");
    assert.ok(await coPhieu(db, `${P}ret2`), "phiếu vẫn còn sau lượt đua");

    // ═══ 1c. Lý do bắt buộc ═══
    await phieu(db, `${P}adj`, "ADJUSTMENT", [{ variantId: `${P}v2`, quantity: -3 }]);
    const c1 = congGia({});
    const khongLyDo = await deleteStockReceiptCore(db, { id: `${P}adj`, reason: "  ab ", actor: ACTOR, actorEmail: "t@cosd", gate: c1.gate });
    assert.ok("error" in khongLyDo, "thiếu lý do thì không xoá");
    assert.equal(c1.calls.length, 0);
    assert.ok(await coPhieu(db, `${P}adj`));

    // ═══ 1d. Cưỡng chế BẬT: xoá điều chỉnh phải chờ duyệt, như lúc TẠO ═══
    const bat = congGia({ INVENTORY_ADJUSTMENT: true, INVENTORY_WRITE_OFF: true });
    const cho = await deleteStockReceiptCore(db, { id: `${P}adj`, reason: "kiểm kê lại thấy đúng", actor: ACTOR, actorEmail: "t@cosd", gate: bat.gate });
    assert.ok("error" in cho && cho.approval === "NEEDS_APPROVAL", "cưỡng chế bật ⇒ xoá điều chỉnh phải chờ người thứ hai");
    assert.equal(bat.calls[0]?.group, "INVENTORY_ADJUSTMENT");
    assert.equal(bat.calls[0]?.entityId, `${P}adj`, "yêu cầu duyệt phải trỏ đúng phiếu");
    assert.ok(await coPhieu(db, `${P}adj`), "chờ duyệt thì phiếu vẫn còn");
    // Phiếu nhập giá trị DƯỚI ngưỡng ghi giảm: làm luôn — cùng luật ngưỡng với phiếu xuất tay.
    await phieu(db, `${P}rc-small`, "RECEIPT", [{ variantId: `${P}v2`, quantity: 5, unitCost: 100_000 }], 500_000);
    const nho = await deleteStockReceiptCore(db, { id: `${P}rc-small`, reason: "nhập trùng hoá đơn", actor: ACTOR, actorEmail: "t@cosd", gate: bat.gate });
    assert.ok("ok" in nho, "dưới ngưỡng 1.000.000đ của nhóm ghi giảm ⇒ không cần duyệt");
    // Phiếu nhập 0đ: CHƯA BIẾT giá trị ⇒ coi như vượt ngưỡng.
    await phieu(db, `${P}rc-zero`, "RECEIPT", [{ variantId: `${P}v2`, quantity: 5 }], 0);
    const khongGia = await deleteStockReceiptCore(db, { id: `${P}rc-zero`, reason: "nhập trùng hoá đơn", actor: ACTOR, actorEmail: "t@cosd", gate: bat.gate });
    assert.ok("error" in khongGia && khongGia.approval === "NEEDS_APPROVAL", "0đ là CHƯA BIẾT, không phải dưới ngưỡng");
    assert.ok("ok" in (await deleteStockReceiptCore(db, { id: `${P}rc-zero`, reason: "nhập trùng hoá đơn", actor: ACTOR, actorEmail: "t@cosd", gate: congGia({}).gate })), "tắt cưỡng chế thì xoá được");

    // ═══ 1e. Cưỡng chế TẮT: xoá được, nhật ký giữ ảnh chụp đầy đủ + lý do ═══
    const tat = congGia({});
    const xoa = await deleteStockReceiptCore(db, { id: `${P}adj`, reason: "kiểm kê lại thấy đúng", actor: ACTOR, actorEmail: "t@cosd", gate: tat.gate });
    assert.ok("ok" in xoa, "cưỡng chế tắt ⇒ hành vi như cũ: xoá được");
    assert.equal(tat.calls.length, 1, "vẫn HỎI cổng (cổng thật ghi dấu vết 'chưa cần duyệt')");
    assert.ok(!(await coPhieu(db, `${P}adj`)), "phiếu đã xoá");
    const [nk] = await db
      .select({ detail: schema.auditLogs.detail })
      .from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.action, "STOCK_RECEIPT_DELETE"), eq(schema.auditLogs.entityId, `${P}adj`)));
    const d = nk?.detail as { before?: { header?: { id?: string; kind?: string }; items?: { quantity: number }[] }; reason?: string } | undefined;
    assert.equal(d?.before?.header?.id, `${P}adj`, "nhật ký giữ ĐẦU PHIẾU");
    assert.equal(d?.before?.header?.kind, "ADJUSTMENT");
    assert.deepEqual(d?.before?.items?.map((i) => i.quantity), [-3], "nhật ký giữ TỪNG DÒNG phiếu");
    assert.equal(d?.reason, "kiểm kê lại thấy đúng", "nhật ký giữ lý do");

    // ═══ 3. Cột nối lệnh SX / lô xưởng ═══
    await db.insert(schema.productionOrders).values({ id: `${P}po`, code: `${P}PO1`, productId: `${P}prod`, productCode: "COSD1", status: "SENT", totalQty: 20, createdBy: "t" });
    await db.insert(schema.productionOrders).values({ id: `${P}po-x`, code: `${P}PO2`, productId: `${P}prod`, productCode: "COSD1", status: "CANCELLED", totalQty: 20, createdBy: "t" });
    await db.insert(schema.productionBatches).values([
      { id: `${P}b1`, productId: `${P}prod`, productCode: "COSD1", batchNo: 1, orderedAt: DAY0, orderedQty: 30, cells: { [`${P}v1`]: 30 }, status: "OPEN" },
      { id: `${P}b2`, productId: `${P}prod`, productCode: "COSD1", batchNo: 2, orderedAt: DAY0, orderedQty: 12, status: "OPEN" },
      { id: `${P}b3`, productId: `${P}prod`, productCode: "COSD1", batchNo: 3, orderedAt: DAY0, orderedQty: 5, status: "OPEN", productionOrderId: `${P}po-x` },
    ]);
    await db.insert(schema.stockReceipts).values({ id: `${P}rc-null`, kind: "RECEIPT", receivedAt: DAY0, totalQuantity: 0, createdBy: "t" });
    const rNull = await db.query.stockReceipts.findFirst({ where: eq(schema.stockReceipts.id, `${P}rc-null`) });
    assert.equal(rNull?.productionOrderId, null, "không khai ⇒ NULL (không backfill, không đoán)");
    assert.equal(rNull?.productionBatchId, null);
    await assert.rejects(
      () => db.insert(schema.stockReceipts).values({ id: `${P}rc-bad`, kind: "RECEIPT", receivedAt: DAY0, productionOrderId: `${P}khong-co`, createdBy: "t" }).then(() => undefined),
      viPhamRangBuoc("stock_receipts_production_order_id_production_orders_id_fk"),
      "CSDL chặn mã lệnh bịa",
    );
    await assert.rejects(
      () => db.insert(schema.stockReceipts).values({ id: `${P}rc-bad2`, kind: "RECEIPT", receivedAt: DAY0, productionBatchId: `${P}khong-co`, createdBy: "t" }).then(() => undefined),
      viPhamRangBuoc("stock_receipts_production_batch_id_production_batches_id_fk"),
      "CSDL chặn mã lô bịa",
    );
    await db.insert(schema.stockReceipts).values({ id: `${P}rc-link`, kind: "RECEIPT", receivedAt: DAY0, productionOrderId: `${P}po`, productionBatchId: `${P}b1`, createdBy: "t" });
    assert.ok("ok" in (await validateProductionLink(db, { kind: "RECEIPT" })), "để trống là hợp lệ");
    assert.ok("ok" in (await validateProductionLink(db, { kind: "RECEIPT", productionOrderId: `${P}po`, productionBatchId: `${P}b1` })));
    assert.ok("error" in (await validateProductionLink(db, { kind: "RECEIPT", productionOrderId: `${P}khong-co` })), "mã lệnh không tồn tại");
    assert.ok("error" in (await validateProductionLink(db, { kind: "RECEIPT", productionBatchId: `${P}khong-co` })), "mã lô không tồn tại");
    assert.ok("error" in (await validateProductionLink(db, { kind: "RETURN", productionOrderId: `${P}po` })), "chỉ phiếu Nhập hàng gắn được lệnh");
    assert.ok("error" in (await validateProductionLink(db, { kind: "RECEIPT", productionOrderId: `${P}po-x` })), "lệnh đã huỷ");
    assert.ok("error" in (await validateProductionLink(db, { kind: "RECEIPT", productionOrderId: `${P}po`, productionBatchId: `${P}b3` })), "lô nối với lệnh KHÁC ⇒ hai cột nói hai lần đặt");
    // Xoá lệnh ⇒ phiếu KHÔNG mất, chỉ rơi về chưa khai.
    await db.delete(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po`));
    assert.equal((await db.query.stockReceipts.findFirst({ where: eq(schema.stockReceipts.id, `${P}rc-link`) }))?.productionOrderId, null, "ON DELETE SET NULL");

    // ═══ 4. getModelStockStates ═══
    await phieu(db, `${P}r-v1`, "RECEIPT", [{ variantId: `${P}v1`, quantity: 10, unitCost: 150_000 }], 1_500_000);
    // v2: chỉ có điều kiện đã xoá + phiếu nhập đã xoá ⇒ không phiếu NHẬP nào ⇒ CHƯA BIẾT
    await phieu(db, `${P}r-v2adj`, "ADJUSTMENT", [{ variantId: `${P}v2`, quantity: 2 }]);
    // v3: nhập 4 + tái nhập 1 − xuất tay 5 = 0 THẬT; có hàng hoàn quay về mà chưa kiểm từng món ⇒ hỏng CHƯA BIẾT
    await phieu(db, `${P}r-v3`, "RECEIPT", [{ variantId: `${P}v3`, quantity: 4 }]);
    await phieu(db, `${P}r-v3ret`, "RETURN", [{ variantId: `${P}v3`, quantity: 1 }]);
    await phieu(db, `${P}r-v3out`, "ISSUE", [{ variantId: `${P}v3`, quantity: -5 }]);
    // v4: nhập 2 − xuất tay 6 = −4 ⇒ ÂM SỔ
    await phieu(db, `${P}r-v4`, "RECEIPT", [{ variantId: `${P}v4`, quantity: 2 }]);
    await phieu(db, `${P}r-v4out`, "ISSUE", [{ variantId: `${P}v4`, quantity: -6 }]);
    // Hỏng: một dòng kiểm từng món trên v1.
    await db.insert(schema.returnInspectionItems).values({ id: `${P}ii1`, inspectionId: `${P}ins1`, shipmentId: `${P}s1`, expectedVariantId: `${P}v1`, expectedQty: 3, actualQty: 2, condition: "DAMAGED", note: "rách", inspectedBy: "kho", inspectedAt: DAY0 });
    // Chờ kiểm: kiện đã về, chưa đếm.
    await db.insert(schema.shipments).values({ id: `${P}s3`, orderId: null, vtpOrderNumber: "COSD003", stage: "RETURNED", returnedAt: DAY0 });
    await db.insert(schema.returnInspections).values({ id: `${P}ins3`, shipmentId: `${P}s3`, orderId: `${P}o1`, status: "RECEIVED", receivedAt: DAY0, receivedBy: "kho" });

    clearMemo();
    const m = await getModelStockStates(`${P}prod`);
    const v = (id: string) => m.variants.find((x) => x.variantId === `${P}${id}`)!;
    assert.equal(m.variants.length, 4);
    assert.equal(v("v1").stockKnown, true);
    assert.equal(v("v1").actualStock, 10 + 1 + 1, "10 nhập + 2 phiếu tái nhập 1 món (ret, ret2)");
    assert.equal(v("v2").stockKnown, false, "không phiếu NHẬP nào ⇒ CHƯA BIẾT");
    assert.equal(v("v2").actualStock, null, "chưa biết là null — KHÔNG phải 2 (số điều chỉnh) và không phải 0");
    assert.equal(v("v2").available, null);
    assert.equal(v("v3").actualStock, 0, "0 THẬT phải là 0, không phải null");
    assert.equal(v("v3").damaged, null, "hàng hoàn đã quay về mà chưa kiểm từng món ⇒ hỏng CHƯA BIẾT");
    assert.equal(v("v4").actualStock, -4);
    assert.equal(v("v2").damaged, 0, "chưa có kiện hoàn nào quay về ⇒ hỏng = 0 thật");
    assert.equal(v("v1").damaged, 2, "đọc từ dòng kiểm từng món");
    assert.equal(v("v1").inProduction, 30, "phần chưa trả của lô có chia mẫu");
    assert.equal(m.basis.inProductionUnsplitUnits, 12 + 5, "lô chưa chia mẫu đếm ở mức MẪU, không chia hộ");
    assert.equal(v("v1").pendingQc, 3, "kiện RECEIVED chưa đếm của đơn có 3 món v1");
    assert.equal(m.basis.returningIncludesPendingQc, true);
    for (const x of m.variants) for (const k of ["reserved", "inProduction", "returning", "pendingQc"] as const) assert.ok(Number.isFinite(x[k]), `${x.sku}.${k}`);
    // Tổng: chỉ cộng dòng DƯƠNG của mẫu đã biết tồn.
    assert.equal(m.totals.actualStock, 12 + 0, "v1 12 + v3 0; v4 âm KHÔNG trừ; v2 chưa biết KHÔNG cộng");
    assert.equal(m.totals.negativeVariants, 1);
    assert.equal(m.totals.negativeQty, 4);
    assert.deepEqual(m.coverage, { variants: 4, stockKnownVariants: 3, damagedKnownVariants: 3 });
    assert.equal(m.totals.damaged, 2);
    const rong = await getModelStockStates(`${P}empty`);
    assert.equal(rong.totals.actualStock, null, "mẫu không có mẫu mã nào ⇒ tồn CHƯA BIẾT, không phải 0");

    // ═══ 4b. B1 (QA): "đang sản xuất" trừ hàng đã NHẬP qua phiếu nối lệnh / lô ═══
    clearMemo();
    const v1Id = `${P}v1`;
    const truocB1 = await openPoQtyByVariant();
    const nenV1 = truocB1.qtyByVariant.get(v1Id) ?? 0;
    assert.equal(nenV1, 30, "nền: lô b1 còn mở 30 cái v1, chưa phiếu nào nối lô");
    await db.insert(schema.productionOrders).values({ id: `${P}po-b1`, code: `${P}PO-B1`, productId: `${P}prod`, productCode: "COSD1", status: "SENT", cells: { "Đen|S": 10 }, totalQty: 10, unitCost: 100_000, createdBy: "t" });
    const khongPhieu = await openPoQtyByVariant();
    assert.equal(khongPhieu.qtyByVariant.get(v1Id), nenV1 + 10, "lệnh chưa có phiếu nối ⇒ đếm đủ 10 như trước");
    assert.equal(khongPhieu.units, truocB1.units + 10);
    assert.equal(khongPhieu.capital, truocB1.capital + 1_000_000);
    await db.insert(schema.stockReceipts).values({ id: `${P}r-b1po`, kind: "RECEIPT", receivedAt: DAY0, productionOrderId: `${P}po-b1`, totalQuantity: 4, createdBy: "t" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}r-b1po-i`, receiptId: `${P}r-b1po`, variantId: v1Id, quantity: 4, unitCost: 100_000 });
    const motPhan = await openPoQtyByVariant();
    assert.equal(motPhan.qtyByVariant.get(v1Id), nenV1 + 6, "nhập 4/10 qua phiếu nối lệnh ⇒ còn 6");
    assert.equal(motPhan.units, truocB1.units + 6);
    assert.equal(motPhan.capital, truocB1.capital + 600_000, "vốn cam kết chỉ còn phần chưa về");
    // Phiếu KHÔNG nối (hoặc nối nhưng là tái nhập) không được trừ.
    await phieu(db, `${P}r-b1free`, "RECEIPT", [{ variantId: v1Id, quantity: 50 }]);
    // Phiếu tái nhập hoàn mang mã lệnh (form không cho, nhưng CSDL không cấm) — không phải hàng của xưởng.
    await db.insert(schema.stockReceipts).values({ id: `${P}r-b1ret`, kind: "RETURN", receivedAt: DAY0, productionOrderId: `${P}po-b1`, totalQuantity: 3, createdBy: "t" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}r-b1ret-i`, receiptId: `${P}r-b1ret`, variantId: v1Id, quantity: 3 });
    assert.equal((await openPoQtyByVariant()).qtyByVariant.get(v1Id), nenV1 + 6, "phiếu không nối lệnh, hay phiếu tái nhập hoàn, không trừ gì");
    await db.insert(schema.stockReceipts).values({ id: `${P}r-b1lo`, kind: "RECEIPT", receivedAt: DAY0, productionBatchId: `${P}b1`, totalQuantity: 25, createdBy: "t" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}r-b1lo-i`, receiptId: `${P}r-b1lo`, variantId: v1Id, quantity: 25 });
    await db.insert(schema.stockReceipts).values({ id: `${P}r-b1po2`, kind: "RECEIPT", receivedAt: DAY0, productionOrderId: `${P}po-b1`, totalQuantity: 9, createdBy: "t" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}r-b1po2-i`, receiptId: `${P}r-b1po2`, variantId: v1Id, quantity: 9 });
    clearMemo();
    const duB1 = await openPoQtyByVariant();
    assert.equal(duB1.qtyByVariant.get(v1Id), 5, "lô b1 30 − 25 đã nhập = 5; lệnh 10 − 13 đã nhập = 0 (không âm)");
    assert.equal(duB1.units, truocB1.units - 25, "lệnh không còn góp; lô bớt 25");
    const modelB1 = await getModelStockStates(`${P}prod`);
    assert.equal(modelB1.variants.find((x) => x.variantId === v1Id)?.inProduction, 5, "trang 360 đọc đúng phép trừ đó");
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, [`${P}r-b1po`, `${P}r-b1po2`, `${P}r-b1lo`, `${P}r-b1free`, `${P}r-b1ret`]));
    await db.delete(schema.productionOrders).where(eq(schema.productionOrders.id, `${P}po-b1`));

    // ═══ 2. Tổng tồn trang chủ = tổng DƯƠNG của đúng bảng kế hoạch ═══
    clearMemo();
    const [risk, plan] = await Promise.all([stockRiskSummary(), getReplenishmentPlan()]);
    const tach = splitSignedStock(plan.rows.map((r) => ({ stockKnown: r.stockKnown, stock: r.stock, available: r.available })));
    assert.equal(risk.states.ON_HAND, tach.onHandPositive, "ON_HAND = tổng dòng dương");
    assert.equal(risk.negativeRows, tach.negativeRows);
    assert.equal(risk.negativeQty, tach.negativeQty);
    const coV4 = plan.rows.some((r) => r.variantId === `${P}v4`);
    if (coV4) assert.ok(risk.negativeRows >= 1, "mẫu âm sổ phải được đếm");

    // ═══ 5. Ngưỡng hàng chậm qua settings ═══
    await setSettingJson(SLOW_MOVING_KEY, { deadDays: 90 });
    let r = await loadSlowMovingRules();
    assert.equal(r.rules.deadDays, 90);
    assert.deepEqual(r.overridden, ["deadDays"]);
    clearMemo();
    assert.equal((await getSlowMoving()).rules.deadDays, 90, "trang Hàng chậm dùng đúng bộ đang hiệu lực");
    await setSettingJson(SLOW_MOVING_KEY, { deadDays: 90, slowCoverDays: 500 });
    r = await loadSlowMovingRules();
    assert.deepEqual(r.rules, { ...SLOW_MOVING_RULES }, "bộ sai trong CSDL bị bỏ nguyên bộ");
    assert.ok(r.ignored);
    await db.update(schema.settings).set({ value: "{không phải json" }).where(eq(schema.settings.key, SLOW_MOVING_KEY));
    r = await loadSlowMovingRules();
    assert.deepEqual(r.rules, { ...SLOW_MOVING_RULES }, "rác trong settings không làm sập trang");
    assert.ok(r.ignored);

    console.log("✓ Company OS · D (CSDL): chặn xoá phiếu tái nhập có kiểm hoàn · duyệt hai bước khi xoá · nhật ký ảnh chụp · cột nối lệnh/lô · trạng thái tồn theo mẫu · tổng tồn không trừ dòng âm · ngưỡng hàng chậm");
  } finally {
    await db.delete(schema.returnInspections).where(inArray(schema.returnInspections.id, [`${P}ins1`, `${P}ins2`, `${P}ins3`]));
    await donDep(db);
    clearMemo();
  }
}
