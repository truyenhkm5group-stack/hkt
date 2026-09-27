import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { can } from "@/lib/auth/session";
import { clearMemo } from "@/lib/cache";
import { computeCostSheet, type SuggestedCellsSnapshot } from "@/lib/constants/production-os";
import {
  COST_V1_REASON,
  costV1Prefill,
  costV1ShortcutState,
  newPoHref,
  PO_SHORTCUT_REASON,
  poShortcutState,
  prefillDesignId,
  prefillSupplier,
  QUOTE_LINE_LABEL,
  RECEIPT_PREFILL_PARAM,
  RECEIPT_SHORTCUT_REASON,
  receiptPrefillFromPo,
  receiptShortcutHref,
  receiptShortcutState,
  TARGET_LINE_LABEL,
} from "@/lib/constants/production-shortcuts";
import { openQtyAfterReceived } from "@/lib/constants/workshop-ledger";
import { validateProductionLink } from "@/lib/inventory/production-link";
import { writeStockReceiptCore } from "@/lib/inventory/receipt-create";
import { validatePoPlan } from "@/lib/production/orders";
import { createSampleCore, reviewSampleCore, submitSampleCore } from "@/lib/production/samples";
import { startCostSheetFromTopicCore } from "@/lib/production/shortcuts";
import { addTopicMessageCore, createTopicCore, setTopicStatusCore } from "@/lib/production/topics";
import { openPoQtyByVariant } from "@/lib/queries/inventory-decision";
import { buildMatrixForProduct } from "@/lib/queries/production";
import { designOptionsForPo } from "@/lib/queries/production-os";
import { getNewPoPrefill, getPoReceiptPrefill, loadDesignPoShortcuts } from "@/lib/queries/production-shortcuts";

/**
 * ═══════════ COMPANY OS · AGENT SC — LỐI TẮT SẢN XUẤT (điền sẵn, người lưu) ═══════════
 *
 * Ba lối tắt: bản duyệt → "Lập lệnh SX" · lệnh ĐÃ GỬI → "Nhập kho theo lệnh SX" · topic ĐÃ CHỐT → "Lập
 * giá thành V1". Bài khoá: (1) số điền sẵn đúng nguồn (gợi ý Kế hoạch SX; lệnh − đã nhập qua phiếu nối,
 * không bao giờ âm; dòng giá thành CHỈ từ topic); (2) ghi đi qua lõi CÓ SẴN — không lệnh `insert` mới
 * nào vào ba bảng lệnh SX / phiếu kho / giá thành; (3) quyền + câu lý do khi nút tắt; (4) bấm hai lần
 * không đẻ bản thứ hai. Không mốc đồng hồ nào: lõi phát sự kiện bằng đồng hồ thật, bài không lọc thời gian
 * (luật 50, 65). Dọn mọi dòng mang tiền tố `cos-sc-` / mẫu của bài.
 */

const P = "cos-sc-";

// ─────────────────────────────── THUẦN ───────────────────────────────

