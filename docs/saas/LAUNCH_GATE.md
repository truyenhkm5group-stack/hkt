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
| A1 | Tạo khách không cần CSDL / script | ✅ PROD | #682 (luật gói + thương hiệu ở tầng ghi chung) deploy 37829126099. nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước A: `requestProvisioning` — ĐÚNG job của form «Tạo khách mới» — tạo workspace `cdt-nghiem-thu` xong, không CSDL / script tay |
| A2 | Tài khoản / quản trị khách được cấp | ✅ PROD | nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước A: tài khoản EXTERNAL, chỉ mục đăng nhập email ⇒ workspace ghi đúng |
| A3 | Gán sản phẩm Chốt Đơn | ✅ PROD | nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước A: thương hiệu `chotdon`, module `ai_sales` bật |
| A4 | Gán gói / thuê bao | ✅ PROD | #682 đã lên production. nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước A: gói dùng thử của bảng giá CATALOG đang hiệu lực + ghim giá V1 |
| A5 | Gửi / gửi lại lời mời | ✅ PROD | #681 + #684 đã lên production. nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước B1: `resendActivation` (lõi nút «Gửi lại kích hoạt») phát liên kết dùng một lần, không lộ token |
| A6 | Thấy trạng thái cấp phát | 🟡 CODE | #682 hiện bước cài mẫu hỏng + đường sửa; đã lên production c7183395 — chưa ai đi qua màn hình trên production |
| A7 | Thấy sức khoẻ Messenger / kênh | 🟡 CODE | #683 + #692 (tín hiệu O2) đã lên production c7183395 — chưa có khách thật mất kênh để thấy trên `/platform/customers` |
| A8 | Thấy sức khoẻ AI | 🟡 CODE | #683 (AI đang lỗi · bị chặn · im) đã lên production c7183395 — chưa kiểm trên production |
| A9 | Thấy gói / mức dùng | 🟡 CODE | Danh sách khách có gói; mức dùng ở chi tiết |
| A10 | Nhận ra khách có vấn đề | 🟡 CODE | #683 (Nguy cấp · Cần chú ý · Chưa đủ dữ liệu · Khoẻ · Đã dừng) đã lên production c7183395 — chưa kiểm trên production |

## 2. KHÁCH

| # | Mục | Trạng thái | Bằng chứng / việc còn lại |
|---|---|---|---|
| C1 | Kích hoạt (đặt mật khẩu) | ✅ PROD | nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước B1: liên kết `/reset` kích hoạt, đặt mật khẩu bằng hai hàm của trang `/reset`; liên kết dùng một lần; bước B2 xoay mật khẩu sau lượt |
| C2 | Đăng nhập email + mật khẩu | ✅ PROD | #681 + `identity-reconcile` (THIẾU 0). nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước B1: đăng nhập email + mật khẩu KHÔNG mã tổ chức ra đúng workspace; mật khẩu sai bị từ chối |
| C3 | Vỏ không lộ nội bộ | ✅ PROD | #669 · #680 · #700 (câu `BILLING_LOCKED` theo sản phẩm, thương hiệu sau redirect) đã lên production. nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371, production 6883bfbf → c7183395) bước C: 8 mục vỏ qua host app Chốt Đơn đều 200, mang dấu vỏ + thương hiệu Chốt Đơn, KHÔNG lộ khung ERP, không vòng chuyển hướng; tuyến ERP bị chặn về trang nhà |
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
| O1 | Khách đăng nhập hỏng | 🟡 CODE | #692 (0237 `platform_auth_failures`, lý do đăng nhập hỏng tách khỏi BAD_CREDENTIALS công khai) đã lên production c7183395 — chưa có lượt kiểm trên production |
| O2 | Facebook mất kết nối | 🟡 CODE | #692 bảng tín hiệu trên `/platform/org` đã lên production c7183395 — chưa kiểm trên production |
| O3 | Webhook hỏng | 🟡 CODE | #692 đã lên production c7183395 — chưa kiểm trên production |
| O4 | AI im lặng | 🟡 CODE | #692 (`error_class`) + #683 đã lên production c7183395 — chưa kiểm trên production |
| O5 | Gửi tin (Send API) hỏng | 🟡 CODE | #692 đã lên production c7183395 — chưa kiểm trên production |
| O6 | Đơn không hợp lệ | 🟡 CODE | #692 đã lên production c7183395 — chưa kiểm trên production |
| O7 | Ghi đơn (OMS) hỏng | 🟡 CODE | #692 (`ORDER_POSTWRITE_ERROR` thôi quy kết thành AI lỗi; cảnh báo bàn giao ghi đơn treo 15 phút) đã lên production c7183395 — chưa kiểm trên production |
| O8 | Hết hạn mức | 🟡 CODE | `/platform/org/<mã>` hiện «Bị chặn» + gói đã dùng / trần; chưa nói giới hạn nào chạm, chưa cờ hết số dư |

## 5. Kiểm được khi Meta duyệt (smoke tài khoản NGOÀI)

OAuth → tìm Page → nối → subscribe → khách nhắn Messenger → hộp thư nhận → AI trả lời → đơn nháp → tạo đơn. Bằng tài khoản Facebook
/ Page KHÔNG có vai trò trong app. Chỉ khi đạt mới ghi META DIRECT sẵn sàng production.

## 6. Tài khoản kiểm thử production (bắt buộc cho smoke tất định)

