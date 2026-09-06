import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLogs, codBatches, orders, paymentTransactions, shipmentEvents, shipments } from "@/db/schema";
import { mergeVtpOrderLists, parseStatementDetail, parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { applyVtpOrderList, applyStatementDetailRows, matchStatementFileToBatch, matchVtpOrderList } from "@/lib/integrations/viettelpost/statement-db";

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
  // Ca thật: shop tạo đơn THẲNG trên web Viettel Post nên ERP có đơn (từ Pancake) mà vận đơn CHƯA
  // có mã; cột "Mã đơn hàng" của file là mã VTP tự sinh nên tra ngược không ra. Bằng chứng còn lại
  // là SĐT người nhận — thiếu bước này thì mã vận đơn và phí vận chuyển không bao giờ vào ERP.
  const webHeader = `${header},Người nhận,ĐT Nhận,Địa chỉ nhận`;
  const webLine = "PKE9900000777,PKE10000000777,02/08/2026 19:51:00,15741,1259,17000,749000,Giao thành công,Đã nhận COD,Đã thanh toán,,06/08/2026 14:46:16,Khách Thử,0969444900,Số 128 Khu phố 3";
  const webRows = parseVtpOrderList(`${webHeader}
${webLine}`);
  assert.equal(webRows[0].receiverPhone, "0969444900", "Đọc được SĐT người nhận từ file danh sách");
  assert.equal(webRows[0].receiverName, "Khách Thử");
  await db.insert(orders).values({ id: "vtp-web-order", insertedAt: new Date(), billPhone: "0969444900" });
  await db.insert(shipments).values({ id: "vtp-web-shipment", orderId: "vtp-web-order", codAmount: 749000,
    stage: "IN_TRANSIT", receiverPhone: "0969.444.900" });
  assert.equal((await applyVtpOrderList(webRows, "fixture-importer")).linked, 1, "Gắn mã vào vận đơn chưa có mã theo SĐT");
  const [web] = await db.select().from(shipments).where(eq(shipments.id, "vtp-web-shipment"));
  assert.equal(web.trackingCode, "PKE9900000777");
  assert.equal(web.vtpOrderNumber, "PKE9900000777");
  assert.equal(web.carrier, "Viettel Post");
  assert.equal(web.shippingFee, 17000, "Phí vận chuyển lấy từ file VTP");
  assert.equal(web.stage, "DELIVERED");
  assert.equal((await applyVtpOrderList(webRows)).duplicate, 1, "Nhập lại ghép thẳng theo mã, không sinh thêm");

  // Hai vận đơn chưa có mã cùng SĐT và cùng COD: không đoán, báo để chủ shop đối chiếu.
  await db.insert(shipments).values([
    { id: "vtp-web-2a", codAmount: 333000, receiverPhone: "0912345678" },
    { id: "vtp-web-2b", codAmount: 333000, receiverPhone: "0912345678" },
  ]);
  const [ambiguousPhone] = await matchVtpOrderList([{ ...webRows[0], trackingCode: "PKE9900000888", cod: 333000, receiverPhone: "0912345678" }]);
  assert.equal(ambiguousPhone.shipmentId, null, "Nhập nhằng thì không gắn bừa");
  assert.match(ambiguousPhone.matchIssue ?? "", /SĐT/);

  console.log("✓ VTP Data Truth: đúng cột/ngày/giờ, unknown, nguồn, chống trùng/cũ/xung đột, gắn mã theo SĐT, không tự xác minh tiền");
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

/**
 * Chi tiết bảng kê Viettel Post: bố cục thật của file "Bao_cao_chi_tiet_bang_ke_N.xlsx".
 * File KHÔNG có cột Trạng thái và KHÔNG chứa mã bảng kê, nên ERP phải (1) chỉ đúng tab,
 * (2) ghép file với đợt tiền về bằng SỐ TIỀN chứ không đoán theo ngày.
 * Số liệu dưới đây là số tổng hợp, không có thông tin khách hàng.
 */
export async function testStatementDetailMatching(db: Db) {
  const header = "Mã vận đơn,Mã KH,Người nhận,Số điện thoại,Địa chỉ,Ngày tạo bưu phẩm,Ngày phát thành công,Tiền thu hộ(VNĐ),Tiền cước (VNĐ),Tiền thu về (VNĐ)";
  const body = [
    "PKE9900000101,GLMTQY214,A,0900000001,X,31/08/2026 18:37:53,01/09/2026 11:14:09,424000,17000,407000",
    "CHPKE9900000102,GLMTQY214,B,,Y,02/09/2026 15:19:25,,0,5000,-5000",
    "PKE99000001031P1,GLMTQY214,C,0900000003,Z,03/09/2026 20:06:37,,0,8501,-8501",
  ].join("\n");
  const file = `${header}\n${body}`;

  // 1. Đọc đúng ba cột tiền, kể cả số âm của chiều hoàn.
  const rows = parseStatementDetail(file, "Bao_cao_chi_tiet_bang_ke_9.csv");
  assert.equal(rows.length, 3);
  assert.equal(rows[0].cod, 424000);
  assert.equal(rows[0].fee, 17000);
  assert.equal(rows[0].net, 407000, "phải đọc cột 'Tiền thu về', không tự suy");
  assert.equal(rows[1].net, -5000, "chiều hoàn có tiền về âm");
  const codGross = rows.reduce((a, r) => a + r.cod, 0);
  const feeTotal = rows.reduce((a, r) => a + r.fee, 0);
  const netAmount = rows.reduce((a, r) => a + r.net, 0);
  assert.equal(netAmount, codGross - feeTotal, "thu về = thu hộ − cước");

  // 2. Nhập nhầm sang tab Danh sách vận đơn phải được chỉ sang đúng tab.
  assert.throws(() => parseVtpOrderList(file), /CHI TIẾT BẢNG KÊ/, "phải chỉ rõ tab đúng thay vì chỉ liệt kê cột");

  // 3. Ghép file với đợt bằng số tiền, không đoán ngày.
  const receivedAt = new Date("2026-09-04T00:00:00Z");
  await db.insert(codBatches).values({
    id: "batch-match-test", reference: "PCOD-A-TEST-MATCH", carrier: "Viettel Post",
    receivedAt, totalAmount: netAmount, codGross, feeTotal, source: "VTP_STATEMENT", createdBy: "test",
  });
  const match = await matchStatementFileToBatch("Bao_cao_chi_tiet_bang_ke_9.csv", rows);
  assert.equal(match.batchReference, "PCOD-A-TEST-MATCH", "ghép được đúng đợt theo số tiền");
  assert.equal(match.issue, null);
  assert.equal(match.netAmount, netAmount);

  // Số tiền lệch một đồng thì KHÔNG được ghép bừa.
  const off = rows.map((r, i) => (i === 0 ? { ...r, net: r.net + 1 } : r));
  const noMatch = await matchStatementFileToBatch("khac.csv", off);
  assert.equal(noMatch.batchId, null, "lệch số tiền thì không ghép");
  assert.ok((noMatch.issue ?? "").length > 0, "phải nêu lý do không ghép được để chủ shop biết xử lý");

  // 4. Gắn vận đơn KHÔNG được sửa số hay ngày của đợt (số của đợt là chứng từ gốc).
  await applyStatementDetailRows(rows, "test.csv", "batch-match-test");
  const after = await db.query.codBatches.findFirst({ where: eq(codBatches.id, "batch-match-test") });
  assert.equal(Number(after?.totalAmount), netAmount, "không đè tổng tiền của đợt");
  assert.equal(new Date(after!.receivedAt).getTime(), receivedAt.getTime(), "không đè ngày về của đợt");

  console.log(`✓ Chi tiết bảng kê: đọc đúng 3 cột tiền, ghép đợt bằng số tiền (${netAmount}), không đè số/ngày của đợt`);
}

/**
 * MỘT CHỖ NHẬP: ERP phải tự nhận loại từng tệp Viettel Post. Nhập nhầm loại rất nguy hiểm
 * vì một bên là trạng thái giao, một bên là tiền — nên phải nhận đúng, không đoán theo tên tệp.
 */
export async function testVtpFileDetection() {
  const { detectVtpFile, VtpFileError } = await import("@/lib/integrations/viettelpost/import-files");

  const statement = [
    "Mã vận đơn,Mã KH,Người nhận,Số điện thoại,Địa chỉ,Ngày tạo bưu phẩm,Ngày phát thành công,Tiền thu hộ(VNĐ),Tiền cước (VNĐ),Tiền thu về (VNĐ)",
    "PKE9900000201,GLMTQY214,A,0900000001,X,31/08/2026 18:37:53,01/09/2026 11:14:09,424000,17000,407000",
  ].join("\n");

  const orderList = [
    "STT,Mã Vận Đơn,Mã đơn hàng,Ngày tạo,Trạng Thái,Tiền thu hộ (4),Tổng phí (9),Ngày chuyển trạng thái",
    "1,PKE9900000202,PKE_REF_02,01/08/2026 12:00:00,Giao thành công,499000,17000,05/09/2026 15:50:44",
  ].join("\n");

  const a = detectVtpFile(statement, "Bao_cao_chi_tiet_bang_ke_1.xlsx");
  assert.equal(a.kind, "STATEMENT_DETAIL", "tệp có Tiền thu về, không có Trạng thái → chi tiết bảng kê");
  assert.equal(a.rows.length, 1);

  const b = detectVtpFile(orderList, "VTP_danh_sach_van_don_T8.xlsx");
  assert.equal(b.kind, "ORDER_LIST", "tệp có cột Trạng thái → danh sách vận đơn");
  assert.equal(b.rows.length, 1);

  // Nhận loại theo NỘI DUNG, không theo tên tệp: đổi chéo tên vẫn phải nhận đúng.
  assert.equal(detectVtpFile(statement, "VTP_danh_sach_van_don.xlsx").kind, "STATEMENT_DETAIL", "không tin tên tệp");
  assert.equal(detectVtpFile(orderList, "Bao_cao_chi_tiet_bang_ke.xlsx").kind, "ORDER_LIST", "không tin tên tệp");

  // Tệp lạ phải báo lỗi kèm TÊN TỆP để chủ shop biết bỏ tệp nào ra.
  assert.throws(
    () => detectVtpFile("cot1,cot2\na,b", "linh_tinh.csv"),
    (e: unknown) => e instanceof VtpFileError && String(e.message).includes("linh_tinh.csv"),
    "tệp không đọc được phải nêu rõ tên tệp",
  );

  console.log("✓ Nhận loại tệp VTP: đúng theo nội dung, không theo tên tệp; tệp lỗi nêu rõ tên");
}
