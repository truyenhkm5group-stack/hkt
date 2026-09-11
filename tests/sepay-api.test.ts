import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { extractSepayRows, mapSepayApiRow, sepayApiDate, webhookFailedAtProvider } from "@/lib/integrations/bank/sepay-api";
import { ingestSepayTransaction } from "@/lib/integrations/bank/sepay-ingest";
import { toBankRow } from "@/lib/integrations/bank/statement";

/**
 * ═══════ ĐƯỜNG ĐỐI CHIẾU API SEPAY ═══════
 *
 * Đây là phần NGUY HIỂM NHẤT của cả tích hợp, vì hai lý do cộng lại:
 *
 *  1. Mã đọc API này CHƯA từng chạy với API thật (chủ shop chưa tạo token), nên không có thực địa
 *     nào bắt lỗi giúp;
 *  2. Việc của nó là GHI THÊM vào sổ tiền. Đọc sai một dòng là bịa ra một giao dịch không có thật,
 *     hoặc bỏ sót một giao dịch có thật — cả hai đều chảy thẳng vào báo cáo dòng tiền.
 *
 * Nên bài kiểm này canh đúng ba thứ: KHÔNG ĐOÁN chiều tiền, KHÔNG im lặng đọc ra 0 giao dịch khi
 * phong bì đổi dạng, và KHÔNG tạo dòng thứ hai cho giao dịch webhook đã ghi.
 */

/** Dòng theo tài liệu API v2 (developer.sepay.vn/vi/sepay-api/v2). */
function apiRow(over: Record<string, unknown> = {}) {
  return {
    id: "77001",
    transaction_date: "2026-09-11 14:08:33",
    account_number: "9972165264",
    va: null,
    bank_brand_name: "MBBank",
    amount_in: "5000000",
    amount_out: "0",
    accumulated: "0",
    transaction_content: "CUSTOMER Mr T chuyen khoan",
    reference_number: "FT26254097039000",
    code: null,
    webhook_success: 1,
    ...over,
  };
}

function take(row: Record<string, unknown>) {
  const r = mapSepayApiRow(row);
  assert.ok(r.ok, `phải đọc được: ${r.ok ? "" : r.error}`);
  return r.txn;
}

