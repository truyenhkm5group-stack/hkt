/**
 * ═══════════ IP CỦA NGƯỜI GỌI, ĐỌC ĐÚNG SAU CADDY ═══════════
 *
 * Production chỉ có MỘT proxy tin cậy đứng trước ứng dụng: Caddy (`deploy/Caddyfile`), và cổng 3000
 * của ứng dụng không mở ra Internet (`expose`, không `ports`). Caddy v2 KHÔNG tin `X-Forwarded-For`
 * do client gửi (chưa khai `trusted_proxies`): nó ghi đè bằng IP thật của kết nối.
 *
 * Nên đọc giá trị NGOÀI CÙNG BÊN PHẢI — phần do proxy gần nhất ghi. Đọc phần bên TRÁI (như code cũ)
 * là đọc thứ client tự khai: nếu một ngày Caddy được khai `trusted_proxies` và bắt đầu NỐI THÊM thay
 * vì ghi đè, kẻ dò chỉ cần gửi `X-Forwarded-For: <ip ngẫu nhiên>` mỗi lần là không bao giờ chạm trần
 * theo IP. Phần bên phải thì đúng trong cả hai cách Caddy làm.
 *
 * `X-Real-IP` KHÔNG được đọc: Caddy không đặt nó, nên nó đi thẳng từ client tới đây.
 *
 * Không có header (chạy dev không qua proxy) ⇒ `unknown`. Giá trị không giống một địa chỉ IP ⇒
 * `unknown` — không để một chuỗi tuỳ ý thành khoá của bộ đếm.
 */
export function clientIpFrom(forwardedFor: string | null | undefined): string {
  if (!forwardedFor) return "unknown";
  const parts = forwardedFor.split(",").map((s) => s.trim()).filter(Boolean);
  const last = parts[parts.length - 1] ?? "";
  if (!last || last.length > 64 || !/^[0-9a-fA-F:.]+$/.test(last)) return "unknown";
  return last.toLowerCase();
}
