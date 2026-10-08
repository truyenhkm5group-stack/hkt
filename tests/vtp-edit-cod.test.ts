import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { schema, type Db } from "@/db";
import { codChangeRequiresConfirmation, collectedCodShown, vtpEditDefaults, type VtpEditShipmentFacts } from "@/lib/constants/shipment-edit";
import { setViettelPostClientForTests } from "@/lib/integrations/viettelpost/client";
import { shipmentHasCashEvidence } from "@/lib/queries/shipments";
import { applyVtpOrderEdit } from "@/lib/shipping/vtp-edit";

/**
 * ───────────── «SỬA ĐƠN VTP» KHÔNG ĐƯỢC ĐIỀN SẴN COD CỦA ĐƠN ─────────────
 *
 * Lỗi gốc: trang chi tiết vận đơn điền sẵn `cod: s.codAmount || s.order?.cod || 0`. Vận đơn COD 0
 * (đơn trả trước, hoặc vận đơn chiều hoàn — `order_id NULL`, AGENTS §3.7) nhận COD CỦA ĐƠN; bấm
 * «Gửi Viettel Post» là gửi sai số tiền khách phải trả VÀ ghi đè `shipments.cod_amount`.
 *
 * Khoá ở đây:
 *  1. Hàm điền sẵn đọc ĐÚNG vận đơn: COD 0 vẫn là 0, địa chỉ là `receiver_address` của vận đơn.
 *  2. Trang dùng hàm đó, không còn `codAmount ||` (quét mã nguồn — đổi lại `||` là đỏ).
 *  3. Máy chủ từ chối đổi COD khi thiếu xác nhận và KHÔNG gọi Viettel Post; có xác nhận thì gửi
 *     và ghi `audit` trước/sau.
 *  4. «Đã thu» chỉ in số khi có bằng chứng tiền (`HAS_CASH_EVIDENCE` của ORDER_OUTCOME).
 */

const ORDER_ID = "vtpedit-o1";
const SHIP_OUT = "vtpedit-s-out";
const SHIP_RET = "vtpedit-s-ret";
const NUM_OUT = "PKE-VTPEDIT-OUT";
const NUM_RET = "PKE-VTPEDIT-OUT1P1";

export function testVtpEditDefaultsPure() {
  const order: NonNullable<VtpEditShipmentFacts["order"]> = {
    shipFullName: "Chị Lan",
    billFullName: "Lan Bill",
    shipPhone: "0901111111",
    billPhone: "0902222222",
    shipFullAddress: "12 Lê Lợi, Phường Bến Nghé, Quận 1, TP Hồ Chí Minh",
    note: "Gọi trước khi giao",
  };

  // Vận đơn CHIỀU HOÀN: không gắn đơn, COD 0 — điền sẵn đúng 0, địa chỉ của vận đơn.
  const ret = vtpEditDefaults({ codAmount: 0, receiverName: "Shop VNX", receiverPhone: "0903333333", receiverAddress: "Kho 5, Thanh Xuân, Hà Nội", order: null });
  assert.equal(ret.cod, 0, "vận đơn chiều hoàn COD 0 ⇒ điền sẵn 0");
  assert.equal(ret.address, "Kho 5, Thanh Xuân, Hà Nội");
  assert.equal(ret.name, "Shop VNX");

  // Vận đơn đơn TRẢ TRƯỚC: COD 0 trên vận đơn, đơn khai COD 499K ⇒ KHÔNG được lấy 499K.
  const prepaid = vtpEditDefaults({ codAmount: 0, receiverName: "Lan VTP", receiverPhone: "0904444444", receiverAddress: "Số 12 Lê Lợi, P. Bến Nghé, Q.1, HCM", order });
  assert.equal(prepaid.cod, 0, "COD của ĐƠN không bao giờ là giá trị điền sẵn của VẬN ĐƠN");
  assert.equal(prepaid.address, "Số 12 Lê Lợi, P. Bến Nghé, Q.1, HCM", "địa chỉ lấy receiver_address của vận đơn, không phải phần đường của đơn");
  assert.equal(prepaid.name, "Lan VTP");
  assert.equal(prepaid.phone, "0904444444");

  // COD thật trên vận đơn được giữ nguyên.
  assert.equal(vtpEditDefaults({ codAmount: 350_000, receiverName: "", receiverPhone: "", receiverAddress: "", order }).cod, 350_000);

  // Vận đơn chưa có chữ người nhận ⇒ lùi về đơn, và địa chỉ là ĐỊA CHỈ ĐẦY ĐỦ (không cắt cụt).
  const empty = vtpEditDefaults({ codAmount: 0, receiverName: "", receiverPhone: "  ", receiverAddress: "", order });
  assert.equal(empty.name, "Chị Lan");
  assert.equal(empty.phone, "0901111111");
  assert.equal(empty.address, order.shipFullAddress);
  assert.equal(empty.cod, 0);

  assert.equal(codChangeRequiresConfirmation(0, 0), false);
  assert.equal(codChangeRequiresConfirmation(0, 499_000), true);
  assert.equal(codChangeRequiresConfirmation(499_000, 0), true, "hạ COD về 0 cũng phải xác nhận");

  // «Đã thu»: không bằng chứng ⇒ null (CHƯA XÁC MINH), có bằng chứng ⇒ số thật, kể cả 0 thật.
  assert.equal(collectedCodShown(0, false), null);
  assert.equal(collectedCodShown(0, true), 0);
  assert.equal(collectedCodShown(250_000, true), 250_000);

  // Trang chi tiết phải đi qua hàm điền sẵn — không còn `||` trên COD, và «Đẩy lại» sau `canManage`.
  const page = readFileSync(path.join(process.cwd(), "app/(dashboard)/shipments/[id]/page.tsx"), "utf8");
  assert.ok(page.includes("receiver={vtpEditDefaults(s)}"), "form «Sửa đơn VTP» phải điền sẵn qua vtpEditDefaults()");
  assert.ok(!/codAmount\s*\|\|/.test(page), "không được `s.codAmount || …` — 0 là giá trị thật của vận đơn");
  assert.ok(!/order\?\.cod\b/.test(page), "COD của đơn không được dùng làm giá trị điền sẵn");
  assert.ok(page.includes("isVtp && canManage ? <RepushButton"), "nút «Yêu cầu VTP gửi lại webhook» chỉ hiện cho người có shipments:manage");
  assert.ok(!page.includes("<Money value={s.codCollected}"), "«Đã thu» không in thẳng cod_collected (mặc định 0 ⇒ 0 ₫ giả)");
  const meta = page.slice(page.indexOf("export async function generateMetadata"), page.indexOf("export default async function"));
  assert.ok(meta.indexOf("can(user") >= 0 && meta.indexOf("can(user") < meta.indexOf("getShipmentDetail"), "metadata kiểm quyền TRƯỚC khi đọc vận đơn");

  console.log("  ✓ Sửa đơn VTP: điền sẵn từ vận đơn (COD 0 giữ 0, địa chỉ receiver_*), «Đã thu» chưa xác minh không in 0 ₫");
}

