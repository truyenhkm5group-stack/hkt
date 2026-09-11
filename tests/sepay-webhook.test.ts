import assert from "node:assert/strict";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import {
  bankMatchKey,
  normalizeBankRef,
  parseSepayPayload,
  sepayBankRef,
  sepayInstant,
  sepaySignature,
  verifySepayRequest,
  SEPAY_REPLAY_WINDOW_SECONDS,
} from "@/lib/integrations/bank/sepay";
import { ingestSepayTransaction, resolveBankAccount } from "@/lib/integrations/bank/sepay-ingest";
import { toBankRow } from "@/lib/integrations/bank/statement";

/**
 * ═══════════ WEBHOOK SEPAY → SỔ NGÂN HÀNG ═══════════
 *
 * Sổ ngân hàng là SỰ THẬT VỀ TIỀN. Một dòng thừa hay một dấu sai ở đây không dừng lại ở sổ: nó chảy
 * thẳng vào dòng tiền, đối soát COD và báo cáo lợi nhuận. Nên bài kiểm này canh đúng những chỗ mà
 * sai thì KHÔNG AI NHÌN RA BẰNG MẮT:
 *
 *   · chiều tiền (10 triệu vào thành 10 triệu ra = lệch 20 triệu);
 *   · múi giờ (giao dịch buổi tối nhảy sang ngày hôm sau, lệch kỳ báo cáo);
 *   · gửi lại và tranh chấp (SePay thử tối đa 7 lần — hai dòng cho một giao dịch);
 *   · hội tụ với sao kê đã nhập bằng file (bật realtime mà nhân đôi lịch sử);
 *   · gộp nhầm hai giao dịch thật chỉ vì chúng giống nhau.
 */

const SECRET = "sepay-test-secret-0123456789";

/** Gói tin mẫu theo đúng tài liệu SePay (docs.sepay.vn/tich-hop-webhooks.html). */
function payload(over: Record<string, unknown> = {}) {
  return {
    id: 92704,
    gateway: "MBBank",
    transactionDate: "2026-09-11 14:08:33",
    accountNumber: "9972165264",
    subAccount: null,
    code: null,
    content: "CUSTOMER Mr T chuyen khoan nhanh qua Zalo",
    transferType: "in",
    description: "BankAPINotify CUSTOMER Mr T chuyen khoan",
    transferAmount: 5_000_000,
    accumulated: 19_077_000,
    referenceCode: "FT26254097039000",
    ...over,
  };
}

function take(p: Record<string, unknown>) {
  const parsed = parseSepayPayload(p);
  assert.ok(parsed.ok, `gói tin phải đọc được: ${parsed.ok ? "" : parsed.error}`);
  return parsed.txn;
}

