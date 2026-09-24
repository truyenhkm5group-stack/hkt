import { MAX_LIST_BASE64, MAX_LIST_FILES } from "@/lib/constants/cod";

/**
 * ═══════════ TRẦN KÍCH THƯỚC BODY CỦA CÁC WEBHOOK ═══════════
 *
 * Webhook là cửa KHÔNG đăng nhập. Trước đây `/api/webhooks/viettelpost` và `/api/webhooks/vtp-statement`
 * đọc + parse TOÀN BỘ body rồi mới hỏi bí mật — ai cũng gửi được một body vài trăm MB và bắt máy chủ
 * (VPS ~1,9 GB chạy cả Postgres) cấp phát nó trước khi bị từ chối.
 *
 * Hai lớp, cùng MỘT nguồn số:
 *  · Caddy (`deploy/Caddyfile`, `request_body { max_size }` theo từng đường) — chặn trước khi byte nào
 *    tới Node. Caddyfile không import được TypeScript nên con số nằm ở đó lần hai, và
 *    `tests/webhook-hardening.test.ts` đọc Caddyfile để đòi nó KHỚP với hằng số ở đây.
 *  · Handler (`readBodyCapped`) — kiểm `content-length` rồi đọc có trần, cho máy dev không có Caddy và
 *    cho ngày ai đó sửa Caddyfile sai.
 */

/**
 * Gói hành trình Viettel Post: vài KB. Gói Pancake chuyển tiếp bọc thêm cả đơn hàng — vẫn dưới
 * vài trăm KB. 1 MB là rộng gấp nhiều lần mà vẫn nhỏ tới mức không ai làm nghẽn được máy.
 */
export const VTP_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/** Pancake đẩy NGUYÊN bản ghi đơn/sản phẩm (kèm lịch sử, dòng hàng). Bí mật nằm trên đường dẫn nên kiểm được TRƯỚC khi đọc. */
export const PANCAKE_WEBHOOK_MAX_BODY_BYTES = 5 * 1024 * 1024;

/** SePay: một giao dịch ngân hàng — vài trăm byte. Chữ ký HMAC cần body nên phải đọc trước khi kiểm. */
export const SEPAY_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * Bảng kê từ Gmail: tới `MAX_LIST_FILES` tệp, mỗi tệp tới `MAX_LIST_BASE64` ký tự base64 (đúng trần
 * mà lược đồ zod của route nhận), cộng phần bao JSON: tên tệp ≤ 300 ký tự + khoá mỗi phần tử, và
 * `source` / `token` / `ping` ở ngoài. DẪN XUẤT từ hai hằng số ấy — đổi trần nhập tệp là trần body đổi theo.
 */
export const VTP_STATEMENT_MAX_BODY_BYTES = MAX_LIST_FILES * (MAX_LIST_BASE64 + 1024) + 64 * 1024;

/**
 * Số lượt ĐỌC BODY CHƯA XÁC THỰC chạy song song ở `vtp-statement`. Script Gmail cũ để bí mật TRONG
 * body (`token`), nên đường ấy buộc phải đọc body trước khi biết người gửi là ai. Script chạy tuần tự
 * (một thư mỗi lần, 15 phút một lượt) nên 2 là thừa cho việc thật, và là trần bộ nhớ cho kẻ lạ.
 * Script mới gửi bí mật qua header `x-webhook-secret` và không bị giới hạn này.
 */
export const VTP_STATEMENT_MAX_UNAUTHENTICATED_READS = 2;
