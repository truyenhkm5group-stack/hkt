import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { auditLogs, codBatches, orders, paymentTransactions, shipmentEvents, shipments } from "@/db/schema";
import { mergeVtpOrderLists, parseCodPaymentStatement, parseStatementDetail, parseVtpOrderList } from "@/lib/integrations/viettelpost/statement";
import { detectVtpFile } from "@/lib/integrations/viettelpost/import-files";
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
/**
 * Bảng kê đối soát thanh toán Viettel Post GỬI QUA EMAIL (BangKeChiCOD_*.xlsx).
 * Bố cục thật do chủ shop cung cấp; dữ liệu tổng hợp để không đưa thông tin khách vào repo public.
 *
 * Gmail đã đẩy đều đặn 11 lần nhưng ERP không đọc được lần nào vì tệp này có tiêu đề thư dài và
 * HAI phần bảng, trong khi hai trình đọc cũ chỉ tìm một dòng tiêu đề duy nhất.
 */
export function testCodPaymentStatement() {
  const csv = [
    "TỔNG CÔNG TY CỔ PHẦN BƯU CHÍNH VIETTEL",
    "PHÒNG TÀI CHÍNH",
    "",
    "",
    ",,,BẢNG KÊ ĐỐI SOÁT THANH TOÁN",
    "",
    "",
    "Mã khách hàng: GLMTQY214,,,,Tên khách hàng: HMT shop",
    "Địa chỉ: Hà Nội,,,,Mã số thuế:",
    "Số điện thoại: 0886833448",
    "",
    "I: CHI TIẾT SỐ TIỀN COD",
    "STT,Số BILL,Ngày gửi,Dịch vụ,Ngày phát thành công,Số tiền COD,Ghi chú",
    "1,PKE1511614351,04/09/2026,VSL7,06/09/2026,\"524,000\",",
    "2,PKE1508909085,31/08/2026,VSL7,04/09/2026,\"20,000\",",
    "3,PKE1508909058,30/08/2026,VSL7,06/09/2026,\"30,000\",",
    "",
    "",
    "II:CHI TIẾT TIỀN CƯỚC CHUYỂN PHÁT VÀ PHÍ COD",
    "STT,Số BILL,Ngày gửi,Dịch vụ,Trọng lượng,Cước phí,Cước đã thu,Giảm giá,Tổng số tiền,Ghi chú",
    "1,PKE1511614351,04/09/2026,VSL7,50,\"16,500\",0,0,\"16,500\",",
    "2,CHPKE1508897990,04/09/2026,GCH,1000,\"5,000\",0,0,\"5,000\",",
    "3,PKE15089090851P1,04/09/2026,VSL7,50,\"8,501\",0,0,\"8,501\",",
  ].join("\n");

  const rows = parseCodPaymentStatement(csv, "BangKeChiCOD_30484111_1788741309880.xlsx");
  const by = (code: string) => rows.find((r) => r.trackingCode === code);

  assert.equal(rows.length, 5, "gộp hai phần theo mã vận đơn: 3 mã có COD + 2 mã chỉ có cước");
  const caHai = by("PKE1511614351");
  assert.ok(caHai, "vận đơn nằm ở cả hai phần phải gộp thành một dòng");
  assert.equal(caHai.cod, 524_000);
  assert.equal(caHai.fee, 16_500);
  assert.equal(caHai.net, 507_500, "tiền thực về = COD trừ cước, đúng cách Viettel Post trả tiền");
  assert.equal(caHai.paidDate, "2026-09-06", "lấy ngày phát thành công để biết bảng kê phủ giai đoạn nào");

  const chiCoCod = by("PKE1508909085");
  assert.ok(chiCoCod && chiCoCod.cod === 20_000 && chiCoCod.fee === 0, "vận đơn chỉ có ở phần COD");

  // Vận đơn chiều hoàn chỉ nằm ở phần cước: COD = 0 là BẰNG CHỨNG không thu được đồng nào,
  // không phải "chưa biết" — đây chính là thứ ERP cần để kết luận tiền.
  const chiCoCuoc = by("CHPKE1508897990");
  assert.ok(chiCoCuoc, "vận đơn chỉ có cước vẫn phải được ghi nhận");
  assert.equal(chiCoCuoc.cod, 0);
  assert.equal(chiCoCuoc.fee, 5_000);
  assert.equal(chiCoCuoc.net, -5_000, "chỉ mất cước thì tiền về âm");
  assert.ok(by("PKE15089090851P1"), "vận đơn chiều hoàn dạng ...1P1 cũng phải đọc được");

  // Không được nhầm sang hai kiểu tệp tải tay.
  assert.throws(() => parseVtpOrderList(csv), /Không tìm thấy cột|không có dòng/i);
  const detected = detectVtpFile(csv, "BangKeChiCOD_30484111_1788741309880.xlsx");
  assert.equal(detected.kind, "STATEMENT_DETAIL", "tự nhận đúng loại, không cần chọn tab");
  assert.equal(detected.rows.length, 5);

  // Phân biệt "bảng kê ghi thu 0" với "bảng kê không nhắc tới COD": dòng chỉ có cước không được
  // phép hạ số tiền đã ghi nhận từ kỳ trước về 0.
  assert.equal(caHai.codReported, true, "vận đơn nằm ở phần COD thì bảng kê CÓ nói về tiền");
  assert.equal(chiCoCuoc.codReported, false, "vận đơn chỉ nằm ở phần cước thì bảng kê KHÔNG nói về tiền");
  assert.equal(by("PKE1508909085")?.codReported, true);

    const tongCod = rows.reduce((a, r) => a + r.cod, 0);
  const tongCuoc = rows.reduce((a, r) => a + r.fee, 0);
  console.log(`✓ Bảng kê đối soát thanh toán qua email: ${rows.length} vận đơn · COD ${tongCod} · cước ${tongCuoc} · thực về ${tongCod - tongCuoc}`);
}

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