export function testCompanyOsProductionShortcutsPure() {
  // ── 2. Số còn phải nhập theo lệnh ──
  const variants = [
    { id: "vM", productId: "p", color: "Đen", size: "M" },
    { id: "vL", productId: "p", color: "Đen", size: "L" },
    { id: "vTM", productId: "p", color: " trắng ", size: "m" },
    { id: "khac", productId: "q", color: "Xanh", size: "XL" },
  ];
  const r = receiptPrefillFromPo({ productId: "p", cells: { "Đen|M": 10, "Đen|L": 5, "Trắng|M": 3, "Xanh|XL": 2, "Đen|S": 0 } }, variants, new Map([["vM", 4], ["vL", 7]]));
  const theo = Object.fromEntries(r.rows.map((x) => [x.variantId, x.remaining]));
  assert.deepEqual(theo, { vM: 6, vL: 0, vTM: 3 }, "còn phải nhập = lệnh − đã nhập qua phiếu nối; nhập vượt ⇒ 0, không âm; ghép màu/size không phân biệt hoa thường / khoảng trắng");
  assert.deepEqual(r.unmapped, [{ cell: "Xanh|XL", qty: 2 }], "ô không ghép được mẫu mã (kể cả mẫu mã của sản phẩm KHÁC) không được điền, mà in ra");
  assert.equal(r.remainingTotal, 9);
  for (const row of r.rows) assert.equal(row.remaining, openQtyAfterReceived(row.planned, 0, row.received), "MỘT phép trừ — đúng `openQtyAfterReceived` của sổ đặt xưởng");
  const gop = receiptPrefillFromPo({ productId: "p", cells: { "Đen|M": 10, " đen |m": 2 } }, variants, new Map([["vM", 4]]));
  assert.deepEqual(gop.rows.map((x) => [x.variantId, x.planned, x.remaining]), [["vM", 12, 8]], "hai ô về cùng một mẫu mã: cộng trước rồi trừ MỘT lần (không trừ số đã nhập hai lần)");
  assert.deepEqual(receiptPrefillFromPo({ productId: null, cells: { "Đen|M": 3 } }, variants, new Map()).rows, [], "lệnh không gắn sản phẩm ⇒ không điền mẫu mã nào");
  assert.equal(receiptPrefillFromPo({ productId: "p", cells: { "Đen|M": 3 } }, variants, new Map()).rows[0].remaining, 3, "chưa có phiếu nối ⇒ còn đủ số lệnh");
  // Tính chất: không bao giờ âm, không bao giờ vượt số lệnh (bộ sinh tất định — không đồng hồ, không ngẫu nhiên thật).
  let seed = 7;
  const next = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed);
  for (let i = 0; i < 300; i++) {
    const planned = next() % 50;
    const received = (next() % 80) - 10;
    const x = receiptPrefillFromPo({ productId: "p", cells: { "Đen|M": planned } }, variants, new Map([["vM", received]]));
    const rem = x.rows[0]?.remaining ?? 0;
    assert.ok(rem >= 0 && rem <= planned, `còn phải nhập ∈ [0, lệnh] (lệnh ${planned}, đã nhập ${received} ⇒ ${rem})`);
  }

  assert.deepEqual(receiptShortcutState({ canWrite: false, status: "SENT", productId: "p", poId: "x", remainingTotal: 5 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NO_PERMISSION }, "không quyền nhập kho ⇒ tắt, nói lý do trước mọi lý do khác");
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "DRAFT", productId: "p", poId: "x", remainingTotal: 5 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOT_SENT });
  assert.equal(RECEIPT_SHORTCUT_REASON.NOT_SENT.startsWith("Lệnh SX chưa gửi xưởng"), true);
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "RECEIVED", productId: "p", poId: "x", remainingTotal: 5 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.RECEIVED });
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "CANCELLED", productId: "p", poId: "x", remainingTotal: 5 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.CANCELLED });
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "SENT", productId: null, poId: "x", remainingTotal: 5 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NO_PRODUCT });
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "SENT", productId: "p", poId: "x", remainingTotal: 0 }), { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOTHING_LEFT }, "nhập đủ rồi ⇒ bấm lần nữa không mở phiếu thứ hai theo lệnh");
  assert.deepEqual(receiptShortcutState({ canWrite: true, status: "SENT", productId: "p", poId: "x y", remainingTotal: null }), { enabled: true, href: `/inventory/receipts?${RECEIPT_PREFILL_PARAM}=x%20y` });
  assert.equal(receiptShortcutHref("a"), "/inventory/receipts?nhap-lenh=a");

  // ── 1. Bản duyệt → lập lệnh ──
  const mo = [
    { id: "po1", code: "PO-1", status: "SENT", designVersionId: "dv1" },
    { id: "po2", code: "PO-2", status: "RECEIVED", designVersionId: "dv2" },
    { id: "po3", code: "PO-3", status: "CANCELLED", designVersionId: "dv3" },
  ];
  assert.deepEqual(poShortcutState({ canWrite: false, productId: "p", designVersionId: "dv9", openOrders: [] }), { enabled: false, reason: PO_SHORTCUT_REASON.NO_PERMISSION });
  assert.deepEqual(poShortcutState({ canWrite: true, productId: "p", designVersionId: null, openOrders: [] }), { enabled: false, reason: PO_SHORTCUT_REASON.NO_DESIGN });
  assert.equal(PO_SHORTCUT_REASON.NO_DESIGN.startsWith("Chưa có bản thiết kế đã duyệt"), true);
  assert.deepEqual(poShortcutState({ canWrite: true, productId: null, designVersionId: "dv9", openOrders: [] }), { enabled: false, reason: PO_SHORTCUT_REASON.NO_PRODUCT }, "mẫu mã tạm (chưa có sản phẩm Pancake) ⇒ nói ra, không mở trình sửa rỗng");
  const trung = poShortcutState({ canWrite: true, productId: "p", designVersionId: "dv1", openOrders: mo });
  assert.ok(!trung.enabled && trung.href === "/inventory/planning/orders/po1" && trung.reason.includes("PO-1"), "đã có lệnh ĐANG MỞ trỏ bản duyệt này ⇒ bấm lần hai dẫn tới lệnh đó, không lập lệnh thứ hai");
  for (const d of ["dv2", "dv3", "dv9"]) assert.deepEqual(poShortcutState({ canWrite: true, productId: "p", designVersionId: d, openOrders: mo }), { enabled: true, href: newPoHref("p", d) }, `lệnh đã nhận / đã huỷ không chặn lệnh mới (${d})`);
  assert.equal(newPoHref("p 1", "d&1"), "/inventory/planning/orders/new?product=p%201&design=d%261");
  assert.equal(prefillDesignId([{ id: "dv1" }], "dv1"), "dv1");
  assert.equal(prefillDesignId([{ id: "dv1" }], "dv-cua-mau-khac"), null, "bản duyệt không thuộc mẫu ⇒ không chọn sẵn");
  assert.equal(prefillDesignId([{ id: "dv1" }], null), null);
  assert.deepEqual(prefillSupplier({ topicSupplier: "Xưởng A", sampleSupplier: "Xưởng B" }), { name: "Xưởng A", source: "TOPIC" });
  assert.deepEqual(prefillSupplier({ topicSupplier: "  ", sampleSupplier: "Xưởng B" }), { name: "Xưởng B", source: "SAMPLE" });
  assert.equal(prefillSupplier({ topicSupplier: null, sampleSupplier: null }), null, "không chứng từ xưởng nào ⇒ để trống, không đoán");

  // ── 3. Topic → giá thành V1 ──
  const mot = costV1Prefill({ quotes: [{ price: null }, { price: 118_000 }, { price: 118_000 }], targetPrice: 120_000 });
  assert.equal(mot.source, "QUOTE");
  assert.deepEqual(mot.lines, [{ kind: "OTHER", description: QUOTE_LINE_LABEL, qty: 1, unit: "sp", unitCost: 118_000 }], "xưởng báo MỘT mức ⇒ đúng một dòng OTHER mang giá báo — không bịa vải / công / phụ liệu");
  const tinh = computeCostSheet(mot.lines);
  assert.ok(!("error" in tinh) && tinh.total === 118_000, "dòng khởi tạo đi qua đúng công thức giá thành");
  const haiMuc = costV1Prefill({ quotes: [{ price: 118_000 }, { price: 110_000 }], targetPrice: 120_000 });
  assert.equal(haiMuc.source, "NONE", "xưởng báo NHIỀU mức ⇒ máy không chọn hộ mức nào (cũng không lùi về giá mong muốn)");
  assert.deepEqual(haiMuc.lines, []);
  assert.ok(haiMuc.note.includes("110.000") && haiMuc.note.includes("118.000"), "liệt kê các mức đã báo cho người chọn");
  const mongMuon = costV1Prefill({ quotes: [], targetPrice: 95_000 });
  assert.equal(mongMuon.source, "TARGET");
  assert.deepEqual(mongMuon.lines, [{ kind: "OTHER", description: TARGET_LINE_LABEL, qty: 1, unit: "sp", unitCost: 95_000 }]);
  assert.ok(!TARGET_LINE_LABEL.startsWith(QUOTE_LINE_LABEL) && TARGET_LINE_LABEL.includes("chưa phải giá xưởng báo"), "giá SHOP MUỐN không được đội tên giá xưởng báo");
  const trong = costV1Prefill({ quotes: [{ price: null }], targetPrice: null });
  assert.deepEqual([trong.source, trong.lines], ["NONE", []], "topic không có giá ⇒ bảng trống");
  for (const x of [mot, haiMuc, mongMuon, trong]) assert.ok(x.lines.length <= 1 && x.lines.every((l) => l.kind === "OTHER"), "không bao giờ quá một dòng, không bao giờ loại chi phí khác OTHER");

  assert.deepEqual(costV1ShortcutState({ canWrite: false, topicStatus: "SELECTED", costSheetCount: 0 }), { enabled: false, reason: COST_V1_REASON.NO_PERMISSION });
  assert.deepEqual(costV1ShortcutState({ canWrite: true, topicStatus: "OPTIONS_READY", costSheetCount: 0 }), { enabled: false, reason: COST_V1_REASON.NOT_SELECTED });
  assert.deepEqual(costV1ShortcutState({ canWrite: true, topicStatus: "SELECTED", costSheetCount: 1 }), { enabled: false, reason: COST_V1_REASON.HAS_SHEET });
  assert.deepEqual(costV1ShortcutState({ canWrite: true, topicStatus: "SELECTED", costSheetCount: 0 }), { enabled: true });

  // Quyền đi theo ĐÚNG hành động bên dưới: kho nhập được phiếu, không lập được giá thành.
  assert.equal(can("WAREHOUSE", "inventory:write"), true);
  assert.equal(can("WAREHOUSE", "production:write"), false);
  assert.equal(costV1ShortcutState({ canWrite: can("WAREHOUSE", "production:write"), topicStatus: "SELECTED", costSheetCount: 0 }).enabled, false);
  assert.equal(costV1ShortcutState({ canWrite: can("LEADER", "production:write"), topicStatus: "SELECTED", costSheetCount: 0 }).enabled, true);

  console.log("✓ Company OS · SC (thuần): còn phải nhập = lệnh − phiếu nối (một phép trừ, không âm, 300 ca) · nút lập lệnh / nhập kho / giá thành V1 tắt kèm lý do · dòng V1 chỉ từ báo giá hoặc giá mong muốn (nhãn đúng)");
}