export async function testVtpEditCodGuardDb(db: Db) {
  const calls: { number: string; fields: Record<string, unknown> }[] = [];
  setViettelPostClientForTests({
    configured: true,
    editOrder: async (number: string, fields: Record<string, unknown>) => {
      calls.push({ number, fields });
      return { status: 200, error: false, message: "OK", data: null };
    },
  });
  try {
    await db.insert(schema.orders).values({ id: ORDER_ID, cod: 499_000, shipAddress: "12 Lê Lợi", shipFullAddress: "12 Lê Lợi, Q.1, HCM", insertedAt: new Date() }).onConflictDoNothing();
    await db.insert(schema.shipments).values([
      { id: SHIP_OUT, orderId: ORDER_ID, carrier: "Viettel Post", vtpOrderNumber: NUM_OUT, stage: "PENDING", codAmount: 0, receiverName: "Lan", receiverPhone: "0904444444", receiverAddress: "Số 12 Lê Lợi, Q.1, HCM" },
      { id: SHIP_RET, orderId: null, orderReference: NUM_OUT, direction: "RETURN", carrier: "Viettel Post", vtpOrderNumber: NUM_RET, stage: "RETURNING", codAmount: 0, receiverName: "Shop", receiverPhone: "0903333333", receiverAddress: "Kho 5, Hà Nội" },
    ]).onConflictDoNothing();

    const actor = { id: null, email: "tester@vtp-edit.local", name: "Người kiểm" };
    const input = { receiverName: "Lan", receiverPhone: "0904444444", receiverAddress: "Số 12 Lê Lợi, Q.1, HCM", moneyCollection: 499_000, note: "" };

    // (a) Đổi COD 0 → 499K KHÔNG xác nhận ⇒ lỗi, KHÔNG gọi VTP, KHÔNG ghi gì.
    const denied = await applyVtpOrderEdit(actor, SHIP_OUT, input);
    assert.ok("error" in denied && /COD hiện tại 0\s?₫ → mới 499\.000\s?₫/.test(denied.error), `phải nêu COD trước → sau, nhận: ${JSON.stringify(denied)}`);
    assert.equal(calls.length, 0, "thiếu xác nhận ⇒ không một lời gọi nào sang Viettel Post");
    const sau1 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, SHIP_OUT), columns: { codAmount: true } });
    assert.equal(sau1?.codAmount, 0, "thiếu xác nhận ⇒ cod_amount giữ nguyên");
    const auditTruoc = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "VTP_ORDER_EDIT"), eq(schema.auditLogs.entityId, SHIP_OUT)));
    assert.equal(auditTruoc.length, 0, "bị từ chối thì không có dòng nhật ký sửa đơn");

    // `confirmCodChange` phải là boolean thật — chuỗi "true" không qua lược đồ.
    const chuoi = await applyVtpOrderEdit(actor, SHIP_OUT, { ...input, confirmCodChange: "true" });
    assert.ok("error" in chuoi);
    assert.equal(calls.length, 0);

    // (b) Có xác nhận ⇒ gửi đúng số, ghi cod_amount, audit trước/sau.
    const ok = await applyVtpOrderEdit(actor, SHIP_OUT, { ...input, confirmCodChange: true });
    assert.ok("ok" in ok, `có xác nhận phải đi tiếp, nhận: ${JSON.stringify(ok)}`);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.number, NUM_OUT);
    assert.equal(calls[0]?.fields.moneyCollection, 499_000);
    assert.ok(!("confirmCodChange" in (calls[0]?.fields ?? {})), "cờ xác nhận là của ERP, không gửi sang Viettel Post");
    const sau2 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, SHIP_OUT), columns: { codAmount: true, codStatus: true, codCollected: true } });
    assert.equal(sau2?.codAmount, 499_000);
    assert.equal(sau2?.codStatus, "PENDING", "sửa đơn không đụng cod_status (§3.6)");
    assert.equal(sau2?.codCollected, 0, "sửa đơn không đụng cod_collected (§3.6)");
    const [dong] = await db.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.action, "VTP_ORDER_EDIT"), eq(schema.auditLogs.entityId, SHIP_OUT)));
    const detail = dong?.detail as { before?: { codAmount?: number }; after?: { codAmount?: number }; codChanged?: boolean } | null;
    assert.equal(detail?.before?.codAmount, 0, "audit ghi COD TRƯỚC");
    assert.equal(detail?.after?.codAmount, 499_000, "audit ghi COD SAU");
    assert.equal(detail?.codChanged, true);

    // (c) Vận đơn chiều hoàn, COD không đổi (0 → 0) ⇒ không cần xác nhận.
    const ret = await applyVtpOrderEdit(actor, SHIP_RET, { receiverName: "Shop", receiverPhone: "0903333333", receiverAddress: "Kho 5, Hà Nội", moneyCollection: 0, note: "" });
    assert.ok("ok" in ret, `COD không đổi thì không cần xác nhận, nhận: ${JSON.stringify(ret)}`);
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.fields.moneyCollection, 0);

    // (d) «Đã thu»: chưa có chứng từ ⇒ chưa xác minh; có dòng bảng kê phần COD ⇒ có bằng chứng.
    assert.equal(await shipmentHasCashEvidence(SHIP_RET), false, "cod_collected 0 mặc định + không bảng kê ⇒ CHƯA XÁC MINH");
    await db.insert(schema.codStatementLines).values({ statementKey: "vtpedit-bk", sourceFile: "vtpedit.xlsx", trackingCode: NUM_RET, cod: 0, codReported: true, statementAt: new Date(), shipmentId: SHIP_RET });
    assert.equal(await shipmentHasCashEvidence(SHIP_RET), true, "bảng kê phần COD ghi thu 0 ₫ là bằng chứng THU 0, in được 0 ₫");
    await db.update(schema.shipments).set({ codCollected: 120_000 }).where(eq(schema.shipments.id, SHIP_OUT));
    assert.equal(await shipmentHasCashEvidence(SHIP_OUT), true, "có số thực thu > 0 ⇒ có bằng chứng");

    console.log("  ✓ Sửa đơn VTP: đổi COD thiếu xác nhận bị từ chối và không gọi Viettel Post; có xác nhận thì gửi + audit trước/sau");
  } finally {
    setViettelPostClientForTests(null);
    await db.delete(schema.codStatementLines).where(eq(schema.codStatementLines.statementKey, "vtpedit-bk"));
    await db.delete(schema.auditLogs).where(and(eq(schema.auditLogs.action, "VTP_ORDER_EDIT"), inArray(schema.auditLogs.entityId, [SHIP_OUT, SHIP_RET])));
    await db.delete(schema.shipmentEvents).where(inArray(schema.shipmentEvents.shipmentId, [SHIP_OUT, SHIP_RET]));
    await db.delete(schema.shipments).where(inArray(schema.shipments.id, [SHIP_OUT, SHIP_RET]));
    await db.delete(schema.orders).where(eq(schema.orders.id, ORDER_ID));
  }
}