/**
 * Bảng kê COD tự lấy từ Gmail: lõi nhập phải chạy được KHÔNG cần phiên đăng nhập (webhook gọi),
 * và gửi lại cùng một tệp không được nhân đôi số liệu — Apps Script có thể gửi lại khi ERP lỗi.
 */
export async function testVtpStatementFromMail() {
  const { runVtpDataFileImport } = await import("@/lib/integrations/viettelpost/import-run");
  const { getDb, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();

  await db.insert(schema.shipments).values({ id: "mail-ship-1", vtpOrderNumber: "PKE9911110001", trackingCode: "PKE9911110001", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 424000 }).onConflictDoNothing();

  const csv = [
    "Mã vận đơn,Mã KH,Người nhận,Số điện thoại,Địa chỉ,Ngày tạo bưu phẩm,Ngày phát thành công,Tiền thu hộ(VNĐ),Tiền cước (VNĐ),Tiền thu về (VNĐ)",
    "PKE9911110001,GLMTQY214,Khach mail,0900000091,X,31/08/2026 18:37:53,01/09/2026 11:14:09,424000,17000,407000",
  ].join("\n");
  const file = { filename: "BangKeChiCOD_thu_gmail.csv", base64: Buffer.from(csv, "utf8").toString("base64") };

  const lan1 = await runVtpDataFileImport([file], "GMAIL:viettelpost");
  assert.equal(lan1.files[0]?.kind, "STATEMENT_DETAIL", "nhận đúng loại tệp bảng kê từ thư");
  assert.equal(lan1.statementRows, 1);
  const sau1 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, "mail-ship-1") });
  // Bảng kê có 3 cột tiền: thu hộ 424.000 (thu của khách) − cước 17.000 = thu về 407.000.
  // codCollected là tiền THU CỦA KHÁCH, cước ghi riêng để báo cáo lợi nhuận trừ đúng chỗ.
  assert.equal(Number(sau1?.codCollected), 424000, "ghi đúng tiền thực thu của khách theo bảng kê");
  assert.equal(Number(sau1?.shippingFee), 17000, "ghi cước thật từ bảng kê thay cho ước lượng");
  assert.equal(sau1?.codStatus, "PAID_TO_BANK", "có chứng từ bảng kê ⇒ tiền đã về ngân hàng");

  // Apps Script gửi lại (ERP từng trả lỗi, hoặc thư bị gắn nhãn hụt) → không được cộng dồn.
  const lan2 = await runVtpDataFileImport([file], "GMAIL:viettelpost");
  assert.equal(lan2.files[0]?.kind, "STATEMENT_DETAIL");
  const sau2 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, "mail-ship-1") });
  assert.equal(Number(sau2?.codCollected), 424000, "gửi lại cùng tệp không nhân đôi tiền thực thu");

  console.log("✓ Bảng kê COD từ Gmail: lõi nhập chạy không cần đăng nhập, ghi đúng tiền thực thu, gửi lại không nhân đôi");
}

