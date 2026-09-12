import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { schema } from "@/db";
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, resolvePermissions } from "@/lib/auth/permissions";
import { can, type SessionUser } from "@/lib/auth/session";
import { collectCandidates } from "@/lib/alerts/rules";
import { BANK_ACCOUNT_STATUSES, BANK_ACCOUNT_STATUS_LABEL, BANK_TABS, BANK_TAB_LABEL, maskAccountNumber } from "@/lib/constants/bank";
import { ingestSepayTransaction, resolveBankAccount } from "@/lib/integrations/bank/sepay-ingest";
import { parseSepayPayload } from "@/lib/integrations/bank/sepay";
import { listBankAccounts, sepayLastReconciliation, unconfirmedBankAccountCount } from "@/lib/queries/bank";

/**
 * ═══════ TÀI KHOẢN NGÂN HÀNG: XÁC NHẬN, NGỪNG DÙNG, VÀ THỨ KHÔNG ĐƯỢC ĐỤNG ═══════
 *
 * Màn hình này chạm vào ranh giới nguy hiểm nhất của cả module: nó là CẤU HÌNH (tài khoản nào được
 * công nhận) nằm ngay cạnh CHỨNG TỪ (tiền đã vào sổ). Trộn hai thứ đó lại là cách một thao tác đổi
 * nhãn vô tình viết lại lịch sử tiền.
 *
 * Nên bài kiểm này canh bốn điều, và cả bốn đều là "sai thì mất tiền, không phải sai thì xấu":
 *   1. KHÔNG đường tự động nào được đặt `ACTIVE` — xác nhận là việc của con người;
 *   2. đổi trạng thái KHÔNG đụng một giao dịch nào, kể cả khi ngừng dùng tài khoản;
 *   3. tài khoản chưa xác nhận VẪN nhận giao dịch đầy đủ — không mất gói tin nào;
 *   4. sau khi xác nhận, webhook tiếp theo map đúng tài khoản cũ, không đẻ tài khoản thứ hai.
 */

function payload(over: Record<string, unknown> = {}) {
  const p = {
    id: 90001,
    gateway: "MBBank",
    transactionDate: "2026-09-12 08:00:00",
    accountNumber: "9972165264",
    subAccount: null,
    content: "Giao dich kiem thu",
    transferType: "in",
    transferAmount: 150_000,
    accumulated: 0,
    referenceCode: "FT-ACC-0001",
    ...over,
  };
  const parsed = parseSepayPayload(p);
  assert.ok(parsed.ok, `gói tin phải đọc được: ${parsed.ok ? "" : parsed.error}`);
  return parsed.txn;
}

