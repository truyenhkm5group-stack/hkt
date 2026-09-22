/**
 * ═══════════ KHE ĐĂNG KÝ BÀI KIỂM CỦA AGENT — VÀ CÁI BÁNH CÓC GIỮ NÓ ═══════════
 *
 * ─── CHỖ TẮC ĐÃ ĐO ĐƯỢC, LƯỢT CHẠY #23 ───
 *
 * Vai QA viết xong `tests/agent-branch-claim-ingest.test.ts` rồi tự khai trong phần tóm tắt:
 *
 *     "Chưa hoàn thành: cần thêm dòng import bài kiểm vào tests/sync-fixtures.test.ts"
 *
 * Nó khai đúng. `tests/sync-fixtures.test.ts` nằm trong `NEVER_WRITE` — thêm vào đó là một quyết
 * định ĐÚNG (xoá một dòng đăng ký là diff MỘT DÒNG mà bộ đếm khẳng định không nhìn thấy). Nhưng hệ
 * quả không ai tính tới: **một bài kiểm không được đăng ký thì không bao giờ chạy**, nên vai QA về
 * mặt cấu trúc không giao nổi một bài kiểm chạy được — dù model có giỏi tới đâu.
 *
 * Và chỗ tắc ấy còn dựng sẵn một cái bẫy tệ hơn: sửa giúp agent lỗi kiểu dữ liệu thì **cả bốn cổng
 * XANH** — `npm test` xanh vì bài kiểm ấy không chạy. Một PR xanh mang một bài kiểm chưa từng chạy
 * một lần nào là thứ nguy hiểm hơn hẳn một PR đỏ.
 *
 * ─── CÁCH VÁ: MỘT KHE HẸP, CÓ BÁNH CÓC — KHÔNG NỚI TỆP ĐÃ KHOÁ ───
 *
 * `tests/sync-fixtures.test.ts` VẪN khoá. Mở thêm đúng một tệp mà agent được ghi, và bộ chạy chính
 * gọi nó đúng một lần — dòng gọi ấy nằm trong tệp đã khoá, nên khe không bị bỏ rơi.
 *
 * Bánh cóc: số lời gọi trong khe **không được GIẢM**. Thêm thì xanh, xoá thì đỏ. Sàn nằm ở hằng số
 * dưới đây, và hằng số này cũng thuộc `NEVER_WRITE` — agent không tự hạ sàn của chính mình được.
 * Nâng sàn là việc của NGƯỜI, lúc review.
 *
 * Vì sao là sàn chứ không phải một con số khớp chính xác: khớp chính xác thì agent THÊM một bài
 * kiểm cũng đỏ, và luật sẽ bị tắt ngay lần dùng đầu tiên.
 */

/** Tệp DUY NHẤT agent được tự đăng ký bài kiểm của mình. Bộ chạy chính gọi nó đúng một lần. */
export const KHE_DANG_KY_AGENT = "tests/agent-tu-dang-ky.test.ts";

/**
 * SÀN — số bài kiểm đã đăng ký trong khe KHÔNG được thấp hơn con số này.
 *
 * Hôm nay là 0 vì khe vừa mở và chưa bài nào vào. Mỗi lần một bài kiểm của agent được gộp, người
 * review nâng sàn lên — đó là lúc duy nhất con số này đổi, và nó chỉ đi một chiều.
 */
export const SO_BAI_AGENT_TOI_THIEU = 0;
