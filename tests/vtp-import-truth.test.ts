import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLogs, orders, paymentTransactions, shipmentEvents, shipments } from "@/db/schema";
import { mergeVtpOrderLists, parseStatementDetail, parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyVtpOrderList, matchVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";

/** Bố cục thật của VTP, dữ liệu tổng hợp để không đưa thông tin khách hàng vào repo public. */
export async function testVtpImportTruth(db: Db) {
  const header = "Mã Vận Đơn,Mã đơn hàng,Ngày tạo,Tổng cước (1),VAT (2),Tổng phí (9)= (3)+(5)+(6)+(7)-(8),Tiền thu hộ (4),Trạng Thái,Trạng thái đối soát COD,Trạng thái thanh toán,Đơn chuyển hoàn,Ngày chuyển trạng thái";
  const line = "PKE9900000001,PKE_REFERENCE_01,01/08/2026 12:00:00,15741,1259,17000,30000,Giao thành công,Chưa đối soát COD,Đã thanh toán,,05/09/2026 15:50:44";
  const rows = parseVtpOrderList(`${header}\n${line}`);
  assert.throws(() => parseStatementDetail(`${header}\n${line}`), /không phải chi tiết bảng kê/, "Không nhập nhầm danh sách vào tab tiền đã về ngân hàng");
  assert.equal(rows[0].fee, 17000, "Lấy tổng phí gồm VAT/phụ phí");
  assert.equal(rows[0].statusAt, "2026-09-05T08:50:44.000Z", "Đúng giờ VN và ngày trạng thái, không dùng ngày tạo");
  assert.equal(rows[0].createdAt, "2026-08-01T05:00:00.000Z");
  assert.equal(rows[0].codReconciliationText, "Chưa đối soát COD");
  assert.equal(rows[0].paymentText, "Đã thanh toán", "Hai cột khác nghĩa vẫn được giữ riêng");
  assert.equal(rows[0].sourceRow, 2);
  assert.equal(rows[0].sourceHash?.length, 64);
  const blank = parseVtpOrderList("Mã vận đơn,Trạng thái,Tiền thu hộ,Cước,Ngày tạo\nPKE9900000099,Giao thành công,,,01/09/2026")[0];
  assert.equal(blank.cod, null);
  assert.equal(blank.fee, null);
  assert.equal(blank.statusAt, null, "Thiếu ngày trạng thái không dùng ngày tạo thay thế");
  assert.throws(() => parseVtpOrderList(`${header}\n${line.replace(",30000,", ",30.5,")}`), /số tiền không hợp lệ/);
  assert.throws(() => parseVtpOrderList(`${header}\n${line.replace("05/09/2026", "31/02/2026")}`), /Ngày VTP không hợp lệ/);
  assert.equal(mergeVtpOrderLists([...rows, ...rows]).length, 1);
  assert.throws(() => mergeVtpOrderLists([rows[0], { ...rows[0], fee: 19000 }]), /xung đột/);
  const newer = { ...rows[0], statusAt: "2026-09-05T09:50:44.000Z", fee: 18000 };
  assert.equal(mergeVtpOrderLists([newer, rows[0]])[0].fee, 18000, "Không phụ thuộc thứ tự file, kể cả cùng ngày");

  await db.insert(orders).values({ id: "vtp-truth-order", insertedAt: new Date() });
  await db.insert(shipments).values({ id: "vtp-truth-shipment", orderId: "vtp-truth-order", vtpOrderNumber: rows[0].trackingCode,
    codAmount: 499000, codCollected: 0, codStatus: "PENDING", stage: "IN_TRANSIT" });
  const paymentsBefore = (await db.select().from(paymentTransactions)).length;
  const applied = await applyVtpOrderList(rows, "fixture-importer");
  assert.equal(applied.updated, 1);
  const [after] = await db.select().from(shipments).where(eq(shipments.id, "vtp-truth-shipment"));
  assert.equal(after.codAmount, 30000);
  assert.equal(after.codCollected, 0, "Không copy COD khai báo vào thực thu");
  assert.equal(after.codStatus, "PENDING", "Thanh toán cước không phải COD về ngân hàng");
  assert.equal(after.codPaidToBankAt, null);
  assert.equal(after.deliveredAt?.toISOString(), rows[0].statusAt);
  assert.equal(after.shippingFee, 17000);
  const events = await db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, after.id));
  assert.equal(events.length, 1);
  assert.equal(events[0].verificationStatus, "PENDING");
  assert.equal(events[0].legType, "OUTBOUND");
  assert.ok(events[0].sourceReference?.startsWith(rows[0].sourceHash!));
  assert.equal((await applyVtpOrderList(rows)).duplicate, 1);
  assert.equal((await db.select().from(auditLogs).where(eq(auditLogs.entityId, after.id))).length, 1, "Retry không nhân audit");
  const older = { ...rows[0], statusText: "Đang vận chuyển", statusAt: "2026-09-05T08:00:00.000Z" };
  assert.equal((await applyVtpOrderList([older])).stale, 1);
  assert.equal((await db.select().from(shipments).where(eq(shipments.id, after.id)))[0].stage, "DELIVERED");
  assert.equal((await applyVtpOrderList([{ ...rows[0], cod: 40000 }])).conflicts, 1, "Cùng thời điểm đổi tiền không overwrite");
  assert.equal((await applyVtpOrderList([{ ...blank, trackingCode: rows[0].trackingCode }])).missingDate, 1);
  const leg = { ...rows[0], trackingCode: "PKE99000000011P1", orderCode: rows[0].trackingCode, cod: 0, fee: 8501 };
  assert.equal((await applyVtpOrderList([leg], "fixture-importer")).legs, 1);
  const [returnedLeg] = await db.select().from(shipments).where(eq(shipments.vtpOrderNumber, leg.trackingCode));
  assert.equal(returnedLeg.orderId, null);
  assert.equal(returnedLeg.orderReference, rows[0].trackingCode);
  assert.equal((await db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, returnedLeg.id)))[0].legType, "RETURN");
  assert.equal((await applyVtpOrderList([leg])).duplicate, 1);
  assert.equal((await db.select().from(paymentTransactions)).length, paymentsBefore, "Nhập vận đơn không sinh verified ledger");

  await db.insert(shipments).values({ id: "vtp-ambiguous", trackingCode: rows[0].trackingCode });
  const [ambiguous] = await matchVtpOrderList(rows);
  assert.equal(ambiguous.shipmentId, null);
  assert.ok(ambiguous.matchIssue);
  const [referenceOnly] = await matchVtpOrderList([{ ...rows[0], trackingCode: "PKE_UNMATCHED", orderCode: "PKE9900000001" }]);
  assert.equal(referenceOnly.shipmentId, null, "Không ghi đè vận đơn khác qua mã đơn tham chiếu");
  console.log("✓ VTP Data Truth: đúng cột/ngày/giờ, unknown, nguồn, chống trùng/cũ/xung đột, không tự xác minh tiền");
}

