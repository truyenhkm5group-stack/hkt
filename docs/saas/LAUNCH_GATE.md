# Launch Gate — khách trả tiền ĐẦU TIÊN của Chốt Đơn Tự Động

> Nguồn sự thật DUY NHẤT cho câu hỏi «đã bán được cho khách trả tiền đầu tiên chưa». Mở ngày 08/10/2026 khi chủ shop chuyển
> MASTER MISSION sang LAUNCH SPRINT. Integration Lead cập nhật sau mỗi lượt deploy — mỗi dòng phải trỏ tới BẰNG CHỨNG (PR, run,
> lượt smoke, ops), không trỏ tới ý định. Phạm vi bị ĐÓNG BĂNG: chỉ làm việc cải thiện kích hoạt · độ tin cậy · độ đúng của đơn ·
> thời gian tới giá trị · sẵn sàng thu tiền, cho tới khi cổng ĐẠT (Product Opportunity Backlog giữ phần còn lại).

## 0. Cách chấm

| Ký hiệu | Nghĩa | Tính vào % |
|---|---|---|
| ✅ PROD | Đã kiểm trên PRODUCTION, có bằng chứng | 1 |
| 🟡 CODE | Có mã + bài kiểm, CHƯA kiểm trên production | 0,5 |
| 🔧 WIP | Đang có PR / nhánh làm | 0 |
| ❌ THIẾU | Chưa ai làm | 0 |
| ⛔ NGOÀI | Chờ bên ngoài (Meta) | 0, nhưng không tính vào «nội bộ» |

Cổng ĐẠT khi: 0 P0 · P1 quan trọng đã xử lý · Admin ≥ 90 % · Khách ≥ 90 % · Quan sát đủ 8 tín hiệu · smoke production xanh.
Chỉ còn Meta ⇒ **READY PENDING META**. Meta duyệt + smoke bằng tài khoản / Page KHÔNG có vai trò trong app ⇒ **READY FOR FIRST
PAYING CUSTOMER**.

Một mục chỉ lên ✅ PROD bằng một lượt kiểm trên production có vết (run ops / smoke) — mã đã deploy mà chưa ai đi qua nó trên
production vẫn là 🟡. Mục từng 🟡 mà review tìm ra lỗi chặn thì LÙI về 🔧 cho tới khi bản sửa gộp (không giữ điểm cũ).

## 1. ADMIN

