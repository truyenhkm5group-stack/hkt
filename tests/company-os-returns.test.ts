import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { APPROVAL_GROUP_REASON, isEnforced, overThreshold, type ApprovalDecision } from "@/lib/constants/approval";
import { DOMAIN_EVENT_BY_NAME } from "@/lib/constants/domain-events";
import { COST_BASES } from "@/lib/constants/inspection-truth";
import { ITEM_CONDITIONS, ITEM_CONDITION_RESTOCKS } from "@/lib/constants/return-lifecycle";
import {
  checkDispositionRequest,
  DISPOSITION_ALLOWED_FROM,
  DISPOSITION_NEEDS_NOTE,
  foldDispositions,
  NON_RESTOCK_ITEM_CONDITIONS,
  parseSubjectKey,
  RETURN_DISPOSITIONS,
  subjectKeyOf,
  TERMINAL_DISPOSITIONS,
  type DispositionEntry,
} from "@/lib/constants/return-disposition";
import { ALERT_KIND_TO_SOURCE, WORK_SOURCE_SPEC } from "@/lib/constants/work-sources";
import { deleteStockReceiptCore } from "@/lib/inventory/receipt-delete";
import { getModelReturnDispositions } from "@/lib/queries/model-returns";
import { getModelStockStates } from "@/lib/queries/model-stock";
import { listDispositionQueue } from "@/lib/queries/return-dispositions";
import { adaptReturnDispositions, collectWorkItems } from "@/lib/queries/work-adapters";
import { setReturnDispositionCore, type DispositionGate, type DispositionGateInput } from "@/lib/returns/disposition";
import { recordInspection } from "@/lib/returns/inspection";

/**
 * ═══════════ COMPANY OS · AGENT E — KẾT CỤC HÀNG HOÀN KHÔNG TÁI NHẬP ═══════════
 *
 * Khoá bảy điều:
 *  1. Sổ `return_dispositions` là APPEND-ONLY (quét mã nguồn), và KHÔNG báo cáo lợi nhuận nào đọc nó.
 *  2. Nhập lại sau sửa lập ĐÚNG MỘT phiếu RETURN với SỐ ĐẾM, qua đường ghi phiếu của trạm kiểm; gửi lại
 *     cùng khoá không nhân đôi; chỉ đi sau "đang sửa".
 *  3. Huỷ bỏ KHÔNG ghi sổ kho, bắt buộc lý do, đi qua cổng `INVENTORY_WRITE_OFF` (giá chưa biết ⇒
 *     coi như vượt ngưỡng).
 *  4. Chỉ món đã kiểm, KHÔNG tái nhập, có hàng thật mới là đối tượng — kiện chờ đếm / món "Đủ" / món
 *     đếm 0 / kiện "Thiếu hàng" cả kiện thì không.
 *  5. `return.disposition_set` phát đúng một lần cho mỗi dòng sổ, mang mẫu khi lần ra được.
 *  6. Nguồn việc `RETURN_DISPOSITION` không chiếu trùng `RETURN_INSPECTION`, khoá không trùng.
 *  7. Tóm tắt theo mẫu: CHƯA BIẾT (`null`) tách khỏi 0 thật.
 *
 * Không phụ thuộc đồng hồ: mọi mốc là ngày cố định, không khẳng định nào lọc theo "N ngày trước".
 */

const P = "cose-";
const DAY0 = new Date("2026-03-02T03:00:00Z");

function nguon(rel: string) {
  return readFileSync(rel, "utf8");
}

function congGia(config: unknown) {
  const calls: DispositionGateInput[] = [];
  const gate: DispositionGate = async (input) => {
    calls.push(input);
    if (isEnforced(config, input.group) && overThreshold(input.group, input.amount)) {
      return { mode: "NEEDS_APPROVAL", group: input.group, reason: APPROVAL_GROUP_REASON[input.group] } satisfies ApprovalDecision;
    }
    return { mode: "PROCEED", recorded: true, group: input.group } satisfies ApprovalDecision;
  };
  return { gate, calls };
}

const e = (disposition: DispositionEntry["disposition"], qty: number, at: string, id: string): DispositionEntry => ({ disposition, qty, createdAt: at, id });

