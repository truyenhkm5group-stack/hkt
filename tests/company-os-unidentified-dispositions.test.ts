import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { clearMemo } from "@/lib/cache";
import { APPROVAL_GROUP_REASON, isEnforced, overThreshold, type ApprovalDecision } from "@/lib/constants/approval";
import { DISPOSITION_GRAINS, parseSubjectKey, SUBJECT_KEY_PREFIX, subjectKeyOf } from "@/lib/constants/return-disposition";
import { checkUnidentifiedRestock } from "@/lib/constants/return-unidentified";
import { deleteStockReceiptCore } from "@/lib/inventory/receipt-delete";
import { getModelReturnDispositions } from "@/lib/queries/model-returns";
import { listDispositionQueue, unassignedUnidentifiedDispositions, unidentifiedIdsInLedger } from "@/lib/queries/return-dispositions";
import { adaptReturnDispositions, collectWorkItems } from "@/lib/queries/work-adapters";
import { setReturnDispositionCore, type DispositionGate, type DispositionGateInput } from "@/lib/returns/disposition";
import { restockUnidentifiedReturn, setUnidentifiedCondition, unidentifiedSummary } from "@/lib/returns/unidentified";

/**
 * ═══════════ COMPANY OS · AGENT R — KẾT CỤC CHO HÀNG HOÀN KHÔNG NHÃN ═══════════
 *
 * Khoá tám điều:
 *  1. Mỗi dòng sổ neo ĐÚNG MỘT nơi (phiếu kiểm HOẶC món không nhãn) — CHECK ở CSDL, không chỉ ở mã.
 *  2. Nhập lại sau sửa của món không nhãn đi CÙNG luật quyền + lý do với nút tái nhập của bàn không nhãn
 *     (`checkUnidentifiedRestock`): chưa nối đơn ⇒ cần `inventory:restock-unidentified` VÀ lý do.
 *  3. …và CÙNG đường lập phiếu (`writeUnidentifiedRestockReceipt`): đúng MỘT phiếu RETURN, đúng số đếm;
 *     gửi lại không nhân đôi; hai đường vào tồn (nguyên món / sau sửa) không mở cùng lúc cho một món.
 *  4. Huỷ bỏ không ghi sổ kho, qua cổng `INVENTORY_WRITE_OFF`; giá chưa biết ⇒ `null`, không phải 0.
 *  5. `return.disposition_set`: `model_id` chỉ khi món có mẫu mã KHO NHẬN DIỆN; chưa nhận diện ⇒ `null`,
 *     kể cả khi đơn đã nối chỉ có đúng một mẫu mã (đó là ĐOÁN — luật 35).
 *  6. Hàng đợi hiện CẢ HAI loại, nhãn "không nhãn" đọc được; nguồn việc chiếu không trùng khoá.
 *  7. Phiếu nhập lại sau sửa của món không nhãn KHÔNG xoá được (chặn trước cổng, trước nhật ký).
 *  8. Tóm tắt theo mẫu chỉ nhận món đã nhận diện mẫu mã; phần chưa gán đứng ở con số cấp shop.
 *
 * Không phụ thuộc đồng hồ (luật 50, 65): mọi mốc là ngày cố định; không khẳng định nào lọc theo "N ngày
 * trước". Con số toàn cục (tóm tắt bàn không nhãn) đo bằng HIỆU trước/sau, không bằng giá trị tuyệt đối.
 */

const P = "cosr-";
const DAY0 = new Date("2026-03-09T03:00:00Z");

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

/** Lỗi CSDL bọc trong DrizzleQueryError: tên ràng buộc nằm ở `cause`. So khớp cả hai tầng. */
function viPham(re: RegExp) {
  return (err: unknown) => {
    const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : "";
    return re.test(`${err instanceof Error ? err.message : String(err)} ${cause}`);
  };
}

const boChuThich = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