export async function testBankAccounts(db: Db) {
  const a = schema.bankAccounts;
  const b = schema.bankTransactions;

  // ═══ 1. QUYỀN ═══
  // Quyền xác nhận tài khoản CỐ Ý tách khỏi `bank:write`: kế toán nhập sao kê hằng ngày không được
  // tự quyết định tài khoản nào của shop.
  assert.ok((ALL_PERMISSIONS as string[]).includes("bank:accounts"), "1. quyền `bank:accounts` có trong ma trận");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.ADMIN.includes("bank:accounts"), "1. ADMIN có quyền xác nhận tài khoản");
  assert.ok(DEFAULT_ROLE_PERMISSIONS.MANAGER.includes("bank:accounts"), "1. MANAGER có quyền xác nhận tài khoản");
  assert.ok(
    !DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("bank:accounts"),
    "1. KẾ TOÁN mặc định KHÔNG có — nhập sao kê là một việc, công nhận một tài khoản ngân hàng là việc khác",
  );
  assert.ok(DEFAULT_ROLE_PERMISSIONS.ACCOUNTANT.includes("bank:write"), "1. nhưng kế toán vẫn nhập & phân loại được như cũ");
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.VIEWER.includes("bank:accounts"), "1. VIEWER không có");
  assert.ok(!DEFAULT_ROLE_PERMISSIONS.CS.includes("bank:accounts"), "1. CSKH không có");

  // ═══ 2. TAB MỚI CÓ THẬT VÀ CÓ NHÃN TIẾNG VIỆT ═══
  assert.ok((BANK_TABS as readonly string[]).includes("tai-khoan"), "2. tab `tai-khoan` có trong danh sách");
  assert.equal(BANK_TAB_LABEL["tai-khoan"], "Tài khoản ngân hàng", "2. tab có nhãn tiếng Việt");
  // Tab cũ KHÔNG được biến mất — thêm màn hình không phải lý do để bỏ màn hình đang dùng.
  for (const cu of ["giao-dich", "doi-khop", "nhap-sao-ke", "quy-tac", "doi-chieu"]) {
    assert.ok((BANK_TABS as readonly string[]).includes(cu), `2. tab cũ \`${cu}\` vẫn còn`);
  }

  // ═══ 3. CHE SỐ TÀI KHOẢN ═══
  assert.equal(maskAccountNumber("9972165264"), "******5264", "3. chỉ hiện 4 số cuối");
  assert.equal(maskAccountNumber("1234"), "1234", "3. số quá ngắn thì không che nổi — hiện nguyên");
  assert.equal(maskAccountNumber(""), "—", "3. rỗng hiện gạch ngang, không hiện chuỗi rỗng");
  assert.ok(!maskAccountNumber("9972165264").includes("997216"), "3. phần đầu số tài khoản KHÔNG lọt ra màn hình");

  // ═══ 4. WEBHOOK TỰ KHAI TÀI KHOẢN — NHƯNG KHÔNG BAO GIỜ TỰ ACTIVE ═══
  const lan1 = await ingestSepayTransaction(db, payload());
  assert.equal(lan1.created, true, "4. giao dịch vào sổ");
  assert.equal(lan1.accountUnmapped, true, "4. tài khoản mới được gắn cờ chờ xác nhận");
  const [tkMoi] = await db.select().from(a).where(eq(a.id, lan1.bankAccountId));
  assert.equal(tkMoi.status, "UNCONFIRMED", "4. TUYỆT ĐỐI không tự đặt ACTIVE — xác nhận là việc của con người");
  assert.ok(tkMoi.label.includes("MBBank"), "4. tự đặt nhãn đọc được để người còn biết đó là tài khoản nào");
  assert.equal(await unconfirmedBankAccountCount(), 1, "4. đếm đúng số tài khoản chờ xác nhận — con số hiện trên tab");

  // ═══ 5. CHƯA XÁC NHẬN VẪN NHẬN ĐỦ GIAO DỊCH ═══
  // Đây là điều kiện sống còn: chặn tiền lại để chờ người "map" thì sổ thiếu mà không ai biết.
  await ingestSepayTransaction(db, payload({ id: 90002, referenceCode: "FT-ACC-0002", transferAmount: 250_000 }));
  await ingestSepayTransaction(db, payload({ id: 90003, referenceCode: "FT-ACC-0003", transferType: "out", transferAmount: 70_000 }));
  const [demChuaXacNhan] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankAccountId, lan1.bankAccountId));
  assert.equal(Number(demChuaXacNhan.n), 3, "5. tài khoản CHƯA xác nhận vẫn nhận đủ 3 giao dịch — không mất gói tin nào");

  // ═══ 6. SỐ LIỆU TRÊN MÀN HÌNH ═══
  const dsTruoc = await listBankAccounts();
  const dong = dsTruoc.find((x) => x.id === lan1.bankAccountId);
  assert.ok(dong, "6. tài khoản có mặt trong danh sách");
  assert.equal(dong.soGiaoDich, 3, "6. đếm đúng số giao dịch");
  assert.equal(dong.tienVao, 400_000, "6. cộng đúng tiền vào (150.000 + 250.000)");
  assert.equal(dong.tienRa, 70_000, "6. cộng đúng tiền ra");
  assert.equal(dong.gateway, "MBBank", "6. hiện đúng ngân hàng");
  assert.ok(dong.lanVaoGanNhat && dong.lanRaGanNhat, "6. có mốc giao dịch gần nhất mỗi chiều");
  assert.equal(dsTruoc[0].status, "UNCONFIRMED", "6. tài khoản chờ xác nhận xếp lên ĐẦU — đó là việc cần làm, không phải tin để đọc cho biết");

  // ═══ 7. XÁC NHẬN: ĐỔI TRẠNG THÁI, KHÔNG ĐỤNG MỘT GIAO DỊCH NÀO ═══
  const truocKhiXacNhan = await db
    .select({ n: sql<number>`count(*)`, tong: sql<number>`coalesce(sum(${b.amount}), 0)` })
    .from(b);

  await db.update(a).set({ label: "MB kinh doanh", status: "ACTIVE", updatedAt: new Date() }).where(eq(a.id, lan1.bankAccountId));

  const sauKhiXacNhan = await db
    .select({ n: sql<number>`count(*)`, tong: sql<number>`coalesce(sum(${b.amount}), 0)` })
    .from(b);
  assert.equal(Number(sauKhiXacNhan[0].n), Number(truocKhiXacNhan[0].n), "7. xác nhận tài khoản KHÔNG đổi số dòng trong sổ");
  assert.equal(Number(sauKhiXacNhan[0].tong), Number(truocKhiXacNhan[0].tong), "7. và KHÔNG đổi một đồng nào");
  assert.equal(await unconfirmedBankAccountCount(), 0, "7. cảnh báo tắt sau khi xác nhận");

  // ═══ 8. SAU KHI ACTIVE, WEBHOOK TIẾP THEO MAP ĐÚNG TÀI KHOẢN CŨ ═══
  const sauActive = await ingestSepayTransaction(db, payload({ id: 90004, referenceCode: "FT-ACC-0004", transferAmount: 999_000 }));
  assert.equal(sauActive.bankAccountId, lan1.bankAccountId, "8. map đúng tài khoản cũ, KHÔNG đẻ tài khoản thứ hai");
  assert.equal(sauActive.accountUnmapped, false, "8. hết cờ chờ xác nhận");
  assert.equal(sauActive.created, true, "8. giao dịch mới vẫn vào sổ bình thường");
  const [demTaiKhoan] = await db.select({ n: sql<number>`count(*)` }).from(a).where(eq(a.accountNumber, "9972165264"));
  assert.equal(Number(demTaiKhoan.n), 1, "8. vẫn đúng MỘT tài khoản cho một số tài khoản");

  // Giao dịch CŨ không bị đụng tới khi trạng thái đổi.
  const [cuNhat] = await db.select().from(b).where(eq(b.providerTxnId, "90001"));
  assert.equal(cuNhat.amount, 150_000, "8. giao dịch cũ giữ nguyên số tiền");
  assert.equal(cuNhat.bankAccountId, lan1.bankAccountId, "8. giao dịch cũ vẫn trỏ đúng tài khoản");

  // ═══ 9. NGỪNG DÙNG: KHÔNG XOÁ, KHÔNG ẨN, KHÔNG CHẶN TIỀN ═══
  // Tiền đã vào sổ là CHỨNG TỪ; trạng thái tài khoản là CẤU HÌNH. Một nhãn cấu hình không được phép
  // làm mất dữ liệu tiền.
  await db.update(a).set({ status: "DISABLED", updatedAt: new Date() }).where(eq(a.id, lan1.bankAccountId));
  const [sauDisable] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankAccountId, lan1.bankAccountId));
  assert.equal(Number(sauDisable.n), 4, "9. ngừng dùng KHÔNG xoá giao dịch đã có");

  const khiDaNgung = await ingestSepayTransaction(db, payload({ id: 90005, referenceCode: "FT-ACC-0005", transferAmount: 11_000 }));
  assert.equal(khiDaNgung.created, true, "9. gói tin đã qua HMAC vẫn được GHI dù tài khoản mang nhãn ngừng dùng — mất tiền vì một nhãn là hậu quả tệ hơn");
  assert.equal(khiDaNgung.bankAccountId, lan1.bankAccountId, "9. vẫn map đúng tài khoản, không đẻ tài khoản mới");

  // ═══ 10. TRẠNG THÁI HỢP LỆ ĐỀU CÓ NHÃN TIẾNG VIỆT ═══
  for (const s of BANK_ACCOUNT_STATUSES) {
    assert.ok(BANK_ACCOUNT_STATUS_LABEL[s]?.length, `10. trạng thái ${s} có nhãn tiếng Việt`);
  }

  // ═══ 11. TÀI KHOẢN KHÁC NHAU KHÔNG BỊ GỘP ═══
  const vcb = await ingestSepayTransaction(db, payload({ id: 90010, gateway: "Vietcombank", accountNumber: "0011004218076", referenceCode: "FT-ACC-VCB" }));
  assert.notEqual(vcb.bankAccountId, lan1.bankAccountId, "11. ngân hàng khác ⇒ tài khoản nội bộ khác");
  const va = await ingestSepayTransaction(db, payload({ id: 90011, subAccount: "VA99", referenceCode: "FT-ACC-VA" }));
  assert.notEqual(va.bankAccountId, lan1.bankAccountId, "11. tài khoản ảo tách khỏi tài khoản gốc");

  // `resolveBankAccount` gọi lại không khai thêm tài khoản trùng.
  const truocGoiLai = await db.select({ n: sql<number>`count(*)` }).from(a);
  await resolveBankAccount(db, { provider: "SEPAY", gateway: "MBBank", accountNumber: "9972165264", subAccount: "", seenAt: new Date() });
  const sauGoiLai = await db.select({ n: sql<number>`count(*)` }).from(a);
  assert.equal(Number(sauGoiLai[0].n), Number(truocGoiLai[0].n), "11. gọi lại không khai thêm tài khoản trùng");

  // ═══ 12. HAI TÀI KHOẢN KHÁC NHAU CÙNG MỘT NGÂN HÀNG KHÔNG BỊ GỘP ═══
  // Test 11 đã tách theo NGÂN HÀNG KHÁC (Vietcombank) và theo TÀI KHOẢN ẢO (VA). Trường hợp phổ
  // biến hơn cả trong thực tế lại là trường hợp còn thiếu: hai tài khoản MBBank THẬT, số khác nhau,
  // của cùng một shop (ví dụ một tài khoản kinh doanh, một tài khoản nhận COD riêng).
  const mb2 = await ingestSepayTransaction(db, payload({ id: 90012, accountNumber: "8888777766", referenceCode: "FT-ACC-MB2", transferAmount: 500_000 }));
  assert.notEqual(mb2.bankAccountId, lan1.bankAccountId, "12. cùng ngân hàng nhưng khác số tài khoản ⇒ tài khoản nội bộ khác");
  assert.equal(mb2.accountUnmapped, true, "12. tài khoản MBBank thứ hai cũng phải tự chờ xác nhận riêng, không thừa hưởng trạng thái của tài khoản MBBank thứ nhất");
  const soMBBank = (await listBankAccounts()).filter((x) => x.gateway === "MBBank").length;
  assert.equal(soMBBank, 3, "12. có đúng 3 tài khoản mang gateway MBBank: tài khoản gốc, tài khoản ảo (VA99), và tài khoản số khác này — không cái nào bị gộp vào cái nào");

  // ═══ 13. "CHƯA PHÂN LOẠI" ĐẾM ĐÚNG THEO TỪNG TÀI KHOẢN, KHÔNG PHẢI CẢ SỔ ═══
  // `unclassifiedBankCount()` đã trả lời "cả sổ còn bao nhiêu dòng chưa phân loại". Nhưng màn hình
  // Tài khoản ngân hàng cần trả lời một câu khác: TÀI KHOẢN NÀO đang tồn việc — không có con số
  // riêng này thì hai tài khoản đều tồn đọng như nhau trên giao diện dù một cái nặng hơn hẳn.
  await db.update(b).set({ accountingGroup: "COD_SETTLEMENT", classifiedBy: "test@shop", classifiedAt: new Date() }).where(sql`${b.providerTxnId} in ('90001','90002')`);
  const dsSauPhanLoai = await listBankAccounts();
  const dongLan1SauPhanLoai = dsSauPhanLoai.find((x) => x.id === lan1.bankAccountId);
  assert.equal(dongLan1SauPhanLoai?.soGiaoDich, 5, "13. tổng giao dịch không đổi — phân loại không xoá dòng nào");
  assert.equal(dongLan1SauPhanLoai?.chuaPhanLoai, 3, "13. còn đúng 3/5 dòng CHƯA phân loại sau khi gán nhãn cho 2 dòng");
  const dongMb2 = dsSauPhanLoai.find((x) => x.id === mb2.bankAccountId);
  assert.equal(dongMb2?.chuaPhanLoai, 1, "13. tài khoản MBBank thứ hai có đúng 1 dòng, vẫn CHƯA phân loại — không bị đếm nhầm sang tài khoản khác");

  // ═══ 14. NGỪNG DÙNG RỒI DÙNG LẠI (RE-ENABLE) ═══
  // Luật nghiệp vụ không cấm dùng lại một tài khoản đã ngừng dùng. `updateBankAccount` xem trạng
  // thái nào cũng chuyển được sang trạng thái khác — nút "Xác nhận" trên giao diện hiện lại bất cứ
  // khi nào trạng thái khác ACTIVE, kể cả DISABLED. Bài kiểm này khoá đúng hành vi đó.
  const [truocKhiBatLai] = await db.select().from(a).where(eq(a.id, lan1.bankAccountId));
  assert.equal(truocKhiBatLai.status, "DISABLED", "14. tài khoản đang ở trạng thái NGỪNG DÙNG từ bước 9 — đúng điều kiện cần trước khi bật lại");
  // Ở bước này còn hai tài khoản KHÁC (vcb, mb2) đang thật sự UNCONFIRMED, nên không thể so với 0 —
  // canh đúng điều cần canh: bật lại một tài khoản ĐÃ TỪNG XÁC NHẬN không được đổi số đếm đó.
  const dangChoTruocKhiBatLai = await unconfirmedBankAccountCount();
  await db.update(a).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(a.id, lan1.bankAccountId));
  const [sauKhiBatLai] = await db.select().from(a).where(eq(a.id, lan1.bankAccountId));
  assert.equal(sauKhiBatLai.status, "ACTIVE", "14. bật lại (re-enable) thành công");
  assert.equal(await unconfirmedBankAccountCount(), dangChoTruocKhiBatLai, "14. bật lại một tài khoản ĐÃ TỪNG xác nhận (không phải UNCONFIRMED) không làm đổi số tài khoản đang chờ xác nhận của CÁC tài khoản khác");
  const [demSauBatLai] = await db.select({ n: sql<number>`count(*)` }).from(b).where(eq(b.bankAccountId, lan1.bankAccountId));
  assert.equal(Number(demSauBatLai.n), 5, "14. bật lại không xoá và không đẻ thêm giao dịch nào");
  const khiDaBatLai = await ingestSepayTransaction(db, payload({ id: 90013, referenceCode: "FT-ACC-0006", transferAmount: 321_000 }));
  assert.equal(khiDaBatLai.bankAccountId, lan1.bankAccountId, "14. sau khi bật lại, giao dịch mới vẫn map đúng tài khoản cũ");
  assert.equal(khiDaBatLai.accountUnmapped, false, "14. tài khoản đang ACTIVE nên giao dịch mới không mang cờ chờ xác nhận");

  // ═══ 15. `can()` TỪ CHỐI THẬT — KHÔNG CHỈ KHAI BÁO TRONG MA TRẬN ═══
  // Test 1 khoá bảng MA TRẬN quyền mặc định (dữ liệu tĩnh). Ở đây gọi THẲNG hàm `can()` — đúng hàm
  // mà `guardAccounts()` trong lib/actions/bank.ts dùng để chặn — với người dùng giả lập.
  // KHÔNG gọi trực tiếp `updateBankAccount()` được trong môi trường bài kiểm này vì nó bắt đầu bằng
  // `requireUser()`, hàm đọc cookie phiên đăng nhập qua `next/headers` — chỉ có trong một request
  // Next.js thật, không có trong tiến trình `tsx` chạy thẳng bài kiểm. `can()` là hàm thuần nên kiểm
  // được ngay, và đó chính xác là đoạn quyết định "được phép" hay "Không có quyền" bên trong action.
  const ketToanGia: SessionUser = { id: "test-accountant", email: "ketoan@shop.test", name: "Kế toán", role: "ACCOUNTANT", permissions: resolvePermissions("ACCOUNTANT", null) };
  const quanTriGia: SessionUser = { id: "test-admin", email: "admin@shop.test", name: "Admin", role: "ADMIN", permissions: resolvePermissions("ADMIN", null) };
  assert.equal(can(ketToanGia, "bank:accounts"), false, "15. kế toán bị TỪ CHỐI xác nhận tài khoản qua đúng hàm guardAccounts() dùng");
  assert.equal(can(ketToanGia, "bank:write"), true, "15. nhưng kế toán vẫn nhập & phân loại sao kê được như cũ");
  assert.equal(can(quanTriGia, "bank:accounts"), true, "15. admin được phép xác nhận tài khoản");

  // ═══ 16. TÀI KHOẢN MỚI CHỜ XÁC NHẬN PHẢI SINH VIỆC TRONG HÀNG ĐỢI CẢNH BÁO ═══
  // Trước đây tài khoản mới chỉ có MỘT dòng cảnh báo THỤ ĐỘNG trên chính trang Tài khoản ngân hàng —
  // ai không mở tab đó thì không bao giờ biết có việc đang chờ. `vcb` (tạo ở bước 11) vẫn UNCONFIRMED.
  const { candidates: truocXacNhanVcb } = await collectCandidates();
  const viecVcb = truocXacNhanVcb.find((c) => c.dedupeKey === `bank-account-unconfirmed:${vcb.bankAccountId}`);
  assert.ok(viecVcb, "16. tài khoản Vietcombank chưa xác nhận phải sinh MỘT việc trong hàng đợi cảnh báo");
  assert.equal(viecVcb?.kind, "BANK_ACCOUNT_UNCONFIRMED", "16. đúng loại việc");
  assert.equal(viecVcb?.href, "/bank?tab=tai-khoan", "16. việc dẫn thẳng tới màn hình xác nhận");

  await db.update(a).set({ status: "ACTIVE", updatedAt: new Date() }).where(eq(a.id, vcb.bankAccountId));
  const { candidates: sauXacNhanVcb } = await collectCandidates();
  assert.ok(
    !sauXacNhanVcb.some((c) => c.dedupeKey === `bank-account-unconfirmed:${vcb.bankAccountId}`),
    "16. sau khi xác nhận, tài khoản không còn sinh việc mới — lượt quét thật (evaluateAlerts) sẽ tự đóng việc cũ vì khoá này không còn trong danh sách ứng viên",
  );

  // ═══ 17. CANH Ở MỨC MÃ NGUỒN ═══
  //
  // Ba điều dưới đây KHÔNG bài kiểm chạy nào bắt được, vì chúng chỉ sai khi ai đó sửa mã về sau:
  // đổi guard sang `bank:write`, hoặc cho action đổi trạng thái đụng vào bảng giao dịch. Cả hai đều
  // chạy trơn tru và xanh hết mọi bài kiểm hành vi — chỉ có người đọc mã mới thấy.
  const nguonAction = readFileSync(path.join(__dirname, "..", "lib/actions/bank.ts"), "utf8");
  const than = nguonAction.slice(nguonAction.indexOf("async function guardAccounts"), nguonAction.indexOf("// ───────────────────────── Phân loại"));
  assert.ok(than.length > 200, "17. tìm được khối tài khoản trong lib/actions/bank.ts");

  assert.ok(
    /can\(\s*user\s*,\s*"bank:accounts"\s*\)/.test(than),
    "17. action phải hỏi ĐÚNG quyền `bank:accounts` — không được hạ xuống `bank:write`",
  );
  assert.ok(
    !/bankTransactions/.test(than),
    "17. action đổi trạng thái tài khoản KHÔNG được nhắc tới `bankTransactions`: cấu hình không được viết lại chứng từ tiền",
  );
  assert.ok(/audit\(/.test(than), "17. mọi thay đổi phải ghi nhật ký — ai làm, lúc nào, đổi từ gì sang gì");
  assert.ok(/before:/.test(than) && /after:/.test(than), "17. nhật ký phải ghi CẢ giá trị trước và sau");
  assert.ok(
    /maskAccountNumber\(/.test(than),
    "17. số tài khoản trong nhật ký phải được che — nhật ký cũng là chỗ người khác đọc được",
  );

  // Đường ghi tự động KHÔNG BAO GIỜ được đặt ACTIVE. Đây là lời hứa lớn nhất của cả màn hình này,
  // và nó nằm ở một dòng duy nhất trong `sepay-ingest.ts` — dễ sửa nhầm, khó thấy khi sửa nhầm.
  const nguonIngest = readFileSync(path.join(__dirname, "..", "lib/integrations/bank/sepay-ingest.ts"), "utf8");
  assert.ok(/status:\s*"UNCONFIRMED"/.test(nguonIngest), "17. webhook khai tài khoản mới với trạng thái UNCONFIRMED");
  assert.ok(
    !/status:\s*"ACTIVE"/.test(nguonIngest),
    "17. KHÔNG dòng nào trong đường ghi tự động được đặt ACTIVE — xác nhận là việc của con người",
  );

  // ═══ 18. ĐỐI CHIẾU API SEPAY: CHƯA CHẠY LÀ `null`, KHÔNG PHẢI MỘT MỐC GIẢ ═══
  // Đối chiếu quét TOÀN BỘ giao dịch của mọi tài khoản SePay trong MỘT lượt (không tách theo từng
  // tài khoản) — nên đây là mốc DÙNG CHUNG. `null` khi chưa từng chạy phải giữ nguyên là `null`,
  // không được suy diễn thành "vừa chạy xong" hay hiện một ngày bất kỳ.
  assert.equal(await sepayLastReconciliation(), null, "18. chưa từng chạy `sepay_reconcile` thì phải trả về null, không phải một mốc giả");
  const mocDoiChieu = new Date("2026-09-12T02:00:00Z");
  await db.insert(schema.syncRuns).values({ source: "SEPAY", job: "sepay_reconcile", status: "OK", trigger: "MANUAL", actor: "test", startedAt: mocDoiChieu, finishedAt: mocDoiChieu, detail: "test" });
  const ganNhat = await sepayLastReconciliation();
  assert.ok(ganNhat, "18. có lượt chạy đã hoàn tất thì phải đọc ra được");
  assert.equal(ganNhat?.finishedAt.getTime(), mocDoiChieu.getTime(), "18. đúng mốc của lượt chạy gần nhất");
  assert.equal(ganNhat?.status, "OK", "18. đọc đúng trạng thái của lượt chạy");
  await db.delete(schema.syncRuns).where(sql`${schema.syncRuns.source} = 'SEPAY' and ${schema.syncRuns.job} = 'sepay_reconcile'`);

  // Dọn dẹp — bài kiểm khác dùng chung bảng.
  await db.delete(b).where(sql`${b.providerTxnId} in ('90001','90002','90003','90004','90005','90010','90011','90012','90013')`);
  await db.delete(a).where(eq(a.provider, "SEPAY"));

  console.log(
    "✓ Tài khoản ngân hàng: quyền xác nhận tách khỏi quyền nhập sao kê · webhook KHÔNG bao giờ tự ACTIVE · chưa xác nhận vẫn nhận đủ giao dịch · đổi trạng thái không đụng một đồng nào · ngừng dùng không xoá và không chặn tiền · bật lại dùng được bình thường · số tài khoản che còn 4 số cuối · chưa phân loại đếm đúng theo từng tài khoản · tài khoản mới chờ xác nhận sinh việc actionable trong hàng đợi cảnh báo",
  );
}
