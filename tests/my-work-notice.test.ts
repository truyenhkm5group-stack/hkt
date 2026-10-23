/**
 * «Việc của tôi» khi một phần nguồn chưa có số (OD-UX-05 mục 2, 24/10/2026). Đo production 23/10: lượt nguội 4/14 nguồn chạm hạn
 * 2,5 s, trả 0 việc, và trang vẫn in «Không còn việc nào được giao cho bạn.» + «Hàng đợi trống». CHƯA BIẾT ≠ 0 (AGENTS 42).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { myWorkNotice } from "@/lib/constants/my-work-notice";

export function testMyWorkNotice() {
  const QUA_HAN = "FULFILLMENT_EXCEPTION: quá 3s — đang tính lại, mở lại sau ít giây là có";
  // Đủ nguồn: y như trước.
  assert.deepEqual(myWorkNotice({ total: 0, overdue: 0, failed: [] }), { description: "Không còn việc nào được giao cho bạn.", banner: null, countNote: undefined, showEmpty: true });
  assert.equal(myWorkNotice({ total: 7, overdue: 2, failed: [] }).description, "7 việc đang cầm · 2 việc quá hạn");

  // Thiếu nguồn + 0 việc đọc được ⇒ CHƯA BIẾT, không «hết việc», không thẻ «Hàng đợi trống».
  const chua = myWorkNotice({ total: 0, overdue: 0, failed: [{ source: "FULFILLMENT_EXCEPTION", error: QUA_HAN }, { source: "ALERT", error: "ALERT: quá 3s — đang tính lại" }] });
  assert.equal(chua.description, "Chưa biết bạn còn việc hay không — 2 nguồn chưa có số");
  assert.equal(chua.showEmpty, false);
  assert.equal(chua.countNote, "thiếu 2 nguồn — có thể nhiều hơn");
  assert.match(chua.banner ?? "", /^Chưa đọc được 2 nguồn: Nút thắt fulfillment \(đang tính lại\) · .+ \(đang tính lại\)\. .*KHÔNG được tính là 0\. Máy đang tính lại phía sau/);
  assert.doesNotMatch(chua.banner ?? "", /FULFILLMENT_EXCEPTION/, "in NHÃN nguồn cho người đọc, không in mã");

  // Thiếu nguồn + có việc ⇒ «ít nhất», số là cận dưới.
  const it = myWorkNotice({ total: 5, overdue: 1, failed: [{ source: "PAYROLL_RECON", error: "LỖI kết nối" }] });
  assert.equal(it.description, "Ít nhất 5 việc đang cầm · 1 việc quá hạn — 1 nguồn chưa có số");
  assert.match(it.banner ?? "", /\(lỗi\)\./);
  assert.doesNotMatch(it.banner ?? "", /đang tính lại phía sau/, "lỗi thật thì không hứa «mở lại sau ít giây»");

  // Nguồn tính theo NHỊP job (đối soát lương, mỗi 12 phút): in đúng nhịp, và KHÔNG hứa «sau ít giây» (OD-UX-05 mục 2).
  const luong = myWorkNotice({ total: 3, overdue: 0, failed: [{ source: "PAYROLL_RECON", error: "đang tính lại (máy tính lại mỗi 12 phút)" }] });
  assert.match(luong.banner ?? "", /\(máy tính lại mỗi 12 phút\)\./);
  assert.doesNotMatch(luong.banner ?? "", /ít giây/, "nguồn tính theo nhịp job không có lời hứa «sau ít giây»");
  const tron = myWorkNotice({ total: 0, overdue: 0, failed: [{ source: "ALERT", error: QUA_HAN }, { source: "PAYROLL_RECON", error: "đang tính lại (máy tính lại mỗi 12 phút)" }] });
  assert.doesNotMatch(tron.banner ?? "", /ít giây/, "chỉ hứa «sau ít giây» khi MỌI nguồn thiếu đang tính lại ngay");

  // Trang dùng ĐÚNG hàm này cho mọi câu phụ thuộc độ đủ — không tự viết lại.
  const trang = readFileSync("app/(dashboard)/work/page.tsx", "utf8");
  for (const s of ["description={notice.description}", "notice.banner ?", "notice.countNote ??", "notice.showEmpty ?"]) assert.ok(trang.includes(s), `/work dùng ${s}`);
  assert.ok(!trang.includes("my.total === 0 ?"), "«Hàng đợi trống» không được dựa riêng vào total = 0");
  console.log("✓ Việc của tôi thiếu nguồn: chưa biết ≠ hết việc · số là cận dưới («ít nhất», «thiếu N nguồn») · nhãn nguồn thay mã · chỉ hứa «mở lại sau ít giây» khi đang tính lại");
}