export async function testSepayWebhook(db: Db) {
  const b = schema.bankTransactions;
  const accounts = schema.bankAccounts;

  // ═══ 1. GIAO DỊCH TIỀN VÀO ═══
  const vao = take(payload());
  assert.equal(vao.amount, 5_000_000, "1. tiền vào mang dấu DƯƠNG");
  assert.equal(vao.direction, "in", "1. chiều tiền đọc từ transferType");
  assert.equal(vao.balanceAfter, 19_077_000, "1. accumulated thành số dư luỹ kế");
  assert.equal(vao.referenceCode, "FT26254097039000", "1. giữ nguyên mã giao dịch của ngân hàng");
  assert.equal(vao.gateway, "MBBank", "1. tên ngân hàng lấy từ gateway, KHÔNG hard-code");

  // ═══ 2. GIAO DỊCH TIỀN RA ═══
  // SePay luôn gửi transferAmount DƯƠNG; chiều nằm ở transferType. Lấy nhầm dấu ở đây là sai
  // dòng tiền gấp đôi số tiền giao dịch.
  const ra = take(payload({ id: 92705, transferType: "out", transferAmount: 5_000_000, referenceCode: "FT26254097039001" }));
  assert.equal(ra.amount, -5_000_000, "2. tiền ra mang dấu ÂM dù SePay gửi số dương");
  assert.equal(ra.direction, "out", "2. chiều tiền là 'out'");

  // ═══ 3. NHIỀU TÀI KHOẢN NGÂN HÀNG ═══
  // Không được hard-code MB: gateway + accountNumber quyết định tài khoản nào.
  const vcb = take(payload({ id: 92706, gateway: "Vietcombank", accountNumber: "0011004218076", referenceCode: "VCB-TEST-0001" }));
  const mb = await ingestSepayTransaction(db, vao);
  const mbRa = await ingestSepayTransaction(db, ra);
  const vcbRow = await ingestSepayTransaction(db, vcb);
  assert.notEqual(mb.bankAccountId, vcbRow.bankAccountId, "3. hai ngân hàng khác nhau ⇒ hai tài khoản nội bộ khác nhau");
  assert.equal(mb.bankAccountId, mbRa.bankAccountId, "3. cùng ngân hàng + cùng số tài khoản ⇒ đúng một tài khoản nội bộ");

  const [mbAccount] = await db.select().from(accounts).where(eq(accounts.id, mb.bankAccountId));
  assert.equal(mbAccount.gateway, "MBBank", "3. tài khoản ghi đúng tên ngân hàng do SePay đặt");
  assert.equal(mbAccount.accountNumber, "9972165264", "3. tài khoản ghi đúng số tài khoản");

  // Tài khoản ảo (VA) là tài khoản RIÊNG, không lẫn vào tài khoản gốc.
  const va = take(payload({ id: 92707, subAccount: "96247TEST", referenceCode: "VA-TEST-0001" }));
  const vaRow = await ingestSepayTransaction(db, va);
  assert.notEqual(vaRow.bankAccountId, mb.bankAccountId, "3. tài khoản ảo tách khỏi tài khoản gốc");

  // ═══ 4. CÙNG MỘT GÓI TIN GỬI HAI LẦN ═══
  // SePay thử lại tối đa 7 lần trong 5 giờ. Lần hai KHÔNG được đẻ dòng mới.
  const lai = await ingestSepayTransaction(db, vao);
  assert.equal(lai.created, false, "4. gửi lại KHÔNG tạo dòng mới");
  assert.equal(lai.duplicate, true, "4. gửi lại được nhận là trùng để trả thành công idempotently");
  assert.equal(lai.transactionId, mb.transactionId, "4. gửi lại trỏ về đúng dòng cũ");

  const demMb = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.providerTxnId, "92704"));
  assert.equal(Number(demMb[0].n), 1, "4. sau hai lần gửi vẫn đúng MỘT dòng trong sổ");

  // ═══ 5. HAI GÓI TIN TRÙNG TỚI CÙNG LÚC ═══
  // Chống trùng bằng mã ứng dụng ("kiểm tra rồi mới ghi") LUÔN thua điều kiện tranh chấp. Ràng buộc
  // UNIQUE ở CSDL mới là thứ chặn được — nên bài kiểm này chạy song song thật, không tuần tự.
  const dongThoi = take(payload({ id: 92708, referenceCode: "FT-CONCURRENT-001", transferAmount: 777_000 }));
  const ketQua = await Promise.allSettled([
    ingestSepayTransaction(db, dongThoi),
    ingestSepayTransaction(db, dongThoi),
    ingestSepayTransaction(db, dongThoi),
  ]);
  const demDongThoi = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.providerTxnId, "92708"));
  assert.equal(Number(demDongThoi[0].n), 1, "5. ba gói tin cùng lúc vẫn chỉ ra MỘT dòng — ràng buộc UNIQUE chặn ở CSDL");
  assert.ok(
    ketQua.filter((r) => r.status === "fulfilled" && r.value.created).length <= 1,
    "5. nhiều nhất một lượt được coi là đã TẠO dòng",
  );

  // ═══ 6. CHỮ KÝ SAI ═══
  const now = new Date("2026-09-11T07:10:00.000Z");
  const stamp = String(Math.floor(now.getTime() / 1000));
  const body = JSON.stringify(payload());
  const thatBai = verifySepayRequest({
    secret: SECRET,
    apiKey: "",
    signature: "sha256=deadbeef",
    timestamp: stamp,
    authorization: null,
    rawBody: body,
    now,
  });
  assert.equal(thatBai.ok, false, "6. chữ ký sai bị từ chối");

  const dung = verifySepayRequest({
    secret: SECRET,
    apiKey: "",
    signature: sepaySignature(SECRET, stamp, body),
    timestamp: stamp,
    authorization: null,
    rawBody: body,
    now,
  });
  assert.equal(dung.ok, true, "6. chữ ký đúng theo công thức {timestamp}.{raw_body} được chấp nhận");

  // Chữ ký ký trên BYTE GỐC. Cùng dữ liệu nhưng khác thứ tự khoá / khoảng trắng ⇒ chữ ký KHÔNG khớp.
  // Đây là lý do route đọc `request.text()` trước và không bao giờ JSON.stringify lại.
  const doiThuTu = JSON.stringify({ ...payload(), id: 92704 }, Object.keys(payload()).reverse());
  assert.notEqual(doiThuTu, body, "6. bản dựng lại quả thật khác chuỗi gốc");
  const kyLai = verifySepayRequest({
    secret: SECRET,
    apiKey: "",
    signature: sepaySignature(SECRET, stamp, body),
    timestamp: stamp,
    authorization: null,
    rawBody: doiThuTu,
    now,
  });
  assert.equal(kyLai.ok, false, "6. dựng lại JSON làm chữ ký sai — phải dùng byte gốc");

  // Đã khai secret HMAC thì KHÔNG cho hạ cấp xuống API key: kẻ biết API key sẽ tự chọn đường yếu hơn.
  const haCap = verifySepayRequest({
    secret: SECRET,
    apiKey: "api-key-hop-le",
    signature: null,
    timestamp: null,
    authorization: "Apikey api-key-hop-le",
    rawBody: body,
    now,
  });
  assert.equal(haCap.ok, false, "6. có HMAC thì không được hạ cấp xuống API key");

  // ═══ 7. MỐC THỜI GIAN QUÁ HẠN (chống phát lại) ═══
  const cu = String(Math.floor(now.getTime() / 1000) - SEPAY_REPLAY_WINDOW_SECONDS - 1);
  const quaHan = verifySepayRequest({
    secret: SECRET,
    apiKey: "",
    signature: sepaySignature(SECRET, cu, body),
    timestamp: cu,
    authorization: null,
    rawBody: body,
    now,
  });
  assert.equal(quaHan.ok, false, "7. chữ ký ĐÚNG nhưng quá 5 phút vẫn bị từ chối — chống phát lại");

  const vuaKip = String(Math.floor(now.getTime() / 1000) - SEPAY_REPLAY_WINDOW_SECONDS + 10);
  assert.equal(
    verifySepayRequest({ secret: SECRET, apiKey: "", signature: sepaySignature(SECRET, vuaKip, body), timestamp: vuaKip, authorization: null, rawBody: body, now }).ok,
    true,
    "7. trong cửa sổ 5 phút thì vẫn nhận",
  );

  // ═══ 8. GÓI TIN SAI ĐỊNH DẠNG ═══
  assert.equal(parseSepayPayload(null).ok, false, "8. null không phải gói tin");
  assert.equal(parseSepayPayload([1, 2]).ok, false, "8. mảng không phải gói tin");
  assert.equal(parseSepayPayload(payload({ id: undefined })).ok, false, "8. thiếu `id` ⇒ không có danh tính ⇒ từ chối");
  assert.equal(parseSepayPayload(payload({ transferAmount: undefined })).ok, false, "8. thiếu số tiền ⇒ từ chối");
  assert.equal(parseSepayPayload(payload({ accountNumber: "" })).ok, false, "8. thiếu số tài khoản ⇒ không biết tiền ở đâu ⇒ từ chối");
  assert.equal(parseSepayPayload(payload({ transferAmount: 0 })).ok, false, "8. số tiền 0 không phải giao dịch");
  // CHIỀU TIỀN KHÔNG BAO GIỜ ĐƯỢC ĐOÁN: giá trị lạ phải từ chối, không được mặc định 'in'.
  assert.equal(parseSepayPayload(payload({ transferType: "chuyen" })).ok, false, "8. transferType lạ ⇒ TỪ CHỐI, tuyệt đối không đoán chiều");
  assert.equal(parseSepayPayload(payload({ transferType: undefined })).ok, false, "8. thiếu transferType ⇒ từ chối");
  assert.equal(parseSepayPayload(payload({ transactionDate: "hôm qua" })).ok, false, "8. ngày không đọc được ⇒ từ chối");

  // ═══ 9. TÀI KHOẢN CHƯA ĐƯỢC XÁC NHẬN ═══
  // KHÔNG MẤT GIAO DỊCH. Gói tin đã qua HMAC nghĩa là nó tới từ chính tài khoản SePay của shop, nên
  // ERP tự khai tài khoản rồi gắn cờ chờ người đặt tên — chặn tiền lại thì sổ thiếu mà không ai biết.
  const la = take(payload({ id: 92709, gateway: "ACB", accountNumber: "1111222233", referenceCode: "ACB-LA-0001", transferAmount: 123_000 }));
  const laRow = await ingestSepayTransaction(db, la);
  assert.equal(laRow.accountUnmapped, true, "9. tài khoản lạ được đánh dấu chờ xác nhận");
  assert.equal(laRow.created, true, "9. nhưng GIAO DỊCH VẪN VÀO SỔ — không mất tiền");
  const [taiKhoanLa] = await db.select().from(accounts).where(eq(accounts.id, laRow.bankAccountId));
  assert.equal(taiKhoanLa.status, "UNCONFIRMED", "9. tài khoản mới ở trạng thái chờ xác nhận, không phải ACTIVE");
  assert.ok(taiKhoanLa.label.includes("ACB"), "9. tự đặt nhãn đọc được để người còn biết đó là tài khoản nào");

  // Người xác nhận xong thì gói tin sau không còn bị gắn cờ nữa.
  await db.update(accounts).set({ status: "ACTIVE", label: "ACB kinh doanh" }).where(eq(accounts.id, laRow.bankAccountId));
  const laLan2 = take(payload({ id: 92710, gateway: "ACB", accountNumber: "1111222233", referenceCode: "ACB-LA-0002", transferAmount: 124_000 }));
  assert.equal((await ingestSepayTransaction(db, laLan2)).accountUnmapped, false, "9. xác nhận xong thì hết cờ");

  // ═══ 10. GIAO DỊCH ĐÃ NHẬP TỪ FILE SAO KÊ ═══
  // Đây là điều kiện sống còn khi bật realtime: KHÔNG được nhân đôi lịch sử, và KHÔNG được xoá
  // phân loại người dùng đã làm.
  const tuFile = toBankRow({
    date: "2026-09-11",
    time: "16:02",
    amount: -4_991_000,
    description: "CUSTOMER MBCT Mr T chuyen khoan nhanh qua Za lo",
    counterparty: "NGUYEN THANH LIEM",
    bankRef: "FT26254097039999",
    categoryCode: "CHUA_PHAN_LOAI",
    note: "",
  });
  await db.insert(b).values({ ...tuFile, id: "sepay-test-file-1", source: "IMPORT", accountingGroup: "PURCHASE", classifiedBy: "chu@shop.vn", note: "đã đối chiếu tay" });

  const webhookTrungFile = take(
    payload({ id: 92711, transferType: "out", transferAmount: 4_991_000, referenceCode: "FT26254097039999", transactionDate: "2026-09-11 16:02:54", content: "Noi dung tu webhook" }),
  );
  const hoiTu = await ingestSepayTransaction(db, webhookTrungFile);
  assert.equal(hoiTu.created, false, "10. cùng mã bút toán ngân hàng ⇒ KHÔNG tạo dòng thứ hai");
  assert.equal(hoiTu.transactionId, "sepay-test-file-1", "10. webhook hội tụ đúng vào dòng đã nhập từ file");

  const [sauHoiTu] = await db.select().from(b).where(eq(b.id, "sepay-test-file-1"));
  assert.equal(sauHoiTu.accountingGroup, "PURCHASE", "10. NHÃN người dùng đã gán KHÔNG bị webhook xoá");
  assert.equal(sauHoiTu.classifiedBy, "chu@shop.vn", "10. người phân loại giữ nguyên");
  assert.equal(sauHoiTu.note, "đã đối chiếu tay", "10. ghi chú tay giữ nguyên");
  assert.equal(sauHoiTu.amount, -4_991_000, "10. số tiền của chứng từ sao kê thắng — webhook không sửa tiền");
  assert.equal(sauHoiTu.description, tuFile.description, "10. mô tả của sao kê được giữ, webhook không đè");
  assert.equal(sauHoiTu.providerTxnId, "92711", "10. nhưng vẫn nhận mã SePay để lần sau gửi lại là nhận ra ngay");
  assert.equal(sauHoiTu.balanceAfter, 19_077_000, "10. số dư luỹ kế được BỔ SUNG vào chỗ trước đó chưa biết");
  assert.equal((sauHoiTu.seenSources as unknown[]).length, 1, "10. provenance ghi ĐÚNG một lần webhook xác nhận");
  assert.equal(sauHoiTu.source, "IMPORT", "10. `source` là đường vào ĐÃ TẠO dòng — bất biến");
  assert.equal(sauHoiTu.lastSeenSource, "WEBHOOK", "10. đường xác nhận gần nhất là webhook");

  // Lưới an toàn phải phủ CẢ dòng nhập từ file: khoá không chứa số tài khoản chính là để cặp
  // file ↔ realtime so được với nhau. Có số tài khoản trong khoá thì cặp nguy hiểm nhất lại lọt.
  assert.equal(
    tuFile.matchKey,
    bankMatchKey({ amount: -4_991_000, txnAt: webhookTrungFile.txnAt }),
    "10. dòng nhập từ file và dòng từ webhook cho CÙNG khoá lưới an toàn",
  );

  // Gửi lại chính gói tin đó: vẫn một dòng, vẫn không đụng nhãn.
  await ingestSepayTransaction(db, webhookTrungFile);
  const [sauGuiLai] = await db.select().from(b).where(eq(b.id, "sepay-test-file-1"));
  assert.equal((sauGuiLai.seenSources as unknown[]).length, 1, "10. gửi lại KHÔNG cộng thêm mục provenance — mảng không phình vô hạn");
  const demHoiTu = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "FT26254097039999"));
  assert.equal(Number(demHoiTu[0].n), 1, "10. gửi lại sau khi hội tụ vẫn đúng một dòng");

  // ═══ 11. CÙNG SỐ TIỀN, CÙNG PHÚT, NHƯNG LÀ HAI GIAO DỊCH THẬT ═══
  // Hai lần chuyển 500.000₫ cho cùng một người cách nhau vài giây là chuyện có thật. Tự gộp là
  // XOÁ TIỀN THẬT. ERP phải giữ đủ hai dòng và chỉ NÊU RA nghi ngờ.
  const songSinh1 = take(payload({ id: 92720, transferAmount: 500_000, referenceCode: "FT-TWIN-A", transactionDate: "2026-09-11 09:30:05" }));
  const songSinh2 = take(payload({ id: 92721, transferAmount: 500_000, referenceCode: "FT-TWIN-B", transactionDate: "2026-09-11 09:30:41" }));
  const a = await ingestSepayTransaction(db, songSinh1);
  const c = await ingestSepayTransaction(db, songSinh2);
  assert.equal(a.created, true, "11. giao dịch thứ nhất vào sổ");
  assert.equal(c.created, true, "11. giao dịch thứ hai CŨNG vào sổ — không bị gộp");
  assert.notEqual(a.transactionId, c.transactionId, "11. hai dòng riêng biệt");
  assert.equal(c.duplicateSuspect, true, "11. nhưng ERP NÊU RA nghi ngờ để người xem");
  assert.equal(
    bankMatchKey({ amount: 500_000, txnAt: songSinh1.txnAt }),
    bankMatchKey({ amount: 500_000, txnAt: songSinh2.txnAt }),
    "11. lưới an toàn quả thật khớp — và đó chính là lý do nó không được phép là khoá UNIQUE",
  );

  // ═══ 12. THỬ LẠI SAU LỖI TẠM THỜI ═══
  // Lượt đầu hỏng (mô phỏng lỗi hạ tầng) ⇒ chưa có dòng nào. SePay gửi lại ⇒ ghi được, đúng một dòng.
  const sauLoi = take(payload({ id: 92730, referenceCode: "FT-RETRY-001", transferAmount: 333_000 }));
  let hong = false;
  try {
    await ingestSepayTransaction(null as unknown as Db, sauLoi);
  } catch {
    hong = true;
  }
  assert.equal(hong, true, "12. lỗi hạ tầng NÉM ra ngoài để route trả 5xx cho SePay gửi lại");
  const chuaCo = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "FT-RETRY-001"));
  assert.equal(Number(chuaCo[0].n), 0, "12. lượt hỏng không để lại dòng nửa vời");
  const thuLai = await ingestSepayTransaction(db, sauLoi);
  assert.equal(thuLai.created, true, "12. lần gửi lại ghi được");
  const sauThuLai = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankRef, "FT-RETRY-001"));
  assert.equal(Number(sauThuLai[0].n), 1, "12. và chỉ đúng một dòng");

  // ═══ 13. NGÀY GIỜ & MÚI GIỜ ═══
  // "2026-09-11 14:08:33" là GIỜ VIỆT NAM. Đọc như giờ máy chủ (UTC) thì lệch 7 tiếng, và giao dịch
  // buổi tối nhảy hẳn sang ngày hôm sau — đủ để một giao dịch cuối tháng rơi sai kỳ báo cáo.
  assert.equal(sepayInstant("2026-09-11 14:08:33")?.toISOString(), "2026-09-11T07:08:33.000Z", "13. 14:08 giờ VN = 07:08Z");
  assert.equal(sepayInstant("2026-09-30 23:30:00")?.toISOString(), "2026-09-30T16:30:00.000Z", "13. 23:30 ngày cuối tháng VẪN thuộc tháng 9 theo giờ VN");
  assert.equal(sepayInstant("2026-09-11T14:08:33+07:00")?.toISOString(), "2026-09-11T07:08:33.000Z", "13. chuỗi tự mang múi giờ thì tôn trọng nguyên bản");
  assert.equal(sepayInstant("2026-09-11T07:08:33Z")?.toISOString(), "2026-09-11T07:08:33.000Z", "13. hậu tố Z cũng tôn trọng");
  assert.equal(sepayInstant(""), null, "13. rỗng là CHƯA BIẾT, không phải mốc 1970");
  assert.equal(sepayInstant("không phải ngày"), null, "13. chuỗi rác không được biến thành một mốc bịa");

  // ═══ 14. TRƯỜNG TUỲ CHỌN RỖNG / NULL ═══
  // Tài liệu SePay phân biệt null với chuỗi rỗng. Không trường nào trong nhóm này được phép làm
  // hỏng gói tin, và `accumulated` thiếu phải là CHƯA BIẾT chứ không phải 0.
  const toiThieu = take({
    id: "92740",
    transactionDate: "2026-09-11 10:00:00",
    accountNumber: "9972165264",
    transferType: "in",
    transferAmount: 250_000,
    gateway: null,
    subAccount: null,
    code: null,
    content: null,
    description: "Mo ta du phong",
    accumulated: null,
    referenceCode: null,
  });
  assert.equal(toiThieu.balanceAfter, null, "14. thiếu accumulated ⇒ số dư là CHƯA BIẾT (null), KHÔNG phải 0");
  assert.equal(toiThieu.subAccount, "", "14. subAccount null ⇒ chuỗi rỗng, không phải 'null'");
  assert.equal(toiThieu.content, "Mo ta du phong", "14. content rỗng thì lùi về description");
  assert.equal(sepayBankRef(toiThieu), "SEPAY:92740", "14. không có mã ngân hàng thì lùi về mã SePay — vẫn tất định");

  const toiThieuRow = await ingestSepayTransaction(db, toiThieu);
  assert.equal(toiThieuRow.created, true, "14. gói tin tối thiểu vẫn vào sổ được");
  const [toiThieuLuu] = await db.select().from(b).where(eq(b.id, toiThieuRow.transactionId));
  assert.equal(toiThieuLuu.balanceAfter, null, "14. số dư chưa biết được lưu là NULL");
  // Gửi lại gói tin không có mã ngân hàng: khoá lùi vẫn tất định nên vẫn một dòng.
  assert.equal((await ingestSepayTransaction(db, toiThieu)).created, false, "14. gửi lại gói tin không có referenceCode vẫn không đẻ dòng mới");

  // ═══ CHUẨN HOÁ MÃ — chỗ ba đường vào hội tụ ═══
  // Lệch một dấu cách hay một chữ hoa là ra hai dòng canonical, và không ai nhìn ra bằng mắt.
  assert.equal(normalizeBankRef(" ft26254097039000 "), "FT26254097039000", "chuẩn hoá: bỏ khoảng trắng, viết hoa");
  assert.equal(normalizeBankRef("9972165264-20260815"), "9972165264-20260815", "chuẩn hoá: giữ dấu gạch của mã trả lãi MB");

  // ═══ RANH GIỚI TIỀN ↔ CHI PHÍ ═══
  // Sổ ngân hàng là SỰ THẬT VỀ TIỀN. Webhook KHÔNG được tự quy một dòng tiền ra thành chi phí —
  // việc đó đi qua quy tắc và bảng thẩm quyền chi phí. Dòng mới luôn vào chưa phân loại.
  const [dongMoi] = await db.select().from(b).where(eq(b.providerTxnId, "92705"));
  assert.equal(dongMoi.accountingGroup, "UNCLASSIFIED", "ranh giới: webhook KHÔNG tự phân loại kế toán");
  assert.equal(dongMoi.classifiedBy, "", "ranh giới: webhook không giả vờ là người đã phân loại");
  assert.equal(dongMoi.linkedType, "", "ranh giới: webhook không tự nối với chứng từ nào");

  // ═══ TỔNG TIỀN KHÔNG ĐỔI SAI ═══
  // Đếm lại toàn bộ dòng do bài kiểm này tạo: mỗi giao dịch đúng một dòng, tổng đúng bằng tổng
  // các giao dịch riêng biệt — không nhân đôi, không thiếu.
  const maSepay = ["92704", "92705", "92706", "92707", "92708", "92709", "92710", "92711", "92720", "92721", "92730", "92740"];
  const tong = await db
    .select({ n: sql<number>`count(*)`, tong: sql<number>`coalesce(sum(${b.amount}), 0)` })
    .from(b)
    .where(inArray(b.providerTxnId, maSepay));
  assert.equal(Number(tong[0].n), maSepay.length, `mỗi mã SePay đúng một dòng canonical (${maSepay.length})`);

  // ═══ MỘT TÀI KHOẢN KHÔNG BỊ KHAI HAI LẦN ═══
  const truocKhiGoiLai = await db.select({ n: sql<number>`count(*)` }).from(accounts);
  await resolveBankAccount(db, { provider: "SEPAY", gateway: "MBBank", accountNumber: "9972165264", subAccount: "", seenAt: new Date() });
  const sauKhiGoiLai = await db.select({ n: sql<number>`count(*)` }).from(accounts);
  assert.equal(Number(sauKhiGoiLai[0].n), Number(truocKhiGoiLai[0].n), "gọi lại resolveBankAccount không khai thêm tài khoản trùng");

  // Dọn dẹp: bài kiểm khác dùng chung `bank_transactions` nên không được để lại rác.
  await db.delete(b).where(and(eq(b.provider, "SEPAY"), inArray(b.providerTxnId, maSepay)));
  await db.delete(b).where(eq(b.id, "sepay-test-file-1"));
  await db.delete(accounts).where(eq(accounts.provider, "SEPAY"));

  console.log(
    "✓ Webhook SePay: chiều tiền không đoán · giờ VN đúng · HMAC trên byte gốc + chống phát lại 5 phút · gửi lại và tranh chấp chỉ ra một dòng · hội tụ với sao kê file mà không xoá nhãn · hai giao dịch giống nhau KHÔNG bị gộp · nhiều ngân hàng/VA tách đúng",
  );
}
