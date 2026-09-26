/**
 * ═══════ LỜI NHẮC "LẦN THỰC THI TRƯỚC KHÔNG HOÀN TẤT" (Company OS · Agent N) ═══════
 *
 * Một lời duyệt được TRẢ LẠI (thao tác hỏng — `releaseApprovalExecution`; hoặc tiến trình dừng giữa
 * chừng — `lib/approvals/reservation-sweep.ts`) mang `execution_error`. Trường hợp thứ hai KHÔNG phân
 * biệt được "chết trước khi ghi" với "ghi xong rồi mới chết", nên làm lại mù là có thể làm MỘT việc HAI
 * LẦN. Câu nhắc này phải đứng ở mọi nơi người xin / người duyệt nhìn thấy yêu cầu — MỘT hàm, để trang
 * Cần xử lý và `/work` nói cùng một câu.
 *
 * Hàm thuần: không đọc CSDL, không đọc đồng hồ. `NULL` / rỗng ⇒ không có gì để nhắc ⇒ `null`.
 */
export function approvalExecutionNote(executionError: string | null | undefined): string | null {
  const e = (executionError ?? "").trim();
  if (!e) return null;
  return `Lần thực thi trước không hoàn tất: ${e} — kiểm tra việc đã được ghi chưa trước khi làm lại`;
}