export function testCompanyOsUnidentifiedDispositionsPure() {
  // ───────── Khoá đối tượng: ba độ mịn, khớp CHECK của migration ─────────
  const mig = readFileSync("drizzle/0142_company_os_unidentified_dispositions.sql", "utf8");
  for (const g of DISPOSITION_GRAINS) {
    assert.deepEqual(parseSubjectKey(subjectKeyOf(g, "x1")), { grain: g, id: "x1" }, `khoá ${g} phải đi hai chiều`);
    assert.ok(mig.includes(`'${SUBJECT_KEY_PREFIX[g]}:'`), `CHECK subject của 0142 thiếu tiền tố ${SUBJECT_KEY_PREFIX[g]}`);
  }
  assert.ok(/CHECK \(num_nonnulls\("inspection_id", "unidentified_id"\) = 1\)/.test(mig), "0142 phải buộc ĐÚNG MỘT neo ở CSDL");
  assert.ok(/ALTER COLUMN "inspection_id" DROP NOT NULL/.test(mig));
  assert.ok(/ON DELETE restrict/.test(mig), "xoá món không nhãn là xoá chứng từ của quyết định ⇒ RESTRICT");
  assert.ok(!/\b(INSERT INTO|UPDATE\s+"?return_)/i.test(mig), "0142 không gieo / sửa dòng nào (mục 8.8, 35)");
  const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as { entries: { tag: string; when: number }[] };
  const e142 = journal.entries.find((e) => e.tag === "0142_company_os_unidentified_dispositions");
  assert.ok(e142 && e142.when === 1790006362491, "sổ migration phải có 0142 đúng mốc Tech Lead cấp");

  // ───────── Một luật tái nhập hàng không nhãn (bảng chân lý) ─────────
  assert.deepEqual(checkUnidentifiedRestock({ status: "IDENTIFIED", reason: "", canOverride: false }), { ok: true, authority: "IDENTIFIED", reason: "" }, "đã nối đơn ⇒ hàng hoàn bình thường");
  for (const status of ["PENDING_IDENTIFICATION", "UNIDENTIFIABLE", ""]) {
    const r1 = checkUnidentifiedRestock({ status, reason: "có lý do", canOverride: false });
    assert.ok("error" in r1 && r1.code === "NEEDS_PERMISSION", `${status || "(rỗng)"}: không có quyền ⇒ từ chối, kể cả khi có lý do`);
    const r2 = checkUnidentifiedRestock({ status, reason: "   ", canOverride: true });
    assert.ok("error" in r2 && r2.code === "NEEDS_REASON", `${status || "(rỗng)"}: có quyền mà thiếu lý do ⇒ từ chối`);
    assert.deepEqual(checkUnidentifiedRestock({ status, reason: " mất nhãn ", canOverride: true }), { ok: true, authority: "MANAGER_OVERRIDE", reason: "mất nhãn" });
  }

  // ───────── Quét mã nguồn: một luật, một đường lập phiếu ─────────
  const act = boChuThich(readFileSync("lib/actions/returns-unidentified.ts", "utf8"));
  assert.ok(/checkUnidentifiedRestock\(/.test(act) && !/row\.status !== "IDENTIFIED"/.test(act), "nút tái nhập của bàn không nhãn phải dùng CHÍNH hàm luật chung, không tự viết lại điều kiện");
  const dv = boChuThich(readFileSync("lib/returns/disposition.ts", "utf8"));
  assert.equal((dv.match(/checkUnidentifiedRestock\(/g) ?? []).length, 2, "lõi kết cục hỏi luật tái nhập hàng không nhãn HAI lần: trước giao dịch và TRONG khoá");
  assert.equal((dv.match(/writeUnidentifiedRestockReceipt\(/g) ?? []).length, 1, "đúng MỘT lời gọi đường lập phiếu của bàn không nhãn");
  assert.ok(!/insert\(\s*schema\.stockReceipt/.test(dv), "lõi kết cục KHÔNG tự lập phiếu kho");
  const uni = boChuThich(readFileSync("lib/returns/unidentified.ts", "utf8"));
  assert.equal((uni.match(/insert\(\s*schema\.stockReceipts\s*\)/g) ?? []).length, 1, "bàn không nhãn chỉ có MỘT chỗ chèn phiếu kho (writeUnidentifiedRestockReceipt)");
  const ra = boChuThich(readFileSync("lib/actions/return-dispositions.ts", "utf8"));
  assert.ok(/canRestockUnidentified:\s*can\(user, RESTOCK_UNIDENTIFIED_PERMISSION\)/.test(ra), "action phải đọc quyền tái nhập hàng không nhãn TỪ PHIÊN");

  console.log("✓ Company OS · kết cục hàng không nhãn (thuần): ba độ mịn khớp CHECK · đúng một neo · một luật tái nhập (quyền + lý do) cho hai đường · một đường lập phiếu");
}

async function donDep(db: Db) {
  const uniIds = (await db.select({ id: schema.returnUnidentified.id }).from(schema.returnUnidentified).where(like(schema.returnUnidentified.id, `${P}%`))).map((r) => r.id);
  const insIds = (await db.select({ id: schema.returnInspections.id }).from(schema.returnInspections).where(like(schema.returnInspections.id, `${P}%`))).map((r) => r.id);
  await db.delete(schema.domainEvents).where(and(eq(schema.domainEvents.name, "return.disposition_set"), like(schema.domainEvents.subjectId, `%${P}%`)));
  const rd = schema.returnDispositions;
  const anchor = [...(uniIds.length ? [inArray(rd.unidentifiedId, uniIds)] : []), ...(insIds.length ? [inArray(rd.inspectionId, insIds)] : [])];
  const receipts: string[] = [];
  for (const cond of anchor) {
    receipts.push(...(await db.select({ id: rd.stockReceiptId }).from(rd).where(cond)).map((r) => r.id).filter((x): x is string => Boolean(x)));
    await db.delete(rd).where(cond);
  }
  if (uniIds.length) {
    receipts.push(...(await db.select({ id: schema.returnUnidentified.stockReceiptId }).from(schema.returnUnidentified).where(inArray(schema.returnUnidentified.id, uniIds))).map((r) => r.id).filter((x): x is string => Boolean(x)));
    await db.delete(schema.returnUnidentified).where(inArray(schema.returnUnidentified.id, uniIds));
  }
  if (receipts.length) await db.delete(schema.stockReceipts).where(inArray(schema.stockReceipts.id, receipts));
  await db.delete(schema.stockReceipts).where(like(schema.stockReceipts.id, `${P}%`));
  await db.delete(schema.returnInspectionItems).where(like(schema.returnInspectionItems.id, `${P}%`));
  await db.delete(schema.returnInspections).where(like(schema.returnInspections.id, `${P}%`));
  await db.delete(schema.shipments).where(like(schema.shipments.id, `${P}%`));
  await db.delete(schema.orders).where(like(schema.orders.id, `${P}%`));
  await db.delete(schema.productModels).where(like(schema.productModels.id, `${P}%`));
  await db.delete(schema.products).where(like(schema.products.id, `${P}%`));
  await db.delete(schema.users).where(like(schema.users.id, `${P}%`));
}

async function demPhieuRework(db: Db) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.stockReceipts).where(like(schema.stockReceipts.reference, "%UR-COSR-%"));
  return Number(r?.n ?? 0);
}

async function suKienCua(db: Db, dispositionId: string) {
  const [ev] = await db.select().from(schema.domainEvents).where(eq(schema.domainEvents.dedupeKey, `return.disposition_set:${dispositionId}`));
  return ev ?? null;
}

export async function testCompanyOsUnidentifiedDispositionsDb(db: Db) {
  await donDep(db);
  try {
    // ═══ Gieo dữ liệu (mốc cố định) ═══
    const U = `${P}u1`;
    await db.insert(schema.users).values({ id: U, email: `${P}kho@t.local`, name: "Kho kiểm thử R", role: "CS", passwordHash: "x", active: true });
    const actor = { id: U, label: "Kho kiểm thử R" };
    await db.insert(schema.products).values({ id: `${P}prod`, name: "Áo kiểm R", customId: "COSR1" });
    await db.insert(schema.productVariants).values({ id: `${P}v1`, productId: `${P}prod`, sku: "COSR1-S", color: "Đen", size: "S", retailPrice: 300_000 });
    await db.insert(schema.productModels).values({ id: `${P}m1`, code: "COSR1", name: "Áo kiểm R", productId: `${P}prod`, registeredBy: "USER" });
    await db.insert(schema.stockReceipts).values({ id: `${P}rc`, kind: "RECEIPT", receivedAt: DAY0, reference: `${P}rc`, totalQuantity: 10, totalCost: 1_200_000, createdBy: "test" });
    await db.insert(schema.stockReceiptItems).values({ id: `${P}rc-i`, receiptId: `${P}rc`, variantId: `${P}v1`, quantity: 10, unitCost: 120_000 });
    await db.insert(schema.orders).values([
      { id: `${P}o1`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
      { id: `${P}o2`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
      { id: `${P}o3`, stage: "CANCELLED", status: 6, insertedAt: DAY0 },
    ]);
    // Đơn o3 chỉ có ĐÚNG MỘT mẫu mã (v1) — một bộ "đoán" sẽ lấy luôn mẫu này cho món không nhãn nối vào o3.
    await db.insert(schema.orderItems).values([
      { id: `${P}oi1`, orderId: `${P}o1`, variantId: `${P}v1`, productId: `${P}prod`, productName: "Áo kiểm R", sku: "COSR1-S", quantity: 2, unitPrice: 300_000, lineTotal: 600_000 },
      { id: `${P}oi2`, orderId: `${P}o2`, variantId: `${P}v1`, productId: `${P}prod`, productName: "Áo kiểm R", sku: "COSR1-S", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 },
      { id: `${P}oi3`, orderId: `${P}o3`, variantId: `${P}v1`, productId: `${P}prod`, productName: "Áo kiểm R", sku: "COSR1-S", quantity: 1, unitPrice: 300_000, lineTotal: 300_000 },
    ]);
    await db.insert(schema.shipments).values([
      { id: `${P}s1`, orderId: `${P}o1`, vtpOrderNumber: "COSR001", stage: "RETURNED", returnedAt: DAY0 },
      { id: `${P}s2`, orderId: `${P}o2`, vtpOrderNumber: "COSR002", stage: "RETURNED", returnedAt: DAY0 },
      { id: `${P}s3`, orderId: `${P}o3`, vtpOrderNumber: "COSR003", stage: "RETURNED", returnedAt: DAY0 },
    ]);
    // Kiện CÓ mã, kiểm từng món: 1 món hỏng — để hàng đợi có CẢ HAI loại.
    await db.insert(schema.returnInspections).values({ id: `${P}ins2`, shipmentId: `${P}s2`, orderId: `${P}o2`, status: "INSPECTED", condition: "DAMAGED", restockQty: 0, unsellableQty: 1, note: "COSR1-S: Hỏng", receivedAt: DAY0, receivedBy: "kho", inspectedAt: DAY0, inspectedBy: "kho" });
    await db.insert(schema.returnInspectionItems).values({ id: `${P}ii2`, inspectionId: `${P}ins2`, shipmentId: `${P}s2`, expectedVariantId: `${P}v1`, expectedSku: "COSR1-S", expectedQty: 1, actualVariantId: `${P}v1`, actualSku: "COSR1-S", actualQty: 1, condition: "DAMAGED", note: "rách", inspectedBy: "kho", inspectedAt: DAY0 });

    const moc = { receivedAt: DAY0, receivedBy: "kho", source: "NO_TRACKING_LABEL" };
    const tongTruoc = await unidentifiedSummary();
    await db.insert(schema.returnUnidentified).values([
      // ur1: KHÔNG lần ra đơn, kho nhận diện mẫu v1, 3 món hỏng.
      { id: `${P}ur1`, code: "UR-COSR-1", status: "UNIDENTIFIABLE", unidentifiableReason: "tra SĐT không ra", variantId: `${P}v1`, sku: "COSR1-S", quantity: 3, condition: "DAMAGED", note: "rách vai", ...moc },
      // ur2: ĐÃ nối vận đơn s1, 2 món bẩn.
      { id: `${P}ur2`, code: "UR-COSR-2", status: "IDENTIFIED", identificationMethod: "MANUAL_MATCH", identifiedAt: DAY0, identifiedBy: "kho", linkedOrderId: `${P}o1`, linkedShipmentId: `${P}s1`, linkedTrackingNumber: "COSR001", variantId: `${P}v1`, sku: "COSR1-S", quantity: 2, condition: "DIRTY", note: "bẩn", ...moc },
      // ur3: ĐÃ nối vận đơn s3 (đơn chỉ có v1) nhưng kho CHƯA nhận diện mẫu mã — không được đoán là v1.
      { id: `${P}ur3`, code: "UR-COSR-3", status: "IDENTIFIED", identificationMethod: "MANUAL_MATCH", identifiedAt: DAY0, identifiedBy: "kho", linkedOrderId: `${P}o3`, linkedShipmentId: `${P}s3`, linkedTrackingNumber: "COSR003", variantId: null, quantity: 1, condition: "UNSELLABLE", note: "mốc", ...moc },
      // ur4: còn bán được — việc của nút tái nhập nguyên món, không phải của sổ kết cục.
      { id: `${P}ur4`, code: "UR-COSR-4", status: "UNIDENTIFIABLE", unidentifiableReason: "x", variantId: `${P}v1`, sku: "COSR1-S", quantity: 1, condition: "OK", note: "", ...moc },
    ]);
    // ur5: dữ liệu cũ đã vào tồn (có phiếu) — dù kết luận mang chữ "hỏng", món đã ở trong tồn KHÔNG phải đối tượng.
    await db.insert(schema.stockReceipts).values({ id: `${P}rc5`, kind: "RETURN", receivedAt: DAY0, reference: `${P}rc5`, totalQuantity: 1, totalCost: 0, createdBy: "test" });
    await db.insert(schema.returnUnidentified).values({ id: `${P}ur5`, code: "UR-COSR-5", status: "UNIDENTIFIABLE", unidentifiableReason: "cũ", variantId: `${P}v1`, quantity: 1, condition: "DAMAGED", stockReceiptId: `${P}rc5`, restockedAt: DAY0, restockedBy: "kho", restockAuthority: "MANAGER_OVERRIDE", restockReason: "cũ", ...moc });
    clearMemo();
    const K1 = `unidentified:${P}ur1`;
    const K2 = `unidentified:${P}ur2`;
    const K3 = `unidentified:${P}ur3`;
    const KI = `item:${P}ii2`;

    // ═══ 1. Đúng MỘT neo — CHECK ở CSDL ═══
    const chen = (extra: string) => db.execute(sql.raw(`insert into return_dispositions (id, subject_key, disposition, qty, note, actor_user_id, ${extra.split("|")[0]}) values ('${P}x', ${extra.split("|")[1]})`));
    await assert.rejects(chen(`inspection_id, unidentified_id|'unidentified:${P}ur1', 'REWORK', 1, '', '${U}', '${P}ins2', '${P}ur1'`), viPham(/return_dispositions_(anchor|subject)_check/), "cả hai neo ⇒ CSDL chặn");
    await assert.rejects(chen(`request_key|'unidentified:${P}ur1', 'REWORK', 1, '', '${U}', 'k-none'`), viPham(/return_dispositions_(anchor|subject)_check/), "không neo nào ⇒ CSDL chặn");
    await assert.rejects(chen(`unidentified_id|'item:${P}ur1', 'REWORK', 1, '', '${U}', '${P}ur1'`), viPham(/return_dispositions_subject_check/), "khoá đối tượng phải khớp neo không nhãn");
    await assert.rejects(chen(`unidentified_id, stock_receipt_id|'unidentified:${P}ur1', 'RESTOCK_AFTER_REWORK', 1, '', '${U}', '${P}ur1', '${P}rc5'`), viPham(/return_dispositions_restock_authority_check/), "nhập lại món không nhãn phải khai căn cứ");
    await assert.rejects(chen(`inspection_id, inspection_item_id, restock_authority|'item:${P}ii2', 'REWORK', 1, '', '${U}', '${P}ins2', '${P}ii2', 'IDENTIFIED'`), viPham(/return_dispositions_restock_authority_check/), "căn cứ chỉ có ở đúng loại dòng ấy");

    // ═══ 6. Hàng đợi: cả hai loại, đúng đối tượng ═══
    const q0 = await listDispositionQueue();
    const cua = q0.rows.filter((r) => r.subjectKey.includes(P)).map((r) => r.subjectKey).sort();
    assert.deepEqual(cua, [KI, K1, K2, K3].sort(), "hàng đợi = món có mã hỏng + món không nhãn hỏng/bẩn/không bán được; KHÔNG món còn bán được, KHÔNG món đã vào tồn");
    const r1 = q0.rows.find((r) => r.subjectKey === K1)!;
    assert.equal(r1.grain, "UNIDENTIFIED");
    assert.equal(r1.code, "UR-COSR-1", "món không nhãn hiện mã UR-… (thứ viết trên kiện)");
    assert.equal(r1.inspectionId, null);
    assert.equal(r1.shipmentId, null, "chưa nối đơn ⇒ không có vận đơn");
    assert.equal(r1.unitCost, 120_000, "giá vốn ước tính theo phiếu nhập gần nhất của mẫu kho nhận diện");
    assert.equal(q0.rows.find((r) => r.subjectKey === K3)!.unitCost, null, "chưa nhận diện mẫu ⇒ giá vốn CHƯA BIẾT (không lấy mẫu của đơn đã nối)");
    assert.ok(q0.summary.unidentifiedOpenQty >= 6, "tiêu đề khối đếm riêng phần không nhãn");
    const viec = (await adaptReturnDispositions(DAY0)).filter((w) => w.sourceKey.includes(P));
    assert.deepEqual(viec.map((w) => w.sourceKey).sort(), [KI, K1, K2, K3].sort(), "nguồn việc RETURN_DISPOSITION chiếu cả món không nhãn");
    assert.equal(viec.find((w) => w.sourceKey === K1)!.businessEntity, "RETURN_UNIDENTIFIED");
    const tatCa = await collectWorkItems({ now: DAY0, sources: ["RETURN_DISPOSITION", "RETURN_INSPECTION"] });
    const khoa = tatCa.items.map((w) => w.key);
    assert.equal(new Set(khoa).size, khoa.length, "không khoá trùng — món không nhãn không bị chiếu hai lần");
    assert.equal(tatCa.items.filter((w) => w.sourceKey === K1).length, 1);

    // ═══ 2 + 3. Nhập lại sau sửa: cùng quyền + lý do, cùng đường lập phiếu ═══
    const g = congGia({});
    const phieu0 = await demPhieuRework(db);
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "x", canRestockUnidentified: true, actor, gate: g.gate })), "chưa qua sửa ⇒ không nhập lại (cùng máy trạng thái)");
    const sua1 = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "REWORK", qty: null, note: "giặt", actor, gate: g.gate });
    assert.ok("ok" in sua1 && sua1.receiptId === null, "đưa đi sửa KHÔNG lập phiếu");
    const khongQuyen = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "mất nhãn, giặt sạch", actor, gate: g.gate });
    assert.ok("error" in khongQuyen && /Tái nhập hàng hoàn không xác định nguồn/.test(khongQuyen.error), "chưa nối đơn + không có quyền ⇒ từ chối (mặc định rơi về phía HẸP)");
    const khongLyDo = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "  ", canRestockUnidentified: true, actor, gate: g.gate });
    assert.ok("error" in khongLyDo && /bắt buộc ghi lý do/.test(khongLyDo.error), "có quyền mà không lý do ⇒ từ chối");
    assert.equal(await demPhieuRework(db), phieu0, "lượt bị từ chối không để lại phiếu kho");

    const KEY = `${P}req-1`;
    const nhap1 = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "mất nhãn, giặt sạch 2 cái", canRestockUnidentified: true, requestKey: KEY, actor, gate: g.gate });
    assert.ok("ok" in nhap1 && nhap1.receiptId && nhap1.restockAuthority === "MANAGER_OVERRIDE", "có quyền + lý do ⇒ nhập lại, căn cứ KHÔNG chứng từ");
    const rid1 = "ok" in nhap1 ? nhap1.receiptId! : "";
    const [hdr1] = await db.select().from(schema.stockReceipts).where(eq(schema.stockReceipts.id, rid1));
    assert.equal(hdr1.kind, "RETURN");
    assert.equal(hdr1.reference, "Nhập lại sau sửa · Hàng hoàn không mã vận đơn UR-COSR-1", "phiếu lập bằng đường của bàn không nhãn (tham chiếu nói rõ nhập lại sau sửa)");
    assert.ok(hdr1.note.includes("mất nhãn, giặt sạch 2 cái"), "lý do đi vào phiếu");
    const dong1 = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, rid1));
    assert.deepEqual(dong1.map((d) => [d.variantId, d.quantity, d.shipmentId]), [[`${P}v1`, 2, null]], "đúng MỘT dòng: mẫu kho nhận diện, SỐ ĐẾM, không vận đơn 'gần đúng'");
    const lap = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "RESTOCK_AFTER_REWORK", qty: 2, note: "mất nhãn, giặt sạch 2 cái", canRestockUnidentified: true, requestKey: KEY, actor, gate: g.gate });
    assert.ok("ok" in lap && lap.replayed && lap.receiptId === rid1 && lap.restockAuthority === "MANAGER_OVERRIDE", "gửi lại cùng khoá ⇒ trả lại dòng cũ");
    assert.equal(await demPhieuRework(db), phieu0 + 1, "đúng MỘT phiếu RETURN");
    const [dongSo1] = await db.select().from(schema.returnDispositions).where(eq(schema.returnDispositions.id, "ok" in nhap1 ? nhap1.dispositionId : ""));
    assert.equal(dongSo1.unidentifiedId, `${P}ur1`);
    assert.equal(dongSo1.inspectionId, null);
    assert.equal(dongSo1.restockAuthority, "MANAGER_OVERRIDE", "căn cứ ghi trên CHÍNH dòng sổ");
    const [ur1Sau] = await db.select().from(schema.returnUnidentified).where(eq(schema.returnUnidentified.id, `${P}ur1`));
    assert.equal(ur1Sau.stockReceiptId, null, "cột một-phiếu-một-món của bàn không nhãn KHÔNG bị ghi đè bởi lượt nhập lại từng phần");

    // Món đã nối đơn: inventory:write đủ, không cần lý do; dòng phiếu mang vận đơn đã nối.
    await setReturnDispositionCore(db, { subjectKey: K2, disposition: "REWORK", qty: null, note: "", actor, gate: g.gate });
    const nhap2 = await setReturnDispositionCore(db, { subjectKey: K2, disposition: "RESTOCK_AFTER_REWORK", qty: 1, note: "", actor, gate: g.gate });
    assert.ok("ok" in nhap2 && nhap2.receiptId && nhap2.restockAuthority === "IDENTIFIED", "đã nối đơn ⇒ nhập lại như hàng hoàn bình thường");
    const dong2 = await db.select().from(schema.stockReceiptItems).where(eq(schema.stockReceiptItems.receiptId, "ok" in nhap2 ? nhap2.receiptId! : ""));
    assert.deepEqual(dong2.map((d) => [d.variantId, d.quantity, d.shipmentId]), [[`${P}v1`, 1, `${P}s1`]], "dòng phiếu mang vận đơn ĐÃ NỐI");

    // Hai đường vào tồn không mở cùng lúc cho một món.
    const doiKetLuan = await setUnidentifiedCondition({ id: `${P}ur1`, condition: "OK", note: "", actor });
    assert.ok("error" in doiKetLuan && /sổ kết cục/.test(doiKetLuan.error), "món đã vào sổ ⇒ bàn không nhãn KHÔNG cho đổi sang “Đủ” (đường vào tồn thứ hai)");
    // Giả lập một cuộc đua đã lọt (kết luận bị đổi thẳng ở CSDL): nút tái nhập nguyên món vẫn phải từ chối.
    await db.update(schema.returnUnidentified).set({ condition: "OK" }).where(eq(schema.returnUnidentified.id, `${P}ur1`));
    const nguyenMon = await restockUnidentifiedReturn({ id: `${P}ur1`, reason: "mất nhãn", actor });
    assert.ok("error" in nguyenMon && /sổ kết cục/.test(nguyenMon.error), "món có dòng sổ ⇒ tái nhập nguyên món bị chặn dù kết luận đã là “Đủ”");
    await db.update(schema.returnUnidentified).set({ condition: "DAMAGED" }).where(eq(schema.returnUnidentified.id, `${P}ur1`));
    assert.equal(await demPhieuRework(db), phieu0 + 2);
    assert.ok((await unidentifiedIdsInLedger(db, [`${P}ur1`, `${P}ur4`])).has(`${P}ur1`), "bàn không nhãn biết món nào đã vào sổ (để ẩn nút)");

    // ═══ 4. Huỷ bỏ: không ghi sổ kho, qua cổng, giá chưa biết ⇒ null ═══
    const phieuTruocHuy = await demPhieuRework(db);
    const g2 = congGia({});
    assert.ok("error" in (await setReturnDispositionCore(db, { subjectKey: K1, disposition: "WRITE_OFF", qty: 1, note: "", actor, gate: g2.gate })), "huỷ thiếu lý do ⇒ từ chối");
    assert.equal(g2.calls.length, 0, "thao tác đằng nào cũng hỏng thì KHÔNG hỏi cổng");
    const huy1 = await setReturnDispositionCore(db, { subjectKey: K1, disposition: "WRITE_OFF", qty: 1, note: "rách to, bỏ", actor, gate: g2.gate });
    assert.ok("ok" in huy1 && huy1.receiptId === null && huy1.valueEstimate === 120_000, "huỷ: không phiếu, giá trị ước tính theo mẫu kho nhận diện");
    assert.equal(g2.calls[0].group, "INVENTORY_WRITE_OFF");
    assert.equal(g2.calls[0].amount, 120_000);
    const huy3 = await setReturnDispositionCore(db, { subjectKey: K3, disposition: "WRITE_OFF", qty: 1, note: "mốc toàn thân", actor, gate: g2.gate });
    assert.ok("ok" in huy3 && huy3.valueEstimate === null, "chưa nhận diện mẫu ⇒ giá trị CHƯA BIẾT, không phải 0");
    assert.equal(g2.calls[1].amount, null, "gửi cổng null ⇒ cổng coi như vượt ngưỡng");
    const g3 = congGia({ INVENTORY_WRITE_OFF: true });
    const cho = await setReturnDispositionCore(db, { subjectKey: K2, disposition: "WRITE_OFF", qty: 1, note: "bẩn không giặt được", actor, gate: g3.gate });
    assert.ok("ok" in cho, "cổng bật, giá trị dưới ngưỡng ⇒ chạy (cổng nhận đúng số tiền ước tính)");
    assert.equal(g3.calls[0].amount, 120_000);
    assert.equal(await demPhieuRework(db), phieuTruocHuy, "huỷ bỏ KHÔNG ghi phiếu kho nào");

    // ═══ 5. Sự kiện: model_id chỉ từ mẫu KHO NHẬN DIỆN ═══
    const ev1 = await suKienCua(db, "ok" in huy1 ? huy1.dispositionId : "");
    assert.ok(ev1, "mỗi dòng sổ phát return.disposition_set");
    assert.equal(ev1!.modelId, `${P}m1`, "món có mẫu kho nhận diện ⇒ sự kiện mang mẫu");
    assert.equal(ev1!.subjectType, "return_inspection", "giữ loại chủ thể đã khai trong sổ sự kiện");
    assert.equal(ev1!.subjectId, K1, "subject_id = khoá unidentified:<id>, không bao giờ trùng id phiếu kiểm");
    assert.equal((ev1!.payload as Record<string, unknown>).grain, "UNIDENTIFIED");
    const ev3 = await suKienCua(db, "ok" in huy3 ? huy3.dispositionId : "");
    assert.ok(ev3);
    assert.equal(ev3!.modelId, null, "chưa nhận diện mẫu ⇒ model_id NULL, dù đơn đã nối chỉ có một mẫu (không đoán — luật 35)");
    const evNhap = await suKienCua(db, "ok" in nhap1 ? nhap1.dispositionId : "");
    assert.equal((evNhap!.payload as Record<string, unknown>).restockAuthority, "MANAGER_OVERRIDE", "sự kiện nhập lại mang căn cứ");

    // ═══ 7. Phiếu nhập lại sau sửa của món không nhãn KHÔNG xoá được ═══
    const demNhatKy = async () => Number((await db.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs).where(eq(schema.auditLogs.entityId, rid1)))[0]?.n ?? 0);
    const nkTruoc = await demNhatKy();
    const gXoa = congGia({});
    const xoa = await deleteStockReceiptCore(db, { id: rid1, reason: "lập nhầm phiếu", actor, actorEmail: `${P}kho@t.local`, gate: gXoa.gate });
    assert.ok("error" in xoa && xoa.blocker?.reworkRestocks.length === 1, "chặn bằng vế sổ kết cục — kể cả dòng không có phiếu kiểm");
    assert.equal("error" in xoa ? xoa.blocker?.reworkRestocks[0].code : "", "UR-COSR-1", "thông điệp chặn nêu đúng mã UR-…");
    assert.ok("error" in xoa && /NHẬP LẠI SAU SỬA/.test(xoa.error));
    assert.equal(gXoa.calls.length, 0, "chặn TRƯỚC cổng duyệt");
    assert.equal(await demNhatKy(), nkTruoc, "không để lại dòng nhật ký nào");
    assert.equal((await db.select({ id: schema.stockReceipts.id }).from(schema.stockReceipts).where(eq(schema.stockReceipts.id, rid1))).length, 1, "phiếu còn nguyên");

    // ═══ 8. Tóm tắt theo mẫu + con số cấp shop ═══
    clearMemo();
    const m = await getModelReturnDispositions(`${P}prod`);
    assert.equal(m.basis.unidentifiedSubjects, 2, "chỉ ur1 + ur2 (đã nhận diện mẫu) thuộc mẫu; ur3 KHÔNG");
    assert.equal(m.basis.itemSubjects, 1);
    assert.equal(m.restockedAfterReworkQty, 3, "2 (ur1) + 1 (ur2)");
    const ur2Huy = 1;
    assert.equal(m.writtenOffQty, 1 + ur2Huy, "huỷ của món chưa gán mẫu KHÔNG vào mẫu nào");
    assert.equal(m.pendingQty, 1, "món có mã ii2 còn 1 chưa quyết");
    assert.equal(m.reworkQty, 1 - ur2Huy, "ur2 còn phần đang sửa (trừ khi đã huỷ)");
    const chuaGan = await unassignedUnidentifiedDispositions(db);
    assert.ok(chuaGan.subjects >= 1 && chuaGan.writtenOffQty >= 1, "món không nhãn chưa gán mẫu có con số cấp shop riêng");
    const q1 = await listDispositionQueue();
    assert.deepEqual(q1.unidentifiedUnassigned, chuaGan, "khối trên /inventory/returns đọc cùng con số");
    assert.ok(!q1.rows.some((r) => r.subjectKey === K1 || r.subjectKey === K3), "món đã có kết cục cuối cho toàn bộ rời hàng đợi");

    // Bàn không nhãn: "đang giữ tạm" trừ phần đã có kết cục cuối (không đếm một món hai lần).
    const tongSau = await unidentifiedSummary();
    const moiGieo = 3 + 2 + 1 + 1; // ur1..ur4 chưa vào tồn (ur5 đã có phiếu)
    const daKetCuc = 3 + 1 + ur2Huy + 1; // ur1: 2 nhập + 1 huỷ · ur2: 1 nhập (+1 huỷ) · ur3: 1 huỷ
    assert.equal(tongSau.holdingUnits - tongTruoc.holdingUnits, moiGieo - daKetCuc, "giữ tạm = số món − phần đã có kết cục cuối");
    assert.equal(tongSau.reworkRestockedUnits - tongTruoc.reworkRestockedUnits, 3);
    assert.equal(tongSau.reworkRestockedOverrideUnits - tongTruoc.reworkRestockedOverrideUnits, 2, "lượt nhập lại KHÔNG chứng từ đứng riêng");

    console.log("✓ Company OS · kết cục hàng không nhãn (CSDL): đúng một neo (CHECK) · nhập lại sau sửa cùng quyền + lý do + đường lập phiếu của bàn không nhãn · hai đường vào tồn không mở cùng lúc · huỷ không ghi sổ kho · model_id không đoán · hàng đợi hai loại · phiếu không xoá được · tóm tắt mẫu bỏ món chưa gán");
  } finally {
    await donDep(db);
    clearMemo();
  }
}