| # | Mục | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|---|
| A1 | Tạo khách không cần CSDL / script | 🔧 WIP **P0-C** | Form + job cấp phát có từ trước, NHƯNG review #682 (08/10) tìm ra: cửa `/start` chế độ người vận hành (link trên `/platform`) vẫn cho chọn gói nội bộ / gói cũ và để thương hiệu NULL ⇒ khách ngoài thấy menu ERP, bot im (gói cũ credit 0); bước cài mẫu hỏng thì job vẫn «Xong» và không có đường sửa. Bản sửa `fix/create-customer-defaults` (#682) đặt luật gói + thương hiệu ở TẦNG GHI CHUNG cho mọi cửa |
| A2 | Tài khoản / quản trị khách được cấp | 🟡 CODE | #681 (P0 danh tính) gộp + deploy 37781964748: cấp phát · kích hoạt · đặt lại mật khẩu đều ghi chỉ mục đăng nhập. Chờ smoke nghiệm thu đi qua trên production |
| A3 | Gán sản phẩm Chốt Đơn | 🟡 CODE | Thuê bao sản phẩm theo module (#670) |
| A4 | Gán gói / thuê bao | 🔧 WIP | Khách mới ghim V1 đúng (kiểm chỉ đọc 08/10), nhưng form / cửa khác vẫn cho gói nội bộ / cũ — cùng bản sửa #682 |
| A5 | Gửi / gửi lại lời mời | 🟡 CODE | #681 (production aa4b69ce): nút gửi lại liên kết kích hoạt (không lộ token, có nhật ký); #684 gộp main 5c781cd5 (gửi lại form không phát liên kết cho người job chưa tạo; mở khoá ghi lại chỉ mục) — lên production lượt deploy kế |
| A6 | Thấy trạng thái cấp phát | 🟡 CODE | Trang chi tiết khách đọc job; bước cài mẫu hỏng chưa hiện — #682 |
| A7 | Thấy sức khoẻ Messenger / kênh | 🔧 WIP | #683 `feat/customer-health` (mất kênh = 0 page bật + 0 tin 2 ngày); lỗi token từng page chỉ ở CSDL tổ chức ⇒ `saas-ops-signals` |
| A8 | Thấy sức khoẻ AI | 🔧 WIP | #683 (AI đang lỗi · bị chặn · im) |
| A9 | Thấy gói / mức dùng | 🟡 CODE | Danh sách khách có gói; mức dùng ở chi tiết |
| A10 | Nhận ra khách có vấn đề | 🔧 WIP | #683: Nguy cấp · Cần chú ý · Chưa đủ dữ liệu · Khoẻ · Đã dừng, lý do có số + mốc; thiếu dữ liệu không bao giờ «Khoẻ» |

## 2. KHÁCH

| # | Mục | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|---|
| C1 | Kích hoạt (đặt mật khẩu) | 🟡 CODE | Liên kết `/reset/<mã>/<token>`; #681 ghi chỉ mục khi đặt mật khẩu |
| C2 | Đăng nhập email + mật khẩu | 🟡 CODE | P0 ĐÃ SỬA ở #681 (deploy 37781964748, production aa4b69ce). Tài khoản tạo TRƯỚC bản vá: ops `identity-reconcile` chạy thử (run 37786092653: 19 tài khoản đủ điều kiện · THIẾU 12 — gồm 5 tài khoản khách HSLC) → ghi bù (run 37786400515: ghi 12 · hỏng 0 · sau: THIẾU 0 · LỆCH 0). Chờ smoke nghiệm thu đăng nhập KHÔNG gõ mã tổ chức trên production |
| C3 | Vỏ không lộ nội bộ | 🟡 CODE | #669 (AI / model / USD), #680 (chữ kỹ thuật · nhãn readiness). Còn: câu `BILLING_LOCKED` ở lib/auth nói «Hệ thống → Gói & thanh toán» |
| C4 | Hướng dẫn bước tiếp theo | 🟡 CODE | #680 (trạng thái rỗng · Hướng dẫn · 404 · `/login` khi còn phiên không còn vòng trắng: 6.007 → 2 lần điều hướng) |
| C5 | Thiết lập sản phẩm | 🟡 CODE | Nhập sản phẩm / mẫu ngành |
| C6 | Nối Facebook | ⛔ NGOÀI | Meta chưa cấp quyền Page — `docs/meta-app-review/HUONG_DAN_CHU_SHOP.md` |
| C7 | Hộp thư mở được | 🟡 CODE | F-01 trang trắng sau đăng nhập đã hết (#671) |
| C8 | Tin khách vào hộp thư | 🟡 CODE | Kênh thay thế lúc chờ Meta: chat web `<tên>.erp.vnxcommerce.com/chat` (DNS wildcard trỏ VPS — đo 08/10), Pancake, Zalo |
| C9 | Nhân viên trả lời | 🟡 CODE | `sendStaffReplyCore`; #661 / #666 |
| C10 | AI trả lời | 🟡 CODE | Bot HSLC chạy thật hằng ngày (bằng chứng vận hành, không phải smoke khách mới) |
| C11 | Tiếp quản / trả lại AI | 🟡 CODE | #633 |
| C12 | Tạo đơn nháp từ hội thoại | 🟡 CODE | Golden v2 (#664) |
| C13 | SKU / SL / SĐT / địa chỉ đúng | 🟡 CODE | Golden v2: SKU 29/29 · SL 34/34 · SĐT 28/29 · địa chỉ 87/87 |
| C14 | Dữ liệu mơ hồ ⇒ cần người kiểm | 🟡 CODE | #675 |
| C15 | Xác nhận tay | 🟡 CODE | #675 nút nhanh Xác nhận / Huỷ |
| C16 | Đơn hợp lệ vào OMS | 🟡 CODE | Đơn ERP |
| C17 | Không đơn trùng | 🟡 CODE | Golden v2: đơn trùng 0/30 |
| C18 | Đồng hồ dùng / hạn mức đúng | 🟡 CODE | AI_CUSTOMER (0228) |
| C19 | Luồng chính dùng được trên điện thoại | 🟡 CODE | Vỏ 390 px (SHELL_AUDIT); `/settings/users` nhiều phần tử nhỏ — P1 |

## 3. BẢO MẬT

| # | Mục | Trạng thái | Bằng chứng |
|---|---|---|---|
| S1 | Cô lập tổ chức | 🟡 CODE | tenant-attack, ai-sales-isolation — CI mỗi PR |
| S2 | Bí mật ẩn | 🟡 CODE | lá chắn connectors, ops-log-leak |
| S3 | Token page mã hoá | 🟡 CODE | AES-256-GCM `lib/connectors/secrets.ts` |
| S4 | Không lộ chi phí / nhà cung cấp cho khách | ✅ PROD | #669 lên production 08/10 |

## 4. QUAN SÁT — người vận hành chẩn đoán được (lệnh LAUNCH SPRINT §11)

Đo 08/10 (đọc mã main 67fc09b1): lỗi theo tổ chức nằm trong CSDL của chính tổ chức, KHÔNG lên trang `/platform` nào; lỗi đăng
nhập chỉ trong bộ nhớ tiến trình; lỗi ghi đơn bị ghi NHẦM thành «AI lỗi» + chuyển người AI_DOWN. Sứ mệnh `saas-ops-signals`
(LAUNCH BLOCKER) đóng cả 8; #683 phủ một phần ở mức danh sách.

| # | Tín hiệu | Trạng thái | Hôm nay ghi ở đâu / còn hở |
|---|---|---|---|
| O1 | Khách đăng nhập hỏng | 🔧 WIP | Chỉ Map bộ nhớ (`lib/auth/login-throttle.ts`), mọi lý do gộp BAD_CREDENTIALS; liên kết kích hoạt hết hạn ra lỗi chung |
| O2 | Facebook mất kết nối | 🔧 WIP | `org_channel_pages.last_error` + thông báo cho KHÁCH; người vận hành chỉ thấy trạng thái `org_connections` |
| O3 | Webhook hỏng | 🔧 WIP | Từ chối chữ ký chỉ ra console; tin hỏng nằm `sales_chat_inbound` DEAD của tổ chức; job `sales-health` 5 phút tính sẵn nhưng chỉ báo Lark / Telegram |
| O4 | AI im lặng | 🔧 WIP | `platform_ai_usage` có ERROR / BLOCKED_QUOTA nhưng không có loại lỗi; #683 phân mức AI đang lỗi / im |
| O5 | Gửi tin (Send API) hỏng | 🔧 WIP | Chỉ trong CSDL tổ chức |
| O6 | Đơn không hợp lệ | 🔧 WIP | Kết quả lỗi của công cụ bot trong `sales_chat_messages`, không có mã lý do ở nhà |
| O7 | Ghi đơn (OMS) hỏng | 🔧 WIP | `fail()` không audit; lỗi CSDL bay lên thành AI ERROR + AI_DOWN (quy kết sai) |
| O8 | Hết hạn mức | 🟡 CODE | `/platform/org/<mã>` hiện «Bị chặn» + gói đã dùng / trần; chưa nói giới hạn nào chạm, chưa cờ hết số dư |

## 5. Kiểm được khi Meta duyệt (smoke tài khoản NGOÀI)

OAuth → tìm Page → nối → subscribe → khách nhắn Messenger → hộp thư nhận → AI trả lời → đơn nháp → tạo đơn. Bằng tài khoản Facebook
/ Page KHÔNG có vai trò trong app. Chỉ khi đạt mới ghi META DIRECT sẵn sàng production.

## 6. Tài khoản kiểm thử production (bắt buộc cho smoke tất định)

| Tài khoản | Trạng thái |
|---|---|
| 1 người vận hành nền tảng (kiểm thử) | ❌ chưa có — tạo tài khoản mang quyền người vận hành là quyết định QUYỀN (AGENTS §7) của chủ shop. Đề xuất thay thế không sinh mật khẩu: smoke phía máy chủ ký phiên ngắn hạn (như `scripts/smoke.ts` đang làm cho `/platform*`) |
| 1 khách EXTERNAL kiểm thử + 1 workspace kiểm thử | 🔧 WIP — ops `saas-acceptance` (sứ mệnh `saas-acceptance-smoke`): tạo qua ĐÚNG đường admin, kích hoạt + đăng nhập email với mật khẩu sinh trong bộ nhớ (không in, không lưu, xoay sau lượt chạy), mở vỏ, chat web → AI → đơn → OMS. Ghi vào workspace kiểm thử dưới danh tính CHÍNH tài khoản khách thử — không ghi hộ |
| 1 Page Facebook kiểm thử | ⛔ dùng Page có vai trò trong app trong lúc chờ Meta |

Không dùng dữ liệu khách thật theo cách phá huỷ.

## 7. Phân loại việc đang chạy (WIP)

| Việc | Loại |
|---|---|
| Tạo khách đúng mặc định — luật gói + thương hiệu ở tầng ghi chung (#682) | LAUNCH BLOCKER (P0-C) |
| Smoke nghiệm thu production (`saas-acceptance-smoke`) | LAUNCH BLOCKER (P0-D + smoke xanh) |
| Tín hiệu sự cố cho người vận hành (`saas-ops-signals`) | LAUNCH BLOCKER (§11) |
| Sức khoẻ khách (#683) | LAUNCH SUPPORT |
| Theo sau danh tính (#684) | LAUNCH SUPPORT |
| Vỏ: thiếu quyền / module tắt không ra trang trắng (`saas-shell-gate-redirects`) | LAUNCH SUPPORT |
| Sao lưu ngoài máy hỏng vì Drive đầy (`backup-drive-trash`) | LAUNCH SUPPORT (độ tin cậy dữ liệu) |
| Chuyển giá legacy → V1 (#676, đã deploy — công cụ, chưa chuyển ai) | POST-LAUNCH |
| HSLC trả trước (#674) · HSLC danh mục / giá sỉ (#677) | CUSTOMER-SPECIFIC |
| Meta App Review | EXTERNAL BLOCKED |
| Worker /tech một nút (#631) | POST-LAUNCH (CRITICAL — chủ shop gộp) |

## 8. Phát hiện cần chủ shop biết

- Địa chỉ chat web của khách Chốt Đơn mang tên miền VNX: `<tên>.erp.vnxcommerce.com` (`PLATFORM_BASE_DOMAIN`). Chạy được; thương
  hiệu riêng `<tên>.chotdontudong.com` là việc sau ra mắt (thêm một miền gốc + DNS wildcard).
- `PLATFORM_SIGNUP_MODE = open`: ai cũng tự đăng ký được ngay bây giờ, trong khi quyết định 08/10 là các cửa hàng tự đăng ký
  «đăng ký lại khi hệ thống sẵn sàng».
- Sao lưu ngoài máy (Google Drive) hỏng 403 từ 08/10; bản trên VPS + PITR vẫn tốt. Nghi phạm: rclone xoá vào THÙNG RÁC của Drive
  (vẫn tính dung lượng 30 ngày) — sửa ở `backup-drive-trash`, không cần chủ shop dọn Drive nếu đúng.

## 9. Nhật ký cập nhật

| Lúc | Thay đổi |
|---|---|
| 08/10/2026 | Mở cổng. Admin 3/10 (30 %) · Khách 8/19 (42 %) · Bảo mật 2,5/4 · Tổng 13,5/33 = 41 %. Đã kiểm production thật: 1/33. P0 còn: C2 đăng nhập email. NOT READY |
| 08/10/2026 tối | #681 (P0 đăng nhập email) + #680 (Finish Line) gộp, deploy 37781964748 thành công (production aa4b69ce); `identity-reconcile` ghi bù 12 chỉ mục, THIẾU 0. Round 2 giao phiên Fable code-erp-a4. Thêm mục 4 QUAN SÁT (8 tín hiệu, §11) — mẫu số 33 → 41. A1 + A4 LÙI về 🔧 vì review #682. Admin 2,5/10 (25 %) · Khách 9/19 (47 %; 9/18 = 50 % bỏ Meta) · Bảo mật 2,5/4 · Quan sát 0,5/8 · Tổng 14,5/41 = 35 %. Đã kiểm production thật: 1/41. P0 còn: A1 / A4 tạo khách đúng mặc định (#682). NOT READY |