export function testCompanyOsReturnsPure() {
  // ───────── Hằng số khớp CHECK ở CSDL ─────────
  const mig = nguon("drizzle/0136_company_os_returns.sql");
  for (const d of RETURN_DISPOSITIONS) assert.ok(mig.includes(`'${d}'`), `CHECK kết cục của migration thiếu ${d}`);
  for (const b of COST_BASES) assert.ok(mig.includes(`'${b}'`), `CHECK bậc giá vốn thiếu ${b}`);
  assert.ok(mig.includes(`"return_dispositions_note_check" CHECK ("disposition" <> 'WRITE_OFF' OR length(trim("note")) > 0)`), "huỷ bỏ phải bắt buộc lý do ở CSDL");
  assert.deepEqual(RETURN_DISPOSITIONS.filter((d) => DISPOSITION_NEEDS_NOTE[d]), ["WRITE_OFF"], "danh sách bắt buộc lý do phải khớp CHECK `return_dispositions_note_check`");
  assert.ok(/"actor_user_id" text NOT NULL/.test(mig), "người làm bắt buộc có khoá tài khoản (luật 34)");
  assert.ok(!/INSERT INTO/i.test(mig), "migration KHÔNG gieo dòng nào (mục 8.8, 35)");
  assert.deepEqual([...NON_RESTOCK_ITEM_CONDITIONS], ITEM_CONDITIONS.filter((c) => !ITEM_CONDITION_RESTOCKS[c]), "đối tượng = đúng các kết luận KHÔNG cộng tồn, dẫn xuất từ sổ kết luận");
  assert.ok(!NON_RESTOCK_ITEM_CONDITIONS.includes("OK"));

  // ───────── Gập sổ ─────────
  const lich = [e("REWORK", 3, "2026-03-03T00:00:00Z", "b"), e("RESTOCK_AFTER_REWORK", 2, "2026-03-04T00:00:00Z", "c"), e("PENDING_DECISION", 1, "2026-03-03T00:00:00Z", "a")];
  const f = foldDispositions(3, lich);
  assert.deepEqual(f, { subjectQty: 3, restocked: 2, writtenOff: 0, returnedToSupplier: 0, remaining: 1, state: "REWORK" }, "cùng mốc thì xếp theo id: a (chưa quyết) rồi b (đang sửa)");
  assert.deepEqual(foldDispositions(3, [...lich].reverse()), f, "gập phải ổn định với thứ tự dòng CSDL trả về");
  assert.equal(foldDispositions(2, [e("WRITE_OFF", 2, "2026-03-05T00:00:00Z", "x")]).state, null, "hết phần mở ⇒ không còn trạng thái");
  assert.equal(foldDispositions(4, []).state, "PENDING_DECISION", "chưa có dòng nào ⇒ mặc định CHƯA QUYẾT (không backfill)");

  // ───────── Kiểm yêu cầu ─────────
  const moi = foldDispositions(3, []);
  assert.ok("error" in checkDispositionRequest(moi, { disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "" }), "nhập lại KHÔNG được đi thẳng từ chưa quyết — phải qua sửa");
  assert.ok("error" in checkDispositionRequest(moi, { disposition: "WRITE_OFF", qty: 1, note: "   " }), "huỷ bỏ thiếu lý do ⇒ từ chối");
  assert.ok("error" in checkDispositionRequest(moi, { disposition: "WRITE_OFF", qty: 4, note: "rách không vá được" }), "không huỷ quá phần còn mở");
  assert.ok("error" in checkDispositionRequest(moi, { disposition: "WRITE_OFF", qty: null, note: "rách không vá được" }), "kết cục cuối phải có số món");
  assert.ok("error" in checkDispositionRequest(moi, { disposition: "PENDING_DECISION", qty: null, note: "" }), "đã ở trạng thái đó ⇒ không ghi thêm dòng");
  assert.deepEqual(checkDispositionRequest(moi, { disposition: "REWORK", qty: 1, note: "" }), { ok: true, qty: 3 }, "trạng thái luôn áp cho TOÀN BỘ phần còn mở");
  assert.deepEqual(checkDispositionRequest(foldDispositions(3, [e("REWORK", 3, "2026-03-03T00:00:00Z", "a")]), { disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "" }), { ok: true, qty: 2 });
  assert.ok("error" in checkDispositionRequest(foldDispositions(1, [e("WRITE_OFF", 1, "2026-03-03T00:00:00Z", "a")]), { disposition: "REWORK", qty: null, note: "" }), "đã có kết cục cuối cho toàn bộ ⇒ không còn gì để quyết");
  for (const d of TERMINAL_DISPOSITIONS) assert.ok(DISPOSITION_ALLOWED_FROM[d].length > 0, `kết cục cuối ${d} phải đi được từ ít nhất một trạng thái mở`);
  assert.deepEqual([...DISPOSITION_ALLOWED_FROM.RESTOCK_AFTER_REWORK], ["REWORK"], "nhập lại CHỈ sau khi đưa đi sửa");
  assert.deepEqual(parseSubjectKey(subjectKeyOf("ITEM", "abc")), { grain: "ITEM", id: "abc" });
  assert.equal(parseSubjectKey("kien:1"), null);

  // ───────── Quét mã nguồn ─────────
  const tep = execSync("git ls-files lib app scripts components && git ls-files --others --exclude-standard lib app scripts components", { encoding: "utf8" })
    .split("\n")
    .map((x) => x.trim())
    .filter((x) => /\.(ts|tsx|mjs|js|sql)$/.test(x) && existsSync(x));
  assert.ok(tep.length > 200, `đọc hụt mã nguồn (chỉ thấy ${tep.length} tệp)`);
  const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/^\s*--.*$/gm, "");
  const ghiDe: string[] = [];
  const docSo: string[] = [];
  // Hai tệp của Agent D đọc sổ vì lý do KHÔNG phải tiền: chặn xoá phiếu nhập lại sau sửa, và trừ SỐ MÓN đã
  // có kết cục khỏi ô "hỏng chờ xử lý". Không tệp nào khác — nhất là không báo cáo lợi nhuận nào.
  const DUOC_DOC = new Set([
    "lib/queries/return-dispositions.ts",
    "lib/queries/model-returns.ts",
    "lib/returns/disposition.ts",
    "lib/actions/return-dispositions.ts",
    "lib/inventory/receipt-delete.ts",
    "lib/queries/model-stock.ts",
  ]);
  for (const f of tep) {
    const src = boChuThich(readFileSync(f, "utf8"));
    const biDanh = ["schema\\.returnDispositions", ...[...src.matchAll(/const (\w+) = schema\.returnDispositions\b/g)].map((m) => m[1])];
    if (biDanh.some((b) => new RegExp(`\\.(update|delete)\\(\\s*${b}\\b`).test(src)) || /\b(update|delete\s+from|truncate)\s+"?return_dispositions\b/i.test(src)) ghiDe.push(f);
    if ((/returnDispositions\b|return_dispositions\b/.test(src)) && !DUOC_DOC.has(f) && f !== "db/schema.ts" && !f.startsWith("drizzle/")) docSo.push(f);
  }
  assert.deepEqual(ghiDe, [], "return_dispositions là APPEND-ONLY — không UPDATE / DELETE ở lib/app/scripts/components");
  assert.deepEqual(docSo, [], "chỉ sáu tệp khai ở DUOC_DOC được đọc return_dispositions — KHÔNG báo cáo lợi nhuận / tồn kho nào đọc giá trị huỷ ước tính ở bản này");

  const dv = boChuThich(nguon("lib/returns/disposition.ts"));
  assert.ok(!/insert\(\s*schema\.stockReceipt/.test(dv), "lõi kết cục KHÔNG tự lập phiếu kho — chỉ đi qua createRestockReceipt của trạm kiểm");
  assert.equal((dv.match(/createRestockReceipt\(/g) ?? []).length, 1, "đúng MỘT lời gọi lập phiếu tái nhập");
  assert.ok(/input\.disposition === "RESTOCK_AFTER_REWORK" && variantId\s*\?\s*await createRestockReceipt\(/.test(dv), "phiếu tái nhập CHỈ cho kết cục nhập lại sau sửa");
  assert.ok(/gate:\s*guardSecondApproval/.test(nguon("lib/actions/return-dispositions.ts")), "action phải truyền cổng duyệt THẬT (guardSecondApproval)");
  assert.ok(/group:\s*WRITE_OFF_APPROVAL_GROUP/.test(dv) && /WRITE_OFF_APPROVAL_GROUP: ApprovalGroup = "INVENTORY_WRITE_OFF"/.test(dv), "huỷ bỏ đi nhóm duyệt có sẵn INVENTORY_WRITE_OFF");
  const spec = DOMAIN_EVENT_BY_NAME["return.disposition_set"];
  assert.ok(spec && spec.status === "LIVE" && spec.emitter === "lib/returns/disposition.ts", "return.disposition_set phải LIVE và trỏ đúng tệp phát");

  // Nguồn việc: không cảnh báo nào đổ vào nguồn này, và câu SQL chỉ đọc kiện ĐÃ KIỂM.
  assert.ok(!Object.values(ALERT_KIND_TO_SOURCE).includes("RETURN_DISPOSITION"), "không loại cảnh báo nào được chiếu vào RETURN_DISPOSITION — nếu có thì phải khai ALERT_KINDS_OWNED_ELSEWHERE");
  assert.equal(WORK_SOURCE_SPEC.RETURN_DISPOSITION.statusAuthority, "SOURCE", "trạng thái nằm ở sổ kết cục, lớp công việc chỉ là phép chiếu (luật 19)");
  const cau = boChuThich(nguon("lib/queries/return-dispositions.ts"));
  assert.ok(!/'RECEIVED'/.test(cau), "đối tượng kết cục KHÔNG bao giờ đọc kiện chờ đếm (việc của RETURN_INSPECTION)");

  console.log("✓ Company OS · kết cục hàng hoàn (thuần): hằng số khớp CHECK · gập sổ ổn định · nhập lại chỉ sau sửa · huỷ bắt buộc lý do · append-only · một đường lập phiếu · không báo cáo lợi nhuận nào đọc giá trị huỷ");
}

async function donDep(db: Db) {
  const insIds = (await db.select({ id: schema.returnInspections.id }).from(schema.returnInspections).where(like(schema.returnInspections.shipmentId, `${P}%`))).map((r) => r.id);
  if (insIds.length) {
    await db.delete(schema.domainEvents).where(and(eq(schema.domainEvents.name, "return.disposition_set"), inArray(schema.domainEvents.subjectId, insIds)));
    const receipts = (await db.select({ id: schema.returnDispositions.stockReceiptId }).from(schema.returnDispositions).where(inArray(schema.returnDispositions.inspectionId, insIds))).map((r) => r.id).filter((x): x is string => Boolean(x));
    await db.delete(schema.returnDispositions).where(inArray(schema.returnDispositions.inspectionId, insIds));
    if (receipts.length) await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  }
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function demPhieuKho(db: Db) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceiptItems).where(like(schema.stockReceiptItems.shipmentId, `${P}%`));
  return Number(r?.n ?? 0);
}

async function demSuKien(db: Db, inspectionId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.domainEvents).where(and(eq(schema.domainEvents.name, "return.disposition_set"), eq(schema.domainEvents.subjectId, inspectionId)));
  return Number(r?.n ?? 0);
}

export async function testCompanyOsReturnsDb(db: Db) {
  await donDep(db);
  try {
    // ═══ Gieo dữ liệu (mốc cố định) ═══
    const U = `${P}u1`;
    await db.insert(schema.users).values({ id: U, email: `${P}kho@t.local`, name: "Kho kiểm thử E", role: "CS", passwordHash: "x", active: true });
    const actor = { id: U, label: "Kho kiểm thử E" };
    await db.insert(schema.products).values([
      { id: `${P}prod`, name: "Áo kiểm E", customId: "COSE1" },
      { id: `${P}prod2`, name: "Mẫu chưa có hàng hoàn", customId: "COSE2" },
      { id: `${P}prod3`, name: "Mẫu chỉ có kiện kiểm cả kiện", customId: "COSE3" },
    ]);
    await db.insert(schema.productVariants).values([
      { id: `${P}v1`, productId: `${P}prod`, sku: "COSE1-S", color: "Đen", size: "S", retailPrice: 300_000 },
      { id: `${P}v2`, productId: `${P}prod`, sku: "COSE1-M", color: "Đen", size: "M", retailPrice: 300_000 },
      { id: `${P}v3`, productId: `${P}prod3`, sku: "COSE3-S", color: "Trắng", size: "S", retailPrice: 300_000 },
    ]);
    await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSE1", name: "Áo kiểm E", productId: `${P}prod`, registeredBy: "USER" });
    // Giá vốn có chứng từ: phiếu NHẬP gần nhất 120.000đ/món cho v1.
    await db.insert(schema.stockReceipts).values({ id: `${P}rc`, kind: "RECEIPT", receivedAt: DAY0, reference: `${P}rc`, totalQuantity: 10, totalCost: 1_200_000, createdBy: "test" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}rc-i`, receiptId: `${P}rc`, variantId: `${P}v1`, quantity: 10, unitCost: 120_000 });

    await db.insert(schema.orders).values([
      { id: `${P}o1`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
      { id: `${P}o2`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
      { id: `${P}o3`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
    ]);
    await db.insert(schema.orderItems).values([
      { id: `${P}oi1`, orderId: `${P}o1`, variantId: `${P}v1`, productId: `${P}prod`, productName: "Áo kiểm E", sku: "COSE1-S", quantity: 3, unitPrice: 300_000, lineTotal: 900_000 },
      { id: `${P}oi2`, orderId: `${P}o1`, variantId: `${P}v2`, productId: `${P}prod`, productName: "Áo kiểm E", sku: "COSE1-M", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 },
      // Kiện s2 (sẽ được đếm nhanh ở cuối bài) thuộc mẫu 3 — để tóm tắt của mẫu 1 không bị kiện cả kiện làm CHƯA BIẾT.
      { id: `${P}oi3`, orderId: `${P}o2`, variantId: `${P}v3`, productId: `${P}prod3`, productName: "Mẫu 3", sku: "COSE3-S", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 },
      { id: `${P}oi4`, orderId: `${P}o3`, variantId: `${P}v3`, productId: `${P}prod3`, productName: "Mẫu 3", sku: "COSE3-S", quantity: 2, unitPrice: 300_000, lineTotal: 600_000 },
    ]);
    await db.insert(schema.shipments).values([
      { id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: "COSE001", stage: "RETURNED", returnedAt: DAY0 },
      { id: `${P}s2`, orderId: `${P}o2`, vtpOrderNumber: "COSE002", stage: "RETURNED", returnedAt: DAY0 },
      { id: `${P}s3`, orderId: `${P}o3`, vtpOrderNumber: "COSE003", stage: "RETURNED", returnedAt: DAY0 },
      { id: `${P}s4`, orderId: `${P}o3`, vtpOrderNumber: "COSE004", stage: "RETURNED", returnedAt: DAY0 },
    ]);
    const kiem = { status: "INSPECTED", receivedAt: DAY0, receivedBy: "kho", inspectedAt: DAY0, inspectedBy: "kho" };
    await db.insert(schema.returnInspections).values([
      // s1: kiểm TỪNG MÓN — 2 cái S hỏng, 1 cái M đủ, 1 dòng thiếu (đếm 0).
      { id: `${P}ins1`, shipmentId: `${P}s1`, orderId: `${P}o1`, condition: "DAMAGED", restockQty: 1, unsellableQty: 2, note: "COSE1-S: Hỏng", ...kiem },
      // s2: kiện ĐÃ VỀ, CHỜ ĐẾM — việc của RETURN_INSPECTION, không phải đối tượng kết cục.
      // `unsellable_qty` khác 0 là CỐ Ý: dù một dòng chờ đếm có mang số ấy, nó vẫn không phải đối tượng kết cục.
      { id: `${P}ins2`, shipmentId: `${P}s2`, orderId: `${P}o2`, status: "RECEIVED", receivedAt: DAY0, receivedBy: "kho", unsellableQty: 1 },
      // s3: kiểm CẢ KIỆN, 2 món hỏng, không dòng từng món.
      { id: `${P}ins3`, shipmentId: `${P}s3`, orderId: `${P}o3`, condition: "DAMAGED", restockQty: 0, unsellableQty: 2, note: "ướt mốc", ...kiem },
      // s4: "Thiếu hàng" cả kiện — con số không bán được là hàng KHÔNG có mặt.
      { id: `${P}ins4`, shipmentId: `${P}s4`, orderId: `${P}o3`, condition: "MISSING", restockQty: 0, unsellableQty: 1, note: "kiện rỗng", ...kiem },
    ]);
    const mon = { inspectionId: `${P}ins1`, shipmentId: `${P}s1`, inspectedBy: "kho", inspectedAt: DAY0 };
    await db.insert(schema.returnInspectionItems).values([
      { id: `${P}ii1`, expectedVariantId: `${P}v1`, expectedSku: "COSE1-S", expectedQty: 3, actualVariantId: `${P}v1`, actualSku: "COSE1-S", actualQty: 2, condition: "DAMAGED", note: "rách nách", ...mon },
      { id: `${P}ii2`, expectedVariantId: `${P}v2`, expectedSku: "COSE1-M", expectedQty: 1, actualVariantId: `${P}v2`, actualSku: "COSE1-M", actualQty: 1, condition: "OK", note: "", ...mon },
      { id: `${P}ii3`, expectedVariantId: `${P}v1`, expectedSku: "COSE1-S", expectedQty: 1, actualVariantId: `${P}v1`, actualSku: "COSE1-S", actualQty: 0, condition: "SHORT", note: "thiếu 1", ...mon },
    ]);
    clearMemo();

    const I1 = `item:${P}ii1`;
    const K3 = `parcel:${P}ins3`;

    // ═══ 4. Chỉ đúng đối tượng ═══
    const q0 = await listDispositionQueue();
    const cua = q0.rows.filter((r) => r.shipmentId.startsWith(P));
    assert.deepEqual(cua.map((r) => r.subjectKey).sort(), [I1, K3].sort(), "đối tượng = món hỏng có hàng thật + phần hỏng của kiện kiểm cả kiện; KHÔNG món đủ / món đếm 0 / kiện chờ đếm / kiện thiếu cả kiện");
    assert.ok(q0.summary.excludedMissingParcels >= 1, "kiện 'Thiếu hàng' cả kiện bị loại thì phải ĐẾM ra, không biến mất");
    const r1 = cua.find((r) => r.subjectKey === I1)!;
    assert.equal(r1.qty, 2);
    assert.equal(r1.unitCost, 120_000, "giá vốn ước tính theo phiếu nhập gần nhất");
    assert.equal(r1.costBasis, "RECEIPT");
    assert.equal(r1.folded.state, "PENDING_DECISION", "không backfill: món cũ hiện là CHƯA QUYẾT");
    const r3 = cua.find((r) => r.subjectKey === K3)!;
    assert.equal(r3.unitCost, null, "kiện kiểm cả kiện không biết mẫu mã ⇒ giá vốn CHƯA BIẾT, không phải 0");
    assert.deepEqual(r3.expectedVariants.map((v) => v.variantId), [`${P}v3`], "kiện cả kiện đưa danh sách mẫu mã kỳ vọng để NGƯỜI chọn");

    const g = congGia({});
    for (const [khoa, ly] of [[`item:${P}ii2`, "món Đủ"], [`item:${P}ii3`, "món đếm 0"], [`parcel:${P}ins2`, "kiện chờ đếm"], [`parcel:${P}ins4`, "kiện thiếu cả kiện"], [`parcel:${P}ins1`, "kiện đã có dòng từng món"]] as const) {
      const r = await setReturnDispositionCore(db, { subjectKey: khoa, disposition: "REWORK", qty: null, note: "", actor, gate: g.gate });
      assert.ok("error" in r, `${ly} KHÔNG phải đối tượng kết cục`);
    }
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: I1, disposition: "REWORK", qty: null, note: "", actor: { id: "", label: "ai đó" }, gate: g.gate })), "thiếu khoá tài khoản ⇒ từ chối (luật 34)");

    // ═══ 7a. Tóm tắt theo mẫu TRƯỚC mọi quyết định ═══
    clearMemo();
    const m0 = await getModelReturnDispositions(`${P}prod`);
    assert.equal(m0.pendingQty, 2, "2 món hỏng chưa quyết");
    assert.equal(m0.openSubjects, 1);
    assert.equal(m0.writeOffValueEstimate, 0, "chưa huỷ gì ⇒ 0 THẬT");
    const m2 = await getModelReturnDispositions(`${P}prod2`);
    assert.equal(m2.pendingQty, 0, "mẫu không có hàng hoàn nào ⇒ 0 thật, không phải null");
    assert.equal(m2.writtenOffQty, 0);
    const m3 = await getModelReturnDispositions(`${P}prod3`);
    assert.equal(m3.pendingQty, null, "mẫu nằm trong kiện kiểm cả kiện ⇒ CHƯA BIẾT (không chia hộ)");
    assert.equal(m3.writeOffValueEstimate, null);
    assert.equal(m3.basis.parcelLevelSubjects, 1, "kiện 'Thiếu hàng' cả kiện không tính — chỉ kiện có hàng hỏng thật");

    const tonTruoc = await getModelStockStates(`${P}prod`);
    assert.equal(tonTruoc.variants.find((x) => x.variantId === `${P}v1`)!.damaged, 2, "chưa có kết cục ⇒ hỏng chờ = cả 2 món");

    // ═══ 2. Nhập lại sau sửa ═══
    const phieu0 = await demPhieuKho(db);
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: I1, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "", actor, gate: g.gate })), "chưa qua sửa ⇒ KHÔNG nhập lại");
    assert.equal(await demPhieuKho(db), phieu0, "lượt bị từ chối không để lại phiếu kho");

    const sua = await setReturnDispositionCore(db, { subjectKey: I1, disposition: "REWORK", qty: null, note: "giặt lại", actor, gate: g.gate });
    assert.ok("ok" in sua && sua.receiptId === null, "đưa đi sửa KHÔNG lập phiếu kho");
    clearMemo();
    assert.equal((await getModelStockStates(`${P}prod`)).variants.find((x) => x.variantId === `${P}v1`)!.damaged, 2, "ĐANG SỬA chưa phải kết cục — hàng vẫn là hỏng chờ xử lý, không được trừ");
    assert.equal(await demPhieuKho(db), phieu0);
    const [ev] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, `return.disposition_set:${"ok" in sua ? sua.dispositionId : ""}`));
    assert.ok(ev, "mỗi dòng sổ phát return.disposition_set");
    assert.equal(ev.modelId, `${P}m1`, "sự kiện mang mẫu lần ra qua product_models");
    assert.equal(ev.actorKind, "USER");
    assert.equal(ev.actorId, U);
    assert.equal(ev.subjectType, "return_inspection");

    const KEY = `${P}req-restock-1`;
    const nhap = await setReturnDispositionCore(db, { subjectKey: I1, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "giặt sạch 1 cái", requestKey: KEY, actor, gate: g.gate });
    assert.ok("ok" in nhap && nhap.receiptId && !nhap.replayed, "nhập lại sau sửa phải lập phiếu tái nhập");
    const rid = "ok" in nhap ? nhap.receiptId! : "";
    const [hdr] = await db.select().from(schema.stockReceipts).where(eq(schema.stockReceipts.id, rid));
    assert.equal(hdr.kind, "RETURN", "phiếu nhập lại là phiếu TÁI NHẬP (RETURN)");
    const dong = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, rid));
    assert.deepEqual(dong.map((d) => [d.variantId, d.quantity, d.shipmentId]), [[`${P}v1`, 1, `${P}s1`]], "đúng MỘT dòng: đúng mẫu mã thực nhận, đúng SỐ ĐẾM, mang mã vận đơn");
    const lap = await setReturnDispositionCore(db, { subjectKey: I1, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "giặt sạch 1 cái", requestKey: KEY, actor, gate: g.gate });
    assert.ok("ok" in lap && lap.replayed && lap.receiptId === rid, "gửi lại cùng khoá ⇒ trả lại dòng cũ");
    assert.equal(await demPhieuKho(db), phieu0 + 1, "gửi lại KHÔNG nhân đôi phiếu");
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: I1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "", requestKey: `${P}req-restock-2`, actor, gate: g.gate })), "chỉ còn 1 món ⇒ không nhập 2");

    // ═══ 3. Huỷ bỏ ═══
    const phieu1 = await demPhieuKho(db);
    const g2 = congGia({ INVENTORY_WRITE_OFF: true });
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: I1, disposition: "WRITE_OFF", qty: 1, note: "", actor, gate: g2.gate })), "huỷ thiếu lý do ⇒ từ chối");
    assert.equal(g2.calls.length, 0, "thao tác đằng nào cũng hỏng thì KHÔNG gửi yêu cầu duyệt");
    const huy = await setReturnDispositionCore(db, { subjectKey: I1, disposition: "WRITE_OFF", qty: 1, note: "rách to, không vá được", actor, gate: g2.gate });
    assert.ok("ok" in huy && huy.receiptId === null, "huỷ bỏ KHÔNG lập phiếu kho");
    assert.equal(g2.calls.length, 1, "huỷ bỏ phải đi qua cổng duyệt");
    assert.equal(g2.calls[0].group, "INVENTORY_WRITE_OFF");
    assert.equal(g2.calls[0].amount, 120_000, "số tiền hỏi cổng = giá trị ước tính");
    assert.equal(await demPhieuKho(db), phieu1, "huỷ bỏ KHÔNG ghi dòng sổ kho nào (hàng chưa từng vào lại tồn)");
    const [dongHuy] = await db.select().from(schema.returnDispositions).where(eq(schema.returnDispositions.id, "ok" in huy ? huy.dispositionId : ""));
    assert.equal(dongHuy.valueEstimate, 120_000);
    assert.equal(dongHuy.costBasis, "RECEIPT");
    assert.equal(dongHuy.actorUserId, U);

    // Giá CHƯA BIẾT + cưỡng chế bật ⇒ phải chờ người thứ hai, KHÔNG ghi gì.
    await setReturnDispositionCore(db, { subjectKey: K3, disposition: "REWORK", qty: null, note: "", actor, gate: g.gate });
    const truocCho = (await db.select({ id: schema.returnDispositions.id }).from(schema.returnDispositions).where(eq(schema.returnDispositions.subjectKey, K3))).length;
    const g3 = congGia({ INVENTORY_WRITE_OFF: true });
    const cho = await setReturnDispositionCore(db, { subjectKey: K3, disposition: "WRITE_OFF", qty: 1, note: "mốc toàn thân", actor, gate: g3.gate });
    assert.ok("error" in cho && cho.approval === "NEEDS_APPROVAL", "chưa biết giá vốn ⇒ coi như vượt ngưỡng ⇒ chờ duyệt");
    assert.equal(g3.calls[0].amount, null, "giá chưa biết gửi cổng là null, không phải 0");
    assert.equal((await db.select({ id: schema.returnDispositions.id }).from(schema.returnDispositions).where(eq(schema.returnDispositions.subjectKey, K3))).length, truocCho, "chờ duyệt ⇒ không ghi dòng nào");

    // Kiện cả kiện: mẫu mã phải nằm trong hàng kỳ vọng; một mẫu duy nhất thì lấy luôn.
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: K3, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "", variantId: `${P}v1`, actor, gate: g.gate })), "mẫu mã ngoài hàng kỳ vọng của kiện ⇒ từ chối");
    const nhap3 = await setReturnDispositionCore(db, { subjectKey: K3, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "phơi khô", actor, gate: g.gate });
    assert.ok("ok" in nhap3 && nhap3.receiptId, "kiện một mẫu mã ⇒ nhập lại vào đúng mẫu ấy");
    const [d3] = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, "ok" in nhap3 ? nhap3.receiptId! : ""));
    assert.equal(d3.variantId, `${P}v3`);

    // ═══ 5. Sự kiện: đúng một cho mỗi dòng sổ ═══
    const soDong1 = (await db.select({ id: schema.returnDispositions.id }).from(schema.returnDispositions).where(eq(schema.returnDispositions.inspectionId, `${P}ins1`))).length;
    assert.equal(soDong1, 3, "ins1: đang sửa · nhập lại · huỷ — lượt gửi lại KHÔNG thêm dòng");
    assert.equal(await demSuKien(db, `${P}ins1`), soDong1, "mỗi dòng sổ đúng MỘT sự kiện (lượt gửi lại không phát lần hai)");

    // ═══ 6. Nguồn việc ═══
    clearMemo();
    const viec = (await adaptReturnDispositions(DAY0)).filter((w) => w.sourceKey.includes(P));
    assert.deepEqual(viec.map((w) => w.sourceKey), [K3], "món đã có kết cục cuối cho toàn bộ rời hàng đợi; kiện còn 1 món vẫn ở lại");
    assert.equal(viec[0].kind, "REWORK");
    assert.equal(viec[0].money.confidence, "UNKNOWN", "giá chưa biết ⇒ tiền CHƯA BIẾT trên hàng đợi");
    // Kiện chờ đếm được đếm xong bằng đường đếm nhanh (đúng đường của trạm kiểm) ⇒ lúc ấy mới thành đối tượng.
    assert.ok(!viec.some((w) => w.sourceKey === `parcel:${P}ins2`), "kiện CHỜ ĐẾM không bao giờ là việc của nguồn kết cục");
    const dem = await recordInspection({ shipmentId: `${P}s2`, condition: "DAMAGED", restockQty: 0, unsellableQty: 1, note: "thủng túi, bẩn", actor });
    assert.ok("ok" in dem);
    clearMemo();
    const viec2 = (await adaptReturnDispositions(DAY0)).filter((w) => w.sourceKey.includes(P));
    assert.ok(viec2.some((w) => w.sourceKey === `parcel:${P}ins2`), "kiện vừa kiểm HỎNG ở đường đếm nhanh phải vào hàng đợi kết cục (đường bấm có thật)");
    const tatCa = await collectWorkItems({ now: DAY0, sources: ["RETURN_DISPOSITION", "RETURN_INSPECTION"] });
    const khoa = tatCa.items.map((w) => w.key);
    assert.equal(new Set(khoa).size, khoa.length, "không khoá trùng giữa hai nguồn hàng hoàn");
    const insOfDisp = tatCa.items.filter((w) => w.sourceType === "RETURN_DISPOSITION").map((w) => parseSubjectKey(w.sourceKey)!);
    const trangThai = await db
      .select({ status: schema.returnInspections.status })
      .from(schema.returnInspections)
      .innerJoin(schema.returnInspectionItems, eq(schema.returnInspectionItems.inspectionId, schema.returnInspections.id))
      .where(inArray(schema.returnInspectionItems.id, insOfDisp.filter((k) => k.grain === "ITEM").map((k) => k.id).concat(["-"])));
    assert.ok(trangThai.every((t) => t.status === "INSPECTED"), "mọi việc kết cục trỏ về kiện ĐÃ KIỂM");
    assert.ok(insOfDisp.filter((k) => k.grain === "PARCEL").length >= 2);

    // ═══ 8. Phiếu nhập lại sau sửa KHÔNG xoá được — chặn có thông điệp, không nhật ký, không lỗi CSDL ═══
    const demNhatKy = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.entityId, rid)))[0]?.n ?? 0);
    const nkTruoc = await demNhatKy();
    const gXoa = congGia({});
    const xoa = await deleteStockReceiptCore(db, { id: rid, reason: "lập nhầm phiếu sửa", actor, actorEmail: `${P}kho@t.local`, gate: gXoa.gate });
    assert.ok("error" in xoa, "phiếu nhập lại sau sửa phải bị CHẶN, không xoá được");
    assert.ok("error" in xoa && xoa.blocker?.reworkRestocks.length === 1, "chặn bằng vế riêng của sổ kết cục (không phải lỗi khoá ngoại)");
    assert.ok("error" in xoa && /NHẬP LẠI SAU SỬA/.test(xoa.error) && !/violat|foreign key|constraint/i.test(xoa.error), "thông điệp tiếng Việt nói rõ lượt nhập lại sau sửa");
    assert.equal(gXoa.calls.length, 0, "chặn TRƯỚC cổng duyệt — không gửi yêu cầu duyệt cho lượt xoá không thể xảy ra");
    assert.equal(await demNhatKy(), nkTruoc, "lượt xoá bị chặn KHÔNG để lại dòng nhật ký nào");
    assert.ok((await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, rid))).length === 1, "phiếu còn nguyên");

    // ═══ 9. Tồn theo mẫu: hỏng CÒN CHỜ = hỏng đã kiểm − phần có kết cục cuối ═══
    clearMemo();
    const ton = await getModelStockStates(`${P}prod`);
    const v1 = ton.variants.find((x) => x.variantId === `${P}v1`)!;
    assert.equal(v1.damaged, 0, "2 món hỏng: 1 nhập lại sau sửa + 1 huỷ ⇒ không còn món hỏng nào chờ (không đếm hai lần với tồn thực tế)");
    assert.deepEqual([...ton.basis.damagedMinusDispositions].sort(), [...TERMINAL_DISPOSITIONS].sort(), "basis khai rõ những kết cục đã trừ");
    assert.equal(ton.variants.find((x) => x.variantId === `${P}v2`)!.damaged, 0, "mẫu mã có dòng kiểm nhưng không hỏng ⇒ 0 thật");

    // ═══ 7b. Tóm tắt sau quyết định ═══
    clearMemo();
    const m1 = await getModelReturnDispositions(`${P}prod`);
    assert.equal(m1.restockedAfterReworkQty, 1);
    assert.equal(m1.writtenOffQty, 1);
    assert.equal(m1.pendingQty, 0, "hết phần mở ⇒ 0 thật");
    assert.equal(m1.openSubjects, 0);
    assert.equal(m1.writeOffValueEstimate, 120_000, "giá trị huỷ = ảnh chụp lúc huỷ");
    assert.equal(m1.decisions.WRITE_OFF, 1);
    const m3b = await getModelReturnDispositions(`${P}prod3`);
    assert.equal(m3b.restockedAfterReworkQty, 1, "nhập lại luôn chính xác (đọc thẳng dòng mang phiếu của đúng mẫu mã), kể cả kiện cả kiện");
    assert.equal(m3b.pendingQty, null);

    console.log("✓ Company OS · kết cục hàng hoàn (CSDL): chỉ món đã kiểm không tái nhập có hàng thật · nhập lại sau sửa đúng một phiếu RETURN, gửi lại không nhân đôi · huỷ không ghi sổ kho, bắt buộc lý do, qua cổng INVENTORY_WRITE_OFF · một sự kiện mỗi dòng · hàng đợi không chiếu trùng · tóm tắt mẫu null ≠ 0");
  } finally {
    await donDep(db);
    clearMemo();
  }
}