/**
 * BẢNG KÊ NHẬP SAU KHÔNG ĐƯỢC ĐÈ MẤT SỐ CỦA BẢNG KÊ MỚI HƠN.
 *
 * Đây là lỗi đã xảy ra thật trên production: luồng email xử lý từ thư mới về thư cũ, mỗi file ghi
 * thẳng lên vận đơn nên file cũ ghi đè lên file mới — 334 vận đơn giao thành công bị đưa tiền về 0
 * và 79.774.116đ biến mất khỏi đối soát. Từ nay chi tiết bảng kê vào SỔ CHỨNG TỪ, số trên vận đơn
 * chỉ là kết quả dựng lại, nên thứ tự nhập không còn ảnh hưởng.
 */
export async function testStatementLedgerOrderIndependent() {
  const { runVtpDataFileImport } = await import("@/lib/integrations/viettelpost/import-run");
  const { getDb, schema } = await import("@/db");
  const { eq, and } = await import("drizzle-orm");
  const db = await getDb();

  await db
    .insert(schema.shipments)
    .values({ id: "so-ship-1", vtpOrderNumber: "PKE9922220001", trackingCode: "PKE9922220001", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 500000 })
    .onConflictDoNothing();

  const head = "Mã vận đơn,Mã KH,Người nhận,Số điện thoại,Địa chỉ,Ngày tạo bưu phẩm,Ngày phát thành công,Tiền thu hộ(VNĐ),Tiền cước (VNĐ),Tiền thu về (VNĐ)";
  const tep = (name: string, ngay: string, cod: number, fee: number) => ({
    filename: name,
    base64: Buffer.from(`${head}\nPKE9922220001,GLMTQY214,K,0900000092,X,01/08/2026 09:00:00,${ngay},${cod},${fee},${cod - fee}`, "utf8").toString("base64"),
  });

  // Bảng kê MỚI (05/09) nói thu được 500.000; bảng kê CŨ (25/08) chỉ có dòng cước, thu 0.
  const moi = tep("BangKeChiCOD_moi.csv", "05/09/2026 10:00:00", 500000, 20000);
  const cu = tep("BangKeChiCOD_cu.csv", "25/08/2026 10:00:00", 0, 12000);

  await runVtpDataFileImport([moi], "GMAIL:viettelpost");
  await runVtpDataFileImport([cu], "GMAIL:viettelpost"); // nhập SAU nhưng chứng từ CŨ hơn

  const sau = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, "so-ship-1") });
  assert.equal(Number(sau?.codCollected), 500000, "bảng kê cũ hơn KHÔNG được xoá tiền của bảng kê mới");
  assert.equal(sau?.codStatus, "PAID_TO_BANK", "vẫn phải là tiền đã về ngân hàng");
  assert.equal(sau?.codStatementRef, "BangKeChiCOD_moi.csv", "chứng từ đại diện là bảng kê có tiền, mới nhất");

  // Sổ giữ đủ cả hai dòng: chứng từ không bị mất, kiểm tra lại được bất cứ lúc nào.
  const lines = await db.select().from(schema.codStatementLines).where(eq(schema.codStatementLines.trackingCode, "PKE9922220001"));
  assert.equal(lines.length, 2, "mỗi file một dòng trong sổ, không đè nhau");

  // Nhập lại đúng file cũ lần nữa cũng không đổi kết quả (đúng một dòng cho mỗi file × mã).
  await runVtpDataFileImport([cu], "GMAIL:viettelpost");
  const lines2 = await db.select().from(schema.codStatementLines).where(eq(schema.codStatementLines.trackingCode, "PKE9922220001"));
  assert.equal(lines2.length, 2, "nhập lại không nhân đôi dòng sổ");
  const sau2 = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, "so-ship-1") });
  assert.equal(Number(sau2?.codCollected), 500000, "nhập lại vẫn ra đúng một kết quả");

  // Dòng bảng kê không ghép được vận đơn vẫn phải nằm trong sổ để đối soát thấy tiền còn treo.
  const la = {
    filename: "BangKeChiCOD_la.csv",
    base64: Buffer.from(`${head}\nPKE9933330001,GLMTQY214,L,0900000093,Y,01/08/2026 09:00:00,06/09/2026 10:00:00,300000,15000,285000`, "utf8").toString("base64"),
  };
  await runVtpDataFileImport([la], "GMAIL:viettelpost");
  const treo = await db
    .select()
    .from(schema.codStatementLines)
    .where(and(eq(schema.codStatementLines.trackingCode, "PKE9933330001")));
  assert.equal(treo.length, 1, "dòng bảng kê chưa có vận đơn vẫn được ghi sổ");
  assert.equal(treo[0].shipmentId, null, "chưa ghép được thì để trống, không gán bừa");
  assert.equal(Number(treo[0].cod), 300000, "giữ nguyên số tiền để biết còn bao nhiêu chưa truy nguyên");

  const { statementLedgerSummary } = await import("@/lib/queries/cod-reconciliation");
  const tong = await statementLedgerSummary();
  assert.ok(tong.codUnmatched >= 300000, "đối soát phải nêu được phần tiền chưa ghép được vận đơn");

  console.log(`✓ Sổ chứng từ bảng kê: bảng kê cũ không đè bảng kê mới, nhập lại không nhân đôi, ${tong.codUnmatched}đ chưa ghép được vẫn hiện ra`);
}