| Tài khoản | Trạng thái |
|---|---|
| 1 người vận hành nền tảng (kiểm thử) | ❌ chưa có — tạo tài khoản mang quyền người vận hành là quyết định QUYỀN (AGENTS §7) của chủ shop. Đề xuất thay thế không sinh mật khẩu: smoke phía máy chủ ký phiên ngắn hạn (như `scripts/smoke.ts` đang làm cho `/platform*`) |
| 1 khách EXTERNAL kiểm thử + 1 workspace kiểm thử | ✅ `cdt-nghiem-thu` tạo trên production 09/10 (run 37838073371), loại khỏi cockpit / sổ cái / phân bổ chi phí (#696). D / E (`--e2e`) chờ chủ shop chuẩn bị UI một lần (ACCEPTANCE.md §3) — ops `saas-acceptance` (sứ mệnh `saas-acceptance-smoke`): tạo qua ĐÚNG đường admin, kích hoạt + đăng nhập email với mật khẩu sinh trong bộ nhớ (không in, không lưu, xoay sau lượt chạy), mở vỏ, chat web → AI → đơn → OMS. Ghi vào workspace kiểm thử dưới danh tính CHÍNH tài khoản khách thử — không ghi hộ |
| 1 Page Facebook kiểm thử | ⛔ dùng Page có vai trò trong app trong lúc chờ Meta |

Không dùng dữ liệu khách thật theo cách phá huỷ.

## 7. Phân loại việc đang chạy (WIP)

| Việc | Loại |
|---|---|
| Nghiệm thu E2E production D + E (`saas-acceptance --apply --e2e`): chat web → AI → đơn CONFIRMED trong OMS · miền chat ngoài | LAUNCH BLOCKER (Khách ≥ 90 % cần C8–C17 lên ✅) — chờ chủ shop chuẩn bị UI một lần |
| Kiểm 8 tín hiệu quan sát trên production (O1–O8) | LAUNCH BLOCKER (§11) |
| Round 2 Production Acceptance + Commercial Sweep (phiên Fable: #705 màn lỗi · #706 trang chủ · R2 · G · F) | LAUNCH SUPPORT |
| Chuyển giá legacy → V1 (#676, đã deploy — công cụ, chưa chuyển ai) | POST-LAUNCH |
| HSLC trả trước + khoá AI nền tảng (đã chuyển 09/10) · danh mục / giá sỉ (#677, #701) | CUSTOMER-SPECIFIC |
| Meta App Review | EXTERNAL BLOCKED |
| Worker /tech một nút (#631) | POST-LAUNCH (CRITICAL — chủ shop gộp) |

## 8. Phát hiện cần chủ shop biết

- Địa chỉ chat web của khách Chốt Đơn mang tên miền VNX: `<tên>.erp.vnxcommerce.com` (`PLATFORM_BASE_DOMAIN`). Chạy được; thương
  hiệu riêng `<tên>.chotdontudong.com` là việc sau ra mắt (thêm một miền gốc + DNS wildcard).
- `PLATFORM_SIGNUP_MODE = open`: ai cũng tự đăng ký được ngay bây giờ, trong khi quyết định 08/10 là các cửa hàng tự đăng ký
  «đăng ký lại khi hệ thống sẵn sàng».
- Sao lưu ngoài máy (Google Drive): bản sửa thùng rác (`backup-drive-trash`) đã lên production; 7 CSDL tổ chức đẩy lên Drive OK.
  CSDL nhà VẪN hỏng vì Drive 15 GB đầy bởi ~9,9 GB tệp riêng của chủ shop — cần chủ shop chọn (dọn / mua dung lượng / tài khoản
  riêng / giảm số bản giữ). Bản trên VPS + PITR vẫn tốt.

## 9. Nhật ký cập nhật

| Lúc | Thay đổi |
|---|---|
| 08/10/2026 | Mở cổng. Admin 3/10 (30 %) · Khách 8/19 (42 %) · Bảo mật 2,5/4 · Tổng 13,5/33 = 41 %. Đã kiểm production thật: 1/33. P0 còn: C2 đăng nhập email. NOT READY |
| 08/10/2026 tối | #681 (P0 đăng nhập email) + #680 (Finish Line) gộp, deploy 37781964748 thành công (production aa4b69ce); `identity-reconcile` ghi bù 12 chỉ mục, THIẾU 0. Round 2 giao phiên Fable code-erp-a4. Thêm mục 4 QUAN SÁT (8 tín hiệu, §11) — mẫu số 33 → 41. A1 + A4 LÙI về 🔧 vì review #682. Admin 2,5/10 (25 %) · Khách 9/19 (47 %; 9/18 = 50 % bỏ Meta) · Bảo mật 2,5/4 · Quan sát 0,5/8 · Tổng 14,5/41 = 35 %. Đã kiểm production thật: 1/41. P0 còn: A1 / A4 tạo khách đúng mặc định (#682). NOT READY |
| 09/10/2026 sáng | Deploy 37829126099 (6883bfbf: #682 #683 #690 #694 #696 #697 #698 #699 #700) + 37838226087 (c7183395: #692 #702 #703 #704), hậu kiểm ĐẠT (health · 238 migration · smoke). Nghiệm thu production `saas-acceptance --apply` PASS 4/4 (run 37838073371): A1–A5, C1–C3 lên ✅. A6–A8, A10 + O1–O7 lên 🟡 (đã deploy, chưa đi qua trên production). Admin 7,5/10 (75 %) · Khách 10,5/19 (55 %; 10,5/18 = 58 % bỏ Meta) · Bảo mật 2,5/4 · Quan sát 4/8 · Tổng 24,5/41 = 60 %. Đã kiểm production thật: 9/41. P0 trong cổng: 0 mở; đường tới ĐẠT = E2E D + E (C8–C17) và kiểm O1–O8 trên production. NOT READY |