export async function testSepayApi(db: Db) {
  const b = schema.bankTransactions;

  // ═══ 1. ĐỌC ĐÚNG DÒNG API V2 ═══
  const v2 = take(apiRow());
  assert.equal(v2.providerTxnId, "77001", "1. id → mã giao dịch nhà cung cấp");
  assert.equal(v2.amount, 5_000_000, "1. amount_in → số dương");
  assert.equal(v2.direction, "in", "1. chiều suy từ cột tiền, không đoán");
  assert.equal(v2.gateway, "MBBank", "1. bank_brand_name → tên ngân hàng");
  assert.equal(v2.referenceCode, "FT26254097039000", "1. reference_number → mã bút toán ngân hàng");
  assert.equal(v2.content, "CUSTOMER Mr T chuyen khoan", "1. transaction_content → mô tả");
  assert.equal(v2.txnAt.toISOString(), "2026-09-11T07:08:33.000Z", "1. giờ VN → UTC đúng, giống hệt đường webhook");

  // ═══ 2. TIỀN RA ═══
  const ra = take(apiRow({ id: "77002", amount_in: "0", amount_out: "4991000", reference_number: "FT-API-OUT" }));
  assert.equal(ra.amount, -4_991_000, "2. amount_out → số ÂM");
  assert.equal(ra.direction, "out", "2. chiều là ra");

  // ═══ 3. SỐ DƯ LUỸ KẾ 0 LÀ CHƯA BIẾT — cùng luật với webhook ═══
  // SePay gửi accumulated=0 cho MB (đo trên production 11/09/2026). Hai đường vào phải dùng CHUNG
  // một luật, nếu không sổ sẽ có chỗ "0" chỗ "NULL" cho cùng một hiện tượng.
  assert.equal(v2.balanceAfter, null, "3. accumulated=0 ⇒ CHƯA BIẾT (null)");
  assert.equal(take(apiRow({ id: "77003", accumulated: "19077000" })).balanceAfter, 19_077_000, "3. số dư dương thật vẫn giữ");

  // ═══ 4. KHÔNG ĐOÁN CHIỀU TIỀN ═══
  // Đây là chỗ một bộ đọc ẩu sẽ "mặc định là tiền vào" và làm sai dòng tiền gấp đôi số giao dịch.
  assert.equal(mapSepayApiRow(apiRow({ amount_in: "0", amount_out: "0" })).ok, false, "4. không có tiền vào lẫn ra ⇒ TỪ CHỐI");
  assert.equal(mapSepayApiRow(apiRow({ amount_in: "1000", amount_out: "2000" })).ok, false, "4. có CẢ hai cột ⇒ TỪ CHỐI, không tự chọn bên nào");
  assert.equal(mapSepayApiRow(apiRow({ id: "" })).ok, false, "4. thiếu id ⇒ TỪ CHỐI");
  assert.equal(mapSepayApiRow(apiRow({ account_number: null })).ok, false, "4. thiếu số tài khoản ⇒ TỪ CHỐI");
  assert.equal(mapSepayApiRow(apiRow({ transaction_date: "hôm qua" })).ok, false, "4. ngày không đọc được ⇒ TỪ CHỐI");

  // Dạng cũ (transfer_type + amount) vẫn đọc được: API v1 và v2 khác nhau, và nâng cấp nhà cung cấp
  // không được phép làm ERP im lặng bỏ sót giao dịch.
  const cu = take({ id: "77010", transaction_date: "2026-09-11 10:00:00", account_number: "9972165264", transfer_type: "out", amount: 250_000, reference_number: "FT-API-V1" });
  assert.equal(cu.amount, -250_000, "4. dạng v1 (transfer_type + amount) vẫn đọc đúng chiều");

  // ═══ 5. PHONG BÌ ĐỔI DẠNG KHÔNG ĐƯỢC LÀM ERP IM LẶNG ĐỌC RA 0 ═══
  // Một đường đối chiếu trả về "0 giao dịch" trông y hệt "mọi thứ đều ổn" — đó là cách nó chết mà
  // không ai biết. Nên bộ đọc thử nhiều khoá, và luôn ghi lại hình dạng thật.
  for (const [ten, phongBi] of [
    ["{transactions:[]}", { transactions: [apiRow()] }],
    ["{data:[]}", { data: [apiRow()] }],
    ["{items:[]}", { items: [apiRow()] }],
    ["mảng trần", [apiRow()]],
  ] as const) {
    const p = extractSepayRows(phongBi);
    assert.equal(p.rows.length, 1, `5. đọc được danh sách từ phong bì dạng ${ten}`);
  }
  const rong = extractSepayRows({ transactions: [] });
  assert.equal(rong.rows.length, 0, "5. phong bì rỗng ⇒ 0 dòng");
  assert.ok(rong.shape.includes("khoá phong bì"), "5. luôn ghi lại hình dạng thật để lần sau siết bộ đọc");

  assert.equal(extractSepayRows({ data: [apiRow()], has_more: true }).hasMore, true, "5. has_more đọc được");
  assert.equal(extractSepayRows({ data: [apiRow()], current_page: 2, last_page: 5 }).hasMore, true, "5. current_page/last_page suy ra được");
  assert.equal(extractSepayRows({ data: [apiRow()] }).hasMore, null, "5. phong bì không nói ⇒ null (CHƯA BIẾT), để nơi gọi tự suy theo số dòng");

  // ═══ 6. SEPAY TỰ BÁO GÓI TIN GỬI HỎNG ═══
  // `webhook_success = 0` là chính nhà cung cấp chỉ vào chỗ thủng — quý hơn mọi suy đoán của ERP.
  assert.equal(webhookFailedAtProvider(apiRow({ webhook_success: 0 })), true, "6. webhook_success=0 ⇒ SePay báo gửi hỏng");
  assert.equal(webhookFailedAtProvider(apiRow({ webhook_success: 1 })), false, "6. =1 ⇒ gửi được");
  assert.equal(webhookFailedAtProvider(apiRow({ webhook_success: undefined })), false, "6. không có trường ⇒ không kết luận gửi hỏng");

  // ═══ 7. KHOẢNG NGÀY GỬI ĐI THEO GIỜ VIỆT NAM ═══
  // Gửi mốc UTC cho một API hiểu giờ VN sẽ lệch cửa sổ 7 tiếng, và lượt đối chiếu bỏ sót đúng phần
  // giao dịch cuối ngày — phần dễ mất webhook nhất.
  assert.equal(sepayApiDate(new Date("2026-09-11T07:08:33.000Z")), "2026-09-11 14:08:33", "7. UTC → giờ VN khi gọi API");

  // ═══ 8. ĐƯỜNG API DÙNG CHUNG CỬA GHI VỚI WEBHOOK ═══
  // Không có hệ thống thứ hai: giao dịch webhook đã ghi thì API quét lại KHÔNG được tạo dòng mới.
  const tuWebhook = await ingestSepayTransaction(db, take(apiRow({ id: "77100", reference_number: "FT-SHARED-GATE" })), { source: "WEBHOOK" });
  assert.equal(tuWebhook.created, true, "8. webhook tạo dòng");
  const quetLai = await ingestSepayTransaction(db, take(apiRow({ id: "77100", reference_number: "FT-SHARED-GATE" })), { source: "API" });
  assert.equal(quetLai.created, false, "8. API quét lại KHÔNG tạo dòng thứ hai");
  assert.equal(quetLai.transactionId, tuWebhook.transactionId, "8. cùng một dòng canonical");

  // Giao dịch webhook làm MẤT: API là đường duy nhất vá được, và nó ghi source='API' để truy nguyên.
  const biMat = await ingestSepayTransaction(db, take(apiRow({ id: "77101", reference_number: "FT-MISSED-BY-WEBHOOK", amount_in: "777000" })), { source: "API" });
  assert.equal(biMat.created, true, "8. giao dịch webhook làm mất được API vá vào sổ");
  const [dongVa] = await db.select().from(b).where(eq(b.id, biMat.transactionId));
  assert.equal(dongVa.source, "API", "8. dòng do API vá ghi rõ source='API' — truy nguyên được sau này");
  assert.equal(dongVa.accountingGroup, "UNCLASSIFIED", "8. đường API cũng KHÔNG tự phân loại kế toán");

  // ═══ 9. HỘI TỤ VỚI SAO KÊ FILE ═══
  // Ba đường vào, một dòng: file → API cũng phải hội tụ y như file → webhook.
  await db.insert(b).values({
    ...toBankRow({ date: "2026-09-11", time: "09:00", amount: 1_234_000, description: "Tu sao ke", counterparty: "ABC", bankRef: "FT-API-CONVERGE", categoryCode: "", note: "" }),
    id: "sepay-api-test-file",
    source: "IMPORT",
    accountingGroup: "SALES_REVENUE",
    classifiedBy: "chu@shop.vn",
  });
  const hoiTu = await ingestSepayTransaction(
    db,
    take(apiRow({ id: "77102", reference_number: "FT-API-CONVERGE", amount_in: "1234000", transaction_date: "2026-09-11 09:00:00" })),
    { source: "API" },
  );
  assert.equal(hoiTu.created, false, "9. API hội tụ vào dòng đã nhập từ file, không đẻ dòng thứ hai");
  const [sauHoiTu] = await db.select().from(b).where(eq(b.id, "sepay-api-test-file"));
  assert.equal(sauHoiTu.accountingGroup, "SALES_REVENUE", "9. nhãn người dùng KHÔNG bị đường API xoá");
  assert.equal(sauHoiTu.classifiedBy, "chu@shop.vn", "9. người phân loại giữ nguyên");
  assert.equal(sauHoiTu.source, "IMPORT", "9. `source` vẫn là đường ĐÃ TẠO dòng — bất biến");
  assert.equal(sauHoiTu.lastSeenSource, "API", "9. nhưng đường xác nhận gần nhất là API");

  const dem = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "FT-API-CONVERGE"));
  assert.equal(Number(dem[0].n), 1, "9. đúng một dòng cho một mã bút toán");

  // Dọn dẹp — bài kiểm khác dùng chung bảng.
  await db.delete(b).where(sql`${b.providerTxnId} in ('77100','77101','77102')`);
  await db.delete(b).where(eq(b.id, "sepay-api-test-file"));
  await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.provider, "SEPAY"));

  console.log(
    "✓ Đối chiếu API SePay: đọc đúng v2 lẫn v1 · KHÔNG đoán chiều tiền · phong bì đổi dạng không làm im lặng đọc ra 0 · dùng CHUNG cửa ghi với webhook · vá được giao dịch webhook làm mất mà không đè nhãn người dùng",
  );
}