// ─────────────────────────────── QUÉT MÃ NGUỒN ───────────────────────────────

const doc = (p: string) => readFileSync(p, "utf8");
const boChuThich = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

function tepMa(dir: string): string[] {
  const out: string[] = [];
  for (const ten of readdirSync(dir)) {
    const p = path.join(dir, ten);
    if (statSync(p).isDirectory()) out.push(...tepMa(p));
    else if (/\.(ts|tsx)$/.test(ten)) out.push(p.split(path.sep).join("/"));
  }
  return out;
}

/** Tệp nào `insert` vào bảng `bang` (qua `schema.X` hoặc bí danh `const a = schema.X`). */
function nguoiGhi(bang: string): string[] {
  const out: string[] = [];
  for (const f of [...tepMa("lib"), ...tepMa("app")]) {
    const src = boChuThich(doc(f));
    if (!src.includes(`schema.${bang}`)) continue;
    const biDanh = [...src.matchAll(new RegExp(`const\\s+(\\w+)\\s*=\\s*schema\\.${bang}\\b`, "g"))].map((m) => m[1]);
    const ten = [`schema\\.${bang}`, ...biDanh].join("|");
    if (new RegExp(`\\.insert\\(\\s*(?:${ten})\\s*\\)`).test(src)) out.push(f);
  }
  return out.sort();
}

