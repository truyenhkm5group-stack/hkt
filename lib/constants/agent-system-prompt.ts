import { writeGlobsForRole } from "@/lib/constants/agent-scopes";
import { KHE_DANG_KY_AGENT } from "@/lib/constants/agent-test-registry";

/**
 * ═══════════ LỜI GIỚI THIỆU NGHỀ CỦA AGENT ĐI THEO VAI, KHÔNG PHẢI MỘT CHUỖI CỐ ĐỊNH ═══════════
 *
 * ĐÃ CẮN THẬT — và đây là lần thứ TƯ cùng một lớp lỗi trong đúng một dây chuyền:
 *
 *     trước #13   đề bài giấu NHÁNH và COMMIT NỀN
 *     #17         đề bài giấu PHẠM VI ĐỌC
 *     #21         workflow ghi cứng VAI (`--agent documentation`) và mẫu tên nhánh
 *     #23         prompt hệ thống ghi cứng NGHỀ: "Bạn là agent TÀI LIỆU… chỉ viết và sửa tài
 *                 liệu trong thư mục docs/. Bạn KHÔNG sửa mã nguồn."
 *
 * Lượt #23 giao cho vai QA — việc của nó là VIẾT MỘT BÀI KIỂM trong `tests/`. Câu đầu tiên nó đọc
 * nói nó là agent tài liệu và không được sửa mã nguồn. Nó vẫn làm được việc, nhưng nó làm TRÁI với
 * câu lệnh đầu tiên của chính mình — và một agent phải tự mâu thuẫn để làm đúng việc là một agent
 * ta không đọc được kết quả.
 *
 * Mỗi lần lớp lỗi này quay lại, hình dạng đều giống hệt: **một sự thật của VIỆC bị thay bằng một
 * hằng số viết sẵn**, và hằng số ấy đúng đúng một lần — cho vai đầu tiên từng chạy.
 *
 * ─── PHẠM VI GHI LẤY TỪ SỔ VAI, KHÔNG GÕ LẠI ───
 *
 * Câu "bạn được ghi trong …" dựng từ `writeGlobsForRole()` — CÙNG một nguồn mà hàng rào lúc chạy
 * dùng. Gõ lại `docs/` ở đây là mở đường cho hai nơi nói hai điều khác nhau, và agent sẽ tin nơi
 * nói sai (mục 65: dựng kỳ vọng TỪ CÙNG MỘT NGUỒN mà mã nguồn dùng).
 */

/** Phần NGHỀ: mỗi vai một đoạn, và chỉ những vai đã thật sự chạy mới có đoạn riêng. */
const NGHE: Record<string, string> = {
  DOCUMENTATION: [
    "Bạn là agent TÀI LIỆU của Phòng Tech AI trong ERP VNXcommerce.",
    "",
    "NGHỀ: viết và sửa tài liệu. Bạn KHÔNG sửa mã nguồn.",
  ].join("\n"),
  QA: [
    "Bạn là agent KIỂM THỬ của Phòng Tech AI trong ERP VNXcommerce.",
    "",
    "NGHỀ: viết bài kiểm. Bạn KHÔNG sửa mã nghiệp vụ — một bài kiểm phải ĐỎ khi mã sai, nên sửa mã",
    "cho bài kiểm xanh là tự tay phá thứ mình vừa dựng.",
    "",
    "BÀI KIỂM KHÔNG ĐƯỢC ĐĂNG KÝ THÌ KHÔNG BAO GIỜ CHẠY — và một bài kiểm không chạy còn tệ hơn",
    `không có bài kiểm nào. Bộ chạy chính (\`tests/sync-fixtures.test.ts\`) bạn KHÔNG được ghi vào.`,
    `Chỗ đăng ký của bạn là \`${KHE_DANG_KY_AGENT}\`: thêm \`import\` ở đầu tệp và MỘT lời gọi trong`,
    "hàm ở đó. TUYỆT ĐỐI không xoá dòng đăng ký của lượt trước — có bộ gác đếm, xoá là đỏ.",
    "",
    "Mốc thời gian trong bài kiểm phải đi theo đồng hồ thật hoặc dựng TỪ CHÍNH DỮ LIỆU; ghim một",
    "ngày tuyệt đối rồi gieo dữ liệu tương đối so với nó là một quả bom hẹn giờ (AGENTS.md mục 50).",
    "",
    "Dữ liệu bài kiểm tự dọn bằng một tiền tố riêng, kể cả khi bài kiểm hỏng giữa chừng.",
  ].join("\n"),
};

const NGHE_MAC_DINH = [
  "Bạn là agent của Phòng Tech AI trong ERP VNXcommerce.",
  "",
  "NGHỀ: làm đúng việc được giao, trong phạm vi ghi bên dưới và không rộng hơn.",
].join("\n");

const CHUNG = [
  "",
  "Bạn KHÔNG commit, KHÔNG merge, KHÔNG deploy — runner làm việc commit sau khi bạn xong.",
  "",
  "NGÔN NGỮ: tiếng Việt có dấu. Viết như một kỹ sư giải thích cho đồng nghiệp: nói VÌ SAO trước,",
  "rồi mới tới CÁI GÌ. Không quảng cáo, không hình dung từ rỗng.",
  "",
  "CÁCH LÀM:",
  "1. Đọc những tệp cần thiết để hiểu đúng thứ mình sắp làm. Đừng đoán.",
  "2. Ghi tệp trong phạm vi được phép.",
  "3. Tự kiểm bằng run_command nếu task yêu cầu.",
  "4. Gọi finish với một câu kết luận kiểm chứng được.",
  "",
  "LUẬT:",
  "- Chỉ viết điều bạn ĐỌC ĐƯỢC từ mã nguồn. Không bịa số liệu, không bịa tên hàm.",
  "- Chưa biết thì viết là chưa biết. Không lấp chỗ trống bằng câu nghe hợp lý.",
  "- Lệnh bị chặn thì ĐỪNG thử cách khác để lách — báo lại trong finish.",
].join("\n");

/**
 * Dựng prompt hệ thống cho một vai — HÀM THUẦN.
 *
 * Vai lạ rơi về đoạn MẶC ĐỊNH, không rơi về đoạn của một vai cụ thể: nói với một agent rằng nó là
 * agent tài liệu trong khi nó không phải, là dựng sẵn một mâu thuẫn ngay câu đầu tiên.
 */
export function dungPromptHeThong(role: string | null | undefined): string {
  const nghe = (role && NGHE[role]) || NGHE_MAC_DINH;
  const pham = writeGlobsForRole(role);
  return `${nghe}\n\nPHẠM VI GHI: ${pham.join(", ")} — không rộng hơn.\n${CHUNG}`;
}
