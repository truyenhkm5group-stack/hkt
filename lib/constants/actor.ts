/**
 * ═══════════ AI ĐÃ LÀM VIỆC NÀY — KHOÁ ĐI CÙNG TÊN, KHÔNG BAO GIỜ RỜI NHAU ═══════════
 *
 * Nhiều dịch vụ trong kho mã này nhận `actor: string` — một chuỗi, thường là email. Chuỗi đó ĐỦ
 * để in ra màn hình và KHÔNG ĐỦ để quy kết: người đổi email là mất dấu toàn bộ việc cũ, và một
 * job ghi hộ thì chuỗi đó là tên job chứ không phải một con người.
 *
 * Kiểu này bắt nơi gọi đưa CẢ HAI. Vì là tham số bắt buộc nên một đường ghi mới KHÔNG THỂ quên
 * phần danh tính — nó không biên dịch được.
 *
 * `id: null` là hợp lệ và có nghĩa rõ ràng: MÁY LÀM, hoặc người thao tác không có tài khoản ERP.
 * Khác hẳn với "chưa biết" — nơi gọi phải cố ý viết `null`.
 */
export type Actor = {
  /** `users.id`. `null` = không phải một tài khoản ERP (job, webhook, import). */
  id: string | null;
  /** Ảnh chụp để người đọc: tên hoặc email tại thời điểm thao tác. */
  label: string;
};

/** Máy tự làm — không có người nào chịu trách nhiệm ở mức cá nhân. */
export function systemActor(label: string): Actor {
  return { id: null, label };
}