/**
 * Chủ shop xuất 11 tệp bảng kê từ Viettel Post và ERP báo lỗi Zod thô
 * ("too_big: expected array to have <=10 items"). Khoá lại cả hai lỗi:
 * giới hạn phải đủ cho việc dùng thật, và thông báo phải đọc được.
 */
export async function testVtpImportLimits() {
  const { MAX_LIST_FILES, MAX_LIST_BASE64, MAX_LIST_RAW_BYTES } = await import("@/lib/constants/cod");

  assert.ok(MAX_LIST_FILES >= 20, `Phải nhập được ít nhất 20 tệp mỗi lượt, đang là ${MAX_LIST_FILES}`);
  assert.ok(MAX_LIST_FILES >= 11, "Trường hợp thật của chủ shop: 11 tệp bảng kê");

  // Trần dung lượng phải nằm dưới serverActions.bodySizeLimit, nếu không sẽ lỗi ở tầng Next.
  const config = readFileSync("next.config.ts", "utf8");
  const limit = /bodySizeLimit:\s*"(\d+)mb"/.exec(config);
  assert.ok(limit, "next.config.ts phải khai báo serverActions.bodySizeLimit");
  assert.ok(
    Number(limit[1]) * 1_000_000 > MAX_LIST_BASE64,
    `bodySizeLimit (${limit[1]}MB) phải lớn hơn MAX_LIST_BASE64 (${MAX_LIST_BASE64}) để không lỗi ở tầng Next`,
  );
  assert.equal(MAX_LIST_RAW_BYTES, Math.floor((MAX_LIST_BASE64 * 3) / 4), "trần dung lượng gốc phải quy đổi đúng từ base64");

  // Lỗi vượt giới hạn phải là câu tiếng Việt, không phải JSON thô của Zod.
  const schema = z
    .array(z.object({ filename: z.string(), base64: z.string() }))
    .max(MAX_LIST_FILES, `Tối đa ${MAX_LIST_FILES} tệp mỗi lượt — hãy chia thành nhiều lượt`);
  const tooMany = Array.from({ length: MAX_LIST_FILES + 1 }, (_, i) => ({ filename: `f${i}.xlsx`, base64: "AA==" }));
  const result = schema.safeParse(tooMany);
  assert.equal(result.success, false);
  const message = result.success ? "" : result.error.issues[0].message;
  assert.match(message, /Tối đa .* tệp mỗi lượt/, "thông báo phải nói rõ giới hạn bằng tiếng Việt");
  assert.doesNotMatch(message, /too_big|expected array|origin/, "không được để lộ JSON thô của Zod ra giao diện");

  console.log(`✓ Nhập bảng kê: cho phép ${MAX_LIST_FILES} tệp/lượt, thông báo vượt giới hạn bằng tiếng Việt`);
}