export function testCompanyOsProductionShortcutsSource() {
  // Không lệnh ghi nào mới vào ba bảng: lối tắt chỉ điền sẵn / gọi lõi có sẵn.
  assert.deepEqual(nguoiGhi("productionOrders"), ["lib/actions/production.ts", "lib/creative/moq.ts"], "lệnh SX chỉ được TẠO ở action lưu bảng đặt hàng (và nháp MOQ có sẵn)");
  assert.deepEqual(nguoiGhi("stockReceipts"), ["lib/inventory/receipt-create.ts", "lib/returns/inspection.ts", "lib/returns/unidentified.ts"], "phiếu kho chỉ được tạo ở lõi có sẵn");
  assert.deepEqual(nguoiGhi("costSheets"), ["lib/production/costing.ts"], "bảng giá thành chỉ được tạo ở lõi giá thành");
  assert.deepEqual(nguoiGhi("costSheetLines"), ["lib/production/costing.ts"]);
  for (const f of ["lib/constants/production-shortcuts.ts", "lib/queries/production-shortcuts.ts", "lib/production/shortcuts.ts", "components/shortcut-action.tsx"]) {
    assert.ok(!/\.(insert|update|delete)\(/.test(boChuThich(doc(f))), `${f}: tệp lối tắt không tự ghi CSDL`);
  }
  const thuan = boChuThich(doc("lib/constants/production-shortcuts.ts"));
  assert.ok(!/new Date\(|Date\.now\(|@\/db/.test(thuan), "luật lối tắt thuần: không đồng hồ, không CSDL");

  // Giá thành V1 đi qua ĐÚNG lõi, chỉ-lần-đầu; action đọc quyền trước khi gọi lõi.
  const loi = boChuThich(doc("lib/production/shortcuts.ts"));
  assert.ok(/createCostSheetCore\(db, \{[^}]*onlyFirst: true/.test(loi), "lối tắt V1 gọi createCostSheetCore với onlyFirst");
  const action = boChuThich(doc("lib/actions/production-costing.ts"));
  const than = action.slice(action.indexOf("export async function startCostSheetFromTopic"));
  assert.ok(than.indexOf('can(user, "production:write")') > -1 && than.indexOf('can(user, "production:write")') < than.indexOf("startCostSheetFromTopicCore("), "quyền production:write kiểm TRƯỚC lõi");
  assert.ok(/revalidateProduction\(\)/.test(than), "action làm mới trang (client không gọi router.refresh)");
  const costing = boChuThich(doc("lib/production/costing.ts"));
  assert.ok(/if \(input\.onlyFirst\) \{\s*await tx\.select\([^;]*\.for\("update"\)/.test(costing), "onlyFirst khoá dòng mẫu TRƯỚC khi đếm (hai cú bấm đồng thời xếp hàng)");

  // Trình sửa lệnh: ô khởi tạo = gợi ý máy chủ tính lại lúc lưu; bản duyệt chọn sẵn chỉ khi hợp lệ.
  const moi = boChuThich(doc("app/(dashboard)/inventory/planning/orders/new/page.tsx"));
  assert.ok(/cells: m\.cells/.test(moi) && /initialFromSuggestion: true/.test(moi) && /buildMatrixForProduct\(/.test(moi), "ô số lượng = buildMatrixForProduct — đúng thứ saveProductionOrder tính lại vào suggested_cells");
  assert.ok(/designVersionId: tuLoiTat\.designVersionId/.test(moi) && /getNewPoPrefill\(designOptions/.test(moi), "bản duyệt chọn sẵn đi qua getNewPoPrefill(designOptions, …)");
  assert.ok(/requirePermission\("planning:write"\)/.test(moi));
  const luuLenh = boChuThich(doc("lib/actions/production.ts"));
  assert.ok(/buildMatrixForProduct\(d\.productId/.test(luuLenh), "máy chủ vẫn TÍNH LẠI gợi ý lúc lưu (không nhận từ trình duyệt)");

  // Nhập kho theo lệnh: hộp thoại lưu qua createStockReceipt (validateProductionLink ở máy chủ), chỉ mở khi nút bật.
  const hop = boChuThich(doc("app/(dashboard)/inventory/receipts/receipt-dialog.tsx"));
  assert.ok(/createStockReceipt\(\{ kind, receivedAt, reference, supplier, note, \.\.\.link/.test(hop), "hộp thoại điền sẵn vẫn lưu qua createStockReceipt");
  const trangPhieu = boChuThich(doc("app/(dashboard)/inventory/receipts/page.tsx"));
  assert.ok(/theoLenh && theoLenh\.state\.enabled/.test(trangPhieu) && /getPoReceiptPrefill\(poParam, canWrite\)/.test(trangPhieu), "chỉ điền sẵn khi nút bật, quyền = inventory:write của trang");
  assert.ok(/validateProductionLink\(db, \{ kind: data\.kind, productionOrderId: data\.productionOrderId/.test(boChuThich(doc("lib/actions/stock.ts"))), "máy chủ kiểm lệnh nối bằng validateProductionLink");
  const trangLenh = boChuThich(doc("app/(dashboard)/inventory/planning/orders/[id]/page.tsx"));
  assert.ok(/getPoReceiptPrefill\(o\.id, can\(user, "inventory:write"\)\)/.test(trangLenh), "nút nhập kho theo lệnh mang quyền inventory:write");
  for (const f of ["app/(dashboard)/production/topics/[id]/page.tsx", "app/(dashboard)/production/models/[id]/page.tsx"]) {
    assert.ok(/loadDesignPoShortcuts\(\{[^}]*canWrite: can\(user, "planning:write"\)/.test(boChuThich(doc(f))), `${f}: nút lập lệnh mang quyền của trình sửa lệnh (planning:write)`);
  }
  assert.ok(/costV1ShortcutState\(\{ canWrite, /.test(boChuThich(doc("app/(dashboard)/production/topics/[id]/page.tsx"))), "nút V1 mang quyền production:write của trang topic");
  // PR #284: client không tự làm mới sau action đã revalidate.
  for (const f of ["app/(dashboard)/production/_components/cost-sheets.tsx", "app/(dashboard)/inventory/receipts/receipt-dialog.tsx"]) {
    assert.equal((boChuThich(doc(f)).match(/router\.refresh\s*\(/g) ?? []).length, 0, `${f}: không router.refresh()`);
  }
  // Nút tắt không bao giờ tắt im lặng.
  const nut = boChuThich(doc("components/shortcut-action.tsx"));
  assert.ok(/\{reason \? <span[^>]*>\{reason\}<\/span> : null\}/.test(nut), "nút lối tắt tắt ⇒ in câu lý do cạnh nút");
  const bang = boChuThich(doc("app/(dashboard)/production/_components/cost-sheets.tsx"));
  assert.ok(/!v1\.state\.enabled \? <span[^>]*>\{v1\.state\.reason\}<\/span>/.test(bang), "nút V1 tắt ⇒ in lý do");

  console.log("✓ Company OS · SC (mã nguồn): không insert mới vào lệnh SX / phiếu kho / giá thành · V1 qua createCostSheetCore(onlyFirst, khoá dòng mẫu) · trình sửa lệnh + hộp thoại nhập hàng có sẵn · quyền đúng hành động · không router.refresh · nút tắt có lý do");
}

// ─────────────────────────────── CSDL (PGlite) ───────────────────────────────

async function don(db: Db) {
  const models = (await db.select({ id: schema.productModels.id }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`))).map((r) => r.id);
  const variantIds = (await db.select({ id: schema.productVariants.id }).from(schema.productVariants).where(like(schema.productVariants.id, `${P}%`))).map((r) => r.id);
  const receiptIds = variantIds.length ? [...new Set((await db.select({ id: schema.stockReceiptItems.receiptId }).from(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.variantId, variantIds))).map((r) => r.id))] : [];
  if (receiptIds.length) {
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.subjectId, receiptIds));
    await db.delete(schema.stockReceiptItems).where(inArray(schema.stockReceiptItems.receiptId, receiptIds));
    await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receiptIds));
  }
  await db.delete(schema.productionOrders).where(like(schema.productionOrders.id, `${P}%`));
  if (models.length) {
    await db.delete(schema.designVersions).where(inArray(schema.designVersions.modelId, models));
    const sampleIds = (await db.select({ id: schema.samples.id }).from(schema.samples).where(inArray(schema.samples.modelId, models))).map((r) => r.id);
    if (sampleIds.length) await db.delete(schema.sampleReviews).where(inArray(schema.sampleReviews.sampleId, sampleIds));
    await db.delete(schema.samples).where(inArray(schema.samples.modelId, models));
    const sheetIds = (await db.select({ id: schema.costSheets.id }).from(schema.costSheets).where(inArray(schema.costSheets.modelId, models))).map((r) => r.id);
    if (sheetIds.length) await db.delete(schema.costSheetLines).where(inArray(schema.costSheetLines.costSheetId, sheetIds));
    await db.delete(schema.costSheets).where(inArray(schema.costSheets.modelId, models));
    const topicIds = (await db.select({ id: schema.productionTopics.id }).from(schema.productionTopics).where(inArray(schema.productionTopics.modelId, models))).map((r) => r.id);
    if (topicIds.length) await db.delete(schema.productionTopicMessages).where(inArray(schema.productionTopicMessages.topicId, topicIds));
    await db.delete(schema.productionTopics).where(inArray(schema.productionTopics.modelId, models));
    await db.delete(schema.productModelStateHistory).where(inArray(schema.productModelStateHistory.modelId, models));
    await db.delete(schema.domainEvents).where(inArray(schema.domainEvents.modelId, models));
    await db.delete(schema.productModels).where(inArray(schema.productModels.id, models));
  }
  await db.delete(schema.productVariants).where(like(schema.productVariants.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.suppliers).where(like(schema.suppliers.id, `${P}%`));
}

export async function testCompanyOsProductionShortcutsDb(db: Db) {
  await don(db);
  try {
    await chay(db);
  } finally {
    await don(db);
    clearMemo();
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  assert.equal(Number(n), 0, "dọn xong: không còn mẫu nào của bài");
}

async function chay(db: Db) {
  const W = `${P}lead`;
  const A = `${P}mgr`;
  const K = `${P}kho`;
  await db
    .insert(schema.users)
    .values([
      { id: W, email: "cos-sc-lead@test.local", name: "Trưởng nhóm SC", passwordHash: "x", role: "LEADER" },
      { id: A, email: "cos-sc-mgr@test.local", name: "Quản lý SC", passwordHash: "x", role: "MANAGER" },
      { id: K, email: "cos-sc-kho@test.local", name: "Kho SC", passwordHash: "x", role: "WAREHOUSE" },
    ])
    .onConflictDoNothing();
  const lead = { id: W, label: "Trưởng nhóm SC" };
  const mgr = { id: A, label: "Quản lý SC" };
  const kho = { id: K, label: "Kho SC" };
  const PROD = `${P}p1`;
  await db.insert(schema.products).values([
    { id: PROD, name: "Đầm SC-1", customId: "SC-1" },
    { id: `${P}p2`, name: "Áo SC-2", customId: "SC-2" },
  ]);
  await db.insert(schema.productVariants).values([
    { id: `${P}vM`, productId: PROD, sku: "SC-1-M", color: "Đen", size: "M" },
    { id: `${P}vL`, productId: PROD, sku: "SC-1-L", color: "Đen", size: "L" },
  ]);
  await db.insert(schema.suppliers).values([
    { id: `${P}s-topic`, name: `${P}Xưởng Topic` },
    { id: `${P}s-mau`, name: `${P}Xưởng Làm Mẫu` },
  ]);
  const mau = (id: string, productId: string | null) => ({ id: `${P}${id}`, code: `SC${id.toUpperCase()}`, name: id, productId, lifecycleState: "WINNER" as const, registeredBy: "USER" as const });
  await db.insert(schema.productModels).values([mau("m1", PROD), mau("m2", `${P}p2`), mau("m3", null)]);
  const evidence = { kind: "SNAPSHOT" as const, capturedAt: new Date().toISOString(), basis: "kiểm thử SC", productId: PROD, orders30d: null, ordersTotal: null, adSpend30d: null };
  const req = (targetPrice: number | null) => ({ material: "Đũi", colors: [], sizes: [], trims: "", designNotes: "", salePrice: 299_000, targetPrice, expectedQty: null, deadline: null });
  const mo = async (modelId: string, targetPrice: number | null, supplierId: string | null) => {
    const t = await createTopicCore(db, { modelId, title: `Hỏi giá ${modelId}`, requirements: req(targetPrice), supplierId, evidence, actor: lead });
    assert.ok("ok" in t, "mở topic được");
    return (t as { topicId: string }).topicId;
  };
  const chot = async (topicId: string) => {
    assert.ok("ok" in (await setTopicStatusCore(db, { topicId, to: "OPTIONS_READY", actor: lead })));
    assert.ok("ok" in (await setTopicStatusCore(db, { topicId, to: "SELECTED", selectedOption: "PA1 đũi Nhật", actor: lead })));
  };
  const soBang = async (modelId: string) => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.costSheets).where(eq(schema.costSheets.modelId, modelId)))[0].n);

  // ═══ 3. Topic ĐÃ CHỐT → giá thành V1 ═══
  const t1 = await mo(`${P}m1`, 120_000, `${P}s-topic`);
  assert.ok("ok" in (await addTopicMessageCore(db, { topicId: t1, kind: "QUOTE", body: "Xưởng báo 118k", attachments: [], quotedUnitPrice: 118_000, actor: lead })));
  const chuaChot = await startCostSheetFromTopicCore(db, { topicId: t1, actor: lead, canWrite: true });
  assert.deepEqual(chuaChot, { error: COST_V1_REASON.NOT_SELECTED }, "topic chưa chốt ⇒ không tạo, nói lý do");
  await chot(t1);
  assert.deepEqual(await startCostSheetFromTopicCore(db, { topicId: t1, actor: kho, canWrite: false }), { error: COST_V1_REASON.NO_PERMISSION }, "không quyền ⇒ không tạo");
  assert.equal(await soBang(`${P}m1`), 0, "hai lần từ chối không ghi gì");
  const v1 = await startCostSheetFromTopicCore(db, { topicId: t1, actor: lead, canWrite: true });
  assert.ok("ok" in v1 && v1.mode === "CREATED" && v1.version === 1 && v1.totalUnitCost === 118_000, `tạo V1 nháp từ báo giá (${JSON.stringify(v1)})`);
  const [bang] = await db.select().from(schema.costSheets).where(eq(schema.costSheets.modelId, `${P}m1`));
  assert.equal(bang.status, "DRAFT");
  assert.equal(bang.topicId, t1, "bảng gắn đúng topic");
  assert.equal(bang.createdByUserId, W, "người bấm là người lập (khoá tài khoản)");
  const dong = await db.select({ kind: schema.costSheetLines.kind, description: schema.costSheetLines.description, unitCost: schema.costSheetLines.unitCost, amount: schema.costSheetLines.amount }).from(schema.costSheetLines).where(eq(schema.costSheetLines.costSheetId, bang.id));
  assert.deepEqual(dong, [{ kind: "OTHER", description: QUOTE_LINE_LABEL, unitCost: 118_000, amount: 118_000 }], "đúng một dòng, lấy từ báo giá của topic — không có giá bán 299k, không giá mong muốn 120k");
  const lan2 = await startCostSheetFromTopicCore(db, { topicId: t1, actor: lead, canWrite: true });
  assert.ok("ok" in lan2 && lan2.mode === "EXISTING" && lan2.version === 1, "bấm lần hai ⇒ nhận lại V1, không đẻ V2");
  assert.equal(await soBang(`${P}m1`), 1);
  const [{ ev }] = await db.select({ ev: sql<number>`count(*)::int` }).from(schema.domainEvents).where(and(eq(schema.domainEvents.modelId, `${P}m1`), eq(schema.domainEvents.name, "costing.version_created")));
  assert.equal(Number(ev), 1, "một sự kiện tạo phiên bản giá thành, không hai");

  // Topic chỉ có giá SX mong muốn: hai cú bấm ĐỒNG THỜI ⇒ đúng MỘT bảng.
  const t2 = await mo(`${P}m2`, 95_000, null);
  await chot(t2);
  const dongThoi = await Promise.all([startCostSheetFromTopicCore(db, { topicId: t2, actor: lead, canWrite: true }), startCostSheetFromTopicCore(db, { topicId: t2, actor: lead, canWrite: true })]);
  assert.deepEqual(dongThoi.map((x) => ("ok" in x ? x.mode : x.error)).sort(), ["CREATED", "EXISTING"], "hai cú bấm đồng thời: một tạo, một nhận lại");
  assert.equal(await soBang(`${P}m2`), 1);
  const [dong2] = await db.select({ description: schema.costSheetLines.description, unitCost: schema.costSheetLines.unitCost }).from(schema.costSheetLines).innerJoin(schema.costSheets, eq(schema.costSheets.id, schema.costSheetLines.costSheetId)).where(eq(schema.costSheets.modelId, `${P}m2`));
  assert.deepEqual(dong2, { description: TARGET_LINE_LABEL, unitCost: 95_000 }, "chưa có báo giá ⇒ dòng giá SX MONG MUỐN, gắn nhãn đúng là gì");

  // Topic không có giá nào ⇒ không ghi gì, màn hình mở bảng trống.
  const t3 = await mo(`${P}m3`, null, null);
  await chot(t3);
  const trong = await startCostSheetFromTopicCore(db, { topicId: t3, actor: lead, canWrite: true });
  assert.ok("ok" in trong && trong.mode === "EMPTY_EDITOR", "không giá ⇒ mở bảng trống");
  assert.equal(await soBang(`${P}m3`), 0, "không giá ⇒ không tạo bảng rỗng");

  // ═══ 1. Duyệt mẫu → bản duyệt → "Lập lệnh SX" điền sẵn ═══
  const s = await createSampleCore(db, { modelId: `${P}m1`, topicId: t1, fields: { supplierId: `${P}s-mau`, costVnd: null, images: [], notes: "", problems: "" }, actor: lead });
  assert.ok("ok" in s);
  if (!("ok" in s)) return;
  assert.ok("ok" in (await submitSampleCore(db, { sampleId: s.sampleId, actor: lead })));
  const duyet = await reviewSampleCore(db, { sampleId: s.sampleId, decision: "APPROVE", note: null, actor: mgr, canApprove: true });
  assert.ok("ok" in duyet && duyet.designVersionId, "duyệt mẫu ⇒ bản thiết kế");
  if (!("ok" in duyet) || !duyet.designVersionId) return;
  const DV = duyet.designVersionId;
  const options = await designOptionsForPo(PROD);
  const nut = await loadDesignPoShortcuts({ productId: PROD, designIds: [DV], canWrite: true });
  assert.deepEqual(nut[DV], { enabled: true, href: newPoHref(PROD, DV) }, "bản duyệt ⇒ nút mở trình sửa lệnh có ?design=");
  assert.deepEqual((await loadDesignPoShortcuts({ productId: PROD, designIds: [DV], canWrite: can("MARKETING", "planning:write") }))[DV], { enabled: false, reason: PO_SHORTCUT_REASON.NO_PERMISSION });
  assert.deepEqual((await loadDesignPoShortcuts({ productId: null, designIds: [DV], canWrite: true }))[DV], { enabled: false, reason: PO_SHORTCUT_REASON.NO_PRODUCT });
  const dien = await getNewPoPrefill(options, DV);
  assert.deepEqual(dien, { designVersionId: DV, designVersion: 1, supplier: { name: `${P}Xưởng Topic`, source: "TOPIC" }, invalidDesign: false }, "chọn sẵn bản duyệt + xưởng của topic (ưu tiên hơn xưởng làm mẫu)");
  await db.update(schema.productionTopics).set({ supplierId: null }).where(eq(schema.productionTopics.id, t1));
  assert.deepEqual((await getNewPoPrefill(options, DV)).supplier, { name: `${P}Xưởng Làm Mẫu`, source: "SAMPLE" }, "topic không khai xưởng ⇒ xưởng đã làm mẫu được duyệt");
  assert.deepEqual(await getNewPoPrefill(options, "dv-cua-mau-khac"), { designVersionId: null, designVersion: null, supplier: null, invalidDesign: true }, "bản duyệt lạ ⇒ không chọn, không điền xưởng");

  // Ô khởi tạo = gợi ý Kế hoạch SX ⇒ máy chủ tính lại ĐÚNG số đó lúc lưu, không đòi lý do; sửa một ô ⇒ đòi.
  clearMemo();
  const m = await buildMatrixForProduct(PROD);
  assert.ok(m, "kế hoạch dựng được ma trận");
  if (!m) return;
  const oKhoiTao = Object.fromEntries(Object.entries(m.cells).filter(([, v]) => v > 0));
  const mayTinhLai = await buildMatrixForProduct(PROD, { coverDays: m.coverDays, countIncoming: m.countIncoming });
  const goiY: SuggestedCellsSnapshot = { cells: Object.fromEntries(Object.entries(mayTinhLai!.cells).filter(([, v]) => v > 0)), basis: { source: "buildMatrixForProduct", coverDays: m.coverDays, countIncoming: m.countIncoming, leadTimeDays: m.leadTimeDays }, computedAt: "cố định" };
  assert.deepEqual(goiY.cells, oKhoiTao, "ô điền sẵn = đúng gợi ý máy chủ lưu vào suggested_cells");
  const khop = await validatePoPlan(db, { productId: PROD, designVersionId: dien.designVersionId, suggestion: goiY, finalCells: oKhoiTao, overrideReason: "" });
  assert.ok("ok" in khop && khop.plan.diff.length === 0 && khop.plan.designVersion?.id === DV, "giữ nguyên số điền sẵn ⇒ không cần lý do, bản duyệt được nhận");
  const sua = await validatePoPlan(db, { productId: PROD, designVersionId: DV, suggestion: goiY, finalCells: { ...oKhoiTao, "Đen|M": (oKhoiTao["Đen|M"] ?? 0) + 7 }, overrideReason: "" });
  assert.ok("error" in sua, "sửa một ô so với gợi ý ⇒ luật ghi lý do vẫn đứng");

  // Người bấm Chốt — `saveProductionOrder` không tách được khỏi phiên đăng nhập, nên bài ghi lệnh như action ghi.
  const PO = `${P}po1`;
  await db.insert(schema.productionOrders).values({ id: PO, code: `${P}PO-1`, productId: PROD, productCode: "SC-1", productName: "Đầm SC-1", colors: ["Đen"], sizes: ["M", "L"], cells: { "Đen|M": 10, "Đen|L": 5 }, totalQty: 15, supplier: `${P}Xưởng Topic`, supplierId: `${P}s-topic`, designVersionId: DV, createdBy: "cos-sc-lead@test.local" });
  const lai = (await loadDesignPoShortcuts({ productId: PROD, designIds: [DV], canWrite: true }))[DV];
  assert.ok(!lai.enabled && lai.href === `/inventory/planning/orders/${PO}`, "đã có lệnh đang mở trỏ bản duyệt ⇒ bấm lần hai dẫn tới lệnh đó");

  // ═══ 2. Lệnh ĐÃ GỬI → nhập kho theo lệnh ═══
  const nhap0 = await getPoReceiptPrefill(PO, true);
  assert.deepEqual(nhap0?.state, { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOT_SENT }, "lệnh nháp ⇒ nút tắt, nói chưa gửi xưởng");
  await db.update(schema.productionOrders).set({ status: "SENT", sentAt: new Date() }).where(eq(schema.productionOrders.id, PO));
  assert.deepEqual((await getPoReceiptPrefill(PO, can("MARKETING", "inventory:write")))?.state, { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NO_PERMISSION });
  const nhap1 = await getPoReceiptPrefill(PO, true);
  assert.ok(nhap1 && nhap1.state.enabled && nhap1.po.supplier === `${P}Xưởng Topic`);
  assert.deepEqual(Object.fromEntries(nhap1!.prefill.rows.map((x) => [x.variantId, x.remaining])), { [`${P}vM`]: 10, [`${P}vL`]: 5 }, "chưa phiếu nào nối ⇒ đủ số lệnh");

  // Phiếu nhập qua ĐÚNG lõi của action (sau cổng validateProductionLink).
  const nhapPhieu = async (lines: [string, number][], productionOrderId: string | null, kind: "RECEIPT" | "RETURN" = "RECEIPT") => {
    const noi = await validateProductionLink(db, { kind, productionOrderId });
    if ("error" in noi) return noi;
    return writeStockReceiptCore(db, {
      kind,
      receipt: { receivedAt: new Date(), reference: `${P}phieu`, supplier: "", supplierId: null, productionOrderId: noi.link.productionOrderId, productionBatchId: null, note: "", totalQuantity: lines.reduce((t, [, q]) => t + q, 0), totalCost: 0, createdBy: "Kho SC" },
      lines: lines.map(([variantId, quantity]) => ({ variantId, quantity, unitCost: 0, shipmentId: null })),
      note: "",
      actor: kho,
      approver: { id: K, email: "cos-sc-kho@test.local" },
      gate: null,
    });
  };
  assert.ok("error" in (await nhapPhieu([[`${P}vM`, 1]], PO, "RETURN")), "phiếu tái nhập hoàn không nối được lệnh (cổng có sẵn)");
  assert.ok("ok" in (await nhapPhieu([[`${P}vM`, 4]], PO)));
  assert.ok("ok" in (await nhapPhieu([[`${P}vL`, 7]], PO)), "nhập vượt số lệnh vẫn là phiếu hợp lệ (đếm thật)");
  assert.ok("ok" in (await nhapPhieu([[`${P}vM`, 3]], null)), "phiếu KHÔNG nối lệnh không trừ vào lệnh");
  const nhap2 = await getPoReceiptPrefill(PO, true);
  assert.deepEqual(Object.fromEntries(nhap2!.prefill.rows.map((x) => [x.variantId, x.remaining])), { [`${P}vM`]: 6, [`${P}vL`]: 0 }, "còn phải nhập = lệnh − phiếu NỐI lệnh; nhập vượt ⇒ 0, không âm");
  assert.equal(nhap2!.prefill.remainingTotal, 6);
  // Cùng số với "đang sản xuất" mà Kế hoạch / Quyết định vốn tồn đọc (một phép trừ, hai nơi đọc).
  const dangSx = await openPoQtyByVariant();
  assert.equal(dangSx.qtyByVariant.get(`${P}vM`) ?? 0, 6);
  assert.equal(dangSx.qtyByVariant.get(`${P}vL`) ?? 0, 0);
  assert.ok("ok" in (await nhapPhieu([[`${P}vM`, 6]], PO)));
  assert.deepEqual((await getPoReceiptPrefill(PO, true))?.state, { enabled: false, reason: RECEIPT_SHORTCUT_REASON.NOTHING_LEFT }, "nhập đủ ⇒ mở lại lối tắt không điền gì, nút tắt kèm lý do");
  assert.equal(await getPoReceiptPrefill(`${P}khong-co`, true), null);

  console.log("✓ Company OS · SC (CSDL): V1 từ báo giá / giá mong muốn / bảng trống, bấm lại + bấm đồng thời chỉ một bảng · duyệt mẫu ⇒ lập lệnh chọn sẵn bản duyệt + xưởng (topic > mẫu), ô = gợi ý máy chủ lưu, sửa ô vẫn đòi lý do, lệnh đang mở chặn lệnh thứ hai · nhập theo lệnh = lệnh − phiếu nối (4+7 vượt ⇒ 6/0, khớp openPoQtyByVariant), nhập đủ ⇒ tắt");
}
