import type { IdeaStatus } from "@/db/schema";

/**
 * Ý TƯỞNG MARKETING — vòng đời một ý tưởng từ lúc marketer đăng tới lúc quản lý chốt.
 *
 * Chỉ có năm trạng thái, cố ý ít: thêm trạng thái thì ai cũng phải học lại quy trình, mà việc thật
 * chỉ cần biết ý tưởng đang chờ ai và kết luận là gì.
 */
export const IDEA_STATUS_LABEL: Record<IdeaStatus, string> = {
  NEW: "Chờ quản lý xem",
  REVIEWING: "Quản lý đang xem",
  CHANGES: "Cần sửa lại",
  APPROVED: "Đã duyệt",
  REJECTED: "Không duyệt",
};

export const IDEA_STATUS_HINT: Record<IdeaStatus, string> = {
  NEW: "Marketer vừa đăng, quản lý chưa nhận xét lần nào.",
  REVIEWING: "Quản lý đã xem và trao đổi, chưa chốt duyệt hay không.",
  CHANGES: "Quản lý yêu cầu sửa — marketer sửa rồi trả lời lại trong khung trao đổi.",
  APPROVED: "Đã duyệt, có thể đưa vào chạy.",
  REJECTED: "Không dùng ý tưởng này. Lý do nằm trong khung trao đổi.",
};

export const IDEA_STATUS_TONE: Record<IdeaStatus, string> = {
  NEW: "bg-sky-50 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  REVIEWING: "bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  CHANGES: "bg-orange-100 text-orange-800 dark:bg-orange-950/60 dark:text-orange-300",
  APPROVED: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  REJECTED: "bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300",
};

export const IDEA_STATUSES: IdeaStatus[] = ["NEW", "REVIEWING", "CHANGES", "APPROVED", "REJECTED"];

/** Trạng thái quản lý được đặt khi nhận xét. "Đang xem" do hệ thống tự đặt, không cần bấm. */
export const IDEA_REVIEW_DECISIONS: IdeaStatus[] = ["CHANGES", "APPROVED", "REJECTED"];

/**
 * Giới hạn ảnh. Ảnh được thu nhỏ ngay trên trình duyệt trước khi gửi nên các số này là trần an
 * toàn, không phải kích thước thường gặp: một ảnh sau khi thu nhỏ khoảng 150–250 KB.
 *
 * Vì ảnh nằm trong CSDL nên trần phải có thật — không chặn thì một lần kéo thả nhầm cả thư mục
 * ảnh gốc từ máy ảnh là đủ làm phình cơ sở dữ liệu.
 */
export const IDEA_MAX_IMAGES = 6;
export const IDEA_IMAGE_MAX_EDGE = 1400;
export const IDEA_IMAGE_QUALITY = 0.82;
/** Trần base64 mỗi ảnh sau khi thu nhỏ (~1 MB nhị phân). */
export const IDEA_IMAGE_MAX_BASE64 = 1_400_000;

/** Dòng đầu của nội dung dùng làm tiêu đề hiển thị; phần còn lại là mô tả chi tiết. */
export function ideaTitle(content: string) {
  const first = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? "";
  return first.trim().slice(0, 120) || "(chưa có nội dung)";
}
