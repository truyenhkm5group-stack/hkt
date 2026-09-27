# Nền tảng ERP — Sổ rủi ro

Mức: **C** nghiêm trọng · **H** cao · **M** vừa · **L** thấp. Trạng thái: MỞ · GIẢM (đã có chặn, còn dư) · ĐÓNG.

| ID | Rủi ro | Mức | Chặn / giảm | Trạng thái |
| --- | --- | --- | --- | --- |
| R-01 | **Mất ngữ cảnh tổ chức** ở một đường chạy request ⇒ rơi về tổ chức nhà ⇒ người tổ chức B thấy dữ liệu A | C | Ngữ cảnh request đọc từ JWT ở MỌI lời gọi `getDb()` (không phụ thuộc ai đó nhớ bọc); rơi về nhà chỉ khi KHÔNG có phiên; bài kiểm E2E truy cập trực tiếp theo id | GIẢM |
| R-02 | Gia hạn JWT làm rơi claim `org` | C | `renewalClaims()` chép mọi claim; bài kiểm `platform-rbac` + kiểm đột biến | ĐÓNG |
| R-03 | Mỗi tổ chức một bể kết nối ⇒ cạn `max_connections` | M | `PGPOOL_MAX_ORG=2`; trần ~15 tổ chức/máy; PgBouncer trước khi vượt | MỞ |
| R-04 | Credential `process.env` của VNX bị dùng trong ngữ cảnh tổ chức khác | C | `assertHomeCredentials()` ở MỌI lối gọi mạng (0 lượt gọi — đo bằng fetch giả); module connector `requiresHomeCredentials`; máy quét tĩnh. Dư: client singleton vẫn giữ credential nhà (an toàn nhờ lời chặn) — đổi sang Map theo tổ chức ở Phase 1.x | GIẢM |
| R-05 | Sự kiện SSE của A phát tới trình duyệt B | H | Sự kiện đóng dấu `org`; SSE chụp tổ chức lúc mở, lọc bằng `eventVisibleTo`; sự kiện thiếu dấu bị bỏ | ĐÓNG |
| R-06 | Tổ chức mới chưa có sao lưu | H | HUMAN GATE khi cấp trên production | MỞ |
| R-07 | Đệm năng lực trễ giữa app và scheduler | L | TTL 5 giây | GIẢM |
| R-08 | Trang/API mới thêm vào mà không khai module ⇒ không bị cổng module chặn | H | `tests/platform-modules.test.ts`: mọi `page.tsx`/`route.ts` phải thuộc đúng một module hoặc `core` (kiểm đột biến đỏ) | ĐÓNG |
| R-09 | Server Action chạy trên một trang core nhưng làm việc của module tắt | M | `can()` chặn theo quyền sở hữu module; quyền dùng chung (vd `expenses:view` cho `/ads`) là dư — ghi ở `tenant-readiness-audit.md` | MỞ |
| R-10 | Bảng `platform_*` rỗng trong CSDL tổ chức khác bị ai đó ghi vào | L | `getPlatformDb()` là đường duy nhất; health kiểm rỗng | GIẢM |
| R-11 | Luật nghiệp vụ VNX (ORDER_OUTCOME, COD, ngưỡng) chạy cho tổ chức không phải thời trang/COD | M | Phase 1 chấp nhận (dữ liệu rỗng ⇒ số rỗng, không sai); tách gói ngành ở Phase 2+ (`vnx-specific-rules.md`) | MỞ |
| R-12 | Hai lượt migrate đua nhau trên CSDL tổ chức mới | M | `pg_advisory_lock` | GIẢM |
| R-13 | Tệp đính kèm lưu ngoài CSDL mà không có khoá tổ chức | M | Audit xác nhận tệp đính kèm nằm TRONG CSDL (bytea/base64) ⇒ silo cô lập | ĐÓNG |
| R-14 | Ops workflow (`db-query`, `run-job`, `set-setting`) luôn nhắm tổ chức nhà | L | Đúng với Phase 1 (chỉ nhà trên production); thêm tham số `org` khi cấp tổ chức thứ hai | MỞ |
| R-15 | Mã tổ chức bị dò qua màn hình đăng nhập | L | Mã sai và mật khẩu sai trả CÙNG một câu + so băm giả (thời gian không lộ); throttle `pair:<org>:<email>|<ip>` | ĐÓNG |
| R-16 | Việc chạy sau phản hồi trong Server Component (`after()`) mất ngữ cảnh ⇒ rơi về nhà | H | Mọi `after(` đi qua `bindOrganization()`; máy quét tĩnh đỏ nếu thiếu | GIẢM |
| R-17 | Lá chắn "job đang chạy" ở `/api/sync` hỏi theo slug còn runner khoá theo tên nội bộ ⇒ gần như không bao giờ khớp (lỗi CŨ, không do nền tảng) | M | Chưa sửa: sửa đổi hành vi (202 + bỏ qua reconcile của vtp-tracking) ⇒ việc riêng, có ghi chú trong mã | MỞ |
| R-18 | `/api/export/payroll`, `/api/export/planning` chưa qua `apiGuard` — module tắt ⇒ 401 thay vì 403 đúng mã (vẫn bị chặn) | L | Cổng đường dẫn trong `getCurrentUser()` vẫn chặn; đổi mã phản hồi là việc riêng | MỞ |
| R-19 | Khoá AI (Anthropic/OpenAI) trong env: chi phí AI của mọi tổ chức trừ vào tài khoản VNX | M | Phase 1 chặn như credential của nhà (tổ chức khác không dùng AI). QUYẾT ĐỊNH CỦA CHỦ: AI là dịch vụ nền tảng hay khách tự mang | MỞ — HUMAN |
