import assert from "node:assert/strict";
import { execSync } from "node:child_process";

/**
 * ══════════ LÁ CHẮN HIỆU NĂNG PHẢI ĐO THỨ NGƯỜI DÙNG THẬT SỰ CHỜ ══════════
 *
 * SỰ CỐ THẬT (15/09/2026). Bản ghi deploy #304 báo cả 54 màn hình đều dưới 310ms — cộng lại đúng
 * 5,6 giây — trong khi CẢ LƯỢT smoke mất 269 giây. 263 giây, tức 97,9% thời gian thật, không nằm
 * trong bất kỳ con số nào mà phép đo in ra.
 *
 * Nguyên nhân: `fetch` hoàn tất khi ĐẦU phản hồi về, còn thân trang RSC chảy về sau theo từng ranh
 * giới Suspense. Đồng hồ dừng ở `fetch` nên `SLOW_MS` đang xét thời gian tới đầu phản hồi. Hậu quả
 * kép: (a) một trang chảy ba mươi giây vẫn được ghi "SUCCESS 74ms" nên không ai biết phải sửa nó,
 * và (b) cả lượt chạy chạm trần ngân sách 300 giây mà không con số nào chỉ ra trang nào đốt hết —
 * hai lần deploy đã ĐỎ NHẦM vì ngân sách vỡ trong lúc máy chủ bận.
 *
 * Bài kiểm này khoá đúng thứ tự ấy ở mức MÃ NGUỒN. Nó không cần máy chủ sống: điều phải giữ là một
 * quan hệ thứ tự trong chính đoạn mã, và một lần sắp xếp lại vô tình sẽ làm phép đo mù trở lại mà
 * không màn hình nào đỏ.
 */
export function testSmokeTiming() {
  const src = execSync("git show HEAD:scripts/smoke.ts", { encoding: "utf8" });

  const iThan = src.indexOf("const body = await response.text();");
  const iDungDongHo = src.indexOf("const ms = Date.now() - started;");
  const iTtfb = src.indexOf("ttfbMs = Date.now() - started;");

  assert.ok(iThan > 0, "scripts/smoke.ts phải đọc hết thân phản hồi — chỉ đọc đầu phản hồi thì không biết trang có dựng xong không");
  assert.ok(iTtfb > 0, "scripts/smoke.ts phải giữ riêng mốc đầu phản hồi (ttfbMs): thiếu nó thì không phân biệt được máy chủ nghĩ lâu với thân trang chảy lâu");
  assert.ok(iDungDongHo > 0, "scripts/smoke.ts phải chốt thời gian cả trang vào một biến `ms`");

  // ĐÂY LÀ CÂU KHOÁ: đồng hồ dừng SAU khi thân trang đã về, không phải lúc `fetch` trả về.
  assert.ok(
    iDungDongHo > iThan,
    "scripts/smoke.ts dừng đồng hồ TRƯỚC khi đọc xong thân trang — đó chính là lỗi đã làm smoke báo 5,6s cho một lượt chạy 269s. `const ms = Date.now() - started` phải nằm SAU `await response.text()`",
  );
  assert.ok(
    iTtfb < iThan,
    "mốc đầu phản hồi phải được ghi TRƯỚC khi đọc thân, nếu không nó chỉ là bản sao của thời gian cả trang",
  );

  // Ngưỡng CHẬM phải xét con số cả trang, không phải con số đầu phản hồi.
  assert.ok(
    /verdict: ms > SLOW_MS \? "SLOW" : "SUCCESS"/.test(src),
    "ngưỡng CHẬM phải so với `ms` (cả trang). So với mốc đầu phản hồi là đo nhầm đại lượng — đúng lỗi bài kiểm này sinh ra để chặn",
  );

  // Phép đo phải tự khai phần nó KHÔNG đo được: chính vì thiếu dòng này mà 263 giây đi lạc nhiều
  // lượt deploy liền mà không ai thấy.
  assert.ok(
    /ngoài phép đo/.test(src),
    "smoke phải in phần thời gian NẰM NGOÀI phép đo; thiếu nó thì lần mù tiếp theo lại phải đợi ai đó đi lục bản ghi mới thấy",
  );
}
