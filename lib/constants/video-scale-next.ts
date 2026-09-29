/**
 * ═══════════ VIDEO SCALE — "VIỆC CẦN LÀM TIẾP THEO" (chủ shop 29/09/2026: "làm lại UI/UX… thông minh hơn") ═══════════
 *
 * Trang có bảy tab và người mở trang thường không biết nên bấm vào đâu. Hàm THUẦN này đọc các con số đã có (không truy vấn
 * gì thêm) và nói ĐÚNG MỘT việc nên làm lúc này, theo thứ tự ưu tiên: đang dừng khẩn cấp → cấu hình chặn sinh video → việc bị
 * chặn trong hàng đợi → video chờ duyệt → video đã duyệt chưa đăng → đang tạo (chỉ cần đợi) → thiếu mã win / ảnh gốc → tạo video
 * mới. Một việc, một nút — không phải một danh sách cảnh báo nữa.
 */

export type VideoScaleTab = "ma-win" | "hang-doi" | "duyet" | "dang-reel" | "quang-cao" | "bao-cao" | "cau-hinh";

export type NextStepInput = {
  paused: boolean;
  blockers: readonly string[];
  blockedJobs: number;
  failedJobs24h: number;
  review: number;
  activeJobs: number;
  approvedUnposted: number;
  winProducts: number;
  winWithPhotos: number;
};

export type NextStep = { tone: "danger" | "warn" | "action" | "wait" | "idle"; title: string; detail: string; tab: VideoScaleTab; cta: string };

export function nextVideoScaleStep(i: NextStepInput): NextStep {
  if (i.paused) return { tone: "danger", title: "Video Scale đang DỪNG mọi tự động", detail: "Không đăng Reel, không tạo / bật quảng cáo cho tới khi mở lại.", tab: "dang-reel", cta: "Xem & mở lại" };
  if (i.blockers.length) return { tone: "warn", title: "Chưa sinh được video thật", detail: i.blockers[0] + (i.blockers.length > 1 ? ` (+${i.blockers.length - 1} lý do khác)` : ""), tab: "cau-hinh", cta: "Mở Cấu hình" };
  if (i.blockedJobs > 0) return { tone: "warn", title: `${i.blockedJobs} việc đang bị chặn`, detail: "Thường là cảnh bị máy sinh video từ chối hoặc hết trần tiền ngày — đổi cảnh sang ảnh động (miễn phí) hoặc thử lại.", tab: "hang-doi", cta: "Xử lý ngay" };
  if (i.review > 0) return { tone: "action", title: `${i.review} video chờ duyệt`, detail: "Xem, sửa nếu cần (chữ · cảnh · giọng · nhạc · màu) rồi Duyệt — video QC đạt duyệt được hàng loạt.", tab: "duyet", cta: "Duyệt video" };
  if (i.approvedUnposted > 0) return { tone: "action", title: `${i.approvedUnposted} video đã duyệt chưa đăng`, detail: "Soạn content và đăng Reel (hoặc hẹn giờ) lên fanpage đã gán cho mã.", tab: "dang-reel", cta: "Đăng Reel" };
  if (i.activeJobs > 0) return { tone: "wait", title: `Đang tạo — ${i.activeJobs} việc trong hàng đợi`, detail: "Không cần làm gì: trang tự cập nhật, clip nào xong xem được ngay.", tab: "hang-doi", cta: "Xem tiến trình" };
  if (i.winProducts === 0) return { tone: "idle", title: "Chưa có mã win nào", detail: "Khai mã từ “Thắng test” trở đi ở trang Mẫu — Video Scale chỉ làm video cho mã đã thắng.", tab: "ma-win", cta: "Xem mã win" };
  if (i.winWithPhotos === 0) return { tone: "warn", title: "Mã win chưa có ảnh sản phẩm thật", detail: "Thư viện Media → Nguồn ảnh → Nhập ảnh sản phẩm từ Pancake, rồi quay lại tạo video.", tab: "ma-win", cta: "Xem mã win" };
  return { tone: "idle", title: "Sẵn sàng tạo video mới", detail: "Chọn một mã win → “Tạo chiến dịch media”. Rẻ nhất: ít cảnh AI + cảnh ảnh động, rồi Nhân bản ở bước Duyệt.", tab: "ma-win", cta: "Tạo video" };
}