/**
 * "KHÔNG THU HỘ" LÀ THUỘC TÍNH CỦA VẬN ĐƠN, KHÔNG PHẢI KẾT LUẬN VỀ TIỀN.
 *
 * Lỗi đã xảy ra thật: Viettel Post ghi "Thu hộ 849.000đ · Đã nhận COD · Giao thành công" mà ERP
 * hiện "Không thu hộ" cho 975 vận đơn (464 triệu COD khai báo). Hai luồng cũ cùng dùng sai:
 * đồng bộ VTP hạ đơn hoàn/huỷ về "không thu hộ", và dòng bảng kê báo 0đ bị hiểu là "vận đơn này
 * không thu hộ". ERP nói một đằng ĐVVC nói một nẻo thì không dùng để vận hành được.
 */
export async function testCodStatusMeaning() {
  const { codStatusForAmount } = await import("@/lib/constants/cod");
  const { mapVtpStatusText } = await import("@/lib/integrations/viettelpost/statement");
  const { runVtpDataFileImport } = await import("@/lib/integrations/viettelpost/import-run");
  const { getDb, schema } = await import("@/db");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();

  // 1. Có tiền thu hộ thì KHÔNG bao giờ là "không thu hộ".
  assert.equal(codStatusForAmount(849000, "NOT_APPLICABLE"), "PENDING", "có COD khai báo thì phải là 'chưa thu', không phải 'không thu hộ'");
  assert.equal(codStatusForAmount(849000, "PAID_TO_BANK"), "PAID_TO_BANK", "không được hạ trạng thái đã có chứng từ");
  assert.equal(codStatusForAmount(0, "PENDING"), "NOT_APPLICABLE", "không có tiền thu hộ mới là 'không thu hộ'");

  // 2. Trạng thái GIAO HÀNG không được kết luận gì về tiền.
  for (const text of ["Chuyển hoàn", "Đã trả hàng", "Huỷ đơn", "Thành công - Chuyển trả người gửi"]) {
    assert.equal(mapVtpStatusText(text).cod, null, `trạng thái "${text}" không được kết luận về COD`);
  }

  // 3. Dòng bảng kê báo 0đ cho vận đơn CÓ thu hộ ⇒ "chưa có chứng từ", không phải "không thu hộ".
  await db
    .insert(schema.shipments)
    .values({ id: "cod-nghia-1", vtpOrderNumber: "PKE9944440001", trackingCode: "PKE9944440001", carrier: "Viettel Post", stage: "DELIVERED", codAmount: 849000, codStatus: "PENDING" })
    .onConflictDoNothing();
  const head = "Mã vận đơn,Mã KH,Người nhận,Số điện thoại,Địa chỉ,Ngày tạo bưu phẩm,Ngày phát thành công,Tiền thu hộ(VNĐ),Tiền cước (VNĐ),Tiền thu về (VNĐ)";
  await runVtpDataFileImport(
    [{ filename: "BangKeChiCOD_khong_tra.csv", base64: Buffer.from(`${head}\nPKE9944440001,GLMTQY214,K,0900000094,X,01/09/2026 09:00:00,03/09/2026 10:00:00,0,17000,-17000`, "utf8").toString("base64") }],
    "GMAIL:viettelpost",
  );
  const sau = await db.query.shipments.findFirst({ where: eq(schema.shipments.id, "cod-nghia-1") });
  assert.equal(sau?.codStatus, "PENDING", "bảng kê chưa chi trả đồng nào KHÔNG biến vận đơn 849.000đ thành 'không thu hộ'");
  assert.equal(Number(sau?.codAmount), 849000, "không được xoá số tiền thu hộ Viettel Post đang ghi");
  assert.equal(Number(sau?.codCollected), 0, "chưa có chứng từ thì tiền thực thu vẫn là chưa biết, không tự điền");

  console.log("✓ Ý nghĩa trạng thái COD: 'không thu hộ' chỉ khi COD khai báo = 0; hoàn/huỷ và bảng kê 0đ không xoá dấu vết thu hộ");
}
